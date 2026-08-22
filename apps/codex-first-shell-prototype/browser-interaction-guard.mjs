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
  const openSidebar = document.querySelector("#openSidebar");
  const closeSidebar = document.querySelector("#collapseSidebar");
  const sidebar = document.querySelector("#sidebar");
  const main = document.querySelector(".main-column");

  openSidebar.focus();
  openSidebar.click();
  await frame();
  check(results, "narrow drawer opens", openSidebar.getAttribute("aria-expanded") === "true" && !sidebar.inert && main.inert);
  check(results, "drawer receives focus", sidebar.contains(document.activeElement), document.activeElement?.id);
  closeSidebar.click();
  await frame();
  check(results, "narrow drawer closes", openSidebar.getAttribute("aria-expanded") === "false" && sidebar.inert && !main.inert);
  check(results, "drawer returns focus", document.activeElement === openSidebar, document.activeElement?.id);

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
