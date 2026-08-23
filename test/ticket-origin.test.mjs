import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  VibeHubError,
  appendEvidence,
  applyTickets,
  putContext,
  validateTicket,
} from "../skills/vibehub-core/scripts/vh.mjs";
import { buildTicketHandoff, buildUiSnapshot } from "../skills/vibehub-core/scripts/vh-ui.mjs";
import { context, room, root, run, tempRepo, ticket, writeRoom } from "./helpers.mjs";

const SHA = "c".repeat(64);
const AT = "2026-08-22T09:30:00.000Z";

function origin(overrides = {}) {
  return {
    harness: "codex",
    thread_id: "thr_0195f2a1",
    forked_from_id: null,
    turn_id: "turn_7",
    item_id: "item_12",
    selection: { start: 14, end: 96, text_sha256: SHA },
    captured_at: AT,
    ...overrides,
  };
}

function born(id, overrides = {}) {
  return { ...ticket(id), maturity: "draft", origin: origin(overrides) };
}

function initialized(label) {
  const repo = tempRepo(label);
  assert.equal(run(repo, "project", "init").status, 0);
  return repo;
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
  assert.fail("expected the host path to refuse");
}

test("the schema gains exactly one optional origin object on schema_version 2", () => {
  const schema = JSON.parse(readFileSync(join(root, "skills", "vibehub-core", "contracts", "ticket.schema.json"), "utf8"));
  assert.equal(schema.$id, "https://vibehub.dev/schemas/ticket.v2.json");
  assert.equal(schema.properties.schema_version.const, 2);
  assert.equal(schema.properties.kind.const, "ticket");
  assert.deepEqual(Object.keys(schema.properties), [
    "schema_version", "kind", "ticket_id", "maturity", "outcome", "deliveries", "context",
    "acceptance", "constraints", "context_refs", "relations", "provenance_refs", "origin",
  ]);
  assert.ok(!schema.required.includes("origin"), "origin stays optional; omission is the only compatibility rule");
  assert.match(schema.properties.origin.description, /never derived from Thread names, previews, or transcripts/u);
  const definition = schema.$defs.origin;
  assert.equal(definition.type, "object");
  assert.equal(definition.additionalProperties, false);
  assert.deepEqual(definition.required, ["harness", "thread_id", "forked_from_id", "turn_id", "item_id", "selection", "captured_at"]);
  assert.deepEqual(definition.properties.harness.enum, ["codex"]);
  assert.deepEqual(definition.properties.forked_from_id.oneOf, [{ $ref: "#/$defs/text" }, { type: "null" }]);
  assert.deepEqual(definition.properties.item_id.oneOf, [{ $ref: "#/$defs/text" }, { type: "null" }]);
  const [nullSelection, selection] = definition.properties.selection.oneOf;
  assert.deepEqual(nullSelection, { type: "null" });
  assert.equal(selection.additionalProperties, false);
  assert.deepEqual(selection.required, ["start", "end", "text_sha256"]);
  assert.deepEqual(selection.properties.start, { type: "integer", minimum: 0 });
  assert.equal(selection.properties.end.minimum, 0);
  assert.deepEqual(selection.properties.text_sha256, { $ref: "#/$defs/sha256" });
  assert.equal(schema.$defs.sha256.pattern, "^[0-9a-f]{64}$");
  assert.deepEqual(definition.properties.captured_at, { type: "string", format: "date-time" });
});

test("every checked-in Ticket of this repository validates unchanged without an origin", () => {
  const validated = run(root, "ticket", "validate");
  assert.equal(validated.status, 0, validated.stdout);
  assert.equal(validated.envelope.data.valid, true);
  assert.ok(validated.envelope.data.ticket_count > 0);
  const graph = run(root, "ticket", "graph", undefined, ["--scope", "all"]).envelope.data;
  assert.equal(graph.count, validated.envelope.data.ticket_count);
  assert.ok(graph.tickets.every((item) => item.ticket.origin === undefined), "no existing Ticket carries an origin");
});

test("a Ticket born with a well-formed origin applies, validates, and reads back verbatim", () => {
  const repo = initialized("origin-valid");
  const forked = born("forked-selection", { forked_from_id: "thr_parent", item_id: null, selection: null });
  const applied = run(repo, "ticket", "apply", { tickets: [born("from-turn"), forked, ticket("plain")] });
  assert.equal(applied.status, 0, applied.stdout);
  assert.deepEqual(applied.envelope.data.ticket_ids, ["from-turn", "forked-selection", "plain"]);
  assert.equal(run(repo, "ticket", "validate").envelope.data.valid, true);
  assert.equal(run(repo, "project", "validate").envelope.data.valid, true);
  const read = run(repo, "ticket", "get", { ticket_id: "from-turn" }).envelope.data;
  assert.deepEqual(read.ticket.origin, origin());
  assert.equal(read.status, "REFINE");
  assert.deepEqual(run(repo, "ticket", "get", { ticket_id: "forked-selection" }).envelope.data.ticket.origin, forked.origin);
  assert.equal(run(repo, "ticket", "get", { ticket_id: "plain" }).envelope.data.ticket.origin, undefined);
  const stored = JSON.parse(readFileSync(join(repo, ".vibehub", "tickets", "from-turn.yaml"), "utf8"));
  assert.deepEqual(stored.origin, origin());
  assert.deepEqual(validateTicket(born("direct")), []);
});

test("a malformed origin is rejected with an exact path and message", () => {
  const repo = initialized("origin-malformed");
  const cases = [
    [{ selection: { start: 0, end: 4, text_sha256: "deadbeef" } }, /origin\.selection\.text_sha256.*64 lowercase hex/u],
    [{ selection: { start: 0, end: 4, text_sha256: SHA.toUpperCase() } }, /origin\.selection\.text_sha256.*64 lowercase hex/u],
    [{ selection: { start: 9, end: 3, text_sha256: SHA } }, /origin\.selection\.end.*greater than or equal to start/u],
    [{ selection: { start: -1, end: 3, text_sha256: SHA } }, /origin\.selection\.start.*non-negative integer/u],
    [{ selection: { start: 0, end: 1.5, text_sha256: SHA } }, /origin\.selection\.end.*non-negative integer/u],
    [{ selection: { start: 0, end: 4, text_sha256: SHA, text: "quoted" } }, /origin\.selection\.text.*not allowed/u],
    [{ selection: { start: 0, end: 4 } }, /origin\.selection\.text_sha256/u],
    [{ selection: "0-4" }, /origin\.selection.*must be an object/u],
    [{ turn_id: undefined }, /origin\.turn_id.*non-empty string/u],
    [{ turn_id: "" }, /origin\.turn_id.*non-empty string/u],
    [{ thread_id: 7 }, /origin\.thread_id.*non-empty string/u],
    [{ harness: "claude" }, /origin\.harness.*must equal codex/u],
    [{ forked_from_id: "" }, /origin\.forked_from_id.*non-empty string or null/u],
    [{ item_id: 3 }, /origin\.item_id.*non-empty string or null/u],
    [{ captured_at: "yesterday" }, /origin\.captured_at.*ISO-compatible/u],
    [{ thread_name: "Chat about origins" }, /origin\.thread_name.*not allowed/u],
    [{ preview: "derived from transcript" }, /origin\.preview.*not allowed/u],
  ];
  for (const [override, expected] of cases) {
    const candidate = born("bad", override);
    for (const key of Object.keys(override)) if (override[key] === undefined) delete candidate.origin[key];
    const error = applyError(repo, [candidate]);
    assert.equal(error.code, "validation_error", JSON.stringify(error));
    assert.match(JSON.stringify(error.details.errors), expected);
    assert.ok(!existsSync(join(repo, ".vibehub", "tickets", "bad.yaml")), "a rejected candidate writes nothing");
  }
  const missingSelection = born("bad");
  delete missingSelection.origin.selection;
  assert.match(JSON.stringify(applyError(repo, [missingSelection]).details.errors), /origin\.selection.*object or null/u);
  assert.match(JSON.stringify(applyError(repo, [{ ...ticket("bad"), origin: null }]).details.errors), /tickets\[0\]\.origin.*must be an object/u);
  assert.match(JSON.stringify(applyError(repo, [{ ...ticket("bad"), origin: "thr_1/turn_1" }]).details.errors), /tickets\[0\]\.origin.*must be an object/u);
  assert.deepEqual(
    validateTicket({ ...ticket("direct"), origin: origin({ harness: "deepseek" }) }).map((item) => item.path),
    ["ticket.origin.harness"],
  );
});

test("ticket validate rejects a malformed origin that reached the tree by hand", () => {
  const repo = initialized("origin-on-disk");
  assert.equal(run(repo, "ticket", "apply", { tickets: [born("healthy")] }).status, 0);
  const path = join(repo, ".vibehub", "tickets", "tampered.yaml");
  writeFileSync(path, `${JSON.stringify(born("tampered", { selection: { start: 4, end: 1, text_sha256: SHA } }), null, 2)}\n`);
  const validated = run(repo, "ticket", "validate");
  assert.notEqual(validated.status, 0);
  assert.equal(validated.envelope.error.code, "validation_error");
  assert.match(JSON.stringify(validated.envelope.error.details.errors), /tampered\.yaml\.origin\.selection\.end/u);
  assert.equal(run(repo, "project", "validate").envelope.error.code, "validation_error");
  assert.throws(() => buildUiSnapshot(repo), (error) => error.code === "validation_error");
});

test("origin is immutable once a Ticket is checked in", () => {
  const repo = initialized("origin-immutable");
  assert.equal(run(repo, "ticket", "apply", { tickets: [born("from-turn"), ticket("plain")] }).status, 0);
  const before = readFileSync(join(repo, ".vibehub", "tickets", "from-turn.yaml"), "utf8");

  // The same origin may be re-applied: planning rewrites the contract, never the birth.
  const refined = { ...born("from-turn"), maturity: "firm", outcome: "Refined outcome after planning." };
  assert.equal(run(repo, "ticket", "apply", { tickets: [refined] }).status, 0);
  const firmed = run(repo, "ticket", "get", { ticket_id: "from-turn" }).envelope.data;
  assert.equal(firmed.status, "READY");
  assert.deepEqual(firmed.ticket.origin, origin());
  const afterRefinement = readFileSync(join(repo, ".vibehub", "tickets", "from-turn.yaml"), "utf8");
  assert.notEqual(afterRefinement, before, "the legitimate refinement was written");

  const changed = applyError(repo, [born("from-turn", { turn_id: "turn_8" })]);
  assert.equal(changed.code, "origin_immutable");
  assert.match(changed.message, /cannot be changed/u);
  assert.deepEqual(changed.details.violations.map((item) => [item.code, item.ticket_id, item.candidate_path]), [
    ["origin_immutable", "from-turn", "tickets[0].origin"],
  ]);
  assert.deepEqual(changed.details.violations[0].existing_origin, origin());
  assert.deepEqual(changed.details.violations[0].candidate_origin, origin({ turn_id: "turn_8" }));
  assert.equal(changed.details.violations[0].ticket_path, join(repo, ".vibehub", "tickets", "from-turn.yaml"));

  const removed = applyError(repo, [{ ...refined, origin: undefined }]);
  assert.equal(removed.code, "origin_immutable");
  assert.match(removed.message, /cannot be removed/u);
  assert.equal(removed.details.violations[0].candidate_origin, null);

  const reselected = applyError(repo, [born("from-turn", { selection: null })]);
  assert.equal(reselected.code, "origin_immutable");

  const added = applyError(repo, [{ ...ticket("plain"), origin: origin() }]);
  assert.equal(added.code, "origin_cannot_be_added");
  assert.match(added.message, /already checked in without an origin/u);
  assert.equal(added.details.violations[0].existing_origin, null);
  assert.deepEqual(added.details.violations[0].candidate_origin, origin());

  // One refused candidate refuses the whole batch before anything is written.
  const batch = applyError(repo, [born("newborn"), { ...ticket("plain"), origin: origin() }, born("from-turn", { item_id: null })]);
  assert.equal(batch.code, "origin_cannot_be_added", "the first violation names the error code");
  assert.deepEqual(batch.details.violations.map((item) => [item.code, item.ticket_id]), [
    ["origin_cannot_be_added", "plain"],
    ["origin_immutable", "from-turn"],
  ]);
  assert.ok(!existsSync(join(repo, ".vibehub", "tickets", "newborn.yaml")), "nothing from the refused batch is written");
  assert.equal(readFileSync(join(repo, ".vibehub", "tickets", "from-turn.yaml"), "utf8"), afterRefinement, "the checked-in Ticket is untouched");

  // A brand-new Ticket may be born with an origin at any time.
  assert.equal(run(repo, "ticket", "apply", { tickets: [born("newborn")] }).status, 0);
  assert.deepEqual(run(repo, "ticket", "get", { ticket_id: "newborn" }).envelope.data.ticket.origin, origin());
});

test("host paths built on applyTickets share the exact origin rules and exports", () => {
  const repo = initialized("origin-host");
  const written = applyTickets({ repo, tickets: [born("from-turn"), ticket("plain")] });
  assert.equal(written.status, "written");
  assert.deepEqual(written.ticket_ids, ["from-turn", "plain"]);
  assert.deepEqual(written.paths, ["from-turn", "plain"].map((id) => join(repo, ".vibehub", "tickets", `${id}.yaml`)));
  assert.deepEqual(written.advice, []);

  const changed = hostError(() => applyTickets({ repo, tickets: [born("from-turn", { thread_id: "thr_other" })] }));
  assert.equal(changed.code, "origin_immutable");
  assert.equal(changed.details.violations[0].ticket_id, "from-turn");
  assert.equal(hostError(() => applyTickets({ repo, tickets: [ticket("from-turn")] })).code, "origin_immutable");
  assert.equal(hostError(() => applyTickets({ repo, tickets: [{ ...ticket("plain"), origin: origin() }] })).code, "origin_cannot_be_added");
  const malformed = hostError(() => applyTickets({ repo, tickets: [born("bad", { turn_id: "" })] }));
  assert.equal(malformed.code, "validation_error");
  assert.match(JSON.stringify(malformed.details.errors), /tickets\[0\]\.origin\.turn_id/u);
  assert.equal(hostError(() => applyTickets({ repo, tickets: [] })).message, "ticket apply needs a non-empty tickets array");
  assert.equal(hostError(() => applyTickets({ repo: tempRepo("origin-uninitialized"), tickets: [born("x")] })).code, "format_mismatch");

  const evidence = appendEvidence({
    repo,
    evidence: {
      schema_version: 1,
      kind: "ticket_evidence",
      evidence_id: "from-turn-proof",
      ticket_id: "from-turn",
      acceptance_ids: ["works"],
      summary: "The born Ticket behavior was observed.",
      refs: ["test:origin-host"],
      recorded_at: AT,
    },
  });
  assert.equal(evidence.status, "written");
  assert.equal(evidence.path, join(repo, ".vibehub", "evidence", "from-turn", "from-turn-proof.yaml"));
  assert.equal(hostError(() => appendEvidence({ repo, evidence: { kind: "ticket_evidence" } })).code, "validation_error");

  writeRoom(repo, "product", room("product"));
  const remembered = putContext({ repo, room: "product", context: context({ context_id: "decision-remembered" }) });
  assert.deepEqual(remembered, {
    status: "written",
    context_id: "decision-remembered",
    room: "product",
    path: join(repo, ".vibehub", "rooms", "product", "decision-remembered.yaml"),
  });
  assert.equal(hostError(() => putContext({ repo, context: context() })).code, "invalid_input");
  assert.equal(hostError(() => putContext({ repo, room: "missing", context: context() })).code, "not_found");
  assert.equal(hostError(() => putContext({ repo, room: "../escape", context: context() })).code, "invalid_argument");
  assert.equal(hostError(() => putContext({ repo, room: "product", context: { kind: "context" } })).code, "validation_error");
  assert.equal(run(repo, "project", "validate").envelope.data.valid, true);
  const recorded = run(repo, "ticket", "get", { ticket_id: "from-turn" }).envelope.data;
  assert.deepEqual(recorded.evidence.map((item) => item.evidence_id), ["from-turn-proof"]);
  assert.deepEqual(recorded.ticket.origin, origin());
});

test("the CLI and the host entry refuse the same batch identically", () => {
  const repo = initialized("origin-parity");
  assert.equal(run(repo, "ticket", "apply", { tickets: [ticket("plain")] }).status, 0);
  const candidates = [{ ...ticket("plain"), origin: origin() }];
  const cli = applyError(repo, candidates);
  const host = hostError(() => applyTickets({ repo, tickets: candidates }));
  assert.deepEqual({ code: host.code, message: host.message, details: host.details }, cli);
});

test("the graph and handoff projections carry origin verbatim and read-only", () => {
  const repo = initialized("origin-projection");
  assert.equal(run(repo, "ticket", "apply", { tickets: [born("from-turn"), ticket("plain", ["from-turn"])] }).status, 0);
  const snapshot = buildUiSnapshot(repo);
  const node = snapshot.state.graph.tickets.find((item) => item.ticketId === "from-turn");
  assert.deepEqual(node.origin, origin());
  assert.equal(node.capabilities.operational.summary.label, "REFINE");
  const plain = snapshot.state.graph.tickets.find((item) => item.ticketId === "plain");
  assert.equal(plain.origin, null);
  assert.deepEqual(snapshot.state.graph.relations.map((item) => [item.prerequisiteTicketId, item.dependentTicketId]), [["from-turn", "plain"]]);

  const handoff = buildTicketHandoff(repo, "from-turn");
  assert.equal(handoff.kind, "vibehub_ticket_handoff");
  assert.deepEqual(handoff.origin, origin());
  assert.equal(handoff.maturity, "draft");
  assert.equal(buildTicketHandoff(repo, "plain").origin, null);

  const graph = run(repo, "ticket", "graph").envelope.data;
  assert.deepEqual(graph.tickets.find((item) => item.ticket.ticket_id === "from-turn").ticket.origin, origin());
  assert.equal(run(repo, "ticket", "frontier").envelope.data.needs_refinement[0].ticket.origin.turn_id, "turn_7");

  // The projection never invents an origin: nothing in the projection is derived from a Thread name or preview.
  node.origin.turn_id = "turn_mutated";
  assert.deepEqual(buildUiSnapshot(repo).state.graph.tickets.find((item) => item.ticketId === "from-turn").origin, origin());
});
