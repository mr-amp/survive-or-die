/**
 * Bounded, read-only public-source retrieval for business research.
 * A successful HTTP fetch is provenance, not proof that a source or claim is true.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";
import type Database from "better-sqlite3";
import { ulid } from "ulid";

export const RESEARCH_LIMITS = Object.freeze({ timeoutMs: 8_000, totalTimeoutMs: 12_000, maxBytes: 256 * 1024, maxExcerptChars: 12_000, maxRedirects: 3, perHostPerMinute: 5, perHostPerDay: 40 });
const SECRET_QUERY = /^(token|access_token|api[_-]?key|key|secret|password|passwd|auth|authorization|session|cookie)$/i;
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("request_timeout")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export interface ResearchResponse { status: number; headers: Record<string, string | undefined>; body: Uint8Array; }
export interface ResearchDependencies {
  resolve(host: string): Promise<string[]>;
  request(url: URL, pinnedAddress: string, timeoutMs: number, maxBytes: number): Promise<ResearchResponse>;
  now?: () => Date;
}
export interface ResearchResult {
  id: string; status: "retrieved" | "failed" | "blocked"; requestedUrl: string; finalUrl: string | null;
  host: string; researchArea: string; retrievedAt: string; httpStatus: number | null; contentType: string | null;
  title: string | null; excerpt: string; contentSha256: string | null; errorCode: string | null;
}

function ipv4IsPublic(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false;
  const [a, b] = octets;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 192 && b === 2) || (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 192 && b === 88 && octets[2] === 99) || (a === 203 && b === 0));
}

function ipv6IsPublic(address: string): boolean {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff")) return false;
  // Global unicast currently occupies 2000::/3. Exclude documentation and discard-only ranges.
  if (!/^[23][0-9a-f]{3}:/i.test(value) || value.startsWith("2001:db8:") || value.startsWith("2001:0000:") || value.startsWith("2002:")) return false;
  return true;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? ipv4IsPublic(address) : family === 6 ? ipv6IsPublic(address) : false;
}

export function canonicalResearchHost(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("*") || value.includes("/") || value.includes(":")) throw new Error("invalid_host");
  const parsed = new URL(`https://${value.trim()}`);
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash || isIP(parsed.hostname)) throw new Error("invalid_host");
  return parsed.hostname.toLowerCase().replace(/\.$/, "");
}

function parseSafeUrl(raw: string, allowedHosts: Set<string>): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("invalid_url");
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid_url"); }
  if (url.protocol !== "https:" || url.port && url.port !== "443" || url.username || url.password || url.hash || isIP(url.hostname)) throw new Error("url_not_permitted");
  for (const key of url.searchParams.keys()) if (SECRET_QUERY.test(key)) throw new Error("sensitive_url_parameter");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!allowedHosts.has(host)) throw new Error("host_not_allowlisted");
  url.hostname = host;
  return url;
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
    const name = entity.toLowerCase();
    if (name[0] === "#") {
      const code = name[1] === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[name] || match;
  });
}

export function extractPublicText(input: string, maxChars = RESEARCH_LIMITS.maxExcerptChars): { title: string | null; text: string } {
  const title = input.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1];
  const text = decodeEntities(input
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|svg|iframe|object|form|noscript|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style|template|svg|iframe|object|form|noscript|head|title)\b[^>]*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
  const cleanTitle = title ? decodeEntities(title.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 200) : null;
  return { title: cleanTitle || null, text: text.slice(0, maxChars) };
}

const productionDependencies: ResearchDependencies = {
  resolve: async (host) => (await lookup(host, { all: true, verbatim: true })).map((item) => item.address),
  request: (url, pinnedAddress, timeoutMs, maxBytes) => new Promise((resolve, reject) => {
    const family = isIP(pinnedAddress);
    const req = https.request(url, {
      method: "GET", timeout: timeoutMs, servername: url.hostname,
      headers: { Accept: "text/html, text/plain, application/xhtml+xml;q=0.9", "Accept-Encoding": "identity", "User-Agent": "SurviveOrDie-Research/1.0" },
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null, pinnedAddress, family)) as never,
    }, (response) => {
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { req.destroy(new Error("response_too_large")); return; } chunks.push(chunk); });
      response.on("end", () => resolve({ status: response.statusCode || 0, headers: {
        location: response.headers.location, "content-type": response.headers["content-type"], "content-encoding": response.headers["content-encoding"], "content-length": response.headers["content-length"],
      }, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    req.end();
  }),
};

function record(db: Database.Database, row: ResearchResult, opportunityId: string | null, requestedBy: string): void {
  const updated = db.prepare(`UPDATE business_research_retrievals SET opportunity_id=?,requested_url=?,final_url=?,host=?,research_area=?,status=?,http_status=?,content_type=?,page_title=?,excerpt=?,content_sha256=?,error_code=?,retrieved_at=?,requested_by=? WHERE id=?`)
    .run(opportunityId, row.requestedUrl, row.finalUrl, row.host, row.researchArea, row.status, row.httpStatus, row.contentType, row.title, row.excerpt, row.contentSha256, row.errorCode, row.retrievedAt, requestedBy, row.id);
  if (updated.changes > 0) return;
  db.prepare(`INSERT INTO business_research_retrievals
    (id,opportunity_id,requested_url,final_url,host,research_area,status,http_status,content_type,page_title,excerpt,content_sha256,error_code,retrieved_at,requested_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, opportunityId, row.requestedUrl, row.finalUrl, row.host, row.researchArea, row.status, row.httpStatus, row.contentType, row.title, row.excerpt, row.contentSha256, row.errorCode, row.retrievedAt, requestedBy);
}

export function listResearchRetrievals(db: Database.Database, opportunityId?: string, limit = 50): ResearchResult[] {
  const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = opportunityId
    ? db.prepare("SELECT * FROM business_research_retrievals WHERE opportunity_id = ? ORDER BY retrieved_at DESC LIMIT ?").all(opportunityId, bounded)
    : db.prepare("SELECT * FROM business_research_retrievals ORDER BY retrieved_at DESC LIMIT ?").all(bounded);
  return (rows as any[]).map((row) => ({ id: row.id, status: row.status, requestedUrl: row.requested_url, finalUrl: row.final_url, host: row.host, researchArea: row.research_area, retrievedAt: row.retrieved_at, httpStatus: row.http_status, contentType: row.content_type, title: row.page_title, excerpt: row.excerpt, contentSha256: row.content_sha256, errorCode: row.error_code }));
}

export async function retrievePublicResearch(
  db: Database.Database,
  input: { url: string; opportunityId?: string; researchArea: string; requestedBy: string },
  config: { publicResearchEnabled?: boolean; publicResearchAllowedHosts?: string[] },
  dependencies: ResearchDependencies = productionDependencies,
): Promise<ResearchResult> {
  const now = dependencies.now ?? (() => new Date());
  let requestUrl: URL;
  let host = "invalid";
  let activeReservationId: string | null = null;
  const allowed = new Set<string>();
  try {
    if (config.publicResearchEnabled !== true) throw new Error("research_disabled");
    for (const entry of config.publicResearchAllowedHosts ?? []) allowed.add(canonicalResearchHost(entry));
    requestUrl = parseSafeUrl(input.url, allowed);
    host = requestUrl.hostname;
    if (input.opportunityId && !db.prepare("SELECT 1 FROM business_opportunities WHERE id=?").get(input.opportunityId)) throw new Error("opportunity_not_found");
    const area = input.researchArea.trim();
    if (!area || area.length > 80 || !input.requestedBy || input.requestedBy.length > 160) throw new Error("invalid_request");
    const timestamp = now().toISOString();
    const initial = requestUrl.href;
    const retrievalId = ulid();
    const reserve = db.transaction(() => {
      const count = db.prepare("SELECT COUNT(*) AS count FROM business_research_retrievals WHERE host=? AND retrieved_at>=? AND status!='blocked'").get(host, new Date(now().getTime() - 60_000).toISOString()) as { count: number };
      const daily = db.prepare("SELECT COUNT(*) AS count FROM business_research_retrievals WHERE host=? AND retrieved_at>=? AND status!='blocked'").get(host, new Date(now().getTime() - 86_400_000).toISOString()) as { count: number };
      if (count.count >= RESEARCH_LIMITS.perHostPerMinute || daily.count >= RESEARCH_LIMITS.perHostPerDay) return false;
      db.prepare(`INSERT INTO business_research_retrievals (id,opportunity_id,requested_url,host,research_area,status,error_code,retrieved_at,requested_by)
        VALUES (?,?,?,?,?,'pending','in_progress',?,?)`).run(retrievalId, input.opportunityId ?? null, initial, host, area, timestamp, input.requestedBy);
      return true;
    });
    if (!reserve()) throw new Error("rate_limited");
    activeReservationId = retrievalId;
    const deadline = Date.now() + RESEARCH_LIMITS.totalTimeoutMs;
    for (let redirects = 0; redirects <= RESEARCH_LIMITS.maxRedirects; redirects++) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new Error("request_timeout");
      const addresses = await withTimeout(dependencies.resolve(requestUrl.hostname), remainingMs);
      if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) throw new Error("unsafe_dns_result");
      const response = await dependencies.request(requestUrl, addresses[0], Math.min(RESEARCH_LIMITS.timeoutMs, deadline - Date.now()), RESEARCH_LIMITS.maxBytes);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.location;
        if (!location || redirects === RESEARCH_LIMITS.maxRedirects) throw new Error("redirect_limit");
        requestUrl = parseSafeUrl(new URL(location, requestUrl).href, allowed);
        continue;
      }
      const contentType = (response.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const contentEncoding = (response.headers["content-encoding"] || "identity").toLowerCase();
      const declaredLength = Number(response.headers["content-length"] || 0);
      if (declaredLength > RESEARCH_LIMITS.maxBytes || response.body.byteLength > RESEARCH_LIMITS.maxBytes) throw new Error("response_too_large");
      if (contentEncoding !== "identity") throw new Error("encoded_response_rejected");
      if (!["text/html", "text/plain", "application/xhtml+xml"].includes(contentType)) throw new Error("content_type_rejected");
      if (response.status < 200 || response.status >= 300) throw new Error(`http_${response.status}`);
      const decoded = new TextDecoder("utf-8", { fatal: false }).decode(response.body);
      const extracted = contentType === "text/plain" ? { title: null, text: decoded.replace(/\s+/g, " ").trim().slice(0, RESEARCH_LIMITS.maxExcerptChars) } : extractPublicText(decoded);
      const result: ResearchResult = { id: retrievalId, status: "retrieved", requestedUrl: initial, finalUrl: requestUrl.href, host, researchArea: area, retrievedAt: timestamp, httpStatus: response.status, contentType, title: extracted.title, excerpt: extracted.text, contentSha256: createHash("sha256").update(response.body).digest("hex"), errorCode: null };
      record(db, result, input.opportunityId ?? null, input.requestedBy);
      return result;
    }
    throw new Error("redirect_limit");
  } catch (error) {
    const code = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) : "research_failed";
    const parsedHost = (() => { try { return new URL(input.url).hostname.toLowerCase(); } catch { return host; } })();
    const isBlocked = ["research_disabled", "invalid_url", "url_not_permitted", "sensitive_url_parameter", "host_not_allowlisted", "unsafe_dns_result", "invalid_host", "opportunity_not_found", "rate_limited", "invalid_request"].includes(code);
    const result: ResearchResult = { id: ulid(), status: isBlocked ? "blocked" : "failed", requestedUrl: input.url.slice(0, 2048), finalUrl: null, host: parsedHost.slice(0, 253), researchArea: (input.researchArea || "unknown").slice(0, 80), retrievedAt: now().toISOString(), httpStatus: null, contentType: null, title: null, excerpt: "", contentSha256: null, errorCode: code };
    // Never retain URLs containing userinfo or secret-like query parameters.
    const safeToPersist = (() => { try { const parsed = new URL(input.url); return !parsed.username && !parsed.password && [...parsed.searchParams.keys()].every((key) => !SECRET_QUERY.test(key)); } catch { return false; } })();
    const attachedOpportunity = input.opportunityId && db.prepare("SELECT 1 FROM business_opportunities WHERE id=?").get(input.opportunityId) ? input.opportunityId : null;
    if (safeToPersist && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='business_research_retrievals'").get()) {
      record(db, { ...result, id: activeReservationId ?? result.id }, attachedOpportunity, (input.requestedBy || "unknown").slice(0, 160));
    }
    return result;
  }
}
