import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { afterEach, test } from "node:test";
import { startVibeHubUi } from "../skills/scripts/vh-ui.mjs";
import { run, tempRepo, ticket } from "./helpers.mjs";

const repos = [];
const hosts = [];
const TOKEN = "c".repeat(64);
const SETTLE_MS = 700;

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function fixture() {
  const repo = tempRepo("session-watch");
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", { tickets: [ticket("foundation")] }).status, 0);
  return repo;
}

async function watchingHost(repo, options = {}) {
  const host = startVibeHubUi({ repoRoot: repo, token: TOKEN, watch: true, ...options });
  hosts.push(host);
  await host.ready;
  return host;
}

async function stateOf(host) {
  const { origin } = await host.ready;
  const response = await fetch(`${origin}/api/state`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

function writeTicketFile(repo, id) {
  writeFileSync(
    join(repo, ".vibehub", "tickets", `${id}.yaml`),
    `${JSON.stringify(ticket(id), null, 2)}\n`,
  );
}

function canonicalBytes(repo) {
  const base = join(repo, ".vibehub");
  function collect(directory, prefix = "") {
    return readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => {
        const relative = join(prefix, entry.name);
        const absolute = join(directory, entry.name);
        return entry.isDirectory()
          ? collect(absolute, relative)
          : [[relative, readFileSync(absolute, "utf8")]];
      });
  }
  return collect(base).sort(([left], [right]) => left.localeCompare(right));
}

test("a burst of governed writes coalesces into one revalidated reprojection", async () => {
  const repo = fixture();
  const host = await watchingHost(repo);
  const initial = await stateOf(host);
  assert.equal(initial.watch.enabled, true);
  assert.equal(initial.watch.error, null);
  assert.equal(initial.graph.tickets.length, 1);
  const baseline = initial.watch.projectionCount;

  for (const id of ["burst-one", "burst-two", "burst-three"]) writeTicketFile(repo, id);
  await wait(SETTLE_MS);

  const updated = await stateOf(host);
  assert.equal(updated.graph.tickets.length, 4);
  assert.equal(updated.watch.error, null);
  assert.equal(updated.watch.projectionCount, baseline + 1);
  assert.notEqual(updated.graph.snapshotId, initial.graph.snapshotId);
});

test("invalid YAML keeps the last valid snapshot and recovers automatically", async () => {
  const repo = fixture();
  const host = await watchingHost(repo);
  const before = await stateOf(host);

  const broken = join(repo, ".vibehub", "tickets", "broken.yaml");
  writeFileSync(broken, "{ this is not a canonical ticket\n");
  await wait(SETTLE_MS);
  const during = await stateOf(host);
  assert.equal(during.graph.snapshotId, before.graph.snapshotId);
  assert.equal(during.graph.tickets.length, 1);
  assert.equal(typeof during.watch.error, "string");

  rmSync(broken);
  await wait(SETTLE_MS);
  const after = await stateOf(host);
  assert.equal(after.watch.error, null);
  assert.equal(after.graph.snapshotId, before.graph.snapshotId);
  assert.equal(after.graph.tickets.length, 1);
});

test("git metadata follows HEAD changes in the watched worktree", async () => {
  const repo = fixture();
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-b", "main");
  git("config", "user.email", "watch@test.local");
  git("config", "user.name", "Watch Test");
  git("add", ".vibehub");
  git("commit", "-m", "seed");

  const host = await watchingHost(repo);
  const before = await stateOf(host);
  assert.equal(before.graph.source.branch, "main");

  git("checkout", "-b", "workbench-watch");
  await wait(SETTLE_MS);
  const after = await stateOf(host);
  assert.equal(after.graph.source.branch, "workbench-watch");
});

test("the watcher never writes back into the repository", async () => {
  const repo = fixture();
  const host = await watchingHost(repo);
  await stateOf(host);
  writeTicketFile(repo, "written-by-test");
  await wait(SETTLE_MS);
  const settled = canonicalBytes(repo);
  for (let round = 0; round < 3; round += 1) {
    await stateOf(host);
    await wait(200);
  }
  assert.deepEqual(canonicalBytes(repo), settled);
});

test("agent-task launches stay per-request with no watch surface", async () => {
  const repo = fixture();
  const host = startVibeHubUi({ repoRoot: repo, token: TOKEN });
  hosts.push(host);
  await host.ready;
  const before = await stateOf(host);
  assert.equal("watch" in before, false);
  writeTicketFile(repo, "immediately-visible");
  const after = await stateOf(host);
  assert.equal(after.graph.tickets.length, 2);
});
