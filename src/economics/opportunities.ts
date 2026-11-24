/** Persistent, review-only business opportunity pipeline.
 * Forecasts are hypotheses. Actuals can only be entered by the owner UI and
 * represent manually reported amounts; this module never moves money.
 */
import type Database from "better-sqlite3";
import { ulid } from "ulid";

export const OPPORTUNITY_STATUSES = [
  "discovered", "researching", "shortlisted", "proposal", "experiment", "completed", "rejected",
] as const;
export type OpportunityStatus = typeof OPPORTUNITY_STATUSES[number];
export type OpportunityActualKind = "income" | "expense";

export interface OpportunityInput {
  title: string;
  customerSegment: string;
  customerProblem: string;
  valueProposition: string;
  evidenceSummary: string;
  competitorSummary?: string;
  evidenceUrls?: string[];
  estimatedCostCents?: number | null;
  estimatedRevenueCents?: number | null;
  forecastDays: number;
  confidence: number;
  risks: string;
}

export interface BusinessOpportunity {
  id: string;
  title: string;
  customerSegment: string;
  customerProblem: string;
  valueProposition: string;
  evidenceSummary: string;
  competitorSummary: string;
  evidenceUrls: string[];
  estimatedCostCents: number | null;
  estimatedRevenueCents: number | null;
  forecastDays: number;
  confidence: number;
  risks: string;
  status: OpportunityStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  actualIncomeCents: number;
  actualExpenseCents: number;
  actuals: Array<{
    id: string;
    kind: OpportunityActualKind;
    amountCents: number;
    currency: "GBP";
    description: string;
    externalReference: string | null;
    enteredBy: string;
    createdAt: string;
  }>;
}

const STATUS_TRANSITIONS: Record<OpportunityStatus, readonly OpportunityStatus[]> = {
  discovered: ["researching", "shortlisted", "rejected"],
  researching: ["shortlisted", "proposal", "rejected"],
  shortlisted: ["researching", "proposal", "experiment", "rejected"],
  proposal: ["researching", "experiment", "rejected"],
  experiment: ["proposal", "completed", "rejected"],
  completed: [],
  rejected: [],
};

function text(value: unknown, label: string, maximum: number, required = true): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const result = value.trim();
  if ((required && !result) || result.length > maximum) throw new Error(`${label} must be ${required ? "1-" : "at most "}${maximum} characters.`);
  return result;
}

function cents(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer number of pence.`);
  return value;
}

function rowToOpportunity(row: any, actualRows: any[], allActuals?: { income: number; expense: number }): BusinessOpportunity {
  const actuals = actualRows.map((actual) => ({
    id: actual.id,
    kind: actual.kind as OpportunityActualKind,
    amountCents: Number(actual.amount_cents),
    currency: "GBP" as const,
    description: actual.description,
    externalReference: actual.external_reference,
    enteredBy: actual.entered_by,
    createdAt: actual.created_at,
  }));
  return {
    id: row.id,
    title: row.title,
    customerSegment: row.customer_segment,
    customerProblem: row.customer_problem,
    valueProposition: row.value_proposition,
    evidenceSummary: row.evidence_summary,
    competitorSummary: row.competitor_summary,
    evidenceUrls: JSON.parse(row.evidence_urls),
    estimatedCostCents: row.estimated_cost_cents === null ? null : Number(row.estimated_cost_cents),
    estimatedRevenueCents: row.estimated_revenue_cents === null ? null : Number(row.estimated_revenue_cents),
    forecastDays: Number(row.forecast_days),
    confidence: Number(row.confidence),
    risks: row.risks,
    status: row.status,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actualIncomeCents: allActuals?.income ?? actuals.filter((actual) => actual.kind === "income").reduce((sum, actual) => sum + actual.amountCents, 0),
    actualExpenseCents: allActuals?.expense ?? actuals.filter((actual) => actual.kind === "expense").reduce((sum, actual) => sum + actual.amountCents, 0),
    actuals,
  };
}

export function createBusinessOpportunity(db: Database.Database, input: OpportunityInput, createdBy: string, now = new Date()): BusinessOpportunity {
  const actor = text(createdBy, "Creator", 160);
  const title = text(input.title, "Title", 160);
  const customerSegment = text(input.customerSegment, "Customer segment", 240);
  const customerProblem = text(input.customerProblem, "Customer problem", 1000);
  const valueProposition = text(input.valueProposition, "Value proposition", 1000);
  const evidenceSummary = text(input.evidenceSummary, "Evidence summary", 2000);
  const competitorSummary = text(input.competitorSummary ?? "", "Competitor summary", 2000, false);
  const risks = text(input.risks, "Risks", 2000);
  if (!Number.isSafeInteger(input.forecastDays) || input.forecastDays < 1 || input.forecastDays > 3650) throw new Error("Forecast period must be 1-3650 days.");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("Confidence must be between 0 and 1.");
  const evidenceUrls = input.evidenceUrls ?? [];
  if (!Array.isArray(evidenceUrls) || evidenceUrls.length > 10) throw new Error("Provide no more than 10 evidence URLs.");
  const safeUrls = evidenceUrls.map((value) => {
    const raw = text(value, "Evidence URL", 1000);
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new Error("Evidence URLs must be valid HTTP or HTTPS links."); }
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) throw new Error("Evidence URLs must be HTTP or HTTPS without embedded credentials.");
    return parsed.toString();
  });
  const estimatedCostCents = cents(input.estimatedCostCents, "Estimated cost");
  const estimatedRevenueCents = cents(input.estimatedRevenueCents, "Estimated revenue");
  const id = ulid();
  const timestamp = now.toISOString();
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO business_opportunities
      (id,title,customer_segment,customer_problem,value_proposition,evidence_summary,competitor_summary,evidence_urls,estimated_cost_cents,estimated_revenue_cents,forecast_days,confidence,risks,status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,'discovered',?,?,?)`).run(
      id, title, customerSegment, customerProblem, valueProposition, evidenceSummary, competitorSummary,
      JSON.stringify(safeUrls), estimatedCostCents, estimatedRevenueCents, input.forecastDays, input.confidence,
      risks, actor, timestamp, timestamp,
    );
    db.prepare("INSERT INTO business_opportunity_events (id,opportunity_id,event_type,actor_kind,actor_id,details,created_at) VALUES (?,?, 'created','agent',?,?,?)")
      .run(ulid(), id, actor, JSON.stringify({ evidenceUrls: safeUrls.length, estimatesAreUnverified: true }), timestamp);
    return db.prepare("SELECT * FROM business_opportunities WHERE id = ?").get(id) as any;
  });
  return rowToOpportunity(transaction(), []);
}

export function listBusinessOpportunities(db: Database.Database, limit = 50): BusinessOpportunity[] {
  const bounded = Math.max(1, Math.min(100, Math.floor(limit)));
  const rows = db.prepare("SELECT * FROM business_opportunities ORDER BY CASE status WHEN 'completed' THEN 1 WHEN 'rejected' THEN 2 ELSE 0 END, updated_at DESC LIMIT ?").all(bounded) as any[];
  const actualQuery = db.prepare("SELECT id,kind,amount_cents,external_reference,description,entered_by,created_at FROM business_opportunity_actuals WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT 100");
  const totalsQuery = db.prepare("SELECT kind, SUM(amount_cents) AS total FROM business_opportunity_actuals WHERE opportunity_id = ? GROUP BY kind");
  return rows.map((row) => {
    const totals = Object.fromEntries((totalsQuery.all(row.id) as Array<{ kind: string; total: number }>).map((entry) => [entry.kind, Number(entry.total)]));
    return rowToOpportunity(row, actualQuery.all(row.id) as any[], { income: totals.income || 0, expense: totals.expense || 0 });
  });
}

export function transitionBusinessOpportunity(db: Database.Database, id: string, status: OpportunityStatus, actorId = "owner-dashboard", now = new Date()): BusinessOpportunity | null {
  if (!OPPORTUNITY_STATUSES.includes(status)) throw new Error("Unknown opportunity status.");
  const actor = text(actorId, "Actor", 160);
  const timestamp = now.toISOString();
  const transaction = db.transaction(() => {
    const current = db.prepare("SELECT * FROM business_opportunities WHERE id = ?").get(id) as any;
    if (!current) return null;
    if (current.status === status) return current;
    if (!STATUS_TRANSITIONS[current.status as OpportunityStatus]?.includes(status)) throw new Error(`Invalid opportunity transition: ${current.status} to ${status}.`);
    db.prepare("UPDATE business_opportunities SET status = ?, updated_at = ? WHERE id = ? AND status = ?").run(status, timestamp, id, current.status);
    db.prepare("INSERT INTO business_opportunity_events (id,opportunity_id,event_type,actor_kind,actor_id,details,created_at) VALUES (?,?, 'status_changed','owner',?,?,?)")
      .run(ulid(), id, actor, JSON.stringify({ from: current.status, to: status }), timestamp);
    return db.prepare("SELECT * FROM business_opportunities WHERE id = ?").get(id) as any;
  });
  const row = transaction();
  if (!row) return null;
  const actuals = db.prepare("SELECT id,kind,amount_cents,external_reference,description,entered_by,created_at FROM business_opportunity_actuals WHERE opportunity_id = ? ORDER BY created_at DESC LIMIT 100").all(id) as any[];
  const totals = Object.fromEntries((db.prepare("SELECT kind, SUM(amount_cents) AS total FROM business_opportunity_actuals WHERE opportunity_id = ? GROUP BY kind").all(id) as Array<{ kind: string; total: number }>).map((entry) => [entry.kind, Number(entry.total)]));
  return rowToOpportunity(row, actuals, { income: totals.income || 0, expense: totals.expense || 0 });
}

/** Record an owner-reported ledger item. Idempotency makes dashboard retries safe. */
export function recordBusinessActual(
  db: Database.Database,
  input: { opportunityId: string; kind: OpportunityActualKind; amountCents: number; description: string; externalReference?: string; idempotencyKey: string },
  actorId = "owner-dashboard",
  now = new Date(),
): BusinessOpportunity | null {
  if (actorId !== "owner-dashboard") throw new Error("Only the authenticated owner dashboard may record actual income or expenses.");
  if (input.kind !== "income" && input.kind !== "expense") throw new Error("Actual kind must be income or expense.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new Error("Actual amount must be a positive integer number of pence.");
  const description = text(input.description, "Description", 500);
  const idempotencyKey = text(input.idempotencyKey, "Idempotency key", 120);
  const externalReference = input.externalReference ? text(input.externalReference, "Reference", 160) : null;
  const timestamp = now.toISOString();
  const transaction = db.transaction(() => {
    const opportunity = db.prepare("SELECT id FROM business_opportunities WHERE id = ?").get(input.opportunityId);
    if (!opportunity) return false;
    const prior = db.prepare("SELECT opportunity_id,kind,amount_cents,description,external_reference FROM business_opportunity_actuals WHERE idempotency_key = ?").get(idempotencyKey) as any;
    if (prior) {
      if (prior.opportunity_id !== input.opportunityId || prior.kind !== input.kind || prior.amount_cents !== input.amountCents || prior.description !== description || prior.external_reference !== externalReference) throw new Error("Idempotency key was already used for a different actual record.");
      return true;
    }
    db.prepare("INSERT INTO business_opportunity_actuals (id,opportunity_id,kind,amount_cents,currency,description,external_reference,entered_by,idempotency_key,created_at) VALUES (?,?,?,?,'GBP',?,?,?,?,?)")
      .run(ulid(), input.opportunityId, input.kind, input.amountCents, description, externalReference, actorId, idempotencyKey, timestamp);
    db.prepare("INSERT INTO business_opportunity_events (id,opportunity_id,event_type,actor_kind,actor_id,details,created_at) VALUES (?,?, 'actual_recorded','owner',?,?,?)")
      .run(ulid(), input.opportunityId, actorId, JSON.stringify({ kind: input.kind, amountCents: input.amountCents, currency: "GBP", idempotencyKey }), timestamp);
    return true;
  });
  if (!transaction()) return null;
  return listBusinessOpportunities(db, 100).find((item) => item.id === input.opportunityId) ?? null;
}

