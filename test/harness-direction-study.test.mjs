import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("direction study compares three product environments across the same states", async () => {
  const [html, script, review] = await Promise.all([
    source("apps/harness-direction-study/index.html"),
    source("apps/harness-direction-study/app.js"),
    source("docs/HARNESS_VISUAL_DIRECTION_REVIEW.md"),
  ]);

  for (const direction of ["Ambient OS", "Spatial Cockpit", "Kinetic Command"]) {
    assert.match(script, new RegExp(direction), `missing direction: ${direction}`);
    assert.match(review, new RegExp(direction), `missing review guidance: ${direction}`);
  }
  for (const scene of ["First frame", "Chat at work", "Active runs"]) {
    assert.match(html, new RegExp(scene), `missing scenario switch: ${scene}`);
  }
  for (const productObject of ["Context", "Ticket", "Run", "Branch", "Evidence"]) {
    assert.match(script + review, new RegExp(productObject), `missing product object: ${productObject}`);
  }
  assert.match(script, /Trusted Run event/);
  assert.match(review, /rejected visual study/);
  assert.match(review, /Do not\s+iterate, combine, or use them as the baseline/);
  assert.doesNotMatch(html + script + review, /<svg|<img/i, "study should use product UI rather than decorative imagery");
  assert.doesNotMatch(html + script, /https?:\/\//, "local study must not load network resources");
});

test("direction study supports keyboard, narrow layouts, and reduced motion", async () => {
  const [script, css] = await Promise.all([
    source("apps/harness-direction-study/app.js"),
    source("apps/harness-direction-study/app.css"),
  ]);
  assert.match(script, /keydown/);
  assert.match(script, /Escape/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /focus-visible/);
});

test("direction study server is local-only and disposable", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-harness-directions.mjs", "--port", "0", "--json"], {
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
  assert.deepEqual(await health.json(), { ok: true, study: "harness-visual-directions", localOnly: true });
  const page = await fetch(envelope.url);
  assert.match(await page.text(), /Application direction study/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);

  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
