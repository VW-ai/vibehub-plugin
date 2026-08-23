// A Thread's name as the runtime reports it. The host titles a listed Thread
// by its name, then the first preview line, then a fallback; the browser
// applies thread/name/updated (and the setThreadName response) the same way
// so every surface shows the runtime's own name without a refresh.

export function threadTitleFromName(name, preview) {
  const clean = name == null ? "" : String(name);
  if (clean) return clean;
  const firstLine = String(preview ?? "").split("\n")[0]?.slice(0, 72) ?? "";
  return firstLine || "Untitled chat";
}

// The same record with its name and title replaced; null clears the name.
export function renameThreadRecord(thread, threadName) {
  const name = threadName == null ? null : String(threadName);
  return { ...thread, name, title: threadTitleFromName(name, thread?.preview) };
}
