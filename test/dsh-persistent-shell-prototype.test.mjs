import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("persistent shell prototype carries one native shell through Chat, Graph and Task focus", async () => {
  const [html, script, review] = await Promise.all([
    source("apps/dsh-persistent-shell-prototype/index.html"),
    source("apps/dsh-persistent-shell-prototype/app.js"),
    source("docs/DSH_PERSISTENT_SHELL_REVIEW.md"),
  ]);

  for (const destination of ["New chat", "Tasks", "Rooms", "Workspace", "Chats", "Settings"]) {
    assert.match(html, new RegExp(destination, "i"), `missing persistent destination: ${destination}`);
  }
  for (const moment of ["normal native Chat", "causal Graph", "Focus Route", "Needs you", "Evidence", "exact Graph focus"]) {
    assert.match(script + review, new RegExp(moment, "i"), `missing loop moment: ${moment}`);
  }
  assert.match(script, /graphFocus/);
  assert.match(script, /focus\(\{ preventScroll: true \}\)/);
  assert.match(html, /A · Tasks first/);
  assert.match(html, /B · Chat first/);
  assert.doesNotMatch(script + html, /localStorage|sessionStorage/);
});

test("composition contract keeps DSH Root and Conversation while shadowing only Sidebar", async () => {
  const [raw, probe, review] = await Promise.all([
    source("docs/proposals/dsh-persistent-shell/composition-contract.json"),
    source("packages/dsh-adapter/probe-persistent-shell.mjs"),
    source("docs/DSH_PERSISTENT_SHELL_REVIEW.md"),
  ]);
  const contract = JSON.parse(raw);
  assert.deepEqual(contract.composition.keep_owners, ["root", "conversation", "details"]);
  assert.deepEqual(contract.composition.shadow_owners, ["sidebar"]);
  assert.deepEqual(contract.composition.recreate_child_slots, [
    "sidebar.brand.mark",
    "sidebar.brand.name",
    "sidebar.workspaces",
    "sidebar.settings",
    "sidebar.footer.action",
  ]);
  assert.equal(contract.recommended_variant, "tasks-first");
  assert.equal(contract.scenario_path.at(0), "first boot");
  assert.equal(contract.scenario_path.at(-1), "return to exact Graph focus");
  assert.ok(contract.stop_conditions.length >= 5);
  assert.match(raw + review, /shell\.overlay/);
  assert.match(raw + review, /DOM injection/);
  assert.match(probe, /expected DSH/);
  assert.match(probe, /sidebar-child-seats-are-complete/);
});

test("persistent shell prototype is keyboard-visible, narrow-safe and reduced-motion-safe", async () => {
  const [html, script, css] = await Promise.all([
    source("apps/dsh-persistent-shell-prototype/index.html"),
    source("apps/dsh-persistent-shell-prototype/app.js"),
    source("apps/dsh-persistent-shell-prototype/app.css"),
  ]);
  assert.match(html, /aria-label="Application navigation"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(script, /keydown/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /overflow: hidden/);
});

test("persistent shell source probe passes against the locally available exact rc.8 checkout", async (context) => {
  const sourceRoot = process.env.DSH_SOURCE ?? "/private/tmp/deepseek-harness-141eb6f";
  try {
    await access(sourceRoot);
  } catch {
    context.skip("exact rc.8 source checkout is not available");
    return;
  }
  const { stdout } = await execFileAsync(process.execPath, ["packages/dsh-adapter/probe-persistent-shell.mjs", sourceRoot], { cwd: new URL(".", root) });
  const result = JSON.parse(stdout);
  assert.equal(result.commit, "141eb6fef83422698aef7a981029e843e8161534");
  assert.equal(result.version, "0.1.0-rc.8");
  assert.equal(result.recommendation, "tasks-first");
  assert.equal(result.checks.length, 8);
  assert.ok(result.checks.every((check) => check.proven));
});

test("persistent shell review server is local-only and read-only", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-dsh-persistent-shell-prototype.mjs", "--port", "0", "--json"], {
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
  assert.deepEqual(await health.json(), {
    ok: true,
    prototype: "dsh-persistent-shell",
    upstream: "@deepseek-ai/dsh@0.1.0-rc.8",
    localOnly: true,
    repositoryWrites: false,
  });
  const page = await fetch(envelope.url);
  assert.match(await page.text(), /Persistent shell prototype/);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/);
  const rejected = await fetch(envelope.url, { method: "POST" });
  assert.equal(rejected.status, 405);

  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
