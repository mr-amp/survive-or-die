import type { PolicyRule } from "../../types.js";

/**
 * Fail-closed gate for actions that can spend money or create paid cloud resources.
 * Review records are audit-only; no approval currently authorizes execution.
 */
export function createOwnerApprovalRule(): PolicyRule {
  return {
    id: "owner_approval.required",
    description: "Block protected actions; recorded owner reviews do not enable execution",
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
        "edit_own_file",
        "revert_last_edit",
        "reset_to_upstream",
        "install_npm_package",
        "pull_upstream",
      ],
    },
    evaluate() {
      return {
        rule: "owner_approval.required",
        action: "deny",
        reasonCode: "OWNER_APPROVAL_REQUIRED",
        humanMessage:
          "Blocked: this protected action requires owner review. No action was performed.",
      };
    },
  };
}
