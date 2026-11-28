import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase, metricsInsertSnapshot } from "../state/database.js";
import { assessBusinessClaim, createBusinessOpportunity, proposeBusinessExperiment, recordBusinessEvidence, reviewBusinessExperiment, transitionBusinessOpportunity } from "../economics/opportunities.js";
import { createTestConfig } from "./mocks.js";
import { createSelfImprovementProposal } from "../self-mod/proposals.js";
import { saveBusinessDeliverable } from "../economics/deliverables.js";

describe("authenticated dashboard business workflow", () => {
  it("protects business data and records the owner experiment review without executing it", async () => {
    const priorHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "sod-dashboard-economics-"));
    process.env.HOME = home;
    const db = createDatabase(":memory:");
    let dashboard: { close(): void; getPort(): number } | undefined;
    try {
      const config = createTestConfig({ dashboardPort: 40973, localOnly: true });
      mkdirSync(join(home, ".automaton"), { recursive: true });
      writeFileSync(join(home, ".automaton", "automaton.json"), JSON.stringify(config));
      const { startDashboardServer } = await import("../dashboard/server.js");
      dashboard = startDashboardServer({
        db,
        config,
        onEmergencyStop: () => {},
      });
      const tokenPath = join(home, ".automaton", "dashboard-token");
      const token = readFileSync(tokenPath, "utf8").trim();
      const base = `http://127.0.0.1:${dashboard.getPort()}`;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const sampledAt = new Date().toISOString();
      metricsInsertSnapshot(db.raw, {
        id: "resource-history-test",
        snapshotAt: sampledAt,
        metricsJson: JSON.stringify([
          { name: "process_rss_bytes", type: "gauge", value: 128 * 1024 ** 2 },
          { name: "process_heap_used_bytes", type: "gauge", value: 64 * 1024 ** 2 },
          { name: "process_cpu_percent_one_core", type: "gauge", value: 12.5 },
          { name: "system_memory_available_bytes", type: "gauge", value: 4 * 1024 ** 3 },
          { name: "system_memory_total_bytes", type: "gauge", value: 16 * 1024 ** 3 },
        ]),
        alertsJson: "[]",
        createdAt: sampledAt,
      });
      db.raw.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, 'completed', ?)")
        .run("history-goal", "Resource and task history", "Integration test goal", sampledAt);
      db.raw.prepare(`INSERT INTO task_graph
        (id, goal_id, title, description, status, result, retry_count, max_retries, created_at, completed_at)
        VALUES (?, ?, ?, ?, 'completed', ?, 1, 3, ?, ?)`)
        .run("history-task", "history-goal", "Completed sample task", "Task history test", JSON.stringify({
          success: true, output: "Completed safely", duration: 42, costCents: 0,
        }), sampledAt, sampledAt);
      const logsPath = join(home, ".automaton", "logs");
      mkdirSync(logsPath, { recursive: true });
      writeFileSync(join(logsPath, "self-mod-isolation-readiness.json"), JSON.stringify({
        detectedAt: "2026-11-25T00:00:00.000Z", operatingSystem: "Windows", edition: "Professional",
        readyForOwnerReview: true, candidateExecutionEnabled: true, blockers: [],
      }));
      const opportunity = createBusinessOpportunity(db.raw, {
        title: "Review workflow", customerSegment: "Local shops", customerProblem: "Rework",
        valueProposition: "Better tracking", evidenceSummary: "Hypothesis", forecastDays: 30,
        confidence: 0.1, risks: "Unknown",
      }, "agent");
      const evidence = recordBusinessEvidence(db.raw, {
        opportunityId: opportunity.id, title: "Public source", sourceUrl: "https://example.test/source",
        claim: "A dated source claim", sourceDate: "2026-11-10", sourceType: "official",
        claimArea: "demand", position: "supports", dateBasis: "publication",
        limitations: "Not independently checked",
      }, "local-agent");
      const claimReview = assessBusinessClaim(db.raw, {
        opportunityId: opportunity.id, claim: "The stated customer problem exists", claimArea: "demand",
        supportingEvidenceIds: [evidence!.id], contradictingEvidenceIds: [],
      }, "local-agent");
      transitionBusinessOpportunity(db.raw, opportunity.id, "shortlisted");
      const experiment = proposeBusinessExperiment(db.raw, {
        opportunityId: opportunity.id, title: "Local prototype test", hypothesis: "H", method: "Local-only mock", successCriteria: "Pass/fail",
      }, "agent");
      const deliverable = saveBusinessDeliverable(db.raw, join(home, ".automaton"), {
        opportunityId: opportunity.id, type: "product_spec", title: "Local maintenance tracker",
        content: "# Product specification\n\nCustomer demand is an unverified hypothesis.",
      }, "local-agent");

      const unauthenticated = await fetch(`${base}/api/experiments`);
      expect(unauthenticated.status).toBe(401);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      expect((await fetch(`${base}/api/research`)).status).toBe(401);
      expect((await fetch(`${base}/api/claim-reviews`)).status).toBe(401);
      expect((await fetch(`${base}/api/resources/history`)).status).toBe(401);
      const resourceHistory = await fetch(`${base}/api/resources/history?hours=999`, { headers });
      expect(resourceHistory.status).toBe(200);
      expect(await resourceHistory.json()).toMatchObject({
        hours: 168,
        samples: [{
          sampledAt,
          processRssBytes: 128 * 1024 ** 2,
          processHeapUsedBytes: 64 * 1024 ** 2,
          processCpuPercentOneCore: 12.5,
          availableMemoryBytes: 4 * 1024 ** 3,
          totalMemoryBytes: 16 * 1024 ** 3,
        }],
      });
      expect((await fetch(`${base}/api/tasks/history`)).status).toBe(401);
      const taskHistory = await fetch(`${base}/api/tasks/history?limit=999`, { headers });
      expect(taskHistory.status).toBe(200);
      expect(await taskHistory.json()).toMatchObject({
        limit: 100,
        items: [{
          id: "history-task", title: "Completed sample task", status: "completed",
          retryCount: 1, maxRetries: 3, goalTitle: "Resource and task history",
          result: { success: true, output: "Completed safely", duration: 42, costCents: 0 },
        }],
      });
      const claimReviews = await fetch(`${base}/api/claim-reviews`, { headers });
      expect(await claimReviews.json()).toMatchObject({ factualTruthVerified: false, items: [{ id: claimReview!.id, ownerDecision: "pending", assessment: { classification: "single_source", sources: [{ evidenceId: evidence!.id, verificationStatus: "unverified" }] } }] });
      const unverifiedClaimDecision = await fetch(`${base}/api/claim-reviews/${claimReview!.id}/decision`, {
        method: "POST", headers, body: JSON.stringify({ decision: "supports", note: "No source inspection attestation." }),
      });
      expect(unverifiedClaimDecision.status).toBe(400);
      const claimDecision = await fetch(`${base}/api/claim-reviews/${claimReview!.id}/decision`, {
        method: "POST", headers, body: JSON.stringify({ decision: "supports", note: "Owner independently inspected the source and its provenance.", sourcesIndependentlyChecked: true }),
      });
      expect(claimDecision.status).toBe(200);
      expect(await claimDecision.json()).toMatchObject({ factualTruthVerified: false, item: { ownerDecision: "supports", ownerSourcesIndependentlyChecked: true, reviewedBy: "owner-dashboard" } });
      const replayDecision = await fetch(`${base}/api/claim-reviews/${claimReview!.id}/decision`, {
        method: "POST", headers, body: JSON.stringify({ decision: "supports", note: "Replay must not overwrite the owner decision.", sourcesIndependentlyChecked: true }),
      });
      expect(replayDecision.status).toBe(409);
      const researchInitial = await fetch(`${base}/api/research`, { headers });
      expect(await researchInitial.json()).toMatchObject({ enabled: false, allowedHosts: [], factualVerificationPerformed: false });
      const invalidResearchConfig = await fetch(`${base}/api/config/research`, { method: "POST", headers, body: JSON.stringify({ enabled: true, allowedHosts: ["*.example.com"] }) });
      expect(invalidResearchConfig.status).toBe(400);
      const enabledResearch = await fetch(`${base}/api/config/research`, { method: "POST", headers, body: JSON.stringify({ enabled: true, allowedHosts: ["www.gov.uk", "www.gov.uk"] }) });
      expect(await enabledResearch.json()).toMatchObject({ enabled: true, allowedHosts: ["www.gov.uk"], restartRequired: false, factsVerified: false });
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
      expect((await fetch(`${base}/api/deliverables`)).status).toBe(401);
      const deliverables = await fetch(`${base}/api/deliverables`, { headers });
      expect(await deliverables.json()).toMatchObject({ executionEnabled: false, publicationEnabled: false,
        items: [{ id: deliverable.id, status: "pending_review", contentSha256: deliverable.contentSha256 }] });
      const detail = await fetch(`${base}/api/deliverables/${deliverable.id}`, { headers });
      expect(await detail.json()).toMatchObject({ item: { content: "# Product specification\n\nCustomer demand is an unverified hypothesis." } });
      const ownerReview = await fetch(`${base}/api/deliverables/${deliverable.id}/review`, {
        method: "POST", headers, body: JSON.stringify({ decision: "approved_for_internal_use", note: "For planning only" }),
      });
      expect(await ownerReview.json()).toMatchObject({ executionEnabled: false, publicationEnabled: false,
        item: { status: "approved_for_internal_use", reviewedBy: "owner-dashboard" } });
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
        items: [{
          evidenceAssessment: { classification: "research_gaps", evidenceCount: 1, uniqueSourceDomains: 1 },
          evidenceItems: [{ title: "Public source", verificationStatus: "unverified", claimArea: "demand", position: "supports", dateBasis: "publication" }],
        }],
      });

      const selfChange = createSelfImprovementProposal(db.raw, {
        title: "Dashboard workspace check", rationale: "Prepare a review-only candidate and rollback snapshot.",
        files: [{ path: "README.md", content: readFileSync("README.md", "utf8") + "\nReview candidate.\n" }],
        requesterId: "local-agent", requesterKind: "agent",
      });
      const selfImprovementsPath = `${base}/api/self-improvements`;
      expect((await fetch(selfImprovementsPath)).status).toBe(401);
      const isolationPath = `${selfImprovementsPath}/isolation-readiness`;
      expect((await fetch(isolationPath)).status).toBe(401);
      const isolationResponse = await fetch(isolationPath, { headers: { Authorization: `Bearer ${token}` } });
      expect(isolationResponse.status).toBe(200);
      expect(await isolationResponse.json()).toMatchObject({
        executionEnabled: false,
        report: { operatingSystem: "Windows", readyForOwnerReview: true, candidateExecutionEnabled: false },
      });
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
