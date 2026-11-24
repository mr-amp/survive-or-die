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
import {
  cancelOwnerApproval,
  listOwnerApprovalEvents,
  listOwnerApprovalRequests,
  reviewOwnerApproval,
  revokeOwnerApproval,
} from "../approvals/store.js";
import {
  createOpportunityValidationGoal,
  businessOpportunityPerformance,
  listBusinessOpportunities,
  listBusinessExperiments,
  recordBusinessActual,
  reviewBusinessExperiment,
  transitionBusinessOpportunity,
  OPPORTUNITY_STATUSES,
} from "../economics/opportunities.js";
import {
  getSelfImprovementProposal,
  listSelfImprovementProposals,
  reviewSelfImprovementProposal,
} from "../self-mod/proposals.js";
import {
  getSelfImprovementWorkspace,
  listSelfImprovementWorkspaces,
  prepareSelfImprovementWorkspace,
} from "../self-mod/workspaces.js";

const logger = createLogger("dashboard");
const TOKEN_FILENAME = "dashboard-token";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_AUTH_FAILURES_PER_MINUTE = 20;

export interface DashboardServerOptions {
  db: AutomatonDatabase;
  config: AutomatonConfig;
  onEmergencyStop: () => void;
  onStopLocalWorker?: (taskId: string) => boolean;
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
        "SELECT id, goal_id, title, description, status, assigned_to, agent_role, priority, retry_count, max_retries, next_attempt_at, created_at, started_at, completed_at FROM task_graph ORDER BY created_at DESC LIMIT 40",
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
    localWorkers: tasks
      .filter((task: any) => typeof task.assigned_to === "string" && task.assigned_to.startsWith("local://") && (task.status === "assigned" || task.status === "running"))
      .map((task: any) => ({
        taskId: task.id,
        workerId: task.assigned_to,
        name: `worker-${task.agent_role || "generalist"}`,
        taskTitle: task.title,
        status: task.status,
        startedAt: task.started_at,
        retryCount: task.retry_count,
        maxRetries: task.max_retries,
      })),
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
    pending: listOwnerApprovalRequests(db.raw, { status: "pending", limit: 50 }),
    history: listOwnerApprovalRequests(db.raw, { limit: 100 }).filter((request) => request.status !== "pending"),
    events: listOwnerApprovalEvents(db.raw, undefined, 150),
    blockedActions,
    note: "Reviews are bound to the exact action and parameters. Decisions are recorded for audit only; financial, paid-cloud, publication and commercial execution remains disabled.",
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
<div id="login" class="card"><h1>Survive or Die</h1><p class="muted">Enter the owner token from the dashboard-token file in the local .automaton folder.</p><label>Dashboard token<input id="token" type="password" autocomplete="current-password"></label><button id="loginButton" class="primary">Unlock dashboard</button><p id="error"></p></div>
<main id="app" class="hide">
<header><div><h1>Survive or Die</h1><small id="updated">Secure local dashboard</small></div><div class="row"><button id="refresh">Refresh</button><button id="logout">Lock</button></div></header>
<div class="grid">
<section class="card"><h2>Agent</h2><div id="agentState" class="value">Loading</div><div id="agentMeta" class="muted"></div><div id="controls" class="row" style="margin-top:12px"><button id="pause" class="primary">Pause</button><button id="resume">Resume</button><button id="stop" class="danger">Emergency stop</button></div></section>
<section class="card"><h2>Objective and tasks</h2><div id="objective" class="value">No active goal</div><ul id="tasks" class="list"></ul></section>
<section class="card"><h2>Local model and resources</h2><div id="model" class="muted"></div><div id="resources" class="value"></div><div class="row"><select id="modelSelect"></select><button id="saveModel">Set model</button><select id="profileSelect"><option value="16gb">16GB profile</option><option value="32gb">32GB profile</option></select><button id="saveProfile">Set profile</button></div><small>Configuration changes take effect after restarting the agent. Ollama cloud models are excluded.</small></section>
<section class="card"><h2>Remote child agents</h2><ul id="children" class="list"></ul></section><section class="card"><h2>Local worker agents</h2><ul id="workers" class="list"></ul></section>
<section class="card"><h2>Financial and survival record</h2><div id="finances" class="muted"></div><ul id="transactions" class="list"></ul></section>
<section class="card wide"><h2>Owner approval queue</h2><div id="approvals" class="muted"></div><ul id="pendingApprovals" class="list"></ul><h3>Decision history</h3><ul id="approvalHistory" class="list"></ul><h3>Audit events</h3><ul id="approvalEvents" class="list"></ul><h3>Blocked attempts</h3><ul id="blockedActions" class="list"></ul></section>
<section class="card wide"><h2>Business opportunity pipeline</h2><p class="muted">Agent entries are hypotheses. Forecasts are estimates; actuals are manually owner-reported GBP amounts. No payments, publication or customer contact are performed.</p><div id="businessMetrics" class="value"></div><ul id="opportunities" class="list"></ul></section>
<section class="card wide"><h2>Business experiment proposals and learning</h2><p class="muted">Plans never start themselves. Outcomes and lessons are owner-reported; record actual costs and income separately in the opportunity ledger.</p><ul id="experiments" class="list"></ul></section>
<section class="card wide"><h2>Self-improvement proposals</h2><p class="muted">The authenticated owner can prepare a candidate and baseline rollback copy outside the live checkout. Candidate execution and activation remain disabled because no OS-isolated verification runner has been validated.</p><ul id="selfImprovements" class="list"></ul></section>
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
async function refresh(){try{const data=await api("/api/status");const agent=data.agent||{};byId("agentState").textContent=agent.state+(agent.paused?" · paused":"");byId("agentMeta").textContent=(agent.name||"Automaton")+" · "+agent.turnCount+" turns · since "+(agent.startedAt||"unknown");const goal=data.objective;byId("objective").textContent=goal?goal.title:"No active goal";addRows("tasks",data.tasks||[],x=>x.title,x=>x.status+" · priority "+x.priority+" · retries "+x.retryCount+"/"+x.maxRetries+(x.next_attempt_at?" · retry after "+x.next_attempt_at:""));byId("model").textContent=(data.model.localOnly?"Local-only · ":"")+(data.model.inferenceModel||"no model")+" · "+data.model.profile+" · "+data.model.maxTokensPerTurn+" output tokens";const r=data.resources||{};byId("resources").textContent="Process RAM "+Math.round((r.processRssBytes||0)/1048576)+" MB · free system RAM "+Math.round((r.availableMemoryBytes||0)/1073741824)+" GB · CPU "+(r.processCpuPercentOneCore||0)+"%";const select=byId("profileSelect");select.value=data.model.profile||"16gb";const models=await api("/api/models");if(models.warning){byId("model").textContent+=" · Ollama unavailable: "+models.warning}const modelSelect=byId("modelSelect");modelSelect.replaceChildren();for(const name of models.models||[]){const option=document.createElement("option");option.value=name;option.textContent=name;modelSelect.append(option)}if(data.model.inferenceModel)modelSelect.value=data.model.inferenceModel;addRows("children",data.children||[],x=>x.name+" · "+x.status,x=>"created "+(x.createdAt||"unknown")+" · funded ledger "+x.fundedAmountCents+"¢");renderWorkers(data.localWorkers||[]);const finances=data.finances||{};byId("finances").textContent="Automatic transactions disabled · recorded transactions "+(finances.transactions||[]).length+" · recorded spend entries "+(finances.spend||[]).length+" · inference cost last 30 days is tracked below";addRows("transactions",finances.transactions||[],x=>x.type,x=>x.description+" · "+x.amountCents+"¢ · "+x.createdAt);const approval=await api("/api/approvals");renderApprovals(approval);addRows("blockedActions",approval.blockedActions||[],x=>x.tool_name+" · denied",x=>x.reason+" · "+x.created_at);const opportunities=await api("/api/opportunities");renderOpportunities(opportunities.items||[],opportunities.summary);const experiments=await api("/api/experiments");renderExperiments(experiments.items||[]);const proposals=await api("/api/self-improvements");renderSelfImprovements(proposals.items||[]);addRows("activity",data.activity||[],x=>x.timestamp+" · "+x.state,x=>x.summary+"\nActions: "+(x.actions||[]).map(y=>y.name+(y.error?" (failed)":"")).join(", "));byId("updated").textContent="Updated "+new Date().toLocaleTimeString();await loadMemory()}catch(error){if(error.message.includes("Unauthorized")){localStorage.removeItem(tokenKey);byId("app").classList.add("hide");byId("login").classList.remove("hide")}showError(error.message||"Dashboard refresh failed.")}}
function renderSelfImprovements(items){
 const list=byId("selfImprovements");list.replaceChildren();
 if(!items.length){const li=document.createElement("li");li.className="item muted";li.textContent="No proposals recorded.";list.append(li);return}
 for(const proposal of items){
  const li=document.createElement("li");li.className="item";
  const strong=document.createElement("strong");strong.textContent=proposal.title+" · "+proposal.status;li.append(strong);
  const pre=document.createElement("pre");
  const workspace=proposal.workspace;
  pre.textContent=proposal.rationale+"\nVerification: "+proposal.verificationStatus+" · "+proposal.verificationSummary+"\nDiff SHA-256: "+proposal.diffHash+"\nApproval request: "+proposal.approvalRequestId+" · expires "+proposal.expiresAt+"\nWorkspace: "+(workspace?workspace.workspacePath+" · manifest "+workspace.manifestHash+" · rollback "+workspace.rollbackHash+" · "+workspace.verificationSummary:"not prepared");
  li.append(pre);
  const detailsButton=document.createElement("button");detailsButton.textContent="Show complete proposed files";
  detailsButton.onclick=async()=>{try{const details=await api("/api/self-improvements/"+encodeURIComponent(proposal.id));const full=document.createElement("pre");full.textContent=(details.proposal.diffPreview||"No diff preview stored.")+"\n\nProposed file contents:\n"+JSON.stringify(details.proposal.files,null,2);li.append(full);detailsButton.disabled=true}catch(error){showError(error.message||"Could not load proposal files.")}};li.append(detailsButton);
  if(!workspace&&["pending_review","approved_for_manual_activation"].includes(proposal.status)){
   const prepare=document.createElement("button");prepare.className="primary";prepare.textContent="Prepare isolated candidate and rollback copy";
   prepare.onclick=async()=>{if(!confirm("Prepare owner-review files outside the live checkout? Candidate code will not be executed or activated."))return;try{await api("/api/self-improvements/"+encodeURIComponent(proposal.id)+"/prepare-workspace",{method:"POST",body:"{}"});await refresh()}catch(error){showError(error.message||"Workspace preparation failed.")}};li.append(prepare)
  }
  if(proposal.status==="pending_review"){
   for(const decision of ["approve","reject"]){const button=document.createElement("button");button.textContent=decision==="approve"?"Approve review (no activation)":"Reject proposal";button.className=decision==="approve"?"primary":"danger";button.onclick=async()=>{if(decision==="approve"&&!confirm("Approve review of this exact draft? Verification and activation remain disabled."))return;try{await api("/api/self-improvements/"+encodeURIComponent(proposal.id)+"/"+decision,{method:"POST",body:JSON.stringify({note:"Reviewed in authenticated owner dashboard"})});await refresh()}catch(error){showError(error.message||"Could not record proposal review.")}};li.append(button)}
  }
  list.append(li)
 }
}
function renderExperiments(items){const list=byId("experiments");list.replaceChildren();if(!items.length){const li=document.createElement("li");li.className="item muted";li.textContent="No experiment proposals recorded.";list.append(li);return}for(const experiment of items){const li=document.createElement("li");li.className="item";const strong=document.createElement("strong");strong.textContent=experiment.title+" · "+experiment.status;li.append(strong);const pre=document.createElement("pre");const cost=experiment.estimatedCostCents===null?"unknown":"£"+(experiment.estimatedCostCents/100).toFixed(2);pre.textContent="Opportunity: "+experiment.opportunityId+"\nHypothesis: "+experiment.hypothesis+"\nProposed method: "+experiment.method+"\nSuccess criteria: "+experiment.successCriteria+"\nForecast cost only: "+cost+"\nOwner-reported outcome: "+(experiment.outcome||"not recorded")+"\nLesson: "+(experiment.lesson||"not recorded")+"\nFollow-up task goal: "+(experiment.followUpGoalId||"not created")+"\nReview note: "+(experiment.reviewNote||"none");li.append(pre);if(experiment.status==="proposed"){const complete=document.createElement("button");complete.className="primary";complete.textContent="Record completed experiment";complete.onclick=async()=>{const outcome=prompt("Enter what actually happened. This should reflect an experiment you performed; no action will be triggered.");if(!outcome)return;const lesson=prompt("What did you learn? Include uncertainty and avoid generalising beyond the evidence.");if(!lesson)return;try{await api("/api/experiments/"+encodeURIComponent(experiment.id)+"/review",{method:"POST",body:JSON.stringify({decision:"completed",outcome,lesson,note:"Manually reported by owner"})});await refresh()}catch(error){showError(error.message||"Could not record outcome.")}};li.append(complete);const reject=document.createElement("button");reject.className="danger";reject.textContent="Reject proposal";reject.onclick=async()=>{if(!confirm("Reject this proposal without starting it?"))return;try{await api("/api/experiments/"+encodeURIComponent(experiment.id)+"/review",{method:"POST",body:JSON.stringify({decision:"rejected",note:"Rejected by owner"})});await refresh()}catch(error){showError(error.message||"Could not reject proposal.")}};li.append(reject)}list.append(li)}}

function renderOpportunities(items,summary){const metrics=summary||{};const money=(p)=>"£"+(Number(p||0)/100).toFixed(2);byId("businessMetrics").textContent="Owner-reported opportunity ledger: income "+money(metrics.actualIncomeCents)+" · expenses "+money(metrics.actualExpenseCents)+" · net "+money(metrics.actualProfitCents)+". Separate unverified open forecast net: "+(metrics.forecastNetCents===null?"incomplete estimates":money(metrics.forecastNetCents))+" across "+(metrics.forecastCount||0)+" opportunities.";const list=byId("opportunities");list.replaceChildren();if(!items.length){const li=document.createElement("li");li.className="item muted";li.textContent="No opportunities recorded.";list.append(li);return}for(const opportunity of items){const li=document.createElement("li");li.className="item";const strong=document.createElement("strong");strong.textContent=opportunity.title+" · "+opportunity.status;li.append(strong);const pre=document.createElement("pre");const money=(p)=>p===null?"unknown":"£"+(p/100).toFixed(2);pre.textContent="Customer: "+opportunity.customerSegment+"\nProblem: "+opportunity.customerProblem+"\nProposal: "+opportunity.valueProposition+"\nEvidence (unverified): "+opportunity.evidenceSummary+"\nCompetitors: "+(opportunity.competitorSummary||"not assessed")+"\nForecast (unverified, "+opportunity.forecastDays+" days): cost "+money(opportunity.estimatedCostCents)+", revenue "+money(opportunity.estimatedRevenueCents)+", confidence "+Math.round(opportunity.confidence*100)+"%\nOwner-entered actuals (GBP): income "+money(opportunity.actualIncomeCents)+", expenses "+money(opportunity.actualExpenseCents)+", net "+money(opportunity.actualProfitCents)+"\nForecast net (unverified): "+money(opportunity.forecastNetCents)+"\nValidation goal: "+(opportunity.validationGoalId||"not created")+"\nRisks: "+opportunity.risks+"\nSources recorded only: "+(opportunity.evidenceUrls||[]).join(", ");li.append(pre);const actions=document.createElement("div");actions.className="row";const next={discovered:["researching","shortlisted","rejected"],researching:["shortlisted","proposal","rejected"],shortlisted:["proposal","experiment","rejected"],proposal:["experiment","rejected"],experiment:["completed","rejected"],completed:[],rejected:[]}[opportunity.status]||[];for(const status of next){const button=document.createElement("button");button.textContent="Move to "+status;button.onclick=async()=>{try{await api("/api/opportunities/"+encodeURIComponent(opportunity.id)+"/status",{method:"POST",body:JSON.stringify({status})});await refresh()}catch(error){showError(error.message)}};actions.append(button)}if(opportunity.validationGoalId){const note=document.createElement("span");note.className="muted";note.textContent="Validation plan saved in persistent task graph.";actions.append(note)}else if(opportunity.status==="shortlisted"||opportunity.status==="proposal"){const plan=document.createElement("button");plan.className="primary";plan.textContent="Create validation task plan";plan.onclick=async()=>{if(!confirm("Create a local research and feasibility goal? It will use the existing task scheduler. Tasks prohibit customer contact, spending, publication and commercial commitments."))return;try{await api("/api/opportunities/"+encodeURIComponent(opportunity.id)+"/create-validation-goal",{method:"POST",body:"{}"});await refresh()}catch(error){showError(error.message||"Could not create validation plan.")}};actions.append(plan)}if(opportunity.status!=="rejected"){for(const kind of ["income","expense"]){const button=document.createElement("button");button.textContent="Record actual "+kind;button.onclick=async()=>{const amount=prompt("Enter actual "+kind+" amount in pounds (GBP). This only records your report; it does not move money.");if(amount===null)return;const parsed=Number(amount);if(!Number.isFinite(parsed)||parsed<=0||Math.round(parsed*100)!==parsed*100){showError("Enter a positive amount with up to two decimal places.");return}const description=prompt("Describe this actual "+kind+" item:");if(!description)return;try{await api("/api/opportunities/"+encodeURIComponent(opportunity.id)+"/actual",{method:"POST",body:JSON.stringify({kind,amountCents:Math.round(parsed*100),description,idempotencyKey:crypto.randomUUID()})});await refresh()}catch(error){showError(error.message)}};actions.append(button)}}li.append(actions);list.append(li)}}
function renderWorkers(items){const list=byId("workers");list.replaceChildren();if(!items.length){const li=document.createElement("li");li.className="item muted";li.textContent="No active local workers.";list.append(li);return}for(const worker of items){const li=document.createElement("li");li.className="item";const strong=document.createElement("strong");strong.textContent=worker.name+" · "+worker.status;li.append(strong);const pre=document.createElement("pre");pre.textContent=worker.taskTitle+" · retries "+worker.retryCount+"/"+worker.maxRetries;li.append(pre);const button=document.createElement("button");button.className="danger";button.textContent="Stop worker";button.onclick=async()=>{if(confirm("Stop this worker? The task will follow its configured retry policy.")){try{await api("/api/workers/"+encodeURIComponent(worker.taskId)+"/stop",{method:"POST",body:"{}"});await refresh()}catch(error){showError(error.message||"Could not stop worker.")}}};li.append(button);list.append(li)}}
function renderApprovals(payload){byId("approvals").textContent=payload.note||"";const list=byId("pendingApprovals");list.replaceChildren();const pending=payload.pending||[];if(!pending.length){const li=document.createElement("li");li.className="item muted";li.textContent="No pending requests.";list.append(li)}for(const request of pending){const li=document.createElement("li");li.className="item";const strong=document.createElement("strong");strong.textContent=request.actionName+" · "+request.scope+" · "+request.riskLevel;li.append(strong);const pre=document.createElement("pre");const cost=request.estimatedCostCents===null?"unknown":(request.estimatedCostCents/100).toFixed(2);pre.textContent=request.description+"\nRequester: "+request.requesterKind+" "+request.requesterId+"\nEstimated cost: "+cost+" · expires "+request.expiresAt+"\nExact action parameters: "+JSON.stringify(request.actionParameters);li.append(pre);for(const action of ["approve","reject","cancel"]){const button=document.createElement("button");button.textContent=action.charAt(0).toUpperCase()+action.slice(1);button.className=action==="approve"?"primary":action==="cancel"?"danger":"";button.onclick=async()=>{if(action==="approve"&&!confirm("Record approval for exactly these parameters? This does NOT execute the action."))return;try{await api("/api/approvals/"+encodeURIComponent(request.id)+"/"+action,{method:"POST",body:JSON.stringify({note:"Reviewed from the authenticated owner dashboard"})});await refresh()}catch(error){showError(error.message||"Could not record the owner decision.")}};li.append(button)}list.append(li)}renderApprovalHistory(payload.history||[]);addRows("approvalEvents",payload.events||[],x=>x.eventType+" · "+x.requestId,x=>x.actorKind+" "+x.actorId+" · "+x.createdAt+" · "+(x.note||""))}
function renderApprovalHistory(items){const list=byId("approvalHistory");list.replaceChildren();if(!items.length){const li=document.createElement("li");li.className="item muted";li.textContent="No decisions recorded.";list.append(li);return}for(const request of items){const li=document.createElement("li");li.className="item";const strong=document.createElement("strong");strong.textContent=request.actionName+" · "+request.status;li.append(strong);const pre=document.createElement("pre");pre.textContent=request.description+" · reviewed "+(request.reviewedAt||"unknown")+" · "+(request.reviewNote||"no note");li.append(pre);if(request.status==="approved"){const button=document.createElement("button");button.className="danger";button.textContent="Emergency revoke";button.onclick=async()=>{if(confirm("Revoke this recorded approval? It has no execution effect.")){try{await api("/api/approvals/"+encodeURIComponent(request.id)+"/revoke",{method:"POST",body:JSON.stringify({note:"Emergency revocation from owner dashboard"})});await refresh()}catch(error){showError(error.message||"Could not revoke approval.")}}};li.append(button)}list.append(li)}}
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
      if (request.method === "GET" && requestUrl.pathname === "/api/opportunities") {
        sendJson(response, 200, {
          estimatesAreUnverified: true,
          actualsAreOwnerReported: true,
          automaticFinancialExecutionEnabled: false,
          summary: businessOpportunityPerformance(options.db.raw),
          items: listBusinessOpportunities(options.db.raw, clampLimit(requestUrl.searchParams.get("limit"), 50, 100)),
        });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/experiments") {
        sendJson(response, 200, {
          plansAreNonExecuting: true,
          outcomesAreOwnerReported: true,
          items: listBusinessExperiments(options.db.raw, clampLimit(requestUrl.searchParams.get("limit"), 50, 100)),
        });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/self-improvements") {
        const items = listSelfImprovementProposals(options.db.raw, clampLimit(requestUrl.searchParams.get("limit"), 20, 50));
        const workspaces = listSelfImprovementWorkspaces(options.db.raw, items.map((item) => item.id));
        sendJson(response, 200, {
          activationEnabled: false,
          items: items.map(({ files: _files, ...summary }) => ({ ...summary, workspace: workspaces.get(summary.id) ?? null })),
        });
        return;
      }
      const proposalDetails = requestUrl.pathname.match(/^\/api\/self-improvements\/([0-9A-HJKMNP-TV-Z]{26})$/i);
      if (request.method === "GET" && proposalDetails) {
        const proposal = getSelfImprovementProposal(options.db.raw, proposalDetails[1]);
        if (!proposal) {
          sendError(response, 404, "Proposal not found.");
          return;
        }
        sendJson(response, 200, { proposal, workspace: getSelfImprovementWorkspace(options.db.raw, proposal.id), activationEnabled: false });
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
      const approvalAction = requestUrl.pathname.match(/^\/api\/approvals\/([A-Za-z0-9_-]+)\/(approve|reject|cancel|revoke)$/i);
      if (approvalAction) {
        const requestId = approvalAction[1];
        const action = approvalAction[2].toLowerCase();
        const note = typeof body.note === "string" ? body.note.slice(0, 1000) : "";
        const request = action === "approve" || action === "reject"
          ? reviewOwnerApproval(options.db.raw, requestId, action === "approve" ? "approved" : "rejected", "owner-dashboard", note)
          : action === "cancel"
            ? cancelOwnerApproval(options.db.raw, requestId, "owner-dashboard", note || "Cancelled by owner")
            : revokeOwnerApproval(options.db.raw, requestId, "owner-dashboard", note || "Revoked by owner");
        if (!request) {
          sendError(response, 409, "The approval request is missing, expired, or has already been reviewed.");
          return;
        }
        sendJson(response, 200, {
          ok: true,
          approval: request,
          executionEnabled: false,
          message: "Owner decision recorded. This approval system does not execute the requested action.",
        });
        return;
      }
      const opportunityStatus = requestUrl.pathname.match(/^\/api\/opportunities\/([0-9A-HJKMNP-TV-Z]{26})\/status$/i);
      const opportunityPlan = requestUrl.pathname.match(/^\/api\/opportunities\/([0-9A-HJKMNP-TV-Z]{26})\/create-validation-goal$/i);
      if (opportunityPlan) {
        const plan = createOpportunityValidationGoal(options.db.raw, opportunityPlan[1]);
        if (!plan) {
          sendError(response, 404, "Opportunity not found.");
          return;
        }
        sendJson(response, plan.existing ? 200 : 201, {
          ok: true,
          ...plan,
          message: "Persistent validation goal is saved. It is restricted to public-source research and assessment; the tasks prohibit customer contact, spending, publication and commitments.",
        });
        return;
      }
      if (opportunityStatus) {
        if (typeof body.status !== "string" || !OPPORTUNITY_STATUSES.includes(body.status as (typeof OPPORTUNITY_STATUSES)[number])) {
          sendError(response, 400, "Choose a valid opportunity status.");
          return;
        }
        const updated = transitionBusinessOpportunity(options.db.raw, opportunityStatus[1], body.status as (typeof OPPORTUNITY_STATUSES)[number]);
        if (!updated) {
          sendError(response, 404, "Opportunity not found.");
          return;
        }
        sendJson(response, 200, { ok: true, item: updated });
        return;
      }
      const opportunityActual = requestUrl.pathname.match(/^\/api\/opportunities\/([0-9A-HJKMNP-TV-Z]{26})\/actual$/i);
      if (opportunityActual) {
        const item = recordBusinessActual(options.db.raw, {
          opportunityId: opportunityActual[1],
          kind: body.kind as "income" | "expense",
          amountCents: body.amountCents as number,
          description: body.description as string,
          externalReference: typeof body.externalReference === "string" ? body.externalReference : undefined,
          idempotencyKey: body.idempotencyKey as string,
        });
        if (!item) {
          sendError(response, 404, "Opportunity not found.");
          return;
        }
        sendJson(response, 200, { ok: true, item, automaticFinancialExecutionEnabled: false });
        return;
      }
      const experimentReview = requestUrl.pathname.match(/^\/api\/experiments\/([0-9A-HJKMNP-TV-Z]{26})\/review$/i);
      if (experimentReview) {
        if (body.decision !== "completed" && body.decision !== "rejected") {
          sendError(response, 400, "Choose completed or rejected.");
          return;
        }
        const item = reviewBusinessExperiment(options.db.raw, experimentReview[1], body.decision, {
          outcome: typeof body.outcome === "string" ? body.outcome : undefined,
          lesson: typeof body.lesson === "string" ? body.lesson : undefined,
          note: typeof body.note === "string" ? body.note : undefined,
        });
        if (!item) {
          sendError(response, 409, "Experiment is missing or has already been reviewed.");
          return;
        }
        sendJson(response, 200, { ok: true, item, executionEnabled: false, actualsLedgerUpdated: false });
        return;
      }
      const selfImprovementReview = requestUrl.pathname.match(/^\/api\/self-improvements\/([0-9A-HJKMNP-TV-Z]{26})\/(approve|reject)$/i);
      const prepareProposalWorkspace = requestUrl.pathname.match(/^\/api\/self-improvements\/([0-9A-HJKMNP-TV-Z]{26})\/prepare-workspace$/i);
      if (prepareProposalWorkspace) {
        try {
          const workspace = prepareSelfImprovementWorkspace(options.db.raw, getAutomatonDir(), prepareProposalWorkspace[1]);
          sendJson(response, 200, { ok: true, workspace, verificationStatus: "not_run", executionEnabled: false });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendError(response, message.includes("not found") ? 404 : 409, message);
        }
        return;
      }
      if (selfImprovementReview) {
        const proposal = reviewSelfImprovementProposal(
          options.db.raw,
          selfImprovementReview[1],
          selfImprovementReview[2].toLowerCase() === "approve" ? "approved" : "rejected",
          typeof body.note === "string" ? body.note : "",
        );
        if (!proposal) {
          sendError(response, 409, "Proposal is missing, expired, or has already been reviewed.");
          return;
        }
        sendJson(response, 200, {
          ok: true,
          proposal,
          activationEnabled: false,
          message: "Owner review recorded. Proposed code was not executed, tested, written to the live tree, or activated.",
        });
        return;
      }
      const workerStop = requestUrl.pathname.match(/^\/api\/workers\/([A-Za-z0-9_-]+)\/stop$/);
      if (workerStop) {
        const stopped = options.onStopLocalWorker?.(workerStop[1]) ?? false;
        if (!stopped) {
          sendError(response, 409, "No active local worker was found for that task.");
          return;
        }
        sendJson(response, 200, { ok: true, stopRequested: true });
        return;
      }
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
