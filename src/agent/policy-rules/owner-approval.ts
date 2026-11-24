import type { PolicyRule } from "../../types.js";

/**
 * Fail-closed gate for actions that can spend money or create paid cloud resources.
 * The owner approval queue is not connected yet, so these operations stay denied.
 */
export function createOwnerApprovalRule(): PolicyRule {
  return {
    id: "owner_approval.required",
    description: "Block financial and paid cloud actions until owner approval is available",
    priority: 1000,
    appliesTo: {
      by: "name",
      names: [
        "topup_credits",
        "transfer_credits",
        "x402_fetch",
        "fund_child",
        "create_sandbox",
        "register_domain",
        "spawn_child",
        "start_child",
      ],
    },
    evaluate() {
      return {
        rule: "owner_approval.required",
        action: "deny",
        reasonCode: "OWNER_APPROVAL_REQUIRED",
        humanMessage:
          "Blocked: this financial or paid cloud action requires owner approval. No transaction was made.",
      };
    },
  };
}
