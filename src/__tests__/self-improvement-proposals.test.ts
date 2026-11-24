import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { createBuiltinTools } from "../agent/tools.js";
import type { ToolContext } from "../types.js";
import {
  createSelfImprovementProposal,
  listSelfImprovementProposals,
  reviewSelfImprovementProposal,
} from "../self-mod/proposals.js";

describe("draft-only self-improvement proposals", () => {
  const databases: ReturnType<typeof createDatabase>[] = [];
  const makeDb = () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("captures a bounded diff and exact owner approval without touching live files", () => {
    const db = makeDb();
    const before = fs.readFileSync("README.md", "utf8");
    const proposal = createSelfImprovementProposal(db.raw, {
      title: "Clarify local setup",
      rationale: "Reduce install confusion; confirm wording against the actual flow.",
      files: [{ path: "README.md", content: before + "\nDraft line for review.\n" }],
      requesterId: "local-agent",
      requesterKind: "agent",
    });

    expect(proposal.status).toBe("pending_review");
    expect(proposal.verificationStatus).toBe("not_run");
    expect(proposal.diffPreview).toContain("+Draft line for review.");
    expect(fs.readFileSync("README.md", "utf8")).toBe(before);
    const approval = db.raw.prepare("SELECT scope, action_name, action_parameters, status FROM owner_approval_requests WHERE id = ?").get(proposal.approvalRequestId) as any;
    expect(approval.scope).toBe("software_change");
    expect(approval.status).toBe("pending");
    expect(JSON.parse(approval.action_parameters)).toMatchObject({ proposalId: proposal.id, diffHash: proposal.diffHash });

    const reviewed = reviewSelfImprovementProposal(db.raw, proposal.id, "approved", "Review only");
    expect(reviewed?.status).toBe("approved_for_manual_activation");
    expect(reviewed?.verificationStatus).toBe("not_run");
    expect(db.raw.prepare("SELECT status FROM owner_approval_requests WHERE id = ?").get(proposal.approvalRequestId)).toEqual({ status: "approved" });
    expect(fs.readFileSync("README.md", "utf8")).toBe(before);
  });

  it("blocks protected, traversal and sensitive paths and prevents child self-review", () => {
    const db = makeDb();
    const base = { title: "A proposal", rationale: "A reason", requesterId: "local-agent", requesterKind: "agent" as const };
    expect(() => createSelfImprovementProposal(db.raw, { ...base, files: [{ path: "src/agent/tools.ts", content: "danger" }] })).toThrow("Protected runtime file");
    expect(() => createSelfImprovementProposal(db.raw, { ...base, files: [{ path: "../outside.txt", content: "no" }] })).toThrow("Unsafe proposal path");
    expect(() => createSelfImprovementProposal(db.raw, { ...base, files: [{ path: ".env.local", content: "secret" }] })).toThrow("Sensitive or generated paths");
    const proposal = createSelfImprovementProposal(db.raw, { ...base, files: [{ path: "README.md", content: "Draft" }] });
    expect(() => reviewSelfImprovementProposal(db.raw, proposal.id, "approved", "", new Date(Date.now() + 8 * 24 * 60 * 60 * 1000))).not.toThrow();
    expect(listSelfImprovementProposals(db.raw)[0].status).toBe("expired");
  });

  it("registers draft proposals as an agent capability, not as a live edit", async () => {
    const db = makeDb();
    const tool = createBuiltinTools("local-sandbox").find((candidate) => candidate.name === "propose_self_improvement");
    expect(tool).toBeDefined();
    const result = await tool!.execute({
      title: "Draft only", rationale: "A narrow proposal", files: [{ path: "README.md", content: "Possible future contents" }],
    }, { db, identity: { address: "local-agent" } } as unknown as ToolContext);
    expect(result).toContain("not activated");
    expect(listSelfImprovementProposals(db.raw)).toHaveLength(1);
  });

  it("allows the same draft to be resubmitted after its old review request expired", () => {
    const db = makeDb();
    const input = {
      title: "Retry review", rationale: "The prior review window ended", requesterId: "local-agent",
      requesterKind: "agent" as const, files: [{ path: "README.md", content: "A bounded draft" }],
    };
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const first = createSelfImprovementProposal(db.raw, input, createdAt);
    const second = createSelfImprovementProposal(db.raw, input, new Date("2026-01-09T00:00:00.000Z"));
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending_review");
  });
});
