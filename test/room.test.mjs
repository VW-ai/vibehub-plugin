import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { context, room, root, run, tempRepo, writeRoom } from "./helpers.mjs";

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

test("overlapping anchors between non-nested rooms fail validation; parent and child may nest territory", () => {
  const repo = tempRepo("room-overlap");
  assert.equal(run(repo, "project", "init").status, 0);
  writeRoom(repo, "auth", room("auth", { anchors: ["src/auth"] }));
  writeRoom(repo, "identity", room("identity", { anchors: ["src/auth/oauth"] }));
  const overlapping = run(repo, "project", "validate");
  assert.notEqual(overlapping.status, 0);
  assert.match(JSON.stringify(overlapping.envelope.error.details), /claim overlapping territory/);

  const nested = tempRepo("room-nested-territory");
  assert.equal(run(nested, "project", "init").status, 0);
  writeRoom(nested, "auth", room("auth", { anchors: ["src/auth"] }));
  writeRoom(nested, "auth/oauth", room("oauth", { anchors: ["src/auth/oauth"] }));
  assert.equal(run(nested, "project", "validate").status, 0);
});

test("context query --room scopes to the room subtree including sub-rooms", () => {
  const repo = tempRepo("room-query-scope");
  assert.equal(run(repo, "project", "init").status, 0);
  writeRoom(repo, "auth", room("auth"));
  writeRoom(repo, "auth/oauth", room("oauth"));
  writeRoom(repo, "billing", room("billing"));
  assert.equal(run(repo, "context", "put", context({ context_id: "decision-auth-flow", summary: "Auth flow decision" }), ["--room", "auth"]).status, 0);
  assert.equal(run(repo, "context", "put", context({ context_id: "decision-oauth-provider", summary: "OAuth provider decision" }), ["--room", "auth/oauth"]).status, 0);
  assert.equal(run(repo, "context", "put", context({ context_id: "decision-billing-cycle", summary: "Billing cycle decision" }), ["--room", "billing"]).status, 0);

  const authScope = run(repo, "context", "query", {}, ["--room", "auth"]);
  assert.equal(authScope.status, 0, authScope.stdout);
  assert.deepEqual(
    authScope.envelope.data.contexts.map((item) => item.context_id).sort(),
    ["decision-auth-flow", "decision-oauth-provider"],
  );

  const billingScope = run(repo, "context", "query", {}, ["--room", "billing"]);
  assert.equal(billingScope.envelope.data.count, 1);
  assert.equal(billingScope.envelope.data.contexts[0].context_id, "decision-billing-cycle");

  const missing = run(repo, "context", "query", {}, ["--room", "payments"]);
  assert.notEqual(missing.status, 0);
  assert.equal(missing.envelope.error.code, "not_found");
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

test("room put creates a Room, replaces it, and refuses an invalid document without writing", () => {
  const repo = tempRepo("room-put");
  assert.equal(run(repo, "project", "init").status, 0);
  const file = join(repo, ".vibehub", "rooms", "auth", "room.yaml");

  const created = run(repo, "room", "put", room("auth"), ["--room", "auth"]);
  assert.equal(created.status, 0, created.stdout);
  assert.deepEqual(created.envelope.data, {
    status: "written",
    room: "auth",
    room_id: "auth",
    created: true,
    path: file,
  });
  assert.equal(run(repo, "project", "validate").envelope.data.rooms, 1);

  const replaced = run(repo, "room", "put", room("auth", { description: "The auth room, revised." }), ["--room", "auth"]);
  assert.equal(replaced.status, 0, replaced.stdout);
  assert.equal(replaced.envelope.data.created, false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).description, "The auth room, revised.");

  const invalid = run(repo, "room", "put", room("auth", { stale: "yes", extra: true }), ["--room", "auth"]);
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.envelope.error.code, "validation_error");
  const details = JSON.stringify(invalid.envelope.error.details);
  assert.match(details, /stale/);
  assert.match(details, /extra/);
  // Rejected whole: the document on disk is still the last good one.
  assert.equal(JSON.parse(readFileSync(file, "utf8")).description, "The auth room, revised.");
  assert.equal(run(repo, "project", "validate").status, 0);
});

test("room put guards the room path: --room is required, room_id must match, parents must exist", () => {
  const repo = tempRepo("room-put-guards-path");
  assert.equal(run(repo, "project", "init").status, 0);

  const pathless = run(repo, "room", "put", room("auth"));
  assert.notEqual(pathless.status, 0);
  assert.match(pathless.envelope.error.message, /pass --room/);

  const mismatched = run(repo, "room", "put", room("other-name"), ["--room", "auth"]);
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.envelope.error.message, /room_id must equal its directory name: auth/);

  const orphan = run(repo, "room", "put", room("oauth"), ["--room", "auth/oauth"]);
  assert.notEqual(orphan.status, 0);
  assert.equal(orphan.envelope.error.code, "not_found");
  assert.match(orphan.envelope.error.message, /Parent room not found: auth/);
  assert.ok(!existsSync(join(repo, ".vibehub", "rooms", "auth")));
});

test("room put rejects overlapping territory at the write, with the message validation gives", () => {
  const repo = tempRepo("room-put-overlap");
  assert.equal(run(repo, "project", "init").status, 0);
  assert.equal(run(repo, "room", "put", room("auth", { anchors: ["src/auth"] }), ["--room", "auth"]).status, 0);

  const overlapping = run(repo, "room", "put", room("identity", { anchors: ["src/auth/oauth"] }), ["--room", "identity"]);
  assert.notEqual(overlapping.status, 0);
  assert.match(overlapping.envelope.error.message, /rooms identity and auth claim overlapping territory \(src\/auth\/oauth\); fuse or split them/);
  assert.ok(!existsSync(join(repo, ".vibehub", "rooms", "identity")));
  // The tree is still valid, which is the point of checking at write time.
  assert.equal(run(repo, "project", "validate").status, 0);

  // A sub-room may nest inside its parent's territory.
  const nested = run(repo, "room", "put", room("oauth", { anchors: ["src/auth/oauth"] }), ["--room", "auth/oauth"]);
  assert.equal(nested.status, 0, nested.stdout);
  assert.equal(run(repo, "project", "validate").envelope.data.rooms, 2);
});

test("room put never stamps alignment and reproduces the hand-written form byte for byte", () => {
  const repo = tempRepo("room-put-bytes");
  assert.equal(run(repo, "project", "init").status, 0);
  const file = join(repo, ".vibehub", "rooms", "auth", "room.yaml");

  assert.equal(run(repo, "room", "put", room("auth"), ["--room", "auth"]).status, 0);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).alignment, undefined);
  // Replacing an aligned Room with a document that carries its alignment keeps
  // exactly that block; the write itself adds nothing.
  const aligned = room("auth", {
    alignment: {
      last_aligned_commit: "abc123",
      checked_at: "2026-08-03T00:00:00.000Z",
      anchor_hashes: [{ path: "src/auth/login.ts", blob: "9f8e" }],
    },
  });
  assert.equal(run(repo, "room", "put", aligned, ["--room", "auth"]).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).alignment, aligned.alignment);

  // A Room this repository maintains by hand round-trips through `room put`
  // without a single byte changing.
  const roomsRoot = join(root, ".vibehub", "rooms");
  const checkedIn = readdirSync(roomsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.ok(checkedIn.length > 0, "expected this repository to carry hand-written rooms");
  for (const name of checkedIn) {
    const source = readFileSync(join(roomsRoot, name, "room.yaml"), "utf8");
    const target = tempRepo(`room-put-bytes-${name}`);
    assert.equal(run(target, "project", "init").status, 0);
    const written = run(target, "room", "put", JSON.parse(source), ["--room", name]);
    assert.equal(written.status, 0, written.stdout);
    assert.equal(readFileSync(written.envelope.data.path, "utf8"), source, `${name}/room.yaml did not round-trip`);
  }
});
