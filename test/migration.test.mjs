import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { context, room, root, run, tempRepo, ticket, writeRoom } from "./helpers.mjs";

test("the complete 0.4-to-current migration takes a flat-context repo from failing to valid", () => {
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

  // The migrations.json steps, performed mechanically:
  // 1. build a room tree; 2. move the entry into its owning room;
  // 3. rewrite the ticket ref to the roomed path.
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

  writeFileSync(
    join(repo, ".vibehub", "version.yaml"),
    `${JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 1 }, null, 2)}\n`,
  );
  const format1Compatibility = run(repo, "project", "compatibility");
  assert.equal(format1Compatibility.status, 0);
  assert.equal(format1Compatibility.envelope.data.state, "MIGRATION_REQUIRED");
  assert.equal(format1Compatibility.envelope.data.detected_format, 1);
  assert.equal(format1Compatibility.envelope.data.target_format, 2);

  writeFileSync(
    join(repo, ".vibehub", "version.yaml"),
    `${JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 2 }, null, 2)}\n`,
  );
  const prematureMarker = run(repo, "project", "validate");
  assert.notEqual(prematureMarker.status, 0);
  assert.match(JSON.stringify(prematureMarker.envelope.error.details), /schema_version.*must equal 2/u);

  const audited = JSON.parse(readFileSync(join(repo, ".vibehub", "tickets", "feature.yaml"), "utf8"));
  audited.schema_version = 2;
  audited.deliveries = [];
  writeFileSync(
    join(repo, ".vibehub", "tickets", "feature.yaml"),
    `${JSON.stringify(audited, null, 2)}\n`,
  );
  const healed = run(repo, "project", "validate");
  assert.equal(healed.status, 0, healed.stdout);
  const queried = run(repo, "context", "query", { query: "development entry" });
  assert.equal(queried.envelope.data.count, 1);
});

test("the repository format-2 audit makes delivery structure explicit and evidence-backed", () => {
  const version = JSON.parse(readFileSync(join(root, ".vibehub", "version.yaml"), "utf8"));
  assert.equal(version.format_version, 2);
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
