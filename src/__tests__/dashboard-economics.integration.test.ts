import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { createBusinessOpportunity, proposeBusinessExperiment, recordBusinessEvidence, reviewBusinessExperiment, transitionBusinessOpportunity } from "../economics/opportunities.js";
import { createTestConfig } from "./mocks.js";
import { createSelfImprovementProposal } from "../self-mod/proposals.js";

describe("authenticated dashboard business workflow", () => {
  it("protects business data and records the owner experiment review without executing it", async () => {
    const priorHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "sod-dashboard-economics-"));
    process.env.HOME = home;
    const db = createDatabase(":memory:");
    let dashboard: { close(): void; getPort(): number } | undefined;
    try {
      const { startDashboardServer } = await import("../dashboard/server.js");
      dashboard = startDashboardServer({
        db,
        config: createTestConfig({ dashboardPort: 40973 }),
        onEmergencyStop: () => {},
      });
      const tokenPath = join(home, ".automaton", "dashboard-token");
      const token = readFileSync(tokenPath, "utf8").trim();
      const base = `http://127.0.0.1:${dashboard.getPort()}`;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const opportunity = createBusinessOpportunity(db.raw, {
        title: "Review workflow", customerSegment: "Local shops", customerProblem: "Rework",
        valueProposition: "Better tracking", evidenceSummary: "Hypothesis", forecastDays: 30,
        confidence: 0.1, risks: "Unknown",
      }, "agent");
      recordBusinessEvidence(db.raw, {
        opportunityId: opportunity.id, title: "Public source", sourceUrl: "https://example.test/source",
        claim: "A dated source claim", sourceDate: "2026-11-10", sourceType: "official",
        limitations: "Not independently checked",
      }, "local-agent");
      transitionBusinessOpportunity(db.raw, opportunity.id, "shortlisted");
      const experiment = proposeBusinessExperiment(db.raw, {
        opportunityId: opportunity.id, title: "Local prototype test", hypothesis: "H", method: "Local-only mock", successCriteria: "Pass/fail",
      }, "agent");

      const unauthenticated = await fetch(`${base}/api/experiments`);
      expect(unauthenticated.status).toBe(401);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      db.raw.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES ('worker-goal', 'Worker goal', 'Review workers', 'active', datetime('now'))").run();
      db.raw.prepare(`INSERT INTO task_graph (id, goal_id, title, description, status, assigned_to, agent_role, created_at)
        VALUES ('worker-task', 'worker-goal', 'Inspect local worker history', 'Read persisted worker status', 'completed', 'local://worker-1', 'researcher', datetime('now'))`).run();
      db.raw.prepare(`INSERT INTO local_worker_runs
        (id, task_id, name, address, role, status, progress_stage, progress_message, result_json, created_at, started_at, finished_at, updated_at)
        VALUES ('worker-1', 'worker-task', 'worker-researcher-1', 'local://worker-1', 'researcher', 'completed', 'completed', 'Collected a local result', '{"success":true,"output":"Review-ready result"}', datetime('now'), datetime('now'), datetime('now'), datetime('now'))`).run();
      db.raw.prepare(`INSERT INTO local_worker_events (id, worker_id, event_type, message, created_at)
        VALUES ('worker-event-1', 'worker-1', 'result', 'Worker returned a result', datetime('now'))`).run();
      const status = await fetch(`${base}/api/status`, { headers });
      expect((await status.json() as any).localWorkers[0]).toMatchObject({
        workerId: "worker-1", taskTitle: "Inspect local worker history", status: "completed",
        progressMessage: "Collected a local result", result: { output: "Review-ready result" }, eventCount: 1, canStop: false,
      });
      const initial = await fetch(`${base}/api/experiments`, { headers });
      expect(initial.status).toBe(200);
      expect((await initial.json() as any).items[0].status).toBe("proposed");
      const response = await fetch(`${base}/api/experiments/${experiment!.id}/review`, {
        method: "POST", headers,
        body: JSON.stringify({ decision: "completed", outcome: "Owner reports one local prototype session", lesson: "One session is not demand evidence" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ executionEnabled: false, actualsLedgerUpdated: false });
      expect(reviewBusinessExperiment(db.raw, experiment!.id, "rejected")).toBeNull();
      const actual = await fetch(`${base}/api/opportunities/${opportunity.id}/actual`, {
        method: "POST", headers,
        body: JSON.stringify({ kind: "income", amountCents: 1250, description: "Owner reported sale", idempotencyKey: "dashboard-test-income" }),
      });
      expect(actual.status).toBe(200);
      const pipeline = await fetch(`${base}/api/opportunities`, { headers });
      expect(await pipeline.json()).toMatchObject({
        automaticFinancialExecutionEnabled: false,
        summary: { actualIncomeCents: 1250, actualExpenseCents: 0, actualProfitCents: 1250 },
        items: [{ evidenceItems: [{ title: "Public source", verificationStatus: "unverified" }] }],
      });

      const selfChange = createSelfImprovementProposal(db.raw, {
        title: "Dashboard workspace check", rationale: "Prepare a review-only candidate and rollback snapshot.",
        files: [{ path: "README.md", content: readFileSync("README.md", "utf8") + "\nReview candidate.\n" }],
        requesterId: "local-agent", requesterKind: "agent",
      });
      const selfImprovementsPath = `${base}/api/self-improvements`;
      expect((await fetch(selfImprovementsPath)).status).toBe(401);
      const unauthorizedPreparation = await fetch(`${selfImprovementsPath}/${selfChange.id}/prepare-workspace`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      expect(unauthorizedPreparation.status).toBe(401);
      const prepared = await fetch(`${selfImprovementsPath}/${selfChange.id}/prepare-workspace`, { method: "POST", headers, body: "{}" });
      const preparedBody = await prepared.json() as any;
      expect(prepared.status).toBe(200);
      expect(preparedBody).toMatchObject({ executionEnabled: false, verificationStatus: "not_run" });
      const proposalDetails = await fetch(`${selfImprovementsPath}/${selfChange.id}`, { headers });
      const proposalBody = await proposalDetails.json() as any;
      expect(proposalBody.activationEnabled).toBe(false);
      expect(proposalBody.proposal.diffPreview).toContain("Review candidate.");
      const page = await (await fetch(base, { headers })).text();
      const inlineScript = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
      expect(inlineScript).toBeTruthy();
      expect(() => new Function(inlineScript!)).not.toThrow();
      const staged = join(home, ".automaton", preparedBody.workspace.workspacePath, "candidate", "README.md");
      expect(readFileSync(staged, "utf8")).toContain("Review candidate.");
      const listed = await fetch(selfImprovementsPath, { headers });
      expect((await listed.json() as any).items.find((item: any) => item.id === selfChange.id).workspace).toMatchObject({
        manifestHash: preparedBody.workspace.manifestHash,
        rollbackHash: preparedBody.workspace.rollbackHash,
        verificationStatus: "not_run",
      });
    } finally {
      dashboard?.close();
      db.close();
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
