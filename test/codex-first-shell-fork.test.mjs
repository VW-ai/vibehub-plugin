// Fork lineage, Bring Back and Fork-from-here proofs for the Codex-first
// shell (ticket-build-fork-lineage-bring-back-and-fork-from-here). The host
// proofs run the production host over the fixture app-server, whose
// thread/fork mirrors the pinned 0.149.0 semantics: the fork replays the
// source's terminal Turns with their ids, lastTurnId is the stable inclusive
// boundary (later Turns omitted), and an in-progress boundary Turn is
// refused. The static proofs pin that the browser uses only that seam —
// never the deprecated thread/rollback — and that the production lineage
// surfaces replaced the raw "Fork of <uuid>" line.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const fixtureAppServer = fileURLToPath(new URL("fixtures/codex-app-server-fixture.mjs", import.meta.url));

// A persisted fixture state with one two-Turn source Thread and one Thread
// whose head Turn is still in progress, both durable so the shell lists them.
function forkSeedState(folder) {
  const turn = (id, status, userText, agentText) => ({
    id,
    status,
    items: [
      { type: "userMessage", id: `${id}-user`, content: [{ type: "text", text: userText }] },
      ...(agentText ? [{ type: "agentMessage", id: `${id}-agent`, text: agentText }] : []),
    ],
  });
  const thread = (id, name, turns) => ({
    id,
    name,
    preview: "fork seam proof",
    cwd: folder,
    createdAt: "2026-08-23T00:00:00Z",
    updatedAt: "2026-08-23T00:10:00Z",
    status: { type: "idle" },
    forkedFromId: null,
    section: null,
    archived: false,
    policy: { approvalPolicy: null, sandbox: null },
    turns,
    durable: true,
  });
  return {
    counter: 500,
    sections: [],
    threads: [
      thread("fork-source-thread", "Fork source chat", [
        turn("fork-turn-1", "completed", "First question.", "First finalized answer."),
        turn("fork-turn-2", "completed", "Second question.", "Second finalized answer."),
      ]),
      thread("fork-live-thread", "Live-head chat", [
        turn("live-turn-1", "completed", "Settled question.", "Settled answer."),
      ]),
    ],
  };
}

async function launchForkShell(context) {
  const folder = await mkdtemp(join(tmpdir(), "vibehub-fork-host-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  const statePath = join(folder, "codex-state.json");
  const logPath = join(folder, "app-server-calls.jsonl");
  await writeFile(statePath, `${JSON.stringify(forkSeedState(folder))}\n`);
  const child = spawn(process.execPath, ["scripts/vh-codex-first-shell.mjs", "--repo", folder, "--port", "0", "--json", "--codex", fixtureAppServer], {
    cwd: new URL(".", root),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CODEX_FIXTURE_VERSION: "0.149.0", CODEX_FIXTURE_STATE: statePath, CODEX_FIXTURE_LOG: logPath },
  });
  context.after(() => child.kill("SIGTERM"));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const startup = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => ({ type: "ready", text: String(chunk).trim() })),
    once(child.stderr, "data").then(([chunk]) => ({ type: "error", text: String(chunk).trim() })),
    once(child, "exit").then(([code]) => ({ type: "exit", text: `exit ${code}` })),
  ]);
  clearTimeout(timer);
  if (startup.type !== "ready" && /EPERM|Operation not permitted/.test(startup.text)) {
    context.skip("loopback sockets are unavailable in this sandbox");
    return null;
  }
  assert.equal(startup.type, "ready", startup.text);
  const envelope = JSON.parse(startup.text);
  const url = new URL(envelope.url);
  const token = url.hash.slice(1);
  url.hash = "";
  const api = async (path, options = {}) => {
    const response = await fetch(new URL(path, url), { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    return { status: response.status, body: await response.json() };
  };
  return { folder, logPath, api, action: (payload) => api("api/action", { method: "POST", body: JSON.stringify(payload) }) };
}

test("forkThread with lastTurnId creates a fork whose transcript ends at the chosen Turn, on the pinned thread/fork seam alone", async (context) => {
  const shell = await launchForkShell(context);
  if (!shell) return;

  // Point fork: the boundary Turn is inclusive and the later Turn is omitted.
  const pointFork = await shell.action({ action: "forkThread", threadId: "fork-source-thread", lastTurnId: "fork-turn-1" });
  assert.equal(pointFork.status, 200, JSON.stringify(pointFork.body));
  const point = pointFork.body.data.thread;
  assert.equal(point.forkedFromId, "fork-source-thread");
  assert.deepEqual(point.turns.map((turn) => turn.id), ["fork-turn-1"], "the fork's transcript ends at the chosen Turn");
  assert.equal(point.turns.at(-1).items.at(-1).text, "First finalized answer.");

  // Head fork: without lastTurnId every terminal Turn replays with its id.
  const headFork = await shell.action({ action: "forkThread", threadId: "fork-source-thread" });
  assert.equal(headFork.status, 200, JSON.stringify(headFork.body));
  assert.deepEqual(headFork.body.data.thread.turns.map((turn) => turn.id), ["fork-turn-1", "fork-turn-2"]);

  // The source Thread is never truncated by forking from a point.
  const sourceRead = await shell.action({ action: "readThread", threadId: "fork-source-thread" });
  assert.deepEqual(sourceRead.body.data.thread.turns.map((turn) => turn.id), ["fork-turn-1", "fork-turn-2"]);

  // An in-progress boundary Turn is refused, as the real server refuses it:
  // a Turn is started (the fixture never finishes one on its own) and named
  // as the fork boundary while it is still running.
  const started = await shell.action({ action: "startTurn", threadId: "fork-live-thread", input: [{ type: "text", text: "keep running" }] });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const liveTurnId = started.body.data.turn.id;
  const refused = await shell.action({ action: "forkThread", threadId: "fork-live-thread", lastTurnId: liveTurnId });
  assert.equal(refused.status, 500);
  assert.match(refused.body.error.message, /in progress/u);
  await shell.action({ action: "interruptTurn", threadId: "fork-live-thread", turnId: liveTurnId });

  // The shared Turn-id prefix of the point fork against its source derives
  // the fork point exactly as the production chip derives it.
  const { sharedTurnPrefix } = await import("../apps/codex-first-shell/fork-lineage.mjs");
  assert.deepEqual(sharedTurnPrefix(point, sourceRead.body.data.thread), { shared: 1, sourceTotal: 2, diverged: false });

  // The pinned seam is the only one dispatched: thread/fork with lastTurnId,
  // never thread/rollback.
  const calls = (await readFile(shell.logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const forks = calls.filter((call) => call.method === "thread/fork");
  assert.equal(forks.length, 3, "three thread/fork dispatches (one refused)");
  assert.equal(forks[0].params.lastTurnId, "fork-turn-1");
  assert.equal(forks[1].params.lastTurnId ?? null, null);
  assert.ok(!calls.some((call) => call.method === "thread/rollback"), "thread/rollback is never dispatched");
});

test("the fork seam stays thread/fork alone: the deprecated thread/rollback appears nowhere in the shell or adapter", async () => {
  const [app, host, projects, clientSource, harness] = await Promise.all([
    source("apps/codex-first-shell/app.js"),
    source("scripts/vh-codex-first-shell.mjs"),
    source("packages/codex-adapter/projects.mjs"),
    source("packages/codex-adapter/client.mjs"),
    source("packages/codex-adapter/harness.mjs"),
  ]);
  assert.doesNotMatch(app + host + projects + clientSource + harness, /thread\/rollback/u, "the deprecated thread/rollback seam stays unused");
  assert.match(host, /projects\.forkThread\(threadId,\s*\{\s*lastTurnId:\s*payload\.lastTurnId\s*\?\?\s*null\s*\}\)/u, "the host forwards lastTurnId to the adapter");
  assert.match(app, /action:\s*"forkThread",\s*threadId:\s*state\.activeThreadId,\s*lastTurnId:\s*item\._turnId/u, "Fork from here sends the message's own Turn as lastTurnId");
});

test("the production lineage surfaces replaced the raw Fork-of line and never present a fork as a Task or dependency", async () => {
  const [app, renderer, html] = await Promise.all([
    source("apps/codex-first-shell/app.js"),
    source("apps/codex-first-shell/chat-renderer.mjs"),
    source("apps/codex-first-shell/index.html"),
  ]);
  // The raw " · Fork of <uuid>" heading line is gone; the navigable chip and
  // the missing-source state render from the production lineage projection,
  // outside any ?forkFixture gate.
  assert.doesNotMatch(app, /Fork of \$\{/u, "the raw Fork-of UUID line is gone");
  const chipMarkup = app.slice(app.indexOf("function forkLineageMarkup"), app.indexOf("function renderChat"));
  assert.doesNotMatch(chipMarkup, /forkReview/u, "the chip, fork listing and missing state no longer sit behind the review gate");
  assert.match(chipMarkup, /Forked from a chat not listed in this folder/u);
  assert.match(chipMarkup, /data-open-lineage/u);
  assert.doesNotMatch(chipMarkup, /Task|Subtask|dependency/u, "lineage copy never borrows Task language");
  // The sidebar gains no fork tree in production: the indented projection
  // stays behind the review gate's sidebar direction.
  assert.match(app, /state\.forkReview\?\.direction !== "sidebar"/u, "the sidebar fork tree stays review-only");
  // Bring Back stays an explicit human send: the draft is written to the
  // source Thread's composer draft store and nothing dispatches a Turn.
  const bringBack = app.slice(app.indexOf("async function bringBackToSource"), app.indexOf("function forkMessageActions"));
  assert.match(bringBack, /saveThreadDraft\(state\.composerDrafts, payload\.targetThreadId/u);
  assert.doesNotMatch(bringBack, /startTurn|queueTurn|steerTurn/u, "Bring Back never starts a Turn by itself");
  assert.match(html, /data-bring-back hidden>Bring back to source/u, "the selection sheet offers the explicit action");
  // The per-message actions ride the finalized gating the bridge already
  // proved: renderForkMessageActions is emitted only for finalized items.
  assert.match(renderer, /const forkActions = finalized \? renderForkMessageActions\(key, fork\) : ""/u);
  assert.match(renderer, /data-fork-from/u);
  assert.match(renderer, /data-bring-back-message/u);
});
