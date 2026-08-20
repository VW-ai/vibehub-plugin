import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("taste board uses real product references rather than another VibeHub concept", async () => {
  const [html, script, review] = await Promise.all([
    source("apps/harness-taste-board/index.html"),
    source("apps/harness-taste-board/app.js"),
    source("docs/HARNESS_VISUAL_DIRECTION_REVIEW.md"),
  ]);

  for (const product of ["OpenAI Codex", "Claude Desktop", "Linear", "Raycast", "Warp", "Dia"]) {
    assert.match(script, new RegExp(product), `missing reference product: ${product}`);
  }
  for (const dimension of ["shell", "chat", "action", "execution", "density"]) {
    assert.match(script, new RegExp(`"${dimension}"`), `missing dimension: ${dimension}`);
  }
  for (const rating of ["keep", "part", "reject"]) {
    assert.match(script, new RegExp(`${rating}:`), `missing rating: ${rating}`);
  }
  assert.match(html, /暂时不设计 VibeHub/);
  assert.match(script, /ephemeral|navigator\.clipboard|ratings = new Map/);
  assert.doesNotMatch(script, /localStorage|sessionStorage/, "taste decisions must not be silently persisted");
  assert.match(review, /rejected visual study/);
  assert.match(review, /土土的/);
});

test("taste board is responsive, keyboard reachable, and reduced-motion safe", async () => {
  const [html, css] = await Promise.all([
    source("apps/harness-taste-board/index.html"),
    source("apps/harness-taste-board/app.css"),
  ]);
  assert.match(html, /aria-label/);
  assert.match(css, /focus-visible/);
  assert.match(css, /@media \(max-width: 520px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("taste board server is local-only and allows official screenshot images", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-harness-taste-board.mjs", "--port", "0", "--json"], {
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
  assert.equal(envelope.ephemeralRatings, true);

  const health = await fetch(new URL("health", envelope.url));
  assert.deepEqual(await health.json(), { ok: true, board: "harness-taste-calibration", localOnly: true });
  const page = await fetch(envelope.url);
  assert.match(await page.text(), /Taste Calibration/);
  assert.match(page.headers.get("content-security-policy"), /img-src 'self' https: data:/);

  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
