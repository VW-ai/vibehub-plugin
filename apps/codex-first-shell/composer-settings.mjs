// Truthful Composer settings. Every option, value and posture here comes from
// the app-server through the host: the model catalog from listModels
// (model/list), the current values from the Thread's settings record
// (thread/start, thread/resume, thread/settings/updated) and the overrides the
// human picked for the next Turn. Nothing is invented when the runtime has not
// reported it, and no option string lives in this source.

// The two postures the host contract names (daily-use-host-contract.json
// turnSettings.posture), sent as the exact turn/start keys.
export const POSTURES = Object.freeze({
  askForApproval: Object.freeze({ approvalPolicy: "on-request", sandboxPolicy: Object.freeze({ type: "workspaceWrite" }) }),
  fullAccess: Object.freeze({ approvalPolicy: "never", sandboxPolicy: Object.freeze({ type: "dangerFullAccess" }) }),
});

export const POSTURE_LABELS = Object.freeze({ askForApproval: "Ask for approval", fullAccess: "Full access" });

// Which named posture a settings record (or override) is, "other" for any
// reported pair that is neither, null while nothing was reported.
export function postureOf(settings) {
  if (!settings || (settings.approvalPolicy == null && settings.sandboxPolicy == null)) return null;
  for (const [key, posture] of Object.entries(POSTURES)) {
    if (settings.approvalPolicy === posture.approvalPolicy && settings.sandboxPolicy?.type === posture.sandboxPolicy.type) return key;
  }
  return "other";
}

export function describePosture(settings) {
  if (!settings || (settings.approvalPolicy == null && settings.sandboxPolicy == null)) return "not reported yet";
  return `${settings.approvalPolicy ?? "approval not reported"} · ${settings.sandboxPolicy?.type ?? "sandbox not reported"}`;
}

export function findModel(models, slug) {
  return (Array.isArray(models) ? models : []).find((model) => model.model === slug) ?? null;
}

export function defaultModel(models) {
  const list = Array.isArray(models) ? models : [];
  return list.find((model) => model.isDefault) ?? list[0] ?? null;
}

export function modelOptionLabel(model) {
  return `${model.displayName ?? model.model}${model.isDefault ? " (default)" : ""}`;
}

export function effortOptionLabel(option, model) {
  return `${option.reasoningEffort}${option.reasoningEffort === model?.defaultReasoningEffort ? " (default)" : ""}`;
}

// The model the picker shows for a Thread: the override wins, then the
// reported record; with neither, the loaded default is shown as "default"
// (source "default"), which claims nothing about what the runtime set.
export function selectedModel(models, record, overrides) {
  const list = Array.isArray(models) ? models : [];
  const slug = overrides?.model ?? record?.model ?? null;
  if (!list.length) return { model: null, slug, source: "not-loaded" };
  if (slug) return { model: findModel(list, slug), slug, source: overrides?.model ? "override" : "record" };
  const fallback = defaultModel(list);
  return { model: fallback, slug: fallback?.model ?? null, source: "default" };
}

// The effort the picker shows: the override when the selected model supports
// it, the record's effort when the record names the selected model (the
// runtime's own report, listed or not), else the model's
// defaultReasoningEffort. Options come from supportedReasoningEfforts alone;
// a model that lists none offers no effort choice.
export function selectedEffort(model, record, overrides, selectedSlug) {
  const supported = (model?.supportedReasoningEfforts ?? []).map((option) => option.reasoningEffort);
  const supports = (effort) => Boolean(effort) && (!supported.length || supported.includes(effort));
  if (supports(overrides?.effort)) return { effort: overrides.effort, source: "override" };
  if (record?.model === selectedSlug && record?.effort) return { effort: record.effort, source: "record" };
  if (model?.defaultReasoningEffort) return { effort: model.defaultReasoningEffort, source: "default" };
  return { effort: null, source: "unknown" };
}

// The overrides that still differ from what the runtime reported: exactly the
// turn/start keys to send, nothing that equals the record. A posture is one
// unit: approvalPolicy and sandboxPolicy travel together when either differs.
export function pendingOverrides(record, overrides) {
  const pending = {};
  if (overrides?.model != null && overrides.model !== record?.model) pending.model = overrides.model;
  if (overrides?.effort != null && overrides.effort !== record?.effort) pending.effort = overrides.effort;
  const posture = overrides?.approvalPolicy != null || overrides?.sandboxPolicy != null;
  if (posture) {
    const approvalDiffers = overrides.approvalPolicy != null && overrides.approvalPolicy !== record?.approvalPolicy;
    const sandboxDiffers = overrides.sandboxPolicy != null && overrides.sandboxPolicy.type !== record?.sandboxPolicy?.type;
    if (approvalDiffers || sandboxDiffers) {
      if (overrides.approvalPolicy != null) pending.approvalPolicy = overrides.approvalPolicy;
      if (overrides.sandboxPolicy != null) pending.sandboxPolicy = overrides.sandboxPolicy;
    }
  }
  return Object.keys(pending).length ? pending : null;
}

// A model whose inputModalities lack image refuses image attachments, naming
// itself and what it does accept, computed from the Model record alone.
export function imageRefusal(model) {
  if (!model) return null;
  const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : [];
  if (modalities.includes("image")) return null;
  return `${model.displayName ?? model.model} accepts: ${modalities.join(", ") || "no reported input modality"}`;
}

// The one-line posture of a Turn this session started: model (displayName
// when the catalog knows it), effort, approval policy and sandbox type, each
// only when known; null when nothing about the Turn is known.
export function describeTurnSettings(turn, models) {
  if (!turn) return null;
  const parts = [];
  if (turn.model) parts.push(findModel(models, turn.model)?.displayName ?? turn.model);
  if (turn.effort) parts.push(turn.effort);
  if (turn.approvalPolicy) parts.push(turn.approvalPolicy);
  if (turn.sandboxPolicy?.type) parts.push(turn.sandboxPolicy.type);
  return parts.length ? parts.join(" · ") : null;
}
