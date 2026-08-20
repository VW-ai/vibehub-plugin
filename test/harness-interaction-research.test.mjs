import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("interaction research is source-backed and compares coherent spatial models", async () => {
  const [html, script, review] = await Promise.all([
    source("apps/harness-interaction-research/index.html"),
    source("apps/harness-interaction-research/app.js"),
    source("docs/HARNESS_INTERACTION_RESEARCH.md"),
  ]);

  for (const product of ["OpenAI Codex", "Linear", "Raycast", "Things", "Notion", "Msty", "Superlist", "OpenHands"]) {
    assert.match(script + review, new RegExp(product), `missing research source: ${product}`);
  }
  for (const direction of ["Focus Route", "Spatial Lens", "Live Split"]) {
    assert.match(script + review, new RegExp(direction), `missing interaction direction: ${direction}`);
  }
  for (const phase of ["Graph home", "Running", "Needs you", "Review"]) {
    assert.match(html + script, new RegExp(phase), `missing scenario phase: ${phase}`);
  }
  assert.match(review, /Focus Route — recommended/);
  assert.match(review, /141eb6fef83422698aef7a981029e843e8161534/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/);
});

test("interaction research is responsive, keyboard reachable, and reduced-motion safe", async () => {
  const [html, script, css] = await Promise.all([
    source("apps/harness-interaction-research/index.html"),
    source("apps/harness-interaction-research/app.js"),
    source("apps/harness-interaction-research/app.css"),
  ]);
  assert.match(html, /aria-label/);
  assert.match(script, /keydown/);
  assert.match(css, /focus-visible/);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("interaction research server is local-only and disposable", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-harness-interaction-research.mjs", "--port", "0", "--json"], {
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

  const health = await fetch(new URL("health", envelope.url));
  assert.deepEqual(await health.json(), { ok: true, board: "task-workbench-interaction-research", localOnly: true });
  const page = await fetch(envelope.url);
  assert.match(await page.text(), /Task Workbench research/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);

  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
