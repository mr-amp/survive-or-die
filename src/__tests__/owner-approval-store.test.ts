import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../state/database.js";
import {
  cancelOwnerApproval,
  listOwnerApprovalEvents,
  listOwnerApprovalRequests,
  requestOwnerApproval,
  reviewOwnerApproval,
  revokeOwnerApproval,
} from "../approvals/store.js";
import type { ApprovalRequestInput } from "../approvals/store.js";

describe("persistent owner approval review", () => {
  let db: ReturnType<typeof createDatabase>;
  const input: ApprovalRequestInput = {
    requesterId: "agent-wallet",
    requesterKind: "agent",
    scope: "financial",
    actionName: "transfer_credits",
    actionParameters: { amount_cents: 250, to_address: "0xabc" },
    description: "Transfer requested by agent; not executed.",
    estimatedCostCents: 250,
    riskLevel: "dangerous",
  };

  beforeEach(() => {
    db = createDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("persists a pending request and deduplicates the exact action independent of key order", () => {
    const first = requestOwnerApproval(db.raw, input);
    const duplicate = requestOwnerApproval(db.raw, {
      ...input,
      actionParameters: { to_address: "0xabc", amount_cents: 250 },
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.actionHash).toBe(first.actionHash);
    expect(listOwnerApprovalRequests(db.raw, { status: "pending" })).toHaveLength(1);
    expect(listOwnerApprovalEvents(db.raw, first.id).map((event) => event.eventType)).toEqual(["requested"]);
  });

  it("keeps an unknown cost distinct from a zero-cost estimate", () => {
    const request = requestOwnerApproval(db.raw, {
      ...input,
      scope: "paid_cloud",
      actionName: "create_sandbox",
      estimatedCostCents: null,
    });
    expect(request.estimatedCostCents).toBeNull();
  });

  it("binds a review to exact action parameters and prevents review replay", () => {
    const first = requestOwnerApproval(db.raw, input);
    const different = requestOwnerApproval(db.raw, {
      ...input,
      actionParameters: { amount_cents: 251, to_address: "0xabc" },
    });
    expect(different.id).not.toBe(first.id);

    const approved = reviewOwnerApproval(db.raw, first.id, "approved", "owner-dashboard", "Reviewed exact transfer");
    expect(approved?.status).toBe("approved");
    expect(approved?.actionParameters).toEqual(input.actionParameters);
    expect(reviewOwnerApproval(db.raw, first.id, "approved", "owner-dashboard")).toBeNull();
    expect(listOwnerApprovalEvents(db.raw, first.id).map((event) => event.eventType)).toEqual(["approved", "requested"]);
  });

  it("rejects self-review and supports cancellation and revocation", () => {
    const pending = requestOwnerApproval(db.raw, input);
    expect(() => reviewOwnerApproval(db.raw, pending.id, "approved", input.requesterId)).toThrow("cannot review its own action");
    const cancelled = cancelOwnerApproval(db.raw, pending.id, "owner-dashboard");
    expect(cancelled?.status).toBe("cancelled");

    const second = requestOwnerApproval(db.raw, input);
    const approved = reviewOwnerApproval(db.raw, second.id, "approved", "owner-dashboard");
    expect(approved?.status).toBe("approved");
    const revoked = revokeOwnerApproval(db.raw, second.id, "owner-dashboard", "Emergency revocation");
    expect(revoked?.status).toBe("revoked");
    expect(listOwnerApprovalEvents(db.raw, second.id).map((event) => event.eventType)).toEqual([
      "revoked", "approved", "requested",
    ]);
  });

  it("expires pending requests and records expiry history", () => {
    const created = new Date("2026-01-01T00:00:00.000Z");
    const pending = requestOwnerApproval(db.raw, { ...input, expiresInMs: 60_000 }, created);
    const listed = listOwnerApprovalRequests(db.raw, { limit: 10 }, new Date("2026-01-01T00:02:00.000Z"));
    expect(listed.find((entry) => entry.id === pending.id)?.status).toBe("expired");
    expect(listOwnerApprovalEvents(db.raw, pending.id).map((event) => event.eventType)).toContain("expired");
    expect(reviewOwnerApproval(db.raw, pending.id, "approved", "owner-dashboard", "", new Date("2026-01-01T00:03:00.000Z"))).toBeNull();
  });
});

