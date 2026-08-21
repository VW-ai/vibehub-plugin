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

function renderItem(item) {
  if (!item) return "";
  if (item.type === "userMessage") {
    const text = userInputText(item.content);
    const handoff = handoffFromText(text);
    if (handoff) return `<div class="turn user"><article class="item-card handoff"><header><strong>VibeHub Task</strong><span>${escapeHtml(handoff.nextAction?.action ?? handoff.operationalState)}</span></header><p><strong>${escapeHtml(humanize(handoff.ticketId))}</strong><br>${escapeHtml(handoff.outcome)}</p></article></div>`;
    const media = (item.content ?? []).filter((entry) => entry.type === "image" || entry.type === "audio");
    return `<div class="turn user"><article>${escapeHtml(text || (media.length ? `${media.length} media attachment` : "User input"))}</article></div>`;
  }
  if (item.type === "agentMessage") return `<div class="turn assistant"><span class="agent-mark">C</span><article><p>${escapeHtml(item.text)}</p></article></div>`;
  if (item.type === "reasoning") {
    const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
    return `<div class="turn assistant"><span class="agent-mark">C</span><article class="item-card"><header><strong>Reasoning</strong><span>${escapeHtml(item.status ?? "completed")}</span></header><p>${escapeHtml(text || "Reasoned about the task")}</p></article></div>`;
  }
  if (item.type === "plan") return `<div class="turn assistant"><span class="agent-mark">C</span><article class="item-card plan"><header><strong>Plan</strong><span>Codex</span></header><p>${escapeHtml(item.text)}</p></article></div>`;
  if (item.type === "commandExecution") return `<div class="turn assistant"><span class="agent-mark">C</span><article class="item-card"><header><strong>Terminal</strong><span>${escapeHtml(item.status)}</span></header><code>${escapeHtml(item.command)}</code>${item.aggregatedOutput ? `<pre>${escapeHtml(item.aggregatedOutput)}</pre>` : ""}</article></div>`;
  if (item.type === "fileChange") return `<div class="turn assistant"><span class="agent-mark">C</span><article class="item-card"><header><strong>File changes</strong><span>${escapeHtml(item.status)}</span></header><p>${escapeHtml((item.changes ?? []).map((change) => change.path).join(", ") || "Patch prepared")}</p></article></div>`;
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") return `<div class="turn assistant"><span class="agent-mark">C</span><article class="item-card"><header><strong>${escapeHtml(item.tool ?? item.name ?? "Tool")}</strong><span>${escapeHtml(item.status)}</span></header><p>${escapeHtml(item.result?.content?.[0]?.text ?? "Tool activity")}</p></article></div>`;
  return `<div class="turn assistant"><span class="agent-mark">C</span><article class="item-card"><header><strong>${escapeHtml(item.type ?? "Codex item")}</strong><span>${escapeHtml(item.status ?? "")}</span></header></article></div>`;
}

function approvalMarkup(request) {
  const params = request.params ?? {};
  const title = request.method.includes("fileChange") ? "Approve file changes?" : request.method.includes("requestUserInput") ? "Codex needs your input" : "Approve command?";
  const detail = params.command ?? params.reason ?? params.questions?.[0]?.question ?? "This Turn is waiting for you.";
  return `<section class="approval-card" data-request-id="${escapeHtml(request.id)}"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(detail)}</p><footer>${request.method.includes("requestUserInput") ? `<button type="button" data-answer-request="${escapeHtml(request.id)}">Answer</button>` : `<button class="accept" type="button" data-request-decision="accept" data-request-id="${escapeHtml(request.id)}">Allow</button><button type="button" data-request-decision="decline" data-request-id="${escapeHtml(request.id)}">Decline</button>`}</footer></section>`;
}

function turnsMarkup(thread) {
  const turns = thread?.turns ?? [];
  const items = turns.flatMap((turn) => turn.items ?? []);
  const approvals = state.pendingRequests.filter((request) => request.params?.threadId === state.activeThreadId);
  return items.map(renderItem).join("") + approvals.map(approvalMarkup).join("");
}

function renderChat() {
  setRouteHeader(state.activeThread ? titleForThread(state.activeThread) : "Codex", state.activeThread ? `Thread ${state.activeThread.id.slice(0, 8)}… · ${state.bootstrap?.graph.project.name}` : "Your real Threads and Turns");
  if (!state.activeThread) {
    surface.innerHTML = `<div class="welcome"><img class="welcome-mark" src="/vibehub-mark.svg" alt=""><h1>What do you want to work on?</h1><p>Start with ordinary Codex Chat. VibeHub adds a durable Task only when the work needs an explicit outcome and stopping contract.</p><div class="welcome-actions"><button class="primary-button" type="button" data-new-thread>Start a chat</button><button class="secondary-button" type="button" data-route="tasks">Open Task Graph</button></div></div>`;
    return;
  }
  surface.innerHTML = `<div class="chat-view"><header class="thread-heading"><h1>${escapeHtml(titleForThread(state.activeThread))}</h1><p>${escapeHtml(state.activeThread.cwd ?? state.bootstrap.graph.project.repositoryRoot)} · ${escapeHtml(state.activeThread.id)}</p></header><div id="turns">${turnsMarkup(state.activeThread)}</div><div id="streamAnchor"></div></div>`;
  requestAnimationFrame(() => { surface.scrollTop = surface.scrollHeight; });
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
  $("#stopTurn").hidden = !state.running;
  updateSidebar();
  setRoute("chat");
}

async function newThread() {
  const data = await action({ action: "newThread" });
  state.threads.unshift(data.thread);
  await openThread(data.thread.id);
  $("#composerInput").focus();
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
    let refresh = false;
    for (const entry of data.events) {
      if (entry.kind === "serverRequest" || entry.kind === "requestResolved") refresh = true;
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
      }
      refresh = true;
    }
    if (refresh && state.activeThreadId) await openThread(state.activeThreadId);
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
    setRoute("chat");
    pollEvents();
  } catch (error) {
    surface.innerHTML = `<div class="welcome"><h1>Unable to start Codex</h1><p>${escapeHtml(error.message)}</p></div>`;
    $("#runtimeLabel").textContent = "Runtime unavailable";
  }
}

start();
