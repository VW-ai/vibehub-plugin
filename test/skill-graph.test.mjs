// Skill graph validation. Every failure mode is built on a throwaway skills
// tree in a temp directory so a case can declare a broken graph without
// touching the real one; the last case asserts the real repository passes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helper, root, run, tempRepo } from "./helpers.mjs";

const CONTRACT = "skills/vibehub-core/contracts/skill-graph.json";
const RETIRED = "vibehub-old-alpha";

function write(repo, relative, content) {
  const absolute = join(repo, relative);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, content);
}

function skill(repo, name, body = "") {
  write(repo, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: The ${name} Skill.\n---\n\n${body}\n`);
}

function declare(name, overrides = {}) {
  return {
    name,
    entry: "user",
    invokes: [],
    presents: [],
    routes: [],
    events: [],
    ...overrides,
  };
}

function graph(repo, skills, overrides = {}) {
  write(repo, CONTRACT, `${JSON.stringify({
    schema_version: 1,
    owner: "vibehub-core",
    scope: "development-time-skill-graph",
    runtime_role: "none",
    skills,
    retired: [],
    ...overrides,
  }, null, 2)}\n`);
}

// alpha (user) invokes beta (internal). The edge is witnessed by a reference in
// alpha's SKILL.md. This is the shape every failure case below perturbs.
function baseline(label) {
  const repo = tempRepo(label);
  skill(repo, "vibehub-core", "Infrastructure. Never invoked.");
  skill(repo, "vibehub-alpha", "Run `$vibehub-beta` for the bounded step.");
  skill(repo, "vibehub-beta", "Internal mechanism.");
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal" }),
  ]);
  return repo;
}

function validate(repo) {
  return run(repo, "skills", "validate").envelope;
}

function messages(envelope) {
  assert.equal(envelope.ok, false, `expected validation to fail, got ${JSON.stringify(envelope)}`);
  assert.equal(envelope.error.code, "validation_error");
  return envelope.error.details.errors.map((entry) => `${entry.path}: ${entry.message}`).join("\n");
}

test("a well-formed throwaway graph passes", () => {
  const envelope = validate(baseline("skill-graph-baseline"));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.data.skills, 3);
  assert.equal(envelope.data.edges, 1);
  assert.deepEqual(envelope.data.internal, ["vibehub-beta"]);
});

test("an unresolvable $vibehub reference fails", () => {
  const repo = baseline("skill-graph-unresolvable");
  skill(repo, "vibehub-alpha", "Run `$vibehub-beta`, then hand off to `$vibehub-ghost`.");
  assert.match(messages(validate(repo)), /\$vibehub-ghost names a Skill that does not exist/u);
});

test("a Skill present under skills but missing from the contract fails", () => {
  const repo = baseline("skill-graph-undeclared");
  skill(repo, "vibehub-gamma", "Undeclared.");
  assert.match(messages(validate(repo)), /vibehub-gamma.*present in skills\/ but missing from/su);
});

test("an orphan Skill reachable from nothing fails", () => {
  const repo = baseline("skill-graph-orphan");
  skill(repo, "vibehub-gamma", "Internal but unreachable.");
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal" }),
    declare("vibehub-gamma", { entry: "internal" }),
  ]);
  assert.match(messages(validate(repo)), /vibehub-gamma.*orphan: no user entry and no inbound edge/su);
});

test("a cycle in the invocation subgraph fails", () => {
  const repo = baseline("skill-graph-cycle");
  skill(repo, "vibehub-beta", "Return through `$vibehub-alpha`.");
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal", invokes: ["vibehub-alpha"] }),
  ]);
  assert.match(messages(validate(repo)), /Invocation cycle: vibehub-alpha -> vibehub-beta -> vibehub-alpha/u);
});

test("a reference in a SKILL.md that the contract declares no edge for fails", () => {
  const repo = baseline("skill-graph-undeclared-edge");
  skill(repo, "vibehub-gamma", "Reached from `$vibehub-alpha` only.");
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal" }),
    declare("vibehub-gamma", { entry: "user" }),
  ]);
  assert.match(
    messages(validate(repo)),
    /\$vibehub-alpha is referenced by vibehub-gamma but no edge between them is declared/u,
  );
});

test("an edge the contract declares but no SKILL.md contains fails", () => {
  const repo = baseline("skill-graph-phantom-edge");
  skill(repo, "vibehub-gamma", "No reference either way.");
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta", "vibehub-gamma"] }),
    declare("vibehub-beta", { entry: "internal" }),
    declare("vibehub-gamma", { entry: "internal" }),
  ]);
  assert.match(
    messages(validate(repo)),
    /Declared edge vibehub-alpha -> vibehub-gamma appears in no SKILL\.md or Skill reference/u,
  );
});

test("a retired name in a live reference fails, and the exempt classes do not", () => {
  const repo = baseline("skill-graph-retired");
  const retired = {
    retired: [{
      name: RETIRED,
      replacement: "vibehub-alpha",
      reason: "Renamed.",
      allowed_paths: [{ path: "docs/RENAME.md", reason: "Prose describing the retirement." }],
    }],
  };
  const contract = [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal" }),
  ];
  graph(repo, contract, retired);

  // Exempt: allowlisted prose, historical records, a dated META record, a
  // closed Ticket, and a Context evidence[].ref that records a past proof.
  write(repo, "docs/RENAME.md", `${RETIRED} became vibehub-alpha.\n`);
  write(repo, ".vibehub/evidence/ticket-old/proof.yaml", `{"note": "${RETIRED}"}\n`);
  write(repo, ".vibehub/outcomes/ticket-closed.yaml", `{"note": "${RETIRED}"}\n`);
  write(repo, ".vibehub/history/snapshot/old.yaml", `{"note": "${RETIRED}"}\n`);
  write(repo, "META/room/artifacts/2026-01-02-note.md", `Named skills/${RETIRED}/SKILL.md then.\n`);
  write(repo, ".vibehub/tickets/ticket-closed.yaml", `{"note": "${RETIRED}"}\n`);
  write(repo, ".vibehub/rooms/product/decision-x.yaml", `${JSON.stringify({
    kind: "context",
    summary: "A decision.",
    evidence: [{ ref: `skills/${RETIRED}/assets/app.css`, note: "What proved it." }],
  }, null, 2)}\n`);
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));

  // An active META spec naming the retired Skill's folder is the reference a
  // careful human grep missed during the real rename. It must fail.
  write(repo, "META/room/spec.md", `See skills/${RETIRED}/SKILL.md.\n`);
  assert.match(messages(validate(repo)), /META\/room\/spec\.md: Live reference to retired Skill/u);
});

test("an open Ticket is live, and an allowlist may not cover a $-invocation", () => {
  const repo = baseline("skill-graph-retired-live");
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal" }),
  ], {
    retired: [{
      name: RETIRED,
      replacement: "vibehub-alpha",
      reason: "Renamed.",
      allowed_paths: [{ path: "docs/RENAME.md", reason: "Prose describing the retirement." }],
    }],
  });
  write(repo, "docs/RENAME.md", `${RETIRED} became vibehub-alpha.\n`);
  write(repo, ".vibehub/tickets/ticket-open.yaml", `{"note": "${RETIRED}"}\n`);
  assert.match(messages(validate(repo)), /\.vibehub\/tickets\/ticket-open\.yaml: Live reference to retired Skill/u);

  write(repo, ".vibehub/tickets/ticket-open.yaml", '{"note": "clean"}\n');
  write(repo, "docs/RENAME.md", `${RETIRED} became vibehub-alpha; never call $${RETIRED}.\n`);
  assert.match(messages(validate(repo)), /docs\/RENAME\.md: Retired Skill .* is invoked as/u);
});

test("an allowance whose file no longer names the retired Skill fails", () => {
  const repo = baseline("skill-graph-stale-allowance");
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal" }),
  ], {
    retired: [{
      name: RETIRED,
      replacement: "vibehub-alpha",
      reason: "Renamed.",
      allowed_paths: [{ path: "docs/GONE.md", reason: "Stale." }],
    }],
  });
  assert.match(messages(validate(repo)), /docs\/GONE\.md no longer contains/u);
});

test("the checked-in skill graph is development-time only", () => {
  const contract = JSON.parse(readFileSync(join(root, CONTRACT), "utf8"));
  assert.equal(contract.runtime_role, "none");
  assert.equal(contract.owner, "vibehub-core");
  assert.ok(contract.retired.some((entry) => entry.replacement === "vibehub-review"));
  // No Skill reads the contract, and the command records nothing in .vibehub/.
  const helperSource = readFileSync(helper, "utf8");
  assert.equal(helperSource.includes("writeDocument(join(repo, \".vibehub\""), false);
  assert.match(helperSource, /Development-time validation only/u);
});

test("this repository's real skill graph passes", () => {
  const envelope = validate(root);
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(envelope.data.valid, true);
  assert.ok(envelope.data.skills >= 12);
  assert.ok(envelope.data.entry_points.includes("vibehub-ticket-plan"));
  assert.deepEqual(envelope.data.internal, ["vibehub-distill", "vibehub-ticket-validate"]);
  assert.deepEqual(envelope.data.infrastructure, ["vibehub-core"]);
});
