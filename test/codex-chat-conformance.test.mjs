import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyChatEvent, boundedText, canonicalTimeline, itemKey, LIVE_ITEM_LIMIT, timelineWindow } from "../apps/codex-first-shell/chat-model.mjs";
import { loadThreadDraft, MAX_DRAFT_THREADS, saveThreadDraft } from "../apps/codex-first-shell/composer-drafts.mjs";
import { clampComposerHeight, composerBounds, COMPOSER_HEIGHT_FALLBACK } from "../apps/codex-first-shell/composer-sizing.mjs";
import {
  createRenderBudget,
  renderAgentMessage,
  renderGeneratedImage,
  renderMarkdown,
  renderMemoryCitations,
  renderTimelineOmission,
  renderToolContent,
  renderUserMedia,
  renderUserMessageText,
} from "../apps/codex-first-shell/chat-renderer.mjs";
import { eventWindow } from "../apps/codex-first-shell/event-window.mjs";
import { threadLocation } from "../apps/codex-first-shell/thread-location.mjs";
import { answersFromDraft, loadRequestDraft, MAX_REQUEST_DRAFTS, pruneRequestDrafts, saveRequestDraft } from "../apps/codex-first-shell/request-drafts.mjs";
import { composeQuotedMessage, parseQuotedMessage } from "../apps/codex-first-shell/quote-source.mjs";
import { planTimelineReconciliation } from "../apps/codex-first-shell/timeline-reconcile.mjs";
import { requestDescriptor, unsupportedServerRequestResult, validateRequestDecision } from "../apps/codex-first-shell/server-request-registry.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("checked-in protocol census classifies every pinned required event", async () => {
  const [lock, census, fixture] = await Promise.all([
    source("packages/codex-adapter/upstream-lock.json").then(JSON.parse),
    source("docs/proposals/codex-chat-conformance/protocol-event-census.json").then(JSON.parse),
    source("apps/codex-first-shell/chat-fixtures.json").then(JSON.parse),
  ]);
  assert.equal(census.baseline.protocolSchemaSha256, lock.codex.protocolSchemaSha256);
  for (const method of lock.requiredNotifications) assert.ok(census.notifications[method], `missing notification classification: ${method}`);
  for (const method of lock.requiredServerRequests) assert.ok(census.serverRequests[method], `missing server-request classification: ${method}`);
  const delegated = fixture.thread.turns.flatMap((turn) => turn.items).find((item) => item.type === "subAgentActivity");
  assert.ok(["started", "interacted", "interrupted"].includes(delegated.kind));
});

test("Codex Chat reducer shares stable identity across replay, deltas, completion, and interruption", async () => {
  const fixture = JSON.parse(await source("apps/codex-first-shell/chat-conformance-fixtures.json"));
  const model = { liveItems: new Map(), turnErrors: new Map() };
  for (const event of fixture.events) assert.equal(applyChatEvent(model, event.method, event.params), true);
  const timeline = canonicalTimeline(fixture.thread, model);
  assert.equal(timeline.filter((item) => item.id === "agent-shared").length, 1, "durable replay must hide a duplicate live item");
  assert.equal(timeline.find((item) => item.id === "agent-shared").text, "Durable completed answer.");
  assert.equal(timeline.find((item) => item.id === "agent-live").text, "Authoritative completed answer.");
  assert.equal(timeline.find((item) => item.id === "tool-live").progress, "Loading page");
  assert.equal(timeline.find((item) => item.type === "turnPlan").plan[1].status, "inProgress");
  assert.match(timeline.find((item) => item.type === "turnDiff").diff, /\+new/);
  assert.equal(timeline.find((item) => item.id === "files-live").output, "Patch applied");
  assert.equal(timeline.filter((item) => item.id === "boundary-turn-interrupted").length, 1);
  assert.equal(timeline.filter((item) => item.id === "error-turn-live").length, 1);
});

test("completed items replace deltas authoritatively and unknown events remain non-mutating", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  applyChatEvent(model, "item/agentMessage/delta", { turnId: "turn", itemId: "answer", delta: "stale" });
  applyChatEvent(model, "item/completed", { turnId: "turn", item: { id: "answer", type: "agentMessage", text: "settled" } });
  const key = itemKey(undefined, "turn", "answer");
  assert.equal(model.liveItems.get(key).text, "settled");
  assert.equal(model.liveItems.get(key)._live, false);
  const size = model.liveItems.size;
  assert.equal(applyChatEvent(model, "item/future/delta", { turnId: "turn", itemId: "future", delta: "raw" }), false);
  assert.equal(model.liveItems.size, size);
});

test("composite identity isolates colliding item ids across Threads and Turns", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  applyChatEvent(model, "item/agentMessage/delta", { threadId: "thread-a", turnId: "turn-a", itemId: "same", delta: "A" });
  applyChatEvent(model, "item/agentMessage/delta", { threadId: "thread-b", turnId: "turn-b", itemId: "same", delta: "B" });
  assert.equal(model.liveItems.size, 2);
  assert.equal(canonicalTimeline({ id: "thread-a", turns: [] }, model)[0].text, "A");
  assert.equal(canonicalTimeline({ id: "thread-b", turns: [] }, model)[0].text, "B");
  assert.notEqual(itemKey("thread-a", "turn-a", "same"), itemKey("thread-b", "turn-b", "same"));
});

test("execution, tool and delegated identities cannot cross Threads or Turns", () => {
  for (const type of ["commandExecution", "mcpToolCall", "collabAgentToolCall"]) {
    const model = { liveItems: new Map(), turnErrors: new Map() };
    applyChatEvent(model, "item/started", { threadId: "thread-a", turnId: "turn-a", item: { id: "same", type, status: "inProgress" } });
    applyChatEvent(model, "item/started", { threadId: "thread-b", turnId: "turn-b", item: { id: "same", type, status: "inProgress" } });
    assert.equal(canonicalTimeline({ id: "thread-a", turns: [] }, model).length, 1);
    assert.equal(canonicalTimeline({ id: "thread-b", turns: [] }, model).length, 1);
    assert.notEqual(canonicalTimeline({ id: "thread-a", turns: [] }, model)[0]._key, canonicalTimeline({ id: "thread-b", turns: [] }, model)[0]._key);
  }
});

test("authoritative Turn completion retires retry, plan, diff and live execution state", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  applyChatEvent(model, "error", { threadId: "thread", turnId: "turn", error: { message: "retry" }, willRetry: true });
  applyChatEvent(model, "turn/plan/updated", { threadId: "thread", turnId: "turn", plan: [{ step: "Retry", status: "inProgress" }] });
  applyChatEvent(model, "turn/diff/updated", { threadId: "thread", turnId: "turn", diff: "stale" });
  applyChatEvent(model, "item/started", { threadId: "thread", turnId: "turn", item: { id: "command", type: "commandExecution", status: "inProgress" } });
  applyChatEvent(model, "turn/completed", { threadId: "thread", turn: { id: "turn", status: "completed" } });
  assert.equal(canonicalTimeline({ id: "thread", turns: [{ id: "turn", status: "completed", items: [] }] }, model).length, 0);
  applyChatEvent(model, "error", { threadId: "thread", turnId: "failed", error: { message: "terminal" }, willRetry: false });
  const failed = canonicalTimeline({ id: "thread", turns: [{ id: "failed", status: "failed", error: { message: "terminal" }, items: [] }] }, model);
  assert.deepEqual(failed.map((item) => item.type), ["turnBoundary"]);
});

test("live reducer memory is bounded before authoritative completion", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  for (let index = 0; index < LIVE_ITEM_LIMIT + 20; index += 1) {
    applyChatEvent(model, "item/started", { threadId: "thread", turnId: "turn", item: { id: `item-${index}`, type: "commandExecution", status: "inProgress" } });
  }
  assert.equal(model.liveItems.size, LIVE_ITEM_LIMIT);
  applyChatEvent(model, "item/agentMessage/delta", { threadId: "thread", turnId: "large", itemId: "answer", delta: "x".repeat(100_000) });
  assert.equal(model.liveItems.get(itemKey("thread", "large", "answer")).text.length, 32_000);
  assert.equal(model.liveItems.get(itemKey("thread", "large", "answer"))._omittedCharacters, 68_000);
  applyChatEvent(model, "item/fileChange/patchUpdated", { threadId: "thread", turnId: "large", itemId: "files", changes: Array.from({ length: 80 }, (_, index) => ({ path: `file-${index}`, diff: "d".repeat(40_000) })) });
  const files = model.liveItems.get(itemKey("thread", "large", "files"));
  assert.equal(files.changes.length, 32);
  assert.equal(files.changes[0].diff.length, 20_000);
});

test("Composer text, Quote identity, and attachments are isolated and bounded by Thread", () => {
  const drafts = new Map();
  saveThreadDraft(drafts, "thread-a", { text: "draft A", quote: { threadId: "thread-a", turnId: "turn-a", itemId: "item-a" }, attachments: [{ type: "image", url: "data:image/png;base64,AA==" }] });
  assert.deepEqual(loadThreadDraft(drafts, "thread-b"), { text: "", quote: null, attachments: [] });
  assert.deepEqual(loadThreadDraft(drafts, null), { text: "", quote: null, attachments: [] });
  assert.equal(loadThreadDraft(drafts, "thread-a").quote.threadId, "thread-a");
  for (let index = 0; index < MAX_DRAFT_THREADS + 2; index += 1) saveThreadDraft(drafts, `thread-${index}`, { text: String(index) });
  assert.equal(drafts.size, MAX_DRAFT_THREADS);
  assert.equal(drafts.has("thread-a"), false);
});

test("pure rich renderer escapes Markdown and visibly bounds malformed code", () => {
  const budget = createRenderBudget({ textCharacters: 160, mediaCharacters: 100 });
  const html = renderMarkdown("<script>alert(1)</script>\n\n[good](https://example.com) [bad](javascript:alert(1))\n```js\n" + "x".repeat(400), budget, 120);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /omitted from this mounted view/);
  assert.match(html, /tabindex="0" aria-label="Code block"/);
});

test("escape-first Markdown renders nested lists, nested quotes and line-start fences as structure", () => {
  assert.equal(renderMarkdown("1. one\n   - a\n     - deep\n   - b\n2. two\n\n3. three"), "<ol><li>one<ul><li>a<ul><li>deep</li></ul></li><li>b</li></ul></li><li>two</li><li>three</li></ol>");
  const quote = renderMarkdown("> quoted **line**\n> - item\n> ```\n> code <b>\n> ```\n> > nested");
  assert.match(quote, /^<blockquote><p>quoted <strong>line<\/strong><\/p><ul><li>item<\/li><\/ul><div class="code-block">/);
  assert.match(quote, /<code>code &lt;b&gt;<\/code>/);
  assert.match(quote, /<blockquote><p>nested<\/p><\/blockquote><\/blockquote>$/);
  assert.equal(renderMarkdown("use ```inline``` here\nnext"), "<p>use <code>inline</code> here<br>next</p>");
  assert.equal(renderMarkdown("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(renderMarkdown("# T #\n###### deep\n#nothash\n***\n- - -"), "<h2>T</h2><h4>deep</h4><p>#nothash</p><hr><hr>");
  assert.equal(renderMarkdown("- a\r\n\t- b\r\nend"), "<ul><li>a<ul><li>b</li></ul></li></ul><p>end</p>");
  assert.equal(renderMarkdown("~~~~\ncode\n~~~\nstill\n~~~~\nafter"), '<div class="code-block"><button type="button" data-copy-code="0" aria-label="Copy code block 1">Copy</button><pre tabindex="0" aria-label="Code block"><code>code\n~~~\nstill</code></pre></div><p>after</p>');
});

test("malformed Markdown stays literal, escaped, bounded and linear", () => {
  const unclosed = renderMarkdown("before\n```js\nconst x = 1;\n<script>alert(1)</script>");
  assert.match(unclosed, /^<p>before<\/p><div class="code-block"><span>js<\/span>/);
  assert.match(unclosed, /&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/code>/);
  assert.doesNotMatch(unclosed, /<script>/);
  assert.equal(renderMarkdown("**unclosed *and `code **bold** <b>` and a_b_c and *em* and ~~gone~~"), "<p>**unclosed *and <code>code **bold** &lt;b&gt;</code> and a_b_c and <em>em</em> and <del>gone</del></p>");
  const links = renderMarkdown("[a_b](https://e.com/a_b_c?x=1&y=2) [js](javascript:alert(1)) [x](https://e.com/\"onmouseover=\"1)");
  assert.match(links, /<a href="https:\/\/e\.com\/a_b_c\?x=1&amp;y=2" target="_blank" rel="noreferrer noopener">a_b<\/a>/);
  assert.doesNotMatch(links, /href="javascript:/);
  assert.doesNotMatch(links, /[^&]"onmouseover/);
  assert.equal(renderMarkdown("<img src=x onerror=alert(1)>\n<!-- c -->"), "<p>&lt;img src=x onerror=alert(1)&gt;<br>&lt;!-- c --&gt;</p>");
  const bomb = renderMarkdown(`${">".repeat(40)} x`);
  assert.equal((bomb.match(/<blockquote>/g) ?? []).length, 9, "nesting depth is capped and the remainder stays literal");
  assert.match(bomb, /&gt;&gt;[^<]* x<\/p>/);
  const started = performance.now();
  for (const input of ["**a ".repeat(8_000), "*a".repeat(16_000), "`a".repeat(16_000), "[a](https://x".repeat(2_000), "- ".repeat(16_000), "> ".repeat(16_000), "1. ".repeat(10_000)]) {
    const html = renderMarkdown(input);
    assert.doesNotMatch(html, /[\uE000\uE001]/, "inline tokens never leak");
    assert.ok(html.length < 400_000, `bounded output for ${input.slice(0, 8)}…, received ${html.length}`);
  }
  assert.ok(performance.now() - started < 1_000, "adversarial inputs stay linear");
});

test("media, generated images, tool images and unknown rich results have truthful fallbacks", () => {
  const image = "data:image/png;base64,AA==";
  assert.match(renderUserMedia([{ type: "image", url: image }]), /<img/);
  const unsupported = renderUserMedia([{ type: "image", url: "https://example.com/private.png", name: "remote" }]);
  assert.match(unsupported, /image source is not mounted/);
  assert.doesNotMatch(unsupported, /@undefined/);
  assert.match(renderGeneratedImage({ result: { imageUrl: image } }), /Generated image/);
  assert.match(renderGeneratedImage({ status: "completed" }), /not mounted by this local carrier/);
  const tool = renderToolContent([
    { type: "text", text: "tool result" },
    { type: "image", data: "AA==", mimeType: "image/png" },
    { type: "resource", uri: "file:///not-mounted" },
    { type: "inputAudio", audioUrl: "data:audio/wav;base64,AA==" },
  ]);
  assert.match(tool, /tool result/);
  assert.match(tool, /Tool image result/);
  assert.match(tool, /resource tool result remains inspectable/);
  assert.match(tool, /Tool audio result remains available/);
});

test("event-window recovery reports loss and runtime generation truthfully", () => {
  const retained = Array.from({ length: 500 }, (_, index) => ({ sequence: index + 2, kind: "notification", value: {} }));
  const lost = eventWindow(retained, 0, 501, { generation: 4, alive: false });
  assert.equal(lost.oldestCursor, 2);
  assert.equal(lost.gap, true);
  assert.equal(lost.runtimeGeneration, 4);
  assert.equal(lost.runtimeAlive, false);
  assert.equal(eventWindow(retained, 1, 501, { generation: 4, alive: true }).gap, false);
});

test("server-request registry never mislabels unsupported requests as approvals", () => {
  const command = { method: "item/commandExecution/requestApproval", params: {} };
  assert.equal(requestDescriptor(command).kind, "commandApproval");
  assert.equal(validateRequestDecision(command, "cancel"), true);
  assert.equal(validateRequestDecision(command, "unknown"), false);
  const dynamic = { method: "item/tool/call", params: {} };
  assert.equal(requestDescriptor(dynamic).supported, false);
  assert.deepEqual(unsupportedServerRequestResult(dynamic), {
    success: false,
    contentItems: [{ type: "inputText", text: "This local VibeHub carrier does not execute client-side dynamic tools." }],
  });
  assert.equal(requestDescriptor({ method: "future/request" }).kind, "unsupported");
});

test("citations preserve full accessible Thread identity and enforce aggregate counts", () => {
  const fullThreadId = "0198d957-f8b5-72a0-a268-46de3a15e807";
  const entries = Array.from({ length: 40 }, (_, index) => ({ path: `docs/${index}.md`, lineStart: 1, note: "source" }));
  const html = renderMemoryCitations({ entries, threadIds: [fullThreadId] }, createRenderBudget({ citationCount: 3 }));
  assert.match(html, new RegExp(fullThreadId));
  assert.match(html, /Copy full source Thread id/);
  assert.match(html, /37 citation entries omitted/);
});

test("agent-message renderer carries compound identity through Copy and Quote actions", () => {
  const key = itemKey("thread", "turn", "answer");
  const html = renderAgentMessage({ id: "answer", _key: key, type: "agentMessage", text: "Answer" });
  assert.match(html, new RegExp(`data-item-id="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, new RegExp(`data-copy-message="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(html, new RegExp(`data-quote-message="${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
});

test("one shared render budget bounds aggregate mounted response text", () => {
  const budget = createRenderBudget({ textCharacters: 1_000, mediaCharacters: 100 });
  const html = Array.from({ length: 8 }, (_, index) => renderAgentMessage({ id: String(index), _key: String(index), type: "agentMessage", text: "x".repeat(500) }, budget)).join("");
  assert.equal(budget.textRemaining, 0);
  assert.match(html, /omitted from this mounted view/);
  assert.ok(html.length < 12_000, `mounted HTML should stay bounded, received ${html.length}`);
});

test("timeline and rich output stay bounded without inferring lifecycle", () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  const thread = { turns: [{ id: "many", status: "completed", items: Array.from({ length: 300 }, (_, index) => ({ id: `item-${index}`, type: "agentMessage", text: String(index) })) }] };
  const timeline = canonicalTimeline(thread, model, { limit: 240 });
  assert.equal(timeline.length, 240);
  assert.equal(timeline[0].id, "item-60");
  assert.equal(timeline.at(-1)._live, false);
  const bounded = boundedText("x".repeat(20_500));
  assert.equal(bounded.text.length, 20_000);
  assert.equal(bounded.omitted, 500);
  assert.equal(bounded.truncated, true);
});

test("Composer growth has one CSS-owned ceiling shared with the JavaScript clamp", async () => {
  const [css, script, host] = await Promise.all([
    source("apps/codex-first-shell/app.css"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
  ]);
  const rule = css.match(/\.composer textarea \{[^}]*min-height: (\d+)px;[^}]*max-height: (\d+)px;/);
  assert.ok(rule, "the textarea rule declares both bounds");
  assert.deepEqual({ min: Number(rule[1]), max: Number(rule[2]) }, { ...COMPOSER_HEIGHT_FALLBACK }, "the script fallback equals the CSS bounds");
  assert.deepEqual(composerBounds({ minHeight: "34px", maxHeight: "190px" }), { min: 34, max: 190 });
  assert.deepEqual(composerBounds({ minHeight: "0px", maxHeight: "none" }), { ...COMPOSER_HEIGHT_FALLBACK });
  assert.deepEqual(composerBounds({ minHeight: "200px", maxHeight: "100px" }), { min: 200, max: 200 }, "an inverted stylesheet never yields max below min");
  assert.equal(clampComposerHeight(900, { min: 34, max: 190 }), 190);
  assert.equal(clampComposerHeight(3, { min: 34, max: 190 }), 34);
  assert.equal(clampComposerHeight(120.5, { min: 34, max: 190 }), 120.5);
  assert.equal(clampComposerHeight(Number.NaN, { min: 34, max: 190 }), 34);
  const autoSize = script.slice(script.indexOf("function autoSizeComposer"), script.indexOf("function captureComposerDraft"));
  assert.match(autoSize, /composerBounds\(getComputedStyle\(textarea\)\)/);
  assert.match(autoSize, /clampComposerHeight\(textarea\.scrollHeight, bounds\)/);
  assert.doesNotMatch(autoSize, /\d{2,}/, "autoSizeComposer carries no numeric ceiling of its own");
  assert.match(host, /\["\/composer-sizing\.mjs", script\("composer-sizing\.mjs"\)\]/);
});

test("thread location follows the visible Thread and preserves token and fixture context", async () => {
  assert.equal(threadLocation("http://127.0.0.1:1/?reviewFrame=narrow#token", "abc"), "http://127.0.0.1:1/?reviewFrame=narrow&thread=abc#token");
  assert.equal(threadLocation("http://127.0.0.1:1/?thread=old&x=1#token", "new"), "http://127.0.0.1:1/?thread=new&x=1#token");
  assert.equal(threadLocation("http://127.0.0.1:1/?thread=old#token", null), "http://127.0.0.1:1/#token");
  assert.equal(threadLocation("http://127.0.0.1:1/#token", null), "http://127.0.0.1:1/#token");
  const [script, host] = await Promise.all([source("apps/codex-first-shell/app.js"), source("scripts/vh-codex-first-shell.mjs")]);
  assert.match(script, /function syncThreadLocation\(\) \{\s*if \(state\.fixtureMode\) return;\s*const next = threadLocation\(location\.href, state\.activeThreadId\);\s*if \(next !== location\.href\) history\.replaceState\(history\.state, "", next\);/);
  const openThreadSource = script.slice(script.indexOf("async function openThread"), script.indexOf("function applyChatNotification"));
  assert.match(openThreadSource, /state\.activeThreadId = threadId;[^]*syncThreadLocation\(\);/);
  for (const name of ["async function newThread", "async function openTask"]) {
    const body = script.slice(script.indexOf(name), script.indexOf("\n}\n", script.indexOf(name)));
    assert.match(body, /syncThreadLocation\(\)/, `${name} keeps the URL on the visible Thread`);
  }
  assert.match(script, /archiveThread[^]*state\.activeThreadId = null;\s*state\.activeThread = null;\s*syncThreadLocation\(\);/);
  assert.match(script, /const requestedThreadId = params\.get\("thread"\);[^]*catch \(error\) \{[^]*syncThreadLocation\(\);[^]*setRoute\("chat"\);/, "a stale deep link lands on Chat instead of bricking the shell");
  assert.match(host, /\["\/thread-location\.mjs", script\("thread-location\.mjs"\)\]/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/i);
});

test("request-user-input drafts survive route changes and resolve to exact answer ids", async () => {
  const store = new Map();
  saveRequestDraft(store, "req-1", { approach: { choice: "__other__", other: "Custom path", direct: "" }, token: { choice: null, other: "", direct: "secret" } });
  assert.deepEqual(answersFromDraft(loadRequestDraft(store, "req-1")), { answers: { approach: { answers: ["Custom path"] }, token: { answers: ["secret"] } }, invalid: false });
  assert.deepEqual(answersFromDraft({ approach: { choice: "Minimal", other: "ignored", direct: "" } }), { answers: { approach: { answers: ["Minimal"] } }, invalid: false }, "an unselected Other value never leaks into the answer");
  assert.equal(answersFromDraft({ approach: { choice: "__other__", other: "   ", direct: "" } }).invalid, true, "the Other sentinel alone is not an answer");
  assert.equal(answersFromDraft({ approach: { choice: null, other: "", direct: "" } }).invalid, true);
  assert.equal(answersFromDraft({}).invalid, true);
  assert.equal(loadRequestDraft(store, "missing"), null);
  saveRequestDraft(store, "req-1", { approach: { choice: null, other: "", direct: "" } });
  assert.equal(store.has("req-1"), false, "an emptied draft is not retained");
  for (let index = 0; index < MAX_REQUEST_DRAFTS + 3; index += 1) saveRequestDraft(store, `req-${index}`, { q: { choice: "A", other: "", direct: "" } });
  assert.equal(store.size, MAX_REQUEST_DRAFTS);
  pruneRequestDrafts(store, new Set(["req-5"]));
  assert.deepEqual([...store.keys()], ["req-5"], "drafts for requests the host no longer reports are dropped");
  const [script, host] = await Promise.all([source("apps/codex-first-shell/app.js"), source("scripts/vh-codex-first-shell.mjs")]);
  assert.match(script, /document\.addEventListener\("input", \(event\) => \{[^]*rememberRequestDraft\(event\.target\);/);
  assert.match(script, /document\.addEventListener\("change", async \(event\) => \{\s*rememberRequestDraft\(event\.target\);/);
  const renderChatSource = script.slice(script.indexOf("function renderChat("), script.indexOf("function primaryPhase"));
  assert.match(renderChatSource, /surface\.innerHTML = `<div class="chat-view">[^]*restoreRequestDrafts\(surface\);/, "a full Chat render restores every pending request draft");
  assert.match(script.slice(script.indexOf("function renderTaskWorkspace"), script.indexOf("function renderRooms")), /restoreRequestDrafts\(surface\)/);
  assert.match(script.slice(script.indexOf("function patchTimeline"), script.indexOf("function renderChat(")), /restoreRequestDrafts\(next\)/);
  assert.match(script, /function setRoute\(route\) \{\s*captureRequestDrafts\(surface\);/, "a route change snapshots pending request forms before the surface is torn down");
  assert.match(script.slice(script.indexOf("function patchTimeline"), script.indexOf("function renderChat(")), /captureRequestDrafts\(existing\);\s*existing\.replaceWith\(next\);/);
  assert.match(script, /const \{ answers, invalid \} = answersFromDraft\(requestDraftFromForm\(form\)\);/);
  assert.match(script, /state\.requestDrafts\.delete\(requestId\)/);
  assert.equal((script.match(/pruneRequestDrafts\(state\.requestDrafts, state\.knownRequestIds\)/g) ?? []).length, 2, "bootstrap and polling both prune resolved requests");
  assert.match(host, /\["\/request-drafts\.mjs", script\("request-drafts\.mjs"\)\]/);
});

test("quote source identity serializes into the Turn input and renders from replayed Thread history", async () => {
  const quote = { text: "first line\nsecond <b>", threadId: "thread-a", turnId: "turn-1", itemId: "agent-7" };
  const composed = composeQuotedMessage(quote, "my question");
  assert.equal(composed, "> first line\n> second <b>\n> — Quoted from Codex thread thread-a · turn turn-1 · item agent-7\n\nmy question");
  const parsed = parseQuotedMessage(composed);
  assert.deepEqual(parsed, { quoted: "> first line\n> second <b>", source: { threadId: "thread-a", turnId: "turn-1", itemId: "agent-7" }, body: "my question" });
  assert.equal(parseQuotedMessage("plain").source, null);
  assert.equal(parseQuotedMessage("not a quote\n> — Quoted from Codex thread a · turn b · item c").source, null, "a source line must close a leading quote block");
  assert.equal(composeQuotedMessage(null, "  text  "), "text");
  assert.equal(composeQuotedMessage({ text: "x" }, ""), "> x", "a quote without identity still quotes");
  const html = renderUserMessageText(composed, createRenderBudget(), { currentThreadId: "thread-a" });
  assert.equal(html, '<blockquote><p>first line<br>second &lt;b&gt;</p></blockquote><small class="quote-source" data-quote-thread="thread-a" data-quote-turn="turn-1" data-quote-item="agent-7" title="Thread thread-a · Turn turn-1 · Item agent-7" aria-label="Quoted from Thread thread-a · Turn turn-1 · Item agent-7">Quoted from a Codex Turn in this Thread</small><p>my question</p>');
  assert.match(renderUserMessageText(composed, createRenderBudget(), { currentThreadId: "other" }), /in another Thread/);
  const hostile = renderUserMessageText("> — Quoted from Codex thread <img onerror=x> · turn b · item c", createRenderBudget());
  assert.doesNotMatch(hostile, /<img/);
  assert.doesNotMatch(renderUserMessageText(composeQuotedMessage({ ...quote, threadId: '"><script>' }, "x"), createRenderBudget()), /<script>/);
  const [script, host] = await Promise.all([source("apps/codex-first-shell/app.js"), source("scripts/vh-codex-first-shell.mjs")]);
  assert.match(script, /const composedText = composeQuotedMessage\(state\.composerQuote, text\);/);
  assert.equal((script.match(/renderUserMessageText\((?:text|message), budget, \{ currentThreadId: item\._threadId \}\)/g) ?? []).length, 2, "ordinary and Task human messages both render replayed quote identity");
  assert.doesNotMatch(script, /function quotePrefix/);
  assert.match(host, /\["\/quote-source\.mjs", script\("quote-source\.mjs"\)\]/);
  assert.doesNotMatch(script + host, /localStorage|sessionStorage|indexedDB/i);
});

test("selection-preserving reconciliation defers only the entries a live selection touches", async () => {
  const current = [{ key: "a", html: "<a1>" }, { key: "b", html: "<b1>" }, { key: "c", html: "<c1>" }, { key: "req", html: "<r1>" }];
  const next = [{ key: "a", html: "<a1>" }, { key: "b", html: "<b2>" }, { key: "c", html: "<c2>" }, { key: "d", html: "<d1>" }];
  assert.deepEqual(planTimelineReconciliation(current, next, new Set(["b", "req"])), {
    order: ["a", "b", "c", "d"],
    mount: ["d"],
    replace: ["c"],
    keep: ["a"],
    defer: ["b", "req"],
    remove: [],
  }, "a selected changed entry and a selected retired entry both hold their mounted node while everything else streams");
  const released = planTimelineReconciliation(current, next, new Set());
  assert.deepEqual([released.defer, released.replace, released.remove], [[], ["b", "c"], ["req"]], "releasing the selection reconciles every held entry");
  assert.deepEqual(planTimelineReconciliation(current, next, new Set(["a"])).defer, [], "an unchanged selected entry needs no deferral");
  const [script, host, css] = await Promise.all([source("apps/codex-first-shell/app.js"), source("scripts/vh-codex-first-shell.mjs"), source("apps/codex-first-shell/app.css")]);
  const patch = script.slice(script.indexOf("function selectionProtectedKeys"), script.indexOf("function renderChat("));
  assert.match(patch, /range\.intersectsNode\(entry\)/);
  assert.match(patch, /planTimelineReconciliation\(/);
  assert.match(patch, /toggleAttribute\("data-paint-deferred", defer\.has\(key\)\)/);
  assert.match(patch, /state\.paintDeferred = plan\.defer\.length > 0/);
  assert.match(script, /document\.addEventListener\("selectionchange", \(\) => \{[^]*if \(state\.paintDeferred && !transcriptSelectionActive\(\)\) scheduleChatRender\(\);/);
  assert.match(script, /if \(selecting\) surface\.scrollTop = heldScrollTop;/, "an active selection is never scrolled out from under the pointer");
  assert.match(script, /keeps its current text until you release the selection/);
  assert.doesNotMatch(script, /selectionDeferralStartedAt|deferredChatRender|1_200/, "no timer-bounded whole-paint deferral remains");
  assert.match(css, /\[data-paint-deferred\]/);
  assert.match(host, /\["\/timeline-reconcile\.mjs", script\("timeline-reconcile\.mjs"\)\]/);
});

test("mounted timeline discloses its 240-item bound instead of truncating silently", async () => {
  const model = { liveItems: new Map(), turnErrors: new Map() };
  const thread = { id: "long", turns: [{ id: "many", status: "completed", items: Array.from({ length: 300 }, (_, index) => ({ id: `item-${index}`, type: "agentMessage", text: String(index) })) }] };
  const mounted = timelineWindow(thread, model, { limit: 240 });
  assert.deepEqual([mounted.items.length, mounted.omitted, mounted.total], [240, 60, 300]);
  assert.equal(mounted.items[0].id, "item-60");
  assert.deepEqual(timelineWindow({ id: "short", turns: [] }, model), { items: [], omitted: 0, total: 0 });
  assert.equal(renderTimelineOmission(0), "");
  assert.match(renderTimelineOmission(60), /^<div class="timeline-entry timeline-omission" data-render-key="timeline-omission" role="note">60 earlier items are not mounted in this view\. Durable Thread history remains authoritative\.<\/div>$/);
  const script = await source("apps/codex-first-shell/app.js");
  assert.match(script, /const mounted = timelineWindow\(thread, state, \{ limit: 240 \}\);[^]*renderTimelineOmission\(mounted\.omitted\) \+ renderTimelineItems\(mounted\.items\)/);
});

test("deferred model, mode, realtime-voice and virtualization checks make no contrary UI claim", async () => {
  const [html, script, host] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
  ]);
  assert.match(html, /<span class="composer-setting" title="Current mode">Agent<\/span>/);
  assert.match(html, /<span class="composer-setting" title="Current runtime">Codex<\/span>/);
  const interactive = [...html.matchAll(/<(?:select|button|input|details)\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(interactive.length > 10);
  for (const tag of interactive) assert.doesNotMatch(tag, /\b(?:model|mode|picker|realtime)\b/i, `no enabled model, mode or realtime control: ${tag}`);
  assert.doesNotMatch(script, /realtime/i, "the browser never renders a realtime voice control");
  assert.match(host, /realtimeConversation: false/);
  assert.match(html, /Realtime conversation stays unavailable until the runtime reports support/);
  assert.match(script, /renderTimelineOmission\(mounted\.omitted\)/, "the 240-item mounted bound discloses itself");
});

test("current shell exposes the conformance interactions without a second transcript", async () => {
  const [html, script, css, host] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/app.css"),
    source("scripts/vh-codex-first-shell.mjs"),
  ]);
  assert.match(html, /type="module"/);
  assert.match(html, /id="quoteSelection"/);
  assert.match(script, /applyChatEvent/);
  assert.match(script, /canonicalTimeline/);
  assert.match(script, /selectionchange/);
  assert.match(script, /patchTimeline/);
  assert.match(script, /preserveScroll && existingTimeline[^]*patchTimeline\(existingTimeline/);
  assert.match(script, /Quote added to your next message/);
  assert.match(script, /data-request-form/);
  assert.match(script, /data-request-other/);
  assert.match(script, /type=\"\$\{question\.isSecret \? \"password\" : \"text\"\}/);
  assert.match(script, /Cancel & interrupt/);
  assert.match(script, /data\.gap/);
  assert.match(script, /runtimeGeneration/);
  assert.match(script, /Retry as a new Turn/);
  assert.match(script, /state\.running.*composer.*stopTurn/s);
  const requestSurface = script.slice(script.indexOf("function approvalMarkup"), script.indexOf("const groupableActivityTypes"));
  assert.doesNotMatch(requestSurface, /\bprompt\(/);
  assert.match(css, /\.quote-selection/);
  assert.match(css, /\.request-option/);
  assert.match(host, /chat-model\.mjs/);
  assert.doesNotMatch(html + script + host, /localStorage|sessionStorage|indexedDB/i);
});

test("audit corrections wire running steer, fork, Thread drafts, drawer semantics, and bounded media", async () => {
  const [html, script, host, projectsAdapter, lockText, guard] = await Promise.all([
    source("apps/codex-first-shell/index.html"),
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("packages/codex-adapter/projects.mjs"),
    source("packages/codex-adapter/upstream-lock.json"),
    source("apps/codex-first-shell/browser-interaction-guard.mjs"),
  ]);
  const lock = JSON.parse(lockText);
  assert.ok(lock.requiredRequests.includes("thread/fork"));
  assert.match(host, /payload\.action === "forkThread"[^]*projects\.forkThread/);
  assert.match(projectsAdapter, /thread\/fork/);
  assert.match(host, /payload\.action === "steerTurn"[^]*turn\/steer/);
  assert.match(host, /payload\.action === "archiveThread"[^]*projects\.archiveThread/);
  assert.match(projectsAdapter, /thread\/archive/);
  assert.match(host, /payload\.action === "setThreadName"[^]*thread\/name\/set/);
  assert.match(script, /state\.running \? "steerTurn" : "startTurn"/);
  assert.match(script, /liveTurnId\(fixture\.thread\)/);
  assert.match(script, /dataset\.turnPosture/);
  assert.match(script, /params\.get\("thread"\)/);
  assert.match(script, /saveThreadDraft\(state\.composerDrafts/);
  assert.match(script, /sidebar\.inert = narrow && !open/);
  assert.match(script, /MAX_ATTACHMENT_BYTES/);
  assert.match(script, /MAX_RECORDING_MS/);
  assert.match(html, /id="routeTitle" tabindex="-1"/);
  assert.match(guard, /window\.__VIBEHUB_INTERACTION_GUARD__/);
});
