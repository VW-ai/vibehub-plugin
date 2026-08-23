import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, test } from "node:test";
import { startVibeHubUi } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { run, tempRepo, ticket } from "./helpers.mjs";

const repos = [];
const hosts = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

test("explicit loopback DSH embedding relaxes only the frame boundary", async () => {
  const repo = tempRepo("ui-dsh-embed");
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "ticket", "apply", { tickets: [ticket("embedded-task")] }).status, 0);
  const host = startVibeHubUi({
    repoRoot: repo,
    embeddedOrigins: ["http://127.0.0.1:3080", "http://localhost:3080"],
  });
  hosts.push(host);
  const { origin } = await host.ready;
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors http:\/\/127\.0\.0\.1:3080 http:\/\/localhost:3080/u,
  );
  assert.equal(response.headers.get("x-frame-options"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  const write = await fetch(`${origin}/api/state`, { method: "POST" });
  assert.equal(write.status, 405);
  assert.equal((await write.json()).error.code, "read_only");
});

test("non-loopback embedding is rejected before the host binds", () => {
  const repo = tempRepo("ui-dsh-embed-reject");
  repos.push(repo);
  assert.equal(run(repo, "project", "init").status, 0);
  assert.throws(
    () => startVibeHubUi({ repoRoot: repo, embeddedOrigins: ["https://example.com"] }),
    /loopback HTTP origins/u,
  );
});

test("embedded Workbench accepts only bounded runtime and refresh messages", () => {
  const app = new URL("../skills/vibehub-ticket-review/assets/app.js", import.meta.url);
  const source = readFileSync(app, "utf8");
  assert.match(source, /event\.data\?\.type === "vibehub-refresh"/u);
  assert.match(source, /refresh\(null, \{ preserveLayout: true \}\)/u);
  assert.match(source, /event\.data\?\.type !== "vibehub-runtime"/u);
});
