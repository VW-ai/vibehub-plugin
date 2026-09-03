import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { context, room, root, run, tempRepo, ticket, writeRoom } from "./helpers.mjs";

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function trackedSnapshot(repo) {
  return Object.fromEntries(
    git(repo, "ls-files", "-z")
      .split("\0")
      .filter(Boolean)
      .map((path) => [path, readFileSync(join(repo, path), "utf8")]),
  );
}

test("a semantic-only 0.4 step makes no change, then the engine completes the mechanical path", () => {
  const repo = tempRepo("migrate-04-to-05");
  assert.equal(run(repo, "project", "init").status, 0);
  unlinkSync(join(repo, ".vibehub", "version.yaml"));

  // A 0.4-style project: a flat context entry and a ticket referencing it.
  mkdirSync(join(repo, ".vibehub", "context"), { recursive: true });
  writeFileSync(
    join(repo, ".vibehub", "context", "decision-use-tickets.yaml"),
    `${JSON.stringify(context(), null, 2)}\n`,
  );
  const legacyTicket = ticket("feature");
  legacyTicket.schema_version = 1;
  delete legacyTicket.deliveries;
  legacyTicket.context_refs = [
    { ref: ".vibehub/context/decision-use-tickets.yaml", purpose: "Product direction." },
  ];
  writeFileSync(
    join(repo, ".vibehub", "tickets", "feature.yaml"),
    `${JSON.stringify(legacyTicket, null, 2)}\n`,
  );

  const broken = run(repo, "project", "validate");
  assert.notEqual(broken.status, 0);
  assert.equal(broken.envelope.error.code, "format_mismatch");
  assert.equal(
    broken.envelope.error.details.compatibility.detected_format,
    "0.4-unversioned",
  );

  const beforeMechanical = {
    context: readFileSync(join(repo, ".vibehub", "context", "decision-use-tickets.yaml"), "utf8"),
    ticket: readFileSync(join(repo, ".vibehub", "tickets", "feature.yaml"), "utf8"),
  };
  const refused = run(repo, "project", "migrate-mechanical");
  assert.equal(refused.status, 0, refused.stderr);
  assert.equal(refused.envelope.data.status, "semantic_required");
  assert.deepEqual(refused.envelope.data.changed_paths, []);
  assert.equal(refused.envelope.data.pending_semantic_steps[0].step_id, "design-room-tree-and-place-contexts");
  assert.equal(
    readFileSync(join(repo, ".vibehub", "context", "decision-use-tickets.yaml"), "utf8"),
    beforeMechanical.context,
  );
  assert.equal(
    readFileSync(join(repo, ".vibehub", "tickets", "feature.yaml"), "utf8"),
    beforeMechanical.ticket,
  );
  assert.equal(existsSync(join(repo, ".vibehub", "version.yaml")), false);

  // Agent judgment supplies the Room design and placement, including the
  // destination-dependent ref rewrite. The engine owns everything after it.
  writeRoom(repo, "product", room("product"));
  renameSync(
    join(repo, ".vibehub", "context", "decision-use-tickets.yaml"),
    join(repo, ".vibehub", "rooms", "product", "decision-use-tickets.yaml"),
  );
  rmdirSync(join(repo, ".vibehub", "context"));
  const migrated = JSON.parse(readFileSync(join(repo, ".vibehub", "tickets", "feature.yaml"), "utf8"));
  migrated.context_refs[0].ref = ".vibehub/rooms/product/decision-use-tickets.yaml";
  writeFileSync(
    join(repo, ".vibehub", "tickets", "feature.yaml"),
    `${JSON.stringify(migrated, null, 2)}\n`,
  );

  const roomedCompatibility = run(repo, "project", "compatibility");
  assert.equal(roomedCompatibility.status, 0);
  assert.equal(roomedCompatibility.envelope.data.state, "MIGRATION_REQUIRED");
  assert.equal(roomedCompatibility.envelope.data.detected_format, "0.5-unversioned");

  const completed = run(repo, "project", "migrate-mechanical");
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.envelope.data.status, "migrated_with_semantic_pending");
  assert.deepEqual(completed.envelope.data.applied_migrations, [
    "0-5-unversioned-to-format-1",
    "format-1-to-format-2",
    "format-2-to-format-3",
  ]);
  assert.deepEqual(completed.envelope.data.changed_paths, [
    ".vibehub/tickets/feature.yaml",
    ".vibehub/version.yaml",
  ]);
  const pendingTicket = JSON.parse(readFileSync(join(repo, ".vibehub", "tickets", "feature.yaml"), "utf8"));
  assert.equal(pendingTicket.schema_version, 2);
  assert.deepEqual(pendingTicket.deliveries, []);
  assert.ok(pendingTicket.provenance_refs.includes(
    "migration-pending:format-1-to-format-2:classify-delivery-membership",
  ));
  const resumed = run(repo, "project", "migrate-mechanical");
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.envelope.data.status, "current_with_semantic_pending");
  assert.deepEqual(resumed.envelope.data.changed_paths, []);
  assert.equal(resumed.envelope.data.pending_semantic_steps[0].step_id, "classify-delivery-membership");
  assert.match(resumed.envelope.data.pending_semantic_steps[0].purpose, /delivered/u);
  assert.ok(resumed.envelope.data.pending_semantic_steps[0].derives_from.length > 0);
  assert.ok(resumed.envelope.data.pending_semantic_steps[0].forbidden_shortcuts.length > 0);
  assert.ok(resumed.envelope.data.pending_semantic_steps[0].instructions.length > 0);
  assert.ok(completed.envelope.data.pending_semantic_steps.some(
    (step) => step.step_id === "bind-deleted-path-provenance-to-exact-history",
  ));
  const healed = run(repo, "project", "validate");
  assert.equal(healed.status, 0, healed.stdout);
  const queried = run(repo, "context", "query", { query: "development entry" });
  assert.equal(queried.envelope.data.count, 1);
});

test("mechanical migration changes only declared paths in the exact worktree", () => {
  const repo = tempRepo("migrate-one-worktree");
  assert.equal(run(repo, "project", "init").status, 0);
  const legacy = ticket("feature");
  legacy.schema_version = 1;
  delete legacy.deliveries;
  writeFileSync(join(repo, ".vibehub", "tickets", "feature.yaml"), `${JSON.stringify(legacy, null, 2)}\n`);
  writeFileSync(
    join(repo, ".vibehub", "version.yaml"),
    `${JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 1 }, null, 2)}\n`,
  );
  git(repo, "init");
  git(repo, "config", "user.name", "VibeHub Test");
  git(repo, "config", "user.email", "vibehub@example.test");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "format 1 fixture");
  const sibling = `${repo}-sibling`;
  git(repo, "worktree", "add", "-b", "sibling", sibling);

  const siblingBefore = trackedSnapshot(sibling);
  const siblingStatusBefore = git(sibling, "status", "--porcelain=v1", "--untracked-files=all");
  const mainHeadBefore = git(repo, "rev-parse", "HEAD");
  const siblingHeadBefore = git(sibling, "rev-parse", "HEAD");
  const refsBefore = git(repo, "show-ref");
  const commitsBefore = git(repo, "rev-list", "--all", "--count");

  const migrated = run(repo, "project", "migrate-mechanical");
  assert.equal(migrated.status, 0, migrated.stderr);
  assert.deepEqual(migrated.envelope.data.changed_paths, [
    ".vibehub/tickets/feature.yaml",
    ".vibehub/version.yaml",
  ]);
  assert.equal(run(repo, "project", "compatibility").envelope.data.state, "CURRENT");
  assert.equal(run(repo, "project", "validate").status, 0);

  assert.deepEqual(trackedSnapshot(sibling), siblingBefore);
  assert.equal(git(sibling, "status", "--porcelain=v1", "--untracked-files=all"), siblingStatusBefore);
  assert.equal(git(repo, "rev-parse", "HEAD"), mainHeadBefore);
  assert.equal(git(sibling, "rev-parse", "HEAD"), siblingHeadBefore);
  assert.equal(git(repo, "show-ref"), refsBefore);
  assert.equal(git(repo, "rev-list", "--all", "--count"), commitsBefore);
  assert.deepEqual(
    git(repo, "status", "--porcelain=v1").split("\n").filter(Boolean).sort(),
    [" M .vibehub/tickets/feature.yaml", " M .vibehub/version.yaml"],
  );
});

test("a failed post-migration validation restores every original byte", () => {
  const repo = tempRepo("migrate-rollback");
  assert.equal(run(repo, "project", "init").status, 0);
  const legacy = ticket("feature");
  legacy.schema_version = 1;
  delete legacy.deliveries;
  legacy.context_refs = [{ ref: "docs/missing.md", purpose: "Deliberately invalid fixture." }];
  const ticketPath = join(repo, ".vibehub", "tickets", "feature.yaml");
  const versionPath = join(repo, ".vibehub", "version.yaml");
  writeFileSync(ticketPath, `${JSON.stringify(legacy, null, 2)}\n`);
  writeFileSync(
    versionPath,
    `${JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 1 }, null, 2)}\n`,
  );
  const ticketBefore = readFileSync(ticketPath, "utf8");
  const versionBefore = readFileSync(versionPath, "utf8");

  const failed = run(repo, "project", "migrate-mechanical");
  assert.notEqual(failed.status, 0);
  assert.equal(failed.envelope.error.code, "validation_error");
  assert.equal(readFileSync(ticketPath, "utf8"), ticketBefore);
  assert.equal(readFileSync(versionPath, "utf8"), versionBefore);
});

test("format 2 to 3 changes only the marker and leaves current-tree refs for semantic audit", () => {
  const repo = tempRepo("migrate-format-2-to-3");
  assert.equal(run(repo, "project", "init").status, 0);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "current.md"), "# Current source\n");
  const existing = ticket("current-reference");
  existing.context_refs = [{ ref: "docs/current.md", purpose: "Current source." }];
  writeFileSync(
    join(repo, ".vibehub", "tickets", "current-reference.yaml"),
    `${JSON.stringify(existing, null, 2)}\n`,
  );
  writeFileSync(
    join(repo, ".vibehub", "version.yaml"),
    `${JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 2 }, null, 2)}\n`,
  );
  const ticketBefore = readFileSync(join(repo, ".vibehub", "tickets", "current-reference.yaml"), "utf8");

  const migrated = run(repo, "project", "migrate-mechanical");
  assert.equal(migrated.status, 0, migrated.stdout);
  assert.deepEqual(migrated.envelope.data.applied_migrations, ["format-2-to-format-3"]);
  assert.deepEqual(migrated.envelope.data.changed_paths, [".vibehub/version.yaml"]);
  assert.equal(
    readFileSync(join(repo, ".vibehub", "tickets", "current-reference.yaml"), "utf8"),
    ticketBefore,
  );
  assert.equal(JSON.parse(readFileSync(join(repo, ".vibehub", "version.yaml"), "utf8")).format_version, 3);
  assert.equal(migrated.envelope.data.pending_semantic_steps.length, 1);
  assert.equal(
    migrated.envelope.data.pending_semantic_steps[0].step_id,
    "bind-deleted-path-provenance-to-exact-history",
  );
  assert.equal(run(repo, "project", "validate").status, 0);
});

test("the repository format-3 project keeps Ticket schema 2 and audited delivery structure", () => {
  const version = JSON.parse(readFileSync(join(root, ".vibehub", "version.yaml"), "utf8"));
  assert.equal(version.format_version, 3);
  const ticketRoot = join(root, ".vibehub", "tickets");
  const tickets = readdirSync(ticketRoot)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => JSON.parse(readFileSync(join(ticketRoot, name), "utf8")));
  assert.ok(tickets.length >= 50);
  assert.equal(tickets.every((item) => item.schema_version === 2), true);
  assert.equal(tickets.every((item) => Array.isArray(item.deliveries)), true);

  const delivered = tickets.flatMap((item) => item.deliveries
    .filter((entry) => entry.state === "delivered")
    .map((entry) => ({ ticketId: item.ticket_id, ...entry })));
  assert.ok(delivered.length >= 40);
  for (const entry of delivered) {
    const result = spawnSync("git", [
      "-C", root,
      "show", "-s", "--format=%H%x09%cI%x09%s", entry.delivered_commit,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `${entry.ticketId}: ${result.stderr}`);
    const [commit, committedAt, subject] = result.stdout.trim().split("\t");
    assert.equal(commit, entry.delivered_commit, entry.ticketId);
    assert.equal(new Date(committedAt).getTime(), new Date(entry.delivered_at).getTime(), entry.ticketId);
    if (entry.kind === "pull_request") {
      const number = new URL(entry.ref).pathname.split("/").at(-1);
      assert.match(subject, new RegExp(`^Merge pull request #${number} `, "u"), entry.ticketId);
    }
  }
});
