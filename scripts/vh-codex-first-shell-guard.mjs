#!/usr/bin/env node

// Drive the Codex-first shell's opt-in browser interaction guard, and the
// real-DOM runtime lifecycle walk, in a fresh headless Chrome over the
// DevTools protocol. A headless page is a visible document, so
// requestAnimationFrame and selectionchange behave as in a foreground tab.
//
//   node scripts/vh-codex-first-shell-guard.mjs            # boots the shell on the fixture app-server over a temporary bound repository, runs every frame in Light and Dark, then the lifecycle walk
//   node scripts/vh-codex-first-shell-guard.mjs --url <printed shell url>   # guard frames against an already running shell (bridge write checks are skipped: no driver-owned repository)
//   node scripts/vh-codex-first-shell-guard.mjs --runtime real --repo <bound repo>   # the same frames and lifecycle walk on the installed codex binary (bridge write checks are skipped: the repository is not driver-owned)
//   --frames wide,narrow-window,narrow-viewport|none   --schemes light,dark   --runs 1   --no-lifecycle   --chrome <binary>   --codex <command>
//
// `--runtime real` boots the production shell on the real app-server (the
// `codex` on PATH, or --codex) against an explicitly named repository, so the
// lifecycle walk's kill, restart and Task recovery are observed on the pinned
// binary instead of the fixture. The repository must be named on purpose: the
// walk starts a Task Turn from its first open Ticket and creates Threads in
// that folder, so point it at a disposable bound repository, never at a
// checkout whose Tickets should not be handed to the model. Nothing is seeded
// there: the bridge runs its preview, placement and scope checks only when
// that repository already lists a finalized "Bridge source chat" Thread, and
// it never writes, because the write verification needs the fixture's call
// log and a repository this driver may reset.
//
// Each frame runs once per emulated prefers-color-scheme, so the shell's
// System theme is exercised in both modes; after the guard, prefers-reduced-
// motion: reduce is emulated and the page's motion audit must report no
// running animation, transition or smooth scroll.
//
// On the fixture runtime the shell this driver boots serves a copy of the
// bridge fixture repository (test/fixtures/bridge-repository.mjs), never the
// checkout it lives in, and the fixture app-server replays one seeded Chat
// with a finalized assistant message. The explicit Chat bridge (Create Task,
// Attach to Task, Quote into Task, Remember) therefore writes real YAML, which
// this driver verifies on disk after every frame and discards before the next
// one.
//
// Exit status is non-zero when any guard check, motion audit, bridge write
// verification or lifecycle step fails.

import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitCount, createBridgeRepository, porcelain, resetBridgeRepository } from "../test/fixtures/bridge-repository.mjs";
import { validateTicket } from "../skills/vibehub-core/scripts/vh.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const options = { url: null, frames: ["wide", "narrow-window", "narrow-viewport"], schemes: ["light", "dark"], runs: 1, lifecycle: true, chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", runtime: "fixture", repo: null, codex: "codex" };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === "--url") options.url = argv[++index];
  else if (flag === "--frames") {
    const value = argv[++index];
    options.frames = value === "none" ? [] : value.split(",");
  }
  else if (flag === "--schemes") options.schemes = argv[++index].split(",");
  else if (flag === "--runs") options.runs = Number(argv[++index]);
  else if (flag === "--no-lifecycle") options.lifecycle = false;
  else if (flag === "--chrome") options.chrome = argv[++index];
  else if (flag === "--runtime") options.runtime = argv[++index];
  else if (flag === "--repo") options.repo = argv[++index];
  else if (flag === "--codex") options.codex = argv[++index];
  else throw new Error(`unknown flag: ${flag}`);
}
if (!existsSync(options.chrome)) throw new Error(`Chrome binary not found: ${options.chrome} (pass --chrome)`);
if (!["fixture", "real"].includes(options.runtime)) throw new Error(`--runtime must be fixture or real, not ${options.runtime}`);
if (options.runtime === "real" && !options.repo) throw new Error("--runtime real needs an explicit --repo: the lifecycle walk hands that repository's first open Ticket to the installed codex");
if (options.runtime !== "real" && options.repo) throw new Error("--repo applies to --runtime real only: the fixture runtime serves a temporary copy of the bridge fixture repository, so bridge writes never land in a real checkout");
const realRuntime = options.runtime === "real";
const FRAMES = {
  wide: { width: 1280, height: 800, narrow: false, mobile: false },
  "narrow-window": { width: 1280, height: 800, narrow: true, mobile: false },
  "narrow-viewport": { width: 390, height: 844, narrow: true, mobile: true },
};

async function launchChrome(viewport) {
  const profile = mkdtempSync(join(tmpdir(), "vibehub-guard-chrome-"));
  const child = spawn(options.chrome, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, `--window-size=${viewport.width},${viewport.height}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", "about:blank"], { stdio: ["ignore", "pipe", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    child.once("exit", (code) => reject(new Error(`chrome exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`chrome did not announce DevTools: ${stderr}`)), 15_000);
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Set();
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const page = async () => {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const errors = [];
    listeners.add((message) => {
      if (message.sessionId !== sessionId) return;
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(" "));
      if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    });
    await send("Runtime.enable", {}, sessionId);
    await send("Page.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: Boolean(viewport.mobile) }, sessionId);
    await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    const evaluate = async (expression, awaitPromise = false) => (await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true }, sessionId)).result.value;
    const emulateMedia = (features) => send("Emulation.setEmulatedMedia", { features }, sessionId);
    return {
      errors,
      evaluate,
      emulateMedia,
      navigate: (url) => send("Page.navigate", { url }, sessionId),
      reload: () => send("Page.reload", {}, sessionId),
      waitFor: (expression, timeoutMs = 20_000) => evaluate(`(async () => { const deadline = Date.now() + ${timeoutMs}; while (Date.now() < deadline) { try { const value = (${expression}); if (value) return value; } catch {} await new Promise((r) => setTimeout(r, 60)); } return null; })()`, true),
      close: () => send("Target.closeTarget", { targetId }),
    };
  };
  return { page, close: () => { ws.close(); child.kill("SIGKILL"); rmSync(profile, { recursive: true, force: true }); } };
}

async function runGuardFrame(shellUrl, frameName, scheme, run, shell = null) {
  const frame = FRAMES[frameName];
  const chrome = await launchChrome(frame);
  const tag = `${frameName} ${frame.width}x${frame.height} ${scheme} run ${run}`;
  try {
    const page = await chrome.page();
    await page.emulateMedia([{ name: "prefers-color-scheme", value: scheme }]);
    const url = new URL(shellUrl);
    url.searchParams.set("chatFixture", "mixed");
    url.searchParams.set("interactionGuard", "1");
    // Bridge writes land only in the repository this driver owns.
    if (shell?.repo) url.searchParams.set("bridgeWrites", "1");
    if (frame.narrow) url.searchParams.set("reviewFrame", "narrow");
    await page.navigate(url.href);
    const summary = await page.evaluate(`(async () => {
      for (let i = 0; i < 900 && !window.__VIBEHUB_INTERACTION_GUARD__; i++) await new Promise((r) => setTimeout(r, 100));
      const s = window.__VIBEHUB_INTERACTION_GUARD__;
      if (!s) return { stalled: true, visibility: document.visibilityState };
      return { ok: s.ok, passed: s.passed, total: s.total, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, canvas: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme, results: s.results, bridge: window.__VIBEHUB_BRIDGE_GUARD__ ?? null };
    })()`, true);
    const expectedCanvas = scheme === "dark" ? "rgb(24, 24, 24)" : "rgb(255, 255, 255)";
    const schemeHonored = summary.theme === "system" && summary.canvas === expectedCanvas;
    let ok = Boolean(summary.ok) && page.errors.length === 0 && summary.clientWidth === summary.scrollWidth && schemeHonored;
    console.log(`[guard ${tag}] ${summary.stalled ? `STALLED (${summary.visibility})` : `${summary.ok ? "PASS" : "FAIL"} browser interaction guard · ${summary.passed}/${summary.total}`} · clientWidth=${summary.clientWidth} scrollWidth=${summary.scrollWidth} · consoleErrors=${page.errors.length} · canvas=${summary.canvas} (${schemeHonored ? "follows" : "IGNORES"} ${scheme} preference)`);
    for (const result of summary.results ?? []) if (!result.pass) console.log(`  ✕ ${result.name}${result.detail ? ` · ${result.detail}` : ""}`);
    for (const line of page.errors) console.log(`  ! ${line}`);
    if (!summary.stalled) {
      // Reduced motion, emulated after the guard so the same mounted document
      // is measured with and without the preference.
      const before = await page.evaluate("window.__VIBEHUB_MOTION_AUDIT__()");
      await page.emulateMedia([{ name: "prefers-color-scheme", value: scheme }, { name: "prefers-reduced-motion", value: "reduce" }]);
      const after = await page.evaluate("window.__VIBEHUB_MOTION_AUDIT__()");
      const motionOk = before.reduced === false && before.offenders.length > 0 && after.reduced === true && after.offenders.length === 0;
      ok = ok && motionOk;
      console.log(`[motion ${tag}] ${motionOk ? "PASS" : "FAIL"} reduced-motion audit · ${before.offenders.length} moving without the preference, ${after.offenders.length} with prefers-reduced-motion: reduce · ${after.scanned} elements scanned`);
      for (const line of after.offenders.slice(0, 10)) console.log(`  ✕ ${line}`);
    }
    if (shell?.repo) {
      ok = verifyBridgeWrites(shell, summary.bridge, tag) && ok;
      await settleStartedTurn(shell, summary.bridge);
    } else {
      // No driver-owned repository to write into, read back and reset: the
      // browser ran the bridge's preview, placement and scope checks only if
      // the shell listed a seeded source Thread, and attempted no write.
      const where = shell ? `the real runtime serves ${shell.repoFolder} as it is` : "--url: a shell this driver did not boot";
      console.log(`[bridge ${tag}] skipped: bridge write checks need a driver-owned repository (${where}) · seeded source Thread ${summary.bridge?.seeded ? "present, so the preview, placement and scope checks ran without writing" : "absent"}`);
    }
    return ok;
  } finally {
    chrome.close();
  }
}

// What the browser's bridge checks claim to have written, read back from the
// driver-owned repository and the fixture app-server's call log: exactly one
// draft Ticket with its origin, one grown provenance list, one Context, no
// commit, and the quoted passage reaching the app-server only inside the
// Task packet. The repository is then returned to its committed graph.
function verifyBridgeWrites(shell, bridge, tag) {
  const steps = [];
  const step = (name, pass, detail) => { steps.push(pass); console.log(`  ${pass ? "✓" : "✕"} ${name}${detail ? ` · ${detail}` : ""}`); };
  const readJson = (path) => { try { return JSON.parse(readFileSync(join(shell.repo.folder, path), "utf8")); } catch { return null; } };
  const dirty = porcelain(shell.repo.folder).sort();
  const ticket = bridge?.ticketPath ? readJson(bridge.ticketPath) : null;
  const context = bridge?.contextPath ? readJson(bridge.contextPath) : null;
  const attached = bridge?.attachPath ? readJson(bridge.attachPath) : null;
  step("browser ran the bridge writes against the seeded Thread", bridge?.seeded === true && bridge.writes === true && Boolean(bridge.ticketId && bridge.ticketPath && bridge.attachPath && bridge.contextPath && bridge.startedThreadId), JSON.stringify(bridge));
  step("the created Ticket is on disk, valid, a draft, and carries the seeded origin verbatim", Boolean(ticket) && validateTicket(ticket).length === 0 && ticket.ticket_id === bridge?.ticketId && ticket.maturity === "draft" && ticket.origin?.harness === "codex" && ticket.origin.thread_id === SEED_THREAD.id && ticket.origin.turn_id === SEED_THREAD.turnId && ticket.origin.item_id === SEED_THREAD.itemId && ticket.origin.selection === null && ticket.provenance_refs?.[0] === `codex-thread:${SEED_THREAD.id}/turn:${SEED_THREAD.turnId}` && ticket.acceptance?.length === 1, ticket ? `${ticket.ticket_id} · ${validateTicket(ticket).length} validation errors` : "no Ticket file");
  step("Attach grew only the open Ticket's provenance_refs", Boolean(attached) && attached.ticket_id === "ticket-bridge-open" && attached.provenance_refs.includes(`codex-thread:${SEED_THREAD.id}/turn:${SEED_THREAD.turnId}`) && attached.origin === undefined && validateTicket(attached).length === 0 && attached.relations.length === 1, attached ? attached.provenance_refs.join(" | ") : "no Ticket file");
  step("Remember wrote one active Context with the exact source reference", Boolean(context) && context.kind === "context" && context.state === "active" && context.type === "decision" && context.source?.ref === `codex-thread:${SEED_THREAD.id}/turn:${SEED_THREAD.turnId}/item:${SEED_THREAD.itemId}` && context.evidence?.[0]?.ref === context.source.ref && JSON.stringify(context.tags) === JSON.stringify(["login", "reliability"]), context ? `${context.context_id} · ${context.source?.ref}` : "no Context file");
  const expectedDirty = bridge?.ticketPath ? [` M ${bridge.attachPath}`, `?? ${bridge.contextPath}`, `?? ${bridge.ticketPath}`].sort() : [];
  step("exactly the three bridge paths are uncommitted and nothing was committed", JSON.stringify(dirty) === JSON.stringify(expectedDirty) && commitCount(shell.repo.folder) === shell.repo.commits, `${dirty.join(", ")} · ${commitCount(shell.repo.folder)} commits`);
  const calls = existsSync(shell.logPath) ? readFileSync(shell.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
  const turnStarts = calls.filter((call) => call.kind === "request" && call.method === "turn/start" && call.params?.threadId === bridge?.startedThreadId);
  const packets = turnStarts.map((call) => { try { return JSON.parse(call.params.input?.[0]?.text ?? ""); } catch { return null; } });
  const quotedPacket = packets.find((packet) => packet?.kind === "vibehub_task_context_packet" && packet.task?.ticketId === bridge?.ticketId && packet.conversation?.humanMessage?.includes("account type"));
  const plainQuote = calls.some((call) => call.kind === "request" && call.method === "turn/start" && call.params?.input?.some((item) => item.type === "text" && item.text.includes("account type") && !item.text.startsWith("{")));
  step("the quoted passage reached the app-server only as the Task packet's humanMessage", Boolean(quotedPacket) && quotedPacket.conversation.humanMessage.includes(`Quoted from Codex thread ${SEED_THREAD.id}`) && !plainQuote && turnStarts.length === 1, quotedPacket ? `${quotedPacket.conversation.humanMessage.length} chars in ${turnStarts.length} turn/start` : "no packet with the quote");
  const afterReset = shell.reset();
  step("the repository returns to its committed graph for the next frame", afterReset.length === 0, afterReset.join(", ") || "clean");
  const ok = steps.every(Boolean);
  console.log(`[bridge ${tag}] ${ok ? "PASS" : "FAIL"} bridge writes verified on disk · ${steps.filter(Boolean).length}/${steps.length}`);
  return ok;
}

// The fixture app-server never finishes a Turn on its own, so the Task Turn
// a frame started is interrupted here: no frame leaves a live Turn behind
// for the next frame or the lifecycle walk to mistake for its own.
async function settleStartedTurn(shell, bridge) {
  if (!bridge?.startedThreadId) return;
  const thread = (await shell.action({ action: "readThread", threadId: bridge.startedThreadId })).body.data?.thread;
  const turn = thread?.turns?.at(-1);
  if (turn && ["inProgress", "running"].includes(turn.status?.type ?? turn.status)) await shell.action({ action: "interruptTurn", threadId: thread.id, turnId: turn.id });
}

// The one Chat the fixture app-server replays for the bridge: a finalized
// Turn with a user message and an assistant answer, in the bound repository's
// own folder so the shell lists it. Beside it, a two-Turn source Thread the
// Fork-from-here guard check cuts at its first Turn through the real host
// action, proving the fixture app-server's lastTurnId truncation end to end.
const SEED_THREAD = Object.freeze({ id: "seed-source-thread", turnId: "seed-turn-1", itemId: "seed-agent-1", title: "Bridge source chat" });
const FORK_SEED_THREAD = Object.freeze({ id: "fork-seed-thread", title: "Fork seed chat" });

function seedFixtureState(statePath, folder) {
  const now = new Date().toISOString();
  const state = {
    counter: 100,
    sections: [],
    threads: [{
      id: SEED_THREAD.id, name: SEED_THREAD.title, preview: "Explain the login flow and propose a fix.", cwd: folder, createdAt: now, updatedAt: now,
      status: { type: "idle" }, forkedFromId: null, section: null, archived: false, policy: { approvalPolicy: null, sandbox: null },
      turns: [{ id: SEED_THREAD.turnId, status: "completed", items: [
        { type: "userMessage", id: "seed-user-1", content: [{ type: "text", text: "Explain the login flow and propose a fix." }] },
        { type: "agentMessage", id: SEED_THREAD.itemId, text: "The login flow retries silently. Every **account type** must log in on the first attempt; retries hide the defect.\n\n- Remove the silent retry.\n- Surface the failure to the human." },
      ] }],
    }, {
      id: FORK_SEED_THREAD.id, name: FORK_SEED_THREAD.title, preview: "First seed question", cwd: folder, createdAt: now, updatedAt: now,
      status: { type: "idle" }, forkedFromId: null, section: null, archived: false, policy: { approvalPolicy: null, sandbox: null },
      turns: [
        { id: "fork-seed-turn-1", status: "completed", items: [
          { type: "userMessage", id: "fork-seed-user-1", content: [{ type: "text", text: "First seed question" }] },
          { type: "agentMessage", id: "fork-seed-agent-1", text: "First seed answer" },
        ] },
        { id: "fork-seed-turn-2", status: "completed", items: [
          { type: "userMessage", id: "fork-seed-user-2", content: [{ type: "text", text: "Second seed question" }] },
          { type: "agentMessage", id: "fork-seed-agent-2", text: "Second seed answer" },
        ] },
      ],
    }],
  };
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
}

// The app-server process the lifecycle walk kills. The fixture records its
// pid in a pidfile; the real `codex` on PATH is a Node launcher around the
// native binary, so the process that owns the Thread is the shell's deepest
// single descendant, and the launcher exits on its own once it is gone.
function descendantPid(pid) {
  let current = pid;
  for (;;) {
    let children = [];
    try {
      children = execFileSync("pgrep", ["-P", String(current)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean).map(Number);
    } catch {
      children = [];
    }
    if (children.length !== 1) return current;
    current = children[0];
  }
}

// Boot the production shell so the lifecycle walk can kill the app-server
// from outside. By default that is the fixture app-server with persisted
// state, a pidfile and a call log, serving a temporary copy of the bridge
// fixture graph, never this checkout, so bridge writes land where the driver
// can verify and discard them. With --runtime real it is the installed codex
// against the named repository as it is: nothing is seeded or reset there.
async function bootShell() {
  const temp = mkdtempSync(join(tmpdir(), "vibehub-guard-shell-"));
  const pidPath = join(temp, "codex-pids");
  const logPath = realRuntime ? null : join(temp, "app-server-calls.jsonl");
  const repo = realRuntime ? null : createBridgeRepository({ prefix: "vibehub-guard-repo-" });
  const repoFolder = realRuntime ? options.repo : repo.folder;
  if (repo) seedFixtureState(join(temp, "codex-state.json"), repo.realFolder);
  // On the fixture, answering a Turn's approval finishes that Turn and every
  // outbound notification joins the call log, so the daily-use walk can
  // order turn/start requests against the turn/completed between them. The
  // lifecycle walk never answers its approval, so its kill still lands on
  // the pending card; the bridge checks never answer theirs either. The
  // userMessage of a Turn becomes durable 2 s after its turn/started (the
  // real server: about 0.4 s, listed about 1.2 s after), wider than the
  // browser's 850 ms poll plus the 750 ms listing retry, so the frames and
  // the lifecycle walk see a bootstrap miss a brand-new Thread before its
  // durable cue lists it.
  const env = realRuntime
    ? { ...process.env, VIBEHUB_CODEX_RESTART_BACKOFF_MS: "1500,2000,5000" }
    : { ...process.env, CODEX_FIXTURE_VERSION: "0.149.0", CODEX_FIXTURE_STATE: join(temp, "codex-state.json"), CODEX_FIXTURE_PIDFILE: pidPath, CODEX_FIXTURE_LOG: logPath, CODEX_FIXTURE_COMPLETE_ON_APPROVAL: "1", CODEX_FIXTURE_LOG_NOTIFICATIONS: "1", CODEX_FIXTURE_USER_MESSAGE_DELAY_MS: "2000", VIBEHUB_CODEX_RESTART_BACKOFF_MS: "1500,2000,5000" };
  const codex = realRuntime ? options.codex : join(root, "test/fixtures/codex-app-server-fixture.mjs");
  const shell = spawn(process.execPath, [join(root, "scripts/vh-codex-first-shell.mjs"), "--repo", repoFolder, "--port", "0", "--json", "--codex", codex], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env });
  const close = async () => {
    shell.kill("SIGTERM");
    await once(shell, "exit").catch(() => {});
    rmSync(temp, { recursive: true, force: true });
    if (repo) rmSync(repo.folder, { recursive: true, force: true });
  };
  const [chunk] = await once(shell.stdout, "data");
  const envelope = JSON.parse(String(chunk));
  const conditions = envelope.runtime.conditions.map((entry) => `${entry.id}=${entry.status}`).join(" ");
  console.log(`[shell ${options.runtime}] ${envelope.runtime.provider} ${envelope.runtime.version} (pin ${envelope.runtime.baselineVersion}, baselineMatch=${envelope.runtime.baselineMatch}) state=${envelope.runtime.state} halt=${envelope.runtime.halt?.conditionId ?? "none"} repo=${repoFolder}`);
  console.log(`[shell ${options.runtime}] conditions: ${conditions}`);
  if (envelope.runtime.state !== "alive") {
    await close();
    throw new Error(`the shell is ${envelope.runtime.state} on ${envelope.runtime.provider} ${envelope.runtime.version}: ${envelope.runtime.halt?.detail ?? "no runtime"}`);
  }
  const token = new URL(envelope.url).hash.slice(1);
  const api = async (path, init = {}) => {
    const base = new URL(envelope.url);
    base.hash = "";
    const response = await fetch(new URL(path, base), { ...init, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
    return { status: response.status, body: await response.json() };
  };
  return {
    url: envelope.url,
    api,
    // The driver-owned bridge repository on the fixture runtime; null on the
    // real runtime, where the named repository is served as it is.
    repo,
    repoFolder,
    logPath,
    action: (payload) => api("api/action", { method: "POST", body: JSON.stringify(payload) }),
    lastPid: () => (realRuntime ? descendantPid(shell.pid) : Number(readFileSync(pidPath, "utf8").trim().split("\n").at(-1))),
    reset: () => (repo ? resetBridgeRepository(repo.folder) : []),
    close,
  };
}

// Real-DOM lifecycle: a live Turn in the production UI, the app-server killed
// under it, the restart, then reloads through ?thread= and ?task=.
async function runLifecycle(shell) {
  const chrome = await launchChrome(FRAMES.wide);
  const steps = [];
  const step = (name, pass, detail) => { steps.push(pass); console.log(`  ${pass ? "✓" : "✕"} ${name}${detail ? ` · ${detail}` : ""}`); };
  try {
    const page = await chrome.page();
    const bootstrap = (await shell.api("api/bootstrap")).body.data;
    const ticketId = bootstrap.graph.tickets.find((ticket) => ticket.capabilities.nextAction.summary.action !== "DONE")?.ticketId ?? bootstrap.graph.tickets[0]?.ticketId;
    const task = ticketId ? (await shell.action({ action: "startTask", ticketId, selectedContextIds: [] })).body.data : null;
    const snapshot = () => page.evaluate(`({ label: document.querySelector('#runtimeLabel').textContent, posture: document.querySelector('#composer').dataset.turnPosture, currentTurnId: document.querySelector('#composer').dataset.currentTurnId ?? null, stopHidden: document.querySelector('#stopTurn').hidden, sendLabel: document.querySelector('#sendButton').getAttribute('aria-label'), inputDisabled: document.querySelector('#composerInput').disabled, boundary: Boolean(document.querySelector('.turn-boundary.runtimeExited')), interruptedBoundary: Boolean(document.querySelector('.turn-boundary.interrupted')), working: [...document.querySelectorAll('.activity-group summary strong')].some((n) => n.textContent.includes('Working')), requests: document.querySelectorAll('.timeline-entry [data-request-id]').length, activeDots: document.querySelectorAll('.thread-state.active').length, activeThreads: [...document.querySelectorAll('.thread-button')].filter((b) => b.querySelector('.thread-state.active')).map((b) => b.dataset.threadId).join('|'), banner: document.querySelector('#stopBanner')?.dataset.conditionId ?? null, thread: new URLSearchParams(location.search).get('thread'), forkDisabled: document.querySelector('[data-fork-thread]')?.disabled ?? null })`);
    await page.navigate(shell.url);
    await page.waitFor(`document.querySelector('#runtimeLabel').textContent === 'Local app-server' && document.querySelector('#newThread') && !document.querySelector('#newThread').disabled`);
    await page.evaluate(`document.querySelector('#newThread').click()`);
    await page.waitFor(`document.querySelector('.thread-heading') && new URLSearchParams(location.search).get('thread')`);
    // The fixture answers every Turn with an approval request, so the kill
    // lands on a pending card; the real model is asked for a long read-only
    // command instead, so the Turn is still running when the process dies.
    const message = realRuntime ? "Use the shell to run exactly `sleep 120` and nothing else, then reply with exactly SLEEP-DONE. Do not read or modify any file." : "keep running";
    await page.evaluate(`(() => { const input = document.querySelector('#composerInput'); input.value = ${JSON.stringify(message)}; input.dispatchEvent(new InputEvent('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
    await page.waitFor(realRuntime
      ? `document.querySelector('#composer').dataset.turnPosture === 'running' && [...document.querySelectorAll('.activity-group summary strong')].some((n) => n.textContent.includes('Working'))`
      : `document.querySelector('#composer').dataset.turnPosture === 'running' && document.querySelectorAll('.timeline-entry [data-request-id]').length > 0`, 60_000);
    const live = await snapshot();
    // The brand-new Chat's own Sidebar row carries the live dot, on the real
    // runtime as on the fixture: the app-server lists the Thread only once
    // its first userMessage is durable, so until then the row is the
    // browser's own thread/start record marked live by turn/started, and a
    // bootstrap the durable cue or the bounded retry fires lists it (the
    // Task Thread the walk started above is live too, with its own dot).
    // The dot is waited for, bounded, then asserted in both modes.
    await page.waitFor(`[...document.querySelectorAll('.thread-button')].some((b) => b.querySelector('.thread-state.active') && b.dataset.threadId === new URLSearchParams(location.search).get('thread'))`, 15_000).catch(() => {});
    const dotted = await snapshot();
    const ownDot = dotted.activeThreads.split("|").includes(dotted.thread);
    // On the fixture the call log proves a bootstrap missed the Thread first:
    // a thread/list issued after its turn/started and before its userMessage
    // item/completed, while the row stayed live.
    const listGap = realRuntime ? null : (() => {
      const calls = existsSync(shell.logPath) ? readFileSync(shell.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
      const startedAt = calls.findIndex((call) => call.kind === "notification" && call.method === "turn/started" && call.params?.threadId === dotted.thread);
      const durableAt = calls.findIndex((call, index) => index > startedAt && call.kind === "notification" && call.method === "item/completed" && call.params?.threadId === dotted.thread && call.params?.item?.type === "userMessage");
      const lists = startedAt >= 0 && durableAt > startedAt ? calls.slice(startedAt + 1, durableAt).filter((call) => call.kind === "request" && call.method === "thread/list").length : -1;
      return { startedAt, durableAt, lists };
    })();
    step("live Turn before the kill, the brand-new Chat's own row live", live.posture === "running" && live.sendLabel === "Queue message" && !live.stopHidden && (realRuntime ? live.working : live.requests > 0) && ownDot && (realRuntime || listGap.lists >= 1), `${live.posture}/${realRuntime ? `working=${live.working}, ` : ""}${live.requests} request cards, send="${live.sendLabel}", stopHidden=${live.stopHidden}, activeDots=${dotted.activeDots} · own dot ${ownDot} (${dotted.thread}) · active ${dotted.activeThreads || "none"}${listGap ? ` · thread/list issued between turn/started and the durable userMessage: ${listGap.lists}` : ""}`);
    process.kill(shell.lastPid(), "SIGKILL");
    await page.waitFor(`document.querySelector('#runtimeLabel').textContent === 'Runtime restarting'`);
    const exited = await snapshot();
    step("runtime exit drops the running posture, voids requests, marks the dead Turn", exited.posture === "idle" && !exited.currentTurnId && exited.stopHidden && exited.sendLabel === "Send message" && exited.inputDisabled && exited.boundary && !exited.working && exited.requests === 0 && exited.activeDots === 0 && exited.forkDisabled === false, `${exited.label}/${exited.posture}`);
    await page.waitFor(`document.querySelector('#runtimeLabel').textContent === 'Local app-server'`, 30_000);
    // Replay is authoritative after the restart: the app-server reports the
    // Turn that died with the process as interrupted, so its boundary
    // replaces the transient "runtime exited" one and nothing is live. The
    // re-read of a real Thread takes longer than a frame, so wait for it.
    await page.waitFor(`document.querySelector('.turn-boundary.interrupted') && !document.querySelector('.turn-boundary.runtimeExited')`, 15_000);
    const restarted = await snapshot();
    step("restart re-reads the same Thread, replay marks the dead Turn interrupted, no live Turn is minted", restarted.thread === live.thread && restarted.posture === "idle" && !restarted.inputDisabled && restarted.interruptedBoundary && !restarted.boundary && !restarted.working && restarted.activeDots === 0 && restarted.banner === null, `${restarted.label}/${restarted.thread}/${restarted.interruptedBoundary ? "interrupted boundary" : "no interrupted boundary"}${restarted.boundary ? " + stale exit boundary" : ""}`);
    await page.reload();
    await page.waitFor(`document.querySelector('#runtimeLabel').textContent === 'Local app-server' && document.querySelector('.thread-heading')`);
    const reloaded = await snapshot();
    step("browser reload recovers the same Thread with idle truth", reloaded.thread === live.thread && reloaded.posture === "idle" && !reloaded.inputDisabled && !reloaded.working && reloaded.activeDots === 0, `${reloaded.thread}`);
    if (task) {
      const taskUrl = new URL(shell.url);
      taskUrl.searchParams.set("task", ticketId);
      await page.navigate(taskUrl.href);
      await page.waitFor(`document.querySelector('.task-workspace')`);
      const workspace = await page.evaluate(`({ ticket: document.querySelector('.task-workspace').dataset.ticketWorkspace, currentWork: document.querySelector('.workspace-aside section:nth-of-type(2)')?.textContent ?? '', thread: new URLSearchParams(location.search).get('thread'), posture: document.querySelector('#composer').dataset.turnPosture, placeholder: document.querySelector('#composerInput').placeholder })`);
      step("reload into ?task= recovers the Task-linked Thread from Codex", workspace.ticket === ticketId && workspace.thread === task.threadId && workspace.currentWork.includes("ready for the next Turn") && !workspace.currentWork.includes("running now") && workspace.posture === "idle" && workspace.placeholder === "Message this Task", `${ticketId} → ${workspace.thread}`);
    } else step("reload into ?task= recovers the Task-linked Thread from Codex", false, "no Ticket in this repository");
    step("no console errors or uncaught exceptions", page.errors.length === 0, page.errors.join(" | "));
  } finally {
    chrome.close();
  }
  const ok = steps.every(Boolean);
  console.log(`[lifecycle wide 1280x800 ${options.runtime}] ${ok ? "PASS" : "FAIL"} runtime lifecycle walk · ${steps.filter(Boolean).length}/${steps.length}`);
  return ok;
}

// Real-DOM daily-use walk on the fixture shell: follow-ups typed while a Turn
// streams queue by default and become their own turn/start after the prior
// turn/completed, an interrupt pauses the queue until an explicit Resume,
// and a queued row can steer the exact live Turn. The fixture's call log is
// the proof: N queued messages become N turn/start requests with distinct
// Turn ids, each after the prior turn/completed, nothing between the
// interrupt and the Resume, and turn/steer naming the live Turn.
async function runQueueWalk(shell) {
  const chrome = await launchChrome(FRAMES.wide);
  const steps = [];
  const step = (name, pass, detail) => { steps.push(pass); console.log(`  ${pass ? "✓" : "✕"} ${name}${detail ? ` · ${detail}` : ""}`); };
  const calls = () => (existsSync(shell.logPath) ? readFileSync(shell.logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  try {
    const page = await chrome.page();
    await page.navigate(shell.url);
    await page.waitFor(`document.querySelector('#runtimeLabel').textContent === 'Local app-server' && document.querySelector('#newThread') && !document.querySelector('#newThread').disabled`);
    await page.evaluate(`document.querySelector('#newThread').click()`);
    await page.waitFor(`document.querySelector('.thread-heading') && new URLSearchParams(location.search).get('thread')`);
    const threadId = await page.evaluate(`new URLSearchParams(location.search).get('thread')`);
    const type = (text, { alt = false } = {}) => page.evaluate(`(() => { const input = document.querySelector('#composerInput'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: ${alt}, bubbles: true })); })()`);
    const queueRows = () => page.evaluate(`[...document.querySelectorAll('#queueTray .queue-row .queue-text')].map((n) => n.textContent)`);
    const userMessages = () => page.evaluate(`[...document.querySelectorAll('.turn.user article > div')].map((n) => n.textContent.trim())`);
    const startsFor = () => calls().filter((call) => call.kind === "request" && call.method === "turn/start" && call.params?.threadId === threadId);
    // The approval card of the live Turn, never a card of an earlier Turn:
    // the fixture (like the runtime) does not withdraw an interrupted Turn's
    // pending approval, so the answer must name the Turn that is running.
    const liveApproval = `document.querySelector('[data-request-turn="' + document.querySelector('#composer').dataset.currentTurnId + '"] [data-request-decision="accept"]')`;
    const awaitApproval = () => page.waitFor(`document.querySelector('#composer').dataset.turnPosture === 'running' && ${liveApproval}`, 30_000);
    const accept = () => page.evaluate(`${liveApproval}.click()`);

    await type("first");
    await awaitApproval();
    await type("follow-up one");
    await page.waitFor(`document.querySelectorAll('#queueTray .queue-row').length === 1`);
    await type("follow-up two");
    await page.waitFor(`document.querySelectorAll('#queueTray .queue-row').length === 2`);
    const sendLabel = await page.evaluate(`document.querySelector('#sendButton').getAttribute('aria-label') + '/' + document.querySelector('#sendButton').textContent`);
    step("two follow-ups typed during the live Turn are queued, not sent", JSON.stringify(await queueRows()) === JSON.stringify(["follow-up one", "follow-up two"]) && startsFor().length === 1 && sendLabel === "Queue message/Queue", `${(await queueRows()).join("|")} · ${startsFor().length} turn/start · send=${sendLabel}`);

    await accept();
    await page.waitFor(`[...document.querySelectorAll('.turn.user article > div')].some((n) => n.textContent.trim() === 'follow-up one') && document.querySelectorAll('#queueTray .queue-row').length === 1`, 30_000);
    step("the first queued follow-up starts as its own Turn after turn/completed", (await userMessages()).slice(-1)[0] === "follow-up one" && JSON.stringify(await queueRows()) === JSON.stringify(["follow-up two"]) && startsFor().length === 2, `${(await userMessages()).join("|")} · queue ${(await queueRows()).join("|")}`);

    await awaitApproval();
    await page.evaluate(`document.querySelector('#stopTurn').click()`);
    await page.waitFor(`document.querySelector('#queueTray .queue-paused') && document.querySelector('#composer').dataset.turnPosture === 'idle'`);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const pausedCopy = await page.evaluate(`document.querySelector('#queueTray .queue-paused')?.textContent ?? ''`);
    step("the interrupt pauses the queue and nothing is sent until Resume", pausedCopy.includes("Queue paused because you interrupted") && startsFor().length === 2 && JSON.stringify(await queueRows()) === JSON.stringify(["follow-up two"]), `${pausedCopy.slice(0, 60)} · ${startsFor().length} turn/start`);

    await page.evaluate(`document.querySelector('[data-resume-queue]').click()`);
    await page.waitFor(`[...document.querySelectorAll('.turn.user article > div')].some((n) => n.textContent.trim() === 'follow-up two') && document.querySelector('#queueTray').hidden`, 30_000);
    step("Resume starts the paused head as its own Turn", startsFor().length === 3 && (await userMessages()).slice(-1)[0] === "follow-up two", `${(await userMessages()).join("|")}`);
    await awaitApproval();
    await accept();
    await page.waitFor(`document.querySelector('#composer').dataset.turnPosture === 'idle'`, 30_000);

    await type("fourth");
    await awaitApproval();
    const liveTurnId = await page.evaluate(`document.querySelector('#composer').dataset.currentTurnId`);
    await type("steer from the row");
    await page.waitFor(`document.querySelectorAll('#queueTray .queue-row').length === 1`);
    await page.evaluate(`document.querySelector('[data-steer-queued]').click()`);
    await page.waitFor(`document.querySelector('#queueTray').hidden`);
    await type("alt steer", { alt: true });
    await page.waitFor(`[...document.querySelectorAll('.turn.user article > div')].some((n) => n.textContent.trim() === 'alt steer')`, 30_000);
    const steers = calls().filter((call) => call.kind === "request" && call.method === "turn/steer" && call.params?.threadId === threadId).map((call) => [call.params.expectedTurnId, call.params.input[0].text]);
    step("a queued row and Alt+Enter steer the exact live Turn through turn/steer", JSON.stringify(steers) === JSON.stringify([[liveTurnId, "steer from the row"], [liveTurnId, "alt steer"]]) && startsFor().length === 4, JSON.stringify(steers));
    await accept();
    await page.waitFor(`document.querySelector('#composer').dataset.turnPosture === 'idle'`, 30_000);

    const timeline = calls()
      .filter((call) => (call.kind === "request" && call.method === "turn/start" && call.params?.threadId === threadId) || (call.kind === "notification" && call.method === "turn/completed" && call.params?.threadId === threadId))
      .map((call) => (call.kind === "request" ? `start:${call.params.input[0].text}` : `completed:${call.params.turn.status}`));
    const turnIds = calls().filter((call) => call.kind === "notification" && call.method === "turn/started" && call.params?.threadId === threadId).map((call) => call.params.turn.id);
    const expected = ["start:first", "completed:completed", "start:follow-up one", "completed:interrupted", "start:follow-up two", "completed:completed", "start:fourth", "completed:completed"];
    step("the fixture call log shows each queued message as its own turn/start with a distinct Turn id after the prior turn/completed", JSON.stringify(timeline) === JSON.stringify(expected) && turnIds.length === 4 && new Set(turnIds).size === 4, `${timeline.join(" → ")} · ids ${turnIds.join(",")}`);

    // @ and $ on the real host: the file picker is fuzzyFileSearch over the
    // bound repository, the skill picker is skills/list, and the app-server
    // log carries the exact input arrays with UTF-8 byte ranges.
    const pick = async (text, optionText) => {
      await page.evaluate(`(() => { const input = document.querySelector('#composerInput'); input.focus(); input.value = ${JSON.stringify(text)}; input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' })); })()`);
      await page.waitFor(`[...document.querySelectorAll('#mentionPicker [role="option"] strong')].some((n) => n.textContent === ${JSON.stringify(optionText)})`);
      await page.evaluate(`(() => { const input = document.querySelector('#composerInput'); const options = [...document.querySelectorAll('#mentionPicker [role="option"] strong')]; const index = options.findIndex((n) => n.textContent === ${JSON.stringify(optionText)}); for (let i = 0; i < index; i += 1) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
      await page.waitFor(`document.querySelector('#mentionPicker').hidden`);
      return page.evaluate(`document.querySelector('#composerInput').value`);
    };
    const afterFile = await pick("voir @READ", "@README.md");
    const afterSkill = await pick(`${afterFile}puis $fixture-rev`, "$fixture-review");
    const chips = await page.evaluate(`[...document.querySelectorAll('#mentionTray .mention-chip')].map((n) => n.getAttribute('aria-label'))`);
    await type(`${afterSkill}merci`);
    await awaitApproval();
    const mentionStart = calls().filter((call) => call.kind === "request" && call.method === "turn/start" && call.params?.threadId === threadId).at(-1)?.params.input ?? null;
    const mentionText = "voir @README.md puis $fixture-review merci";
    const byteRange = (prefix, placeholder) => ({ start: Buffer.byteLength(prefix, "utf8"), end: Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(placeholder, "utf8") });
    const expectedInput = [
      { type: "text", text: mentionText, text_elements: [{ byteRange: byteRange("voir ", "@README.md"), placeholder: "@README.md" }, { byteRange: byteRange("voir @README.md puis ", "$fixture-review"), placeholder: "$fixture-review" }] },
      { type: "mention", name: "README.md", path: join(shell.repo.realFolder, "README.md") },
      { type: "skill", name: "fixture-review", path: "/tmp/codex-fixture/skills/fixture-review/SKILL.md" },
    ];
    const searched = calls().filter((call) => call.kind === "request" && call.method === "fuzzyFileSearch").map((call) => call.params);
    const replayedChips = await page.evaluate(`[...document.querySelectorAll('.turn.user .mention-chip')].map((n) => n.textContent)`);
    step("@ and $ pickers read fuzzyFileSearch and skills/list, and the app-server log carries the exact input arrays with UTF-8 byte ranges", JSON.stringify(mentionStart) === JSON.stringify(expectedInput) && chips.join("|") === "File mention @README.md|Skill mention $fixture-review" && searched.some((params) => params.query === "READ" && params.roots.length === 1) && calls().some((call) => call.kind === "request" && call.method === "skills/list") && replayedChips.join("|") === "@README.md|$fixture-review", `${JSON.stringify(mentionStart)} · replay ${replayedChips.join("|")}`);
    await accept();
    await page.waitFor(`document.querySelector('#composer').dataset.turnPosture === 'idle'`, 30_000);

    // Context use on the real host: the indicator carries the fixture's own
    // thread/tokenUsage/updated total against its 272,000 window, Compact
    // runs thread/compact/start as its own Turn whose contextCompaction item
    // is the boundary row, and the next usage update is smaller.
    const usageBefore = calls().filter((call) => call.kind === "notification" && call.method === "thread/tokenUsage/updated" && call.params?.threadId === threadId).at(-1)?.params.tokenUsage;
    const expectedBefore = `Context ${Math.round((usageBefore?.total.totalTokens / usageBefore?.modelContextWindow) * 100)}% · ${usageBefore?.total.totalTokens.toLocaleString("en-US")} of ${usageBefore?.modelContextWindow.toLocaleString("en-US")} tokens`;
    // The log is written at once; the browser polls, so wait for it to catch up.
    await page.waitFor(`document.querySelector('#contextLabel')?.textContent === ${JSON.stringify(expectedBefore)} && !document.querySelector('[data-compact-thread]').disabled`);
    const labelBefore = await page.evaluate(`document.querySelector('#contextLabel').textContent`);
    await page.evaluate(`document.querySelector('[data-compact-thread]').click()`);
    await page.waitFor(`document.querySelector('.turn-boundary.compacted') && document.querySelector('#composer').dataset.turnPosture === 'idle'`, 30_000);
    await page.waitFor(`document.querySelector('#contextLabel').textContent !== ${JSON.stringify(labelBefore)}`);
    const labelAfter = await page.evaluate(`document.querySelector('#contextLabel').textContent`);
    const usageAfter = calls().filter((call) => call.kind === "notification" && call.method === "thread/tokenUsage/updated" && call.params?.threadId === threadId).at(-1)?.params.tokenUsage;
    const compactRequests = calls().filter((call) => call.kind === "request" && call.method === "thread/compact/start" && call.params?.threadId === threadId).length;
    step("the context indicator carries the runtime's own token usage and Compact runs thread/compact/start as a boundary Turn", labelBefore === expectedBefore && compactRequests === 1 && usageAfter?.total.totalTokens < usageBefore?.total.totalTokens && labelAfter.includes(`${usageAfter?.total.totalTokens.toLocaleString("en-US")} of`) && !calls().some((call) => call.kind === "notification" && call.method === "thread/compacted"), `${labelBefore} → ${labelAfter} · ${compactRequests} thread/compact/start`);

    // Rename and posture on the real host: thread/name/set then
    // thread/name/updated rename every surface; Full access is confirmed,
    // travels as the exact turn/start keys, and the runtime's
    // thread/settings/updated becomes the header's reported posture.
    await page.evaluate(`document.querySelector('[data-rename-thread][data-rename-where="header"]').click()`);
    await page.evaluate(`(() => { const input = document.querySelector('[data-rename-form] input'); input.value = 'Walk renamed chat'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); input.closest('form').requestSubmit(); })()`);
    await page.waitFor(`document.querySelector('#activeThreadTitle')?.textContent === 'Walk renamed chat' && document.querySelector('#routeTitle').textContent === 'Walk renamed chat' && [...document.querySelectorAll('.thread-button strong')].some((n) => n.textContent === 'Walk renamed chat')`);
    const nameCalls = calls().filter((call) => call.params?.threadId === threadId && ((call.kind === "request" && call.method === "thread/name/set") || (call.kind === "notification" && call.method === "thread/name/updated"))).map((call) => `${call.method}:${call.params.name ?? call.params.threadName}`);
    step("header Rename runs thread/name/set and thread/name/updated renames the header, route title and Sidebar row", JSON.stringify(nameCalls) === JSON.stringify(["thread/name/set:Walk renamed chat", "thread/name/updated:Walk renamed chat"]), nameCalls.join(" → "));
    const postureBefore = await page.evaluate(`document.querySelector('#threadPosture').textContent`);
    await page.evaluate(`(() => { const control = document.querySelector('#permissionsControl'); control.value = 'fullAccess'; control.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await page.waitFor(`!document.querySelector('#fullAccessDialog').hidden`);
    await page.evaluate(`document.querySelector('#confirmFullAccess').click()`);
    await page.waitFor(`document.querySelector('#threadPosture').dataset.pending === 'fullAccess'`);
    await type("with full access");
    await awaitApproval();
    await page.waitFor(`document.querySelector('#threadPosture').textContent.includes('reported by thread/settings/updated')`);
    const postureAfter = await page.evaluate(`document.querySelector('#threadPosture').textContent`);
    const postureTurnLine = await page.evaluate(`[...document.querySelectorAll('[data-turn-settings]')].at(-1)?.textContent ?? ''`);
    const postureStart = calls().filter((call) => call.kind === "request" && call.method === "turn/start" && call.params?.threadId === threadId).at(-1)?.params;
    await accept();
    await page.waitFor(`document.querySelector('#composer').dataset.turnPosture === 'idle'`, 30_000);
    await page.evaluate(`(() => { const control = document.querySelector('#permissionsControl'); control.value = 'askForApproval'; control.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await type("back to asking");
    await awaitApproval();
    const askStart = calls().filter((call) => call.kind === "request" && call.method === "turn/start" && call.params?.threadId === threadId).at(-1)?.params;
    await accept();
    await page.waitFor(`document.querySelector('#composer').dataset.turnPosture === 'idle'`, 30_000);
    step("Full access is confirmed, travels as approvalPolicy never and sandboxPolicy dangerFullAccess, and the runtime's thread/settings/updated becomes the reported posture; Ask for approval switches back",
      postureBefore === "Approval on-request · Sandbox workspaceWrite · reported by thread/start" && postureStart?.approvalPolicy === "never" && postureStart?.sandboxPolicy?.type === "dangerFullAccess" && postureAfter === "Approval never · Sandbox dangerFullAccess · reported by thread/settings/updated" && postureTurnLine.includes("never · dangerFullAccess") && askStart?.approvalPolicy === "on-request" && askStart?.sandboxPolicy?.type === "workspaceWrite",
      `${postureBefore} → ${postureAfter} · turn ${JSON.stringify({ approvalPolicy: postureStart?.approvalPolicy, sandboxPolicy: postureStart?.sandboxPolicy })} then ${JSON.stringify({ approvalPolicy: askStart?.approvalPolicy, sandboxPolicy: askStart?.sandboxPolicy })} · Turn line: ${postureTurnLine}`);
    // A completion in a background Chat on the real host: the Turn starts
    // here, the human opens a new Chat, the approval is answered from
    // outside, and turn/completed from the event feed raises one in-app
    // notice with the Sidebar badge; the default preference (unfocused) and
    // the page's focus emulation mean no browser Notification is due.
    await type("finish in the background");
    await awaitApproval();
    // The live Turn's own approval: an interrupted Turn's approval stays
    // pending in the host, so the request is chosen by Turn id.
    const backgroundTurnId = await page.evaluate(`document.querySelector('#composer').dataset.currentTurnId`);
    const backgroundRequest = (await shell.api("api/bootstrap")).body.data.pendingRequests.find((request) => request.params?.threadId === threadId && request.params?.turnId === backgroundTurnId);
    await page.evaluate(`document.querySelector('#newThread').click()`);
    await page.waitFor(`new URLSearchParams(location.search).get('thread') !== ${JSON.stringify(threadId)} && document.querySelector('.thread-heading')`);
    const resolved = await shell.action({ action: "resolveRequest", requestId: backgroundRequest.id, decision: "accept" });
    await page.waitFor(`document.querySelector('#noticeStatus').textContent.includes('finished a Turn')`, 30_000);
    const noticed = await page.evaluate(`({ status: document.querySelector('#noticeStatus').textContent, badge: document.querySelector('[data-thread-id="${threadId}"] .completion-badge')?.textContent ?? null, active: new URLSearchParams(location.search).get('thread') })`);
    step("a Turn completing in a background Chat on the real host raises one in-app notice and the Sidebar badge", resolved.status === 200 && noticed.status === "Codex finished a Turn in Walk renamed chat" && noticed.badge === "DONE" && noticed.active !== threadId, `${noticed.status} · badge ${noticed.badge}`);
    step("no console errors or uncaught exceptions", page.errors.length === 0, page.errors.join(" | "));
  } finally {
    chrome.close();
  }
  const ok = steps.every(Boolean);
  console.log(`[queue wide 1280x800 ${options.runtime}] ${ok ? "PASS" : "FAIL"} follow-up queue walk · ${steps.filter(Boolean).length}/${steps.length}`);
  return ok;
}

let ok = true;
const shell = options.url ? null : await bootShell();
try {
  const url = options.url ?? shell.url;
  for (const frame of options.frames) {
    if (!FRAMES[frame]) throw new Error(`unknown frame: ${frame}`);
    for (const scheme of options.schemes) {
      if (!["light", "dark"].includes(scheme)) throw new Error(`unknown scheme: ${scheme}`);
      for (let run = 1; run <= options.runs; run += 1) ok = (await runGuardFrame(url, frame, scheme, run, shell)) && ok;
    }
  }
  if (options.lifecycle && shell) ok = (await runLifecycle(shell)) && ok;
  else if (options.lifecycle) console.log("[lifecycle] skipped: the lifecycle walk needs a shell this driver booted (omit --url)");
  // The queue walk costs four model Turns, so it runs on the fixture only.
  if (options.lifecycle && shell && !realRuntime) ok = (await runQueueWalk(shell)) && ok;
  else if (options.lifecycle) console.log(`[queue] skipped: the follow-up queue walk runs on the fixture shell this driver booted (${realRuntime ? "the real runtime would spend model Turns" : "omit --url"})`);
} finally {
  await shell?.close();
}
process.exit(ok ? 0 : 1);
