import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("Codex-first shell uses real app-server ownership and additive VibeHub Tasks", async () => {
  const [html, script, server, review] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.js"),
    source("scripts/vh-codex-first-shell-prototype.mjs"),
    source("docs/CODEX_FIRST_SHELL_PROTOTYPE_REVIEW.md"),
  ]);
  for (const label of ["New task", "Codex", "Tasks", "Rooms", "Project", "Appearance"]) assert.match(html, new RegExp(label, "i"));
  for (const request of ["thread/list", "thread/read", "thread/start", "turn/start", "turn/interrupt"]) assert.match(server, new RegExp(request.replace("/", "\\/")));
  for (const event of ["turn/started", "turn/completed", "serverRequest"]) assert.match(server + script, new RegExp(event.replace("/", "\\/")));
  assert.match(server, /buildTicketHandoff/);
  assert.match(server, /startCodexTask/);
  assert.match(script, /vibehub_ticket_handoff/);
  assert.match(script, /relation\.prerequisiteTicketId/);
  assert.match(script, /relation\.dependentTicketId/);
  assert.match(review, /Codex owns Threads, Turns, tools, approvals and execution/);
  assert.doesNotMatch(html + script, /DeepSeek|native DSH|DSH Session/);
  assert.doesNotMatch(html + script + server, /localStorage|sessionStorage|sqlite/i);
});

test("Codex-first shell exposes ordinary audio honestly and routes real approvals", async () => {
  const [html, script, server, lock] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.js"),
    source("scripts/vh-codex-first-shell-prototype.mjs"),
    source("packages/codex-adapter/upstream-lock.json"),
  ]);
  assert.match(html, /Record voice input/);
  assert.match(script, /navigator\.mediaDevices\.getUserMedia/);
  assert.match(script, /MediaRecorder/);
  assert.match(script, /ordinary Codex audio input/);
  assert.match(server, /audioInput: true/);
  assert.match(server, /realtimeConversation: false/);
  assert.match(lock, /"stableTurnInputs": \["audio", "localAudio"\]/);
  for (const decision of ["accept", "acceptForSession", "decline", "cancel"]) assert.match(server, new RegExp(`"${decision}"`));
  assert.match(server, /item\/tool\/requestUserInput/);
  assert.match(script, /data-request-decision/);
});

test("Codex light and dark primitives share one responsive accessible shell", async () => {
  const [html, css, script] = await Promise.all([
    source("apps/codex-first-shell-prototype/index.html"),
    source("apps/codex-first-shell-prototype/app.css"),
    source("apps/codex-first-shell-prototype/app.js"),
  ]);
  for (const exact of ["#0169cc", "#fff", "#0d0d0d", "#339cff", "#181818"]) assert.match(css.toLowerCase(), new RegExp(exact));
  assert.match(css, /Inter, -apple-system/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.app-shell[^}]+color: var\(--text\)/);
  assert.match(css, /\.graph-edges[^}]+pointer-events: none/);
  assert.match(css, /\.graph-edges \{ display: none; \}/);
  assert.doesNotMatch(css, /\.task-card::before/);
  assert.match(script, /requestAnimationFrame\(renderGraphEdges\)/);
  assert.match(html, /aria-label="Application navigation"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /meta name="color-scheme"/);
});

test("Codex-first prototype host is loopback-only, bounded, and connected to the real runtime", async (context) => {
  const child = spawn(process.execPath, ["scripts/vh-codex-first-shell-prototype.mjs", "--repo", ".", "--port", "0", "--json"], {
    cwd: new URL(".", root),
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const startup = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => ({ type: "ready", text: String(chunk).trim() })),
    once(child.stderr, "data").then(([chunk]) => ({ type: "error", text: String(chunk).trim() })),
    once(child, "exit").then(([code]) => ({ type: "exit", text: `exit ${code}` })),
  ]);
  clearTimeout(timer);
  if (startup.type !== "ready" && /EPERM|Operation not permitted/.test(startup.text)) {
    context.skip("local app-server or loopback sockets are unavailable in this sandbox");
    return;
  }
  assert.equal(startup.type, "ready", startup.text);
  const envelope = JSON.parse(startup.text);
  assert.equal(envelope.localOnly, true);
  assert.equal(envelope.repositoryWrites, false);
  assert.equal(envelope.codexRuntime, true);
  const url = new URL(envelope.url);
  const token = url.hash.slice(1);
  url.hash = "";
  const health = await fetch(new URL("health", url));
  assert.deepEqual(await health.json(), { ok: true, prototype: "codex-first-shell", localOnly: true, repositoryWrites: false, codexRuntime: true });
  const unauthorized = await fetch(new URL("api/bootstrap", url));
  assert.equal(unauthorized.status, 401);
  const bootstrap = await fetch(new URL("api/bootstrap", url), { headers: { authorization: `Bearer ${token}` } });
  const payload = await bootstrap.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.data.account.authenticated, true);
  assert.equal(payload.data.runtime.provider, "Codex app-server");
  assert.equal(payload.data.runtime.realtimeConversation, false);
  assert.ok(payload.data.graph.tickets.some((ticket) => ticket.ticketId === "ticket-prototype-codex-first-vibehub-shell"));
  const rejected = await fetch(url, { method: "POST" });
  assert.equal(rejected.status, 405);
  const exit = once(child, "exit");
  child.kill("SIGTERM");
  await exit;
});
