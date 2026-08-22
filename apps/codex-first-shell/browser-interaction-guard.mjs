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
  check(results, "active Turn exposes coherent Steer and Stop", activeComposer.dataset.turnPosture === "running" && activeComposer.dataset.currentTurnId === fixture.activeThread.turns[0].id && !document.querySelector("#stopTurn").hidden && document.querySelector("#sendButton").getAttribute("aria-label") === "Steer current turn");
  const steerActions = [];
  await hooks.withFixtureTransport(async (payload) => {
    steerActions.push(payload);
    if (payload.action === "readThread") return { thread: structuredClone(fixture.activeThread) };
    return {};
  }, async () => {
    document.querySelector("#composerInput").value = "Steer this exact active Turn";
    document.querySelector("#composer").requestSubmit();
    await waitFor(() => steerActions.some((entry) => entry.action === "readThread"));
  });
  const steer = steerActions.find((entry) => entry.action === "steerTurn");
  check(results, "active submission dispatches one exact steer", steer?.threadId === fixture.activeThread.id && steer?.expectedTurnId === fixture.activeThread.turns[0].id && !steerActions.some((entry) => entry.action === "startTurn"));
  const interrupted = structuredClone(fixture.activeThread);
  interrupted.status = { type: "idle" };
  interrupted.turns.at(-1).status = "interrupted";
  let terminalForkEnabled = false;
  await hooks.withFixtureTransport(async () => ({}), async () => {
    await hooks.reconcileFixtureThread(interrupted);
    terminalForkEnabled = document.querySelector("#composer").dataset.turnPosture === "idle" && document.querySelector("#stopTurn").hidden && !document.querySelector("[data-fork-thread]").disabled;
  });
  check(results, "terminal reconciliation re-enables Fork", terminalForkEnabled);

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
    await waitFor(() => forkActions.some((entry) => entry.action === "readThread"));
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
  check(results, "deferred model, mode and realtime controls make no contrary claim", [...document.querySelectorAll(".composer-setting")].every((node) => node.tagName === "SPAN") && !document.querySelector("[data-model-picker], [data-mode-picker], [aria-label*='realtime' i], [aria-label*='model' i], [aria-label*='collaboration mode' i]"));
  await hooks.switchFixtureThread(fixture.thread);

  openSidebar.focus();
  openSidebar.click();
  const themeToggle = document.querySelector("#themeToggle");
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
    ? Boolean(composer.dataset.currentTurnId) && !stop.hidden && send.getAttribute("aria-label") === "Steer current turn"
    : !composer.dataset.currentTurnId && stop.hidden && send.getAttribute("aria-label") === "Send message");
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
  return summary;
}
