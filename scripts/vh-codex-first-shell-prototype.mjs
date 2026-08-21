#!/usr/bin/env node

import crypto from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../packages/codex-adapter/client.mjs";
import { startCodexTask } from "../packages/codex-adapter/handoff.mjs";
import { buildTicketHandoff, buildUiSnapshot } from "../skills/scripts/vh-ui.mjs";
import { documents, loadRepository } from "../skills/scripts/vh.mjs";

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const assetRoot = join(sourceRoot, "apps", "codex-first-shell-prototype");
const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
};
const repoRoot = resolve(flag("--repo") ?? process.cwd());
const requestedPort = Number(flag("--port") ?? 0);
const token = crypto.randomBytes(32).toString("hex");
const eventLimit = 500;
const bodyLimit = 12 * 1024 * 1024;

if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
  process.stderr.write("--port must be an integer from 0 to 65535\n");
  process.exit(1);
}

const client = new CodexAppServerClient({ cwd: repoRoot, timeoutMs: 120_000 });
const events = [];
const pendingRequests = new Map();
let sequence = 0;
let origin = null;
let stopping = false;

function appendEvent(kind, value) {
  events.push({ sequence: ++sequence, kind, value, observedAt: new Date().toISOString() });
  if (events.length > eventLimit) events.splice(0, events.length - eventLimit);
}

client.on("notification", (value) => appendEvent("notification", value));
client.on("serverRequest", (value) => {
  pendingRequests.set(String(value.id), value);
  appendEvent("serverRequest", value);
});
client.on("stderr", (line) => appendEvent("runtimeStderr", { line }));
client.on("exit", (value) => appendEvent("runtimeExit", value));

const assets = new Map([
  ["/", [join(assetRoot, "index.html"), "text/html; charset=utf-8"]],
  ["/index.html", [join(assetRoot, "index.html"), "text/html; charset=utf-8"]],
  ["/app.css", [join(assetRoot, "app.css"), "text/css; charset=utf-8"]],
  ["/app.js", [join(assetRoot, "app.js"), "text/javascript; charset=utf-8"]],
  ["/chat-fixtures.json", [join(assetRoot, "chat-fixtures.json"), "application/json; charset=utf-8"]],
  ["/vibehub-mark.svg", [join(sourceRoot, "assets", "brand", "vibehub-mark.svg"), "image/svg+xml"]],
]);

const headers = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function json(response, status, value) {
  response.writeHead(status, { ...headers, "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function fail(response, status, code, message) {
  json(response, status, { ok: false, error: { code, message } });
}

function requireLocal(request) {
  const host = request.headers.host;
  if (!host || !origin || `http://${host}` !== origin) throw Object.assign(new Error("Host rejected"), { status: 403 });
}

function requireToken(request) {
  if (request.headers.authorization !== `Bearer ${token}`) {
    throw Object.assign(new Error("Bearer token required"), { status: 401 });
  }
}

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > bodyLimit) throw Object.assign(new Error("Request body is too large"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be JSON"), { status: 400 });
  }
}

function threadTitle(thread) {
  return thread.name || thread.preview?.split("\n")[0]?.slice(0, 72) || "Untitled task";
}

function taskLinkFromThread(thread) {
  try {
    const parsed = JSON.parse(thread.preview);
    return parsed?.kind === "vibehub_ticket_handoff" && typeof parsed.ticketId === "string"
      ? { ticketId: parsed.ticketId, threadId: thread.id }
      : null;
  } catch {
    return null;
  }
}

function publicThread(thread) {
  return {
    id: thread.id,
    title: threadTitle(thread),
    preview: thread.preview,
    cwd: thread.cwd,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: thread.status,
    source: thread.source,
    forkedFromId: thread.forkedFromId,
    taskLink: taskLinkFromThread(thread),
  };
}

async function listThreads() {
  const result = await client.request("thread/list", {
    archived: false,
    cursor: null,
    cwd: repoRoot,
    limit: 40,
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

async function bootstrap() {
  const [account, threads] = await Promise.all([client.accountStatus(), listThreads()]);
  const graph = graphProjection();
  return {
    account,
    threads,
    graph,
    contexts: knowledgeProjection(),
    attention: attentionProjection(graph),
    runtime: {
      provider: "Codex app-server",
      version: "0.147.0",
      local: true,
      audioInput: true,
      realtimeConversation: false,
    },
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
      return typeof item.url === "string" && item.url.startsWith("data:") && item.url.length <= bodyLimit;
    }
    return false;
  });
}

async function action(payload) {
  if (!payload || typeof payload.action !== "string") throw Object.assign(new Error("Unknown action"), { status: 400 });
  if (payload.action === "newThread") {
    const started = await client.request("thread/start", {
      approvalPolicy: "on-request",
      cwd: repoRoot,
      ephemeral: false,
      sandbox: "workspace-write",
    });
    return { thread: publicThread(started.thread) };
  }
  if (payload.action === "readThread") {
    if (typeof payload.threadId !== "string") throw Object.assign(new Error("threadId required"), { status: 400 });
    return client.request("thread/read", { threadId: payload.threadId, includeTurns: true });
  }
  if (payload.action === "startTurn") {
    if (typeof payload.threadId !== "string" || !validInputs(payload.input)) {
      throw Object.assign(new Error("threadId and bounded text/image/audio input required"), { status: 400 });
    }
    return client.request("turn/start", { threadId: payload.threadId, input: payload.input });
  }
  if (payload.action === "interruptTurn") {
    if (typeof payload.threadId !== "string" || typeof payload.turnId !== "string") {
      throw Object.assign(new Error("threadId and turnId required"), { status: 400 });
    }
    return client.request("turn/interrupt", { threadId: payload.threadId, turnId: payload.turnId });
  }
  if (payload.action === "startTask") {
    const handoff = buildTicketHandoff(repoRoot, payload.ticketId);
    return startCodexTask({ client, payload: handoff, cwd: repoRoot, ephemeral: false });
  }
  if (payload.action === "readTask") {
    return { handoff: buildTicketHandoff(repoRoot, payload.ticketId) };
  }
  if (payload.action === "resolveRequest") {
    const request = pendingRequests.get(String(payload.requestId));
    if (!request) throw Object.assign(new Error("Approval or input request is no longer pending"), { status: 409 });
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      if (!["accept", "acceptForSession", "decline", "cancel"].includes(payload.decision)) {
        throw Object.assign(new Error("Invalid approval decision"), { status: 400 });
      }
      client.respond(request.id, { decision: payload.decision });
    } else if (request.method === "item/tool/requestUserInput") {
      if (!payload.answers || typeof payload.answers !== "object") {
        throw Object.assign(new Error("Answers required"), { status: 400 });
      }
      client.respond(request.id, { answers: payload.answers });
    } else {
      throw Object.assign(new Error("Unsupported server request"), { status: 400 });
    }
    pendingRequests.delete(String(request.id));
    appendEvent("requestResolved", { id: request.id, method: request.method });
    return { resolved: true };
  }
  throw Object.assign(new Error(`Unsupported action: ${payload.action}`), { status: 400 });
}

await client.start();

const server = createServer(async (request, response) => {
  try {
    requireLocal(request);
    const url = new URL(request.url ?? "/", origin);
    if (url.pathname === "/health") {
      json(response, 200, { ok: true, prototype: "codex-first-shell", localOnly: true, repositoryWrites: false, codexRuntime: true });
      return;
    }
    if (assets.has(url.pathname)) {
      if (request.method !== "GET" && request.method !== "HEAD") return fail(response, 405, "method_not_allowed", "Asset routes are read-only");
      const [path, type] = assets.get(url.pathname);
      const content = await readFile(path);
      response.writeHead(200, { ...headers, "content-type": type });
      response.end(request.method === "HEAD" ? undefined : content);
      return;
    }
    if (!url.pathname.startsWith("/api/")) return fail(response, 404, "not_found", "Route not found");
    requireToken(request);
    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      json(response, 200, { ok: true, data: await bootstrap() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      const after = Number(url.searchParams.get("after") ?? 0);
      json(response, 200, {
        ok: true,
        data: {
          events: events.filter((entry) => entry.sequence > after),
          cursor: sequence,
          pendingRequests: [...pendingRequests.values()],
        },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      json(response, 200, { ok: true, data: await action(await body(request)) });
      return;
    }
    fail(response, 405, "method_not_allowed", "Unsupported API method");
  } catch (error) {
    fail(response, error.status ?? 500, error.status ? "invalid_request" : "internal_error", error.message);
  }
});

server.on("error", (error) => {
  process.stderr.write(`Unable to start Codex-first prototype: ${error.code ?? error.message}\n`);
  process.exitCode = 1;
});

server.listen(requestedPort, "127.0.0.1", () => {
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/#${token}`;
  const envelope = { ok: true, url, pid: process.pid, localOnly: true, repositoryWrites: false, codexRuntime: true };
  process.stdout.write(`${argv.includes("--json") ? JSON.stringify(envelope) : `VibeHub Codex-first prototype: ${url}`}\n`);
});

async function stop() {
  if (stopping) return;
  stopping = true;
  await client.stop();
  server.close(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, stop);
