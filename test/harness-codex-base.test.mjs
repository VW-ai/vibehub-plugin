import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Codex-base models the complete Ticket, Run, attention, and closeout loop", async () => {
  const [html, css, script, review, logic] = await Promise.all([source("apps/harness-codex-base/index.html"), source("apps/harness-codex-base/app.css"), source("apps/harness-codex-base/app.js"), source(".vibehub/rooms/workbench/note-harness-lowfidelity-product-walkthrough.yaml"), source(".vibehub/rooms/product/note-harness-product-model-history.yaml")]);
  assert.equal(JSON.parse(review).type, "note");
  for (const phrase of ["New task", "vibehub-plugin", "Message Codex", "GPT-5.6 Sol", "Needs you", "Evidence"]) assert.match(html + script, new RegExp(phrase));
  for (const phase of ["Explore", "Ready", "Running", "Needs you", "Review", "Done"]) assert.match(html + script, new RegExp(phase));
  for (const object of ["Branches", "Context", "Ticket", "Run", "Evidence", "Outcome"]) assert.match(html + script + logic, new RegExp(object));
  for (const graphFact of ["Ticket graph", "Ticket dependency graph", "data-open-phase", "Active Run", "by 2 Tickets", "Click any Ticket to enter its Workspace"]) assert.match(html + script, new RegExp(graphFact));
  assert.match(script, /Ready does not mean that an Agent is running/);
  assert.match(script, /Run completed\. The Ticket is still open/);
  assert.match(script, /Outcome does not update durable Context automatically/);
  assert.match(script, /Ticket remains active/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB/);
});

test("Codex-base is keyboard reachable, responsive, and reduced-motion safe", async () => {
  const [html, css, script] = await Promise.all([source("apps/harness-codex-base/index.html"), source("apps/harness-codex-base/app.css"), source("apps/harness-codex-base/app.js")]);
  assert.match(html, /aria-label="Current work surface"/);
  assert.match(html, /aria-label="Work by attention"/);
  assert.match(css, /focus-visible/);
  assert.match(css, /@media \(max-width: 660px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(script, /event\.key === "Escape"/);
});

test("Codex-base server is loopback-only and disposable", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-harness-codex-base.mjs", "--port", "0", "--json"], { cwd: new URL(".", root), stdio: ["ignore", "pipe", "pipe"] });
  context.after(() => child.kill("SIGTERM"));
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const startup = await Promise.race([once(child.stdout, "data").then(([chunk]) => ({ type: "ready", text: String(chunk).trim() })), once(child.stderr, "data").then(([chunk]) => ({ type: "error", text: String(chunk).trim() })), once(child, "exit").then(([code]) => ({ type: "exit", text: `exit ${code}` }))]);
  clearTimeout(timer);
  if (startup.type !== "ready" && /EPERM/.test(startup.text)) { context.skip("loopback sockets are unavailable in this sandbox"); return; }
  assert.equal(startup.type, "ready", startup.text);
  const envelope = JSON.parse(startup.text);
  assert.equal(envelope.localOnly, true);
  const health = await fetch(new URL("health", envelope.url));
  assert.deepEqual(await health.json(), { ok: true, prototype: "harness-codex-base", localOnly: true });
  const exit = once(child, "exit"); child.kill("SIGTERM"); await exit;
});
