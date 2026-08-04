// Contract-layer tests (see convention-skill-contract-test-layers): model-free
// assertions that weld SKILL.md prose to system reality. Unit tests cover the
// deterministic scripts; e2e is the social independent validate/closeout
// practice; this file is the layer in between.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { helper, root } from "./helpers.mjs";

const skillNames = readdirSync(join(root, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("vibehub-"))
  .map((entry) => entry.name);
const bodies = new Map(skillNames.map((name) => [
  name,
  readFileSync(join(root, "skills", name, "SKILL.md"), "utf8"),
]));

function invoke(repo, ...args) {
  const result = spawnSync(process.execPath, [helper, ...args, "--repo", repo], { encoding: "utf8" });
  return JSON.parse(result.stdout);
}

test("every vh.mjs command a skill cites resolves to a real operation", () => {
  const repo = mkdtempSync(join(tmpdir(), "vibehub-command-surface-"));
  assert.equal(invoke(repo, "project", "init").ok, true);
  const cited = new Set();
  for (const body of bodies.values()) {
    for (const match of body.matchAll(/vh\.mjs (\w[\w-]*) (\w[\w-]*)/gu)) {
      cited.add(`${match[1]} ${match[2]}`);
    }
    for (const match of body.matchAll(/`(context|room|ticket|project) ([a-z][\w-]*)`/gu)) {
      cited.add(`${match[1]} ${match[2]}`);
    }
  }
  assert.ok(cited.size >= 10, `expected a substantial cited command surface, found ${cited.size}`);
  for (const command of cited) {
    const [domain, operation] = command.split(" ");
    const envelope = invoke(repo, domain, operation);
    if (envelope.ok) continue;
    for (const code of ["unsupported_domain", "unsupported_operation", "invalid_argument"]) {
      assert.notEqual(envelope.error.code, code, `skill-cited "${command}" does not resolve: ${envelope.error.message}`);
    }
  }
});

test("the --room flag skills cite parses in vh.mjs", () => {
  const repo = mkdtempSync(join(tmpdir(), "vibehub-room-flag-"));
  assert.equal(invoke(repo, "project", "init").ok, true);
  const envelope = invoke(repo, "context", "query", "--room", "missing-room");
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "not_found");
});

test("skills point at their governing shared references", () => {
  const boundary = "vibehub-setup/references/architecture-boundary.md";
  assert.ok(existsSync(join(root, "skills", boundary)));
  for (const name of ["vibehub-setup", "vibehub-ingest", "vibehub-query", "vibehub-distill", "vibehub-ticket-plan", "vibehub-ticket-run"]) {
    const pointer = name === "vibehub-setup" ? "references/architecture-boundary.md" : `../${boundary}`;
    assert.ok(bodies.get(name).includes(pointer), `${name} misses the architecture boundary pointer`);
  }

  const governance = "vibehub-ingest/references/knowledge-governance.json";
  const document = JSON.parse(readFileSync(join(root, "skills", governance), "utf8"));
  assert.equal(document.owner, "vibehub-ingest");
  assert.equal(document.placement.rule, "lowest-owning-room");
  assert.equal(document.trust_layers.filter((layer) => layer.wins_conflicts).length, 1);
  const recomputable = document.stale_origins.filter((origin) => origin.resolution === "recompute");
  assert.equal(recomputable.length, 1);
  assert.equal(recomputable[0].reason_prefix, "drift:");
  for (const name of ["vibehub-ingest", "vibehub-distill", "vibehub-query"]) {
    const pointer = name === "vibehub-ingest" ? "references/knowledge-governance.json" : `../${governance}`;
    assert.ok(bodies.get(name).includes(pointer), `${name} misses the knowledge governance pointer`);
  }

  const migrations = JSON.parse(readFileSync(join(root, "skills", "vibehub-migrate", "references", "migrations.json"), "utf8"));
  assert.equal(migrations.owner, "vibehub-migrate");
  assert.ok(Array.isArray(migrations.migrations) && migrations.migrations.length >= 1);
  const first = migrations.migrations[0];
  assert.equal(first.from, "0.4");
  assert.equal(first.to, "0.5");
  assert.ok(typeof first.detect === "string" && first.steps.length >= 3);
  assert.ok(bodies.get("vibehub-migrate").includes("references/migrations.json"), "vibehub-migrate misses its migrations pointer");
});
