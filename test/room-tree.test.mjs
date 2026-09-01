import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildUiSnapshot } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { context, room, run, tempRepo, writeRoom } from "./helpers.mjs";

function sh(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function nestedRepo(label) {
  const repo = tempRepo(label);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@vibehub.dev");
  sh(repo, "config", "user.name", "VibeHub Test");
  assert.equal(run(repo, "project", "init").status, 0);
  mkdirSync(join(repo, "src", "auth", "session"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "login.txt"), "v1\n");
  writeFileSync(join(repo, "src", "auth", "session", "token.txt"), "v1\n");
  writeRoom(repo, "auth", room("auth", { anchors: ["src/auth/"] }));
  writeRoom(repo, "auth/session", room("session", { anchors: ["src/auth/session/"] }));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "baseline");
  return repo;
}

function tree(repo) {
  const result = run(repo, "room", "tree");
  assert.equal(result.status, 0, result.stdout);
  return result.envelope.data;
}

test("room tree projects nesting, boundary text, and per-room drift state", () => {
  const repo = nestedRepo("tree-nested");
  const before = tree(repo);
  assert.deepEqual(before.rooms.map((item) => item.room), ["auth", "auth/session"]);
  assert.deepEqual(before.rooms.map((item) => item.parent), [null, "auth"]);
  assert.deepEqual(before.rooms.map((item) => item.room_id), ["auth", "session"]);
  assert.equal(before.rooms[1].description, "The session room.");
  assert.equal(before.rooms[1].boundary, "Everything about session, nothing else.");
  // Never aligned reads as COLD_START in the conversation view, exactly as the UI presents it.
  assert.deepEqual(before.rooms.map((item) => item.drift.state), ["COLD_START", "COLD_START"]);

  assert.equal(run(repo, "room", "align", undefined, ["--room", "auth"]).status, 0);
  assert.equal(run(repo, "room", "align", undefined, ["--room", "auth/session"]).status, 0);
  assert.deepEqual(tree(repo).rooms.map((item) => item.drift.state), ["FRESH", "FRESH"]);

  writeFileSync(join(repo, "src", "auth", "session", "token.txt"), "v2\n");
  const drifted = tree(repo).rooms;
  assert.equal(drifted[0].drift.state, "DRIFTED");
  assert.deepEqual(drifted[1].drift.changed, ["src/auth/session/token.txt"]);

  assert.equal(run(repo, "room", "stale", { reason: "boundary is wrong" }, ["--room", "auth"]).status, 0);
  const stale = tree(repo).rooms[0];
  assert.equal(stale.drift.state, "STALE");
  assert.equal(stale.drift.reason, "boundary is wrong");
});

test("room tree counts Contexts and keeps an empty Room at zero", () => {
  const repo = nestedRepo("tree-counts");
  const empty = tree(repo);
  assert.deepEqual(empty.rooms.map((item) => item.context_count), [0, 0]);

  assert.equal(run(repo, "context", "put", context(), ["--room", "auth"]).status, 0);
  assert.equal(
    run(repo, "context", "put", context({ context_id: "note-session-ttl", type: "note" }), ["--room", "auth/session"]).status,
    0,
  );
  const counted = tree(repo).rooms;
  // Containment: a parent's count includes its subtree, exactly as the UI Room panel counts.
  assert.deepEqual(counted.map((item) => item.context_count), [2, 1]);

  const bare = tempRepo("tree-bare");
  assert.equal(run(bare, "project", "init").status, 0);
  assert.deepEqual(tree(bare), { cold_start: true, rooms: [] });
});

test("room tree and the UI Room projection cannot disagree about a repository", () => {
  const compare = (repo) => {
    const cli = tree(repo);
    const ui = buildUiSnapshot(repo).state.rooms;
    assert.equal(cli.cold_start, ui.coldStart);
    assert.deepEqual(
      cli.rooms.map((item) => [item.room, item.room_id, item.parent, item.description, item.boundary, item.context_count, item.drift]),
      ui.rooms.map((item) => [item.room, item.roomId, item.parent, item.description, item.boundary, item.contexts.length, item.drift]),
    );
  };
  const repo = nestedRepo("tree-agrees");
  assert.equal(run(repo, "context", "put", context(), ["--room", "auth"]).status, 0);
  assert.equal(run(repo, "room", "align", undefined, ["--room", "auth"]).status, 0);
  compare(repo);
  // The production repository is the real anti-divergence case: many Rooms, real drift.
  compare(process.cwd());
});
