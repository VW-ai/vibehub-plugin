import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeTaskLink,
  encodeTaskLink,
  taskLinkProjectionDefinition,
} from "../packages/dsh-adapter/linkage.mjs";
import { buildDshBundle } from "../scripts/build-dsh-bundle.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("Task linkage round-trips one stable Workspace and Ticket identity", () => {
  const source = {
    version: 1,
    workspace: "/work/vibehub",
    ticketId: "ticket-build-task-harness-vertical-slice",
    commit: "a".repeat(40),
  };
  assert.deepEqual(decodeTaskLink(encodeTaskLink(source)), source);
  assert.throws(() => decodeTaskLink("not-json"), /base64url JSON/u);
  assert.throws(() => encodeTaskLink({ ...source, ticketId: "BAD ID" }), /canonical Ticket ID/u);
});

test("registered command lifecycle folds only a successful VibeHub Task link", () => {
  const definition = taskLinkProjectionDefinition();
  const encoded = encodeTaskLink({
    version: 1,
    workspace: "/work/vibehub",
    ticketId: "ticket-one",
    commit: null,
  });
  let state = definition.init();
  state = definition.apply(state, {
    type: "command/run",
    data: { commandId: "cmd-1", name: "vibehub-task", args: ` ${encoded}` },
  });
  assert.equal(definition.view(state), null);
  state = definition.apply(state, {
    type: "command/done",
    data: { commandId: "cmd-1", kind: "success" },
  });
  assert.deepEqual(definition.schema.parse(definition.view(state)), {
    version: 1,
    workspace: "/work/vibehub",
    ticketId: "ticket-one",
    commit: null,
    runId: "cmd-1",
  });

  const before = state;
  state = definition.apply(state, {
    type: "command/run",
    data: { commandId: "cmd-2", name: "vibehub-task", args: " invalid" },
  });
  assert.equal(state, before);
});

test("production Bundle is additive and routes exact host handoff into native Chat", () => {
  const manifest = JSON.parse(read("packages/dsh-bundle/package.json"));
  const patch = read("packages/dsh-bundle/cordis.patch.yml");
  const bundleEntry = read("packages/dsh-bundle/index.js");
  const host = read("packages/dsh-adapter/host.js");
  const client = read("packages/dsh-adapter/client.js");

  assert.equal(manifest.exports["./client"], "./adapter/client.js");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh.client.platform, "web");
  assert.equal(bundleEntry.trim(), 'export { apply, inject, name } from "./adapter/host.js";');
  assert.match(patch, /id: vibehub-skill-filesystem/u);
  assert.match(patch, /name: '@deepseek-ai\/dsh-skill-filesystem'/u);
  assert.match(patch, /includeDefaultRoots: false/u);
  assert.match(patch, /customSkillDirs/u);
  assert.match(patch, /createRequire\(baseUrl\)\.resolve\('@vibehub\/dsh-vibehub\/package\.json'\)/u);
  assert.match(host, /name: "vibehub-task"/u);
  assert.match(host, /recordInput: true/u);
  assert.match(host, /sessionProjections\.register\(taskLinkProjectionDefinition\(\)\)/u);
  assert.match(client, /name: "conversation\.view"/u);
  assert.match(client, /id: "vibehub-tasks"/u);
  assert.match(client, /name: "shell\.overlay"/u);
  assert.match(client, /id: "vibehub-task-workbench"/u);
  assert.match(client, /ctx\.workspaces\.create\(\{ path: repoRoot \}\)/u);
  assert.match(client, /ctx\.workspaces\.connectWorkspace\(workspace\.workspaceId\)/u);
  assert.match(client, /ctx\.sessions\.open\(sessionId\)/u);
  assert.match(client, /session\.command\(`\/vibehub-task/u);
  assert.match(client, /session\.prompt/u);
  assert.match(client, /JSON\.stringify\(payload, null, 2\)/u);
  assert.match(client, /trustedSource: "dsh-session-summary"/u);
  assert.match(client, /expiresAt:/u);
  assert.match(client, /pendingInteraction \?\? null/u);
  assert.doesNotMatch(client, /pendingInteraction\?\.kind/u);
  assert.match(client, /type: "vibehub-refresh"/u);
  assert.doesNotMatch(patch, /- id: skill-filesystem\n|ui-layout|ui-conversation|agent-team/u);
  assert.doesNotMatch(host, /vibehub\/run|localStorage|sqlite/u);
  assert.doesNotMatch(bundleEntry, /ctx\.|@deepseek-ai\/dsh-/u);
});

test("built DSH Bundle vendors the exact current VibeHub runtime and Skills", () => {
  const temp = mkdtempSync(join(tmpdir(), "vibehub-dsh-bundle-"));
  const artifact = join(temp, "bundle");
  try {
    buildDshBundle({ artifactRoot: artifact });
    for (const path of [
      "adapter/linkage.mjs",
      "adapter/client.js",
      "adapter/host.js",
      "cordis.patch.yml",
      "index.js",
      "vendor/skills/scripts/vh-ui.mjs",
      "vendor/skills/vibehub-ticket-run/SKILL.md",
      "vendor/skills/vibehub-ticket-review/assets/app.js",
    ]) assert.equal(existsSync(join(artifact, path)), true, path);
    const manifest = JSON.parse(readFileSync(join(artifact, "package.json"), "utf8"));
    assert.equal(manifest.private, false);
    assert.equal(
      readFileSync(join(artifact, "vendor/skills/scripts/vh-ui.mjs"), "utf8"),
      read("skills/scripts/vh-ui.mjs"),
    );
    buildDshBundle({ artifactRoot: artifact, clean: true });
    assert.equal(JSON.parse(readFileSync(join(artifact, "package.json"), "utf8")).private, false);
    assert.throws(
      () => buildDshBundle({ artifactRoot: temp, clean: true }),
      /refusing to clean unrecognized artifact output/u,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("keyless installed-profile fixture drives the real Skill and Evidence boundaries", () => {
  const replay = JSON.parse(read("test/fixtures/dsh-vibehub-run/replay.override.json"));
  const evidence = JSON.parse(read("test/fixtures/dsh-vibehub-run/evidence.json"));
  assert.equal(replay.length, 3);
  assert.deepEqual(
    replay.slice(0, 2).map((entry) => entry.chunks.find((chunk) => chunk.type === "block-end")?.block?.name),
    ["skill", "bash"],
  );
  assert.match(JSON.stringify(replay[0]), /vibehub-ticket-run/u);
  assert.match(JSON.stringify(replay[1]), /ticket evidence --repo \. --input/u);
  assert.equal(evidence.ticket_id, "ticket-build-task-harness-vertical-slice");
  assert.deepEqual(evidence.acceptance_ids, ["one-real-task-completes-the-execution-evidence-loop"]);
  assert.equal(evidence.origin, "agent");
  const fixturePlugin = read("test/fixtures/dsh-vibehub-run/llm-plugin/index.js");
  assert.match(fixturePlugin, /if \(options\.purpose\)/u);
  assert.match(fixturePlugin, /ctx\.on\("llm\/stream"/u);
});
