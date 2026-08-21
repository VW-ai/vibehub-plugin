const LIVE_STATUSES = new Set(["inProgress", "running"]);

export function itemKey(threadId, turnId, itemId) {
  return `${encodeURIComponent(String(threadId ?? "unknown"))}::${encodeURIComponent(String(turnId ?? "unknown"))}::${encodeURIComponent(String(itemId ?? "unknown"))}`;
}

function liveItem(model, threadId, itemId, fallback, turnId) {
  const key = itemKey(threadId, turnId, itemId);
  if (!model.liveItems.has(key)) {
    model.liveItems.set(key, { id: itemId, ...fallback, _threadId: threadId, _turnId: turnId, _key: key, _live: true });
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

export function applyChatEvent(model, method, params = {}) {
  if (!model?.liveItems || !model?.turnErrors) throw new TypeError("Chat model requires liveItems and turnErrors Maps");
  if (method === "item/started") {
    const key = itemKey(params.threadId, params.turnId, params.item.id);
    model.liveItems.set(key, { ...params.item, _threadId: params.threadId, _turnId: params.turnId, _key: key, _live: true });
    return true;
  }
  if (method === "item/completed") {
    const key = itemKey(params.threadId, params.turnId, params.item.id);
    model.liveItems.set(key, { ...params.item, _threadId: params.threadId, _turnId: params.turnId, _key: key, _live: false });
    return true;
  }
  if (method === "turn/plan/updated") {
    const id = `plan-${params.turnId}`;
    const key = itemKey(params.threadId, params.turnId, id);
    transientMap(model, "turnPlans").set(key, {
      id,
      type: "turnPlan",
      plan: params.plan ?? [],
      explanation: params.explanation ?? null,
      _threadId: params.threadId,
      _turnId: params.turnId,
      _key: key,
      _live: true,
    });
    return true;
  }
  if (method === "turn/diff/updated") {
    const id = `diff-${params.turnId}`;
    const key = itemKey(params.threadId, params.turnId, id);
    transientMap(model, "turnDiffs").set(key, {
      id,
      type: "turnDiff",
      diff: params.diff ?? "",
      _threadId: params.threadId,
      _turnId: params.turnId,
      _key: key,
      _live: true,
    });
    return true;
  }
  if (method === "item/agentMessage/delta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "agentMessage", text: "", phase: null }, params.turnId);
    item.text = `${item.text ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/plan/delta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "plan", text: "" }, params.turnId);
    item.text = `${item.text ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "reasoning", summary: [], content: [] }, params.turnId);
    item.summary ??= [];
    item.summary[params.summaryIndex ?? 0] = `${item.summary[params.summaryIndex ?? 0] ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/reasoning/textDelta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "reasoning", summary: [], content: [] }, params.turnId);
    item.content ??= [];
    item.content[params.contentIndex ?? 0] = `${item.content[params.contentIndex ?? 0] ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/commandExecution/outputDelta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "commandExecution", command: "Command", status: "inProgress", aggregatedOutput: "" }, params.turnId);
    item.aggregatedOutput = `${item.aggregatedOutput ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/fileChange/patchUpdated") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "fileChange", status: "inProgress", changes: [] }, params.turnId);
    item.changes = params.changes ?? item.changes;
    return true;
  }
  if (method === "item/fileChange/outputDelta") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "fileChange", status: "inProgress", changes: [], output: "" }, params.turnId);
    item.output = `${item.output ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/mcpToolCall/progress") {
    const item = liveItem(model, params.threadId, params.itemId, { type: "mcpToolCall", status: "inProgress", arguments: {} }, params.turnId);
    item.progress = `${item.progress ?? ""}${params.message ?? params.delta ?? ""}`;
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
    return true;
  }
  if (method === "turn/completed") {
    const turnId = params.turn?.id ?? params.turnId;
    if (turnId) clearTurnTransient(model, params.threadId, turnId);
    return true;
  }
  return false;
}

export function canonicalTimeline(thread, model, { limit = 240 } = {}) {
  const threadId = thread?.id;
  const replay = (thread?.turns ?? []).flatMap((turn) => {
    const items = (turn.items ?? []).map((item) => {
      const key = itemKey(threadId, turn.id, item.id);
      return { ...item, _threadId: threadId, _turnId: turn.id, _key: key, _live: false };
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
  const live = transient.filter((item) => item._threadId === threadId && !authoritativeTurnIds.has(item._turnId) && !replayIds.has(item._key));
  const errorIds = new Set(replay.map((item) => item._key));
  const errors = [...model.turnErrors.values()].filter((item) => item._threadId === threadId && !authoritativeTurnIds.has(item._turnId) && !errorIds.has(item._key));
  return [...replay, ...live, ...errors].slice(-limit);
}

export function boundedText(value, maximum = 20_000) {
  const text = String(value ?? "");
  if (text.length <= maximum) return { text, truncated: false, omitted: 0 };
  return { text: text.slice(0, maximum), truncated: true, omitted: text.length - maximum };
}

export function turnIsLive(turn) {
  return LIVE_STATUSES.has(turn?.status?.type ?? turn?.status);
}
