/**
 * Owner-triggered, non-executing workspaces for proposed self-improvements.
 * Candidate and rollback files live under the private Automaton data directory,
 * never in the running checkout. No command runner or activation path exists.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import { isProtectedFile } from "./code.js";

const MAX_FILES = 12;
const MAX_FILE_BYTES = 100_000;
const MAX_TOTAL_BYTES = 250_000;
const BLOCKED_SEGMENTS = new Set([".git", ".automaton", "node_modules", ".ssh", ".aws", ".azure", ".gnupg"]);
const WINDOWS_RESERVED_PATH = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export interface SelfImprovementWorkspace {
  proposalId: string;
  workspacePath: string;
  manifestHash: string;
  rollbackHash: string;
  verificationStatus: "not_run" | "passed" | "failed";
  verificationSummary: string;
  preparedAt: string;
}

interface BaselineEntry {
  path: string;
  proposalPath: string;
  existed: boolean;
  baseHash: string;
  proposedHash: string;
  baseContent: string;
  proposedContent: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resolveInside(root: string, relative: string): string {
  const absolute = path.resolve(root, relative);
  if (absolute === root || !absolute.startsWith(root + path.sep)) throw new Error("Workspace path leaves its configured root.");
  return absolute;
}

function assertNoSymlinkComponents(root: string, target: string): void {
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Symbolic links are not permitted in self-improvement paths: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function captureBaseline(proposal: { id: string; diff_hash: string; proposed_files: string }, repositoryRoot: string): BaselineEntry[] {
  const realRoot = fs.realpathSync(repositoryRoot);
  const files = JSON.parse(proposal.proposed_files) as Array<{ path: string; content: string }>;
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) throw new Error("Stored proposal file list is invalid.");
  let totalBytes = 0;
  const entries = files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Stored proposal contains an invalid file entry.");
    const rel = file.path.replace(/\\/g, "/");
    const segments = rel.split("/");
    if (!rel || rel.startsWith("/") || rel.includes("\0") || segments.some((part) => !part || part === "." || part === ".." || WINDOWS_RESERVED_PATH.test(part) || WINDOWS_RESERVED_NAME.test(part) || part.endsWith(".") || part.endsWith(" ") || BLOCKED_SEGMENTS.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /\.(?:pem|key)$/i.test(part))) {
      throw new Error(`Unsafe stored proposal path: ${rel}`);
    }
    const target = resolveInside(realRoot, rel);
    if (isProtectedFile(target)) throw new Error(`Protected file cannot be staged: ${rel}`);
    assertNoSymlinkComponents(realRoot, target);
    let baseContent = "";
    let existed = false;
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) throw new Error(`Proposal target is not a regular file: ${rel}`);
      baseContent = fs.readFileSync(target, "utf8");
      existed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const baselineBytes = Buffer.byteLength(baseContent, "utf8");
    const proposedBytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += baselineBytes + proposedBytes;
    if (baselineBytes > MAX_FILE_BYTES || proposedBytes > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) throw new Error("Stored proposal or rollback baseline exceeds workspace size limits.");
    return {
      path: rel,
      proposalPath: file.path,
      existed,
      baseContent,
      proposedContent: file.content,
      baseHash: hash(baseContent),
      proposedHash: hash(file.content),
    };
  });
  const recomputed = hash(JSON.stringify({
    files: entries.map(({ proposalPath, proposedContent }) => ({ path: proposalPath, content: proposedContent })),
    baselineHashes: entries.map((entry) => entry.baseHash),
  }));
  if (recomputed !== proposal.diff_hash) throw new Error("The live source has changed since this proposal was created. Reject this stale draft and submit a fresh proposal.");
  return entries;
}

function toWorkspace(row: any): SelfImprovementWorkspace {
  return {
    proposalId: row.proposal_id,
    workspacePath: row.workspace_path,
    manifestHash: row.manifest_hash,
    rollbackHash: row.rollback_hash,
    verificationStatus: row.verification_status,
    verificationSummary: row.verification_summary,
    preparedAt: row.prepared_at,
  };
}

function assertContainedDirectory(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) throw new Error("Workspace directory escaped its private root.");
  assertNoSymlinkComponents(resolvedRoot, resolvedTarget);
}

function writeEntries(root: string, entries: BaselineEntry[], contentKey: "baseContent" | "proposedContent"): void {
  for (const entry of entries) {
    const target = resolveInside(root, entry.path);
    assertContainedDirectory(root, target);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry[contentKey], { flag: "wx", mode: 0o600 });
  }
}

function readAndVerifyArtifacts(directory: string, proposalId: string, diffHash: string): { manifest: string; rollbackManifest: string; entries: any[]; preparedAt: string } {
  assertNoSymlinkComponents(path.dirname(directory), directory);
  const manifest = fs.readFileSync(path.join(directory, "manifest.json"), "utf8");
  const rollbackManifest = fs.readFileSync(path.join(directory, "rollback-manifest.json"), "utf8");
  const parsed = JSON.parse(manifest) as any;
  const rollback = JSON.parse(rollbackManifest) as any;
  if (parsed.format !== 1 || parsed.proposalId !== proposalId || parsed.diffHash !== diffHash ||
      rollback.format !== 1 || rollback.proposalId !== proposalId || rollback.diffHash !== diffHash ||
      !Array.isArray(parsed.files) || parsed.files.length < 1 || parsed.files.length > MAX_FILES || !Array.isArray(rollback.files)) {
    throw new Error("Prepared workspace artifacts do not match the proposal.");
  }
  const canonical: Array<{ path: string; content: string; baseHash: string; existed: boolean }> = [];
  for (const entry of parsed.files) {
    if (!entry || typeof entry.path !== "string" || typeof entry.existed !== "boolean" ||
        !/^[a-f0-9]{64}$/.test(entry.baseHash) || !/^[a-f0-9]{64}$/.test(entry.proposedHash)) {
      throw new Error("Prepared workspace manifest contains an invalid file entry.");
    }
    const segments: string[] = entry.path.split("/");
    if (!entry.path || entry.path.startsWith("/") || segments.some((part) => !part || part === "." || part === ".." || WINDOWS_RESERVED_PATH.test(part) || WINDOWS_RESERVED_NAME.test(part) || part.endsWith(".") || part.endsWith(" ") || BLOCKED_SEGMENTS.has(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part) || /\.(?:pem|key)$/i.test(part))) {
      throw new Error(`Unsafe path in prepared workspace manifest: ${entry.path}`);
    }
    if (canonical.some((previous) => previous.path.toLowerCase() === segments.join(path.sep).toLowerCase())) throw new Error("Prepared workspace manifest contains duplicate paths.");
    if (!entry.existed && entry.baseHash !== hash("")) throw new Error(`New proposed path has a non-empty baseline hash: ${entry.path}`);
    const candidateRoot = path.join(directory, "candidate");
    const candidatePath = resolveInside(candidateRoot, entry.path);
    assertNoSymlinkComponents(candidateRoot, candidatePath);
    const proposedContent = fs.readFileSync(candidatePath, "utf8");
    if (Buffer.byteLength(proposedContent, "utf8") > MAX_FILE_BYTES || hash(proposedContent) !== entry.proposedHash) throw new Error(`Candidate file integrity check failed: ${entry.path}`);
    const rollbackRoot = path.join(directory, "rollback");
    const rollbackPath = resolveInside(rollbackRoot, entry.path);
    if (entry.existed) {
      assertNoSymlinkComponents(rollbackRoot, rollbackPath);
      const baseContent = fs.readFileSync(rollbackPath, "utf8");
      if (Buffer.byteLength(baseContent, "utf8") > MAX_FILE_BYTES || hash(baseContent) !== entry.baseHash) throw new Error(`Rollback file integrity check failed: ${entry.path}`);
    } else if (fs.existsSync(rollbackPath)) {
      throw new Error(`Unexpected rollback file exists for new path: ${entry.path}`);
    }
    canonical.push({ path: segments.join(path.sep), content: proposedContent, baseHash: entry.baseHash, existed: entry.existed });
  }
  const rollbackExpected = parsed.files.filter((entry: any) => entry.existed).map((entry: any) => ({ path: entry.path, existed: true, baseHash: entry.baseHash }));
  if (JSON.stringify(rollback.files) !== JSON.stringify(rollbackExpected)) throw new Error("Rollback manifest does not match the candidate manifest.");
  const totalBytes = canonical.reduce((sum, entry) => sum + Buffer.byteLength(entry.content, "utf8") + (entry.existed ? fs.statSync(resolveInside(path.join(directory, "rollback"), entry.path)).size : 0), 0);
  if (totalBytes > MAX_TOTAL_BYTES || hash(JSON.stringify({ files: canonical.map(({ path: filePath, content }) => ({ path: filePath, content })), baselineHashes: canonical.map(({ baseHash }) => baseHash) })) !== diffHash) {
    throw new Error("Prepared workspace content does not match the proposal hash.");
  }
  return { manifest, rollbackManifest, entries: parsed.files, preparedAt: parsed.preparedAt };
}

function persistWorkspace(
  db: Database.Database,
  proposalId: string,
  relativePath: string,
  artifacts: { manifest: string; rollbackManifest: string; entries: any[]; preparedAt: string },
  eventType: "workspace_prepared" | "workspace_recovered",
  now: Date,
): any {
  const manifestHash = hash(artifacts.manifest);
  const rollbackHash = hash(artifacts.rollbackManifest);
  const verificationSummary = "not_run: candidate execution remains disabled because an OS-isolated verification boundary has not been validated.";
  const transaction = db.transaction(() => {
    const updatedAt = now.toISOString();
    db.prepare(`INSERT INTO self_improvement_workspaces
      (id,proposal_id,workspace_path,manifest_json,manifest_hash,rollback_manifest_json,rollback_hash,verification_status,verification_summary,prepared_at,updated_at)
      VALUES (?,?,?,?,?,?,?,'not_run',?,?,?)
      ON CONFLICT(proposal_id) DO UPDATE SET workspace_path=excluded.workspace_path,manifest_json=excluded.manifest_json,manifest_hash=excluded.manifest_hash,rollback_manifest_json=excluded.rollback_manifest_json,rollback_hash=excluded.rollback_hash,verification_status='not_run',verification_summary=excluded.verification_summary,updated_at=excluded.updated_at`).run(
      ulid(), proposalId, relativePath, artifacts.manifest, manifestHash, artifacts.rollbackManifest,
      rollbackHash, verificationSummary, artifacts.preparedAt, updatedAt,
    );
    db.prepare(`INSERT INTO self_improvement_workspace_events
      (id,proposal_id,event_type,actor_kind,actor_id,details,created_at) VALUES (?,?,?,'owner','owner-dashboard',?,?)`)
      .run(ulid(), proposalId, eventType, JSON.stringify({ manifestHash, rollbackHash, files: artifacts.entries.length, executionEnabled: false }), updatedAt);
    if (eventType === "workspace_prepared") {
      db.prepare(`INSERT INTO self_improvement_workspace_events
        (id,proposal_id,event_type,actor_kind,actor_id,details,created_at) VALUES (?,?, 'verification_blocked','system','isolation-check',?,?)`)
        .run(ulid(), proposalId, JSON.stringify({ reason: verificationSummary }), updatedAt);
    }
    return db.prepare("SELECT * FROM self_improvement_workspaces WHERE proposal_id = ?").get(proposalId) as any;
  });
  return transaction();
}

/**
 * Prepare an isolated candidate plus a versioned baseline copy for rollback.
 * This function is called only by the authenticated local owner dashboard.
 * It validates the exact source baseline again and never executes candidate code.
 */
export function prepareSelfImprovementWorkspace(
  db: Database.Database,
  privateDataRoot: string,
  proposalId: string,
  now = new Date(),
): SelfImprovementWorkspace {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/i.test(proposalId)) throw new Error("Invalid proposal id.");
  const proposal = db.prepare("SELECT id,diff_hash,proposed_files,status,expires_at FROM self_improvement_proposals WHERE id = ?").get(proposalId) as any;
  if (!proposal) throw new Error("Self-improvement proposal not found.");
  if (!["pending_review", "approved_for_manual_activation"].includes(proposal.status) || proposal.expires_at <= now.toISOString()) {
    throw new Error("Only an active proposal may be prepared for owner review.");
  }
  const dataRoot = path.resolve(privateDataRoot);
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const realDataRoot = fs.realpathSync(dataRoot);
  const workspaceRoot = path.join(realDataRoot, "self-mod", "workspaces");
  fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  const realWorkspaceRoot = fs.realpathSync(workspaceRoot);
  if (!realWorkspaceRoot.startsWith(realDataRoot + path.sep)) throw new Error("Workspace storage is outside the private Automaton data directory.");
  const interruptedPrefix = `.${proposalId}.preparing-`;
  for (const entry of fs.readdirSync(realWorkspaceRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(interruptedPrefix) || !new RegExp(`^\\.${proposalId}\\.preparing-[a-f0-9]{12}$`).test(entry.name)) continue;
    const interruptedPath = path.join(realWorkspaceRoot, entry.name);
    const ageMs = Date.now() - fs.lstatSync(interruptedPath).mtimeMs;
    if (entry.isDirectory() && !entry.isSymbolicLink() && ageMs > 5 * 60 * 1000) fs.rmSync(interruptedPath, { recursive: true, force: true });
  }
  const finalDirectory = path.join(realWorkspaceRoot, proposalId);
  assertContainedDirectory(realWorkspaceRoot, finalDirectory);
  const existing = db.prepare("SELECT * FROM self_improvement_workspaces WHERE proposal_id = ?").get(proposalId) as any;
  if (existing && fs.existsSync(finalDirectory)) {
    const artifacts = readAndVerifyArtifacts(finalDirectory, proposalId, proposal.diff_hash);
    if (artifacts.manifest !== existing.manifest_json || artifacts.rollbackManifest !== existing.rollback_manifest_json ||
        hash(artifacts.manifest) !== existing.manifest_hash || hash(artifacts.rollbackManifest) !== existing.rollback_hash) throw new Error("Prepared workspace manifest failed integrity verification.");
    return toWorkspace(existing);
  }

  if (!existing && fs.existsSync(finalDirectory)) {
    const artifacts = readAndVerifyArtifacts(finalDirectory, proposalId, proposal.diff_hash);
    const relativePath = path.relative(realDataRoot, finalDirectory).split(path.sep).join("/");
    return toWorkspace(persistWorkspace(db, proposalId, relativePath, artifacts, "workspace_recovered", now));
  }

  const entries = captureBaseline(proposal, process.cwd());
  const manifestEntries = entries.map(({ path: relative, existed, baseHash, proposedHash }) => ({ path: relative, existed, baseHash, proposedHash }));
  const manifest = JSON.stringify({ format: 1, proposalId, diffHash: proposal.diff_hash, preparedAt: now.toISOString(), files: manifestEntries }, null, 2) + "\n";
  const rollbackManifest = JSON.stringify({ format: 1, proposalId, diffHash: proposal.diff_hash, files: manifestEntries.map(({ path: relative, existed, baseHash }) => ({ path: relative, existed, baseHash })) }, null, 2) + "\n";
  const manifestHash = hash(manifest);
  const rollbackHash = hash(rollbackManifest);
  const tempDirectory = path.join(realWorkspaceRoot, `.${proposalId}.preparing-${randomBytes(6).toString("hex")}`);
  if (fs.existsSync(finalDirectory)) throw new Error("A workspace exists without a matching persistent database record; inspect it before recovery.");
  fs.mkdirSync(tempDirectory, { recursive: false, mode: 0o700 });
  try {
    writeEntries(path.join(tempDirectory, "candidate"), entries, "proposedContent");
    fs.mkdirSync(path.join(tempDirectory, "rollback"), { recursive: true, mode: 0o700 });
    const rollbackEntries = entries.filter((entry) => entry.existed);
    writeEntries(path.join(tempDirectory, "rollback"), rollbackEntries, "baseContent");
    fs.writeFileSync(path.join(tempDirectory, "manifest.json"), manifest, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(tempDirectory, "rollback-manifest.json"), rollbackManifest, { flag: "wx", mode: 0o600 });
    fs.writeFileSync(path.join(tempDirectory, "VERIFICATION_DISABLED.txt"), "Candidate code was not executed. No OS-isolated test runner is installed. These files are review and rollback preparation artifacts only.\n", { flag: "wx", mode: 0o600 });
    fs.renameSync(tempDirectory, finalDirectory);
  } catch (error) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    throw error;
  }

  const relativePath = path.relative(realDataRoot, finalDirectory).split(path.sep).join("/");
  const record = persistWorkspace(db, proposalId, relativePath, {
    manifest,
    rollbackManifest,
    entries: manifestEntries,
    preparedAt: now.toISOString(),
  }, existing ? "workspace_recovered" : "workspace_prepared", now);
  return toWorkspace(record);
}

export function getSelfImprovementWorkspace(db: Database.Database, proposalId: string): SelfImprovementWorkspace | null {
  const row = db.prepare("SELECT * FROM self_improvement_workspaces WHERE proposal_id = ?").get(proposalId) as any;
  return row ? toWorkspace(row) : null;
}

export function listSelfImprovementWorkspaces(db: Database.Database, proposalIds: string[]): Map<string, SelfImprovementWorkspace> {
  const result = new Map<string, SelfImprovementWorkspace>();
  if (!proposalIds.length) return result;
  const query = db.prepare("SELECT * FROM self_improvement_workspaces WHERE proposal_id = ?");
  for (const id of proposalIds) {
    const row = query.get(id) as any;
    if (row) result.set(id, toWorkspace(row));
  }
  return result;
}
