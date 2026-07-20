import { describe, expect, it } from "vitest";
import {
  isAppliedIntervention,
  isApplyInterventionRequest,
  isBridgeResult,
  isConflictCardSnapshot,
  isConflictDetailRequest,
  isIntervention,
  isMapSnapshot,
  isLiveShellRepoRef,
  isLiveShellSnapshot,
  isRepoRef,
  isTaskPanelSnapshot,
  isTaskPanelRequest,
} from "../../src/bridge-validation";
import { liveShellBaseline } from "../fixtures";

const repo = { repoKey: "repo", repoRoot: "/repo" };
const task = {
  id: "task", title: "Task", state: "running", signalTier: "hooks",
  conflictIds: [], scopes: [], git: { branch: "feature/task" },
  stateSince: "2026-07-12T00:00:00.000Z", lastEventAt: "2026-07-12T00:00:00.000Z",
};
const mapSnapshot = {
  capturedAt: "2026-07-12T00:00:00.000Z",
  repo: { slug: "owner/repo", defaultBranch: "main", branchCount: 1 },
  sync: { lastFetchAt: null, lastHookEventAt: null, stale: false },
  tasks: [task], territories: [], occupancy: [], conflicts: [],
};
const panelSnapshot = {
  capturedAt: "2026-07-12T00:00:00.000Z", task,
  timeline: [{ id: "event", at: "2026-07-12T00:00:00.000Z", type: "launch", prompt: "go" }],
  transcriptTail: [],
};
const conflictSnapshot = {
  capturedAt: "2026-07-12T00:00:00.000Z",
  conflict: {
    id: "conflict", taskIds: ["task", "other"], territoryId: "core",
    sharedSymbols: ["run"], severity: "red", detectedAt: "2026-07-12T00:00:00.000Z",
  },
  tasks: [task, { ...task, id: "other", git: { branch: "feature/other" } }],
  crumb: { resourceName: "Core", territoryName: "Core", anchorFile: "src/core.ts" },
  symbols: [{
    name: "run", file: "src/core.ts", touches: [
      { taskId: "task", action: "edit", at: "2026-07-12T00:00:00.000Z" },
      { taskId: "other", action: "edit", at: "2026-07-12T00:00:00.000Z" },
    ],
  }],
};

describe("bridge runtime validation", () => {
  it("validates repo refs and method-specific ids", () => {
    expect(isRepoRef(repo)).toBe(true);
    expect(isRepoRef({ repoKey: "", repoRoot: "relative" })).toBe(false);
    expect(isLiveShellRepoRef({ ...repo, checkoutRoot: "/repo/worktrees/live", host: "codex" })).toBe(true);
    expect(isLiveShellRepoRef({ ...repo, checkoutRoot: "relative", host: "" })).toBe(false);
    expect(isTaskPanelRequest({ ...repo, taskId: "task" })).toBe(true);
    expect(isTaskPanelRequest({ ...repo, taskId: "" })).toBe(false);
    expect(isConflictDetailRequest({ ...repo, conflictId: "conflict" })).toBe(true);
    expect(isConflictDetailRequest({ ...repo })).toBe(false);
  });

  it("strictly validates live shell sections, receipts, and exact checkout identity", () => {
    expect(isLiveShellSnapshot(liveShellBaseline)).toBe(true);
    expect(isLiveShellSnapshot({ ...liveShellBaseline, synthetic: true })).toBe(false);
    expect(isLiveShellSnapshot({
      ...liveShellBaseline,
      identity: { ...liveShellBaseline.identity, data: { ...liveShellBaseline.identity.data!, checkoutRoot: "relative" } },
    })).toBe(false);
    expect(isLiveShellSnapshot({
      ...liveShellBaseline,
      identity: { ...liveShellBaseline.identity, data: { ...liveShellBaseline.identity.data!, unexpected: "field" } },
    })).toBe(false);
    expect(isLiveShellSnapshot({
      ...liveShellBaseline,
      contextFeedback: { ...liveShellBaseline.contextFeedback, data: [{ ...liveShellBaseline.contextFeedback.data![0], kind: "invented" }] },
    })).toBe(false);
    expect(isLiveShellSnapshot({
      ...liveShellBaseline,
      workspace: {
        ...liveShellBaseline.workspace,
        data: { ...liveShellBaseline.workspace.data!, declaredScope: [{ mode: "write", territoryId: "app", label: "legacy DTO" }] },
      },
    })).toBe(false);
  });

  it("validates every intervention discriminant and required field", () => {
    expect(isIntervention({ kind: "inject", taskId: "task", text: "note" })).toBe(true);
    expect(isIntervention({ kind: "pause", taskId: "task", text: "wait" })).toBe(true);
    expect(isIntervention({ kind: "inject_both", conflictId: "c", text: "note" })).toBe(true);
    expect(isIntervention({ kind: "ignore_pair", conflictId: "c" })).toBe(true);
    expect(isIntervention({ kind: "generate_diagnosis", conflictId: "c" })).toBe(true);
    expect(isIntervention({ kind: "inject", taskId: "task", text: "" })).toBe(false);
    expect(isIntervention({ kind: "unknown", taskId: "task", text: "note" })).toBe(false);
    expect(isApplyInterventionRequest({ ...repo, requestId: "request", intervention: { kind: "ignore_pair", conflictId: "c" } })).toBe(true);
    expect(isApplyInterventionRequest({ ...repo, requestId: "", intervention: { kind: "ignore_pair", conflictId: "c" } })).toBe(false);
  });

  it("rejects unchecked success/error envelopes", () => {
    const receipt = {
      requestId: "request", outcome: "applied", injectionIds: [1],
      affectedTaskIds: ["task"], acceptedAt: "2026-07-12T00:00:00.000Z",
    };
    expect(isAppliedIntervention(receipt)).toBe(true);
    expect(isAppliedIntervention({ ...receipt, replayed: true })).toBe(true);
    expect(isAppliedIntervention({ ...receipt, replayed: "yes" })).toBe(false);
    expect(isAppliedIntervention({ ...receipt, outcome: "invented" })).toBe(false);
    expect(isBridgeResult({ status: "ok", data: receipt }, isAppliedIntervention)).toBe(true);
    expect(isBridgeResult({ status: "ok", data: {} }, isAppliedIntervention)).toBe(false);
    expect(isBridgeResult({ status: "internal_error", message: "bad" }, isMapSnapshot)).toBe(true);
    expect(isBridgeResult({ status: "idempotency_conflict", message: "request reused" }, isMapSnapshot)).toBe(true);
    expect(isBridgeResult({ status: "internal_error" }, isMapSnapshot)).toBe(false);
  });

  it("rejects malformed nested success payloads and unknown warning codes", () => {
    expect(isMapSnapshot(mapSnapshot)).toBe(true);
    expect(isMapSnapshot({ ...mapSnapshot, tasks: [null] })).toBe(false);

    expect(isTaskPanelSnapshot(panelSnapshot)).toBe(true);
    expect(isTaskPanelSnapshot({
      ...panelSnapshot,
      timeline: [{ id: "event", at: panelSnapshot.capturedAt, type: "invented" }],
    })).toBe(false);
    expect(isTaskPanelSnapshot({
      ...panelSnapshot,
      timeline: [{ id: "event", at: panelSnapshot.capturedAt, type: "question", transitionTo: "waiting" }],
    })).toBe(false);

    expect(isConflictCardSnapshot(conflictSnapshot)).toBe(true);
    expect(isConflictCardSnapshot({
      ...conflictSnapshot,
      symbols: [{ ...conflictSnapshot.symbols[0], touches: [null, null] }],
    })).toBe(false);

    expect(isBridgeResult({
      status: "ok",
      data: panelSnapshot,
      warnings: [{ code: "invented", message: "not canonical" }],
    }, isTaskPanelSnapshot)).toBe(false);
  });
});
