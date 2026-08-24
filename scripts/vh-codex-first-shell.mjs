#!/usr/bin/env node

// VibeHub Codex-first shell launcher.
//
// Boot order: the Codex app-server process is owned by
// packages/codex-adapter/client.mjs, the single-harness routing is owned by
// packages/harness-core (shell.mjs over router.mjs), Codex Projects and Task
// Context packets are owned by packages/codex-adapter, and this script owns
// only the loopback host, the short-lived bearer URL, the host-side
// projections of the Git-native repository and two explicit repository write
// classes: importing a single-folder Codex Project as this VibeHub Project,
// and the Chat bridge (Create Task, Attach to Task, Remember) that writes one
// Ticket or one Context document through vh.mjs's validated entry points.

import crypto from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../packages/codex-adapter/client.mjs";
import { createCodexHarnessAdapter } from "../packages/codex-adapter/harness.mjs";
import { probeCodexSchema } from "../packages/codex-adapter/probe-schema.mjs";
import { CODEX_PROJECT_CAPABILITIES, CodexProjectsAdapter, publicCodexThread } from "../packages/codex-adapter/projects.mjs";
import { evaluateStopConditions, firstViolation, observedRuntimeVersion } from "../packages/codex-adapter/stop-conditions.mjs";
import { buildTaskContextPacket, startTaskContextThread, taskLinkFromPreview } from "../packages/codex-adapter/task-context.mjs";
import { createSharedHarnessShell } from "../packages/harness-core/shell.mjs";
import { eventWindow } from "../apps/codex-first-shell/event-window.mjs";
import { requestDescriptor, unsupportedServerRequestResult, validateRequestDecision } from "../apps/codex-first-shell/server-request-registry.mjs";
import { buildCandidateTicketHandoff, buildTicketHandoff, buildUiSnapshot } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { VibeHubError, applyTickets, documents, initProject, outcomeAccepted, projectCompatibility, putContext, readDocument, validateTicket, writeDocument } from "../skills/vibehub-core/scripts/vh.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const SHELL_ID = "codex-first-shell";
const EVENT_LIMIT = 500;
const BODY_LIMIT = 12 * 1024 * 1024;
const APP_SERVER_TIMEOUT_MS = 120_000;
const SEARCH_LIMIT = 20;
const FILE_SEARCH_LIMIT = 20;
const FILE_QUERY_LIMIT = 256;
// One Turn input carries at most this many items: text, attachments and the
// mention or skill item each chip emits.
const INPUT_ITEM_LIMIT = 16;
const TEXT_ELEMENT_LIMIT = 64;
// Follow-ups queued behind a live Turn, per Thread.
const QUEUE_LIMIT = 20;
const NOTIFICATION_MODES = Object.freeze(["always", "unfocused", "never"]);
// The stable AskForApproval strings; the granular object form stays out.
const APPROVAL_POLICIES = Object.freeze(["untrusted", "on-request", "never"]);
// SandboxPolicy variants of the pinned schema with the fields each accepts.
const SANDBOX_POLICIES = Object.freeze({
  dangerFullAccess: Object.freeze([]),
  readOnly: Object.freeze(["networkAccess"]),
  workspaceWrite: Object.freeze(["networkAccess", "writableRoots", "excludeSlashTmp", "excludeTmpdirEnvVar"]),
  externalSandbox: Object.freeze(["networkAccess"]),
});
const IMAGE_DETAILS = new Set(["auto", "low", "high", "original"]);
// When the app-server exits on its own the host respawns it with this
// backoff; after the last attempt the runtime halts visibly instead of looping.
const RESTART_BACKOFF_MS = Object.freeze(parseBackoff(process.env.VIBEHUB_CODEX_RESTART_BACKOFF_MS, [500, 2000, 5000]));
// readTask and the explicit Chat bridge are served from the checked-in
// repository alone, so they stay usable while the app-server is restarting or
// halted; every other action needs the live app-server and is refused
// truthfully while it is unavailable.
const ADAPTER_FREE_ACTIONS = new Set(["readTask", "listTaskTargets", "listRooms", "previewCreateTask", "createTask", "attachTask", "remember"]);
// Transient host session state is read and edited without the runtime: the
// queued follow-ups of a Thread and the notification preference.
const HOST_STATE_ACTIONS = new Set(["listQueue", "updateQueued", "deleteQueued", "setNotificationPreference"]);
const THREAD_POLICY = Object.freeze({ approvalPolicy: "on-request", sandbox: "workspace-write" });
// The Codex Project binding record is provenance only. Chat membership stays
// in the native ThreadSection, which is re-read on every bootstrap; the
// record says which single-folder Codex Project the human imported and when.
const BINDING_FILE = join(".vibehub", "codex-project.yaml");
// The repository writes this host performs, each explicit and left
// uncommitted: the import (the VibeHub scaffold plus the binding record) and
// the Chat bridge (exactly one Ticket for Create Task or Attach to Task,
// exactly one Context document for Remember). Review stays the activation
// gate: no host action ever stages, commits or pushes.
const REPOSITORY_WRITES = Object.freeze({
  default: false,
  explicitImportOnly: Object.freeze([
    ".vibehub/version.yaml",
    ".vibehub/rooms/",
    ".vibehub/tickets/",
    ".vibehub/evidence/",
    ".vibehub/outcomes/",
    ".vibehub/codex-project.yaml",
  ]),
  explicitChatBridge: Object.freeze([
    ".vibehub/tickets/<ticket_id>.yaml",
    ".vibehub/rooms/<room_id>/<context_id>.yaml",
  ]),
  commits: false,
});

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(sourceRoot, "apps", SHELL_ID);

function parseBackoff(raw, fallback) {
  if (!raw) return fallback;
  const delays = raw.split(",").map((entry) => Number(entry.trim()));
  if (!delays.length || delays.some((delay) => !Number.isInteger(delay) || delay < 0)) {
    throw new Error("VIBEHUB_CODEX_RESTART_BACKOFF_MS must be a comma-separated list of non-negative integers");
  }
  return delays;
}

function parseShellFlags(argv) {
  const flags = { repo: process.cwd(), port: 0, codex: "codex", json: false, open: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (seen.has(flag)) throw new Error(`repeated flag: ${flag}`);
    seen.add(flag);
    if (flag === "--repo" || flag === "--port" || flag === "--codex") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      if (flag === "--repo") flags.repo = value;
      else if (flag === "--codex") flags.codex = value;
      else {
        flags.port = Number(value);
        if (!Number.isInteger(flags.port) || flags.port < 0 || flags.port > 65_535) {
          throw new Error("--port must be an integer from 0 to 65535");
        }
      }
    } else if (flag === "--json") flags.json = true;
    else if (flag === "--open") flags.open = true;
    else throw new Error(`unknown flag: ${flag}`);
  }
  return { ...flags, repo: resolve(flags.repo) };
}

let flags;
try {
  flags = parseShellFlags(process.argv.slice(2));
  if (!existsSync(flags.repo)) throw new Error(`Repository does not exist: ${flags.repo}`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
// The selected folder is the one real path every native cwd comparison uses.
const repoRoot = realpathSync.native(flags.repo);
const token = crypto.randomBytes(32).toString("hex");

// Runtime ownership: the app-server child process lives inside the codex
// adapter client; the shared shell routes every harness verb through the one
// selected adapter; Projects stay on the native ThreadSection adapter.
const client = new CodexAppServerClient({ command: flags.codex, cwd: repoRoot, timeoutMs: APP_SERVER_TIMEOUT_MS });
const harness = createSharedHarnessShell({ adapter: createCodexHarnessAdapter({ client }) });
const projects = new CodexProjectsAdapter({ client, exposeThread: publicThread });

const events = [];
const pendingRequests = new Map();
let sequence = 0;
let origin = null;
let stopping = false;
let restartTimer = null;
let restarting = false;
// Runtime truth the host holds about the one app-server process:
//   state      alive | restarting | exited | halted
//   halt       null, or the violated stop condition that ended reuse
//   generation the process generation currently (or last) bound
//   known      Thread ids and Task links this folder has shown, so a restart
//              can prove the same identities resolve from Codex again
//   loaded     Threads loaded into the current process generation
const runtime = {
  generation: 0,
  alive: false,
  state: "exited",
  version: null,
  halt: null,
  account: null,
  accountError: null,
  schemaProbe: null,
  schemaProbeError: null,
  missingMethods: new Set(),
  recovery: null,
  conditions: [],
  restartAttempt: 0,
  knownThreadIds: new Set(),
  knownTaskLinks: new Map(),
  loadedThreadIds: new Set(),
};

function appendEvent(kind, value) {
  events.push({ sequence: ++sequence, kind, value, observedAt: new Date().toISOString() });
  if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
}

client.on("notification", (value) => appendEvent("notification", value));
client.on("serverRequest", (value) => {
  const descriptor = requestDescriptor(value);
  if (!descriptor.supported) {
    const result = unsupportedServerRequestResult(value);
    if (result) client.respond(value.id, result);
    else client.respondError(value.id, -32601, `Unsupported server request: ${value.method}`);
    appendEvent("unsupportedServerRequest", { id: value.id, method: value.method, params: value.params });
    appendEvent("requestResolved", { id: value.id, method: value.method, resolution: "unsupported" });
    return;
  }
  pendingRequests.set(String(value.id), { ...value, runtimeGeneration: runtime.generation });
  appendEvent("serverRequest", value);
});
client.on("notification:serverRequest/resolved", (params) => {
  pendingRequests.delete(String(params.requestId));
  appendEvent("requestResolved", { id: params.requestId, threadId: params.threadId, resolution: "external" });
});
client.on("stderr", (line) => appendEvent("runtimeStderr", { line }));
client.on("methodMissing", ({ method, generation }) => {
  runtime.missingMethods.add(method);
  // A pinned request the runtime does not know halts reuse right away; the
  // caller's own rejection arrives after this and is reported as the halt.
  if (!runtime.halt) {
    const violation = firstViolation(evaluateStopConditions(stopConditionInputs()));
    if (violation) haltRuntime(violation, { generation });
  }
});
client.on("exit", (value) => {
  runtime.alive = false;
  runtime.loadedThreadIds.clear();
  appendEvent("runtimeExit", { ...value, runtimeGeneration: runtime.generation });
  // Every approval or input request the dead process asked for is void: it
  // is resolved visibly as runtime_exited and never replayed to a new process.
  for (const request of pendingRequests.values()) {
    appendEvent("requestResolved", { id: request.id, method: request.method, threadId: request.params?.threadId ?? null, resolution: "runtime_exited", runtimeGeneration: runtime.generation });
  }
  pendingRequests.clear();
  // Nothing the dead process reported stays live: no Turn, no settings. A
  // queued follow-up is kept but paused until the human resumes it, so no
  // message is fired into a respawned process on its own.
  liveTurns.clear();
  threadSettings.clear();
  for (const threadId of queues.keys()) pauseQueue(threadId, "runtime_exited");
  if (stopping || value.requested) {
    runtime.state = runtime.halt ? "halted" : "exited";
    return;
  }
  if (runtime.halt) {
    runtime.state = "halted";
    return;
  }
  runtime.state = "restarting";
  if (!restarting) scheduleRestart(0);
});

// ---------------------------------------------------------------------------
// Transient host session state for ordinary Chat, held exactly like
// pendingRequests: the follow-up queue of each Thread, the live Turn of each
// Thread, the settings each Thread reported, and the notification preference.
// All of it lives as long as this host process and no longer: nothing here
// is written to the repository, to a store or to the browser, and a host
// restart starts empty. A queue survives browser route changes because it
// lives here, and it is never a second durable store.
// ---------------------------------------------------------------------------
const queues = new Map();
const liveTurns = new Map();
const threadSettings = new Map();
let notificationPreference = "unfocused";

// The settings a Thread reported, null until the runtime reported them: the
// thread/start or thread/resume response first, then every
// thread/settings/updated the runtime sends for it. The browser reads them
// from the newThread, readThread and startTurn responses and from the
// forwarded thread/settings/updated notification; no host event restates
// them.
function threadSettingsProjection(threadId) {
  return threadSettings.get(threadId) ?? null;
}

function rememberSettings(threadId, settings, source) {
  const record = { model: settings.model ?? null, effort: settings.effort ?? null, approvalPolicy: settings.approvalPolicy ?? null, sandboxPolicy: settings.sandboxPolicy ?? null, source, observedAt: new Date().toISOString() };
  threadSettings.set(threadId, record);
  return record;
}

client.on("result", ({ method, result }) => {
  if ((method === "thread/start" || method === "thread/resume") && typeof result?.thread?.id === "string") {
    rememberSettings(result.thread.id, { model: result.model, effort: result.reasoningEffort, approvalPolicy: result.approvalPolicy, sandboxPolicy: result.sandbox }, method);
  }
});
client.on("notification:thread/settings/updated", (params) => {
  const settings = params?.threadSettings;
  if (typeof params?.threadId !== "string" || !settings || typeof settings !== "object") return;
  rememberSettings(params.threadId, { model: settings.model, effort: settings.effort, approvalPolicy: settings.approvalPolicy, sandboxPolicy: settings.sandboxPolicy }, "thread/settings/updated");
});
client.on("notification:turn/started", (params) => {
  if (typeof params?.threadId === "string" && typeof params.turn?.id === "string") liveTurns.set(params.threadId, params.turn.id);
});
client.on("notification:turn/completed", (params) => {
  if (typeof params?.threadId !== "string") return;
  const live = liveTurns.get(params.threadId);
  if (live === undefined || typeof params.turn?.id !== "string" || live === params.turn.id) liveTurns.delete(params.threadId);
  settleQueueAfterTurn(params.threadId, params.turn?.status ?? "completed");
});

function queueRecord(threadId) {
  let queue = queues.get(threadId);
  if (!queue) {
    queue = { paused: false, pausedReason: null, lastError: null, draining: false, items: [] };
    queues.set(threadId, queue);
  }
  return queue;
}

// Media inputs are carried in full by the queue reads and elided from the
// event feed, which only has to say what is queued, not carry the bytes.
function elideMedia(input) {
  return input.map((item) => (item.type === "image" || item.type === "audio" ? { type: item.type, elided: true, byteLength: Buffer.byteLength(item.url), ...(item.detail ? { detail: item.detail } : {}) } : item));
}

function queueProjection(threadId, { media = "elided" } = {}) {
  const queue = queues.get(threadId);
  return {
    threadId,
    paused: queue?.paused ?? false,
    pausedReason: queue?.pausedReason ?? null,
    lastError: queue?.lastError ?? null,
    limit: QUEUE_LIMIT,
    items: (queue?.items ?? []).map((item) => ({
      queuedId: item.queuedId,
      queuedAt: item.queuedAt,
      settings: item.settings,
      starting: item.starting === true,
      input: media === "full" ? item.input : elideMedia(item.input),
    })),
  };
}

function queueProjections() {
  return [...queues.keys()].filter((threadId) => queues.get(threadId).items.length > 0).map((threadId) => queueProjection(threadId));
}

function announceQueue(threadId) {
  appendEvent("queueChanged", { threadId, queue: queueProjection(threadId) });
}

// A pause only means something while follow-ups are queued; it ends with an
// explicit resumeQueue. An empty queue is never left paused.
function pauseQueue(threadId, reason) {
  const queue = queues.get(threadId);
  if (!queue || queue.items.length === 0 || (queue.paused && queue.pausedReason === reason)) return false;
  queue.paused = true;
  queue.pausedReason = reason;
  announceQueue(threadId);
  return true;
}

function settleQueueAfterTurn(threadId, status) {
  const queue = queues.get(threadId);
  if (!queue || queue.items.length === 0) return;
  if (status === "completed") {
    void drainQueue(threadId);
    return;
  }
  // An interrupted or failed Turn stops the queue: nothing is sent until
  // the human resumes it.
  pauseQueue(threadId, status === "interrupted" ? "interrupted" : "turn_failed");
}

// Starts the head of a Thread's queue as its own turn/start with a Turn id
// the runtime mints, one at a time: only when no Turn is live, the queue is
// not paused and nothing is already starting. A start that fails keeps the
// follow-up at the head and pauses the queue with the error in view.
async function drainQueue(threadId) {
  const queue = queues.get(threadId);
  if (!queue || queue.paused || queue.draining || queue.items.length === 0 || liveTurns.has(threadId)) return null;
  if (runtime.halt || !runtime.alive || runtime.state !== "alive") return null;
  const item = queue.items[0];
  queue.draining = true;
  item.starting = true;
  try {
    await ensureLoaded(threadId);
    const started = await sendThroughHarness(threadId, item.input, item.settings);
    const turnId = started.value.turn.id;
    liveTurns.set(threadId, turnId);
    queue.items.shift();
    queue.lastError = null;
    appendEvent("queuedStarted", { threadId, queuedId: item.queuedId, turnId });
    announceQueue(threadId);
    return { queuedId: item.queuedId, turnId };
  } catch (error) {
    item.starting = false;
    queue.lastError = { queuedId: item.queuedId, message: error.message, observedAt: new Date().toISOString() };
    queue.paused = true;
    queue.pausedReason = "start_failed";
    appendEvent("queuedFailed", { threadId, queuedId: item.queuedId, error: error.message });
    announceQueue(threadId);
    return null;
  } finally {
    item.starting = false;
    queue.draining = false;
  }
}

function preferencesProjection() {
  return { notifications: { mode: notificationPreference, modes: [...NOTIFICATION_MODES], transient: true } };
}

function scheduleRestart(attempt) {
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void restartRuntime(attempt);
  }, RESTART_BACKOFF_MS[attempt]);
}

function haltRuntime(violation, { generation = runtime.generation } = {}) {
  if (runtime.halt) return runtime.halt;
  const baseline = harness.capabilities.upstream.version;
  const versionMismatch = violation.id === "generated-protocol-hash-changed" && runtime.version !== null && runtime.version !== baseline;
  runtime.halt = {
    code: versionMismatch ? "runtime-baseline-mismatch" : "stop-condition-violated",
    conditionId: violation.id,
    detail: violation.detail,
    message: versionMismatch
      ? `Codex app-server ${runtime.version} is running but VibeHub pins ${baseline}. The shell stops here instead of reusing an unverified runtime.`
      : `Stop condition ${violation.id}: ${violation.detail} The shell stops here instead of reusing this runtime.`,
    observedVersion: runtime.version,
    baselineVersion: baseline,
    generation,
    observedAt: new Date().toISOString(),
  };
  runtime.state = "halted";
  clearTimeout(restartTimer);
  restartTimer = null;
  appendEvent("runtimeHalted", runtime.halt);
  // A halt at boot is announced after the URL line so the envelope stays the
  // first thing a caller reads; a later halt is announced as it happens.
  if (origin) process.stderr.write(haltNotice());
  return runtime.halt;
}

function haltNotice() {
  return `VibeHub halted Codex runtime reuse (${runtime.halt.conditionId}): ${runtime.halt.detail}\n`;
}

function stopConditionInputs() {
  return {
    initialized: client.initialized,
    observedVersion: runtime.version,
    account: runtime.account,
    accountError: runtime.accountError,
    schemaProbe: runtime.schemaProbe,
    schemaProbeError: runtime.schemaProbeError,
    missingMethods: [...runtime.missingMethods],
    recovery: runtime.recovery,
    staleRequestIds: [...pendingRequests.values()].filter((request) => request.runtimeGeneration !== runtime.generation).map((request) => String(request.id)),
    carrierIds: [harness.carrierId],
  };
}

// Evaluate every pinned stop condition against what this process has
// observed; a violation halts reuse and is returned, otherwise null.
function gateRuntime() {
  const report = evaluateStopConditions(stopConditionInputs());
  runtime.conditions = report.conditions;
  const violation = firstViolation(report);
  return violation ? haltRuntime(violation) : null;
}

function rememberThreads(threads) {
  for (const thread of threads) {
    runtime.knownThreadIds.add(thread.id);
    if (thread.taskLink?.ticketId) runtime.knownTaskLinks.set(thread.id, thread.taskLink.ticketId);
  }
}

// After a respawn every Thread identity and Task link this folder has shown
// must resolve from Codex again: the scoped list first, then thread/read for
// anything the bounded list no longer carries (archived, beyond the tail).
async function recoverKnownThreads() {
  const listed = await listThreads();
  const recovered = new Map(listed.map((thread) => [thread.id, thread]));
  const missingThreadIds = [];
  for (const threadId of runtime.knownThreadIds) {
    if (recovered.has(threadId)) continue;
    try {
      const read = await client.request("thread/read", { threadId, includeTurns: false });
      recovered.set(threadId, publicThread(read.thread));
    } catch {
      missingThreadIds.push(threadId);
    }
  }
  const recoveredTaskLinks = [];
  const lostTaskLinks = [];
  for (const [threadId, ticketId] of runtime.knownTaskLinks) {
    if (recovered.get(threadId)?.taskLink?.ticketId === ticketId) recoveredTaskLinks.push({ ticketId, threadId });
    else lostTaskLinks.push({ ticketId, threadId });
  }
  return {
    generation: runtime.generation,
    knownThreadIds: [...runtime.knownThreadIds],
    recoveredThreadIds: [...runtime.knownThreadIds].filter((threadId) => recovered.has(threadId)),
    missingThreadIds,
    recoveredTaskLinks,
    lostTaskLinks,
  };
}

async function restartRuntime(attempt) {
  if (stopping || runtime.halt || restarting) return;
  restarting = true;
  try {
    const initialized = await client.start();
    runtime.generation = client.generation;
    runtime.version = observedRuntimeVersion(initialized);
    // The process is back; the shell reuses it only once the gate passes.
    runtime.alive = true;
    await readAccount();
    runtime.restartAttempt = attempt + 1;
    runtime.recovery = await recoverKnownThreads();
    if (gateRuntime()) return;
    runtime.state = "alive";
    appendEvent("runtimeRestarted", {
      generation: runtime.generation,
      version: runtime.version,
      attempt: attempt + 1,
      recoveredThreadIds: runtime.recovery.recoveredThreadIds,
      recoveredTaskLinks: runtime.recovery.recoveredTaskLinks,
    });
  } catch (error) {
    appendEvent("runtimeRestartFailed", { attempt: attempt + 1, error: error.message });
    if (stopping || runtime.halt) return;
    if (attempt + 1 >= RESTART_BACKOFF_MS.length) {
      runtime.recovery = { generation: client.generation, error: error.message, attempts: attempt + 1 };
      gateRuntime();
      return;
    }
    // Let the exit handler of a process that died mid-restart settle first.
    runtime.state = "restarting";
    scheduleRestart(attempt + 1);
  } finally {
    restarting = false;
  }
}

async function readAccount() {
  try {
    runtime.account = await client.accountStatus();
    runtime.accountError = null;
  } catch (error) {
    runtime.account = null;
    runtime.accountError = error.message;
  }
  return runtime.account;
}

const script = (name) => [join(assetRoot, name), "text/javascript; charset=utf-8"];
const fixture = (name) => [join(assetRoot, name), "application/json; charset=utf-8"];
const assets = new Map([
  ["/", [join(assetRoot, "index.html"), "text/html; charset=utf-8"]],
  ["/index.html", [join(assetRoot, "index.html"), "text/html; charset=utf-8"]],
  ["/app.css", [join(assetRoot, "app.css"), "text/css; charset=utf-8"]],
  ["/app.js", script("app.js")],
  ["/chat-model.mjs", script("chat-model.mjs")],
  ["/chat-renderer.mjs", script("chat-renderer.mjs")],
  ["/event-window.mjs", script("event-window.mjs")],
  ["/server-request-registry.mjs", script("server-request-registry.mjs")],
  ["/browser-interaction-guard.mjs", script("browser-interaction-guard.mjs")],
  ["/composer-drafts.mjs", script("composer-drafts.mjs")],
  ["/composer-sizing.mjs", script("composer-sizing.mjs")],
  ["/thread-location.mjs", script("thread-location.mjs")],
  ["/request-drafts.mjs", script("request-drafts.mjs")],
  ["/quote-source.mjs", script("quote-source.mjs")],
  ["/timeline-reconcile.mjs", script("timeline-reconcile.mjs")],
  ["/composer-queue.mjs", script("composer-queue.mjs")],
  ["/composer-settings.mjs", script("composer-settings.mjs")],
  ["/composer-attachments.mjs", script("composer-attachments.mjs")],
  ["/composer-recording.mjs", script("composer-recording.mjs")],
  ["/composer-mentions.mjs", script("composer-mentions.mjs")],
  ["/context-usage.mjs", script("context-usage.mjs")],
  ["/thread-name.mjs", script("thread-name.mjs")],
  ["/completion-notifier.mjs", script("completion-notifier.mjs")],
  ["/sidebar-freshness.mjs", script("sidebar-freshness.mjs")],
  ["/chat-fixtures.json", fixture("chat-fixtures.json")],
  ["/chat-conformance-fixtures.json", fixture("chat-conformance-fixtures.json")],
  ["/task-fixtures.json", fixture("task-fixtures.json")],
  ["/project-fixtures.json", fixture("project-fixtures.json")],
  ["/vibehub-mark.svg", [join(sourceRoot, "assets", "brand", "vibehub-mark.svg"), "image/svg+xml"]],
]);

const headers = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

class HostError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const invalid = (message) => new HostError(400, "invalid_request", message);

// A fuzzyFileSearch path inside a .git directory at any depth (the
// repository's own or a nested checkout's): `.git`, `.git/...`, `a/.git/...`.
function gitInternal(path) {
  return String(path ?? "").split("/").includes(".git");
}

// The runtime refusing a Thread identity on thread/resume or thread/read,
// as the installed 0.149.0 binary words it (-32600 "no rollout found for
// thread id …", "thread not found: …", "thread not loaded: …", "invalid
// thread id: …", "invalid session id: …") and as the fixture does (-32602
// "Unknown thread …"): a typed 404 naming the Thread and the runtime's own
// message. Any other failure is returned as is.
const THREAD_REFUSALS = /no rollout found for thread id|thread not found|thread not loaded|unknown thread|invalid (?:thread|session) id/iu;
function threadNotFound(error, threadId) {
  const rpc = error?.rpcError;
  if (!rpc || ![-32600, -32602].includes(rpc.code) || !THREAD_REFUSALS.test(String(rpc.message ?? ""))) return null;
  return new HostError(404, "thread_not_found", `Codex does not know Thread ${threadId}: ${rpc.message}`, { threadId, runtimeMessage: rpc.message, method: error.method ?? null });
}

function json(response, status, value) {
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function fail(response, error) {
  // A request the runtime rejected as unknown has already halted reuse by the
  // time it is reported; the caller sees the halt, not a bare 500.
  if (runtime.halt && error?.rpcError?.code === -32601) error = haltError();
  const status = error instanceof HostError ? error.status : error?.name === "UnsupportedHarnessCapabilityError" ? 409 : 500;
  const code = error instanceof HostError ? error.code : error?.name === "UnsupportedHarnessCapabilityError" ? "unsupported_capability" : "internal_error";
  const details = error instanceof HostError ? error.details : {};
  json(response, status, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error), ...details } });
}

function haltError() {
  return new HostError(409, "runtime_halted", runtime.halt.message, { conditionId: runtime.halt.conditionId, detail: runtime.halt.detail });
}

// Adapter verbs need the live app-server: a halt is permanent (409), a
// restart in progress is temporary (503), and both say which.
function requireRuntime() {
  if (runtime.halt) throw haltError();
  if (runtime.state === "restarting") throw new HostError(503, "runtime_restarting", `The Codex app-server exited and is being restarted (attempt ${runtime.restartAttempt + 1} of ${RESTART_BACKOFF_MS.length}); retry in a moment.`, { runtimeState: runtime.state });
  if (!runtime.alive) throw new HostError(503, "runtime_unavailable", "The Codex app-server is not running.", { runtimeState: runtime.state });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b);
}

function requireHost(request) {
  if (!origin || request.headers.host !== new URL(origin).host) {
    throw new HostError(403, "host_rejected", "The request was not addressed to this loopback host.");
  }
}

function requireBearer(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ") || !safeEqual(authorization.slice(7), token)) {
    throw new HostError(401, "unauthorized", "Open the exact short-lived URL printed by VibeHub.");
  }
}

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HostError(413, "payload_too_large", "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw invalid("Request body must be JSON");
  }
}

function threadTitle(thread) {
  return thread.name || thread.preview?.split("\n")[0]?.slice(0, 72) || "Untitled task";
}

// The Thread a Task Turn names, linked to the Task by its Codex Thread name
// (the linkage authority): from the scoped listing, which carries a Thread
// only once its first userMessage is durable, or else from thread/read,
// which carries the name from thread/name/set on, so a Task Turn sent in
// that window right after Start is not refused.
async function linkedTaskThread(threadId, ticketId) {
  let thread = (await listThreads()).find((entry) => entry.id === threadId) ?? null;
  if (!thread) {
    try {
      thread = publicThread((await client.request("thread/read", { threadId, includeTurns: false })).thread);
      rememberThreads([thread]);
    } catch {
      thread = null;
    }
  }
  return thread?.taskLink?.ticketId === ticketId ? thread : null;
}

function taskLinkFromThread(thread) {
  const named = String(thread.name ?? "").match(/^VibeHub Task · (ticket-[a-z0-9-]+)$/u);
  if (named) return { ticketId: named[1], kind: "codex_thread_name", threadId: thread.id };
  const link = taskLinkFromPreview(thread.preview);
  return link ? { ...link, threadId: thread.id } : null;
}

function publicThread(thread) {
  return {
    ...publicCodexThread(thread),
    title: threadTitle(thread),
    taskLink: taskLinkFromThread(thread),
    settings: threadSettingsProjection(thread.id),
  };
}

// Replay seam (capability "replay": thread/list, thread/read, thread/resume).
async function listThreads() {
  const result = await client.request("thread/list", {
    archived: false,
    cursor: null,
    cwd: repoRoot,
    limit: 40,
    sourceKinds: ["cli", "vscode", "appServer"],
    searchTerm: null,
    sortDirection: "desc",
    sortKey: "updated_at",
  });
  const threads = (result.data ?? result.threads ?? []).map(publicThread);
  rememberThreads(threads);
  return threads;
}

function graphProjection(snapshot = buildUiSnapshot(repoRoot)) {
  return {
    snapshotId: snapshot.state.graph.snapshotId,
    project: snapshot.state.project,
    tickets: snapshot.state.graph.tickets,
    relations: snapshot.state.graph.relations,
    source: snapshot.state.graph.source,
  };
}

function gitTopLevel() {
  try {
    return realpathSync.native(execFileSync("git", ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch {
    return null;
  }
}

function bindingRecord() {
  const path = join(repoRoot, BINDING_FILE);
  if (!existsSync(path)) return null;
  try {
    const document = readDocument(path);
    if (document?.kind !== "codex_project_binding" || typeof document.section_id !== "string") {
      return { path, invalid: true, reason: "The binding record is not a codex_project_binding document." };
    }
    return { path, invalid: false, document };
  } catch (error) {
    return { path, invalid: true, reason: error.message };
  }
}

// The four scope states the shell can truthfully be in. Only `bound` unlocks
// VibeHub Task actions; Chat stays fully usable in every state.
function scopeState({ repositoryRoot, compatibility }) {
  if (repositoryRoot === null) return "no-repository";
  if (compatibility.state === "CURRENT") return "bound";
  if (compatibility.detected_format === "uninitialized") return "unbound";
  return "migration-required";
}

function scopeReason(scope, compatibility) {
  if (scope === "bound") return null;
  if (scope === "no-repository") return "This folder is not inside a Git repository. VibeHub Tasks, Context, Evidence and Outcomes live in a checked-in .vibehub tree, so Task actions are unavailable here.";
  if (scope === "unbound") return "This repository is not set up as a VibeHub Project yet. Import the single-folder Codex Project for this folder to write the .vibehub scaffold.";
  return compatibility.reason ?? "This repository's VibeHub data cannot be used by this version.";
}

function projectProjection(snapshot, folderScope, sections) {
  const repositoryRoot = gitTopLevel();
  const compatibility = projectCompatibility(repoRoot);
  const scope = scopeState({ repositoryRoot, compatibility });
  const record = bindingRecord();
  const binding = record && !record.invalid
    ? {
        sectionId: record.document.section_id,
        sectionName: record.document.section_name_at_import ?? null,
        folder: record.document.folder ?? null,
        importedAt: record.document.imported_at ?? null,
        codexVersion: record.document.codex_version ?? null,
        sectionPresent: sections.some((section) => section.id === record.document.section_id),
        recordPath: BINDING_FILE,
      }
    : null;
  const source = snapshot.state.graph.source;
  return {
    scope,
    reason: scopeReason(scope, compatibility),
    name: basename(repositoryRoot ?? repoRoot),
    repositoryRoot,
    worktreeRoot: repoRoot,
    branch: repositoryRoot ? snapshot.state.project.branch : null,
    compatibility: {
      state: compatibility.state,
      detectedFormat: compatibility.detected_format,
      currentFormat: compatibility.current_format,
      targetFormat: compatibility.target_format,
      reason: compatibility.reason,
    },
    binding,
    bindingRecord: record?.invalid ? { path: BINDING_FILE, invalid: true, reason: record.reason } : null,
    rooms: { coldStart: snapshot.state.rooms.coldStart, count: snapshot.state.rooms.rooms.length },
    uncommitted: { paths: source.dirtyPaths, truncated: source.dirtyPathsTruncated, committed: !source.semanticDirty },
    taskActions: { available: scope === "bound", reason: scopeReason(scope, compatibility) },
    visibility: folderScope,
    sync: {
      chatFolder: repoRoot,
      rule: "Threads this shell creates carry this folder as their native cwd; Tasks, Context and Evidence are YAML under .vibehub that stays uncommitted until you commit it.",
      automaticCommit: false,
    },
  };
}

function requireBoundScope() {
  const project = projectProjection(buildUiSnapshot(repoRoot), null, []);
  if (project.scope !== "bound") throw new HostError(409, "scope_unavailable", project.reason);
  return project;
}

// Durable Context is read through the canonical Room projection
// (vh-ui.mjs buildUiSnapshot -> projectRooms): Room membership, state and the
// checked-in path come from there, and only the document body (detail, tags,
// source ref) is looked up by that canonical Context id. The host never walks
// .vibehub itself to decide which Context exists or which Room owns it.
const KNOWLEDGE_SOURCE = "canonical_room_projection";

function knowledgeProjection(snapshot = buildUiSnapshot(repoRoot)) {
  const owners = new Map();
  for (const room of snapshot.state.rooms.rooms) {
    for (const context of room.contexts) {
      // A nested Room lists its ancestors' prefix too; the deepest Room owns it.
      const current = owners.get(context.contextId);
      if (!current || room.room.length > current.room.length) owners.set(context.contextId, { room: room.room, context });
    }
  }
  return [...owners.values()]
    .filter(({ context }) => context.state === "active")
    .map(({ room, context }) => {
      const document = snapshot.repository.contexts.documents.get(context.contextId).document;
      return {
        contextId: context.contextId,
        type: context.type,
        summary: context.summary,
        detail: document.detail,
        tags: document.tags,
        room,
        sourceRef: document.source.ref,
        contextRef: context.path,
        source: KNOWLEDGE_SOURCE,
      };
    })
    .sort((left, right) => left.summary.localeCompare(right.summary));
}

function priorAcceptedProjection(handoff, repository) {
  return (handoff.relations ?? [])
    .filter((relation) => relation.type === "depends_on")
    .map((relation) => {
      const outcomeEntry = repository.outcomes.documents.get(relation.target_ticket_id);
      const outcome = outcomeEntry?.document;
      // The canonical acceptance gate: an unresolved successful Outcome is
      // not prior accepted context, exactly as it no longer unlocks anything.
      if (outcome?.status !== "successful" || !outcomeAccepted(repository, relation.target_ticket_id)) return null;
      return {
        ticketId: relation.target_ticket_id,
        rationale: relation.rationale,
        outcomeRef: outcomeEntry.path,
        outcome: {
          status: outcome.status,
          summary: outcome.summary,
          closedAt: outcome.closed_at,
          acceptedAcceptanceIds: outcome.accepted_acceptance_ids,
        },
        evidence: (outcome.evidence_ids ?? [])
          .map((evidenceId) => repository.evidence.documents.get(evidenceId))
          .filter(Boolean)
          .map(({ document, path }) => ({
            evidenceId: document.evidence_id,
            evidenceRef: path,
            summary: document.summary,
            acceptanceIds: document.acceptance_ids,
            origin: document.origin ?? "agent",
            refs: document.refs ?? [],
          }))
          .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.ticketId.localeCompare(right.ticketId));
}

// The Task Workspace is one read of the canonical projection: the handoff is
// vh-ui.mjs buildTicketHandoff, and the packet is exactly what
// codex-adapter/task-context.mjs assembles from it. packetText is the byte
// sequence the browser shows and the Turn input the host sends; the browser
// never rebuilds either, and Evidence, Outcome and next action are handed over
// from the same handoff rather than re-derived anywhere else.
// A `candidate` Ticket (previewCreateTask) is projected by the same canonical
// path as if it were already written uncommitted, so the preview packet is the
// packet a Start would send once the Task exists.
function taskWorkspaceProjection(ticketId, { selectedContextIds = [], thread = null, operation = "start", humanMessage = null, candidate = null } = {}) {
  const handoff = candidate ? buildCandidateTicketHandoff(repoRoot, candidate) : buildTicketHandoff(repoRoot, ticketId);
  const snapshot = buildUiSnapshot(repoRoot);
  const contexts = knowledgeProjection(snapshot);
  const packet = buildTaskContextPacket({
    handoff,
    project: snapshot.state.project,
    contexts,
    rooms: snapshot.state.rooms.rooms,
    selectedContextIds,
    priorAccepted: priorAcceptedProjection(handoff, snapshot.repository),
    thread,
    operation,
    humanMessage,
  });
  return {
    handoff,
    packet,
    packetText: JSON.stringify(packet, null, 2),
    evidence: handoff.evidence,
    outcome: handoff.outcomeRecord,
    nextAction: handoff.nextAction,
    source: {
      handoff: "vh-ui.buildTicketHandoff",
      packet: "codex-adapter/task-context.buildTaskContextPacket",
      contexts: KNOWLEDGE_SOURCE,
      snapshotId: snapshot.state.graph.snapshotId,
    },
    eligibleContexts: contexts.map((item) => ({
      contextId: item.contextId,
      room: item.room,
      type: item.type,
      summary: item.summary,
      sourceRef: item.sourceRef,
      defaultIncluded: packet.context.directContextIds.includes(item.contextId),
    })),
    rooms: snapshot.state.rooms.rooms.map((room) => ({
      room: room.room,
      roomId: room.roomId,
      description: room.description,
      boundary: room.boundary,
      drift: room.drift.state,
      contextCount: room.contexts.length,
    })),
  };
}

function attentionProjection(graph, repository) {
  const tickets = new Map(documents(repository.tickets.documents).map((ticket) => [ticket.ticket_id, ticket]));
  const needsYou = graph.tickets
    .filter((ticket) => ticket.capabilities.nextAction.summary.action === "NEEDS_HUMAN")
    .map((ticket) => ({
      kind: "needs_you",
      ticketId: ticket.ticketId,
      title: tickets.get(ticket.ticketId)?.outcome ?? ticket.outcome,
      reason: "A current Human-authority criterion needs your explicit decision.",
      source: "canonical_next_action",
    }));
  const recentCompletions = documents(repository.outcomes.documents)
    .filter((outcome) => outcome.status === "successful")
    .sort((left, right) => String(right.closed_at).localeCompare(String(left.closed_at)))
    .slice(0, 6)
    .map((outcome) => ({
      kind: "completed",
      ticketId: outcome.ticket_id,
      title: tickets.get(outcome.ticket_id)?.outcome ?? outcome.summary,
      closedAt: outcome.closed_at,
      source: "canonical_successful_outcome",
    }));
  return {
    needsYou,
    recentCompletions,
    semantics: {
      needsYou: "current_attention_not_unread_event",
      recentCompletions: "repository_history_not_unread_event",
      running: "presence_only_never_notification",
    },
  };
}

function runtimeProjection() {
  const baselineVersion = harness.capabilities.upstream.version;
  return {
    provider: "Codex app-server",
    command: flags.codex,
    version: runtime.version,
    baselineVersion,
    baselineMatch: runtime.version === baselineVersion,
    local: true,
    audioInput: harness.capabilities.capabilities.audio.available,
    // The truthful no-claim explanation the browser shows on the disabled
    // microphone whenever audioInput is not granted: the capability
    // contract's own fallback text, never a working-microphone claim.
    audioInputFallback: harness.capabilities.capabilities.audio.fallback,
    realtimeConversation: false,
    generation: runtime.generation,
    alive: runtime.alive,
    state: runtime.state,
    halt: runtime.halt,
    conditions: runtime.conditions,
    restart: { attempts: runtime.restartAttempt, backoffMs: [...RESTART_BACKOFF_MS] },
    recovery: runtime.recovery,
  };
}

// The stop the browser shows is the halt itself: which pinned condition
// ended reuse, with the observed and pinned versions beside it.
function runtimeStop() {
  const halt = runtime.halt;
  if (!halt) return null;
  return {
    code: halt.code,
    conditionId: halt.conditionId,
    message: halt.message,
    detail: halt.detail,
    observedVersion: halt.observedVersion,
    baselineVersion: halt.baselineVersion,
  };
}

async function bootstrap() {
  const stop = runtimeStop();
  const snapshot = buildUiSnapshot(repoRoot);
  // Every default list is scoped to this folder through the native filter.
  // Groups whose members all live elsewhere are counted, never listed. A
  // halted, absent or not-yet-gated runtime yields empty lists, never a
  // guess from memory.
  const unavailable = Boolean(stop) || !runtime.alive || runtime.state !== "alive";
  const [account, projectSnapshot] = await Promise.all([
    runtime.alive ? readAccount().then((value) => value ?? { authenticated: false, requiresOpenaiAuth: false }) : Promise.resolve({ authenticated: false, requiresOpenaiAuth: false }),
    unavailable
      ? Promise.resolve({ projects: [], pinned: [], recents: [], threads: [], capabilities: CODEX_PROJECT_CAPABILITIES, folderScope: null })
      : projects.snapshot({ cwd: repoRoot }),
  ]);
  rememberThreads(projectSnapshot.threads);
  const { folderScope, projects: groups, ...lists } = projectSnapshot;
  const visibleGroups = groups.filter((group) => group.scopedCount > 0 || group.totalCount === 0);
  const graph = graphProjection(snapshot);
  const project = projectProjection(snapshot, folderScope, groups);
  return {
    account,
    ...lists,
    projects: visibleGroups,
    project,
    graph,
    contexts: knowledgeProjection(snapshot),
    attention: attentionProjection(graph, snapshot.repository),
    harness: carrier,
    runtime: runtimeProjection(),
    stop,
    // The explicit write classes, advertised here as in /health; the paths a
    // bridge write touched show up in project.uncommitted on the next read.
    repositoryWrites: REPOSITORY_WRITES,
    pendingRequests: [...pendingRequests.values()],
    // Transient host session state beside the pending requests: the queued
    // follow-ups of every Thread and the notification preference, both gone
    // after a host restart.
    queues: queueProjections(),
    preferences: preferencesProjection(),
    eventCursor: sequence,
  };
}

async function importProject(sectionId) {
  const snapshot = buildUiSnapshot(repoRoot);
  const before = projectProjection(snapshot, null, []);
  if (before.scope === "no-repository" || before.scope === "migration-required") {
    throw new HostError(409, "scope_unavailable", before.reason);
  }
  if (before.binding || before.bindingRecord) {
    throw new HostError(409, "already_bound", `This repository already carries ${BINDING_FILE}; exactly one Codex Project binds this VibeHub Project.`);
  }
  const candidates = await projects.importableProjects({ repositoryRoot: repoRoot });
  const candidate = candidates.projects.find((item) => item.id === sectionId);
  if (!candidate) throw new HostError(409, "import_ineligible", "That Codex Project no longer exists in the app-server.");
  if (!candidate.importable) throw new HostError(409, "import_ineligible", candidate.reason);
  const scaffold = { created: false, directories: [], versionPath: null };
  if (before.compatibility.detectedFormat === "uninitialized") {
    const initialized = initProject(repoRoot);
    scaffold.created = true;
    scaffold.directories = initialized.directories.map((path) => path.slice(repoRoot.length + 1));
    scaffold.versionPath = initialized.version_path.slice(repoRoot.length + 1);
  }
  const document = {
    schema_version: 1,
    kind: "codex_project_binding",
    harness: "codex",
    section_id: candidate.id,
    section_name_at_import: candidate.name,
    folder: candidate.folders[0],
    imported_at: new Date().toISOString(),
    codex_version: runtime.version,
  };
  writeDocument(join(repoRoot, BINDING_FILE), document);
  appendEvent("clientAction", { action: "importProject", sectionId: candidate.id, sectionName: candidate.name, folder: candidate.folders[0], scaffoldCreated: scaffold.created });
  const after = buildUiSnapshot(repoRoot);
  const projectSnapshot = await projects.snapshot({ cwd: repoRoot });
  return {
    project: projectProjection(after, projectSnapshot.folderScope, projectSnapshot.projects),
    binding: document,
    scaffold,
    writtenPaths: [...(scaffold.versionPath ? [scaffold.versionPath] : []), ...scaffold.directories.map((path) => `${path}/`), BINDING_FILE],
    committed: false,
  };
}

// ---------------------------------------------------------------------------
// The explicit Chat bridge. Every action here is gated on the bound scope,
// reads the repository through the canonical snapshot only, and writes (if it
// writes at all) exactly one document through vh.mjs's validated entry points:
// applyTickets for a Ticket, putContext for a Context. Source identity (the
// Codex Thread, Turn and item) is what the browser captured from the native
// transcript it is showing; the host never derives it from Thread names,
// previews or transcripts, never creates a Thread or Turn here, and never
// runs git. Written paths surface as uncommitted changes on the next bootstrap.
// ---------------------------------------------------------------------------

const TEXT_LIMITS = Object.freeze({ title: 200, outcome: 2_000, summary: 300, evidenceNote: 1_000, long: 20_000, tag: 64, tags: 16 });
const TICKET_SLUG_LIMIT = 64;
const CONTEXT_ID_LIMIT = 60;
// Thread, Turn and item identities are opaque Codex strings; the reference
// grammar only needs them free of whitespace and slashes.
const CODEX_IDENTITY = /^[^\s/]{1,128}$/u;
const TICKET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ROOM_PATH = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/u;
const CONTEXT_TYPES = new Set(["intent", "decision", "constraint", "contract", "convention", "change", "note"]);
const PLACEHOLDER_ACCEPTANCE = Object.freeze({
  acceptance_id: "refine-after-creation",
  criterion: "Acceptance is written at refinement: this draft Task was created from a Codex Chat and needs a firm, executable acceptance contract before it can be executed.",
});

function codexThreadRef({ threadId, turnId, itemId = null }) {
  return `codex-thread:${threadId}/turn:${turnId}${itemId ? `/item:${itemId}` : ""}`;
}

function boundedText(payload, key, limit, { required = true } = {}) {
  const value = payload[key];
  if (value === undefined || value === null) {
    if (required) throw invalid(`${key} required`);
    return null;
  }
  if (typeof value !== "string" || (required && !value.trim())) throw invalid(`${key} must be a non-empty string`);
  if (value.length > limit) throw invalid(`${key} must be at most ${limit} characters`);
  return required ? value.trim() : value.trim() || null;
}

function codexIdentity(payload, key, { required = true } = {}) {
  const value = payload?.[key];
  if (value === undefined || value === null) {
    if (required) throw invalid(`${key} required`);
    return null;
  }
  if (typeof value !== "string" || !CODEX_IDENTITY.test(value)) throw invalid(`${key} must be a Codex identity without whitespace or slashes`);
  return value;
}

function kebab(value) {
  return String(value).normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function clampSlug(slug, limit) {
  if (slug.length <= limit) return slug;
  const cut = slug.slice(0, limit);
  return (cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut).replace(/-+$/u, "");
}

function shortHash(value, length) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

// VibeHubError from the validated entry points becomes the host's own error
// envelope: validator errors keep their exact path and message, origin guard
// violations keep their code, and nothing is ever written on refusal.
function bridgeFailure(error) {
  if (!(error instanceof VibeHubError)) return error;
  const errors = error.details?.errors;
  if (error.code === "validation_error" && Array.isArray(errors)) {
    return new HostError(400, "validation_error", `${error.message}: ${errors.map((item) => `${item.path} ${item.message}`).join("; ")}`, { errors });
  }
  if (error.code === "origin_immutable" || error.code === "origin_cannot_be_added") {
    return new HostError(409, error.code, error.message, { violations: error.details?.violations ?? [] });
  }
  if (error.code === "not_found") return new HostError(404, "not_found", error.message);
  return new HostError(409, error.code, error.message, error.details ? { details: error.details } : {});
}

function listTaskTargets(snapshot = buildUiSnapshot(repoRoot)) {
  return snapshot.state.graph.tickets
    // A Ticket is a Task target until its successful Outcome is accepted by
    // the canonical binding gate; an unresolved one returns as REPLAN work.
    .filter((row) => !outcomeAccepted(snapshot.repository, row.ticketId))
    .map((row) => {
      const ticket = snapshot.repository.tickets.documents.get(row.ticketId).document;
      return {
        ticketId: row.ticketId,
        outcome: row.outcome,
        maturity: ticket.maturity ?? "firm",
        status: row.capabilities.operational.summary.label,
        nextAction: row.capabilities.nextAction.summary,
        hasOrigin: row.origin !== null,
        associations: row.associations,
      };
    })
    .sort((left, right) => left.ticketId.localeCompare(right.ticketId));
}

function listRooms(snapshot = buildUiSnapshot(repoRoot)) {
  return snapshot.state.rooms.rooms.map((room) => ({
    room: room.room,
    roomId: room.roomId,
    description: room.description,
    boundary: room.boundary,
    path: `.vibehub/rooms/${room.room}`,
    contextCount: room.contexts.length,
  }));
}

// Origin arrives from the browser as the exact identity of the finalized
// assistant message or selection it is showing. The host canonicalizes absence
// (a missing nullable key is null) and stamps captured_at when the browser
// left it out; every other key is validated verbatim by validateTicket.
function originFromPayload(payload) {
  const origin = payload.origin;
  if (!origin || typeof origin !== "object" || Array.isArray(origin)) throw invalid("origin required: the exact Codex Thread, Turn, item and selection the Task is born from");
  return {
    ...origin,
    forked_from_id: origin.forked_from_id ?? null,
    item_id: origin.item_id ?? null,
    selection: origin.selection ?? null,
    captured_at: origin.captured_at ?? new Date().toISOString(),
  };
}

function deriveTicketId(title, snapshot) {
  const slug = clampSlug(kebab(title), TICKET_SLUG_LIMIT);
  const base = slug ? `ticket-${slug}` : `ticket-${shortHash(title.trim(), 12)}`;
  const taken = (id) => snapshot.repository.tickets.documents.has(id);
  let ticketId = base;
  for (let suffix = 2; taken(ticketId); suffix += 1) ticketId = `${base}-${suffix}`;
  return ticketId;
}

// The draft Ticket a Create Task confirmation writes: schema v2, maturity
// draft (so it surfaces as REFINE), one placeholder criterion, the origin
// verbatim, and one provenance reference naming the source Turn.
function draftTicketCandidate(payload, snapshot) {
  const title = boundedText(payload, "title", TEXT_LIMITS.title);
  const outcome = boundedText(payload, "outcome", TEXT_LIMITS.outcome);
  const context = boundedText(payload, "context", TEXT_LIMITS.long);
  const origin = originFromPayload(payload);
  const ticketId = deriveTicketId(title, snapshot);
  const candidate = {
    schema_version: 2,
    kind: "ticket",
    ticket_id: ticketId,
    maturity: "draft",
    outcome,
    deliveries: [],
    context,
    acceptance: [{ ...PLACEHOLDER_ACCEPTANCE }],
    constraints: [],
    context_refs: [],
    relations: [],
    provenance_refs: [codexThreadRef({ threadId: String(origin.thread_id), turnId: String(origin.turn_id) })],
    origin,
  };
  const validation = validateTicket(candidate, "ticket");
  if (validation.length > 0) {
    throw new HostError(400, "validation_error", `Task candidate is invalid: ${validation.map((item) => `${item.path} ${item.message}`).join("; ")}`, { errors: validation });
  }
  // The identities also have to fit the provenance reference grammar.
  for (const key of ["thread_id", "turn_id", "item_id"]) {
    if (origin[key] !== null && !CODEX_IDENTITY.test(origin[key])) throw invalid(`origin.${key} must be a Codex identity without whitespace or slashes`);
  }
  return { title, ticketId, candidate };
}

function previewCreateTask(payload) {
  const snapshot = buildUiSnapshot(repoRoot);
  const { ticketId, candidate } = draftTicketCandidate(payload, snapshot);
  let workspace;
  try {
    workspace = taskWorkspaceProjection(ticketId, { candidate });
  } catch (error) {
    throw bridgeFailure(error);
  }
  return {
    ticketId,
    path: `.vibehub/tickets/${ticketId}.yaml`,
    candidate,
    validation: [],
    packet: workspace.packet,
    packetText: workspace.packetText,
    nextAction: workspace.nextAction,
  };
}

function createTask(payload) {
  const snapshot = buildUiSnapshot(repoRoot);
  const { ticketId, candidate } = draftTicketCandidate(payload, snapshot);
  // The confirmation surface names the id it derived; if that id was taken
  // meanwhile the derivation has moved on and the write is refused rather
  // than landing under a name the human did not confirm.
  if (payload.ticketId !== undefined && payload.ticketId !== ticketId) {
    if (typeof payload.ticketId === "string" && snapshot.repository.tickets.documents.has(payload.ticketId)) {
      throw new HostError(409, "ticket_exists", `Task ${payload.ticketId} already exists in this repository; preview again to derive a free id.`, { ticketId: payload.ticketId, derivedTicketId: ticketId });
    }
    throw invalid(`ticketId ${String(payload.ticketId)} does not match the id derived from the title (${ticketId})`);
  }
  let written;
  try {
    written = applyTickets({ repo: repoRoot, tickets: [candidate] });
  } catch (error) {
    throw bridgeFailure(error);
  }
  const path = `.vibehub/tickets/${ticketId}.yaml`;
  appendEvent("clientAction", { action: "createTask", ticketId, path, threadId: candidate.origin.thread_id, turnId: candidate.origin.turn_id, itemId: candidate.origin.item_id });
  return { ticketId, path, writtenPaths: written.paths.map((absolute) => absolute.slice(repoRoot.length + 1)), uncommitted: true };
}

function attachTask(payload) {
  if (typeof payload.ticketId !== "string" || !TICKET_ID.test(payload.ticketId)) throw invalid("ticketId must be a kebab-case Task id");
  const ticketId = payload.ticketId;
  const threadId = codexIdentity(payload, "threadId");
  const turnId = codexIdentity(payload, "turnId");
  const snapshot = buildUiSnapshot(repoRoot);
  const entry = snapshot.repository.tickets.documents.get(ticketId);
  if (!entry) throw new HostError(404, "task_not_found", `Task ${ticketId} does not exist in this repository.`);
  if (snapshot.repository.outcomes.documents.get(ticketId)?.document.status === "successful") {
    throw new HostError(409, "task_closed", `Task ${ticketId} has a successful Outcome; closed work does not take new associations.`);
  }
  const provenanceRef = codexThreadRef({ threadId, turnId });
  const path = `.vibehub/tickets/${ticketId}.yaml`;
  if (entry.document.provenance_refs.includes(provenanceRef)) {
    return { ticketId, provenanceRef, added: false, path, writtenPaths: [] };
  }
  // Only provenance_refs grows; origin, deliveries, acceptance and relations
  // are re-applied untouched, so the origin guard sees the same origin.
  const candidate = { ...entry.document, provenance_refs: [...entry.document.provenance_refs, provenanceRef] };
  try {
    applyTickets({ repo: repoRoot, tickets: [candidate] });
  } catch (error) {
    throw bridgeFailure(error);
  }
  appendEvent("clientAction", { action: "attachTask", ticketId, path, threadId, turnId });
  return { ticketId, provenanceRef, added: true, path, writtenPaths: [path] };
}

function deriveContextId(summary, type, content, snapshot) {
  const slug = clampSlug(kebab(summary), CONTEXT_ID_LIMIT);
  const base = slug || `${type}-${shortHash(content, 12)}`;
  const taken = (id) => snapshot.repository.contexts.documents.has(id);
  if (!taken(base)) return base;
  const hash = shortHash(content, 6);
  const hashed = `${clampSlug(base, CONTEXT_ID_LIMIT - hash.length - 1)}-${hash}`;
  let contextId = hashed;
  for (let suffix = 2; taken(contextId); suffix += 1) contextId = `${hashed}-${suffix}`;
  return contextId;
}

function remember(payload) {
  const room = typeof payload.room === "string" ? payload.room : "";
  if (!ROOM_PATH.test(room)) throw invalid("room must be a slash-separated path of kebab-case Room slugs");
  const type = payload.type;
  if (!CONTEXT_TYPES.has(type)) throw invalid(`type must be one of ${[...CONTEXT_TYPES].join(", ")}`);
  const summary = boundedText(payload, "summary", TEXT_LIMITS.summary);
  const detail = boundedText(payload, "detail", TEXT_LIMITS.long);
  const tags = payload.tags === undefined ? [] : payload.tags;
  if (!Array.isArray(tags) || tags.length > TEXT_LIMITS.tags || tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > TEXT_LIMITS.tag)) {
    throw invalid(`tags must be at most ${TEXT_LIMITS.tags} non-empty strings`);
  }
  const source = payload.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) throw invalid("source required: the Codex Thread and Turn the claim comes from");
  const threadId = codexIdentity(source, "threadId");
  const turnId = codexIdentity(source, "turnId");
  const itemId = codexIdentity(source, "itemId", { required: false });
  const quote = boundedText(source, "quote", TEXT_LIMITS.long, { required: false });
  const ref = codexThreadRef({ threadId, turnId, itemId });
  const evidenceNote = boundedText(payload, "evidenceNote", TEXT_LIMITS.evidenceNote, { required: false })
    ?? `Remembered by the human from Codex Thread ${threadId}, Turn ${turnId}${itemId ? `, item ${itemId}` : ""}.`;
  const snapshot = buildUiSnapshot(repoRoot);
  if (!snapshot.state.rooms.rooms.some((entry) => entry.room === room)) {
    throw new HostError(409, "room_missing", `Room ${room} does not exist in this repository; Remember never creates a Room. Choose an existing Room or distill one first.`, { room, rooms: listRooms(snapshot).map((entry) => entry.room) });
  }
  const contextId = deriveContextId(summary, type, `${ref}\n${summary}\n${detail}`, snapshot);
  const context = {
    schema_version: 1,
    kind: "context",
    context_id: contextId,
    type,
    state: "active",
    summary,
    detail,
    tags: [...new Set(tags.map((tag) => tag.trim()))],
    source: { ref, ...(quote ? { quote } : {}), captured_at: new Date().toISOString() },
    evidence: [{ ref, note: evidenceNote }],
    relations: [],
  };
  let written;
  try {
    written = putContext({ repo: repoRoot, room, context });
  } catch (error) {
    throw bridgeFailure(error);
  }
  const path = written.path.slice(repoRoot.length + 1);
  appendEvent("clientAction", { action: "remember", contextId, room, path, threadId, turnId, itemId });
  return { contextId, room, path, writtenPaths: [path], sourceRef: ref, uncommitted: true };
}

function validInputs(input) {
  try {
    validateInputs(input);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Turn input and settings validation. The host sends the app-server exactly
// the pinned UserInput variants: text (with UI-defined text_elements), image
// and audio as bounded data URLs, and skill and mention with name and path.
// A browser File carries no filesystem path, so localImage and localAudio are
// never produced here. Each text_elements entry must occupy the UTF-8 byte
// span its placeholder says it does, measured with Buffer.byteLength.
// ---------------------------------------------------------------------------

function validateInputs(input, label = "input") {
  if (!Array.isArray(input) || input.length === 0) throw invalid(`${label} must be a non-empty array of Turn inputs`);
  if (input.length > INPUT_ITEM_LIMIT) throw invalid(`${label} may carry at most ${INPUT_ITEM_LIMIT} items`);
  return input.map((item, index) => validateInput(item, `${label}[${index}]`));
}

function validateInput(item, label) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid(`${label} must be a Turn input object`);
  if (item.type === "text") {
    if (typeof item.text !== "string" || !item.text.trim()) throw invalid(`${label}.text must be a non-empty string`);
    if (item.text_elements === undefined || item.text_elements === null) return { type: "text", text: item.text };
    return { type: "text", text: item.text, text_elements: validateTextElements(item.text_elements, item.text, label) };
  }
  if (item.type === "image" || item.type === "audio") {
    if (typeof item.url !== "string" || !item.url.startsWith("data:") || item.url.length > BODY_LIMIT) throw invalid(`${label}.url must be a data: URL of at most ${BODY_LIMIT} bytes`);
    if (item.type === "image" && item.detail !== undefined && item.detail !== null) {
      if (!IMAGE_DETAILS.has(item.detail)) throw invalid(`${label}.detail must be one of ${[...IMAGE_DETAILS].join(", ")}`);
      return { type: "image", url: item.url, detail: item.detail };
    }
    return { type: item.type, url: item.url };
  }
  if (item.type === "skill" || item.type === "mention") {
    if (typeof item.name !== "string" || !item.name.trim() || item.name.length > 256) throw invalid(`${label}.name must be a non-empty string of at most 256 characters`);
    if (typeof item.path !== "string" || !item.path.trim() || item.path.length > 4096) throw invalid(`${label}.path must be a non-empty string of at most 4096 characters`);
    return { type: item.type, name: item.name, path: item.path };
  }
  throw invalid(`${label}.type must be text, image, audio, skill or mention`);
}

function validateTextElements(elements, text, label) {
  if (!Array.isArray(elements)) throw invalid(`${label}.text_elements must be an array`);
  if (elements.length > TEXT_ELEMENT_LIMIT) throw invalid(`${label}.text_elements may carry at most ${TEXT_ELEMENT_LIMIT} elements`);
  const bytes = Buffer.from(text, "utf8");
  const validated = elements.map((element, index) => {
    const name = `${label}.text_elements[${index}]`;
    const range = element?.byteRange;
    if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > bytes.byteLength) {
      throw invalid(`${name}.byteRange must be a non-empty byte span inside the ${bytes.byteLength}-byte UTF-8 text`);
    }
    const placeholder = element.placeholder === undefined ? null : element.placeholder;
    if (placeholder !== null && typeof placeholder !== "string") throw invalid(`${name}.placeholder must be a string or null`);
    const span = bytes.subarray(range.start, range.end).toString("utf8");
    if (Buffer.byteLength(span, "utf8") !== range.end - range.start) throw invalid(`${name}.byteRange cuts through a UTF-8 character`);
    if (placeholder !== null && (Buffer.byteLength(placeholder, "utf8") !== range.end - range.start || span !== placeholder)) {
      throw invalid(`${name}.placeholder ${JSON.stringify(placeholder)} does not occupy bytes ${range.start}-${range.end} of the text (found ${JSON.stringify(span)})`);
    }
    return placeholder === null ? { byteRange: { start: range.start, end: range.end } } : { byteRange: { start: range.start, end: range.end }, placeholder };
  });
  const ordered = [...validated].sort((left, right) => left.byteRange.start - right.byteRange.start);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].byteRange.start < ordered[index - 1].byteRange.end) throw invalid(`${label}.text_elements must not overlap`);
  }
  return validated;
}

function validateSandboxPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || !Object.hasOwn(SANDBOX_POLICIES, policy.type)) {
    throw invalid(`settings.sandboxPolicy.type must be one of ${Object.keys(SANDBOX_POLICIES).join(", ")}`);
  }
  const allowed = SANDBOX_POLICIES[policy.type];
  const validated = { type: policy.type };
  for (const [key, value] of Object.entries(policy)) {
    if (key === "type") continue;
    if (!allowed.includes(key)) throw invalid(`settings.sandboxPolicy.${key} is not a field of ${policy.type}`);
    if (key === "writableRoots") {
      if (!Array.isArray(value) || value.length > 32 || value.some((root) => typeof root !== "string" || !root.trim())) throw invalid("settings.sandboxPolicy.writableRoots must be an array of at most 32 paths");
    } else if (key === "networkAccess" && policy.type === "externalSandbox") {
      if (value !== "restricted" && value !== "enabled") throw invalid("settings.sandboxPolicy.networkAccess must be restricted or enabled for externalSandbox");
    } else if (typeof value !== "boolean") throw invalid(`settings.sandboxPolicy.${key} must be a boolean`);
    validated[key] = value;
  }
  return validated;
}

// Per-Turn settings overrides, exactly the turn/start keys the app-server
// accepts: model, effort, approvalPolicy and sandboxPolicy. They come from a
// `settings` object, or from the same keys at the top level of startTurn.
// Returns null when nothing is overridden, so nothing is defaulted.
function turnSettingsFromPayload(payload) {
  const source = payload.settings === undefined ? payload : payload.settings;
  if (source === null) return null;
  if (typeof source !== "object" || Array.isArray(source)) throw invalid("settings must be an object");
  const settings = {};
  if (source.model !== undefined && source.model !== null) {
    if (typeof source.model !== "string" || !source.model.trim() || source.model.length > 128) throw invalid("settings.model must be a non-empty string of at most 128 characters");
    settings.model = source.model;
  }
  if (source.effort !== undefined && source.effort !== null) {
    if (typeof source.effort !== "string" || !source.effort.trim() || source.effort.length > 32) throw invalid("settings.effort must be a non-empty string of at most 32 characters");
    settings.effort = source.effort;
  }
  if (source.approvalPolicy !== undefined && source.approvalPolicy !== null) {
    if (!APPROVAL_POLICIES.includes(source.approvalPolicy)) throw invalid(`settings.approvalPolicy must be one of ${APPROVAL_POLICIES.join(", ")}`);
    settings.approvalPolicy = source.approvalPolicy;
  }
  if (source.sandboxPolicy !== undefined && source.sandboxPolicy !== null) settings.sandboxPolicy = validateSandboxPolicy(source.sandboxPolicy);
  return Object.keys(settings).length ? settings : null;
}

// Every ordinary Turn start goes through the shared harness shell so the
// selected carrier's audio, attachment and settings capabilities gate the
// request; settings, when present, are the exact turn/start override keys.
function sendThroughHarness(threadId, content, settings = null) {
  const types = new Set(content.map((item) => item.type));
  const input = { conversationId: threadId, content, ...(settings ? { settings } : {}) };
  if (types.has("audio")) return harness.sendChatAudio(input);
  if (types.has("image")) return harness.sendChatAttachments(input);
  return harness.sendChat(input);
}

function requireQueued(queue, queuedId, threadId) {
  if (typeof queuedId !== "string" || !queuedId) throw invalid("queuedId required");
  const index = queue.items.findIndex((item) => item.queuedId === queuedId);
  if (index === -1) throw new HostError(409, "queued_not_found", `Queued follow-up ${queuedId} is not in the queue of Thread ${threadId}.`, { threadId, queuedId });
  if (queue.items[index].starting) throw new HostError(409, "queued_starting", `Queued follow-up ${queuedId} is being started right now.`, { threadId, queuedId });
  return index;
}

// Host-owned transient state, served without the runtime.
function hostStateAction(payload) {
  if (payload.action === "setNotificationPreference") {
    if (!NOTIFICATION_MODES.includes(payload.mode)) throw invalid(`mode must be one of ${NOTIFICATION_MODES.join(", ")}`);
    notificationPreference = payload.mode;
    appendEvent("clientAction", { action: "setNotificationPreference", mode: payload.mode });
    return { preferences: preferencesProjection() };
  }
  const threadId = requireThreadId(payload);
  if (payload.action === "listQueue") {
    return { queue: queueProjection(threadId, { media: "full" }) };
  }
  const queue = queueRecord(threadId);
  if (payload.action === "updateQueued") {
    const index = requireQueued(queue, payload.queuedId, threadId);
    const input = validateInputs(payload.input);
    const item = queue.items[index];
    item.input = input;
    if (payload.settings !== undefined) item.settings = turnSettingsFromPayload({ settings: payload.settings });
    announceQueue(threadId);
    return { queuedId: item.queuedId, queue: queueProjection(threadId, { media: "full" }) };
  }
  if (payload.action === "deleteQueued") {
    const index = requireQueued(queue, payload.queuedId, threadId);
    queue.items.splice(index, 1);
    if (queue.items.length === 0) {
      queue.paused = false;
      queue.pausedReason = null;
    }
    announceQueue(threadId);
    return { queuedId: payload.queuedId, queue: queueProjection(threadId, { media: "full" }) };
  }
  throw invalid(`Unsupported action: ${payload.action}`);
}

function requireThreadId(payload) {
  if (typeof payload.threadId !== "string" || !payload.threadId) throw invalid("threadId required");
  return payload.threadId;
}

function rememberCreatedThread(thread) {
  runtime.loadedThreadIds.add(thread.id);
  rememberThreads([thread]);
  return thread;
}

// A Thread that is not loaded into the current process generation (opened
// from history, or every Thread after a restart) is resumed before its next
// Turn, the way the app-server expects; a Thread this generation created or
// already resumed goes straight to turn/start.
async function ensureLoaded(threadId) {
  if (runtime.loadedThreadIds.has(threadId)) return;
  await harness.resumeChat({ conversationId: threadId });
  runtime.loadedThreadIds.add(threadId);
}

async function action(payload) {
  if (!payload || typeof payload.action !== "string") throw invalid("Unknown action");
  if (HOST_STATE_ACTIONS.has(payload.action)) return hostStateAction(payload);
  if (!ADAPTER_FREE_ACTIONS.has(payload.action)) requireRuntime();
  if (payload.action === "newThread") {
    const created = await harness.newChat({ ...THREAD_POLICY, cwd: repoRoot, ephemeral: false });
    return { thread: rememberCreatedThread(publicThread(created.value.thread)) };
  }
  if (payload.action === "readThread") {
    const threadId = requireThreadId(payload);
    const read = await client.request("thread/read", { threadId, includeTurns: true });
    return { ...read, settings: threadSettingsProjection(threadId) };
  }
  if (payload.action === "listModels") {
    // The picker's options, from model/list alone: hidden models are dropped
    // again here, and a record without inputModalities takes the pinned
    // schema default of text and image. Send `model` (the slug) back as the
    // turn/start model override, not `id`.
    const listed = await harness.listModels({});
    const models = listed.value.models.filter((model) => !model.hidden).map((model) => ({
      id: model.id,
      model: model.model,
      displayName: model.displayName,
      description: model.description ?? null,
      isDefault: Boolean(model.isDefault),
      defaultReasoningEffort: model.defaultReasoningEffort ?? null,
      supportedReasoningEfforts: (model.supportedReasoningEfforts ?? []).map((option) => ({ reasoningEffort: option.reasoningEffort, description: option.description ?? null })),
      inputModalities: Array.isArray(model.inputModalities) ? model.inputModalities : ["text", "image"],
    }));
    return { models };
  }
  if (payload.action === "compactThread") {
    const threadId = requireThreadId(payload);
    // thread/compact/start replaces a running task in core, so a live Turn
    // refuses it here: the host's own record first, then the runtime's.
    const refuse = (turnId) => new HostError(409, "turn_live", `A Turn is still running in this Thread${turnId ? ` (${turnId})` : ""}; compaction would replace it. Wait for it to complete or interrupt it first.`, { threadId, turnId: turnId ?? null });
    if (liveTurns.has(threadId)) throw refuse(liveTurns.get(threadId));
    // A Thread the runtime does not know is a typed refusal, not a 500.
    let read;
    try {
      await ensureLoaded(threadId);
      read = await client.request("thread/read", { threadId, includeTurns: false });
    } catch (error) {
      throw threadNotFound(error, threadId) ?? error;
    }
    if (read.thread?.status?.type === "active") throw refuse(liveTurns.get(threadId) ?? null);
    await harness.compactChat({ conversationId: threadId });
    appendEvent("clientAction", { action: "compactThread", threadId });
    return { threadId, compacting: true };
  }
  if (payload.action === "searchFiles") {
    // fuzzyFileSearch rooted at the bound repository, bounded, with a fresh
    // cancellation token per request; an empty query asks nothing.
    const query = typeof payload.query === "string" ? payload.query.trim() : "";
    if (query.length > FILE_QUERY_LIMIT) throw invalid(`query must be at most ${FILE_QUERY_LIMIT} characters`);
    const limit = Number.isInteger(payload.limit) ? Math.min(Math.max(payload.limit, 1), FILE_SEARCH_LIMIT) : FILE_SEARCH_LIMIT;
    if (!query) return { query, root: repoRoot, limit, total: 0, files: [] };
    const cancellationToken = `vibehub-${crypto.randomUUID()}`;
    const searched = await harness.searchFiles({ query, roots: [repoRoot], cancellationToken });
    // The runtime's search walks .git too (observed on 0.149.0), so its
    // internals are dropped here: the @ picker offers no .git entry.
    const files = (searched.value.files ?? []).filter((file) => !gitInternal(file.path));
    return {
      query,
      root: repoRoot,
      limit,
      total: files.length,
      files: files.slice(0, limit).map((file) => ({ ...file, absolutePath: resolve(file.root, file.path) })),
    };
  }
  if (payload.action === "listSkills") {
    const listed = await harness.listSkills({ cwds: [repoRoot], forceReload: payload.forceReload === true });
    const entries = listed.value.data ?? [];
    return {
      cwd: repoRoot,
      skills: entries.flatMap((entry) => (entry.skills ?? []).map((skill) => ({
        name: skill.name,
        path: skill.path,
        description: skill.description ?? null,
        shortDescription: skill.shortDescription ?? null,
        enabled: skill.enabled !== false,
        scope: skill.scope ?? null,
        cwd: entry.cwd,
      }))),
      errors: entries.flatMap((entry) => (entry.errors ?? []).map((error) => ({ path: error.path, message: error.message, cwd: entry.cwd }))),
    };
  }
  if (payload.action === "queueTurn") {
    // A follow-up typed while a Turn streams: queued in the host-owned
    // transient queue of this Thread and started as its own turn/start after
    // the live Turn's turn/completed. With no Turn live and no pause it starts
    // right away, so a submission that raced a completion is never stranded.
    const threadId = requireThreadId(payload);
    const input = validateInputs(payload.input);
    const settings = turnSettingsFromPayload({ settings: payload.settings ?? null });
    const queue = queueRecord(threadId);
    if (queue.items.length >= QUEUE_LIMIT) throw new HostError(409, "queue_full", `At most ${QUEUE_LIMIT} follow-ups can wait in one Thread.`, { threadId, limit: QUEUE_LIMIT });
    const item = { queuedId: `queued-${crypto.randomUUID()}`, queuedAt: new Date().toISOString(), input, settings, starting: false };
    queue.items.push(item);
    announceQueue(threadId);
    const started = await drainQueue(threadId);
    return { queuedId: item.queuedId, started, queue: queueProjection(threadId, { media: "full" }) };
  }
  if (payload.action === "resumeQueue") {
    const threadId = requireThreadId(payload);
    const queue = queueRecord(threadId);
    queue.paused = false;
    queue.pausedReason = null;
    announceQueue(threadId);
    const started = await drainQueue(threadId);
    return { started, queue: queueProjection(threadId, { media: "full" }) };
  }
  if (payload.action === "steerQueued") {
    // The per-row opposite of waiting: the queued follow-up leaves the queue
    // and steers the exact live Turn through turn/steer.
    const threadId = requireThreadId(payload);
    if (typeof payload.expectedTurnId !== "string" || !payload.expectedTurnId) throw invalid("expectedTurnId required");
    const queue = queueRecord(threadId);
    const index = requireQueued(queue, payload.queuedId, threadId);
    const item = queue.items[index];
    const result = await client.request("turn/steer", {
      threadId,
      expectedTurnId: payload.expectedTurnId,
      clientUserMessageId: `vibehub-${crypto.randomUUID()}`,
      input: item.input,
    });
    queue.items.splice(index, 1);
    if (queue.items.length === 0) {
      queue.paused = false;
      queue.pausedReason = null;
    }
    appendEvent("clientAction", { action: "steerQueued", threadId, queuedId: item.queuedId, expectedTurnId: payload.expectedTurnId });
    announceQueue(threadId);
    return { ...result, queuedId: item.queuedId, queue: queueProjection(threadId, { media: "full" }) };
  }
  if (payload.action === "createProject") {
    return projects.createProject(payload.name);
  }
  if (payload.action === "renameProject") {
    return projects.renameProject(payload.projectId, payload.name);
  }
  if (payload.action === "deleteProject") {
    return projects.deleteProject(payload.projectId);
  }
  if (payload.action === "moveThread") {
    if (payload.projectId !== null && typeof payload.projectId !== "string") {
      throw invalid("projectId must be a Project id or null");
    }
    return projects.moveThread(payload.threadId, payload.projectId, { beforeThreadId: payload.beforeThreadId ?? null });
  }
  if (payload.action === "forkThread") {
    const threadId = requireThreadId(payload);
    const result = await projects.forkThread(threadId, { lastTurnId: payload.lastTurnId ?? null });
    rememberCreatedThread(result.thread);
    appendEvent("clientAction", { action: "forkThread", sourceThreadId: threadId, createdThreadId: result.thread.id, forkedFromId: result.thread.forkedFromId });
    return result;
  }
  if (payload.action === "archiveThread") {
    return projects.archiveThread(payload.threadId);
  }
  if (payload.action === "unarchiveThread") {
    return projects.unarchiveThread(payload.threadId);
  }
  if (payload.action === "searchThreads") {
    // Native Thread search: the app-server's own thread/list searchTerm over
    // every group in this folder, so Threads beyond the listed tail are found
    // without any host-side index. The result is bounded, never paged forward.
    const limit = Number.isInteger(payload.limit) ? Math.min(Math.max(payload.limit, 1), SEARCH_LIMIT) : SEARCH_LIMIT;
    const searchTerm = typeof payload.searchTerm === "string" ? payload.searchTerm.trim() : "";
    const scope = { cwd: repoRoot, method: "thread/list", filter: "searchTerm", groups: "all sections and Recents in this folder", archived: false };
    if (!searchTerm) return { threads: [], total: 0, limit, searchTerm, scope };
    const threads = await projects.listThreads({ searchTerm: payload.searchTerm.trim(), cwd: repoRoot });
    return { threads: threads.slice(0, limit), total: threads.length, limit, searchTerm, scope };
  }
  if (payload.action === "listImportableProjects") {
    const project = projectProjection(buildUiSnapshot(repoRoot), null, []);
    const candidates = await projects.importableProjects({ repositoryRoot: repoRoot });
    const blocked = project.scope === "no-repository" || project.scope === "migration-required"
      ? project.reason
      : project.binding || project.bindingRecord
        ? `This repository already carries ${BINDING_FILE}.`
        : null;
    return { ...candidates, scope: project.scope, canImport: blocked === null, blockedReason: blocked, writes: REPOSITORY_WRITES.explicitImportOnly };
  }
  if (payload.action === "importProject") {
    if (typeof payload.sectionId !== "string" || !payload.sectionId) throw invalid("sectionId required");
    return importProject(payload.sectionId);
  }
  if (payload.action === "setThreadName") {
    if (typeof payload.threadId !== "string" || typeof payload.name !== "string" || !payload.name.trim() || payload.name.length > 160) {
      throw invalid("bounded threadId and name required");
    }
    await client.request("thread/name/set", { threadId: payload.threadId, name: payload.name.trim() });
    return { threadId: payload.threadId, name: payload.name.trim() };
  }
  if (payload.action === "startTurn") {
    const threadId = requireThreadId(payload);
    const input = validateInputs(payload.input);
    const settings = turnSettingsFromPayload(payload);
    await ensureLoaded(threadId);
    const started = await sendThroughHarness(threadId, input, settings);
    liveTurns.set(threadId, started.value.turn.id);
    return { ...started.value, settings: threadSettingsProjection(threadId) };
  }
  if (payload.action === "steerTurn") {
    // Steering stays exact: the live Turn named by expectedTurnId, or the
    // runtime's own refusal.
    if (typeof payload.threadId !== "string" || typeof payload.expectedTurnId !== "string") throw invalid("threadId and expectedTurnId required");
    const input = validateInputs(payload.input);
    const result = await client.request("turn/steer", {
      threadId: payload.threadId,
      expectedTurnId: payload.expectedTurnId,
      clientUserMessageId: `vibehub-${crypto.randomUUID()}`,
      input,
    });
    appendEvent("clientAction", { action: "steerTurn", threadId: payload.threadId, expectedTurnId: payload.expectedTurnId });
    return result;
  }
  if (payload.action === "interruptTurn") {
    if (typeof payload.threadId !== "string" || typeof payload.turnId !== "string") {
      throw invalid("threadId and turnId required");
    }
    const interrupted = await harness.interruptChat({ conversationId: payload.threadId, runId: payload.turnId });
    // Nothing queued is sent after an interrupt until an explicit Resume.
    pauseQueue(payload.threadId, "interrupted");
    return { ...interrupted.value, queue: queueProjection(payload.threadId) };
  }
  if (payload.action === "startTask") {
    requireBoundScope();
    // An explicit Quote into Task on a Task without a Thread yet reaches the
    // Agent only here, as the packet's conversation.humanMessage, exactly as
    // a later Task Turn carries its message; nothing else in the packet moves.
    if (payload.humanMessage !== undefined && payload.humanMessage !== null && (typeof payload.humanMessage !== "string" || !payload.humanMessage.trim())) {
      throw invalid("humanMessage must be a non-empty string when present");
    }
    const workspace = taskWorkspaceProjection(payload.ticketId, {
      selectedContextIds: Array.isArray(payload.selectedContextIds) ? payload.selectedContextIds : [],
      operation: payload.operation === "explore" ? "explore" : "start",
      humanMessage: typeof payload.humanMessage === "string" ? payload.humanMessage : null,
    });
    // The Task Workspace contract sends the host-owned Context packet and names
    // the Thread; that composition lives in codex-adapter/task-context.mjs.
    const started = await startTaskContextThread({ client, packet: workspace.packet, cwd: repoRoot, ephemeral: false, ...THREAD_POLICY });
    runtime.loadedThreadIds.add(started.threadId);
    runtime.knownThreadIds.add(started.threadId);
    runtime.knownTaskLinks.set(started.threadId, started.ticketId);
    // The Thread's own record, linked by its Codex name: the scoped listing
    // carries it only once its first userMessage (the packet) is durable,
    // so the browser holds this record until a bootstrap lists it.
    const read = await client.request("thread/read", { threadId: started.threadId, includeTurns: false });
    return { ...started, thread: publicThread(read.thread) };
  }
  if (payload.action === "readTask") {
    requireBoundScope();
    return taskWorkspaceProjection(payload.ticketId);
  }
  // The explicit Chat bridge: unavailable with the missing scope explained
  // unless the Project is bound; each write is one validated document.
  if (payload.action === "listTaskTargets") {
    requireBoundScope();
    return { tasks: listTaskTargets() };
  }
  if (payload.action === "listRooms") {
    requireBoundScope();
    return { rooms: listRooms() };
  }
  if (payload.action === "previewCreateTask") {
    requireBoundScope();
    return previewCreateTask(payload);
  }
  if (payload.action === "createTask") {
    requireBoundScope();
    return createTask(payload);
  }
  if (payload.action === "attachTask") {
    requireBoundScope();
    return attachTask(payload);
  }
  if (payload.action === "remember") {
    requireBoundScope();
    return remember(payload);
  }
  if (payload.action === "startTaskTurn" || payload.action === "steerTaskTurn") {
    requireBoundScope();
    if (typeof payload.ticketId !== "string" || typeof payload.threadId !== "string" || typeof payload.message !== "string" || !payload.message.trim()) {
      throw invalid("ticketId, threadId and message required");
    }
    const linked = await linkedTaskThread(payload.threadId, payload.ticketId);
    if (!linked) throw new HostError(409, "task_not_linked", "Thread is not linked to this canonical Task");
    const operation = payload.action === "steerTaskTurn" ? "steer" : "continue";
    const workspace = taskWorkspaceProjection(payload.ticketId, {
      selectedContextIds: Array.isArray(payload.selectedContextIds) ? payload.selectedContextIds : [],
      thread: { id: linked.id, activeTurnId: payload.expectedTurnId ?? null },
      operation,
      humanMessage: payload.message,
    });
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    if (attachments.length > 3 || !validInputs([{ type: "text", text: payload.message }, ...attachments])) {
      throw invalid("Task Turn attachments must be bounded image or audio inputs");
    }
    // payloadText is the exact Turn input: the same bytes the Workspace shows
    // and the app-server persists as this Turn's user message.
    const payloadText = workspace.packetText;
    const input = [{ type: "text", text: payloadText }, ...attachments];
    if (operation === "steer") {
      if (typeof payload.expectedTurnId !== "string") throw invalid("expectedTurnId required to steer");
      const steered = await client.request("turn/steer", {
        threadId: linked.id,
        expectedTurnId: payload.expectedTurnId,
        clientUserMessageId: `vibehub-${crypto.randomUUID()}`,
        input,
      });
      return { ...steered, ticketId: payload.ticketId, threadId: linked.id, operation, payloadText };
    }
    await client.request("thread/resume", { threadId: linked.id, cwd: repoRoot, ...THREAD_POLICY });
    runtime.loadedThreadIds.add(linked.id);
    const continued = await sendThroughHarness(linked.id, input);
    return { ...continued.value, ticketId: payload.ticketId, threadId: linked.id, operation, payloadText };
  }
  if (payload.action === "resolveRequest") {
    const request = pendingRequests.get(String(payload.requestId));
    // Only the process generation that asked can be answered; a request from
    // an exited process was resolved as runtime_exited and is never replayed.
    if (!request || request.runtimeGeneration !== runtime.generation) throw new HostError(409, "request_not_pending", "Approval or input request is no longer pending");
    let result;
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
      if (!validateRequestDecision(request, payload.decision)) throw invalid("Invalid approval decision");
      result = { decision: payload.decision };
    } else if (request.method === "item/tool/requestUserInput") {
      if (!payload.answers || typeof payload.answers !== "object") throw invalid("Answers required");
      result = { answers: payload.answers };
    } else {
      throw invalid("Unsupported server request");
    }
    await harness.resolveInteraction({ conversationId: request.params?.threadId ?? null, requestId: request.id, result });
    pendingRequests.delete(String(request.id));
    appendEvent("requestResolved", { id: request.id, method: request.method });
    return { resolved: true };
  }
  throw invalid(`Unsupported action: ${payload.action}`);
}

// Boot: spawn the app-server, read what it reports about itself, then pass
// every pinned stop condition before the shell reuses it. The generated
// protocol schema is re-hashed when the binary can emit it; when it cannot
// (the fixture, or a binary without generate-json-schema) the condition is
// shown as unverified rather than assumed.
async function startRuntime() {
  const started = client.start();
  const spawnFailure = new Promise((_, reject) => client.child?.once("error", reject));
  const initialized = await Promise.race([started, spawnFailure]);
  runtime.generation = client.generation;
  runtime.version = observedRuntimeVersion(initialized);
  runtime.alive = true;
  const carrier = harness.boot();
  await readAccount();
  if (runtime.version === harness.capabilities.upstream.version) {
    try {
      runtime.schemaProbe = probeCodexSchema({ codex: flags.codex });
    } catch (error) {
      runtime.schemaProbe = null;
      const reason = error.status !== undefined && error.status !== null
        ? `exit ${error.status}${error.stderr ? `, ${String(error.stderr).trim().split("\n")[0].slice(0, 120)}` : ""}`
        : String(error.message).split("\n")[0].slice(0, 120);
      runtime.schemaProbeError = `generate-json-schema unavailable: ${reason}`;
    }
  }
  if (!gateRuntime()) runtime.state = "alive";
  return carrier;
}

let carrier;
try {
  carrier = await startRuntime();
} catch (error) {
  process.stderr.write(`Unable to start the Codex app-server (${flags.codex}): ${error.message}\n`);
  await client.stop().catch(() => {});
  process.exit(1);
}

const server = createServer(async (request, response) => {
  try {
    requireHost(request);
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/health") {
      json(response, 200, { ok: true, shell: SHELL_ID, harness: carrier.carrierId, localOnly: true, repositoryWrites: REPOSITORY_WRITES, codexRuntime: true });
      return;
    }
    if (assets.has(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") throw new HostError(405, "method_not_allowed", "Asset routes are read-only");
      const [path, type] = assets.get(url.pathname);
      const content = await readFile(path);
      response.writeHead(200, { ...headers, "content-type": type });
      response.end(request.method === "HEAD" ? undefined : content);
      return;
    }
    if (!url.pathname.startsWith("/api/")) throw new HostError(404, "not_found", "Route not found");
    requireBearer(request);
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      json(response, 200, { ok: true, data: await bootstrap() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const after = Number(url.searchParams.get("after") ?? 0);
      json(response, 200, {
        ok: true,
        data: {
          ...eventWindow(events, after, sequence, runtime),
          pendingRequests: [...pendingRequests.values()],
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      json(response, 200, { ok: true, data: await action(await body(request)) });
      return;
    }
    throw new HostError(405, "method_not_allowed", "Unsupported API method");
  } catch (error) {
    fail(response, error);
  }
});

function openBrowser(url) {
  const command = process.platform === "darwin"
    ? { file: "open", args: [url] }
    : process.platform === "win32"
      ? { file: "cmd", args: ["/c", "start", "", url] }
      : { file: "xdg-open", args: [url] };
  const child = spawn(command.file, command.args, { detached: true, stdio: "ignore" });
  child.once("error", () => {
    process.stderr.write(`Could not open the browser. Open this URL manually:\n${url}\n`);
  });
  child.unref();
}

server.on("error", (error) => {
  process.stderr.write(`Unable to start the Codex-first shell: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
  void stop();
});

server.listen(flags.port, LOOPBACK_HOST, () => {
  const address = server.address();
  origin = `http://${LOOPBACK_HOST}:${address.port}`;
  const url = `${origin}/#${token}`;
  const envelope = {
    ok: true,
    url,
    pid: process.pid,
    shell: SHELL_ID,
    harness: carrier.carrierId,
    runtime: runtimeProjection(),
    localOnly: true,
    repositoryWrites: REPOSITORY_WRITES,
    codexRuntime: true,
  };
  process.stdout.write(`${flags.json ? JSON.stringify(envelope) : `VibeHub Codex-first shell: ${url}`}\n`);
  if (runtime.halt) process.stderr.write(haltNotice());
  if (flags.open) openBrowser(url);
});

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(restartTimer);
  restartTimer = null;
  // Closing the shared shell closes the selected adapter, which stops the
  // app-server child owned by the codex adapter client.
  await harness.close();
  server.closeAllConnections?.();
  server.close(() => process.exit(process.exitCode ?? 0));
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
