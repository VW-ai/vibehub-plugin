#!/usr/bin/env node

// VibeHub Codex-first shell launcher.
//
// Boot order: the Codex app-server process is owned by
// packages/codex-adapter/client.mjs, the single-harness routing is owned by
// packages/harness-core (shell.mjs over router.mjs), Codex Projects and Task
// Context packets are owned by packages/codex-adapter, and this script owns
// only the loopback host, the short-lived bearer URL, the host-side
// projections of the Git-native repository and the one explicit repository
// write: importing a single-folder Codex Project as this VibeHub Project.

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
import { buildTicketHandoff, buildUiSnapshot } from "../skills/scripts/vh-ui.mjs";
import { documents, initProject, projectCompatibility, readDocument, writeDocument } from "../skills/scripts/vh.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const SHELL_ID = "codex-first-shell";
const EVENT_LIMIT = 500;
const BODY_LIMIT = 12 * 1024 * 1024;
const APP_SERVER_TIMEOUT_MS = 120_000;
const SEARCH_LIMIT = 20;
// When the app-server exits on its own the host respawns it with this
// backoff; after the last attempt the runtime halts visibly instead of looping.
const RESTART_BACKOFF_MS = Object.freeze(parseBackoff(process.env.VIBEHUB_CODEX_RESTART_BACKOFF_MS, [500, 2000, 5000]));
// Only readTask is served from the repository alone; every other action needs
// the live app-server and is refused truthfully while it is restarting or halted.
const ADAPTER_FREE_ACTIONS = new Set(["readTask"]);
const THREAD_POLICY = Object.freeze({ approvalPolicy: "on-request", sandbox: "workspace-write" });
// The Codex Project binding record is provenance only. Chat membership stays
// in the native ThreadSection, which is re-read on every bootstrap; the
// record says which single-folder Codex Project the human imported and when.
const BINDING_FILE = join(".vibehub", "codex-project.yaml");
// The only repository write this host ever performs is the explicit import:
// the VibeHub scaffold plus the binding record, all left uncommitted.
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
      if (outcome?.status !== "successful") return null;
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
function taskWorkspaceProjection(ticketId, { selectedContextIds = [], thread = null, operation = "start", humanMessage = null } = {}) {
  const handoff = buildTicketHandoff(repoRoot, ticketId);
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
    pendingRequests: [...pendingRequests.values()],
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

function validInputs(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 8) return false;
  return input.every((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.type === "text") return typeof item.text === "string" && item.text.trim().length > 0;
    if (item.type === "image" || item.type === "audio") {
      return typeof item.url === "string" && item.url.startsWith("data:") && item.url.length <= BODY_LIMIT;
    }
    return false;
  });
}

// Every ordinary Turn start goes through the shared harness shell so the
// selected carrier's audio and attachment capabilities gate the request.
function sendThroughHarness(threadId, content) {
  const types = new Set(content.map((item) => item.type));
  const input = { conversationId: threadId, content };
  if (types.has("audio")) return harness.sendChatAudio(input);
  if (types.has("image")) return harness.sendChatAttachments(input);
  return harness.sendChat(input);
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
  if (!ADAPTER_FREE_ACTIONS.has(payload.action)) requireRuntime();
  if (payload.action === "newThread") {
    const created = await harness.newChat({ ...THREAD_POLICY, cwd: repoRoot, ephemeral: false });
    return { thread: rememberCreatedThread(publicThread(created.value.thread)) };
  }
  if (payload.action === "readThread") {
    return client.request("thread/read", { threadId: requireThreadId(payload), includeTurns: true });
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
    if (typeof payload.threadId !== "string" || !validInputs(payload.input)) {
      throw invalid("threadId and bounded text/image/audio input required");
    }
    await ensureLoaded(payload.threadId);
    const started = await sendThroughHarness(payload.threadId, payload.input);
    return started.value;
  }
  if (payload.action === "steerTurn") {
    if (typeof payload.threadId !== "string" || typeof payload.expectedTurnId !== "string" || !validInputs(payload.input)) {
      throw invalid("threadId, expectedTurnId and bounded text/image/audio input required");
    }
    const result = await client.request("turn/steer", {
      threadId: payload.threadId,
      expectedTurnId: payload.expectedTurnId,
      clientUserMessageId: `vibehub-${crypto.randomUUID()}`,
      input: payload.input,
    });
    appendEvent("clientAction", { action: "steerTurn", threadId: payload.threadId, expectedTurnId: payload.expectedTurnId });
    return result;
  }
  if (payload.action === "interruptTurn") {
    if (typeof payload.threadId !== "string" || typeof payload.turnId !== "string") {
      throw invalid("threadId and turnId required");
    }
    const interrupted = await harness.interruptChat({ conversationId: payload.threadId, runId: payload.turnId });
    return interrupted.value;
  }
  if (payload.action === "startTask") {
    requireBoundScope();
    const workspace = taskWorkspaceProjection(payload.ticketId, {
      selectedContextIds: Array.isArray(payload.selectedContextIds) ? payload.selectedContextIds : [],
      operation: payload.operation === "explore" ? "explore" : "start",
    });
    // The Task Workspace contract sends the host-owned Context packet and names
    // the Thread; that composition lives in codex-adapter/task-context.mjs.
    const started = await startTaskContextThread({ client, packet: workspace.packet, cwd: repoRoot, ephemeral: false, ...THREAD_POLICY });
    runtime.loadedThreadIds.add(started.threadId);
    runtime.knownThreadIds.add(started.threadId);
    runtime.knownTaskLinks.set(started.threadId, started.ticketId);
    return started;
  }
  if (payload.action === "readTask") {
    requireBoundScope();
    return taskWorkspaceProjection(payload.ticketId);
  }
  if (payload.action === "startTaskTurn" || payload.action === "steerTaskTurn") {
    requireBoundScope();
    if (typeof payload.ticketId !== "string" || typeof payload.threadId !== "string" || typeof payload.message !== "string" || !payload.message.trim()) {
      throw invalid("ticketId, threadId and message required");
    }
    const threads = await listThreads();
    const linked = threads.find((thread) => thread.id === payload.threadId && thread.taskLink?.ticketId === payload.ticketId);
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
