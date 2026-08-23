import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createCodexHarnessAdapter } from "../packages/codex-adapter/harness.mjs";
import { createDshHarnessAdapter } from "../packages/dsh-adapter/harness.mjs";
import { assertCapabilityContract, capabilitySnapshot, harnessCapabilityContract } from "../packages/harness-core/capabilities.mjs";
import { createMemoryAssociationStore } from "../packages/harness-core/association-store.mjs";
import { createFixtureClient } from "../packages/harness-core/fixtures.mjs";
import { probeCodexOnlyRoute } from "../packages/harness-core/probe-codex-only.mjs";
import { probePackageIsolation } from "../packages/harness-core/probe-package-isolation.mjs";
import { createHarnessRouter, UnsupportedHarnessCapabilityError } from "../packages/harness-core/router.mjs";
import { createSharedHarnessShell } from "../packages/harness-core/shell.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("capability contract is complete, pinned, and truthful about different audio support", () => {
  assert.equal(assertCapabilityContract(), true);
  const codex = capabilitySnapshot("codex");
  const dsh = capabilitySnapshot("dsh");
  assert.equal(Object.keys(codex.capabilities).length, 15);
  assert.deepEqual(Object.keys(codex.capabilities), Object.keys(dsh.capabilities));
  // The daily-use seams are native on Codex and truthfully unsupported on
  // DSH until a seam is pinned: no picker, indicator or @ menu is invented.
  for (const id of ["settings", "compaction", "mentions"]) {
    assert.equal(codex.capabilities[id].mode, "native", id);
    assert.equal(dsh.capabilities[id].available, false, id);
    assert.equal(dsh.capabilities[id].mode, "unsupported", id);
  }
  assert.match(codex.capabilities.settings.source, /model\/list/u);
  assert.match(codex.capabilities.settings.source, /thread\/settings\/updated/u);
  assert.match(codex.capabilities.compaction.source, /thread\/compact\/start/u);
  assert.match(codex.capabilities.compaction.source, /contextCompaction/u);
  assert.match(codex.capabilities.mentions.source, /fuzzyFileSearch and skills\/list/u);
  assert.equal(codex.upstream.version, "0.149.0");
  assert.equal(dsh.upstream.version, "0.1.0-rc.8");
  assert.deepEqual(codex.capabilities.audio, {
    available: true,
    mode: "native",
    source: "Turn input audio and localAudio variants",
    fallback: "Keep text input; hide microphone-live, transcript-live and audio-output claims while the pinned experimental thread/realtime probe reports protocol-present-current-ephemeral-thread-unsupported.",
  });
  assert.equal(dsh.capabilities.audio.available, false);
  assert.match(dsh.capabilities.audio.source, /text or image only/u);
});

test("refreshed Codex declarations bind native ThreadSection Projects, hidden realtime, and ordinary audio", () => {
  const codex = capabilitySnapshot("codex");
  assert.deepEqual(codex.capabilities.projects, {
    available: true,
    mode: "native",
    source: "ClientRequest threadSection/list, threadSection/create, threadSection/update, threadSection/delete and thread/section/move; Thread.section is the sole membership authority with built-in Pinned and sectionId-null Recents. 0.149.0 adds an app-server-owned Thread.projectId with project/changed and thread/project/updated notifications but no ClientRequest that assigns it; it is observed, never read as membership",
    fallback: "If fork placement races with Project deletion, the fork stays visible in unsectioned Recents with placement.applied=false; threadSection/delete returns member Threads to Recents. If a later pin makes Thread.projectId assignable, membership stays on Thread.section until a probe proves the new seam; projectId is never merged into it.",
  });
  assert.match(codex.capabilities.projects.fallback, /placement\.applied=false/u);
  assert.match(codex.capabilities.projects.source, /Thread\.projectId[^.]*never read as membership/u);
  assert.equal(Object.hasOwn(harnessCapabilityContract.capabilities, "realtime"), false);
  assert.equal(Object.hasOwn(harnessCapabilityContract.carriers.codex.capabilities, "realtime"), false);
  assert.equal(Object.hasOwn(harnessCapabilityContract.carriers.dsh.capabilities, "realtime"), false);
  assert.equal(codex.capabilities.audio.available, true);
  assert.equal(codex.capabilities.audio.mode, "native");
  assert.match(codex.capabilities.audio.source, /audio and localAudio/u);
  assert.match(codex.capabilities.audio.fallback, /protocol-present-current-ephemeral-thread-unsupported/u);
  assert.equal(capabilitySnapshot("dsh").capabilities.projects.mode, "adapted");
});

test("one router dispatches through exactly one selected harness and never cross-falls back", async () => {
  const calls = [];
  const router = createHarnessRouter({
    adapter: {
      id: "dsh",
      async execute(action) {
        calls.push(action);
        return { harnessId: "dsh", conversationId: "session-1" };
      },
    },
    associations: createMemoryAssociationStore(),
  });
  await router.dispatch("chat.send", { conversationId: "session-1", content: [{ type: "text", text: "hello" }] });
  await assert.rejects(router.dispatch("chat.send", { harnessId: "codex" }), /codex, but dsh is selected/u);
  await assert.rejects(router.dispatch("chat.sendAudio", { conversationId: "session-1" }), UnsupportedHarnessCapabilityError);
  // A per-Turn settings override rides on chat.send and is gated by the
  // settings capability the carrier does not have; the plain send still goes.
  await assert.rejects(router.dispatch("chat.send", { conversationId: "session-1", content: [{ type: "text", text: "hello" }], settings: { model: "x" } }), (error) => error instanceof UnsupportedHarnessCapabilityError && error.capability === "settings");
  await router.dispatch("chat.send", { conversationId: "session-1", content: [{ type: "text", text: "hello" }], settings: {} });
  for (const action of ["chat.listModels", "chat.compact", "chat.searchFiles", "chat.listSkills"]) {
    await assert.rejects(router.dispatch(action, { conversationId: "session-1" }), UnsupportedHarnessCapabilityError);
  }
  assert.deepEqual(calls, ["chat.send", "chat.send"]);
});

test("shared shell exposes one seam per router verb, gates them behind boot, and inherits capability gating", async () => {
  const dispatched = [];
  const recordingAdapter = (id) => ({
    id,
    async execute(action, input) {
      dispatched.push({ action, input });
      return { harnessId: id, conversationId: input.conversationId ?? `${id}-thread-1`, runId: input.runId ?? null };
    },
  });
  const shell = createSharedHarnessShell({ adapter: recordingAdapter("codex"), associations: createMemoryAssociationStore() });
  assert.throws(() => shell.sendChat({ conversationId: "thread-1", content: [] }), /not booted/u);
  assert.throws(() => shell.recoverTask("ticket-shell-seams"), /not booted/u);
  assert.deepEqual(shell.boot(), { carrierId: "codex", capabilities: capabilitySnapshot("codex") });
  const text = [{ type: "text", text: "hello" }];
  const seams = [
    ["newChat", { cwd: "/work" }, "chat.create"],
    ["resumeChat", { conversationId: "thread-1" }, "chat.resume"],
    ["sendChat", { conversationId: "thread-1", content: text }, "chat.send"],
    ["sendChatAttachments", { conversationId: "thread-1", content: [...text, { type: "image", url: "data:image/png;base64,AA==" }] }, "chat.sendAttachments"],
    ["sendChatAudio", { conversationId: "thread-1", content: [{ type: "audio", url: "data:audio/webm;base64,AA==" }] }, "chat.sendAudio"],
    ["forkChat", { conversationId: "thread-1" }, "chat.fork"],
    ["searchChats", { query: "hello" }, "chat.search"],
    ["interruptChat", { conversationId: "thread-1", runId: "turn-1" }, "chat.interrupt"],
    ["listModels", {}, "chat.listModels"],
    ["compactChat", { conversationId: "thread-1" }, "chat.compact"],
    ["searchFiles", { query: "read", roots: ["/work"] }, "chat.searchFiles"],
    ["listSkills", { cwds: ["/work"] }, "chat.listSkills"],
    ["resolveInteraction", { conversationId: "thread-1", requestId: 7, result: { decision: "accept" } }, "interaction.resolveApproval"],
    ["startTask", { cwd: "/work", payload: { kind: "vibehub_ticket_handoff", ticketId: "ticket-shell-seams" } }, "task.start"],
  ];
  for (const [method, input] of seams) await shell[method](input);
  assert.deepEqual(dispatched.map(({ action }) => action), seams.map(([, , action]) => action));
  assert.ok(dispatched.every(({ input }) => input.harnessId === "codex"));
  assert.deepEqual(dispatched[0].input.options, { cwd: "/work" });
  assert.equal((await shell.recoverTask("ticket-shell-seams")).conversationId, "codex-thread-1");
  await shell.close();
  assert.throws(() => shell.newChat(), /not booted/u);

  const dsh = createSharedHarnessShell({ adapter: recordingAdapter("dsh") });
  dsh.boot();
  await assert.rejects(dsh.sendChatAudio({ conversationId: "session-1", content: [] }), UnsupportedHarnessCapabilityError);
  await dsh.sendChatAttachments({ conversationId: "session-1", content: [] });
  await assert.rejects(dsh.listModels(), UnsupportedHarnessCapabilityError);
  await assert.rejects(dsh.compactChat({ conversationId: "session-1" }), UnsupportedHarnessCapabilityError);
  await assert.rejects(dsh.searchFiles({ query: "x", roots: ["/work"] }), UnsupportedHarnessCapabilityError);
  await assert.rejects(dsh.listSkills({ cwds: ["/work"] }), UnsupportedHarnessCapabilityError);
  await dsh.close();
});

test("Codex adapter routes ordinary Chat and exact Task handoff through app-server only", async () => {
  const client = createFixtureClient({ prefix: "codex-test" });
  const associations = createMemoryAssociationStore();
  const router = createHarnessRouter({ adapter: createCodexHarnessAdapter({ client }), associations });
  const chat = await router.dispatch("chat.create", { options: { cwd: "/work" } });
  await router.dispatch("chat.send", { conversationId: chat.conversationId, content: [{ type: "text", text: "hello" }] });
  const payload = { kind: "vibehub_ticket_handoff", ticketId: "ticket-harness-core-contract" };
  const task = await router.dispatch("task.start", { cwd: "/work", payload, origin: { threadId: chat.conversationId } });
  assert.deepEqual(client.calls.map((call) => call.method), ["thread/start", "turn/start", "thread/start", "turn/start"]);
  assert.deepEqual(JSON.parse(client.calls[3].params.input[0].text), payload);
  assert.deepEqual(Object.keys(client.calls[1].params).sort(), ["input", "threadId"], "a send without settings carries no override key");
  // Per-Turn overrides are the exact turn/start keys and nothing is defaulted.
  await router.dispatch("chat.send", { conversationId: chat.conversationId, content: [{ type: "text", text: "again" }], settings: { model: "gpt-5.3-codex", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, ignored: true } });
  assert.deepEqual(client.calls.at(-1).params, { threadId: chat.conversationId, input: [{ type: "text", text: "again" }], model: "gpt-5.3-codex", effort: "high", approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  await router.dispatch("chat.compact", { conversationId: chat.conversationId });
  await router.dispatch("chat.searchFiles", { query: "read", roots: ["/work"], cancellationToken: "token-1" });
  await router.dispatch("chat.listSkills", { cwds: ["/work"] });
  assert.deepEqual(client.calls.slice(-3).map((call) => [call.method, call.params]), [
    ["thread/compact/start", { threadId: chat.conversationId }],
    ["fuzzyFileSearch", { query: "read", roots: ["/work"], cancellationToken: "token-1" }],
    ["skills/list", { cwds: ["/work"], forceReload: false }],
  ]);
  assert.deepEqual(await associations.get(payload.ticketId), {
    ticketId: payload.ticketId,
    harnessId: "codex",
    conversationId: task.conversationId,
    origin: { threadId: chat.conversationId },
  });
});

test("DSH adapter fixture uses native ports and keeps unsupported audio out of the Session", async () => {
  const calls = [];
  const session = {
    async command(line) { calls.push(["command", line]); return { ok: true, value: { matched: true } }; },
    async prompt(content, mode) { calls.push(["prompt", content, mode]); return { ok: true, value: { accepted: true } }; },
    async cancel() { calls.push(["cancel"]); return { ok: true, value: { accepted: true } }; },
  };
  const sessions = {
    binding: () => ({ session }),
    open(id) { calls.push(["open", id]); },
    async create() { return "session-created"; },
    async fork() { return "session-fork"; },
    async search() { return { ok: true, value: { items: [], hasMore: false } }; },
  };
  const workspaces = {
    async create() { return { workspaceId: "workspace-1" }; },
    async connectWorkspace() { return "session-task"; },
  };
  const router = createHarnessRouter({ adapter: createDshHarnessAdapter({ sessions, workspaces }), associations: createMemoryAssociationStore() });
  const payload = { kind: "vibehub_ticket_handoff", ticketId: "ticket-dsh-fixture" };
  const result = await router.dispatch("task.start", { cwd: "/work", commit: "abc", payload });
  assert.equal(result.conversationId, "session-task");
  assert.equal(calls[0][0], "command");
  assert.match(calls[0][1], /^\/vibehub-task /u);
  assert.deepEqual(JSON.parse(calls[1][1][0].text), payload);
  await assert.rejects(router.dispatch("chat.sendAudio", { conversationId: "session-task" }), UnsupportedHarnessCapabilityError);
  assert.equal(calls.length, 2);
});

test("shared packages and each carrier keep upstream imports isolated", async () => {
  const result = await probePackageIsolation();
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.checks.length, 5);
  assert.equal(result.checks.every((check) => check.violations.length === 0), true);
});

test("clean Codex-only route survives restart and removes its bounded association store", async () => {
  const result = await probeCodexOnlyRoute();
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.deepEqual(result.ordinaryChat.requestMethods, ["thread/start", "turn/start"]);
  assert.deepEqual(result.shell, { firstBoot: "codex", restartBoot: "codex" });
  assert.equal(result.taskHandoff.exactHandoff, true);
  assert.equal(result.restart.recovered.harnessId, "codex");
  assert.equal(result.restart.recovered.conversationId, result.taskHandoff.conversationId);
  assert.equal(result.removal.removed, true);
});

test("decision document names ownership, source-only DSH proof, maintenance and downstream boundaries", async () => {
  const document = await read("../docs/HARNESS_NEUTRAL_CORE_CONTRACT.md");
  for (const section of [
    "## Ownership matrix",
    "## Versioned capabilities",
    "## Single-runtime routing",
    "## Clean Codex-only route",
    "## Exact DSH source and package seams",
    "## Package isolation",
    "## Failure, upgrade, and migration policy",
    "## Downstream implementation sequence",
    "## Stop conditions",
  ]) assert.match(document, new RegExp(section.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.match(document, /does not install, boot, or run\s+the future DSH carrier/u);
  assert.match(document, /One continuous Chat may birth zero, one, or many Tasks\s+and then keep/u);
});
