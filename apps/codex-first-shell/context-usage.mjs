// Context use of a Thread, computed only from thread/tokenUsage/updated
// (chat-model.mjs applyTokenUsage): the last total.totalTokens against
// modelContextWindow. No value exists before the first notification, and no
// percentage while the runtime reports no window.

const formatCount = (value) => Number(value).toLocaleString("en-US");

export function contextUsage(record) {
  if (!record || !Number.isFinite(record.totalTokens)) {
    return { state: "unknown", totalTokens: null, modelContextWindow: null, percent: null, label: "Context use not reported yet", detail: "The runtime reports token usage inside each Turn; nothing has been reported for this Chat in this session." };
  }
  const total = record.totalTokens;
  if (!Number.isFinite(record.modelContextWindow) || record.modelContextWindow <= 0) {
    return { state: "no-window", totalTokens: total, modelContextWindow: null, percent: null, label: `Context ${formatCount(total)} tokens · window not reported`, detail: "The runtime reported the total without a model context window, so no share can be shown." };
  }
  const window = record.modelContextWindow;
  const percent = Math.min(999, Math.round((total / window) * 100));
  return { state: "known", totalTokens: total, modelContextWindow: window, percent, label: `Context ${percent}% · ${formatCount(total)} of ${formatCount(window)} tokens`, detail: `Last reported by Turn ${record.turnId ?? "unknown"}.` };
}

export function compactDisabledReason({ running, fixture, runtimeAlive }) {
  if (fixture) return "Review fixture only: nothing to compact.";
  if (!runtimeAlive) return "Compaction needs the runtime.";
  if (running) return "Wait for the running Turn to complete, or interrupt it, before compacting.";
  return null;
}
