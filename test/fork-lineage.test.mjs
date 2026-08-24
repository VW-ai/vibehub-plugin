// Node tests over the production fork-lineage projection
// (apps/codex-first-shell/fork-lineage.mjs) the shipped source chip, fork
// listing and Bring Back consume. The review fixtures stand in for listed
// Thread rows and replayed transcripts; nothing here invents a fork point —
// every derivation is from forkedFromId and the shared Turn-id prefix alone.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  bringBackQuote,
  divergenceNote,
  forksOf,
  placementNote,
  resolveLineage,
  sharedTurnPrefix,
} from "../apps/codex-first-shell/fork-lineage.mjs";
import { composeQuotedMessage, parseQuotedMessage } from "../apps/codex-first-shell/quote-source.mjs";

const fixture = JSON.parse(readFileSync(join(process.cwd(), "apps/codex-first-shell/fork-fixtures.json"), "utf8"));
const threads = fixture.threads;
const byId = (id) => threads.find((thread) => thread.id === id);

test("production lineage: a listed source resolves with its record, an unlisted one is missing with its id named, a root chat has none", () => {
  const fork = resolveLineage(byId("fork-risky-cleanup"), threads);
  assert.equal(fork.source.id, "fork-src-login");
  assert.equal(fork.missing, false);
  const orphan = resolveLineage(byId("fork-of-unlisted"), threads);
  assert.equal(orphan.source, null);
  assert.equal(orphan.missing, true);
  assert.equal(orphan.sourceId, "0198f000-dead-7000-a000-000000000000");
  assert.equal(resolveLineage(byId("fork-src-login"), threads), null);
  assert.equal(resolveLineage(null, threads), null);
});

test("production lineage: the shared Turn prefix is derived from replayed Turn ids, never from a persisted fork point", () => {
  const source = byId("fork-src-login");
  assert.deepEqual(sharedTurnPrefix(byId("fork-risky-cleanup"), source), { shared: 1, sourceTotal: 2, diverged: true });
  assert.deepEqual(sharedTurnPrefix(byId("fork-prompt-variant"), source), { shared: 2, sourceTotal: 2, diverged: true });
  assert.deepEqual(sharedTurnPrefix({ turns: source.turns.slice(0, 1) }, source), { shared: 1, sourceTotal: 2, diverged: false });
  assert.deepEqual(sharedTurnPrefix(byId("fork-of-unlisted"), null), { shared: 0, sourceTotal: 0, diverged: true });
});

test("production lineage: the chip's derived note reads from the transcripts or is withheld, never invented", () => {
  const source = byId("fork-src-login");
  assert.equal(divergenceNote(byId("fork-risky-cleanup"), source), "shares 1 of 2 source Turns, then diverges");
  assert.equal(divergenceNote(byId("fork-prompt-variant"), source), "shares 2 of 2 source Turns, then diverges");
  assert.equal(divergenceNote({ turns: source.turns.slice(0, 1) }, source), "shares 1 of 2 source Turns");
  assert.equal(divergenceNote(byId("fork-risky-cleanup"), { turns: [] }), null, "no source transcript, no note");
  assert.equal(divergenceNote(byId("fork-risky-cleanup"), null), null);
});

test("production lineage: forksOf lists a chat's forks oldest first and placementNote speaks only when membership diverges", () => {
  assert.deepEqual(forksOf("fork-src-login", threads).map((thread) => thread.id), ["fork-risky-cleanup", "fork-prompt-variant"]);
  assert.deepEqual(forksOf("plain-brainstorm", threads), []);
  assert.equal(placementNote(byId("fork-risky-cleanup"), byId("fork-src-login")), null);
  assert.equal(
    placementNote(byId("fork-prompt-variant"), byId("fork-src-login")),
    "This fork lives in Recents; its source lives in the Auth hardening group.",
  );
});

test("production Bring Back: the payload targets the fork's source and serializes the fork's exact identity through the shipped quote machinery", () => {
  const payload = bringBackQuote({
    fork: byId("fork-prompt-variant"),
    turnId: "variant-t3",
    itemId: "variant-t3-agent",
    itemKey: "fork-prompt-variant::variant-t3::variant-t3-agent",
    text: "keep retryOn for the 401 mask, and take the onRetry metric from this variant",
  });
  assert.equal(payload.targetThreadId, "fork-src-login");
  assert.equal(payload.quote.threadId, "fork-prompt-variant");
  const message = composeQuotedMessage(payload.quote, "Adopt the metric half.");
  const parsed = parseQuotedMessage(message);
  assert.deepEqual(parsed.source, { threadId: "fork-prompt-variant", turnId: "variant-t3", itemId: "variant-t3-agent" });
  assert.equal(parsed.body, "Adopt the metric half.");
});

test("production Bring Back: a rootless chat, an empty passage and an unnamed Turn or item are refused instead of guessed", () => {
  const fork = byId("fork-prompt-variant");
  assert.equal(bringBackQuote({ fork: byId("fork-src-login"), turnId: "src-t1", itemId: "src-t1-agent", text: "x" }), null);
  assert.equal(bringBackQuote({ fork, turnId: "variant-t3", itemId: "variant-t3-agent", text: "   " }), null);
  assert.equal(bringBackQuote({ fork, turnId: null, itemId: "variant-t3-agent", text: "x" }), null);
  assert.equal(bringBackQuote({ fork, turnId: "variant-t3", itemId: null, text: "x" }), null);
});

test("the review module re-exports the production projections, so review fixtures exercise the shipped code", async () => {
  const review = await import("../apps/codex-first-shell/fork-review.mjs");
  const production = await import("../apps/codex-first-shell/fork-lineage.mjs");
  for (const name of ["resolveLineage", "forksOf", "placementNote", "sharedTurnPrefix", "divergenceNote", "bringBackQuote"]) {
    assert.equal(review[name], production[name], `${name} is the same function in review and production`);
  }
  assert.equal(typeof review.forkTreeRows, "function", "the sidebar tree stays a review-only projection");
  assert.equal(production.forkTreeRows, undefined, "the production module carries no sidebar tree");
});
