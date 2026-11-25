/**
 * Local, bounded business outputs linked to existing opportunities and tasks.
 * Content is stored as review-only Markdown under the private Automaton data
 * directory. It is never executed or published by this module.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "ulid";

export const BUSINESS_DELIVERABLE_TYPES = [
  "business_plan", "market_report", "product_spec", "prototype_spec", "website_draft", "experiment_spec",
] as const;
export type BusinessDeliverableType = typeof BUSINESS_DELIVERABLE_TYPES[number];
export type BusinessDeliverableStatus = "draft" | "pending_review" | "approved_for_internal_use" | "changes_requested" | "archived";
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_VERSIONS = 20;
const MAX_DELIVERABLES = 100;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export interface BusinessDeliverable {
  id: string;
  opportunityId: string;
  taskId: string | null;
  type: BusinessDeliverableType;
  title: string;
  status: BusinessDeliverableStatus;
  version: number;
  contentSha256: string;
  byteSize: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  reviewedBy: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  content?: string;
  versions?: Array<{ version: number; contentSha256: string; byteSize: number; createdBy: string; createdAt: string }>;
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be text.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${name} must contain 1-${max} characters.`);
  return normalized;
}

function safeStorageRoot(privateDataRoot: string): { root: string; directory: string } {
  fs.mkdirSync(privateDataRoot, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(privateDataRoot);
  const directory = path.join(root, "business-deliverables");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Business deliverable storage must be a private real directory.");
  const realDirectory = fs.realpathSync(directory);
  if (!realDirectory.startsWith(root + path.sep)) throw new Error("Business deliverable storage escaped the private data directory.");
  return { root, directory: realDirectory };
}

function storageTarget(privateDataRoot: string, relativePath: string, forWrite = false): string {
  const { root, directory } = safeStorageRoot(privateDataRoot);
  if (!/^business-deliverables\/[0-9A-HJKMNP-TV-Z]{26}\/v[1-9][0-9]*\.md$/i.test(relativePath)) {
    throw new Error("Stored business deliverable path is invalid.");
  }
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(directory + path.sep)) throw new Error("Stored business deliverable path escaped its workspace.");
  const parts = path.relative(root, path.dirname(target)).split(path.sep);
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Symbolic links are not permitted in business deliverable storage.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !forWrite) throw error;
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
  }
  return target;
}

function mapRow(row: any): BusinessDeliverable {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    taskId: row.task_id,
    type: row.artifact_type,
    title: row.title,
    status: row.status,
    version: row.version,
    contentSha256: row.content_sha256,
    byteSize: row.byte_size,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedBy: row.reviewed_by,
    reviewNote: row.review_note,
    reviewedAt: row.reviewed_at,
  };
}

const currentQuery = `SELECT d.*,v.version,v.content_sha256,v.byte_size,v.storage_path,v.created_by AS version_created_by,v.created_at AS version_created_at
  FROM business_deliverables d JOIN business_deliverable_versions v ON v.deliverable_id=d.id AND v.version=d.current_version`;

/** Create a reviewable deliverable, or append a version to the same named item. */
export function saveBusinessDeliverable(
  db: Database.Database,
  privateDataRoot: string,
  input: { opportunityId: string; taskId?: string | null; type: BusinessDeliverableType; title: string; content: string },
  createdBy: string,
  now = new Date(),
): BusinessDeliverable {
  if (!ID.test(input.opportunityId)) throw new Error("Opportunity id is invalid.");
  if (input.taskId && !ID.test(input.taskId)) throw new Error("Task id is invalid.");
  if (!BUSINESS_DELIVERABLE_TYPES.includes(input.type)) throw new Error("Deliverable type is not supported.");
  const title = boundedText(input.title, "Title", 120);
  const content = boundedText(input.content, "Content", MAX_CONTENT_BYTES);
  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > MAX_CONTENT_BYTES) throw new Error(`Deliverable exceeds the ${MAX_CONTENT_BYTES} byte limit.`);
  const author = boundedText(createdBy, "Creator", 160);
  const opportunity = db.prepare("SELECT validation_goal_id FROM business_opportunities WHERE id=?").get(input.opportunityId) as { validation_goal_id: string | null } | undefined;
  if (!opportunity) throw new Error("Business opportunity was not found.");
  if (input.taskId) {
    const task = db.prepare("SELECT goal_id FROM task_graph WHERE id=?").get(input.taskId) as { goal_id: string } | undefined;
    if (!task || !opportunity.validation_goal_id || task.goal_id !== opportunity.validation_goal_id) {
      throw new Error("Deliverable task must belong to this opportunity's validation goal.");
    }
  }

  const hash = digest(content);
  const existing = db.prepare(`SELECT * FROM business_deliverables WHERE opportunity_id=? AND artifact_type=? AND title=?`)
    .get(input.opportunityId, input.type, title) as any;
  if (existing) {
    const current = db.prepare("SELECT content_sha256 FROM business_deliverable_versions WHERE deliverable_id=? AND version=?")
      .get(existing.id, existing.current_version) as { content_sha256: string } | undefined;
    if (current?.content_sha256 === hash) return getBusinessDeliverable(db, privateDataRoot, existing.id, true)!;
    if (existing.status === "archived") throw new Error("Archived deliverables cannot be changed; create a new title.");
    if (existing.current_version >= MAX_VERSIONS) throw new Error(`A deliverable is limited to ${MAX_VERSIONS} versions.`);
  } else {
    const count = db.prepare("SELECT COUNT(*) AS count FROM business_deliverables WHERE status <> 'archived'").get() as { count: number };
    if (count.count >= MAX_DELIVERABLES) throw new Error(`The local deliverable limit (${MAX_DELIVERABLES}) has been reached.`);
  }

  const id = existing?.id ?? ulid();
  const version = existing ? existing.current_version + 1 : 1;
  const relativePath = `business-deliverables/${id}/v${version}.md`;
  const target = storageTarget(privateDataRoot, relativePath, true);
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  fs.writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
  let linked = false;
  try {
    // A hard-link install is atomic and fails if an orphaned or planted target
    // already exists; rename would silently replace that target on some OSes.
    fs.linkSync(temp, target);
    linked = true;
    fs.unlinkSync(temp);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    if (linked) fs.rmSync(target, { force: true });
    throw error;
  }

  const timestamp = now.toISOString();
  try {
    const transaction = db.transaction(() => {
      if (existing) {
        db.prepare(`UPDATE business_deliverables SET task_id=COALESCE(?,task_id),status='pending_review',current_version=?,updated_at=?,reviewed_by=NULL,review_note=NULL,reviewed_at=NULL WHERE id=?`)
          .run(input.taskId ?? null, version, timestamp, id);
      } else {
        db.prepare(`INSERT INTO business_deliverables
          (id,opportunity_id,task_id,artifact_type,title,status,created_by,current_version,created_at,updated_at)
          VALUES (?,?,?,?,?,'pending_review',?,1,?,?)`)
          .run(id, input.opportunityId, input.taskId ?? null, input.type, title, author, timestamp, timestamp);
      }
      db.prepare(`INSERT INTO business_deliverable_versions
        (id,deliverable_id,version,content_sha256,byte_size,storage_path,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(ulid(), id, version, hash, byteSize, relativePath, author, timestamp);
      db.prepare(`INSERT INTO business_deliverable_events (id,deliverable_id,event_type,actor_kind,actor_id,details_json,created_at)
        VALUES (?,?,?,?,?,?,?)`).run(ulid(), id, existing ? "version_added" : "prepared", "agent", author,
        JSON.stringify({ type: input.type, version, contentSha256: hash, ownerReviewRequested: true }), timestamp);
    });
    transaction();
  } catch (error) {
    fs.rmSync(target, { force: true });
    throw error;
  }
  return getBusinessDeliverable(db, privateDataRoot, id, true)!;
}

export function getBusinessDeliverable(db: Database.Database, privateDataRoot: string, id: string, includeContent = false): BusinessDeliverable | null {
  if (!ID.test(id)) return null;
  const row = db.prepare(`${currentQuery} WHERE d.id=?`).get(id) as any;
  if (!row) return null;
  const item = mapRow(row);
  if (includeContent) {
    const target = storageTarget(privateDataRoot, row.storage_path);
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.byteSize || stat.size > MAX_CONTENT_BYTES) {
      throw new Error("Deliverable file failed its size or type integrity check.");
    }
    const content = fs.readFileSync(target, "utf8");
    if (digest(content) !== item.contentSha256) throw new Error("Deliverable file failed its SHA-256 integrity check.");
    item.content = content;
  }
  return item;
}

export function listBusinessDeliverables(db: Database.Database, limit = 50): BusinessDeliverable[] {
  const boundedLimit = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
  const rows = db.prepare(`${currentQuery} ORDER BY d.updated_at DESC LIMIT ?`).all(boundedLimit) as any[];
  const versions = db.prepare(`SELECT version,content_sha256,byte_size,created_by,created_at FROM business_deliverable_versions
    WHERE deliverable_id=? ORDER BY version ASC`);
  return rows.map((row) => ({
    ...mapRow(row),
    versions: (versions.all(row.id) as any[]).map((version) => ({
      version: version.version, contentSha256: version.content_sha256, byteSize: version.byte_size,
      createdBy: version.created_by, createdAt: version.created_at,
    })),
  }));
}

/** Owner review only changes an internal planning state. It cannot publish or execute the artifact. */
export function reviewBusinessDeliverable(
  db: Database.Database,
  id: string,
  decision: "approved_for_internal_use" | "changes_requested" | "archived",
  note: string,
  now = new Date(),
): BusinessDeliverable | null {
  if (!ID.test(id)) return null;
  if (!["approved_for_internal_use", "changes_requested", "archived"].includes(decision)) throw new Error("Invalid owner review decision.");
  const normalizedNote = typeof note === "string" ? note.replace(/\s+/g, " ").trim().slice(0, 1000) : "";
  const timestamp = now.toISOString();
  const update = db.prepare(`UPDATE business_deliverables SET status=?,reviewed_by='owner-dashboard',review_note=?,reviewed_at=?,updated_at=? WHERE id=? AND status='pending_review'`)
    .run(decision, normalizedNote, timestamp, timestamp, id);
  if (update.changes !== 1) return null;
  const row = db.prepare("SELECT opportunity_id FROM business_deliverables WHERE id=?").get(id) as { opportunity_id: string };
  db.prepare(`INSERT INTO business_deliverable_events (id,deliverable_id,event_type,actor_kind,actor_id,details_json,created_at)
    VALUES (?,?, 'reviewed','owner','owner-dashboard',?,?)`).run(ulid(), id,
    JSON.stringify({ opportunityId: row.opportunity_id, decision, note: normalizedNote, publicationEnabled: false }), timestamp);
  return getBusinessDeliverable(db, "", id, false);
}
