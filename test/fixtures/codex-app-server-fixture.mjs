#!/usr/bin/env node

// Minimal stand-in for `codex app-server --listen stdio://`.
//
// It speaks the JSON-RPC line protocol that packages/codex-adapter/client.mjs
// expects, keeps Threads, ThreadSections and Turns in memory for one process,
// and appends every inbound message to the file named by CODEX_FIXTURE_LOG so
// a test can prove which upstream methods the production shell actually
// dispatched.
//
// CODEX_FIXTURE_SEED may carry JSON `{ sections: [{ id, name }], threads: [{
// id, name, preview, cwd, sectionId, archived }] }` so a test can stage Chats
// in several folders and ThreadSections of every import-eligibility shape
// before the shell boots.
//
// Restart proofs use four more knobs, all off by default:
//   CODEX_FIXTURE_STATE=<path>   persist sections, Threads and Turns to that
//                                file on every mutation and load them on
//                                start, the way the real app-server replays
//                                rollouts: a reloaded Thread is `notLoaded`
//                                until resumed, and a Turn that was in
//                                progress when the process died keeps its
//                                persisted status instead of being repaired;
//   CODEX_FIXTURE_PIDFILE=<path> append this process id so a test can kill
//                                the app-server from outside;
//   CODEX_FIXTURE_MAX_STARTS=<n> with a pidfile, refuse to start once n
//                                processes have been recorded (exit 3), so a
//                                test can prove restart exhaustion;
//   CODEX_FIXTURE_AUTH=unavailable   make account/read fail;
//   CODEX_FIXTURE_DROP_METHODS=a,b   answer those methods with -32601.

import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// Only the app-server transport is impersonated; any other subcommand (for
// example generate-json-schema) exits loudly so a caller never mistakes this
// fixture for the pinned binary.
if (process.argv[2] !== "app-server" || !process.argv.includes("--listen")) {
  process.stderr.write(`codex-app-server-fixture: unsupported invocation ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}

const version = process.env.CODEX_FIXTURE_VERSION ?? "0.147.0";
const logPath = process.env.CODEX_FIXTURE_LOG ?? null;
const statePath = process.env.CODEX_FIXTURE_STATE ?? null;
const pidPath = process.env.CODEX_FIXTURE_PIDFILE ?? null;
const authUnavailable = process.env.CODEX_FIXTURE_AUTH === "unavailable";
const droppedMethods = new Set((process.env.CODEX_FIXTURE_DROP_METHODS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
const PINNED_SECTION = Object.freeze({ id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Pinned" });
const threads = new Map();
const sections = new Map();
let counter = 0;
const nextId = (prefix) => `${prefix}-${++counter}`;
const now = () => new Date().toISOString();

if (pidPath) {
  const maxStarts = Number(process.env.CODEX_FIXTURE_MAX_STARTS ?? 0);
  const started = existsSync(pidPath) ? readFileSync(pidPath, "utf8").split("\n").filter(Boolean).length : 0;
  if (maxStarts > 0 && started >= maxStarts) {
    process.stderr.write(`codex-app-server-fixture: refusing start ${started + 1} (CODEX_FIXTURE_MAX_STARTS=${maxStarts})\n`);
    process.exit(3);
  }
  appendFileSync(pidPath, `${process.pid}\n`);
}

// The real app-server compares folders by their resolved path, so a symlinked
// /tmp and its /private/tmp target name the same folder here too.
function realFolder(path) {
  if (typeof path !== "string" || !path) return null;
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function sectionRecord(section) {
  return { id: section.id, name: section.name };
}

function requireSection(sectionId) {
  if (sectionId === PINNED_SECTION.id) return PINNED_SECTION;
  const section = sections.get(sectionId);
  if (!section) throw Object.assign(new Error(`Unknown section ${sectionId}`), { code: -32602 });
  return section;
}

function seed() {
  const raw = process.env.CODEX_FIXTURE_SEED;
  if (!raw) return;
  const plan = JSON.parse(raw);
  for (const section of plan.sections ?? []) sections.set(section.id, { id: section.id, name: section.name });
  for (const entry of plan.threads ?? []) {
    const thread = {
      id: entry.id ?? nextId("seed-thread"),
      name: entry.name ?? null,
      preview: entry.preview ?? "",
      cwd: entry.cwd,
      createdAt: entry.createdAt ?? now(),
      updatedAt: entry.updatedAt ?? now(),
      status: { type: "idle" },
      forkedFromId: null,
      section: entry.sectionId ? sectionRecord(requireSection(entry.sectionId)) : null,
      archived: Boolean(entry.archived),
      turns: [],
      policy: { approvalPolicy: null, sandbox: null },
    };
    threads.set(thread.id, thread);
  }
}

function loadState() {
  if (!statePath || !existsSync(statePath)) return false;
  const raw = readFileSync(statePath, "utf8");
  if (!raw.trim()) return false;
  const state = JSON.parse(raw);
  counter = state.counter ?? 0;
  for (const section of state.sections ?? []) sections.set(section.id, { id: section.id, name: section.name });
  for (const thread of state.threads ?? []) {
    // A Thread read back from disk is not loaded into this process until it
    // is resumed; its Turns are exactly what was persisted, orphaned
    // in-progress status included.
    threads.set(thread.id, { ...thread, status: { type: "notLoaded" } });
  }
  return true;
}

function persist() {
  if (!statePath) return;
  const state = { counter, sections: [...sections.values()], threads: [...threads.values()] };
  writeFileSync(`${statePath}.next`, `${JSON.stringify(state)}\n`);
  renameSync(`${statePath}.next`, statePath);
}

if (!loadState()) {
  seed();
  persist();
}

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
  const folders = params?.cwd === undefined || params?.cwd === null
    ? null
    : new Set((Array.isArray(params.cwd) ? params.cwd : [params.cwd]).map(realFolder));
  return [...threads.values()]
    .filter((thread) => thread.archived === Boolean(params?.archived))
    .filter((thread) => params?.sectionId === undefined || (thread.section?.id ?? null) === params.sectionId)
    .filter((thread) => folders === null || folders.has(realFolder(thread.cwd)))
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
  "account/read": () => {
    if (authUnavailable) throw Object.assign(new Error("account status unavailable (fixture)"), { code: -32603 });
    return { account: { type: "chatgpt", email: "fixture@example.com", planType: "pro" }, requiresOpenaiAuth: true };
  },
  "threadSection/list": () => ({ data: [...sections.values()].map(sectionRecord), nextCursor: null }),
  "threadSection/create": (params) => {
    if (typeof params?.name !== "string" || !params.name.trim()) throw Object.assign(new Error("name required"), { code: -32602 });
    const section = { id: nextId("fixture-section"), name: params.name.trim() };
    sections.set(section.id, section);
    return { section: sectionRecord(section) };
  },
  "threadSection/update": (params) => {
    const section = requireSection(params?.sectionId);
    if (section === PINNED_SECTION) throw Object.assign(new Error("Pinned cannot be renamed"), { code: -32602 });
    section.name = params.name;
    for (const thread of threads.values()) if (thread.section?.id === section.id) thread.section = sectionRecord(section);
    return { section: sectionRecord(section) };
  },
  "threadSection/delete": (params) => {
    const section = requireSection(params?.sectionId);
    if (section === PINNED_SECTION) throw Object.assign(new Error("Pinned cannot be deleted"), { code: -32602 });
    // Deleting a section atomically returns its members to unsectioned Recents.
    for (const thread of threads.values()) if (thread.section?.id === section.id) thread.section = null;
    sections.delete(section.id);
    return {};
  },
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
  "thread/resume": (params) => {
    const thread = requireThread(params);
    if (thread.status?.type === "notLoaded") thread.status = { type: "idle" };
    return { thread: threadRecord(thread) };
  },
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
  "thread/section/move": (params) => {
    const thread = requireThread(params);
    thread.section = params?.sectionId === null || params?.sectionId === undefined ? null : sectionRecord(requireSection(params.sectionId));
    return {};
  },
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
    // Like the real app-server, the Turn input is persisted as this Turn's
    // userMessage item, so thread/read replays the exact bytes a client sent.
    const turn = { id: nextId("fixture-turn"), status: "inProgress", items: [{ type: "userMessage", id: nextId("fixture-item"), content: params.input }] };
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
    const thread = requireThread(params);
    const turn = thread.turns.find((item) => item.id === params.expectedTurnId);
    if (!turn) throw Object.assign(new Error(`Unknown turn ${params.expectedTurnId}`), { code: -32602 });
    turn.items.push({ type: "userMessage", id: nextId("fixture-item"), content: params.input });
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

const MUTATING_METHODS = new Set([
  "threadSection/create", "threadSection/update", "threadSection/delete",
  "thread/start", "thread/resume", "thread/name/set", "thread/fork", "thread/section/move", "thread/archive", "thread/unarchive",
  "turn/start", "turn/steer", "turn/interrupt",
]);

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
  const handler = droppedMethods.has(message.method) ? null : handlers[message.method];
  if (!handler) {
    send({ id: message.id, error: { code: -32601, message: `Invalid request: unknown variant \`${message.method}\`` } });
    return;
  }
  try {
    const result = handler(message.params, message.id);
    if (MUTATING_METHODS.has(message.method)) persist();
    send({ id: message.id, result });
  } catch (error) {
    send({ id: message.id, error: { code: error.code ?? -32603, message: error.message } });
  }
});

process.stdin.on("end", () => process.exit(0));
