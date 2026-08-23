import { itemKey } from "./chat-model.mjs";

const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const waitFor = async (predicate, attempts = 30) => {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true;
    await frame();
  }
  return false;
};

function check(results, name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail });
}

// A compound check: every named condition must hold; the failing names are
// the detail, so a red line says which clause broke instead of only that one did.
function checkAll(results, name, conditions, detail = "") {
  const failed = Object.entries(conditions).filter(([, value]) => !value).map(([key]) => key);
  check(results, name, failed.length === 0, `${failed.length ? `failed: ${failed.join(", ")}` : "all clauses hold"}${detail ? ` · ${detail}` : ""}`);
}

const describeNode = (node) => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${node.className ? `.${String(node.className).trim().split(/\s+/)[0]}` : ""}`;
const NATIVE_OPERABLE = "button, a[href], input, select, textarea, summary";
const focusableByTabindex = (node) => node.hasAttribute("tabindex") && Number(node.getAttribute("tabindex")) >= 0;
const keyboardOperable = (node) => node.matches(NATIVE_OPERABLE) || focusableByTabindex(node);
// Every selector the delegated click handler in app.js dispatches on. A match
// that is neither a native control nor focusable has no keyboard path.
const POINTER_TARGETS = ["[data-search-kind]", "[data-open-inbox]", "[data-route]", "[data-thread-id]", "[data-ticket-id]", "[data-clear-context]", "#roomsSearch", "[data-new-thread]", "[data-open-import]", "[data-import-section]", "[data-toggle-project]", "[data-rename-project]", "[data-delete-project]", "[data-fork-thread]", "[data-archive-thread]", "[data-remove-attachment]", "[data-remove-quote]", "#quoteSelection", "[data-quote-message]", "[data-copy-code]", "[data-copy-message]", "[data-copy-citation-thread]", "[data-request-decision]", "[data-retry-turn]", "[data-task-action]", "[data-focus-task-composer]", "[data-create-task]", "[data-attach-task]", "[data-remember]", "[data-selection-bridge]", "[data-attach-target]", "[data-return-to-source]", "[data-graph-chat]", "[data-association-ticket]"].join(", ");

// Pointer-only gaps in the mounted document: click targets without a keyboard
// path, and scroll regions (wheel or touch) that neither take focus nor hold a
// focusable descendant. Closed disclosures are opened for the scan so their
// content is measured, then restored.
function keyboardGaps() {
  const visible = (node) => node.getClientRects().length > 0 && !node.closest("[inert]");
  const disclosures = [...document.querySelectorAll("details:not([open])")].filter(visible);
  for (const node of disclosures) node.open = true;
  try {
    const pointerOnly = [...document.querySelectorAll(POINTER_TARGETS)].filter((node) => visible(node) && !keyboardOperable(node)).map(describeNode);
    const scrolls = (value) => value === "auto" || value === "scroll";
    const unreachableScroll = [...document.querySelectorAll("body *")].filter((node) => {
      if (!visible(node) || node.closest(".interaction-guard-result")) return false;
      const style = getComputedStyle(node);
      if (!scrolls(style.overflowY) && !scrolls(style.overflowX)) return false;
      if (node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1) return false;
      if (node.matches("textarea") || focusableByTabindex(node)) return false;
      return !node.querySelector(`${NATIVE_OPERABLE.split(", ").map((selector) => `${selector}:not([disabled])`).join(", ")}, [tabindex]:not([tabindex='-1'])`);
    }).map((node) => `${describeNode(node)} ${node.scrollWidth}x${node.scrollHeight} in ${node.clientWidth}x${node.clientHeight}`);
    const spilling = [...document.querySelectorAll("body *")].filter((node) => {
      if (!visible(node) || node.closest(".interaction-guard-result")) return false;
      const style = getComputedStyle(node);
      return style.maxHeight !== "none" && style.overflowY === "visible" && node.scrollHeight > node.clientHeight + 1;
    }).map((node) => `${describeNode(node)} ${node.scrollHeight} in ${node.clientHeight}`);
    return { pointerOnly, unreachableScroll, spilling };
  } finally {
    for (const node of disclosures) node.open = false;
  }
}

// The route title and the search trigger share the topbar: the title must end
// inside its own box (ellipsized, full name kept) before the trigger begins.
function topbarBoxes() {
  const title = document.querySelector("#routeTitle");
  const trigger = document.querySelector("#searchButton");
  const topbar = document.querySelector(".topbar");
  const a = title.getBoundingClientRect();
  const b = trigger.getBoundingClientRect();
  const intersects = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  return { intersects, truncated: title.scrollWidth > title.clientWidth, fullName: title.title === title.textContent && title.textContent.length > 0, overflow: topbar.scrollWidth > topbar.clientWidth, detail: `title ${Math.round(a.left)}–${Math.round(a.right)} · search ${Math.round(b.left)}–${Math.round(b.right)} · ${title.clientWidth}/${title.scrollWidth}px` };
}

const nonZeroDuration = (value) => String(value).split(",").some((part) => Number.parseFloat(part) > 0);
// Every element and its ::before/::after, with the durations the engine will
// actually run. Under prefers-reduced-motion: reduce the shell must report no
// animation or transition time and no smooth scrolling anywhere.
export function auditMotion() {
  const offenders = [];
  for (const node of document.querySelectorAll("body *")) {
    for (const pseudo of [null, "::before", "::after"]) {
      const style = getComputedStyle(node, pseudo);
      const animated = nonZeroDuration(style.animationDuration) && style.animationName !== "none";
      const transitioned = nonZeroDuration(style.transitionDuration) && style.transitionProperty !== "none";
      const smooth = !pseudo && style.scrollBehavior === "smooth";
      if (animated || transitioned || smooth) offenders.push(`${describeNode(node)}${pseudo ?? ""} · ${animated ? `animation ${style.animationName} ${style.animationDuration}` : transitioned ? `transition ${style.transitionProperty} ${style.transitionDuration}` : "scroll-behavior smooth"}`);
    }
  }
  return { reduced: matchMedia("(prefers-reduced-motion: reduce)").matches, offenders, scanned: document.querySelectorAll("body *").length };
}

export async function runBrowserInteractionGuard(hooks) {
  const results = [];
  const fixture = await fetch("/chat-fixtures.json").then((response) => response.json());
  const originalTheme = document.documentElement.dataset.theme || "system";
  const originalHref = location.href;
  const openSidebar = document.querySelector("#openSidebar");
  const closeSidebar = document.querySelector("#collapseSidebar");
  const sidebar = document.querySelector("#sidebar");
  const main = document.querySelector(".main-column");

  const appShell = document.querySelector("#appShell");
  const narrowLayout = () => document.body.dataset.reviewFrame === "narrow" || matchMedia("(max-width: 760px)").matches;
  if (narrowLayout()) {
    openSidebar.focus();
    openSidebar.click();
    await frame();
    check(results, "narrow drawer opens", openSidebar.getAttribute("aria-expanded") === "true" && !sidebar.inert && main.inert);
    check(results, "drawer receives focus", sidebar.contains(document.activeElement), document.activeElement?.id);
    closeSidebar.click();
    await frame();
    check(results, "narrow drawer closes", openSidebar.getAttribute("aria-expanded") === "false" && sidebar.inert && !main.inert);
    check(results, "drawer returns focus", document.activeElement === openSidebar, document.activeElement?.id);
  } else {
    // Wide layout: the sidebar is persistent, never inert, and the collapse
    // control toggles width without trapping or moving focus.
    check(results, "wide sidebar is persistent and reachable", !sidebar.inert && sidebar.getAttribute("aria-hidden") === "false" && !sidebar.hasAttribute("aria-modal") && getComputedStyle(openSidebar).display === "none" && !main.inert);
    closeSidebar.focus();
    closeSidebar.click();
    await frame();
    check(results, "wide sidebar collapses without trapping focus", appShell.classList.contains("sidebar-collapsed") && !sidebar.inert && !main.inert && document.activeElement === closeSidebar, document.activeElement?.id);
    closeSidebar.click();
    await frame();
    check(results, "wide sidebar expands again", !appShell.classList.contains("sidebar-collapsed") && !sidebar.inert);
  }

  // The Composer is the last grid row of the main column: on screen, beneath
  // the conversation, whether or not a stop banner occupies the row above.
  const frameBox = document.body.getBoundingClientRect();
  const composerBox = document.querySelector("#composer").getBoundingClientRect();
  const surfaceBox = document.querySelector("#surface").getBoundingClientRect();
  check(results, "Composer stays on screen beneath the conversation", composerBox.height > 40 && composerBox.bottom <= frameBox.bottom + 1 && composerBox.top >= surfaceBox.bottom - 1 && surfaceBox.height > 200, `composer ${Math.round(composerBox.top)}–${Math.round(composerBox.bottom)} · surface ${Math.round(surfaceBox.top)}–${Math.round(surfaceBox.bottom)} · frame ${Math.round(frameBox.bottom)}`);

  const searchTrigger = document.querySelector("#searchButton");
  searchTrigger.focus();
  searchTrigger.click();
  await frame();
  const search = document.querySelector("#searchDialog");
  const searchInput = document.querySelector("#searchInput");
  check(results, "search is a contained modal", !search.hidden && document.querySelector("#appShell").inert && document.activeElement === searchInput);
  check(results, "search exposes composite focus", searchInput.getAttribute("aria-controls") === "searchResults" && Boolean(searchInput.getAttribute("aria-activedescendant")));
  const focusable = [...search.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")].filter((element) => element.getClientRects().length);
  focusable.at(-1)?.focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  check(results, "search traps forward Tab", document.activeElement === focusable[0], document.activeElement?.id);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await frame();
  check(results, "search Escape restores focus", search.hidden && document.activeElement === searchTrigger, document.activeElement?.id);

  const request = document.querySelector('[data-request-id="fixture-user-input"]');
  const other = request?.querySelector('[data-request-other="approach"]');
  const otherRadio = other?.closest(".request-other")?.querySelector('input[type="radio"]');
  const secret = request?.querySelector('[data-request-answer="token"]');
  check(results, "requestUserInput renders every blocking question", request?.dataset.blocking === "true" && request.querySelectorAll("fieldset").length === 2);
  check(results, "requestUserInput exposes secret and Other posture", other?.type === "text" && secret?.type === "password");
  const decisionButtons = [...document.querySelectorAll("[data-request-decision], [data-request-form] button")];
  check(results, "approval decision labels stay unclipped at this width", decisionButtons.length >= 4 && decisionButtons.every((button) => button.scrollHeight <= button.clientHeight + 1 && button.scrollWidth <= button.clientWidth + 1), decisionButtons.map((button) => `${button.textContent.trim()} ${button.clientHeight}/${button.scrollHeight}`).join(" · "));
  const keyboardGapLog = [];
  const auditKeyboard = (surfaceName) => { const gaps = keyboardGaps(); for (const gap of gaps.pointerOnly) keyboardGapLog.push(`${surfaceName}: click target ${gap}`); for (const gap of gaps.unreachableScroll) keyboardGapLog.push(`${surfaceName}: scroll region ${gap}`); for (const gap of gaps.spilling) keyboardGapLog.push(`${surfaceName}: bounded content spills without a scroll ${gap}`); };
  auditKeyboard("chat fixture");
  if (other && secret) {
    other.value = "Custom path";
    other.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Custom path" }));
    secret.value = "fixture-secret";
    other.focus();
    await hooks.reconcile();
  }
  check(results, "typing Other selects its exact option", otherRadio?.checked === true);
  check(results, "request draft and focus survive reconciliation", other?.value === "Custom path" && secret?.value === "fixture-secret" && document.activeElement === other);

  // An intentional route change through the real navigation rebuilds the
  // Chat surface; the request card must come back with its typed draft.
  openSidebar.click();
  await frame();
  document.querySelector('.primary-nav [data-route="tasks"]').click();
  await frame();
  const tasksVisible = Boolean(document.querySelector(".tasks-view"));
  if (tasksVisible) auditKeyboard("tasks graph");
  openSidebar.click();
  await frame();
  document.querySelector('.primary-nav [data-route="chat"]').click();
  await frame();
  const restoredRequest = document.querySelector('[data-request-id="fixture-user-input"]');
  const restoredOther = restoredRequest?.querySelector('[data-request-other="approach"]');
  const restoredRadio = restoredOther?.closest(".request-other")?.querySelector('input[type="radio"]');
  const restoredSecret = restoredRequest?.querySelector('[data-request-answer="token"]');
  check(results, "request draft survives an intentional route change", tasksVisible && restoredRequest && restoredRequest !== request && restoredOther?.value === "Custom path" && restoredRadio?.checked === true && restoredSecret?.value === "fixture-secret", `${tasksVisible}/${restoredOther?.value}/${restoredSecret?.value}`);

  // Selection held across a streamed update: the selected entry keeps its
  // mounted node while the rest of the Turn streams, then reconciles once
  // the selection is released.
  const agentEntry = document.querySelector('[data-item-id$="fixture-agent"]');
  const paragraph = agentEntry?.querySelector(".agent-response p");
  const selection = window.getSelection();
  let heldText = "";
  if (paragraph) {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    selection.removeAllRanges();
    selection.addRange(range);
    heldText = selection.toString();
  }
  const streamed = structuredClone(fixture.thread);
  const streamedAgent = streamed.turns[0].items.find((item) => item.id === "fixture-agent");
  streamedAgent.text = `${streamedAgent.text}\n\nStreamed continuation that must not replace the selected passage.`;
  const streamedCommand = streamed.turns[0].items.find((item) => item.id === "fixture-command");
  streamedCommand.aggregatedOutput = `${streamedCommand.aggregatedOutput}✓ streamed while a passage was selected\n`;
  await hooks.reconcileFixtureThread(streamed);
  const heldEntry = document.querySelector('[data-item-id$="fixture-agent"]')?.closest(".timeline-entry");
  check(results, "streaming never replaces a selected transcript entry", heldText.length > 20 && selection.toString() === heldText && heldEntry?.hasAttribute("data-paint-deferred") && agentEntry?.isConnected && !agentEntry.textContent.includes("Streamed continuation"), `${heldText.length}/${selection.toString().length}`);
  check(results, "unselected entries keep streaming around the selection", Boolean(document.querySelector(".terminal-output")?.textContent.includes("streamed while a passage was selected")));
  selection.removeAllRanges();
  const released = await waitFor(() => document.querySelector('[data-item-id$="fixture-agent"]')?.textContent.includes("Streamed continuation") && !document.querySelector("[data-paint-deferred]"));
  check(results, "releasing the selection reconciles the held entry", released);

  const originalComposer = document.querySelector("#composerInput");
  originalComposer.value = "draft owned by the original Thread";
  document.querySelector("[data-quote-message]")?.click();
  await frame();
  check(results, "Quote captures exact original Thread identity", document.querySelector("#quoteTray")?.textContent.includes("Quoted response") && document.querySelector("#quoteTray .quote-source")?.getAttribute("aria-label")?.includes(fixture.thread.id));
  await hooks.switchFixtureThread(fixture.secondaryThread);
  check(results, "switching Thread does not leak Composer state", !document.querySelector("#composerInput").value && document.querySelector("#quoteTray").hidden);
  document.querySelector("#composerInput").value = "secondary draft";
  await hooks.switchFixtureThread(fixture.thread);
  check(results, "returning restores only that Thread draft", document.querySelector("#composerInput").value === "draft owned by the original Thread" && !document.querySelector("#quoteTray").hidden);

  const quoteActions = [];
  await hooks.withFixtureTransport(async (payload) => {
    quoteActions.push(payload);
    if (payload.action === "startTurn") return { turn: { id: "fixture-quote-turn" } };
    if (payload.action === "readThread") return { thread: structuredClone(fixture.thread) };
    return {};
  }, async () => {
    document.querySelector("#composer").requestSubmit();
    await waitFor(() => quoteActions.some((entry) => entry.action === "readThread"));
  });
  const sentText = quoteActions.find((entry) => entry.action === "startTurn")?.input?.find((entry) => entry.type === "text")?.text ?? "";
  check(results, "Quote serializes exact source identity into the Turn input", sentText.includes(`> — Quoted from Codex thread ${fixture.thread.id} · turn fixture-turn-1 · item fixture-agent`) && sentText.endsWith("draft owned by the original Thread"), sentText.slice(0, 80));
  const replayed = structuredClone(fixture.thread);
  replayed.turns.push({ id: "fixture-turn-quote", status: "completed", items: [{ type: "userMessage", id: "fixture-quote-user", content: [{ type: "text", text: sentText }] }] });
  await hooks.reconcileFixtureThread(replayed);
  const replayedChip = document.querySelector('.turn.user .quote-source[data-quote-item="fixture-agent"]');
  check(results, "replayed quote renders its durable source identity", replayedChip?.getAttribute("aria-label") === `Quoted from Thread ${fixture.thread.id} · Turn fixture-turn-1 · Item fixture-agent` && replayedChip.textContent.includes("this Thread"), replayedChip?.getAttribute("aria-label") ?? "missing");

  const composerInput = document.querySelector("#composerInput");
  composerInput.value = Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n");
  composerInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await frame();
  const ceiling = Number.parseFloat(getComputedStyle(composerInput).maxHeight);
  check(results, "Composer growth stops at the CSS ceiling", Number.isFinite(ceiling) && Number.parseFloat(composerInput.style.height) === ceiling && composerInput.getBoundingClientRect().height <= ceiling + 1 && composerInput.scrollHeight > ceiling, `${composerInput.style.height}/${ceiling}px`);
  composerInput.value = "";
  composerInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
  document.querySelector("[data-quote-message]")?.click();
  await frame();
  const quoteTray = document.querySelector("#quoteTray");
  const quoteShown = !quoteTray.hidden;
  quoteTray.querySelector("[data-remove-quote]")?.click();
  await frame();
  const attachmentInput = document.querySelector("#attachmentInput");
  check(results, "text, image and ordinary audio inputs stay available and quote context is removable", quoteShown && quoteTray.hidden && attachmentInput?.accept === "image/*,audio/*" && document.querySelector("#voiceButton")?.getAttribute("aria-label") === "Record voice input" && composerInput.getAttribute("aria-label") === "Message Codex");

  await hooks.switchFixtureThread(fixture.activeThread);
  const activeComposer = document.querySelector("#composer");
  const sendButton = document.querySelector("#sendButton");
  check(results, "active Turn exposes coherent Queue and Stop", activeComposer.dataset.turnPosture === "running" && activeComposer.dataset.currentTurnId === fixture.activeThread.turns[0].id && !document.querySelector("#stopTurn").hidden && sendButton.getAttribute("aria-label") === "Queue message" && sendButton.textContent === "Queue" && sendButton.dataset.sendMode === "queue" && document.querySelector("#composerNote").textContent.includes("Alt+Enter steers"), `${sendButton.textContent}/${sendButton.getAttribute("aria-label")}`);

  // --- The host-owned follow-up queue ------------------------------------
  // Enter while a Turn streams queues through queueTurn (never turn/start,
  // never turn/steer); the host's record renders as rows above the Composer;
  // Alt+Enter is the explicit opposite and steers the exact live Turn.
  const liveTurn = fixture.activeThread.turns[0].id;
  const queueRecord = (items, extra = {}) => ({ threadId: fixture.activeThread.id, paused: false, pausedReason: null, lastError: null, limit: 20, items, ...extra });
  const queuedItem = (queuedId, text, extra = {}) => ({ queuedId, queuedAt: "2026-08-22T00:00:00.000Z", settings: null, starting: false, input: [{ type: "text", text }], ...extra });
  let queueTray = document.querySelector("#queueTray");
  const queueActions = [];
  let mirrored = queueRecord([]);
  const queueFailure = (name, error) => check(results, name, false, `threw: ${error?.message ?? error}`);
  try { await hooks.withFixtureTransport(async (payload) => {
    queueActions.push(payload);
    if (payload.action === "queueTurn") {
      mirrored = queueRecord([...mirrored.items, queuedItem(`queued-${mirrored.items.length + 1}`, payload.input.find((item) => item.type === "text")?.text ?? "")]);
      return { queuedId: mirrored.items.at(-1).queuedId, started: null, queue: structuredClone(mirrored) };
    }
    if (payload.action === "updateQueued") {
      mirrored = queueRecord(mirrored.items.map((item) => (item.queuedId === payload.queuedId ? { ...item, input: payload.input } : item)));
      return { queuedId: payload.queuedId, queue: structuredClone(mirrored) };
    }
    if (payload.action === "deleteQueued") {
      mirrored = queueRecord(mirrored.items.filter((item) => item.queuedId !== payload.queuedId));
      return { queuedId: payload.queuedId, queue: structuredClone(mirrored) };
    }
    if (payload.action === "steerQueued") {
      mirrored = queueRecord(mirrored.items.filter((item) => item.queuedId !== payload.queuedId));
      return { turnId: payload.expectedTurnId, queuedId: payload.queuedId, queue: structuredClone(mirrored) };
    }
    if (payload.action === "steerTurn") return { turnId: payload.expectedTurnId };
    if (payload.action === "readThread") return { thread: structuredClone(fixture.activeThread) };
    if (payload.action === "listQueue") return { queue: structuredClone(mirrored) };
    return {};
  }, async () => {
    const composerInput = document.querySelector("#composerInput");
    composerInput.value = "Queued follow-up one";
    composerInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => document.querySelectorAll("#queueTray .queue-row").length === 1);
    composerInput.value = "Queued follow-up two";
    document.querySelector("#composer").requestSubmit();
    await waitFor(() => document.querySelectorAll("#queueTray .queue-row").length === 2);
    queueTray = document.querySelector("#queueTray");
    const rows = [...queueTray.querySelectorAll(".queue-row")];
    const queued = queueActions.filter((entry) => entry.action === "queueTurn");
    checkAll(results, "submission during a live Turn queues by default through queueTurn", {
      twoQueueTurns: queued.length === 2 && queued.every((entry) => entry.threadId === fixture.activeThread.id && entry.input[0].type === "text"),
      noStartOrSteer: !queueActions.some((entry) => entry.action === "startTurn" || entry.action === "steerTurn"),
      rowsAboveComposer: rows.length === 2 && rows.map((row) => row.querySelector(".queue-text").textContent).join("|") === "Queued follow-up one|Queued follow-up two" && queueTray.getBoundingClientRect().bottom <= document.querySelector("#composer").getBoundingClientRect().top + 1,
      composerCleared: composerInput.value === "",
      rowActions: rows.every((row) => row.querySelector("[data-edit-queued]") && row.querySelector("[data-steer-queued]:not([disabled])") && row.querySelector("[data-delete-queued]")),
      stillRunning: activeComposer.dataset.turnPosture === "running" && sendButton.textContent === "Queue",
    }, `${queued.length} queueTurn · ${rows.length} rows`);

    // Alt+Enter: the opposite of the Queue label, one exact turn/steer.
    composerInput.value = "Steer this exact active Turn";
    composerInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", altKey: true, bubbles: true }));
    await waitFor(() => queueActions.some((entry) => entry.action === "steerTurn"));
    const steer = queueActions.find((entry) => entry.action === "steerTurn");
    check(results, "Alt+Enter steers the exact live Turn instead of queueing", steer?.threadId === fixture.activeThread.id && steer?.expectedTurnId === liveTurn && steer.input[0].text === "Steer this exact active Turn" && queueActions.filter((entry) => entry.action === "queueTurn").length === 2 && !queueActions.some((entry) => entry.action === "startTurn"), JSON.stringify(steer ?? null).slice(0, 120));

    // Per-row Edit (inline, Enter saves, focus returns to Edit), Delete and
    // Steer (turn/steer with the exact expectedTurnId) through the host.
    const editButton = queueTray.querySelector('[data-edit-queued="queued-1"]');
    editButton.focus();
    editButton.click();
    await frame();
    const editor = queueTray.querySelector('[data-queue-edit="queued-1"] textarea');
    const editorFocused = document.activeElement === editor;
    editor.value = "Queued follow-up one, edited";
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => queueTray.querySelector(".queue-text")?.textContent === "Queued follow-up one, edited");
    const update = queueActions.find((entry) => entry.action === "updateQueued");
    const editFocusReturned = document.activeElement === queueTray.querySelector('[data-edit-queued="queued-1"]');
    queueTray.querySelector('[data-delete-queued="queued-2"]').click();
    await waitFor(() => queueTray.querySelectorAll(".queue-row").length === 1);
    const deletion = queueActions.find((entry) => entry.action === "deleteQueued");
    queueTray.querySelector('[data-steer-queued="queued-1"]').click();
    await waitFor(() => queueActions.some((entry) => entry.action === "steerQueued"));
    await waitFor(() => document.querySelector("#queueTray").hidden);
    const rowSteer = queueActions.find((entry) => entry.action === "steerQueued");
    checkAll(results, "queued rows edit, delete and steer through the host queue actions", {
      editorFocused,
      updateCarriesEditedText: update?.queuedId === "queued-1" && update.input.length === 1 && update.input[0].text === "Queued follow-up one, edited" && update.settings === undefined,
      editFocusReturned,
      deleteNamesRow: deletion?.queuedId === "queued-2" && deletion.threadId === fixture.activeThread.id,
      steerNamesExactTurn: rowSteer?.queuedId === "queued-1" && rowSteer.expectedTurnId === liveTurn,
      queueEmptied: document.querySelector("#queueTray").hidden,
    }, `${queueActions.map((entry) => entry.action).join(",")}`);

    // The interrupt pauses the queue (host pausedReason interrupted): the
    // paused copy names the cause and Resume is the only way out; the
    // resumed head starts as its own Turn and the transcript is re-read.
    mirrored = queueRecord([queuedItem("queued-7", "Paused follow-up")], { paused: true, pausedReason: "interrupted" });
    await hooks.applyEventWindow({ events: [{ sequence: 21, kind: "queueChanged", value: { threadId: fixture.activeThread.id, queue: structuredClone(mirrored) } }], cursor: 21, oldestCursor: 1, gap: false, runtimeGeneration: 2, runtimeAlive: true, runtimeState: "alive", runtimeHalt: null, pendingRequests: fixture.pendingRequests });
    queueTray = document.querySelector("#queueTray");
    const pausedNote = queueTray.querySelector(".queue-paused");
    const pausedShown = !queueTray.hidden && queueTray.dataset.paused === "true" && queueTray.dataset.pausedReason === "interrupted" && pausedNote?.textContent.includes("Queue paused because you interrupted") && Boolean(pausedNote.querySelector("[data-resume-queue]"));
    const actionsBeforeResume = queueActions.length;
    await frame();
    const nothingSentWhilePaused = queueActions.length === actionsBeforeResume;
    pausedNote?.querySelector("[data-resume-queue]")?.click();
    await waitFor(() => queueActions.some((entry) => entry.action === "resumeQueue"));
    const resume = queueActions.find((entry) => entry.action === "resumeQueue");
    check(results, "an interrupted queue stays paused until an explicit Resume", pausedShown && nothingSentWhilePaused && resume?.threadId === fixture.activeThread.id && !queueActions.some((entry) => entry.action === "startTurn"), `${queueTray.dataset.paused}/${queueTray.dataset.pausedReason} · ${pausedNote?.textContent.slice(0, 60) ?? "no paused note"}`);
  }); } catch (error) { queueFailure("queue checks completed", error); }

  // queuedStarted: the follow-up became its own Turn with a runtime-minted
  // id. The row leaves the queue and the re-read Thread carries the new
  // Turn's user message as the next transcript entry.
  const startedThread = structuredClone(fixture.activeThread);
  startedThread.turns = [{ ...startedThread.turns[0], status: "completed" }, { id: "fixture-queued-turn", status: "inProgress", items: [{ type: "userMessage", id: "fixture-queued-user", content: [{ type: "text", text: "Paused follow-up" }] }] }];
  const startedActions = [];
  try { await hooks.withFixtureTransport(async (payload) => {
    startedActions.push(payload);
    if (payload.action === "readThread") return { thread: structuredClone(startedThread) };
    if (payload.action === "listQueue") return { queue: queueRecord([]) };
    return {};
  }, async () => {
    await hooks.applyEventWindow({ events: [
      { sequence: 22, kind: "queuedStarted", value: { threadId: fixture.activeThread.id, queuedId: "queued-7", turnId: "fixture-queued-turn" } },
      { sequence: 23, kind: "queueChanged", value: { threadId: fixture.activeThread.id, queue: queueRecord([]) } },
      { sequence: 24, kind: "notification", value: { method: "turn/started", params: { threadId: fixture.activeThread.id, turn: { id: "fixture-queued-turn", status: "inProgress", items: [] } } } },
    ], cursor: 24, oldestCursor: 1, gap: false, runtimeGeneration: 2, runtimeAlive: true, runtimeState: "alive", runtimeHalt: null, pendingRequests: fixture.pendingRequests });
    await waitFor(() => document.querySelector('.turn.user[data-item-id$="fixture-queued-user"]'));
    const userEntries = [...document.querySelectorAll(".turn.user")];
    check(results, "queuedStarted moves the follow-up into the transcript as its own Turn", startedActions.some((entry) => entry.action === "readThread" && entry.threadId === fixture.activeThread.id) && document.querySelector("#queueTray").hidden && userEntries.at(-1)?.textContent.includes("Paused follow-up") && userEntries.at(-1).closest(".timeline-entry")?.dataset.renderKey?.includes("fixture-queued-turn") && document.querySelector("#composer").dataset.currentTurnId === "fixture-queued-turn", `${userEntries.length} user entries · ${startedActions.map((entry) => entry.action).join(",")}`);
  }); } catch (error) { queueFailure("queuedStarted check completed", error); }
  await hooks.switchFixtureThread(fixture.activeThread);
  const interrupted = structuredClone(fixture.activeThread);
  interrupted.status = { type: "idle" };
  interrupted.turns.at(-1).status = "interrupted";
  let terminalForkEnabled = false;
  await hooks.withFixtureTransport(async () => ({}), async () => {
    await hooks.reconcileFixtureThread(interrupted);
    terminalForkEnabled = document.querySelector("#composer").dataset.turnPosture === "idle" && document.querySelector("#stopTurn").hidden && !document.querySelector("[data-fork-thread]").disabled;
  });
  check(results, "terminal reconciliation re-enables Fork", terminalForkEnabled);

  // Runtime lifecycle through the same path pollEvents takes. The app-server
  // exits under a live Turn: the running posture must go at once, a boundary
  // must say where the exit fell, and nothing may claim to be working. A halt
  // announced by the host must raise the persistent stop and disable every
  // adapter action until relaunch.
  await hooks.switchFixtureThread(fixture.activeThread);
  const composerNode = document.querySelector("#composer");
  const runtimeLabelNode = document.querySelector("#runtimeLabel");
  const liveBeforeExit = composerNode.dataset.turnPosture === "running" && !document.querySelector("#stopTurn").hidden;
  await hooks.applyEventWindow({ events: [{ sequence: 1, kind: "runtimeExit", value: { code: null, signal: "SIGKILL", generation: 1, requested: false, runtimeGeneration: 1 } }], cursor: 1, oldestCursor: 1, gap: false, runtimeGeneration: 1, runtimeAlive: false, runtimeState: "restarting", runtimeHalt: null, pendingRequests: fixture.pendingRequests });
  const exitBoundary = document.querySelector(".turn-boundary.runtimeExited");
  check(results, "runtime exit clears the running posture and marks the dead Turn", liveBeforeExit
    && composerNode.dataset.turnPosture === "idle" && !composerNode.dataset.currentTurnId
    && document.querySelector("#stopTurn").hidden && document.querySelector("#sendButton").getAttribute("aria-label") === "Send message"
    && document.querySelector("#composerInput").disabled
    && Boolean(exitBoundary?.textContent.includes("Runtime exited during this Turn")) && exitBoundary.textContent.includes("process generation 1")
    && !document.querySelector(".activity-group summary strong")?.textContent.includes("Working")
    && runtimeLabelNode.textContent === "Runtime restarting" && runtimeLabelNode.parentElement.dataset.runtimeState === "restarting",
    `${composerNode.dataset.turnPosture}/${runtimeLabelNode.textContent}/${exitBoundary ? "boundary" : "no boundary"}`);
  const haltFixture = { code: "stop-condition-violated", conditionId: "thread-restart-recovery-unavailable", message: "Stop condition thread-restart-recovery-unavailable: After restart (generation 2), Thread fixture-active-thread did not come back. The shell stops here instead of reusing this runtime.", detail: "After restart (generation 2), Thread fixture-active-thread did not come back.", observedVersion: "0.147.0", baselineVersion: "0.147.0", generation: 2 };
  await hooks.applyEventWindow({ events: [{ sequence: 2, kind: "runtimeHalted", value: haltFixture }], cursor: 2, oldestCursor: 1, gap: false, runtimeGeneration: 2, runtimeAlive: true, runtimeState: "halted", runtimeHalt: haltFixture, pendingRequests: fixture.pendingRequests });
  const haltBanner = document.querySelector("#stopBanner");
  check(results, "runtime halt raises a persistent stop that names the condition and disables adapter actions",
    haltBanner?.getAttribute("role") === "alert" && haltBanner.dataset.conditionId === "thread-restart-recovery-unavailable"
      && haltBanner.querySelector("code")?.textContent === "thread-restart-recovery-unavailable" && haltBanner.textContent.includes("did not come back")
      && document.querySelector("#composerInput").disabled && document.querySelector("#sendButton").disabled && document.querySelector("#newThread").disabled
      && [...document.querySelectorAll("[data-fork-thread]")].every((button) => button.disabled)
      && document.querySelector("#importProject").hidden
      && runtimeLabelNode.textContent === "Stopped: thread-restart-recovery-unavailable" && runtimeLabelNode.parentElement.dataset.stopped === "true"
      && composerNode.dataset.turnPosture === "idle",
    `${haltBanner?.dataset.conditionId ?? "no banner"}/${runtimeLabelNode.textContent}`);
  await hooks.restoreRuntime();
  check(results, "restoring the runtime posture withdraws the stop", !document.querySelector("#stopBanner") && !document.querySelector("#composerInput").disabled && !document.querySelector("#newThread").disabled && runtimeLabelNode.parentElement.dataset.stopped === "false");

  await hooks.switchFixtureThread(fixture.secondaryThread);
  const forked = { ...structuredClone(fixture.secondaryThread), id: "fixture-forked-thread", title: "Forked fixture chat", forkedFromId: fixture.secondaryThread.id };
  const forkActions = [];
  await hooks.withFixtureTransport(async (payload) => {
    forkActions.push(payload);
    if (payload.action === "forkThread") return { thread: structuredClone(forked) };
    if (payload.action === "readThread") return { thread: structuredClone(forked) };
    throw new Error(`Unexpected fixture action ${payload.action}`);
  }, async () => {
    document.querySelector("[data-fork-thread]")?.click();
    // The fork refreshes the Thread list through the live host before it
    // opens the returned Thread; on the real app-server that bootstrap takes
    // seconds, not frames.
    await waitFor(() => forkActions.some((entry) => entry.action === "readThread"), 900);
  });
  check(results, "Fork dispatches exact source Thread", forkActions[0]?.action === "forkThread" && forkActions[0]?.threadId === fixture.secondaryThread.id);
  check(results, "Fork opens returned lineage", document.querySelector(".thread-heading")?.textContent.includes("Forked fixture chat") && forked.forkedFromId === fixture.secondaryThread.id);
  check(results, "Fork navigation updates the Thread deep link", new URL(location.href).searchParams.get("thread") === forked.id, location.search);
  const longThread = structuredClone(fixture.secondaryThread);
  longThread.turns = [{ id: "fixture-long-turn", status: "completed", items: Array.from({ length: 300 }, (_, index) => ({ type: "agentMessage", id: `fixture-long-${index}`, text: `Item ${index}` })) }];
  await hooks.reconcileFixtureThread(longThread);
  const omissionNote = document.querySelector("#turns > .timeline-omission");
  const mountedEntries = document.querySelectorAll("#turns > .timeline-entry:not(.timeline-omission)").length;
  check(results, "mounted timeline discloses its bound", Boolean(omissionNote?.textContent.includes("60 earlier items")) && mountedEntries === 240, `${mountedEntries} mounted · ${omissionNote?.textContent.slice(0, 40) ?? "no disclosure"}`);
  check(results, "deferred mode and realtime controls make no contrary claim", [...document.querySelectorAll(".composer-setting")].every((node) => node.tagName === "SPAN") && !document.querySelector("[data-mode-picker], [aria-label*='realtime' i], [aria-label*='collaboration mode' i]"));

  // --- Model and effort pickers --------------------------------------------
  // Disabled and labelled not-loaded until model/list answers; then exactly
  // the catalog the host returned (hidden models never arrive), the default
  // marked, efforts from the selected model, and the value read from the
  // Thread's settings record or shown as the runtime default without
  // claiming it is set.
  const pickerCatalog = [
    { id: "guard-default", model: "guard-default", displayName: "Guard Default", description: "Takes text and images.", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast." }, { reasoningEffort: "medium", description: "Balanced." }, { reasoningEffort: "high", description: "Thorough." }], inputModalities: ["text", "image"] },
    { id: "guard-text", model: "guard-text", displayName: "Guard Text Only", description: "Takes text only.", isDefault: false, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced." }], inputModalities: ["text"] },
  ];
  const modelPicker = document.querySelector("#modelPicker");
  const effortPicker = document.querySelector("#effortPicker");
  const settingsSource = document.querySelector("#settingsSource");
  const optionsOf = (select) => [...select.options].map((option) => `${option.value}=${option.text}`);
  await hooks.resetModels();
  check(results, "model and effort pickers stay disabled and say not loaded until model/list answers", modelPicker.disabled && effortPicker.disabled && optionsOf(modelPicker).join("|") === "=Not loaded" && optionsOf(effortPicker).join("|") === "=Not loaded" && document.querySelector("#composerSettings").dataset.models === "not-loaded" && settingsSource.textContent === "Model list not loaded from the runtime yet.", `${optionsOf(modelPicker).join("|")} · ${settingsSource.textContent}`);
  const pickerActions = [];
  try { await hooks.withFixtureTransport(async (payload) => {
    pickerActions.push(payload);
    if (payload.action === "listModels") return { models: structuredClone(pickerCatalog) };
    if (payload.action === "startTurn") return { turn: { id: "guard-picker-turn" }, settings: null };
    if (payload.action === "readThread") return { thread: structuredClone(fixture.secondaryThread) };
    return {};
  }, async () => {
    await hooks.loadModels();
    const loadedModels = optionsOf(modelPicker);
    const loadedEfforts = optionsOf(effortPicker);
    check(results, "model and effort pickers offer exactly what listModels returned with defaults marked", !modelPicker.disabled && !effortPicker.disabled
      && loadedModels.join("|") === "guard-default=Guard Default (default)|guard-text=Guard Text Only"
      && loadedEfforts.join("|") === "low=low|medium=medium (default)|high=high"
      && modelPicker.value === "guard-default" && effortPicker.value === "medium"
      && modelPicker.dataset.valueSource === "default" && effortPicker.dataset.valueSource === "default"
      && settingsSource.textContent.startsWith("Not reported for this Chat yet; showing the runtime default")
      && pickerActions.filter((entry) => entry.action === "listModels").length === 1,
      `${loadedModels.join("|")} · ${loadedEfforts.join("|")} · ${settingsSource.textContent}`);

    // A text-only model refuses an image attachment, naming itself and what
    // it accepts, from the Model record; the image-capable default takes it.
    const attachImage = () => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([137, 80, 78, 71])], "guard-shot.png", { type: "image/png" }));
      const input = document.querySelector("#attachmentInput");
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    modelPicker.value = "guard-text";
    modelPicker.dispatchEvent(new Event("change", { bubbles: true }));
    await frame();
    const textEfforts = optionsOf(effortPicker);
    const toast = document.querySelector("#toast");
    attachImage();
    // The file is read asynchronously before the refusal; wait for the
    // refusal itself, not for whatever toast was still showing.
    await waitFor(() => toast.textContent.includes("accepts:"));
    const refusal = toast.textContent;
    const refusedChips = document.querySelectorAll("#attachmentTray .attachment-chip").length;
    modelPicker.value = "guard-default";
    modelPicker.dispatchEvent(new Event("change", { bubbles: true }));
    await frame();
    attachImage();
    await waitFor(() => document.querySelectorAll("#attachmentTray .attachment-chip").length === 1);
    const acceptedChips = document.querySelectorAll("#attachmentTray .attachment-chip").length;
    check(results, "a text-only model refuses image attachments naming its input modalities", textEfforts.join("|") === "medium=medium (default)" && refusal === "Guard Text Only accepts: text" && refusedChips === 0 && acceptedChips === 1, `${refusal} · ${refusedChips}/${acceptedChips} chips`);
    document.querySelector("[data-remove-attachment]")?.click();
    await waitFor(() => document.querySelector("#attachmentTray").hidden);

    // The picked model and effort travel as the exact turn/start settings
    // keys and label the Turn they started.
    modelPicker.value = "guard-text";
    modelPicker.dispatchEvent(new Event("change", { bubbles: true }));
    await frame();
    const sentLine = settingsSource.textContent;
    document.querySelector("#composerInput").value = "Use the text model";
    document.querySelector("#composer").requestSubmit();
    await waitFor(() => pickerActions.some((entry) => entry.action === "readThread"));
    const start = pickerActions.find((entry) => entry.action === "startTurn");
    const labelled = structuredClone(fixture.secondaryThread);
    labelled.turns.push({ id: "guard-picker-turn", status: "completed", items: [{ type: "userMessage", id: "guard-picker-user", content: [{ type: "text", text: "Use the text model" }] }] });
    await hooks.reconcileFixtureThread(labelled);
    const postureLine = document.querySelector('[data-turn-posture="guard-picker-turn"]');
    check(results, "picked model and effort travel as turn/start settings and label the Turn", start?.settings?.model === "guard-text" && start.settings.effort === "medium" && Object.keys(start.settings).sort().join(",") === "effort,model" && sentLine.includes("next Turn sends model guard-text, effort medium") && postureLine?.textContent.startsWith("Guard Text Only · medium") && postureLine.textContent.includes("sent model, effort"), `${JSON.stringify(start?.settings ?? null)} · ${postureLine?.textContent ?? "no posture line"}`);
  }); } catch (error) { check(results, "picker checks completed", false, `threw: ${error?.message ?? error}`); }
  await hooks.resetModels();
  await hooks.switchFixtureThread(fixture.thread);

  // --- Images: paste, drop, several per Turn, removable chips --------------
  // A clipboard image and dropped image files attach beside the plus picker,
  // each chip carries an accessible name and a remove control, and every
  // image travels as the image variant with a data URL (never localImage)
  // and renders as an image in the user message after send.
  const attachmentTray = document.querySelector("#attachmentTray");
  const pngFile = (name) => new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
  const chipLabels = () => [...attachmentTray.querySelectorAll(".attachment-chip")].map((chip) => chip.getAttribute("aria-label"));
  try {
    const pasteTransfer = new DataTransfer();
    pasteTransfer.items.add(pngFile(""));
    composerInput.dispatchEvent(new ClipboardEvent("paste", { clipboardData: pasteTransfer, bubbles: true, cancelable: true }));
    await waitFor(() => attachmentTray.querySelectorAll(".attachment-chip").length === 1);
    check(results, "pasting an image attaches it as a removable chip with an accessible name", chipLabels().join("|") === "Attached image Pasted image 1.png" && Boolean(attachmentTray.querySelector('.attachment-chip[role="group"] img')) && attachmentTray.querySelector("[data-remove-attachment]")?.getAttribute("aria-label") === "Remove Pasted image 1.png" && !attachmentTray.hidden, chipLabels().join("|") || "no chip");
    const dropTransfer = new DataTransfer();
    dropTransfer.items.add(pngFile("guard-a.png"));
    dropTransfer.items.add(pngFile("guard-b.png"));
    const composerForm = document.querySelector("#composer");
    composerForm.dispatchEvent(new DragEvent("dragover", { dataTransfer: dropTransfer, bubbles: true, cancelable: true }));
    const dropMarked = composerForm.classList.contains("drop-target");
    composerForm.dispatchEvent(new DragEvent("drop", { dataTransfer: dropTransfer, bubbles: true, cancelable: true }));
    await waitFor(() => attachmentTray.querySelectorAll(".attachment-chip").length === 3);
    const dropped = chipLabels();
    attachmentTray.querySelector('[data-remove-attachment="1"]')?.click();
    await frame();
    check(results, "dropped images attach beside the pasted one and a chip removes exactly its image", dropMarked && !composerForm.classList.contains("drop-target") && dropped.join("|") === "Attached image Pasted image 1.png|Attached image guard-a.png|Attached image guard-b.png" && chipLabels().join("|") === "Attached image Pasted image 1.png|Attached image guard-b.png", `${dropped.join("|")} → ${chipLabels().join("|")}`);
    const imageActions = [];
    await hooks.withFixtureTransport(async (payload) => {
      imageActions.push(payload);
      if (payload.action === "startTurn") return { turn: { id: "guard-image-turn" }, settings: null };
      if (payload.action === "readThread") return { thread: structuredClone(fixture.thread) };
      return {};
    }, async () => {
      composerInput.value = "Two images";
      composerForm.requestSubmit();
      await waitFor(() => imageActions.some((entry) => entry.action === "readThread"));
      const start = imageActions.find((entry) => entry.action === "startTurn");
      const images = start?.input.filter((item) => item.type === "image") ?? [];
      const replayed = structuredClone(fixture.thread);
      replayed.turns.push({ id: "guard-image-turn", status: "completed", items: [{ type: "userMessage", id: "guard-image-user", content: structuredClone(start?.input ?? []) }] });
      await hooks.reconcileFixtureThread(replayed);
      const rendered = document.querySelectorAll('.turn.user[data-item-id$="guard-image-user"] img.message-image').length;
      check(results, "several images travel as data-URL image inputs and render as images in the user message", images.length === 2 && images.every((item) => /^data:image\/png;base64,/.test(item.url)) && start.input.every((item) => item.type !== "localImage") && start.input[0]?.text === "Two images" && rendered === 2 && attachmentTray.hidden, `${images.length} image inputs · ${rendered} rendered`);
    });
  } catch (error) { check(results, "image attachment checks completed", false, `threw: ${error?.message ?? error}`); }
  for (const remove of attachmentTray.querySelectorAll("[data-remove-attachment]")) remove.click();
  await hooks.switchFixtureThread(fixture.thread);

  // One Project, four scope states: the header, the Tasks gate, the Room
  // cold-start handoff and the explicit import dialog are exercised through
  // the real controls with host-shaped fixtures, then the live Project is
  // restored.
  const projectFixture = await fetch("/project-fixtures.json").then((response) => response.json());
  const originalProject = hooks.currentProject();
  const projectHeader = document.querySelector("#projectHeader");
  const scopeStates = [
    ["bound", "Bound", "scope state bound renders"],
    ["unbound", "Not set up", "scope state unbound renders"],
    ["no-repository", "No repository", "scope state no-repository renders"],
    ["migration-required", "Migration required", "scope state migration-required renders"],
  ];
  for (const [scope, label, name] of scopeStates) {
    await hooks.applyScopeFixture(projectFixture.scopes[scope]);
    const tasksNav = document.querySelector('.primary-nav [data-route="tasks"]');
    const importButton = document.querySelector("#importProject");
    const pill = document.querySelector("#projectScope");
    const inspect = document.querySelector("#projectInspectList")?.textContent ?? "";
    check(results, name, projectHeader.dataset.scope === scope
      && pill.textContent === label
      && tasksNav.getAttribute("aria-disabled") === String(scope !== "bound")
      && importButton.hidden === (scope !== "unbound")
      && document.querySelector("#inboxButton").hidden === (scope !== "bound")
      && inspect.includes("Working folder (cwd)")
      && (scope === "bound" || document.querySelector("#projectNote")?.textContent.length > 20), `${projectHeader.dataset.scope}/${pill.textContent}/${tasksNav.getAttribute("aria-disabled")}/${importButton.hidden}`);
  }
  check(results, "cwd appears only as inspectable metadata", !document.querySelector("#projectName").textContent.includes("/") && !document.querySelector("#projectBranch").textContent.includes("/") && document.querySelector("#projectInspect").tagName === "DETAILS");
  await hooks.applyScopeFixture(projectFixture.scopes.unbound);
  openSidebar.click();
  await frame();
  document.querySelector('.primary-nav [data-route="tasks"]').click();
  await frame();
  const scopePanel = document.querySelector(".scope-panel");
  check(results, "unbound Tasks route explains the missing scope instead of a graph", scopePanel?.dataset.scope === "unbound" && !document.querySelector(".tasks-view") && scopePanel.textContent.includes("uncommitted") && scopePanel.textContent.includes("Chat keeps working") && Boolean(scopePanel.querySelector("[data-open-import]")));
  await hooks.applyScopeFixture(projectFixture.scopes.bound);
  check(results, "bound cold start hands off to distill without inventing a Room tree", document.querySelector("#projectRooms")?.textContent === "Rooms: cold start pending — run distill" && (document.querySelector("#projectInspectList")?.textContent ?? "").includes("no Room tree checked in") && Boolean(document.querySelector(".tasks-view")));
  check(results, "grouping copy never says Project for a Codex ThreadSection", !/Create Project|Move Chat to Project|No Projects yet|New Project name/u.test(document.querySelector("#sidebar").innerHTML) && document.querySelector("#projectLabel").textContent === "Chat groups" && document.querySelector("#createProject").getAttribute("aria-label") === "Create chat group");

  await hooks.applyScopeFixture(projectFixture.scopes.unbound);
  const importTrigger = document.querySelector("#importProject");
  const importActions = [];
  await hooks.withFixtureTransport(async (payload) => {
    importActions.push(payload);
    if (payload.action === "listImportableProjects") return structuredClone(projectFixture.importCandidates);
    if (payload.action === "readThread") return { thread: structuredClone(fixture.thread) };
    return {};
  }, async () => {
    // The trigger lives in the Sidebar: on the narrow frame the drawer must be
    // open (and therefore not inert) before it can take focus, as for the nav.
    openSidebar.click();
    await frame();
    importTrigger.focus();
    importTrigger.click();
    await waitFor(() => document.querySelectorAll(".import-row").length === projectFixture.importCandidates.projects.length);
    const importDialog = document.querySelector("#importDialog");
    const rows = [...document.querySelectorAll(".import-row")];
    const eligible = rows.filter((row) => !row.disabled);
    check(results, "import dialog is a contained modal that lands focus on the first eligible Codex Project", !importDialog.hidden && appShell.inert && eligible.length === 1 && document.activeElement === eligible[0], document.activeElement?.id || document.activeElement?.className);
    check(results, "ineligible Codex Projects stay visible but disabled with their reason", rows.filter((row) => row.disabled).length === 3 && rows.filter((row) => row.disabled).every((row) => row.title.length > 0) && rows.some((row) => row.textContent.includes("Different folder")) && rows.some((row) => row.textContent.includes("2 folders")) && rows.some((row) => row.textContent.includes("No chats")));
    const confirmButton = document.querySelector("#confirmImport");
    const disabledBefore = confirmButton.disabled;
    eligible[0].click();
    await frame();
    const selectionText = document.querySelector("#importSelection").textContent;
    check(results, "selecting an eligible Codex Project names the uncommitted scaffold it will write", disabledBefore && !document.querySelector("#confirmImport").disabled && document.querySelector('.import-row[aria-pressed="true"]')?.dataset.importSection === eligible[0].dataset.importSection && selectionText.includes(".vibehub/codex-project.yaml") && selectionText.includes("uncommitted"));
    const importFocusable = [...importDialog.querySelectorAll("button:not([disabled])")].filter((element) => element.getClientRects().length);
    importFocusable.at(-1).focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    check(results, "import dialog traps forward Tab", document.activeElement === importFocusable[0], document.activeElement?.id);
    auditKeyboard("import dialog");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frame();
    check(results, "import dialog Escape restores focus to its trigger without importing", importDialog.hidden && !appShell.inert && document.activeElement === importTrigger && !importActions.some((entry) => entry.action === "importProject"), document.activeElement?.id);
  });
  await hooks.applyScopeFixture(originalProject);
  openSidebar.click();
  await frame();
  document.querySelector('.primary-nav [data-route="chat"]').click();
  await frame();
  await hooks.switchFixtureThread(fixture.thread);

  // Typed Search from one entry: Chats are native Codex Threads (the
  // app-server's thread/list searchTerm answers through the transport), Tasks
  // and Context stay local to the canonical bootstrap; every group carries its
  // owner label and every result its object type.
  const searchActions = [];
  const nativeHit = { id: "fixture-native-hit", title: "Native hit beyond the listed tail", preview: "Found by thread/list searchTerm", cwd: "/fixture", status: { type: "idle" }, forkedFromId: null, project: null, taskLink: null };
  await hooks.withFixtureTransport(async (payload) => {
    searchActions.push(payload);
    if (payload.action === "searchThreads") return { threads: [structuredClone(nativeHit)], total: 1, limit: payload.limit, searchTerm: payload.searchTerm };
    if (payload.action === "readThread") return { thread: structuredClone(fixture.thread) };
    return {};
  }, async () => {
    searchTrigger.focus();
    searchTrigger.click();
    await frame();
    searchInput.value = "codex";
    searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "codex" }));
    const nativeArrived = await waitFor(() => document.querySelector('.search-result[data-search-source="native"][data-search-id="fixture-native-hit"]'), 90);
    const labels = [...document.querySelectorAll(".search-group-label")].map((node) => node.textContent);
    const bound = hooks.currentProject()?.scope === "bound";
    const dispatched = searchActions.filter((entry) => entry.action === "searchThreads");
    const typed = [...document.querySelectorAll(".search-result")].every((node) => node.querySelector("em")?.textContent === ({ chat: "Chat", task: "Task", context: "Context" })[node.dataset.searchKind]);
    check(results, "search groups are labelled by owner and include a native Thread result", nativeArrived && dispatched.length === 1 && dispatched[0].searchTerm === "codex" && dispatched[0].limit === 20 && labels[0] === "Chats (Codex)" && (!bound || (labels.includes("Tasks (VibeHub)") && labels.includes("Context (Rooms)"))) && typed, `${labels.join(" | ")} · ${dispatched.length} native quer${dispatched.length === 1 ? "y" : "ies"}`);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frame();
  });

  // Task Workspace through the review fixture: the contract, PROOF (Evidence
  // and Outcome handed over from the canonical handoff, with the next-action
  // reason), the packet verbatim, and the persisted Turn input on the
  // transcript card, filled from the replayed Thread item on open.
  const taskFixture = await fetch("/task-fixtures.json").then((response) => response.json());
  const fixtureWorkspace = await hooks.applyTaskFixture(taskFixture, "done");
  const workspaceNode = document.querySelector(".task-workspace");
  const proof = workspaceNode?.querySelector(".proof-section");
  const packetPre = workspaceNode?.querySelector(".packet-inspector pre[data-packet-text]");
  const evidenceIds = (node) => [...(node?.querySelectorAll("[data-evidence-id]") ?? [])].map((item) => item.dataset.evidenceId).join(",");
  check(results, "Task Workspace shows canonical PROOF, Evidence, Outcome and the fixture packet verbatim",
    workspaceNode?.dataset.ticketWorkspace === taskFixture.ticketId
      && proof?.dataset.evidenceCount === String(taskFixture.handoff.evidence.length)
      && evidenceIds(proof) === taskFixture.handoff.evidence.map((item) => item.evidenceId).join(",")
      && proof.querySelector(".outcome-record")?.dataset.outcomeStatus === "successful"
      && proof.querySelector(".proof-next code")?.textContent === "review_fixture"
      && packetPre?.textContent === fixtureWorkspace.packetText
      && fixtureWorkspace.packetText === JSON.stringify(fixtureWorkspace.packet, null, 2)
      && document.querySelector("#routeTitle").textContent === "Review Task Workspace",
    `${proof?.dataset.evidenceCount ?? "no proof"} evidence · ${proof?.dataset.outcomeStatus ?? "?"} · ${packetPre?.textContent.length ?? 0}/${fixtureWorkspace.packetText.length} chars`);
  const rawDetails = document.querySelector("#taskConversationTimeline .packet-raw[data-packet-raw]");
  const persisted = taskFixture.thread.turns[0].items[0].content[0].text;
  if (rawDetails) rawDetails.open = true;
  const rawFilled = await waitFor(() => rawDetails?.querySelector("[data-packet-raw-text]")?.dataset.filled === "true");
  check(results, "Task packet transcript card discloses the persisted Turn input byte-exact", rawFilled && rawDetails.querySelector("[data-packet-raw-text]").textContent === persisted && rawDetails.querySelector("summary").textContent.includes(`${persisted.length.toLocaleString()} chars`), `${rawDetails?.querySelector("[data-packet-raw-text]")?.textContent.length ?? 0}/${persisted.length} chars`);
  auditKeyboard("task workspace");
  const workspaceTopbar = topbarBoxes();
  check(results, "Workspace route title with its back button stays clear of the search trigger", !workspaceTopbar.intersects && !workspaceTopbar.overflow && workspaceTopbar.fullName && !document.querySelector("#backButton").hidden, workspaceTopbar.detail);

  // Deep link: `?task=` reopens the Workspace through the same landing path
  // start() takes, and leaving the Workspace drops it from the URL again.
  const deepLinkActions = [];
  await hooks.withFixtureTransport(async (payload) => {
    deepLinkActions.push(payload);
    if (payload.action === "readTask") return { handoff: structuredClone(taskFixture.handoff), packet: structuredClone(taskFixture.packet), packetText: JSON.stringify(taskFixture.packet, null, 2), evidence: taskFixture.handoff.evidence, outcome: null, nextAction: taskFixture.handoff.nextAction, eligibleContexts: taskFixture.eligibleContexts, rooms: taskFixture.rooms };
    if (payload.action === "readThread") return { thread: structuredClone(taskFixture.thread) };
    return {};
  }, async () => {
    openSidebar.click();
    await frame();
    document.querySelector('.primary-nav [data-route="chat"]').click();
    await frame();
    const deepLink = new URL(location.href);
    deepLink.searchParams.set("task", taskFixture.ticketId);
    history.replaceState(history.state, "", deepLink.href);
    const landed = await hooks.landFromLocation();
    await frame();
    const reopened = document.querySelector(".task-workspace");
    check(results, "task deep link reopens the Workspace through the landing path", landed === true && reopened?.dataset.ticketWorkspace === taskFixture.ticketId && deepLinkActions.some((entry) => entry.action === "readTask" && entry.ticketId === taskFixture.ticketId) && new URL(location.href).searchParams.get("task") === taskFixture.ticketId && reopened.querySelector(".packet-inspector pre[data-packet-text]")?.textContent === JSON.stringify(taskFixture.packet, null, 2), location.search);
    document.querySelector("#backButton").click();
    await frame();
    check(results, "leaving the Workspace drops the task deep link", !new URL(location.href).searchParams.has("task") && !document.querySelector(".task-workspace") && Boolean(document.querySelector(".tasks-view, .scope-panel")), location.search);
    openSidebar.click();
    await frame();
    document.querySelector('.primary-nav [data-route="chat"]').click();
    await frame();
  });

  // With a bound Project the same Workspace is read through the live host:
  // the packet bytes and proof state come from the checked-in repository.
  const liveBootstrap = hooks.currentBootstrap();
  if (liveBootstrap?.project?.scope === "bound" && liveBootstrap.graph.tickets.length) {
    const liveTicketId = liveBootstrap.attention.recentCompletions[0]?.ticketId ?? liveBootstrap.graph.tickets[0].ticketId;
    const liveActions = [];
    await hooks.withFixtureTransport(async (payload) => {
      const data = await hooks.hostAction(payload);
      liveActions.push({ payload, data });
      return data;
    }, async () => {
      await hooks.openTask(liveTicketId);
      await frame();
      const read = liveActions.find((entry) => entry.payload.action === "readTask")?.data;
      const liveWorkspace = document.querySelector(".task-workspace");
      const liveProof = liveWorkspace?.querySelector(".proof-section");
      const livePre = liveWorkspace?.querySelector(".packet-inspector pre[data-packet-text]");
      check(results, "live Task Workspace renders the host PROOF and packet verbatim",
        Boolean(read) && liveWorkspace?.dataset.ticketWorkspace === liveTicketId
          && livePre?.textContent === read.packetText && read.packetText === JSON.stringify(read.packet, null, 2) && read.packet.kind === "vibehub_task_context_packet"
          && liveProof?.dataset.evidenceCount === String(read.evidence.length)
          && evidenceIds(liveProof) === read.evidence.map((item) => item.evidenceId).join(",")
          && liveProof.dataset.outcomeStatus === (read.outcome?.status ?? "pending")
          && liveProof.querySelector(".proof-next code")?.textContent === read.nextAction.reason,
        `${liveTicketId} · ${read?.evidence.length ?? "?"} evidence · ${read?.outcome?.status ?? "pending"} · ${read?.packetText.length ?? 0} chars`);
      openSidebar.click();
      await frame();
      document.querySelector('.primary-nav [data-route="chat"]').click();
      await frame();
    });
  }
  await hooks.switchFixtureThread(fixture.thread);


  // --- The explicit Chat bridge -------------------------------------------
  // Placement first, on the review fixture: Create Task, Attach to Task and
  // Remember exist only on finalized assistant messages (disabled here, since
  // a fixture is never a source of a real write), never on a user message,
  // never on an item of a live Turn and never on a streaming item. The
  // hookPrompt divider the fixture now carries reads Repository instructions.
  const bridgeSelector = "[data-create-task], [data-attach-task], [data-remember]";
  const fixtureAgent = document.querySelector('.turn.assistant[data-item-id$="fixture-agent"]');
  const fixtureBridge = [...(fixtureAgent?.querySelectorAll(bridgeSelector) ?? [])];
  const fixtureUserBridge = document.querySelectorAll(`.turn.user ${bridgeSelector.split(", ").join(", .turn.user ")}`).length;
  const hookDivider = document.querySelector("[data-hook-prompt]");
  check(results, "hookPrompt divider reads Repository instructions from the fixture", hookDivider?.querySelector("span")?.textContent === "Repository instructions" && hookDivider.querySelector("strong")?.textContent.includes("AGENTS.md") && !document.body.textContent.includes("Project instructions"), hookDivider?.textContent.slice(0, 60) ?? "no divider");
  await hooks.switchFixtureThread(fixture.activeThread);
  const liveTurnAgent = document.querySelector('.turn.assistant[data-item-id$="fixture-active-agent"]');
  const liveTurnBridge = liveTurnAgent?.querySelectorAll(bridgeSelector).length ?? -1;
  let streamingAgent = null;
  let streamingBridge = -1;
  // Against a shell without the bridge, a missing hook or anchor is a failed
  // check with its reason, never a stalled run.
  const bridgeFailure = (name, error) => check(results, name, false, `threw: ${error?.message ?? error}`);
  try { await hooks.withFixtureTransport(async (payload) => (payload.action === "readThread" ? { thread: structuredClone(fixture.activeThread) } : {}), async () => {
    // Generation 2 is where the halt window above left the shell; a streamed
    // item of the live Turn arrives through the same path pollEvents takes.
    await hooks.applyEventWindow({ events: [
      { sequence: 11, kind: "notification", value: { method: "item/started", params: { threadId: fixture.activeThread.id, turnId: fixture.activeThread.turns[0].id, item: { id: "guard-streaming-agent", type: "agentMessage", text: "" } } } },
      { sequence: 12, kind: "notification", value: { method: "item/agentMessage/delta", params: { threadId: fixture.activeThread.id, turnId: fixture.activeThread.turns[0].id, itemId: "guard-streaming-agent", delta: "A streaming answer that is not finalized." } } },
    ], cursor: 12, oldestCursor: 1, gap: false, runtimeGeneration: 2, runtimeAlive: true, runtimeState: "alive", runtimeHalt: null, pendingRequests: fixture.pendingRequests });
    streamingAgent = document.querySelector('.turn.assistant[data-item-id$="guard-streaming-agent"]');
    streamingBridge = streamingAgent?.querySelectorAll(bridgeSelector).length ?? -1;
  }); } catch (error) { bridgeFailure("streamed item check completed", error); }
  check(results, "bridge actions appear only on finalized assistant messages",
    fixtureAgent?.dataset.finalized === "true" && fixtureBridge.length === 3 && fixtureBridge.every((button) => button.disabled && button.title.includes("Review fixture"))
      && fixtureUserBridge === 0
      && liveTurnAgent?.dataset.finalized === "false" && liveTurnBridge === 0
      && streamingAgent?.dataset.finalized === "false" && streamingAgent.querySelector(".streaming") && streamingBridge === 0,
    `finalized ${fixtureBridge.length} · user ${fixtureUserBridge} · live Turn ${liveTurnBridge} · streaming ${streamingBridge}`);
  await hooks.switchFixtureThread(fixture.thread);

  // The real bridge runs on a Thread the fixture app-server replays for the
  // bound repository the driver booted: one finalized assistant message. Every
  // host call goes through the live transport and is recorded.
  const bridgeWrites = new URLSearchParams(location.search).get("bridgeWrites") === "1";
  const bridgeBootstrap = hooks.currentBootstrap();
  const seedThread = bridgeBootstrap?.threads.find((thread) => thread.title === "Bridge source chat") ?? null;
  const bridgeSummary = { seeded: Boolean(seedThread), writes: bridgeWrites, ticketId: null, ticketPath: null, attachPath: null, contextPath: null, startedThreadId: null };
  if (seedThread && bridgeBootstrap.project.scope === "bound") {
    const bridgeActions = [];
    try { await hooks.withFixtureTransport(async (payload) => {
      const data = await hooks.hostAction(payload);
      bridgeActions.push({ payload, data });
      return data;
    }, async () => {
      const actionsOf = (name) => bridgeActions.filter((entry) => entry.payload.action === name);
      const selectIn = (node, start, end) => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const texts = [];
        while (walker.nextNode()) texts.push(walker.currentNode);
        const from = texts.find((text) => text.textContent.includes(start));
        const to = texts.find((text) => text.textContent.includes(end));
        const range = document.createRange();
        range.setStart(from, from.textContent.indexOf(start));
        range.setEnd(to, to.textContent.indexOf(end) + end.length);
        const live = window.getSelection();
        live.removeAllRanges();
        live.addRange(range);
        return live.toString();
      };
      await hooks.openThread(seedThread.id);
      await frame();
      const seedMessage = document.querySelector('.turn.assistant[data-finalized="true"]');
      const seedItem = { threadId: seedThread.id, turnId: seedMessage?.dataset.turnId, itemId: seedMessage?.dataset.sourceItem };
      const seedText = seedMessage?.querySelector(".agent-response")?.textContent ?? "";
      const seedSourceText = (await hooks.hostAction({ action: "readThread", threadId: seedThread.id })).thread.turns.flatMap((turn) => turn.items).find((item) => item.id === seedItem.itemId)?.text ?? "";
      const enabledBridge = [...(seedMessage?.querySelectorAll(bridgeSelector) ?? [])];
      check(results, "bridge actions are enabled on the finalized message of a bound real Thread", enabledBridge.length === 3 && enabledBridge.every((button) => !button.disabled && !button.hasAttribute("aria-describedby")) && seedItem.turnId && seedItem.itemId, `${enabledBridge.length} enabled · ${seedItem.turnId}/${seedItem.itemId}`);

      // Unbound: the same actions stay visible but disabled, and both the
      // footer and the selection sheet explain the missing scope.
      await hooks.applyScopeFixture(projectFixture.scopes.unbound);
      await hooks.reconcile();
      const unboundMessage = document.querySelector('.turn.assistant[data-finalized="true"]');
      const unboundBridge = [...(unboundMessage?.querySelectorAll(bridgeSelector) ?? [])];
      const unboundHint = unboundBridge[0] ? document.getElementById(unboundBridge[0].getAttribute("aria-describedby") ?? "") : null;
      const unboundReason = projectFixture.scopes.unbound.reason;
      selectIn(unboundMessage.querySelector(".agent-response"), "account type", "first attempt");
      await waitFor(() => !document.querySelector("#selectionSheet").hidden);
      const sheet = document.querySelector("#selectionSheet");
      const sheetBridge = [...sheet.querySelectorAll("[data-selection-bridge]")];
      check(results, "bridge actions are disabled with the missing scope explained while unbound",
        unboundBridge.length === 3 && unboundBridge.every((button) => button.disabled && button.title === unboundReason && button.getAttribute("aria-describedby") === unboundHint?.id)
          && unboundHint?.textContent.includes(unboundReason) && unboundHint.getClientRects().length > 0
          && sheetBridge.length === 3 && sheetBridge.every((button) => !button.hidden && button.disabled && button.title === unboundReason && button.getAttribute("aria-describedby") === "selectionSheetHint")
          && !document.querySelector("#selectionSheetHint").hidden && document.querySelector("#selectionSheetHint").textContent.includes(unboundReason),
        `${unboundBridge.filter((button) => button.disabled).length}/3 disabled · hint ${unboundHint ? "present" : "missing"} · sheet ${sheetBridge.filter((button) => button.disabled).length}/3 disabled`);
      window.getSelection().removeAllRanges();
      await hooks.applyScopeFixture(bridgeBootstrap.project);
      await hooks.reconcile();
      sheet.hidden = true;

      // Create Task: the sheet is a contained modal that previews through the
      // host (derived id, packet bytes) and writes only on confirmation.
      const createTrigger = document.querySelector('.turn.assistant[data-finalized="true"] [data-create-task]');
      const createDialog = document.querySelector("#createTaskDialog");
      const guardTitle = `Guard login fix ${Date.now().toString(36)}`;
      const guardOutcome = "Login succeeds on the first attempt for every account type.";
      const fillCreate = async () => {
        const title = document.querySelector("#createTaskTitleInput");
        const outcome = document.querySelector("#createTaskOutcome");
        title.value = guardTitle;
        title.dispatchEvent(new InputEvent("input", { bubbles: true }));
        outcome.value = guardOutcome;
        outcome.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return waitFor(() => document.querySelector("#createTaskId").textContent.startsWith("ticket-") && !document.querySelector("#confirmCreateTask").disabled, 120);
      };
      createTrigger.focus();
      createTrigger.click();
      await frame();
      const createContained = !createDialog.hidden && appShell.inert && createDialog.contains(document.activeElement);
      const previewed = await fillCreate();
      const previewCall = actionsOf("previewCreateTask").at(-1);
      const previewOrigin = previewCall?.payload.origin;
      const expectedPreview = previewCall ? await hooks.hostAction({ action: "previewCreateTask", title: guardTitle, outcome: guardOutcome, context: document.querySelector("#createTaskContext").value, origin: previewOrigin }) : null;
      const packetShown = document.querySelector("#createTaskPacket")?.textContent ?? "";
      check(results, "Create Task sheet previews the derived id and the host packet byte for byte from an exact whole-message origin",
        createContained && previewed && expectedPreview
          && previewOrigin?.harness === "codex" && previewOrigin.thread_id === seedThread.id && previewOrigin.turn_id === seedItem.turnId && previewOrigin.item_id === seedItem.itemId && previewOrigin.selection === null && previewOrigin.forked_from_id === null && !Number.isNaN(Date.parse(previewOrigin.captured_at))
          && document.querySelector("#createTaskId").textContent === expectedPreview.ticketId && packetShown === expectedPreview.packetText && packetShown.includes(`"ticketId": "${expectedPreview.ticketId}"`)
          && document.querySelector("#createTaskContext").value.includes(`> — Quoted from Codex thread ${seedThread.id} · turn ${seedItem.turnId} · item ${seedItem.itemId}`)
          && document.querySelector("#createTaskSource").textContent.includes(seedItem.turnId) && document.querySelector("#createTaskSource").textContent.includes("whole message")
          && actionsOf("createTask").length === 0,
        `${document.querySelector("#createTaskId").textContent} · ${packetShown.length}/${expectedPreview?.packetText.length ?? "?"} chars`);
      const createFocusable = [...createDialog.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])")].filter((element) => element.getClientRects().length);
      createFocusable.at(-1).focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      const createTrapped = document.activeElement === createFocusable[0];
      auditKeyboard("create task sheet");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await frame();
      check(results, "Create Task sheet traps Tab, and Escape restores focus to its trigger without writing", createTrapped && createDialog.hidden && !appShell.inert && document.activeElement === createTrigger && actionsOf("createTask").length === 0, document.activeElement?.outerHTML.slice(0, 60));

      if (bridgeWrites) {
        createTrigger.click();
        await frame();
        await fillCreate();
        const ticketId = document.querySelector("#createTaskId").textContent;
        document.querySelector("#confirmCreateTask").click();
        const markerSelector = `.turn-associations [data-association-ticket="${CSS.escape(ticketId)}"][data-association-kind="origin"]`;
        const marked = await waitFor(() => document.querySelector(markerSelector) && createDialog.hidden && document.querySelector("#toast").textContent.includes(actionsOf("createTask").at(-1)?.data?.path ?? "\u0000"), 120);
        const createCall = actionsOf("createTask").at(-1);
        // The confirmation re-previews first; the Ticket is written with the
        // origin that preview validated, captured when this sheet opened.
        const confirmedPreview = actionsOf("previewCreateTask").at(-1);
        const createdRow = hooks.currentBootstrap()?.graph.tickets.find((ticket) => ticket.ticketId === ticketId);
        const marker = document.querySelector(markerSelector);
        const sourceAfter = (await hooks.hostAction({ action: "readThread", threadId: seedThread.id })).thread;
        bridgeSummary.ticketId = ticketId;
        bridgeSummary.ticketPath = createCall?.data?.path ?? null;
        check(results, "Create Task writes one uncommitted draft Ticket with its origin, marks the origin Turn inline and leaves the source Chat unchanged",
          marked && createCall?.payload.ticketId === ticketId && JSON.stringify(createCall.payload.origin) === JSON.stringify(confirmedPreview?.payload.origin) && JSON.stringify({ ...createCall.payload.origin, captured_at: null }) === JSON.stringify({ ...previewOrigin, captured_at: null }) && createCall.data.uncommitted === true && createCall.data.path === `.vibehub/tickets/${ticketId}.yaml`
            && document.querySelector("#toast")?.textContent.includes(createCall.data.path) && document.querySelector("#toast").textContent.includes("uncommitted")
            && createdRow?.capabilities.operational.summary.label === "REFINE" && createdRow.origin?.thread_id === seedThread.id && createdRow.associations[0]?.kind === "origin" && createdRow.associations[0].turnId === seedItem.turnId
            && hooks.currentBootstrap().project.uncommitted.paths.includes(createCall.data.path) && hooks.currentBootstrap().project.uncommitted.committed === false
            && marker.closest(".turn-associations").dataset.associationTurn === seedItem.turnId && marker.textContent.includes("born from this Turn") && marker.textContent.includes("REFINE")
            && sourceAfter.turns.length === 1 && document.querySelector('.turn.assistant[data-finalized="true"] .agent-response')?.textContent === seedText
            && document.querySelector(`.thread-button[data-thread-id="${CSS.escape(seedThread.id)}"] [data-born-tasks]`)?.dataset.bornTasks === "1"
            && document.activeElement === document.querySelector('.turn.assistant[data-finalized="true"] [data-create-task]'),
          `${ticketId} · ${createdRow?.capabilities.operational.summary.label ?? "no row"} · ${sourceAfter.turns.length} Turn · focus ${document.activeElement?.outerHTML.slice(0, 40)}`);

        // Second Task from the same Turn and title: the preview moves to a
        // free id, and the Chat lists both Tasks at the Turn.
        createTrigger.click();
        await frame();
        await fillCreate();
        const secondId = document.querySelector("#createTaskId").textContent;
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await frame();
        check(results, "a second Task from the same Turn and title previews a free id instead of the taken one", secondId === `${ticketId}-2`, secondId);

        // Graph: the new Task is DRAFT · REFINE with its origin; focusing it
        // draws the provenance edge from its source Chat with its own edge
        // kind, and no depends_on edge or count changes.
        openSidebar.click();
        await frame();
        document.querySelector('.primary-nav [data-route="tasks"]').click();
        await frame();
        const relationCount = hooks.currentBootstrap().graph.relations.length;
        const countsBefore = [...document.querySelectorAll(".task-card [data-relation-counts]")].map((node) => node.dataset.relationCounts).join(",");
        const dependsBefore = document.querySelectorAll('.graph-edges path[data-edge-kind="depends_on"]').length;
        const card = document.querySelector(`.task-card[data-ticket-id="${CSS.escape(ticketId)}"]`);
        card?.focus();
        await frame();
        const provenanceEdges = [...document.querySelectorAll('.graph-edges path[data-edge-kind="provenance"]')];
        const chatNode = document.querySelector(`#graphSources [data-graph-chat="${CSS.escape(seedThread.id)}"]`);
        const countsAfter = [...document.querySelectorAll(".task-card [data-relation-counts]")].map((node) => node.dataset.relationCounts).join(",");
        check(results, "Graph lists the new Task as DRAFT · REFINE with its origin and draws a provenance edge for the focused Task without touching depends_on",
          card?.dataset.phase === "DRAFT" && card.dataset.operational === "REFINE" && card.querySelector(".substate")?.textContent === "REFINE" && card.querySelector(".task-origin")?.dataset.originThread === seedThread.id
            && chatNode?.dataset.graphTurn === seedItem.turnId && chatNode.dataset.associationKind === "origin"
            && provenanceEdges.length === 1 && provenanceEdges[0].dataset.provenanceTicket === ticketId && provenanceEdges[0].dataset.provenanceThread === seedThread.id
            && dependsBefore === relationCount && document.querySelectorAll('.graph-edges path[data-edge-kind="depends_on"]').length === relationCount && relationCount === 1
            && countsBefore === countsAfter && card.querySelector("[data-relation-counts]").dataset.relationCounts === "0:0"
            && !hooks.currentBootstrap().graph.relations.some((relation) => relation.dependentTicketId === ticketId || relation.prerequisiteTicketId === ticketId),
          `${card?.dataset.phase}/${card?.dataset.operational} · provenance ${provenanceEdges.length} · depends_on ${dependsBefore}→${document.querySelectorAll('.graph-edges path[data-edge-kind="depends_on"]').length} of ${relationCount} · counts ${countsBefore} → ${countsAfter}`);
        auditKeyboard("task graph with provenance");

        // Attach to Task: the picker lists every open Task the host returns,
        // and Attach appends one provenance reference to the chosen one.
        await hooks.openThread(seedThread.id);
        await frame();
        const attachTrigger = document.querySelector('.turn.assistant[data-finalized="true"] [data-attach-task]');
        attachTrigger.focus();
        attachTrigger.click();
        const attachDialog = document.querySelector("#attachTaskDialog");
        await waitFor(() => document.querySelectorAll(".attach-row").length >= 2, 120);
        const targets = actionsOf("listTaskTargets").at(-1)?.data.tasks ?? [];
        const rows = [...document.querySelectorAll(".attach-row")];
        const attachContained = !attachDialog.hidden && appShell.inert && attachDialog.contains(document.activeElement);
        const bornRow = rows.find((row) => row.dataset.attachTarget === ticketId);
        const openRow = rows.find((row) => row.dataset.attachTarget === "ticket-bridge-open");
        const attachBefore = document.querySelector("#confirmAttachTask").disabled;
        openRow?.click();
        await frame();
        const attachSelection = document.querySelector("#attachTaskSelection").textContent;
        auditKeyboard("attach to task sheet");
        document.querySelector("#confirmAttachTask").click();
        const attachedMarkerSelector = '.turn-associations [data-association-ticket="ticket-bridge-open"][data-association-kind="attached"]';
        const attachedMarked = await waitFor(() => document.querySelector(attachedMarkerSelector) && attachDialog.hidden && document.querySelector("#toast").textContent.includes(actionsOf("attachTask").at(-1)?.data?.path ?? "\u0000"), 120);
        const attachCall = actionsOf("attachTask").at(-1);
        bridgeSummary.attachPath = attachCall?.data?.path ?? null;
        check(results, "Attach to Task lists every open Task the host returns, appends one exact provenance reference and marks the Turn as attached",
          attachContained && rows.length === targets.length && targets.length >= 2 && !targets.some((task) => task.ticketId === "ticket-bridge-closed")
            && rows.every((row) => row.dataset.taskStatus === targets.find((task) => task.ticketId === row.dataset.attachTarget)?.status)
            && bornRow?.textContent.includes("born from a Chat") && bornRow.dataset.taskStatus === "REFINE"
            && attachBefore && attachSelection.includes(`codex-thread:${seedThread.id}/turn:${seedItem.turnId}`) && attachSelection.includes("uncommitted")
            && attachedMarked && attachCall?.payload.threadId === seedThread.id && attachCall.payload.turnId === seedItem.turnId && attachCall.data.added === true && attachCall.data.provenanceRef === `codex-thread:${seedThread.id}/turn:${seedItem.turnId}`
            && document.querySelector("#toast").textContent.includes(attachCall.data.path) && hooks.currentBootstrap().project.uncommitted.paths.includes(attachCall.data.path)
            && hooks.currentBootstrap().graph.tickets.find((ticket) => ticket.ticketId === "ticket-bridge-open")?.relationCounts.prerequisites === 1
            && document.querySelectorAll(".turn-associations [data-association-ticket]").length === 2 && document.activeElement === document.querySelector('.turn.assistant[data-finalized="true"] [data-attach-task]'),
          `${rows.length}/${targets.length} rows · added ${attachCall?.data?.added} · markers ${document.querySelectorAll(".turn-associations [data-association-ticket]").length}`);

        // Quote into Task: the selected passage lands in the new Task's own
        // conversation draft, shown in the Workspace Composer, and reaches
        // the Agent only as startTask.humanMessage inside the host packet.
        const quoteText = selectIn(document.querySelector('.turn.assistant[data-finalized="true"] .agent-response'), "account type", "first attempt");
        const sheetShown = await waitFor(() => !document.querySelector("#selectionSheet").hidden, 60);
        const sheetState = `sheet ${sheetShown ? "shown" : "hidden"} · selection "${window.getSelection().toString()}" · buttons ${[...document.querySelectorAll("[data-selection-bridge]")].map((button) => `${button.dataset.selectionBridge}:${button.hidden ? "hidden" : "visible"}:${button.disabled ? "disabled" : "enabled"}`).join(",")}`;
        document.querySelector('[data-selection-bridge="attach-task"]').click();
        await waitFor(() => !document.querySelector("#attachTaskDialog").hidden && document.querySelectorAll(".attach-row").length >= 2, 120);
        const quoteDialogState = `dialog ${document.querySelector("#attachTaskDialog").hidden ? "hidden" : "open"} · rows ${document.querySelectorAll(".attach-row").length}`;
        document.querySelector(`.attach-row[data-attach-target="${CSS.escape(ticketId)}"]`).click();
        await frame();
        const quoteSourceLine = document.querySelector("#attachTaskSource").textContent;
        document.querySelector("#quoteIntoTask").click();
        const workspaceShown = await waitFor(() => document.querySelector(".task-workspace")?.dataset.ticketWorkspace === ticketId && !document.querySelector("#quoteTray").hidden, 120);
        const workspaceDetail = `${document.querySelector(".task-workspace")?.dataset.ticketWorkspace ?? "no workspace"} · tray ${document.querySelector("#quoteTray").hidden ? "hidden" : "shown"} · toast ${document.querySelector("#toast").textContent.slice(0, 80)}`;
        const pendingQuote = hooks.taskQuoteDraft(ticketId);
        const composerNote = document.querySelector("#composerNote").textContent;
        const trayBeforeStart = document.querySelector("#quoteTray .quote-source")?.textContent ?? "";
        const quotedPacketBefore = actionsOf("startTask").length;
        document.querySelector('[data-task-action="REFINE"]')?.click();
        const started = await waitFor(() => actionsOf("startTask").length > quotedPacketBefore && document.querySelector(".task-workspace") && new URLSearchParams(location.search).get("thread"), 200);
        const startCall = actionsOf("startTask").at(-1);
        const sentPacket = startCall?.data?.payloadText ? JSON.parse(startCall.data.payloadText) : null;
        bridgeSummary.startedThreadId = startCall?.data?.threadId ?? null;
        checkAll(results, "Quote into Task lands in the Task-scoped Composer draft and reaches the Agent only as startTask humanMessage inside the host packet", {
          selectedPassage: quoteText.includes("account type"),
          exactSelectionRange: quoteSourceLine.includes("characters "),
          workspaceShowsPendingQuote: workspaceShown,
          draftKeyedToTask: pendingQuote?.threadId === seedThread.id && pendingQuote.turnId === seedItem.turnId && pendingQuote.itemId === seedItem.itemId && pendingQuote.text.includes("account type"),
          trayNamesSourceThread: Boolean(document.querySelector("#quoteTray .quote-source")?.textContent.includes(seedThread.id)) || trayBeforeStart.includes(seedThread.id),
          composerNoteExplains: composerNote.includes("Pending quote"),
          startSent: started && startCall?.payload.ticketId === ticketId,
          humanMessageCarriesQuote: Boolean(startCall?.payload.humanMessage?.includes(pendingQuote?.text ?? "\u0000")) && startCall.payload.humanMessage.includes(`> — Quoted from Codex thread ${seedThread.id} · turn ${seedItem.turnId} · item ${seedItem.itemId}`),
          packetCarriesItAsHumanMessage: sentPacket?.conversation.humanMessage === startCall?.payload.humanMessage && sentPacket?.task.ticketId === ticketId,
          draftConsumed: hooks.taskQuoteDraft(ticketId) === null && document.querySelector("#quoteTray").hidden,
          noOrdinaryTurn: !actionsOf("startTurn").length && !actionsOf("steerTurn").length,
        }, `${pendingQuote ? "draft held" : "no draft"} · start ${started ? "sent" : "missing"} · humanMessage ${startCall?.payload.humanMessage?.length ?? 0} chars · ${workspaceDetail} · ${sheetState} · ${quoteDialogState}`);

        // Quote into a Task that already has a Thread: the passage goes into
        // that Thread's own Composer draft, shown when the Workspace opens on
        // the linked Thread, and nothing is sent or written until the human
        // sends a Task Turn.
        await hooks.openThread(seedThread.id);
        await frame();
        document.querySelector('.turn.assistant[data-finalized="true"] [data-attach-task]').click();
        await waitFor(() => !document.querySelector("#attachTaskDialog").hidden && document.querySelectorAll(".attach-row").length >= 2, 120);
        document.querySelector(`.attach-row[data-attach-target="${CSS.escape(ticketId)}"]`).click();
        await frame();
        const linkedSelection = document.querySelector("#attachTaskSelection").textContent;
        const taskTurnsBefore = actionsOf("startTaskTurn").length + actionsOf("steerTaskTurn").length;
        document.querySelector("#quoteIntoTask").click();
        const linkedShown = await waitFor(() => document.querySelector(".task-workspace")?.dataset.ticketWorkspace === ticketId && !document.querySelector("#quoteTray").hidden && new URLSearchParams(location.search).get("thread") === startCall?.data?.threadId, 120);
        checkAll(results, "Quote into a Task with a linked Thread lands in that Thread's Composer draft and sends nothing", {
          pickerNamesTheDraft: linkedSelection.includes("adds the passage to its Codex conversation draft"),
          workspaceOpensOnLinkedThread: linkedShown,
          trayNamesSourceThread: Boolean(document.querySelector("#quoteTray .quote-source")?.textContent.includes(seedThread.id)),
          noTaskScopedDraft: hooks.taskQuoteDraft(ticketId) === null,
          composerIsTheTaskConversation: document.querySelector("#composerInput").placeholder === "Message this Task",
          nothingSentOrWritten: actionsOf("startTaskTurn").length + actionsOf("steerTaskTurn").length === taskTurnsBefore && actionsOf("startTask").length === 1 && actionsOf("createTask").length === 1 && actionsOf("attachTask").length === 1,
        }, `${linkedShown ? "shown" : "not shown"} · ${new URLSearchParams(location.search).get("thread")}`);
        document.querySelector("#quoteTray [data-remove-quote]")?.click();
        await frame();

        // Remember: existing Rooms only, prefilled from the selection, the
        // exact source reference shown, one Context written uncommitted.
        await hooks.openThread(seedThread.id);
        await frame();
        const rememberTrigger = document.querySelector('.turn.assistant[data-finalized="true"] [data-remember]');
        rememberTrigger.focus();
        rememberTrigger.click();
        const rememberDialog = document.querySelector("#rememberDialog");
        await waitFor(() => document.querySelectorAll("#rememberRoom option[value]").length >= 2 && document.querySelector("#rememberRoom option[value='product']"), 120);
        const roomOptions = [...document.querySelectorAll("#rememberRoom option")].map((option) => option.value);
        const listedRooms = actionsOf("listRooms").at(-1)?.data.rooms.map((room) => room.room) ?? [];
        const rememberContained = !rememberDialog.hidden && appShell.inert && rememberDialog.contains(document.activeElement);
        document.querySelector("#rememberRoom").value = "product";
        document.querySelector("#rememberType").value = "decision";
        const rememberSummary = `Guard remembered claim ${Date.now().toString(36)}`;
        document.querySelector("#rememberSummary").value = rememberSummary;
        document.querySelector("#rememberTags").value = "login, reliability";
        auditKeyboard("remember sheet");
        document.querySelector("#confirmRemember").click();
        const remembered = await waitFor(() => actionsOf("remember").length && rememberDialog.hidden && hooks.currentBootstrap()?.project.uncommitted.paths.includes(actionsOf("remember").at(-1)?.data?.path) && document.querySelector("#toast").textContent.includes(actionsOf("remember").at(-1)?.data?.path), 120);
        const rememberCall = actionsOf("remember").at(-1);
        const projectedContext = hooks.currentBootstrap()?.contexts.find((item) => item.contextId === rememberCall?.data?.contextId);
        bridgeSummary.contextPath = rememberCall?.data?.path ?? null;
        checkAll(results, "Remember lists only existing Rooms, keeps the exact source reference and writes one uncommitted Context the Rooms now project", {
          containedModal: rememberContained,
          existingRoomsOnly: roomOptions.join(",") === listedRooms.join(",") && listedRooms.includes("product") && listedRooms.includes("product/ux"),
          exactSourceRef: document.querySelector("#rememberSource").textContent.includes(`codex-thread:${seedThread.id}/turn:${seedItem.turnId}/item:${seedItem.itemId}`),
          written: remembered && rememberCall?.payload.room === "product" && rememberCall.payload.type === "decision" && JSON.stringify(rememberCall.payload.tags) === JSON.stringify(["login", "reliability"]),
          sourceIdentityAndQuote: rememberCall?.payload.source.threadId === seedThread.id && rememberCall.payload.source.turnId === seedItem.turnId && rememberCall.payload.source.itemId === seedItem.itemId && rememberCall.payload.source.quote === seedSourceText && rememberCall.payload.detail === seedSourceText,
          uncommittedPath: rememberCall?.data.uncommitted === true && rememberCall.data.path === `.vibehub/rooms/product/${rememberCall.data.contextId}.yaml`,
          toastAndBootstrapNamePath: Boolean(rememberCall) && document.querySelector("#toast").textContent.includes(rememberCall.data.path) && hooks.currentBootstrap().project.uncommitted.paths.includes(rememberCall.data.path),
          roomsProjectIt: projectedContext?.room === "product" && projectedContext.type === "decision" && projectedContext.sourceRef === rememberCall?.data.sourceRef,
          focusRestored: document.activeElement === document.querySelector('.turn.assistant[data-finalized="true"] [data-remember]'),
        }, `${rememberCall?.data?.contextId ?? "not written"} · rooms ${roomOptions.join("|")}`);

        // Origin chip and Return to source: the Workspace names the source
        // Thread, Turn, item and excerpt; Return reopens the Thread on the
        // chat route, scrolled and focused on the exact origin item.
        await hooks.openTask(ticketId);
        await frame();
        const chip = document.querySelector(`.origin-chip[data-task-origin="${CSS.escape(seedThread.id)}"]`);
        const chipText = chip?.textContent ?? "";
        const attachedList = document.querySelectorAll('.origin-attached [data-return-to-source][data-association-kind="attached"]').length;
        chip?.querySelector("[data-return-to-source]")?.click();
        const originKey = itemKey(seedThread.id, seedItem.turnId, seedItem.itemId);
        const returned = await waitFor(() => document.querySelector(".chat-view") && document.activeElement?.dataset?.itemId === originKey, 120);
        const originNode = document.querySelector(`[data-item-id="${CSS.escape(originKey)}"]`);
        const originBox = originNode?.getBoundingClientRect();
        const surfaceBox = document.querySelector("#surface").getBoundingClientRect();
        check(results, "Task Workspace origin chip names the source Thread, Turn and excerpt, and Return to source focuses the exact origin item on the chat route",
          chip?.dataset.originTurn === seedItem.turnId && chip.dataset.originItem === seedItem.itemId && chipText.includes(seedThread.title) && chipText.includes(seedItem.turnId) && chipText.includes("whole message") && chip.querySelector(".origin-excerpt")?.textContent.includes("account type")
            && returned && new URLSearchParams(location.search).get("thread") === seedThread.id && originNode?.dataset.sourceFocus === "true" && originBox.top >= surfaceBox.top - 1 && originBox.bottom <= surfaceBox.bottom + 1
            && document.querySelector("#streamStatus").textContent.includes("Returned to the source Turn"),
          `${returned ? "focused" : "not focused"} · attached ${attachedList} · ${chipText.slice(0, 60)}`);
        window.getSelection().removeAllRanges();
      } else {
        check(results, "bridge write checks are skipped without a driver-owned repository (pass bridgeWrites=1 from the guard driver)", true, "preview, placement and scope checks ran; no write was attempted");
      }
    }); } catch (error) { bridgeFailure("bridge flow checks completed", error); }
    await hooks.switchFixtureThread(fixture.thread);
  } else {
    check(results, "bridge write checks need the seeded source Thread on a bound repository", !bridgeWrites, `seeded ${Boolean(seedThread)} · scope ${bridgeBootstrap?.project?.scope}`);
  }
  window.__VIBEHUB_BRIDGE_GUARD__ = bridgeSummary;

  // The two remaining overlays: the Task inbox and the product boundary notes
  // open as contained modals, take focus, and Escape returns it to the trigger.
  const inboxTrigger = document.querySelector("#inboxButton");
  if (!inboxTrigger.hidden) {
    inboxTrigger.focus();
    inboxTrigger.click();
    await frame();
    const inboxPanel = document.querySelector("#inboxPanel");
    const inboxContained = !inboxPanel.hidden && !inboxPanel.inert && appShell.inert && inboxPanel.contains(document.activeElement);
    auditKeyboard("inbox");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await frame();
    check(results, "inbox opens as a contained modal and Escape restores focus to its trigger", inboxContained && inboxPanel.hidden && inboxPanel.inert && !appShell.inert && document.activeElement === inboxTrigger, document.activeElement?.id);
  }
  const reviewTrigger = document.querySelector("#reviewButton");
  reviewTrigger.focus();
  reviewTrigger.click();
  await frame();
  const reviewPanel = document.querySelector("#reviewPanel");
  const reviewContained = !reviewPanel.hidden && !reviewPanel.inert && appShell.inert && reviewPanel.contains(document.activeElement);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await frame();
  check(results, "boundary notes open as a contained modal and Escape restores focus to its trigger", reviewContained && reviewPanel.hidden && reviewPanel.inert && !appShell.inert && document.activeElement === reviewTrigger, document.activeElement?.id);

  // A long Thread title: the topbar keeps the search trigger reachable and the
  // title ellipsizes inside its own box with the full name still exposed.
  const longTitled = { ...structuredClone(fixture.thread), title: `${fixture.thread.title} — ${"a deliberately long Thread title that has to truncate ".repeat(5).trim()}` };
  await hooks.switchFixtureThread(longTitled);
  const longTopbar = topbarBoxes();
  check(results, "long route title truncates beside the search trigger and keeps its full accessible name", !longTopbar.intersects && longTopbar.truncated && longTopbar.fullName && !longTopbar.overflow && document.querySelector("#routeTitle").textContent === longTitled.title && document.querySelector("#routeTitle").title === longTitled.title, longTopbar.detail);
  await hooks.switchFixtureThread(fixture.thread);

  check(results, "every pointer action has a keyboard path (click targets are operable, scroll regions are reachable)", keyboardGapLog.length === 0, `${keyboardGapLog.length} gap${keyboardGapLog.length === 1 ? "" : "s"}${keyboardGapLog.length ? `: ${keyboardGapLog.slice(0, 6).join(" | ")}` : ""}`);

  // Theme: system preference decides by default, an explicit override wins,
  // and returning to System follows the preference again. (That no browser
  // storage backs any of this is a static proof over the shell sources.)
  const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const canvas = () => getComputedStyle(document.body).backgroundColor;
  const lightCanvas = "rgb(255, 255, 255)";
  const darkCanvas = "rgb(24, 24, 24)";
  const themeToggle = document.querySelector("#themeToggle");
  openSidebar.focus();
  openSidebar.click();
  await frame();
  const followsSystem = document.documentElement.dataset.theme === "system" && canvas() === (systemDark ? darkCanvas : lightCanvas);
  const override = systemDark ? "light" : "dark";
  for (let index = 0; index < 3 && document.documentElement.dataset.theme !== override; index += 1) themeToggle.click();
  await frame();
  const overrideWins = document.documentElement.dataset.theme === override && canvas() === (override === "dark" ? darkCanvas : lightCanvas) && document.querySelector("#themeLabel").textContent === (override === "dark" ? "Dark" : "Light");
  for (let index = 0; index < 3 && document.documentElement.dataset.theme !== "system"; index += 1) themeToggle.click();
  await frame();
  const backToSystem = document.documentElement.dataset.theme === "system" && canvas() === (systemDark ? darkCanvas : lightCanvas);
  check(results, `theme follows the ${systemDark ? "dark" : "light"} system preference, an explicit ${override} override wins, and System follows the preference again`, followsSystem && overrideWins && backToSystem, `${followsSystem}/${overrideWins}/${backToSystem} · ${canvas()}`);
  for (let index = 0; index < 3 && document.documentElement.dataset.theme !== "dark"; index += 1) themeToggle.click();
  closeSidebar.click();
  await frame();
  searchTrigger.focus();
  searchTrigger.click();
  await frame();
  check(results, "dark theme reaches overlay siblings", getComputedStyle(search).backgroundColor !== "rgb(255, 255, 255)", getComputedStyle(search).backgroundColor);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  openSidebar.focus();
  openSidebar.click();
  for (let index = 0; index < 3 && document.documentElement.dataset.theme !== originalTheme; index += 1) themeToggle.click();
  closeSidebar.click();

  check(results, "page has no horizontal overflow", document.documentElement.scrollWidth <= document.documentElement.clientWidth, `${document.documentElement.scrollWidth}/${document.documentElement.clientWidth}`);
  check(results, "reduced-motion contract is queryable", typeof matchMedia("(prefers-reduced-motion: reduce)").matches === "boolean");
  const composer = document.querySelector("#composer");
  const send = document.querySelector("#sendButton");
  const stop = document.querySelector("#stopTurn");
  const running = composer.dataset.turnPosture === "running";
  check(results, "Turn posture is internally coherent", running
    ? Boolean(composer.dataset.currentTurnId) && !stop.hidden && send.getAttribute("aria-label") === "Queue message" && send.textContent === "Queue"
    : !composer.dataset.currentTurnId && stop.hidden && send.getAttribute("aria-label") === "Send message" && send.textContent === "↑");
  check(results, "terminal mixed fixture makes no false live claim", !document.querySelector(".turn-boundary") || !running);

  if (location.href !== originalHref) history.replaceState(history.state, "", originalHref);
  const summary = { ok: results.every((entry) => entry.pass), passed: results.filter((entry) => entry.pass).length, total: results.length, results };
  const output = document.createElement("section");
  output.id = "interactionGuardResult";
  output.className = `interaction-guard-result ${summary.ok ? "pass" : "fail"}`;
  output.setAttribute("role", "status");
  const heading = document.createElement("strong");
  heading.textContent = `${summary.ok ? "PASS" : "FAIL"} browser interaction guard · ${summary.passed}/${summary.total}`;
  const list = document.createElement("ul");
  for (const result of results) {
    const item = document.createElement("li");
    item.dataset.pass = String(result.pass);
    item.textContent = `${result.pass ? "✓" : "✕"} ${result.name}${result.detail ? ` · ${result.detail}` : ""}`;
    list.append(item);
  }
  output.append(heading, list);
  document.body.append(output);
  window.__VIBEHUB_INTERACTION_GUARD__ = summary;
  window.__VIBEHUB_MOTION_AUDIT__ = auditMotion;
  return summary;
}
