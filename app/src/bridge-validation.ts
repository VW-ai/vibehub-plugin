import type {
  AppliedIntervention,
  ConflictCardSnapshot,
  MapSnapshot,
  TaskPanelSnapshot,
  WorkbenchIntervention,
  WorkbenchRepoRef,
} from "@vibehub/core/contracts";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string";
const nonEmpty = (value: unknown): value is string =>
  string(value) && value.trim().length > 0;
const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number => Number.isInteger(value);
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(string);
const optional = (value: unknown, guard: (item: unknown) => boolean): boolean =>
  value === undefined || guard(value);
const oneOf = (value: unknown, values: readonly string[]): value is string =>
  string(value) && values.includes(value);

const TASK_STATES = ["queued", "running", "waiting", "stalled", "done"] as const;

export function isRepoRef(value: unknown): value is WorkbenchRepoRef {
  return record(value) && nonEmpty(value.repoKey) && nonEmpty(value.repoRoot)
    && value.repoRoot.startsWith("/");
}

export function isTaskPanelRequest(value: unknown): boolean {
  return record(value) && isRepoRef(value) && nonEmpty(value.taskId);
}

export function isConflictDetailRequest(value: unknown): boolean {
  return record(value) && isRepoRef(value) && nonEmpty(value.conflictId);
}

export function isIntervention(value: unknown): value is WorkbenchIntervention {
  if (!record(value) || !nonEmpty(value.kind)) return false;
  const locusOk = optional(value.contextLocus, string);
  switch (value.kind) {
    case "inject":
    case "pause":
      return nonEmpty(value.taskId) && nonEmpty(value.text) && locusOk;
    case "inject_both":
      return nonEmpty(value.conflictId) && nonEmpty(value.text) && locusOk;
    case "ignore_pair":
    case "generate_diagnosis":
      return nonEmpty(value.conflictId);
    default:
      return false;
  }
}

export function isApplyInterventionRequest(value: unknown): boolean {
  return record(value) && isRepoRef(value) && nonEmpty(value.requestId)
    && isIntervention(value.intervention);
}

function isScope(value: unknown): boolean {
  return record(value) && oneOf(value.mode, ["write", "read"])
    && string(value.territoryId) && optional(value.subBlockId, string)
    && string(value.label) && optional(value.filesTouched, finiteNumber);
}

function isTaskGit(value: unknown): boolean {
  return record(value) && string(value.branch) && optional(value.worktreePath, string)
    && optional(value.prNumber, finiteNumber)
    && optional(value.prState, (item) => oneOf(item, ["open", "merged", "closed"]));
}

function isTask(value: unknown): boolean {
  return record(value) && string(value.id) && string(value.title)
    && oneOf(value.state, TASK_STATES) && oneOf(value.signalTier, ["hooks", "basic"])
    && stringArray(value.conflictIds) && Array.isArray(value.scopes)
    && value.scopes.every(isScope) && isTaskGit(value.git)
    && string(value.stateSince) && string(value.lastEventAt)
    && optional(value.statusDetail, string);
}

function isConflict(value: unknown): boolean {
  return record(value) && string(value.id) && Array.isArray(value.taskIds)
    && value.taskIds.length === 2 && value.taskIds.every(string)
    && string(value.territoryId) && optional(value.subBlockId, string)
    && stringArray(value.sharedSymbols) && oneOf(value.severity, ["red", "yellow"])
    && string(value.detectedAt);
}

function isTerritory(value: unknown): boolean {
  if (!record(value) || !string(value.id) || !string(value.name)
    || !finiteNumber(value.anchoredFileCount) || !Array.isArray(value.subBlocks)
    || !value.subBlocks.every((subBlock) => record(subBlock) && string(subBlock.id)
      && string(subBlock.name) && finiteNumber(subBlock.anchoredFileCount))) return false;
  if (!optional(value.layout, (layout) => record(layout)
    && finiteNumber(layout.left) && finiteNumber(layout.top)
    && finiteNumber(layout.width) && finiteNumber(layout.height))) return false;
  return optional(value.subBlockLayout, (layout) => record(layout)
    && Object.values(layout).every((offset) => record(offset)
      && optional(offset.left, finiteNumber) && optional(offset.top, finiteNumber)
      && optional(offset.right, finiteNumber) && optional(offset.bottom, finiteNumber)));
}

function isOccupancy(value: unknown): boolean {
  return record(value) && string(value.territoryId)
    && stringArray(value.writingTaskIds) && stringArray(value.readingTaskIds)
    && stringArray(value.doneTodayTaskIds);
}

export function isMapSnapshot(value: unknown): value is MapSnapshot {
  return record(value) && string(value.capturedAt) && record(value.repo)
    && string(value.repo.slug) && string(value.repo.defaultBranch)
    && finiteNumber(value.repo.branchCount) && record(value.sync)
    && (value.sync.lastFetchAt === null || string(value.sync.lastFetchAt))
    && (value.sync.lastHookEventAt === null || string(value.sync.lastHookEventAt))
    && typeof value.sync.stale === "boolean"
    && Array.isArray(value.tasks) && value.tasks.every(isTask)
    && Array.isArray(value.territories) && value.territories.every(isTerritory)
    && Array.isArray(value.occupancy) && value.occupancy.every(isOccupancy)
    && Array.isArray(value.conflicts) && value.conflicts.every(isConflict);
}

function isTimelineEvent(value: unknown): boolean {
  if (!record(value) || !string(value.id) || !string(value.at) || !string(value.type)) return false;
  switch (value.type) {
    case "launch":
      return string(value.prompt) && optional(value.promptId, string);
    case "self_report":
      return string(value.text) && optional(value.kicker, string)
        && optional(value.footprintCorroboration, (proof) =>
          record(proof) && stringArray(proof.offScopeFiles));
    case "file_change":
      return Array.isArray(value.files) && value.files.every((file) =>
        record(file) && string(file.path) && typeof file.offScope === "boolean");
    case "file_read":
      return finiteNumber(value.count) && string(value.territoryName)
        && typeof value.inDeclaredScope === "boolean";
    case "test_run":
      return finiteNumber(value.passed) && finiteNumber(value.failed) && optional(value.note, string);
    case "user_injection":
      return oneOf(value.mode, ["inject", "pause"]) && string(value.text)
        && optional(value.promptId, string)
        && optional(value.classification, (item) => oneOf(item, ["milestone", "default"]));
    case "user_intervention":
      return oneOf(value.action, ["inject", "pause", "ignore"])
        && string(value.text) && string(value.requestId);
    case "agent_ack":
      return string(value.text) && string(value.ackOfEventId) && optional(value.kicker, string);
    case "question":
      return string(value.text) && value.transitionTo === "waiting";
    case "cross_read_notice":
      return string(value.file) && string(value.otherTaskId) && string(value.otherTaskTitle);
    case "commit":
      return string(value.sha) && string(value.message) && optional(value.filesChanged, finiteNumber);
    case "state_transition":
      return oneOf(value.from, TASK_STATES) && oneOf(value.to, TASK_STATES)
        && optional(value.cause, string);
    default:
      return false;
  }
}

export function isTaskPanelSnapshot(value: unknown): value is TaskPanelSnapshot {
  return record(value) && string(value.capturedAt) && isTask(value.task)
    && optional(value.session, (session) => record(session) && string(session.agent)
      && finiteNumber(session.sessionOrdinal) && finiteNumber(session.sessionCount)
      && optional(session.previousEndedAt, string)
      && optional(session.previousEndReason, (item) =>
        oneOf(item, ["context_limit", "user_ended", "completed"])))
    && optional(value.twist, (twist) => record(twist) && stringArray(twist.offScopeFiles)
      && optional(twist.acknowledgedByEventId, string))
    && Array.isArray(value.timeline) && value.timeline.every(isTimelineEvent)
    && stringArray(value.transcriptTail);
}

function isDiagnosis(value: unknown): boolean {
  return record(value) && string(value.verdict) && string(value.suggested)
    && Array.isArray(value.sides) && value.sides.length === 2
    && value.sides.every((side) => record(side) && string(side.taskId)
      && string(side.label) && string(side.doing))
    && record(value.provenance) && string(value.provenance.diagnosedAt)
    && value.provenance.engine === "claude-p-local"
    && finiteNumber(value.stalenessEditsSince);
}

export function isConflictCardSnapshot(value: unknown): value is ConflictCardSnapshot {
  return record(value) && string(value.capturedAt) && isConflict(value.conflict)
    && Array.isArray(value.tasks) && value.tasks.length === 2 && value.tasks.every(isTask)
    && record(value.crumb) && string(value.crumb.resourceName)
    && string(value.crumb.territoryName) && optional(value.crumb.subBlockName, string)
    && string(value.crumb.anchorFile) && Array.isArray(value.symbols)
    && value.symbols.every((symbol) => record(symbol) && string(symbol.name)
      && string(symbol.file) && Array.isArray(symbol.touches) && symbol.touches.length === 2
      && symbol.touches.every((touch) => record(touch) && string(touch.taskId)
        && oneOf(touch.action, ["edit", "read"]) && string(touch.at)))
    && optional(value.diagnosis, isDiagnosis);
}

const OUTCOMES = ["applied", "already_applied", "no_op", "stale", "unsupported"] as const;
export function isAppliedIntervention(value: unknown): value is AppliedIntervention {
  return record(value) && nonEmpty(value.requestId) && nonEmpty(value.acceptedAt)
    && oneOf(value.outcome, OUTCOMES) && Array.isArray(value.injectionIds)
    && value.injectionIds.every(integer) && stringArray(value.affectedTaskIds)
    && optional(value.message, string);
}

const ERROR_STATUSES = [
  "db_missing", "repo_uninitialized", "unsynced", "not_found",
  "evidence_unavailable", "bridge_unavailable", "internal_error",
] as const;
const WARNING_CODES = ["git_unavailable", "transcript_unavailable"] as const;

export function isBridgeResult(value: unknown, dataGuard: (data: unknown) => boolean): boolean {
  if (!record(value) || !nonEmpty(value.status)) return false;
  if (value.status === "ok") {
    return dataGuard(value.data) && optional(value.warnings, (warnings) =>
      Array.isArray(warnings) && warnings.every((warning) => record(warning)
        && oneOf(warning.code, WARNING_CODES) && nonEmpty(warning.message)));
  }
  return oneOf(value.status, ERROR_STATUSES) && nonEmpty(value.message);
}
