// When the Sidebar lists a brand-new Chat.
//
// The real Codex 0.149.0 app-server lists a Thread in thread/list only once
// its first userMessage item is durable in its rollout: probed on the
// installed binary, thread/status/changed { active } and turn/started arrive
// in the same millisecond, the userMessage item/started and item/completed
// follow about 0.4 s later, and the first thread/list that carries the
// Thread was issued about 1.2 s after turn/started (a list issued at
// turn/started answers without it); at turn/completed it is listed idle.
// The fixture app-server mirrors that delay now.
//
// So turn/started is not the cue to refresh the lists from, and neither is
// thread/status/changed { active }, which lands before the durable write.
// The refresh fires on the userMessage item/completed of the watched Thread
// (and on its turn/completed, when it is still unlisted by then), backed by
// a bounded retry after turn/started that stops the moment a bootstrap lists
// the Thread: at most LISTING_RETRY_ATTEMPTS refreshes, each scheduled
// LISTING_RETRY_DELAY_MS after the previous one settled, never a perpetual
// poll. Meanwhile the record this browser already holds for the Thread (the
// thread/start answer) stays in the lists as a provisional row carrying the
// status the runtime last reported, so the live dot shows from turn/started
// and settles on turn/completed; a bootstrap that lists the Thread replaces
// the row with the host's own record. A Thread the browser holds no record
// for (another client's) is refreshed for, never drawn.

export const LISTING_RETRY_ATTEMPTS = 4;
export const LISTING_RETRY_DELAY_MS = 750;
const WATCH_LIMIT = 16;

export function threadStatusType(status) {
  return String(status?.type ?? status ?? "").toLowerCase();
}

export function threadIsActive(thread) {
  return threadStatusType(thread?.status).includes("active");
}

// The refresh cue one app-server notification is for a watched Thread, or
// null: the durable userMessage (item/completed, type userMessage) and the
// Turn's completion. thread/status/changed is deliberately none of them.
export function listingCue(method, params = {}) {
  if (typeof params?.threadId !== "string") return null;
  if (method === "item/completed" && params.item?.type === "userMessage") return "userMessage durable";
  if (method === "turn/completed") return "turn completed";
  return null;
}

export function createListingWatch({ attempts = LISTING_RETRY_ATTEMPTS, delayMs = LISTING_RETRY_DELAY_MS } = {}) {
  // threadId -> { record, attemptsLeft, refreshes }, in watch order.
  const watched = new Map();
  return {
    attempts,
    delayMs,
    has: (threadId) => watched.has(threadId),
    size: () => watched.size,
    ids: () => [...watched.keys()],
    // Watch an unlisted Thread the runtime reported a Turn for. `record` is
    // the Thread record this browser already holds (null when it holds
    // none); a watch that already exists keeps its retry budget and only
    // adopts a record it lacked.
    watch(threadId, record = null) {
      if (typeof threadId !== "string" || !threadId) return null;
      const entry = watched.get(threadId) ?? { record: null, attemptsLeft: attempts, refreshes: 0 };
      if (record && !entry.record) entry.record = record;
      watched.delete(threadId);
      watched.set(threadId, entry);
      while (watched.size > WATCH_LIMIT) watched.delete(watched.keys().next().value);
      return entry;
    },
    record: (threadId) => watched.get(threadId)?.record ?? null,
    // The provisional records, oldest watch first, for lists that lack them.
    provisional: () => [...watched.values()].map((entry) => entry.record).filter(Boolean),
    // One notification: the cue it is for a watched Thread, or null.
    cue(method, params = {}) {
      const cue = listingCue(method, params);
      return cue && watched.has(params.threadId) ? cue : null;
    },
    // Take one retry for a watched Thread: its number and the delay before
    // it, or null once the budget is spent or the watch has ended.
    nextRetry(threadId) {
      const entry = watched.get(threadId);
      if (!entry || entry.attemptsLeft <= 0) return null;
      entry.attemptsLeft -= 1;
      return { attempt: attempts - entry.attemptsLeft, remaining: entry.attemptsLeft, delayMs };
    },
    // A bootstrap answered with these Thread ids: every watched Thread among
    // them is settled (the host's record wins, the watch ends); the rest stay
    // watched, their refresh counted.
    settle(listedIds) {
      const listed = new Set(listedIds ?? []);
      const settled = [];
      const pending = [];
      for (const [threadId, entry] of watched) {
        if (listed.has(threadId)) {
          watched.delete(threadId);
          settled.push(threadId);
        } else {
          entry.refreshes += 1;
          pending.push(threadId);
        }
      }
      return { settled, pending };
    },
    refreshes: (threadId) => watched.get(threadId)?.refreshes ?? 0,
    drop(threadId) {
      return watched.delete(threadId);
    },
    clear() {
      watched.clear();
    },
  };
}

// The lists after a bootstrap, with every provisional record the bootstrap
// did not list placed at the head of `threads` and `recents`, where newThread
// put it; a record the host listed is never duplicated.
export function withProvisionalThreads({ threads = [], recents = [] }, watch) {
  const listed = new Set(threads.map((thread) => thread.id));
  const missing = watch.provisional().filter((record) => !listed.has(record.id)).reverse();
  if (!missing.length) return { threads, recents };
  return { threads: [...missing, ...threads], recents: [...missing, ...recents] };
}

// thread/status/changed { threadId, status } applied to every local record of
// that Thread: the runtime's own status report, so a row's dot follows it
// without a refresh. Returns whether any record changed.
export function applyThreadStatus(lists, threadId, status) {
  if (typeof threadId !== "string" || status == null) return false;
  let changed = false;
  for (const thread of lists) {
    if (thread?.id !== threadId) continue;
    if (JSON.stringify(thread.status ?? null) === JSON.stringify(status)) continue;
    thread.status = status;
    changed = true;
  }
  return changed;
}
