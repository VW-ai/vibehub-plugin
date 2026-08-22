// Selection-preserving reconciliation policy for the keyed transcript.
//
// The mounted node of any entry the live user selection touches is never
// replaced or removed while that selection exists; its fresh markup waits
// until the selection ends. Every other entry patches immediately, so a
// streaming Turn keeps flowing around the selected passage instead of pausing
// the whole paint on a timer and then destroying the selection anyway.
export function planTimelineReconciliation(currentEntries, nextEntries, protectedKeys = new Set()) {
  const current = new Map(currentEntries.map((entry) => [entry.key, entry]));
  const nextKeys = new Set(nextEntries.map((entry) => entry.key));
  const plan = { order: nextEntries.map((entry) => entry.key), mount: [], replace: [], keep: [], defer: [], remove: [] };
  for (const next of nextEntries) {
    const existing = current.get(next.key);
    if (!existing) plan.mount.push(next.key);
    else if (existing.html === next.html) plan.keep.push(next.key);
    else if (protectedKeys.has(next.key)) plan.defer.push(next.key);
    else plan.replace.push(next.key);
  }
  for (const key of current.keys()) {
    if (nextKeys.has(key)) continue;
    if (protectedKeys.has(key)) plan.defer.push(key);
    else plan.remove.push(key);
  }
  return plan;
}
