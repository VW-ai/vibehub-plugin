#!/usr/bin/env node

// VibeHub Codex-first shell launcher.
//
// Boot order: the Codex app-server process is owned by
// packages/codex-adapter/client.mjs, the single-harness routing is owned by
// packages/harness-core (shell.mjs over router.mjs), Codex Projects and Task
// Context packets are owned by packages/codex-adapter, and this script owns
// only the loopback host, the short-lived bearer URL and the host-side
// projections of the Git-native repository.

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../packages/codex-adapter/client.mjs";
import { createCodexHarnessAdapter } from "../packages/codex-adapter/harness.mjs";
import { CodexProjectsAdapter, publicCodexThread } from "../packages/codex-adapter/projects.mjs";
import { buildTaskContextPacket, startTaskContextThread, taskLinkFromPreview } from "../packages/codex-adapter/task-context.mjs";
import { createSharedHarnessShell } from "../packages/harness-core/shell.mjs";
import { eventWindow } from "../apps/codex-first-shell/event-window.mjs";
import { requestDescriptor, unsupportedServerRequestResult, validateRequestDecision } from "../apps/codex-first-shell/server-request-registry.mjs";
import { buildTicketHandoff, buildUiSnapshot } from "../skills/scripts/vh-ui.mjs";
import { documents, loadRepository } from "../skills/scripts/vh.mjs";

const LOOPBACK_HOST = "127.0.0.1";
const SHELL_ID = "codex-first-shell";
const EVENT_LIMIT = 500;
const BODY_LIMIT = 12 * 1024 * 1024;
const APP_SERVER_TIMEOUT_MS = 120_000;
const THREAD_POLICY = Object.freeze({ approvalPolicy: "on-request", sandbox: "workspace-write" });

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(sourceRoot, "apps", SHELL_ID);

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
const repoRoot = flags.repo;
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
const runtime = { generation: 1, alive: false, version: null };

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
  pendingRequests.set(String(value.id), value);
  appendEvent("serverRequest", value);
});
client.on("notification:serverRequest/resolved", (params) => {
  pendingRequests.delete(String(params.requestId));
  appendEvent("requestResolved", { id: params.requestId, threadId: params.threadId, resolution: "external" });
});
client.on("stderr", (line) => appendEvent("runtimeStderr", { line }));
client.on("exit", (value) => {
  runtime.alive = false;
  runtime.generation += 1;
  appendEvent("runtimeExit", { ...value, runtimeGeneration: runtime.generation });
});

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
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (message) => new HostError(400, "invalid_request", message);

function json(response, status, value) {
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function fail(response, error) {
  const status = error instanceof HostError ? error.status : error?.name === "UnsupportedHarnessCapabilityError" ? 409 : 500;
  const code = error instanceof HostError ? error.code : error?.name === "UnsupportedHarnessCapabilityError" ? "unsupported_capability" : "internal_error";
  json(response, status, { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } });
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
  return (result.data ?? result.threads ?? []).map(publicThread);
}

function graphProjection() {
  const snapshot = buildUiSnapshot(repoRoot);
  return {
    snapshotId: snapshot.state.graph.snapshotId,
    project: snapshot.state.project,
    tickets: snapshot.state.graph.tickets,
    relations: snapshot.state.graph.relations,
    source: snapshot.state.graph.source,
  };
}

function knowledgeProjection() {
  const repository = loadRepository(repoRoot);
  return [...repository.contexts.documents.values()]
    .filter(({ document }) => document.state === "active")
    .map(({ document, path }) => ({
      contextId: document.context_id,
      type: document.type,
      summary: document.summary,
      detail: document.detail,
      tags: document.tags,
      room: path.split(".vibehub/rooms/")[1]?.split("/").slice(0, -1).join("/") ?? "project",
      sourceRef: document.source.ref,
    }))
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

function taskWorkspaceProjection(ticketId, { selectedContextIds = [], thread = null, operation = "start", humanMessage = null } = {}) {
  const handoff = buildTicketHandoff(repoRoot, ticketId);
  const snapshot = buildUiSnapshot(repoRoot);
  const repository = loadRepository(repoRoot);
  const contexts = knowledgeProjection();
  const packet = buildTaskContextPacket({
    handoff,
    project: snapshot.state.project,
    contexts,
    rooms: snapshot.state.rooms.rooms,
    selectedContextIds,
    priorAccepted: priorAcceptedProjection(handoff, repository),
    thread,
    operation,
    humanMessage,
  });
  return {
    handoff,
    packet,
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

function attentionProjection(graph) {
  const repository = loadRepository(repoRoot);
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
  };
}

async function bootstrap() {
  const [account, projectSnapshot] = await Promise.all([client.accountStatus(), projects.snapshot()]);
  const graph = graphProjection();
  return {
    account,
    ...projectSnapshot,
    graph,
    contexts: knowledgeProjection(),
    attention: attentionProjection(graph),
    harness: carrier,
    runtime: runtimeProjection(),
    pendingRequests: [...pendingRequests.values()],
    eventCursor: sequence,
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

async function action(payload) {
  if (!payload || typeof payload.action !== "string") throw invalid("Unknown action");
  if (payload.action === "newThread") {
    const created = await harness.newChat({ ...THREAD_POLICY, cwd: repoRoot, ephemeral: false });
    return { thread: publicThread(created.value.thread) };
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
    if (typeof payload.searchTerm !== "string" || !payload.searchTerm.trim()) return { threads: [] };
    return { threads: await projects.listThreads({ searchTerm: payload.searchTerm.trim() }) };
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
    const workspace = taskWorkspaceProjection(payload.ticketId, {
      selectedContextIds: Array.isArray(payload.selectedContextIds) ? payload.selectedContextIds : [],
      operation: payload.operation === "explore" ? "explore" : "start",
    });
    // The Task Workspace contract sends the host-owned Context packet and names
    // the Thread; that composition lives in codex-adapter/task-context.mjs.
    return startTaskContextThread({ client, packet: workspace.packet, cwd: repoRoot, ephemeral: false, ...THREAD_POLICY });
  }
  if (payload.action === "readTask") {
    return taskWorkspaceProjection(payload.ticketId);
  }
  if (payload.action === "startTaskTurn" || payload.action === "steerTaskTurn") {
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
    const input = [{ type: "text", text: JSON.stringify(workspace.packet, null, 2) }, ...attachments];
    if (operation === "steer") {
      if (typeof payload.expectedTurnId !== "string") throw invalid("expectedTurnId required to steer");
      return client.request("turn/steer", {
        threadId: linked.id,
        expectedTurnId: payload.expectedTurnId,
        clientUserMessageId: `vibehub-${crypto.randomUUID()}`,
        input,
      });
    }
    await client.request("thread/resume", { threadId: linked.id, cwd: repoRoot, ...THREAD_POLICY });
    const continued = await sendThroughHarness(linked.id, input);
    return continued.value;
  }
  if (payload.action === "resolveRequest") {
    const request = pendingRequests.get(String(payload.requestId));
    if (!request) throw new HostError(409, "request_not_pending", "Approval or input request is no longer pending");
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

function observedRuntimeVersion(initialized) {
  return String(initialized?.userAgent ?? "").match(/^[^/\s]+\/(\d+\.\d+\.\d+)/u)?.[1] ?? null;
}

async function startRuntime() {
  const started = client.start();
  const spawnFailure = new Promise((_, reject) => client.child?.once("error", reject));
  const initialized = await Promise.race([started, spawnFailure]);
  runtime.version = observedRuntimeVersion(initialized);
  runtime.alive = true;
  return harness.boot();
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
      json(response, 200, { ok: true, shell: SHELL_ID, harness: carrier.carrierId, localOnly: true, repositoryWrites: false, codexRuntime: true });
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
    repositoryWrites: false,
    codexRuntime: true,
  };
  process.stdout.write(`${flags.json ? JSON.stringify(envelope) : `VibeHub Codex-first shell: ${url}`}\n`);
  if (flags.open) openBrowser(url);
});

async function stop() {
  if (stopping) return;
  stopping = true;
  // Closing the shared shell closes the selected adapter, which stops the
  // app-server child owned by the codex adapter client.
  await harness.close();
  server.closeAllConnections?.();
  server.close(() => process.exit(process.exitCode ?? 0));
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
