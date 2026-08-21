import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startCodexTask } from "../packages/codex-adapter/handoff.mjs";
import { projectCodexRuntime } from "../packages/codex-adapter/client.mjs";
import {
  codexThreadLinkProjectionDefinition,
  decodeCodexThreadLink,
  encodeCodexThreadLink,
} from "../packages/codex-adapter/linkage.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("Codex adapter pins exact runtime and protocol identities", () => {
  const lock = JSON.parse(read("packages/codex-adapter/upstream-lock.json"));
  assert.deepEqual(
    { version: lock.codex.version, tag: lock.codex.releaseTag, commit: lock.codex.commit },
    { version: "0.147.0", tag: "rust-v0.147.0", commit: "be6e8eac029b183056b7e4402879f15d2c85f61b" },
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
