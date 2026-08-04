import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { room, run, tempRepo, writeRoom } from "./helpers.mjs";

function sh(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitRepo(label) {
  const repo = tempRepo(label);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@vibehub.dev");
  sh(repo, "config", "user.name", "VibeHub Test");
  assert.equal(run(repo, "project", "init").status, 0);
  mkdirSync(join(repo, "src", "auth"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "login.txt"), "v1\n");
  writeRoom(repo, "auth", room("auth", { anchors: ["src/auth"] }));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "baseline");
  return repo;
}

function driftFor(repo, roomPath) {
  const drift = run(repo, "room", "drift");
  assert.equal(drift.status, 0, drift.stdout);
  const entry = drift.envelope.data.rooms.find((item) => item.room === roomPath);
  assert.ok(entry, drift.stdout);
  return entry;
}

test("drift reports COLD_START without rooms and the four room states", () => {
  const cold = tempRepo("drift-cold");
  assert.equal(run(cold, "project", "init").status, 0);
  assert.equal(run(cold, "room", "drift").envelope.data.cold_start, true);

  const repo = gitRepo("drift-states");
  assert.equal(driftFor(repo, "auth").state, "UNKNOWN");

  const aligned = run(repo, "room", "align", undefined, ["--room", "auth"]);
  assert.equal(aligned.status, 0, aligned.stdout);
  assert.equal(aligned.envelope.data.aligned_files, 1);
  assert.equal(driftFor(repo, "auth").state, "FRESH");

  writeFileSync(join(repo, "src", "auth", "login.txt"), "v2\n");
  const drifted = driftFor(repo, "auth");
  assert.equal(drifted.state, "DRIFTED");
  assert.deepEqual(drifted.changed, ["src/auth/login.txt"]);

  const marked = run(repo, "room", "stale", { reason: "spec is semantically wrong" }, ["--room", "auth"]);
  assert.equal(marked.status, 0, marked.stdout);
  const stale = driftFor(repo, "auth");
  assert.equal(stale.state, "STALE");
  assert.equal(stale.reason, "spec is semantically wrong");
});

test("rename out of an anchor still flags the source room", () => {
  const repo = gitRepo("drift-rename");
  run(repo, "room", "align", undefined, ["--room", "auth"]);
  mkdirSync(join(repo, "src", "identity"), { recursive: true });
  sh(repo, "mv", "src/auth/login.txt", "src/identity/login.txt");
  sh(repo, "commit", "-qm", "move login out of auth");
  const drifted = driftFor(repo, "auth");
  assert.equal(drifted.state, "DRIFTED");
  assert.deepEqual(drifted.deleted, ["src/auth/login.txt"]);
});

test("untracked files in new nested directories count as drift", () => {
  const repo = gitRepo("drift-untracked");
  run(repo, "room", "align", undefined, ["--room", "auth"]);
  mkdirSync(join(repo, "src", "auth", "newdir"), { recursive: true });
  writeFileSync(join(repo, "src", "auth", "newdir", "extra.txt"), "x\n");
  const drifted = driftFor(repo, "auth");
  assert.equal(drifted.state, "DRIFTED");
  assert.deepEqual(drifted.added, ["src/auth/newdir/extra.txt"]);
});

test("change-then-revert stays FRESH and src/authx never matches src/auth", () => {
  const repo = gitRepo("drift-revert");
  const aligned = run(repo, "room", "align", undefined, ["--room", "auth"]);
  assert.equal(aligned.status, 0, aligned.stdout);
  sh(repo, "commit", "-qam", "record alignment");
  writeFileSync(join(repo, "src", "auth", "login.txt"), "v2\n");
  sh(repo, "commit", "-qam", "change");
  sh(repo, "revert", "--no-edit", "HEAD");
  assert.equal(driftFor(repo, "auth").state, "FRESH");

  mkdirSync(join(repo, "src", "authx"), { recursive: true });
  writeFileSync(join(repo, "src", "authx", "other.txt"), "x\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "authx is a different segment");
  assert.equal(driftFor(repo, "auth").state, "FRESH");
});

test("an old checkout yields WARNING, never DRIFTED, and align refuses to go backwards", () => {
  const repo = gitRepo("drift-old-checkout");
  const before = sh(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "src", "auth", "login.txt"), "v2\n");
  sh(repo, "commit", "-qam", "newer work");
  run(repo, "room", "align", undefined, ["--room", "auth"]);
  sh(repo, "checkout", "-q", before);
  const warned = driftFor(repo, "auth");
  assert.equal(warned.state, "WARNING");
  assert.match(warned.reason, /never realign specs backwards/);
  const refused = run(repo, "room", "align", undefined, ["--room", "auth"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.envelope.error.message, /refusing to realign backwards/);
});

test("drift reports whether a stale room's hashes still match", () => {
  const repo = gitRepo("drift-stale-hashes");
  const aligned = run(repo, "room", "align", undefined, ["--room", "auth"]);
  assert.equal(aligned.status, 0, aligned.stdout);
  run(repo, "room", "stale", { reason: "spec is semantically wrong" }, ["--room", "auth"]);
  assert.equal(driftFor(repo, "auth").hashes_match, true);

  writeFileSync(join(repo, "src", "auth", "login.txt"), "v2\n");
  assert.equal(driftFor(repo, "auth").hashes_match, false);

  rmSync(join(repo, ".vibehub", "rooms", "auth", "room.yaml"));
  writeRoom(repo, "auth", room("auth", { anchors: ["src/auth"], stale: true, stale_reason: "drift: deferred, never aligned" }));
  assert.equal(driftFor(repo, "auth").hashes_match, null);
});

test("align is atomic, clears stale, and stale needs a reason", () => {
  const repo = gitRepo("drift-align-atomic");
  run(repo, "room", "stale", { reason: "deferred at ticket start" }, ["--room", "auth"]);
  const aligned = run(repo, "room", "align", undefined, ["--room", "auth"]);
  assert.equal(aligned.status, 0, aligned.stdout);
  const fresh = driftFor(repo, "auth");
  assert.equal(fresh.state, "FRESH");
  assert.equal(run(repo, "project", "validate").status, 0);

  const missingReason = run(repo, "room", "stale", {}, ["--room", "auth"]);
  assert.notEqual(missingReason.status, 0);
  assert.match(missingReason.envelope.error.message, /non-empty reason/);

  rmSync(join(repo, ".vibehub", "rooms", "auth", "room.yaml"));
  writeRoom(repo, "auth", room("auth", { anchors: ["src/auth"] }));
  assert.equal(driftFor(repo, "auth").state, "UNKNOWN");
});
