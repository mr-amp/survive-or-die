import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AutomatonConfig, AutomatonDatabase } from "../types.js";
import { getAutomatonDir } from "../identity/wallet.js";
import { getResourceSnapshot } from "../platform/resources.js";
import { saveConfig, getConfigPath } from "../config.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("dashboard");
const TOKEN_FILENAME = "dashboard-token";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_AUTH_FAILURES_PER_MINUTE = 20;

export interface DashboardServerOptions {
  db: AutomatonDatabase;
  config: AutomatonConfig;
  onEmergencyStop: () => void;
}

export interface DashboardServer {
  close(): void;
  getPort(): number;
}

export function constantTimeTokenEquals(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length &&
    expectedBytes.length > 0 &&
    timingSafeEqual(expectedBytes, providedBytes);
}

export function isSafeLocalModelId(modelId: string): boolean {
  return modelId.length > 0 &&
    modelId.length <= 160 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(modelId) &&
    !/:cloud$/i.test(modelId);
}

export function clampLimit(value: unknown, fallback = 50, maximum = 100): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

function tokenPath(): string {
  return path.join(getAutomatonDir(), TOKEN_FILENAME);
}

function loadOrCreateToken(): string {
  const dir = getAutomatonDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = tokenPath();
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (Buffer.byteLength(existing) < 32) {
      throw new Error("Dashboard token file is invalid; remove it and restart the agent to generate a new token.");
    }
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    fs.writeFileSync(file, token + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return fs.readFileSync(file, "utf8").trim();
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows uses the current user's profile ACL instead of POSIX mode bits.
  }
  logger.info(`Dashboard owner token created at ${file}. Read it locally to sign in; it is never returned by the API.`);
  return token;
}

function hasTable(db: AutomatonDatabase, tableName: string): boolean {
  return Boolean(db.raw.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(tableName));
}

function parseJson(value: unknown): any {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function trimText(value: unknown, max = 420): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  response.end(JSON.stringify(value));
}

function sendError(response: http.ServerResponse, status: number, message: string): void {
  sendJson(response, status, { error: message });
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body exceeds the size limit.");
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A JSON object is required.");
  }
  return parsed as Record<string, unknown>;
}

function recentTurns(db: AutomatonDatabase): unknown[] {
  return db.raw.prepare(
    "SELECT id, timestamp, state, input, input_source, thinking, tool_calls, cost_cents FROM turns ORDER BY timestamp DESC LIMIT 12",
  ).all().map((row: any) => {
    const calls = parseJson(row.tool_calls);
    return {
      id: row.id,
      timestamp: row.timestamp,
      state: row.state,
      input: trimText(row.input, 180),
      inputSource: row.input_source,
      summary: trimText(row.thinking, 420),
      actions: Array.isArray(calls)
        ? calls.slice(0, 12).map((call: any) => ({
            name: trimText(call?.name, 80),
            error: trimText(call?.error, 180) || undefined,
          }))
        : [],
      costCents: Number(row.cost_cents) || 0,
    };
  });
}

function statusPayload(db: AutomatonDatabase, config: AutomatonConfig): Record<string, unknown> {
  const activeGoal = hasTable(db, "goals")
    ? db.raw.prepare(
        "SELECT id, title, description, status, expected_revenue_cents, actual_revenue_cents, created_at, deadline FROM goals WHERE status = 'active' ORDER BY created_at DESC LIMIT 1",
      ).get()
    : undefined;
  const tasks = hasTable(db, "task_graph")
    ? db.raw.prepare(
        "SELECT id, goal_id, title, description, status, assigned_to, agent_role, priority, retry_count, max_retries, created_at, started_at, completed_at FROM task_graph ORDER BY created_at DESC LIMIT 40",
      ).all()
    : [];
  const childRows = hasTable(db, "children") ? db.getChildren() : [];
  const transactions = db.getRecentTransactions(20);
  const recentSpend = hasTable(db, "spend_tracking")
    ? db.raw.prepare(
        "SELECT id, tool_name, amount_cents, category, recipient, domain, created_at FROM spend_tracking ORDER BY created_at DESC LIMIT 20",
      ).all()
    : [];
  const inference = hasTable(db, "inference_costs")
    ? db.raw.prepare(
        "SELECT model, provider, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, SUM(cost_cents) AS cost_cents, COUNT(*) AS calls FROM inference_costs WHERE created_at >= datetime('now', '-30 days') GROUP BY model, provider ORDER BY calls DESC LIMIT 12",
      ).all()
    : [];
  return {
    agent: {
      name: config.name,
      address: config.walletAddress,
      state: db.getAgentState(),
      turnCount: db.getTurnCount(),
      startedAt: db.getKV("start_time") || null,
      paused: db.getKV("dashboard_pause_requested") === "true",
      emergencyStopRequested: db.getKV("dashboard_stop_requested") === "true",
    },
    objective: activeGoal || null,
    tasks,
    activity: recentTurns(db),
    resources: getResourceSnapshot(),
    model: {
      localOnly: config.localOnly === true,
      inferenceModel: config.inferenceModel,
      ollamaBaseUrl: config.localOnly ? (process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl || "http://localhost:11434") : config.ollamaBaseUrl || null,
      profile: config.localProfile || "16gb",
      maxTokensPerTurn: config.maxTokensPerTurn,
      maxChildren: config.maxChildren,
    },
    memoryCounts: {
      semantic: hasTable(db, "semantic_memory")
        ? Number((db.raw.prepare("SELECT COUNT(*) AS count FROM semantic_memory").get() as any).count)
        : 0,
      episodic: hasTable(db, "episodic_memory")
        ? Number((db.raw.prepare("SELECT COUNT(*) AS count FROM episodic_memory").get() as any).count)
        : 0,
      procedural: hasTable(db, "procedural_memory")
        ? Number((db.raw.prepare("SELECT COUNT(*) AS count FROM procedural_memory").get() as any).count)
        : 0,
    },
    children: childRows.map((child: any) => ({
      id: child.id,
      name: child.name,
      address: child.address,
      status: child.status,
      createdAt: child.createdAt,
      lastChecked: child.lastChecked,
      fundedAmountCents: child.fundedAmountCents || 0,
    })),
    finances: {
      transactions,
      spend: recentSpend,
      inferenceLast30Days: inference,
      automaticTransactionsEnabled: false,
    },
  };
}

function memoryPayload(db: AutomatonDatabase, search: string): Record<string, unknown> {
  const needle = `%${search.slice(0, 120)}%`;
  return {
    semantic: hasTable(db, "semantic_memory")
      ? db.raw.prepare(
          "SELECT id, category, key, value, confidence, source, updated_at FROM semantic_memory WHERE (? = '%%' OR key LIKE ? OR value LIKE ?) ORDER BY updated_at DESC LIMIT 80",
        ).all(search ? needle : "%%", needle, needle)
      : [],
    episodic: hasTable(db, "episodic_memory")
      ? db.raw.prepare(
          "SELECT id, event_type, summary, detail, outcome, importance, classification, created_at FROM episodic_memory WHERE (? = '%%' OR summary LIKE ? OR detail LIKE ?) ORDER BY created_at DESC LIMIT 80",
        ).all(search ? needle : "%%", needle, needle)
      : [],
    procedural: hasTable(db, "procedural_memory")
      ? db.raw.prepare(
          "SELECT id, name, description, steps, success_count, failure_count, last_used_at FROM procedural_memory WHERE (? = '%%' OR name LIKE ? OR description LIKE ?) ORDER BY updated_at DESC LIMIT 80",
        ).all(search ? needle : "%%", needle, needle)
      : [],
  };
}

function approvalPayload(db: AutomatonDatabase): Record<string, unknown> {
  const blockedActions = hasTable(db, "policy_decisions")
    ? db.raw.prepare(
        "SELECT id, tool_name, risk_level, reason, created_at FROM policy_decisions WHERE reason LIKE 'OWNER_APPROVAL_REQUIRED:%' ORDER BY created_at DESC LIMIT 30",
      ).all()
    : [];
  return {
    pending: [],
    blockedActions,
    note: "No approval is executable from this dashboard yet. Financial and paid-cloud actions remain blocked; these records show attempts that were denied.",
  };
}

function ollamaBaseUrl(config: AutomatonConfig): string {
  const base = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl || "http://localhost:11434";
  const parsed = new URL(base);
  if (parsed.protocol !== "http:" || !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Dashboard model management accepts Ollama on this computer only.");
  }
  return base.replace(/\/$/, "");
}

async function installedModels(config: AutomatonConfig): Promise<string[]> {
  const base = ollamaBaseUrl(config);
  const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}`);
  const payload = await response.json() as { models?: Array<{ name?: string; model?: string }> };
  return Array.isArray(payload.models)
    ? payload.models.map((model) => model.name || model.model).filter((model): model is string => Boolean(model) && !/:cloud$/i.test(model || ""))
    : [];
}

function saveLocalConfig(config: AutomatonConfig, updates: { inferenceModel?: string; localProfile?: "16gb" | "32gb" }): void {
  if (config.localOnly !== true) throw new Error("Dashboard configuration changes are available only in local-only mode.");
  const configPath = getConfigPath();
  const backup = `${configPath}.dashboard-backup-${Date.now()}`;
  fs.copyFileSync(configPath, backup);
  const next = { ...config };
  if (updates.inferenceModel) next.inferenceModel = updates.inferenceModel;
  if (updates.localProfile) {
    next.localProfile = updates.localProfile;
    next.maxChildren = updates.localProfile === "32gb" ? 2 : 1;
    next.maxTokensPerTurn = updates.localProfile === "32gb" ? 4096 : 2048;
  }
  saveConfig(next);
  Object.assign(config, next);
}

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><title>Survive or Die</title>
<style>
:root{font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#edf3f9;background:#0d1219;--panel:#161e29;--muted:#a7b4c3;--line:#2a3747;--accent:#74d4b1;--red:#ff8f8f}
*{box-sizing:border-box}body{margin:0;max-width:1200px;padding:16px;margin-inline:auto}header{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:8px 0 20px}h1{font-size:1.35rem;margin:0}h2{font-size:1rem;margin:0 0 12px}small,.muted{color:var(--muted)}button,input,select{font:inherit;color:inherit;background:#202b39;border:1px solid var(--line);border-radius:10px;padding:10px}button{cursor:pointer}button.primary{background:#174a3c;border-color:#24775f}button.danger{background:#4c2629;border-color:#85454a}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:12px}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.value{font-size:1.15rem;font-weight:650;margin:8px 0;overflow-wrap:anywhere}.list{display:grid;gap:8px;padding:0;margin:0;list-style:none;max-height:370px;overflow:auto}.item{border-top:1px solid var(--line);padding:9px 0;overflow-wrap:anywhere}.item:first-child{border-top:0}.item strong{display:block}.item pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#d7e1eb;font:inherit;font-size:.88rem;margin:5px 0 0}#login{max-width:440px;margin:15vh auto}#error{color:var(--red);min-height:1.5em}.wide{grid-column:1/-1}.hide{display:none}label{display:grid;gap:6px;margin:8px 0}
</style></head><body>
<div id="login" class="card"><h1>Survive or Die</h1><p class="muted">Enter the owner token from your local `.automaton\dashboard-token` file.</p><label>Dashboard token<input id="token" type="password" autocomplete="current-password"></label><button id="loginButton" class="primary">Unlock dashboard</button><p id="error"></p></div>
<main id="app" class="hide">
<header><div><h1>Survive or Die</h1><small id="updated">Secure local dashboard</small></div><div class="row"><button id="refresh">Refresh</button><button id="logout">Lock</button></div></header>
<div class="grid">
<section class="card"><h2>Agent</h2><div id="agentState" class="value">Loading</div><div id="agentMeta" class="muted"></div><div id="controls" class="row" style="margin-top:12px"><button id="pause" class="primary">Pause</button><button id="resume">Resume</button><button id="stop" class="danger">Emergency stop</button></div></section>
<section class="card"><h2>Objective and tasks</h2><div id="objective" class="value">No active goal</div><ul id="tasks" class="list"></ul></section>
<section class="card"><h2>Local model and resources</h2><div id="model" class="muted"></div><div id="resources" class="value"></div><div class="row"><select id="modelSelect"></select><button id="saveModel">Set model</button><select id="profileSelect"><option value="16gb">16GB profile</option><option value="32gb">32GB profile</option></select><button id="saveProfile">Set profile</button></div><small>Configuration changes take effect after restarting the agent. Ollama cloud models are excluded.</small></section>
<section class="card"><h2>Child agents</h2><ul id="children" class="list"></ul></section>
<section class="card"><h2>Financial and survival record</h2><div id="finances" class="muted"></div><ul id="transactions" class="list"></ul></section>
<section class="card"><h2>Owner approvals</h2><div id="approvals" class="muted"></div><ul id="blockedActions" class="list"></ul></section>
<section class="card wide"><h2>Recent activity</h2><ul id="activity" class="list"></ul></section>
<section class="card wide"><h2>Persistent memory</h2><div class="row"><input id="memorySearch" placeholder="Search saved memory"><button id="searchMemory">Search</button></div><div class="grid"><ul id="semantic" class="list"></ul><ul id="episodic" class="list"></ul><ul id="procedural" class="list"></ul></div></section>
</div></main>
<script>
const tokenKey="sod-dashboard-token";let token=localStorage.getItem(tokenKey)||"";
const byId=(id)=>document.getElementById(id);
function showError(message){byId("error").textContent=message||""}
function addRows(id,items,title,body){const list=byId(id);list.replaceChildren();if(!items||!items.length){const li=document.createElement("li");li.className="item muted";li.textContent="Nothing recorded yet.";list.append(li);return}for(const item of items){const li=document.createElement("li");li.className="item";const strong=document.createElement("strong");strong.textContent=title(item);li.append(strong);const pre=document.createElement("pre");pre.textContent=body(item);li.append(pre);list.append(li)}}
async function api(path,options={}){const response=await fetch(path,{...options,headers:{Authorization:"Bearer "+token,"Content-Type":"application/json",...(options.headers||{})}});const data=await response.json();if(!response.ok)throw new Error(data.error||"Request failed");return data}
async function connect(){try{await api("/api/status");localStorage.setItem(tokenKey,token);byId("login").classList.add("hide");byId("app").classList.remove("hide");showError("");await refresh()}catch(error){showError(error.message||"Authentication failed.")}}
async function refresh(){try{const data=await api("/api/status");const agent=data.agent||{};byId("agentState").textContent=agent.state+(agent.paused?" · paused":"");byId("agentMeta").textContent=(agent.name||"Automaton")+" · "+agent.turnCount+" turns · since "+(agent.startedAt||"unknown");const goal=data.objective;byId("objective").textContent=goal?goal.title:"No active goal";addRows("tasks",data.tasks||[],x=>x.title,x=>x.status+" · priority "+x.priority+" · retries "+x.retryCount+"/"+x.maxRetries);byId("model").textContent=(data.model.localOnly?"Local-only · ":"")+(data.model.inferenceModel||"no model")+" · "+data.model.profile+" · "+data.model.maxTokensPerTurn+" output tokens";const r=data.resources||{};byId("resources").textContent="Process RAM "+Math.round((r.processRssBytes||0)/1048576)+" MB · free system RAM "+Math.round((r.availableMemoryBytes||0)/1073741824)+" GB · CPU "+(r.processCpuPercentOneCore||0)+"%";const select=byId("profileSelect");select.value=data.model.profile||"16gb";const models=await api("/api/models");if(models.warning){byId("model").textContent+=" · Ollama unavailable: "+models.warning}const modelSelect=byId("modelSelect");modelSelect.replaceChildren();for(const name of models.models||[]){const option=document.createElement("option");option.value=name;option.textContent=name;modelSelect.append(option)}if(data.model.inferenceModel)modelSelect.value=data.model.inferenceModel;addRows("children",data.children||[],x=>x.name+" · "+x.status,x=>"created "+(x.createdAt||"unknown")+" · funded ledger "+x.fundedAmountCents+"¢");const finances=data.finances||{};byId("finances").textContent="Automatic transactions disabled · recorded transactions "+(finances.transactions||[]).length+" · recorded spend entries "+(finances.spend||[]).length+" · inference cost last 30 days is tracked below";addRows("transactions",finances.transactions||[],x=>x.type,x=>x.description+" · "+x.amountCents+"¢ · "+x.createdAt);const approval=await api("/api/approvals");byId("approvals").textContent=approval.note;addRows("blockedActions",approval.blockedActions||[],x=>x.tool_name+" · denied",x=>x.reason+" · "+x.created_at);addRows("activity",data.activity||[],x=>x.timestamp+" · "+x.state,x=>x.summary+"\nActions: "+(x.actions||[]).map(y=>y.name+(y.error?" (failed)":"")).join(", "));byId("updated").textContent="Updated "+new Date().toLocaleTimeString();await loadMemory()}catch(error){if(error.message.includes("Unauthorized")){localStorage.removeItem(tokenKey);byId("app").classList.add("hide");byId("login").classList.remove("hide")}showError(error.message||"Dashboard refresh failed.")}}
async function loadMemory(){const query=encodeURIComponent(byId("memorySearch").value||"");const data=await api("/api/memory?q="+query);addRows("semantic",data.semantic||[],x=>"Fact · "+x.category+" · "+x.key,x=>x.value+" · confidence "+x.confidence);addRows("episodic",data.episodic||[],x=>"Episode · "+x.event_type,x=>x.summary+" · "+x.outcome);addRows("procedural",data.procedural||[],x=>"Procedure · "+x.name,x=>x.description+" · success "+x.success_count+", failure "+x.failure_count)}
byId("loginButton").onclick=()=>{token=byId("token").value.trim();connect()};byId("token").onkeydown=e=>{if(e.key==="Enter")byId("loginButton").click()};byId("refresh").onclick=refresh;byId("logout").onclick=()=>{localStorage.removeItem(tokenKey);token="";byId("app").classList.add("hide");byId("login").classList.remove("hide");byId("token").value=""};byId("searchMemory").onclick=loadMemory;
byId("pause").onclick=async()=>{await api("/api/control/pause",{method:"POST",body:"{}"});await refresh()};byId("resume").onclick=async()=>{await api("/api/control/resume",{method:"POST",body:"{}"});await refresh()};byId("stop").onclick=async()=>{if(confirm("Stop the agent and heartbeat now? You will need to start it again on the computer.")){await api("/api/control/stop",{method:"POST",body:"{}"});byId("agentState").textContent="Stopping"}};byId("saveModel").onclick=async()=>{if(confirm("Save this local model? Restart the agent to apply it.")){await api("/api/config/model",{method:"POST",body:JSON.stringify({model:byId("modelSelect").value})});alert("Saved. Restart the agent to apply the model.")}};byId("saveProfile").onclick=async()=>{if(confirm("Save this resource profile? Restart the agent to apply it.")){await api("/api/config/profile",{method:"POST",body:JSON.stringify({profile:byId("profileSelect").value})});alert("Saved. Restart the agent to apply the profile.")}};
if(token){byId("token").value=token;connect()}
</script></body></html>`;

export function startDashboardServer(options: DashboardServerOptions): DashboardServer {
  const token = loadOrCreateToken();
  const failureWindows = new Map<string, number[]>();
  const configuredPort = Number(options.config.dashboardPort);
  const port = Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535
    ? configuredPort
    : 41555;

  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" });
      response.end(DASHBOARD_HTML);
      return;
    }

    const auth = request.headers.authorization || "";
    const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!constantTimeTokenEquals(token, provided)) {
      const ip = request.socket.remoteAddress || "unknown";
      const now = Date.now();
      const recent = (failureWindows.get(ip) || []).filter((time) => now - time < 60_000);
      recent.push(now);
      failureWindows.set(ip, recent);
      if (recent.length > MAX_AUTH_FAILURES_PER_MINUTE) {
        sendError(response, 429, "Too many authentication attempts.");
      } else {
        sendError(response, 401, "Unauthorized");
      }
      return;
    }

    try {
      if (request.method === "GET" && requestUrl.pathname === "/api/status") {
        sendJson(response, 200, statusPayload(options.db, options.config));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/memory") {
        sendJson(response, 200, memoryPayload(options.db, requestUrl.searchParams.get("q") || ""));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/approvals") {
        sendJson(response, 200, approvalPayload(options.db));
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/models") {
        try {
          sendJson(response, 200, { models: await installedModels(options.config) });
        } catch (error) {
          sendJson(response, 200, { models: [], warning: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (request.method !== "POST") {
        sendError(response, 404, "Not found");
        return;
      }

      const body = await readJsonBody(request);
      if (requestUrl.pathname === "/api/control/pause") {
        options.db.setKV("dashboard_pause_requested", "true");
        sendJson(response, 200, { ok: true, paused: true });
        return;
      }
      if (requestUrl.pathname === "/api/control/resume") {
        options.db.deleteKV("dashboard_pause_requested");
        options.db.deleteKV("dashboard_stop_requested");
        options.db.raw.prepare(
          "INSERT INTO wake_events (source, reason, payload) VALUES (?, ?, ?)",
        ).run("dashboard", "Owner resumed the agent from the private dashboard", "{}");
        sendJson(response, 200, { ok: true, paused: false });
        return;
      }
      if (requestUrl.pathname === "/api/control/stop") {
        options.db.setKV("dashboard_stop_requested", "true");
        sendJson(response, 202, { ok: true, stopping: true });
        options.onEmergencyStop();
        return;
      }
      if (requestUrl.pathname === "/api/config/model") {
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (!isSafeLocalModelId(model)) {
          sendError(response, 400, "Choose an installed local model. Ollama cloud models are not allowed.");
          return;
        }
        if (!(await installedModels(options.config)).includes(model)) {
          sendError(response, 400, "That model is not installed in the local Ollama instance.");
          return;
        }
        saveLocalConfig(options.config, { inferenceModel: model });
        sendJson(response, 200, { ok: true, restartRequired: true });
        return;
      }
      if (requestUrl.pathname === "/api/config/profile") {
        if (body.profile !== "16gb" && body.profile !== "32gb") {
          sendError(response, 400, "Profile must be 16gb or 32gb.");
          return;
        }
        saveLocalConfig(options.config, { localProfile: body.profile });
        sendJson(response, 200, { ok: true, restartRequired: true });
        return;
      }
      sendError(response, 404, "Not found");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(response, message.includes("size limit") ? 413 : 400, message);
    }
  });

  server.on("error", (error) => logger.error("Dashboard server failed", error));
  server.listen(port, "127.0.0.1", () => {
    const address = server.address() as AddressInfo;
    logger.info(`Private management dashboard listening at http://127.0.0.1:${address.port} (owner token required for all data and controls).`);
  });
  return {
    close: () => server.close(),
    getPort: () => {
      const address = server.address();
      return address && typeof address !== "string" ? address.port : port;
    },
  };
}
