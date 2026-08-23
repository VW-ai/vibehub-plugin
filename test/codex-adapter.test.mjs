import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startCodexTask } from "../packages/codex-adapter/handoff.mjs";
import { CodexAppServerClient, projectCodexRuntime } from "../packages/codex-adapter/client.mjs";
import { STOP_CONDITION_IDS, evaluateStopConditions, firstViolation, observedRuntimeVersion } from "../packages/codex-adapter/stop-conditions.mjs";
import {
  codexThreadLinkProjectionDefinition,
  decodeCodexThreadLink,
  encodeCodexThreadLink,
} from "../packages/codex-adapter/linkage.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const fixtureAppServer = fileURLToPath(new URL("fixtures/codex-app-server-fixture.mjs", import.meta.url));

test("Codex adapter pins exact runtime and protocol identities", () => {
  const lock = JSON.parse(read("packages/codex-adapter/upstream-lock.json"));
  assert.deepEqual(
    { version: lock.codex.version, tag: lock.codex.releaseTag, commit: lock.codex.commit },
    { version: "0.149.0", tag: "rust-v0.149.0", commit: "758ef40f50c1a458425c7cfbf1eb12cbc07af0b0" },
  );
  assert.equal(lock.dsh.commit, "141eb6fef83422698aef7a981029e843e8161534");
  assert.deepEqual(lock.dsh.requiredHostServices, [
    "commands.register",
    "sessionProjections.register",
    "webServer.register",
    "effect",
  ]);
  assert.equal(lock.transport.credentialsPersistedByVibeHub, false);
  assert.deepEqual(lock.audio.stableTurnInputs, ["audio", "localAudio"]);
  assert.equal(lock.audio.requiresExperimentalApi, true);
});

test("runtime projection never turns replay or closeout into false live presence", () => {
  const started = [{ method: "turn/started", params: { turn: { id: "turn-1" } } }];
  assert.deepEqual(projectCodexRuntime({ nextAction: "EXECUTE", notifications: started, now: 10 }), {
    phase: "RUNNING", substate: null, live: true, observedAt: 10,
  });
  assert.deepEqual(projectCodexRuntime({ nextAction: "CLOSE_OUT", notifications: started, now: 10 }), {
    phase: "RUNNING", substate: "VERIFYING", live: false, observedAt: null,
  });
  assert.deepEqual(projectCodexRuntime({ nextAction: "REPLAN", notifications: started, now: 10 }), {
    phase: "DRAFT", live: false, observedAt: null,
  });
  assert.deepEqual(projectCodexRuntime({ nextAction: "DONE", notifications: started, now: 10 }), {
    phase: "DONE", live: false, observedAt: null,
  });
  assert.deepEqual(projectCodexRuntime({ nextAction: "EXECUTE", notifications: [
    ...started,
    { method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } },
  ], now: 20 }), { phase: "READY", live: false, observedAt: null });
});

test("Task to Codex Thread identity survives DSH command replay without inventing liveness", () => {
  const link = {
    version: 1,
    workspace: "/work/vibehub",
    ticketId: "ticket-spike-codex-app-server-dsh-adapter",
    codexThreadId: "019c1234-codex-thread",
  };
  const encoded = encodeCodexThreadLink(link);
  assert.deepEqual(decodeCodexThreadLink(encoded), link);
  const definition = codexThreadLinkProjectionDefinition();
  const events = [
    {
      type: "command/run",
      data: { commandId: "command-1", name: "vibehub-codex-thread", args: encoded },
    },
    { type: "command/done", data: { commandId: "command-1", kind: "success" } },
  ];
  const replay = () => definition.view(events.reduce(definition.apply, definition.init()));
  assert.deepEqual(replay(), replay());
  assert.deepEqual(definition.schema.parse(replay()), { ...link, commandId: "command-1" });
  assert.equal(Object.hasOwn(replay(), "live"), false);
  assert.equal(Object.hasOwn(replay(), "observedAt"), false);
});

test("canonical host handoff enters one Codex Turn without browser re-derivation", async () => {
  const calls = [];
  const client = {
    async request(method, params) {
      calls.push({ method, params });
      if (method === "thread/start") return { thread: { id: "thread-exact" } };
      if (method === "turn/start") return { turn: { id: "turn-exact" } };
      throw new Error(`unexpected method ${method}`);
    },
  };
  const payload = {
    kind: "vibehub_ticket_handoff",
    ticketId: "ticket-spike-codex-app-server-dsh-adapter",
    acceptance: [{ acceptance_id: "exact", criterion: "Exact payload" }],
  };
  const result = await startCodexTask({ client, payload, cwd: "/work/vibehub" });
  assert.equal(result.threadId, "thread-exact");
  assert.deepEqual(calls.map((call) => call.method), ["thread/start", "turn/start"]);
  assert.equal(calls[1].params.input.length, 1);
  assert.equal(calls[1].params.input[0].text, JSON.stringify(payload, null, 2));
  assert.deepEqual(JSON.parse(calls[1].params.input[0].text), payload);
  assert.equal(calls[0].params.approvalPolicy, "on-request");
  assert.equal(calls[0].params.sandbox, "workspace-write");
});

test("adapter source keeps credentials and a second task lifecycle out of scope", () => {
  const source = read("packages/codex-adapter/client.mjs");
  assert.match(source, /accountStatus/u);
  assert.match(source, /planType/u);
  assert.doesNotMatch(source, /account\.email|auth\.json|sqlite|localStorage|agentTeams/u);
  assert.match(source, /turn\/started/u);
  assert.match(source, /turn\/completed/u);
});

test("disposable DSH spike bundle owns one redacted read-only adapter health route", () => {
  const index = read("spikes/codex-app-server/dsh-bundle/index.js");
  const patch = read("spikes/codex-app-server/dsh-bundle/cordis.patch.yml");
  assert.match(index, /new CodexAppServerClient/u);
  assert.match(index, /accountStatus/u);
  assert.match(index, /vibehub-codex-thread/u);
  assert.match(index, /vibehub-codex-start/u);
  assert.match(index, /buildTicketHandoff/u);
  assert.match(index, /sessionProjections\.register\(codexThreadLinkProjectionDefinition\(\)\)/u);
  assert.match(index, /ctx\.commands\.register/u);
  assert.match(index, /ctx\.webServer\.register/u);
  assert.match(index, /ctx\.effect/u);
  assert.match(index, /repositoryWrites: false/u);
  assert.match(index, /request\.method !== "GET"/u);
  assert.doesNotMatch(index, /email|auth\.json|turn\/start/u);
  assert.match(patch, /@vibehub\/dsh-codex-adapter-spike/u);

  const temp = mkdtempSync(join(tmpdir(), "vibehub-codex-dsh-spike-"));
  try {
    const output = join(temp, "bundle");
    execFileSync(process.execPath, ["spikes/codex-app-server/build-dsh-spike.mjs", output], {
      cwd: new URL("../", import.meta.url),
    });
    for (const file of ["index.js", "cordis.patch.yml", "package.json", "adapter/client.mjs", "adapter/handoff.mjs", "adapter/linkage.mjs"]) {
      assert.equal(existsSync(join(output, file)), true, file);
    }
    assert.equal(JSON.parse(readFileSync(join(output, "package.json"), "utf8")).private, false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

// Every pinned stop condition, evaluated from observations only: the table
// names the observation that proves, breaks, or leaves each one unverified.
test("stop conditions resolve every pinned id from runtime observations and never from assumptions", () => {
  const lock = JSON.parse(read("packages/codex-adapter/upstream-lock.json"));
  assert.deepEqual([...STOP_CONDITION_IDS], lock.stopConditions);
  const initialized = { userAgent: `codex/${lock.codex.version} (Mac OS 26.0; arm64) vibehub (VibeHub; 0.0.0)` };
  assert.equal(observedRuntimeVersion(initialized), lock.codex.version);
  assert.equal(observedRuntimeVersion({ userAgent: "garbage" }), null);
  const account = { authenticated: true, accountType: "chatgpt", planType: "pro", requiresOpenaiAuth: true };
  const statuses = (report) => Object.fromEntries(report.conditions.map((entry) => [entry.id, entry.status]));

  // Boot with the pinned version, a readable account and no schema probe.
  const boot = evaluateStopConditions({ initialized, account, carrierIds: ["codex"] });
  assert.deepEqual(statuses(boot), {
    "generated-protocol-hash-changed": "unverified",
    "required-request-or-event-missing": "unverified",
    "managed-auth-status-unavailable": "pass",
    "thread-restart-recovery-unavailable": "unverified",
    "approval-cannot-round-trip-without-hidden-state": "structural",
    "audio-input-removed": "unverified",
    "dsh-profile-cannot-own-one-idempotent-app-server-process": "not-applicable",
    "same-user-action-routes-through-two-agent-loops": "structural",
  });
  assert.equal(boot.ok, true);
  assert.equal(firstViolation(boot), null);
  assert.match(boot.conditions.find((entry) => entry.id === "generated-protocol-hash-changed").detail, /was not re-hashed against this binary/);
  assert.match(boot.conditions.find((entry) => entry.id === "thread-restart-recovery-unavailable").detail, /No app-server restart has been observed/);

  // A full schema probe against the pinned binary proves the schema-bound ids.
  const provenProbe = {
    schemaSha256: lock.codex.protocolSchemaSha256,
    checks: [
      ...lock.requiredRequests.map((method) => ({ kind: "request", method, proven: true })),
      ...lock.requiredServerRequests.map((method) => ({ kind: "server-request", method, proven: true })),
      ...lock.requiredNotifications.map((method) => ({ kind: "notification", method, proven: true })),
      ...lock.audio.stableTurnInputs.map((method) => ({ kind: "audio-input", method, proven: true })),
    ],
  };
  const proven = evaluateStopConditions({ initialized, account, schemaProbe: provenProbe, carrierIds: ["codex"], recovery: { generation: 2, recoveredThreadIds: ["t1", "t2"], missingThreadIds: [], recoveredTaskLinks: [{ ticketId: "ticket-a", threadId: "t2" }], lostTaskLinks: [] } });
  assert.deepEqual(Object.entries(statuses(proven)).filter(([, status]) => status === "pass").map(([id]) => id), [
    "generated-protocol-hash-changed",
    "required-request-or-event-missing",
    "managed-auth-status-unavailable",
    "thread-restart-recovery-unavailable",
    "audio-input-removed",
  ]);
  assert.match(proven.conditions.find((entry) => entry.id === "thread-restart-recovery-unavailable").detail, /2 known Thread identities and 1 Task link resolved from Codex again/);

  // Each violation names its own observation.
  const violations = [
    [{ initialized: { userAgent: "codex/0.146.0 (x)" }, account }, "generated-protocol-hash-changed", /0\.146\.0 is running but the lock pins 0\.149\.0/],
    [{ initialized, account, schemaProbe: { ...provenProbe, schemaSha256: "0".repeat(64) } }, "generated-protocol-hash-changed", /hashes to 000000000000…, not the pinned/],
    [{ initialized, account, missingMethods: ["turn/steer", "not/pinned"] }, "required-request-or-event-missing", /rejected pinned request turn\/steer as unknown \(-32601\)/],
    [{ initialized, account, schemaProbe: { ...provenProbe, checks: provenProbe.checks.map((check) => check.method === "thread/fork" ? { ...check, proven: false } : check) } }, "required-request-or-event-missing", /omits request thread\/fork/],
    [{ initialized, account: null, accountError: "account status unavailable (fixture)" }, "managed-auth-status-unavailable", /account\/read did not answer: account status unavailable/],
    [{ initialized, account, recovery: { generation: 2, recoveredThreadIds: [], missingThreadIds: ["t1"], recoveredTaskLinks: [], lostTaskLinks: [{ ticketId: "ticket-a", threadId: "t2" }] } }, "thread-restart-recovery-unavailable", /Thread t1 did not come back; Task link ticket-a→t2 lost/],
    [{ initialized, account, recovery: { error: "spawn ENOENT", attempts: 3 } }, "thread-restart-recovery-unavailable", /could not be restarted after 3 attempts: spawn ENOENT/],
    [{ initialized, account, staleRequestIds: ["req-1"] }, "approval-cannot-round-trip-without-hidden-state", /req-1 from an earlier process generation is still pending/],
    [{ initialized, account, schemaProbe: { ...provenProbe, checks: provenProbe.checks.map((check) => check.method === "localAudio" ? { ...check, proven: false } : check) } }, "audio-input-removed", /no longer carries Turn input localAudio/],
    [{ initialized, account, dshProfile: { ownsSingleProcess: false } }, "dsh-profile-cannot-own-one-idempotent-app-server-process", /cannot own one idempotent app-server process/],
    [{ initialized, account, carrierIds: ["codex", "dsh"] }, "same-user-action-routes-through-two-agent-loops", /More than one harness carrier is selected: codex, dsh/],
  ];
  for (const [input, id, detail] of violations) {
    const report = evaluateStopConditions({ carrierIds: ["codex"], ...input });
    const violation = firstViolation(report);
    assert.equal(violation?.id, id, `${id}: ${JSON.stringify(report.violated)}`);
    assert.match(violation.detail, detail);
    assert.equal(report.ok, false);
    assert.deepEqual(report.violated, [id]);
  }
  // A -32601 for a method the lock never pinned is not a violation.
  assert.equal(evaluateStopConditions({ initialized, account, missingMethods: ["thread/realtime/start"], carrierIds: ["codex"] }).ok, true);
  for (const report of [boot, proven]) {
    assert.deepEqual(report.conditions.map((entry) => entry.id), lock.stopConditions, "conditions keep the lock order");
    assert.ok(report.conditions.every((entry) => typeof entry.detail === "string" && entry.detail.length > 20));
  }
});

// The client counts process generations: after the app-server dies, nothing
// from the dead generation answers for the next one.
test("app-server client restarts into a new process generation without carrying replies, notifications or waits across", async (context) => {
  const client = new CodexAppServerClient({ command: fixtureAppServer, cwd: fileURLToPath(root), timeoutMs: 5_000, env: { ...process.env, CODEX_FIXTURE_VERSION: "0.149.0" } });
  context.after(() => client.stop());
  const exits = [];
  const missing = [];
  client.on("exit", (value) => exits.push(value));
  client.on("methodMissing", (value) => missing.push(value));
  const first = await client.start();
  assert.equal(client.generation, 1);
  assert.equal(client.alive, true);
  assert.match(first.userAgent, /0\.149\.0/);
  assert.equal(await client.start(), first, "start() is idempotent while the process is alive");
  const thread = await client.request("thread/start", { cwd: fileURLToPath(root) });
  await client.request("turn/start", { threadId: thread.thread.id, input: [{ type: "text", text: "hello" }] });
  await client.waitForNotification("turn/started", (params) => params.threadId === thread.thread.id);
  assert.equal(client.notifications.length, 1);
  await assert.rejects(client.request("thread/realtime/start", {}), (error) => error.rpcError?.code === -32601 && error.method === "thread/realtime/start");
  assert.deepEqual(missing.map((entry) => [entry.method, entry.generation]), [["thread/realtime/start", 1]]);

  // Kill the process under an open request and an open wait: both settle with
  // the exit, and the exit names the generation that died.
  const orphanRequest = client.request("thread/list", { archived: false, cursor: null, cwd: fileURLToPath(root), limit: 40, sourceKinds: ["appServer"], searchTerm: null, sortDirection: "desc", sortKey: "updated_at" });
  const orphanWait = client.waitForNotification("turn/completed");
  const pid = client.child.pid;
  process.kill(pid, "SIGKILL");
  await assert.rejects(orphanRequest, /codex app-server exited \(null, SIGKILL\)/);
  await assert.rejects(orphanWait, /codex app-server exited/);
  assert.deepEqual(exits.map((entry) => [entry.generation, entry.signal, entry.requested]), [[1, "SIGKILL", false]]);
  assert.equal(client.child, null);
  assert.equal(client.alive, false);
  assert.throws(() => client.request("thread/list", {}), /not running/);

  const second = await client.start();
  assert.equal(client.generation, 2);
  assert.notEqual(client.child.pid, pid);
  assert.match(second.userAgent, /0\.149\.0/);
  assert.deepEqual(client.notifications, [], "notifications of the dead generation are gone");
  assert.equal(client.pending.size, 0);
  await assert.rejects(client.waitForNotification("turn/started", () => true, { timeoutMs: 60 }), /timed out/, "a pre-restart notification never satisfies a new wait");
  const restarted = await client.restart();
  assert.equal(client.generation, 3);
  assert.match(restarted.userAgent, /0\.149\.0/);
  assert.deepEqual(exits.map((entry) => [entry.generation, entry.requested]), [[1, false], [2, true]]);
  await client.stop();
  assert.equal(client.child, null);
  assert.deepEqual(exits.map((entry) => [entry.generation, entry.requested]), [[1, false], [2, true], [3, true]]);
});
