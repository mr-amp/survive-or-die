import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { createBuiltinTools } from "../agent/tools.js";
import type { ToolContext } from "../types.js";
import {
  createBusinessOpportunity,
  listBusinessOpportunities,
  recordBusinessActual,
  transitionBusinessOpportunity,
} from "../economics/opportunities.js";

describe("persistent business opportunity pipeline", () => {
  const databases: ReturnType<typeof createDatabase>[] = [];
  const makeDb = () => {
    const db = createDatabase(":memory:");
    databases.push(db);
    return db;
  };
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("persists unverified estimates separately from owner reported actuals", () => {
    const db = makeDb();
    const opportunity = createBusinessOpportunity(db.raw, {
      title: "Repair checklist service",
      customerSegment: "Small holiday parks",
      customerProblem: "Maintenance records are scattered",
      valueProposition: "A searchable maintenance checklist",
      evidenceSummary: "Owner observation only; interviews not completed",
      competitorSummary: "Not researched",
      evidenceUrls: ["https://example.test/problem"],
      estimatedCostCents: 2500,
      estimatedRevenueCents: 8000,
      forecastDays: 90,
      confidence: 0.2,
      risks: "Demand and willingness to pay are unknown",
    }, "local-agent", new Date("2026-01-01T00:00:00.000Z"));

    expect(opportunity.status).toBe("discovered");
    expect(opportunity.actualIncomeCents).toBe(0);
    expect(transitionBusinessOpportunity(db.raw, opportunity.id, "researching")?.status).toBe("researching");
    const first = recordBusinessActual(db.raw, {
      opportunityId: opportunity.id,
      kind: "expense",
      amountCents: 450,
      description: "Owner reported prototype hosting expense",
      idempotencyKey: "owner-entry-1",
    });
    const retry = recordBusinessActual(db.raw, {
      opportunityId: opportunity.id,
      kind: "expense",
      amountCents: 450,
      description: "Owner reported prototype hosting expense",
      idempotencyKey: "owner-entry-1",
    });
    expect(first?.actualExpenseCents).toBe(450);
    expect(retry?.actualExpenseCents).toBe(450);
    expect(listBusinessOpportunities(db.raw)[0].actuals).toHaveLength(1);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM business_opportunity_events WHERE opportunity_id = ?").get(opportunity.id)).toEqual({ count: 3 });
  });

  it("rejects unsafe sources, invalid transitions, non-owner actuals and idempotency-key reuse", () => {
    const db = makeDb();
    const base = {
      title: "Idea", customerSegment: "People", customerProblem: "Problem",
      valueProposition: "Value", evidenceSummary: "Unverified", forecastDays: 30,
      confidence: 0.5, risks: "Unknown",
    };
    expect(() => createBusinessOpportunity(db.raw, { ...base, evidenceUrls: ["file:///etc/passwd"] }, "agent")).toThrow("HTTP or HTTPS");
    const item = createBusinessOpportunity(db.raw, base, "agent");
    expect(() => transitionBusinessOpportunity(db.raw, item.id, "completed")).toThrow("Invalid opportunity transition");
    expect(() => recordBusinessActual(db.raw, {
      opportunityId: item.id, kind: "income", amountCents: 100, description: "Reported",
      idempotencyKey: "x",
    }, "child-worker")).toThrow("Only the authenticated owner dashboard");
    recordBusinessActual(db.raw, {
      opportunityId: item.id, kind: "income", amountCents: 100, description: "Reported",
      idempotencyKey: "x",
    });
    expect(() => recordBusinessActual(db.raw, {
      opportunityId: item.id, kind: "income", amountCents: 101, description: "Different",
      idempotencyKey: "x",
    })).toThrow("already used for a different");
  });

  it("exposes the pipeline as an agent capability without performing external actions", async () => {
    const db = makeDb();
    const tool = createBuiltinTools("local-sandbox").find((candidate) => candidate.name === "propose_business_opportunity");
    expect(tool).toBeDefined();
    const result = await tool!.execute({
      title: "Local proposal", customer_segment: "Small businesses", customer_problem: "Untracked work",
      value_proposition: "Simple tracking", evidence_summary: "Hypothesis only", forecast_days: 60,
      confidence: 0.1, risks: "Demand unknown",
    }, { db, identity: { address: "local-agent" } } as unknown as ToolContext);
    expect(result).toContain("unverified hypotheses");
    expect(listBusinessOpportunities(db.raw)).toHaveLength(1);
  });

  it("keeps the actual balance complete while limiting the displayed ledger history", () => {
    const db = makeDb();
    const item = createBusinessOpportunity(db.raw, {
      title: "Ledger history", customerSegment: "Owners", customerProblem: "Tracking",
      valueProposition: "A ledger", evidenceSummary: "Not researched", forecastDays: 30,
      confidence: 0, risks: "Unknown",
    }, "agent");
    for (let index = 0; index < 101; index += 1) {
      recordBusinessActual(db.raw, {
        opportunityId: item.id, kind: "income", amountCents: 1,
        description: `Owner entry ${index}`, idempotencyKey: `entry-${index}`,
      });
    }
    const listed = listBusinessOpportunities(db.raw)[0];
    expect(listed.actualIncomeCents).toBe(101);
    expect(listed.actuals).toHaveLength(100);
  });
});
