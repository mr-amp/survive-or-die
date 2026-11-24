import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../state/database.js";
import { createDefaultRules } from "../agent/policy-rules/index.js";
import { PolicyEngine } from "../agent/policy-engine.js";
import { executeTool } from "../agent/tools.js";
import { DEFAULT_TREASURY_POLICY } from "../types.js";
import type { AutomatonTool, ToolContext } from "../types.js";

describe("protected tool approval requests", () => {
  it("queues the exact denied action but never invokes its executor", async () => {
    const db = createDatabase(":memory:");
    try {
      const execute = vi.fn(async () => "executed");
      const tool: AutomatonTool = {
        name: "transfer_credits",
        description: "Transfer credits",
        parameters: { type: "object" },
        execute,
        riskLevel: "dangerous",
        category: "financial",
      };
      const context = {
        db,
        identity: { address: "agent-wallet" },
      } as unknown as ToolContext;
      const engine = new PolicyEngine(
        db.raw,
        createDefaultRules(DEFAULT_TREASURY_POLICY, { requireOwnerApproval: true }),
      );

      const result = await executeTool(
        "transfer_credits",
        { amount_cents: 250, to_address: "0x1234567890123456789012345678901234567890" },
        [tool],
        context,
        engine,
        {
          inputSource: "agent",
          turnToolCallCount: 1,
          sessionSpend: {
            recordSpend: vi.fn(),
            checkLimit: () => ({ allowed: true }),
            getHourlySpend: () => 0,
            getDailySpend: () => 0,
          } as any,
        },
      );

      const queued = db.raw.prepare(
        "SELECT action_name, action_parameters, scope, status, estimated_cost_cents FROM owner_approval_requests",
      ).get() as any;
      expect(result.error).toContain("OWNER_APPROVAL_REQUIRED");
      expect(result.error).toContain("Approval request");
      expect(execute).not.toHaveBeenCalled();
      expect(queued).toMatchObject({
        action_name: "transfer_credits",
        scope: "financial",
        status: "pending",
        estimated_cost_cents: 250,
      });
      expect(JSON.parse(queued.action_parameters)).toEqual({ amount_cents: 250, to_address: "0x1234567890123456789012345678901234567890" });
    } finally {
      db.close();
    }
  });
});

