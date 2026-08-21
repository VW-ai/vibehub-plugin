const LIVE_STATUSES = new Set(["inProgress", "running"]);

function liveItem(model, itemId, fallback, turnId) {
  if (!model.liveItems.has(itemId)) {
    model.liveItems.set(itemId, { id: itemId, ...fallback, _turnId: turnId, _live: true });
  }
  const item = model.liveItems.get(itemId);
  if (turnId && !item._turnId) item._turnId = turnId;
  return item;
}

export function applyChatEvent(model, method, params = {}) {
  if (!model?.liveItems || !model?.turnErrors) throw new TypeError("Chat model requires liveItems and turnErrors Maps");
  if (method === "item/started") {
    model.liveItems.set(params.item.id, { ...params.item, _turnId: params.turnId, _live: true });
    return true;
  }
  if (method === "item/completed") {
    model.liveItems.set(params.item.id, { ...params.item, _turnId: params.turnId, _live: false });
    return true;
  }
  if (method === "item/agentMessage/delta") {
    const item = liveItem(model, params.itemId, { type: "agentMessage", text: "", phase: null }, params.turnId);
    item.text = `${item.text ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/plan/delta") {
    const item = liveItem(model, params.itemId, { type: "plan", text: "" }, params.turnId);
    item.text = `${item.text ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const item = liveItem(model, params.itemId, { type: "reasoning", summary: [], content: [] }, params.turnId);
    item.summary ??= [];
    item.summary[params.summaryIndex ?? 0] = `${item.summary[params.summaryIndex ?? 0] ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/reasoning/textDelta") {
    const item = liveItem(model, params.itemId, { type: "reasoning", summary: [], content: [] }, params.turnId);
    item.content ??= [];
    item.content[params.contentIndex ?? 0] = `${item.content[params.contentIndex ?? 0] ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/commandExecution/outputDelta") {
    const item = liveItem(model, params.itemId, { type: "commandExecution", command: "Command", status: "inProgress", aggregatedOutput: "" }, params.turnId);
    item.aggregatedOutput = `${item.aggregatedOutput ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/fileChange/patchUpdated") {
    const item = liveItem(model, params.itemId, { type: "fileChange", status: "inProgress", changes: [] }, params.turnId);
    item.changes = params.changes ?? item.changes;
    return true;
  }
  if (method === "item/mcpToolCall/progress") {
    const item = liveItem(model, params.itemId, { type: "mcpToolCall", status: "inProgress", arguments: {} }, params.turnId);
    item.progress = `${item.progress ?? ""}${params.message ?? params.delta ?? ""}`;
    return true;
  }
  if (method === "error") {
    const turnId = params.turnId ?? "unknown";
    model.turnErrors.set(turnId, {
      type: "turnError",
      id: `error-${turnId}`,
      _turnId: turnId,
      message: params.error?.message ?? params.error ?? "Codex encountered an error.",
      willRetry: Boolean(params.willRetry),
    });
    return true;
  }
  return false;
}

export function canonicalTimeline(thread, model, { limit = 240 } = {}) {
  const replay = (thread?.turns ?? []).flatMap((turn) => {
    const items = (turn.items ?? []).map((item) => ({ ...item, _turnId: turn.id, _live: false }));
    if (["interrupted", "failed"].includes(turn.status)) {
      items.push({
        type: "turnBoundary",
        id: `boundary-${turn.id}`,
        _turnId: turn.id,
        status: turn.status,
        message: turn.error?.message,
        _live: false,
      });
    }
    return items;
  });
  const replayIds = new Set(replay.map((item) => item.id));
  const live = [...model.liveItems.values()].filter((item) => !replayIds.has(item.id));
  const errorIds = new Set(replay.map((item) => item.id));
  const errors = [...model.turnErrors.values()].filter((item) => !errorIds.has(item.id));
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
