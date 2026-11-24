/**
 * Persistent, action-bound owner review records.
 * Approved records are audit state only; no runtime tool consumes them.
 */
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { ulid } from "ulid";

export type ApprovalScope = "financial" | "paid_cloud" | "publication" | "commercial" | "software_change" | "other";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled" | "revoked";
export type ApprovalRisk = "safe" | "caution" | "dangerous" | "forbidden";

export interface ApprovalRequestInput {
  requesterId: string;
  requesterKind: "agent" | "child";
  scope: ApprovalScope;
  actionName: string;
  actionParameters: Record<string, unknown>;
  description: string;
  estimatedCostCents?: number | null;
  riskLevel: ApprovalRisk;
  expiresInMs?: number;
}

export interface OwnerApprovalRequest {
  id: string;
  requesterId: string;
  requesterKind: "agent" | "child";
  scope: ApprovalScope;
  actionName: string;
  actionParameters: Record<string, unknown>;
  actionHash: string;
  description: string;
  estimatedCostCents: number | null;
  riskLevel: ApprovalRisk;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
}

export interface OwnerApprovalEvent {
  id: string;
  requestId: string;
  eventType: "requested" | "approved" | "rejected" | "expired" | "cancelled" | "revoked";
  actorKind: "agent" | "child" | "owner" | "system";
  actorId: string;
  note: string;
  createdAt: string;
}

const SCOPES = new Set<ApprovalScope>(["financial", "paid_cloud", "publication", "commercial", "software_change", "other"]);
const RISKS = new Set<ApprovalRisk>(["safe", "caution", "dangerous", "forbidden"]);
const DEFAULT_EXPIRY_MS = 24 * 60 * 60 * 1000;
const MAX_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PARAMETERS_BYTES = 32 * 1024;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Approval parameters must contain finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (!value || typeof value !== "object") throw new Error("Approval parameters must be JSON values.");
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return "{" + entries.map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry)).join(",") + "}";
}

function rowToRequest(row: any): OwnerApprovalRequest {
  return {
    id: row.id,
    requesterId: row.requester_id,
    requesterKind: row.requester_kind,
    scope: row.scope,
    actionName: row.action_name,
    actionParameters: JSON.parse(row.action_parameters),
    actionHash: row.action_hash,
    description: row.description,
    estimatedCostCents: row.estimated_cost_cents,
    riskLevel: row.risk_level,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reviewedAt: row.reviewed_at,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
  };
}

function appendEvent(
  db: Database.Database,
  requestId: string,
  eventType: OwnerApprovalEvent["eventType"],
  actorKind: OwnerApprovalEvent["actorKind"],
  actorId: string,
  note = "",
  createdAt = new Date().toISOString(),
): void {
  db.prepare(
    "INSERT INTO owner_approval_events (id, request_id, event_type, actor_kind, actor_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(ulid(), requestId, eventType, actorKind, actorId, note.slice(0, 1000), createdAt);
}

function expirePending(db: Database.Database, now: string): void {
  const expired = db.prepare(
    "SELECT id FROM owner_approval_requests WHERE status = 'pending' AND expires_at <= ?",
  ).all(now) as Array<{ id: string }>;
  if (!expired.length) return;
  db.prepare(
    "UPDATE owner_approval_requests SET status = 'expired', reviewed_at = ?, reviewed_by = 'system', review_note = 'Request expired' WHERE status = 'pending' AND expires_at <= ?",
  ).run(now, now);
  for (const row of expired) appendEvent(db, row.id, "expired", "system", "approval-expiry", "", now);
}

export function requestOwnerApproval(
  db: Database.Database,
  input: ApprovalRequestInput,
  now = new Date(),
): OwnerApprovalRequest {
  const requesterId = input.requesterId.trim();
  const actionName = input.actionName.trim();
  const description = input.description.trim();
  if (!requesterId || requesterId.length > 160 || requesterId === "owner-dashboard") throw new Error("Invalid approval requester.");
  if (!actionName || actionName.length > 120) throw new Error("Invalid approval action name.");
  if (!description || description.length > 1000) throw new Error("Approval description must be 1-1000 characters.");
  if (!SCOPES.has(input.scope) || !RISKS.has(input.riskLevel)) throw new Error("Invalid approval scope or risk level.");
  if (input.requesterKind !== "agent" && input.requesterKind !== "child") throw new Error("Invalid approval requester type.");
  const estimatedCostCents = input.estimatedCostCents ?? null;
  if (estimatedCostCents !== null && (!Number.isSafeInteger(estimatedCostCents) || estimatedCostCents < 0)) throw new Error("Estimated cost must be a non-negative integer number of cents.");
  const expiryMs = input.expiresInMs ?? DEFAULT_EXPIRY_MS;
  if (!Number.isSafeInteger(expiryMs) || expiryMs < 60_000 || expiryMs > MAX_EXPIRY_MS) throw new Error("Approval expiry must be between one minute and seven days.");
  if (!input.actionParameters || Array.isArray(input.actionParameters) || typeof input.actionParameters !== "object") throw new Error("Approval parameters must be a JSON object.");

  const parameters = canonicalJson(input.actionParameters);
  if (Buffer.byteLength(parameters) > MAX_PARAMETERS_BYTES) throw new Error("Approval parameters exceed 32KB.");
  const actionHash = createHash("sha256")
    .update(canonicalJson({ scope: input.scope, actionName, actionParameters: JSON.parse(parameters) }))
    .digest("hex");
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + expiryMs).toISOString();
  const transaction = db.transaction(() => {
    expirePending(db, createdAt);
    const existing = db.prepare(
      "SELECT * FROM owner_approval_requests WHERE action_hash = ? AND status = 'pending' AND expires_at > ?",
    ).get(actionHash, createdAt) as any;
    if (existing) return rowToRequest(existing);

    const id = ulid();
    db.prepare(
      "INSERT INTO owner_approval_requests (id, requester_id, requester_kind, scope, action_name, action_parameters, action_hash, description, estimated_cost_cents, risk_level, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    ).run(id, requesterId, input.requesterKind, input.scope, actionName, parameters, actionHash, description, estimatedCostCents, input.riskLevel, createdAt, expiresAt);
    appendEvent(db, id, "requested", input.requesterKind, requesterId, description, createdAt);
    return rowToRequest(db.prepare("SELECT * FROM owner_approval_requests WHERE id = ?").get(id));
  });
  return transaction();
}

export function listOwnerApprovalRequests(
  db: Database.Database,
  options: { status?: ApprovalStatus; limit?: number } = {},
  now = new Date(),
): OwnerApprovalRequest[] {
  const expire = db.transaction(() => expirePending(db, now.toISOString()));
  expire();
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
  const rows = options.status
    ? db.prepare("SELECT * FROM owner_approval_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(options.status, limit)
    : db.prepare("SELECT * FROM owner_approval_requests ORDER BY created_at DESC LIMIT ?").all(limit);
  return (rows as any[]).map(rowToRequest);
}

export function listOwnerApprovalEvents(
  db: Database.Database,
  requestId?: string,
  limit = 100,
): OwnerApprovalEvent[] {
  const boundedLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  const rows = requestId
    ? db.prepare("SELECT * FROM owner_approval_events WHERE request_id = ? ORDER BY created_at DESC LIMIT ?").all(requestId, boundedLimit)
    : db.prepare("SELECT * FROM owner_approval_events ORDER BY created_at DESC LIMIT ?").all(boundedLimit);
  return (rows as any[]).map((row) => ({
    id: row.id,
    requestId: row.request_id,
    eventType: row.event_type,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    note: row.note,
    createdAt: row.created_at,
  }));
}

export function reviewOwnerApproval(
  db: Database.Database,
  requestId: string,
  decision: "approved" | "rejected",
  reviewerId: string,
  note = "",
  now = new Date(),
): OwnerApprovalRequest | null {
  const actorId = reviewerId.trim();
  if (!actorId || actorId.length > 160) throw new Error("Invalid owner reviewer.");
  const transaction = db.transaction(() => {
    const createdAt = now.toISOString();
    expirePending(db, createdAt);
    const row = db.prepare("SELECT * FROM owner_approval_requests WHERE id = ?").get(requestId) as any;
    if (!row || row.status !== "pending" || row.expires_at <= createdAt) return null;
    if (row.requester_id === actorId) throw new Error("A requester cannot review its own action.");
    const changed = db.prepare(
      "UPDATE owner_approval_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = 'pending' AND action_hash = ? AND expires_at > ?",
    ).run(decision, createdAt, actorId, note.slice(0, 1000), requestId, row.action_hash, createdAt);
    if (changed.changes !== 1) return null;
    appendEvent(db, requestId, decision, "owner", actorId, note, createdAt);
    return rowToRequest(db.prepare("SELECT * FROM owner_approval_requests WHERE id = ?").get(requestId));
  });
  return transaction();
}

export function cancelOwnerApproval(
  db: Database.Database,
  requestId: string,
  ownerId: string,
  note = "Cancelled by owner",
  now = new Date(),
): OwnerApprovalRequest | null {
  return changeOwnerState(db, requestId, "pending", "cancelled", ownerId, note, now);
}

export function revokeOwnerApproval(
  db: Database.Database,
  requestId: string,
  ownerId: string,
  note = "Revoked by owner",
  now = new Date(),
): OwnerApprovalRequest | null {
  return changeOwnerState(db, requestId, "approved", "revoked", ownerId, note, now);
}

function changeOwnerState(
  db: Database.Database,
  requestId: string,
  from: "pending" | "approved",
  to: "cancelled" | "revoked",
  ownerId: string,
  note: string,
  now: Date,
): OwnerApprovalRequest | null {
  const actorId = ownerId.trim();
  if (!actorId || actorId.length > 160) throw new Error("Invalid owner reviewer.");
  const transaction = db.transaction(() => {
    const createdAt = now.toISOString();
    expirePending(db, createdAt);
    const row = db.prepare("SELECT * FROM owner_approval_requests WHERE id = ?").get(requestId) as any;
    if (!row || row.status !== from) return null;
    if (row.requester_id === actorId) throw new Error("A requester cannot change its own approval.");
    const changed = db.prepare(
      "UPDATE owner_approval_requests SET status = ?, reviewed_at = ?, reviewed_by = ?, review_note = ? WHERE id = ? AND status = ? AND action_hash = ?",
    ).run(to, createdAt, actorId, note.slice(0, 1000), requestId, from, row.action_hash);
    if (changed.changes !== 1) return null;
    appendEvent(db, requestId, to, "owner", actorId, note, createdAt);
    return rowToRequest(db.prepare("SELECT * FROM owner_approval_requests WHERE id = ?").get(requestId));
  });
  return transaction();
}

