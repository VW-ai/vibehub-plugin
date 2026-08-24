// Review-only projections for the fork chat interaction proposal
// (docs/proposals/fork-chat/README.md). Everything here derives from data the
// pinned 0.149.0 protocol already persists — Thread.forkedFromId on every
// thread/read and thread/list row, Thread.section for placement, and the
// replayed Turn ids a fork shares with its source — so no direction below
// needs a browser-side registry or any new durable record. The shell mounts
// these projections only under the ?forkFixture review gate; production fork
// behavior is untouched.

// --- Lineage resolution (Direction A: navigable source chip) ---------------
// Canonical data: the active Thread's forkedFromId (thread/read) and the
// listed Thread records of this folder (thread/list via bootstrap). A source
// that is not in the lists is reported missing, never invented: it may be
// archived, in another folder, or deleted, and the chip must say it cannot
// navigate rather than fabricate a title.
export function resolveLineage(thread, threads) {
  const sourceId = thread?.forkedFromId ?? null;
  if (!sourceId) return null;
  const source = threads.find((entry) => entry.id === sourceId) ?? null;
  return { sourceId, source, missing: !source };
}

// Forks of one Thread, from the same listed records: every row whose
// forkedFromId names it, newest last so the listing reads as history.
export function forksOf(threadId, threads) {
  return threads
    .filter((entry) => entry.forkedFromId === threadId)
    .sort((left, right) => String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? "")));
}

// Placement divergence, derived from canonical section membership alone: the
// adapter places a fork in its source's group and reports a fallback when the
// race loses (placement.applied=false in the forkThread response), but that
// response is transient. What survives is the memberships themselves, so the
// honest durable statement is a comparison of the two Thread.section values.
export function placementNote(thread, source) {
  if (!source) return null;
  const forkGroup = thread?.project ?? null;
  const sourceGroup = source?.project ?? null;
  if ((forkGroup?.id ?? null) === (sourceGroup?.id ?? null)) return null;
  const name = (group) => (group ? `the ${group.name} group` : "Recents");
  return `This fork lives in ${name(forkGroup)}; its source lives in ${name(sourceGroup)}.`;
}

// The divergence point, derived instead of invented: thread/fork replays the
// source's Turns into the fork with their ids, so the shared prefix of Turn
// ids is exactly what the fork inherited. The protocol does not persist the
// lastTurnId a fork was cut at, and this derivation needs both transcripts
// read (thread/read on the open pair) — both facts the proposal states.
export function sharedTurnPrefix(fork, source) {
  const forkTurns = fork?.turns ?? [];
  const sourceTurns = source?.turns ?? [];
  let shared = 0;
  while (shared < forkTurns.length && shared < sourceTurns.length && forkTurns[shared].id === sourceTurns[shared].id) shared += 1;
  return { shared, sourceTotal: sourceTurns.length, diverged: forkTurns.length > shared };
}

// --- Sidebar fork tree (Direction B: grouped, indented presentation) -------
// Canonical data: forkedFromId on every listed row of one Sidebar list.
// A fork nests under its source only when the source row is in the same
// visible list; a fork whose source is elsewhere stays a flat row, because a
// tree that invents placeholder parents would claim history this folder's
// listing does not carry. Depth is capped so a long chain stays readable;
// rows keep list order semantics (DOM order = reading order = tab order).
export const FORK_TREE_MAX_DEPTH = 3;

export function forkTreeRows(threads) {
  const listed = new Set(threads.map((thread) => thread.id));
  const children = new Map();
  const roots = [];
  for (const thread of threads) {
    const parentId = thread.forkedFromId && listed.has(thread.forkedFromId) ? thread.forkedFromId : null;
    if (parentId) {
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(thread);
    } else {
      roots.push(thread);
    }
  }
  const rows = [];
  const visit = (thread, depth) => {
    rows.push({ thread, depth: Math.min(depth, FORK_TREE_MAX_DEPTH) });
    for (const child of children.get(thread.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return rows;
}

// --- Bring Back (Direction C: return a fork's result to its source) --------
// Canonical carrier: the shipped quote machinery. The selected passage
// becomes the source Chat's composer quote whose identity names the FORK's
// Thread, Turn and item — exactly what quote-source.mjs serializes into the
// Turn input and what buildOrigin records for the explicit VibeHub bridge.
// Nothing is written anywhere by composing; the explicit send stays with the
// human, and in a review fixture the send is refused, so no model is spent.
export function bringBackQuote({ fork, turnId, itemId, itemKey = null, text }) {
  const clean = String(text ?? "").trim();
  if (!fork?.forkedFromId || !clean || !turnId || !itemId) return null;
  return {
    targetThreadId: fork.forkedFromId,
    quote: {
      text: clean.slice(0, 4_000),
      itemKey,
      threadId: fork.id,
      turnId,
      itemId,
    },
  };
}
