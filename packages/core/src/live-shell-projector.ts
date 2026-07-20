import type {
  LiveShellContextFeedbackEntry,
  LiveShellProjectorInput,
  LiveShellRecoveryAction,
  LiveShellSnapshotV1,
  LiveShellSourceIssue,
  LiveShellSourceSection,
  LiveShellSection,
  Task,
  WorkflowReceiptV1,
} from "./contract/index.js";

const MAX_CONTEXT_FEEDBACK_ENTRIES = 100;
const DURABLE_CONTEXT_OPERATIONS = new Set([
  "kb.draft.apply",
  "kb.promote",
  "kb.mark-stale",
  "kb.deprecate",
  "kb.amend",
  "kb.supersede",
]);

/**
 * Exact checkout ownership wins, including basic-tier tasks. Without that
 * evidence, the freshest hooks-tier task is the only honest fallback.
 */
export function selectLiveShellCurrentTask(
  tasks: readonly Task[],
  checkoutRoot: string,
): Task | null {
  const newest = (items: readonly Task[]): Task | null =>
    [...items].sort((a, b) =>
      b.lastEventAt.localeCompare(a.lastEventAt) || a.id.localeCompare(b.id),
    )[0] ?? null;
  return newest(tasks.filter((task) => task.git.worktreePath === checkoutRoot))
    ?? newest(tasks.filter((task) => task.signalTier === "hooks"));
}

export function projectLiveShellSnapshot(
  input: LiveShellProjectorInput,
): LiveShellSnapshotV1 {
  const workspace = section(input.workspace);
  const feedback = workspace.data
    ? workspace.data.receipts
        .slice(-MAX_CONTEXT_FEEDBACK_ENTRIES)
        .map(projectContextFeedbackEntry)
    : null;
  return {
    schemaVersion: 1,
    capturedAt: input.capturedAt,
    identity: section(input.identity),
    activation: section(input.activation),
    workspace,
    contextFeedback: {
      availability: feedback === null
        ? "unavailable"
        : workspace.availability,
      freshness: workspace.freshness,
      data: feedback,
      recovery: workspace.recovery,
    },
  };
}

export function projectContextFeedbackEntry(
  receipt: WorkflowReceiptV1,
): LiveShellContextFeedbackEntry {
  const operation = receipt.evidence.find(
    (evidence) => evidence.source === "operation_result",
  );
  const kind = receipt.activity === "review"
    ? "explicit_proposal"
    : receipt.outcome === "persisted"
        && operation?.source === "operation_result"
        && DURABLE_CONTEXT_OPERATIONS.has(operation.operation)
      ? "durable_mutation"
      : operation?.effect === "read"
        ? "retrieval"
        : "operational_capture";
  return { kind, receipt };
}

function section<T>(source: LiveShellSourceSection<T>): LiveShellSection<T> {
  return {
    availability: source.data === null
      ? "unavailable"
      : source.issue ? "partial" : "available",
    freshness: source.freshness,
    data: source.data,
    recovery: source.issue ? [recoveryFor(source.issue)] : [],
  };
}

function recoveryFor(issue: LiveShellSourceIssue): LiveShellRecoveryAction {
  const code = issue.code === "database_missing" || issue.code === "repository_uninitialized"
    ? "initialize_runtime"
    : issue.code === "repository_unsynced"
      ? "sync_repository"
      : issue.code === "activation_not_configured"
        ? "configure_activation"
        : issue.code === "activation_evidence_partial"
          ? "inspect_activation"
          : issue.code === "task_not_observed"
            ? "start_or_select_task"
            : issue.code === "receipt_source_incomplete"
              ? "inspect_receipt_coverage"
            : "retry_read";
  return { code, instruction: issue.instruction };
}
