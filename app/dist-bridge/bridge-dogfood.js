const WORKFLOW_ACTIVITIES = [
  "setup",
  "query",
  "review",
  "ingest",
  "update",
  "distill",
  "inject",
  "checkpoint"
];
const CANONICAL_OPERATION_PRESENTATION = {
  "kb.status": { activity: "query", effect: "read" },
  "kb.feature.list": { activity: "query", effect: "read" },
  "kb.feature.get": { activity: "query", effect: "read" },
  "kb.feature.suggest": { activity: "query", effect: "read" },
  "kb.spec.search": { activity: "query", effect: "read" },
  "kb.spec.get": { activity: "query", effect: "read" },
  "kb.relations": { activity: "query", effect: "read" },
  "kb.lineage": { activity: "query", effect: "read" },
  "kb.anchors": { activity: "query", effect: "read" },
  "kb.review": { activity: "review", effect: "read" },
  "kb.ingest.preview": { activity: "review", effect: "read" },
  "kb.draft.apply": { activity: "ingest", effect: "write" },
  "kb.promote": { activity: "update", effect: "write" },
  "kb.mark-stale": { activity: "update", effect: "write" },
  "kb.deprecate": { activity: "update", effect: "write" },
  "kb.amend": { activity: "update", effect: "write" },
  "kb.supersede": { activity: "update", effect: "write" },
  "distill.run.start": { activity: "distill", effect: "write" },
  "distill.run.status": { activity: "distill", effect: "read" },
  "distill.run.resume": { activity: "distill", effect: "write" },
  "distill.run.abort": { activity: "distill", effect: "write" },
  "distill.inventory.put": { activity: "distill", effect: "write" },
  "distill.inventory.get": { activity: "distill", effect: "read" },
  "distill.inventory.diff": { activity: "distill", effect: "read" },
  "distill.inventory.seal": { activity: "distill", effect: "write" },
  "distill.scopes.plan": { activity: "distill", effect: "write" },
  "distill.scopes.claim": { activity: "distill", effect: "write" },
  "distill.scopes.complete": { activity: "distill", effect: "write" },
  "distill.scopes.fail": { activity: "distill", effect: "write" },
  "distill.scopes.retry": { activity: "distill", effect: "write" },
  "distill.scopes.correct": { activity: "distill", effect: "write" },
  "distill.candidates.put": { activity: "distill", effect: "write" },
  "distill.candidates.get": { activity: "distill", effect: "read" },
  "distill.candidates.list": { activity: "distill", effect: "read" },
  "distill.baseline.get": { activity: "distill", effect: "read" },
  "distill.version.get": { activity: "distill", effect: "read" },
  "distill.version.diff": { activity: "distill", effect: "read" },
  "distill.reconcile": { activity: "distill", effect: "write" },
  "distill.validate": { activity: "distill", effect: "write" },
  "distill.finalize": { activity: "distill", effect: "write" },
  "distill.activate": { activity: "distill", effect: "write" },
  "distill.rollback": { activity: "distill", effect: "write" }
};
const WORKFLOW_PHASES = ["prepare", "execute", "complete"];
const WORKFLOW_OUTCOMES = [
  "queued",
  "attempted",
  "claimed",
  "persisted",
  "returned",
  "verified",
  "skipped",
  "failed",
  "waiting"
];
const WORKFLOW_VISIBILITIES = ["silent", "brief", "expanded"];
const WORKFLOW_EFFECTS = ["read", "write", "injection", "health_check", "none"];
const MAX_FIELD_CHARS = 2e4;
const MAX_EVIDENCE = 32;
const RECEIPT_KEYS = [
  "schemaVersion",
  "activity",
  "phase",
  "outcome",
  "visibility",
  "trigger",
  "evidence",
  "nextAction",
  "at"
];
function validateWorkflowReceiptStructure(value) {
  const errors = [];
  if (!isRecord(value))
    return { ok: false, errors: ["receipt must be an object"] };
  exactKeys$1(value, RECEIPT_KEYS, "receipt", errors);
  if (value.schemaVersion !== 1)
    errors.push("schemaVersion must be 1");
  enumField(value.activity, WORKFLOW_ACTIVITIES, "activity", errors);
  enumField(value.phase, WORKFLOW_PHASES, "phase", errors);
  enumField(value.outcome, WORKFLOW_OUTCOMES, "outcome", errors);
  enumField(value.visibility, WORKFLOW_VISIBILITIES, "visibility", errors);
  boundedString(value.trigger, "trigger", errors);
  boundedString(value.at, "at", errors);
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  if (!Array.isArray(value.evidence) || evidence.length === 0 || evidence.length > MAX_EVIDENCE) {
    errors.push(`evidence must contain 1-${MAX_EVIDENCE} facts`);
  }
  for (const [index, item] of evidence.entries())
    validateEvidence(item, index, errors);
  if (value.nextAction !== null) {
    if (!isRecord(value.nextAction))
      errors.push("nextAction must be an object or null");
    else {
      exactKeys$1(value.nextAction, ["required", "instruction"], "nextAction", errors);
      if (typeof value.nextAction.required !== "boolean")
        errors.push("nextAction.required must be boolean");
      boundedString(value.nextAction.instruction, "nextAction.instruction", errors);
    }
  }
  if (typeof value.outcome === "string" && typeof value.phase === "string" && !phaseAllowsOutcome(value.phase, value.outcome)) {
    errors.push(`phase ${value.phase} cannot report outcome ${value.outcome}`);
  }
  if ((value.outcome === "failed" || value.outcome === "waiting") && value.visibility === "silent") {
    errors.push(`${value.outcome} cannot be silent`);
  }
  if (value.outcome === "waiting" && (!isRecord(value.nextAction) || value.nextAction.required !== true)) {
    errors.push("waiting requires a required next action");
  }
  const matching = evidence.some((item) => isRecord(item) && item.outcome === value.outcome && sourceProvesOutcome(item));
  if (["persisted", "returned", "verified", "queued", "claimed"].includes(String(value.outcome)) && !matching) {
    errors.push(`${String(value.outcome)} requires matching source-specific evidence`);
  }
  if (typeof value.activity === "string") {
    for (const item of evidence) {
      if (isRecord(item) && typeof item.effect === "string" && !activityAllowsEffect(value.activity, item.effect)) {
        errors.push(`activity ${value.activity} cannot carry effect ${item.effect}`);
      }
      if (isRecord(item) && item.source === "operation_result" && typeof item.operation === "string") {
        const canonical = operationPresentation(item.operation);
        if (canonical && canonical.activity !== value.activity) {
          errors.push(`activity ${value.activity} contradicts operation ${item.operation}`);
        }
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}
function validateEvidence(value, index, errors) {
  const name = `evidence[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${name} must be an object`);
    return;
  }
  boundedString(value.subject, `${name}.subject`, errors);
  if (value.detail !== void 0)
    boundedString(value.detail, `${name}.detail`, errors);
  enumField(value.effect, WORKFLOW_EFFECTS, `${name}.effect`, errors);
  enumField(value.outcome, WORKFLOW_OUTCOMES, `${name}.outcome`, errors);
  if (value.source === "operation_result") {
    exactKeys$1(value, ["source", "effect", "outcome", "subject", "detail", "operation", "repoId", "requestId", "ok", "returnedCount", "totalCount"], name, errors, true);
    boundedString(value.operation, `${name}.operation`, errors);
    positiveInteger(value.repoId, `${name}.repoId`, errors);
    boundedString(value.requestId, `${name}.requestId`, errors);
    if (typeof value.ok !== "boolean")
      errors.push(`${name}.ok must be boolean`);
    if (value.returnedCount !== void 0)
      nonNegativeInteger(value.returnedCount, `${name}.returnedCount`, errors);
    if (value.totalCount !== void 0)
      nonNegativeInteger(value.totalCount, `${name}.totalCount`, errors);
    if (typeof value.returnedCount === "number" && typeof value.totalCount === "number" && value.returnedCount > value.totalCount)
      errors.push(`${name}.returnedCount cannot exceed totalCount`);
    const canonical = typeof value.operation === "string" ? operationPresentation(value.operation) : void 0;
    if (!canonical)
      errors.push(`${name}.operation is not canonical`);
    else if (canonical.effect !== value.effect)
      errors.push(`${name}.effect contradicts canonical operation mapping`);
    if (typeof value.operation === "string" && typeof value.requestId === "string" && value.subject !== `${value.operation} request ${value.requestId}`) {
      errors.push(`${name}.subject must be the deterministic operation/request subject`);
    }
    if (value.ok === true && !["returned", "persisted"].includes(String(value.outcome)))
      errors.push(`${name} successful operation has invalid outcome`);
    if (value.ok === false && value.outcome !== "failed")
      errors.push(`${name} failed operation must report failed`);
    if (value.effect === "read" && value.outcome === "persisted")
      errors.push(`${name} read cannot prove persisted`);
    if (value.effect === "write" && value.outcome === "returned")
      errors.push(`${name} write cannot prove returned`);
  } else if (value.source === "init_runtime_result") {
    exactKeys$1(value, ["source", "effect", "outcome", "subject", "detail", "ok", "repoId", "schemaVersion", "conflictCount"], name, errors, true);
    if (value.effect !== "write")
      errors.push(`${name}.effect must be write`);
    if (typeof value.ok !== "boolean")
      errors.push(`${name}.ok must be boolean`);
    positiveInteger(value.repoId, `${name}.repoId`, errors);
    nonNegativeInteger(value.schemaVersion, `${name}.schemaVersion`, errors);
    nonNegativeInteger(value.conflictCount, `${name}.conflictCount`, errors);
    if (value.ok === true && value.outcome !== "persisted")
      errors.push(`${name} successful init must report persisted`);
    if (value.ok === false && !["waiting", "failed"].includes(String(value.outcome)))
      errors.push(`${name} unsuccessful init cannot prove success`);
    if (typeof value.ok === "boolean" && typeof value.conflictCount === "number" && value.ok !== (value.conflictCount === 0))
      errors.push(`${name}.ok must equal conflictCount === 0`);
  } else if (value.source === "doctor_runtime_result") {
    exactKeys$1(value, ["source", "effect", "outcome", "subject", "detail", "computedHealthy", "dbStatus", "nativeStatus", "repoStatus", "managedAssetsStatus"], name, errors, true);
    if (value.effect !== "health_check")
      errors.push(`${name}.effect must be health_check`);
    if (typeof value.computedHealthy !== "boolean")
      errors.push(`${name}.computedHealthy must be boolean`);
    enumField(value.dbStatus, ["healthy", "missing", "unreadable", "migration_required"], `${name}.dbStatus`, errors);
    enumField(value.nativeStatus, ["healthy", "unavailable"], `${name}.nativeStatus`, errors);
    enumField(value.repoStatus, ["healthy", "uninitialized", "invalid"], `${name}.repoStatus`, errors);
    enumField(value.managedAssetsStatus, ["healthy", "unhealthy"], `${name}.managedAssetsStatus`, errors);
    if (value.computedHealthy === true && value.outcome !== "verified")
      errors.push(`${name} healthy doctor must report verified`);
    if (value.computedHealthy === false && value.outcome !== "failed")
      errors.push(`${name} unhealthy doctor must report failed`);
    const recomputed = value.dbStatus === "healthy" && value.nativeStatus === "healthy" && value.repoStatus === "healthy" && value.managedAssetsStatus === "healthy";
    if (typeof value.computedHealthy === "boolean" && value.computedHealthy !== recomputed) {
      errors.push(`${name}.computedHealthy contradicts component statuses`);
    }
  } else if (value.source === "applied_intervention") {
    exactKeys$1(value, ["source", "effect", "outcome", "subject", "detail", "requestId", "originalKind", "resultOutcome", "replayed", "injectionIds"], name, errors, true);
    if (value.effect !== "injection")
      errors.push(`${name}.effect must be injection`);
    boundedString(value.requestId, `${name}.requestId`, errors);
    enumField(value.originalKind, ["inject", "pause", "inject_both"], `${name}.originalKind`, errors);
    enumField(value.resultOutcome, ["applied", "already_applied", "no_op", "stale", "unsupported"], `${name}.resultOutcome`, errors);
    if (value.replayed !== void 0 && typeof value.replayed !== "boolean")
      errors.push(`${name}.replayed must be boolean`);
    safeIds(value.injectionIds, `${name}.injectionIds`, errors, value.outcome === "queued");
    if (value.outcome === "queued" && !["applied", "already_applied"].includes(String(value.resultOutcome)))
      errors.push(`${name} replay outcome cannot prove queued`);
    if (value.outcome === "queued" && Array.isArray(value.injectionIds)) {
      const expected = value.originalKind === "inject_both" ? 2 : 1;
      if (value.injectionIds.length !== expected)
        errors.push(`${name}.injectionIds cardinality must be ${expected} for ${String(value.originalKind)}`);
    }
  } else if (value.source === "hook_evidence") {
    exactKeys$1(value, ["source", "effect", "outcome", "subject", "detail", "hookEvent", "injectionIds", "injectionModes"], name, errors, true);
    if (value.effect !== "injection" || value.outcome !== "claimed")
      errors.push(`${name} hook injection evidence proves claimed only`);
    boundedString(value.hookEvent, `${name}.hookEvent`, errors);
    safeIds(value.injectionIds, `${name}.injectionIds`, errors, true);
    if (!Array.isArray(value.injectionModes) || value.injectionModes.length !== (Array.isArray(value.injectionIds) ? value.injectionIds.length : -1) || value.injectionModes.some((mode) => mode !== "inject" && mode !== "pause")) {
      errors.push(`${name}.injectionModes must align with injectionIds`);
    }
  } else if (value.source === "checkpoint_hook") {
    exactKeys$1(value, ["source", "effect", "outcome", "subject", "detail", "userTurnCount"], name, errors, true);
    if (value.effect !== "none")
      errors.push(`${name}.effect must be none`);
    if (!["attempted", "skipped", "waiting", "failed"].includes(String(value.outcome)))
      errors.push(`${name} has invalid checkpoint outcome`);
    nonNegativeInteger(value.userTurnCount, `${name}.userTurnCount`, errors);
  } else {
    errors.push(`${name}.source is unknown`);
  }
}
function sourceProvesOutcome(item) {
  if (item.source === "operation_result") {
    return item.outcome === "persisted" && item.effect === "write" && item.ok === true || item.outcome === "returned" && item.effect === "read" && item.ok === true;
  }
  if (item.source === "init_runtime_result")
    return item.outcome === "persisted" && item.ok === true;
  if (item.source === "doctor_runtime_result")
    return item.outcome === "verified" && item.computedHealthy === true;
  if (item.source === "applied_intervention") {
    return item.outcome === "queued" && (item.resultOutcome === "applied" || item.resultOutcome === "already_applied") && validIds(item.injectionIds, true);
  }
  if (item.source === "hook_evidence") {
    return item.outcome === "claimed" && validIds(item.injectionIds, true);
  }
  return false;
}
function phaseAllowsOutcome(phase, outcome) {
  if (outcome === "failed" || outcome === "waiting")
    return true;
  if (phase === "prepare")
    return outcome === "skipped";
  if (phase === "execute")
    return outcome === "attempted";
  return ["queued", "claimed", "persisted", "returned", "verified", "skipped"].includes(outcome);
}
function activityAllowsEffect(activity, effect) {
  var _a;
  const matrix = {
    setup: ["write", "health_check"],
    query: ["read"],
    review: ["read"],
    ingest: ["write"],
    update: ["write"],
    distill: ["read", "write"],
    inject: ["injection"],
    checkpoint: ["none", "read", "write"]
  };
  return ((_a = matrix[activity]) == null ? void 0 : _a.includes(effect)) ?? false;
}
function operationPresentation(operation) {
  return Object.prototype.hasOwnProperty.call(CANONICAL_OPERATION_PRESENTATION, operation) ? CANONICAL_OPERATION_PRESENTATION[operation] : void 0;
}
function exactKeys$1(value, allowed, name, errors, optional2 = false) {
  const set = new Set(allowed);
  for (const key of Object.keys(value))
    if (!set.has(key))
      errors.push(`${name}.${key} is not allowed`);
  if (!optional2) {
    for (const key of allowed)
      if (!(key in value))
        errors.push(`${name}.${key} is required`);
  }
}
function enumField(value, allowed, name, errors) {
  if (typeof value !== "string" || !allowed.includes(value))
    errors.push(`${name} must be one of ${allowed.join(", ")}`);
}
function boundedString(value, name, errors) {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > MAX_FIELD_CHARS) {
    errors.push(`${name} must be a non-empty string of at most ${MAX_FIELD_CHARS} characters`);
  }
}
function positiveInteger(value, name, errors) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    errors.push(`${name} must be a positive safe integer`);
}
function nonNegativeInteger(value, name, errors) {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    errors.push(`${name} must be a non-negative safe integer`);
}
function safeIds(value, name, errors, nonEmpty2) {
  if (!validIds(value, nonEmpty2))
    errors.push(`${name} must contain ${nonEmpty2 ? "non-empty " : ""}unique positive safe injection ids`);
}
function validIds(value, nonEmpty2) {
  return Array.isArray(value) && (!nonEmpty2 || value.length > 0) && value.every((id) => Number.isSafeInteger(id) && id > 0) && new Set(value).size === value.length;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
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
function isLiveShellRepoRef(value) {
  return record(value) && exactKeys(value, ["repoKey", "repoRoot", "checkoutRoot", "host"]) && isRepoRef(value) && nonEmpty(value.checkoutRoot) && value.checkoutRoot.startsWith("/") && nonEmpty(value.host);
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
  return record(value) && nonEmpty(value.requestId) && nonEmpty(value.acceptedAt) && oneOf(value.outcome, OUTCOMES) && Array.isArray(value.injectionIds) && value.injectionIds.every((id) => integer(id) && id > 0) && new Set(value.injectionIds).size === value.injectionIds.length && stringArray(value.affectedTaskIds) && optional(value.replayed, (item) => typeof item === "boolean") && optional(value.message, string);
}
const ERROR_STATUSES = [
  "db_missing",
  "repo_uninitialized",
  "unsynced",
  "not_found",
  "evidence_unavailable",
  "idempotency_conflict",
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
const AVAILABILITY = ["available", "partial", "unavailable"];
const FRESHNESS = ["live", "stale", "unknown"];
const RECOVERY_CODES = [
  "initialize_runtime",
  "sync_repository",
  "configure_activation",
  "inspect_activation",
  "retry_read",
  "start_or_select_task",
  "inspect_receipt_coverage"
];
function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}
function isRecovery(value) {
  return record(value) && exactKeys(value, ["code", "instruction"]) && oneOf(value.code, RECOVERY_CODES) && nonEmpty(value.instruction);
}
function isSection(value, dataGuard) {
  return record(value) && exactKeys(value, ["availability", "freshness", "data", "recovery"]) && oneOf(value.availability, AVAILABILITY) && oneOf(value.freshness, FRESHNESS) && Array.isArray(value.recovery) && value.recovery.every(isRecovery) && (value.data === null ? value.availability !== "available" : dataGuard(value.data));
}
function isActivationProof(value) {
  return record(value) && exactKeys(value, ["state", "evidence"]) && oneOf(value.state, ["proven", "not_proven", "blocked"]) && stringArray(value.evidence);
}
function isActivation(value) {
  return record(value) && exactKeys(value, ["installed", "connected", "activated"]) && isActivationProof(value.installed) && isActivationProof(value.connected) && isActivationProof(value.activated);
}
function isReceipt(value) {
  return validateWorkflowReceiptStructure(value).ok;
}
function isSession(value) {
  return record(value) && exactKeys(value, ["id", "startedAt", "endedAt", "lifecycle", "endReason", "identity"]) && nonEmpty(value.id) && nonEmpty(value.startedAt) && (value.endedAt === null || string(value.endedAt)) && oneOf(value.lifecycle, ["active", "ended"]) && (value.endReason === null || oneOf(value.endReason, ["context_limit", "user_ended", "completed"])) && record(value.identity) && string(value.identity.agent) && finiteNumber(value.identity.sessionOrdinal) && finiteNumber(value.identity.sessionCount) && optional(value.identity.previousEndedAt, string) && optional(value.identity.previousEndReason, (item) => oneOf(item, ["context_limit", "user_ended", "completed"]));
}
function isCoverage(value) {
  if (!record(value) || !exactKeys(value, ["operation_request", "intervention_queue", "injection_claim", "checkpoint"])) return false;
  return Object.values(value).every((section) => isSection(section, (data) => record(data) && exactKeys(data, ["detail"]) && nonEmpty(data.detail)));
}
function isDeclaredScope(value) {
  return record(value) && exactKeys(value, ["mode", "glob", "label"]) && oneOf(value.mode, ["read", "write"]) && nonEmpty(value.glob) && (value.label === null || nonEmpty(value.label));
}
function isWorkspace(value) {
  return record(value) && exactKeys(value, [
    "authorityModel",
    "map",
    "currentTask",
    "currentSession",
    "declaredScope",
    "observedFootprint",
    "timeline",
    "receipts",
    "receiptCoverage"
  ]) && value.authorityModel === "beta_compatibility" && (value.map === null || isMapSnapshot(value.map)) && (value.currentTask === null || isTask(value.currentTask)) && (value.currentSession === null || isSession(value.currentSession)) && Array.isArray(value.declaredScope) && value.declaredScope.every(isDeclaredScope) && Array.isArray(value.observedFootprint) && value.observedFootprint.every((item) => record(item) && exactKeys(item, ["path", "access", "observedAt"]) && nonEmpty(item.path) && oneOf(item.access, ["read", "write"]) && nonEmpty(item.observedAt)) && Array.isArray(value.timeline) && value.timeline.every(isTimelineEvent) && Array.isArray(value.receipts) && value.receipts.every(isReceipt) && isCoverage(value.receiptCoverage);
}
function isContextEntry(value) {
  return record(value) && exactKeys(value, ["kind", "receipt"]) && oneOf(value.kind, ["retrieval", "operational_capture", "explicit_proposal", "durable_mutation"]) && isReceipt(value.receipt);
}
function isLiveShellSnapshot(value) {
  return record(value) && exactKeys(value, ["schemaVersion", "capturedAt", "identity", "activation", "workspace", "contextFeedback"]) && value.schemaVersion === 1 && nonEmpty(value.capturedAt) && isSection(value.identity, isLiveShellRepoRef) && isSection(value.activation, isActivation) && isSection(value.workspace, isWorkspace) && isSection(value.contextFeedback, (data) => Array.isArray(data) && data.every(isContextEntry));
}
function dispatchWorkbenchEnvelope(envelope, configuredRepo, service) {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("malformed bridge envelope");
  }
  const { method, request } = envelope;
  const validRequest = method === "getLiveShell" ? isLiveShellRepoRef(request) : method === "getSnapshot" ? isRepoRef(request) : method === "getTaskPanel" ? isTaskPanelRequest(request) : method === "getConflictDetail" ? isConflictDetailRequest(request) : method === "applyIntervention" ? isApplyInterventionRequest(request) : false;
  if (!validRequest || !isRepoRef(request)) throw new Error("invalid method-specific bridge request");
  if (request.repoRoot !== configuredRepo.repoRoot || request.repoKey !== configuredRepo.repoKey || method === "getLiveShell" && (!isLiveShellRepoRef(request) || request.checkoutRoot !== configuredRepo.checkoutRoot || request.host !== configuredRepo.host)) {
    throw new Error("bridge repository mismatch");
  }
  let result;
  let guard;
  switch (method) {
    case "getLiveShell":
      result = service.readLiveShell(configuredRepo);
      guard = isLiveShellSnapshot;
      break;
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
  if (!host || !nonEmptyEndpoint(host.endpoint) || !isLiveShellRepoRef(host.repo)) return null;
  const bridge = {
    getLiveShell: (repo) => call(host.endpoint, "getLiveShell", repo, isLiveShellRepoRef, isLiveShellSnapshot, fetchImpl),
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
