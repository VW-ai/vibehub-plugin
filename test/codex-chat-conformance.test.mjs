import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyChatEvent, boundedText, canonicalTimeline, itemKey } from "../apps/codex-first-shell-prototype/chat-model.mjs";
import {
  createRenderBudget,
  renderAgentMessage,
  renderGeneratedImage,
  renderMarkdown,
  renderMemoryCitations,
  renderToolContent,
  renderUserMedia,
} from "../apps/codex-first-shell-prototype/chat-renderer.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Codex Chat reducer shares stable identity across replay, deltas, completion, and interruption", async () => {
  const fixture = JSON.parse(await source("apps/codex-first-shell-prototype/chat-conformance-fixtures.json"));
  const model = { liveItems: new Map(), turnErrors: new Map() };
  for (const event of fixture.events) assert.equal(applyChatEvent(model, event.method, event.params), true);
  const timeline = canonicalTimeline(fixture.thread, model);
  assert.equal(timeline.filter((item) => item.id === "agent-shared").length, 1, "durable replay must hide a duplicate live item");
  assert.equal(timeline.find((item) => item.id === "agent-shared").text, "Durable completed answer.");
  assert.equal(timeline.find((item) => item.id === "agent-live").text, "Authoritative completed answer.");
  assert.equal(timeline.find((item) => item.id === "tool-live").progress, "Loading page");
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
  ]);
  assert.match(tool, /tool result/);
  assert.match(tool, /Tool image result/);
  assert.match(tool, /resource tool result remains inspectable/);
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
  assert.match(script, /Retry as a new Turn/);
  assert.match(script, /state\.running.*composer.*stopTurn/s);
  assert.doesNotMatch(script, /\bprompt\(/);
  assert.match(css, /\.quote-selection/);
  assert.match(css, /\.request-option/);
  assert.match(host, /chat-model\.mjs/);
  assert.doesNotMatch(html + script + host, /localStorage|sessionStorage|indexedDB/i);
});
