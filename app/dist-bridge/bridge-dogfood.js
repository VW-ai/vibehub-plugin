const record = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value) => typeof value === "string";
const nonEmpty = (value) => string(value) && value.trim().length > 0;
const finiteNumber = (value) => typeof value === "number" && Number.isFinite(value);
const integer = (value) => Number.isInteger(value);
const stringArray = (value) => Array.isArray(value) && value.every(string);
const optional = (value, guard) => value === void 0 || guard(value);
const oneOf = (value, values) => string(value) && values.includes(value);
const TASK_STATES = ["queued", "running", "waiting", "stalled", "done"];
function isRepoRef(value) {
  return record(value) && nonEmpty(value.repoKey) && nonEmpty(value.repoRoot) && value.repoRoot.startsWith("/");
}
function isTaskPanelRequest(value) {
  return record(value) && isRepoRef(value) && nonEmpty(value.taskId);
}
function isConflictDetailRequest(value) {
  return record(value) && isRepoRef(value) && nonEmpty(value.conflictId);
}
function isIntervention(value) {
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
function isApplyInterventionRequest(value) {
  return record(value) && isRepoRef(value) && nonEmpty(value.requestId) && isIntervention(value.intervention);
}
function isScope(value) {
  return record(value) && oneOf(value.mode, ["write", "read"]) && string(value.territoryId) && optional(value.subBlockId, string) && string(value.label) && optional(value.filesTouched, finiteNumber);
}
function isTaskGit(value) {
  return record(value) && string(value.branch) && optional(value.worktreePath, string) && optional(value.prNumber, finiteNumber) && optional(value.prState, (item) => oneOf(item, ["open", "merged", "closed"]));
}
function isTask(value) {
  return record(value) && string(value.id) && string(value.title) && oneOf(value.state, TASK_STATES) && oneOf(value.signalTier, ["hooks", "basic"]) && stringArray(value.conflictIds) && Array.isArray(value.scopes) && value.scopes.every(isScope) && isTaskGit(value.git) && string(value.stateSince) && string(value.lastEventAt) && optional(value.statusDetail, string);
}
function isConflict(value) {
  return record(value) && string(value.id) && Array.isArray(value.taskIds) && value.taskIds.length === 2 && value.taskIds.every(string) && string(value.territoryId) && optional(value.subBlockId, string) && stringArray(value.sharedSymbols) && oneOf(value.severity, ["red", "yellow"]) && string(value.detectedAt);
}
function isTerritory(value) {
  if (!record(value) || !string(value.id) || !string(value.name) || !finiteNumber(value.anchoredFileCount) || !Array.isArray(value.subBlocks) || !value.subBlocks.every((subBlock) => record(subBlock) && string(subBlock.id) && string(subBlock.name) && finiteNumber(subBlock.anchoredFileCount))) return false;
  if (!optional(value.layout, (layout) => record(layout) && finiteNumber(layout.left) && finiteNumber(layout.top) && finiteNumber(layout.width) && finiteNumber(layout.height))) return false;
  return optional(value.subBlockLayout, (layout) => record(layout) && Object.values(layout).every((offset) => record(offset) && optional(offset.left, finiteNumber) && optional(offset.top, finiteNumber) && optional(offset.right, finiteNumber) && optional(offset.bottom, finiteNumber)));
}
function isOccupancy(value) {
  return record(value) && string(value.territoryId) && stringArray(value.writingTaskIds) && stringArray(value.readingTaskIds) && stringArray(value.doneTodayTaskIds);
}
function isMapSnapshot(value) {
  return record(value) && string(value.capturedAt) && record(value.repo) && string(value.repo.slug) && string(value.repo.defaultBranch) && finiteNumber(value.repo.branchCount) && record(value.sync) && (value.sync.lastFetchAt === null || string(value.sync.lastFetchAt)) && (value.sync.lastHookEventAt === null || string(value.sync.lastHookEventAt)) && typeof value.sync.stale === "boolean" && Array.isArray(value.tasks) && value.tasks.every(isTask) && Array.isArray(value.territories) && value.territories.every(isTerritory) && Array.isArray(value.occupancy) && value.occupancy.every(isOccupancy) && Array.isArray(value.conflicts) && value.conflicts.every(isConflict);
}
function isTimelineEvent(value) {
  if (!record(value) || !string(value.id) || !string(value.at) || !string(value.type)) return false;
  switch (value.type) {
    case "launch":
      return string(value.prompt) && optional(value.promptId, string);
    case "self_report":
      return string(value.text) && optional(value.kicker, string) && optional(value.footprintCorroboration, (proof) => record(proof) && stringArray(proof.offScopeFiles));
    case "file_change":
      return Array.isArray(value.files) && value.files.every((file) => record(file) && string(file.path) && typeof file.offScope === "boolean");
    case "file_read":
      return finiteNumber(value.count) && string(value.territoryName) && typeof value.inDeclaredScope === "boolean";
    case "test_run":
      return finiteNumber(value.passed) && finiteNumber(value.failed) && optional(value.note, string);
    case "user_injection":
      return oneOf(value.mode, ["inject", "pause"]) && string(value.text) && optional(value.promptId, string) && optional(value.classification, (item) => oneOf(item, ["milestone", "default"]));
    case "user_intervention":
      return oneOf(value.action, ["inject", "pause", "ignore"]) && string(value.text) && string(value.requestId);
    case "agent_ack":
      return string(value.text) && string(value.ackOfEventId) && optional(value.kicker, string);
    case "question":
      return string(value.text) && value.transitionTo === "waiting";
    case "cross_read_notice":
      return string(value.file) && string(value.otherTaskId) && string(value.otherTaskTitle);
    case "commit":
      return string(value.sha) && string(value.message) && optional(value.filesChanged, finiteNumber);
    case "state_transition":
      return oneOf(value.from, TASK_STATES) && oneOf(value.to, TASK_STATES) && optional(value.cause, string);
    default:
      return false;
  }
}
function isTaskPanelSnapshot(value) {
  return record(value) && string(value.capturedAt) && isTask(value.task) && optional(value.session, (session) => record(session) && string(session.agent) && finiteNumber(session.sessionOrdinal) && finiteNumber(session.sessionCount) && optional(session.previousEndedAt, string) && optional(session.previousEndReason, (item) => oneOf(item, ["context_limit", "user_ended", "completed"]))) && optional(value.twist, (twist) => record(twist) && stringArray(twist.offScopeFiles) && optional(twist.acknowledgedByEventId, string)) && Array.isArray(value.timeline) && value.timeline.every(isTimelineEvent) && stringArray(value.transcriptTail);
}
function isDiagnosis(value) {
  return record(value) && string(value.verdict) && string(value.suggested) && Array.isArray(value.sides) && value.sides.length === 2 && value.sides.every((side) => record(side) && string(side.taskId) && string(side.label) && string(side.doing)) && record(value.provenance) && string(value.provenance.diagnosedAt) && value.provenance.engine === "claude-p-local" && finiteNumber(value.stalenessEditsSince);
}
function isConflictCardSnapshot(value) {
  return record(value) && string(value.capturedAt) && isConflict(value.conflict) && Array.isArray(value.tasks) && value.tasks.length === 2 && value.tasks.every(isTask) && record(value.crumb) && string(value.crumb.resourceName) && string(value.crumb.territoryName) && optional(value.crumb.subBlockName, string) && string(value.crumb.anchorFile) && Array.isArray(value.symbols) && value.symbols.every((symbol) => record(symbol) && string(symbol.name) && string(symbol.file) && Array.isArray(symbol.touches) && symbol.touches.length === 2 && symbol.touches.every((touch) => record(touch) && string(touch.taskId) && oneOf(touch.action, ["edit", "read"]) && string(touch.at))) && optional(value.diagnosis, isDiagnosis);
}
const OUTCOMES = ["applied", "already_applied", "no_op", "stale", "unsupported"];
function isAppliedIntervention(value) {
  return record(value) && nonEmpty(value.requestId) && nonEmpty(value.acceptedAt) && oneOf(value.outcome, OUTCOMES) && Array.isArray(value.injectionIds) && value.injectionIds.every(integer) && stringArray(value.affectedTaskIds) && optional(value.message, string);
}
const ERROR_STATUSES = [
  "db_missing",
  "repo_uninitialized",
  "unsynced",
  "not_found",
  "evidence_unavailable",
  "bridge_unavailable",
  "internal_error"
];
const WARNING_CODES = ["git_unavailable", "transcript_unavailable"];
function isBridgeResult(value, dataGuard) {
  if (!record(value) || !nonEmpty(value.status)) return false;
  if (value.status === "ok") {
    return dataGuard(value.data) && optional(value.warnings, (warnings) => Array.isArray(warnings) && warnings.every((warning) => record(warning) && oneOf(warning.code, WARNING_CODES) && nonEmpty(warning.message)));
  }
  return oneOf(value.status, ERROR_STATUSES) && nonEmpty(value.message);
}
function dispatchWorkbenchEnvelope(envelope, configuredRepo, service) {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("malformed bridge envelope");
  }
  const { method, request } = envelope;
  const validRequest = method === "getSnapshot" ? isRepoRef(request) : method === "getTaskPanel" ? isTaskPanelRequest(request) : method === "getConflictDetail" ? isConflictDetailRequest(request) : method === "applyIntervention" ? isApplyInterventionRequest(request) : false;
  if (!validRequest || !isRepoRef(request)) throw new Error("invalid method-specific bridge request");
  if (request.repoRoot !== configuredRepo.repoRoot || request.repoKey !== configuredRepo.repoKey) {
    throw new Error("bridge repository mismatch");
  }
  let result;
  let guard;
  switch (method) {
    case "getSnapshot":
      result = service.readWorkbenchSnapshot(configuredRepo);
      guard = isMapSnapshot;
      break;
    case "getTaskPanel":
      result = service.readTaskPanel(configuredRepo, request.taskId);
      guard = isTaskPanelSnapshot;
      break;
    case "getConflictDetail":
      result = service.readConflictDetail(configuredRepo, request.conflictId);
      guard = isConflictCardSnapshot;
      break;
    case "applyIntervention": {
      const input = request;
      result = service.applyIntervention(configuredRepo, input.requestId, input.intervention);
      guard = isAppliedIntervention;
      break;
    }
    default:
      throw new Error("unknown bridge method");
  }
  if (!isBridgeResult(result, guard)) throw new Error("core returned a malformed method-specific bridge response");
  return result;
}
async function call(endpoint, method, request, requestGuard, dataGuard, fetchImpl) {
  if (!requestGuard(request)) {
    return { status: "bridge_unavailable", message: `Refused malformed ${method} request.` };
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, request })
    });
    if (!response.ok) {
      return {
        status: "bridge_unavailable",
        message: `Workbench host returned HTTP ${response.status}.`
      };
    }
    const value = await response.json();
    if (!isBridgeResult(value, dataGuard)) {
      return { status: "bridge_unavailable", message: `Workbench host returned a malformed ${method} result.` };
    }
    return value;
  } catch {
    return {
      status: "bridge_unavailable",
      message: "The configured workbench host is unavailable."
    };
  }
}
function bridgeFromHost(host, fetchImpl = globalThis.fetch) {
  if (!host || !nonEmptyEndpoint(host.endpoint) || !isRepoRef(host.repo)) return null;
  const bridge = {
    getSnapshot: (repo) => call(host.endpoint, "getSnapshot", repo, isRepoRef, isMapSnapshot, fetchImpl),
    getTaskPanel: (request) => call(host.endpoint, "getTaskPanel", request, isTaskPanelRequest, isTaskPanelSnapshot, fetchImpl),
    getConflictDetail: (request) => call(host.endpoint, "getConflictDetail", request, isConflictDetailRequest, isConflictCardSnapshot, fetchImpl),
    applyIntervention: (request) => call(host.endpoint, "applyIntervention", request, isApplyInterventionRequest, isAppliedIntervention, fetchImpl)
  };
  return { bridge, repo: host.repo };
}
function createWorkbenchBridge(host, fetchImpl = globalThis.fetch) {
  const connected = bridgeFromHost(host, fetchImpl);
  if (!connected) throw new Error("invalid workbench host configuration");
  return connected.bridge;
}
const nonEmptyEndpoint = (value) => typeof value === "string" && value.trim().length > 0;
export {
  createWorkbenchBridge,
  dispatchWorkbenchEnvelope
};
