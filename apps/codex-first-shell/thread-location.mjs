// The browser query carries the visible Thread and, on the Task Workspace, the
// focused Task so a reload recovers the same surface after in-app navigation.
// This is navigation state on the URL itself, not a persistence authority:
// history.replaceState writes no browser store, and the Task id only names a
// checked-in Ticket the host re-reads on landing.
export function threadLocation(href, threadId, ticketId = null) {
  const url = new URL(href);
  if (threadId) url.searchParams.set("thread", String(threadId));
  else url.searchParams.delete("thread");
  if (ticketId) url.searchParams.set("task", String(ticketId));
  else url.searchParams.delete("task");
  return url.href;
}
