// The browser query carries the visible Thread so a reload recovers it after
// in-app navigation. This is navigation state on the URL itself, not storage:
// history.replaceState never touches localStorage, IndexedDB or a second store.
export function threadLocation(href, threadId) {
  const url = new URL(href);
  if (threadId) url.searchParams.set("thread", String(threadId));
  else url.searchParams.delete("thread");
  return url.href;
}
