import { mergeQueueRecord } from "./composer-queue.mjs";

const LIVE_STATUSES = new Set(["inProgress", "running"]);
export const LIVE_ITEM_LIMIT = 64;
const THREAD_RECORD_LIMIT = 64;
const LIVE_TEXT_LIMIT = 32_000;
const LIVE_OUTPUT_LIMIT = 20_000;
const LIVE_CHANGE_LIMIT = 32;

function trimMap(map, limit = LIVE_ITEM_LIMIT) {
  while (map.size > limit) map.delete(map.keys().next().value);
}

function appendLiveText(item, field, delta, maximum = LIVE_TEXT_LIMIT) {
  const prior = String(item[field] ?? "");
  const source = String(delta ?? "");
  const remaining = Math.max(0, maximum - prior.length);
  const accepted = source.slice(0, remaining);
  item[field] = `${prior}${accepted}`;
  item._omittedCharacters = (item._omittedCharacters ?? 0) + source.length - accepted.length;
}

function boundedChanges(changes) {
  return (changes ?? []).slice(0, LIVE_CHANGE_LIMIT).map((change) => ({
    ...change,
    path: String(change.path ?? "").slice(0, 1_024),
    diff: change.diff == null ? change.diff : String(change.diff).slice(0, LIVE_OUTPUT_LIMIT),
  }));
}

export function itemKey(threadId, turnId, itemId) {
  return `${encodeURIComponent(String(threadId ?? "unknown"))}::${encodeURIComponent(String(turnId ?? "unknown"))}::${encodeURIComponent(String(itemId ?? "unknown"))}`;
}

function liveItem(model, threadId, itemId, fallback, turnId) {
  const key = itemKey(threadId, turnId, itemId);
  if (!model.liveItems.has(key)) {
    model.liveItems.set(key, { id: itemId, ...fallback, _threadId: threadId, _turnId: turnId, _key: key, _live: true });
    trimMap(model.liveItems);
  }
  const item = model.liveItems.get(key);
  if (threadId && !item._threadId) item._threadId = threadId;
  if (turnId && !item._turnId) item._turnId = turnId;
  return item;
}

function transientMap(model, name) {
  model[name] ??= new Map();
  return model[name];
}

function clearTurnTransient(model, threadId, turnId) {
  for (const name of ["liveItems", "turnErrors", "turnPlans", "turnDiffs"]) {
    const map = transientMap(model, name);
    for (const [key, value] of map) {
      if (value?._threadId === threadId && value?._turnId === turnId) map.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-Thread records the runtime reports beside the transcript. Each one is
// exactly what the app-server or the host sent: the last
// thread/tokenUsage/updated (no value exists before the first one), the
// settings record the host attached or the forwarded thread/settings/updated,
// and the host-owned follow-up queue. None of it is persisted in the browser.
// ---------------------------------------------------------------------------

// thread/tokenUsage/updated: { threadId, turnId, tokenUsage: { total, last,
// modelContextWindow } } — inside a Turn before its turn/completed, and
// replayed on thread/resume.
export function applyTokenUsage(model, params = {}) {
  if (typeof params.threadId !== "string" || !params.tokenUsage || typeof params.tokenUsage !== "object") return false;
  const usage = transientMap(model, "tokenUsage");
  const total = params.tokenUsage.total ?? null;
  usage.delete(params.threadId);
  usage.set(params.threadId, {
    threadId: params.threadId,
    turnId: params.turnId ?? null,
    totalTokens: Number.isFinite(total?.totalTokens) ? total.totalTokens : null,
    modelContextWindow: Number.isFinite(params.tokenUsage.modelContextWindow) ? params.tokenUsage.modelContextWindow : null,
    total,
    last: params.tokenUsage.last ?? null,
  });
  trimMap(usage, THREAD_RECORD_LIMIT);
  return true;
}

// The settings record shape the host attaches (daily-use-host-contract.json
// settingsRecord): model, effort, approvalPolicy, sandboxPolicy, source,
// observedAt. A forwarded thread/settings/updated becomes the same record
// with source thread/settings/updated; note effort, not reasoningEffort.
export function settingsRecordFromNotification(params = {}) {
  const settings = params.threadSettings;
  if (typeof params.threadId !== "string" || !settings || typeof settings !== "object") return null;
  return {
    model: settings.model ?? null,
    effort: settings.effort ?? null,
    approvalPolicy: settings.approvalPolicy ?? null,
    sandboxPolicy: settings.sandboxPolicy ?? null,
    source: "thread/settings/updated",
    observedAt: new Date().toISOString(),
  };
}

export function rememberThreadSettings(model, threadId, record) {
  if (typeof threadId !== "string" || !threadId) return false;
  const settings = transientMap(model, "threadSettings");
  settings.delete(threadId);
  if (record) settings.set(threadId, record);
  trimMap(settings, THREAD_RECORD_LIMIT);
  return true;
}

export function threadSettings(model, threadId) {
  return transientMap(model, "threadSettings").get(threadId) ?? null;
}

export function threadTokenUsage(model, threadId) {
  return transientMap(model, "tokenUsage").get(threadId) ?? null;
}

export function threadQueue(model, threadId) {
  return transientMap(model, "queues").get(threadId) ?? null;
}

// Host events about the follow-up queue. queueChanged carries the whole
// record (media elided), queuedStarted names the follow-up that became its
// own Turn (the record that follows drops it), queuedFailed names the one
// whose turn/start was refused (it stays at the head, the queue pauses with
// start_failed). The started item is returned so the caller can attribute
// the new Turn's settings.
export function applyHostEvent(model, kind, value = {}) {
  if (typeof value.threadId !== "string") return null;
  const queues = transientMap(model, "queues");
  if (kind === "queueChanged") {
    if (!value.queue || typeof value.queue !== "object") return null;
    const prior = transientMap(model, "queueShadow").get(value.threadId) ?? queues.get(value.threadId) ?? null;
    queues.delete(value.threadId);
    queues.set(value.threadId, mergeQueueRecord(prior, value.queue));
    trimMap(queues, THREAD_RECORD_LIMIT);
    return { kind, threadId: value.threadId, queue: queues.get(value.threadId) };
  }
  if (kind === "queuedStarted") {
    const queue = queues.get(value.threadId);
    const item = queue?.items.find((entry) => entry.queuedId === value.queuedId) ?? null;
    return { kind, threadId: value.threadId, queuedId: value.queuedId, turnId: value.turnId, item };
  }
  if (kind === "queuedFailed") {
    return { kind, threadId: value.threadId, queuedId: value.queuedId, error: value.error ?? null };
  }
  return null;
}

// A queue record read with full media (listQueue, queueTurn, updateQueued,
// deleteQueued, resumeQueue, steerQueued responses) replaces the mirror and
// is kept as the shadow that later elided events borrow their media from.
export function rememberQueue(model, queue) {
  if (!queue || typeof queue.threadId !== "string") return null;
  const queues = transientMap(model, "queues");
  const shadows = transientMap(model, "queueShadow");
  queues.delete(queue.threadId);
  queues.set(queue.threadId, queue);
  shadows.delete(queue.threadId);
  shadows.set(queue.threadId, queue);
  trimMap(queues, THREAD_RECORD_LIMIT);
  trimMap(shadows, THREAD_RECORD_LIMIT);
  return queue;
}

export function applyChatEvent(model, method, params = {}) {
  if (!model?.liveItems || !model?.turnErrors) throw new TypeError("Chat model requires liveItems and turnErrors Maps");
  if (method === "thread/tokenUsage/updated") return applyTokenUsage(model, params);
  if (method === "thread/settings/updated") {
    const record = settingsRecordFromNotification(params);
    return record ? rememberThreadSettings(model, params.threadId, record) : false;
  }
  if (method === "item/started") {
    const key = itemKey(params.threadId, params.turnId, params.item.id);
    model.liveItems.set(key, { ...params.item, changes: boundedChanges(params.item.changes), _threadId: params.threadId, _turnId: params.turnId, _key: key, _live: true });
    trimMap(model.liveItems);
    return true;
  }
  if (method === "item/completed") {
    const key = itemKey(params.threadId, params.turnId, params.item.id);
    model.liveItems.set(key, { ...params.item, text: params.item.text == null ? params.item.text : String(params.item.text).slice(0, LIVE_TEXT_LIMIT), aggregatedOutput: params.item.aggregatedOutput == null ? params.item.aggregatedOutput : String(params.item.aggregatedOutput).slice(0, LIVE_OUTPUT_LIMIT), changes: boundedChanges(params.item.changes), _threadId: params.threadId, _turnId: params.turnId, _key: key, _live: false });
    trimMap(model.liveItems);
    return true;
  }
  if (method === "turn/plan/updated") {
    const id = `plan-${params.turnId}`;
    const key = itemKey(params.threadId, params.turnId, id);
    const plans = transientMap(model, "turnPlans");
    plans.set(key, {
      id,
      type: "turnPlan",
      plan: (params.plan ?? []).slice(0, LIVE_ITEM_LIMIT).map((entry) => ({ ...entry, step: String(entry.step ?? "").slice(0, 2_000) })),
      explanation: params.explanation == null ? null : String(params.explanation).slice(0, 4_000),
      _threadId: params.threadId,
      _turnId: params.turnId,
      _key: key,
      _live: true,
    });
    trimMap(plans);
    return true;
  }
  if (method === "turn/diff/updated") {
    const id = `diff-${params.turnId}`;
    const key = itemKey(params.threadId, params.turnId, id);
    const diffs = transientMap(model, "turnDiffs");
    diffs.set(key, {
      id,
      type: "turnDiff",
      diff: String(params.diff ?? "").slice(0, LIVE_OUTPUT_LIMIT),
      _threadId: params.threadId,
      _turnId: params.turnId,
      _key: key,
      _live: true,
    });
    trimMap(diffs);
    return true;
  }
  if (method === "item/agentMessage/delta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "agentMessage", text: "", phase: null }, params.turnId);
    appendLiveText(item, "text", params.delta);
    return true;
  }
  if (method === "item/plan/delta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "plan", text: "" }, params.turnId);
    appendLiveText(item, "text", params.delta);
    return true;
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "reasoning", summary: [], content: [] }, params.turnId);
    item.summary ??= [];
    const index = Math.min(15, Math.max(0, params.summaryIndex ?? 0));
    const holder = { value: item.summary[index] ?? "", _omittedCharacters: item._omittedCharacters ?? 0 };
    appendLiveText(holder, "value", params.delta, 8_000);
    item.summary[index] = holder.value;
    item._omittedCharacters = holder._omittedCharacters;
    return true;
  }
  if (method === "item/reasoning/textDelta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "reasoning", summary: [], content: [] }, params.turnId);
    item.content ??= [];
    const index = Math.min(15, Math.max(0, params.contentIndex ?? 0));
    const holder = { value: item.content[index] ?? "", _omittedCharacters: item._omittedCharacters ?? 0 };
    appendLiveText(holder, "value", params.delta, 8_000);
    item.content[index] = holder.value;
    item._omittedCharacters = holder._omittedCharacters;
    return true;
  }
  if (method === "item/commandExecution/outputDelta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "commandExecution", command: "Command", status: "inProgress", aggregatedOutput: "" }, params.turnId);
    appendLiveText(item, "aggregatedOutput", params.delta, LIVE_OUTPUT_LIMIT);
    return true;
  }
  if (method === "item/fileChange/patchUpdated") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "fileChange", status: "inProgress", changes: [] }, params.turnId);
    item.changes = boundedChanges(params.changes ?? item.changes);
    return true;
  }
  if (method === "item/fileChange/outputDelta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "fileChange", status: "inProgress", changes: [], output: "" }, params.turnId);
    appendLiveText(item, "output", params.delta, LIVE_OUTPUT_LIMIT);
    return true;
  }
  if (method === "item/mcpToolCall/progress") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "mcpToolCall", status: "inProgress", arguments: {} }, params.turnId);
    appendLiveText(item, "progress", params.message ?? params.delta ?? "", 4_000);
    return true;
  }
  if (method === "error") {
    const turnId = params.turnId ?? "unknown";
    const key = itemKey(params.threadId, turnId, `error-${turnId}`);
    model.turnErrors.set(key, {
      type: "turnError",
      id: `error-${turnId}`,
      _threadId: params.threadId,
      _turnId: turnId,
      _key: key,
      message: params.error?.message ?? params.error ?? "Codex encountered an error.",
      willRetry: Boolean(params.willRetry),
    });
    trimMap(model.turnErrors);
    return true;
  }
  if (method === "turn/completed") {
    const turnId = params.turn?.id ?? params.turnId;
    if (turnId) clearTurnTransient(model, params.threadId, turnId);
    return true;
  }
  // The app-server process died while this Turn was in progress. The Turn
  // is not live any more and nothing streamed for it can be trusted; a
  // boundary records where the exit fell until replay marks the Turn
  // terminal on its own (an authoritative Turn hides every transient entry).
  if (method === "runtime/exited") {
    const turnId = params.turnId ?? "unknown";
    clearTurnTransient(model, params.threadId, turnId);
    const id = `runtime-exit-${turnId}`;
    const key = itemKey(params.threadId, turnId, id);
    model.turnErrors.set(key, {
      type: "turnBoundary",
      id,
      status: "runtimeExited",
      _threadId: params.threadId,
      _turnId: turnId,
      _key: key,
      _live: false,
      message: `The local Codex app-server exited (process generation ${params.generation ?? "unknown"}) while this Turn was running. Nothing here is live; the Thread is re-read from Codex once the runtime is back.`,
    });
    trimMap(model.turnErrors);
    return true;
  }
  return false;
}

// The mounted window is the accepted 240-item tail; the omitted count is
// returned so the UI can disclose the bound instead of silently truncating.
export function timelineWindow(thread, model, { limit = 240 } = {}) {
  const threadId = thread?.id;
  // `_turnLive` marks whether the owning Turn is still running as the
  // app-server reports it: a replayed item of a terminal Turn is finalized, a
  // replayed or streamed item of a live Turn is not, whatever the item's own
  // streaming state. Additive VibeHub actions are offered on finalized
  // assistant messages only.
  const replay = (thread?.turns ?? []).flatMap((turn) => {
    const turnLive = turnIsLive(turn);
    const items = (turn.items ?? []).map((item) => {
      const key = itemKey(threadId, turn.id, item.id);
      // A contextCompaction item is the transcript boundary of its
      // compaction Turn (the 0.149.0 v2 path sends no thread/compacted).
      return { ...item, _threadId: threadId, _turnId: turn.id, _key: key, _live: false, _turnLive: turnLive, ...(item.type === "contextCompaction" ? { _boundary: "compacted" } : {}) };
    });
    if (["interrupted", "failed"].includes(turn.status)) {
      const boundaryKey = itemKey(threadId, turn.id, `boundary-${turn.id}`);
      items.push({
        type: "turnBoundary",
        id: `boundary-${turn.id}`,
        _threadId: threadId,
        _turnId: turn.id,
        _key: boundaryKey,
        status: turn.status,
        message: turn.error?.message,
        _live: false,
        _turnLive: turnLive,
      });
    }
    return items;
  });
  const authoritativeTurnIds = new Set((thread?.turns ?? []).filter((turn) => !LIVE_STATUSES.has(turn?.status?.type ?? turn?.status)).map((turn) => turn.id));
  const replayIds = new Set(replay.map((item) => item._key));
  const transient = [
    ...transientMap(model, "turnPlans").values(),
    ...transientMap(model, "turnDiffs").values(),
    ...model.liveItems.values(),
  ];
  const live = transient
    .filter((item) => item._threadId === threadId && !authoritativeTurnIds.has(item._turnId) && !replayIds.has(item._key))
    .map((item) => ({ ...item, _turnLive: true }));
  const errorIds = new Set(replay.map((item) => item._key));
  const errors = [...model.turnErrors.values()].filter((item) => item._threadId === threadId && !authoritativeTurnIds.has(item._turnId) && !errorIds.has(item._key));
  const all = [...replay, ...live, ...errors];
  const items = all.slice(-limit);
  return { items, omitted: all.length - items.length, total: all.length };
}

export function canonicalTimeline(thread, model, options = {}) {
  return timelineWindow(thread, model, options).items;
}

export function boundedText(value, maximum = 20_000) {
  const text = String(value ?? "");
  if (text.length <= maximum) return { text, truncated: false, omitted: 0 };
  return { text: text.slice(0, maximum), truncated: true, omitted: text.length - maximum };
}

export function turnIsLive(turn) {
  return LIVE_STATUSES.has(turn?.status?.type ?? turn?.status);
}
