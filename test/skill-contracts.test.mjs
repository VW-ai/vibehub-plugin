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
import { helper, root, tempRepo, ticket } from "./helpers.mjs";
import { writeFileSync } from "node:fs";

let inputSeq = 0;
function writeInput(repo, document) {
  const path = join(repo, `.input-${(inputSeq += 1)}.json`);
  writeFileSync(path, JSON.stringify(document));
  return path;
}

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
  const versions = JSON.parse(readFileSync(join(root, "skills", "vibehub-core", "contracts", "versions.json"), "utf8"));
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

  const projectFormat = JSON.parse(readFileSync(join(root, "skills", "vibehub-core", "contracts", "project-format.schema.json"), "utf8"));
  assert.equal(projectFormat.properties.format_version.type, "integer");
  assert.equal(projectFormat.properties.kind.const, "vibehub_project");
  const currentProject = JSON.parse(readFileSync(join(root, ".vibehub", "version.yaml"), "utf8"));
  assert.equal(currentProject.format_version, versions.project_format);

  const currentTicket = JSON.parse(readFileSync(join(root, "skills", "vibehub-core", "contracts", "ticket.schema.json"), "utf8"));
  assert.equal(currentTicket.$id, "https://vibehub.dev/schemas/ticket.v2.json");
  assert.equal(currentTicket.properties.schema_version.const, versions.document_schemas.ticket);
  assert.equal(
    deliveryAudit.document_schema_versions.ticket.to,
    versions.document_schemas.ticket,
  );

  const authority = "vibehub-core/contracts/acceptance-authority.md";
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

  const dependencyHygiene = "vibehub-core/contracts/dependency-hygiene.json";
  const dependencyContract = JSON.parse(readFileSync(join(root, "skills", dependencyHygiene), "utf8"));
  assert.equal(dependencyContract.owner, "vibehub-ticket-plan");
  assert.equal(dependencyContract.scope, "newly-proposed-dependency-edges");
  assert.match(dependencyContract.classification.depends_on, /direct independently schedulable prerequisite/u);
  assert.match(dependencyContract.classification.context_refs, /Completed product authority/u);
  assert.equal(dependencyContract.candidate_done_dependency.advice_code, "completed-dependency-review");
  assert.equal(dependencyContract.candidate_done_dependency.blocking, false);
  assert.equal(dependencyContract.candidate_done_dependency.rationale_required, true);
  assert.match(dependencyContract.preservation.existing_edges, /Never delete or rewrite/u);
  assert.match(dependencyContract.preservation.schema_validity, /remains schema-valid/u);
  for (const name of ["vibehub-ticket-plan", "vibehub-ticket-validate"]) {
    assert.ok(
      bodies.get(name).includes(`../${dependencyHygiene}`),
      `${name} misses the dependency hygiene pointer`,
    );
  }
});

test("human decision boundaries stay in the Ticket graph", () => {
  const authority = "vibehub-core/contracts/acceptance-authority.md";
  const authorityBody = readFileSync(join(root, "skills", authority), "utf8");
  const ticketSchema = JSON.parse(readFileSync(join(root, "skills", "vibehub-core", "contracts", "ticket.schema.json"), "utf8"));
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

// An executor grading its own work is the failure vibehub-ticket-closeout
// exists to prevent, and prose alone cannot prevent it. These weld the Skill's
// named independence sources to the set the engine actually accepts, and prove
// the engine refuses the write rather than merely discouraging it.
test("the closeout Skill names exactly the independence sources the engine accepts", () => {
  const engine = readFileSync(helper, "utf8");
  const declared = engine.match(/const INDEPENDENCE_SOURCES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(declared, "vh.mjs must declare INDEPENDENCE_SOURCES");
  const accepted = [...declared[1].matchAll(/"([a-z_]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(accepted, ["different_human", "separate_session", "subagent"]);

  const skill = bodies.get("vibehub-ticket-closeout");
  const named = [...skill.matchAll(/`([a-z_]+)`/g)]
    .map((match) => match[1])
    .filter((word) => word.includes("_") || word === "subagent");
  assert.deepEqual([...new Set(named)].sort(), accepted,
    "the Skill must name every engine-accepted source and no others");
  const schema = JSON.parse(readFileSync(
    join(root, "skills", "vibehub-core", "contracts", "outcome.schema.json"),
    "utf8",
  ));
  assert.deepEqual([...schema.properties.independence.properties.source.enum].sort(), accepted);
  assert.ok(
    !schema.required.includes("independence"),
    "independence stays optional in the schema so Outcomes written before it remain readable",
  );
});

test("closeout without a declared independence source writes no Outcome", () => {
  const repo = tempRepo("closeout-independence");
  assert.equal(invoke(repo, "project", "init").ok, true);
  assert.equal(invoke(repo, "ticket", "apply", "--input", writeInput(repo, {
    validation: { independent: false, note: "contract test" },
    tickets: [ticket("subject-work")],
  })).ok, true);

  const outcome = {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "subject-work",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: [],
    summary: "contract test",
    closed_at: "2026-09-02T00:00:00.000Z",
  };
  const refused = invoke(repo, "ticket", "closeout", "--input", writeInput(repo, outcome));
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "missing_independence");
  assert.equal(
    existsSync(join(repo, ".vibehub", "outcomes", "subject-work.yaml")),
    false,
    "a refused closeout must leave no Outcome behind",
  );
  // The criterion is that a refused closeout leaves the Ticket at CLOSE_OUT, so
  // the fixture must actually be routing there: give every criterion Evidence.
  assert.equal(invoke(repo, "ticket", "evidence", "--input", writeInput(repo, {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "subject-work-proof",
    ticket_id: "subject-work",
    acceptance_ids: ["works"],
    summary: "contract test",
    refs: ["conversation:contract-test"],
    recorded_at: "2026-09-02T00:00:00.000Z",
  })).ok, true);
  const routed = invoke(repo, "ticket", "get", "--input", writeInput(repo, { ticket_id: "subject-work" }));
  assert.equal(routed.data.next_action.action, "CLOSE_OUT");
  const refusedAgain = invoke(repo, "ticket", "closeout", "--input", writeInput(repo, outcome));
  assert.equal(refusedAgain.error.code, "missing_independence");
  assert.equal(
    invoke(repo, "ticket", "get", "--input", writeInput(repo, { ticket_id: "subject-work" }))
      .data.next_action.action,
    "CLOSE_OUT",
    "a refused closeout leaves the Ticket awaiting adjudication, not adjudicated",
  );

  const rejected = invoke(repo, "ticket", "closeout", "--input", writeInput(repo, {
    ...outcome, independence: { source: "myself" },
  }));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "validation_error");
});

test("ticket apply records whether an independent Agent validated the batch", () => {
  const repo = tempRepo("apply-validation");
  assert.equal(invoke(repo, "project", "init").ok, true);

  const undeclared = invoke(repo, "ticket", "apply", "--input", writeInput(repo, {
    tickets: [ticket("undeclared-work")],
  }));
  assert.equal(undeclared.ok, false);
  assert.equal(undeclared.error.code, "missing_validation_declaration");
  assert.equal(existsSync(join(repo, ".vibehub", "tickets", "undeclared-work.yaml")), false);

  for (const [independent, expected] of [[true, "plan-validation:independent"], [false, "plan-validation:none"]]) {
    const id = independent ? "validated-work" : "skipped-work";
    assert.equal(invoke(repo, "ticket", "apply", "--input", writeInput(repo, {
      validation: { independent, note: "contract test" },
      tickets: [ticket(id)],
    })).ok, true);
    const written = invoke(repo, "ticket", "get", "--input", writeInput(repo, { ticket_id: id }));
    assert.ok(
      written.data.ticket.provenance_refs.includes(expected),
      `${id} must carry ${expected}`,
    );
    // Re-applying must replace, not accumulate.
    assert.equal(invoke(repo, "ticket", "apply", "--input", writeInput(repo, {
      validation: { independent, note: "contract test" },
      tickets: [written.data.ticket],
    })).ok, true);
    const again = invoke(repo, "ticket", "get", "--input", writeInput(repo, { ticket_id: id }));
    assert.deepEqual(
      again.data.ticket.provenance_refs.filter((ref) => ref.startsWith("plan-validation:")),
      [expected],
      "a rerun records exactly one plan-validation ref",
    );
  }

  // The bare `validation:` namespace already carries a different meaning in
  // checked-in Tickets; recording must not touch it.
  const preserved = ticket("history-work");
  preserved.provenance_refs = ["validation:ticket-that-validated-this"];
  assert.equal(invoke(repo, "ticket", "apply", "--input", writeInput(repo, {
    validation: { independent: true, note: "contract test" },
    tickets: [preserved],
  })).ok, true);
  assert.deepEqual(
    invoke(repo, "ticket", "get", "--input", writeInput(repo, { ticket_id: "history-work" }))
      .data.ticket.provenance_refs,
    ["validation:ticket-that-validated-this", "plan-validation:independent"],
    "an existing validation: ref survives the recording",
  );
});

test("the declared independence source reaches a reader and the Workbench", async () => {
  const repo = tempRepo("independence-visible");
  assert.equal(invoke(repo, "project", "init").ok, true);
  assert.equal(invoke(repo, "ticket", "apply", "--input", writeInput(repo, {
    validation: { independent: true, note: "contract test" },
    tickets: [ticket("judged-work")],
  })).ok, true);
  assert.equal(invoke(repo, "ticket", "evidence", "--input", writeInput(repo, {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "judged-work-proof",
    ticket_id: "judged-work",
    acceptance_ids: ["works"],
    summary: "contract test",
    refs: ["conversation:contract-test"],
    recorded_at: "2026-09-02T00:00:00.000Z",
  })).ok, true);
  assert.equal(invoke(repo, "ticket", "closeout", "--input", writeInput(repo, {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "judged-work",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["judged-work-proof"],
    summary: "contract test",
    closed_at: "2026-09-02T00:01:00.000Z",
    independence: { source: "separate_session", note: "contract test" },
  })).ok, true);

  // A reader of the checked-in document sees it.
  const written = readFileSync(join(repo, ".vibehub", "outcomes", "judged-work.yaml"), "utf8");
  assert.match(written, /separate_session/u);

  // And so does the Log, which is the surface the closeout Skill sends them to.
  const { buildUiTrace, loadRepository } = await import(
    join(root, "skills", "vibehub-core", "scripts", "vh-ui.mjs")
  ).catch(() => ({}));
  if (typeof buildUiTrace === "function" && typeof loadRepository === "function") {
    const trace = buildUiTrace(loadRepository(repo), "judged-work");
    const entry = JSON.stringify(trace);
    assert.match(entry, /separate_session/u, "the Log must show the declared source");
    assert.match(entry, /declared, unverified/u, "and must say it is unverified");
  } else {
    const ui = readFileSync(join(root, "skills", "vibehub-core", "scripts", "vh-ui.mjs"), "utf8");
    assert.match(ui, /independence: outcome\.independence \?\? null/u);
    assert.match(ui, /declared, unverified/u);
  }
  const closeout = bodies.get("vibehub-ticket-closeout");
  assert.match(
    closeout,
    /records that claim and never verifies it/u,
    "the Skill must say plainly that the declaration is unverified, so nobody reads it as proof",
  );
});
