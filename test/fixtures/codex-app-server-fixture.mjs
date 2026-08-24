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
//                                progress when the process died replays as
//                                `interrupted` (observed on Codex 0.149.0 by
//                                packages/codex-adapter/probe-interrupted-turn-live.mjs:
//                                the orphaned Turn is never repaired back to
//                                inProgress, and nothing streamed for it is
//                                persisted beyond the items already durable);
//   CODEX_FIXTURE_PIDFILE=<path> append this process id so a test can kill
//                                the app-server from outside;
//   CODEX_FIXTURE_MAX_STARTS=<n> with a pidfile, refuse to start once n
//                                processes have been recorded (exit 3), so a
//                                test can prove restart exhaustion;
//   CODEX_FIXTURE_AUTH=unavailable   make account/read fail;
//   CODEX_FIXTURE_DROP_METHODS=a,b   answer those methods with -32601.
//
// Daily-use parity knobs, all off by default:
//   CODEX_FIXTURE_COMPLETE_ON_APPROVAL=1  answering a Turn's approval request
//                                finishes that Turn: one agentMessage item,
//                                thread/tokenUsage/updated, then turn/completed
//                                (status completed). Without it the fixture
//                                never finishes a Turn on its own;
//   CODEX_FIXTURE_CONTEXT_WINDOW=<int>|null  the modelContextWindow reported by
//                                thread/tokenUsage/updated (default 272000;
//                                `null` reports the nullable variant);
//   CODEX_FIXTURE_SKILLS=<json>  the SkillMetadata records skills/list returns
//                                for every cwd asked;
//   CODEX_FIXTURE_LOG_NOTIFICATIONS=1  also append every outbound notification
//                                and server request to CODEX_FIXTURE_LOG, so a
//                                proof can order turn/start requests against
//                                the turn/completed notifications between them;
//   CODEX_FIXTURE_LIST_NEW_THREADS=durable|immediate  when thread/list first
//                                carries a brand-new Thread. `durable` (the
//                                default, what the real 0.149.0 server does)
//                                omits it until its first userMessage item is
//                                completed; `immediate` lists it right after
//                                thread/start, the fixture's former behaviour;
//   CODEX_FIXTURE_USER_MESSAGE_DELAY_MS=<int>  the delay between a Turn's
//                                turn/started and its userMessage item/started
//                                and item/completed (default 0, still a later
//                                macrotask; the real server was observed at
//                                about 430 ms), after which the approval
//                                request follows.
//
// What the fixture mirrors from Codex 0.149.0 (rust-v0.149.0 app-server and
// core sources) for the daily-use seams:
//   thread/start and thread/resume answer with the effective model,
//   reasoningEffort, approvalPolicy and sandbox beside the Thread;
//   thread/settings/updated is sent only when a turn/start carries settings
//   overrides that change the Thread's settings, before that Turn's
//   turn/started; thread/tokenUsage/updated lands inside a Turn before its
//   turn/completed and is replayed on thread/resume; thread/compact/start runs
//   a compaction Turn of its own whose contextCompaction item is the canonical
//   signal (the deprecated thread/compacted notification is not sent by the
//   0.149.0 v2 path, so the fixture does not send it either);
//   thread/name/set answers first and then sends thread/name/updated;
//   thread/fork replays the source's terminal Turns into the fork with their
//   ids; lastTurnId is the stable inclusive boundary (later Turns omitted,
//   an in-progress Turn refused), exactly the ThreadForkParams seam pinned in
//   docs/proposals/fork-chat/fork-interaction-contract.json;
//   model/list lists the fixture's hidden model too, unlike the real server
//   (which omits hidden presets unless includeHidden), so the host-side
//   hidden filter is exercised by the proof;
//   a brand-new Thread is absent from thread/list until its first userMessage
//   item is durable (probed on the installed 0.149.0 binary: unlisted at
//   turn/started, listed active about 1.2 s later, listed idle at
//   turn/completed), and thread/status/changed { active } precedes
//   turn/started while { idle } precedes turn/completed, in that order;
//   fuzzyFileSearch walks .git like the real server does (the host drops
//   those entries), node_modules stands in for what .gitignore excludes.

import { appendFileSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

// Only the app-server transport is impersonated; any other subcommand (for
// example generate-json-schema) exits loudly so a caller never mistakes this
// fixture for the pinned binary.
if (process.argv[2] !== "app-server" || !process.argv.includes("--listen")) {
  process.stderr.write(`codex-app-server-fixture: unsupported invocation ${process.argv.slice(2).join(" ")}\n`);
  process.exit(2);
}

const version = process.env.CODEX_FIXTURE_VERSION ?? "0.149.0";
const logPath = process.env.CODEX_FIXTURE_LOG ?? null;
const statePath = process.env.CODEX_FIXTURE_STATE ?? null;
const pidPath = process.env.CODEX_FIXTURE_PIDFILE ?? null;
const authUnavailable = process.env.CODEX_FIXTURE_AUTH === "unavailable";
const droppedMethods = new Set((process.env.CODEX_FIXTURE_DROP_METHODS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
const completeOnApproval = process.env.CODEX_FIXTURE_COMPLETE_ON_APPROVAL === "1";
const logNotifications = process.env.CODEX_FIXTURE_LOG_NOTIFICATIONS === "1";
const listNewThreads = process.env.CODEX_FIXTURE_LIST_NEW_THREADS ?? "durable";
if (!["durable", "immediate"].includes(listNewThreads)) {
  process.stderr.write(`codex-app-server-fixture: CODEX_FIXTURE_LIST_NEW_THREADS must be durable or immediate, not ${listNewThreads}\n`);
  process.exit(2);
}
const userMessageDelayMs = Math.max(0, Number(process.env.CODEX_FIXTURE_USER_MESSAGE_DELAY_MS ?? 0) || 0);
const contextWindow = process.env.CODEX_FIXTURE_CONTEXT_WINDOW === undefined
  ? 272_000
  : process.env.CODEX_FIXTURE_CONTEXT_WINDOW === "null" ? null : Number(process.env.CODEX_FIXTURE_CONTEXT_WINDOW);
const PINNED_SECTION = Object.freeze({ id: "01984de2-8f74-7c91-a3b2-5c5e937cf318", name: "Pinned" });
// The model catalog model/list answers with: one default model that takes
// text and images with three efforts, one text-only model with a single
// effort, and one hidden model a truthful picker must never show.
const MODELS = Object.freeze([
  {
    id: "fixture-default",
    model: "fixture-default",
    displayName: "Fixture Default",
    description: "Default fixture model that accepts text and images.",
    hidden: false,
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast answers." },
      { reasoningEffort: "medium", description: "Balanced." },
      { reasoningEffort: "high", description: "Thorough." },
    ],
    inputModalities: ["text", "image"],
  },
  {
    id: "fixture-text",
    model: "fixture-text",
    displayName: "Fixture Text Only",
    description: "Fixture model that accepts text only.",
    hidden: false,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced." }],
    inputModalities: ["text"],
  },
  {
    id: "fixture-hidden",
    model: "fixture-hidden",
    displayName: "Fixture Hidden",
    description: "Hidden fixture model that no picker may list.",
    hidden: true,
    isDefault: false,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced." }],
    inputModalities: ["text"],
  },
]);
const DEFAULT_SKILLS = Object.freeze([
  { name: "fixture-review", path: "/tmp/codex-fixture/skills/fixture-review/SKILL.md", description: "Review the current change the fixture way.", enabled: true, scope: "repo" },
  { name: "fixture-release", path: "/tmp/codex-fixture/skills/fixture-release/SKILL.md", description: "Cut a fixture release.", enabled: true, scope: "user" },
]);
const skills = process.env.CODEX_FIXTURE_SKILLS ? JSON.parse(process.env.CODEX_FIXTURE_SKILLS) : [...DEFAULT_SKILLS];
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

// thread/start and thread/resume take a SandboxMode string and answer with
// the effective SandboxPolicy object, the way the real server does.
function sandboxPolicyFromMode(mode) {
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false, writableRoots: [] };
}

function defaultSettings(params) {
  return {
    model: params?.model ?? MODELS[0].model,
    effort: MODELS[0].defaultReasoningEffort,
    approvalPolicy: params?.approvalPolicy ?? "on-request",
    sandboxPolicy: sandboxPolicyFromMode(params?.sandbox ?? "workspace-write"),
  };
}

function threadSettingsRecord(thread) {
  return {
    model: thread.settings.model,
    effort: thread.settings.effort,
    approvalPolicy: thread.settings.approvalPolicy,
    sandboxPolicy: thread.settings.sandboxPolicy,
    modelProvider: "fixture",
    cwd: thread.cwd,
    approvalsReviewer: "user",
    collaborationMode: { mode: "default", settings: { model: thread.settings.model, reasoning_effort: thread.settings.effort } },
  };
}

// The effective settings beside the Thread in a thread/start or
// thread/resume response (ThreadStartResponse model, reasoningEffort,
// approvalPolicy, sandbox).
function threadStartResponse(thread) {
  return {
    thread: threadRecord(thread),
    model: thread.settings.model,
    modelProvider: "fixture",
    reasoningEffort: thread.settings.effort,
    approvalPolicy: thread.settings.approvalPolicy,
    sandbox: thread.settings.sandboxPolicy,
    cwd: thread.cwd,
  };
}

function tokenUsage(thread) {
  const usage = thread.tokens ?? { total: 0, last: 0 };
  const breakdown = (total) => ({ totalTokens: total, inputTokens: Math.max(total - 150, 0), cachedInputTokens: 0, outputTokens: Math.min(total, 150), reasoningOutputTokens: 0 });
  return { total: breakdown(usage.total), last: breakdown(usage.last), modelContextWindow: contextWindow };
}

function sendTokenUsage(thread, turnId) {
  send({ method: "thread/tokenUsage/updated", params: { threadId: thread.id, turnId, tokenUsage: tokenUsage(thread) } });
}

// Applies turn/start settings overrides to the Thread and, when they change
// its effective settings, broadcasts thread/settings/updated (the server
// sends it only on an effective change).
function applyTurnSettings(thread, params) {
  const next = {
    model: params?.model ?? thread.settings.model,
    effort: params?.effort === undefined ? thread.settings.effort : params.effort,
    approvalPolicy: params?.approvalPolicy ?? thread.settings.approvalPolicy,
    sandboxPolicy: params?.sandboxPolicy ?? thread.settings.sandboxPolicy,
  };
  const changed = JSON.stringify(next) !== JSON.stringify(thread.settings);
  thread.settings = next;
  if (changed) send({ method: "thread/settings/updated", params: { threadId: thread.id, threadSettings: threadSettingsRecord(thread) } });
}

function completeTurn(thread, turn, items) {
  for (const item of items) {
    send({ method: "item/started", params: { threadId: thread.id, turnId: turn.id, item } });
    turn.items.push(item);
    send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() } });
  }
  sendTokenUsage(thread, turn.id);
  turn.status = "completed";
  setThreadStatus(thread, { type: "idle" });
  thread.updatedAt = now();
  send({ method: "turn/completed", params: { threadId: thread.id, turn } });
  persist();
}

// The Thread's status as the real server reports it: thread/status/changed
// { active } right before turn/started, { idle } right before turn/completed.
function setThreadStatus(thread, status) {
  thread.status = status;
  send({ method: "thread/status/changed", params: { threadId: thread.id, status } });
}

// The Turn's userMessage item becomes durable: item/started and
// item/completed for it, and from now on thread/list carries the Thread.
function persistUserMessage(thread, turn) {
  const item = turn.items.find((entry) => entry.type === "userMessage");
  if (!item) return;
  send({ method: "item/started", params: { threadId: thread.id, turnId: turn.id, item } });
  send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item, completedAtMs: Date.now() } });
  thread.durable = true;
  persist();
}

// A bounded walk of the search roots for fuzzyFileSearch: every file and
// directory path relative to its root. .git is walked, as the real server's
// search does (observed on 0.149.0: it offers .git internals, which the host
// drops); node_modules stands in for what .gitignore keeps out.
function walkRoot(root, limit = 5_000) {
  const entries = [];
  const visit = (folder) => {
    if (entries.length >= limit) return;
    let names;
    try {
      names = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      if (entries.length >= limit) return;
      if (entry.name === "node_modules") continue;
      const absolute = join(folder, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        entries.push({ path, fileName: entry.name, matchType: "directory" });
        visit(absolute);
      } else entries.push({ path, fileName: entry.name, matchType: "file" });
    }
  };
  visit(root);
  return entries;
}

// Case-insensitive subsequence match over the relative path; the score
// rewards a short span and a file-name hit, and indices name the matched
// characters the way the real search reports them.
function fuzzyMatch(query, path, fileName) {
  const haystack = path.toLowerCase();
  const needle = query.toLowerCase();
  const indices = [];
  let position = 0;
  for (const character of needle) {
    const index = haystack.indexOf(character, position);
    if (index === -1) return null;
    indices.push(index);
    position = index + 1;
  }
  const span = indices.length ? indices.at(-1) - indices[0] + 1 : 0;
  const score = Math.max(1, 1_000 - span * 10 - path.length + (fileName.toLowerCase().includes(needle) ? 500 : 0));
  return { score, indices };
}

function fuzzyFileSearch(params) {
  const query = String(params?.query ?? "");
  const files = [];
  for (const root of params?.roots ?? []) {
    const resolvedRoot = realFolder(root) ?? root;
    if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) continue;
    for (const entry of walkRoot(resolvedRoot)) {
      const match = query ? fuzzyMatch(query, entry.path, entry.fileName) : { score: 1, indices: [] };
      if (!match) continue;
      files.push({ root: resolvedRoot, path: entry.path, file_name: entry.fileName, match_type: entry.matchType, score: match.score, indices: match.indices });
    }
  }
  files.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return { files: files.slice(0, 50) };
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
      settings: defaultSettings(null),
      tokens: { total: 0, last: 0 },
      // Seeded history is listed: it stands for Threads with durable Turns.
      durable: true,
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
    // is resumed. A Turn that was still in progress when the previous
    // process died replays as interrupted, as the real app-server reports
    // it; no live status survives a process boundary.
    const turns = (thread.turns ?? []).map((turn) => (turn.status === "inProgress" ? { ...turn, status: "interrupted" } : turn));
    // A reloaded Thread is listed when it was durable before, or when a
    // persisted Turn carries its userMessage (a state file written by hand).
    const durable = thread.durable ?? turns.some((turn) => (turn.items ?? []).some((item) => item.type === "userMessage"));
    threads.set(thread.id, { ...thread, turns, durable, status: { type: "notLoaded" }, settings: thread.settings ?? defaultSettings(null), tokens: thread.tokens ?? { total: 0, last: 0 } });
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
  if (logNotifications && message.method) {
    record(Object.hasOwn(message, "id") ? { kind: "serverRequest", id: message.id, method: message.method, params: message.params ?? null } : { kind: "notification", method: message.method, params: message.params ?? null });
  }
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
    // A brand-new Thread joins the listing once its first userMessage is
    // durable, as on the real server; `immediate` restores the old listing.
    .filter((thread) => listNewThreads === "immediate" || thread.durable === true)
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
  "model/list": () => ({ data: MODELS.map((model) => ({ ...model })), nextCursor: null }),
  "skills/list": (params) => ({ data: (params?.cwds?.length ? params.cwds : [process.cwd()]).map((cwd) => ({ cwd, errors: [], skills: skills.map((skill) => ({ ...skill })) })) }),
  fuzzyFileSearch: (params) => fuzzyFileSearch(params),
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
      settings: defaultSettings(params),
      tokens: { total: 0, last: 0 },
      durable: false,
    };
    threads.set(thread.id, thread);
    return threadStartResponse(thread);
  },
  "thread/read": (params) => {
    const thread = requireThread(params);
    return { thread: { ...threadRecord(thread), turns: params?.includeTurns ? thread.turns : [] } };
  },
  "thread/resume": (params) => {
    const thread = requireThread(params);
    if (thread.status?.type === "notLoaded") thread.status = { type: "idle" };
    if (params?.approvalPolicy || params?.sandbox || params?.model) {
      thread.settings = {
        ...thread.settings,
        model: params.model ?? thread.settings.model,
        approvalPolicy: params.approvalPolicy ?? thread.settings.approvalPolicy,
        sandboxPolicy: params.sandbox ? sandboxPolicyFromMode(params.sandbox) : thread.settings.sandboxPolicy,
      };
    }
    // Persisted usage is replayed to the attaching client after the reply.
    if (thread.tokens?.total > 0) {
      const lastTurn = thread.turns.at(-1);
      queueMicrotask(() => sendTokenUsage(thread, lastTurn?.id ?? "replay"));
    }
    return threadStartResponse(thread);
  },
  "thread/name/set": (params) => {
    const thread = requireThread(params);
    thread.name = params.name;
    queueMicrotask(() => send({ method: "thread/name/updated", params: { threadId: thread.id, threadName: params.name } }));
    return {};
  },
  "thread/compact/start": (params) => {
    const thread = requireThread(params);
    // Compaction is a Turn of its own: turn/started, the contextCompaction
    // item, a reduced usage update, then turn/completed.
    const turn = { id: nextId("fixture-turn"), status: "inProgress", items: [] };
    thread.turns.push(turn);
    thread.status = { type: "active" };
    queueMicrotask(() => {
      setThreadStatus(thread, { type: "active" });
      send({ method: "turn/started", params: { threadId: thread.id, turn: { ...turn, items: [] } } });
      thread.tokens = { total: Math.min(thread.tokens?.total ?? 0, 400), last: 0 };
      completeTurn(thread, turn, [{ type: "contextCompaction", id: nextId("fixture-item") }]);
    });
    return {};
  },
  "thread/fork": (params) => {
    const source = requireThread(params);
    // Mirrors pinned 0.149.0 thread_fork_inner: the fork replays the source's
    // terminal Turns with their ids (thread_fork_at_last_turn_id_keeps_only_
    // terminal_prefix); lastTurnId is an inclusive boundary — Turns after it
    // are omitted — and may not name an in-progress Turn, which the real
    // server refuses as an invalid request.
    const terminal = source.turns.filter((turn) => turn.status !== "inProgress");
    let replayed = terminal;
    if (params?.lastTurnId !== undefined && params?.lastTurnId !== null) {
      const named = source.turns.find((turn) => turn.id === params.lastTurnId);
      if (!named) throw Object.assign(new Error(`Unknown turn ${params.lastTurnId}`), { code: -32602 });
      if (named.status === "inProgress") throw Object.assign(new Error(`turn ${params.lastTurnId} is in progress and cannot be a fork boundary`), { code: -32600 });
      replayed = terminal.slice(0, terminal.indexOf(named) + 1);
    }
    const thread = { ...source, id: nextId("fixture-thread"), forkedFromId: source.id, turns: structuredClone(replayed), name: null, status: { type: "idle" } };
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
    // userMessage item, so thread/read replays the exact bytes a client sent
    // (text_elements, skill and mention items included).
    const turn = { id: nextId("fixture-turn"), status: "inProgress", items: [{ type: "userMessage", id: nextId("fixture-item"), content: params.input }] };
    thread.turns.push(turn);
    thread.preview = thread.preview || params.input.find((item) => item.type === "text")?.text?.slice(0, 4_000) || "";
    thread.updatedAt = now();
    thread.status = { type: "active" };
    const approvalItemId = nextId("fixture-item");
    queueMicrotask(() => {
      applyTurnSettings(thread, params);
      setThreadStatus(thread, { type: "active" });
      send({ method: "turn/started", params: { threadId: thread.id, turn } });
      // The userMessage becomes durable a moment after turn/started (the
      // real server: about 430 ms), and only then does the Thread join
      // thread/list; the model's first request follows it.
      setTimeout(() => {
        // An interrupt inside that window still leaves the userMessage
        // durable (core writes it before the model is asked); only the
        // model's request is gone with the Turn.
        persistUserMessage(thread, turn);
        if (turn.status !== "inProgress") return;
        send({
          id: `fixture-request-${turn.id}`,
          method: "item/commandExecution/requestApproval",
          params: { threadId: thread.id, turnId: turn.id, itemId: approvalItemId, command: ["echo", "fixture"], cwd: thread.cwd, reason: "fixture approval" },
        });
      }, userMessageDelayMs);
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
    queueMicrotask(() => {
      setThreadStatus(thread, { type: "idle" });
      send({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn, status: "interrupted" } } });
    });
    return {};
  },
};

const MUTATING_METHODS = new Set([
  "threadSection/create", "threadSection/update", "threadSection/delete",
  "thread/start", "thread/resume", "thread/name/set", "thread/fork", "thread/section/move", "thread/archive", "thread/unarchive",
  "turn/start", "turn/steer", "turn/interrupt", "thread/compact/start",
]);

// With CODEX_FIXTURE_COMPLETE_ON_APPROVAL the client's answer to a Turn's
// approval request finishes that Turn the way the real model would after the
// command ran: one agentMessage, the Turn's usage, then turn/completed.
function finishApprovedTurn(requestId) {
  const turnId = String(requestId).replace(/^fixture-request-/u, "");
  for (const thread of threads.values()) {
    const turn = thread.turns.find((entry) => entry.id === turnId);
    if (!turn || turn.status !== "inProgress") continue;
    const total = (thread.tokens?.total ?? 0) + 1_200 + 300 * thread.turns.length;
    thread.tokens = { total, last: 1_200 + 300 * thread.turns.length };
    completeTurn(thread, turn, [{ type: "agentMessage", id: nextId("fixture-item"), text: `Fixture answer for ${turn.id}.` }]);
    return;
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (Object.hasOwn(message, "id") && !Object.hasOwn(message, "method")) {
    record({ kind: "response", id: message.id, result: message.result ?? null, error: message.error ?? null });
    if (completeOnApproval && message.result) queueMicrotask(() => finishApprovedTurn(message.id));
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
