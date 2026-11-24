import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { createBusinessOpportunity, proposeBusinessExperiment, reviewBusinessExperiment, transitionBusinessOpportunity } from "../economics/opportunities.js";
import { createTestConfig } from "./mocks.js";

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
      transitionBusinessOpportunity(db.raw, opportunity.id, "shortlisted");
      const experiment = proposeBusinessExperiment(db.raw, {
        opportunityId: opportunity.id, title: "Local prototype test", hypothesis: "H", method: "Local-only mock", successCriteria: "Pass/fail",
      }, "agent");

      const unauthenticated = await fetch(`${base}/api/experiments`);
      expect(unauthenticated.status).toBe(401);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
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
