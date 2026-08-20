import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Harness prototype carries the complete mocked product loop", async () => {
  const [html, script, contract, review] = await Promise.all([
    source("apps/harness-prototype/index.html"),
    source("apps/harness-prototype/app.js"),
    source("docs/HARNESS_PRODUCT_CONTRACT.md"),
    source("docs/HARNESS_PROTOTYPE_REVIEW.md"),
  ]);

  for (const marker of ["Chat", "Branches", "Compare branches", "Bring back to Main", "Context off", "Make Ticket", "Start Ticket", "Preview execution states"]) {
    assert.match(html, new RegExp(marker, "i"), `missing interaction marker: ${marker}`);
  }
  for (const runState of ["queued", "running", "waiting", "failed", "evidence", "completed"]) {
    assert.match(script, new RegExp(`${runState}:`), `missing trusted run projection: ${runState}`);
  }
  assert.match(contract, /Think first/);
  assert.match(contract, /Act first/);
  assert.match(contract, /Cross-repository Project or Ticket federation/);
  assert.match(contract, /A native desktop wrapper/);
  assert.match(review, /Product questions for the owner/);
  assert.doesNotMatch(html, /https?:\/\//, "prototype must not load network resources");
});

test("Harness prototype has app-like narrow and reduced-motion behavior", async () => {
  const css = await source("apps/harness-prototype/app.css");
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /position: sticky/);
});

test("Harness prototype server is loopback-only, static, and disposable", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-harness-prototype.mjs", "--port", "0", "--json"], {
    cwd: new URL(".", root),
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));

  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const startup = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => ({ type: "ready", text: String(chunk).trim() })),
    once(child.stderr, "data").then(([chunk]) => ({ type: "error", text: String(chunk).trim() })),
    once(child, "exit").then(([code]) => ({ type: "exit", text: `exit ${code}` })),
  ]);
  clearTimeout(timer);
  if (startup.type !== "ready" && /EPERM/.test(startup.text)) {
    context.skip("loopback sockets are unavailable in this sandbox");
    return;
  }
  assert.equal(startup.type, "ready", startup.text);
  const envelope = JSON.parse(startup.text);
  assert.equal(envelope.localOnly, true);
  assert.equal(envelope.mockedState, true);
  assert.match(envelope.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const health = await fetch(new URL("health", envelope.url));
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, prototype: true, durableState: false });
  const page = await fetch(envelope.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /VibeHub Harness/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);

  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
