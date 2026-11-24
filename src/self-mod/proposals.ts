/** Draft-only self-improvement proposals. This module stores proposals and
 * review evidence but contains no live-file writer, shell runner or activator.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { requestOwnerApproval, reviewOwnerApproval } from "../approvals/store.js";
import { isProtectedFile } from "./code.js";

const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 250_000;
const MAX_FILES = 12;
const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BLOCKED_PATH_SEGMENTS = new Set([".git", ".automaton", "node_modules", ".ssh", ".aws", ".azure", ".gnupg"]);
const WINDOWS_RESERVED_PATH = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface ProposedFile {
  path: string;
  content: string;
}

export interface SelfImprovementProposalInput {
  title: string;
  rationale: string;
  files: ProposedFile[];
  requesterId: string;
  requesterKind: "agent" | "child";
}

export interface SelfImprovementProposal {
  id: string;
  title: string;
  rationale: string;
  files: ProposedFile[];
  diffPreview: string;
  diffHash: string;
  verificationStatus: "not_run" | "passed" | "failed";
  verificationSummary: string;
  approvalRequestId: string;
  status: "pending_review" | "approved_for_manual_activation" | "rejected" | "expired";
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} must be 1-${max} characters.`);
  }
  return value.trim();
}

function normaliseProposalFiles(files: ProposedFile[]): ProposedFile[] {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    throw new Error(`A proposal must contain 1-${MAX_FILES} files.`);
  }
  const root = path.resolve(process.cwd());
  const seen = new Set<string>();
  let totalBytes = 0;
  return files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Each proposal file requires a path and text content.");
    const proposedPath = file.path.trim().replace(/\\/g, "/");
    if (!proposedPath || proposedPath.includes("\0") || path.isAbsolute(proposedPath) || proposedPath.split("/").some((part) => part === ".." || part === "" || WINDOWS_RESERVED_PATH.test(part) || WINDOWS_RESERVED_NAME.test(part) || part.endsWith(".") || part.endsWith(" "))) {
      throw new Error(`Unsafe proposal path: ${file.path}`);
    }
    const resolved = path.resolve(root, proposedPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Proposal path leaves the repository: ${file.path}`);
    if (isProtectedFile(resolved)) throw new Error(`Protected runtime file cannot be proposed for self-modification: ${proposedPath}`);
    if (proposedPath.split("/").some((part) => BLOCKED_PATH_SEGMENTS.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /\.(?:pem|key)$/i.test(part))) {
      throw new Error(`Sensitive or generated paths cannot be proposed: ${proposedPath}`);
    }
    let existingAncestor = resolved;
    while (existingAncestor !== root && !fs.existsSync(existingAncestor)) existingAncestor = path.dirname(existingAncestor);
    if (fs.existsSync(existingAncestor)) {
      const real = fs.realpathSync(existingAncestor);
      if (real !== root && !real.startsWith(root + path.sep)) throw new Error(`Proposal path resolves outside the repository: ${proposedPath}`);
    }
    const normal = proposedPath.split("/").join(path.sep);
    const duplicateKey = normal.toLowerCase();
    if (seen.has(duplicateKey)) throw new Error(`Duplicate proposal path: ${proposedPath}`);
    seen.add(duplicateKey);
    const bytes = Buffer.byteLength(file.content, "utf8");
    if (bytes > MAX_FILE_BYTES) throw new Error(`Proposal file exceeds ${MAX_FILE_BYTES} bytes: ${proposedPath}`);
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`Proposal exceeds the ${MAX_TOTAL_BYTES} byte total limit.`);
    return { path: normal, content: file.content };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

/** Bounded single-hunk diff preview; full proposed content remains review-only in SQLite. */
function fileDiff(file: ProposedFile, root: string): { diff: string; baseHash: string } {
  const absolutePath = path.resolve(root, file.path);
  let previous = "";
  try { previous = fs.readFileSync(absolutePath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const oldLines = previous.split("\n");
  const newLines = file.content.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix);
  const newChanged = newLines.slice(prefix, newLines.length - suffix);
  const limit = 80;
  const removed = oldChanged.slice(0, limit).map((line) => `-${line}`);
  const added = newChanged.slice(0, limit).map((line) => `+${line}`);
  const clipped = oldChanged.length > limit || newChanged.length > limit;
  return {
    diff: `--- a/${file.path}\n+++ b/${file.path}\n@@ changed lines ${prefix + 1} @@\n${[...removed, ...added].join("\n")}${clipped ? "\n... diff preview truncated; review the full proposed content" : ""}`,
    baseHash: createHash("sha256").update(previous).digest("hex"),
  };
}

function toProposal(row: any): SelfImprovementProposal {
  return {
    id: row.id,
    title: row.title,
    rationale: row.rationale,
    files: JSON.parse(row.proposed_files),
    diffPreview: row.diff_preview,
    diffHash: row.diff_hash,
    verificationStatus: row.verification_status,
    verificationSummary: row.verification_summary,
    approvalRequestId: row.approval_request_id,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
  };
}

export function createSelfImprovementProposal(db: Database.Database, input: SelfImprovementProposalInput, now = new Date()): SelfImprovementProposal {
  const title = requiredText(input.title, "Title", 160);
  const rationale = requiredText(input.rationale, "Rationale", 2000);
  const requesterId = requiredText(input.requesterId, "Requester", 160);
  if (requesterId === "owner-dashboard" || (input.requesterKind !== "agent" && input.requesterKind !== "child")) throw new Error("Invalid self-improvement requester.");
  const files = normaliseProposalFiles(input.files);
  const root = path.resolve(process.cwd());
  const perFileDiffs = files.map((file) => fileDiff(file, root));
  const diffPreview = perFileDiffs.map((entry) => entry.diff).join("\n\n").slice(0, 24_000);
  const diffHash = createHash("sha256").update(JSON.stringify({ files, baselineHashes: perFileDiffs.map((entry) => entry.baseHash) })).digest("hex");
  const timestamp = now.toISOString();
  const expiresAt = new Date(now.getTime() + PROPOSAL_TTL_MS).toISOString();
  const id = ulid();
  const transaction = db.transaction(() => {
    db.prepare("UPDATE self_improvement_proposals SET status = 'expired' WHERE status = 'pending_review' AND expires_at <= ?").run(timestamp);
    const existing = db.prepare("SELECT * FROM self_improvement_proposals WHERE diff_hash = ? AND status = 'pending_review' AND expires_at > ?").get(diffHash, timestamp) as any;
    if (existing) return toProposal(existing);
    const approval = requestOwnerApproval(db, {
      requesterId,
      requesterKind: input.requesterKind,
      scope: "software_change",
      actionName: "review_self_improvement_proposal",
      actionParameters: { proposalId: id, diffHash, paths: files.map((file) => file.path) },
      description: `Review draft code proposal: ${title}. No code is applied by approval.`,
      riskLevel: "caution",
      expiresInMs: PROPOSAL_TTL_MS,
    }, now);
    db.prepare(`INSERT INTO self_improvement_proposals
      (id,title,rationale,proposed_files,diff_preview,diff_hash,verification_status,verification_summary,approval_request_id,status,created_by,created_at,expires_at)
      VALUES (?,?,?,?,?,?,'not_run','Not run: changes are not executed because an isolated test sandbox is unavailable.',?,'pending_review',?,?,?)`)
      .run(id, title, rationale, JSON.stringify(files), diffPreview, diffHash, approval.id, requesterId, timestamp, expiresAt);
    return toProposal(db.prepare("SELECT * FROM self_improvement_proposals WHERE id = ?").get(id));
  });
  return transaction();
}

export function listSelfImprovementProposals(db: Database.Database, limit = 50, now = new Date()): SelfImprovementProposal[] {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  db.prepare("UPDATE self_improvement_proposals SET status = 'expired' WHERE status = 'pending_review' AND expires_at <= ?").run(now.toISOString());
  return (db.prepare("SELECT * FROM self_improvement_proposals ORDER BY created_at DESC LIMIT ?").all(bounded) as any[]).map(toProposal);
}

export function getSelfImprovementProposal(db: Database.Database, id: string): SelfImprovementProposal | null {
  const row = db.prepare("SELECT * FROM self_improvement_proposals WHERE id = ?").get(id) as any;
  return row ? toProposal(row) : null;
}

/** Owner review is linked to its exact approval record. This only records review; never activates code. */
export function reviewSelfImprovementProposal(
  db: Database.Database,
  id: string,
  decision: "approved" | "rejected",
  note: string,
  now = new Date(),
): SelfImprovementProposal | null {
  const timestamp = now.toISOString();
  const reviewNote = typeof note === "string" ? note.trim().slice(0, 1000) : "";
  const transaction = db.transaction(() => {
    const proposal = db.prepare("SELECT * FROM self_improvement_proposals WHERE id = ?").get(id) as any;
    if (!proposal || proposal.status !== "pending_review") return null;
    if (proposal.expires_at <= timestamp) {
      db.prepare("UPDATE self_improvement_proposals SET status = 'expired', reviewed_at = ?, reviewed_by = 'system', review_note = 'Proposal expired' WHERE id = ? AND status = 'pending_review'").run(timestamp, id);
      return null;
    }
    const approval = reviewOwnerApproval(db, proposal.approval_request_id, decision, "owner-dashboard", reviewNote, now);
    if (!approval) return null;
    const status = decision === "approved" ? "approved_for_manual_activation" : "rejected";
    db.prepare("UPDATE self_improvement_proposals SET status = ?, reviewed_at = ?, reviewed_by = 'owner-dashboard', review_note = ? WHERE id = ? AND status = 'pending_review'").run(status, timestamp, reviewNote, id);
    return db.prepare("SELECT * FROM self_improvement_proposals WHERE id = ?").get(id) as any;
  });
  const row = transaction();
  return row ? toProposal(row) : null;
}

