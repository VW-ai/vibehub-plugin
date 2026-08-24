// Proof-to-acceptance binding: the shared contract identity, the one optional
// binding each proof schema gains, native bindings on every new Evidence and
// Outcome, the closed-contract guard beside the origin guard, and the
// binding-aware projection that explains stale and unresolved proof through
// the existing seven next actions.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  VibeHubError,
  appendEvidence,
  applyTickets,
  contractIdentity,
  loadRepository,
  outcomeAccepted,
  ticketNextAction,
  ticketProofState,
  ticketStatus,
} from "../skills/vibehub-core/scripts/vh.mjs";
import { root, run, tempRepo, ticket } from "./helpers.mjs";

const NOW = "2026-08-23T10:00:00.000Z";
const HEX_64 = /^[0-9a-f]{64}$/u;

function evidence(id, ticketId, acceptanceIds, overrides = {}) {
  return {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: id,
    ticket_id: ticketId,
    acceptance_ids: acceptanceIds,
    summary: `${ticketId} has acceptance-linked proof.`,
    refs: [`test:${id}`],
    recorded_at: NOW,
    ...overrides,
  };
}

function outcome(ticketId, status, accepted, unresolved, evidenceIds = [], overrides = {}) {
  return {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: ticketId,
    status,
    accepted_acceptance_ids: accepted,
    unresolved_acceptance_ids: unresolved,
    evidence_ids: evidenceIds,
    summary: `${ticketId} was independently adjudicated as ${status}.`,
    closed_at: NOW,
    ...overrides,
  };
}

function initialized(label) {
  const repo = tempRepo(label);
  assert.equal(run(repo, "project", "init").status, 0);
  return repo;
}

// Reads carry no format gate, so flipping the checked-in marker alone selects
// the interpretation: >= 3 consults bindings, < 3 is the legacy (rollback)
// interpretation with bindings inert on disk.
function setFormat(repo, formatVersion) {
  writeFileSync(join(repo, ".vibehub", "version.yaml"), `${JSON.stringify({
    format_version: formatVersion,
    kind: "vibehub_project",
    schema_version: 1,
  }, null, 2)}\n`);
}

function rewriteCriterion(repo, ticketId, acceptanceId, criterion) {
  const path = join(repo, ".vibehub", "tickets", `${ticketId}.yaml`);
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.acceptance = document.acceptance.map((item) =>
    item.acceptance_id === acceptanceId ? { ...item, criterion } : item);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
}

function applyError(repo, tickets) {
  const result = run(repo, "ticket", "apply", { tickets });
  assert.notEqual(result.status, 0, result.stdout);
  return result.envelope.error;
}

function hostError(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof VibeHubError, String(error));
    return error;
  }
  return assert.fail("expected the host path to refuse");
}

test("evidence schema gains exactly one optional acceptance_bindings array on version 2", () => {
  const schema = JSON.parse(readFileSync(join(root, "skills", "vibehub-core", "contracts", "evidence.schema.json"), "utf8"));
  assert.equal(schema.$id, "https://vibehub.dev/schemas/ticket-evidence.v2.json");
  assert.deepEqual(schema.properties.schema_version.enum, [1, 2]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), [
    "schema_version", "kind", "evidence_id", "ticket_id", "acceptance_ids",
    "acceptance_bindings", "summary", "refs", "origin", "recorded_at",
  ]);
  assert.ok(!schema.required.includes("acceptance_bindings"), "the binding stays optional; omission is the legacy rule");
  const entry = schema.properties.acceptance_bindings.items;
  assert.equal(entry.additionalProperties, false);
  assert.deepEqual(entry.required, ["acceptance_id", "digest", "binding"]);
  assert.deepEqual(entry.properties.binding.enum, ["native", "reconstructed"]);
  assert.deepEqual(entry.properties.digest, { $ref: "#/$defs/sha256" });
  assert.equal(schema.$defs.sha256.pattern, "^[0-9a-f]{64}$");
  assert.equal(schema.$defs.commit_ref.pattern, "^commit:[0-9a-f]{40}$");
  assert.match(entry.properties.provenance_ref.description, /never identity/u);
});

test("outcome schema gains exactly one optional contract_binding object on version 2", () => {
  const schema = JSON.parse(readFileSync(join(root, "skills", "vibehub-core", "contracts", "outcome.schema.json"), "utf8"));
  assert.equal(schema.$id, "https://vibehub.dev/schemas/ticket-outcome.v2.json");
  assert.deepEqual(schema.properties.schema_version.enum, [1, 2]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), [
    "schema_version", "kind", "ticket_id", "status", "accepted_acceptance_ids",
    "unresolved_acceptance_ids", "evidence_ids", "contract_binding", "summary", "closed_at",
  ]);
  assert.ok(!schema.required.includes("contract_binding"), "the binding stays optional; omission is the legacy rule");
  const binding = schema.properties.contract_binding;
  assert.equal(binding.additionalProperties, false);
  assert.deepEqual(binding.required, ["binding"]);
  assert.deepEqual(binding.properties.binding.enum, ["native", "reconstructed"]);
  assert.deepEqual(binding.properties.unresolved.required, ["reason"]);
  assert.deepEqual(binding.properties.unresolved.properties.reason.enum, [
    "no-addition-commit",
    "ticket-unreadable-at-addition",
    "referenced-acceptance-missing-at-addition",
    "contract-drifted-since-addition",
  ]);
  // Native bindings always carry the digest they certify; missing-history
  // reconstruction never fabricates one.
  const [nativeRule, driftRule, missingRule, resolvedRule] = binding.allOf;
  assert.deepEqual(nativeRule.then, { required: ["digest"], not: { required: ["unresolved"] } });
  assert.deepEqual(driftRule.then, { required: ["digest"] });
  assert.deepEqual(missingRule.then, { not: { required: ["digest"] } });
  assert.deepEqual(resolvedRule.then, { required: ["digest"] });
});

test("contract identity is deterministic, canonical, and blind to unrelated Ticket edits", () => {
  const base = {
    ...ticket("digest-fixture"),
    acceptance: [
      { acceptance_id: "beta", criterion: "Beta behavior is observed." },
      { acceptance_id: "alpha", criterion: "Alpha behavior is observed.", authority: "human" },
    ],
  };
  const identity = contractIdentity(base);
  assert.match(identity.contract_digest, HEX_64);
  assert.deepEqual(Object.keys(identity.criterion_digests), ["alpha", "beta"]);
  for (const digest of Object.values(identity.criterion_digests)) assert.match(digest, HEX_64);

  // Identical inputs and reordered acceptance produce identical digests.
  assert.deepEqual(contractIdentity({ ...base }), identity);
  assert.deepEqual(
    contractIdentity({ ...base, acceptance: [...base.acceptance].reverse() }),
    identity,
  );
  // The explicit default authority is the same identity as its omission.
  assert.deepEqual(
    contractIdentity({
      ...base,
      acceptance: base.acceptance.map((item) =>
        item.acceptance_id === "beta" ? { ...item, authority: "agent" } : item),
    }),
    identity,
  );

  // Unrelated Ticket edits change nothing.
  assert.deepEqual(contractIdentity({
    ...base,
    context: "Entirely rewritten context.",
    constraints: ["A new constraint."],
    context_refs: [{ ref: "README.md", purpose: "Reference." }],
    relations: [{ type: "depends_on", target_ticket_id: "digest-other" }],
    deliveries: [],
    provenance_refs: ["conversation:rewritten"],
    outcome: "A rewritten outcome sentence.",
    maturity: "draft",
  }), identity);

  // Wording, authority, and membership drift each change the digest.
  const worded = contractIdentity({
    ...base,
    acceptance: base.acceptance.map((item) =>
      item.acceptance_id === "beta" ? { ...item, criterion: "Beta behavior is observed differently." } : item),
  });
  assert.notEqual(worded.contract_digest, identity.contract_digest);
  assert.notEqual(worded.criterion_digests.beta, identity.criterion_digests.beta);
  assert.equal(worded.criterion_digests.alpha, identity.criterion_digests.alpha);

  const reauthored = contractIdentity({
    ...base,
    acceptance: base.acceptance.map((item) =>
      item.acceptance_id === "alpha" ? { ...item, authority: "agent" } : item),
  });
  assert.notEqual(reauthored.criterion_digests.alpha, identity.criterion_digests.alpha);
  assert.notEqual(reauthored.contract_digest, identity.contract_digest);

  const grown = contractIdentity({
    ...base,
    acceptance: [...base.acceptance, { acceptance_id: "gamma", criterion: "Gamma behavior is observed." }],
  });
  assert.notEqual(grown.contract_digest, identity.contract_digest);
  assert.equal(grown.criterion_digests.alpha, identity.criterion_digests.alpha);
  assert.equal(grown.criterion_digests.beta, identity.criterion_digests.beta);

  // A different owning Ticket is a different identity even with equal criteria.
  assert.notEqual(
    contractIdentity({ ...base, ticket_id: "digest-elsewhere" }).contract_digest,
    identity.contract_digest,
  );
});

test("the source tree and both installed marketplace artifacts derive identical digests", async () => {
  const output = mkdtempSync(join(tmpdir(), "vibehub-binding-artifacts-"));
  const fixture = {
    ...ticket("artifact-digest-fixture"),
    acceptance: [
      { acceptance_id: "parity", criterion: "Installed hosts derive the same identity.", authority: "human" },
      { acceptance_id: "works", criterion: "artifact-digest-fixture behavior is observed." },
    ],
  };
  const { buildClaudeMarketplace } = await import("../scripts/build-claude-marketplace.mjs");
  const { buildCodexMarketplace } = await import("../scripts/build-codex-marketplace.mjs");
  buildClaudeMarketplace({ outputRoot: join(output, "claude"), offline: true });
  buildCodexMarketplace({ outputRoot: join(output, "codex"), offline: true });
  const expected = contractIdentity(fixture);
  for (const host of ["claude", "codex"]) {
    const helper = join(output, host, "plugins", "vibehub", "skills", "vibehub-core", "scripts", "vh.mjs");
    assert.ok(existsSync(helper), `${host} marketplace ships vh.mjs`);
    const installed = await import(pathToFileURL(helper).href);
    assert.deepEqual(installed.contractIdentity(fixture), expected, `${host} artifact digest parity`);
  }
});

test("every new Evidence and Outcome written by vh.mjs carries native bindings", () => {
  const repo = initialized("binding-native-writes");
  assert.equal(run(repo, "ticket", "apply", { tickets: [ticket("native-work")] }).status, 0);
  const identity = contractIdentity(JSON.parse(readFileSync(join(repo, ".vibehub", "tickets", "native-work.yaml"), "utf8")));

  assert.equal(run(repo, "ticket", "evidence", evidence("native-proof", "native-work", ["works"])).status, 0);
  const storedEvidence = JSON.parse(readFileSync(join(repo, ".vibehub", "evidence", "native-work", "native-proof.yaml"), "utf8"));
  assert.equal(storedEvidence.schema_version, 2);
  assert.deepEqual(storedEvidence.acceptance_bindings, [
    { acceptance_id: "works", binding: "native", digest: identity.criterion_digests.works },
  ]);

  assert.equal(run(repo, "ticket", "closeout", outcome("native-work", "successful", ["works"], [], ["native-proof"])).status, 0);
  const storedOutcome = JSON.parse(readFileSync(join(repo, ".vibehub", "outcomes", "native-work.yaml"), "utf8"));
  assert.equal(storedOutcome.schema_version, 2);
  assert.deepEqual(storedOutcome.contract_binding, { binding: "native", digest: identity.contract_digest });
  assert.equal(run(repo, "ticket", "validate").envelope.data.valid, true);

  // The host entry writes the same native binding.
  assert.equal(run(repo, "ticket", "apply", { tickets: [ticket("host-work")] }).status, 0);
  const written = appendEvidence({ repo, evidence: evidence("host-proof", "host-work", ["works"]) });
  assert.equal(written.status, "written");
  const hostEvidence = JSON.parse(readFileSync(written.path, "utf8"));
  assert.equal(hostEvidence.schema_version, 2);
  assert.equal(hostEvidence.acceptance_bindings[0].binding, "native");
  assert.match(hostEvidence.acceptance_bindings[0].digest, HEX_64);

  // Bindings are derived: a caller may repeat the exact derivation but never
  // supply a different one.
  const exact = evidence("repeat-proof", "host-work", ["works"], {
    acceptance_bindings: hostEvidence.acceptance_bindings,
  });
  assert.equal(appendEvidence({ repo, evidence: exact }).status, "written");
  const fabricated = evidence("forged-proof", "host-work", ["works"], {
    acceptance_bindings: [{ acceptance_id: "works", binding: "native", digest: "f".repeat(64) }],
  });
  assert.equal(hostError(() => appendEvidence({ repo, evidence: fabricated })).code, "validation_error");
  const reconstructedByHand = run(repo, "ticket", "closeout", outcome("host-work", "successful", ["works"], [], ["host-proof"], {
    contract_binding: { binding: "reconstructed", digest: "f".repeat(64) },
  }));
  assert.notEqual(reconstructedByHand.status, 0);
  assert.equal(reconstructedByHand.envelope.error.code, "validation_error");
});

test("malformed bindings are rejected with exact paths", () => {
  const repo = initialized("binding-malformed");
  assert.equal(run(repo, "ticket", "apply", { tickets: [ticket("strict-work")] }).status, 0);
  const cases = [
    [{ acceptance_bindings: [] }, /acceptance_bindings.*non-empty array/u],
    [{ acceptance_bindings: [{ acceptance_id: "works", digest: "nope", binding: "native" }] }, /digest.*64 lowercase hex/u],
    [{ acceptance_bindings: [{ acceptance_id: "works", digest: "a".repeat(64), binding: "imported" }] }, /binding.*native or reconstructed/u],
    [{ acceptance_bindings: [{ acceptance_id: "other", digest: "a".repeat(64), binding: "native" }] }, /acceptance_id.*one of this Evidence's acceptance_ids/u],
    [{ acceptance_bindings: [{ acceptance_id: "works", digest: "a".repeat(64), binding: "native", provenance_ref: `commit:${"a".repeat(40)}` }] }, /provenance_ref.*only for reconstructed/u],
    [{ acceptance_bindings: [{ acceptance_id: "works", digest: "a".repeat(64), binding: "reconstructed", provenance_ref: "not-a-commit" }] }, /provenance_ref.*commit:<40-hex>/u],
    [{ acceptance_bindings: [
      { acceptance_id: "works", digest: "a".repeat(64), binding: "native" },
      { acceptance_id: "works", digest: "b".repeat(64), binding: "native" },
    ] }, /acceptance_id.*unique/u],
    [{ schema_version: 3 }, /schema_version.*must equal 1 or 2/u],
  ];
  for (const [override, expected] of cases) {
    const result = run(repo, "ticket", "evidence", evidence("bad-proof", "strict-work", ["works"], override));
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.error.code, "validation_error");
    assert.match(JSON.stringify(result.envelope.error.details.errors), expected);
  }
  const outcomeCases = [
    [{ contract_binding: { binding: "native", digest: "a".repeat(64), unresolved: { reason: "contract-drifted-since-addition" } } }, /unresolved.*only for reconstructed/u],
    [{ contract_binding: { binding: "reconstructed", unresolved: { reason: "not-a-reason" } } }, /reason.*must be one of/u],
    [{ contract_binding: { binding: "reconstructed", unresolved: { reason: "contract-drifted-since-addition" } } }, /digest.*required/u],
    [{ contract_binding: { binding: "reconstructed", digest: "a".repeat(64), unresolved: { reason: "no-addition-commit" } } }, /digest.*must be omitted/u],
    [{ contract_binding: { binding: "reconstructed" } }, /digest.*required/u],
    [{ contract_binding: { binding: "native" } }, /digest.*required/u],
    [{ contract_binding: { binding: "reconstructed", digest: "a".repeat(64), unresolved: { reason: "contract-drifted-since-addition", acceptance_ids: [] } } }, /acceptance_ids.*non-empty array/u],
  ];
  for (const [override, expected] of outcomeCases) {
    const result = run(repo, "ticket", "closeout", outcome("strict-work", "failed", [], ["works"], [], override));
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.error.code, "validation_error", JSON.stringify(result.envelope.error));
    assert.match(JSON.stringify(result.envelope.error.details.errors), expected);
  }
});

test("a successful Outcome closes the acceptance contract against every apply path", () => {
  const repo = initialized("contract-closed");
  const twoCriteria = {
    ...ticket("closed-work"),
    acceptance: [
      { acceptance_id: "works", criterion: "closed-work behavior is observed." },
      { acceptance_id: "holds", criterion: "closed-work invariants hold.", authority: "human" },
    ],
  };
  assert.equal(run(repo, "ticket", "apply", { tickets: [twoCriteria, ticket("open-work")] }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence("closed-proof", "closed-work", ["works", "holds"], { origin: "human" })).status, 0);
  assert.equal(run(repo, "ticket", "closeout", outcome("closed-work", "successful", ["works", "holds"], [], ["closed-proof"])).status, 0);
  const before = readFileSync(join(repo, ".vibehub", "tickets", "closed-work.yaml"), "utf8");

  // Criterion text, authority, and membership changes are each refused with
  // the stable code beside origin_immutable.
  const reworded = {
    ...twoCriteria,
    acceptance: twoCriteria.acceptance.map((item) =>
      item.acceptance_id === "works" ? { ...item, criterion: "closed-work behavior is observed differently." } : item),
  };
  const rewordedError = applyError(repo, [reworded]);
  assert.equal(rewordedError.code, "contract_closed");
  assert.match(rewordedError.message, /closed and cannot be changed/u);
  assert.deepEqual(rewordedError.details.violations.map((item) => [item.code, item.ticket_id, item.changed_acceptance_ids]), [
    ["contract_closed", "closed-work", ["works"]],
  ]);
  assert.equal(rewordedError.details.violations[0].candidate_path, "tickets[0].acceptance");
  assert.equal(rewordedError.details.violations[0].ticket_path, join(repo, ".vibehub", "tickets", "closed-work.yaml"));
  assert.match(rewordedError.details.violations[0].existing_contract_digest, HEX_64);

  const reauthored = {
    ...twoCriteria,
    acceptance: twoCriteria.acceptance.map((item) =>
      item.acceptance_id === "holds" ? { ...item, authority: "agent" } : item),
  };
  assert.equal(applyError(repo, [reauthored]).code, "contract_closed");

  const regrown = {
    ...twoCriteria,
    acceptance: [...twoCriteria.acceptance, { acceptance_id: "extra", criterion: "An appended criterion." }],
  };
  const regrownError = applyError(repo, [regrown]);
  assert.equal(regrownError.code, "contract_closed");
  assert.deepEqual(regrownError.details.violations[0].changed_acceptance_ids, ["extra"]);

  // One refused candidate refuses the whole batch before anything is written.
  const batch = applyError(repo, [ticket("batch-newcomer"), reworded]);
  assert.equal(batch.code, "contract_closed");
  assert.ok(!existsSync(join(repo, ".vibehub", "tickets", "batch-newcomer.yaml")), "nothing from the refused batch is written");
  assert.equal(readFileSync(join(repo, ".vibehub", "tickets", "closed-work.yaml"), "utf8"), before);

  // Context, constraints, refs, relations, deliveries and provenance edits
  // still apply to the closed Ticket.
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  const annotated = {
    ...twoCriteria,
    context: "Rewritten context after closure.",
    constraints: ["A sharpened constraint."],
    context_refs: [{ ref: "README.md", purpose: "Post-closure reference." }],
    relations: [{ type: "depends_on", target_ticket_id: "open-work", rationale: "Recorded late." }],
    deliveries: [{
      kind: "pull_request",
      ref: "https://github.com/VW-ai/vibehub-plugin/pull/9999",
      state: "delivered",
      delivered_at: NOW,
      delivered_commit: "d".repeat(40),
    }],
    provenance_refs: ["conversation:post-closure"],
  };
  const annotatedApplied = run(repo, "ticket", "apply", { tickets: [annotated] });
  assert.equal(annotatedApplied.status, 0, annotatedApplied.stdout);

  // The host path refuses identically.
  const host = hostError(() => applyTickets({ repo, tickets: [reworded] }));
  assert.equal(host.code, "contract_closed");
  assert.deepEqual({ code: host.code, message: host.message, details: host.details }, applyError(repo, [reworded]));

  // A non-successful Outcome leaves the contract open for replanning.
  assert.equal(run(repo, "ticket", "closeout", outcome("open-work", "failed", [], ["works"])).status, 0);
  const replanned = {
    ...ticket("open-work"),
    acceptance: [{ acceptance_id: "works", criterion: "open-work behavior is observed after replanning." }],
  };
  assert.equal(run(repo, "ticket", "apply", { tickets: [replanned] }).status, 0);
});

test("stale Evidence stops satisfying coverage under the binding-aware format", () => {
  const repo = initialized("binding-stale-coverage");
  const mixed = {
    ...ticket("stale-work"),
    acceptance: [
      { acceptance_id: "agent-check", criterion: "The agent-checkable behavior is observed." },
      { acceptance_id: "owner-check", criterion: "The owner approves the behavior.", authority: "human" },
    ],
  };
  assert.equal(run(repo, "ticket", "apply", { tickets: [mixed] }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence("agent-proof", "stale-work", ["agent-check"])).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence("owner-proof", "stale-work", ["owner-check"], { origin: "human" })).status, 0);
  assert.equal(run(repo, "ticket", "get", { ticket_id: "stale-work" }).envelope.data.next_action.action, "CLOSE_OUT");

  // The agent criterion is revised: its recorded binding digest no longer
  // matches, so the coverage row stops counting it.
  rewriteCriterion(repo, "stale-work", "agent-check", "The agent-checkable behavior is observed and reproducible.");
  setFormat(repo, 3);
  const staleAction = run(repo, "ticket", "get", { ticket_id: "stale-work" }).envelope.data.next_action;
  assert.equal(staleAction.action, "EXECUTE");
  assert.equal(staleAction.reason, "acceptance_evidence_incomplete");
  assert.deepEqual(staleAction.acceptance_ids, ["agent-check"]);
  assert.match(staleAction.detail, /agent-check.*superseded criterion revisions/u);
  assert.deepEqual(staleAction.proof.stale_acceptance_ids, ["agent-check"]);
  const staleEntry = staleAction.proof.acceptance.find((item) => item.acceptance_id === "agent-check");
  assert.deepEqual(
    [staleEntry.coverage, staleEntry.covered, staleEntry.stale_evidence_ids],
    ["stale", false, ["agent-proof"]],
  );
  assert.equal(staleAction.proof.acceptance.find((item) => item.acceptance_id === "owner-check").coverage, "native");

  // A stale human-origin record no longer satisfies human authority either.
  rewriteCriterion(repo, "stale-work", "owner-check", "The owner approves the revised behavior.");
  const humanAction = run(repo, "ticket", "get", { ticket_id: "stale-work" }).envelope.data.next_action;
  assert.equal(humanAction.action, "NEEDS_HUMAN");
  assert.equal(humanAction.reason, "missing_human_evidence");
  assert.deepEqual(humanAction.acceptance_ids, ["owner-check"]);
  assert.match(humanAction.detail, /owner-check.*superseded criterion revisions/u);

  // The legacy interpretation — the rollback state — still counts the same
  // records without deleting a single binding.
  setFormat(repo, 2);
  const rolledBack = run(repo, "ticket", "get", { ticket_id: "stale-work" }).envelope.data.next_action;
  assert.equal(rolledBack.action, "CLOSE_OUT");
  assert.equal(rolledBack.proof.mode, "legacy");
});

test("an unresolved successful Outcome stops DONE, archive, unlock and CLOSE_OUT and projects REPLAN", () => {
  const repo = initialized("binding-unresolved-outcome");
  const delivered = {
    ...ticket("done-work"),
    deliveries: [{
      kind: "pull_request",
      ref: "https://github.com/VW-ai/vibehub-plugin/pull/4242",
      state: "delivered",
      delivered_at: NOW,
      delivered_commit: "e".repeat(40),
    }],
  };
  assert.equal(run(repo, "ticket", "apply", { tickets: [delivered, ticket("dependent-work", ["done-work"])] }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence("done-proof", "done-work", ["works"])).status, 0);
  assert.equal(run(repo, "ticket", "closeout", outcome("done-work", "successful", ["works"], [], ["done-proof"])).status, 0);

  setFormat(repo, 3);
  const graph = run(repo, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data;
  const doneRow = graph.tickets.find((item) => item.ticket.ticket_id === "done-work");
  assert.equal(doneRow.status, "DONE");
  assert.equal(doneRow.archived, true);
  assert.equal(doneRow.next_action.action, "DONE");
  assert.equal(doneRow.next_action.proof.outcome.binding, "native");
  assert.equal(doneRow.next_action.proof.outcome.state, "current");
  assert.equal(graph.tickets.find((item) => item.ticket.ticket_id === "dependent-work").next_action.action, "EXECUTE");

  // The contract drifts underneath the recorded binding: the successful
  // Outcome becomes unresolved without touching its file.
  rewriteCriterion(repo, "done-work", "works", "done-work behavior is observed under the revised contract.");
  const drifted = run(repo, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data;
  const driftedRow = drifted.tickets.find((item) => item.ticket.ticket_id === "done-work");
  assert.equal(driftedRow.status, "READY", "the unresolved Outcome no longer projects DONE");
  assert.equal(driftedRow.archived, false, "archive membership needs an accepted Outcome");
  assert.equal(driftedRow.next_action.action, "REPLAN");
  assert.equal(driftedRow.next_action.reason, "unresolved_legacy_outcome");
  assert.deepEqual(driftedRow.next_action.acceptance_ids, ["works"]);
  assert.match(driftedRow.next_action.detail, /contract-drifted-since-addition/u);
  assert.deepEqual(
    [driftedRow.next_action.proof.outcome.state, driftedRow.next_action.proof.outcome.reason],
    ["unresolved", "contract-drifted-since-addition"],
  );
  const dependentRow = drifted.tickets.find((item) => item.ticket.ticket_id === "dependent-work");
  assert.equal(dependentRow.status, "BLOCKED", "an unresolved Outcome stops dependent unlock");
  assert.deepEqual(dependentRow.blocking_ticket_ids, ["done-work"]);
  assert.equal(dependentRow.next_action.action, "WAIT");
  const frontier = run(repo, "ticket", "frontier").envelope.data;
  assert.deepEqual(frontier.needs_replan.map((item) => item.ticket.ticket_id), ["done-work"]);
  assert.deepEqual(frontier.waiting.map((item) => item.ticket.ticket_id), ["dependent-work"]);

  // The Outcome file itself stays readable and untouched.
  const stored = JSON.parse(readFileSync(join(repo, ".vibehub", "outcomes", "done-work.yaml"), "utf8"));
  assert.equal(stored.status, "successful");
  assert.equal(run(repo, "ticket", "validate").envelope.data.valid, true);

  // Host projections share the same acceptance gate.
  const repository = loadRepository(repo);
  assert.equal(outcomeAccepted(repository, "done-work"), null);
  assert.equal(ticketStatus(repository, repository.tickets.documents.get("done-work").document), "READY");
  assert.equal(
    ticketNextAction(repository, repository.tickets.documents.get("done-work").document).reason,
    "unresolved_legacy_outcome",
  );
  assert.equal(
    ticketProofState(repository, repository.tickets.documents.get("done-work").document).outcome.state,
    "unresolved",
  );

  // Rollback to the legacy interpretation restores DONE without deleting the
  // recorded binding.
  setFormat(repo, 2);
  const restored = run(repo, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data;
  const restoredRow = restored.tickets.find((item) => item.ticket.ticket_id === "done-work");
  assert.equal(restoredRow.status, "DONE");
  assert.equal(restoredRow.archived, true);
  assert.equal(restoredRow.next_action.action, "DONE");
  assert.deepEqual(
    JSON.parse(readFileSync(join(repo, ".vibehub", "outcomes", "done-work.yaml"), "utf8")).contract_binding,
    stored.contract_binding,
  );
});

test("a stored unresolved marker projects REPLAN naming the recorded drifted ids", () => {
  const repo = initialized("binding-marker");
  const pair = {
    ...ticket("marked-work"),
    acceptance: [
      { acceptance_id: "first", criterion: "The first behavior is observed." },
      { acceptance_id: "second", criterion: "The second behavior is observed." },
    ],
  };
  assert.equal(run(repo, "ticket", "apply", { tickets: [pair] }).status, 0);
  assert.equal(run(repo, "ticket", "evidence", evidence("marked-proof", "marked-work", ["first", "second"])).status, 0);
  assert.equal(run(repo, "ticket", "closeout", outcome("marked-work", "successful", ["first", "second"], [], ["marked-proof"])).status, 0);
  // A reconstruction-style unresolved marker reaches the tree the way the
  // migration writes it: directly, without rewriting anything else.
  const path = join(repo, ".vibehub", "outcomes", "marked-work.yaml");
  const document = JSON.parse(readFileSync(path, "utf8"));
  document.contract_binding = {
    binding: "reconstructed",
    digest: document.contract_binding.digest,
    unresolved: { reason: "contract-drifted-since-addition", acceptance_ids: ["second"] },
  };
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  setFormat(repo, 3);
  assert.equal(run(repo, "ticket", "validate").envelope.data.valid, true);
  const action = run(repo, "ticket", "get", { ticket_id: "marked-work" }).envelope.data.next_action;
  assert.equal(action.action, "REPLAN");
  assert.equal(action.reason, "unresolved_legacy_outcome");
  assert.deepEqual(action.acceptance_ids, ["second"]);
  assert.deepEqual(
    [action.proof.outcome.binding, action.proof.outcome.state, action.proof.outcome.reason],
    ["reconstructed", "unresolved", "contract-drifted-since-addition"],
  );
});
