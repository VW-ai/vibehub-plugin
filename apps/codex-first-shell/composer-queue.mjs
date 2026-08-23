// The host-owned follow-up queue as the browser mirrors it. Every record here
// is the host's own queueRecord (docs/proposals/codex-chat-conformance/
// daily-use-host-contract.json): bootstrap.queues and the queueChanged event
// carry elided media, listQueue and the queue actions carry the full input.
// Nothing is persisted in the browser; a host restart empties every queue.

export const QUEUE_PAUSE_MESSAGES = Object.freeze({
  interrupted: "Queue paused because you interrupted.",
  turn_failed: "Queue paused because the Turn failed.",
  runtime_exited: "Queue paused because the Codex app-server exited.",
  start_failed: "Queue paused because the next follow-up could not start.",
});

export function emptyQueue(threadId) {
  return { threadId, paused: false, pausedReason: null, lastError: null, limit: 20, items: [] };
}

function elided(input) {
  return (input ?? []).some((item) => item?.elided === true);
}

// Keep the full media bytes a prior read carried when the next record (an
// event-feed projection) elides them for the same queued follow-up.
export function mergeQueueRecord(prior, next) {
  if (!next) return prior ?? null;
  const priorItems = new Map((prior?.items ?? []).map((item) => [item.queuedId, item]));
  return {
    ...next,
    items: (next.items ?? []).map((item) => {
      const before = priorItems.get(item.queuedId);
      const keepPrior = before && elided(item.input) && !elided(before.input) && before.input.length === item.input.length;
      return keepPrior ? { ...item, input: before.input } : item;
    }),
  };
}

export function queuedText(item) {
  return (item?.input ?? []).filter((entry) => entry.type === "text").map((entry) => entry.text).join("\n");
}

// A one-line account of the non-text inputs a queued follow-up carries.
export function queuedMediaSummary(item) {
  const counts = new Map();
  for (const entry of item?.input ?? []) {
    if (entry.type === "text") continue;
    counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  }
  return [...counts].map(([type, count]) => `${count} ${type}${count === 1 ? "" : "s"}`).join(" · ");
}

// The edited text replaces the follow-up's text input; every other input
// (images, audio, mentions, skills) travels unchanged. A follow-up that had no
// text input gains one in front. `elements` are the text_elements recomputed
// over the edited text by the caller (null when none apply): the old byte
// ranges never survive an edit.
export function replaceQueuedText(input, text, elements = null) {
  const clean = String(text ?? "");
  const items = (input ?? []).filter((entry) => entry.type !== "text");
  if (!clean.trim()) return items;
  const textItem = elements?.length ? { type: "text", text: clean, text_elements: elements } : { type: "text", text: clean };
  return [textItem, ...items];
}

export function pausedMessage(queue) {
  if (!queue?.paused) return "";
  const base = QUEUE_PAUSE_MESSAGES[queue.pausedReason] ?? `Queue paused (${queue.pausedReason ?? "unknown reason"}).`;
  const detail = queue.pausedReason === "start_failed" && queue.lastError?.message ? ` ${queue.lastError.message}` : "";
  return `${base}${detail} Nothing is sent until you resume.`;
}
