import type { LiveShellContextFeedbackEntry, LiveShellSnapshotV1, WorkflowReceiptV1 } from "@vibehub/core/contracts";
import { v8Baseline } from "./v8-baseline";

const at = "2026-07-19T18:00:00.000Z";
const operationReceipt = (activity: "query" | "review" | "update", operation: "kb.status" | "kb.review" | "kb.promote", effect: "read" | "write", outcome: "returned" | "persisted", requestId: string): WorkflowReceiptV1 => ({
  schemaVersion: 1, activity, phase: "complete", outcome, visibility: "brief", trigger: "production fixture",
  evidence: [{ source: "operation_result", effect, outcome, subject: `${operation} request ${requestId}`, operation, repoId: 1, requestId, ok: true }],
  nextAction: null, at,
});
const doctor: WorkflowReceiptV1 = {
  schemaVersion: 1, activity: "setup", phase: "complete", outcome: "verified", visibility: "brief", trigger: "doctor",
  evidence: [{ source: "doctor_runtime_result", effect: "health_check", outcome: "verified", subject: "local runtime", computedHealthy: true, dbStatus: "healthy", nativeStatus: "healthy", repoStatus: "healthy", managedAssetsStatus: "healthy" }],
  nextAction: null, at,
};
const entries: LiveShellContextFeedbackEntry[] = [
  { kind: "retrieval", receipt: operationReceipt("query", "kb.status", "read", "returned", "read-1") },
  { kind: "operational_capture", receipt: doctor },
  { kind: "explicit_proposal", receipt: operationReceipt("review", "kb.review", "read", "returned", "review-1") },
  { kind: "durable_mutation", receipt: operationReceipt("update", "kb.promote", "write", "persisted", "write-1") },
];
const available = <T,>(data: T) => ({ availability: "available" as const, freshness: "live" as const, data, recovery: [] });
const coverage = available({ detail: "Receipt source observed." });

export const liveShellBaseline: LiveShellSnapshotV1 = {
  schemaVersion: 1,
  capturedAt: at,
  identity: available({ repoKey: "production-e2e", repoRoot: "/tmp/production-e2e", checkoutRoot: "/tmp/production-e2e/worktrees/live-shell", host: "codex" }),
  activation: available({
    installed: { state: "proven", evidence: ["managed assets present"] },
    connected: { state: "proven", evidence: ["native bridge response"] },
    activated: { state: "not_proven", evidence: ["no activation receipt"] },
  }),
  workspace: available({
    authorityModel: "beta_compatibility", map: v8Baseline, currentTask: v8Baseline.tasks[0] ?? null,
    currentSession: null,
    declaredScope: [
      { mode: "write", glob: "app/src/**", label: "Workbench UI" },
      { mode: "read", glob: "packages/core/src/contract/**", label: null },
    ],
    observedFootprint: [], timeline: [],
    receipts: entries.map((entry) => entry.receipt),
    receiptCoverage: { operation_request: coverage, intervention_queue: coverage, injection_claim: coverage, checkpoint: coverage },
  }),
  contextFeedback: available(entries),
};

export const unavailableLiveShell: LiveShellSnapshotV1 = {
  ...liveShellBaseline,
  workspace: { availability: "unavailable", freshness: "unknown", data: null, recovery: [{ code: "initialize_runtime", instruction: "Initialize this repository before reading workspace evidence." }] },
};

export const mappedPartialLiveShell: LiveShellSnapshotV1 = {
  ...liveShellBaseline,
  workspace: {
    availability: "partial",
    freshness: "stale",
    data: {
      ...liveShellBaseline.workspace.data!,
      currentTask: liveShellBaseline.workspace.data!.map!.tasks[0]!,
      currentSession: {
        id: "session-live-17",
        startedAt: "2026-07-19T17:30:00.000Z",
        endedAt: null,
        lifecycle: "active",
        endReason: null,
        identity: { agent: "codex", sessionOrdinal: 2, sessionCount: 3 },
      },
      observedFootprint: [
        { path: "app/src/main.tsx", access: "read", observedAt: at },
        { path: "app/src/WorkbenchMap.tsx", access: "write", observedAt: at },
        { path: "app/src/app.css", access: "write", observedAt: at },
      ],
      timeline: [{ id: "launch-live", at, type: "launch", prompt: "Implement Live Shell" }],
      receiptCoverage: {
        ...liveShellBaseline.workspace.data!.receiptCoverage,
        checkpoint: { availability: "partial", freshness: "stale", data: { detail: "Checkpoint attempts observed without completion proof." }, recovery: [{ code: "inspect_receipt_coverage", instruction: "Inspect checkpoint receipt coverage." }] },
      },
    },
    recovery: [{ code: "sync_repository", instruction: "Sync repository evidence before relying on this workspace view." }],
  },
};

export const identityRecoveryLiveShell: LiveShellSnapshotV1 = {
  ...liveShellBaseline,
  identity: {
    ...liveShellBaseline.identity,
    availability: "partial",
    freshness: "stale",
    recovery: [{ code: "retry_read", instruction: "Retry the identity read from the native host." }],
  },
};
