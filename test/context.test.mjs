import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { context, run, tempRepo } from "./helpers.mjs";

test("explicit Context capture survives a fresh process and remains queryable", () => {
  const repo = tempRepo("context-roundtrip");
  assert.equal(run(repo, "project", "init").status, 0);
  const captured = run(repo, "context", "put", context());
  assert.equal(captured.status, 0, captured.stdout);

  const queried = run(repo, "context", "query", { query: "development entry" });
  assert.equal(queried.status, 0, queried.stdout);
  assert.equal(queried.envelope.data.count, 1);
  assert.equal(queried.envelope.data.contexts[0].context_id, "decision-use-tickets");
  assert.equal(queried.envelope.data.contexts[0].source.ref, "conversation:2026-07-31");
});

test("malformed YAML and dangling Context relations fail visibly", () => {
  const malformedRepo = tempRepo("context-malformed");
  mkdirSync(join(malformedRepo, ".vibehub", "context"), { recursive: true });
  writeFileSync(join(malformedRepo, ".vibehub", "context", "broken.yaml"), "id: not-json\n");
  const malformed = run(malformedRepo, "project", "validate");
  assert.notEqual(malformed.status, 0);
  assert.equal(malformed.envelope.error.code, "validation_error");
  assert.match(JSON.stringify(malformed.envelope.error.details), /JSON-compatible YAML/);

  const danglingRepo = tempRepo("context-dangling");
  const dangling = run(
    danglingRepo,
    "context",
    "put",
    context({ relations: [{ type: "depends_on", target_context_id: "missing-context" }] }),
  );
  assert.notEqual(dangling.status, 0);
  assert.match(JSON.stringify(dangling.envelope.error.details), /dangling Context relation/);
});
