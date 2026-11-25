import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import { createBusinessOpportunity, createOpportunityValidationGoal } from "../economics/opportunities.js";
import { getBusinessDeliverable, listBusinessDeliverables, reviewBusinessDeliverable, saveBusinessDeliverable } from "../economics/deliverables.js";

describe("local business deliverables", () => {
  const dbs: ReturnType<typeof createDatabase>[] = [];
  const roots: string[] = [];
  const setup = () => {
    const db = createDatabase(":memory:");
    dbs.push(db);
    const root = mkdtempSync(join(tmpdir(), "sod-deliverables-"));
    roots.push(root);
    const opportunity = createBusinessOpportunity(db.raw, {
      title: "Local product", customerSegment: "Small operators", customerProblem: "Records are fragmented",
      valueProposition: "A private tracker", evidenceSummary: "Hypothesis only", forecastDays: 90,
      confidence: 0.1, risks: "Demand and willingness to pay are unknown",
    }, "agent");
    const goal = createOpportunityValidationGoal(db.raw, opportunity.id)!;
    const task = db.raw.prepare("SELECT id FROM task_graph WHERE goal_id=? LIMIT 1").get(goal.goalId) as { id: string };
    return { db, root, opportunity, task };
  };
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("stores opportunity and task linked drafts in a bounded private workspace with verifiable versions", () => {
    const { db, root, opportunity, task } = setup();
    const draft = "# Product specification\n\nDemand is an unverified hypothesis.";
    const item = saveBusinessDeliverable(db.raw, root, {
      opportunityId: opportunity.id, taskId: task.id, type: "product_spec", title: "Private repair tracker", content: draft,
    }, "local-agent");
    expect(item).toMatchObject({ opportunityId: opportunity.id, taskId: task.id, status: "pending_review", version: 1, content: draft });
    expect(item.contentSha256).toBe(createHash("sha256").update(draft).digest("hex"));
    const stored = db.raw.prepare("SELECT storage_path FROM business_deliverable_versions WHERE deliverable_id=?").get(item.id) as { storage_path: string };
    expect(readFileSync(join(root, stored.storage_path), "utf8")).toBe(draft);
    expect(listBusinessDeliverables(db.raw)).toHaveLength(1);

    const retry = saveBusinessDeliverable(db.raw, root, {
      opportunityId: opportunity.id, taskId: task.id, type: "product_spec", title: "Private repair tracker", content: draft,
    }, "local-agent");
    expect(retry.id).toBe(item.id);
    expect(retry.version).toBe(1);
    const revised = saveBusinessDeliverable(db.raw, root, {
      opportunityId: opportunity.id, taskId: task.id, type: "product_spec", title: "Private repair tracker", content: `${draft}\n\nRevision 2: add export requirements.`
    }, "local-agent");
    expect(revised).toMatchObject({ id: item.id, version: 2, status: "pending_review" });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM business_deliverable_versions WHERE deliverable_id=?").get(item.id)).toEqual({ count: 2 });
  });

  it("rejects unrelated tasks and reports tampered content instead of serving it", () => {
    const { db, root, opportunity, task } = setup();
    db.raw.prepare("INSERT INTO goals (id,title,description,status,created_at) VALUES ('another-goal','Other','Other','active',datetime('now'))").run();
    db.raw.prepare("INSERT INTO task_graph (id,goal_id,title,description,status,created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV','another-goal','Other','Other','pending',datetime('now'))").run();
    expect(() => saveBusinessDeliverable(db.raw, root, {
      opportunityId: opportunity.id, taskId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", type: "business_plan", title: "Bad linkage", content: "No."
    }, "agent")).toThrow("must belong to this opportunity");

    const item = saveBusinessDeliverable(db.raw, root, {
      opportunityId: opportunity.id, taskId: task.id, type: "prototype_spec", title: "Prototype", content: "Keep code inactive."
    }, "agent");
    const path = db.raw.prepare("SELECT storage_path FROM business_deliverable_versions WHERE deliverable_id=?").get(item.id) as { storage_path: string };
    writeFileSync(join(root, path.storage_path), "tampered");
    expect(() => getBusinessDeliverable(db.raw, root, item.id, true)).toThrow("integrity check");
  });

  it("allows one owner review transition and never authorizes execution or publication", () => {
    const { db, root, opportunity } = setup();
    const item = saveBusinessDeliverable(db.raw, root, {
      opportunityId: opportunity.id, type: "market_report", title: "Research summary", content: "One source was retrieved; claims remain unverified."
    }, "local-agent");
    expect(reviewBusinessDeliverable(db.raw, item.id, "approved_for_internal_use", "Planning only")?.status).toBe("approved_for_internal_use");
    expect(reviewBusinessDeliverable(db.raw, item.id, "changes_requested", "second decision")).toBeNull();
    expect((db.raw.prepare("SELECT actor_kind,details_json FROM business_deliverable_events WHERE event_type='reviewed'").get() as any)).toMatchObject({ actor_kind: "owner" });
  });

  it("rejects oversized or empty generated content", () => {
    const { db, root, opportunity } = setup();
    const input = { opportunityId: opportunity.id, type: "website_draft" as const, title: "Landing page", content: "" };
    expect(() => saveBusinessDeliverable(db.raw, root, input, "agent")).toThrow("Content must contain");
    expect(() => saveBusinessDeliverable(db.raw, root, { ...input, content: "x".repeat(65_537) }, "agent")).toThrow("Content must contain");
  });
});
