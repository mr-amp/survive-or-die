import { describe, expect, it } from "vitest";
import type { PolicyRequest } from "../types.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { createOwnerApprovalRule } from "../agent/policy-rules/owner-approval.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";

const protectedActions = [
  "topup_credits",
  "transfer_credits",
  "x402_fetch",
  "fund_child",
  "create_sandbox",
  "register_domain",
];

describe("owner approval policy", () => {
  it("denies every financial or paid cloud tool until approval is connected", () => {
    const rule = createOwnerApprovalRule();

    for (const name of protectedActions) {
      const result = rule.evaluate({ tool: { name } } as PolicyRequest);
      expect(result?.action, name).toBe("deny");
      expect(result?.reasonCode, name).toBe("OWNER_APPROVAL_REQUIRED");
    }
  });

  it("is enabled by the runtime's explicit policy option", () => {
    expect(
      createDefaultRules(DEFAULT_TREASURY_POLICY, { requireOwnerApproval: true }).some(
        (rule) => rule.id === "owner_approval.required",
      ),
    ).toBe(true);
    expect(
      createDefaultRules(DEFAULT_TREASURY_POLICY).some(
        (rule) => rule.id === "owner_approval.required",
      ),
    ).toBe(false);
  });
});
