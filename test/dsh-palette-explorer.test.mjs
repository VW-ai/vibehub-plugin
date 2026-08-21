import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("palette explorer is one controlled monochrome shell comparison", async () => {
  const [html, script, css, review] = await Promise.all([
    source("apps/dsh-palette-explorer/index.html"),
    source("apps/dsh-palette-explorer/app.js"),
    source("apps/dsh-palette-explorer/app.css"),
    source("docs/DSH_MONOCHROME_PALETTE_REVIEW.md"),
  ]);
  for (const name of ["True Black", "Graphite", "Soft Black", "Cool Mono", "Warm Mono"]) {
    assert.match(html + script + review, new RegExp(name));
  }
  for (const surface of ["Graph", "Chat", "Task", "Recommended action", "Needs you"]) {
    assert.match(html + review, new RegExp(surface, "i"));
  }
  assert.match(script, /data-surface/);
  assert.match(review, /same Shell/i);
  assert.doesNotMatch(html + script, /localStorage|sessionStorage/);
});

test("every direction declares the same complete visual token contract", async () => {
  const css = await source("apps/dsh-palette-explorer/app.css");
  const selectors = ["true-black", "graphite", "soft-black", "cool-mono", "warm-mono"];
  const tokens = ["--bg", "--sidebar", "--surface", "--surface-2", "--raised", "--border", "--text", "--muted", "--accent", "--selected", "--phase-done", "--phase-ready", "--phase-running", "--phase-draft"];
  for (const selector of selectors) {
    const start = css.indexOf(`[data-palette="${selector}"]`);
    assert.notEqual(start, -1, `missing palette ${selector}`);
    const end = css.indexOf("}\n", start);
    const block = css.slice(start, end);
    for (const token of tokens) assert.match(block, new RegExp(token), `${selector} missing ${token}`);
  }
  assert.doesNotMatch(css, /#[0-9a-f]{6}\s*,\s*#[0-9a-f]{6}\s*,/i);
});

test("palette review is keyboard reachable, narrow safe, reduced-motion safe and honest", async () => {
  const [html, script, css, review] = await Promise.all([
    source("apps/dsh-palette-explorer/index.html"),
    source("apps/dsh-palette-explorer/app.js"),
    source("apps/dsh-palette-explorer/app.css"),
    source("docs/DSH_MONOCHROME_PALETTE_REVIEW.md"),
  ]);
  assert.match(html, /role="radiogroup"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(script, /keydown/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /overflow: hidden/);
  assert.match(review, /not human approval|not human\napproval|not human/i);
  assert.match(review, /whole-application visual review/i);
});

test("palette review server is loopback-only and read-only", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-dsh-palette-explorer.mjs", "--port", "0", "--json"], {
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
  assert.equal(envelope.repositoryWrites, false);
  const health = await fetch(new URL("health", envelope.url));
  assert.deepEqual(await health.json(), { ok: true, prototype: "dsh-monochrome-palette-explorer", palettes: 5, localOnly: true, repositoryWrites: false });
  const page = await fetch(envelope.url);
  assert.match(await page.text(), /DSH palette lab/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  assert.equal((await fetch(envelope.url, { method: "POST" })).status, 405);
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
