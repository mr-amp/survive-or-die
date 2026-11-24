/**
 * Local Agent Worker
 *
 * Runs inference-driven task execution in-process as an async background task.
 * Each worker executes through a harness chosen by role via HarnessRegistry.
 */

import path from "node:path";
import os from "node:os";
import { hasMemoryForLocalWorker } from "../platform/resources.js";
import { ulid } from "ulid";
import { createLogger } from "../observability/logger.js";
import type { HarnessContext, WorkerInferenceClient } from "../agent/harness-types.js";
import { buildWisdomFromGoal, createBudgetFromTask } from "../agent/harness-types.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import { completeTask, failTask } from "./task-graph.js";
import type { TaskNode } from "./task-graph.js";
import { AgentWorkspace } from "./workspace.js";
import type {
  AutomatonConfig,
  AutomatonIdentity,
  AutomatonTool,
  ConwayClient,
  InputSource,
  SpendTrackerInterface,
  ToolContext,
} from "../types.js";
import type { Database } from "better-sqlite3";
import type { PolicyEngine } from "../agent/policy-engine.js";

const logger = createLogger("orchestration.local-worker");
const DEFAULT_ALLOWED_EDIT_ROOT = process.cwd();

interface LocalWorkerConfig {
  db: Database;
  inference: WorkerInferenceClient;
  conway: ConwayClient;
  maxTurns?: number;
  harnessRegistry: HarnessRegistry;
  identity: AutomatonIdentity;
  config: AutomatonConfig;
  allowedEditRoot?: string;
  tools?: AutomatonTool[];
  toolContext?: ToolContext;
  policyEngine?: PolicyEngine;
  spendTracker?: SpendTrackerInterface;
  inputSource?: InputSource;
}

export class LocalWorkerPool {
  private activeWorkers = new Map<string, { promise: Promise<void>; abortController: AbortController; taskId: string }>();

  constructor(private readonly config: LocalWorkerConfig) {
    this.recoverInterruptedRuns();
  }

  spawn(task: TaskNode): { address: string; name: string; sandboxId: string } {
    const limit = this.config.config.localOnly
      ? (this.config.config.localProfile === "32gb" ? 2 : 1)
      : Math.max(1, this.config.config.maxChildren || 3);
    if (this.activeWorkers.size >= limit) {
      throw new Error(`Local worker limit reached (${limit}); task remains persisted for a later retry.`);
    }
    if (this.config.config.localOnly && !hasMemoryForLocalWorker(os.freemem(), this.config.config.localProfile || "16gb")) {
      throw new Error("Local worker deferred because available RAM is below the profile safety reserve.");
    }
    const workerId = `local-worker-${ulid()}`;
    const workerName = `worker-${task.agentRole ?? "generalist"}-${workerId.slice(-6)}`;
    const address = `local://${workerId}`;
    const abortController = new AbortController();
    this.registerWorker(workerId, task, workerName, address);

    const workerPromise = this.runWorker(workerId, task, abortController.signal)
      .catch((error) => {
        logger.error("Local worker crashed", error instanceof Error ? error : new Error(String(error)), {
          workerId,
          taskId: task.id,
        });
        try {
          failTask(
            this.config.db,
            task.id,
            `Worker crashed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        } catch {
          // Task may already be in a terminal state.
        }
      })
      .finally(() => {
        this.activeWorkers.delete(workerId);
      });

    this.activeWorkers.set(workerId, { promise: workerPromise, abortController, taskId: task.id });
    return { address, name: workerName, sandboxId: workerId };
  }

  stopTask(taskId: string): boolean {
    const pair = [...this.activeWorkers.entries()].find(([, active]) => active.taskId === taskId);
    const worker = pair?.[1];
    if (!worker) return false;
    this.setWorkerState(pair![0], "stopping", "cancel_requested", "Owner requested worker cancellation.");
    worker.abortController.abort();
    return true;
  }

  getActiveCount(): number {
    return this.activeWorkers.size;
  }

  hasWorker(addressOrId: string): boolean {
    const id = addressOrId.replace("local://", "");
    return this.activeWorkers.has(id);
  }

  async shutdown(): Promise<void> {
    for (const [, worker] of this.activeWorkers) {
      worker.abortController.abort();
    }
    await Promise.allSettled([...this.activeWorkers.values()].map((worker) => worker.promise));
    this.activeWorkers.clear();
  }

  private async runWorker(workerId: string, task: TaskNode, signal: AbortSignal): Promise<void> {
    const workerName = `worker-${task.agentRole ?? "generalist"}-${workerId.slice(-6)}`;
    this.registerWorker(workerId, task, workerName, `local://${workerId}`);
    this.setWorkerState(workerId, "running", "started", "Worker started its assigned task.");
    const harness = this.config.harnessRegistry.createForRole(task.agentRole);
    const workspace = new AgentWorkspace(task.goalId);
    const allowedEditRoot = path.resolve(this.config.allowedEditRoot ?? DEFAULT_ALLOWED_EDIT_ROOT);
    const workerIdentity = createWorkerIdentity(this.config.identity, workerId, task.agentRole);
    const context: HarnessContext = {
      workspaceRoot: workspace.basePath,
      allowedEditRoot,
      workspace,
      identity: workerIdentity,
      config: this.config.config,
      db: this.config.db,
      conway: this.config.conway,
      inference: {
        chat: async (params) => this.config.inference.chat(params),
      },
      budget: createBudgetFromTask(task),
      wisdom: buildWisdomFromGoal(this.config.db, task.goalId, workspace),
      abortSignal: signal,
      onProgress: (stage, message) => this.recordProgress(workerId, stage, message),
      goalId: task.goalId,
      toolCatalog: this.config.tools,
      toolContext: this.config.toolContext
        ? {
            ...this.config.toolContext,
            identity: workerIdentity,
          }
        : undefined,
      policyEngine: this.config.policyEngine,
      spendTracker: this.config.spendTracker,
      inputSource: this.config.inputSource,
    };

    if (this.config.maxTurns) {
      context.budget.maxTurns = this.config.maxTurns;
    }
    if (harness.id === "orchestrator" && !this.config.maxTurns) {
      context.budget.maxTurns = Math.max(context.budget.maxTurns, 50);
    }

    logger.info(
      `[WORKER ${workerId}] Starting task "${task.title}" (${task.id}), role: ${task.agentRole ?? "generalist"}, harness: ${harness.id}`,
    );

    try {
      this.recordProgress(workerId, "initializing", "Preparing the task harness and bounded workspace.");
      await harness.initialize(task, context);
      this.recordProgress(workerId, "executing", "Executing the assigned task with the configured local inference budget.");
      const result = await harness.execute();

      if (result.success) {
        completeTask(this.config.db, task.id, result);
        this.finishWorker(workerId, "completed", "result", result.output, result);
        logger.info("Local worker completed task", {
          workerId,
          taskId: task.id,
          title: task.title,
          duration: result.duration,
          harness: harness.id,
        });
      } else {
        failTask(this.config.db, task.id, result.output || "Task reported failure", true);
        this.finishWorker(workerId, "failed", "failed", result.output || "Task reported failure", result);
        logger.warn("Local worker reported task failure", {
          workerId,
          taskId: task.id,
          title: task.title,
          harness: harness.id,
          output: result.output.slice(0, 200),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[WORKER ${workerId}] Harness execution failed: ${message}`);
      failTask(this.config.db, task.id, message, true);
      this.finishWorker(workerId, signal.aborted ? "cancelled" : "failed", signal.aborted ? "cancelled" : "failed", message);
    }
  }

  private registerWorker(workerId: string, task: TaskNode, name: string, address: string): void {
    const now = new Date().toISOString();
    const parentAddress = task.parentId
      ? (this.config.db.prepare("SELECT assigned_to FROM task_graph WHERE id = ?").get(task.parentId) as { assigned_to?: string | null } | undefined)?.assigned_to
      : null;
    const parentWorkerId = typeof parentAddress === "string" && parentAddress.startsWith("local://")
      ? parentAddress.slice("local://".length)
      : null;
    this.config.db.prepare(
      `INSERT OR IGNORE INTO local_worker_runs
       (id, task_id, parent_worker_id, name, address, role, status, progress_stage, progress_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 'assigned', 'Task assigned; waiting for a local worker slot.', ?, ?)`,
    ).run(workerId, task.id, parentWorkerId, name, address, task.agentRole ?? "generalist", now, now);
    const exists = this.config.db.prepare(
      "SELECT 1 AS present FROM local_worker_events WHERE worker_id = ? LIMIT 1",
    ).get(workerId);
    if (!exists) this.appendWorkerEvent(workerId, "assigned", `Assigned: ${task.title}`, { taskId: task.id, role: task.agentRole });
  }

  private recoverInterruptedRuns(): void {
    const stale = this.config.db.prepare(
      "SELECT id FROM local_worker_runs WHERE status IN ('queued','running','stopping')",
    ).all() as Array<{ id: string }>;
    const recover = this.config.db.transaction(() => {
      const now = new Date().toISOString();
      for (const { id } of stale) {
        this.config.db.prepare(
          `UPDATE local_worker_runs SET status = 'interrupted', progress_stage = 'interrupted',
           progress_message = 'Process restarted before the worker reported completion.', error = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
        ).run("Process restarted before worker completion.", now, now, id);
        this.appendWorkerEvent(id, "interrupted", "Worker execution was interrupted by process restart.");
      }
    });
    recover();
  }

  private recordProgress(workerId: string, stage: string, message: string): void {
    this.config.db.prepare(
      "UPDATE local_worker_runs SET progress_stage = ?, progress_message = ?, updated_at = ? WHERE id = ?",
    ).run(stage, message.slice(0, 1000), new Date().toISOString(), workerId);
    this.appendWorkerEvent(workerId, "progress", message, { stage });
  }

  private setWorkerState(workerId: string, status: "running" | "stopping", event: "started" | "cancel_requested", message: string): void {
    const now = new Date().toISOString();
    this.config.db.prepare(
      "UPDATE local_worker_runs SET status = ?, progress_stage = ?, progress_message = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?",
    ).run(status, event === "started" ? "starting" : "cancelling", message, now, now, workerId);
    this.appendWorkerEvent(workerId, event, message);
  }

  private finishWorker(workerId: string, status: "completed" | "failed" | "cancelled", event: "result" | "failed" | "cancelled", message: string, result?: unknown): void {
    const now = new Date().toISOString();
    this.config.db.prepare(
      "UPDATE local_worker_runs SET status = ?, progress_stage = ?, progress_message = ?, result_json = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?",
    ).run(status, status, message.slice(0, 1000), result ? JSON.stringify(result).slice(0, 100_000) : null, status === "failed" || status === "cancelled" ? message.slice(0, 1000) : null, now, now, workerId);
    this.appendWorkerEvent(workerId, event, message, result ? { result } : {});
  }

  private appendWorkerEvent(workerId: string, event: string, message: string, details: Record<string, unknown> = {}): void {
    this.config.db.prepare(
      "INSERT INTO local_worker_events (id, worker_id, event_type, message, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(ulid(), workerId, event, message.slice(0, 1000), JSON.stringify(details).slice(0, 100_000), new Date().toISOString());
    this.config.db.prepare(
      `DELETE FROM local_worker_events WHERE worker_id = ? AND id NOT IN
       (SELECT id FROM local_worker_events WHERE worker_id = ? ORDER BY created_at DESC, id DESC LIMIT 100)`,
    ).run(workerId, workerId);
  }
}

function createWorkerIdentity(
  parentIdentity: AutomatonIdentity,
  workerId: string,
  role: string | null,
): AutomatonIdentity {
  return {
    ...parentIdentity,
    name: `worker-${role ?? "generalist"}-${workerId.slice(-6)}`,
    address: `local://${workerId}`,
    sandboxId: workerId,
  };
}
