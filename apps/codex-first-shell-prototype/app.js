const state = {
  route: "chat",
  bootstrap: null,
  threads: [],
  activeThreadId: null,
  activeThread: null,
  activeTicketId: null,
  activeTask: null,
  activeContextId: null,
  eventCursor: 0,
  pendingRequests: [],
  running: false,
  currentTurnId: null,
  attachments: [],
  recorder: null,
  recordingStream: null,
  themeIndex: 0,
  searchResults: [],
  searchIndex: 0,
  overlayReturnFocus: null,
  attentionInitialized: false,
  initialCompletionKeys: new Set(),
  unreadCompletionKeys: new Set(),
  attentionPollCounter: 0,
  liveItems: new Map(),
  turnErrors: new Map(),
  chatRenderFrame: 0,
  fixtureMode: false,
  creatingThread: null,
};

const token = location.hash.slice(1);
const reviewFrame = new URLSearchParams(location.search).get("reviewFrame");
if (reviewFrame === "narrow") document.body.dataset.reviewFrame = "narrow";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const surface = $("#surface");
const composerWrap = $("#composerWrap");
const routeTitle = $("#routeTitle");
const routeMeta = $("#routeMeta");
const backButton = $("#backButton");
const appShell = $("#appShell");
const toast = $("#toast");
let toastTimer;
let pollTimer;
let graphResizeFrame;

window.addEventListener("resize", () => {
  if (state.route !== "tasks") return;
  cancelAnimationFrame(graphResizeFrame);
  graphResizeFrame = requestAnimationFrame(renderGraphEdges);
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const envelope = await response.json();
  if (!response.ok || !envelope.ok) throw new Error(envelope.error?.message ?? `Request failed (${response.status})`);
  return envelope.data;
}

const action = (payload) => api("/api/action", { method: "POST", body: JSON.stringify(payload) });

function titleForThread(thread) {
  if (thread.taskLink) return humanize(thread.taskLink.ticketId);
  return thread.title || "Untitled chat";
}

function humanize(ticketId) {
  return String(ticketId).replace(/^ticket-/, "").split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function updateSidebar() {
  const list = $("#threadList");
  const needsYou = state.bootstrap?.attention?.needsYou ?? [];
  const attention = $("#sidebarAttention");
  attention.hidden = needsYou.length === 0;
  $("#sidebarAttentionList").innerHTML = needsYou.slice(0, 3).map((item) => `<button class="attention-item" type="button" data-ticket-id="${escapeHtml(item.ticketId)}"><i></i><span><strong>${escapeHtml(humanize(item.ticketId))}</strong><small>Task · Needs you</small></span></button>`).join("");
  if (!state.threads.length) {
    list.innerHTML = '<p class="muted">No Codex chats in this Project yet.</p>';
    return;
  }
  list.innerHTML = state.threads.map((thread) => {
    const active = thread.id === state.activeThreadId;
    const runtimeActive = String(thread.status?.type ?? thread.status ?? "").toLowerCase().includes("active");
    return `<button class="thread-button${active ? " active" : ""}" type="button" data-thread-id="${escapeHtml(thread.id)}">
      <i class="thread-state${runtimeActive ? " active" : ""}"></i>
      <span><strong>${escapeHtml(titleForThread(thread))}</strong><small>${escapeHtml(thread.taskLink ? "VibeHub Task · Codex Thread" : (thread.preview || "Codex Thread").slice(0, 54))}</small></span>
      ${thread.taskLink ? "<em>TASK</em>" : ""}
    </button>`;
  }).join("");

}

function completionKey(item) {
  return `${item.ticketId}:${item.closedAt}`;
}

function updateAttentionState(nextAttention) {
  const keys = new Set((nextAttention?.recentCompletions ?? []).map(completionKey));
  if (!state.attentionInitialized) {
    state.initialCompletionKeys = keys;
    state.attentionInitialized = true;
  } else {
    for (const key of keys) {
      if (!state.initialCompletionKeys.has(key)) state.unreadCompletionKeys.add(key);
    }
  }
  updateInboxBadge();
}

function updateInboxBadge() {
  const currentNeedsYou = state.bootstrap?.attention?.needsYou?.length ?? 0;
  const count = currentNeedsYou + state.unreadCompletionKeys.size;
  const badge = $("#inboxBadge");
  badge.hidden = count === 0;
  $("#inboxButton").setAttribute("aria-label", count ? `Open Task inbox, ${count} items need attention` : "Open Task inbox");
}

function setRouteHeader(title, meta, { back = false } = {}) {
  routeTitle.textContent = title;
  routeMeta.textContent = meta;
  backButton.hidden = !back;
}

function setRoute(route) {
  state.route = route;
  appShell.classList.remove("sidebar-open");
  const activeRoute = route === "task" ? "tasks" : route;
  $$('[data-route]', $("#sidebar")).forEach((button) => button.classList.toggle("active", button.dataset.route === activeRoute));
  composerWrap.hidden = route !== "chat";
  if (route === "chat") renderChat();
  else if (route === "tasks") renderTasks();
  else if (route === "task") renderTaskWorkspace();
  else renderRooms();
}

function syncScrim() {
  $("#scrim").hidden = $("#searchDialog").hidden && $("#inboxPanel").hidden && $("#reviewPanel").hidden;
}

function searchCorpus(query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const includes = (...values) => {
    const haystack = values.map((value) => String(value ?? "")).join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
  const chats = state.threads
    .filter((thread) => includes(titleForThread(thread), thread.preview, thread.id))
    .slice(0, 6)
    .map((thread) => ({ kind: "chat", id: thread.id, title: titleForThread(thread), detail: thread.preview || "Codex Thread", glyph: "C" }));
  const tasks = (state.bootstrap?.graph.tickets ?? [])
    .filter((ticket) => includes(ticket.ticketId, ticket.outcome, ticket.capabilities.nextAction.summary.action))
    .slice(0, 8)
    .map((ticket) => ({ kind: "task", id: ticket.ticketId, title: humanize(ticket.ticketId), detail: ticket.outcome, glyph: "T" }));
  const contexts = (state.bootstrap?.contexts ?? [])
    .filter((context) => includes(context.contextId, context.summary, context.detail, ...(context.tags ?? [])))
    .slice(0, 6)
    .map((context) => ({ kind: "context", id: context.contextId, title: context.summary, detail: `${context.room} · ${context.type}`, glyph: "◇" }));
  return [...chats, ...tasks, ...contexts];
}

function renderSearchResults() {
  state.searchResults = searchCorpus($("#searchInput").value);
  state.searchIndex = Math.min(state.searchIndex, Math.max(0, state.searchResults.length - 1));
  const groups = [
    ["chat", "Chats"],
    ["task", "Tasks"],
    ["context", "Context"],
  ];
  const markup = groups.map(([kind, label]) => {
    const matches = state.searchResults.filter((item) => item.kind === kind);
    if (!matches.length) return "";
    return `<div class="search-group-label">${label}</div>${matches.map((item) => {
      const index = state.searchResults.indexOf(item);
      return `<button class="search-result" type="button" role="option" aria-selected="${index === state.searchIndex}" data-search-kind="${item.kind}" data-search-id="${escapeHtml(item.id)}"><i>${item.glyph}</i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span><em>${kind === "chat" ? "Chat" : kind === "task" ? "Task" : "Context"}</em></button>`;
    }).join("")}`;
  }).join("");
  $("#searchResults").innerHTML = markup || '<div class="search-empty">No matching Chat, Task, or Context.</div>';
  $(".search-result[aria-selected=\"true\"]")?.scrollIntoView({ block: "nearest" });
}

function openSearch() {
  closeInbox(false);
  state.overlayReturnFocus = document.activeElement;
  const dialog = $("#searchDialog");
  dialog.hidden = false;
  dialog.inert = false;
  $("#searchInput").value = "";
  state.searchIndex = 0;
  renderSearchResults();
  syncScrim();
  requestAnimationFrame(() => $("#searchInput").focus());
}

function closeSearch(restore = true) {
  const dialog = $("#searchDialog");
  if (dialog.hidden) return;
  dialog.hidden = true;
  dialog.inert = true;
  syncScrim();
  if (restore) state.overlayReturnFocus?.focus?.();
}

function formatWhen(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Recorded" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function renderInbox() {
  const attention = state.bootstrap?.attention ?? { needsYou: [], recentCompletions: [] };
  const needs = attention.needsYou.map((item) => `<button class="inbox-row needs-you" type="button" data-ticket-id="${escapeHtml(item.ticketId)}"><i></i><span><strong>${escapeHtml(humanize(item.ticketId))}</strong><small>Needs your explicit decision</small></span><em>Task</em></button>`).join("");
  const completed = attention.recentCompletions.map((item) => `<button class="inbox-row" type="button" data-ticket-id="${escapeHtml(item.ticketId)}"><i></i><span><strong>${escapeHtml(humanize(item.ticketId))}</strong><small>Successful Outcome · ${escapeHtml(formatWhen(item.closedAt))}</small></span><em>${state.unreadCompletionKeys.has(completionKey(item)) ? "New" : "History"}</em></button>`).join("");
  $("#inboxContent").innerHTML = `<section class="inbox-section"><header><span>Needs you</span><span>${attention.needsYou.length}</span></header>${needs || '<p class="inbox-empty">Nothing currently needs your decision.</p>'}</section><section class="inbox-section"><header><span>Recently completed</span><span>Repository history</span></header>${completed || '<p class="inbox-empty">No successful Outcomes yet.</p>'}</section>`;
}

function openInbox() {
  closeSearch(false);
  state.overlayReturnFocus = document.activeElement;
  renderInbox();
  const panel = $("#inboxPanel");
  panel.hidden = false;
  panel.inert = false;
  state.unreadCompletionKeys.clear();
  updateInboxBadge();
  syncScrim();
  $("#closeInbox").focus();
}

function closeInbox(restore = true) {
  const panel = $("#inboxPanel");
  if (panel.hidden) return;
  panel.hidden = true;
  panel.inert = true;
  syncScrim();
  if (restore) state.overlayReturnFocus?.focus?.();
}

async function openSearchResult(kind, id) {
  closeSearch(false);
  if (kind === "chat") await openThread(id);
  else if (kind === "task") await openTask(id);
  else {
    state.activeContextId = id;
    setRoute("rooms");
  }
}

function handoffFromText(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.kind === "vibehub_ticket_handoff" ? parsed : null;
  } catch {
    return null;
  }
}

function userInputText(content) {
  return (content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

function renderMarkdown(value) {
  const chunks = String(value ?? "").split(/```/);
  return chunks.map((chunk, index) => {
    if (index % 2) {
      const [language, ...lines] = chunk.replace(/^\n/, "").split("\n");
      const body = lines.length ? lines.join("\n") : language;
      const label = lines.length && language.trim() ? `<span>${escapeHtml(language.trim())}</span>` : "";
      return `<div class="code-block">${label}<pre><code>${escapeHtml(body)}</code></pre></div>`;
    }
    const blocks = [];
    let list = [];
    const flushList = () => {
      if (!list.length) return;
      blocks.push(`<ul>${list.map((line) => `<li>${inlineMarkdown(line)}</li>`).join("")}</ul>`);
      list = [];
    };
    for (const line of chunk.split("\n")) {
      if (/^[-*] /.test(line)) { list.push(line.slice(2)); continue; }
      flushList();
      if (!line.trim()) continue;
      const heading = line.match(/^(#{1,3})\s+(.+)/);
      if (heading) blocks.push(`<h${Math.min(4, heading[1].length + 1)}>${inlineMarkdown(heading[2])}</h${Math.min(4, heading[1].length + 1)}>`);
      else blocks.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    flushList();
    return blocks.join("");
  }).join("");
}

function statusLabel(item) {
  if (item._live) return "running";
  if (item.status) return String(item.status).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return "complete";
}

function disclosureCard({ kind, title, status, summary, detail = "", icon = "◇", open = false, extra = "" }) {
  return `<details class="activity-card ${kind}" ${open ? "open" : ""}><summary><i>${icon}</i><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(summary)}</small></span><em>${escapeHtml(status)}</em></summary>${detail ? `<div class="activity-detail">${detail}</div>` : ""}${extra}</details>`;
}

function userMediaMarkup(content) {
  return (content ?? []).filter((entry) => ["image", "localImage", "audio", "localAudio", "skill", "mention"].includes(entry.type)).map((entry) => {
    if (entry.type === "image" && String(entry.url).startsWith("data:image/")) return `<img class="message-image" src="${escapeHtml(entry.url)}" alt="Attached image">`;
    if (entry.type === "audio") return '<span class="message-attachment">◉ Audio attachment</span>';
    if (entry.type === "localImage") return `<span class="message-attachment">▧ ${escapeHtml(entry.path?.split("/").pop() ?? "Local image")}</span>`;
    if (entry.type === "localAudio") return `<span class="message-attachment">◉ ${escapeHtml(entry.path?.split("/").pop() ?? "Local audio")}</span>`;
    return `<span class="message-attachment">${entry.type === "skill" ? "$" : "@"}${escapeHtml(entry.name)}</span>`;
  }).join("");
}

function renderItem(item) {
  if (!item) return "";
  if (item.type === "userMessage") {
    const text = userInputText(item.content);
    const handoff = handoffFromText(text);
    if (handoff) return `<div class="turn user"><article class="item-card handoff"><header><strong>VibeHub Task</strong><span>${escapeHtml(handoff.nextAction?.action ?? handoff.operationalState)}</span></header><p><strong>${escapeHtml(humanize(handoff.ticketId))}</strong><br>${escapeHtml(handoff.outcome)}</p></article></div>`;
    const media = userMediaMarkup(item.content);
    return `<div class="turn user" data-item-id="${escapeHtml(item.id)}"><article>${text ? `<div>${renderMarkdown(text)}</div>` : ""}${media}</article></div>`;
  }
  if (item.type === "agentMessage") return `<div class="turn assistant" data-item-id="${escapeHtml(item.id)}"><span class="agent-mark">C</span><article class="agent-response${item._live ? " streaming" : ""}">${renderMarkdown(item.text)}<footer class="message-actions"><button type="button" data-copy-message="${escapeHtml(item.id)}">Copy</button><button type="button" disabled title="Planned VibeHub bridge">Remember</button><button type="button" disabled title="Planned VibeHub bridge">Make Task</button></footer></article></div>`;
  if (item.type === "reasoning") {
    const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
    return `<div class="activity-row">${disclosureCard({ kind: "reasoning", icon: "✦", title: "Reasoning", status: statusLabel(item), summary: item._live ? "Thinking…" : "Reasoning summary", detail: renderMarkdown(text || "Reasoned about the request") })}</div>`;
  }
  if (item.type === "plan") return `<div class="activity-row">${disclosureCard({ kind: "plan", icon: "☷", title: "Plan", status: statusLabel(item), summary: item._live ? "Updating plan…" : "Plan updated", detail: renderMarkdown(item.text), open: true })}</div>`;
  if (item.type === "commandExecution") {
    const detail = `<div class="command-meta">${escapeHtml(item.cwd ?? "")}</div><code class="command-line">${escapeHtml(item.command)}</code>${item.aggregatedOutput ? `<pre class="terminal-output">${escapeHtml(item.aggregatedOutput)}</pre>` : ""}`;
    const duration = item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : "";
    return `<div class="activity-row">${disclosureCard({ kind: "terminal", icon: ">_", title: "Terminal", status: statusLabel(item), summary: `${item.command || "Command"}${duration}`, detail, open: item._live || item.status === "failed" })}</div>`;
  }
  if (item.type === "fileChange") {
    const changes = item.changes ?? [];
    const detail = changes.map((change) => `<section class="diff-file"><header><strong>${escapeHtml(change.path)}</strong><span>${escapeHtml(change.kind?.type ?? change.kind ?? "update")}</span></header>${change.diff ? `<pre>${escapeHtml(change.diff)}</pre>` : ""}</section>`).join("");
    return `<div class="activity-row">${disclosureCard({ kind: "files", icon: "±", title: "File changes", status: statusLabel(item), summary: `${changes.length} file${changes.length === 1 ? "" : "s"}`, detail, open: item._live || item.status === "failed" })}</div>`;
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const name = item.tool ?? "Tool";
    const server = item.server ?? item.namespace ?? "Codex";
    const result = item.result?.content?.map((entry) => entry.text).filter(Boolean).join("\n") ?? item.contentItems?.map((entry) => entry.text ?? entry.content ?? "").join("\n") ?? item.error?.message ?? "";
    const detail = `<pre class="tool-arguments">${escapeHtml(JSON.stringify(item.arguments ?? {}, null, 2))}</pre>${result ? `<div class="tool-result">${renderMarkdown(result)}</div>` : ""}`;
    return `<div class="activity-row">${disclosureCard({ kind: "tool", icon: "◇", title: name, status: statusLabel(item), summary: `${server}${item.readOnlyHint ? " · read only" : ""}`, detail, open: item.status === "failed" })}</div>`;
  }
  if (item.type === "collabAgentToolCall") {
    const agents = Object.entries(item.agentsStates ?? {}).map(([id, value]) => `${id.slice(0, 8)} · ${value.status ?? value}`).join("\n");
    return `<div class="activity-row">${disclosureCard({ kind: "agents", icon: "⑂", title: "Delegated work", status: statusLabel(item), summary: `${item.receiverThreadIds?.length ?? 0} agent thread${item.receiverThreadIds?.length === 1 ? "" : "s"}`, detail: `${item.prompt ? `<p>${escapeHtml(item.prompt)}</p>` : ""}${agents ? `<pre>${escapeHtml(agents)}</pre>` : ""}`, open: item._live })}</div>`;
  }
  if (item.type === "subAgentActivity") return `<div class="timeline-divider"><span>⑂ ${escapeHtml(item.agentPath || "Agent")}</span><strong>${escapeHtml(item.kind?.type ?? item.kind ?? "activity")}</strong></div>`;
  if (item.type === "webSearch") return `<div class="activity-row">${disclosureCard({ kind: "search", icon: "⌕", title: "Web search", status: statusLabel(item), summary: item.query ?? item.action?.query ?? "Search activity", detail: item.result ? `<p>${escapeHtml(String(item.result))}</p>` : "" })}</div>`;
  if (item.type === "imageView") return `<div class="timeline-divider"><span>▧ Viewed image</span><strong>${escapeHtml(item.path?.split("/").pop() ?? "image")}</strong></div>`;
  if (item.type === "sleep") return `<div class="timeline-divider"><span>◷ Waiting</span><strong>${escapeHtml(item.reason ?? item.status ?? "Codex paused")}</strong></div>`;
  if (item.type === "imageGeneration") return `<div class="activity-row">${disclosureCard({ kind: "image-generation", icon: "▧", title: "Image generation", status: statusLabel(item), summary: item.prompt ?? "Generated image activity" })}</div>`;
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") return `<div class="timeline-divider"><span>${item.type === "enteredReviewMode" ? "Entered" : "Finished"} review</span><strong>${escapeHtml(item.review)}</strong></div>`;
  if (item.type === "contextCompaction") return '<div class="timeline-divider"><span>Context compacted</span><strong>Earlier detail remains in Thread history</strong></div>';
  if (item.type === "hookPrompt") return `<div class="timeline-divider"><span>Project instructions</span><strong>${escapeHtml((item.fragments ?? []).map((fragment) => fragment.text ?? fragment.content ?? "").join(" ").slice(0, 120))}</strong></div>`;
  if (item.type === "turnError") return `<section class="turn-error"><strong>${item.willRetry ? "Codex is retrying" : "This Turn stopped"}</strong><p>${escapeHtml(item.message)}</p>${item.willRetry ? '<span class="retrying">Retrying…</span>' : ""}</section>`;
  return `<div class="activity-row">${disclosureCard({ kind: "unknown", icon: "?", title: item.type ?? "Unsupported item", status: statusLabel(item), summary: "Inspect raw app-server item; no result inferred", detail: `<pre>${escapeHtml(JSON.stringify(item, null, 2))}</pre>` })}</div>`;
}

function approvalMarkup(request) {
  const params = request.params ?? {};
  const title = request.method.includes("fileChange") ? "Approve file changes?" : request.method.includes("requestUserInput") ? "Codex needs your input" : "Approve command?";
  const detail = params.command ?? params.reason ?? params.questions?.[0]?.question ?? "This Turn is waiting for you.";
  const disabled = request.fixture ? " disabled title=\"Review fixture only\"" : "";
  return `<section class="approval-card" data-request-id="${escapeHtml(request.id)}"><header><span>Needs your approval</span><em>${request.fixture ? "Review fixture" : "Turn paused"}</em></header><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p><footer>${request.method.includes("requestUserInput") ? `<button class="accept" type="button" data-answer-request="${escapeHtml(request.id)}"${disabled}>Answer Codex</button>` : `<button class="accept" type="button" data-request-decision="accept" data-request-id="${escapeHtml(request.id)}"${disabled}>Allow once</button><button type="button" data-request-decision="acceptForSession" data-request-id="${escapeHtml(request.id)}"${disabled}>Allow for session</button><button type="button" data-request-decision="decline" data-request-id="${escapeHtml(request.id)}"${disabled}>Decline</button>`}</footer></section>`;
}

const groupableActivityTypes = new Set(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView", "sleep", "imageGeneration"]);

function renderTimelineItems(items) {
  const output = [];
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const running = group.some((item) => item._live || ["inProgress", "running"].includes(item.status));
    const failed = group.some((item) => ["failed", "declined", "errored"].includes(item.status));
    const files = group.filter((item) => item.type === "fileChange").flatMap((item) => item.changes ?? []).length;
    const label = running ? "Working…" : failed ? "Work needs attention" : "Worked on this Turn";
    const detail = `${group.length} activit${group.length === 1 ? "y" : "ies"}${files ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}`;
    output.push(`<details class="activity-group" ${running || failed ? "open" : ""}><summary><span><i>${running ? "↻" : failed ? "!" : "✓"}</i><strong>${label}</strong></span><em>${detail}</em></summary><div>${group.map(renderItem).join("")}</div></details>`);
    group = [];
  };
  for (const item of items) {
    if (groupableActivityTypes.has(item.type) && (!group.length || group[0]._turnId === item._turnId)) group.push(item);
    else {
      flush();
      if (groupableActivityTypes.has(item.type)) group.push(item);
      else output.push(renderItem(item));
    }
  }
  flush();
  return output.join("");
}

function turnsMarkup(thread) {
  const turns = thread?.turns ?? [];
  const replay = turns.flatMap((turn) => (turn.items ?? []).map((item) => ({ ...item, _turnId: turn.id })));
  const replayIds = new Set(replay.map((item) => item.id));
  const live = [...state.liveItems.values()].filter((item) => !replayIds.has(item.id));
  const errors = [...state.turnErrors.values()];
  const items = [...replay, ...live, ...errors].slice(-240);
  const approvals = state.pendingRequests.filter((request) => request.params?.threadId === state.activeThreadId);
  return renderTimelineItems(items) + approvals.map(approvalMarkup).join("");
}

function renderChat({ preserveScroll = false } = {}) {
  setRouteHeader(state.activeThread ? titleForThread(state.activeThread) : "Codex", state.activeThread ? `${state.fixtureMode ? "Review fixture · not runtime history" : `Thread ${state.activeThread.id.slice(0, 8)}…`} · ${state.bootstrap?.graph.project.name}` : "Your real Threads and Turns");
  if (!state.activeThread) {
    surface.innerHTML = `<div class="welcome"><img class="welcome-mark" src="/vibehub-mark.svg" alt=""><h1>What do you want to work on?</h1><p>Start with ordinary Codex Chat. VibeHub adds a durable Task only when the work needs an explicit outcome and stopping contract.</p><div class="welcome-actions"><button class="primary-button" type="button" data-new-thread>Start a chat</button><button class="secondary-button" type="button" data-route="tasks">Open Task Graph</button></div></div>`;
    return;
  }
  const distanceFromBottom = surface.scrollHeight - surface.scrollTop - surface.clientHeight;
  surface.innerHTML = `<div class="chat-view"><header class="thread-heading"><div><h1>${escapeHtml(titleForThread(state.activeThread))}</h1><p>${escapeHtml(state.activeThread.cwd ?? state.bootstrap.graph.project.repositoryRoot)} · ${escapeHtml(state.activeThread.id)}</p></div><button class="thread-menu" type="button" aria-label="Thread actions" title="Thread actions">•••</button></header><div class="transcript" id="turns">${turnsMarkup(state.activeThread)}</div><div id="streamAnchor"></div></div>`;
  requestAnimationFrame(() => {
    if (!preserveScroll || distanceFromBottom < 96) surface.scrollTop = surface.scrollHeight;
    else surface.scrollTop = Math.max(0, surface.scrollHeight - surface.clientHeight - distanceFromBottom);
  });
}

function primaryPhase(ticket) {
  const actionName = ticket.capabilities.nextAction.summary.action;
  if (actionName === "DONE") return "DONE";
  if (["WAIT", "REFINE", "REPLAN"].includes(actionName)) return "DRAFT";
  if (actionName === "CLOSE_OUT") return "RUNNING";
  if (state.threads.some((thread) => thread.taskLink?.ticketId === ticket.ticketId && String(thread.status?.type ?? thread.status).toLowerCase().includes("active"))) return "RUNNING";
  return "READY";
}

function substate(ticket) {
  const actionName = ticket.capabilities.nextAction.summary.action;
  return ({ WAIT: "BLOCKED", REPLAN: "DEVIATED", NEEDS_HUMAN: "NEEDS YOU", CLOSE_OUT: "VERIFYING" })[actionName] ?? "";
}

function topologicalTickets(tickets, relations) {
  const byId = new Map(tickets.map((ticket) => [ticket.ticketId, ticket]));
  const incoming = new Map(tickets.map((ticket) => [ticket.ticketId, 0]));
  const outgoing = new Map(tickets.map((ticket) => [ticket.ticketId, []]));
  for (const relation of relations) {
    if (!byId.has(relation.prerequisiteTicketId) || !byId.has(relation.dependentTicketId)) continue;
    incoming.set(relation.dependentTicketId, incoming.get(relation.dependentTicketId) + 1);
    outgoing.get(relation.prerequisiteTicketId).push(relation.dependentTicketId);
  }
  const queue = tickets.filter((ticket) => incoming.get(ticket.ticketId) === 0);
  const ordered = [];
  while (queue.length) {
    const ticket = queue.shift();
    ordered.push(ticket);
    for (const dependentId of outgoing.get(ticket.ticketId)) {
      incoming.set(dependentId, incoming.get(dependentId) - 1);
      if (incoming.get(dependentId) === 0) queue.push(byId.get(dependentId));
    }
  }
  return ordered.length === tickets.length ? ordered : tickets;
}

function renderGraphEdges() {
  const graph = $(".graph");
  const svg = $(".graph-edges", graph);
  if (!graph || !svg) return;
  const graphRect = graph.getBoundingClientRect();
  const paths = [];
  for (const relation of state.bootstrap.graph.relations) {
    const source = graph.querySelector(`[data-ticket-id="${CSS.escape(relation.prerequisiteTicketId)}"]`);
    const target = graph.querySelector(`[data-ticket-id="${CSS.escape(relation.dependentTicketId)}"]`);
    if (!source || !target) continue;
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const sourceCenterX = sourceRect.left - graphRect.left + sourceRect.width / 2;
    const targetCenterX = targetRect.left - graphRect.left + targetRect.width / 2;
    const sameRow = Math.abs(sourceRect.top - targetRect.top) < 8;
    let d;
    if (sameRow) {
      const forward = targetCenterX >= sourceCenterX;
      const x1 = (forward ? sourceRect.right : sourceRect.left) - graphRect.left;
      const x2 = (forward ? targetRect.left : targetRect.right) - graphRect.left;
      const y1 = sourceRect.top - graphRect.top + sourceRect.height / 2;
      const y2 = targetRect.top - graphRect.top + targetRect.height / 2;
      const bend = Math.max(22, Math.abs(x2 - x1) * .45);
      d = `M ${x1} ${y1} C ${x1 + (forward ? bend : -bend)} ${y1}, ${x2 - (forward ? bend : -bend)} ${y2}, ${x2} ${y2}`;
    } else {
      const x1 = sourceCenterX;
      const y1 = sourceRect.bottom - graphRect.top;
      const x2 = targetCenterX;
      const y2 = targetRect.top - graphRect.top;
      const bend = Math.max(20, Math.abs(y2 - y1) * .48);
      d = `M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`;
    }
    paths.push(`<path d="${d}" marker-end="url(#graphArrow)"><title>${escapeHtml(relation.rationale)}</title></path>`);
  }
  svg.setAttribute("viewBox", `0 0 ${graphRect.width} ${graphRect.height}`);
  svg.innerHTML = `<defs><marker id="graphArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z"></path></marker></defs>${paths.join("")}`;
}

function renderTasks() {
  setRouteHeader("Tasks", `Current graph · ${state.bootstrap.graph.project.name}`);
  const tickets = topologicalTickets(state.bootstrap.graph.tickets, state.bootstrap.graph.relations);
  const phases = tickets.reduce((counts, ticket) => ({ ...counts, [primaryPhase(ticket)]: (counts[primaryPhase(ticket)] ?? 0) + 1 }), {});
  surface.innerHTML = `<div class="tasks-view"><header class="tasks-heading"><div><span class="eyebrow">VIBEHUB · CURRENT WORK</span><h1>Task Graph</h1><p>Tasks organize what Codex work is for, how it progresses, and what counts as done.</p></div><div class="task-summary">${["DRAFT", "READY", "RUNNING", "DONE"].map((phase) => `<span>${phases[phase] ?? 0} ${phase}</span>`).join("")}</div></header><div class="graph"><svg class="graph-edges" aria-hidden="true"></svg>${tickets.map((ticket) => `<button class="task-card" type="button" data-ticket-id="${escapeHtml(ticket.ticketId)}" data-phase="${primaryPhase(ticket)}"><header><span class="phase"><i></i>${primaryPhase(ticket)}</span>${substate(ticket) ? `<span class="substate">${substate(ticket)}</span>` : ""}</header><strong>${escapeHtml(humanize(ticket.ticketId))}</strong><p>${escapeHtml(ticket.outcome)}</p><footer><span>${ticket.relationCounts.prerequisites} in · ${ticket.relationCounts.dependents} out</span><span>→</span></footer></button>`).join("")}</div></div>`;
  requestAnimationFrame(renderGraphEdges);
}

function recommendedAction(handoff) {
  return ({ EXECUTE: "Start in Codex", REFINE: "Continue", CLOSE_OUT: "Verify & close", NEEDS_HUMAN: "Needs you", WAIT: "Waiting", REPLAN: "Replan", DONE: "Done" })[handoff.nextAction.action] ?? handoff.nextAction.action;
}

function renderTaskWorkspace() {
  if (!state.activeTask) {
    setRouteHeader("Task", "Loading canonical Context", { back: true });
    surface.innerHTML = '<div class="loading"><span></span><p>Reading Task Context…</p></div>';
    return;
  }
  const handoff = state.activeTask;
  const ticket = state.bootstrap.graph.tickets.find((item) => item.ticketId === handoff.ticketId) ?? {
    ticketId: handoff.ticketId,
    capabilities: { nextAction: { summary: handoff.nextAction } },
  };
  const linked = state.threads.find((thread) => thread.taskLink?.ticketId === handoff.ticketId);
  const phase = primaryPhase(ticket);
  const actionLabel = recommendedAction(handoff);
  setRouteHeader(humanize(handoff.ticketId), `Task Workspace · ${handoff.nextAction.action}`, { back: true });
  surface.innerHTML = `<div class="task-workspace"><header class="task-hero"><div><span class="eyebrow">TASK · ${escapeHtml(handoff.ticketId)}</span><h1>${escapeHtml(humanize(handoff.ticketId))}</h1><p>${escapeHtml(handoff.outcome)}</p></div><span class="task-phase"><i></i>${phase}${substate(ticket) ? ` · ${substate(ticket)}` : ""}</span></header><div class="workspace-grid"><div class="workspace-main"><section><span class="eyebrow">CONTEXT SPACE</span><h2>What Codex is being asked to complete</h2><p>${escapeHtml(handoff.context)}</p></section><section><span class="eyebrow">ACCEPTANCE</span><div class="acceptance-list">${handoff.acceptance.map((item) => `<div class="acceptance-row"><i>${handoff.evidence.some((evidence) => evidence.acceptanceIds.includes(item.acceptance_id)) ? "✓" : "○"}</i><span>${escapeHtml(item.criterion)}</span></div>`).join("")}</div></section><section><span class="eyebrow">EXECUTION</span><h2>${linked ? "A Codex Thread is linked" : "Ready for one Codex Thread"}</h2><p>${linked ? "The Task remains canonical VibeHub truth; Codex owns the conversation and execution stream." : "Starting passes the exact host-owned handoff into your Codex. It does not create a second Task record."}</p>${linked ? `<button class="linked-thread" type="button" data-thread-id="${escapeHtml(linked.id)}"><strong>${escapeHtml(titleForThread(linked))}</strong><br><small>${escapeHtml(linked.id)}</small></button>` : ""}</section></div><aside class="workspace-aside"><section><span class="eyebrow">RECOMMENDED ACTION</span><button class="recommended" type="button" data-task-action="${escapeHtml(handoff.nextAction.action)}" ${["WAIT", "DONE"].includes(handoff.nextAction.action) ? "disabled" : ""}><strong>${escapeHtml(actionLabel)}</strong><span>→</span></button></section><section><span class="eyebrow">PROOF</span><h3>${handoff.evidence.length} Evidence</h3><p>${handoff.acceptance.length} acceptance criteria · Outcome ${handoff.outcomeRecord ? handoff.outcomeRecord.status : "pending"}</p></section><section><span class="eyebrow">SOURCE</span><p>${escapeHtml(handoff.reviewInputs.ticketRef)}<br><strong>${escapeHtml(handoff.reviewInputs.commit?.slice(0, 10) ?? "working tree")}</strong></p></section></aside></div></div>`;
}

function renderRooms() {
  setRouteHeader("Rooms", "Durable Project Context");
  const context = state.bootstrap?.contexts?.find((item) => item.contextId === state.activeContextId);
  if (context) {
    surface.innerHTML = `<div class="task-workspace context-focus"><header class="task-hero"><div><span class="eyebrow">CONTEXT · ${escapeHtml(context.room)}</span><h1>${escapeHtml(context.summary)}</h1><p>${escapeHtml(context.type)} · ${escapeHtml(context.contextId)}</p></div><span class="task-phase"><i></i>CONTEXT</span></header><div class="workspace-grid"><div class="workspace-main"><section><span class="eyebrow">DURABLE CLAIM</span><p>${escapeHtml(context.detail)}</p></section><section><span class="eyebrow">TAGS</span><p>${escapeHtml((context.tags ?? []).join(" · "))}</p></section></div><aside class="workspace-aside"><section><span class="eyebrow">SOURCE</span><p>${escapeHtml(context.sourceRef)}</p></section><section><button class="secondary-button" type="button" data-clear-context>Back to Rooms</button></section></aside></div></div>`;
    return;
  }
  surface.innerHTML = `<div class="welcome"><img class="welcome-mark" src="/vibehub-mark.svg" alt=""><h1>Rooms stay Project-native</h1><p>Search can open exact durable Context here. Writeback remains a governed VibeHub action, not automatic Chat harvesting.</p><button class="secondary-button" type="button" id="roomsSearch">Search Context</button></div>`;
}

async function refreshThreads() {
  const data = await api("/api/bootstrap");
  state.bootstrap = data;
  state.threads = data.threads;
  state.eventCursor = data.eventCursor;
  state.pendingRequests = data.pendingRequests;
  updateAttentionState(data.attention);
  $("#projectName").textContent = data.graph.project.name;
  $("#projectBranch").textContent = data.graph.project.branch;
  $("#taskCount").textContent = data.graph.tickets.length;
  $("#accountName").textContent = data.account.authenticated ? "Codex" : "Sign in required";
  $("#accountPlan").textContent = data.account.planType ?? data.account.accountType ?? "Unavailable";
  $("#accountDot").classList.toggle("connected", data.account.authenticated);
  $("#runtimeLabel").textContent = data.account.authenticated ? "Local app-server" : "Authentication required";
  updateSidebar();
}

async function openThread(threadId) {
  const data = await action({ action: "readThread", threadId });
  state.activeThreadId = threadId;
  state.activeThread = { ...state.threads.find((thread) => thread.id === threadId), ...data.thread };
  state.running = String(data.thread.status?.type ?? data.thread.status).toLowerCase().includes("active");
  if (!state.running) state.liveItems.clear();
  $("#stopTurn").hidden = !state.running;
  updateSidebar();
  setRoute("chat");
}

function liveItem(itemId, fallback) {
  if (!state.liveItems.has(itemId)) state.liveItems.set(itemId, { id: itemId, ...fallback, _live: true });
  return state.liveItems.get(itemId);
}

function applyChatNotification(method, params) {
  if (params.threadId !== state.activeThreadId) return false;
  if (method === "item/started") {
    state.liveItems.set(params.item.id, { ...params.item, _turnId: params.turnId, _live: true });
    return true;
  }
  if (method === "item/completed") {
    state.liveItems.set(params.item.id, { ...params.item, _turnId: params.turnId, _live: false });
    return true;
  }
  if (method === "item/agentMessage/delta") {
    const item = liveItem(params.itemId, { type: "agentMessage", text: "", phase: null });
    item.text = `${item.text ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/plan/delta") {
    const item = liveItem(params.itemId, { type: "plan", text: "" });
    item.text = `${item.text ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/reasoning/summaryTextDelta") {
    const item = liveItem(params.itemId, { type: "reasoning", summary: [], content: [] });
    item.summary ??= [];
    item.summary[params.summaryIndex ?? 0] = `${item.summary[params.summaryIndex ?? 0] ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/reasoning/textDelta") {
    const item = liveItem(params.itemId, { type: "reasoning", summary: [], content: [] });
    item.content ??= [];
    item.content[params.contentIndex ?? 0] = `${item.content[params.contentIndex ?? 0] ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/commandExecution/outputDelta") {
    const item = liveItem(params.itemId, { type: "commandExecution", command: "Command", status: "inProgress", aggregatedOutput: "" });
    item.aggregatedOutput = `${item.aggregatedOutput ?? ""}${params.delta ?? ""}`;
    return true;
  }
  if (method === "item/fileChange/patchUpdated") {
    const item = liveItem(params.itemId, { type: "fileChange", status: "inProgress", changes: [] });
    item.changes = params.changes ?? item.changes;
    return true;
  }
  if (method === "error") {
    state.turnErrors.set(params.turnId, { type: "turnError", id: `error-${params.turnId}`, _turnId: params.turnId, message: params.error?.message ?? params.error ?? "Codex encountered an error.", willRetry: params.willRetry });
    return true;
  }
  return false;
}

function scheduleChatRender() {
  if (state.chatRenderFrame || state.route !== "chat" || !state.activeThread) return;
  state.chatRenderFrame = requestAnimationFrame(() => {
    state.chatRenderFrame = 0;
    renderChat({ preserveScroll: true });
  });
}

async function newThread() {
  if (state.creatingThread) return state.creatingThread;
  state.creatingThread = (async () => {
    $("#newThread").disabled = true;
    const data = await action({ action: "newThread" });
    state.threads.unshift(data.thread);
    state.activeThreadId = data.thread.id;
    state.activeThread = { ...data.thread, turns: [] };
    state.running = false;
    state.liveItems.clear();
    state.turnErrors.clear();
    updateSidebar();
    setRoute("chat");
    $("#composerInput").focus();
    return data.thread;
  })();
  try { return await state.creatingThread; }
  finally { state.creatingThread = null; $("#newThread").disabled = false; }
}

async function openTask(ticketId) {
  state.activeTicketId = ticketId;
  state.activeTask = null;
  setRoute("task");
  try {
    const data = await action({ action: "readTask", ticketId });
    state.activeTask = data.handoff;
    renderTaskWorkspace();
  } catch (error) { notify(error.message); setRoute("tasks"); }
}

function addAttachment(file, url) {
  const type = file.type.startsWith("audio/") ? "audio" : "image";
  state.attachments = [...state.attachments, { type, url, name: file.name || (type === "audio" ? "Voice recording" : "Image") }].slice(-3);
  renderAttachments();
}

function renderAttachments() {
  const tray = $("#attachmentTray");
  tray.hidden = state.attachments.length === 0;
  tray.innerHTML = state.attachments.map((item, index) => `<span class="attachment-chip">${item.type === "audio" ? "◉" : "▧"}<span>${escapeHtml(item.name)}</span><button type="button" data-remove-attachment="${index}" aria-label="Remove attachment">×</button></span>`).join("");
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function toggleRecording() {
  if (state.recorder?.state === "recording") {
    state.recorder.stop();
    return;
  }
  if (!state.bootstrap.runtime.audioInput || !navigator.mediaDevices?.getUserMedia) return notify("Voice input is unavailable in this browser.");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const recorder = new MediaRecorder(stream);
    state.recorder = recorder;
    state.recordingStream = stream;
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const file = new File([blob], "Voice recording.webm", { type: blob.type });
      addAttachment(file, await fileToDataUrl(file));
      stream.getTracks().forEach((track) => track.stop());
      state.recorder = null;
      state.recordingStream = null;
      $("#voiceButton").classList.remove("recording");
      $("#voiceButton").setAttribute("aria-label", "Record voice input");
      $("#composerNote").textContent = "Voice recording is attached as ordinary Codex audio input.";
    };
    recorder.start();
    $("#voiceButton").classList.add("recording");
    $("#voiceButton").setAttribute("aria-label", "Stop recording");
    $("#composerNote").textContent = "Recording locally… Select the microphone again to stop.";
  } catch (error) { notify(`Microphone unavailable: ${error.message}`); }
}

async function submitTurn(event) {
  event.preventDefault();
  const textarea = $("#composerInput");
  const text = textarea.value.trim();
  if (!text && !state.attachments.length) return;
  try {
    if (!state.activeThreadId) await newThread();
    const input = [];
    if (text) input.push({ type: "text", text });
    input.push(...state.attachments.map(({ type, url }) => ({ type, url })));
    const result = await action({ action: "startTurn", threadId: state.activeThreadId, input });
    state.currentTurnId = result.turn.id;
    state.running = true;
    textarea.value = "";
    state.attachments = [];
    renderAttachments();
    $("#stopTurn").hidden = false;
    await openThread(state.activeThreadId);
  } catch (error) { notify(error.message); }
}

async function pollEvents() {
  try {
    const data = await api(`/api/events?after=${state.eventCursor}`);
    state.eventCursor = data.cursor;
    state.pendingRequests = data.pendingRequests;
    let refreshRequests = false;
    let reconcile = false;
    let rendered = false;
    for (const entry of data.events) {
      if (entry.kind === "serverRequest" || entry.kind === "requestResolved") refreshRequests = true;
      if (entry.kind !== "notification") continue;
      const method = entry.value.method;
      const params = entry.value.params ?? {};
      if (params.threadId !== state.activeThreadId) continue;
      if (method === "turn/started") {
        state.running = true;
        state.currentTurnId = params.turn?.id;
        $("#stopTurn").hidden = false;
      }
      if (method === "turn/completed") {
        state.running = false;
        state.currentTurnId = null;
        $("#stopTurn").hidden = true;
        reconcile = true;
      }
      rendered = applyChatNotification(method, params) || rendered;
    }
    if (reconcile && state.activeThreadId) await openThread(state.activeThreadId);
    else if ((rendered || refreshRequests) && state.activeThreadId) scheduleChatRender();
    state.attentionPollCounter += 1;
    if (state.attentionPollCounter >= 12) {
      state.attentionPollCounter = 0;
      await refreshThreads();
    }
  } catch (error) {
    $("#runtimeLabel").textContent = "Runtime reconnecting";
  } finally {
    pollTimer = setTimeout(pollEvents, 850);
  }
}

document.addEventListener("click", async (event) => {
  const searchResult = event.target.closest("[data-search-kind]");
  if (searchResult) { await openSearchResult(searchResult.dataset.searchKind, searchResult.dataset.searchId); return; }
  if (event.target.closest("[data-open-inbox]")) { openInbox(); return; }
  const route = event.target.closest("[data-route]");
  if (route) {
    if (route.dataset.route === "rooms") state.activeContextId = null;
    setRoute(route.dataset.route);
    return;
  }
  const thread = event.target.closest("[data-thread-id]");
  if (thread) { await openThread(thread.dataset.threadId); return; }
  const ticket = event.target.closest("[data-ticket-id]");
  if (ticket) { closeInbox(false); await openTask(ticket.dataset.ticketId); return; }
  if (event.target.closest("[data-clear-context]")) { state.activeContextId = null; renderRooms(); return; }
  if (event.target.closest("#roomsSearch")) { openSearch(); return; }
  if (event.target.closest("[data-new-thread]")) { await newThread(); return; }
  const remove = event.target.closest("[data-remove-attachment]");
  if (remove) { state.attachments.splice(Number(remove.dataset.removeAttachment), 1); renderAttachments(); return; }
  const copyMessage = event.target.closest("[data-copy-message]");
  if (copyMessage) {
    const itemId = copyMessage.dataset.copyMessage;
    const replay = state.activeThread?.turns?.flatMap((turn) => turn.items ?? []).find((item) => item.id === itemId);
    const item = replay ?? state.liveItems.get(itemId);
    if (item?.text) {
      await navigator.clipboard.writeText(item.text);
      notify("Response copied.");
    }
    return;
  }
  const decision = event.target.closest("[data-request-decision]");
  if (decision) {
    try { await action({ action: "resolveRequest", requestId: decision.dataset.requestId, decision: decision.dataset.requestDecision }); await openThread(state.activeThreadId); }
    catch (error) { notify(error.message); }
    return;
  }
  const answer = event.target.closest("[data-answer-request]");
  if (answer) {
    const request = state.pendingRequests.find((item) => String(item.id) === answer.dataset.answerRequest);
    const question = request?.params?.questions?.[0];
    const value = prompt(question?.question ?? "Answer Codex");
    if (value !== null) {
      await action({ action: "resolveRequest", requestId: answer.dataset.answerRequest, answers: { [question.id]: { answers: [value] } } });
      await openThread(state.activeThreadId);
    }
    return;
  }
  const taskAction = event.target.closest("[data-task-action]");
  if (taskAction) {
    const next = taskAction.dataset.taskAction;
    if (next === "EXECUTE" || next === "REFINE") {
      taskAction.disabled = true;
      try {
        const started = await action({ action: "startTask", ticketId: state.activeTicketId });
        await refreshThreads();
        await openThread(started.threadId);
      } catch (error) { notify(error.message); taskAction.disabled = false; }
    } else if (next === "CLOSE_OUT") notify("Independent closeout remains a separate VibeHub action.");
    else if (next === "NEEDS_HUMAN") notify("This Task is waiting for your explicit decision.");
  }
});

$("#newThread").addEventListener("click", newThread);
$("#refreshThreads").addEventListener("click", async () => { await refreshThreads(); updateSidebar(); notify("Codex Chat history refreshed."); });
$("#searchButton").addEventListener("click", openSearch);
$("#searchInput").addEventListener("input", () => { state.searchIndex = 0; renderSearchResults(); });
$("#inboxButton").addEventListener("click", openInbox);
$("#closeInbox").addEventListener("click", () => closeInbox());
$("#collapseSidebar").addEventListener("click", () => appShell.classList.toggle("sidebar-collapsed"));
$("#openSidebar").addEventListener("click", () => appShell.classList.toggle("sidebar-open"));
backButton.addEventListener("click", () => {
  const ticketId = state.activeTicketId;
  setRoute("tasks");
  requestAnimationFrame(() => document.querySelector(`[data-ticket-id="${CSS.escape(ticketId)}"]`)?.focus());
});
$("#attachButton").addEventListener("click", () => $("#attachmentInput").click());
$("#attachmentInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) addAttachment(file, await fileToDataUrl(file));
  event.target.value = "";
});
$("#voiceButton").addEventListener("click", toggleRecording);
$("#composer").addEventListener("submit", submitTurn);
$("#composerInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#stopTurn").addEventListener("click", async () => {
  if (!state.activeThreadId || !state.currentTurnId) return;
  try { await action({ action: "interruptTurn", threadId: state.activeThreadId, turnId: state.currentTurnId }); }
  catch (error) { notify(error.message); }
});
$("#reviewButton").addEventListener("click", () => { closeSearch(false); closeInbox(false); $("#reviewPanel").hidden = false; $("#reviewPanel").inert = false; syncScrim(); $("#closeReview").focus(); });
$("#closeReview").addEventListener("click", () => { $("#reviewPanel").hidden = true; $("#reviewPanel").inert = true; syncScrim(); $("#reviewButton").focus(); });
$("#scrim").addEventListener("click", () => {
  if (!$("#searchDialog").hidden) closeSearch();
  else if (!$("#inboxPanel").hidden) closeInbox();
  else if (!$("#reviewPanel").hidden) $("#closeReview").click();
});
$("#themeToggle").addEventListener("click", () => {
  const themes = ["system", "light", "dark"];
  state.themeIndex = (state.themeIndex + 1) % themes.length;
  appShell.dataset.theme = themes[state.themeIndex];
  $("#themeLabel").textContent = themes[state.themeIndex][0].toUpperCase() + themes[state.themeIndex].slice(1);
});

document.addEventListener("keydown", (event) => {
  if (!$("#searchDialog").hidden && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    state.searchIndex = (state.searchIndex + direction + state.searchResults.length) % Math.max(1, state.searchResults.length);
    renderSearchResults();
    return;
  }
  if (!$("#searchDialog").hidden && event.key === "Enter" && state.searchResults[state.searchIndex]) {
    event.preventDefault();
    const item = state.searchResults[state.searchIndex];
    openSearchResult(item.kind, item.id);
    return;
  }
  if (event.key === "Escape") {
    if (!$("#searchDialog").hidden) closeSearch();
    else if (!$("#inboxPanel").hidden) closeInbox();
    else if (!$("#reviewPanel").hidden) $("#closeReview").click();
  }
  if (event.metaKey && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
  if (event.metaKey && event.key.toLowerCase() === "n") { event.preventDefault(); newThread(); }
});

async function start() {
  try {
    await refreshThreads();
    if (new URLSearchParams(location.search).get("chatFixture") === "mixed") {
      const fixture = await fetch("/chat-fixtures.json").then((response) => response.json());
      state.fixtureMode = true;
      state.activeThreadId = fixture.thread.id;
      state.activeThread = fixture.thread;
      state.pendingRequests = fixture.pendingRequests;
      state.running = true;
    }
    setRoute("chat");
    if (!state.fixtureMode) pollEvents();
  } catch (error) {
    surface.innerHTML = `<div class="welcome"><h1>Unable to start Codex</h1><p>${escapeHtml(error.message)}</p></div>`;
    $("#runtimeLabel").textContent = "Runtime unavailable";
  }
}

start();
