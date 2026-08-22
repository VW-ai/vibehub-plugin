#!/usr/bin/env node

// Drive the Codex-first shell's opt-in browser interaction guard, and the
// real-DOM runtime lifecycle walk, in a fresh headless Chrome over the
// DevTools protocol. A headless page is a visible document, so
// requestAnimationFrame and selectionchange behave as in a foreground tab.
//
//   node scripts/vh-codex-first-shell-guard.mjs            # boots the shell on the fixture app-server, runs every frame in Light and Dark, then the lifecycle walk
//   node scripts/vh-codex-first-shell-guard.mjs --url <printed shell url>   # guard frames against an already running shell
//   --frames wide,narrow-window,narrow-viewport   --schemes light,dark   --runs 1   --no-lifecycle   --chrome <binary>
//
// Each frame runs once per emulated prefers-color-scheme, so the shell's
// System theme is exercised in both modes; after the guard, prefers-reduced-
// motion: reduce is emulated and the page's motion audit must report no
// running animation, transition or smooth scroll.
//
// Exit status is non-zero when any guard check, motion audit or lifecycle step fails.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const options = { url: null, frames: ["wide", "narrow-window", "narrow-viewport"], schemes: ["light", "dark"], runs: 1, lifecycle: true, chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === "--url") options.url = argv[++index];
  else if (flag === "--frames") options.frames = argv[++index].split(",");
  else if (flag === "--schemes") options.schemes = argv[++index].split(",");
  else if (flag === "--runs") options.runs = Number(argv[++index]);
  else if (flag === "--no-lifecycle") options.lifecycle = false;
  else if (flag === "--chrome") options.chrome = argv[++index];
  else throw new Error(`unknown flag: ${flag}`);
}
if (!existsSync(options.chrome)) throw new Error(`Chrome binary not found: ${options.chrome} (pass --chrome)`);
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

async function runGuardFrame(shellUrl, frameName, scheme, run) {
  const frame = FRAMES[frameName];
  const chrome = await launchChrome(frame);
  const tag = `${frameName} ${frame.width}x${frame.height} ${scheme} run ${run}`;
  try {
    const page = await chrome.page();
    await page.emulateMedia([{ name: "prefers-color-scheme", value: scheme }]);
    const url = new URL(shellUrl);
    url.searchParams.set("chatFixture", "mixed");
    url.searchParams.set("interactionGuard", "1");
    if (frame.narrow) url.searchParams.set("reviewFrame", "narrow");
    await page.navigate(url.href);
    const summary = await page.evaluate(`(async () => {
      for (let i = 0; i < 900 && !window.__VIBEHUB_INTERACTION_GUARD__; i++) await new Promise((r) => setTimeout(r, 100));
      const s = window.__VIBEHUB_INTERACTION_GUARD__;
      if (!s) return { stalled: true, visibility: document.visibilityState };
      return { ok: s.ok, passed: s.passed, total: s.total, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, canvas: getComputedStyle(document.body).backgroundColor, theme: document.documentElement.dataset.theme, results: s.results };
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
    return ok;
  } finally {
    chrome.close();
  }
}

// Boot the production shell on the fixture app-server with persisted state
// and a pidfile, so the lifecycle walk can kill the app-server from outside.
async function bootShell() {
  const temp = mkdtempSync(join(tmpdir(), "vibehub-guard-shell-"));
  const pidPath = join(temp, "codex-pids");
  const env = { ...process.env, CODEX_FIXTURE_VERSION: "0.147.0", CODEX_FIXTURE_STATE: join(temp, "codex-state.json"), CODEX_FIXTURE_PIDFILE: pidPath, VIBEHUB_CODEX_RESTART_BACKOFF_MS: "1500,2000,5000" };
  const shell = spawn(process.execPath, [join(root, "scripts/vh-codex-first-shell.mjs"), "--repo", root, "--port", "0", "--json", "--codex", join(root, "test/fixtures/codex-app-server-fixture.mjs")], { cwd: root, stdio: ["ignore", "pipe", "pipe"], env });
  const [chunk] = await once(shell.stdout, "data");
  const envelope = JSON.parse(String(chunk));
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
    action: (payload) => api("api/action", { method: "POST", body: JSON.stringify(payload) }),
    lastPid: () => Number(readFileSync(pidPath, "utf8").trim().split("\n").at(-1)),
    async close() {
      shell.kill("SIGTERM");
      await once(shell, "exit").catch(() => {});
      rmSync(temp, { recursive: true, force: true });
    },
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
    const snapshot = () => page.evaluate(`({ label: document.querySelector('#runtimeLabel').textContent, posture: document.querySelector('#composer').dataset.turnPosture, currentTurnId: document.querySelector('#composer').dataset.currentTurnId ?? null, stopHidden: document.querySelector('#stopTurn').hidden, sendLabel: document.querySelector('#sendButton').getAttribute('aria-label'), inputDisabled: document.querySelector('#composerInput').disabled, boundary: Boolean(document.querySelector('.turn-boundary.runtimeExited')), working: [...document.querySelectorAll('.activity-group summary strong')].some((n) => n.textContent.includes('Working')), requests: document.querySelectorAll('.timeline-entry [data-request-id]').length, activeDots: document.querySelectorAll('.thread-state.active').length, banner: document.querySelector('#stopBanner')?.dataset.conditionId ?? null, thread: new URLSearchParams(location.search).get('thread'), forkDisabled: document.querySelector('[data-fork-thread]')?.disabled ?? null })`);
    await page.navigate(shell.url);
    await page.waitFor(`document.querySelector('#runtimeLabel').textContent === 'Local app-server' && document.querySelector('#newThread') && !document.querySelector('#newThread').disabled`);
    await page.evaluate(`document.querySelector('#newThread').click()`);
    await page.waitFor(`document.querySelector('.thread-heading') && new URLSearchParams(location.search).get('thread')`);
    await page.evaluate(`(() => { const input = document.querySelector('#composerInput'); input.value = 'keep running'; input.dispatchEvent(new InputEvent('input', { bubbles: true })); document.querySelector('#composer').requestSubmit(); })()`);
    await page.waitFor(`document.querySelector('#composer').dataset.turnPosture === 'running' && document.querySelectorAll('.timeline-entry [data-request-id]').length > 0`);
    const live = await snapshot();
    step("live Turn before the kill", live.posture === "running" && live.sendLabel === "Steer current turn" && !live.stopHidden && live.requests > 0 && live.activeDots === 1, `${live.posture}/${live.requests} request cards`);
    process.kill(shell.lastPid(), "SIGKILL");
    await page.waitFor(`document.querySelector('#runtimeLabel').textContent === 'Runtime restarting'`);
    const exited = await snapshot();
    step("runtime exit drops the running posture, voids requests, marks the dead Turn", exited.posture === "idle" && !exited.currentTurnId && exited.stopHidden && exited.sendLabel === "Send message" && exited.inputDisabled && exited.boundary && !exited.working && exited.requests === 0 && exited.activeDots === 0 && exited.forkDisabled === false, `${exited.label}/${exited.posture}`);
    await page.waitFor(`document.querySelector('#runtimeLabel').textContent === 'Local app-server'`, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const restarted = await snapshot();
    step("restart re-reads the same Thread without minting a live Turn", restarted.thread === live.thread && restarted.posture === "idle" && !restarted.inputDisabled && restarted.boundary && !restarted.working && restarted.activeDots === 0 && restarted.banner === null, `${restarted.label}/${restarted.thread}`);
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
  console.log(`[lifecycle wide 1280x800] ${ok ? "PASS" : "FAIL"} runtime lifecycle walk · ${steps.filter(Boolean).length}/${steps.length}`);
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
      for (let run = 1; run <= options.runs; run += 1) ok = (await runGuardFrame(url, frame, scheme, run)) && ok;
    }
  }
  if (options.lifecycle && shell) ok = (await runLifecycle(shell)) && ok;
  else if (options.lifecycle) console.log("[lifecycle] skipped: the lifecycle walk needs a shell this driver booted (omit --url)");
} finally {
  await shell?.close();
}
process.exit(ok ? 0 : 1);
