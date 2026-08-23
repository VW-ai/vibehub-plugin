// The browser side of the explicit Chat bridge: finalized-only placement of
// Create Task, Attach to Task and Remember, exact selection identity, the
// inline association marker, the hookPrompt divider, and the static shape of
// the surfaces (dialogs, focus trap, keyboard paths, no second store). The
// real-DOM flows are proven by the browser interaction guard; these tests pin
// the pure modules and the sources the guard relies on.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { itemKey, timelineWindow } from "../apps/codex-first-shell/chat-model.mjs";
import { bridgeHintId, messageFinalized, renderAgentMessage, renderBridgeActions, renderTurnAssociations } from "../apps/codex-first-shell/chat-renderer.mjs";
import { buildOrigin, codexThreadRef, composeQuotedMessage, describeSelection, locateSelection, sha256Hex, sourceIdentityLabel } from "../apps/codex-first-shell/quote-source.mjs";
import { BRIDGE_REPOSITORY_DOCUMENTS } from "./fixtures/bridge-repository.mjs";
import { validateTicket } from "../skills/scripts/vh.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const bound = { available: true, reason: null };
const unbound = { available: false, reason: "This repository is not set up as a VibeHub Project yet." };
const BRIDGE_ATTRIBUTES = ["data-create-task", "data-attach-task", "data-remember"];
const count = (html, attribute) => (html.match(new RegExp(`${attribute}="`, "g")) ?? []).length;

test("bridge actions render only on finalized assistant messages, never on streaming items or items of a live Turn", () => {
  const key = itemKey("thread", "turn", "answer");
  const finalized = renderAgentMessage({ id: "answer", _key: key, _turnId: "turn", type: "agentMessage", text: "Answer", _live: false, _turnLive: false }, undefined, { bridge: bound });
  for (const attribute of BRIDGE_ATTRIBUTES) assert.equal(count(finalized, attribute), 1, attribute);
  assert.match(finalized, /data-finalized="true"/);
  assert.match(finalized, /data-turn-id="turn"/);
  assert.match(finalized, /data-source-item="answer"/);
  assert.match(finalized, /tabindex="-1"/, "the origin item is a focus anchor for Return to source");
  assert.doesNotMatch(finalized, /disabled|aria-describedby/, "a bound Project offers every action enabled");
  assert.match(finalized, />Create Task<\/button>.*>Attach to Task<\/button>.*>Remember<\/button>/);
  for (const [name, item] of [
    ["streaming delta", { id: "answer", _key: key, _turnId: "turn", type: "agentMessage", text: "Partial", _live: true, _turnLive: true }],
    ["completed item of a live Turn", { id: "answer", _key: key, _turnId: "turn", type: "agentMessage", text: "Done item", _live: false, _turnLive: true }],
    ["live item without Turn state", { id: "answer", _key: key, _turnId: "turn", type: "agentMessage", text: "Partial", _live: true }],
  ]) {
    const html = renderAgentMessage(item, undefined, { bridge: bound });
    for (const attribute of BRIDGE_ATTRIBUTES) assert.equal(count(html, attribute), 0, `${name}: ${attribute}`);
    assert.match(html, /data-finalized="false"/, name);
    assert.match(html, /data-copy-message=.*data-quote-message=/, `${name} keeps the native Copy and Quote`);
    assert.equal(messageFinalized(item), false, name);
  }
  // Without the host-owned availability the renderer offers no bridge at all,
  // and the retired placeholders are gone for good.
  const plain = renderAgentMessage({ id: "answer", _key: key, _turnId: "turn", type: "agentMessage", text: "Answer", _live: false, _turnLive: false });
  for (const attribute of BRIDGE_ATTRIBUTES) assert.equal(count(plain, attribute), 0, attribute);
  assert.doesNotMatch(plain + finalized, /Make Task|Planned VibeHub bridge/);
});

test("while the Project is unbound the actions stay visible but disabled with the missing scope explained twice", () => {
  const key = itemKey("t", "u", "i");
  const html = renderAgentMessage({ id: "i", _key: key, _turnId: "u", type: "agentMessage", text: "Answer", _live: false, _turnLive: false }, undefined, { bridge: unbound });
  const hintId = bridgeHintId(key);
  assert.match(hintId, /^bridge-hint-[A-Za-z0-9_-]+$/u, "the hint id is a valid DOM id");
  for (const attribute of BRIDGE_ATTRIBUTES) {
    const button = html.match(new RegExp(`<button type="button" ${attribute}="[^"]*"([^>]*)>`))?.[1] ?? "";
    assert.match(button, / disabled /, attribute);
    assert.match(button, new RegExp(`aria-describedby="${hintId}"`), attribute);
    assert.match(button, /title="This repository is not set up as a VibeHub Project yet\."/, attribute);
  }
  assert.match(html, new RegExp(`<small class="bridge-hint" id="${hintId}" role="note">Create Task, Attach to Task and Remember need a bound VibeHub Project: This repository is not set up as a VibeHub Project yet\\.</small>`));
  assert.match(renderBridgeActions(key, bound), /data-bridge-available="true"/);
  assert.doesNotMatch(renderBridgeActions(key, bound), /bridge-hint/);
  assert.match(renderBridgeActions(key, { available: false, reason: "<unsafe> & \"quoted\"" }), /&lt;unsafe&gt; &amp; &quot;quoted&quot;/, "the reason is escaped in both title and hint");
});

test("the timeline marks whether each item's Turn is still live, for replayed and streamed items alike", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  model.liveItems.set(itemKey("thread", "running", "streamed"), { id: "streamed", type: "agentMessage", text: "…", _threadId: "thread", _turnId: "running", _key: itemKey("thread", "running", "streamed"), _live: true });
  const thread = { id: "thread", turns: [
    { id: "done", status: "completed", items: [{ id: "a", type: "agentMessage", text: "final" }] },
    { id: "running", status: "inProgress", items: [{ id: "b", type: "agentMessage", text: "persisted while running" }] },
  ] };
  const items = timelineWindow(thread, model).items;
  assert.deepEqual(items.map((item) => [item.id, item._live, item._turnLive]), [["a", false, false], ["b", false, true], ["streamed", true, true]]);
  assert.deepEqual(items.map(messageFinalized), [true, false, false]);
  assert.equal(model.liveItems.get(itemKey("thread", "running", "streamed"))._turnLive, undefined, "the stored live item is never mutated");
});

test("a selection is located in the item's own text, verbatim, across whitespace, or through rendered Markdown, and hashed exactly", async () => {
  const text = "The renderer now keeps the **answer** visually primary.\n\n- Replay is durable history.\n- Live deltas update the same item identity.";
  assert.deepEqual(locateSelection(text, "Replay is durable history."), { start: 59, end: 85, method: "exact" });
  assert.deepEqual(locateSelection(text, "keeps the answer visually"), { start: 17, end: 46, method: "markdown" });
  assert.equal(text.slice(17, 46), "keeps the **answer** visually", "the located span is the Markdown source, markers balanced");
  assert.deepEqual(locateSelection(text, "renderer now\nkeeps"), { start: 4, end: 22, method: "whitespace" });
  assert.equal(text.slice(4, 22), "renderer now keeps");
  assert.deepEqual(locateSelection(text, "Replay is durable history.\nLive deltas"), { start: 59, end: 99, method: "markdown" }, "a selection across list items skips the rendered list markers");
  assert.equal(text.slice(59, 99), "Replay is durable history.\n- Live deltas");
  assert.deepEqual(locateSelection("Every **account type** must log in", "account type must"), { start: 6, end: 27, method: "markdown" });
  assert.equal("Every **account type** must log in".slice(6, 27), "**account type** must");
  assert.equal(locateSelection(text, "not in the message"), null);
  assert.equal(locateSelection(text, "   "), null);
  const slice = text.slice(17, 46);
  assert.equal(await sha256Hex(slice), crypto.createHash("sha256").update(slice).digest("hex"));
  await assert.rejects(() => sha256Hex("x", null), /secure context/);
});

test("the origin the browser sends validates against the Ticket schema with and without a selection", async () => {
  const text = "Explain the login flow and propose a fix.";
  const located = locateSelection(text, "propose a fix");
  const selection = { ...located, text_sha256: await sha256Hex(text.slice(located.start, located.end)) };
  const withSelection = buildOrigin({ threadId: "thr_1", forkedFromId: "thr_0", turnId: "turn_1", itemId: "item_1", selection, capturedAt: "2026-08-22T18:00:00.000Z" });
  assert.deepEqual(withSelection, { harness: "codex", thread_id: "thr_1", forked_from_id: "thr_0", turn_id: "turn_1", item_id: "item_1", selection: { start: 27, end: 40, text_sha256: crypto.createHash("sha256").update("propose a fix").digest("hex") }, captured_at: "2026-08-22T18:00:00.000Z" });
  const whole = buildOrigin({ threadId: "thr_1", turnId: "turn_1", itemId: "item_1" });
  assert.deepEqual([whole.forked_from_id, whole.selection, whole.item_id], [null, null, "item_1"]);
  assert.ok(!Number.isNaN(Date.parse(whole.captured_at)));
  const candidate = (origin) => ({
    schema_version: 2, kind: "ticket", ticket_id: "ticket-born", maturity: "draft", outcome: "Born.", deliveries: [], context: "Born.",
    acceptance: [{ acceptance_id: "refine-after-creation", criterion: "Refine later." }], constraints: [], context_refs: [], relations: [],
    provenance_refs: [codexThreadRef({ threadId: origin.thread_id, turnId: origin.turn_id })], origin,
  });
  assert.deepEqual(validateTicket(candidate(withSelection)), []);
  assert.deepEqual(validateTicket(candidate(whole)), []);
  assert.equal(codexThreadRef({ threadId: "t", turnId: "u", itemId: "i" }), "codex-thread:t/turn:u/item:i");
  assert.equal(codexThreadRef({ threadId: "t", turnId: "u" }), "codex-thread:t/turn:u");
  assert.equal(sourceIdentityLabel({ threadId: "t", turnId: "u", itemId: "i" }), "Thread t · Turn u · Item i");
  assert.equal(describeSelection(null), "whole message");
  assert.match(describeSelection(selection), /^characters 27–40 · sha256 [0-9a-f]{12}…$/u);
  // The quoted context a Create Task writes keeps the exact source line the
  // replayed Chat already understands.
  assert.equal(composeQuotedMessage({ text: "propose a fix", threadId: "thr_1", turnId: "turn_1", itemId: "item_1" }, ""), "> propose a fix\n> — Quoted from Codex thread thr_1 · turn turn_1 · item item_1");
});

test("the inline association marker names every Task of a Turn and links each to its Workspace without a dependency", () => {
  const html = renderTurnAssociations({ turnId: "turn_3", entries: [
    { ticketId: "ticket-born", label: "Born", kind: "origin", status: "REFINE" },
    { ticketId: "ticket-open", label: "Open", kind: "attached", status: "READY" },
  ] });
  assert.match(html, /class="turn-associations" data-turn-id="turn_3" data-association-turn="turn_3" role="group" aria-label="VibeHub Tasks associated with this Turn"/);
  assert.match(html, /<button type="button" class="association-link" data-ticket-id="ticket-born" data-association-ticket="ticket-born" data-association-kind="origin"[^>]*><strong>Born<\/strong><small>born from this Turn · REFINE<\/small><\/button>/);
  assert.match(html, /data-association-kind="attached"[^>]*><strong>Open<\/strong><small>attached to this Turn · READY<\/small>/);
  assert.doesNotMatch(html, /depends_on|relation/);
  assert.equal(renderTurnAssociations({ turnId: "turn_3", entries: [] }), "");
});

test("the hookPrompt divider never reads Project instructions and the fixtures render one", async () => {
  const [script, html, renderer, css, chatFixture, conformanceFixture] = await Promise.all([
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/chat-renderer.mjs"),
    source("apps/codex-first-shell/app.css"),
    source("apps/codex-first-shell/chat-fixtures.json"),
    source("apps/codex-first-shell/chat-conformance-fixtures.json"),
  ]);
  assert.doesNotMatch(script + html + renderer + css, /Project instructions/, "Project names only the repository-bound VibeHub Project");
  assert.match(script, /if \(item\.type === "hookPrompt"\) return `<div class="timeline-divider" data-hook-prompt="\$\{escapeHtml\(identity\)\}"><span>Repository instructions<\/span>/);
  for (const [name, text] of [["chat fixture", chatFixture], ["conformance fixture", conformanceFixture]]) {
    const fixture = JSON.parse(text);
    const hook = fixture.thread.turns.flatMap((turn) => turn.items).find((item) => item.type === "hookPrompt");
    assert.ok(hook, `${name} carries a hookPrompt item`);
    assert.ok(hook.fragments.length && hook.fragments.every((fragment) => typeof fragment.hookRunId === "string" && typeof fragment.text === "string"), `${name} hookPrompt fragments follow the protocol shape`);
  }
});

test("bridge surfaces are contained modals with keyboard paths, exact action shapes and no second store", async () => {
  const [script, html, css, guard, driver, contractText, readme] = await Promise.all([
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.css"),
    source("apps/codex-first-shell/browser-interaction-guard.mjs"),
    source("scripts/vh-codex-first-shell-guard.mjs"),
    source("docs/proposals/codex-native-chat/chat-ui-contract.json"),
    source("docs/proposals/codex-chat-conformance/README.md"),
  ]);
  // Three dialogs, each a modal that joins the shared Tab trap, closes on
  // Escape and on the scrim, and restores focus to its trigger.
  for (const id of ["createTaskDialog", "attachTaskDialog", "rememberDialog"]) {
    assert.match(html, new RegExp(`<section class="bridge-dialog" id="${id}" role="dialog" aria-modal="true" aria-labelledby="[a-zA-Z]+" hidden inert>`), id);
  }
  assert.match(script, /const BRIDGE_DIALOG_IDS = \["createTaskDialog", "attachTaskDialog", "rememberDialog"\];/);
  assert.match(script, /\$\("#inboxPanel"\), \$\("#reviewPanel"\), \.\.\.BRIDGE_DIALOG_IDS\.map\(\(id\) => \$\(`#\$\{id\}`\)\)/, "the bridge dialogs join the shared focus trap");
  assert.match(script, /else if \(openBridgeDialog\(\)\) closeOpenBridgeDialog\(\);/, "Escape closes the open bridge dialog");
  assert.match(script, /state\.overlayReturnFocus = trigger \?\? document\.activeElement;/);
  assert.match(script, /returnTo\?\.focus\?\.\(\{ preventScroll: true \}\);/);
  assert.match(script, /Boolean\(openBridgeDialog\(\)\)/, "an open bridge dialog raises the scrim and inerts the shell");
  // Action shapes, verbatim against the host.
  assert.match(script, /action: "previewCreateTask", \.\.\.fields, origin: bridge\.source\.origin/);
  assert.match(script, /action: "createTask", \.\.\.createTaskFields\(\), origin: bridge\.source\.origin, ticketId: preview\.ticketId/, "the confirmed id is the one the host derived");
  assert.match(script, /action: "attachTask", ticketId, threadId: bridge\.source\.identity\.threadId, turnId: bridge\.source\.identity\.turnId/);
  assert.match(script, /action: "listTaskTargets"/);
  assert.match(script, /action: "listRooms"/);
  assert.match(script, /action: "remember",\s*\.\.\.fields,\s*source: \{ threadId: bridge\.source\.identity\.threadId, turnId: bridge\.source\.identity\.turnId, itemId: bridge\.source\.identity\.itemId, quote: bridge\.source\.quote\.text \}/);
  assert.match(script, /error\.code === "ticket_exists"/, "a taken id re-previews instead of renaming");
  assert.match(script, /error\.code === "room_missing"/, "a missing Room refreshes the picker and explains");
  assert.match(html, /<select id="rememberType">(?:<option value="(?:intent|decision|constraint|contract|convention|change|note)"[^>]*>[a-z]+<\/option>){7}<\/select>/, "the type select is exactly the Context schema enum");
  // Quote into Task: an in-memory Task-scoped draft, sent only as humanMessage.
  assert.match(script, /taskQuoteDrafts: new Map\(\)/);
  assert.match(script, /const humanMessage = composeQuotedMessage\(state\.composerQuote, \$\("#composerInput"\)\.value\) \|\| null;\s*const started = await action\(\{ action: "startTask", ticketId, selectedContextIds: \[\.\.\.state\.taskSelectedContextIds\], \.\.\.\(humanMessage \? \{ humanMessage \} : \{\}\) \}\);/);
  assert.match(script, /saveThreadDraft\(state\.composerDrafts, linked\.id, \{ \.\.\.loadThreadDraft\(state\.composerDrafts, linked\.id\), quote \}\);/, "a linked Thread takes the quote into its own Composer draft");
  assert.doesNotMatch(script + html, /localStorage|sessionStorage|indexedDB|caches\.open/i);
  // Finalized-only placement in the app: only the agent-message renderer
  // receives the bridge, and user messages never render actions.
  assert.match(script, /renderAgentMessage\(item, budget, \{ bridge: bridgeAvailability\(\) \}\)/);
  assert.equal((script.match(/renderBridgeActions/g) ?? []).length, 0, "app.js never renders bridge actions outside the agent-message renderer");
  assert.match(script, /if \(state\.fixtureMode\) return \{ available: false, reason: "Review fixture only/, "a review fixture is never a source of a real write");
  // Presentation provenance: markers, origin chip, Graph edge kind, sidebar.
  assert.match(script, /renderTurnAssociations\(\{ turnId: currentTurnId, entries:/);
  assert.match(script, /data-edge-kind="provenance"/);
  assert.match(script, /data-edge-kind="depends_on"/);
  assert.match(script, /data-return-to-source data-source-thread=/);
  assert.match(script, /node\.scrollIntoView\(\{ block: "center", behavior: "instant" \}\);\s*node\.dataset\.sourceFocus = "true";/);
  assert.match(script, /data-born-tasks="\$\{born\.size\}"/, "sidebar Chat rows count the Tasks born from them");
  assert.match(script, /class="task-origin" data-origin-thread=/, "Graph cards name their origin");
  assert.match(script, /if \(\["BLOCKED", "DEVIATED", "REFINE"\]\.includes\(operational\)\) return operational;/, "a draft Task reads REFINE in the Graph");
  for (const rule of [".bridge-dialog", ".bridge-form", ".attach-row", ".turn-associations", ".association-link", ".origin-chip", ".origin-excerpt", ".graph-sources", ".graph-chat", ".selection-sheet", ".bridge-hint", ".task-origin"]) assert.match(css, new RegExp(rule.replace(".", "\\.")));
  assert.match(css, /\.graph-edges path\[data-edge-kind="provenance"\] \{[^}]*stroke-dasharray/);
  assert.match(css, /body\[data-review-frame="narrow"\] \.bridge-dialog \{ position: absolute;/);
  // The guard: every new pointer target has a keyboard path, and the
  // negatively controlled checks exist by name.
  for (const selector of ["[data-create-task]", "[data-attach-task]", "[data-remember]", "[data-selection-bridge]", "[data-attach-target]", "[data-return-to-source]", "[data-graph-chat]", "[data-association-ticket]"]) assert.ok(guard.includes(`"${selector}"`), `${selector} is audited for a keyboard path`);
  for (const behavior of [
    "bridge actions appear only on finalized assistant messages",
    "hookPrompt divider reads Repository instructions from the fixture",
    "bridge actions are enabled on the finalized message of a bound real Thread",
    "bridge actions are disabled with the missing scope explained while unbound",
    "Create Task sheet previews the derived id and the host packet byte for byte from an exact whole-message origin",
    "Create Task sheet traps Tab, and Escape restores focus to its trigger without writing",
    "Create Task writes one uncommitted draft Ticket with its origin, marks the origin Turn inline and leaves the source Chat unchanged",
    "a second Task from the same Turn and title previews a free id instead of the taken one",
    "Graph lists the new Task as DRAFT · REFINE with its origin and draws a provenance edge for the focused Task without touching depends_on",
    "Attach to Task lists every open Task the host returns, appends one exact provenance reference and marks the Turn as attached",
    "Quote into Task lands in the Task-scoped Composer draft and reaches the Agent only as startTask humanMessage inside the host packet",
    "Remember lists only existing Rooms, keeps the exact source reference and writes one uncommitted Context the Rooms now project",
    "Task Workspace origin chip names the source Thread, Turn and excerpt, and Return to source focuses the exact origin item on the chat route",
  ]) assert.ok(guard.includes(`"${behavior}"`), behavior);
  // The driver never serves this checkout: bridge writes land in a temporary
  // copy of the fixture repository and are verified on disk, then discarded.
  assert.match(driver, /const repo = createBridgeRepository\(\{ prefix: "vibehub-guard-repo-" \}\);/);
  assert.match(driver, /"--repo", repo\.folder/);
  assert.doesNotMatch(driver, /"--repo", root/);
  assert.match(driver, /if \(shell\) url\.searchParams\.set\("bridgeWrites", "1"\);/);
  assert.match(driver, /function verifyBridgeWrites\(shell, bridge, tag\)/);
  assert.match(driver, /validateTicket\(ticket\)\.length === 0/);
  assert.match(driver, /commitCount\(shell\.repo\.folder\) === shell\.repo\.commits/);
  assert.match(driver, /resetBridgeRepository/);
  assert.equal(BRIDGE_REPOSITORY_DOCUMENTS[".vibehub/tickets/ticket-bridge-open.yaml"].relations.length, 1, "the fixture graph carries one depends_on so the unchanged count is a real number");
  // Documentation names the shipped actions.
  assert.deepEqual(JSON.parse(contractText).vibehubBoundary.additiveActions, ["Create Task", "Attach to Task", "Remember", "Open related Task"]);
  assert.doesNotMatch(readme, /disabled `Remember` and `Make Task` controls/);
});
