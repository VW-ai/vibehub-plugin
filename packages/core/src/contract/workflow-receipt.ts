export const WORKFLOW_ACTIVITIES = [
  "setup",
  "query",
  "review",
  "ingest",
  "update",
  "distill",
  "inject",
  "checkpoint",
] as const;
export type WorkflowActivity = typeof WORKFLOW_ACTIVITIES[number];

/** Canonical, browser-safe presentation semantics for every public operation. */
export const CANONICAL_OPERATION_PRESENTATION = {
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
  "distill.rollback": { activity: "distill", effect: "write" },
} as const;

export const WORKFLOW_PHASES = ["prepare", "execute", "complete"] as const;
export type WorkflowPhase = typeof WORKFLOW_PHASES[number];

/** "delivered" and "acknowledged" require evidence the current runtime lacks. */
export const WORKFLOW_OUTCOMES = [
  "queued",
  "attempted",
  "claimed",
  "persisted",
  "returned",
  "verified",
  "skipped",
  "failed",
  "waiting",
] as const;
export type WorkflowOutcome = typeof WORKFLOW_OUTCOMES[number];

export const WORKFLOW_VISIBILITIES = ["silent", "brief", "expanded"] as const;
export type WorkflowVisibility = typeof WORKFLOW_VISIBILITIES[number];

export const WORKFLOW_EFFECTS = ["read", "write", "injection", "health_check", "none"] as const;
export type WorkflowEffect = typeof WORKFLOW_EFFECTS[number];

interface EvidenceBase {
  effect: WorkflowEffect;
  outcome: WorkflowOutcome;
  subject: string;
  detail?: string;
}

export interface OperationResultEvidenceV1 extends EvidenceBase {
  source: "operation_result";
  effect: "read" | "write";
  outcome: "returned" | "persisted" | "failed";
  operation: string;
  repoId: number;
  requestId: string;
  ok: boolean;
  /** Number returned in this page/result collection, when structurally known. */
  returnedCount?: number;
  /** Total matching count, when the source reports it separately. */
  totalCount?: number;
}

export interface InitRuntimeEvidenceV1 extends EvidenceBase {
  source: "init_runtime_result";
  effect: "write";
  outcome: "persisted" | "waiting" | "failed";
  ok: boolean;
  repoId: number;
  schemaVersion: number;
  conflictCount: number;
}

export interface DoctorRuntimeEvidenceV1 extends EvidenceBase {
  source: "doctor_runtime_result";
  effect: "health_check";
  outcome: "verified" | "failed";
  computedHealthy: boolean;
  dbStatus: "healthy" | "missing" | "unreadable" | "migration_required";
  nativeStatus: "healthy" | "unavailable";
  repoStatus: "healthy" | "uninitialized" | "invalid";
  managedAssetsStatus: "healthy" | "unhealthy";
}

export interface AppliedInterventionEvidenceV1 extends EvidenceBase {
  source: "applied_intervention";
  effect: "injection";
  outcome: "queued" | "skipped" | "failed";
  requestId: string;
  originalKind: "inject" | "pause" | "inject_both";
  resultOutcome: "applied" | "already_applied" | "no_op" | "stale" | "unsupported";
  replayed?: boolean;
  injectionIds: number[];
}

export interface InjectionClaimEvidenceV1 extends EvidenceBase {
  source: "hook_evidence";
  effect: "injection";
  outcome: "claimed";
  hookEvent: string;
  injectionIds: number[];
  injectionModes: Array<"inject" | "pause">;
}

export interface CheckpointHookEvidenceV1 extends EvidenceBase {
  source: "checkpoint_hook";
  effect: "none";
  outcome: "attempted" | "skipped" | "waiting" | "failed";
  userTurnCount: number;
}

export type WorkflowEvidenceV1 =
  | OperationResultEvidenceV1
  | InitRuntimeEvidenceV1
  | DoctorRuntimeEvidenceV1
  | AppliedInterventionEvidenceV1
  | InjectionClaimEvidenceV1
  | CheckpointHookEvidenceV1;

export interface WorkflowNextActionV1 {
  required: boolean;
  instruction: string;
}

/** A bounded presentation projection, never a second workflow state store. */
export interface WorkflowReceiptV1 {
  schemaVersion: 1;
  activity: WorkflowActivity;
  phase: WorkflowPhase;
  outcome: WorkflowOutcome;
  visibility: WorkflowVisibility;
  trigger: string;
  evidence: WorkflowEvidenceV1[];
  nextAction: WorkflowNextActionV1 | null;
  at: string;
}

export type WorkflowReceiptValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

const MAX_FIELD_CHARS = 20_000;
const MAX_EVIDENCE = 32;
const RECEIPT_KEYS = [
  "schemaVersion", "activity", "phase", "outcome", "visibility",
  "trigger", "evidence", "nextAction", "at",
] as const;

/**
 * Strictly validates the wire shape and its safety matrix. It deliberately
 * does not claim that arbitrary caller-provided JSON is authentic evidence.
 */
export function validateWorkflowReceiptStructure(value: unknown): WorkflowReceiptValidation {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["receipt must be an object"] };
  exactKeys(value, RECEIPT_KEYS, "receipt", errors);
  if (value.schemaVersion !== 1) errors.push("schemaVersion must be 1");
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
  for (const [index, item] of evidence.entries()) validateEvidence(item, index, errors);

  if (value.nextAction !== null) {
    if (!isRecord(value.nextAction)) errors.push("nextAction must be an object or null");
    else {
      exactKeys(value.nextAction, ["required", "instruction"], "nextAction", errors);
      if (typeof value.nextAction.required !== "boolean") errors.push("nextAction.required must be boolean");
      boundedString(value.nextAction.instruction, "nextAction.instruction", errors);
    }
  }

  if (typeof value.outcome === "string" && typeof value.phase === "string"
    && !phaseAllowsOutcome(value.phase, value.outcome)) {
    errors.push(`phase ${value.phase} cannot report outcome ${value.outcome}`);
  }
  if ((value.outcome === "failed" || value.outcome === "waiting") && value.visibility === "silent") {
    errors.push(`${value.outcome} cannot be silent`);
  }
  if (value.outcome === "waiting"
    && (!isRecord(value.nextAction) || value.nextAction.required !== true)) {
    errors.push("waiting requires a required next action");
  }

  const matching = evidence.some((item) =>
    isRecord(item) && item.outcome === value.outcome && sourceProvesOutcome(item));
  if (["persisted", "returned", "verified", "queued", "claimed"].includes(String(value.outcome))
    && !matching) {
    errors.push(`${String(value.outcome)} requires matching source-specific evidence`);
  }
  if (typeof value.activity === "string") {
    for (const item of evidence) {
      if (isRecord(item) && typeof item.effect === "string"
        && !activityAllowsEffect(value.activity, item.effect)) {
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

export interface WorkflowReceiptTextOptions {
  width?: number;
}

export function renderWorkflowReceiptText(
  receipt: WorkflowReceiptV1,
  options: WorkflowReceiptTextOptions = {},
): string {
  const validation = validateWorkflowReceiptStructure(receipt);
  if (!validation.ok) throw new Error(`invalid WorkflowReceiptV1 structure: ${validation.errors.join("; ")}`);
  const requested = options.width;
  const width = Number.isFinite(requested)
    ? Math.min(160, Math.max(20, Math.floor(requested as number)))
    : 80;
  const shown = receipt.evidence.slice(0, 8).map(renderEvidence);
  if (receipt.evidence.length > shown.length) {
    shown.push(`[effects omitted: ${receipt.evidence.length - shown.length} additional facts]`);
  }
  const next = receipt.nextAction
    ? `${receipt.nextAction.required ? "required" : "optional"} — ${clip(receipt.nextAction.instruction, 512)}`
    : "none";
  return [
    section("Activity:", `${receipt.activity} / ${receipt.phase}`, width, 256, "[truncated]"),
    section("Trigger:", receipt.trigger, width, 1_024, "[truncated]"),
    section("Effects:", shown.join("; "), width, 4_600, "[effects omitted]"),
    section("Result:", receipt.outcome, width, 256, "[truncated]"),
    section("Next:", next, width, 1_600, "[truncated]"),
  ].join("\n");
}

function validateEvidence(value: unknown, index: number, errors: string[]): void {
  const name = `evidence[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${name} must be an object`);
    return;
  }
  boundedString(value.subject, `${name}.subject`, errors);
  if (value.detail !== undefined) boundedString(value.detail, `${name}.detail`, errors);
  enumField(value.effect, WORKFLOW_EFFECTS, `${name}.effect`, errors);
  enumField(value.outcome, WORKFLOW_OUTCOMES, `${name}.outcome`, errors);

  if (value.source === "operation_result") {
    exactKeys(value, ["source", "effect", "outcome", "subject", "detail", "operation", "repoId", "requestId", "ok", "returnedCount", "totalCount"], name, errors, true);
    boundedString(value.operation, `${name}.operation`, errors);
    positiveInteger(value.repoId, `${name}.repoId`, errors);
    boundedString(value.requestId, `${name}.requestId`, errors);
    if (typeof value.ok !== "boolean") errors.push(`${name}.ok must be boolean`);
    if (value.returnedCount !== undefined) nonNegativeInteger(value.returnedCount, `${name}.returnedCount`, errors);
    if (value.totalCount !== undefined) nonNegativeInteger(value.totalCount, `${name}.totalCount`, errors);
    if (typeof value.returnedCount === "number" && typeof value.totalCount === "number"
      && value.returnedCount > value.totalCount) errors.push(`${name}.returnedCount cannot exceed totalCount`);
    const canonical = typeof value.operation === "string" ? operationPresentation(value.operation) : undefined;
    if (!canonical) errors.push(`${name}.operation is not canonical`);
    else if (canonical.effect !== value.effect) errors.push(`${name}.effect contradicts canonical operation mapping`);
    if (typeof value.operation === "string" && typeof value.requestId === "string"
      && value.subject !== `${value.operation} request ${value.requestId}`) {
      errors.push(`${name}.subject must be the deterministic operation/request subject`);
    }
    if (value.ok === true && !["returned", "persisted"].includes(String(value.outcome))) errors.push(`${name} successful operation has invalid outcome`);
    if (value.ok === false && value.outcome !== "failed") errors.push(`${name} failed operation must report failed`);
    if (value.effect === "read" && value.outcome === "persisted") errors.push(`${name} read cannot prove persisted`);
    if (value.effect === "write" && value.outcome === "returned") errors.push(`${name} write cannot prove returned`);
  } else if (value.source === "init_runtime_result") {
    exactKeys(value, ["source", "effect", "outcome", "subject", "detail", "ok", "repoId", "schemaVersion", "conflictCount"], name, errors, true);
    if (value.effect !== "write") errors.push(`${name}.effect must be write`);
    if (typeof value.ok !== "boolean") errors.push(`${name}.ok must be boolean`);
    positiveInteger(value.repoId, `${name}.repoId`, errors);
    nonNegativeInteger(value.schemaVersion, `${name}.schemaVersion`, errors);
    nonNegativeInteger(value.conflictCount, `${name}.conflictCount`, errors);
    if (value.ok === true && value.outcome !== "persisted") errors.push(`${name} successful init must report persisted`);
    if (value.ok === false && !["waiting", "failed"].includes(String(value.outcome))) errors.push(`${name} unsuccessful init cannot prove success`);
    if (typeof value.ok === "boolean" && typeof value.conflictCount === "number"
      && value.ok !== (value.conflictCount === 0)) errors.push(`${name}.ok must equal conflictCount === 0`);
  } else if (value.source === "doctor_runtime_result") {
    exactKeys(value, ["source", "effect", "outcome", "subject", "detail", "computedHealthy", "dbStatus", "nativeStatus", "repoStatus", "managedAssetsStatus"], name, errors, true);
    if (value.effect !== "health_check") errors.push(`${name}.effect must be health_check`);
    if (typeof value.computedHealthy !== "boolean") errors.push(`${name}.computedHealthy must be boolean`);
    enumField(value.dbStatus, ["healthy", "missing", "unreadable", "migration_required"], `${name}.dbStatus`, errors);
    enumField(value.nativeStatus, ["healthy", "unavailable"], `${name}.nativeStatus`, errors);
    enumField(value.repoStatus, ["healthy", "uninitialized", "invalid"], `${name}.repoStatus`, errors);
    enumField(value.managedAssetsStatus, ["healthy", "unhealthy"], `${name}.managedAssetsStatus`, errors);
    if (value.computedHealthy === true && value.outcome !== "verified") errors.push(`${name} healthy doctor must report verified`);
    if (value.computedHealthy === false && value.outcome !== "failed") errors.push(`${name} unhealthy doctor must report failed`);
    const recomputed = value.dbStatus === "healthy" && value.nativeStatus === "healthy"
      && value.repoStatus === "healthy" && value.managedAssetsStatus === "healthy";
    if (typeof value.computedHealthy === "boolean" && value.computedHealthy !== recomputed) {
      errors.push(`${name}.computedHealthy contradicts component statuses`);
    }
  } else if (value.source === "applied_intervention") {
    exactKeys(value, ["source", "effect", "outcome", "subject", "detail", "requestId", "originalKind", "resultOutcome", "replayed", "injectionIds"], name, errors, true);
    if (value.effect !== "injection") errors.push(`${name}.effect must be injection`);
    boundedString(value.requestId, `${name}.requestId`, errors);
    enumField(value.originalKind, ["inject", "pause", "inject_both"], `${name}.originalKind`, errors);
    enumField(value.resultOutcome, ["applied", "already_applied", "no_op", "stale", "unsupported"], `${name}.resultOutcome`, errors);
    if (value.replayed !== undefined && typeof value.replayed !== "boolean") errors.push(`${name}.replayed must be boolean`);
    safeIds(value.injectionIds, `${name}.injectionIds`, errors, value.outcome === "queued");
    if (value.outcome === "queued" && !["applied", "already_applied"].includes(String(value.resultOutcome))) errors.push(`${name} replay outcome cannot prove queued`);
    if (value.outcome === "queued" && Array.isArray(value.injectionIds)) {
      const expected = value.originalKind === "inject_both" ? 2 : 1;
      if (value.injectionIds.length !== expected) errors.push(`${name}.injectionIds cardinality must be ${expected} for ${String(value.originalKind)}`);
    }
  } else if (value.source === "hook_evidence") {
    exactKeys(value, ["source", "effect", "outcome", "subject", "detail", "hookEvent", "injectionIds", "injectionModes"], name, errors, true);
    if (value.effect !== "injection" || value.outcome !== "claimed") errors.push(`${name} hook injection evidence proves claimed only`);
    boundedString(value.hookEvent, `${name}.hookEvent`, errors);
    safeIds(value.injectionIds, `${name}.injectionIds`, errors, true);
    if (!Array.isArray(value.injectionModes) || value.injectionModes.length !== (Array.isArray(value.injectionIds) ? value.injectionIds.length : -1)
      || value.injectionModes.some((mode) => mode !== "inject" && mode !== "pause")) {
      errors.push(`${name}.injectionModes must align with injectionIds`);
    }
  } else if (value.source === "checkpoint_hook") {
    exactKeys(value, ["source", "effect", "outcome", "subject", "detail", "userTurnCount"], name, errors, true);
    if (value.effect !== "none") errors.push(`${name}.effect must be none`);
    if (!["attempted", "skipped", "waiting", "failed"].includes(String(value.outcome))) errors.push(`${name} has invalid checkpoint outcome`);
    nonNegativeInteger(value.userTurnCount, `${name}.userTurnCount`, errors);
  } else {
    errors.push(`${name}.source is unknown`);
  }
}

function sourceProvesOutcome(item: Record<string, unknown>): boolean {
  if (item.source === "operation_result") {
    return (item.outcome === "persisted" && item.effect === "write" && item.ok === true)
      || (item.outcome === "returned" && item.effect === "read" && item.ok === true);
  }
  if (item.source === "init_runtime_result") return item.outcome === "persisted" && item.ok === true;
  if (item.source === "doctor_runtime_result") return item.outcome === "verified" && item.computedHealthy === true;
  if (item.source === "applied_intervention") {
    return item.outcome === "queued"
      && (item.resultOutcome === "applied" || item.resultOutcome === "already_applied")
      && validIds(item.injectionIds, true);
  }
  if (item.source === "hook_evidence") {
    return item.outcome === "claimed" && validIds(item.injectionIds, true);
  }
  return false;
}

function phaseAllowsOutcome(phase: string, outcome: string): boolean {
  if (outcome === "failed" || outcome === "waiting") return true;
  if (phase === "prepare") return outcome === "skipped";
  if (phase === "execute") return outcome === "attempted";
  return ["queued", "claimed", "persisted", "returned", "verified", "skipped"].includes(outcome);
}

function activityAllowsEffect(activity: string, effect: string): boolean {
  const matrix: Record<string, readonly string[]> = {
    setup: ["write", "health_check"],
    query: ["read"],
    review: ["read"],
    ingest: ["write"],
    update: ["write"],
    distill: ["read", "write"],
    inject: ["injection"],
    checkpoint: ["none", "read", "write"],
  };
  return matrix[activity]?.includes(effect) ?? false;
}

function operationPresentation(operation: string): { activity: string; effect: string } | undefined {
  return Object.prototype.hasOwnProperty.call(CANONICAL_OPERATION_PRESENTATION, operation)
    ? CANONICAL_OPERATION_PRESENTATION[operation as keyof typeof CANONICAL_OPERATION_PRESENTATION]
    : undefined;
}

function renderEvidence(item: WorkflowEvidenceV1): string {
  const facts = item.source === "operation_result"
    ? `${item.operation}; ok=${item.ok}${item.returnedCount === undefined ? "" : `; returned=${item.returnedCount}`}${item.totalCount === undefined ? "" : `; total=${item.totalCount}`}`
    : item.source === "doctor_runtime_result"
      ? `db=${item.dbStatus}; native=${item.nativeStatus}; repo=${item.repoStatus}; assets=${item.managedAssetsStatus}`
      : item.source === "applied_intervention"
        ? `${item.originalKind}; ${item.resultOutcome}; replayed=${item.replayed === true}; ids=${item.injectionIds.join(",")}`
        : item.source === "hook_evidence"
          ? `${item.hookEvent}; ids=${item.injectionIds.join(",")}`
          : item.source === "init_runtime_result"
            ? `ok=${item.ok}; repo=${item.repoId}; conflicts=${item.conflictCount}`
            : `turns=${item.userTurnCount}`;
  return `${item.effect}/${item.outcome}: ${clip(item.subject, 160)} — ${clip(facts, 240)}${item.detail ? ` — ${clip(item.detail, 240)}` : ""}`;
}

function section(label: string, raw: string, width: number, budget: number, marker: string): string {
  const value = sanitize(raw);
  const full = labeled(label, value, width);
  if ([...full].length <= budget) return full;
  const chars = [...value];
  const markerBlock = wrap(marker, width).join("\n");
  const contentBudget = Math.max([...label].length + 1, budget - [...markerBlock].length - 1);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = labeled(label, chars.slice(0, mid).join(""), width);
    if ([...candidate].length <= contentBudget) low = mid;
    else high = mid - 1;
  }
  return `${labeled(label, chars.slice(0, low).join(""), width)}\n${markerBlock}`;
}

function labeled(label: string, value: string, width: number): string {
  const available = Math.max(8, width - displayWidth(label) - 1);
  const lines = wrap(value, available);
  const indent = " ".repeat(displayWidth(label) + 1);
  return lines.map((line, index) => index === 0 ? `${label} ${line}` : `${indent}${line}`).join("\n");
}

function wrap(raw: string, width: number): string[] {
  const value = sanitize(raw);
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const flush = () => { if (line) { lines.push(line); line = ""; } };
  for (const word of words) {
    const joined = line ? `${line} ${word}` : word;
    if (displayWidth(joined) <= width) {
      line = joined;
      continue;
    }
    flush();
    const chunks = splitByDisplayWidth(word, width);
    while (chunks.length > 1) lines.push(chunks.shift()!);
    line = chunks[0] ?? "";
  }
  flush();
  return lines.length ? lines : [""];
}

function splitByDisplayWidth(value: string, width: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let columns = 0;
  for (const char of value) {
    const charColumns = terminalCharWidth(char);
    if (chunk && columns + charColumns > width) {
      chunks.push(chunk);
      chunk = "";
      columns = 0;
    }
    chunk += char;
    columns += charColumns;
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [""];
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += terminalCharWidth(char);
  return width;
}

function terminalCharWidth(char: string): number {
  if (/\p{Mark}/u.test(char) || char === "\u200d" || char === "\ufe0f") return 0;
  if (/\p{Extended_Pictographic}/u.test(char)
    || /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char)) {
    return 2;
  }
  return 1;
}

function clip(value: string, limit: number): string {
  const chars = [...sanitize(value)];
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit - 1).join("")}…`;
}

function sanitize(value: string): string {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)?)/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string, errors: string[], optional = false): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) if (!set.has(key)) errors.push(`${name}.${key} is not allowed`);
  if (!optional) for (const key of allowed) if (!(key in value)) errors.push(`${name}.${key} is required`);
}

function enumField(value: unknown, allowed: readonly string[], name: string, errors: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) errors.push(`${name} must be one of ${allowed.join(", ")}`);
}

function boundedString(value: unknown, name: string, errors: string[]): void {
  if (typeof value !== "string" || value.trim().length === 0 || [...value].length > MAX_FIELD_CHARS) {
    errors.push(`${name} must be a non-empty string of at most ${MAX_FIELD_CHARS} characters`);
  }
}

function positiveInteger(value: unknown, name: string, errors: string[]): void {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) errors.push(`${name} must be a positive safe integer`);
}

function nonNegativeInteger(value: unknown, name: string, errors: string[]): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) errors.push(`${name} must be a non-negative safe integer`);
}

function safeIds(value: unknown, name: string, errors: string[], nonEmpty: boolean): void {
  if (!validIds(value, nonEmpty)) errors.push(`${name} must contain ${nonEmpty ? "non-empty " : ""}unique positive safe injection ids`);
}

function validIds(value: unknown, nonEmpty: boolean): value is number[] {
  return Array.isArray(value)
    && (!nonEmpty || value.length > 0)
    && value.every((id) => Number.isSafeInteger(id) && id > 0)
    && new Set(value).size === value.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
