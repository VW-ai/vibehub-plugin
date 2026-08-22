import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyChatEvent, boundedText, canonicalTimeline, itemKey, LIVE_ITEM_LIMIT } from "../apps/codex-first-shell-prototype/chat-model.mjs";
import { loadThreadDraft, MAX_DRAFT_THREADS, saveThreadDraft } from "../apps/codex-first-shell-prototype/composer-drafts.mjs";
import {
  createRenderBudget,
  renderAgentMessage,
  renderGeneratedImage,
  renderMarkdown,
  renderMemoryCitations,
  renderToolContent,
  renderUserMedia,
} from "../apps/codex-first-shell-prototype/chat-renderer.mjs";
import { eventWindow } from "../apps/codex-first-shell-prototype/event-window.mjs";
import { requestDescriptor, unsupportedServerRequestResult, validateRequestDecision } from "../apps/codex-first-shell-prototype/server-request-registry.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("checked-in protocol census classifies every pinned required event", async () => {
  const [lock, census, fixture] = await Promise.all([
    source("packages/codex-adapter/upstream-lock.json").then(JSON.parse),
    source("docs/proposals/codex-chat-conformance/protocol-event-census.json").then(JSON.parse),
    source("apps/codex-first-shell-prototype/chat-fixtures.json").then(JSON.parse),
  ]);
  assert.equal(census.baseline.protocolSchemaSha256, lock.codex.protocolSchemaSha256);
  for (const method of lock.requiredNotifications) assert.ok(census.notifications[method], `missing notification classification: ${method}`);
  for (const method of lock.requiredServerRequests) assert.ok(census.serverRequests[method], `missing server-request classification: ${method}`);
  const delegated = fixture.thread.turns.flatMap((turn) => turn.items).find((item) => item.type === "subAgentActivity");
  assert.ok(["started", "interacted", "interrupted"].includes(delegated.kind));
});

test("Codex Chat reducer shares stable identity across replay, deltas, completion, and interruption", async () => {
  const fixture = JSON.parse(await source("apps/codex-first-shell-prototype/chat-conformance-fixtures.json"));
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

test("current shell exposes the conformance interactions without a second transcript", async () => {
  const [html, script, css, host] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.js"),
    source("apps/codex-first-shell-prototype/app.css"),
    source("scripts/vh-codex-first-shell-prototype.mjs"),
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
  assert.doesNotMatch(script, /\bprompt\(/);
  assert.match(css, /\.quote-selection/);
  assert.match(css, /\.request-option/);
  assert.match(host, /chat-model\.mjs/);
  assert.doesNotMatch(html + script + host, /localStorage|sessionStorage|indexedDB/i);
});

test("audit corrections wire running steer, fork, Thread drafts, drawer semantics, and bounded media", async () => {
  const [html, script, host, lockText, guard] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.js"),
    source("scripts/vh-codex-first-shell-prototype.mjs"),
    source("packages/codex-adapter/upstream-lock.json"),
    source("apps/codex-first-shell-prototype/browser-interaction-guard.mjs"),
  ]);
  const lock = JSON.parse(lockText);
  assert.ok(lock.requiredRequests.includes("thread/fork"));
  assert.match(host, /payload\.action === "forkThread"[^]*thread\/fork/);
  assert.match(host, /payload\.action === "steerTurn"[^]*turn\/steer/);
  assert.match(script, /state\.running \? "steerTurn" : "startTurn"/);
  assert.match(script, /saveThreadDraft\(state\.composerDrafts/);
  assert.match(script, /sidebar\.inert = narrow && !open/);
  assert.match(script, /MAX_ATTACHMENT_BYTES/);
  assert.match(script, /MAX_RECORDING_MS/);
  assert.match(html, /id="routeTitle" tabindex="-1"/);
  assert.match(guard, /window\.__VIBEHUB_INTERACTION_GUARD__/);
});
