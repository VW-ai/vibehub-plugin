import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  FORK_TREE_MAX_DEPTH,
  bringBackQuote,
  forkTreeRows,
  forksOf,
  placementNote,
  resolveLineage,
  sharedTurnPrefix,
} from "../apps/codex-first-shell/fork-review.mjs";
import { composeQuotedMessage, parseQuotedMessage } from "../apps/codex-first-shell/quote-source.mjs";

const fixture = JSON.parse(readFileSync(join(process.cwd(), "apps/codex-first-shell/fork-fixtures.json"), "utf8"));
const threads = fixture.threads;
const byId = (id) => threads.find((thread) => thread.id === id);

// --- Fixture shape: the review family stays internally consistent ----------

test("fork fixture family: every variant opens a listed thread and lineage references resolve or are deliberately missing", () => {
  for (const [variant, threadId] of Object.entries(fixture.openByVariant)) {
    assert.ok(byId(threadId), `variant ${variant} opens a listed thread`);
    assert.ok(fixture.directionsByVariant[variant], `variant ${variant} names its direction`);
  }
  const listed = new Set(threads.map((thread) => thread.id));
  const missing = threads.filter((thread) => thread.forkedFromId && !listed.has(thread.forkedFromId));
  assert.deepEqual(missing.map((thread) => thread.id), ["fork-of-unlisted"], "exactly one fork deliberately names an unlisted source");
  for (const thread of threads) {
    assert.equal(thread.status.type, "idle", `${thread.id} makes no live claim`);
  }
});

test("fork fixture family: inherited Turns repeat the source's Turn ids exactly as thread/fork replays them", () => {
  const source = byId("fork-src-login");
  const pointFork = byId("fork-risky-cleanup");
  const fullFork = byId("fork-prompt-variant");
  assert.equal(pointFork.turns[0].id, source.turns[0].id);
  assert.notEqual(pointFork.turns[1].id, source.turns[1].id, "the point-fork dropped the source's second Turn");
  assert.deepEqual(fullFork.turns.slice(0, 2).map((turn) => turn.id), source.turns.map((turn) => turn.id));
});

// --- Direction A: lineage resolution and honest divergence -----------------

test("resolveLineage finds a listed source, reports an unlisted one missing, and stays null for a root chat", () => {
  const fork = resolveLineage(byId("fork-risky-cleanup"), threads);
  assert.equal(fork.source.id, "fork-src-login");
  assert.equal(fork.missing, false);
  const orphan = resolveLineage(byId("fork-of-unlisted"), threads);
  assert.equal(orphan.source, null);
  assert.equal(orphan.missing, true);
  assert.equal(orphan.sourceId, "0198f000-dead-7000-a000-000000000000");
  assert.equal(resolveLineage(byId("fork-src-login"), threads), null);
});

test("sharedTurnPrefix derives the divergence point from replayed Turn ids instead of inventing a recorded fork point", () => {
  const source = byId("fork-src-login");
  assert.deepEqual(sharedTurnPrefix(byId("fork-risky-cleanup"), source), { shared: 1, sourceTotal: 2, diverged: true });
  assert.deepEqual(sharedTurnPrefix(byId("fork-prompt-variant"), source), { shared: 2, sourceTotal: 2, diverged: true });
  assert.deepEqual(sharedTurnPrefix(byId("fork-of-unlisted"), null), { shared: 0, sourceTotal: 0, diverged: true });
});

test("forksOf lists a chat's forks oldest first and placementNote speaks only when section membership diverges", () => {
  const forks = forksOf("fork-src-login", threads);
  assert.deepEqual(forks.map((thread) => thread.id), ["fork-risky-cleanup", "fork-prompt-variant"]);
  assert.equal(placementNote(byId("fork-risky-cleanup"), byId("fork-src-login")), null, "same group, no note");
  assert.equal(
    placementNote(byId("fork-prompt-variant"), byId("fork-src-login")),
    "This fork lives in Recents; its source lives in the Auth hardening group.",
  );
});

// --- Direction B: sidebar fork tree ----------------------------------------

test("forkTreeRows nests forks under their listed source, keeps unrelated rows flat, and never invents a parent", () => {
  const recents = threads.filter((thread) => !thread.project);
  const rows = forkTreeRows(recents);
  assert.deepEqual(
    rows.map((row) => `${row.thread.id}@${row.depth}`),
    ["fork-prompt-variant@0", "fork-nested-refine@1", "fork-of-unlisted@0", "plain-brainstorm@0"],
    "the nested fork indents under its source, the orphan and the plain chat stay flat",
  );
  const family = forkTreeRows(threads);
  const depths = new Map(family.map((row) => [row.thread.id, row.depth]));
  assert.equal(depths.get("fork-src-login"), 0);
  assert.equal(depths.get("fork-risky-cleanup"), 1);
  assert.equal(depths.get("fork-prompt-variant"), 1);
  assert.equal(depths.get("fork-nested-refine"), 2);
});

test("forkTreeRows caps indentation depth so a long chain stays readable", () => {
  const chain = [{ id: "t0", forkedFromId: null }];
  for (let index = 1; index <= 6; index += 1) chain.push({ id: `t${index}`, forkedFromId: `t${index - 1}` });
  const rows = forkTreeRows(chain);
  assert.equal(Math.max(...rows.map((row) => row.depth)), FORK_TREE_MAX_DEPTH);
  assert.equal(rows.length, chain.length, "capping depth drops no row");
});

// --- Direction C: Bring Back on the shipped quote machinery ----------------

test("bringBackQuote targets the fork's source and carries the fork's exact Thread, Turn and item identity", () => {
  const fork = byId("fork-prompt-variant");
  const payload = bringBackQuote({
    fork,
    turnId: "variant-t3",
    itemId: "variant-t3-agent",
    itemKey: "fork-prompt-variant::variant-t3::variant-t3-agent",
    text: "keep retryOn for the 401 mask, and take the onRetry metric from this variant",
  });
  assert.equal(payload.targetThreadId, "fork-src-login");
  assert.deepEqual(payload.quote, {
    text: "keep retryOn for the 401 mask, and take the onRetry metric from this variant",
    itemKey: "fork-prompt-variant::variant-t3::variant-t3-agent",
    threadId: "fork-prompt-variant",
    turnId: "variant-t3",
    itemId: "variant-t3-agent",
  });
});

test("a brought-back quote serializes the fork identity into the Turn input through the shipped quote machinery", () => {
  const payload = bringBackQuote({
    fork: byId("fork-prompt-variant"),
    turnId: "variant-t3",
    itemId: "variant-t3-agent",
    text: "make any retry observable",
  });
  const message = composeQuotedMessage(payload.quote, "Adopt the metric half in the main direction.");
  const parsed = parseQuotedMessage(message);
  assert.deepEqual(parsed.source, { threadId: "fork-prompt-variant", turnId: "variant-t3", itemId: "variant-t3-agent" });
  assert.equal(parsed.body, "Adopt the metric half in the main direction.");
});

test("bringBackQuote refuses a rootless chat, an empty passage, and an unnamed item instead of guessing", () => {
  const fork = byId("fork-prompt-variant");
  assert.equal(bringBackQuote({ fork: byId("fork-src-login"), turnId: "src-t1", itemId: "src-t1-agent", text: "x" }), null);
  assert.equal(bringBackQuote({ fork, turnId: "variant-t3", itemId: "variant-t3-agent", text: "   " }), null);
  assert.equal(bringBackQuote({ fork, turnId: null, itemId: "variant-t3-agent", text: "x" }), null);
  assert.equal(bringBackQuote({ fork, turnId: "variant-t3", itemId: null, text: "x" }), null);
});
