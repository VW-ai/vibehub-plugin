// Host-side proofs for the Codex daily-use parity gaps: the pinned seams, the
// truthful model catalog, per-Thread settings, the host-owned follow-up
// queue, compaction, file and skill discovery, text_elements validation and
// the transient notification preference. Every proof runs the production
// host over the fixture app-server in a temporary repository; the lock probe
// alone touches the installed Codex binary, read-only.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { probeCodexSchema } from "../packages/codex-adapter/probe-schema.mjs";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const fixtureAppServer = fileURLToPath(new URL("fixtures/codex-app-server-fixture.mjs", import.meta.url));

const DAILY_USE_REQUESTS = ["model/list", "thread/compact/start", "fuzzyFileSearch", "skills/list", "thread/name/set", "turn/start", "turn/steer", "turn/interrupt"];
const DAILY_USE_NOTIFICATIONS = ["thread/settings/updated", "thread/tokenUsage/updated", "thread/name/updated", "thread/compacted"];

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

// A small Git repository with a few files for fuzzyFileSearch to find. It
// carries no .vibehub scaffold: ordinary Chat needs none.
async function temporaryRepository(context) {
  const folder = await mkdtemp(join(tmpdir(), "vibehub-parity-host-"));
  context.after(() => rm(folder, { recursive: true, force: true }));
  await writeFile(join(folder, "README.md"), "# parity fixture\n");
  await mkdir(join(folder, "src"), { recursive: true });
  await writeFile(join(folder, "src", "app.js"), "export const app = true;\n");
  await mkdir(join(folder, "docs"), { recursive: true });
  await writeFile(join(folder, "docs", "guide.md"), "# guide\n");
  git(folder, ["init", "-q", "-b", "main"]);
  git(folder, ["config", "user.email", "fixture@example.com"]);
  git(folder, ["config", "user.name", "Fixture"]);
  git(folder, ["add", "."]);
  git(folder, ["commit", "-q", "-m", "fixture"]);
  return { folder, realFolder: realpathSync.native(folder) };
}

async function launchShell(context, { repo, env = {} }) {
  const args = ["scripts/vh-codex-first-shell.mjs", "--repo", repo, "--port", "0", "--json", "--codex", fixtureAppServer];
  const child = spawn(process.execPath, args, { cwd: new URL(".", root), stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CODEX_FIXTURE_VERSION: "0.149.0", ...env } });
  context.after(() => child.kill("SIGTERM"));
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const startup = await Promise.race([
    once(child.stdout, "data").then(([chunk]) => ({ type: "ready", text: String(chunk).trim() })),
    once(child.stderr, "data").then(([chunk]) => ({ type: "error", text: String(chunk).trim() })),
    once(child, "exit").then(([code]) => ({ type: "exit", text: `exit ${code}` })),
  ]);
  clearTimeout(timer);
  if (startup.type !== "ready" && /EPERM|Operation not permitted/.test(startup.text)) {
    context.skip("loopback sockets are unavailable in this sandbox");
    return null;
  }
  assert.equal(startup.type, "ready", startup.text);
  const envelope = JSON.parse(startup.text);
  const url = new URL(envelope.url);
  const token = url.hash.slice(1);
  url.hash = "";
  const api = async (path, options = {}) => {
    const response = await fetch(new URL(path, url), { ...options, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers ?? {}) } });
    return { status: response.status, body: await response.json() };
  };
  const action = (payload) => api("api/action", { method: "POST", body: JSON.stringify(payload) });
  const stop = async () => {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    return exit;
  };
  return { child, envelope, url, api, action, stop };
}

async function appServerCalls(logPath) {
  return (await readFile(logPath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function pollEventsUntil(api, predicate, { timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let window = null;
  while (Date.now() < deadline) {
    window = (await api("api/events?after=0")).body.data;
    if (predicate(window)) return window;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`event window never satisfied the predicate; kinds: ${window?.events.map((event) => `${event.kind}${event.kind === "notification" ? `:${event.value.method}` : ""}`).join(",")}`);
}

const pendingFor = (window, turnId) => window.pendingRequests.find((request) => request.params?.turnId === turnId);

async function acceptApproval(api, action, turnId) {
  const window = await pollEventsUntil(api, (entry) => pendingFor(entry, turnId));
  const resolved = await action({ action: "resolveRequest", requestId: pendingFor(window, turnId).id, decision: "accept" });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  return pollEventsUntil(api, (entry) => entry.events.some((event) => event.kind === "notification" && event.value.method === "turn/completed" && event.value.params.turn.id === turnId));
}

test("the lock pins every daily-use seam once and the installed 0.149.0 binary proves them", async (context) => {
  const lock = JSON.parse(await source("packages/codex-adapter/upstream-lock.json"));
  const census = JSON.parse(await source("docs/proposals/codex-chat-conformance/protocol-event-census.json"));
  assert.equal(new Set(lock.requiredRequests).size, lock.requiredRequests.length, "no pinned request is listed twice");
  for (const method of DAILY_USE_REQUESTS) assert.ok(lock.requiredRequests.includes(method), method);
  for (const method of DAILY_USE_NOTIFICATIONS) {
    assert.ok(lock.requiredNotifications.includes(method), method);
    assert.ok(census.notifications[method]?.startsWith("consumed"), `${method} is classified as consumed`);
    assert.ok(census.consumed[method], `${method} names how it is consumed`);
  }
  assert.deepEqual(lock.stableTurnInputs, ["text", "image", "localImage", "audio", "localAudio", "skill", "mention"]);
  assert.deepEqual(lock.audio.stableTurnInputs, ["audio", "localAudio"]);
  assert.ok(lock.capabilityItems.includes("contextCompaction"));
  assert.match(lock.dailyUseSeams["thread/compacted"], /schema presence only/u);
  assert.match(lock.dailyUseSeams["thread/settings/updated"], /changed settings overrides/u);
  assert.match(lock.dailyUseSeams.followUpQueue, /host-owned transient/u);

  let installed;
  try {
    installed = execFileSync("codex", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    context.skip("no codex binary on PATH; the schema probe needs the pinned 0.149.0 binary");
    return;
  }
  if (!installed.includes(lock.codex.version)) {
    context.skip(`installed ${installed} is not the pinned ${lock.codex.version}; the schema probe only proves the pinned binary`);
    return;
  }
  const probe = probeCodexSchema();
  assert.equal(probe.ok, true, JSON.stringify(probe.checks.filter((check) => !check.proven)));
  assert.equal(probe.schemaSha256, lock.codex.protocolSchemaSha256);
  const proven = (kind, method) => probe.checks.find((check) => check.kind === kind && check.method === method)?.proven;
  for (const method of DAILY_USE_REQUESTS) assert.equal(proven("request", method), true, method);
  for (const method of DAILY_USE_NOTIFICATIONS) assert.equal(proven("notification", method), true, method);
  for (const type of ["skill", "mention", "text"]) assert.equal(proven("turn-input", type), true, type);
  assert.equal(proven("capability-item", "contextCompaction"), true);
});

test("listModels offers only what model/list returned, hidden models dropped, with the picker fields exact", async (context) => {
  const { folder } = await temporaryRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-parity-models-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "calls.jsonl");
  const shell = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_LOG: logPath } });
  if (!shell) return;
  const listed = await shell.action({ action: "listModels" });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const { models } = listed.body.data;
  assert.deepEqual(models.map((model) => model.id), ["fixture-default", "fixture-text"], "the hidden fixture model is filtered out");
  assert.deepEqual(Object.keys(models[0]), ["id", "model", "displayName", "description", "isDefault", "defaultReasoningEffort", "supportedReasoningEfforts", "inputModalities"]);
  assert.deepEqual(models[0], {
    id: "fixture-default",
    model: "fixture-default",
    displayName: "Fixture Default",
    description: "Default fixture model that accepts text and images.",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast answers." },
      { reasoningEffort: "medium", description: "Balanced." },
      { reasoningEffort: "high", description: "Thorough." },
    ],
    inputModalities: ["text", "image"],
  });
  assert.deepEqual([models[1].isDefault, models[1].inputModalities, models[1].supportedReasoningEfforts.map((option) => option.reasoningEffort)], [false, ["text"], ["medium"]]);
  const calls = await appServerCalls(logPath);
  assert.deepEqual(calls.filter((call) => call.method === "model/list").map((call) => call.params), [{ cursor: null, includeHidden: false }], "one model/list without hidden models");
  assert.deepEqual(await shell.stop(), [0, null]);
});

test("Thread settings are null until the runtime reported them, then follow thread/start, thread/resume and thread/settings/updated", async (context) => {
  const { folder, realFolder } = await temporaryRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-parity-settings-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "calls.jsonl");
  const seed = { threads: [{ id: "seed-history", name: "History chat", preview: "earlier", cwd: folder }] };
  const shell = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_LOG: logPath, CODEX_FIXTURE_SEED: JSON.stringify(seed) } });
  if (!shell) return;
  const { api, action } = shell;
  const bootstrap = (await api("api/bootstrap")).body.data;
  const history = bootstrap.threads.find((thread) => thread.id === "seed-history");
  assert.equal(history.settings, null, "a listed Thread the runtime never started or resumed has no settings");
  assert.equal((await action({ action: "readThread", threadId: "seed-history" })).body.data.settings, null);

  const created = (await action({ action: "newThread" })).body.data.thread;
  assert.deepEqual(created.settings, {
    model: "fixture-default",
    effort: "medium",
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false, excludeSlashTmp: false, excludeTmpdirEnvVar: false, writableRoots: [] },
    source: "thread/start",
    observedAt: created.settings.observedAt,
  }, "the thread/start response is the first settings source");
  assert.match(created.settings.observedAt, /^\d{4}-\d{2}-\d{2}T/u);

  // A history Thread is resumed before its first Turn; the thread/resume
  // response reports its settings.
  const resumedTurn = await action({ action: "startTurn", threadId: "seed-history", input: [{ type: "text", text: "hello again" }] });
  assert.equal(resumedTurn.status, 200, JSON.stringify(resumedTurn.body));
  assert.equal(resumedTurn.body.data.settings.source, "thread/resume");
  assert.equal(resumedTurn.body.data.settings.model, "fixture-default");
  assert.equal((await action({ action: "readThread", threadId: "seed-history" })).body.data.settings.source, "thread/resume");

  // A Turn that carries overrides sends the exact turn/start keys; the
  // runtime's thread/settings/updated then becomes the settings source.
  const overridden = await action({ action: "startTurn", threadId: created.id, input: [{ type: "text", text: "with overrides" }], settings: { model: "fixture-text", effort: "high" } });
  assert.equal(overridden.status, 200, JSON.stringify(overridden.body));
  await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "notification" && event.value.method === "thread/settings/updated" && event.value.params.threadId === created.id));
  const updated = (await action({ action: "readThread", threadId: created.id })).body.data.settings;
  assert.deepEqual([updated.model, updated.effort, updated.approvalPolicy, updated.sandboxPolicy.type, updated.source], ["fixture-text", "high", "on-request", "workspaceWrite", "thread/settings/updated"]);
  await action({ action: "interruptTurn", threadId: created.id, turnId: overridden.body.data.turn.id });
  await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "notification" && event.value.method === "turn/completed" && event.value.params.turn.id === overridden.body.data.turn.id));
  const posture = await action({ action: "startTurn", threadId: created.id, input: [{ type: "text", text: "full access" }], approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  assert.equal(posture.status, 200, JSON.stringify(posture.body));
  await pollEventsUntil(api, (window) => window.events.filter((event) => event.kind === "notification" && event.value.method === "thread/settings/updated" && event.value.params.threadId === created.id).length >= 2);
  const full = (await action({ action: "readThread", threadId: created.id })).body.data.settings;
  assert.deepEqual([full.model, full.effort, full.approvalPolicy, full.sandboxPolicy], ["fixture-text", "high", "never", { type: "dangerFullAccess" }]);

  // Invalid overrides never reach the runtime.
  for (const settings of [{ approvalPolicy: "granular" }, { sandboxPolicy: { type: "rootful" } }, { sandboxPolicy: { type: "readOnly", writableRoots: [] } }, { model: "" }, { effort: 3 }]) {
    const refused = await action({ action: "startTurn", threadId: created.id, input: [{ type: "text", text: "x" }], settings });
    assert.equal(refused.status, 400, JSON.stringify(settings));
    assert.match(refused.body.error.message, /settings\./u);
  }

  const calls = await appServerCalls(logPath);
  const starts = calls.filter((call) => call.method === "turn/start");
  assert.deepEqual(starts.map((call) => Object.keys(call.params).sort()), [["input", "threadId"], ["effort", "input", "model", "threadId"], ["approvalPolicy", "input", "sandboxPolicy", "threadId"]]);
  assert.deepEqual([starts[1].params.model, starts[1].params.effort, starts[2].params.approvalPolicy, starts[2].params.sandboxPolicy], ["fixture-text", "high", "never", { type: "dangerFullAccess" }]);
  assert.deepEqual(calls.filter((call) => call.method === "thread/resume").map((call) => call.params), [{ threadId: "seed-history" }]);
  assert.equal(calls.find((call) => call.method === "thread/start").params.cwd, realFolder);
  assert.deepEqual(await shell.stop(), [0, null]);
});

test("queued follow-ups become their own turn/start after turn/completed, pause on interrupt until resume, and steer stays exact", async (context) => {
  const { folder } = await temporaryRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-parity-queue-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "calls.jsonl");
  const statePath = join(temp, "codex-state.json");
  const env = { CODEX_FIXTURE_LOG: logPath, CODEX_FIXTURE_STATE: statePath, CODEX_FIXTURE_COMPLETE_ON_APPROVAL: "1", CODEX_FIXTURE_LOG_NOTIFICATIONS: "1" };
  const shell = await launchShell(context, { repo: folder, env });
  if (!shell) return;
  const { api, action } = shell;
  const text = (value) => [{ type: "text", text: value }];
  const thread = (await action({ action: "newThread" })).body.data.thread;
  const other = (await action({ action: "newThread" })).body.data.thread;
  const first = (await action({ action: "startTurn", threadId: thread.id, input: text("first") })).body.data.turn;
  await pollEventsUntil(api, (window) => pendingFor(window, first.id));

  // Three follow-ups typed while the first Turn streams: queued, not sent.
  const queued = [];
  for (const label of ["A", "B", "C"]) {
    const response = await action({ action: "queueTurn", threadId: thread.id, input: text(label), ...(label === "B" ? { settings: { effort: "low" } } : {}) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.started, null, "nothing starts while a Turn is live");
    assert.match(response.body.data.queuedId, /^queued-/u);
    queued.push(response.body.data.queuedId);
  }
  const listed = (await action({ action: "listQueue", threadId: thread.id })).body.data.queue;
  assert.deepEqual([listed.threadId, listed.paused, listed.pausedReason, listed.limit, listed.items.map((item) => item.input[0].text), listed.items.map((item) => item.settings)], [thread.id, false, null, 20, ["A", "B", "C"], [null, { effort: "low" }, null]]);
  assert.deepEqual(listed.items.map((item) => item.queuedId), queued);
  assert.deepEqual((await action({ action: "listQueue", threadId: other.id })).body.data.queue.items, [], "queues are per Thread");
  assert.deepEqual((await api("api/bootstrap")).body.data.queues.map((queue) => [queue.threadId, queue.items.length]), [[thread.id, 3]], "bootstrap lists the non-empty queues");
  assert.equal((await appServerCalls(logPath)).filter((call) => call.method === "turn/start").length, 1, "no turn/start was issued for a queued follow-up");

  // The first Turn completes: the head starts as a new turn/start.
  await acceptApproval(api, action, first.id);
  const startedA = await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "queuedStarted"));
  const eventA = startedA.events.find((event) => event.kind === "queuedStarted").value;
  assert.equal(eventA.queuedId, queued[0]);
  assert.notEqual(eventA.turnId, first.id);
  assert.deepEqual((await action({ action: "listQueue", threadId: thread.id })).body.data.queue.items.map((item) => item.input[0].text), ["B", "C"]);
  const changed = startedA.events.filter((event) => event.kind === "queueChanged").map((event) => event.value);
  assert.ok(changed.every((value) => value.threadId === thread.id && Array.isArray(value.queue.items)), "every queueChanged names the Thread and carries the queue");
  assert.deepEqual(changed.at(-1).queue.items.map((item) => item.input[0].text), ["B", "C"]);

  // Interrupting the running follow-up pauses the queue; nothing is sent
  // until an explicit Resume, whatever else happens meanwhile.
  await pollEventsUntil(api, (window) => pendingFor(window, eventA.turnId));
  const interrupted = await action({ action: "interruptTurn", threadId: thread.id, turnId: eventA.turnId });
  assert.equal(interrupted.status, 200, JSON.stringify(interrupted.body));
  assert.deepEqual([interrupted.body.data.queue.paused, interrupted.body.data.queue.pausedReason], [true, "interrupted"]);
  await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "notification" && event.value.method === "turn/completed" && event.value.params.turn.id === eventA.turnId));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal((await appServerCalls(logPath)).filter((call) => call.method === "turn/start").length, 2, "a paused queue sends nothing after turn/completed");
  const paused = (await action({ action: "listQueue", threadId: thread.id })).body.data.queue;
  assert.deepEqual([paused.paused, paused.pausedReason, paused.items.map((item) => item.input[0].text)], [true, "interrupted", ["B", "C"]]);

  // Edit and delete while paused.
  const edited = await action({ action: "updateQueued", threadId: thread.id, queuedId: queued[1], input: text("B edited"), settings: null });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.deepEqual(edited.body.data.queue.items.map((item) => [item.input[0].text, item.settings]), [["B edited", null], ["C", null]]);
  const deleted = await action({ action: "deleteQueued", threadId: thread.id, queuedId: queued[2] });
  assert.deepEqual(deleted.body.data.queue.items.map((item) => item.queuedId), [queued[1]]);
  assert.equal((await action({ action: "deleteQueued", threadId: thread.id, queuedId: queued[2] })).body.error.code, "queued_not_found");
  assert.equal((await action({ action: "updateQueued", threadId: thread.id, queuedId: queued[1], input: [] })).status, 400);

  // Resume on an idle Thread starts the head at once, as its own Turn.
  const resumed = await action({ action: "resumeQueue", threadId: thread.id });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  assert.equal(resumed.body.data.started.queuedId, queued[1]);
  const turnB = resumed.body.data.started.turnId;
  assert.ok(![first.id, eventA.turnId].includes(turnB));
  assert.deepEqual([resumed.body.data.queue.paused, resumed.body.data.queue.items], [false, []]);
  await acceptApproval(api, action, turnB);

  // A queued row can steer the live Turn instead, through turn/steer with
  // the exact expectedTurnId; a wrong id is the runtime's refusal.
  const fourth = (await action({ action: "startTurn", threadId: thread.id, input: text("fourth") })).body.data.turn;
  await pollEventsUntil(api, (window) => pendingFor(window, fourth.id));
  const queuedD = (await action({ action: "queueTurn", threadId: thread.id, input: text("D") })).body.data.queuedId;
  const wrong = await action({ action: "steerQueued", threadId: thread.id, queuedId: queuedD, expectedTurnId: "fixture-turn-none" });
  assert.notEqual(wrong.status, 200);
  assert.equal((await action({ action: "listQueue", threadId: thread.id })).body.data.queue.items.length, 1, "a refused steer keeps the follow-up queued");
  const steered = await action({ action: "steerQueued", threadId: thread.id, queuedId: queuedD, expectedTurnId: fourth.id });
  assert.equal(steered.status, 200, JSON.stringify(steered.body));
  assert.deepEqual([steered.body.data.turnId, steered.body.data.queuedId, steered.body.data.queue.items], [fourth.id, queuedD, []]);
  const plain = await action({ action: "steerTurn", threadId: thread.id, expectedTurnId: fourth.id, input: text("steer plain") });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  await acceptApproval(api, action, fourth.id);

  // The fixture call log: every queued follow-up became its own turn/start
  // with a distinct Turn id, each after the prior turn/completed, nothing
  // between the interrupt and the Resume, and steer named the exact Turn.
  const calls = await appServerCalls(logPath);
  const timeline = calls
    .filter((call) => (call.kind === "request" && call.method === "turn/start") || (call.kind === "notification" && call.method === "turn/completed" && call.params.threadId === thread.id))
    .map((call) => (call.kind === "request" ? `start:${call.params.input[0].text}` : `completed:${call.params.turn.status}`));
  assert.deepEqual(timeline, ["start:first", "completed:completed", "start:A", "completed:interrupted", "start:B edited", "completed:completed", "start:fourth", "completed:completed"]);
  const startedTurnIds = calls.filter((call) => call.kind === "response" && call.result?.turn?.id).map((call) => call.result.turn.id);
  assert.equal(new Set(startedTurnIds).size, startedTurnIds.length, "every Turn id is distinct");
  const queuedStart = calls.find((call) => call.method === "turn/start" && call.params.input[0].text === "A");
  assert.deepEqual(Object.keys(queuedStart.params).sort(), ["input", "threadId"]);
  const steers = calls.filter((call) => call.method === "turn/steer").map((call) => [call.params.expectedTurnId, call.params.input[0].text]);
  assert.deepEqual(steers, [["fixture-turn-none", "D"], [fourth.id, "D"], [fourth.id, "steer plain"]]);
  assert.ok(calls.filter((call) => call.method === "turn/steer").every((call) => /^vibehub-/u.test(call.params.clientUserMessageId)));
  const hostEvents = (await api("api/events?after=0")).body.data.events.filter((event) => ["queueChanged", "queuedStarted", "queuedFailed"].includes(event.kind));
  assert.equal(hostEvents.filter((event) => event.kind === "queuedFailed").length, 0);
  assert.deepEqual(hostEvents.filter((event) => event.kind === "queuedStarted").map((event) => event.value.queuedId), [queued[0], queued[1]]);

  // The queue and the notification preference are host session state: a
  // second host over the same persisted Codex state starts without them.
  const left = (await action({ action: "queueTurn", threadId: thread.id, input: text("left behind"), settings: { model: "fixture-text" } })).body.data;
  assert.equal(left.started.queuedId, left.queuedId, "an idle Thread starts a queued follow-up at once");
  assert.equal((await action({ action: "setNotificationPreference", mode: "always" })).body.data.preferences.notifications.mode, "always");
  await pollEventsUntil(api, (window) => pendingFor(window, left.started.turnId));
  const queuedBehind = (await action({ action: "queueTurn", threadId: thread.id, input: text("stranded") })).body.data;
  assert.equal(queuedBehind.started, null);
  assert.deepEqual(await shell.stop(), [0, null]);
  const second = await launchShell(context, { repo: folder, env });
  if (!second) return;
  const after = (await second.api("api/bootstrap")).body.data;
  assert.deepEqual(after.queues, [], "no queue survives a host restart");
  assert.deepEqual(after.preferences, { notifications: { mode: "unfocused", modes: ["always", "unfocused", "never"], transient: true } });
  assert.deepEqual((await second.action({ action: "listQueue", threadId: thread.id })).body.data.queue.items, []);
  assert.deepEqual(await second.stop(), [0, null]);
});

test("compaction is refused while a Turn is live and renders as a contextCompaction item with usage updates after", async (context) => {
  const { folder } = await temporaryRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-parity-compact-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "calls.jsonl");
  const shell = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_LOG: logPath, CODEX_FIXTURE_COMPLETE_ON_APPROVAL: "1" } });
  if (!shell) return;
  const { api, action } = shell;
  const thread = (await action({ action: "newThread" })).body.data.thread;
  const turn = (await action({ action: "startTurn", threadId: thread.id, input: [{ type: "text", text: "work" }] })).body.data.turn;
  const refused = await action({ action: "compactThread", threadId: thread.id });
  assert.equal(refused.status, 409);
  assert.deepEqual([refused.body.error.code, refused.body.error.turnId], ["turn_live", turn.id]);
  assert.equal((await appServerCalls(logPath)).filter((call) => call.method === "thread/compact/start").length, 0, "a refused compaction never reaches the runtime");

  const completed = await acceptApproval(api, action, turn.id);
  const usage = completed.events.filter((event) => event.kind === "notification" && event.value.method === "thread/tokenUsage/updated").map((event) => event.value.params);
  assert.equal(usage.length, 1);
  assert.deepEqual([usage[0].threadId, usage[0].turnId, usage[0].tokenUsage.modelContextWindow, typeof usage[0].tokenUsage.total.totalTokens], [thread.id, turn.id, 272_000, "number"]);
  const order = completed.events.filter((event) => event.kind === "notification").map((event) => event.value.method);
  assert.ok(order.indexOf("thread/tokenUsage/updated") < order.lastIndexOf("turn/completed"), "usage lands inside the Turn, before its turn/completed");

  const compacting = await action({ action: "compactThread", threadId: thread.id });
  assert.equal(compacting.status, 200, JSON.stringify(compacting.body));
  assert.deepEqual(compacting.body.data, { threadId: thread.id, compacting: true });
  const done = await pollEventsUntil(api, (window) => window.events.some((event) => event.kind === "notification" && event.value.method === "turn/completed" && event.value.params.turn.items?.some((item) => item.type === "contextCompaction")));
  assert.ok(!done.events.some((event) => event.kind === "notification" && event.value.method === "thread/compacted"), "the 0.149.0 v2 path sends no thread/compacted; the item is the signal");
  const replayed = (await action({ action: "readThread", threadId: thread.id })).body.data.thread;
  assert.deepEqual(replayed.turns.at(-1).items.map((item) => item.type), ["contextCompaction"], "the compaction Turn replays its boundary item");
  const later = done.events.filter((event) => event.kind === "notification" && event.value.method === "thread/tokenUsage/updated").map((event) => event.value.params.tokenUsage.total.totalTokens);
  assert.equal(later.length, 2);
  assert.ok(later[1] < later[0], "compaction reduced the reported total");
  const calls = await appServerCalls(logPath);
  assert.deepEqual(calls.filter((call) => call.method === "thread/compact/start").map((call) => call.params), [{ threadId: thread.id }]);
  assert.deepEqual(await shell.stop(), [0, null]);

  // The nullable window variant reaches the browser as null, never a guess.
  const nullable = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_COMPLETE_ON_APPROVAL: "1", CODEX_FIXTURE_CONTEXT_WINDOW: "null" } });
  if (!nullable) return;
  const second = (await nullable.action({ action: "newThread" })).body.data.thread;
  const secondTurn = (await nullable.action({ action: "startTurn", threadId: second.id, input: [{ type: "text", text: "work" }] })).body.data.turn;
  const window = await acceptApproval(nullable.api, nullable.action, secondTurn.id);
  const nullUsage = window.events.find((event) => event.kind === "notification" && event.value.method === "thread/tokenUsage/updated").value.params.tokenUsage;
  assert.equal(nullUsage.modelContextWindow, null);
  assert.deepEqual(await nullable.stop(), [0, null]);
});

test("searchFiles and listSkills discover the bound repository through fuzzyFileSearch and skills/list", async (context) => {
  const { folder, realFolder } = await temporaryRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-parity-discover-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "calls.jsonl");
  const skills = [
    { name: "review-change", path: "/tmp/skills/review-change/SKILL.md", description: "Review the change.", enabled: true, scope: "repo" },
    { name: "disabled-skill", path: "/tmp/skills/disabled/SKILL.md", description: "Off.", enabled: false, scope: "user" },
  ];
  const shell = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_LOG: logPath, CODEX_FIXTURE_SKILLS: JSON.stringify(skills) } });
  if (!shell) return;
  const { action } = shell;
  const empty = await action({ action: "searchFiles", query: "   " });
  assert.deepEqual(empty.body.data, { query: "", root: realFolder, limit: 20, total: 0, files: [] });
  const found = await action({ action: "searchFiles", query: "readme" });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual([found.body.data.query, found.body.data.root, found.body.data.limit], ["readme", realFolder, 20]);
  const [top] = found.body.data.files;
  assert.deepEqual([top.path, top.file_name, top.match_type, top.root, top.absolutePath, typeof top.score, Array.isArray(top.indices)], ["README.md", "README.md", "file", realFolder, join(realFolder, "README.md"), "number", true]);
  const bounded = await action({ action: "searchFiles", query: "d", limit: 2 });
  assert.equal(bounded.body.data.files.length, 2);
  assert.ok(bounded.body.data.total >= 2);
  assert.equal((await action({ action: "searchFiles", query: "x".repeat(257) })).status, 400);
  const listed = await action({ action: "listSkills" });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.data, {
    cwd: realFolder,
    skills: skills.map((skill) => ({ name: skill.name, path: skill.path, description: skill.description, shortDescription: null, enabled: skill.enabled, scope: skill.scope, cwd: realFolder })),
    errors: [],
  });
  const calls = await appServerCalls(logPath);
  const searches = calls.filter((call) => call.method === "fuzzyFileSearch").map((call) => call.params);
  assert.equal(searches.length, 2, "an empty query asks nothing");
  assert.deepEqual(searches.map((params) => [params.query, params.roots]), [["readme", [realFolder]], ["d", [realFolder]]]);
  assert.ok(searches.every((params) => /^vibehub-[0-9a-f-]{36}$/u.test(params.cancellationToken)));
  assert.notEqual(searches[0].cancellationToken, searches[1].cancellationToken, "a fresh cancellation token per request");
  assert.deepEqual(calls.filter((call) => call.method === "skills/list").map((call) => call.params), [{ cwds: [realFolder], forceReload: false }]);
  assert.deepEqual(await shell.stop(), [0, null]);
});

test("mention and skill inputs travel verbatim with text_elements whose byte ranges the host proves with Buffer.byteLength", async (context) => {
  const { folder, realFolder } = await temporaryRepository(context);
  const temp = await mkdtemp(join(tmpdir(), "vibehub-parity-elements-"));
  context.after(() => rm(temp, { recursive: true, force: true }));
  const logPath = join(temp, "calls.jsonl");
  const shell = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_LOG: logPath } });
  if (!shell) return;
  const { action } = shell;
  const thread = (await action({ action: "newThread" })).body.data.thread;
  const mentionPath = join(realFolder, "README.md");
  const skillPath = "/tmp/skills/review-change/SKILL.md";
  const text = "héllo @README.md then $review-change";
  const at = Buffer.byteLength("héllo ", "utf8");
  const dollar = Buffer.byteLength("héllo @README.md then ", "utf8");
  const input = [
    { type: "text", text, text_elements: [{ byteRange: { start: at, end: at + Buffer.byteLength("@README.md") }, placeholder: "@README.md" }, { byteRange: { start: dollar, end: dollar + Buffer.byteLength("$review-change") }, placeholder: "$review-change" }] },
    { type: "mention", name: "README.md", path: mentionPath },
    { type: "skill", name: "review-change", path: skillPath },
  ];
  const started = await action({ action: "startTurn", threadId: thread.id, input });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const replayed = (await action({ action: "readThread", threadId: thread.id })).body.data.thread;
  assert.deepEqual(replayed.turns[0].items[0].content, input, "the persisted user message replays the exact input arrays");
  const calls = await appServerCalls(logPath);
  assert.deepEqual(calls.find((call) => call.method === "turn/start").params.input, input, "the app-server received the exact input arrays");

  const refusals = [
    [[{ type: "text", text, text_elements: [{ byteRange: { start: at, end: at + 9 }, placeholder: "@README.md" }] }], /does not occupy bytes/u],
    [[{ type: "text", text, text_elements: [{ byteRange: { start: 1, end: 2 }, placeholder: null }] }], /cuts through a UTF-8 character/u],
    [[{ type: "text", text, text_elements: [{ byteRange: { start: 0, end: 99 } }] }], /byte span inside the \d+-byte UTF-8 text/u],
    [[{ type: "text", text, text_elements: [{ byteRange: { start: at, end: at + 10 }, placeholder: "@README.md" }, { byteRange: { start: at + 2, end: at + 12 }, placeholder: "EADME.md t" }] }], /must not overlap/u],
    [[{ type: "text", text: "plain" }, { type: "mention", name: "README.md" }], /path must be a non-empty string/u],
    [[{ type: "text", text: "plain" }, { type: "skill", name: "", path: skillPath }], /name must be a non-empty string/u],
    [[{ type: "text", text: "plain" }, { type: "localImage", path: "/tmp/x.png" }], /type must be text, image, audio, skill or mention/u],
    [[{ type: "image", url: "https://example.com/x.png" }], /data: URL/u],
    [Array.from({ length: 17 }, () => ({ type: "text", text: "x" })), /at most 16 items/u],
  ];
  for (const [bad, message] of refusals) {
    const refused = await action({ action: "startTurn", threadId: thread.id, input: bad });
    assert.equal(refused.status, 400, JSON.stringify(bad).slice(0, 120));
    assert.equal(refused.body.error.code, "invalid_request");
    assert.match(refused.body.error.message, message);
  }
  assert.equal((await appServerCalls(logPath)).filter((call) => call.method === "turn/start").length, 1, "no refused input reached the runtime");
  assert.deepEqual(await shell.stop(), [0, null]);
});

test("the notification preference and queue edits are transient host state served without the runtime", async (context) => {
  const { folder } = await temporaryRepository(context);
  const shell = await launchShell(context, { repo: folder, env: { CODEX_FIXTURE_AUTH: "unavailable" } });
  if (!shell) return;
  const { api, action } = shell;
  assert.equal(shell.envelope.runtime.state, "halted", "an unreadable auth status halts reuse at boot");
  assert.equal((await action({ action: "newThread" })).status, 409);
  assert.equal((await action({ action: "listModels" })).status, 409, "catalog reads need the runtime");
  const before = (await api("api/bootstrap")).body.data.preferences;
  assert.deepEqual(before, { notifications: { mode: "unfocused", modes: ["always", "unfocused", "never"], transient: true } });
  assert.equal((await action({ action: "setNotificationPreference", mode: "sometimes" })).status, 400);
  const set = await action({ action: "setNotificationPreference", mode: "never" });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.data.preferences.notifications.mode, "never");
  assert.equal((await api("api/bootstrap")).body.data.preferences.notifications.mode, "never");
  assert.deepEqual((await action({ action: "listQueue", threadId: "any-thread" })).body.data.queue, { threadId: "any-thread", paused: false, pausedReason: null, lastError: null, limit: 20, items: [] });
  assert.equal((await action({ action: "deleteQueued", threadId: "any-thread", queuedId: "queued-none" })).body.error.code, "queued_not_found");
  assert.equal((await action({ action: "queueTurn", threadId: "any-thread", input: [{ type: "text", text: "x" }] })).status, 409, "queueing leads to turn/start, so it needs the runtime");
  assert.equal((await action({ action: "resumeQueue", threadId: "any-thread" })).status, 409);
  assert.deepEqual(await shell.stop(), [0, null]);
});

test("the queue, settings and preference live in host memory only, with no store and no browser persistence", async () => {
  const [host, fixture, client, adapter, shell, router] = await Promise.all([
    source("scripts/vh-codex-first-shell.mjs"),
    source("test/fixtures/codex-app-server-fixture.mjs"),
    source("packages/codex-adapter/client.mjs"),
    source("packages/codex-adapter/harness.mjs"),
    source("packages/harness-core/shell.mjs"),
    source("packages/harness-core/router.mjs"),
  ]);
  assert.doesNotMatch(host + client + adapter + shell + router, /localStorage|sessionStorage|indexedDB|sqlite|better-sqlite|openDatabase|caches\.open|leveldb|levelup|AssociationStore/i);
  assert.doesNotMatch(host, /writeFile|appendFile|createWriteStream|mkdir\(|renameSync|rmSync|unlink/);
  const transient = host.slice(host.indexOf("const queues = new Map();"), host.indexOf("function scheduleRestart"));
  assert.match(transient, /const liveTurns = new Map\(\);/);
  assert.match(transient, /const threadSettings = new Map\(\);/);
  assert.match(transient, /let notificationPreference = "unfocused";/);
  assert.doesNotMatch(transient, /writeDocument|putContext|applyTickets|fs\.|readFile/);
  assert.match(host, /const HOST_STATE_ACTIONS = new Set\(\["listQueue", "updateQueued", "deleteQueued", "setNotificationPreference"\]\);/);
  assert.match(host, /const ADAPTER_FREE_ACTIONS = new Set\(\["readTask", "listTaskTargets", "listRooms", "previewCreateTask", "createTask", "attachTask", "remember"\]\);/);
  assert.match(host, /if \(HOST_STATE_ACTIONS\.has\(payload\.action\)\) return hostStateAction\(payload\);/);
  assert.match(host, /if \(!ADAPTER_FREE_ACTIONS\.has\(payload\.action\)\) requireRuntime\(\);/);
  // Queue semantics pinned in source: dequeue only after a completed Turn,
  // pause on interrupt, failure or runtime exit, a new Turn id per start.
  assert.match(host, /client\.on\("notification:turn\/completed"/);
  assert.match(host, /settleQueueAfterTurn\(params\.threadId, params\.turn\?\.status \?\? "completed"\)/);
  assert.match(host, /pauseQueue\(threadId, status === "interrupted" \? "interrupted" : "turn_failed"\)/);
  assert.match(host, /pauseQueue\(payload\.threadId, "interrupted"\)/);
  assert.match(host, /pauseQueue\(threadId, "runtime_exited"\)/);
  assert.match(host, /appendEvent\("queuedStarted", \{ threadId, queuedId: item\.queuedId, turnId \}\)/);
  assert.match(host, /appendEvent\("queueChanged", \{ threadId, queue: queueProjection\(threadId\) \}\)/);
  assert.match(host, /appendEvent\("queuedFailed", \{ threadId, queuedId: item\.queuedId, error: error\.message \}\)/);
  assert.doesNotMatch(host, /thread\/queue\//, "the experimental server-side queue stays out");
  // Steering stays exact and is never the default for a queued follow-up.
  assert.match(host, /expectedTurnId: payload\.expectedTurnId,\s*clientUserMessageId: `vibehub-\$\{crypto\.randomUUID\(\)\}`,\s*input: item\.input,/);
  // Compaction guards the live Turn; settings come from responses and the
  // runtime's notification; inputs are validated with Buffer.byteLength.
  assert.match(host, /new HostError\(409, "turn_live"/);
  assert.match(host, /client\.on\("result", \(\{ method, result \}\) => \{\s*if \(\(method === "thread\/start" \|\| method === "thread\/resume"\)/);
  assert.match(host, /client\.on\("notification:thread\/settings\/updated"/);
  assert.match(host, /Buffer\.byteLength\(placeholder, "utf8"\) !== range\.end - range\.start \|\| span !== placeholder/);
  assert.doesNotMatch(host.slice(host.indexOf("function validateInput("), host.indexOf("function validateTextElements")), /localImage|localAudio/, "no local path input is produced by the host");
  assert.match(host, /Array\.isArray\(model\.inputModalities\) \? model\.inputModalities : \["text", "image"\]/, "the schema default for inputModalities is the only fallback");
  assert.match(host, /filter\(\(model\) => !model\.hidden\)/);
  // The fixture knobs exist only in the test double.
  for (const knob of ["CODEX_FIXTURE_COMPLETE_ON_APPROVAL", "CODEX_FIXTURE_CONTEXT_WINDOW", "CODEX_FIXTURE_SKILLS", "CODEX_FIXTURE_LOG_NOTIFICATIONS"]) assert.ok(fixture.includes(knob), knob);
  assert.doesNotMatch(host, /CODEX_FIXTURE/);
  assert.match(fixture, /deprecated thread\/compacted notification is not sent by the\s*\/\/\s*0\.149\.0 v2 path/);
});

test("the checked-in daily-use host contract names only actions, events and notifications the host implements", async () => {
  const [host, contractText, lockText] = await Promise.all([
    source("scripts/vh-codex-first-shell.mjs"),
    source("docs/proposals/codex-chat-conformance/daily-use-host-contract.json"),
    source("packages/codex-adapter/upstream-lock.json"),
  ]);
  const contract = JSON.parse(contractText);
  const lock = JSON.parse(lockText);
  for (const name of Object.keys(contract.actions)) assert.match(host, new RegExp(`payload\\.action === "${name}"`, "u"), `${name} is a host action`);
  for (const kind of Object.keys(contract.hostEvents)) assert.match(host, new RegExp(`appendEvent\\("${kind}"`, "u"), `${kind} is a host event`);
  for (const method of Object.keys(contract.forwardedNotifications)) {
    for (const name of method.split(",").map((entry) => entry.trim())) assert.ok(lock.requiredNotifications.includes(name), `${name} is pinned`);
  }
  assert.match(contract.queueRecord.shape, /interrupted\|turn_failed\|runtime_exited\|start_failed/u);
  for (const reason of ["interrupted", "turn_failed", "runtime_exited", "start_failed"]) assert.ok(host.includes(`"${reason}"`), reason);
  assert.match(contract.turnSettings.shape, /Model\.model slug, not Model\.id/u);
  assert.match(contract.inputs.never, /localImage and localAudio are never produced/u);
  assert.equal(contract.bootstrap.preferences.includes("default unfocused"), true);
});
