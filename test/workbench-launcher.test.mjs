import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { startVibeHubUi } from "../skills/scripts/vh-ui.mjs";
import { root, run, tempRepo, ticket } from "./helpers.mjs";

const launcher = join(root, "skills", "scripts", "vh-workbench.mjs");
const repos = [];
const hosts = [];
const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

function fixture() {
  const repo = tempRepo("workbench-launcher");
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", { tickets: [ticket("foundation")] }).status, 0);
  return repo;
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

function firstLine(child) {
  return new Promise((resolveLine, rejectLine) => {
    let buffered = "";
    const timer = setTimeout(
      () => rejectLine(new Error(`launcher produced no output: ${buffered}`)),
      15_000,
    );
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timer);
        resolveLine(buffered.slice(0, newline));
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      rejectLine(new Error(`launcher exited early: ${buffered}`));
    });
  });
}

function exited(child) {
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

test("session-owned host has no expiry and stays read-only", async () => {
  const repo = fixture();
  const before = canonicalBytes(repo);
  const token = "b".repeat(64);
  const host = startVibeHubUi({ repoRoot: repo, token, tokenLifetimeMs: null });
  hosts.push(host);
  const ready = await host.ready;
  assert.equal(ready.expiresInMs, null);
  assert.equal(ready.origin.startsWith("http://127.0.0.1:"), true);
  assert.equal(new URL(ready.url).hash, `#${token}`);

  const unauthorized = await fetch(`${ready.origin}/api/state`);
  assert.equal(unauthorized.status, 401);
  const state = await fetch(`${ready.origin}/api/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).data.graph.tickets.length, 1);
  const write = await fetch(`${ready.origin}/api/state`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(write.status, 405);
  assert.equal((await write.json()).error.code, "read_only");

  assert.deepEqual(canonicalBytes(repo), before);
  await host.close();
  await assert.rejects(fetch(`${ready.origin}/health`));
});

test("agent-task default lifetime is unchanged", async () => {
  const repo = fixture();
  const host = startVibeHubUi({ repoRoot: repo });
  hosts.push(host);
  const ready = await host.ready;
  assert.equal(ready.expiresInMs, 30 * 60 * 1_000);
  await host.close();
});

test("invalid token lifetimes are still rejected", () => {
  const repo = fixture();
  for (const tokenLifetimeMs of [0, -5, 1.5, "forever"]) {
    assert.throws(
      () => startVibeHubUi({ repoRoot: repo, tokenLifetimeMs }),
      /tokenLifetimeMs must be a positive integer/u,
    );
  }
});

test("foreground workbench command owns the session and leaves no residue", async () => {
  const repo = fixture();
  const before = canonicalBytes(repo);
  const rootEntriesBefore = readdirSync(repo).sort();
  const child = spawn(
    process.execPath,
    [launcher, "--repo", repo, "--no-open", "--json"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  const envelope = JSON.parse(await firstLine(child));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.readOnly, true);
  assert.equal(envelope.sessionOwner, "user");
  assert.equal(envelope.opened, false);
  assert.equal(envelope.expiresInMs, null);
  assert.match(envelope.url, /^http:\/\/127\.0\.0\.1:\d+\/#[0-9a-f]{64}$/u);

  const health = await fetch(`${envelope.origin}/health`);
  assert.deepEqual(await health.json(), { ok: true, schemaVersion: 1, readOnly: true });
  const token = new URL(envelope.url).hash.slice(1);
  const state = await fetch(`${envelope.origin}/api/state`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(state.status, 200);

  child.kill("SIGTERM");
  const exit = await exited(child);
  assert.deepEqual(exit, { code: 0, signal: null });
  await assert.rejects(fetch(`${envelope.origin}/health`));
  assert.deepEqual(canonicalBytes(repo), before);
  assert.deepEqual(readdirSync(repo).sort(), rootEntriesBefore);
});

test("workbench command keeps the launcher flag surface narrow", async () => {
  const child = spawn(
    process.execPath,
    [launcher, "--daemon"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await exited(child);
  assert.equal(exit.code, 1);
  assert.match(stderr, /unknown flag: --daemon/u);
});
