// Turn completion notices. A turn/completed the human is not looking at (a
// Thread off the active route, or an unfocused window) is noticed exactly
// once per Turn id, however many times the event feed delivers it (live,
// then replayed after a reconnect): an in-app notice always, and a browser
// Notification when the preference allows it and permission was granted.
// The preference is host session state (setNotificationPreference), read
// from bootstrap.preferences and absent after a host restart; nothing here
// touches browser storage.

export const NOTIFICATION_MODE_LABELS = Object.freeze({ always: "Always", unfocused: "Only when unfocused", never: "Never" });

// always: every completion off the active route or while unfocused also
// raises a browser Notification; unfocused: the browser Notification only
// while the window is unfocused; never: nothing, not even in-app.
export function completionDecision({ mode, onActiveRoute, focused }) {
  if (mode === "never") return { notice: false, browser: false };
  const background = !onActiveRoute || !focused;
  if (!background) return { notice: false, browser: false };
  return { notice: true, browser: mode === "always" || !focused };
}

export function createCompletionNotifier({ limit = 256 } = {}) {
  const seen = new Set();
  return {
    has: (turnId) => seen.has(turnId),
    // True the first time a Turn id is offered, false for every later delivery.
    claim(turnId) {
      if (!turnId || seen.has(turnId)) return false;
      seen.add(turnId);
      while (seen.size > limit) seen.delete(seen.values().next().value);
      return true;
    },
    size: () => seen.size,
  };
}

export function browserNotification({ title, body, tag }, NotificationClass = globalThis.Notification) {
  if (typeof NotificationClass !== "function" || NotificationClass.permission !== "granted") return null;
  try {
    return new NotificationClass(title, { body, tag });
  } catch {
    return null;
  }
}

// One turn/completed through the dedupe and the preference: the notice text
// and the Notification built, or nulls when nothing is due.
export function noticeForCompletion(notifier, params, { mode, activeThreadId, route, focused, threadTitle, NotificationClass = globalThis.Notification }) {
  const turnId = params?.turn?.id ?? params?.turnId ?? null;
  const threadId = params?.threadId ?? null;
  if (!turnId || !threadId || !notifier.claim(turnId)) return { notice: null, notification: null, turnId, threadId };
  const onActiveRoute = ["chat", "task"].includes(route) && threadId === activeThreadId;
  const decision = completionDecision({ mode, onActiveRoute, focused });
  if (!decision.notice) return { notice: null, notification: null, turnId, threadId };
  const title = threadTitle ?? `Chat ${String(threadId).slice(0, 8)}…`;
  const status = params.turn?.status ?? "completed";
  const notice = `Codex ${status === "completed" ? "finished" : status} a Turn in ${title}`;
  const notification = decision.browser ? browserNotification({ title: "Codex finished a Turn", body: title, tag: turnId }, NotificationClass) : null;
  return { notice, notification, turnId, threadId };
}
