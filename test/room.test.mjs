import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { context, room, run, tempRepo, writeRoom } from "./helpers.mjs";

test("a nested rooms tree validates and room Context resolves in query", () => {
  const repo = tempRepo("room-tree");
  assert.equal(run(repo, "project", "init").status, 0);
  writeRoom(repo, "auth", room("auth"));
  writeRoom(repo, "auth/oauth", room("oauth"));

  const captured = run(repo, "context", "put", context(), ["--room", "auth/oauth"]);
  assert.equal(captured.status, 0, captured.stdout);
  assert.equal(captured.envelope.data.room, "auth/oauth");
  assert.ok(existsSync(join(repo, ".vibehub", "rooms", "auth", "oauth", "decision-use-tickets.yaml")));

  const validated = run(repo, "project", "validate");
  assert.equal(validated.status, 0, validated.stdout);
  assert.equal(validated.envelope.data.rooms, 2);
  assert.equal(validated.envelope.data.contexts, 1);

  const queried = run(repo, "context", "query", { query: "development entry" });
  assert.equal(queried.envelope.data.count, 1);
  assert.equal(queried.envelope.data.contexts[0].context_id, "decision-use-tickets");
});

test("room directories without room.yaml, bad slugs, and mismatched room_id fail visibly", () => {
  const repo = tempRepo("room-invalid");
  assert.equal(run(repo, "project", "init").status, 0);

  mkdirSync(join(repo, ".vibehub", "rooms", "orphan"), { recursive: true });
  let result = run(repo, "project", "validate");
  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.envelope.error.details), /must contain room\.yaml/);

  writeRoom(repo, "orphan", room("orphan"));
  mkdirSync(join(repo, ".vibehub", "rooms", "Bad_Slug"), { recursive: true });
  writeRoom(repo, "Bad_Slug", room("orphan"));
  result = run(repo, "project", "validate");
  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.envelope.error.details), /kebab-case slug/);

  const mismatchRepo = tempRepo("room-mismatch");
  assert.equal(run(mismatchRepo, "project", "init").status, 0);
  writeRoom(mismatchRepo, "auth", room("other-name"));
  result = run(mismatchRepo, "project", "validate");
  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.envelope.error.details), /room_id must equal its directory name/);
});

test("documents directly under rooms/ and schema-invalid room.yaml fail visibly", () => {
  const repo = tempRepo("room-stray");
  assert.equal(run(repo, "project", "init").status, 0);
  writeFileSync(join(repo, ".vibehub", "rooms", "stray.yaml"), `${JSON.stringify(context())}\n`);
  let result = run(repo, "project", "validate");
  assert.notEqual(result.status, 0);
  assert.match(JSON.stringify(result.envelope.error.details), /inside a room directory/);

  const schemaRepo = tempRepo("room-schema");
  assert.equal(run(schemaRepo, "project", "init").status, 0);
  writeRoom(schemaRepo, "auth", room("auth", { stale: "yes", extra: true }));
  result = run(schemaRepo, "project", "validate");
  assert.notEqual(result.status, 0);
  const details = JSON.stringify(result.envelope.error.details);
  assert.match(details, /stale/);
  assert.match(details, /extra/);
});

test("context put demands a room, refuses a missing room, and never duplicates a Context elsewhere", () => {
  const repo = tempRepo("room-put-guards");
  assert.equal(run(repo, "project", "init").status, 0);
  writeRoom(repo, "auth", room("auth"));
  writeRoom(repo, "billing", room("billing"));

  const roomless = run(repo, "context", "put", context());
  assert.notEqual(roomless.status, 0);
  assert.match(roomless.envelope.error.message, /every Context lives in a room/);

  const missing = run(repo, "context", "put", context(), ["--room", "payments"]);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.envelope.error.code, "not_found");

  assert.equal(run(repo, "context", "put", context(), ["--room", "auth"]).status, 0);
  const moved = run(repo, "context", "put", context(), ["--room", "billing"]);
  assert.notEqual(moved.status, 0);
  assert.match(moved.envelope.error.message, /already lives at/);

  const updated = run(repo, "context", "put", context({ summary: "Updated summary" }), ["--room", "auth"]);
  assert.equal(updated.status, 0, updated.stdout);
});

test("alignment block and stale flag validate strictly", () => {
  const repo = tempRepo("room-alignment");
  assert.equal(run(repo, "project", "init").status, 0);
  writeRoom(repo, "auth", room("auth", {
    stale: true,
    stale_reason: "drift detected at abc123, deferred",
    alignment: {
      last_aligned_commit: "abc123",
      checked_at: "2026-08-03T00:00:00.000Z",
      anchor_hashes: [{ path: "src/auth/login.ts", blob: "9f8e" }],
    },
  }));
  assert.equal(run(repo, "project", "validate").status, 0);

  writeRoom(repo, "auth", room("auth", {
    alignment: { last_aligned_commit: "abc123", checked_at: "not-a-date", anchor_hashes: [] },
  }));
  const invalid = run(repo, "project", "validate");
  assert.notEqual(invalid.status, 0);
  assert.match(JSON.stringify(invalid.envelope.error.details), /checked_at/);
});
