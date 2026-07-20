import type { MapSnapshot, Task } from "./map-types.js";
import type { SessionIdentity, TimelineEvent } from "./panel-types.js";
import type { WorkflowReceiptV1 } from "./workflow-receipt.js";
import type { WorkbenchRepoRef } from "./workbench-bridge.js";

export type LiveShellAvailability = "available" | "partial" | "unavailable";
export type LiveShellFreshness = "live" | "stale" | "unknown";

/**
 * Recovery is descriptive wire data, not an executable command. Hosts decide
 * whether and how to offer an action after presenting the instruction.
 */
export type LiveShellRecoveryCode =
  | "initialize_runtime"
  | "sync_repository"
  | "configure_activation"
  | "inspect_activation"
  | "retry_read"
  | "start_or_select_task"
  | "inspect_receipt_coverage";

export interface LiveShellRecoveryAction {
  code: LiveShellRecoveryCode;
  instruction: string;
}

export interface LiveShellSection<T> {
  availability: LiveShellAvailability;
  freshness: LiveShellFreshness;
  data: T | null;
  recovery: LiveShellRecoveryAction[];
}

/** One exact checkout on one host; repoRoot remains the canonical main repo. */
export interface LiveShellRepoRef extends WorkbenchRepoRef {
  checkoutRoot: string;
  host: string;
}

export interface LiveShellIdentityV1 extends LiveShellRepoRef {}

export type LiveShellActivationProofState = "proven" | "not_proven" | "blocked";
export interface LiveShellActivationProof {
  state: LiveShellActivationProofState;
  evidence: string[];
}
export interface LiveShellActivationV1 {
  installed: LiveShellActivationProof;
  connected: LiveShellActivationProof;
  activated: LiveShellActivationProof;
}

/** Browser-safe projection of a raw footprint row; no SQLite DTO leaks. */
export interface LiveShellObservedFootprint {
  path: string;
  access: "read" | "write";
  observedAt: string;
}

/** Canonical raw declaration registered by the host; no territory inference. */
export interface LiveShellDeclaredScope {
  mode: "read" | "write";
  glob: string;
  label: string | null;
}

export interface LiveShellSessionV1 {
  id: string;
  startedAt: string;
  endedAt: string | null;
  lifecycle: "active" | "ended";
  endReason: "context_limit" | "user_ended" | "completed" | null;
  identity: SessionIdentity;
}

export type LiveShellReceiptSource =
  | "operation_request"
  | "intervention_queue"
  | "injection_claim"
  | "checkpoint";

export type LiveShellReceiptCoverage = Record<
  LiveShellReceiptSource,
  LiveShellSection<{ detail: string }>
>;

export interface LiveShellWorkspaceV1 {
  authorityModel: "beta_compatibility";
  /** Existing map authority is embedded rather than reimplemented. */
  map: MapSnapshot | null;
  currentTask: Task | null;
  currentSession: LiveShellSessionV1 | null;
  declaredScope: LiveShellDeclaredScope[];
  observedFootprint: LiveShellObservedFootprint[];
  timeline: TimelineEvent[];
  /** Canonical receipt contract, reused without a shell-specific duplicate. */
  receipts: WorkflowReceiptV1[];
  receiptCoverage: LiveShellReceiptCoverage;
}

export type LiveShellContextFeedbackKind =
  | "retrieval"
  | "operational_capture"
  | "explicit_proposal"
  | "durable_mutation";

export interface LiveShellContextFeedbackEntry {
  kind: LiveShellContextFeedbackKind;
  receipt: WorkflowReceiptV1;
}

export interface LiveShellContextFeedbackV1 {
  entries: LiveShellContextFeedbackEntry[];
}

export interface LiveShellSnapshotV1 {
  schemaVersion: 1;
  capturedAt: string;
  identity: LiveShellSection<LiveShellIdentityV1>;
  activation: LiveShellSection<LiveShellActivationV1>;
  workspace: LiveShellSection<LiveShellWorkspaceV1>;
  contextFeedback: LiveShellSection<LiveShellContextFeedbackEntry[]>;
}

export type LiveShellSourceIssueCode =
  | "database_missing"
  | "repository_uninitialized"
  | "repository_unsynced"
  | "activation_not_configured"
  | "activation_evidence_partial"
  | "task_not_observed"
  | "receipt_source_incomplete"
  | "source_read_failed";

export interface LiveShellSourceIssue {
  code: LiveShellSourceIssueCode;
  instruction: string;
}

/** Storage-neutral source boundary consumed by the pure projector. */
export interface LiveShellSourceSection<T> {
  data: T | null;
  freshness: LiveShellFreshness;
  issue?: LiveShellSourceIssue;
}

export interface LiveShellProjectorInput {
  capturedAt: string;
  identity: LiveShellSourceSection<LiveShellIdentityV1>;
  activation: LiveShellSourceSection<LiveShellActivationV1>;
  workspace: LiveShellSourceSection<LiveShellWorkspaceV1>;
}
