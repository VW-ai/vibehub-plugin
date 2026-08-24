import { applyChatEvent, applyHostEvent, canonicalTimeline, itemKey, rememberQueue, rememberThreadSettings, threadQueue, threadSettings, threadTokenUsage, timelineWindow } from "./chat-model.mjs";
import { describePosture, describeTurnSettings, effortOptionLabel, findModel, imageRefusal, modelOptionLabel, pendingOverrides, POSTURE_LABELS, POSTURES, postureOf, selectedEffort, selectedModel } from "./composer-settings.mjs";
import { acceptAttachment, attachmentKind, imageFilesFrom, MAX_ATTACHMENT_BYTES, renderAttachmentChips } from "./composer-attachments.mjs";
import { activeTrigger, chipsFromItems, composeTextElements, insertPlaceholder, placeholderFor, removePlaceholder } from "./composer-mentions.mjs";
import { compactDisabledReason, contextUsage } from "./context-usage.mjs";
import { renameThreadRecord } from "./thread-name.mjs";
import { createCompletionNotifier, NOTIFICATION_MODE_LABELS, noticeForCompletion } from "./completion-notifier.mjs";
import { applyThreadStatus, createListingWatch, threadIsActive, withProvisionalThreads } from "./sidebar-freshness.mjs";
import { emptyQueue, pausedMessage, queuedMediaSummary, queuedText, replaceQueuedText } from "./composer-queue.mjs";
import {
  DOM_LIMITS,
  createRenderBudget,
  escapeHtml,
  renderAgentMessage,
  renderGeneratedImage,
  messageFinalized,
  renderMarkdown,
  renderTimelineOmission,
  renderToolContent,
  renderTurnAssociations,
  renderUserMedia,
  renderUserMessageText,
  takeText,
} from "./chat-renderer.mjs";
import { requestDescriptor } from "./server-request-registry.mjs";
import { loadThreadDraft, saveThreadDraft } from "./composer-drafts.mjs";
import { clampComposerHeight, composerBounds } from "./composer-sizing.mjs";
import { threadLocation } from "./thread-location.mjs";
import { answersFromDraft, applyRequestDraft, loadRequestDraft, pruneRequestDrafts, requestDraftFromForm, saveRequestDraft } from "./request-drafts.mjs";
import { buildOrigin, codexThreadRef, composeQuotedMessage, describeSelection, locateSelection, parseQuotedMessage, sha256Hex, sourceIdentityLabel } from "./quote-source.mjs";
import { planTimelineReconciliation } from "./timeline-reconcile.mjs";
import { bringBackQuote, forksOf, forkTreeRows, placementNote, resolveLineage, sharedTurnPrefix } from "./fork-review.mjs";

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
  eventStreamOpened: false,
  pendingRequests: [],
  running: false,
  currentTurnId: null,
  attachments: [],
  recorder: null,
  recordingStream: null,
  themeIndex: 0,
  searchResults: [],
  searchIndex: 0,
  searchNative: { query: "", threads: [], pending: false, error: null },
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
  // The fork chat review gate (?forkFixture=…): null in ordinary use, so the
  // production fork surfaces are untouched; { direction, variant } while a
  // fork-lineage review fixture is mounted (docs/proposals/fork-chat).
  forkReview: null,
  creatingThread: null,
  composerQuote: null,
  selectedQuote: null,
  paintDeferred: false,
  runtimeGeneration: 0,
  runtimeAlive: false,
  // alive | restarting | exited | halted, as the host reports it; the label
  // in the topbar is derived from this, never from a guess.
  runtimeState: "exited",
  knownRequestIds: new Set(),
  composerDrafts: new Map(),
  requestDrafts: new Map(),
  requestReturnFocus: new Map(),
  importCandidates: null,
  importSelectedId: null,
  importing: false,
  // The open explicit bridge surface (Create Task, Attach to Task, Remember):
  // the exact source identity it acts on and the host preview it shows.
  bridge: null,
  // Quote into Task for a Task without a Codex Thread yet: the pending quote
  // keyed by Task id, in memory only, sent solely as startTask.humanMessage.
  taskQuoteDrafts: new Map(),
  overlayReturnSelector: null,
  // Host-owned transient records mirrored per Thread (chat-model.mjs): the
  // follow-up queue, the last token usage and the settings record. They are
  // read from bootstrap, the host responses and the event feed; nothing is
  // persisted in the browser.
  queues: new Map(),
  queueShadow: new Map(),
  tokenUsage: new Map(),
  threadSettings: new Map(),
  // The queued follow-up being edited inline, if any.
  queueEdit: null,
  // What each Turn this browser session started was sent with: the settings
  // record the host attached to the startTurn response merged with the
  // overrides that Turn carried. Never claimed for Turns replayed from history.
  turnSettings: new Map(),
  // The model catalog exactly as listModels returned it: null until model/list
  // answered, so the pickers stay disabled and say so.
  models: null,
  modelsError: null,
  modelsLoading: false,
  // The next-Turn overrides the human picked, per Thread ("" before a Thread
  // exists): only keys that still differ from the reported record are sent.
  settingsOverrides: new Map(),
  // File and skill mention chips in the Composer, Thread-owned like the text;
  // the skills catalog as listSkills returned it, read once per session.
  mentions: [],
  skills: null,
  // The inline rename in progress, if any: the Thread and where it was opened.
  renaming: null,
  // The Permissions control's pending full-access confirmation: the Thread
  // it was asked for and the control to return focus to.
  fullAccess: null,
  // Turn completion notices: the host's transient preference
  // (bootstrap.preferences.notifications), the once-per-Turn dedupe, the
  // Threads whose completion was noticed but not yet opened, and a bounded
  // in-memory log of the notices raised in this session.
  notificationMode: null,
  notificationModes: [],
  completionNotifier: createCompletionNotifier(),
  unseenCompletions: new Set(),
  completionLog: [],
  bootstrapRefreshes: 0,
  // Sidebar freshness for a Thread the host's lists do not carry yet
  // (sidebar-freshness.mjs): the ids the last bootstrap listed, the Threads
  // watched until a bootstrap lists them, and their bounded retry timers.
  listedThreadIds: new Set(),
  listingWatch: createListingWatch(),
  listingTimers: new Map(),
};

// The mention picker: `@` searches files through the host (debounced), `$`
// lists skills; both are keyboard-navigable and never claim an entry the
// host did not return.
const MENTION_SEARCH_DEBOUNCE_MS = 160;
const MENTION_RESULT_LIMIT = 10;
const INPUT_ITEM_LIMIT = 16;
const mentionPicker = { open: false, kind: null, trigger: null, query: "", items: [], index: 0, pending: false, error: null };
let mentionSearchTimer = 0;
let mentionSearchSequence = 0;

// The Composer submit path: Enter takes the Send label's own action (Queue
// while a Turn is live, Send otherwise); Alt+Enter takes the opposite
// (steer the live Turn). The flag is read once by submitTurn.
let composerSubmitMode = "default";

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

// Availability of the explicit Chat bridge, in the host's own words: the
// Project must be bound, and a review fixture is never a source of a real
// Ticket or Context write.
function bridgeAvailability() {
  if (state.fixtureMode) return { available: false, reason: "Review fixture only: this Thread is not Codex history." };
  if (scopeBound()) return { available: true, reason: null };
  return { available: false, reason: state.bootstrap?.project?.reason ?? "No bound VibeHub Project is available for this folder." };
}

// Chat associations of every Task, from the canonical graph rows alone
// (origin and codex-thread provenance references, never a Thread name).
function taskAssociations() {
  return scopeBound() ? (state.bootstrap?.graph?.tickets ?? []).flatMap((ticket) => ticket.associations?.map((association) => ({ ...association, ticketId: ticket.ticketId, status: ticket.capabilities?.operational?.summary?.label ?? null })) ?? []) : [];
}

function associationsForThread(threadId) {
  const byTurn = new Map();
  for (const association of taskAssociations()) {
    if (association.threadId !== threadId) continue;
    if (!byTurn.has(association.turnId)) byTurn.set(association.turnId, []);
    byTurn.get(association.turnId).push(association);
  }
  // Tasks born from the Turn come before Tasks merely attached to it.
  for (const entries of byTurn.values()) entries.sort((left, right) => (left.kind === right.kind ? 0 : left.kind === "origin" ? -1 : 1));
  return byTurn;
}

function taskOrigin(ticketId) {
  return state.bootstrap?.graph?.tickets?.find((ticket) => ticket.ticketId === ticketId)?.associations?.find((association) => association.kind === "origin") ?? null;
}

function threadTitleById(threadId) {
  const thread = state.threads.find((entry) => entry.id === threadId);
  return thread ? titleForThread(thread) : null;
}

// Every local Thread record the lists hold (a bootstrap parses each list
// separately, so the same Thread is a distinct object in each).
function allThreadRecords() {
  return [...state.threads, ...state.pinned, ...state.recents, ...state.projects.flatMap((project) => project.threads ?? [])];
}

// --- Sidebar freshness for a Thread the host does not list yet -------------
// The real app-server lists a brand-new Thread only once its first
// userMessage is durable, about 0.4 to 1.2 s after turn/started (see
// sidebar-freshness.mjs). turn/started for a Thread outside the last
// bootstrap's listing starts a watch: the record this browser holds stays in
// the lists as a provisional row with the runtime's status, the refresh is
// keyed on that Thread's userMessage item/completed, and a bounded retry
// (LISTING_RETRY_ATTEMPTS refreshes, LISTING_RETRY_DELAY_MS apart) runs
// until a bootstrap lists the Thread. Nothing here polls for good.

function watchListing(threadId, record) {
  const fresh = !state.listingWatch.has(threadId);
  state.listingWatch.watch(threadId, record);
  if (fresh) scheduleListingRetry(threadId);
}

// A Thread the host does not list yet, held by its own record (thread/start
// or startTask answered with it): the row joins the lists where newThread
// puts a new Chat, and the watch keeps it there until a bootstrap lists it.
function holdUnlistedThread(threadId, record) {
  if (record && !state.threads.some((thread) => thread.id === threadId)) {
    state.threads.unshift(record);
    state.recents.unshift(record);
  }
  watchListing(threadId, record);
}

function scheduleListingRetry(threadId) {
  const retry = state.listingWatch.nextRetry(threadId);
  if (!retry) return;
  clearTimeout(state.listingTimers.get(threadId));
  state.listingTimers.set(threadId, setTimeout(async () => {
    state.listingTimers.delete(threadId);
    if (!state.listingWatch.has(threadId)) return;
    // A bootstrap the host cannot answer right now is reported by the next
    // poll; the retry chain stays bounded either way.
    try { await refreshThreads(); } catch { /* posture comes from pollEvents */ }
    if (state.listingWatch.has(threadId)) scheduleListingRetry(threadId);
  }, retry.delayMs));
}

function endListingWatch(threadId) {
  clearTimeout(state.listingTimers.get(threadId));
  state.listingTimers.delete(threadId);
  state.listingWatch.drop(threadId);
}

function clearListingWatches() {
  for (const threadId of state.listingWatch.ids()) endListingWatch(threadId);
}

// A bootstrap listed these Thread ids: the watches it settles end, and the
// lists carry the provisional rows it did not list.
function settleListings(data) {
  state.listedThreadIds = new Set(data.threads.map((thread) => thread.id));
  const { settled } = state.listingWatch.settle(state.listedThreadIds);
  for (const threadId of settled) endListingWatch(threadId);
  return withProvisionalThreads({ threads: data.threads, recents: data.recents }, state.listingWatch);
}

function originLabel(ticketId) {
  const origin = taskOrigin(ticketId);
  if (!origin) return "";
  return `Born from Chat ${threadTitleById(origin.threadId) ?? `${origin.threadId.slice(0, 8)}…`} · Turn ${origin.turnId}`;
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

// The stop banner is the one visible halt: it names the pinned stop
// condition the host enforced (upstream-lock.json stopConditions) and stays
// until the shell is relaunched; no action re-enables reuse from the browser.
function renderStopBanner() {
  const stop = state.bootstrap?.stop ?? null;
  $("#stopBanner")?.remove();
  if (!stop) return;
  const banner = document.createElement("div");
  banner.id = "stopBanner";
  banner.className = "stop-banner";
  banner.setAttribute("role", "alert");
  banner.dataset.conditionId = stop.conditionId ?? "runtime-baseline-mismatch";
  const title = stop.code === "runtime-baseline-mismatch"
    ? "Stopped: Codex runtime does not match the pinned baseline"
    : "Stopped: Codex runtime violated a pinned stop condition";
  banner.innerHTML = `<strong>${escapeHtml(title)}</strong><p>${escapeHtml(stop.message)} Chat history, grouping and Tasks are not read from this runtime.</p><p class="stop-condition">Stop condition <code>${escapeHtml(stop.conditionId ?? "runtime-baseline-mismatch")}</code>${stop.detail && stop.detail !== stop.message ? ` · ${escapeHtml(stop.detail)}` : ""} · Relaunch VibeHub after correcting the runtime.</p>`;
  mainColumn.querySelector(".topbar").insertAdjacentElement("afterend", banner);
}

// A halt announced after boot (runtimeHalted event or the event window's
// runtimeHalt) becomes the same stop the bootstrap would carry.
function applyRuntimeHalt(halt) {
  if (!halt || state.bootstrap?.stop?.conditionId === halt.conditionId) return false;
  state.bootstrap = { ...(state.bootstrap ?? {}), stop: { code: halt.code, conditionId: halt.conditionId, message: halt.message, detail: halt.detail, observedVersion: halt.observedVersion ?? null, baselineVersion: halt.baselineVersion ?? null } };
  state.running = false;
  state.currentTurnId = null;
  $("#stopTurn").hidden = true;
  renderStopBanner();
  renderProjectHeader();
  setRuntimePosture({ alive: state.runtimeAlive, state: "halted" });
  if (state.route === "chat") renderChat({ preserveScroll: true });
  else if (state.route === "task") renderTaskWorkspace();
  return true;
}

// The app-server died. Nothing the browser holds about its Turns is live any
// more: the running posture is dropped, streamed partials are discarded in
// favour of what Codex persisted, and the transcript says where the exit
// fell. Live posture comes back only from thread/read after a restart.
function markRuntimeExited(value) {
  if (state.running && state.activeThreadId) {
    applyChatEvent(state, "runtime/exited", { threadId: state.activeThreadId, turnId: state.currentTurnId, generation: value?.runtimeGeneration ?? state.runtimeGeneration });
  }
  state.running = false;
  state.currentTurnId = null;
  $("#stopTurn").hidden = true;
  for (const map of [state.liveItems, state.turnPlans, state.turnDiffs]) map.clear();
  // A provisional Sidebar row carried the dead process's status: the watch
  // ends with it, and the bootstrap after the restart lists whatever the
  // runtime made durable.
  clearListingWatches();
  setRuntimePosture({ alive: false, generation: value?.runtimeGeneration ?? state.runtimeGeneration, state: state.bootstrap?.stop ? "halted" : "restarting" });
  updateSidebar();
  if (state.route === "chat") renderChat({ preserveScroll: true });
  else if (state.route === "task") renderTaskWorkspace();
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
  if (!response.ok || !envelope.ok) {
    // The host's error envelope keeps its code and details (ticket_exists
    // names the derived id, room_missing lists the Rooms, validation_error
    // carries the validator's paths) so a surface can explain the refusal.
    const error = new Error(envelope.error?.message ?? `Request failed (${response.status})`);
    error.code = envelope.error?.code ?? null;
    error.status = response.status;
    error.details = envelope.error ?? null;
    throw error;
  }
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

// The settings record the host last reported for a Thread, null until the
// runtime reported them: the forwarded thread/settings/updated or a host
// response first, then the record every listed Thread carries in bootstrap.
function threadSettingsRecord(threadId) {
  if (!threadId) return null;
  return threadSettings(state, threadId) ?? state.threads.find((thread) => thread.id === threadId)?.settings ?? null;
}

// What a Turn this session started was sent with: the Thread's reported
// record (as known at that moment) under the overrides the Turn carried.
// The first attribution wins; a later event never rewrites it.
function attributeTurnSettings(turnId, threadId, overrides = null, record = threadSettingsRecord(threadId)) {
  if (!turnId || state.turnSettings.has(turnId)) return;
  const { source, observedAt, ...reported } = record ?? {};
  state.turnSettings.set(turnId, { ...reported, ...(overrides ?? {}), _source: record ? source ?? null : null, _overrides: Object.keys(overrides ?? {}) });
  while (state.turnSettings.size > 64) state.turnSettings.delete(state.turnSettings.keys().next().value);
}

function humanize(ticketId) {
  return String(ticketId).replace(/^ticket-/, "").split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");
}

// Tasks each Chat birthed or was attached to, from checked-in Ticket YAML;
// computed once per sidebar render.
let sidebarTasksByThread = new Map();

function tasksByThread() {
  const byThread = new Map();
  for (const association of taskAssociations()) {
    if (!byThread.has(association.threadId)) byThread.set(association.threadId, new Set());
    byThread.get(association.threadId).add(association.ticketId);
  }
  return byThread;
}

function threadButton(thread, { forkDepth = 0 } = {}) {
  const active = thread.id === state.activeThreadId;
  // The presence dot is a live claim: it needs a live runtime as well as the
  // last status the app-server reported for the Thread.
  const runtimeActive = state.runtimeAlive && !state.bootstrap?.stop && String(thread.status?.type ?? thread.status ?? "").toLowerCase().includes("active");
  const born = sidebarTasksByThread.get(thread.id) ?? new Set();
  const badge = state.unseenCompletions.has(thread.id)
    ? '<em class="completion-badge" data-unseen-completion="true" title="A Turn completed here while you were away">DONE</em>'
    : thread.taskLink
      ? "<em>TASK</em>"
      : born.size ? `<em data-born-tasks="${born.size}" title="${born.size} Task${born.size === 1 ? "" : "s"} born from or attached to this Chat">${born.size} TASK${born.size === 1 ? "" : "S"}</em>` : "";
  if (state.renaming?.threadId === thread.id && state.renaming.where === "sidebar") return `<div class="thread-row renaming" data-thread-row="${escapeHtml(thread.id)}">${renameFormMarkup(thread, "sidebar")}</div>`;
  return `<div class="thread-row" data-thread-row="${escapeHtml(thread.id)}"${forkDepth ? ` data-fork-depth="${forkDepth}"` : ""}><button class="thread-button${active ? " active" : ""}" type="button" data-thread-id="${escapeHtml(thread.id)}">
    ${forkDepth ? '<span class="fork-branch" aria-hidden="true">⑂</span>' : ""}<i class="thread-state${runtimeActive ? " active" : ""}"></i>
    <span>${forkDepth ? '<span class="sr-only">Fork · </span>' : ""}<strong>${escapeHtml(titleForThread(thread))}</strong><small>${escapeHtml(thread.taskLink ? "VibeHub Task · Codex Thread" : (thread.preview || "Codex Thread").slice(0, 54))}</small></span>
    ${badge}
  </button><button class="thread-rename" type="button" data-rename-thread="${escapeHtml(thread.id)}" data-rename-where="sidebar" aria-label="Rename chat ${escapeHtml(titleForThread(thread))}" title="Rename chat">✎</button></div>`;
}

// --- Inline rename --------------------------------------------------------
// The header and the sidebar row rename through the existing setThreadName
// host action (thread/name/set); the runtime's thread/name/updated then
// renames every surface without a refresh.

function renameFormMarkup(thread, where) {
  const value = state.renaming?.draft ?? thread.name ?? titleForThread(thread);
  return `<form class="rename-form" data-rename-form="${escapeHtml(thread.id)}" data-rename-where="${escapeHtml(where)}"><input type="text" aria-label="Chat name" maxlength="160" autocomplete="off" value="${escapeHtml(value)}" required><button type="submit">Save</button><button type="button" data-cancel-rename="${escapeHtml(thread.id)}">Cancel</button></form>`;
}

// A re-render while a rename is typed (the sidebar refreshes on a poll, the
// Chat re-reads on a Turn) keeps the typed draft and the caret.
function withRenameFocus(render) {
  const before = document.activeElement?.closest?.("[data-rename-form]") ? document.activeElement : null;
  const caret = before ? [before.selectionStart, before.selectionEnd] : null;
  render();
  if (!before || !state.renaming) return;
  const input = $(`[data-rename-form="${CSS.escape(state.renaming.threadId)}"][data-rename-where="${state.renaming.where}"] input`);
  if (!input) return;
  input.focus({ preventScroll: true });
  if (caret) input.setSelectionRange(Math.min(caret[0], input.value.length), Math.min(caret[1], input.value.length));
}

function beginRename(threadId, where) {
  const thread = state.threads.find((entry) => entry.id === threadId) ?? (state.activeThread?.id === threadId ? state.activeThread : null);
  if (!thread) return;
  state.renaming = { threadId, where };
  if (where === "sidebar") updateSidebar();
  else renderThreadTitle();
  const input = $(`[data-rename-form="${CSS.escape(threadId)}"][data-rename-where="${where}"] input`);
  input?.focus();
  input?.select();
}

function endRename({ restore = true } = {}) {
  const renaming = state.renaming;
  if (!renaming) return;
  state.renaming = null;
  if (renaming.where === "sidebar") updateSidebar();
  else renderThreadTitle();
  if (restore) $(`[data-rename-thread="${CSS.escape(renaming.threadId)}"][data-rename-where="${renaming.where}"]`)?.focus({ preventScroll: true });
}

async function submitRename(form) {
  const threadId = form.dataset.renameForm;
  const name = form.querySelector("input").value.trim();
  if (!name) { notify("A chat name cannot be empty."); return; }
  try {
    const result = await action({ action: "setThreadName", threadId, name });
    // The host answered with the name it set; thread/name/updated follows
    // in the event feed and is applied the same way.
    applyThreadName(result.threadId ?? threadId, result.name ?? name);
    endRename();
    notify("Chat renamed.");
  } catch (error) { notify(error.message); }
}

// thread/name/updated { threadId, threadName } and the setThreadName
// response both land here: the list entry, the open Chat and every surface
// that shows the name follow, with no bootstrap refresh.
function applyThreadName(threadId, threadName) {
  let changed = false;
  for (const thread of [...state.threads, ...state.pinned, ...state.recents, ...state.projects.flatMap((project) => project.threads ?? [])]) {
    if (thread.id !== threadId) continue;
    Object.assign(thread, renameThreadRecord(thread, threadName));
    changed = true;
  }
  if (state.activeThread?.id === threadId) {
    state.activeThread = renameThreadRecord(state.activeThread, threadName);
    changed = true;
    renderThreadTitle();
  }
  if (changed) updateSidebar();
  return changed;
}

// The Chat header's title block: the name with its Rename control, or the
// inline form while renaming there; the route title follows.
function renderThreadTitle() {
  const block = $("#threadTitleBlock");
  if (!block || !state.activeThread) return;
  const thread = state.activeThread;
  withRenameFocus(() => {
    block.innerHTML = state.renaming?.threadId === thread.id && state.renaming.where === "header"
      ? renameFormMarkup(thread, "header")
      : `<h1 id="activeThreadTitle" tabindex="-1">${escapeHtml(titleForThread(thread))}</h1><button class="thread-rename" type="button" data-rename-thread="${escapeHtml(thread.id)}" data-rename-where="header" aria-label="Rename chat" title="Rename chat"${state.fixtureMode ? " disabled" : ""}>Rename</button>`;
  });
  if (state.route === "chat") setRouteHeader(titleForThread(thread), `${state.fixtureMode ? "Review fixture · not runtime history" : `Thread ${thread.id.slice(0, 8)}…`} · ${state.bootstrap?.graph.project.name}`);
}

function updateSidebar() {
  withRenameFocus(renderSidebar);
}

// One Sidebar list's rows. In ordinary use this is the flat listing; under
// the fork review's sidebar direction (Direction B of
// docs/proposals/fork-chat) forks indent under their source when the source
// row is in the same visible list, from Thread.forkedFromId alone. DOM order
// stays reading order, so the keyboard path is unchanged.
function threadRowsMarkup(threads) {
  if (state.forkReview?.direction !== "sidebar") return threads.map((thread) => threadButton(thread)).join("");
  return forkTreeRows(threads).map(({ thread, depth }) => threadButton(thread, { forkDepth: depth })).join("");
}

function renderSidebar() {
  const list = $("#threadList");
  sidebarTasksByThread = tasksByThread();
  const focused = sidebar.contains(document.activeElement)
    ? { threadId: document.activeElement.dataset.threadId, ticketId: document.activeElement.dataset.ticketId, id: document.activeElement.id }
    : null;
  const needsYou = scopeBound() ? state.bootstrap?.attention?.needsYou ?? [] : [];
  const attention = $("#sidebarAttention");
  attention.hidden = needsYou.length === 0;
  $("#sidebarAttentionList").innerHTML = needsYou.slice(0, 3).map((item) => `<button class="attention-item" type="button" data-ticket-id="${escapeHtml(item.ticketId)}"><i></i><span><strong>${escapeHtml(humanize(item.ticketId))}</strong><small>Task · Needs you${taskOrigin(item.ticketId) ? ` · ${escapeHtml(originLabel(item.ticketId))}` : ""}</small></span></button>`).join("");
  $("#pinnedSection").hidden = state.pinned.length === 0;
  $("#pinnedList").innerHTML = threadRowsMarkup(state.pinned);
  $("#projectList").innerHTML = state.projects.length
    ? state.projects.map((project) => `<section class="project-group" data-project-drop="${escapeHtml(project.id)}">
        <header><button class="project-toggle" type="button" data-toggle-project="${escapeHtml(project.id)}" aria-expanded="true" aria-label="Collapse ${escapeHtml(project.name)} group"><span class="project-dot"></span><strong>${escapeHtml(project.name)}</strong><small title="${project.hiddenElsewhere ? `${project.threads.length} here · ${project.hiddenElsewhere} in other folders hidden` : `${project.threads.length} in this folder`}">${project.threads.length}${project.hiddenElsewhere ? "+" : ""}</small></button><details class="project-menu"><summary aria-label="${escapeHtml(project.name)} group actions">•••</summary><div><button type="button" data-rename-project="${escapeHtml(project.id)}">Rename</button><button type="button" data-delete-project="${escapeHtml(project.id)}">Delete</button></div></details></header>
        <div class="project-threads">${threadRowsMarkup(project.threads) || '<p class="muted">Drop a Chat here</p>'}</div>
      </section>`).join("")
    : '<p class="muted">No chat groups yet. Chats stay in Recents.</p>';
  list.innerHTML = threadRowsMarkup(state.recents) || '<p class="muted">No ungrouped chats in this folder.</p>';
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
  // A narrow topbar ellipsizes the title; the full text stays its accessible
  // name and the title attribute gives the full name to a sighted hover.
  routeTitle.title = title;
  routeMeta.textContent = meta;
  routeMeta.title = meta;
  backButton.hidden = !back;
}

function syncThreadLocation() {
  if (state.fixtureMode) return;
  const next = threadLocation(location.href, state.activeThreadId, state.route === "task" ? state.activeTicketId : null);
  if (next !== location.href) history.replaceState(history.state, "", next);
}

function setRoute(route) {
  captureRequestDrafts(surface);
  // Leaving a Task Workspace that has no Codex Thread yet: its pending Quote
  // into Task stays keyed to the Task, and never leaks into ordinary Chat.
  if (state.route === "task" && route !== "task" && !state.activeThreadId) {
    captureTaskQuoteDraft();
    restoreComposerDraft(null);
  }
  state.route = route;
  closeMobileSidebar(false);
  const activeRoute = route === "task" ? "tasks" : route;
  $$('[data-route]', $("#sidebar")).forEach((button) => button.classList.toggle("active", button.dataset.route === activeRoute));
  composerWrap.hidden = route !== "chat" && route !== "task";
  if (route === "chat") renderChat();
  else if (route === "tasks") renderTasks();
  else if (route === "task") renderTaskWorkspace();
  else renderRooms();
  syncThreadLocation();
  syncComposerMode();
}

function syncComposerMode() {
  const input = $("#composerInput");
  const taskMode = state.route === "task";
  const linked = taskMode && state.activeThreadId;
  // The composer needs a runtime the host says is usable: alive, gated
  // (state alive, not restarting or halted), authenticated, and no stop.
  input.disabled = !state.runtimeAlive || state.runtimeState !== "alive" || Boolean(state.bootstrap?.stop) || Boolean(taskMode && !linked);
  const send = $("#sendButton");
  send.disabled = input.disabled;
  // Ordinary Chat while a Turn streams: Enter queues the follow-up in the
  // host-owned queue and the label says so; Alt+Enter is the explicit
  // opposite (steer that exact Turn). The Task Workspace composer keeps its
  // host-built packet path: Turn steering there stays explicit in its label.
  const queueing = state.running && !taskMode;
  send.textContent = queueing ? "Queue" : "↑";
  send.dataset.sendMode = queueing ? "queue" : state.running ? "steer" : "send";
  send.setAttribute("aria-label", queueing ? "Queue message" : state.running ? "Steer current turn" : "Send message");
  send.title = queueing ? "Queue for after this Turn (Enter) · Steer this Turn now (Alt+Enter)" : state.running ? "Steer current Turn" : "Send message";
  $("#composer").dataset.turnPosture = state.running ? "running" : "idle";
  if (state.currentTurnId) $("#composer").dataset.currentTurnId = state.currentTurnId;
  else delete $("#composer").dataset.currentTurnId;
  const halted = Boolean(state.bootstrap?.stop);
  if (!state.creatingThread) $("#newThread").disabled = halted;
  for (const fork of $$("[data-fork-thread]")) fork.disabled = state.fixtureMode || state.running || halted;
  renderContextIndicator();
  input.placeholder = taskMode ? (linked ? "Message this Task" : "Start the Task to open its Codex conversation") : queueing ? "Queue a follow-up for after this Turn" : "Ask Codex to do something";
  $("#composerNote").textContent = taskMode
    ? (linked
      ? `${state.taskSelectedContextIds.size} Context item${state.taskSelectedContextIds.size === 1 ? "" : "s"} included in the next Turn · Browser never rebuilds the packet.`
      : state.composerQuote
        ? "Pending quote: Start sends it as this Task's first message inside the host-built packet. Nothing is written to the source Chat."
        : "The host will open a linked Codex Thread with the canonical Task packet.")
    : queueing
      ? "Enter queues this message for after the running Turn · Alt+Enter steers the running Turn now."
      : "Codex can make mistakes. Review commands and changes.";
  renderQueue();
  renderComposerSettings();
  renderPosture();
}

function runtimeLabel() {
  const stop = state.bootstrap?.stop;
  if (stop) return stop.code === "runtime-baseline-mismatch" ? "Stopped: baseline mismatch" : `Stopped: ${stop.conditionId}`;
  if (state.runtimeState === "restarting") return "Runtime restarting";
  if (state.runtimeState === "exited") return "Runtime exited";
  if (state.runtimeState === "halted") return "Stopped";
  if (state.runtimeState === "unreachable") return "Host unreachable";
  if (!state.bootstrap?.account?.authenticated && state.bootstrap) return "Authentication required";
  return state.runtimeAlive ? "Local app-server" : "Runtime unavailable";
}

function setRuntimePosture({ alive, generation = state.runtimeGeneration, state: runtimeState, label } = {}) {
  state.runtimeAlive = Boolean(alive);
  state.runtimeGeneration = generation;
  if (runtimeState) state.runtimeState = runtimeState;
  const stopped = Boolean(state.bootstrap?.stop);
  const pill = $("#runtimeLabel").parentElement;
  $("#runtimeLabel").textContent = label ?? runtimeLabel();
  pill.dataset.stopped = String(stopped);
  pill.dataset.runtimeState = stopped ? "halted" : state.runtimeState;
  const conditions = state.bootstrap?.runtime?.conditions ?? [];
  pill.title = conditions.length
    ? `Pinned stop conditions · ${conditions.map((entry) => `${entry.id}: ${entry.status}`).join(" · ")}`
    : "";
  $("#accountDot").classList.toggle("connected", state.runtimeAlive && state.runtimeState === "alive" && Boolean(state.bootstrap?.account?.authenticated));
  $("#stopTurn").disabled = !state.runtimeAlive || state.runtimeState !== "alive";
  syncComposerMode();
}

const BRIDGE_DIALOG_IDS = ["createTaskDialog", "attachTaskDialog", "rememberDialog"];
const openBridgeDialog = () => BRIDGE_DIALOG_IDS.map((id) => $(`#${id}`)).find((dialog) => dialog && !dialog.hidden) ?? null;

function syncScrim() {
  const overlayOpen = !$("#searchDialog").hidden || !$("#inboxPanel").hidden || !$("#reviewPanel").hidden || !$("#importDialog").hidden || !$("#fullAccessDialog").hidden || Boolean(openBridgeDialog());
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

// One typed Search entry, three owners: Chats are native Codex Threads (the
// listed tail matched locally plus the app-server's own thread/list searchTerm
// over every group in this folder), Tasks are the canonical VibeHub graph and
// Context is durable Room Context. Every result keeps its object type; nothing
// is relabelled across owners.
const SEARCH_DEBOUNCE_MS = 160;
const SEARCH_NATIVE_LIMIT = 20;
const SEARCH_GROUPS = [
  ["chat", "Chats (Codex)", "Chat"],
  ["task", "Tasks (VibeHub)", "Task"],
  ["context", "Context (Rooms)", "Context"],
];
let searchTimer = 0;
let searchSequence = 0;

function searchMatcher(query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return (...values) => {
    const haystack = values.map((value) => String(value ?? "")).join("\n").toLowerCase();
    return terms.every((term) => haystack.includes(term));
  };
}

function chatSearchResult(thread, source) {
  return { kind: "chat", id: thread.id, title: titleForThread(thread), detail: thread.preview || "Codex Thread", glyph: "C", source };
}

function searchCorpus(query) {
  const includes = searchMatcher(query);
  const native = state.searchNative.query === query.trim() ? state.searchNative.threads : [];
  const nativeIds = new Set(native.map((thread) => thread.id));
  const chats = [
    ...native.map((thread) => chatSearchResult(thread, "native")),
    ...state.threads
      .filter((thread) => !nativeIds.has(thread.id) && includes(titleForThread(thread), thread.preview, thread.id))
      .slice(0, 6)
      .map((thread) => chatSearchResult(thread, "listed")),
  ];
  const bound = scopeBound();
  const tasks = (bound ? state.bootstrap?.graph.tickets ?? [] : [])
    .filter((ticket) => includes(ticket.ticketId, ticket.outcome, ticket.capabilities.nextAction.summary.action))
    .slice(0, 8)
    .map((ticket) => ({ kind: "task", id: ticket.ticketId, title: humanize(ticket.ticketId), detail: ticket.outcome, glyph: "T", source: "canonical" }));
  const contexts = (bound ? state.bootstrap?.contexts ?? [] : [])
    .filter((context) => includes(context.contextId, context.summary, context.detail, ...(context.tags ?? [])))
    .slice(0, 6)
    .map((context) => ({ kind: "context", id: context.contextId, title: context.summary, detail: `${context.room} · ${context.type}`, glyph: "◇", source: "canonical" }));
  return [...chats, ...tasks, ...contexts];
}

function renderSearchResults() {
  const query = $("#searchInput").value;
  state.searchResults = searchCorpus(query);
  state.searchIndex = Math.min(state.searchIndex, Math.max(0, state.searchResults.length - 1));
  const markup = SEARCH_GROUPS.map(([kind, label, typeLabel]) => {
    const matches = state.searchResults.filter((item) => item.kind === kind);
    if (!matches.length) return "";
    return `<div class="search-group-label" data-search-group="${kind}">${label}</div>${matches.map((item) => {
      const index = state.searchResults.indexOf(item);
      return `<button class="search-result" id="search-result-${index}" type="button" role="option" aria-selected="${index === state.searchIndex}" data-search-kind="${item.kind}" data-search-id="${escapeHtml(item.id)}" data-search-source="${item.source}"><i>${item.glyph}</i><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></span><em>${typeLabel}</em></button>`;
    }).join("")}`;
  }).join("");
  const pending = state.searchNative.pending && Boolean(query.trim());
  const status = pending
    ? '<div class="search-status" role="status">Searching Codex Threads…</div>'
    : state.searchNative.error && state.searchNative.query === query.trim()
      ? `<div class="search-status" role="status">Codex Thread search unavailable: ${escapeHtml(state.searchNative.error)}</div>`
      : "";
  $("#searchResults").innerHTML = (markup || (pending ? "" : `<div class="search-empty">${scopeBound() ? "No matching Chat, Task, or Context." : "No matching Chat. Tasks and Context need a bound VibeHub Project."}</div>`)) + status;
  const active = state.searchResults.length ? `search-result-${state.searchIndex}` : null;
  if (active) $("#searchInput").setAttribute("aria-activedescendant", active);
  else $("#searchInput").removeAttribute("aria-activedescendant");
  $(".search-result[aria-selected=\"true\"]")?.scrollIntoView({ block: "nearest" });
}

// Typing re-renders the local groups at once and debounces one native
// thread/list search; a reply for a query that is no longer typed is dropped.
function runSearch() {
  const query = $("#searchInput").value.trim();
  const sequence = ++searchSequence;
  clearTimeout(searchTimer);
  state.searchNative = { query, threads: [], pending: Boolean(query), error: null };
  renderSearchResults();
  if (!query) return;
  searchTimer = setTimeout(async () => {
    let next;
    try {
      const data = await action({ action: "searchThreads", searchTerm: query, limit: SEARCH_NATIVE_LIMIT });
      next = { query, threads: data.threads ?? [], pending: false, error: null };
    } catch (error) {
      next = { query, threads: [], pending: false, error: error.message };
    }
    if (sequence !== searchSequence || $("#searchDialog").hidden) return;
    state.searchNative = next;
    renderSearchResults();
  }, SEARCH_DEBOUNCE_MS);
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
  runSearch();
  syncScrim();
  requestAnimationFrame(() => $("#searchInput").focus());
}

function closeSearch(restore = true) {
  const dialog = $("#searchDialog");
  if (dialog.hidden) return;
  clearTimeout(searchTimer);
  searchSequence += 1;
  state.searchNative = { query: "", threads: [], pending: false, error: null };
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
  const originNote = (ticketId) => (taskOrigin(ticketId) ? ` · ${escapeHtml(originLabel(ticketId))}` : "");
  const needs = attention.needsYou.map((item) => `<button class="inbox-row needs-you" type="button" data-ticket-id="${escapeHtml(item.ticketId)}"><i></i><span><strong>${escapeHtml(humanize(item.ticketId))}</strong><small>Needs your explicit decision${originNote(item.ticketId)}</small></span><em>Task</em></button>`).join("");
  const completed = attention.recentCompletions.map((item) => `<button class="inbox-row" type="button" data-ticket-id="${escapeHtml(item.ticketId)}"><i></i><span><strong>${escapeHtml(humanize(item.ticketId))}</strong><small>Successful Outcome · ${escapeHtml(formatWhen(item.closedAt))}${originNote(item.ticketId)}</small></span><em>${state.unreadCompletionKeys.has(completionKey(item)) ? "New" : "History"}</em></button>`).join("");
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

// The packet a Task Turn carried is the Turn's persisted user input as
// thread/read replays it. The disclosure is filled on open from that replayed
// item so the mounted transcript stays bounded and no second copy exists.
function packetRawDisclosure(identity, text, operation) {
  return `<details class="packet-raw" data-disclosure-id="packet-raw-${escapeHtml(identity)}" data-packet-raw="${escapeHtml(identity)}"><summary>Persisted Turn input · ${escapeHtml(operation ?? "packet")} <span>${text.length.toLocaleString()} chars</span></summary><pre data-packet-raw-text tabindex="0" aria-label="Persisted Turn input"></pre></details>`;
}

function fillPacketRaw(details) {
  const pre = details.querySelector("[data-packet-raw-text]");
  if (!pre || !details.open || pre.dataset.filled === "true") return;
  const item = timelineItem(details.dataset.packetRaw);
  if (!item) { pre.textContent = "This Turn input is no longer mounted; Thread history remains authoritative."; return; }
  pre.textContent = userInputText(item.content);
  pre.dataset.filled = "true";
}

function statusLabel(item) {
  if (item._live) return "running";
  if (item.status) return String(item.status).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return "complete";
}

function disclosureCard({ identity, kind, title, status, summary, detail = "", icon = "◇", open = false, extra = "" }) {
  return `<details class="activity-card ${kind}" data-disclosure-id="${escapeHtml(identity ?? `${kind}-${title}`)}" ${open ? "open" : ""}><summary><i>${icon}</i><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(summary)}</small></span><em>${escapeHtml(status)}</em></summary>${detail ? `<div class="activity-detail">${detail}</div>` : ""}${extra}</details>`;
}

// Bounded output is a scroll region once it exceeds its CSS ceiling; the
// tabindex keeps that scroll reachable from the keyboard, not only the wheel.
const BOUNDED_PRE_LABELS = { "terminal-output": "Command output", "tool-arguments": "Tool arguments" };
function boundedPre(value, className = "", maximum = DOM_LIMITS.outputCharacters, budget = createRenderBudget()) {
  const bounded = takeText(budget, value, maximum);
  return `<pre${className ? ` class="${className}"` : ""} tabindex="0" aria-label="${BOUNDED_PRE_LABELS[className] ?? "Output"}">${escapeHtml(bounded.text)}</pre>${bounded.truncated ? `<p class="truncation-note">${bounded.omitted.toLocaleString()} characters omitted from this browser view. Durable Thread history remains authoritative.</p>` : ""}`;
}

function liveOmission(item) {
  return item._omittedCharacters
    ? `<p class="truncation-note">${item._omittedCharacters.toLocaleString()} characters omitted from this mounted live view. Durable Thread history remains authoritative.</p>`
    : "";
}

// The settings a Turn this session started was sent with, as one line under
// its first user message: the host-attached record under the overrides the
// Turn carried. Turns replayed from history make no such claim.
function turnPostureMarkup(turnId) {
  const turn = state.turnSettings.get(turnId);
  const line = describeTurnSettings(turn, state.models);
  if (!line) return "";
  const overridden = turn._overrides?.length ? ` · sent ${turn._overrides.join(", ")}` : "";
  const source = turn._source ? ` · reported by ${turn._source}` : "";
  return `<small class="turn-posture" data-turn-settings="${escapeHtml(turnId)}" title="Model, effort, approval policy and sandbox this Turn was sent with">${escapeHtml(line)}${escapeHtml(overridden)}${escapeHtml(source)}</small>`;
}

function renderItem(item, budget, { posture = "" } = {}) {
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
      const raw = packetRawDisclosure(identity, text, handoff.operation);
      if (message) return `<div class="turn user" data-item-id="${escapeHtml(identity)}"><article><div>${renderUserMessageText(message, budget, { currentThreadId: item._threadId })}</div>${media}<small class="task-message-context">${contextCount} Context item${contextCount === 1 ? "" : "s"} · host-owned packet</small>${raw}</article></div>`;
      return `<div class="turn user" data-item-id="${escapeHtml(identity)}"><article class="item-card handoff task-packet"><header><strong>VibeHub Task</strong><span>${escapeHtml(handoff.task?.nextAction?.action ?? handoff.task?.operationalState)}</span></header><p><strong>${escapeHtml(humanize(handoff.task?.ticketId))}</strong><br>${escapeHtml(takeText(budget, handoff.task?.outcome, 8_000).text)}</p><small>${contextCount} Context item${contextCount === 1 ? "" : "s"} · ${escapeHtml(handoff.project?.scope ?? "standalone")} · host-owned packet</small>${raw}</article></div>`;
    }
    const textElements = item.content?.find((entry) => entry.type === "text")?.text_elements ?? null;
    const inlineMentions = Array.isArray(textElements) && textElements.length > 0;
    const media = renderUserMedia(item.content, budget, { inlineMentions });
    return `<div class="turn user" data-item-id="${escapeHtml(identity)}"><article>${text ? `<div>${renderUserMessageText(text, budget, { currentThreadId: item._threadId, textElements })}</div>` : ""}${media}${posture}</article></div>`;
  }
  if (item.type === "agentMessage") return renderAgentMessage(item, budget, { bridge: bridgeAvailability() });
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
  if (item.type === "contextCompaction") return `<div class="turn-boundary compacted" data-context-compaction="${escapeHtml(item.id ?? identity)}" role="note"><span>Context compacted</span><strong>Codex continues from a summary of the earlier Turns; the full detail remains in Thread history.</strong></div>`;
  if (item.type === "hookPrompt") return `<div class="timeline-divider" data-hook-prompt="${escapeHtml(identity)}"><span>Repository instructions</span><strong>${escapeHtml((item.fragments ?? []).map((fragment) => fragment.text ?? fragment.content ?? "").join(" ").slice(0, 120))}</strong></div>`;
  if (item.type === "turnError") return `<section class="turn-error"><strong>${item.willRetry ? "Codex is retrying" : "This Turn stopped"}</strong><p>${escapeHtml(takeText(budget, item.message, 4_000).text)}</p>${item.willRetry ? '<span class="retrying">Retrying…</span>' : `<button type="button" data-retry-turn="${escapeHtml(item._turnId)}">Retry as a new Turn</button>`}</section>`;
  if (item.type === "turnBoundary") return `<div class="turn-boundary ${escapeHtml(item.status)}"><span>${item.status === "interrupted" ? "Turn interrupted" : item.status === "runtimeExited" ? "Runtime exited during this Turn" : "Turn failed"}</span><strong>${escapeHtml(takeText(budget, item.message ?? (item.status === "interrupted" ? "Partial output remains in Thread history." : "The error remains inspectable in this Thread."), 4_000).text)}</strong></div>`;
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
  return `<section class="approval-card" data-request-id="${escapeHtml(request.id)}" data-request-turn="${escapeHtml(params.turnId ?? "")}" role="alertdialog" aria-label="${escapeHtml(title)}"><header><span>Needs your approval</span><em>${request.fixture ? "Review fixture" : "Turn paused"}</em></header><strong>${escapeHtml(title)}</strong>${command}<dl class="approval-context">${context}</dl><footer><button class="accept" type="button" data-request-decision="accept" data-request-id="${escapeHtml(request.id)}"${fixtureDecisionDisabled}>Allow once</button><button type="button" data-request-decision="acceptForSession" data-request-id="${escapeHtml(request.id)}"${fixtureDecisionDisabled}>Allow for session</button><button type="button" data-request-decision="decline" data-request-id="${escapeHtml(request.id)}"${fixtureDecisionDisabled}>Decline</button><button class="danger" type="button" data-request-decision="cancel" data-request-id="${escapeHtml(request.id)}"${fixtureDecisionDisabled}>Cancel & interrupt</button></footer></section>`;
}

const groupableActivityTypes = new Set(["commandExecution", "fileChange", "turnDiff", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView", "sleep", "imageGeneration"]);

function renderTimelineItems(items) {
  const budget = createRenderBudget();
  const output = [];
  let group = [];
  let groupOrdinal = 0;
  // Every Task born from or attached to a Turn of this Thread, rendered as
  // one inline marker after the Turn's last item. The marker is read from the
  // canonical graph rows; the Chat itself is never rewritten.
  const threadId = items[0]?._threadId ?? state.activeThreadId;
  const associations = associationsForThread(threadId);
  let currentTurnId = null;
  let turnOpen = false;
  const labeledTurns = new Set();
  const closeTurn = () => {
    if (!turnOpen) return;
    turnOpen = false;
    const entries = associations.get(currentTurnId);
    if (!entries?.length) return;
    const key = `associations-${threadId ?? "thread"}--${currentTurnId ?? "turn"}`;
    output.push(`<div class="timeline-entry turn-associations-entry" data-render-key="${escapeHtml(key)}">${renderTurnAssociations({ turnId: currentTurnId, entries: entries.map((entry) => ({ ticketId: entry.ticketId, label: humanize(entry.ticketId), kind: entry.kind, status: entry.status })) })}</div>`);
  };
  const flush = () => {
    if (!group.length) return;
    // "Working…" is a live claim: it needs a streamed item or an in-progress
    // item of the Turn thread/read says is live; replayed in-progress status
    // from a Thread that is not active never counts.
    const running = group.some((item) => item._live || (state.running && item._turnId === state.currentTurnId && ["inProgress", "running"].includes(item.status)));
    const failed = group.some((item) => ["failed", "declined", "errored"].includes(item.status));
    const files = group.filter((item) => item.type === "fileChange").flatMap((item) => item.changes ?? []).length;
    const label = running ? "Working…" : failed ? "Work needs attention" : "Worked on this Turn";
    const detail = `${group.length} activit${group.length === 1 ? "y" : "ies"}${files ? ` · ${files} file${files === 1 ? "" : "s"}` : ""}`;
    const identity = `${group[0]._threadId ?? "thread"}--${group[0]._turnId ?? "turn"}--${groupOrdinal++}`;
    output.push(`<details class="activity-group" data-render-key="group-${escapeHtml(identity)}" data-disclosure-id="group-${escapeHtml(identity)}" ${running || failed ? "open" : ""}><summary><span><i>${running ? "↻" : failed ? "!" : "✓"}</i><strong>${label}</strong></span><em>${detail}</em></summary><div>${group.map((item) => renderItem(item, budget)).join("")}</div></details>`);
    group = [];
  };
  for (const item of items) {
    if (item._turnId !== currentTurnId || !turnOpen) {
      flush();
      closeTurn();
      currentTurnId = item._turnId;
      turnOpen = true;
    }
    if (groupableActivityTypes.has(item.type) && (!group.length || group[0]._turnId === item._turnId)) group.push(item);
    else {
      flush();
      if (groupableActivityTypes.has(item.type)) group.push(item);
      else {
        const posture = item.type === "userMessage" && !labeledTurns.has(item._turnId) ? turnPostureMarkup(item._turnId) : "";
        if (posture) labeledTurns.add(item._turnId);
        output.push(`<div class="timeline-entry" data-render-key="${escapeHtml(item._key ?? item.id)}">${renderItem(item, budget, { posture })}</div>`);
      }
    }
  }
  flush();
  closeTurn();
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

// --- Fork lineage review surface (Direction A of docs/proposals/fork-chat) --
// Mounted only while a ?forkFixture review fixture is active; ordinary use
// keeps the production "Fork of <uuid>" line untouched. The chip resolves
// forkedFromId against the listed Threads of this folder; a source those
// lists do not carry is named missing instead of invented, and the forks of
// the open Chat are listed from the same canonical rows.
function forkLineageMarkup(thread) {
  if (state.forkReview?.direction !== "chip") return "";
  const parts = [];
  const lineage = resolveLineage(thread, state.threads);
  if (lineage?.missing) {
    parts.push(`<span class="lineage-chip is-missing" title="Source thread ${escapeHtml(lineage.sourceId)}">⑂ Forked from a chat not listed in this folder</span><small class="lineage-note">Source ${escapeHtml(lineage.sourceId.slice(0, 8))}… is archived, deleted, or lives in another folder. There is nothing to open here.</small>`);
  } else if (lineage) {
    const source = lineage.source;
    const prefix = sharedTurnPrefix(thread, source);
    const divergence = prefix.sourceTotal ? ` · shares ${prefix.shared} of ${prefix.sourceTotal} source Turns${prefix.diverged ? ", then diverges" : ""}` : "";
    const placement = placementNote(thread, source);
    parts.push(`<button type="button" class="lineage-chip" data-open-lineage="${escapeHtml(source.id)}" aria-label="Open the source chat: ${escapeHtml(titleForThread(source))}">⑂ Forked from <strong>${escapeHtml(titleForThread(source))}</strong></button><small class="lineage-note">Lineage from Thread.forkedFromId${escapeHtml(divergence)}</small>${placement ? `<small class="lineage-note lineage-placement">${escapeHtml(placement)}</small>` : ""}`);
  }
  const forks = forksOf(thread.id, state.threads);
  if (forks.length) {
    const rows = forks.map((fork) => `<button type="button" class="fork-row" data-open-lineage="${escapeHtml(fork.id)}"><strong>${escapeHtml(titleForThread(fork))}</strong><small>${escapeHtml(`${fork.preview || "Codex Thread"} · ${fork.project ? `in the ${fork.project.name} group` : "in Recents"}`)}</small></button>`).join("");
    parts.push(`<details class="fork-list" data-disclosure-id="fork-list" open><summary>⑂ ${forks.length} fork${forks.length === 1 ? "" : "s"} of this chat</summary><div class="fork-list-rows">${rows}</div></details>`);
  }
  return parts.length ? `<div class="thread-lineage" id="threadLineage">${parts.join("")}</div>` : "";
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
  const lineage = state.activeThread.forkedFromId && state.forkReview?.direction !== "chip" ? ` · Fork of ${state.activeThread.forkedFromId}` : "";
  const lineageReview = forkLineageMarkup(state.activeThread);
  const existingTimeline = $("#turns");
  if (preserveScroll && existingTimeline) {
    patchTimeline(existingTimeline, turnsMarkup(state.activeThread));
    $("#streamStatus").textContent = state.paintDeferred
      ? "Codex response updated. The selected passage keeps its current text until you release the selection."
      : state.running ? "Codex response updated." : "Codex response settled.";
  } else {
    captureRequestDrafts(surface);
    surface.innerHTML = `<div class="chat-view"><header class="thread-heading"><div><div class="thread-title-block" id="threadTitleBlock"></div><p>${escapeHtml(state.activeThread.cwd ?? state.bootstrap.graph.project.repositoryRoot)} · ${escapeHtml(state.activeThread.id)}${escapeHtml(lineage)}</p>${lineageReview}<p class="thread-posture" id="threadPosture" data-posture="unknown"></p><div class="thread-context" id="contextIndicator" data-state="unknown"></div></div><div class="thread-actions"><label><span class="sr-only">Move Chat to group</span><select id="activeThreadProject" aria-label="Move Chat to group">${projectOptions}</select></label><label><span class="sr-only">Permissions</span><select id="permissionsControl" aria-label="Permissions"></select></label><button type="button" data-compact-thread="${escapeHtml(state.activeThread.id)}" aria-label="Compact this chat's context" disabled>Compact</button><button type="button" data-fork-thread="${escapeHtml(state.activeThread.id)}" aria-label="Fork this chat" title="Fork this chat" ${state.fixtureMode || state.running ? "disabled" : ""}>Fork</button><button type="button" data-archive-thread="${escapeHtml(state.activeThread.id)}">Archive</button></div></header><div class="transcript" id="turns">${turnsMarkup(state.activeThread)}</div><div id="streamAnchor"></div></div>`;
    restoreRequestDrafts(surface);
    renderThreadTitle();
  }
  renderContextIndicator();
  renderPosture();
  requestAnimationFrame(() => {
    if (selecting) surface.scrollTop = heldScrollTop;
    else if (!preserveScroll || distanceFromBottom < 96) surface.scrollTop = surface.scrollHeight;
    else surface.scrollTop = Math.max(0, surface.scrollHeight - surface.clientHeight - distanceFromBottom);
  });
}

// Phase comes from the canonical operational summary (vh-ui.mjs
// operationalState) wherever the two agree; the browser adds only RUNNING,
// which is live Thread presence or pending independent closeout.
function operationalLabel(ticket) {
  return ticket.capabilities.operational?.summary?.label ?? null;
}

function primaryPhase(ticket) {
  const operational = operationalLabel(ticket);
  if (operational === "DONE") return "DONE";
  if (["BLOCKED", "REFINE", "DEVIATED"].includes(operational)) return "DRAFT";
  if (ticket.capabilities.nextAction.summary.action === "CLOSE_OUT") return "RUNNING";
  if (state.threads.some((thread) => thread.taskLink?.ticketId === ticket.ticketId && String(thread.status?.type ?? thread.status).toLowerCase().includes("active"))) return "RUNNING";
  return "READY";
}

function substate(ticket) {
  const operational = operationalLabel(ticket);
  if (["BLOCKED", "DEVIATED", "REFINE"].includes(operational)) return operational;
  const actionName = ticket.capabilities.nextAction.summary.action;
  return ({ NEEDS_HUMAN: "NEEDS YOU", CLOSE_OUT: "VERIFYING" })[actionName] ?? "";
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

// The Task whose provenance the Graph draws: the focused card, else the Task
// the Workspace was last opened on. Selection is presentation state only.
function focusedGraphTicketId() {
  const focused = document.activeElement?.closest?.(".task-card")?.dataset.ticketId;
  if (focused) return focused;
  return state.activeTicketId && $(`.graph .task-card[data-ticket-id="${CSS.escape(state.activeTicketId)}"]`) ? state.activeTicketId : null;
}

// Source Chats of the focused Task as nodes above the cards, so a Chat-to-Task
// provenance edge has a Chat end. Associations come from checked-in Ticket
// YAML; clicking a node opens that Codex Thread as ordinary Chat.
function renderGraphSources() {
  const strip = $("#graphSources");
  if (!strip) return;
  const ticketId = focusedGraphTicketId();
  const associations = ticketId ? taskAssociations().filter((association) => association.ticketId === ticketId) : [];
  strip.dataset.provenanceTicket = ticketId ?? "";
  if (!ticketId) {
    strip.innerHTML = '<p class="graph-sources-empty">Focus a Task to see the Chats it was born from or attached to. Provenance is never a dependency.</p>';
    return;
  }
  if (!associations.length) {
    strip.innerHTML = `<p class="graph-sources-empty">${escapeHtml(humanize(ticketId))} was not born from a Codex Chat and has no attached Turn.</p>`;
    return;
  }
  strip.innerHTML = `<span class="graph-sources-label">Provenance of ${escapeHtml(humanize(ticketId))}</span>${associations.map((association) => `<button type="button" class="graph-chat" data-thread-id="${escapeHtml(association.threadId)}" data-graph-chat="${escapeHtml(association.threadId)}" data-graph-turn="${escapeHtml(association.turnId)}" data-association-kind="${escapeHtml(association.kind)}" title="Open this Codex Chat"><i>◫</i><span><strong>${escapeHtml(threadTitleById(association.threadId) ?? `Chat ${association.threadId.slice(0, 8)}…`)}</strong><small>Codex Chat · Turn ${escapeHtml(association.turnId)} · ${association.kind === "origin" ? "origin" : "attached"}</small></span></button>`).join("")}`;
}

function renderGraphEdges() {
  const graph = $(".graph");
  const svg = graph ? $(".graph-edges", graph) : null;
  if (!graph || !svg) return;
  const graphRect = graph.getBoundingClientRect();
  const paths = [];
  // Provenance edges: from each source Chat node to the focused Task card.
  // They carry their own edge kind and are never relations, never counted.
  const provenanceTicketId = focusedGraphTicketId();
  const provenanceTarget = provenanceTicketId ? graph.querySelector(`.task-card[data-ticket-id="${CSS.escape(provenanceTicketId)}"]`) : null;
  for (const node of provenanceTarget ? $$("[data-graph-chat]", graph) : []) {
    const nodeRect = node.getBoundingClientRect();
    const targetRect = provenanceTarget.getBoundingClientRect();
    const x1 = nodeRect.left - graphRect.left + nodeRect.width / 2;
    const y1 = nodeRect.bottom - graphRect.top;
    const x2 = targetRect.left - graphRect.left + targetRect.width / 2;
    const y2 = targetRect.top - graphRect.top;
    const bend = Math.max(20, Math.abs(y2 - y1) * .48);
    paths.push(`<path data-edge-kind="provenance" data-provenance-ticket="${escapeHtml(provenanceTicketId)}" data-provenance-thread="${escapeHtml(node.dataset.graphChat)}" d="M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}" marker-end="url(#graphProvenanceArrow)"><title>${escapeHtml(`${node.dataset.associationKind === "origin" ? "Born from" : "Attached to"} Codex Chat ${node.dataset.graphChat} · Turn ${node.dataset.graphTurn} (provenance, not a dependency)`)}</title></path>`);
  }
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
    paths.push(`<path data-edge-kind="depends_on" d="${d}" marker-end="url(#graphArrow)"><title>${escapeHtml(relation.rationale)}</title></path>`);
  }
  svg.setAttribute("viewBox", `0 0 ${graphRect.width} ${graphRect.height}`);
  svg.innerHTML = `<defs><marker id="graphArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 8 4 L 0 8 z"></path></marker><marker id="graphProvenanceArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto"><path class="provenance-arrow" d="M 0 0 L 8 4 L 0 8 z"></path></marker></defs>${paths.join("")}`;
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
  const cardOrigin = (ticket) => {
    const origin = ticket.associations?.find((association) => association.kind === "origin") ?? null;
    const attached = (ticket.associations ?? []).filter((association) => association.kind === "attached").length;
    if (!origin && !attached) return "";
    const text = origin ? originLabel(ticket.ticketId) : `Attached to ${attached} Chat Turn${attached === 1 ? "" : "s"}`;
    return `<small class="task-origin" data-origin-thread="${escapeHtml(origin?.threadId ?? "")}" data-origin-turn="${escapeHtml(origin?.turnId ?? "")}">${escapeHtml(text)}${origin && attached ? ` · +${attached} attached` : ""}</small>`;
  };
  surface.innerHTML = `<div class="tasks-view"><header class="tasks-heading"><div><span class="eyebrow">VIBEHUB · CURRENT WORK</span><h1>Task Graph</h1><p>Tasks organize what Codex work is for, how it progresses, and what counts as done.</p></div><div class="task-summary">${["DRAFT", "READY", "RUNNING", "DONE"].map((phase) => `<span>${phases[phase] ?? 0} ${phase}</span>`).join("")}</div></header><div class="graph"><div class="graph-sources" id="graphSources" aria-label="Source Chats of the focused Task"></div><svg class="graph-edges" aria-hidden="true"></svg>${tickets.map((ticket) => `<button class="task-card" type="button" data-ticket-id="${escapeHtml(ticket.ticketId)}" data-phase="${primaryPhase(ticket)}" data-operational="${escapeHtml(operationalLabel(ticket) ?? "")}"><header><span class="phase"><i></i>${primaryPhase(ticket)}</span>${substate(ticket) ? `<span class="substate">${substate(ticket)}</span>` : ""}</header><strong>${escapeHtml(humanize(ticket.ticketId))}</strong><p>${escapeHtml(ticket.outcome)}</p>${cardOrigin(ticket)}<footer><span data-relation-counts="${ticket.relationCounts.prerequisites}:${ticket.relationCounts.dependents}">${ticket.relationCounts.prerequisites} in · ${ticket.relationCounts.dependents} out</span><span>→</span></footer></button>`).join("")}</div></div>`;
  renderGraphSources();
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

function proofMarkup(handoff, workspace) {
  // Evidence, Outcome and next action are the canonical handoff fields the
  // host returned (vh-ui.mjs buildTicketHandoff); nothing here is re-derived.
  const evidence = workspace?.evidence ?? handoff.evidence ?? [];
  const outcome = workspace?.outcome ?? handoff.outcomeRecord ?? null;
  const nextAction = workspace?.nextAction ?? handoff.nextAction;
  const acceptanceCount = handoff.acceptance.length;
  const evidencedIds = new Set(evidence.flatMap((item) => item.acceptanceIds ?? []));
  const evidencedCount = handoff.acceptance.filter((item) => evidencedIds.has(item.acceptance_id)).length;
  const evidenceList = evidence.length
    ? `<ul class="evidence-list">${evidence.map((item) => `<li data-evidence-id="${escapeHtml(item.evidenceId)}"><details class="evidence-item" data-disclosure-id="evidence-${escapeHtml(item.evidenceId)}"><summary><strong>${escapeHtml(item.evidenceId)}</strong><small>${escapeHtml((item.acceptanceIds ?? []).join(", "))} · ${escapeHtml(item.origin ?? "agent")} origin${item.recordedAt ? ` · ${escapeHtml(formatWhen(item.recordedAt))}` : ""}</small></summary><p>${escapeHtml(item.summary)}</p>${item.refs?.length ? `<ul class="evidence-refs">${item.refs.map((ref) => `<li><code>${escapeHtml(ref)}</code></li>`).join("")}</ul>` : ""}</details></li>`).join("")}</ul>`
    : '<p class="proof-empty">No acceptance-linked Evidence is recorded yet.</p>';
  const outcomeRecord = outcome
    ? `<dl class="outcome-record" data-outcome-status="${escapeHtml(outcome.status)}"><dt>Status</dt><dd><strong>${escapeHtml(outcome.status)}</strong> · closed ${escapeHtml(formatWhen(outcome.closed_at))}</dd><dt>Summary</dt><dd>${escapeHtml(outcome.summary)}</dd><dt>Accepted</dt><dd>${escapeHtml((outcome.accepted_acceptance_ids ?? []).join(", ") || "none")}</dd><dt>Unresolved</dt><dd>${escapeHtml((outcome.unresolved_acceptance_ids ?? []).join(", ") || "none")}</dd><dt>Evidence cited</dt><dd>${escapeHtml((outcome.evidence_ids ?? []).join(", ") || "none")}</dd></dl>`
    : '<p class="proof-empty" data-outcome-status="pending">No independent Outcome is recorded. A completed Codex Turn is never an Outcome.</p>';
  return `<section class="proof-section" data-evidence-count="${evidence.length}" data-outcome-status="${escapeHtml(outcome?.status ?? "pending")}"><span class="eyebrow">PROOF</span><h3>${evidence.length} Evidence</h3><p>${evidencedCount} of ${acceptanceCount} acceptance criteria evidenced · Outcome ${escapeHtml(outcome ? outcome.status : "pending")}</p><p class="proof-next" data-next-action="${escapeHtml(nextAction.action)}"><strong>${escapeHtml(nextAction.action)}</strong> · <code>${escapeHtml(nextAction.reason ?? "unknown")}</code>${nextAction.detail ? `<br>${escapeHtml(nextAction.detail)}` : ""}</p><h4>Evidence</h4>${evidenceList}<h4>Outcome</h4>${outcomeRecord}</section>`;
}

// The quoted passage a Create Task confirmation recorded in the Task's own
// context (the checked-in Ticket), shown as the origin excerpt. Nothing is
// read back from the source transcript to build it.
function originExcerpt(handoff) {
  const { quoted } = parseQuotedMessage(handoff.context ?? "");
  const text = quoted.split("\n").map((line) => line.replace(/^> ?/, "")).join("\n").trim();
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

// Origin chip and attached associations of a Task, from handoff.associations
// (checked-in YAML) alone. Return to source reopens the exact Thread on the
// chat route and focuses the origin item; an attached Turn opens the same way.
function taskAssociationsMarkup(handoff) {
  const associations = handoff.associations ?? [];
  const origin = associations.find((association) => association.kind === "origin") ?? null;
  const attached = associations.filter((association) => association.kind === "attached");
  if (!origin && !attached.length) return "";
  const sourceButton = (association, label, className) => `<button class="${className}" type="button" data-return-to-source data-source-thread="${escapeHtml(association.threadId)}" data-source-turn="${escapeHtml(association.turnId)}" data-source-item="${escapeHtml(association.itemId ?? "")}" data-association-kind="${escapeHtml(association.kind)}">${label}</button>`;
  const excerpt = origin ? originExcerpt(handoff) : "";
  const chip = origin
    ? `<div class="origin-chip" data-task-origin="${escapeHtml(origin.threadId)}" data-origin-turn="${escapeHtml(origin.turnId)}" data-origin-item="${escapeHtml(origin.itemId ?? "")}"><span class="eyebrow">ORIGIN</span><p><strong>${escapeHtml(threadTitleById(origin.threadId) ?? `Chat ${origin.threadId.slice(0, 8)}…`)}</strong> · Turn <code>${escapeHtml(origin.turnId)}</code>${origin.itemId ? ` · Item <code>${escapeHtml(origin.itemId)}</code>` : ""} · ${escapeHtml(describeSelection(handoff.origin?.selection ?? null))}</p>${excerpt ? `<blockquote class="origin-excerpt">${escapeHtml(excerpt)}</blockquote>` : ""}${sourceButton(origin, "Return to source", "secondary-button")}</div>`
    : "";
  const others = attached.length
    ? `<div class="origin-attached"><span class="eyebrow">ATTACHED TURNS</span>${attached.map((association) => sourceButton(association, `<strong>${escapeHtml(threadTitleById(association.threadId) ?? `Chat ${association.threadId.slice(0, 8)}…`)}</strong><small>attached · Turn ${escapeHtml(association.turnId)}</small>`, "association-link")).join("")}</div>`
    : "";
  return `<div class="task-associations" data-association-count="${associations.length}">${chip}${others}</div>`;
}

function renderTaskWorkspace() {
  if (!state.activeTask) {
    setRouteHeader("Task", "Loading canonical Context", { back: true });
    surface.innerHTML = '<div class="loading"><span></span><p>Reading Task Context…</p></div>';
    return;
  }
  const handoff = state.activeTask;
  const workspace = state.taskWorkspace;
  const ticket = state.bootstrap.graph.tickets.find((item) => item.ticketId === handoff.ticketId) ?? {
    ticketId: handoff.ticketId,
    capabilities: { operational: { summary: { label: handoff.operationalState } }, nextAction: { summary: handoff.nextAction } },
  };
  const linked = state.threads.find((thread) => thread.taskLink?.ticketId === handoff.ticketId);
  const phase = primaryPhase(ticket);
  const actionLabel = linked && ["EXECUTE", "REFINE"].includes(handoff.nextAction.action) ? "Continue" : recommendedAction(handoff);
  const packet = workspace?.packet;
  // packetText is shown verbatim: it is the host's own serialization of the
  // packet, the same bytes a Start sends as the first Turn input.
  const packetText = workspace?.packetText ?? (packet ? JSON.stringify(packet, null, 2) : "");
  const packetLabel = state.fixtureMode ? "Inspect review fixture packet" : "Inspect host-owned packet";
  const effectiveContextIds = new Set([...(packet?.context.directContextIds ?? []), ...state.taskSelectedContextIds]);
  const effectiveContexts = workspace?.eligibleContexts.filter((item) => effectiveContextIds.has(item.contextId)) ?? [];
  const contextCount = effectiveContexts.length;
  const roomNames = [...new Set(effectiveContexts.map((item) => item.room))].sort();
  const projectLabel = packet?.project.scope === "standalone" ? "Standalone Task" : packet?.project.name ?? state.bootstrap.graph.project.name;
  setRouteHeader(humanize(handoff.ticketId), `Task Workspace · ${handoff.nextAction.action}`, { back: true });
  captureRequestDrafts(surface);
  surface.innerHTML = `<div class="task-workspace" data-ticket-workspace="${escapeHtml(handoff.ticketId)}"><header class="task-hero"><div><span class="eyebrow">TASK · ${escapeHtml(projectLabel)}</span><h1>${escapeHtml(humanize(handoff.ticketId))}</h1><p>${escapeHtml(handoff.outcome)}</p>${taskAssociationsMarkup(handoff)}</div><span class="task-phase"><i></i>${phase}${substate(ticket) ? ` · ${substate(ticket)}` : ""}</span></header><div class="workspace-grid"><div class="workspace-main"><section class="task-intent"><span class="eyebrow">CONTEXT SPACE</span><h2>What this Task is here to finish</h2><p>${escapeHtml(handoff.context)}</p><details><summary>Acceptance and constraints <span>${handoff.acceptance.length}</span></summary><div class="acceptance-list">${handoff.acceptance.map((item) => `<div class="acceptance-row"><i>${handoff.evidence.some((evidence) => evidence.acceptanceIds.includes(item.acceptance_id)) ? "✓" : "○"}</i><span>${escapeHtml(item.criterion)}</span></div>`).join("")}</div>${handoff.constraints?.length ? `<ul class="constraint-list">${handoff.constraints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}</details></section><section class="task-context-panel"><header><div><span class="eyebrow">CONTEXT FOR THE NEXT TURN</span><h2>${contextCount} governed item${contextCount === 1 ? "" : "s"}</h2></div><span>${escapeHtml(roomNames.join(" · ") || "No Room required")}</span></header><p>Included by the Task contract or selected here for one Turn. Reading never grants writeback.</p>${taskContextSelectionMarkup()}<details class="packet-inspector" data-disclosure-id="packet-inspector"><summary>${packetLabel} <span>${packetText.length.toLocaleString()} chars</span></summary><pre data-packet-text tabindex="0" aria-label="Task Context packet">${escapeHtml(packetText)}</pre></details></section><section class="task-conversation-section"><header><div><span class="eyebrow">TASK CONVERSATION</span><h2>${linked ? escapeHtml(titleForThread(linked)) : "No Codex Thread yet"}</h2></div>${linked ? `<button class="secondary-button" type="button" data-thread-id="${escapeHtml(linked.id)}">Open as Chat</button>` : ""}</header><p>${linked ? "Human messages can explore, steer, approve or interrupt this Task. Codex owns the Thread; VibeHub owns the Task contract." : "Start the recommended action to open a persistent Codex Thread with the exact packet above."}</p><div class="task-conversation-timeline" id="taskConversationTimeline">${state.activeThread ? turnsMarkup(state.activeThread) : '<div class="task-conversation-empty">The first Turn will carry the canonical Task packet. No transcript is invented before that.</div>'}</div></section></div><aside class="workspace-aside"><section class="recommended-section"><span class="eyebrow">RECOMMENDED ACTION</span><button class="recommended" type="button" ${linked ? "data-focus-task-composer" : `data-task-action="${escapeHtml(handoff.nextAction.action)}"`} ${["WAIT", "DONE"].includes(handoff.nextAction.action) && !linked ? "disabled" : ""}><strong>${escapeHtml(actionLabel)}</strong><span>→</span></button><p>${linked ? "Continue in the Task conversation below." : "The local host assembles Project, Context, authority and source citations."}</p></section><section><span class="eyebrow">CURRENT WORK</span><h3>${linked ? `Thread ${escapeHtml(linked.id.slice(0, 8))}…` : "Not started"}</h3><p>${state.running ? "Codex is running now." : linked ? "Thread is ready for the next Turn." : "No execution claim."}</p></section>${proofMarkup(handoff, workspace)}<section><span class="eyebrow">ROOMS & SOURCE</span><p>${escapeHtml(roomNames.join(" · ") || "Standalone")}</p><p>${escapeHtml(handoff.reviewInputs.ticketRef)}<br><strong>${escapeHtml(handoff.reviewInputs.commit?.slice(0, 10) ?? "working tree")}</strong></p></section></aside></div></div>`;
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
  state.bootstrapRefreshes += 1;
  state.bootstrap = data;
  applyNotificationPreferences(data.preferences);
  // The host's lists, plus the provisional row of any watched Thread the
  // runtime has not listed yet (sidebar-freshness.mjs).
  const lists = settleListings(data);
  state.threads = lists.threads;
  state.projects = data.projects;
  state.pinned = data.pinned;
  state.recents = lists.recents;
  if (state.activeThreadId) {
    const metadata = state.threads.find((thread) => thread.id === state.activeThreadId);
    if (metadata && state.activeThread) state.activeThread = { ...state.activeThread, ...metadata };
  }
  // The event stream opens at the bootstrap's cursor once, so history is
  // never replayed as live; every later bootstrap keeps the browser's own
  // cursor, because adopting a newer one would drop the events appended
  // since the last poll (a turn/completed, an approval request).
  if (!state.eventStreamOpened) {
    state.eventCursor = data.eventCursor;
    state.eventStreamOpened = true;
  }
  state.pendingRequests = data.pendingRequests;
  state.knownRequestIds = new Set(data.pendingRequests.map((request) => String(request.id)));
  pruneRequestDrafts(state.requestDrafts, state.knownRequestIds);
  state.runtimeGeneration = data.runtime.generation;
  state.runtimeAlive = data.runtime.alive;
  // bootstrap.queues lists every Thread with queued follow-ups (media elided);
  // a Thread absent from it has an empty queue in the host.
  mirrorBootstrapQueues(data.queues ?? []);
  updateAttentionState(data.attention);
  renderProjectHeader();
  renderStopBanner();
  $("#accountName").textContent = data.account.authenticated ? "Codex" : "Sign in required";
  $("#accountPlan").textContent = data.account.planType ?? data.account.accountType ?? "Unavailable";
  setRuntimePosture({ alive: data.runtime.alive && data.account.authenticated, generation: data.runtime.generation, state: data.stop ? "halted" : data.runtime.state ?? (data.runtime.alive ? "alive" : "exited") });
  updateSidebar();
  // The model catalog is read once the runtime can answer; until then the
  // pickers stay disabled and say they are not loaded.
  if (state.runtimeAlive && state.runtimeState === "alive" && !data.stop && state.models === null) void loadModels();
  renderComposerSettings();
}

async function openThread(threadId, { route = "chat" } = {}) {
  const sameSurface = state.activeThreadId === threadId && state.route === route;
  const switchingThread = state.activeThreadId !== threadId;
  if (switchingThread) captureComposerDraft();
  const data = await action({ action: "readThread", threadId });
  state.activeThreadId = threadId;
  state.unseenCompletions.delete(threadId);
  state.activeThread = { ...state.threads.find((thread) => thread.id === threadId), ...data.thread };
  state.currentTurnId = liveTurnId(state.activeThread);
  state.running = Boolean(state.currentTurnId);
  if (data.settings) rememberSettingsRecord(threadId, data.settings);
  syncThreadLocation();
  if (switchingThread) restoreComposerDraft(threadId);
  // The host-owned queue of this Thread, with full media, on every open; a
  // host that cannot answer leaves the mirror as it was.
  if (switchingThread || !threadQueue(state, threadId)) await loadQueue(threadId);
  if (!state.running) {
    for (const [key, item] of state.liveItems) if (item._threadId === threadId) state.liveItems.delete(key);
    for (const map of [state.turnErrors, state.turnPlans, state.turnDiffs]) {
      // A "runtime exited during this Turn" boundary is observed history,
      // not streamed state: it stays until replay marks the Turn terminal.
      for (const [key, item] of map) if (item._threadId === threadId && item.status !== "runtimeExited") map.delete(key);
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
    if (state.settingsOverrides.has("")) {
      state.settingsOverrides.set(data.thread.id, state.settingsOverrides.get(""));
      state.settingsOverrides.delete("");
    }
    if (data.thread.settings) rememberSettingsRecord(data.thread.id, data.thread.settings);
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
  finally { state.creatingThread = null; $("#newThread").disabled = Boolean(state.bootstrap?.stop); }
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
      restoreTaskQuoteDraft(ticketId);
    }
    syncThreadLocation();
    renderTaskWorkspace();
  } catch (error) {
    // A Task that cannot be read (unbound scope, unknown Ticket, stale deep
    // link) lands on ordinary Chat; the Graph is never a fallback landing.
    state.activeTicketId = null;
    state.activeTask = null;
    state.taskWorkspace = null;
    notify(error.message);
    setRoute("chat");
  }
}

// One more attachment, or the reason it was refused: the next Turn's model
// must accept images, and the count and byte bounds are named.
function addAttachment(file, url) {
  if (attachmentKind(file) === "image") {
    const refusal = imageRefusal(nextTurnModel());
    if (refusal) { notify(refusal); return false; }
  }
  const { attachments, refused } = acceptAttachment(state.attachments, { file, url });
  if (refused) { notify(refused); return false; }
  state.attachments = attachments;
  renderAttachments();
  return true;
}

// Files from the picker, the clipboard or a drop, read one by one into data
// URLs; a file over the byte bound is refused before it is read.
async function addAttachmentFiles(files) {
  let added = 0;
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) { notify(`${file.name || "The attachment"} is larger than the 8 MiB attachment limit.`); continue; }
    if (addAttachment(file, await fileToDataUrl(file))) added += 1;
  }
  if (added) $("#streamStatus").textContent = `${added} attachment${added === 1 ? "" : "s"} added to your next message.`;
  return added;
}

function renderAttachments() {
  const tray = $("#attachmentTray");
  tray.hidden = state.attachments.length === 0;
  tray.innerHTML = renderAttachmentChips(state.attachments);
}

function renderComposerQuote() {
  const tray = $("#quoteTray");
  tray.hidden = !state.composerQuote;
  const source = state.composerQuote ? `Thread ${state.composerQuote.threadId} · Turn ${state.composerQuote.turnId} · Item ${state.composerQuote.itemId}` : "";
  // Review-only Bring Back labeling: when the quote's Thread is a listed fork
  // of the open Chat, say so; the identity line itself is unchanged.
  const quotedFromFork = state.forkReview && state.composerQuote && state.threads.find((thread) => thread.id === state.composerQuote.threadId)?.forkedFromId === state.activeThreadId;
  const where = state.composerQuote && state.composerQuote.threadId !== state.activeThreadId ? `${quotedFromFork ? "Brought back from fork" : "From Codex Thread"} ${state.composerQuote.threadId} · Turn ${state.composerQuote.turnId}` : "From this Codex Turn";
  tray.innerHTML = state.composerQuote ? `<span><strong>Quoted response</strong><small>${escapeHtml(state.composerQuote.text.slice(0, 180))}${state.composerQuote.text.length > 180 ? "…" : ""}</small><small class="quote-source" title="${escapeHtml(source)}" aria-label="${escapeHtml(source)}">${escapeHtml(where)}</small></span><button type="button" data-remove-quote aria-label="Remove quoted response">×</button>` : "";
}

function setComposerQuote({ text, itemKey: sourceKey }) {
  const clean = String(text ?? "").trim();
  if (!clean) return;
  const source = timelineItem(sourceKey);
  state.composerQuote = { text: clean.slice(0, 4_000), itemKey: sourceKey, threadId: source?._threadId ?? state.activeThreadId, turnId: source?._turnId, itemId: source?.id };
  renderComposerQuote();
  $("#selectionSheet").hidden = true;
  $("#composerInput").focus();
  notify("Quote added to your next message.");
}

function autoSizeComposer() {
  const textarea = $("#composerInput");
  const bounds = composerBounds(getComputedStyle(textarea));
  textarea.style.height = "auto";
  textarea.style.height = `${clampComposerHeight(textarea.scrollHeight, bounds)}px`;
}

// A Task without a Codex Thread keeps its pending Quote into Task keyed by
// Task id, in memory only; it is sent solely as startTask.humanMessage.
function captureTaskQuoteDraft() {
  if (state.route !== "task" || state.activeThreadId || !state.activeTicketId) return;
  if (state.composerQuote) state.taskQuoteDrafts.set(state.activeTicketId, structuredClone(state.composerQuote));
  else state.taskQuoteDrafts.delete(state.activeTicketId);
}

function restoreTaskQuoteDraft(ticketId) {
  $("#composerInput").value = "";
  state.composerQuote = state.taskQuoteDrafts.get(ticketId) ? structuredClone(state.taskQuoteDrafts.get(ticketId)) : null;
  state.attachments = [];
  state.mentions = [];
  closeMentionPicker();
  renderComposerQuote();
  renderAttachments();
  renderMentions();
  autoSizeComposer();
}

function captureComposerDraft(threadId = state.activeThreadId) {
  if (!threadId) { captureTaskQuoteDraft(); return; }
  saveThreadDraft(state.composerDrafts, threadId, {
    text: $("#composerInput").value,
    quote: state.composerQuote ? structuredClone(state.composerQuote) : null,
    attachments: state.attachments.map((item) => ({ ...item })),
    mentions: state.mentions.map((item) => ({ ...item })),
  });
}

function restoreComposerDraft(threadId) {
  const draft = loadThreadDraft(state.composerDrafts, threadId);
  $("#composerInput").value = draft.text;
  state.composerQuote = draft.quote;
  state.attachments = draft.attachments;
  state.mentions = draft.mentions;
  closeMentionPicker();
  renderComposerQuote();
  renderAttachments();
  renderMentions();
  autoSizeComposer();
}

function timelineItem(itemKeyValue) {
  return canonicalTimeline(state.activeThread, state, { limit: 240 }).find((item) => item._key === itemKeyValue);
}

function itemText(itemKeyValue) {
  return timelineItem(itemKeyValue)?.text ?? "";
}

// The selection sheet: Add to chat on any assistant passage; Create Task,
// Attach to Task and Remember only on a finalized assistant message, and
// disabled with the missing scope explained while the Project is unbound.
function updateQuoteSelection() {
  const sheet = $("#selectionSheet");
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) { sheet.hidden = true; return; }
  const range = selection.getRangeAt(0);
  const assistant = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer.closest?.(".turn.assistant")
    : range.commonAncestorContainer.parentElement?.closest(".turn.assistant");
  const text = selection.toString().trim();
  if (!assistant || !surface.contains(assistant) || !text) { sheet.hidden = true; return; }
  const rect = range.getBoundingClientRect();
  state.selectedQuote = { text, itemKey: assistant.dataset.itemId };
  const finalized = assistant.dataset.finalized === "true";
  const bridge = bridgeAvailability();
  sheet.dataset.finalized = finalized ? "true" : "false";
  sheet.dataset.bridgeAvailable = bridge.available ? "true" : "false";
  const hint = $("#selectionSheetHint");
  hint.hidden = !(finalized && !bridge.available);
  hint.textContent = finalized && !bridge.available ? `Create Task, Attach to Task and Remember need a bound VibeHub Project: ${bridge.reason}` : "";
  for (const button of $$("[data-selection-bridge]", sheet)) {
    button.hidden = !finalized;
    button.disabled = !bridge.available;
    if (bridge.available) { button.removeAttribute("title"); button.removeAttribute("aria-describedby"); }
    else { button.title = bridge.reason; button.setAttribute("aria-describedby", "selectionSheetHint"); }
  }
  // Bring Back (Direction C of docs/proposals/fork-chat), review fixture
  // only: offered on a finalized passage of a fork whose source is listed.
  const bringBackButton = $("[data-bring-back]", sheet);
  if (bringBackButton) bringBackButton.hidden = !(state.forkReview?.direction === "bringback" && finalized && resolveLineage(state.activeThread, state.threads)?.source);
  sheet.hidden = false;
  const width = sheet.offsetWidth || 112;
  sheet.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2))}px`;
  sheet.style.top = `${Math.max(8, rect.top - sheet.offsetHeight - 10)}px`;
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

function clearComposerAfterSend(textarea) {
  textarea.value = "";
  state.composerQuote = null;
  renderComposerQuote();
  autoSizeComposer();
  state.attachments = [];
  renderAttachments();
  state.mentions = [];
  renderMentions();
  closeMentionPicker();
  state.composerDrafts.delete(state.activeThreadId);
}

async function submitTurn(event) {
  event.preventDefault();
  const mode = composerSubmitMode;
  composerSubmitMode = "default";
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
    const threadId = state.activeThreadId;
    const input = [];
    // Each mention chip still present in the text is one text_elements entry
    // (the UTF-8 byte span of its placeholder) and one mention or skill item.
    const { elements, items } = composeTextElements(composedText, state.mentions);
    if (composedText) input.push(elements.length ? { type: "text", text: composedText, text_elements: elements } : { type: "text", text: composedText });
    input.push(...state.attachments.map(({ type, url }) => ({ type, url })));
    input.push(...items);
    if (input.length > INPUT_ITEM_LIMIT) return notify(`A Turn carries at most ${INPUT_ITEM_LIMIT} inputs; this message has ${input.length}. Remove some attachments or mentions.`);
    // While a Turn streams, Enter queues the follow-up in the host-owned
    // queue (started as its own turn/start after turn/completed) and
    // Alt+Enter steers that exact Turn instead. Idle submission alone starts
    // a Turn; Alt+Enter while idle is the same plain send.
    const steer = state.running && mode === "opposite";
    if (steer && !state.currentTurnId) return notify("Wait for the active Turn identity before steering it.");
    const dispatch = steer ? "steerTurn" : state.running ? "queueTurn" : "startTurn";
    // Only the keys the human changed away from the reported record travel,
    // as the exact turn/start settings; a steer carries none.
    const settings = steer ? undefined : pendingTurnSettings(threadId);
    const result = await action({ action: dispatch, threadId, ...(steer ? { expectedTurnId: state.currentTurnId } : {}), input, ...(settings ? { settings } : {}) });
    if (dispatch === "queueTurn") {
      rememberQueue(state, result.queue);
      clearComposerAfterSend(textarea);
      if (result.started) {
        // No Turn was live after all: the head started at once as its own Turn.
        attributeTurnSettings(result.started.turnId, threadId, settings ?? null);
        state.currentTurnId = result.started.turnId;
        state.running = true;
        $("#stopTurn").hidden = false;
        syncComposerMode();
        await openThread(threadId);
      } else {
        renderQueue();
        $("#streamStatus").textContent = `Queued for after the running Turn (${result.queue.items.length} waiting).`;
      }
      return;
    }
    if (dispatch === "startTurn") {
      state.currentTurnId = result.turn.id;
      // The startTurn response attaches the Thread's settings record; the
      // Turn is attributed that record under the overrides it carried.
      if (result.settings) rememberSettingsRecord(threadId, result.settings);
      attributeTurnSettings(result.turn.id, threadId, settings ?? null, result.settings ?? threadSettingsRecord(threadId));
    }
    state.running = true;
    clearComposerAfterSend(textarea);
    $("#stopTurn").hidden = false;
    syncComposerMode();
    await openThread(threadId);
  } catch (error) { notify(error.message); }
}

// --- Composer settings: model, effort and the Turn posture ------------------
// The pickers offer only what listModels returned, read their current value
// from the Thread's settings record, and send only the keys the human changed
// as the exact turn/start settings of the next Turn.

function overrideKey(threadId = state.activeThreadId) {
  return threadId ?? "";
}

function overridesFor(threadId = state.activeThreadId) {
  return state.settingsOverrides.get(overrideKey(threadId)) ?? {};
}

function setOverrides(patch, threadId = state.activeThreadId) {
  const key = overrideKey(threadId);
  const next = { ...overridesFor(threadId), ...patch };
  for (const name of Object.keys(next)) if (next[name] == null) delete next[name];
  if (Object.keys(next).length) state.settingsOverrides.set(key, next);
  else state.settingsOverrides.delete(key);
  while (state.settingsOverrides.size > 64) state.settingsOverrides.delete(state.settingsOverrides.keys().next().value);
}

// The overrides still differing from the record, or undefined when the next
// Turn needs no settings keys at all.
function pendingTurnSettings(threadId = state.activeThreadId) {
  return pendingOverrides(threadSettingsRecord(threadId), overridesFor(threadId)) ?? undefined;
}

// A reported record makes equal overrides redundant; they are dropped so the
// picker reads the runtime's own value again.
function rememberSettingsRecord(threadId, record) {
  if (!threadId || !record) return;
  rememberThreadSettings(state, threadId, record);
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (thread) thread.settings = record;
  if (state.activeThread?.id === threadId) state.activeThread.settings = record;
  const overrides = overridesFor(threadId);
  const pending = pendingOverrides(record, overrides) ?? {};
  const kept = {};
  for (const name of Object.keys(overrides)) if (name in pending) kept[name] = overrides[name];
  state.settingsOverrides.delete(overrideKey(threadId));
  if (Object.keys(kept).length) state.settingsOverrides.set(overrideKey(threadId), kept);
  if (threadId === state.activeThreadId) { renderComposerSettings(); renderPosture(); }
}

async function loadModels({ force = false } = {}) {
  if (state.modelsLoading || (state.models && !force)) return state.models;
  state.modelsLoading = true;
  try {
    const data = await action({ action: "listModels" });
    if (!Array.isArray(data?.models)) throw new Error("model/list answered without a model catalog");
    state.models = data.models;
    state.modelsError = null;
  } catch (error) {
    state.models = null;
    state.modelsError = error.message;
  } finally {
    state.modelsLoading = false;
  }
  renderComposerSettings();
  return state.models;
}

// Options are rebuilt only when they changed: the pickers re-render on every
// event window, and rebuilding an open native select would close it.
function replaceOptions(select, options, value) {
  const signature = options.map((entry) => `${entry.value}\u0000${entry.label}\u0000${entry.title ?? ""}\u0000${entry.disabled ? "1" : "0"}`).join("\n");
  if (select.dataset.optionsSignature !== signature) {
    select.textContent = "";
    for (const entry of options) {
      const option = new Option(entry.label, entry.value);
      if (entry.title) option.title = entry.title;
      if (entry.disabled) option.disabled = true;
      select.append(option);
    }
    select.dataset.optionsSignature = signature;
  }
  const next = value ?? "";
  if (select.value !== next) select.value = next;
  if (value != null && select.value !== value && options.length) select.selectedIndex = 0;
}

function settingsSourceLine(record, model, catalog) {
  if (!catalog) return state.modelsError ? `Model list unavailable: ${state.modelsError}` : "Model list not loaded from the runtime yet.";
  const reported = record ? `Reported by ${record.source}` : "Not reported for this Chat yet; showing the runtime default";
  const unlisted = model.slug && !model.model ? ` · ${model.slug} is not in model/list` : "";
  const pending = pendingTurnSettings();
  const keys = pending ? Object.keys(pending).filter((key) => ["model", "effort"].includes(key)) : [];
  const next = keys.length ? ` · next Turn sends ${keys.map((key) => `${key} ${pending[key]}`).join(", ")}` : "";
  return `${reported}${unlisted}${next}`;
}

// Model and effort pickers beneath the Composer. Disabled until listModels
// answered; options are the response alone (hidden models never arrive);
// isDefault and defaultReasoningEffort are marked; the current value comes
// from the Thread's settings record, or the loaded default when the record
// is null, without claiming it is set.
function renderComposerSettings() {
  const container = $("#composerSettings");
  if (!container) return;
  const modelPicker = $("#modelPicker");
  const effortPicker = $("#effortPicker");
  const source = $("#settingsSource");
  const catalog = Array.isArray(state.models) && state.models.length > 0;
  const record = threadSettingsRecord(state.activeThreadId);
  const overrides = overridesFor();
  const model = selectedModel(state.models, record, overrides);
  const effort = selectedEffort(model.model, record, overrides, model.slug);
  container.dataset.models = catalog ? "loaded" : state.modelsError ? "error" : "not-loaded";
  container.dataset.settingsSource = record?.source ?? "none";
  const composerDisabled = $("#composerInput").disabled;
  if (!catalog) {
    replaceOptions(modelPicker, [{ label: "Not loaded", value: "" }], "");
    replaceOptions(effortPicker, [{ label: "Not loaded", value: "" }], "");
    modelPicker.disabled = true;
    effortPicker.disabled = true;
    source.textContent = settingsSourceLine(record, model, false);
    return;
  }
  const modelOptions = state.models.map((entry) => ({ label: modelOptionLabel(entry), value: entry.model, title: entry.description ?? "" }));
  if (model.slug && !model.model) modelOptions.unshift({ label: `${model.slug} (reported by the runtime, not listed)`, value: model.slug });
  replaceOptions(modelPicker, modelOptions, model.slug);
  const effortOptions = (model.model?.supportedReasoningEfforts ?? []).map((option) => ({ label: effortOptionLabel(option, model.model), value: option.reasoningEffort, title: option.description ?? "" }));
  if (effort.effort && !effortOptions.some((option) => option.value === effort.effort)) effortOptions.unshift({ label: `${effort.effort} (reported by the runtime, not listed)`, value: effort.effort });
  replaceOptions(effortPicker, effortOptions.length ? effortOptions : [{ label: "No effort choice for this model", value: "" }], effort.effort ?? "");
  modelPicker.disabled = composerDisabled;
  effortPicker.disabled = composerDisabled || effortOptions.length === 0;
  modelPicker.dataset.valueSource = model.source;
  effortPicker.dataset.valueSource = effort.source;
  source.textContent = settingsSourceLine(record, model, true);
}

// The model the next Turn would use, for the image refusal: the picker's
// selection, which is the record's model or the loaded default.
function nextTurnModel() {
  const record = threadSettingsRecord(state.activeThreadId);
  return selectedModel(state.models, record, overridesFor()).model;
}

function chooseModel(slug) {
  const model = findModel(state.models, slug);
  if (!model) return;
  const refusal = state.attachments.some((item) => item.type === "image") ? imageRefusal(model) : null;
  if (refusal) {
    notify(`${refusal} — remove the attached images first.`);
    renderComposerSettings();
    return;
  }
  const record = threadSettingsRecord(state.activeThreadId);
  // A different model takes its own default effort unless the record already
  // names this model with an effort it supports.
  const effort = selectedEffort(model, record, {}, slug).effort;
  setOverrides({ model: slug, effort });
  renderComposerSettings();
}

function chooseEffort(effort) {
  setOverrides({ effort: effort || null });
  renderComposerSettings();
}

// --- Turn completion notices ------------------------------------------------

function applyNotificationPreferences(preferences) {
  const notifications = preferences?.notifications;
  state.notificationMode = typeof notifications?.mode === "string" ? notifications.mode : null;
  state.notificationModes = Array.isArray(notifications?.modes) ? notifications.modes : [];
  renderNotificationSetting();
}

// The control offers exactly the modes the host reported, labelled here,
// and shows the host's current mode; it is disabled until bootstrap said.
function renderNotificationSetting() {
  const control = $("#notificationMode");
  if (!control) return;
  if (!state.notificationMode || !state.notificationModes.length) {
    replaceOptions(control, [{ label: "Not loaded", value: "" }], "");
    control.disabled = true;
    return;
  }
  replaceOptions(control, state.notificationModes.map((mode) => ({ label: NOTIFICATION_MODE_LABELS[mode] ?? mode, value: mode })), state.notificationMode);
  control.disabled = false;
  control.title = "Turn completion notifications · host session setting, reset when the host restarts";
}

async function chooseNotificationMode(mode, control) {
  try {
    const data = await action({ action: "setNotificationPreference", mode });
    applyNotificationPreferences(data.preferences);
    // A browser Notification needs the human's permission; ask from this
    // gesture when it was never decided.
    if (mode !== "never" && typeof Notification === "function" && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    notify(`Turn completion notifications: ${NOTIFICATION_MODE_LABELS[mode] ?? mode}.`);
  } catch (error) {
    notify(error.message);
    renderNotificationSetting();
  }
  // The control re-rendered under the pointer; only a focus the re-render
  // dropped comes back, never one the human moved elsewhere meanwhile.
  if (document.activeElement === document.body) control?.focus?.({ preventScroll: true });
}

// One turn/completed from the event feed, live or replayed: noticed once per
// Turn id, in-app (toast, live region, Sidebar badge) and as a browser
// Notification when the preference and the permission allow.
function handleTurnCompletion(params) {
  const { notice, notification, turnId, threadId } = noticeForCompletion(state.completionNotifier, params, {
    mode: state.notificationMode ?? "unfocused",
    activeThreadId: state.activeThreadId,
    route: state.route,
    focused: document.hasFocus(),
    threadTitle: threadTitleById(params.threadId),
  });
  if (!notice) return;
  state.completionLog.push({ turnId, threadId, notice, browser: Boolean(notification), observedAt: new Date().toISOString() });
  while (state.completionLog.length > 32) state.completionLog.shift();
  state.unseenCompletions.add(threadId);
  notify(notice);
  // Notices have their own live region: the stream region is rewritten by
  // the next transcript render.
  $("#noticeStatus").textContent = notice;
  updateSidebar();
}

// --- Approval posture -------------------------------------------------------
// The header shows the approval policy and sandbox the runtime reported for
// this Thread (the settings record); the Permissions control switches between
// the two contract postures for the next Turn, with a confirmation before
// full access. Nothing changes until that turn/start carries the keys.

function renderPosture() {
  const line = $("#threadPosture");
  const control = $("#permissionsControl");
  if (!line || !control || !state.activeThread) return;
  const record = threadSettingsRecord(state.activeThreadId);
  const overrides = overridesFor();
  const reported = postureOf(record);
  const pending = pendingOverrides(record, overrides);
  const pendingPosture = pending?.approvalPolicy || pending?.sandboxPolicy ? postureOf({ approvalPolicy: pending.approvalPolicy ?? record?.approvalPolicy, sandboxPolicy: pending.sandboxPolicy ?? record?.sandboxPolicy }) : null;
  line.dataset.posture = reported ?? "unknown";
  line.dataset.pending = pendingPosture ?? "";
  const current = record && reported ? `Approval <strong>${escapeHtml(record.approvalPolicy ?? "not reported")}</strong> · Sandbox <strong>${escapeHtml(record.sandboxPolicy?.type ?? "not reported")}</strong> · reported by ${escapeHtml(record.source)}` : "Approval posture not reported for this Chat yet";
  const next = pendingPosture ? ` · next Turn sends <strong>${escapeHtml(POSTURE_LABELS[pendingPosture] ?? describePosture(pending))}</strong> (${escapeHtml(describePosture({ approvalPolicy: pending.approvalPolicy ?? record?.approvalPolicy, sandboxPolicy: pending.sandboxPolicy ?? record?.sandboxPolicy }))})` : "";
  line.innerHTML = `${current}${next}`;
  const shown = pendingPosture ?? reported;
  const options = Object.entries(POSTURE_LABELS).map(([value, label]) => ({ value, label }));
  if (!shown || shown === "other") options.unshift({ value: "", label: reported === "other" ? describePosture(record) : "Not reported", disabled: true });
  replaceOptions(control, options, shown && shown !== "other" ? shown : "");
  control.disabled = state.fixtureMode || $("#composerInput").disabled;
  control.title = pendingPosture ? "Applies to the next Turn" : "Sent as approvalPolicy and sandboxPolicy on the next Turn";
}

function choosePosture(value, control) {
  if (value === "fullAccess") {
    openFullAccessDialog(control);
    return;
  }
  if (value === "askForApproval") setOverrides({ ...POSTURES.askForApproval });
  renderPosture();
  renderComposerSettings();
}

function openFullAccessDialog(control) {
  closeSearch(false);
  closeInbox(false);
  closeImport(false);
  state.fullAccess = { threadId: state.activeThreadId, returnTo: control };
  const dialog = $("#fullAccessDialog");
  dialog.hidden = false;
  dialog.inert = false;
  syncScrim();
  requestAnimationFrame(() => $("#cancelFullAccess").focus());
}

function closeFullAccessDialog({ confirmed = false, restore = true } = {}) {
  const dialog = $("#fullAccessDialog");
  if (dialog.hidden) return;
  const request = state.fullAccess;
  state.fullAccess = null;
  dialog.hidden = true;
  dialog.inert = true;
  if (confirmed && request?.threadId) setOverrides({ ...POSTURES.fullAccess }, request.threadId);
  renderPosture();
  renderComposerSettings();
  syncScrim();
  if (restore) (request?.returnTo?.isConnected ? request.returnTo : $("#permissionsControl"))?.focus?.({ preventScroll: true });
}

// --- Context use and compaction ---------------------------------------------
// The indicator is computed only from thread/tokenUsage/updated: nothing
// before the first notification, no percentage without a modelContextWindow.
// Compact calls the host's compactThread, which refuses while a Turn is live.

function renderContextIndicator() {
  const indicator = $("#contextIndicator");
  if (!indicator || !state.activeThread) return;
  const usage = contextUsage(threadTokenUsage(state, state.activeThreadId));
  indicator.dataset.state = usage.state;
  indicator.title = usage.detail;
  const meter = usage.state === "known" ? `<span class="context-meter" role="img" aria-label="${escapeHtml(usage.label)}"><i></i></span>` : "";
  indicator.innerHTML = `${meter}<span class="context-label" id="contextLabel">${escapeHtml(usage.label)}</span>`;
  // The host's CSP allows no inline style attribute; the fill is set through the CSSOM.
  const fill = indicator.querySelector(".context-meter i");
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, usage.percent))}%`;
  const compact = $("[data-compact-thread]");
  if (compact) {
    const reason = compactDisabledReason({ running: state.running, fixture: state.fixtureMode, runtimeAlive: state.runtimeAlive && state.runtimeState === "alive" && !state.bootstrap?.stop });
    compact.disabled = Boolean(reason);
    compact.title = reason ?? "Start a compaction Turn: thread/compact/start";
  }
}

async function compactActiveThread(button) {
  const threadId = button.dataset.compactThread;
  if (!threadId || button.disabled) return;
  button.disabled = true;
  try {
    const result = await action({ action: "compactThread", threadId });
    if (result?.compacting) notify("Compacting the context as its own Turn…");
  } catch (error) {
    // 409 turn_live is the host's own refusal: a Turn is still running.
    notify(error.code === "turn_live" ? `${error.message}` : error.message);
  }
  renderContextIndicator();
}

// --- File and skill mentions ------------------------------------------------

function renderMentions() {
  const tray = $("#mentionTray");
  if (!tray) return;
  tray.hidden = state.mentions.length === 0;
  tray.innerHTML = state.mentions.map((chip, index) => `<span class="mention-chip composer-mention" role="group" data-mention-kind="${escapeHtml(chip.kind)}" aria-label="${escapeHtml(chip.kind === "skill" ? "Skill" : "File")} mention ${escapeHtml(chip.placeholder)}" title="${escapeHtml(chip.path)}"><span>${escapeHtml(chip.placeholder)}</span><button type="button" data-remove-mention="${index}" aria-label="Remove ${escapeHtml(chip.placeholder)}">×</button></span>`).join("");
}

function closeMentionPicker() {
  clearTimeout(mentionSearchTimer);
  mentionSearchSequence += 1;
  const wasOpen = mentionPicker.open;
  Object.assign(mentionPicker, { open: false, kind: null, trigger: null, query: "", items: [], index: 0, pending: false, error: null });
  if (wasOpen) renderMentionPicker();
}

function mentionOptionMarkup(item, index) {
  const selected = index === mentionPicker.index;
  const detail = item.kind === "skill" ? (item.description ?? item.path) : item.path;
  return `<button type="button" role="option" id="mention-option-${index}" aria-selected="${selected}" data-mention-option="${index}" tabindex="-1"><strong>${escapeHtml(item.placeholder)}</strong><small>${escapeHtml(detail ?? "")}</small></button>`;
}

function renderMentionPicker() {
  const picker = $("#mentionPicker");
  const textarea = $("#composerInput");
  if (!picker || !textarea) return;
  if (!mentionPicker.open) {
    picker.hidden = true;
    picker.innerHTML = "";
    textarea.setAttribute("aria-expanded", "false");
    textarea.removeAttribute("aria-activedescendant");
    return;
  }
  const kindLabel = mentionPicker.kind === "skill" ? "Skills" : "Files";
  const status = mentionPicker.error
    ? `<div class="mention-status" role="status">${escapeHtml(kindLabel)} unavailable: ${escapeHtml(mentionPicker.error)}</div>`
    : mentionPicker.pending
      ? `<div class="mention-status" role="status">Searching ${escapeHtml(kindLabel.toLowerCase())}…</div>`
      : !mentionPicker.items.length
        ? `<div class="mention-status" role="status">${mentionPicker.kind === "mention" && !mentionPicker.query ? "Type to search files in this repository" : `No ${escapeHtml(kindLabel.toLowerCase())} match ${escapeHtml(mentionPicker.query ? `“${mentionPicker.query}”` : "yet")}`}</div>`
        : "";
  picker.dataset.kind = mentionPicker.kind;
  picker.hidden = false;
  picker.innerHTML = `<header><strong>${escapeHtml(kindLabel)}</strong><small>↑↓ choose · ↵ or Tab insert · Esc close</small></header>${mentionPicker.items.map(mentionOptionMarkup).join("")}${status}`;
  textarea.setAttribute("aria-expanded", "true");
  if (mentionPicker.items.length) textarea.setAttribute("aria-activedescendant", `mention-option-${mentionPicker.index}`);
  else textarea.removeAttribute("aria-activedescendant");
  picker.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function fileMentionItems(data) {
  return (data?.files ?? []).slice(0, MENTION_RESULT_LIMIT).map((file) => ({
    kind: "mention",
    name: file.file_name ?? file.path.split("/").pop(),
    path: file.absolutePath ?? file.path,
    detail: file.path,
    placeholder: placeholderFor("mention", file.file_name ?? file.path.split("/").pop()),
  }));
}

function skillMentionItems(query) {
  const needle = query.trim().toLowerCase();
  return (state.skills ?? [])
    .filter((skill) => skill.enabled !== false && (!needle || skill.name.toLowerCase().includes(needle)))
    .slice(0, MENTION_RESULT_LIMIT)
    .map((skill) => ({ kind: "skill", name: skill.name, path: skill.path, description: skill.shortDescription ?? skill.description ?? null, placeholder: placeholderFor("skill", skill.name) }));
}

// The picker follows the trigger token the caret sits in: a new query asks
// the host again (files, debounced; skills from the one listSkills read) and
// a reply for a query no longer typed is dropped.
function syncMentionPicker() {
  const textarea = $("#composerInput");
  const trigger = state.route === "chat" && !textarea.disabled && document.activeElement === textarea ? activeTrigger(textarea.value, textarea.selectionStart) : null;
  if (!trigger) { closeMentionPicker(); return; }
  if (mentionPicker.open && mentionPicker.kind === trigger.kind && mentionPicker.query === trigger.query) { mentionPicker.trigger = trigger; return; }
  const sequence = ++mentionSearchSequence;
  clearTimeout(mentionSearchTimer);
  Object.assign(mentionPicker, { open: true, kind: trigger.kind, trigger, query: trigger.query, index: 0, error: null });
  if (trigger.kind === "mention") {
    mentionPicker.items = trigger.query ? mentionPicker.items.filter((item) => item.kind === "mention") : [];
    mentionPicker.pending = Boolean(trigger.query);
    renderMentionPicker();
    if (!trigger.query) return;
    mentionSearchTimer = setTimeout(async () => {
      let next;
      try { next = { items: fileMentionItems(await action({ action: "searchFiles", query: trigger.query, limit: MENTION_RESULT_LIMIT })), error: null }; }
      catch (error) { next = { items: [], error: error.message }; }
      if (sequence !== mentionSearchSequence || !mentionPicker.open) return;
      Object.assign(mentionPicker, next, { pending: false, index: 0 });
      renderMentionPicker();
    }, MENTION_SEARCH_DEBOUNCE_MS);
    return;
  }
  mentionPicker.items = skillMentionItems(trigger.query);
  mentionPicker.pending = state.skills === null;
  renderMentionPicker();
  if (state.skills !== null) return;
  void (async () => {
    let error = null;
    try {
      const data = await action({ action: "listSkills" });
      if (!Array.isArray(data?.skills)) throw new Error("skills/list answered without a skills list");
      state.skills = data.skills;
    } catch (caught) { error = caught.message; }
    if (sequence !== mentionSearchSequence || !mentionPicker.open) return;
    Object.assign(mentionPicker, { items: error ? [] : skillMentionItems(mentionPicker.query), pending: false, error, index: 0 });
    renderMentionPicker();
  })();
}

function moveMentionSelection(direction) {
  if (!mentionPicker.items.length) return;
  mentionPicker.index = (mentionPicker.index + direction + mentionPicker.items.length) % mentionPicker.items.length;
  renderMentionPicker();
}

// A pick replaces the trigger token with the placeholder and keeps the chip;
// the chip's name and path are exactly the host's own record.
function chooseMention(index = mentionPicker.index) {
  const item = mentionPicker.items[index];
  const trigger = mentionPicker.trigger;
  if (!item || !trigger) return false;
  if (state.mentions.length >= INPUT_ITEM_LIMIT - 2) { notify(`At most ${INPUT_ITEM_LIMIT - 2} mentions travel in one Turn.`); return false; }
  const textarea = $("#composerInput");
  const inserted = insertPlaceholder(textarea.value, trigger, item.placeholder);
  textarea.value = inserted.text;
  textarea.setSelectionRange(inserted.caret, inserted.caret);
  state.mentions = [...state.mentions, { kind: item.kind, name: item.name, path: item.path, placeholder: item.placeholder }];
  closeMentionPicker();
  renderMentions();
  autoSizeComposer();
  textarea.focus();
  $("#streamStatus").textContent = `${item.kind === "skill" ? "Skill" : "File"} ${item.placeholder} added to your message.`;
  return true;
}

function removeMention(index) {
  const chip = state.mentions[index];
  if (!chip) return;
  const textarea = $("#composerInput");
  // The chip's own occurrence of the placeholder leaves the text: the n-th
  // chip with this placeholder is its n-th occurrence.
  const ordinal = state.mentions.slice(0, index).filter((entry) => entry.placeholder === chip.placeholder).length;
  state.mentions = state.mentions.filter((_, at) => at !== index);
  textarea.value = removePlaceholder(textarea.value, chip.placeholder, ordinal);
  renderMentions();
  autoSizeComposer();
  textarea.focus();
}

// --- The host-owned follow-up queue ---------------------------------------

function mirrorBootstrapQueues(queues) {
  const listed = new Set(queues.map((queue) => queue.threadId));
  for (const threadId of [...state.queues.keys()]) if (!listed.has(threadId)) state.queues.delete(threadId);
  for (const queue of queues) applyHostEvent(state, "queueChanged", { threadId: queue.threadId, queue });
  renderQueue();
}

async function loadQueue(threadId) {
  try {
    const data = await action({ action: "listQueue", threadId });
    if (data?.queue?.threadId === threadId) rememberQueue(state, data.queue);
  } catch {
    // The mirror keeps what bootstrap or the event feed last said.
  }
  renderQueue();
}

function activeQueue() {
  return state.activeThreadId ? threadQueue(state, state.activeThreadId) ?? emptyQueue(state.activeThreadId) : null;
}

function queueRowMarkup(item, index, queue) {
  const text = queuedText(item);
  const media = queuedMediaSummary(item);
  const editing = state.queueEdit?.threadId === queue.threadId && state.queueEdit.queuedId === item.queuedId;
  if (editing) {
    return `<li class="queue-row editing" data-queued-id="${escapeHtml(item.queuedId)}"><span class="queue-order">${index + 1}</span><form class="queue-edit" data-queue-edit="${escapeHtml(item.queuedId)}"><textarea rows="2" aria-label="Edit queued message ${index + 1}" maxlength="32000">${escapeHtml(text)}</textarea>${media ? `<small class="queue-media">${escapeHtml(media)} kept</small>` : ""}<div class="queue-actions"><button type="submit">Save</button><button type="button" data-cancel-queued="${escapeHtml(item.queuedId)}">Cancel</button></div></form></li>`;
  }
  const steerable = state.running && Boolean(state.currentTurnId) && !item.starting;
  const busy = item.starting ? " disabled" : "";
  return `<li class="queue-row" data-queued-id="${escapeHtml(item.queuedId)}" data-starting="${item.starting ? "true" : "false"}"><span class="queue-order">${index + 1}</span><div class="queue-body"><p class="queue-text">${escapeHtml(text || "(no text)")}</p>${media ? `<small class="queue-media">${escapeHtml(media)}</small>` : ""}${item.starting ? '<small class="queue-media">Starting as its own Turn…</small>' : ""}</div><div class="queue-actions"><button type="button" data-edit-queued="${escapeHtml(item.queuedId)}" aria-label="Edit queued message ${index + 1}"${busy}>Edit</button><button type="button" data-steer-queued="${escapeHtml(item.queuedId)}" aria-label="Steer the running Turn with queued message ${index + 1}"${steerable ? "" : " disabled"} title="${steerable ? "Send now as a steer of the running Turn" : "Steer needs a running Turn"}">Steer</button><button type="button" data-delete-queued="${escapeHtml(item.queuedId)}" aria-label="Delete queued message ${index + 1}"${busy}>Delete</button></div></li>`;
}

// The queued follow-ups of the visible Thread, above the Composer: every row
// is the host's record, the paused state names the host's pausedReason, and
// Resume is the only way anything is sent after an interrupt.
function renderQueue() {
  const tray = $("#queueTray");
  if (!tray) return;
  const queue = state.route === "chat" ? activeQueue() : null;
  const items = queue?.items ?? [];
  if (!queue || (!items.length && !queue.paused)) {
    tray.hidden = true;
    tray.innerHTML = "";
    tray.dataset.count = "0";
    delete tray.dataset.paused;
    return;
  }
  const focused = tray.contains(document.activeElement) ? { queuedId: document.activeElement.closest("[data-queued-id]")?.dataset.queuedId, attribute: ["data-edit-queued", "data-steer-queued", "data-delete-queued", "data-cancel-queued", "data-resume-queue"].find((name) => document.activeElement.hasAttribute(name)), textarea: document.activeElement.matches("textarea") } : null;
  tray.hidden = false;
  tray.dataset.count = String(items.length);
  tray.dataset.paused = queue.paused ? "true" : "false";
  if (queue.pausedReason) tray.dataset.pausedReason = queue.pausedReason; else delete tray.dataset.pausedReason;
  const paused = queue.paused
    ? `<p class="queue-paused" role="status" data-paused-reason="${escapeHtml(queue.pausedReason ?? "")}">${escapeHtml(pausedMessage(queue))} <button type="button" data-resume-queue="${escapeHtml(queue.threadId)}">Resume</button></p>`
    : "";
  const summary = items.length ? `${items.length} waiting · ${state.running ? "each starts as its own Turn after the running one completes" : queue.paused ? "paused" : "starts next"}` : "Nothing waiting";
  tray.innerHTML = `<header><strong>Queued follow-ups</strong><small>${escapeHtml(summary)}</small></header>${paused}<ol class="queue-list" aria-label="Queued follow-ups">${items.map((item, index) => queueRowMarkup(item, index, queue)).join("")}</ol>`;
  if (focused) {
    const row = focused.queuedId ? tray.querySelector(`[data-queued-id="${CSS.escape(focused.queuedId)}"]`) : null;
    const target = focused.textarea ? row?.querySelector("textarea") : focused.attribute ? (row ?? tray).querySelector(`[${focused.attribute}]`) : null;
    (target ?? tray.querySelector("button:not([disabled]), textarea"))?.focus({ preventScroll: true });
  }
}

async function queueAction(payload, { focusSelector = null } = {}) {
  try {
    const data = await action(payload);
    if (data?.queue) rememberQueue(state, data.queue);
    renderQueue();
    if (focusSelector) requestAnimationFrame(() => $(focusSelector)?.focus({ preventScroll: true }));
    return data;
  } catch (error) {
    notify(error.message);
    await loadQueue(payload.threadId);
    return null;
  }
}

function beginQueueEdit(queuedId) {
  const queue = activeQueue();
  if (!queue?.items.some((item) => item.queuedId === queuedId)) return;
  state.queueEdit = { threadId: queue.threadId, queuedId };
  renderQueue();
  const textarea = $(`#queueTray [data-queue-edit="${CSS.escape(queuedId)}"] textarea`);
  textarea?.focus();
  textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
}

function cancelQueueEdit() {
  const queuedId = state.queueEdit?.queuedId;
  state.queueEdit = null;
  renderQueue();
  if (queuedId) $(`#queueTray [data-edit-queued="${CSS.escape(queuedId)}"]`)?.focus();
}

async function saveQueueEdit(form) {
  const queuedId = form.dataset.queueEdit;
  const queue = activeQueue();
  const item = queue?.items.find((entry) => entry.queuedId === queuedId);
  if (!item) { state.queueEdit = null; renderQueue(); return; }
  const text = form.querySelector("textarea").value;
  // An elided record (from bootstrap or the event feed) cannot resend its
  // media bytes: read the full follow-up first, then replace its text only.
  let input = item.input;
  if (input.some((entry) => entry.elided)) {
    try {
      const listed = await action({ action: "listQueue", threadId: queue.threadId });
      rememberQueue(state, listed.queue);
      input = listed.queue.items.find((entry) => entry.queuedId === queuedId)?.input ?? input;
    } catch (error) { notify(error.message); return; }
  }
  // Fresh byte ranges over the edited text; a mention whose placeholder the
  // edit removed leaves with it.
  const { elements, items } = composeTextElements(text, chipsFromItems(input));
  const next = [...replaceQueuedText(input.filter((entry) => entry.type !== "mention" && entry.type !== "skill"), text, elements), ...items];
  if (!next.length) { notify("A queued message needs text or an attachment; delete it instead."); return; }
  state.queueEdit = null;
  await queueAction({ action: "updateQueued", threadId: queue.threadId, queuedId, input: next }, { focusSelector: `#queueTray [data-edit-queued="${CSS.escape(queuedId)}"]` });
}

// One host event window applied to the browser state. Runtime truth flows in
// three ways and none of them mints a live Turn: runtimeExit drops every
// live posture, runtimeRestarted (or a generation change while alive)
// re-reads the Thread so thread/read is the only source of liveness, and
// runtimeHalted raises the persistent stop.
async function applyEventWindow(data) {
  const previousRequestIds = new Set(state.pendingRequests.map((request) => String(request.id)));
  const focusedRequestId = document.activeElement?.closest?.("[data-request-id]")?.dataset.requestId;
  const previousGeneration = state.runtimeGeneration;
  state.eventCursor = data.cursor;
  state.pendingRequests = data.pendingRequests;
  state.knownRequestIds = new Set(data.pendingRequests.map((request) => String(request.id)));
  pruneRequestDrafts(state.requestDrafts, state.knownRequestIds);
  let haltRaised = false;
  let refreshRequests = false;
  let refreshLists = false;
  let reconcile = data.gap || (data.runtimeGeneration !== previousGeneration && data.runtimeAlive);
  let rendered = false;
  let queueDirty = false;
  let settingsDirty = false;
  let contextDirty = false;
  let sidebarDirty = false;
  for (const entry of data.events) {
    if (entry.kind === "serverRequest" || entry.kind === "requestResolved") refreshRequests = true;
    if (entry.kind === "runtimeExit") {
      markRuntimeExited(entry.value);
      reconcile = false;
      continue;
    }
    if (entry.kind === "runtimeRestarted") {
      refreshLists = true;
      reconcile = true;
      continue;
    }
    if (entry.kind === "runtimeHalted") {
      haltRaised = applyRuntimeHalt(entry.value) || haltRaised;
      reconcile = false;
      continue;
    }
    if (entry.kind === "queueChanged" || entry.kind === "queuedStarted" || entry.kind === "queuedFailed") {
      const applied = applyHostEvent(state, entry.kind, entry.value);
      if (applied?.threadId === state.activeThreadId) {
        queueDirty = true;
        if (entry.kind === "queuedStarted") {
          // The follow-up became its own Turn with a runtime-minted id: the
          // Thread is re-read so the new Turn's user message enters the
          // transcript, and the Turn is attributed the settings it carried.
          attributeTurnSettings(applied.turnId, applied.threadId, applied.item?.settings ?? null);
          reconcile = true;
          $("#streamStatus").textContent = "A queued follow-up started as its own Turn.";
        }
        if (entry.kind === "queuedFailed") notify(`Queued follow-up could not start: ${applied.error ?? "the runtime refused it"}`);
      }
      continue;
    }
    if (entry.kind !== "notification") continue;
    const method = entry.value.method;
    const params = entry.value.params ?? {};
    if (method === "serverRequest/resolved") refreshRequests = true;
    // Per-Thread records the runtime reports for any Thread, listed or not:
    // the settings after a Turn carried overrides, and the token usage.
    if (method === "thread/name/updated") {
      if (typeof params.threadId === "string") applyThreadName(params.threadId, params.threadName ?? null);
      continue;
    }
    // A Turn starting in a Thread the last bootstrap listed marks that row
    // live at once and re-reads the lists. A Turn starting in a Thread the
    // host does not list yet (a brand-new Chat: the real app-server lists it
    // only once its first userMessage is durable) keeps the record this
    // browser holds as a provisional row with the live dot and starts the
    // watch; the refresh waits for the durable cue below, with a bounded
    // retry meanwhile.
    if (method === "turn/started" && typeof params.threadId === "string") {
      const held = state.threads.find((thread) => thread.id === params.threadId);
      if (state.listedThreadIds.has(params.threadId)) {
        if (held && !threadIsActive(held)) { held.status = { type: "active" }; refreshLists = true; }
      } else {
        const record = held ?? (state.activeThread?.id === params.threadId ? (({ turns, ...rest }) => rest)(state.activeThread) : null);
        if (record) record.status = { type: "active" };
        holdUnlistedThread(params.threadId, record);
        sidebarDirty = true;
      }
    }
    // thread/status/changed is the runtime's own status for the Thread, so
    // every local row follows it (the dot settles on idle without a
    // refresh); its active variant lands with turn/started, before the
    // durable write, so it is no refresh cue.
    if (method === "thread/status/changed" && typeof params.threadId === "string") {
      if (applyThreadStatus(allThreadRecords(), params.threadId, params.status)) sidebarDirty = true;
      continue;
    }
    // The durable cue: the watched Thread's userMessage item/completed.
    if (method === "item/completed" && state.listingWatch.cue(method, params)) refreshLists = true;
    if (method === "turn/completed" && typeof params.threadId === "string") {
      if (!state.threads.some((thread) => thread.id === params.threadId) || state.listingWatch.cue(method, params)) refreshLists = true;
      handleTurnCompletion(params);
    }
    if (method === "thread/settings/updated" || method === "thread/tokenUsage/updated") {
      applyChatEvent(state, method, params);
      if (method === "thread/settings/updated" && threadSettings(state, params.threadId)) rememberSettingsRecord(params.threadId, threadSettings(state, params.threadId));
      if (params.threadId === state.activeThreadId) {
        if (method === "thread/settings/updated") settingsDirty = true;
        else contextDirty = true;
      }
      continue;
    }
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
  if (data.runtimeHalt) haltRaised = applyRuntimeHalt(data.runtimeHalt) || haltRaised;
  setRuntimePosture({ alive: data.runtimeAlive, generation: data.runtimeGeneration, state: state.bootstrap?.stop ? "halted" : data.runtimeState ?? (data.runtimeAlive ? "alive" : "exited") });
  if (queueDirty) renderQueue();
  if (settingsDirty) { renderComposerSettings(); renderPosture(); }
  if (contextDirty) renderContextIndicator();
  if (refreshLists) await refreshThreads();
  else if (sidebarDirty) updateSidebar();
  if (reconcile && state.activeThreadId && state.runtimeAlive && !state.bootstrap?.stop) await openThread(state.activeThreadId, { route: state.route === "task" ? "task" : "chat" });
  else if ((rendered || refreshRequests || haltRaised) && state.activeThreadId) scheduleChatRender();
  focusNewBlockingRequest(previousRequestIds);
  if (focusedRequestId && !state.knownRequestIds.has(focusedRequestId)) requestAnimationFrame(() => $("#composerInput")?.focus({ preventScroll: true }));
}

async function pollEvents() {
  try {
    const data = await api(`/api/events?after=${state.eventCursor}`);
    await applyEventWindow(data);
    state.attentionPollCounter += 1;
    if (state.attentionPollCounter >= 12) {
      state.attentionPollCounter = 0;
      await refreshThreads();
    }
  } catch (error) {
    // The loopback host itself did not answer. That is all the browser knows:
    // it never claims the runtime is reconnecting on its own behalf.
    setRuntimePosture({ alive: false, state: "unreachable" });
  } finally {
    pollTimer = setTimeout(pollEvents, 850);
  }
}


// ---------------------------------------------------------------------------
// The explicit Chat bridge: Create Task, Attach to Task (with Quote into
// Task) and Remember. Each surface acts on one exact source identity (the
// finalized assistant message or a located selection inside it), shows the
// host's own preview, and confirms into one host action that writes one
// document uncommitted. The source Chat is never rewritten; no browser storage
// is involved, and the only persistence is the checked-in YAML the host wrote.
// ---------------------------------------------------------------------------

const BRIDGE_QUOTE_LIMIT = 12_000;

// The exact source the bridge acts on: the mounted item's own text, and when
// a passage is selected, its span inside that text plus the hash of exactly
// that slice. A passage that cannot be placed exactly falls back to the whole
// message as the origin while the quoted text still carries what was chosen.
async function bridgeSource({ itemKey: sourceKey, selectionText = null }) {
  const item = timelineItem(sourceKey);
  if (!item || item.type !== "agentMessage") throw new Error("This message is no longer mounted; Thread history remains authoritative.");
  if (!messageFinalized(item)) throw new Error("Only a finalized assistant message can become a Task or Context.");
  const sourceText = String(item.text ?? "");
  let selection = null;
  let located = null;
  let selectionNote = "";
  if (selectionText) {
    located = locateSelection(sourceText, selectionText);
    if (located) {
      selection = { start: located.start, end: located.end, text_sha256: await sha256Hex(sourceText.slice(located.start, located.end)) };
    } else {
      selectionNote = "The selected passage could not be placed exactly in the message text; the origin names the whole message and the quote keeps your selection.";
    }
  }
  const fullQuote = located ? sourceText.slice(located.start, located.end) : (selectionText ?? sourceText);
  const quoteText = fullQuote.slice(0, BRIDGE_QUOTE_LIMIT);
  const threadId = item._threadId ?? state.activeThreadId;
  const identity = { threadId, turnId: item._turnId, itemId: item.id };
  const forkedFromId = state.activeThread?.id === threadId ? state.activeThread.forkedFromId ?? null : null;
  return {
    key: sourceKey,
    identity,
    origin: buildOrigin({ threadId, forkedFromId, turnId: item._turnId, itemId: item.id, selection }),
    quote: { text: quoteText, itemKey: sourceKey, ...identity },
    selection,
    selectionNote,
    truncated: quoteText.length < fullQuote.length,
  };
}

function bridgeSourceLine(source) {
  return `${sourceIdentityLabel(source.identity)} · ${describeSelection(source.selection)}${source.truncated ? ` · quote cut to ${BRIDGE_QUOTE_LIMIT.toLocaleString()} characters` : ""}${source.selectionNote ? ` · ${source.selectionNote}` : ""}`;
}

function firstLine(text, limit) {
  const line = String(text ?? "").split("\n").map((entry) => entry.replace(/^[\s>#*\-]+/, "").replace(/[*_`~]+/g, "").trim()).find(Boolean) ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

function bridgeTriggerSelector(trigger, source) {
  const itemSelector = `[data-item-id="${CSS.escape(source.key)}"]`;
  if (trigger?.dataset?.createTask) return `[data-create-task="${CSS.escape(source.key)}"]`;
  if (trigger?.dataset?.attachTask) return `[data-attach-task="${CSS.escape(source.key)}"]`;
  if (trigger?.dataset?.remember) return `[data-remember="${CSS.escape(source.key)}"]`;
  return itemSelector;
}

function openBridgeDialogElement(id, { trigger, source }) {
  closeSearch(false);
  closeInbox(false);
  closeImport(false);
  for (const other of BRIDGE_DIALOG_IDS) if (other !== id) closeBridgeDialog(other, { restore: false });
  state.overlayReturnFocus = trigger ?? document.activeElement;
  state.overlayReturnSelector = source ? bridgeTriggerSelector(trigger, source) : null;
  $("#selectionSheet").hidden = true;
  const dialog = $(`#${id}`);
  dialog.hidden = false;
  dialog.inert = false;
  syncScrim();
  return dialog;
}

function closeBridgeDialog(id, { restore = true } = {}) {
  const dialog = $(`#${id}`);
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  dialog.inert = true;
  if (state.bridge?.dialogId === id) {
    clearTimeout(state.bridge.previewTimer);
    state.bridge = null;
  }
  syncScrim();
  if (!restore) return;
  const returnTo = state.overlayReturnFocus?.isConnected && !state.overlayReturnFocus.hidden && state.overlayReturnFocus.getClientRects().length
    ? state.overlayReturnFocus
    : state.overlayReturnSelector ? document.querySelector(state.overlayReturnSelector) : null;
  returnTo?.focus?.({ preventScroll: true });
}

function closeOpenBridgeDialog({ restore = true } = {}) {
  const dialog = openBridgeDialog();
  if (dialog) closeBridgeDialog(dialog.id, { restore });
}

function bridgeStatus(id, message, { error = false } = {}) {
  const node = $(`#${id}`);
  node.textContent = message;
  node.dataset.error = error ? "true" : "false";
}

async function refuseUnlessAvailable() {
  const bridge = bridgeAvailability();
  if (bridge.available) return true;
  notify(bridge.reason);
  return false;
}

// Re-read the canonical projection after a bridge write and repaint whatever
// presents associations: the source Chat marker, the Workspace, the Graph and
// the sidebar. The transcript itself is patched in place, never rewritten.
async function afterBridgeWrite() {
  await refreshThreads();
  if (state.route === "chat" && state.activeThread) renderChat({ preserveScroll: true });
  else if (state.route === "task" && state.activeTask) {
    try {
      const data = await action({ action: "readTask", ticketId: state.activeTicketId });
      state.activeTask = data.handoff;
      state.taskWorkspace = data;
    } catch {}
    renderTaskWorkspace();
  } else if (state.route === "tasks") renderTasks();
}

// --- Create Task -----------------------------------------------------------

async function openCreateTask({ itemKey: sourceKey, selectionText = null, trigger = null }) {
  if (!(await refuseUnlessAvailable())) return;
  let source;
  try { source = await bridgeSource({ itemKey: sourceKey, selectionText }); }
  catch (error) { notify(error.message); return; }
  state.bridge = { kind: "create", dialogId: "createTaskDialog", source, preview: null, sequence: 0, previewTimer: 0, busy: false };
  $("#createTaskSource").textContent = `Source: ${bridgeSourceLine(source)}`;
  $("#createTaskTitleInput").value = firstLine(source.quote.text, 80);
  $("#createTaskOutcome").value = "";
  $("#createTaskContext").value = composeQuotedMessage(source.quote, "");
  $("#createTaskId").textContent = "—";
  $("#createTaskPacket").textContent = "";
  $("#createTaskPacketSize").textContent = "";
  $("#createTaskWrite").textContent = "Writes one draft Ticket, uncommitted. Nothing is committed.";
  $("#confirmCreateTask").disabled = true;
  bridgeStatus("createTaskStatus", "Write the outcome to preview the Task.");
  openBridgeDialogElement("createTaskDialog", { trigger, source });
  scheduleCreatePreview(0);
  requestAnimationFrame(() => $("#createTaskOutcome").focus());
}

function createTaskFields() {
  return {
    title: $("#createTaskTitleInput").value.trim(),
    outcome: $("#createTaskOutcome").value.trim(),
    context: $("#createTaskContext").value.trim(),
  };
}

const CREATE_PREVIEW_DEBOUNCE_MS = 240;

function scheduleCreatePreview(delay = CREATE_PREVIEW_DEBOUNCE_MS) {
  const bridge = state.bridge;
  if (bridge?.kind !== "create") return;
  clearTimeout(bridge.previewTimer);
  bridge.previewTimer = setTimeout(() => { runCreatePreview(); }, delay);
}

// One preview per settled edit: the host derives the Task id, validates the
// full draft candidate and returns the packet a Start would send. A reply for
// an edit that is no longer current is dropped.
async function runCreatePreview() {
  const bridge = state.bridge;
  if (bridge?.kind !== "create") return null;
  clearTimeout(bridge.previewTimer);
  const sequence = ++bridge.sequence;
  const fields = createTaskFields();
  const missing = ["title", "outcome", "context"].filter((field) => !fields[field]);
  if (missing.length) {
    bridge.preview = null;
    $("#createTaskId").textContent = "—";
    $("#confirmCreateTask").disabled = true;
    bridgeStatus("createTaskStatus", `Write the ${missing.join(", ")} to preview the Task.`);
    return null;
  }
  bridgeStatus("createTaskStatus", "Previewing through the host…");
  try {
    const preview = await action({ action: "previewCreateTask", ...fields, origin: bridge.source.origin });
    if (sequence !== bridge.sequence || state.bridge !== bridge) return null;
    bridge.preview = preview;
    $("#createTaskId").textContent = preview.ticketId;
    $("#createTaskPacket").textContent = preview.packetText;
    $("#createTaskPacketSize").textContent = `${preview.packetText.length.toLocaleString()} chars`;
    $("#createTaskWrite").textContent = `Writes ${preview.path}, uncommitted. Nothing is committed.`;
    $("#confirmCreateTask").disabled = bridge.busy;
    bridgeStatus("createTaskStatus", `Ready: ${preview.ticketId} will be a draft Task (${preview.nextAction.action}) with one placeholder acceptance criterion.`);
    return preview;
  } catch (error) {
    if (sequence !== bridge.sequence || state.bridge !== bridge) return null;
    bridge.preview = null;
    $("#createTaskId").textContent = "—";
    $("#confirmCreateTask").disabled = true;
    const details = Array.isArray(error.details?.errors) ? ` ${error.details.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; ")}` : "";
    bridgeStatus("createTaskStatus", `${error.message}${details}`, { error: true });
    return null;
  }
}

async function confirmCreateTask() {
  const bridge = state.bridge;
  if (bridge?.kind !== "create" || bridge.busy) return;
  bridge.busy = true;
  $("#confirmCreateTask").disabled = true;
  try {
    // The id the human confirms is the one the host derived for these exact
    // fields; a stale id is refused by the host, never silently renamed.
    const preview = await runCreatePreview();
    if (!preview || state.bridge !== bridge) return;
    const created = await action({ action: "createTask", ...createTaskFields(), origin: bridge.source.origin, ticketId: preview.ticketId });
    closeBridgeDialog("createTaskDialog", { restore: true });
    await afterBridgeWrite();
    notify(`Task ${created.ticketId} created as a draft at ${created.path}, uncommitted. It appears in the Graph and Task list as REFINE; this Chat is unchanged.`);
  } catch (error) {
    if (state.bridge !== bridge) return;
    if (error.code === "ticket_exists") {
      bridgeStatus("createTaskStatus", `${error.message} The derived id is now ${error.details?.derivedTicketId ?? "being re-derived"}; confirm again to create it.`, { error: true });
      bridge.busy = false;
      await runCreatePreview();
      return;
    }
    bridgeStatus("createTaskStatus", error.message, { error: true });
  } finally {
    if (state.bridge === bridge) {
      bridge.busy = false;
      $("#confirmCreateTask").disabled = !bridge.preview;
    }
  }
}

// --- Attach to Task / Quote into Task ----------------------------------------

function attachRowMarkup(task) {
  const selected = state.bridge?.selectedTicketId === task.ticketId;
  const associations = task.associations?.length ?? 0;
  const provenance = [task.hasOrigin ? "born from a Chat" : "", associations ? `${associations} Chat association${associations === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
  return `<button class="attach-row" type="button" data-attach-target="${escapeHtml(task.ticketId)}" data-task-status="${escapeHtml(task.status)}" aria-pressed="${selected ? "true" : "false"}"><span><strong>${escapeHtml(humanize(task.ticketId))}</strong><small>${escapeHtml(takeText(createRenderBudget({ textCharacters: 400 }), task.outcome, 140).text)}</small>${provenance ? `<small class="attach-provenance">${escapeHtml(provenance)}</small>` : ""}</span><em>${escapeHtml(task.status)} · ${escapeHtml(task.nextAction?.action ?? "")}<br>${escapeHtml(task.maturity)}${task.nextAction?.reason ? ` · ${escapeHtml(task.nextAction.reason)}` : ""}</em></button>`;
}

function renderAttachRows() {
  const bridge = state.bridge;
  if (bridge?.kind !== "attach") return;
  const list = $("#attachTaskList");
  if (!bridge.targets) { list.innerHTML = '<p class="muted">Reading Tasks…</p>'; }
  else if (!bridge.targets.length) { list.innerHTML = '<p class="muted">No open Task in this Project. Create one from this message instead; closed Tasks never take new associations.</p>'; }
  else list.innerHTML = bridge.targets.map(attachRowMarkup).join("");
  const selected = bridge.targets?.find((task) => task.ticketId === bridge.selectedTicketId) ?? null;
  $("#confirmAttachTask").disabled = !selected || bridge.busy;
  $("#quoteIntoTask").disabled = !selected || bridge.busy;
  const linked = selected ? state.threads.find((thread) => thread.taskLink?.ticketId === selected.ticketId) : null;
  $("#attachTaskSelection").textContent = selected
    ? `Attach appends ${codexThreadRef(bridge.source.identity).replace(/\/item:.*$/u, "")} to .vibehub/tickets/${selected.ticketId}.yaml, uncommitted. Quote into Task ${linked ? "adds the passage to its Codex conversation draft" : "keeps the passage for its first Turn"}; nothing is written.`
    : bridge.targets?.length ? "Select a Task." : "";
}

async function openAttachTask({ itemKey: sourceKey, selectionText = null, trigger = null }) {
  if (!(await refuseUnlessAvailable())) return;
  let source;
  try { source = await bridgeSource({ itemKey: sourceKey, selectionText }); }
  catch (error) { notify(error.message); return; }
  state.bridge = { kind: "attach", dialogId: "attachTaskDialog", source, targets: null, selectedTicketId: null, busy: false };
  $("#attachTaskSource").textContent = `Source: ${bridgeSourceLine(source)}`;
  bridgeStatus("attachTaskStatus", "");
  renderAttachRows();
  const dialog = openBridgeDialogElement("attachTaskDialog", { trigger, source });
  $("#closeAttachTask").focus();
  await loadAttachTargets();
  if (dialog.hidden) return;
  const firstRow = dialog.querySelector(".attach-row");
  if (firstRow && document.activeElement === $("#closeAttachTask")) firstRow.focus();
}

async function loadAttachTargets() {
  const bridge = state.bridge;
  if (bridge?.kind !== "attach") return;
  try {
    const data = await action({ action: "listTaskTargets" });
    if (state.bridge !== bridge) return;
    bridge.targets = data.tasks;
  } catch (error) {
    if (state.bridge !== bridge) return;
    bridge.targets = [];
    bridgeStatus("attachTaskStatus", error.message, { error: true });
  }
  renderAttachRows();
}

async function confirmAttachTask() {
  const bridge = state.bridge;
  if (bridge?.kind !== "attach" || bridge.busy || !bridge.selectedTicketId) return;
  bridge.busy = true;
  renderAttachRows();
  const ticketId = bridge.selectedTicketId;
  try {
    const attached = await action({ action: "attachTask", ticketId, threadId: bridge.source.identity.threadId, turnId: bridge.source.identity.turnId });
    closeBridgeDialog("attachTaskDialog", { restore: true });
    await afterBridgeWrite();
    notify(attached.added
      ? `Attached this Turn to Task ${attached.ticketId}: ${attached.path} now carries ${attached.provenanceRef}, uncommitted. This Chat is unchanged.`
      : `Task ${attached.ticketId} already carries ${attached.provenanceRef}; nothing was written.`);
  } catch (error) {
    if (state.bridge !== bridge) return;
    bridge.busy = false;
    bridgeStatus("attachTaskStatus", error.message, { error: true });
    if (error.code === "task_closed" || error.code === "task_not_found") await loadAttachTargets();
    else renderAttachRows();
  }
}

// Quote into Task: the passage becomes the Task's own conversation draft. A
// Task with a linked Thread takes it into that Thread's Composer draft; a Task
// without one keeps it keyed by Task id. Either way it reaches the Agent only
// as the host-built packet's conversation.humanMessage, and nothing is written.
async function quoteIntoTask() {
  const bridge = state.bridge;
  if (bridge?.kind !== "attach" || bridge.busy || !bridge.selectedTicketId) return;
  const ticketId = bridge.selectedTicketId;
  const quote = structuredClone(bridge.source.quote);
  const linked = state.threads.find((thread) => thread.taskLink?.ticketId === ticketId) ?? null;
  closeBridgeDialog("attachTaskDialog", { restore: false });
  if (linked && linked.id === state.activeThreadId) {
    state.composerQuote = quote;
    renderComposerQuote();
  } else if (linked) {
    saveThreadDraft(state.composerDrafts, linked.id, { ...loadThreadDraft(state.composerDrafts, linked.id), quote });
  } else {
    state.taskQuoteDrafts.set(ticketId, quote);
  }
  await openTask(ticketId);
  notify(`Quoted into Task ${ticketId}. It is sent only as that Task's next message inside the host-built packet; nothing was written and this Chat is unchanged.`);
}

// --- Remember ---------------------------------------------------------------

function renderRememberRooms() {
  const bridge = state.bridge;
  if (bridge?.kind !== "remember") return;
  const select = $("#rememberRoom");
  const current = select.value;
  if (!bridge.rooms) { select.innerHTML = '<option value="">Reading Rooms…</option>'; }
  else if (!bridge.rooms.length) { select.innerHTML = '<option value="">No Room is checked in</option>'; }
  else select.innerHTML = bridge.rooms.map((room) => `<option value="${escapeHtml(room.room)}"${room.room === current ? " selected" : ""}>${escapeHtml(room.room)} · ${escapeHtml(room.description)} (${room.contextCount})</option>`).join("");
  const ready = Boolean(bridge.rooms?.length);
  $("#confirmRemember").disabled = !ready || bridge.busy;
  if (bridge.rooms && !bridge.rooms.length) bridgeStatus("rememberStatus", "No Room tree is checked in under .vibehub/rooms. Remember never creates a Room; run the distill Skill first.", { error: true });
}

async function loadRememberRooms() {
  const bridge = state.bridge;
  if (bridge?.kind !== "remember") return;
  try {
    const data = await action({ action: "listRooms" });
    if (state.bridge !== bridge) return;
    bridge.rooms = data.rooms;
  } catch (error) {
    if (state.bridge !== bridge) return;
    bridge.rooms = [];
    bridgeStatus("rememberStatus", error.message, { error: true });
  }
  renderRememberRooms();
}

async function openRemember({ itemKey: sourceKey, selectionText = null, trigger = null }) {
  if (!(await refuseUnlessAvailable())) return;
  let source;
  try { source = await bridgeSource({ itemKey: sourceKey, selectionText }); }
  catch (error) { notify(error.message); return; }
  state.bridge = { kind: "remember", dialogId: "rememberDialog", source, rooms: null, busy: false };
  $("#rememberSource").textContent = `Source ref: ${codexThreadRef(source.identity)} · ${describeSelection(source.selection)}`;
  $("#rememberQuote").textContent = source.quote.text;
  $("#rememberSummary").value = firstLine(source.quote.text, 120);
  $("#rememberDetail").value = source.quote.text;
  $("#rememberTags").value = "";
  $("#rememberEvidence").value = "";
  $("#rememberType").value = "note";
  bridgeStatus("rememberStatus", "");
  renderRememberRooms();
  openBridgeDialogElement("rememberDialog", { trigger, source });
  requestAnimationFrame(() => $("#rememberRoom").focus());
  await loadRememberRooms();
}

function rememberFields() {
  const tags = [...new Set($("#rememberTags").value.split(",").map((tag) => tag.trim()).filter(Boolean))];
  const evidenceNote = $("#rememberEvidence").value.trim();
  return {
    room: $("#rememberRoom").value,
    type: $("#rememberType").value,
    summary: $("#rememberSummary").value.trim(),
    detail: $("#rememberDetail").value.trim(),
    ...(tags.length ? { tags } : {}),
    ...(evidenceNote ? { evidenceNote } : {}),
  };
}

async function confirmRemember() {
  const bridge = state.bridge;
  if (bridge?.kind !== "remember" || bridge.busy) return;
  const fields = rememberFields();
  if (!fields.room) { bridgeStatus("rememberStatus", "Choose an existing Room.", { error: true }); return; }
  if (!fields.summary || !fields.detail) { bridgeStatus("rememberStatus", "Summary and detail are required.", { error: true }); return; }
  bridge.busy = true;
  $("#confirmRemember").disabled = true;
  try {
    const remembered = await action({
      action: "remember",
      ...fields,
      source: { threadId: bridge.source.identity.threadId, turnId: bridge.source.identity.turnId, itemId: bridge.source.identity.itemId, quote: bridge.source.quote.text },
    });
    closeBridgeDialog("rememberDialog", { restore: true });
    await afterBridgeWrite();
    notify(`Remembered into Room ${remembered.room}: ${remembered.path}, uncommitted. Git review activates it; source ${remembered.sourceRef}.`);
  } catch (error) {
    if (state.bridge !== bridge) return;
    bridge.busy = false;
    if (error.code === "room_missing") {
      bridgeStatus("rememberStatus", `${error.message} Rooms now: ${(error.details?.rooms ?? []).join(", ") || "none"}.`, { error: true });
      await loadRememberRooms();
      return;
    }
    bridgeStatus("rememberStatus", error.message, { error: true });
    $("#confirmRemember").disabled = false;
  }
}

// --- Return to source -----------------------------------------------------

// Scroll to and focus the exact origin item (or the Turn's marker when the
// origin names no item) once the source Chat is mounted.
function focusSourceItem({ threadId, turnId, itemId }) {
  const selector = itemId
    ? `[data-item-id="${CSS.escape(itemKey(threadId, turnId, itemId))}"]`
    : `[data-turn-id="${CSS.escape(turnId)}"]`;
  rerenderFocusSelector = selector;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const node = surface.querySelector(selector);
    if (!node) {
      notify("The origin Turn is not mounted in this view; Thread history remains authoritative.");
      return;
    }
    node.scrollIntoView({ block: "center", behavior: "instant" });
    node.dataset.sourceFocus = "true";
    node.addEventListener("blur", () => { delete node.dataset.sourceFocus; }, { once: true });
    node.focus({ preventScroll: true });
    $("#streamStatus").textContent = "Returned to the source Turn of this Task.";
  }));
}

async function returnToSource({ sourceThread, sourceTurn, sourceItem }) {
  try {
    await openThread(sourceThread, { route: "chat" });
  } catch (error) {
    notify(`Could not open the source Chat ${sourceThread.slice(0, 8)}…: ${error.message}`);
    return;
  }
  focusSourceItem({ threadId: sourceThread, turnId: sourceTurn, itemId: sourceItem || null });
}

document.addEventListener("click", async (event) => {
  const searchResult = event.target.closest("[data-search-kind]");
  if (searchResult) { await openSearchResult(searchResult.dataset.searchKind, searchResult.dataset.searchId); return; }
  if (event.target.closest("[data-open-inbox]")) { openInbox(); return; }
  const route = event.target.closest("[data-route]");
  if (route) {
    const returningTicketId = route.id === "backButton" ? state.activeTicketId : null;
    if (route.dataset.route === "rooms") state.activeContextId = null;
    setRoute(route.dataset.route);
    if (returningTicketId) requestAnimationFrame(() => document.querySelector(`[data-ticket-id="${CSS.escape(returningTicketId)}"]`)?.focus());
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
  // Fork lineage navigation (review fixture only): the source chip and the
  // fork-list rows open the named Thread through the ordinary open path.
  const openLineage = event.target.closest("[data-open-lineage]");
  if (openLineage) {
    if (!state.forkReview) return;
    try { await openThread(openLineage.dataset.openLineage); } catch (error) { notify(error.message); }
    return;
  }
  // Bring Back (review fixture only): the selected fork passage lands in the
  // source Chat's composer as a quote carrying the fork's exact identity;
  // the explicit send stays with the human and the fixture refuses it.
  const bringBackButton = event.target.closest("[data-bring-back]");
  if (bringBackButton) {
    if (!state.forkReview || !state.selectedQuote) return;
    const fork = state.activeThread;
    const item = timelineItem(state.selectedQuote.itemKey);
    const payload = bringBackQuote({ fork, turnId: item?._turnId, itemId: item?.id, itemKey: item?._key ?? null, text: state.selectedQuote.text });
    if (!payload) return notify("Bring back needs a finalized passage in a fork whose source is listed.");
    $("#selectionSheet").hidden = true;
    window.getSelection()?.removeAllRanges?.();
    try {
      await openThread(payload.targetThreadId);
      state.composerQuote = payload.quote;
      renderComposerQuote();
      $("#composerInput").focus();
      notify("Fork result quoted into the source chat. Nothing is sent until you send it.");
    } catch (error) { notify(error.message); }
    return;
  }
  const compactThread = event.target.closest("[data-compact-thread]");
  if (compactThread) { await compactActiveThread(compactThread); return; }
  const renameThread = event.target.closest("[data-rename-thread]");
  if (renameThread) { if (!renameThread.disabled) beginRename(renameThread.dataset.renameThread, renameThread.dataset.renameWhere ?? "header"); return; }
  if (event.target.closest("[data-cancel-rename]")) { endRename(); return; }
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
  const returnButton = event.target.closest("[data-return-to-source]");
  if (returnButton) { await returnToSource(returnButton.dataset); return; }
  const createTask = event.target.closest("[data-create-task]");
  if (createTask) { if (!createTask.disabled) await openCreateTask({ itemKey: createTask.dataset.createTask, trigger: createTask }); return; }
  const attachTask = event.target.closest("[data-attach-task]");
  if (attachTask) { if (!attachTask.disabled) await openAttachTask({ itemKey: attachTask.dataset.attachTask, trigger: attachTask }); return; }
  const rememberButton = event.target.closest("[data-remember]");
  if (rememberButton) { if (!rememberButton.disabled) await openRemember({ itemKey: rememberButton.dataset.remember, trigger: rememberButton }); return; }
  const selectionBridge = event.target.closest("[data-selection-bridge]");
  if (selectionBridge) {
    if (selectionBridge.disabled || !state.selectedQuote) return;
    const request = { itemKey: state.selectedQuote.itemKey, selectionText: state.selectedQuote.text, trigger: selectionBridge };
    if (selectionBridge.dataset.selectionBridge === "create-task") await openCreateTask(request);
    else if (selectionBridge.dataset.selectionBridge === "attach-task") await openAttachTask(request);
    else await openRemember(request);
    return;
  }
  const attachRow = event.target.closest("[data-attach-target]");
  if (attachRow) {
    if (state.bridge?.kind !== "attach") return;
    state.bridge.selectedTicketId = state.bridge.selectedTicketId === attachRow.dataset.attachTarget ? null : attachRow.dataset.attachTarget;
    renderAttachRows();
    $(`[data-attach-target="${CSS.escape(attachRow.dataset.attachTarget)}"]`)?.focus();
    return;
  }
  const editQueued = event.target.closest("[data-edit-queued]");
  if (editQueued) { beginQueueEdit(editQueued.dataset.editQueued); return; }
  if (event.target.closest("[data-cancel-queued]")) { cancelQueueEdit(); return; }
  const deleteQueued = event.target.closest("[data-delete-queued]");
  if (deleteQueued) {
    const queue = activeQueue();
    if (!queue) return;
    const index = queue.items.findIndex((item) => item.queuedId === deleteQueued.dataset.deleteQueued);
    const next = queue.items[index + 1] ?? queue.items[index - 1] ?? null;
    await queueAction({ action: "deleteQueued", threadId: queue.threadId, queuedId: deleteQueued.dataset.deleteQueued }, { focusSelector: next ? `#queueTray [data-delete-queued="${CSS.escape(next.queuedId)}"]` : "#composerInput" });
    return;
  }
  const steerQueued = event.target.closest("[data-steer-queued]");
  if (steerQueued) {
    const queue = activeQueue();
    if (!queue || !state.running || !state.currentTurnId) return notify("Steer needs a running Turn.");
    // The queued follow-up leaves the queue and steers the exact live Turn.
    const steered = await queueAction({ action: "steerQueued", threadId: queue.threadId, queuedId: steerQueued.dataset.steerQueued, expectedTurnId: state.currentTurnId }, { focusSelector: "#composerInput" });
    if (steered) { notify("Queued message steered the running Turn."); await openThread(queue.threadId); }
    return;
  }
  const resumeQueue = event.target.closest("[data-resume-queue]");
  if (resumeQueue) {
    const threadId = resumeQueue.dataset.resumeQueue;
    const head = threadQueue(state, threadId)?.items[0] ?? null;
    const resumed = await queueAction({ action: "resumeQueue", threadId }, { focusSelector: "#composerInput" });
    if (resumed?.started) {
      attributeTurnSettings(resumed.started.turnId, threadId, head?.queuedId === resumed.started.queuedId ? head.settings : null);
      state.currentTurnId = resumed.started.turnId;
      state.running = true;
      $("#stopTurn").hidden = false;
      syncComposerMode();
      await openThread(resumeQueue.dataset.resumeQueue);
    }
    return;
  }
  const remove = event.target.closest("[data-remove-attachment]");
  if (remove) { state.attachments.splice(Number(remove.dataset.removeAttachment), 1); renderAttachments(); return; }
  const removeMentionButton = event.target.closest("[data-remove-mention]");
  if (removeMentionButton) { removeMention(Number(removeMentionButton.dataset.removeMention)); return; }
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
        // A pending Quote into Task reaches the Agent only here, as the
        // host-built packet's conversation.humanMessage.
        const ticketId = state.activeTicketId;
        const humanMessage = composeQuotedMessage(state.composerQuote, $("#composerInput").value) || null;
        const started = await action({ action: "startTask", ticketId, selectedContextIds: [...state.taskSelectedContextIds], ...(humanMessage ? { humanMessage } : {}) });
        state.taskQuoteDrafts.delete(ticketId);
        state.composerQuote = null;
        $("#composerInput").value = "";
        renderComposerQuote();
        autoSizeComposer();
        // The host answered with the Task Thread's own linked record; the
        // runtime lists it only once the packet is durable, so the record
        // is held until a bootstrap lists it (sidebar-freshness.mjs).
        if (started.thread) holdUnlistedThread(started.threadId, started.thread);
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
  // The Graph draws provenance for the focused Task; focus moves it.
  if (state.route === "tasks" && event.target.closest?.(".task-card") && $("#graphSources")) {
    renderGraphSources();
    renderGraphEdges();
  }
});

document.addEventListener("toggle", (event) => {
  if (event.target instanceof HTMLDetailsElement && event.target.matches("[data-packet-raw]")) fillPacketRaw(event.target);
}, true);

document.addEventListener("submit", async (event) => {
  const queueEdit = event.target.closest("[data-queue-edit]");
  if (queueEdit) { event.preventDefault(); await saveQueueEdit(queueEdit); return; }
  const renameForm = event.target.closest("[data-rename-form]");
  if (renameForm) { event.preventDefault(); await submitRename(renameForm); return; }
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
  if (event.target.id === "modelPicker") { chooseModel(event.target.value); return; }
  if (event.target.id === "effortPicker") { chooseEffort(event.target.value); return; }
  if (event.target.id === "permissionsControl") { choosePosture(event.target.value, event.target); return; }
  if (event.target.id === "notificationMode") { await chooseNotificationMode(event.target.value, event.target); return; }
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
for (const [id, dialogId] of [["closeCreateTask", "createTaskDialog"], ["cancelCreateTask", "createTaskDialog"], ["closeAttachTask", "attachTaskDialog"], ["cancelAttachTask", "attachTaskDialog"], ["closeRemember", "rememberDialog"], ["cancelRemember", "rememberDialog"]]) {
  $(`#${id}`).addEventListener("click", () => closeBridgeDialog(dialogId));
}
$("#createTaskForm").addEventListener("submit", (event) => { event.preventDefault(); confirmCreateTask(); });
$("#createTaskForm").addEventListener("input", () => scheduleCreatePreview());
$("#confirmAttachTask").addEventListener("click", confirmAttachTask);
$("#quoteIntoTask").addEventListener("click", quoteIntoTask);
$("#rememberForm").addEventListener("submit", (event) => { event.preventDefault(); confirmRemember(); });
$("#refreshThreads").addEventListener("click", async () => { await refreshThreads(); updateSidebar(); notify("Codex Chat history refreshed."); });
$("#closeFullAccess").addEventListener("click", () => closeFullAccessDialog());
$("#cancelFullAccess").addEventListener("click", () => closeFullAccessDialog());
$("#confirmFullAccess").addEventListener("click", () => closeFullAccessDialog({ confirmed: true }));
$("#searchButton").addEventListener("click", openSearch);
$("#searchInput").addEventListener("input", () => { state.searchIndex = 0; runSearch(); });
$("#inboxButton").addEventListener("click", openInbox);
$("#closeInbox").addEventListener("click", () => closeInbox());
$("#collapseSidebar").addEventListener("click", () => {
  if (isNarrowLayout()) closeMobileSidebar();
  else appShell.classList.toggle("sidebar-collapsed");
});
$("#openSidebar").addEventListener("click", openMobileSidebar);
$("#attachButton").addEventListener("click", () => $("#attachmentInput").click());
$("#attachmentInput").addEventListener("change", async (event) => {
  const files = [...(event.target.files ?? [])];
  event.target.value = "";
  await addAttachmentFiles(files);
});
// Images pasted from the clipboard attach beside the typed text; a paste
// without an image file is the ordinary text paste.
$("#composerInput").addEventListener("paste", async (event) => {
  const images = imageFilesFrom(event.clipboardData);
  if (!images.length) return;
  event.preventDefault();
  await addAttachmentFiles(images);
});
// Image files dropped anywhere on the Composer attach the same way; the
// drop target is marked while a file drag hovers it.
const composerForm = $("#composer");
composerForm.addEventListener("dragover", (event) => {
  if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  composerForm.classList.add("drop-target");
});
composerForm.addEventListener("dragleave", (event) => {
  if (!composerForm.contains(event.relatedTarget)) composerForm.classList.remove("drop-target");
});
composerForm.addEventListener("drop", async (event) => {
  composerForm.classList.remove("drop-target");
  if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
  event.preventDefault();
  const images = imageFilesFrom(event.dataTransfer);
  if (!images.length) { notify("Only image files can be dropped here; use + for audio."); return; }
  await addAttachmentFiles(images);
  $("#composerInput").focus();
});
$("#voiceButton").addEventListener("click", toggleRecording);
$("#composer").addEventListener("submit", submitTurn);
$("#composerInput").addEventListener("keydown", (event) => {
  // The open mention picker takes the navigation keys: ↑↓ move, ↵ or Tab
  // insert the highlighted entry, Escape closes it and keeps focus here.
  if (mentionPicker.open) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); moveMentionSelection(event.key === "ArrowDown" ? 1 : -1); return; }
    if ((event.key === "Enter" && !event.shiftKey && !event.isComposing) || event.key === "Tab") {
      if (mentionPicker.items.length) { event.preventDefault(); chooseMention(); return; }
      if (event.key === "Tab") return;
    }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMentionPicker(); return; }
  }
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    // Alt+Enter is the opposite of the Send label for this one message.
    composerSubmitMode = event.altKey ? "opposite" : "default";
    $("#composer").requestSubmit();
  }
});
$("#composerInput").addEventListener("keyup", (event) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) syncMentionPicker();
});
$("#composerInput").addEventListener("click", syncMentionPicker);
$("#composerInput").addEventListener("blur", () => {
  // An option click moves focus for an instant; the picker closes only when
  // focus really left the Composer.
  requestAnimationFrame(() => { if (!$("#composer").contains(document.activeElement)) closeMentionPicker(); });
});
$("#mentionPicker").addEventListener("pointerdown", (event) => event.preventDefault());
$("#mentionPicker").addEventListener("click", (event) => {
  const option = event.target.closest("[data-mention-option]");
  if (option) chooseMention(Number(option.dataset.mentionOption));
});
// Inline rename: Escape cancels and returns focus to the Rename control.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const form = event.target.closest?.("[data-rename-form]");
  if (!form) return;
  event.preventDefault();
  event.stopPropagation();
  endRename();
}, true);
// Inline queue edit: Enter saves, Escape cancels and returns focus to Edit.
$("#queueTray").addEventListener("keydown", (event) => {
  const form = event.target.closest?.("[data-queue-edit]");
  if (!form || !event.target.matches("textarea")) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelQueueEdit(); }
});
$("#composerInput").addEventListener("input", () => { autoSizeComposer(); syncMentionPicker(); });
document.addEventListener("input", (event) => {
  if (state.renaming && event.target.closest?.("[data-rename-form]")) state.renaming.draft = event.target.value;
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
  try {
    // The interrupt pauses a non-empty queue (pausedReason interrupted):
    // nothing queued is sent until an explicit Resume.
    const result = await action({ action: "interruptTurn", threadId: state.activeThreadId, turnId: state.currentTurnId });
    if (result?.queue) { applyHostEvent(state, "queueChanged", { threadId: result.queue.threadId, queue: result.queue }); renderQueue(); }
  }
  catch (error) { notify(error.message); }
});
$("#reviewButton").addEventListener("click", () => { closeSearch(false); closeInbox(false); closeImport(false); $("#reviewPanel").hidden = false; $("#reviewPanel").inert = false; syncScrim(); $("#closeReview").focus(); });
$("#closeReview").addEventListener("click", () => { $("#reviewPanel").hidden = true; $("#reviewPanel").inert = true; syncScrim(); $("#reviewButton").focus(); });
$("#scrim").addEventListener("click", () => {
  if (!$("#searchDialog").hidden) closeSearch();
  else if (openBridgeDialog()) closeOpenBridgeDialog();
  else if (!$("#fullAccessDialog").hidden) closeFullAccessDialog();
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
  const modal = [$("#searchDialog"), $("#importDialog"), $("#inboxPanel"), $("#reviewPanel"), ...BRIDGE_DIALOG_IDS.map((id) => $(`#${id}`)), $("#fullAccessDialog"), appShell.classList.contains("sidebar-open") ? sidebar : null].find((element) => element && !element.hidden && !element.inert);
  if (event.key === "Tab" && modal) {
    const focusable = $$("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])", modal).filter((element) => !element.hidden && element.getClientRects().length);
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
    else if (openBridgeDialog()) closeOpenBridgeDialog();
    else if (!$("#fullAccessDialog").hidden) closeFullAccessDialog();
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

// Deep links name the surface to recover after a reload: `?task=` reopens the
// focused Task Workspace (whose linked Thread the host resolves), `?thread=`
// reopens ordinary Chat. Nothing here is a default: without either, start()
// lands on Chat.
async function landFromLocation(params) {
  const requestedTicketId = params.get("task");
  if (requestedTicketId) {
    // openTask lands on Chat itself when the Task cannot be read.
    await openTask(requestedTicketId);
    return true;
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
    return true;
  }
  return false;
}

// Review fixture for the Task Workspace: host-shaped data, never runtime
// history. The packet text is serialized here for the same reason the host
// serializes it: the Workspace shows bytes, not a browser re-rendering.
function applyTaskFixture(fixture, variantName) {
  const variant = fixture.variants[variantName] ?? fixture.variants.ready;
  state.fixtureMode = true;
  state.threads = state.threads.filter((thread) => thread.id !== fixture.thread.id && thread.taskLink?.ticketId !== fixture.ticketId);
  state.activeTicketId = fixture.ticketId;
  state.activeTask = structuredClone(fixture.handoff);
  state.activeTask.nextAction = { action: variant.nextAction, reason: "review_fixture" };
  state.activeTask.operationalState = ({ DONE: "DONE", REPLAN: "DEVIATED", REFINE: "REFINE", WAIT: "BLOCKED" })[variant.nextAction] ?? "READY";
  if (variant.outcome) state.activeTask.outcomeRecord = { status: variant.outcome, summary: "Review fixture Outcome", closed_at: "2026-08-21T00:00:00Z", accepted_acceptance_ids: fixture.handoff.acceptance.map((item) => item.acceptance_id), unresolved_acceptance_ids: [], evidence_ids: fixture.handoff.evidence.map((item) => item.evidenceId) };
  const packet = structuredClone(fixture.packet);
  packet.task.nextAction = state.activeTask.nextAction;
  if (variant.project === "standalone") packet.project = { scope: "standalone", projectId: null, name: null, ownership: "no_project" };
  state.taskWorkspace = {
    handoff: state.activeTask,
    packet,
    packetText: JSON.stringify(packet, null, 2),
    evidence: state.activeTask.evidence,
    outcome: state.activeTask.outcomeRecord ?? null,
    nextAction: state.activeTask.nextAction,
    eligibleContexts: fixture.eligibleContexts,
    rooms: fixture.rooms,
  };
  state.taskSelectedContextIds = new Set(packet.context.selectedContextIds ?? []);
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
  } else {
    state.activeThreadId = null;
    state.activeThread = null;
    state.currentTurnId = null;
    state.running = false;
  }
  state.pendingRequests = fixture.pendingRequests;
  $("#stopTurn").hidden = !state.running;
  updateSidebar();
  setRoute("task");
  return state.taskWorkspace;
}

// Review fixture for the fork chat proposal (docs/proposals/fork-chat):
// host-shaped Thread records, never runtime history. The action sink serves
// reads of the fixture family only, so lineage navigation works while
// nothing reaches the runtime — a send is refused honestly, no model is
// spent, and nothing is written.
function applyForkFixture(fixture, variantName) {
  const variant = fixture.openByVariant[variantName] ? variantName : "chip";
  state.fixtureMode = true;
  state.forkReview = { direction: fixture.directionsByVariant[variant], variant };
  const threads = fixture.threads.map((thread) => structuredClone(thread));
  state.threads = threads;
  state.pinned = [];
  state.projects = [{ ...fixture.project, threads: threads.filter((thread) => thread.project?.id === fixture.project.id) }];
  state.recents = threads.filter((thread) => !thread.project);
  interactionGuardActionSink = async (payload) => {
    if (payload.action === "readThread") {
      const thread = threads.find((entry) => entry.id === payload.threadId);
      if (!thread) throw new Error(`Review fixture only: no fixture thread ${payload.threadId}.`);
      return { thread: structuredClone(thread) };
    }
    if (payload.action === "listQueue") return { queue: { threadId: payload.threadId, paused: false, pausedReason: null, lastError: null, limit: 20, items: [] } };
    throw new Error("Review fixture only: nothing is sent and nothing is written.");
  };
  const open = threads.find((thread) => thread.id === fixture.openByVariant[variant]);
  state.activeThreadId = open.id;
  state.activeThread = structuredClone(open);
  state.currentTurnId = null;
  state.running = false;
  $("#stopTurn").hidden = true;
  updateSidebar();
  setRoute("chat");
}

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
    if (await landFromLocation(params)) {
      pollEvents();
      return;
    }
    const taskFixtureName = params.get("taskFixture");
    if (taskFixtureName) {
      applyTaskFixture(await fetch("/task-fixtures.json").then((response) => response.json()), taskFixtureName);
      return;
    }
    const forkFixtureName = params.get("forkFixture");
    if (forkFixtureName) {
      applyForkFixture(await fetch("/fork-fixtures.json").then((response) => response.json()), forkFixtureName);
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
    currentBootstrap: () => state.bootstrap ?? null,
    // The process generation the browser currently holds, so a synthetic
    // event window can name it and never trigger a generation-change re-read.
    currentRuntimeGeneration: () => state.runtimeGeneration,
    // Completion notices raised in this session and bootstrap refreshes so far.
    completionLog: () => structuredClone(state.completionLog),
    bootstrapRefreshes: () => state.bootstrapRefreshes,
    // The Sidebar freshness watch: each Thread watched until a bootstrap
    // lists it (its provisional row, bootstraps that missed it, a retry
    // pending), and the ids the last bootstrap listed.
    listingWatch: () => ({
      watched: state.listingWatch.ids().map((threadId) => ({ threadId, provisional: Boolean(state.listingWatch.record(threadId)), refreshes: state.listingWatch.refreshes(threadId), retryPending: state.listingTimers.has(threadId) })),
      listed: [...state.listedThreadIds],
      attempts: state.listingWatch.attempts,
      delayMs: state.listingWatch.delayMs,
    }),
    // Host event windows fed straight into the same path pollEvents takes,
    // and a way back to the live runtime posture once the checks are done.
    applyEventWindow: async (window) => {
      await applyEventWindow(window);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    },
    restoreRuntime: async ({ stop = null, alive = true } = {}) => {
      state.bootstrap = { ...(state.bootstrap ?? {}), stop };
      for (const map of [state.turnErrors]) for (const [key, item] of map) if (item.status === "runtimeExited") map.delete(key);
      renderStopBanner();
      renderProjectHeader();
      setRuntimePosture({ alive, state: alive ? "alive" : "exited" });
      if (state.route === "chat") renderChat();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    },
    closeImport: () => closeImport(false),
    // The model catalog through the current transport (the guard's fixture
    // transport or the live host), and the not-loaded posture again.
    loadModels: () => loadModels({ force: true }),
    resetModels: async () => {
      state.models = null;
      state.modelsError = null;
      state.settingsOverrides.clear();
      renderComposerSettings();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    },
    // Real host transport for checks that must read the checked-in repository
    // through the live projection rather than a fixture.
    hostAction: (payload) => api("/api/action", { method: "POST", body: JSON.stringify(payload) }),
    refreshBootstrap: () => refreshThreads(),
    taskQuoteDraft: (ticketId) => (state.taskQuoteDrafts.has(ticketId) ? structuredClone(state.taskQuoteDrafts.get(ticketId)) : null),
    openThread: (threadId, options) => openThread(threadId, options),
    openTask,
    landFromLocation: () => landFromLocation(new URLSearchParams(location.search)),
    applyTaskFixture: async (fixture, variantName) => {
      const workspace = applyTaskFixture(fixture, variantName);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return workspace;
    },
  });
}
