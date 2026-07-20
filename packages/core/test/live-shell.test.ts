import { describe, expect, it } from "vitest";
import type {
  LiveShellProjectorInput,
  Task,
  WorkflowReceiptV1,
} from "../src/contract/index.js";
import {
  projectLiveShellSnapshot,
  projectContextFeedbackEntry,
  selectLiveShellCurrentTask,
} from "../src/live-shell-projector.js";

const task = (
  id: string,
  worktreePath: string | undefined,
  lastEventAt: string,
  signalTier: Task["signalTier"] = "hooks",
): Task => ({
  id,
  title: id,
  state: "running",
  signalTier,
  conflictIds: [],
  scopes: [],
  git: { branch: `branch/${id}`, ...(worktreePath ? { worktreePath } : {}) },
  stateSince: lastEventAt,
  lastEventAt,
});

const receipt = (
  activity: WorkflowReceiptV1["activity"],
  effect: "read" | "write",
  outcome: "returned" | "persisted",
): WorkflowReceiptV1 => ({
  schemaVersion: 1,
  activity,
  phase: "complete",
  outcome,
  visibility: "brief",
  trigger: "test",
  evidence: [{
    source: "operation_result",
    effect,
    outcome,
    subject: activity,
    operation: activity === "review" ? "kb.review" : effect === "read" ? "kb.status" : "kb.promote",
    repoId: 1,
    requestId: `${activity}-${effect}`,
    ok: true,
  }],
  nextAction: null,
  at: "2026-07-19T12:00:00.000Z",
});

const coverage = {
  operation_request: { availability: "available" as const, freshness: "live" as const, data: { detail: "available" }, recovery: [] },
  intervention_queue: { availability: "unavailable" as const, freshness: "unknown" as const, data: null, recovery: [] },
  injection_claim: { availability: "unavailable" as const, freshness: "unknown" as const, data: null, recovery: [] },
  checkpoint: { availability: "unavailable" as const, freshness: "unknown" as const, data: null, recovery: [] },
};

describe("LiveShellSnapshotV1 projector", () => {
  it("selects an exact checkout task before the most recent hooks task", () => {
    const exact = task("exact", "/repo/worktrees/exact", "2026-07-19T10:00:00.000Z", "basic");
    const recent = task("recent", "/other", "2026-07-19T12:00:00.000Z");
    expect(selectLiveShellCurrentTask([recent, exact], "/repo/worktrees/exact")?.id).toBe("exact");
    expect(selectLiveShellCurrentTask([task("basic", "/other", "2026-07-19T13:00:00.000Z", "basic"), recent], "/none")?.id)
      .toBe("recent");
  });

  it("keeps section failures local and classifies receipt truth without changing outcomes", () => {
    const receipts = [
      receipt("query", "read", "returned"),
      receipt("review", "read", "returned"),
      receipt("update", "write", "persisted"),
    ];
    const input: LiveShellProjectorInput = {
      capturedAt: "2026-07-19T12:00:00.000Z",
      identity: {
        data: {
          repoKey: "example",
          repoRoot: "/repo",
          checkoutRoot: "/repo/worktrees/live",
          host: "codex",
        },
        freshness: "live",
      },
      activation: {
        data: null,
        freshness: "unknown",
        issue: {
          code: "activation_not_configured",
          instruction: "Configure activation evidence.",
        },
      },
      workspace: {
        data: {
          authorityModel: "beta_compatibility",
          map: null,
          currentTask: null,
          currentSession: null,
          declaredScope: [],
          observedFootprint: [],
          timeline: [],
          receipts,
          receiptCoverage: coverage,
        },
        freshness: "stale",
        issue: {
          code: "repository_unsynced",
          instruction: "Sync this repository.",
        },
      },
    };

    const snapshot = projectLiveShellSnapshot(input);
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.activation.availability).toBe("unavailable");
    expect(snapshot.workspace.availability).toBe("partial");
    expect(snapshot.workspace.data?.authorityModel).toBe("beta_compatibility");
    expect(snapshot.contextFeedback.data?.map((entry) => [entry.kind, entry.receipt.outcome]))
      .toEqual([
        ["retrieval", "returned"],
        ["explicit_proposal", "returned"],
        ["durable_mutation", "persisted"],
      ]);
    expect(snapshot.contextFeedback.recovery[0]?.code).toBe("sync_repository");
  });

  it("uses an explicit durable operation whitelist and preserves every receipt outcome", () => {
    const distill = receipt("distill", "write", "persisted");
    (distill.evidence[0] as { operation: string }).operation = "distill.activate";
    expect(projectContextFeedbackEntry(distill).kind).toBe("operational_capture");

    const setup = receipt("setup", "write", "persisted");
    (setup.evidence[0] as { operation: string }).operation = "runtime.initialize";
    expect(projectContextFeedbackEntry(setup).kind).toBe("operational_capture");

    for (const outcome of ["queued", "attempted", "claimed", "waiting", "failed", "skipped"] as const) {
      const value = {
        ...receipt("checkpoint", "write", "persisted"),
        outcome,
      } as WorkflowReceiptV1;
      expect(projectContextFeedbackEntry(value).receipt.outcome).toBe(outcome);
    }
  });
});
