import { applyChatEvent, canonicalTimeline, timelineWindow } from "./chat-model.mjs";
import {
  DOM_LIMITS,
  createRenderBudget,
  escapeHtml,
  renderAgentMessage,
  renderGeneratedImage,
  renderMarkdown,
  renderTimelineOmission,
  renderToolContent,
  renderUserMedia,
  renderUserMessageText,
  takeText,
} from "./chat-renderer.mjs";
import { requestDescriptor } from "./server-request-registry.mjs";
import { loadThreadDraft, saveThreadDraft } from "./composer-drafts.mjs";
import { clampComposerHeight, composerBounds } from "./composer-sizing.mjs";
import { threadLocation } from "./thread-location.mjs";
import { answersFromDraft, applyRequestDraft, loadRequestDraft, pruneRequestDrafts, requestDraftFromForm, saveRequestDraft } from "./request-drafts.mjs";
import { composeQuotedMessage } from "./quote-source.mjs";
import { planTimelineReconciliation } from "./timeline-reconcile.mjs";

const state = {
  route: "chat",
  bootstrap: null,
  threads: [],
  projects: [],
  pinned: [],
  recents: [],
  activeThreadId: null,
  activeThread: null,
  activeTicketId: null,
  activeTask: null,
  taskWorkspace: null,
  taskSelectedContextIds: new Set(),
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
  turnPlans: new Map(),
  turnDiffs: new Map(),
  chatRenderFrame: 0,
  fixtureMode: false,
  creatingThread: null,
  composerQuote: null,
  selectedQuote: null,
  paintDeferred: false,
  runtimeGeneration: 0,
  runtimeAlive: false,
  knownRequestIds: new Set(),
  composerDrafts: new Map(),
  requestDrafts: new Map(),
  requestReturnFocus: new Map(),
  importCandidates: null,
  importSelectedId: null,
  importing: false,
};

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_RECORDING_MS = 90_000;

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
const sidebar = $("#sidebar");
const mainColumn = $(".main-column");
const toast = $("#toast");
let toastTimer;
let pollTimer;
let graphResizeFrame;
let pointerDrag = null;
let suppressThreadClick = null;
let rerenderFocusSelector = null;

window.addEventListener("resize", () => {
  if (state.route !== "tasks") return;
  cancelAnimationFrame(graphResizeFrame);
  graphResizeFrame = requestAnimationFrame(renderGraphEdges);
});

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function afterRenderFocus(selector) {
  rerenderFocusSelector = selector;
  requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector(selector)?.focus()));
}

function restoreRerenderedFocus() {
  if (!rerenderFocusSelector || (document.activeElement !== document.body && document.activeElement?.isConnected)) return;
  requestAnimationFrame(() => document.querySelector(rerenderFocusSelector)?.focus());
}

// "Project" names only the repository-bound VibeHub Project. Native Codex
// ThreadSections are chat groups here so nobody is asked to tell two kinds
// of Project apart; membership stays entirely in the app-server.
function projectDestinationName(projectId) {
  if (projectId === null) return "Recents";
  if (projectId === state.bootstrap?.capabilities?.pinnedSectionId) return "Pinned";
  return `the ${state.projects.find((project) => project.id === projectId)?.name ?? "selected"} group`;
}

function scopeBound() {
  return state.bootstrap?.project?.scope === "bound";
}

function scopeLabel(project) {
  if (!project) return "Reading";
  if (project.scope === "bound") return "Bound";
  if (project.scope === "unbound") return "Not set up";
  if (project.scope === "no-repository") return "No repository";
  if (project.scope === "migration-required") return project.compatibility?.state === "UNSUPPORTED_NEWER" ? "Newer format" : "Migration required";
  return "Unknown scope";
}

function inspectRows(project) {
  const binding = project.binding
    ? `${project.binding.sectionName ?? "unnamed"} · ${project.binding.sectionId} · imported ${project.binding.importedAt ?? "unknown"} · ${project.binding.sectionPresent ? "section present in Codex" : "section no longer in Codex"}`
    : project.bindingRecord?.invalid ? `invalid record: ${project.bindingRecord.reason}` : "none";
  const rooms = project.rooms?.coldStart ? "cold start · no Room tree checked in" : `${project.rooms?.count ?? 0} room${project.rooms?.count === 1 ? "" : "s"}`;
  const uncommitted = project.uncommitted?.paths?.length ? `${project.uncommitted.paths.join(", ")}${project.uncommitted.truncated ? " …" : ""}` : "nothing pending under .vibehub";
  const visibility = project.visibility
    ? `${project.visibility.scopedCount} of ${project.visibility.totalCount} Codex chats are in this folder · ${project.visibility.hiddenChats} hidden in other folders · ${project.visibility.hiddenGroups} group${project.visibility.hiddenGroups === 1 ? "" : "s"} hidden`
    : "not read";
  return [
    ["Scope", `${project.scope}${project.reason ? ` · ${project.reason}` : ""}`],
    ["Repository root", project.repositoryRoot ?? "none (not a Git repository)"],
    ["Working folder (cwd)", project.worktreeRoot],
    ["Branch", project.branch ?? "none"],
    ["VibeHub format", `${project.compatibility?.state ?? "unknown"} · detected ${project.compatibility?.detectedFormat ?? "unknown"} · target ${project.compatibility?.targetFormat ?? "unknown"}`],
    ["Codex binding", binding],
    ["Rooms", rooms],
    ["Uncommitted", uncommitted],
    ["Chat visibility", visibility],
    ["Sync", project.sync ? `${project.sync.rule} Automatic commit: ${project.sync.automaticCommit ? "yes" : "never"}.` : "not read"],
  ];
}

function renderProjectHeader() {
  const project = state.bootstrap?.project ?? null;
  const header = $("#projectHeader");
  header.dataset.scope = project?.scope ?? "loading";
  $("#projectScope").textContent = scopeLabel(project);
  $("#projectName").textContent = project?.name ?? "—";
  $("#projectBranch").textContent = !project
    ? "Resolving the selected folder"
    : project.scope === "no-repository"
      ? "Not inside a Git repository"
      : `${project.branch ?? "detached"} · Git repository`;
  const rooms = $("#projectRooms");
  rooms.hidden = !(project && project.scope === "bound");
  rooms.textContent = project?.scope === "bound"
    ? (project.rooms?.coldStart ? "Rooms: cold start pending — run distill" : `Rooms: ${project.rooms.count} checked in`)
    : "";
  // The header keeps one short line; the full reason lives in Inspect and on
  // the Tasks route, which explains the missing scope in full.
  const note = $("#projectNote");
  const shortNote = project?.scope === "unbound"
    ? "Tasks wait for an explicit Codex Project import."
    : project?.scope === "no-repository"
      ? "Not a Git repository: Tasks unavailable, Chat works."
      : project?.scope === "migration-required"
        ? "VibeHub data needs migration: Tasks unavailable, Chat works."
        : "";
  note.hidden = !shortNote;
  note.textContent = shortNote;
  const importButton = $("#importProject");
  importButton.hidden = project?.scope !== "unbound" || Boolean(state.bootstrap?.stop);
  $("#projectInspectList").innerHTML = project
    ? inspectRows(project).map(([term, detail]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(detail)}</dd>`).join("")
    : "";
  const tasksNav = $('.primary-nav [data-route="tasks"]');
  const bound = scopeBound();
  tasksNav.setAttribute("aria-disabled", bound ? "false" : "true");
  tasksNav.title = bound ? "" : `Tasks unavailable: ${project?.reason ?? "no bound Project"}`;
  $("#taskCount").textContent = bound ? String(state.bootstrap?.graph.tickets.length ?? 0) : "—";
  $("#inboxButton").hidden = !bound;
}

function renderStopBanner() {
  const stop = state.bootstrap?.stop ?? null;
  $("#stopBanner")?.remove();
  if (!stop) return;
  const banner = document.createElement("div");
  banner.id = "stopBanner";
  banner.className = "stop-banner";
  banner.setAttribute("role", "alert");
  banner.innerHTML = `<strong>Stopped: Codex runtime does not match the pinned baseline</strong><p>${escapeHtml(stop.message)} Chat history, grouping and Tasks are not read from this runtime.</p>`;
  mainColumn.querySelector(".topbar").insertAdjacentElement("afterend", banner);
}

function scopePanelMarkup(title) {
  const project = state.bootstrap?.project;
  const scope = project?.scope ?? "no-repository";
  const reason = project?.reason ?? "No bound VibeHub Project.";
  const next = scope === "unbound"
    ? "Importing the single-folder Codex Project for this folder writes the .vibehub scaffold into the working tree, uncommitted. Room creation stays with the distill Skill."
    : scope === "no-repository"
      ? "Open VibeHub inside a Git repository to use Tasks. No hidden storage is created for an unversioned folder."
      : scope === "migration-required"
        ? "Run the VibeHub migrate Skill on this repository first; nothing is rewritten in place."
        : "No bound VibeHub Project is available for this folder.";
  const actions = scope === "unbound" && !state.bootstrap?.stop
    ? '<button class="primary-button" type="button" data-open-import>Set up from Codex…</button>'
    : "";
  return `<section class="scope-panel" data-scope="${escapeHtml(scope)}"><span class="eyebrow">VIBEHUB · ${escapeHtml(scopeLabel(project).toUpperCase())}</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(reason)}</p><p>${escapeHtml(next)}</p><p>Chat keeps working exactly as before: new Chats carry this folder as their Codex cwd.</p><div class="scope-actions">${actions}<button class="secondary-button" type="button" data-route="chat">Back to Chat</button></div></section>`;
}

function announceThreadMove(projectId) {
  notify(`Chat moved to ${projectDestinationName(projectId)}.`);
}

async function moveThreadToProject(threadId, projectId, focusSelector) {
  await action({ action: "moveThread", threadId, projectId });
  await refreshThreads();
  if (state.route === "chat" && state.activeThreadId === threadId) renderChat();
  announceThreadMove(projectId);
  afterRenderFocus(focusSelector);
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

let interactionGuardActionSink = null;
const action = (payload) => interactionGuardActionSink
  ? interactionGuardActionSink(payload)
  : api("/api/action", { method: "POST", body: JSON.stringify(payload) });

function titleForThread(thread) {
  if (thread.taskLink) return humanize(thread.taskLink.ticketId);
  return thread.title || "Untitled chat";
}

function liveTurnId(thread) {
  const threadActive = String(thread?.status?.type ?? thread?.status ?? "").toLowerCase().includes("active");
  const turn = thread?.turns?.at(-1);
  const turnStatus = String(turn?.status?.type ?? turn?.status ?? "").toLowerCase();
  return threadActive && ["inprogress", "running"].includes(turnStatus) ? turn.id : null;
}

function humanize(ticketId) {
  return String(ticketId).replace(/^ticket-/, "").split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

function threadButton(thread) {
  const active = thread.id === state.activeThreadId;
  const runtimeActive = String(thread.status?.type ?? thread.status ?? "").toLowerCase().includes("active");
  return `<button class="thread-button${active ? " active" : ""}" type="button" data-thread-id="${escapeHtml(thread.id)}">
    <i class="thread-state${runtimeActive ? " active" : ""}"></i>
    <span><strong>${escapeHtml(titleForThread(thread))}</strong><small>${escapeHtml(thread.taskLink ? "VibeHub Task · Codex Thread" : (thread.preview || "Codex Thread").slice(0, 54))}</small></span>
    ${thread.taskLink ? "<em>TASK</em>" : ""}
  </button>`;
}

function updateSidebar() {
  const list = $("#threadList");
  const focused = sidebar.contains(document.activeElement)
    ? { threadId: document.activeElement.dataset.threadId, ticketId: document.activeElement.dataset.ticketId, id: document.activeElement.id }
    : null;
  const needsYou = scopeBound() ? state.bootstrap?.attention?.needsYou ?? [] : [];
  const attention = $("#sidebarAttention");
  attention.hidden = needsYou.length === 0;
  $("#sidebarAttentionList").innerHTML = needsYou.slice(0, 3).map((item) => `<button class="attention-item" type="button" data-ticket-id="${escapeHtml(item.ticketId)}"><i></i><span><strong>${escapeHtml(humanize(item.ticketId))}</strong><small>Task · Needs you</small></span></button>`).join("");
  $("#pinnedSection").hidden = state.pinned.length === 0;
  $("#pinnedList").innerHTML = state.pinned.map(threadButton).join("");
  $("#projectList").innerHTML = state.projects.length
    ? state.projects.map((project) => `<section class="project-group" data-project-drop="${escapeHtml(project.id)}">
        <header><button class="project-toggle" type="button" data-toggle-project="${escapeHtml(project.id)}" aria-expanded="true" aria-label="Collapse ${escapeHtml(project.name)} group"><span class="project-dot"></span><strong>${escapeHtml(project.name)}</strong><small title="${project.hiddenElsewhere ? `${project.threads.length} here · ${project.hiddenElsewhere} in other folders hidden` : `${project.threads.length} in this folder`}">${project.threads.length}${project.hiddenElsewhere ? "+" : ""}</small></button><details class="project-menu"><summary aria-label="${escapeHtml(project.name)} group actions">•••</summary><div><button type="button" data-rename-project="${escapeHtml(project.id)}">Rename</button><button type="button" data-delete-project="${escapeHtml(project.id)}">Delete</button></div></details></header>
        <div class="project-threads">${project.threads.map(threadButton).join("") || '<p class="muted">Drop a Chat here</p>'}</div>
      </section>`).join("")
    : '<p class="muted">No chat groups yet. Chats stay in Recents.</p>';
  list.innerHTML = state.recents.map(threadButton).join("") || '<p class="muted">No ungrouped chats in this folder.</p>';
  const hidden = state.bootstrap?.project?.visibility;
  const footnote = $("#recentsFootnote");
  const hiddenParts = [];
  if (hidden?.hiddenChats) hiddenParts.push(`${hidden.hiddenChats} chat${hidden.hiddenChats === 1 ? "" : "s"}`);
  if (hidden?.hiddenGroups) hiddenParts.push(`${hidden.hiddenGroups} group${hidden.hiddenGroups === 1 ? "" : "s"}`);
  footnote.hidden = hiddenParts.length === 0;
  footnote.textContent = hiddenParts.length ? `${hiddenParts.join(" and ")} in other folders hidden` : "";
  restoreRerenderedFocus();
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

function syncThreadLocation() {
  if (state.fixtureMode) return;
  const next = threadLocation(location.href, state.activeThreadId);
  if (next !== location.href) history.replaceState(history.state, "", next);
}

function setRoute(route) {
  captureRequestDrafts(surface);
  state.route = route;
  closeMobileSidebar(false);
  const activeRoute = route === "task" ? "tasks" : route;
  $$('[data-route]', $("#sidebar")).forEach((button) => button.classList.toggle("active", button.dataset.route === activeRoute));
  composerWrap.hidden = route !== "chat" && route !== "task";
  if (route === "chat") renderChat();
  else if (route === "tasks") renderTasks();
  else if (route === "task") renderTaskWorkspace();
  else renderRooms();
  syncComposerMode();
}

function syncComposerMode() {
  const input = $("#composerInput");
  const taskMode = state.route === "task";
  const linked = taskMode && state.activeThreadId;
  input.disabled = !state.runtimeAlive || Boolean(state.bootstrap?.stop) || Boolean(taskMode && !linked);
  $("#sendButton").disabled = input.disabled;
  $("#sendButton").setAttribute("aria-label", state.running ? "Steer current turn" : "Send message");
  $("#sendButton").title = state.running ? "Steer current Turn" : "Send message";
  $("#composer").dataset.turnPosture = state.running ? "running" : "idle";
  if (state.currentTurnId) $("#composer").dataset.currentTurnId = state.currentTurnId;
  else delete $("#composer").dataset.currentTurnId;
  input.placeholder = taskMode ? (linked ? "Message this Task" : "Start the Task to open its Codex conversation") : "Ask Codex to do something";
  $("#composerNote").textContent = taskMode
    ? (linked ? `${state.taskSelectedContextIds.size} Context item${state.taskSelectedContextIds.size === 1 ? "" : "s"} included in the next Turn · Browser never rebuilds the packet.` : "The host will open a linked Codex Thread with the canonical Task packet.")
    : "Codex can make mistakes. Review commands and changes.";
}

function setRuntimePosture({ alive, generation = state.runtimeGeneration, label } = {}) {
  state.runtimeAlive = Boolean(alive);
  state.runtimeGeneration = generation;
  const stopped = Boolean(state.bootstrap?.stop);
  $("#runtimeLabel").textContent = label ?? (stopped ? "Stopped: baseline mismatch" : state.runtimeAlive ? "Local app-server" : "Runtime unavailable");
  $("#runtimeLabel").parentElement.dataset.stopped = String(stopped);
  $("#accountDot").classList.toggle("connected", state.runtimeAlive && Boolean(state.bootstrap?.account?.authenticated));
  $("#stopTurn").disabled = !state.runtimeAlive;
  syncComposerMode();
}

function syncScrim() {
  const overlayOpen = !$("#searchDialog").hidden || !$("#inboxPanel").hidden || !$("#reviewPanel").hidden || !$("#importDialog").hidden;
  const mobileNavigationOpen = appShell.classList.contains("sidebar-open") && isNarrowLayout();
  $("#scrim").hidden = !overlayOpen && !mobileNavigationOpen;
  appShell.inert = overlayOpen;
  if (!overlayOpen) mainColumn.inert = mobileNavigationOpen;
}

function isNarrowLayout() {
  return reviewFrame === "narrow" || window.matchMedia("(max-width: 760px)").matches;
}

function syncSidebarAccessibility() {
  const narrow = isNarrowLayout();
  const open = narrow && appShell.classList.contains("sidebar-open");
  sidebar.inert = narrow && !open;
  sidebar.setAttribute("aria-hidden", narrow && !open ? "true" : "false");
  if (narrow) {
    sidebar.setAttribute("role", "dialog");
    sidebar.setAttribute("aria-modal", "true");
  } else {
    sidebar.removeAttribute("role");
    sidebar.removeAttribute("aria-modal");
    mainColumn.inert = false;
  }
  $("#openSidebar").setAttribute("aria-expanded", open ? "true" : "false");
  $("#collapseSidebar").setAttribute("aria-label", narrow ? "Close navigation" : "Collapse sidebar");
}

function openMobileSidebar() {
  if (!isNarrowLayout()) return;
  state.overlayReturnFocus = document.activeElement;
  appShell.classList.add("sidebar-open");
  syncSidebarAccessibility();
  syncScrim();
  $("#collapseSidebar").focus();
}

function closeMobileSidebar(restore = true) {
  if (!appShell.classList.contains("sidebar-open")) { syncSidebarAccessibility(); return; }
  appShell.classList.remove("sidebar-open");
  syncSidebarAccessibility();
  syncScrim();
  if (restore) state.overlayReturnFocus?.focus?.();
}

function focusRouteHeading() {
  requestAnimationFrame(() => routeTitle.focus({ preventScroll: true }));
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
  const bound = scopeBound();
  const tasks = (bound ? state.bootstrap?.graph.tickets ?? [] : [])
    .filter((ticket) => includes(ticket.ticketId, ticket.outcome, ticket.capabilities.nextAction.summary.action))
    .slice(0, 8)
    .map((ticket) => ({ kind: "task", id: ticket.ticketId, title: humanize(ticket.ticketId), detail: ticket.outcome, glyph: "T" }));
  const contexts = (bound ? state.bootstrap?.contexts ?? [] : [])
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
      return `<button class="search-result" id="search-result-${index}" type="button" role="option" aria-selected="${index === state.searchIndex}" data-search-kind="${item.kind}" data-search-id="${escapeHtml(item.id)}"><i>${item.glyph}</i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span><em>${kind === "chat" ? "Chat" : kind === "task" ? "Task" : "Context"}</em></button>`;
    }).join("")}`;
  }).join("");
  $("#searchResults").innerHTML = markup || `<div class="search-empty">${scopeBound() ? "No matching Chat, Task, or Context." : "No matching Chat. Tasks and Context need a bound VibeHub Project."}</div>`;
  const active = state.searchResults.length ? `search-result-${state.searchIndex}` : null;
  if (active) $("#searchInput").setAttribute("aria-activedescendant", active);
  else $("#searchInput").removeAttribute("aria-activedescendant");
  $(".search-result[aria-selected=\"true\"]")?.scrollIntoView({ block: "nearest" });
}

function openSearch() {
  closeInbox(false);
  closeImport(false);
  state.overlayReturnFocus = document.activeElement;
  const dialog = $("#searchDialog");
  dialog.hidden = false;
  dialog.inert = false;
  $("#searchInput").setAttribute("aria-expanded", "true");
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
  $("#searchInput").setAttribute("aria-expanded", "false");
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
  closeImport(false);
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

function importRowMarkup(row) {
  const eligibility = { "single-folder": "Single folder", "multi-folder": `${row.folders.length} folders`, empty: "No chats" }[row.eligibility] ?? row.eligibility;
  const match = row.eligibility === "single-folder" ? (row.matchesRepository ? "Matches this repository" : "Different folder") : "Not importable";
  const selected = state.importSelectedId === row.id;
  return `<button class="import-row" type="button" data-import-section="${escapeHtml(row.id)}" data-importable="${row.importable ? "true" : "false"}" aria-pressed="${selected ? "true" : "false"}" ${row.importable ? "" : "disabled"} title="${escapeHtml(row.reason ?? "Eligible: its only folder is this repository")}"><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.folders.join(" · ") || "No folder yet")}</small></span><em>${row.memberCount} chat${row.memberCount === 1 ? "" : "s"}${row.archivedCount ? ` (${row.archivedCount} archived)` : ""}<br>${escapeHtml(eligibility)} · ${escapeHtml(match)}</em></button>`;
}

function renderImportRows() {
  const candidates = state.importCandidates;
  const content = $("#importContent");
  const confirm = $("#confirmImport");
  const selection = $("#importSelection");
  if (!candidates) {
    content.innerHTML = '<p class="muted">Reading your Codex Projects…</p>';
    confirm.disabled = true;
    return;
  }
  if (!candidates.canImport) {
    content.innerHTML = `<p class="muted">${escapeHtml(candidates.blockedReason ?? "Import is unavailable here.")}</p>`;
    confirm.disabled = true;
    selection.textContent = "Import unavailable.";
    return;
  }
  content.innerHTML = candidates.projects.length
    ? candidates.projects.map(importRowMarkup).join("")
    : '<p class="muted">Codex has no Projects yet. Create one in Codex with chats in this folder, then import it here.</p>';
  const selected = candidates.projects.find((row) => row.id === state.importSelectedId && row.importable) ?? null;
  confirm.disabled = !selected || state.importing;
  selection.textContent = selected
    ? `Import “${selected.name}”: writes ${candidates.writes.join(", ")} into the working tree, uncommitted.`
    : candidates.projects.some((row) => row.importable) ? "Select an eligible Codex Project." : "No Codex Project matches this repository's folder.";
}

async function openImport() {
  closeSearch(false);
  closeInbox(false);
  state.overlayReturnFocus = document.activeElement;
  state.importSelectedId = null;
  state.importCandidates = null;
  const dialog = $("#importDialog");
  dialog.hidden = false;
  dialog.inert = false;
  renderImportRows();
  syncScrim();
  $("#closeImport").focus();
  try {
    state.importCandidates = await action({ action: "listImportableProjects" });
  } catch (error) {
    state.importCandidates = { canImport: false, blockedReason: error.message, projects: [], writes: [] };
  }
  if (dialog.hidden) return;
  renderImportRows();
  const firstEligible = dialog.querySelector('.import-row[data-importable="true"]');
  if (firstEligible && document.activeElement === $("#closeImport")) firstEligible.focus();
}

function closeImport(restore = true) {
  const dialog = $("#importDialog");
  if (dialog.hidden) return;
  dialog.hidden = true;
  dialog.inert = true;
  syncScrim();
  if (restore) state.overlayReturnFocus?.focus?.();
}

async function confirmImport() {
  const candidates = state.importCandidates;
  const selected = candidates?.projects.find((row) => row.id === state.importSelectedId && row.importable);
  if (!selected || state.importing) return;
  state.importing = true;
  renderImportRows();
  try {
    const result = await action({ action: "importProject", sectionId: selected.id });
    closeImport(false);
    await refreshThreads();
    if (state.route === "tasks") renderTasks();
    else if (state.route === "rooms") renderRooms();
    else if (state.route === "chat" && !state.activeThread) renderChat();
    notify(`Imported “${selected.name}” as this Project. ${result.writtenPaths.length} paths written under .vibehub, uncommitted. Rooms: cold start pending — run distill.`);
    afterRenderFocus("#projectInspect > summary");
  } catch (error) {
    notify(error.message);
    try { state.importCandidates = await action({ action: "listImportableProjects" }); } catch {}
  } finally {
    state.importing = false;
    if (!$("#importDialog").hidden) renderImportRows();
  }
}

async function openSearchResult(kind, id) {
  closeSearch(false);
  if (kind === "chat") await openThread(id);
  else if (kind === "task") await openTask(id);
  else {
    state.activeContextId = id;
    setRoute("rooms");
  }
  focusRouteHeading();
}

function handoffFromText(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed?.kind === "vibehub_ticket_handoff") return { kind: parsed.kind, ticketId: parsed.ticketId, outcome: parsed.outcome, nextAction: parsed.nextAction };
    if (parsed?.kind === "vibehub_task_context_packet") return parsed;
    return null;
  } catch {
    return null;
  }
}

function userInputText(content) {
  return (content ?? []).filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function statusLabel(item) {
  if (item._live) return "running";
  if (item.status) return String(item.status).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return "complete";
}

function disclosureCard({ identity, kind, title, status, summary, detail = "", icon = "◇", open = false, extra = "" }) {
  return `<details class="activity-card ${kind}" data-disclosure-id="${escapeHtml(identity ?? `${kind}-${title}`)}" ${open ? "open" : ""}><summary><i>${icon}</i><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(summary)}</small></span><em>${escapeHtml(status)}</em></summary>${detail ? `<div class="activity-detail">${detail}</div>` : ""}${extra}</details>`;
}

function boundedPre(value, className = "", maximum = DOM_LIMITS.outputCharacters, budget = createRenderBudget()) {
  const bounded = takeText(budget, value, maximum);
  return `<pre${className ? ` class="${className}"` : ""}>${escapeHtml(bounded.text)}</pre>${bounded.truncated ? `<p class="truncation-note">${bounded.omitted.toLocaleString()} characters omitted from this browser view. Durable Thread history remains authoritative.</p>` : ""}`;
}

function liveOmission(item) {
  return item._omittedCharacters
    ? `<p class="truncation-note">${item._omittedCharacters.toLocaleString()} characters omitted from this mounted live view. Durable Thread history remains authoritative.</p>`
    : "";
}

function renderItem(item, budget) {
  if (!item) return "";
  const identity = item._key ?? item.id;
  if (item.type === "userMessage") {
    const text = userInputText(item.content);
    const handoff = handoffFromText(text);
    if (handoff?.kind === "vibehub_ticket_handoff") return `<div class="turn user"><article class="item-card handoff"><header><strong>VibeHub Task</strong><span>${escapeHtml(handoff.nextAction?.action ?? handoff.operationalState)}</span></header><p><strong>${escapeHtml(humanize(handoff.ticketId))}</strong><br>${escapeHtml(takeText(budget, handoff.outcome, 8_000).text)}</p></article></div>`;
    if (handoff?.kind === "vibehub_task_context_packet") {
      const message = handoff.conversation?.humanMessage;
      const contextCount = handoff.context?.items?.length ?? 0;
      const media = renderUserMedia(item.content, budget);
      if (message) return `<div class="turn user" data-item-id="${escapeHtml(identity)}"><article><div>${renderUserMessageText(message, budget, { currentThreadId: item._threadId })}</div>${media}<small class="task-message-context">${contextCount} Context item${contextCount === 1 ? "" : "s"} · host-owned packet</small></article></div>`;
      return `<div class="turn user"><article class="item-card handoff task-packet"><header><strong>VibeHub Task</strong><span>${escapeHtml(handoff.task?.nextAction?.action ?? handoff.task?.operationalState)}</span></header><p><strong>${escapeHtml(humanize(handoff.task?.ticketId))}</strong><br>${escapeHtml(takeText(budget, handoff.task?.outcome, 8_000).text)}</p><small>${contextCount} Context item${contextCount === 1 ? "" : "s"} · ${escapeHtml(handoff.project?.scope ?? "standalone")} · host-owned packet</small></article></div>`;
    }
    const media = renderUserMedia(item.content, budget);
    return `<div class="turn user" data-item-id="${escapeHtml(identity)}"><article>${text ? `<div>${renderUserMessageText(text, budget, { currentThreadId: item._threadId })}</div>` : ""}${media}</article></div>`;
  }
  if (item.type === "agentMessage") return renderAgentMessage(item, budget);
  if (item.type === "reasoning") {
    const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n");
    return `<div class="activity-row">${disclosureCard({ identity, kind: "reasoning", icon: "✦", title: "Reasoning", status: statusLabel(item), summary: item._live ? "Thinking…" : "Reasoning summary", detail: `${renderMarkdown(text || "Reasoned about the request", budget)}${liveOmission(item)}` })}</div>`;
  }
  if (item.type === "plan") return `<div class="activity-row">${disclosureCard({ identity, kind: "plan", icon: "☷", title: "Plan", status: statusLabel(item), summary: item._live ? "Updating plan…" : "Plan updated", detail: renderMarkdown(item.text, budget), open: true })}</div>`;
  if (item.type === "turnPlan") {
    const steps = (item.plan ?? []).slice(0, 64).map((entry) => `<li data-status="${escapeHtml(entry.status)}"><i></i><span>${escapeHtml(takeText(budget, entry.step, 2_000).text)}</span><em>${escapeHtml(entry.status)}</em></li>`).join("");
    const explanation = item.explanation ? `<p>${escapeHtml(takeText(budget, item.explanation, 4_000).text)}</p>` : "";
    return `<div class="activity-row">${disclosureCard({ identity, kind: "plan", icon: "☷", title: "Plan", status: "running", summary: `${item.plan?.filter((entry) => entry.status === "completed").length ?? 0}/${item.plan?.length ?? 0} steps`, detail: `${explanation}<ol class="plan-steps">${steps}</ol>`, open: true })}</div>`;
  }
  if (item.type === "turnDiff") return `<div class="activity-row">${disclosureCard({ identity, kind: "files", icon: "±", title: "Turn diff", status: "running", summary: "Latest aggregate diff", detail: boundedPre(item.diff, "", DOM_LIMITS.outputCharacters, budget), open: true })}</div>`;
  if (item.type === "commandExecution") {
    const detail = `<div class="command-meta">${escapeHtml(takeText(budget, item.cwd, 1_024).text)}</div><code class="command-line">${escapeHtml(takeText(budget, item.command, 4_000).text)}</code>${item.aggregatedOutput ? boundedPre(item.aggregatedOutput, "terminal-output", DOM_LIMITS.outputCharacters, budget) : ""}${liveOmission(item)}`;
    const duration = item.durationMs ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : "";
    return `<div class="activity-row">${disclosureCard({ identity, kind: "terminal", icon: ">_", title: "Terminal", status: statusLabel(item), summary: `${takeText(budget, item.command || "Command", 240).text}${duration}`, detail, open: item._live || item.status === "failed" })}</div>`;
  }
  if (item.type === "fileChange") {
    const changes = item.changes ?? [];
    const count = Math.max(0, Math.min(changes.length, budget.changesRemaining));
    budget.changesRemaining -= count;
    const detail = `${changes.slice(0, count).map((change) => `<section class="diff-file"><header><strong>${escapeHtml(takeText(budget, change.path, 1_024).text)}</strong><span>${escapeHtml(change.kind?.type ?? change.kind ?? "update")}</span></header>${change.diff ? boundedPre(change.diff, "", DOM_LIMITS.outputCharacters, budget) : ""}</section>`).join("")}${item.output ? boundedPre(item.output, "file-change-output", DOM_LIMITS.outputCharacters, budget) : ""}${changes.length > count ? `<p class="truncation-note">${changes.length - count} file changes omitted from this mounted view. Durable Thread history remains authoritative.</p>` : ""}${liveOmission(item)}`;
    return `<div class="activity-row">${disclosureCard({ identity, kind: "files", icon: "±", title: "File changes", status: statusLabel(item), summary: `${changes.length} file${changes.length === 1 ? "" : "s"}`, detail, open: item._live || item.status === "failed" })}</div>`;
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const name = takeText(budget, item.tool ?? "Tool", 160).text;
    const server = takeText(budget, item.server ?? item.namespace ?? "Codex", 160).text;
    const content = item.result?.content ?? item.contentItems ?? (item.error?.message ? [{ type: "text", text: item.error.message }] : []);
    const detail = `${boundedPre(JSON.stringify(item.arguments ?? {}, null, 2), "tool-arguments", 8_000, budget)}${item.progress ? `<p class="tool-progress">${escapeHtml(takeText(budget, item.progress, 4_000).text)}</p>` : ""}${renderToolContent(content, budget)}`;
    return `<div class="activity-row">${disclosureCard({ identity, kind: "tool", icon: "◇", title: name, status: statusLabel(item), summary: `${server}${item.readOnlyHint ? " · read only" : ""}`, detail, open: item._live || item.status === "failed" })}</div>`;
  }
  if (item.type === "collabAgentToolCall") {
    const agents = Object.entries(item.agentsStates ?? {}).map(([id, value]) => `<li><code tabindex="0">${escapeHtml(id)}</code><span>${escapeHtml(value.status ?? value)}</span><button type="button" data-copy-citation-thread="${escapeHtml(id)}" aria-label="Copy delegated Thread id">Copy</button></li>`).join("");
    const sender = item.senderThreadId ? `<p>Sender <code tabindex="0">${escapeHtml(item.senderThreadId)}</code></p>` : "";
    return `<div class="activity-row">${disclosureCard({ identity, kind: "agents", icon: "⑂", title: "Delegated work", status: statusLabel(item), summary: `${item.receiverThreadIds?.length ?? 0} agent thread${item.receiverThreadIds?.length === 1 ? "" : "s"}`, detail: `${sender}${item.prompt ? `<p>${escapeHtml(takeText(budget, item.prompt, 4_000).text)}</p>` : ""}${agents ? `<ul class="agent-identities">${agents}</ul>` : ""}`, open: item._live })}</div>`;
  }
  if (item.type === "subAgentActivity") return `<div class="timeline-divider"><span>⑂ ${escapeHtml(takeText(budget, item.agentPath || "Agent", 240).text)}</span><strong>${escapeHtml(item.kind?.type ?? item.kind ?? "activity")}</strong></div>`;
  if (item.type === "webSearch") return `<div class="activity-row">${disclosureCard({ identity, kind: "search", icon: "⌕", title: "Web search", status: statusLabel(item), summary: takeText(budget, item.query ?? item.action?.query ?? "Search activity", 240).text, detail: item.result ? boundedPre(item.result, "", 8_000, budget) : "" })}</div>`;
  if (item.type === "imageView") return `<div class="timeline-divider"><span>▧ Viewed image</span><strong>${escapeHtml(item.path?.split("/").pop() ?? "image")}</strong></div>`;
  if (item.type === "sleep") return `<div class="timeline-divider"><span>◷ Waiting</span><strong>${escapeHtml(takeText(budget, item.reason ?? item.status ?? "Codex paused", 1_000).text)}</strong></div>`;
  if (item.type === "imageGeneration") return `<div class="activity-row">${disclosureCard({ identity, kind: "image-generation", icon: "▧", title: "Image generation", status: statusLabel(item), summary: takeText(budget, item.prompt ?? "Generated image activity", 240).text, detail: renderGeneratedImage(item, budget), open: Boolean(item.result) })}</div>`;
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") return `<div class="timeline-divider"><span>${item.type === "enteredReviewMode" ? "Entered" : "Finished"} review</span><strong>${escapeHtml(takeText(budget, item.review, 1_000).text)}</strong></div>`;
  if (item.type === "contextCompaction") return '<div class="timeline-divider"><span>Context compacted</span><strong>Earlier detail remains in Thread history</strong></div>';
  if (item.type === "hookPrompt") return `<div class="timeline-divider"><span>Project instructions</span><strong>${escapeHtml((item.fragments ?? []).map((fragment) => fragment.text ?? fragment.content ?? "").join(" ").slice(0, 120))}</strong></div>`;
  if (item.type === "turnError") return `<section class="turn-error"><strong>${item.willRetry ? "Codex is retrying" : "This Turn stopped"}</strong><p>${escapeHtml(takeText(budget, item.message, 4_000).text)}</p>${item.willRetry ? '<span class="retrying">Retrying…</span>' : `<button type="button" data-retry-turn="${escapeHtml(item._turnId)}">Retry as a new Turn</button>`}</section>`;
  if (item.type === "turnBoundary") return `<div class="turn-boundary ${escapeHtml(item.status)}"><span>${item.status === "interrupted" ? "Turn interrupted" : "Turn failed"}</span><strong>${escapeHtml(takeText(budget, item.message ?? (item.status === "interrupted" ? "Partial output remains in Thread history." : "The error remains inspectable in this Thread."), 4_000).text)}</strong></div>`;
  return `<div class="activity-row">${disclosureCard({ identity, kind: "unknown", icon: "?", title: item.type ?? "Unsupported item", status: statusLabel(item), summary: "Inspect raw app-server item; no result inferred", detail: boundedPre(JSON.stringify(item, null, 2), "", 8_000, budget) })}</div>`;
}

function approvalMarkup(request) {
  const params = request.params ?? {};
  const descriptor = requestDescriptor(request);
  const fixtureDecisionDisabled = request.fixture ? " disabled title=\"Review fixture only\"" : "";
  if (!descriptor.supported) {
    return `<section class="approval-card unsupported-request" data-request-id="${escapeHtml(request.id)}" role="status"><header><span>Unsupported runtime request</span><em>Resolved by carrier</em></header><strong>${escapeHtml(request.method)}</strong><p>This request is never presented as a command approval. Its exact payload remains inspectable in the bounded event log.</p></section>`;
  }
  if (descriptor.kind === "userInput") {
    const titleId = `request-title-${String(request.id).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const questions = (params.questions ?? []).map((question, index) => {
    const id = question.id ?? `question-${index}`;
      const name = `request-${request.id}-${id}`;
      const options = (question.options ?? []).map((option) => `<label class="request-option"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(option.label ?? option)}"> <span>${escapeHtml(option.label ?? option)}${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span></label>`).join("");
      const other = question.isOther ? `<label class="request-option request-other"><input type="radio" name="${escapeHtml(name)}" value="__other__"> <span>Other</span><input type="${question.isSecret ? "password" : "text"}" data-request-other="${escapeHtml(id)}" aria-label="Other answer for ${escapeHtml(question.header)}" autocomplete="off"></label>` : "";
      const freeform = options
        ? `${options}${other}`
        : `<input class="request-answer" type="${question.isSecret ? "password" : "text"}" data-request-answer="${escapeHtml(id)}" aria-label="${escapeHtml(question.question ?? "Answer Codex")}" autocomplete="off">`;
      return `<fieldset data-question-id="${escapeHtml(id)}" data-secret="${question.isSecret ? "true" : "false"}"><legend><span>${escapeHtml(question.header ?? "Question")}</span>${escapeHtml(question.question ?? "Your answer")}</legend>${freeform}</fieldset>`;
    }).join("");
    return `<section class="approval-card request-input" data-request-id="${escapeHtml(request.id)}" data-blocking="${descriptor.blocking ? "true" : "false"}" role="${descriptor.blocking ? "alertdialog" : "group"}" aria-labelledby="${escapeHtml(titleId)}"><header><span>${descriptor.blocking ? "Needs your input" : "Input requested"}</span><em>${request.fixture ? "Review fixture" : descriptor.blocking ? "Turn paused" : "You can keep working"}</em></header><strong id="${escapeHtml(titleId)}">Codex needs your input</strong><form data-request-form="${escapeHtml(request.id)}">${questions}<footer><button class="accept" type="submit"${fixtureDecisionDisabled}>Send answer</button></footer></form></section>`;
  }
  const isFile = descriptor.kind === "fileApproval";
  const title = isFile ? "Approve file changes?" : "Approve command?";
  const command = params.command ? `<code class="command-line">${escapeHtml(params.command)}</code>` : "";
  const context = [
    params.reason && ["Reason", params.reason],
    params.cwd && ["Working directory", params.cwd],
    params.itemId && ["Execution item", params.itemId],
    params.grantRoot && ["Requested write root", params.grantRoot],
    params.commandActions?.length && ["Parsed actions", JSON.stringify(params.commandActions)],
    params.proposedExecpolicyAmendment?.length && ["Exec policy amendment", params.proposedExecpolicyAmendment.join(" ")],
    params.proposedNetworkPolicyAmendments?.length && ["Network policy amendment", JSON.stringify(params.proposedNetworkPolicyAmendments)],
    params.networkApprovalContext && ["Network context", JSON.stringify(params.networkApprovalContext)],
  ].filter(Boolean).map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(takeText(createRenderBudget({ textCharacters: 8_000 }), value, 2_000).text)}</dd>`).join("");
  return `<section class="approval-card" data-request-id="${escapeHtml(request.id)}" role="alertdialog" aria-label="${escapeHtml(title)}"><header><span>Needs your approval</span><em>${request.fixture ? "Review fixture" : "Turn paused"}</em></header><strong>${escapeHtml(title)}</strong>${command}<dl class="approval-context">${context}</dl><footer><button class="accept" type="button" data-request-decision="accept" data-request-id="${escapeHtml(request.id)}"${fixtureDecisionDisabled}>Allow once</button><button type="button" data-request-decision="acceptForSession" data-request-id="${escapeHtml(request.id)}"${fixtureDecisionDisabled}>Allow for session</button><button type="button" data-request-decision="decline" data-request-id="${escapeHtml(request.id)}"${fixtureDecisionDisabled}>Decline</button><button class="danger" type="button" data-request-decision="cancel" data-request-id="${escapeHtml(request.id)}"${fixtureDecisionDisabled}>Cancel & interrupt</button></footer></section>`;
}

const groupableActivityTypes = new Set(["commandExecution", "fileChange", "turnDiff", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView", "sleep", "imageGeneration"]);

function renderTimelineItems(items) {
  const budget = createRenderBudget();
  const output = [];
  let group = [];
  let groupOrdinal = 0;
  const flush = () => {
    if (!group.length) return;
    const running = group.some((item) => item._live || ["inProgress", "running"].includes(item.status));
    const failed = group.some((item) => ["failed", "declined", "errored"].includes(item.status));
    const files = group.filter((item) => item.type === "fileChange").flatMap((item) => item.changes ?? []).length;
    const label = running ? "Working…" : failed ? "Work needs attention" : "Worked on this Turn";
    const detail = `${group.length} activit${group.length === 1 ? "y" : "ies"}${files ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}`;
    const identity = `${group[0]._threadId ?? "thread"}--${group[0]._turnId ?? "turn"}--${groupOrdinal++}`;
    output.push(`<details class="activity-group" data-render-key="group-${escapeHtml(identity)}" data-disclosure-id="group-${escapeHtml(identity)}" ${running || failed ? "open" : ""}><summary><span><i>${running ? "↻" : failed ? "!" : "✓"}</i><strong>${label}</strong></span><em>${detail}</em></summary><div>${group.map((item) => renderItem(item, budget)).join("")}</div></details>`);
    group = [];
  };
  for (const item of items) {
    if (groupableActivityTypes.has(item.type) && (!group.length || group[0]._turnId === item._turnId)) group.push(item);
    else {
      flush();
      if (groupableActivityTypes.has(item.type)) group.push(item);
      else output.push(`<div class="timeline-entry" data-render-key="${escapeHtml(item._key ?? item.id)}">${renderItem(item, budget)}</div>`);
    }
  }
  flush();
  return output.join("");
}

function turnsMarkup(thread) {
  const mounted = timelineWindow(thread, state, { limit: 240 });
  const approvals = state.pendingRequests.filter((request) => request.params?.threadId === state.activeThreadId);
  return renderTimelineOmission(mounted.omitted) + renderTimelineItems(mounted.items) + approvals.map((request) => `<div class="timeline-entry" data-render-key="request-${escapeHtml(request.id)}">${approvalMarkup(request)}</div>`).join("");
}

function disclosureStates(root = surface) {
  const states = new Map($$("details[data-disclosure-id]", root).map((detail) => [detail.dataset.disclosureId, detail.open]));
  if (root.matches?.("details[data-disclosure-id]")) states.set(root.dataset.disclosureId, root.open);
  return states;
}

function restoreDisclosureStates(states, root = surface) {
  if (root.matches?.("details[data-disclosure-id]") && states.has(root.dataset.disclosureId)) root.open = states.get(root.dataset.disclosureId);
  for (const detail of $$("details[data-disclosure-id]", root)) {
    if (states.has(detail.dataset.disclosureId)) detail.open = states.get(detail.dataset.disclosureId);
  }
}

function rememberRequestDraft(target) {
  const form = target?.closest?.("[data-request-form]");
  if (!form) return;
  saveRequestDraft(state.requestDrafts, form.dataset.requestForm, requestDraftFromForm(form));
}

// Snapshot every pending request form before its DOM is torn down, so values
// set without an input event (autofill, password managers) survive as well.
function captureRequestDrafts(root) {
  for (const form of $$("[data-request-form]", root)) saveRequestDraft(state.requestDrafts, form.dataset.requestForm, requestDraftFromForm(form));
}

function restoreRequestDrafts(root) {
  const forms = root.matches?.("[data-request-form]") ? [root] : $$("[data-request-form]", root);
  for (const form of forms) {
    const draft = loadRequestDraft(state.requestDrafts, form.dataset.requestForm);
    if (draft) applyRequestDraft(form, draft);
  }
}

function transcriptSelectionActive() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  return surface.contains(range.commonAncestorContainer);
}

function focusSignature(element, entry) {
  if (!element || !entry) return null;
  if (element.matches("summary")) return "summary";
  if (element.matches("pre[tabindex]")) return "pre[tabindex]";
  if (element.matches('input[type="radio"][name]')) return `input[type="radio"][name="${CSS.escape(element.name)}"][value="${CSS.escape(element.value)}"]`;
  for (const attribute of ["data-copy-code", "data-copy-message", "data-quote-message", "data-copy-citation-thread", "data-retry-turn", "data-request-decision", "data-request-other", "data-request-answer"]) {
    if (element.hasAttribute(attribute)) return `[${attribute}="${CSS.escape(element.getAttribute(attribute))}"]`;
  }
  return null;
}

// Keys of mounted entries the live selection touches. Those nodes are held in
// place (and flagged) until the selection ends; see timeline-reconcile.mjs.
function selectionProtectedKeys(container) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return new Set();
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(container)) return new Set();
  return new Set($$(":scope > [data-render-key]", container).filter((entry) => range.intersectsNode(entry)).map((entry) => entry.dataset.renderKey));
}

function patchTimeline(container, markup) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const nextEntries = [...template.content.children];
  const nextByKey = new Map(nextEntries.map((entry) => [entry.dataset.renderKey, entry]));
  const current = new Map($$(":scope > [data-render-key]", container).map((entry) => [entry.dataset.renderKey, entry]));
  const plan = planTimelineReconciliation(
    [...current].map(([key, entry]) => ({ key, html: entry.outerHTML })),
    nextEntries.map((entry) => ({ key: entry.dataset.renderKey, html: entry.outerHTML })),
    selectionProtectedKeys(container),
  );
  const replace = new Set(plan.replace);
  const defer = new Set(plan.defer);
  plan.order.forEach((key, index) => {
    const existing = current.get(key);
    const next = nextByKey.get(key);
    let mounted = existing;
    if (!existing) {
      restoreRequestDrafts(next);
      mounted = next;
    } else if (replace.has(key)) {
      const focused = existing.contains(document.activeElement) ? document.activeElement : null;
      const signature = focusSignature(focused, existing);
      const disclosures = disclosureStates(existing);
      captureRequestDrafts(existing);
      existing.replaceWith(next);
      restoreDisclosureStates(disclosures, next);
      restoreRequestDrafts(next);
      if (signature) next.querySelector(signature)?.focus({ preventScroll: true });
      mounted = next;
    }
    mounted.toggleAttribute("data-paint-deferred", defer.has(key));
    const atIndex = container.children[index];
    if (atIndex !== mounted) container.insertBefore(mounted, atIndex ?? null);
  });
  for (const key of plan.remove) current.get(key).remove();
  for (const key of plan.defer) current.get(key)?.toggleAttribute("data-paint-deferred", true);
  state.paintDeferred = plan.defer.length > 0;
  return plan;
}

function renderChat({ preserveScroll = false } = {}) {
  setRouteHeader(state.activeThread ? titleForThread(state.activeThread) : "Codex", state.activeThread ? `${state.fixtureMode ? "Review fixture · not runtime history" : `Thread ${state.activeThread.id.slice(0, 8)}…`} · ${state.bootstrap?.graph.project.name}` : "Your real Threads and Turns");
  const existingFork = surface.querySelector("[data-fork-thread]");
  if (existingFork) existingFork.disabled = state.fixtureMode || state.running;
  if (!state.activeThread) {
    const project = state.bootstrap?.project;
    const secondary = scopeBound()
      ? '<button class="secondary-button" type="button" data-route="tasks">Open Task Graph</button>'
      : project?.scope === "unbound" && !state.bootstrap?.stop
        ? '<button class="secondary-button" type="button" data-open-import>Set up from Codex…</button>'
        : `<button class="secondary-button" type="button" data-route="tasks">Why Tasks are unavailable</button>`;
    const note = scopeBound()
      ? "VibeHub adds a durable Task only when the work needs an explicit outcome and stopping contract."
      : project?.scope === "unbound"
        ? "This repository is not set up as a VibeHub Project yet. Chat works as usual; Tasks wait for an explicit Codex Project import."
        : `VibeHub Task actions are unavailable here: ${project?.reason ?? "no bound Project"}`;
    surface.innerHTML = `<div class="welcome"><img class="welcome-mark" src="/vibehub-mark.svg" alt=""><h1>What do you want to work on?</h1><p>Start with ordinary Codex Chat. ${escapeHtml(note)}</p><div class="welcome-actions"><button class="primary-button" type="button" data-new-thread ${state.bootstrap?.stop ? "disabled" : ""}>Start a chat</button>${secondary}</div></div>`;
    return;
  }
  const selecting = preserveScroll && transcriptSelectionActive();
  const heldScrollTop = surface.scrollTop;
  const distanceFromBottom = surface.scrollHeight - surface.scrollTop - surface.clientHeight;
  const activeProjectId = state.activeThread.project?.id ?? null;
  const pinnedId = state.bootstrap?.capabilities?.pinnedSectionId;
  const projectOptions = [`<option value=""${activeProjectId === null ? " selected" : ""}>Recents</option>`, ...(pinnedId ? [`<option value="${escapeHtml(pinnedId)}"${activeProjectId === pinnedId ? " selected" : ""}>Pinned</option>`] : []), ...state.projects.map((project) => `<option value="${escapeHtml(project.id)}"${activeProjectId === project.id ? " selected" : ""}>${escapeHtml(project.name)}</option>`)].join("");
  const lineage = state.activeThread.forkedFromId ? ` · Fork of ${state.activeThread.forkedFromId}` : "";
  const existingTimeline = $("#turns");
  if (preserveScroll && existingTimeline) {
    patchTimeline(existingTimeline, turnsMarkup(state.activeThread));
    $("#streamStatus").textContent = state.paintDeferred
      ? "Codex response updated. The selected passage keeps its current text until you release the selection."
      : state.running ? "Codex response updated." : "Codex response settled.";
  } else {
    captureRequestDrafts(surface);
    surface.innerHTML = `<div class="chat-view"><header class="thread-heading"><div><h1 id="activeThreadTitle" tabindex="-1">${escapeHtml(titleForThread(state.activeThread))}</h1><p>${escapeHtml(state.activeThread.cwd ?? state.bootstrap.graph.project.repositoryRoot)} · ${escapeHtml(state.activeThread.id)}${escapeHtml(lineage)}</p></div><div class="thread-actions"><label><span class="sr-only">Move Chat to group</span><select id="activeThreadProject" aria-label="Move Chat to group">${projectOptions}</select></label><button type="button" data-fork-thread="${escapeHtml(state.activeThread.id)}" aria-label="Fork this chat" title="Fork this chat" ${state.fixtureMode || state.running ? "disabled" : ""}>Fork</button><button type="button" data-archive-thread="${escapeHtml(state.activeThread.id)}">Archive</button></div></header><div class="transcript" id="turns">${turnsMarkup(state.activeThread)}</div><div id="streamAnchor"></div></div>`;
    restoreRequestDrafts(surface);
  }
  requestAnimationFrame(() => {
    if (selecting) surface.scrollTop = heldScrollTop;
    else if (!preserveScroll || distanceFromBottom < 96) surface.scrollTop = surface.scrollHeight;
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
  const svg = graph ? $(".graph-edges", graph) : null;
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
  if (!scopeBound()) {
    setRouteHeader("Tasks", `Unavailable · ${state.bootstrap?.project?.name ?? "no Project"}`);
    surface.innerHTML = scopePanelMarkup("VibeHub Tasks need a bound Project");
    return;
  }
  setRouteHeader("Tasks", `Current graph · ${state.bootstrap.graph.project.name}`);
  const tickets = topologicalTickets(state.bootstrap.graph.tickets, state.bootstrap.graph.relations);
  const phases = tickets.reduce((counts, ticket) => ({ ...counts, [primaryPhase(ticket)]: (counts[primaryPhase(ticket)] ?? 0) + 1 }), {});
  surface.innerHTML = `<div class="tasks-view"><header class="tasks-heading"><div><span class="eyebrow">VIBEHUB · CURRENT WORK</span><h1>Task Graph</h1><p>Tasks organize what Codex work is for, how it progresses, and what counts as done.</p></div><div class="task-summary">${["DRAFT", "READY", "RUNNING", "DONE"].map((phase) => `<span>${phases[phase] ?? 0} ${phase}</span>`).join("")}</div></header><div class="graph"><svg class="graph-edges" aria-hidden="true"></svg>${tickets.map((ticket) => `<button class="task-card" type="button" data-ticket-id="${escapeHtml(ticket.ticketId)}" data-phase="${primaryPhase(ticket)}"><header><span class="phase"><i></i>${primaryPhase(ticket)}</span>${substate(ticket) ? `<span class="substate">${substate(ticket)}</span>` : ""}</header><strong>${escapeHtml(humanize(ticket.ticketId))}</strong><p>${escapeHtml(ticket.outcome)}</p><footer><span>${ticket.relationCounts.prerequisites} in · ${ticket.relationCounts.dependents} out</span><span>→</span></footer></button>`).join("")}</div></div>`;
  requestAnimationFrame(renderGraphEdges);
}

function recommendedAction(handoff) {
  return ({ EXECUTE: "Start in Codex", REFINE: "Continue", CLOSE_OUT: "Verify & close", NEEDS_HUMAN: "Needs you", WAIT: "Waiting", REPLAN: "Replan", DONE: "Done" })[handoff.nextAction.action] ?? handoff.nextAction.action;
}

function taskContextSelectionMarkup() {
  const workspace = state.taskWorkspace;
  if (!workspace) return "";
  const directIds = new Set(workspace.packet.context.directContextIds);
  const included = new Set([...directIds, ...state.taskSelectedContextIds]);
  const selectedItems = workspace.eligibleContexts.filter((item) => included.has(item.contextId));
  const availableItems = workspace.eligibleContexts.filter((item) => !included.has(item.contextId)).slice(0, 8);
  const row = (item, checked) => `<label class="task-context-row"><input type="checkbox" data-task-context-id="${escapeHtml(item.contextId)}" ${checked ? "checked" : ""} ${directIds.has(item.contextId) ? "disabled" : ""}><span><strong>${escapeHtml(item.summary)}</strong><small>${escapeHtml(item.room)} · ${directIds.has(item.contextId) ? "Task contract" : "Next Turn only"}</small></span><em>${escapeHtml(item.type)}</em></label>`;
  return `<div class="task-context-list">${selectedItems.map((item) => row(item, true)).join("")}${availableItems.length ? `<details class="context-picker"><summary>Add Context for the next Turn <span>${availableItems.length}</span></summary><div>${availableItems.map((item) => row(item, false)).join("")}</div></details>` : ""}</div>`;
}

function renderTaskConversation({ preserveScroll = false } = {}) {
  const timeline = $("#taskConversationTimeline");
  if (!timeline || !state.activeThread) return;
  const selecting = preserveScroll && transcriptSelectionActive();
  const heldScrollTop = timeline.scrollTop;
  const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
  if (preserveScroll) patchTimeline(timeline, turnsMarkup(state.activeThread));
  else { captureRequestDrafts(timeline); timeline.innerHTML = turnsMarkup(state.activeThread); restoreRequestDrafts(timeline); }
  requestAnimationFrame(() => {
    if (selecting) timeline.scrollTop = heldScrollTop;
    else if (!preserveScroll || distanceFromBottom < 96) timeline.scrollTop = timeline.scrollHeight;
    else timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight - distanceFromBottom);
  });
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
  const actionLabel = linked && ["EXECUTE", "REFINE"].includes(handoff.nextAction.action) ? "Continue" : recommendedAction(handoff);
  const packet = state.taskWorkspace?.packet;
  const effectiveContextIds = new Set([...(packet?.context.directContextIds ?? []), ...state.taskSelectedContextIds]);
  const effectiveContexts = state.taskWorkspace?.eligibleContexts.filter((item) => effectiveContextIds.has(item.contextId)) ?? [];
  const contextCount = effectiveContexts.length;
  const roomNames = [...new Set(effectiveContexts.map((item) => item.room))].sort();
  const projectLabel = packet?.project.scope === "standalone" ? "Standalone Task" : packet?.project.name ?? state.bootstrap.graph.project.name;
  setRouteHeader(humanize(handoff.ticketId), `Task Workspace · ${handoff.nextAction.action}`, { back: true });
  captureRequestDrafts(surface);
  surface.innerHTML = `<div class="task-workspace"><header class="task-hero"><div><span class="eyebrow">TASK · ${escapeHtml(projectLabel)}</span><h1>${escapeHtml(humanize(handoff.ticketId))}</h1><p>${escapeHtml(handoff.outcome)}</p></div><span class="task-phase"><i></i>${phase}${substate(ticket) ? ` · ${substate(ticket)}` : ""}</span></header><div class="workspace-grid"><div class="workspace-main"><section class="task-intent"><span class="eyebrow">CONTEXT SPACE</span><h2>What this Task is here to finish</h2><p>${escapeHtml(handoff.context)}</p><details><summary>Acceptance and constraints <span>${handoff.acceptance.length}</span></summary><div class="acceptance-list">${handoff.acceptance.map((item) => `<div class="acceptance-row"><i>${handoff.evidence.some((evidence) => evidence.acceptanceIds.includes(item.acceptance_id)) ? "✓" : "○"}</i><span>${escapeHtml(item.criterion)}</span></div>`).join("")}</div>${handoff.constraints?.length ? `<ul class="constraint-list">${handoff.constraints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}</details></section><section class="task-context-panel"><header><div><span class="eyebrow">CONTEXT FOR THE NEXT TURN</span><h2>${contextCount} governed item${contextCount === 1 ? "" : "s"}</h2></div><span>${escapeHtml(roomNames.join(" · ") || "No Room required")}</span></header><p>Included by the Task contract or selected here for one Turn. Reading never grants writeback.</p>${taskContextSelectionMarkup()}<details class="packet-inspector"><summary>Inspect host-owned packet</summary><pre>${escapeHtml(JSON.stringify(packet, null, 2))}</pre></details></section><section class="task-conversation-section"><header><div><span class="eyebrow">TASK CONVERSATION</span><h2>${linked ? escapeHtml(titleForThread(linked)) : "No Codex Thread yet"}</h2></div>${linked ? `<button class="secondary-button" type="button" data-thread-id="${escapeHtml(linked.id)}">Open as Chat</button>` : ""}</header><p>${linked ? "Human messages can explore, steer, approve or interrupt this Task. Codex owns the Thread; VibeHub owns the Task contract." : "Start the recommended action to open a persistent Codex Thread with the exact packet above."}</p><div class="task-conversation-timeline" id="taskConversationTimeline">${state.activeThread ? turnsMarkup(state.activeThread) : '<div class="task-conversation-empty">The first Turn will carry the canonical Task packet. No transcript is invented before that.</div>'}</div></section></div><aside class="workspace-aside"><section class="recommended-section"><span class="eyebrow">RECOMMENDED ACTION</span><button class="recommended" type="button" ${linked ? "data-focus-task-composer" : `data-task-action="${escapeHtml(handoff.nextAction.action)}"`} ${["WAIT", "DONE"].includes(handoff.nextAction.action) && !linked ? "disabled" : ""}><strong>${escapeHtml(actionLabel)}</strong><span>→</span></button><p>${linked ? "Continue in the Task conversation below." : "The local host assembles Project, Context, authority and source citations."}</p></section><section><span class="eyebrow">CURRENT WORK</span><h3>${linked ? `Thread ${escapeHtml(linked.id.slice(0, 8))}…` : "Not started"}</h3><p>${state.running ? "Codex is running now." : linked ? "Thread is ready for the next Turn." : "No execution claim."}</p></section><section><span class="eyebrow">PROOF</span><h3>${handoff.evidence.length} Evidence</h3><p>${handoff.acceptance.length} acceptance criteria · Outcome ${handoff.outcomeRecord ? handoff.outcomeRecord.status : "pending"}</p></section><section><span class="eyebrow">ROOMS & SOURCE</span><p>${escapeHtml(roomNames.join(" · ") || "Standalone")}</p><p>${escapeHtml(handoff.reviewInputs.ticketRef)}<br><strong>${escapeHtml(handoff.reviewInputs.commit?.slice(0, 10) ?? "working tree")}</strong></p></section></aside></div></div>`;
  restoreRequestDrafts(surface);
  syncComposerMode();
}

function renderRooms() {
  setRouteHeader("Rooms", "Durable Project Context");
  const context = state.bootstrap?.contexts?.find((item) => item.contextId === state.activeContextId);
  if (context) {
    surface.innerHTML = `<div class="task-workspace context-focus"><header class="task-hero"><div><span class="eyebrow">CONTEXT · ${escapeHtml(context.room)}</span><h1>${escapeHtml(context.summary)}</h1><p>${escapeHtml(context.type)} · ${escapeHtml(context.contextId)}</p></div><span class="task-phase"><i></i>CONTEXT</span></header><div class="workspace-grid"><div class="workspace-main"><section><span class="eyebrow">DURABLE CLAIM</span><p>${escapeHtml(context.detail)}</p></section><section><span class="eyebrow">TAGS</span><p>${escapeHtml((context.tags ?? []).join(" · "))}</p></section></div><aside class="workspace-aside"><section><span class="eyebrow">SOURCE</span><p>${escapeHtml(context.sourceRef)}</p></section><section><button class="secondary-button" type="button" data-clear-context>Back to Rooms</button></section></aside></div></div>`;
    return;
  }
  if (!scopeBound()) {
    surface.innerHTML = scopePanelMarkup("Rooms need a bound Project");
    return;
  }
  const rooms = state.bootstrap?.project?.rooms;
  if (rooms?.coldStart) {
    surface.innerHTML = `<div class="welcome"><img class="welcome-mark" src="/vibehub-mark.svg" alt=""><h1>Rooms: cold start pending</h1><p>No Room tree is checked in under .vibehub/rooms yet, and this shell never invents one. Run the VibeHub distill Skill to build the Room tree from the repository; durable Context will appear here once it is checked in.</p><p class="muted">Handoff: <code>vibehub-distill</code> in an Agent session for this repository.</p></div>`;
    return;
  }
  surface.innerHTML = `<div class="welcome"><img class="welcome-mark" src="/vibehub-mark.svg" alt=""><h1>Rooms stay Project-native</h1><p>Search can open exact durable Context here. Writeback remains a governed VibeHub action, not automatic Chat harvesting.</p><button class="secondary-button" type="button" id="roomsSearch">Search Context</button></div>`;
}

async function refreshThreads() {
  const data = await api("/api/bootstrap");
  state.bootstrap = data;
  state.threads = data.threads;
  state.projects = data.projects;
  state.pinned = data.pinned;
  state.recents = data.recents;
  if (state.activeThreadId) {
    const metadata = state.threads.find((thread) => thread.id === state.activeThreadId);
    if (metadata && state.activeThread) state.activeThread = { ...state.activeThread, ...metadata };
  }
  state.eventCursor = data.eventCursor;
  state.pendingRequests = data.pendingRequests;
  state.knownRequestIds = new Set(data.pendingRequests.map((request) => String(request.id)));
  pruneRequestDrafts(state.requestDrafts, state.knownRequestIds);
  state.runtimeGeneration = data.runtime.generation;
  state.runtimeAlive = data.runtime.alive;
  updateAttentionState(data.attention);
  renderProjectHeader();
  renderStopBanner();
  $("#accountName").textContent = data.account.authenticated ? "Codex" : "Sign in required";
  $("#accountPlan").textContent = data.account.planType ?? data.account.accountType ?? "Unavailable";
  setRuntimePosture({ alive: data.runtime.alive && data.account.authenticated, generation: data.runtime.generation, label: data.stop ? "Stopped: baseline mismatch" : data.account.authenticated ? (data.runtime.alive ? "Local app-server" : "Runtime unavailable") : "Authentication required" });
  updateSidebar();
}

async function openThread(threadId, { route = "chat" } = {}) {
  const sameSurface = state.activeThreadId === threadId && state.route === route;
  const switchingThread = state.activeThreadId !== threadId;
  if (switchingThread) captureComposerDraft();
  const data = await action({ action: "readThread", threadId });
  state.activeThreadId = threadId;
  state.activeThread = { ...state.threads.find((thread) => thread.id === threadId), ...data.thread };
  state.currentTurnId = liveTurnId(state.activeThread);
  state.running = Boolean(state.currentTurnId);
  syncThreadLocation();
  if (switchingThread) restoreComposerDraft(threadId);
  if (!state.running) {
    for (const [key, item] of state.liveItems) if (item._threadId === threadId) state.liveItems.delete(key);
    for (const map of [state.turnErrors, state.turnPlans, state.turnDiffs]) {
      for (const [key, item] of map) if (item._threadId === threadId) map.delete(key);
    }
  }
  $("#stopTurn").hidden = !state.running;
  updateSidebar();
  if (sameSurface && route === "chat") { renderChat({ preserveScroll: true }); syncComposerMode(); }
  else if (sameSurface && route === "task") { renderTaskConversation({ preserveScroll: true }); syncComposerMode(); }
  else {
    setRoute(route);
    if (route === "chat") afterRenderFocus("#activeThreadTitle");
  }
}

function applyChatNotification(method, params) {
  if (params.threadId !== state.activeThreadId) return false;
  return applyChatEvent(state, method, params);
}

function scheduleChatRender() {
  if (state.chatRenderFrame || !["chat", "task"].includes(state.route) || !state.activeThread) return;
  state.chatRenderFrame = requestAnimationFrame(() => {
    state.chatRenderFrame = 0;
    if (state.route === "chat") renderChat({ preserveScroll: true });
    else renderTaskConversation({ preserveScroll: true });
  });
}

function focusNewBlockingRequest(previousIds) {
  const request = state.pendingRequests.find((entry) => !previousIds.has(String(entry.id)) && requestDescriptor(entry).blocking);
  if (!request) return;
  requestAnimationFrame(() => {
    const card = surface.querySelector(`[data-request-id="${CSS.escape(String(request.id))}"]`);
    state.requestReturnFocus.set(String(request.id), document.activeElement);
    const target = card?.querySelector("input:not([disabled]), textarea:not([disabled]), button:not([disabled])");
    target?.scrollIntoView({ block: "center", behavior: "instant" });
    target?.focus();
    $("#streamStatus").textContent = "Codex needs your input.";
  });
}

async function newThread() {
  if (state.creatingThread) return state.creatingThread;
  state.creatingThread = (async () => {
    $("#newThread").disabled = true;
    captureComposerDraft();
    const data = await action({ action: "newThread" });
    state.threads.unshift(data.thread);
    state.recents.unshift(data.thread);
    state.activeThreadId = data.thread.id;
    state.activeThread = { ...data.thread, turns: [] };
    state.running = false;
    syncThreadLocation();
    state.liveItems.clear();
    state.turnErrors.clear();
    state.turnPlans.clear();
    state.turnDiffs.clear();
    restoreComposerDraft(data.thread.id);
    updateSidebar();
    setRoute("chat");
    $("#composerInput").focus();
    return data.thread;
  })();
  try { return await state.creatingThread; }
  finally { state.creatingThread = null; $("#newThread").disabled = false; }
}

async function forkActiveThread() {
  if (!state.activeThreadId || state.fixtureMode || state.running) return;
  const sourceThreadId = state.activeThreadId;
  try {
    const data = await action({ action: "forkThread", threadId: sourceThreadId });
    state.threads.unshift(data.thread);
    await openThread(data.thread.id);
    $("#composerInput").focus();
    notify("Forked into a new Codex Chat.");
  } catch (error) { notify(error.message); }
}

async function openTask(ticketId) {
  captureComposerDraft();
  state.activeTicketId = ticketId;
  state.activeTask = null;
  state.taskWorkspace = null;
  state.taskSelectedContextIds = new Set();
  setRoute("task");
  try {
    const data = await action({ action: "readTask", ticketId });
    state.activeTask = data.handoff;
    state.taskWorkspace = data;
    state.taskSelectedContextIds = new Set(data.packet.context.selectedContextIds ?? []);
    const linked = state.threads.find((thread) => thread.taskLink?.ticketId === ticketId);
    if (linked) {
      const threadData = await action({ action: "readThread", threadId: linked.id });
      state.activeThreadId = linked.id;
      state.activeThread = { ...linked, ...threadData.thread };
      state.currentTurnId = liveTurnId(state.activeThread);
      state.running = Boolean(state.currentTurnId);
      restoreComposerDraft(linked.id);
    } else {
      state.activeThreadId = null;
      state.activeThread = null;
      state.running = false;
      state.currentTurnId = null;
      restoreComposerDraft(null);
    }
    syncThreadLocation();
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

function renderComposerQuote() {
  const tray = $("#quoteTray");
  tray.hidden = !state.composerQuote;
  const source = state.composerQuote ? `Thread ${state.composerQuote.threadId} · Turn ${state.composerQuote.turnId} · Item ${state.composerQuote.itemId}` : "";
  tray.innerHTML = state.composerQuote ? `<span><strong>Quoted response</strong><small>${escapeHtml(state.composerQuote.text.slice(0, 180))}${state.composerQuote.text.length > 180 ? "…" : ""}</small><small class="quote-source" title="${escapeHtml(source)}" aria-label="${escapeHtml(source)}">From this Codex Turn</small></span><button type="button" data-remove-quote aria-label="Remove quoted response">×</button>` : "";
}

function setComposerQuote({ text, itemKey: sourceKey }) {
  const clean = String(text ?? "").trim();
  if (!clean) return;
  const source = timelineItem(sourceKey);
  state.composerQuote = { text: clean.slice(0, 4_000), itemKey: sourceKey, threadId: source?._threadId ?? state.activeThreadId, turnId: source?._turnId, itemId: source?.id };
  renderComposerQuote();
  $("#quoteSelection").hidden = true;
  $("#composerInput").focus();
  notify("Quote added to your next message.");
}

function autoSizeComposer() {
  const textarea = $("#composerInput");
  const bounds = composerBounds(getComputedStyle(textarea));
  textarea.style.height = "auto";
  textarea.style.height = `${clampComposerHeight(textarea.scrollHeight, bounds)}px`;
}

function captureComposerDraft(threadId = state.activeThreadId) {
  if (!threadId) return;
  saveThreadDraft(state.composerDrafts, threadId, {
    text: $("#composerInput").value,
    quote: state.composerQuote ? structuredClone(state.composerQuote) : null,
    attachments: state.attachments.map((item) => ({ ...item })),
  });
}

function restoreComposerDraft(threadId) {
  const draft = loadThreadDraft(state.composerDrafts, threadId);
  $("#composerInput").value = draft.text;
  state.composerQuote = draft.quote;
  state.attachments = draft.attachments;
  renderComposerQuote();
  renderAttachments();
  autoSizeComposer();
}

function timelineItem(itemKeyValue) {
  return canonicalTimeline(state.activeThread, state, { limit: 240 }).find((item) => item._key === itemKeyValue);
}

function itemText(itemKeyValue) {
  return timelineItem(itemKeyValue)?.text ?? "";
}

function updateQuoteSelection() {
  const button = $("#quoteSelection");
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) { button.hidden = true; return; }
  const range = selection.getRangeAt(0);
  const assistant = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer.closest?.(".turn.assistant")
    : range.commonAncestorContainer.parentElement?.closest(".turn.assistant");
  const text = selection.toString().trim();
  if (!assistant || !surface.contains(assistant) || !text) { button.hidden = true; return; }
  const rect = range.getBoundingClientRect();
  state.selectedQuote = { text, itemKey: assistant.dataset.itemId };
  button.style.left = `${Math.max(8, Math.min(window.innerWidth - 112, rect.left + rect.width / 2 - 52))}px`;
  button.style.top = `${Math.max(8, rect.top - 42)}px`;
  button.hidden = false;
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
    let recordedBytes = 0;
    const recorder = new MediaRecorder(stream);
    state.recorder = recorder;
    state.recordingStream = stream;
    const stopTimer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, MAX_RECORDING_MS);
    recorder.ondataavailable = (event) => {
      if (!event.data.size) return;
      recordedBytes += event.data.size;
      if (recordedBytes <= MAX_ATTACHMENT_BYTES) chunks.push(event.data);
      if (recordedBytes > MAX_ATTACHMENT_BYTES && recorder.state === "recording") recorder.stop();
    };
    recorder.onstop = async () => {
      clearTimeout(stopTimer);
      if (recordedBytes > MAX_ATTACHMENT_BYTES) notify("Voice recording exceeded the 8 MiB local attachment limit and was not attached.");
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const file = new File([blob], "Voice recording.webm", { type: blob.type });
      if (recordedBytes <= MAX_ATTACHMENT_BYTES) addAttachment(file, await fileToDataUrl(file));
      stream.getTracks().forEach((track) => track.stop());
      state.recorder = null;
      state.recordingStream = null;
      $("#voiceButton").classList.remove("recording");
      $("#voiceButton").setAttribute("aria-label", "Record voice input");
      $("#composerNote").textContent = "Voice recording is attached as ordinary Codex audio input.";
    };
    recorder.start(1_000);
    $("#voiceButton").classList.add("recording");
    $("#voiceButton").setAttribute("aria-label", "Stop recording");
    $("#composerNote").textContent = "Recording locally… Select the microphone again to stop.";
  } catch (error) { notify(`Microphone unavailable: ${error.message}`); }
}

async function submitTurn(event) {
  event.preventDefault();
  const textarea = $("#composerInput");
  const text = textarea.value.trim();
  if (!text && !state.attachments.length && !state.composerQuote) return;
  const composedText = composeQuotedMessage(state.composerQuote, text);
  try {
    if (state.route === "task") {
      if (!state.activeTicketId || !state.activeThreadId) return notify("Start this Task before sending a message.");
      if (!composedText) return notify("Add a message for this Task Turn.");
      const taskAction = state.running ? "steerTaskTurn" : "startTaskTurn";
      const result = await action({
        action: taskAction,
        ticketId: state.activeTicketId,
        threadId: state.activeThreadId,
        expectedTurnId: state.running ? state.currentTurnId : undefined,
        message: composedText,
        selectedContextIds: [...state.taskSelectedContextIds],
        attachments: state.attachments.map(({ type, url }) => ({ type, url })),
      });
      if (!state.running) state.currentTurnId = result.turn?.id ?? result.turnId;
      state.running = true;
      textarea.value = "";
      state.composerQuote = null;
      renderComposerQuote();
      autoSizeComposer();
      state.attachments = [];
      renderAttachments();
      state.composerDrafts.delete(state.activeThreadId);
      $("#stopTurn").hidden = false;
      await openThread(state.activeThreadId, { route: "task" });
      return;
    }
    if (!state.activeThreadId) await newThread();
    const input = [];
    if (composedText) input.push({ type: "text", text: composedText });
    input.push(...state.attachments.map(({ type, url }) => ({ type, url })));
    if (state.running && !state.currentTurnId) return notify("Wait for the active Turn identity before steering it.");
    const result = await action({ action: state.running ? "steerTurn" : "startTurn", threadId: state.activeThreadId, expectedTurnId: state.running ? state.currentTurnId : undefined, input });
    if (!state.running) state.currentTurnId = result.turn.id;
    state.running = true;
    textarea.value = "";
    state.composerQuote = null;
    renderComposerQuote();
    autoSizeComposer();
    state.attachments = [];
    renderAttachments();
    state.composerDrafts.delete(state.activeThreadId);
    $("#stopTurn").hidden = false;
    syncComposerMode();
    await openThread(state.activeThreadId);
  } catch (error) { notify(error.message); }
}

async function pollEvents() {
  try {
    const previousRequestIds = new Set(state.pendingRequests.map((request) => String(request.id)));
    const focusedRequestId = document.activeElement?.closest?.("[data-request-id]")?.dataset.requestId;
    const previousGeneration = state.runtimeGeneration;
    const data = await api(`/api/events?after=${state.eventCursor}`);
    state.eventCursor = data.cursor;
    state.pendingRequests = data.pendingRequests;
    state.knownRequestIds = new Set(data.pendingRequests.map((request) => String(request.id)));
    pruneRequestDrafts(state.requestDrafts, state.knownRequestIds);
    setRuntimePosture({ alive: data.runtimeAlive, generation: data.runtimeGeneration });
    let refreshRequests = false;
    let reconcile = data.gap || data.runtimeGeneration !== previousGeneration;
    let rendered = false;
    for (const entry of data.events) {
      if (entry.kind === "serverRequest" || entry.kind === "requestResolved") refreshRequests = true;
      if (entry.kind === "runtimeExit") {
        setRuntimePosture({ alive: false, generation: entry.value.runtimeGeneration, label: "Runtime exited" });
        reconcile = false;
      }
      if (entry.kind !== "notification") continue;
      const method = entry.value.method;
      const params = entry.value.params ?? {};
      if (method === "serverRequest/resolved") refreshRequests = true;
      if (params.threadId !== state.activeThreadId) continue;
      if (method === "turn/started") {
        state.running = true;
        state.currentTurnId = params.turn?.id;
        $("#stopTurn").hidden = false;
        syncComposerMode();
      }
      if (method === "turn/completed") {
        state.running = false;
        state.currentTurnId = null;
        $("#stopTurn").hidden = true;
        syncComposerMode();
        reconcile = true;
      }
      rendered = applyChatNotification(method, params) || rendered;
    }
    if (reconcile && state.activeThreadId && state.runtimeAlive) await openThread(state.activeThreadId, { route: state.route === "task" ? "task" : "chat" });
    else if ((rendered || refreshRequests) && state.activeThreadId) scheduleChatRender();
    focusNewBlockingRequest(previousRequestIds);
    if (focusedRequestId && !state.knownRequestIds.has(focusedRequestId)) requestAnimationFrame(() => $("#composerInput")?.focus({ preventScroll: true }));
    state.attentionPollCounter += 1;
    if (state.attentionPollCounter >= 12) {
      state.attentionPollCounter = 0;
      await refreshThreads();
    }
  } catch (error) {
    setRuntimePosture({ alive: false, label: "Runtime reconnecting" });
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
  if (thread && suppressThreadClick === thread.dataset.threadId) {
    event.preventDefault();
    suppressThreadClick = null;
    return;
  }
  if (thread) { await openThread(thread.dataset.threadId); focusRouteHeading(); return; }
  const ticket = event.target.closest("[data-ticket-id]");
  if (ticket) { closeInbox(false); await openTask(ticket.dataset.ticketId); return; }
  if (event.target.closest("[data-clear-context]")) { state.activeContextId = null; renderRooms(); return; }
  if (event.target.closest("#roomsSearch")) { openSearch(); return; }
  if (event.target.closest("[data-new-thread]")) { await newThread(); return; }
  if (event.target.closest("[data-open-import]")) { await openImport(); return; }
  const importRow = event.target.closest("[data-import-section]");
  if (importRow) {
    if (importRow.disabled) return;
    state.importSelectedId = state.importSelectedId === importRow.dataset.importSection ? null : importRow.dataset.importSection;
    renderImportRows();
    $(`[data-import-section="${CSS.escape(importRow.dataset.importSection)}"]`)?.focus();
    return;
  }
  const toggleProject = event.target.closest("[data-toggle-project]");
  if (toggleProject) {
    const group = toggleProject.closest(".project-group");
    const collapsed = group.classList.toggle("collapsed");
    toggleProject.setAttribute("aria-expanded", String(!collapsed));
    toggleProject.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${toggleProject.querySelector("strong").textContent} group`);
    return;
  }
  const renameProject = event.target.closest("[data-rename-project]");
  if (renameProject) {
    const project = state.projects.find((item) => item.id === renameProject.dataset.renameProject);
    const name = prompt("Rename chat group", project?.name ?? "");
    if (name?.trim()) {
      try { await action({ action: "renameProject", projectId: renameProject.dataset.renameProject, name }); await refreshThreads(); notify("Chat group renamed."); }
      catch (error) { notify(error.message); }
    }
    return;
  }
  const deleteProject = event.target.closest("[data-delete-project]");
  if (deleteProject) {
    const project = state.projects.find((item) => item.id === deleteProject.dataset.deleteProject);
    if (confirm(`Delete the “${project?.name ?? "selected"}” chat group? Its Chats will return to Recents.`)) {
      try { await action({ action: "deleteProject", projectId: deleteProject.dataset.deleteProject }); await refreshThreads(); if (state.route === "chat") renderChat(); notify("Chat group deleted. Chats returned to Recents."); }
      catch (error) { notify(error.message); }
    }
    return;
  }
  const forkThread = event.target.closest("[data-fork-thread]");
  if (forkThread) {
    try {
      const result = await action({ action: "forkThread", threadId: forkThread.dataset.forkThread });
      await refreshThreads();
      await openThread(result.thread.id);
      notify(result.placement?.applied
        ? "Chat forked with its source group and lineage."
        : "Chat forked; its source group changed, so the fork stayed in Recents.");
    } catch (error) { notify(error.message); }
    return;
  }
  const archiveThread = event.target.closest("[data-archive-thread]");
  if (archiveThread) {
    try {
      await action({ action: "archiveThread", threadId: archiveThread.dataset.archiveThread });
      state.activeThreadId = null;
      state.activeThread = null;
      syncThreadLocation();
      await refreshThreads();
      setRoute("chat");
      notify("Chat archived.");
    } catch (error) { notify(error.message); }
    return;
  }
  const remove = event.target.closest("[data-remove-attachment]");
  if (remove) { state.attachments.splice(Number(remove.dataset.removeAttachment), 1); renderAttachments(); return; }
  if (event.target.closest("[data-remove-quote]")) { state.composerQuote = null; renderComposerQuote(); return; }
  if (event.target.closest("#quoteSelection") && state.selectedQuote) { setComposerQuote(state.selectedQuote); return; }
  const quoteMessage = event.target.closest("[data-quote-message]");
  if (quoteMessage) { setComposerQuote({ text: itemText(quoteMessage.dataset.quoteMessage), itemKey: quoteMessage.dataset.quoteMessage }); return; }
  const copyCode = event.target.closest("[data-copy-code]");
  if (copyCode) { await navigator.clipboard.writeText(copyCode.parentElement.querySelector("code")?.textContent ?? ""); notify("Code copied."); return; }
  const copyMessage = event.target.closest("[data-copy-message]");
  if (copyMessage) {
    const item = timelineItem(copyMessage.dataset.copyMessage);
    if (item?.text) {
      await navigator.clipboard.writeText(item.text);
      notify("Response copied.");
    }
    return;
  }
  const copyCitationThread = event.target.closest("[data-copy-citation-thread]");
  if (copyCitationThread) { await navigator.clipboard.writeText(copyCitationThread.dataset.copyCitationThread); notify("Source Thread id copied."); return; }
  const decision = event.target.closest("[data-request-decision]");
  if (decision) {
    const requestId = decision.dataset.requestId;
    const returnFocus = state.requestReturnFocus.get(requestId);
    try { await action({ action: "resolveRequest", requestId, decision: decision.dataset.requestDecision }); await openThread(state.activeThreadId, { route: state.route === "task" ? "task" : "chat" }); (returnFocus?.isConnected ? returnFocus : $("#composerInput")).focus(); state.requestReturnFocus.delete(requestId); }
    catch (error) { notify(error.message); }
    return;
  }
  const retry = event.target.closest("[data-retry-turn]");
  if (retry) {
    const turn = state.activeThread?.turns?.find((entry) => entry.id === retry.dataset.retryTurn);
    const prior = turn?.items?.find((item) => item.type === "userMessage");
    $("#composerInput").value = userInputText(prior?.content);
    autoSizeComposer();
    $("#composerInput").focus();
    notify("Previous request restored. Sending will create a new Turn.");
    return;
  }
  const taskAction = event.target.closest("[data-task-action]");
  if (taskAction) {
    const next = taskAction.dataset.taskAction;
    if (next === "EXECUTE" || next === "REFINE") {
      taskAction.disabled = true;
      try {
        const started = await action({ action: "startTask", ticketId: state.activeTicketId, selectedContextIds: [...state.taskSelectedContextIds] });
        await refreshThreads();
        await openThread(started.threadId, { route: "task" });
      } catch (error) { notify(error.message); taskAction.disabled = false; }
    } else if (next === "CLOSE_OUT") notify("Independent closeout remains a separate VibeHub action.");
    else if (next === "NEEDS_HUMAN") notify("This Task is waiting for your explicit decision.");
    return;
  }
  if (event.target.closest("[data-focus-task-composer]")) { $("#composerInput").focus(); return; }
});

document.addEventListener("focusin", (event) => {
  if (rerenderFocusSelector && !event.target.matches(rerenderFocusSelector)) rerenderFocusSelector = null;
});

document.addEventListener("submit", async (event) => {
  const form = event.target.closest("[data-request-form]");
  if (!form) return;
  event.preventDefault();
  const { answers, invalid } = answersFromDraft(requestDraftFromForm(form));
  if (invalid) { notify("Answer every question before sending."); form.querySelector("input:not([disabled]), textarea:not([disabled])")?.focus(); return; }
  const requestId = form.dataset.requestForm;
  const returnFocus = state.requestReturnFocus.get(requestId);
  try { await action({ action: "resolveRequest", requestId, answers }); state.requestDrafts.delete(requestId); await openThread(state.activeThreadId, { route: state.route === "task" ? "task" : "chat" }); (returnFocus?.isConnected ? returnFocus : $("#composerInput")).focus(); state.requestReturnFocus.delete(requestId); }
  catch (error) { notify(error.message); }
});

document.addEventListener("change", async (event) => {
  rememberRequestDraft(event.target);
  if (event.target.id === "activeThreadProject") {
    try {
      const projectId = event.target.value || null;
      await moveThreadToProject(state.activeThreadId, projectId, "#activeThreadProject");
    } catch (error) { notify(error.message); }
    return;
  }
  const contextInput = event.target.closest("[data-task-context-id]");
  if (!contextInput || contextInput.disabled) return;
  if (contextInput.checked) state.taskSelectedContextIds.add(contextInput.dataset.taskContextId);
  else state.taskSelectedContextIds.delete(contextInput.dataset.taskContextId);
  renderTaskWorkspace();
  $("#composerInput").focus();
});

$("#newThread").addEventListener("click", newThread);
$("#createProject").addEventListener("click", async () => {
  const name = prompt("New chat group name");
  if (!name?.trim()) return;
  try { await action({ action: "createProject", name }); await refreshThreads(); notify("Chat group created."); }
  catch (error) { notify(error.message); }
});
$("#importProject").addEventListener("click", openImport);
$("#closeImport").addEventListener("click", () => closeImport());
$("#confirmImport").addEventListener("click", confirmImport);
$("#refreshThreads").addEventListener("click", async () => { await refreshThreads(); updateSidebar(); notify("Codex Chat history refreshed."); });
$("#searchButton").addEventListener("click", openSearch);
$("#searchInput").addEventListener("input", () => { state.searchIndex = 0; renderSearchResults(); });
$("#inboxButton").addEventListener("click", openInbox);
$("#closeInbox").addEventListener("click", () => closeInbox());
$("#collapseSidebar").addEventListener("click", () => {
  if (isNarrowLayout()) closeMobileSidebar();
  else appShell.classList.toggle("sidebar-collapsed");
});
$("#openSidebar").addEventListener("click", openMobileSidebar);
backButton.addEventListener("click", () => {
  const ticketId = state.activeTicketId;
  setRoute("tasks");
  requestAnimationFrame(() => document.querySelector(`[data-ticket-id="${CSS.escape(ticketId)}"]`)?.focus());
});
$("#attachButton").addEventListener("click", () => $("#attachmentInput").click());
$("#attachmentInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file?.size > MAX_ATTACHMENT_BYTES) notify("Attachments must be 8 MiB or smaller before encoding.");
  else if (file) addAttachment(file, await fileToDataUrl(file));
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
$("#composerInput").addEventListener("input", autoSizeComposer);
document.addEventListener("input", (event) => {
  const other = event.target.closest?.("[data-request-other]");
  if (other) {
    const radio = other.closest(".request-other")?.querySelector('input[type="radio"]');
    if (radio && other.value) radio.checked = true;
  }
  rememberRequestDraft(event.target);
});
document.addEventListener("selectionchange", () => {
  requestAnimationFrame(updateQuoteSelection);
  if (state.paintDeferred && !transcriptSelectionActive()) scheduleChatRender();
});
$("#stopTurn").addEventListener("click", async () => {
  if (!state.activeThreadId || !state.currentTurnId) return;
  try { await action({ action: "interruptTurn", threadId: state.activeThreadId, turnId: state.currentTurnId }); }
  catch (error) { notify(error.message); }
});
$("#reviewButton").addEventListener("click", () => { closeSearch(false); closeInbox(false); closeImport(false); $("#reviewPanel").hidden = false; $("#reviewPanel").inert = false; syncScrim(); $("#closeReview").focus(); });
$("#closeReview").addEventListener("click", () => { $("#reviewPanel").hidden = true; $("#reviewPanel").inert = true; syncScrim(); $("#reviewButton").focus(); });
$("#scrim").addEventListener("click", () => {
  if (!$("#searchDialog").hidden) closeSearch();
  else if (!$("#importDialog").hidden) closeImport();
  else if (!$("#inboxPanel").hidden) closeInbox();
  else if (!$("#reviewPanel").hidden) $("#closeReview").click();
  else if (appShell.classList.contains("sidebar-open")) closeMobileSidebar();
});
$("#themeToggle").addEventListener("click", () => {
  const themes = ["system", "light", "dark"];
  state.themeIndex = (state.themeIndex + 1) % themes.length;
  const theme = themes[state.themeIndex];
  document.documentElement.dataset.theme = theme;
  appShell.dataset.theme = theme;
  $("#themeLabel").textContent = theme[0].toUpperCase() + theme.slice(1);
});

document.addEventListener("keydown", (event) => {
  const modal = [$("#searchDialog"), $("#importDialog"), $("#inboxPanel"), $("#reviewPanel"), appShell.classList.contains("sidebar-open") ? sidebar : null].find((element) => element && !element.hidden && !element.inert);
  if (event.key === "Tab" && modal) {
    const focusable = $$("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])", modal).filter((element) => !element.hidden && element.getClientRects().length);
    if (focusable.length) {
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!modal.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }
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
    else if (!$("#importDialog").hidden) closeImport();
    else if (!$("#inboxPanel").hidden) closeInbox();
    else if (!$("#reviewPanel").hidden) $("#closeReview").click();
    else if (appShell.classList.contains("sidebar-open")) closeMobileSidebar();
    else if (state.running && $("#composer").contains(document.activeElement)) $("#stopTurn").click();
  }
  if (event.metaKey && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
  if (event.metaKey && event.key.toLowerCase() === "n") { event.preventDefault(); newThread(); }
});

function clearPointerDrag() {
  pointerDrag?.source?.classList.remove("dragging");
  $$("[data-project-drop]").forEach((target) => target.classList.remove("drag-over"));
  pointerDrag = null;
}

function pointerDropTarget(event) {
  return document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-project-drop]") ?? null;
}

document.addEventListener("pointerdown", (event) => {
  const thread = event.target.closest(".thread-button[data-thread-id]");
  if (!thread || event.button !== 0 || !event.isPrimary) return;
  pointerDrag = {
    pointerId: event.pointerId,
    threadId: thread.dataset.threadId,
    source: thread,
    startX: event.clientX,
    startY: event.clientY,
    dragging: false,
  };
  thread.setPointerCapture?.(event.pointerId);
});

document.addEventListener("pointermove", (event) => {
  if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
  if (!pointerDrag.dragging && Math.hypot(event.clientX - pointerDrag.startX, event.clientY - pointerDrag.startY) < 8) return;
  pointerDrag.dragging = true;
  pointerDrag.source.classList.add("dragging");
  event.preventDefault();
  const target = pointerDropTarget(event);
  $$("[data-project-drop]").forEach((candidate) => candidate.classList.toggle("drag-over", candidate === target));
});

document.addEventListener("pointercancel", clearPointerDrag);

document.addEventListener("pointerup", async (event) => {
  if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
  const drag = pointerDrag;
  const target = drag.dragging ? pointerDropTarget(event) : null;
  clearPointerDrag();
  if (!target) return;
  event.preventDefault();
  suppressThreadClick = drag.threadId;
  setTimeout(() => { if (suppressThreadClick === drag.threadId) suppressThreadClick = null; }, 0);
  const projectId = target.dataset.projectDrop === "recent" ? null : target.dataset.projectDrop;
  try {
    await moveThreadToProject(drag.threadId, projectId, `[data-thread-id="${CSS.escape(drag.threadId)}"]`);
  } catch (error) { notify(error.message); }
});

window.matchMedia("(max-width: 760px)").addEventListener("change", () => {
  if (!isNarrowLayout()) appShell.classList.remove("sidebar-open");
  syncSidebarAccessibility();
  syncScrim();
});

async function start() {
  try {
    const themes = ["system", "light", "dark"];
    state.themeIndex = 0;
    const theme = themes[state.themeIndex];
    document.documentElement.dataset.theme = theme;
    appShell.dataset.theme = theme;
    $("#themeLabel").textContent = theme[0].toUpperCase() + theme.slice(1);
    syncSidebarAccessibility();
    await refreshThreads();
    const params = new URLSearchParams(location.search);
    if (params.get("projectFixture") === "matrix") {
      const fixture = await fetch("/project-fixtures.json").then((response) => response.json());
      state.fixtureMode = true;
      state.projects = fixture.projects;
      state.pinned = fixture.pinned ?? [];
      state.recents = fixture.recents;
      state.threads = [...state.pinned, ...fixture.recents, ...fixture.projects.flatMap((project) => project.threads)];
      const scopeVariant = fixture.scopes?.[params.get("scope") ?? ""];
      if (scopeVariant) {
        state.bootstrap = { ...state.bootstrap, project: scopeVariant, stop: null };
        renderProjectHeader();
        renderStopBanner();
      }
      updateSidebar();
    }
    const requestedThreadId = params.get("thread");
    if (requestedThreadId) {
      try {
        await openThread(requestedThreadId);
      } catch (error) {
        // A stale deep link (archived or foreign Thread) must not brick the
        // shell: drop it from the URL and land on ordinary Chat.
        state.activeThreadId = null;
        state.activeThread = null;
        syncThreadLocation();
        setRoute("chat");
        notify(`Could not reopen Thread ${requestedThreadId.slice(0, 8)}…: ${error.message}`);
      }
      pollEvents();
      return;
    }
    const taskFixtureName = params.get("taskFixture");
    if (taskFixtureName) {
      const fixture = await fetch("/task-fixtures.json").then((response) => response.json());
      const variant = fixture.variants[taskFixtureName] ?? fixture.variants.ready;
      state.fixtureMode = true;
      state.threads = state.threads.filter((thread) => thread.id !== fixture.thread.id && thread.taskLink?.ticketId !== fixture.ticketId);
      state.activeTicketId = fixture.ticketId;
      state.activeTask = structuredClone(fixture.handoff);
      state.activeTask.nextAction = { action: variant.nextAction, reason: "review_fixture" };
      state.activeTask.operationalState = variant.nextAction === "DONE" ? "DONE" : variant.nextAction === "REPLAN" ? "DEVIATED" : "READY";
      if (variant.outcome) state.activeTask.outcomeRecord = { status: variant.outcome };
      state.taskWorkspace = {
        handoff: state.activeTask,
        packet: structuredClone(fixture.packet),
        eligibleContexts: fixture.eligibleContexts,
        rooms: fixture.rooms,
      };
      state.taskWorkspace.packet.task.nextAction = state.activeTask.nextAction;
      if (variant.project === "standalone") state.taskWorkspace.packet.project = { scope: "standalone", projectId: null, name: null, ownership: "no_project" };
      state.taskSelectedContextIds = new Set(state.taskWorkspace.packet.context.selectedContextIds ?? []);
      if (variant.thread) {
        const thread = structuredClone(fixture.thread);
        if (variant.live) {
          thread.status = { type: "active" };
          thread.turns.at(-1).status = "inProgress";
        }
        state.threads.unshift(thread);
        state.activeThreadId = thread.id;
        state.activeThread = thread;
        state.currentTurnId = liveTurnId(thread);
        state.running = Boolean(state.currentTurnId);
      }
      state.pendingRequests = fixture.pendingRequests;
      updateSidebar();
      setRoute("task");
      return;
    }
    if (params.get("chatFixture") === "mixed") {
      const fixture = await fetch("/chat-fixtures.json").then((response) => response.json());
      state.fixtureMode = true;
      state.activeThreadId = fixture.thread.id;
      state.activeThread = fixture.thread;
      state.pendingRequests = fixture.pendingRequests;
      state.currentTurnId = liveTurnId(fixture.thread);
      state.running = Boolean(state.currentTurnId);
      $("#stopTurn").hidden = !state.running;
    }
    setRoute("chat");
    if (!state.fixtureMode) pollEvents();
  } catch (error) {
    surface.innerHTML = `<div class="welcome"><h1>Unable to start Codex</h1><p>${escapeHtml(error.message)}</p></div>`;
    $("#runtimeLabel").textContent = "Runtime unavailable";
  }
}

await start();
if (new URLSearchParams(location.search).get("interactionGuard") === "1") {
  const { runBrowserInteractionGuard } = await import("./browser-interaction-guard.mjs");
  await runBrowserInteractionGuard({
    reconcile: async () => { renderChat({ preserveScroll: true }); await new Promise((resolve) => requestAnimationFrame(resolve)); },
    switchFixtureThread: async (thread) => {
      captureComposerDraft();
      state.activeThreadId = thread.id;
      state.activeThread = structuredClone(thread);
      state.currentTurnId = liveTurnId(state.activeThread);
      state.running = Boolean(state.currentTurnId);
      restoreComposerDraft(thread.id);
      $("#stopTurn").hidden = !state.running;
      setRoute("chat");
      await new Promise((resolve) => requestAnimationFrame(resolve));
    },
    reconcileFixtureThread: async (thread) => {
      state.activeThread = structuredClone(thread);
      state.currentTurnId = liveTurnId(state.activeThread);
      state.running = Boolean(state.currentTurnId);
      $("#stopTurn").hidden = !state.running;
      renderChat({ preserveScroll: true });
      syncComposerMode();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    },
    withFixtureTransport: async (handler, callback) => {
      const priorFixtureMode = state.fixtureMode;
      state.fixtureMode = false;
      interactionGuardActionSink = handler;
      renderChat();
      try { return await callback(); }
      finally {
        interactionGuardActionSink = null;
        state.fixtureMode = priorFixtureMode;
        renderChat();
      }
    },
    applyScopeFixture: async (project) => {
      // Swap only the host-owned Project projection; Chat lists stay as read.
      state.bootstrap = { ...state.bootstrap, project };
      renderProjectHeader();
      updateSidebar();
      if (state.route === "tasks") renderTasks();
      else if (state.route === "rooms") renderRooms();
      else if (state.route === "chat" && !state.activeThread) renderChat();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    },
    currentProject: () => state.bootstrap?.project ?? null,
    closeImport: () => closeImport(false),
  });
}
