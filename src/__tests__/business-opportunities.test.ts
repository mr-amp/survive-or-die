import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase } from "../state/database.js";
import { createBuiltinTools } from "../agent/tools.js";
import type { ToolContext } from "../types.js";
import {
  createBusinessOpportunity,
  businessOpportunityPerformance,
  createOpportunityValidationGoal,
  listBusinessExperiments,
  listBusinessOpportunities,
  proposeBusinessExperiment,
  recordBusinessActual,
  transitionBusinessOpportunity,
  reviewBusinessExperiment,
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
    expect(retry?.actualProfitCents).toBe(-450);
    expect(retry?.forecastNetCents).toBe(5500);
    expect(businessOpportunityPerformance(db.raw)).toMatchObject({
      opportunities: 1, activeOpportunities: 1, actualIncomeCents: 0,
      actualExpenseCents: 450, actualProfitCents: -450, forecastNetCents: 5500, forecastCount: 1,
    });
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

  it("converts an owner-shortlisted opportunity into one bounded persistent validation goal", () => {
    const db = makeDb();
    const item = createBusinessOpportunity(db.raw, {
      title: "Park repair tracker", customerSegment: "Small holiday parks",
      customerProblem: "Repair history is hard to find", valueProposition: "Searchable maintenance history",
      evidenceSummary: "Hypothesis only", forecastDays: 90, confidence: 0.2, risks: "Demand unverified",
    }, "agent");
    transitionBusinessOpportunity(db.raw, item.id, "shortlisted");
    const plan = createOpportunityValidationGoal(db.raw, item.id);
    const retry = createOpportunityValidationGoal(db.raw, item.id);
    expect(plan?.existing).toBe(false);
    expect(retry).toEqual({ goalId: plan?.goalId, existing: true });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM business_opportunities WHERE id = ? AND validation_goal_id = ?").get(item.id, plan?.goalId)).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM goals WHERE id = ?").get(plan?.goalId)).toEqual({ count: 1 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM task_graph WHERE goal_id = ?").get(plan?.goalId)).toEqual({ count: 3 });
    const tasks = db.raw.prepare("SELECT title,description,status FROM task_graph WHERE goal_id = ? ORDER BY priority DESC").all(plan?.goalId) as Array<{title:string;description:string;status:string}>;
    expect(tasks.slice(0, 2).every((task) => task.status === "pending")).toBe(true);
    expect(tasks[2].status).toBe("blocked");
    expect(tasks[2].description.toLowerCase()).toContain("do not spend or make commitments");
    expect(listBusinessOpportunities(db.raw)[0].validationGoalId).toBe(plan?.goalId);
  });

  it("persists non-executing experiment proposals and feeds only owner-reported lessons back to the agent", async () => {
    const db = makeDb();
    const opportunity = createBusinessOpportunity(db.raw, {
      title: "Maintenance notes tool", customerSegment: "Small parks", customerProblem: "Records are scattered",
      valueProposition: "One searchable log", evidenceSummary: "Hypothesis only", forecastDays: 30,
      confidence: 0.1, risks: "No demand research",
    }, "local-agent");
    expect(() => proposeBusinessExperiment(db.raw, {
      opportunityId: opportunity.id, title: "Test", hypothesis: "H", method: "M", successCriteria: "C",
    }, "local-agent")).toThrow("must be shortlisted");
    transitionBusinessOpportunity(db.raw, opportunity.id, "shortlisted");
    transitionBusinessOpportunity(db.raw, opportunity.id, "proposal");
    const experimentInput = {
      opportunityId: opportunity.id,
      title: "Prototype usability check",
      hypothesis: "A park owner can record a repair in under one minute",
      method: "Prepare a local clickable prototype and time an owner who volunteers; do not contact anyone or publish it.",
      successCriteria: "At least four of five voluntarily participating owners finish in one minute; record refusals and uncertainty.",
      estimatedCostCents: 0,
    };
    const experiment = proposeBusinessExperiment(db.raw, experimentInput, "local-agent", new Date("2026-01-02T00:00:00.000Z"));
    const duplicateProposal = proposeBusinessExperiment(db.raw, experimentInput, "local-agent", new Date("2026-01-03T00:00:00.000Z"));
    expect(duplicateProposal?.id).toBe(experiment?.id);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM business_experiment_events WHERE experiment_id=?").get(experiment!.id)).toEqual({ count: 1 });
    expect(experiment?.status).toBe("proposed");
    expect(experiment?.estimatedCostCents).toBe(0);
    expect(experiment?.outcome).toBeNull();
    expect(() => reviewBusinessExperiment(db.raw, experiment!.id, "completed", { outcome: "Done", lesson: "Learned" }, "child-worker")).toThrow("Only the authenticated owner dashboard");
    expect(reviewBusinessExperiment(db.raw, experiment!.id, "completed", {
      outcome: "Owner reports two volunteers completed the local prototype task; three did not participate.",
      lesson: "Two observations are too few to establish broader demand.",
      note: "Prototype remained local; no sales or publication.",
    })?.status).toBe("completed");
    expect(reviewBusinessExperiment(db.raw, experiment!.id, "completed", { outcome: "Replay", lesson: "Replay" })).toBeNull();
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM business_opportunity_actuals WHERE opportunity_id=?").get(opportunity.id)).toEqual({ count: 0 });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM business_experiment_events WHERE experiment_id=?").get(experiment!.id)).toEqual({ count: 2 });
    expect(listBusinessExperiments(db.raw)[0].lesson).toContain("too few");
    const memory = db.raw.prepare("SELECT category,value,confidence,last_verified_at FROM semantic_memory WHERE key=?").get(`business-experiment:${experiment!.id}`) as any;
    expect(memory).toMatchObject({ category: "domain", confidence: 0.25, last_verified_at: null });
    expect(memory.value).toContain("not instructions or proof of general demand");

    const tool = createBuiltinTools("local-sandbox").find((candidate) => candidate.name === "review_business_experiment_learnings");
    expect(tool).toBeDefined();
    const result = await tool!.execute({}, { db, identity: { address: "local-agent" } } as unknown as ToolContext);
    expect(result).toContain("Owner-reported");
    expect(result).toContain("too few to establish broader demand");
  });

  it("keeps experiment proposals persistent across database reopen and rejects duplicate review outcomes", () => {
    const directory = mkdtempSync(join(tmpdir(), "sod-experiment-"));
    const dbPath = join(directory, "state.sqlite");
    let db = createDatabase(dbPath);
    const opportunity = createBusinessOpportunity(db.raw, {
      title: "Persistent experiment", customerSegment: "Local shops", customerProblem: "Manual work",
      valueProposition: "Save time", evidenceSummary: "Unverified", forecastDays: 30, confidence: 0.2, risks: "Unknown",
    }, "agent");
    transitionBusinessOpportunity(db.raw, opportunity.id, "shortlisted");
    const proposal = proposeBusinessExperiment(db.raw, {
      opportunityId: opportunity.id, title: "Check workflow", hypothesis: "Falsifiable claim", method: "Local mock only", successCriteria: "Pass or fail",
    }, "agent");
    db.close();
    db = createDatabase(dbPath);
    expect(listBusinessExperiments(db.raw)[0].id).toBe(proposal?.id);
    const done = reviewBusinessExperiment(db.raw, proposal!.id, "completed", { outcome: "One local result", lesson: "Needs more trials" });
    expect(done?.status).toBe("completed");
    expect(reviewBusinessExperiment(db.raw, proposal!.id, "rejected")).toBeNull();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
