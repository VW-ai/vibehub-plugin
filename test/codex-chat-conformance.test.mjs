import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { applyChatEvent, boundedText, canonicalTimeline } from "../apps/codex-first-shell-prototype/chat-model.mjs";

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
  assert.equal(model.liveItems.get("answer").text, "settled");
  assert.equal(model.liveItems.get("answer")._live, false);
  const size = model.liveItems.size;
  assert.equal(applyChatEvent(model, "item/future/delta", { turnId: "turn", itemId: "future", delta: "raw" }), false);
  assert.equal(model.liveItems.size, size);
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
