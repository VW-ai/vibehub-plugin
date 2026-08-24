// Review-only surface of the fork chat proposal (docs/proposals/fork-chat).
// The lineage projections the proposal reviewed — source resolution, fork
// listing, placement, shared-Turn-prefix divergence and the Bring Back quote
// — shipped as production behavior and live in fork-lineage.mjs; they are
// re-exported here so the review fixtures and their tests keep reading the
// same functions the production shell runs. What stays review-only is the
// sidebar fork tree (Direction B), held by the owner's decision for its
// recency-reorder cost: it mounts only under the ?forkFixture gate.

export { bringBackQuote, divergenceNote, forksOf, placementNote, resolveLineage, sharedTurnPrefix } from "./fork-lineage.mjs";

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
