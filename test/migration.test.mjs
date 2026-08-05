import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { context, room, run, tempRepo, ticket, writeRoom } from "./helpers.mjs";

test("the 0.4-to-0.5 migration steps take a flat-context repo from failing to valid", () => {
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
  const healed = run(repo, "project", "validate");
  assert.equal(healed.status, 0, healed.stdout);
  const queried = run(repo, "context", "query", { query: "development entry" });
  assert.equal(queried.envelope.data.count, 1);
});
