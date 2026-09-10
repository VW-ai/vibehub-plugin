// Authority Context is golden truth: governed scope, canonical artifacts,
// ordered update rules, validation checks. These tests hold the schema, the
// governing lookup, the change guard, and the Workbench projection to that
// meaning.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { buildUiSnapshot } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { context, room, run, tempRepo, ticket, writeRoom } from "./helpers.mjs";

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function authority(overrides = {}) {
  return context({
    context_id: "authority-system-architecture",
    type: "authority",
    summary: "The architecture graph is the source of truth for service boundaries",
    detail: "docs/architecture.md governs src/services; change it only through its update rules.",
    tags: ["architecture"],
    authority: {
      governs: ["src/services", "docs/architecture.md#overview"],
      canonical: ["docs/architecture.md"],
      update_rules: ["Revise the diagram first.", "Check every affected service contract.", "Record the reason as a change Context."],
      validation: ["Every service in src/services appears in the diagram."],
    },
    ...overrides,
  });
}

function changeRecord(overrides = {}) {
  return context({
    context_id: "change-add-session-service",
    type: "change",
    summary: "Add the session service to the architecture graph",
    detail: "The session service joins the graph as a boundary of its own.",
    tags: ["architecture"],
    evidence: [{ ref: "docs/architecture.md", note: "Diagram gained the session service." }],
    relations: [{ type: "relates_to", target_context_id: "authority-system-architecture" }],
    ...overrides,
  });
}

function fixture(label) {
  const repo = tempRepo(label);
  assert.equal(run(repo, "project", "init").status, 0);
  mkdirSync(join(repo, "docs"), { recursive: true });
  mkdirSync(join(repo, "src", "services", "auth"), { recursive: true });
  writeFileSync(join(repo, "docs", "architecture.md"), "# Architecture\n\n## Overview\n\nauth service\n");
  writeFileSync(join(repo, "src", "services", "auth", "index.js"), "export const auth = true;\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  writeRoom(repo, "product", room("product", { anchors: ["docs", "src/services"] }));
  return repo;
}

test("an authority Context needs a complete authority object and other types refuse one", () => {
  const repo = fixture("authority-schema");
  const written = run(repo, "context", "put", authority(), ["--room", "product"]);
  assert.equal(written.envelope.ok, true, JSON.stringify(written.envelope));
  assert.equal(written.envelope.data.advice, undefined, "canonical inside the room's anchors needs no advice");
  assert.equal(run(repo, "context", "validate").envelope.ok, true);

  const rejected = (document, pattern) => {
    const result = run(repo, "context", "put", document, ["--room", "product"]);
    assert.equal(result.envelope.ok, false);
    assert.match(JSON.stringify(result.envelope.error), pattern, JSON.stringify(result.envelope.error));
  };
  rejected(authority({ context_id: "authority-missing", authority: undefined }), /must carry an authority object/u);
  rejected(context({ context_id: "decision-with-authority", authority: authority().authority }), /only allowed when type equals authority/u);
  rejected(authority({ context_id: "authority-bad-scope", authority: { ...authority().authority, governs: ["../outside"] } }), /repository-relative/u);
  rejected(authority({ context_id: "authority-internal", authority: { ...authority().authority, canonical: [".vibehub/rooms/product/room.yaml"] } }), /not live under \.vibehub/u);
  rejected(authority({ context_id: "authority-versioned", authority: { ...authority().authority, canonical: [`commit:${"a".repeat(40)}:docs/architecture.md`] } }), /current repository path/u);
  rejected(authority({ context_id: "authority-no-rules", authority: { ...authority().authority, update_rules: [] } }), /update_rules.*non-empty/u);
  rejected(authority({ context_id: "authority-approval", authority: { ...authority().authority, approval: "board" } }), /none or human/u);
  rejected(authority({ context_id: "authority-missing-file", authority: { ...authority().authority, canonical: ["docs/missing.md"] } }), /canonical artifact unreadable/u);
});

test("context put advises when golden truth sits outside the owning room's anchors", () => {
  const repo = fixture("authority-advice");
  writeRoom(repo, "product", room("product", { anchors: ["src/services"] }));
  const written = run(repo, "context", "put", authority(), ["--room", "product"]);
  assert.equal(written.envelope.ok, true);
  assert.deepEqual(written.envelope.data.advice.map((item) => [item.kind, item.canonical]), [
    ["canonical_outside_room_anchors", "docs/architecture.md"],
  ]);
});

test("context governing finds the authority covering paths, segment files, and a Ticket's refs", () => {
  const repo = fixture("authority-governing");
  assert.equal(run(repo, "context", "put", authority(), ["--room", "product"]).envelope.ok, true);
  assert.equal(run(repo, "context", "put", authority({
    context_id: "authority-retired",
    state: "superseded",
    relations: [],
  }), ["--room", "product"]).envelope.ok, true);

  const byPath = run(repo, "context", "governing", { paths: ["./src/services//auth/index.js", "README.md"] });
  assert.equal(byPath.envelope.ok, true, JSON.stringify(byPath.envelope));
  assert.deepEqual(byPath.envelope.data.paths, ["README.md", "src/services/auth/index.js"]);
  assert.equal(byPath.envelope.data.count, 1, "superseded authority no longer governs");
  const [found] = byPath.envelope.data.authorities;
  assert.equal(found.context_id, "authority-system-architecture");
  assert.equal(found.room, "product");
  assert.equal(found.path, ".vibehub/rooms/product/authority-system-architecture.yaml");
  assert.equal(found.approval, "none");
  assert.deepEqual(found.matched, [{ scope: "src/services", paths: ["src/services/auth/index.js"] }]);
  assert.deepEqual(found.update_rules, authority().authority.update_rules);

  const bySegmentFile = run(repo, "context", "governing", { paths: ["docs/architecture.md"] });
  assert.deepEqual(bySegmentFile.envelope.data.authorities[0].matched, [
    { scope: "docs/architecture.md#overview", paths: ["docs/architecture.md"] },
  ]);

  const none = run(repo, "context", "governing", { paths: ["README.md"] });
  assert.equal(none.envelope.ok, true);
  assert.deepEqual(none.envelope.data, { paths: ["README.md"], authorities: [], count: 0 });

  const consumer = ticket("ticket-touch-services");
  consumer.context_refs = [{ purpose: "service code", ref: "src/services/auth/index.js" }];
  assert.equal(run(repo, "ticket", "apply", { validation: { independent: false, note: "test" }, tickets: [consumer] }).envelope.ok, true);
  const byTicket = run(repo, "context", "governing", { ticket_id: "ticket-touch-services" });
  assert.equal(byTicket.envelope.data.count, 1);
  assert.deepEqual(byTicket.envelope.data.paths, ["src/services/auth/index.js"]);

  const empty = run(repo, "context", "governing", {});
  assert.equal(empty.envelope.ok, false);
  assert.equal(empty.envelope.error.code, "invalid_input");
  assert.equal(run(repo, "context", "governing", { ticket_id: "missing" }).envelope.error.code, "not_found");
});

test("context guard refuses a canonical change without its change Context and passes with it", () => {
  const repo = fixture("authority-guard");
  assert.equal(run(repo, "context", "put", authority(), ["--room", "product"]).envelope.ok, true);

  const untouched = run(repo, "context", "guard", { paths: ["src/services/auth/index.js"] });
  assert.equal(untouched.envelope.ok, true);
  assert.deepEqual(untouched.envelope.data, {
    origin: "input",
    changed_paths: ["src/services/auth/index.js"],
    authorities: [],
    violations: [],
    passed: true,
  });

  const unrecorded = run(repo, "context", "guard", { paths: ["docs/architecture.md"] });
  assert.equal(unrecorded.envelope.data.passed, false);
  assert.deepEqual(unrecorded.envelope.data.violations, ["authority-system-architecture"]);
  assert.equal(unrecorded.envelope.data.authorities[0].status, "unrecorded");
  assert.deepEqual(unrecorded.envelope.data.authorities[0].changed_canonical, ["docs/architecture.md"]);
  assert.equal(unrecorded.envelope.data.authorities[0].recorded_by, null);

  assert.equal(run(repo, "context", "put", changeRecord(), ["--room", "product"]).envelope.ok, true);
  const recordPath = ".vibehub/rooms/product/change-add-session-service.yaml";
  const staleRecord = run(repo, "context", "guard", { paths: ["docs/architecture.md"] });
  assert.equal(staleRecord.envelope.data.passed, false, "a record outside the change set does not cover this change");
  const recorded = run(repo, "context", "guard", { paths: ["docs/architecture.md", recordPath] });
  assert.equal(recorded.envelope.data.passed, true, JSON.stringify(recorded.envelope.data));
  assert.equal(recorded.envelope.data.authorities[0].status, "recorded");
  assert.equal(recorded.envelope.data.authorities[0].recorded_by, "change-add-session-service");

  assert.equal(run(repo, "context", "put", changeRecord({
    context_id: "change-unrelated",
    evidence: [{ ref: "README.md", note: "cites the wrong file" }],
  }), ["--room", "product"]).envelope.ok, true);
  const wrongCitation = run(repo, "context", "guard", {
    paths: ["docs/architecture.md", ".vibehub/rooms/product/change-unrelated.yaml"],
  });
  assert.equal(wrongCitation.envelope.data.passed, false, "the record must cite the changed canonical artifact");

  assert.equal(run(repo, "context", "guard", { paths: "docs/architecture.md" }).envelope.error.code, "invalid_input");
});

test("context guard derives the changed set from git status and an optional since revision", () => {
  const repo = fixture("authority-guard-git");
  assert.equal(run(repo, "context", "put", authority(), ["--room", "product"]).envelope.ok, true);
  git(repo, "init");
  git(repo, "config", "user.name", "VibeHub Test");
  git(repo, "config", "user.email", "vibehub@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "baseline");
  const base = git(repo, "rev-parse", "HEAD");

  const clean = run(repo, "context", "guard");
  assert.equal(clean.envelope.ok, true, JSON.stringify(clean.envelope));
  assert.deepEqual(clean.envelope.data, { origin: "git", changed_paths: [], authorities: [], violations: [], passed: true });

  writeFileSync(join(repo, "docs", "architecture.md"), "# Architecture\n\n## Overview\n\nauth service\nsession service\n");
  const dirty = run(repo, "context", "guard");
  assert.equal(dirty.envelope.data.passed, false);
  assert.deepEqual(dirty.envelope.data.violations, ["authority-system-architecture"]);

  git(repo, "add", ".");
  git(repo, "commit", "-m", "change golden truth without a record");
  assert.equal(run(repo, "context", "guard").envelope.data.passed, true, "status alone cannot see committed work");
  const since = run(repo, "context", "guard", { since: base });
  assert.equal(since.envelope.data.passed, false, "since sees the committed canonical change");
  // The run helper drops its input JSON inside the repo, so only assert the
  // canonical artifact is in the derived set.
  assert.ok(since.envelope.data.changed_paths.includes("docs/architecture.md"));

  assert.equal(run(repo, "context", "put", changeRecord(), ["--room", "product"]).envelope.ok, true);
  const recorded = run(repo, "context", "guard", { since: base });
  assert.equal(recorded.envelope.data.passed, true, JSON.stringify(recorded.envelope.data));
  assert.equal(recorded.envelope.data.authorities[0].recorded_by, "change-add-session-service");
  assert.equal(run(repo, "context", "guard", { since: "not-a-revision" }).envelope.error.code, "git_error");
});

test("the Rooms projection marks authority Context with its scope and canonical artifacts", () => {
  const repo = fixture("authority-ui");
  assert.equal(run(repo, "context", "put", authority({ authority: { ...authority().authority, approval: "human" } }), ["--room", "product"]).envelope.ok, true);
  assert.equal(run(repo, "context", "put", context(), ["--room", "product"]).envelope.ok, true);
  const rooms = buildUiSnapshot(repo).state.rooms.rooms;
  const product = rooms.find((item) => item.room === "product");
  const marked = product.contexts.find((item) => item.contextId === "authority-system-architecture");
  assert.equal(marked.type, "authority");
  assert.deepEqual(marked.authority, {
    governs: ["src/services", "docs/architecture.md#overview"],
    canonical: ["docs/architecture.md"],
    updateRules: authority().authority.update_rules,
    validation: authority().authority.validation,
    approval: "human",
  });
  const plain = product.contexts.find((item) => item.contextId === "decision-use-tickets");
  assert.equal(plain.authority, undefined);
});


test("authority lookup rejects absolute and escaping paths", () => {
  const repo = fixture("authority-paths");
  for (const operation of ["governing", "guard"]) {
    for (const path of ["/docs/architecture.md", "../docs/architecture.md", "src/../docs/architecture.md", "."]) {
      assert.equal(run(repo, "context", operation, { paths: [path] }).envelope.error.code, "invalid_input");
    }
  }
});

test("guard requires records for every changed canonical artifact", () => {
  const repo = fixture("authority-multiple-artifacts");
  assert.equal(run(repo, "context", "put", authority({ authority: {
    ...authority().authority, canonical: ["docs/architecture.md", "README.md"],
  } }), ["--room", "product"]).envelope.ok, true);
  assert.equal(run(repo, "context", "put", changeRecord(), ["--room", "product"]).envelope.ok, true);
  const paths = ["docs/architecture.md", "README.md", ".vibehub/rooms/product/change-add-session-service.yaml"];
  assert.equal(run(repo, "context", "guard", { paths }).envelope.data.passed, false);
  assert.equal(run(repo, "context", "put", changeRecord({
    context_id: "change-readme", evidence: [{ ref: "README.md", note: "Updated overview" }],
  }), ["--room", "product"]).envelope.ok, true);
  paths.push(".vibehub/rooms/product/change-readme.yaml");
  assert.equal(run(repo, "context", "guard", { paths }).envelope.data.passed, true);
});
