#!/usr/bin/env node

// Minimal stand-in for `codex app-server --listen stdio://`.
//
// It speaks the JSON-RPC line protocol that packages/codex-adapter/client.mjs
// expects, keeps Threads and Turns in memory for one process, and appends every
// inbound message to the file named by CODEX_FIXTURE_LOG so a test can prove
// which upstream methods the production shell actually dispatched.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const version = process.env.CODEX_FIXTURE_VERSION ?? "0.147.0";
const logPath = process.env.CODEX_FIXTURE_LOG ?? null;
const threads = new Map();
let counter = 0;
const nextId = (prefix) => `${prefix}-${++counter}`;
const now = () => new Date().toISOString();

function record(entry) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function threadRecord(thread) {
  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    cwd: thread.cwd,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.updatedAt,
    status: thread.status,
    source: "appServer",
    forkedFromId: thread.forkedFromId,
    section: thread.section,
  };
}

function requireThread(params) {
  const thread = threads.get(params?.threadId);
  if (!thread) throw Object.assign(new Error(`Unknown thread ${params?.threadId}`), { code: -32602 });
  return thread;
}

function listThreads(params) {
  return [...threads.values()]
    .filter((thread) => thread.archived === Boolean(params?.archived))
    .filter((thread) => params?.sectionId === undefined || (thread.section?.id ?? null) === params.sectionId)
    .filter((thread) => !params?.searchTerm || `${thread.name ?? ""}\n${thread.preview}`.includes(params.searchTerm))
    .map(threadRecord);
}

const handlers = {
  initialize: () => ({
    userAgent: `vibehub/${version} (fixture; arm64) fixture (vibehub; 0.0.0)`,
    codexHome: "/tmp/codex-fixture",
    platformFamily: "unix",
    platformOs: "fixture",
  }),
  "account/read": () => ({ account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true }),
  "threadSection/list": () => ({ data: [], nextCursor: null }),
  "thread/list": (params) => ({ data: listThreads(params), nextCursor: null }),
  "thread/start": (params) => {
    const thread = {
      id: nextId("fixture-thread"),
      name: null,
      preview: "",
      cwd: params?.cwd ?? process.cwd(),
      createdAt: now(),
      updatedAt: now(),
      status: { type: "idle" },
      forkedFromId: null,
      section: null,
      archived: false,
      turns: [],
      policy: { approvalPolicy: params?.approvalPolicy ?? null, sandbox: params?.sandbox ?? null },
    };
    threads.set(thread.id, thread);
    return { thread: threadRecord(thread) };
  },
  "thread/read": (params) => {
    const thread = requireThread(params);
    return { thread: { ...threadRecord(thread), turns: params?.includeTurns ? thread.turns : [] } };
  },
  "thread/resume": (params) => ({ thread: threadRecord(requireThread(params)) }),
  "thread/name/set": (params) => {
    requireThread(params).name = params.name;
    return {};
  },
  "thread/fork": (params) => {
    const source = requireThread(params);
    const thread = { ...source, id: nextId("fixture-thread"), forkedFromId: source.id, turns: [], name: null };
    threads.set(thread.id, thread);
    return { thread: threadRecord(thread) };
  },
  "thread/section/move": () => ({}),
  "thread/archive": (params) => {
    requireThread(params).archived = true;
    return {};
  },
  "thread/unarchive": (params) => {
    requireThread(params).archived = false;
    return {};
  },
  "turn/start": (params, id) => {
    const thread = requireThread(params);
    const turn = { id: nextId("fixture-turn"), status: "inProgress", items: [] };
    thread.turns.push(turn);
    thread.preview = thread.preview || params.input.find((item) => item.type === "text")?.text?.slice(0, 4_000) || "";
    thread.updatedAt = now();
    thread.status = { type: "active" };
    queueMicrotask(() => {
      send({ method: "turn/started", params: { threadId: thread.id, turn } });
      send({
        id: `fixture-request-${turn.id}`,
        method: "item/commandExecution/requestApproval",
        params: { threadId: thread.id, turnId: turn.id, itemId: nextId("fixture-item"), command: ["echo", "fixture"], cwd: thread.cwd, reason: "fixture approval" },
      });
    });
    return { turn };
  },
  "turn/steer": (params) => {
    requireThread(params);
    return { turnId: params.expectedTurnId };
  },
  "turn/interrupt": (params) => {
    const thread = requireThread(params);
    const turn = thread.turns.find((item) => item.id === params.turnId);
    if (turn) turn.status = "interrupted";
    thread.status = { type: "idle" };
    queueMicrotask(() => send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn, status: "interrupted" } } }));
    return {};
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
    record({ kind: "response", id: message.id, result: message.result ?? null, error: message.error ?? null });
    return;
  }
  record({ kind: "request", id: message.id ?? null, method: message.method, params: message.params ?? null });
  const handler = handlers[message.method];
  if (!handler) {
    send({ id: message.id, error: { code: -32601, message: `Invalid request: unknown variant \`${message.method}\`` } });
    return;
  }
  try {
    send({ id: message.id, result: handler(message.params, message.id) });
  } catch (error) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});

process.stdin.on("end", () => process.exit(0));
