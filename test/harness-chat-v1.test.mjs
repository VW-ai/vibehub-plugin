import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("Chat v1 keeps conversation primary and reveals product objects in place", async () => {
  const [html, script, css] = await Promise.all([
    source("apps/harness-chat-v1/index.html"),
    source("apps/harness-chat-v1/app.js"),
    source("apps/harness-chat-v1/app.css"),
  ]);

  assert.match(html, /Harness 的日常工作体验/);
  assert.match(html, /Fork from here/);
  assert.match(html, /Context for next turn/);
  assert.match(html, /Make task from this/);
  assert.match(html, /Trusted executor activity/);
  assert.match(html, /Compare without merging history/);
  assert.match(html, /Go to or start/);
  assert.match(script, /enterBranch/);
  assert.match(script, /startRun/);
  assert.doesNotMatch(script, /composerZone\.hidden = true/, "execution must not take away Chat input");
  assert.match(script, /commandPalette/);
  assert.match(script, /selectedContextCount/);
  assert.match(script, /Bring back|Brought back/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/);
  assert.match(css, /\.run-strip/);
  assert.match(css, /\.attention-bar/);
});

test("Chat v1 is keyboard reachable, responsive, and reduced-motion safe", async () => {
  const [html, script, css] = await Promise.all([
    source("apps/harness-chat-v1/index.html"),
    source("apps/harness-chat-v1/app.js"),
    source("apps/harness-chat-v1/app.css"),
  ]);
  assert.match(html, /aria-label="Conversation"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(script, /event\.key === "Escape"/);
  assert.match(script, /metaKey \|\| event\.ctrlKey/);
  assert.match(css, /focus-visible/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test("Chat v1 server is loopback-only, static, and disposable", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-harness-chat-v1.mjs", "--port", "0", "--json"], {
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
  assert.equal(envelope.ephemeralState, true);

  const health = await fetch(new URL("health", envelope.url));
  assert.deepEqual(await health.json(), { ok: true, prototype: "harness-chat-v1", localOnly: true });
  const page = await fetch(envelope.url);
  assert.match(await page.text(), /Chat workspace/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);

  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
