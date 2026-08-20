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
  const versions = JSON.parse(readFileSync(join(root, "skills", "contracts", "versions.json"), "utf8"));
  assert.equal(migrations.owner, "vibehub-migrate");
  assert.equal(migrations.current_format, versions.project_format);
  assert.ok(Array.isArray(migrations.migrations) && migrations.migrations.length >= 1);
  const first = migrations.migrations[0];
  assert.equal(first.from, "0.4");
  assert.equal(first.to, "0.5");
  assert.ok(typeof first.detect === "string" && first.steps.length >= 3);
  const formatMarker = migrations.migrations.find((migration) => migration.from === "0.5-unversioned");
  assert.equal(formatMarker.to, "format-1");
  assert.match(formatMarker.detect, /project compatibility/u);
  assert.ok(formatMarker.steps.some((step) => step.includes(".vibehub/version.yaml")));
  const deliveryAudit = migrations.migrations.find((migration) => migration.from === "format-1");
  assert.equal(deliveryAudit.to, "format-2");
  assert.deepEqual(deliveryAudit.document_schema_versions, {
    ticket: { from: 1, to: 2 },
  });
  assert.match(deliveryAudit.detect, /detected_format 1/u);
  assert.ok(deliveryAudit.steps.some((step) => step.includes("deliveries array")));
  assert.ok(deliveryAudit.steps.some((step) => step.includes("schema_version 1 to schema_version 2")));
  assert.ok(deliveryAudit.steps.some((step) => step.includes("format_version 2")));
  assert.ok(bodies.get("vibehub-migrate").includes("references/migrations.json"), "vibehub-migrate misses its migrations pointer");

  const projectFormat = JSON.parse(readFileSync(join(root, "skills", "contracts", "project-format.schema.json"), "utf8"));
  assert.equal(projectFormat.properties.format_version.type, "integer");
  assert.equal(projectFormat.properties.kind.const, "vibehub_project");
  const currentProject = JSON.parse(readFileSync(join(root, ".vibehub", "version.yaml"), "utf8"));
  assert.equal(currentProject.format_version, versions.project_format);

  const currentTicket = JSON.parse(readFileSync(join(root, "skills", "contracts", "ticket.schema.json"), "utf8"));
  assert.equal(currentTicket.$id, "https://vibehub.dev/schemas/ticket.v2.json");
  assert.equal(currentTicket.properties.schema_version.const, versions.document_schemas.ticket);
  assert.equal(
    deliveryAudit.document_schema_versions.ticket.to,
    versions.document_schemas.ticket,
  );

  const authority = "contracts/acceptance-authority.md";
  assert.ok(existsSync(join(root, "skills", authority)));
  for (const name of [
    "vibehub-ticket-plan",
    "vibehub-ticket-validate",
    "vibehub-ticket-run",
    "vibehub-ticket-closeout",
  ]) {
    assert.ok(
      bodies.get(name).includes(`../${authority}`),
      `${name} misses the acceptance authority pointer`,
    );
  }
});

test("human decision boundaries stay in the Ticket graph", () => {
  const authority = "contracts/acceptance-authority.md";
  const authorityBody = readFileSync(join(root, "skills", authority), "utf8");
  const ticketSchema = JSON.parse(readFileSync(join(root, "skills", "contracts", "ticket.schema.json"), "utf8"));
  assert.deepEqual(ticketSchema.properties.maturity.enum, ["firm", "draft"]);
  assert.equal(ticketSchema.properties.maturity.default, "firm");
  assert.match(authorityBody, /decision owner/u);
  assert.match(authorityBody, /independently\s+schedulable downstream work/u);
  assert.match(authorityBody, /repository-level handoff/u);
  assert.match(authorityBody, /does not assign, wake, or bind an Agent session/u);
  assert.match(authorityBody, /maturity: draft/u);
  assert.match(bodies.get("vibehub-ticket-plan"), /proposal, human decision, then dependent\s+implementation/u);
  assert.match(bodies.get("vibehub-ticket-plan"), /do not manufacture a firm downstream\s+plan/u);
  assert.match(bodies.get("vibehub-ticket-plan"), /new or rewritten Tickets state it explicitly/u);
  assert.match(bodies.get("vibehub-ticket-run"), /split out a new\s+human-decision Ticket/u);
  assert.match(bodies.get("vibehub-ticket-validate"), /represented by direct\s+Ticket dependencies/u);
  assert.match(bodies.get("vibehub-ticket-validate"), /remain `maturity: draft`/u);
});
