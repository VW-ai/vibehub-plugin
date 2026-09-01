// Skill graph validation. Every failure mode is built on a throwaway skills
// tree in a temp directory so a case can declare a broken graph without
// touching the real one; the last case asserts the real repository passes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

const RENAME_LINE = `${RETIRED} became vibehub-alpha.`;

// The retired-name cases share one shape: the baseline graph, one retired entry,
// and whatever allowances the case is testing.
function retiredRepo(label, allowed_paths) {
  const repo = baseline(label);
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal" }),
  ], {
    retired: [{ name: RETIRED, replacement: "vibehub-alpha", reason: "Renamed.", allowed_paths }],
  });
  return repo;
}

const PROSE_ALLOWANCE = [{
  path: "docs/RENAME.md",
  text: RENAME_LINE,
  reason: "Prose describing the retirement.",
}];

test("a retired name in a live reference fails, and the exempt classes do not", () => {
  const repo = retiredRepo("skill-graph-retired", PROSE_ALLOWANCE);

  // Exempt: the named occurrence in allowlisted prose, the archive directories,
  // a closed Ticket, a META/legacy-* tree, and a Context evidence[].ref that
  // records a past proof.
  write(repo, "docs/RENAME.md", `${RENAME_LINE}\n`);
  write(repo, ".vibehub/evidence/ticket-old/proof.yaml", `{"note": "${RETIRED}"}\n`);
  // The Outcome has to say `successful`: that is what makes the Ticket beside it
  // a closed record rather than a live document. The earlier version of this
  // case wrote an Outcome with no status at all and expected the Ticket to be
  // exempt, which encoded the bug that any Outcome counts as closed.
  write(repo, ".vibehub/outcomes/ticket-closed.yaml", `{"status": "successful", "note": "${RETIRED}"}\n`);
  write(repo, ".vibehub/history/snapshot/old.yaml", `{"note": "${RETIRED}"}\n`);
  write(repo, "META/legacy-ui/note.md", `Named skills/${RETIRED}/SKILL.md then.\n`);
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

// A filename never earns an exemption. Both of these used to pass: a date-shaped
// basename was read as "record", and a legacy- segment counted at any depth, so
// anyone could date-prefix or reparent a live file to silence the rule.
test("a META filename cannot buy an exemption", () => {
  const repo = retiredRepo("skill-graph-retired-meta-name", []);

  write(repo, "META/room/artifacts/2026-01-02-note.md", `See skills/${RETIRED}/SKILL.md.\n`);
  assert.match(messages(validate(repo)), /2026-01-02-note\.md: Live reference to retired Skill/u);

  write(repo, "META/room/artifacts/2026-01-02-note.md", "clean\n");
  write(repo, "META/room/legacy-notes/live.md", `See skills/${RETIRED}/SKILL.md.\n`);
  assert.match(messages(validate(repo)), /legacy-notes\/live\.md: Live reference to retired Skill/u);

  // Only the segment directly under META/ is an archive, and only as a
  // directory: META/legacy-note.md is a file wearing the name.
  write(repo, "META/room/legacy-notes/live.md", "clean\n");
  write(repo, "META/legacy-note.md", `See skills/${RETIRED}/SKILL.md.\n`);
  assert.match(messages(validate(repo)), /META\/legacy-note\.md: Live reference to retired Skill/u);
});

// The property the old allowlist did not have: being listed excuses the named
// occurrence, not the file around it.
test("an allowance excuses one occurrence, not the file it sits in", () => {
  const repo = retiredRepo("skill-graph-retired-per-occurrence", PROSE_ALLOWANCE);
  write(repo, "docs/RENAME.md", `${RENAME_LINE}\n`);
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));

  // A live reference appended to the allowlisted file.
  write(repo, "docs/RENAME.md", `${RENAME_LINE}\nlive: read ../${RETIRED}/assets/app.js at runtime\n`);
  assert.match(messages(validate(repo)), /docs\/RENAME\.md: Live reference to retired Skill .* \(1 unexcused occurrence\)/u);

  // An exact duplicate of the excused line is a second occurrence the allowance
  // does not name: one allowance, one occurrence, unless it says otherwise.
  write(repo, "docs/RENAME.md", `${RENAME_LINE}\n${RENAME_LINE}\n`);
  assert.match(messages(validate(repo)), /docs\/RENAME\.md: Live reference to retired Skill/u);

  // Near miss: the text an entry names must match exactly.
  write(repo, "docs/RENAME.md", `${RETIRED} became  vibehub-alpha.\n`);
  const near = messages(validate(repo));
  assert.match(near, /docs\/RENAME\.md no longer contains the excused text/u);
  assert.match(near, /docs\/RENAME\.md: Live reference to retired Skill/u);
});

test("an open Ticket is live, and an unnamed $-invocation fails inside an allowlisted file", () => {
  const repo = retiredRepo("skill-graph-retired-live", PROSE_ALLOWANCE);
  write(repo, "docs/RENAME.md", `${RENAME_LINE}\n`);
  write(repo, ".vibehub/tickets/ticket-open.yaml", `{"note": "${RETIRED}"}\n`);
  assert.match(messages(validate(repo)), /\.vibehub\/tickets\/ticket-open\.yaml: Live reference to retired Skill/u);

  write(repo, ".vibehub/tickets/ticket-open.yaml", '{"note": "clean"}\n');
  write(repo, "docs/RENAME.md", `${RENAME_LINE}\nnever call $${RETIRED}.\n`);
  assert.match(messages(validate(repo)), /docs\/RENAME\.md: Retired Skill .* is invoked as/u);
});

// The rule allows an allowance to name a $-invocation and say why. In this
// layout it can never be used: the contract itself lives under
// skills/vibehub-core/, so the moment an allowance quotes a $-invocation the
// reference check sees a $-reference to a Skill that no longer has a folder and
// rejects it there. A retired name therefore cannot be called anywhere, which is
// stricter than the rule requires, and the second half of the case shows the
// per-occurrence accounting is still what decides it.
test("naming a $-invocation in an allowance is itself rejected", () => {
  const call = `migration note: $${RETIRED} is gone; call $vibehub-alpha`;
  const repo = retiredRepo("skill-graph-retired-named-call", [{
    path: "docs/RENAME.md",
    text: call,
    reason: "A migration note has to show the old call to be useful.",
  }]);
  write(repo, "docs/RENAME.md", `${call}\n`);
  assert.match(messages(validate(repo)), /\$vibehub-old-alpha names a Skill that does not exist under skills\//u);

  // With the allowance withdrawn, the same file fails as an invocation.
  graph(repo, [
    declare("vibehub-core", { entry: "infrastructure" }),
    declare("vibehub-alpha", { invokes: ["vibehub-beta"] }),
    declare("vibehub-beta", { entry: "internal" }),
  ], { retired: [{ name: RETIRED, replacement: "vibehub-alpha", reason: "Renamed.", allowed_paths: [] }] });
  assert.match(messages(validate(repo)), /docs\/RENAME\.md: Retired Skill .* is invoked as/u);
});

// Context's source.ref/evidence[].ref exemption belongs to Context documents,
// not to two field names any JSON file could adopt.
test("only a Context document may claim the recorded-ref exemption", () => {
  const repo = retiredRepo("skill-graph-retired-ref-class", []);
  const body = (kind) => `${JSON.stringify({ kind, source: { ref: `skills/${RETIRED}/assets/app.js` } }, null, 2)}\n`;

  write(repo, ".vibehub/rooms/product/decision-x.yaml", body("context"));
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));

  // Same fields, not a Context: a live config outside .vibehub/rooms/.
  write(repo, "assets/config.json", body("context"));
  assert.match(messages(validate(repo)), /assets\/config\.json: Live reference to retired Skill/u);

  write(repo, "assets/config.json", "{}\n");
  write(repo, ".vibehub/rooms/product/note.yaml", body("note"));
  assert.match(messages(validate(repo)), /\.vibehub\/rooms\/product\/note\.yaml: Live reference to retired Skill/u);
});

test("a stale allowance fails: missing file, missing text, or a moved count", () => {
  const gone = retiredRepo("skill-graph-stale-allowance", [{
    path: "docs/GONE.md",
    text: RENAME_LINE,
    reason: "Stale.",
  }]);
  assert.match(messages(validate(gone)), /docs\/GONE\.md no longer contains/u);

  const moved = retiredRepo("skill-graph-stale-text", PROSE_ALLOWANCE);
  write(moved, "docs/RENAME.md", `${RETIRED} was renamed.\n`);
  assert.match(messages(validate(moved)), /docs\/RENAME\.md no longer contains the excused text/u);

  const counted = retiredRepo("skill-graph-stale-count", [{ ...PROSE_ALLOWANCE[0], occurrences: 2 }]);
  write(counted, "docs/RENAME.md", `${RENAME_LINE}\n`);
  assert.match(messages(validate(counted)), /carries 1 occurrence of .* but the allowance names 2/u);
});

// The shape rules exist so an allowance cannot be widened back into a file pass.
test("an allowance may not be shaped into a blanket exemption", () => {
  const noText = retiredRepo("skill-graph-allowance-no-text", [{ path: "docs/RENAME.md", reason: "No text." }]);
  write(noText, "docs/RENAME.md", `${RENAME_LINE}\n`);
  assert.match(messages(validate(noText)), /needs a path, the exact text it excuses, and a reason/u);

  const unrelated = retiredRepo("skill-graph-allowance-unrelated", [{
    path: "docs/RENAME.md",
    text: "became vibehub-alpha",
    reason: "Names no retired text.",
  }]);
  write(unrelated, "docs/RENAME.md", `${RENAME_LINE}\n`);
  assert.match(messages(validate(unrelated)), /does not contain vibehub-old-alpha, so it excuses nothing/u);

  const span = retiredRepo("skill-graph-allowance-span", [{
    path: "docs/RENAME.md",
    text: `${RENAME_LINE}\nand more.`,
    reason: "The whole file.",
  }]);
  write(span, "docs/RENAME.md", `${RENAME_LINE}\nand more.\n`);
  assert.match(messages(validate(span)), /must be a single line/u);

  const directory = retiredRepo("skill-graph-allowance-directory", [{
    path: "docs/",
    text: RENAME_LINE,
    reason: "A directory, not a file.",
  }]);
  write(directory, "docs/RENAME.md", `${RENAME_LINE}\n`);
  const messagesOut = messages(validate(directory));
  assert.match(messagesOut, /docs\/ no longer contains/u);
  assert.match(messagesOut, /docs\/RENAME\.md: Live reference to retired Skill/u);

  const negative = retiredRepo("skill-graph-allowance-count", [{ ...PROSE_ALLOWANCE[0], occurrences: 0 }]);
  write(negative, "docs/RENAME.md", `${RENAME_LINE}\n`);
  assert.match(messages(validate(negative)), /occurrences must be a positive integer/u);
});

// A Ticket is a closed record only once its Outcome says `successful`. A
// partial, failed or deviated Outcome means the work is still live, so the
// Ticket YAML is a live document — including the Ticket whose own criterion is
// the one being adjudicated, which used to be excused by its own failure.
test("only a successful Outcome turns a Ticket into a historical record", () => {
  const repo = retiredRepo("skill-graph-retired-outcome-status", []);
  write(repo, ".vibehub/tickets/ticket-x.yaml", `{"note": "${RETIRED}"}\n`);

  for (const status of ["partial", "failed", "deviated"]) {
    write(repo, ".vibehub/outcomes/ticket-x.yaml", `{"status": "${status}"}\n`);
    assert.match(
      messages(validate(repo)),
      /\.vibehub\/tickets\/ticket-x\.yaml: Live reference to retired Skill/u,
      `a ${status} Outcome must not silence its Ticket`,
    );
  }

  // An Outcome with no status at all is not a closure either.
  write(repo, ".vibehub/outcomes/ticket-x.yaml", '{"note": "no status"}\n');
  assert.match(messages(validate(repo)), /ticket-x\.yaml: Live reference to retired Skill/u);

  write(repo, ".vibehub/outcomes/ticket-x.yaml", '{"status": "successful"}\n');
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));
});

// The contract is not exempt from its own rule. It legitimately carries the
// retired name in three parsed fields — each retired entry's name and
// replacement, and each allowance's text — and those are subtracted
// structurally. Everything else in the file is scanned like any other file.
test("the contract file is scanned like any other file", () => {
  const repo = retiredRepo("skill-graph-contract-scanned", PROSE_ALLOWANCE);
  write(repo, "docs/RENAME.md", `${RENAME_LINE}\n`);
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));

  // A stray key in the contract holding a live path. Under the old per-file
  // skip this passed, in the one file the rule is defined in.
  const contract = JSON.parse(readFileSync(join(repo, CONTRACT), "utf8"));
  contract.probe_live_reference = `../${RETIRED}/assets/app.js`;
  write(repo, CONTRACT, `${JSON.stringify(contract, null, 2)}\n`);
  assert.match(
    messages(validate(repo)),
    /skill-graph\.json: Live reference to retired Skill .* \(1 unexcused occurrence\)/u,
  );

  // An allowance's `reason` is prose, not an excused field: quoting a live path
  // there fails too.
  delete contract.probe_live_reference;
  contract.retired[0].allowed_paths[0].reason = `Kept because skills/${RETIRED}/assets/app.js is still read.`;
  write(repo, CONTRACT, `${JSON.stringify(contract, null, 2)}\n`);
  assert.match(messages(validate(repo)), /skill-graph\.json: Live reference to retired Skill/u);
});

// `name` and `replacement` are the two fields whose raw spans the contract scan
// subtracts, so their grammar is what bounds that subtraction. A bare kebab-case
// Skill name — the grammar every folder under skills/ follows — carries no path
// separator, whitespace, quote, or trailing punctuation, so nothing that is not
// a Skill name can be parked there and exempted by key position. A `replacement`
// that is not a Skill name is also useless as the guidance the error prints.
test("a retired name and replacement must each be a bare Skill name", () => {
  const wellFormed = retiredRepo("skill-graph-retired-token-ok", PROSE_ALLOWANCE);
  write(wellFormed, "docs/RENAME.md", `${RENAME_LINE}\n`);
  assert.equal(validate(wellFormed).ok, true, JSON.stringify(validate(wellFormed)));

  // Each case sets one field to something that is not a Skill name.
  const rejected = [
    ["name", `../${RETIRED}/assets/app-nowhere-else.js`],
    ["name", `skills/${RETIRED}/SKILL.md`],
    ["name", `${RETIRED} (renamed)`],
    ["replacement", `vibehub-alpha (the old skills/${RETIRED}/ folder is gone)`],
    ["replacement", "vibehub-alpha/assets/app.js"],
    ["replacement", "vibehub-alpha\nvibehub-beta"],
    ["replacement", "\"vibehub-alpha\""],
    ["replacement", "vibehub-alpha."],
    ["replacement", "Vibehub-Alpha"],
  ];
  for (const [key, value] of rejected) {
    const repo = retiredRepo(`skill-graph-retired-token-${key}-${value.length}`, PROSE_ALLOWANCE);
    write(repo, "docs/RENAME.md", `${RENAME_LINE}\n`);
    const contract = JSON.parse(readFileSync(join(repo, CONTRACT), "utf8"));
    contract.retired[0][key] = value;
    write(repo, CONTRACT, `${JSON.stringify(contract, null, 2)}\n`);
    assert.match(
      messages(validate(repo)),
      new RegExp(`retired\\[0\\]\\.${key}: must be a bare lowercase kebab-case Skill name`, "u"),
      `${key} = ${JSON.stringify(value)} should have been rejected`,
    );
  }
});

// An allowance text that is merely the bare name matches any occurrence in the
// file, so swapping an excused prose mention for a live path would keep the
// count at one and still pass.
test("an allowance text must be narrower than the retired name itself", () => {
  for (const text of [RETIRED, `  ${RETIRED}\t`, `${RETIRED} ${RETIRED}`]) {
    const repo = retiredRepo(`skill-graph-bare-${text.length}`, [{
      path: "docs/RENAME.md",
      text,
      reason: "Bare name.",
    }]);
    write(repo, "docs/RENAME.md", `live: ../${RETIRED}/assets/app.js\n`);
    assert.match(messages(validate(repo)), /is no narrower than vibehub-old-alpha itself/u);
  }
});

// Two allowances whose texts overlap the same occurrence used to subtract two,
// which bought the file one silent live reference elsewhere. Spans are consumed,
// not counted.
test("overlapping allowances cannot excuse the same occurrence twice", () => {
  const repo = retiredRepo("skill-graph-overlap", [
    { path: "docs/RENAME.md", text: `note ${RETIRED}`, reason: "Left half." },
    { path: "docs/RENAME.md", text: `${RETIRED} here`, reason: "Right half." },
  ]);
  write(repo, "docs/RENAME.md", `note ${RETIRED} here\nlive: ../${RETIRED}/assets/app.js\n`);
  const out = messages(validate(repo));
  assert.match(out, /docs\/RENAME\.md: Live reference to retired Skill .* \(1 unexcused occurrence\)/u);
});

// A differently-cased path is the same folder on a case-insensitive filesystem
// and the same name to a reader.
test("a case-varied reference to the retired name fails", () => {
  const repo = retiredRepo("skill-graph-case", []);
  write(repo, "docs/CASE.md", "See skills/Vibehub-Old-Alpha/SKILL.md.\n");
  assert.match(messages(validate(repo)), /docs\/CASE\.md: Case-variant reference to retired Skill/u);
});

// Git checks a symlink in as a blob holding its target path, so that path is
// checked-in content. The walk does not follow it and still cannot leave the
// root.
test("a symlink's target path is scanned as checked-in content", () => {
  const repo = retiredRepo("skill-graph-symlink", []);
  mkdirSync(join(repo, "docs"), { recursive: true });
  symlinkSync(`../skills/${RETIRED}/assets/app.js`, join(repo, "docs", "app.js"));
  assert.match(messages(validate(repo)), /docs\/app\.js: Live reference to retired Skill/u);
});

// One NUL byte used to classify a whole file as binary and skip it.
test("a NUL byte does not hide a live reference", () => {
  const repo = retiredRepo("skill-graph-nul", []);
  write(repo, "docs/NUL.md", `See skills/${RETIRED}/SKILL.md.\n\0\n`);
  assert.match(messages(validate(repo)), /docs\/NUL\.md: Live reference to retired Skill/u);
});

// Allowance texts are matched literally, never compiled as patterns.
test("an allowance text carrying regex metacharacters is matched literally", () => {
  const line = `note (a+b)* ${RETIRED} [x] $y | .*`;
  const repo = retiredRepo("skill-graph-regex-text", [{
    path: "docs/RX.md",
    text: line,
    reason: "Metacharacters in prose.",
  }]);
  write(repo, "docs/RX.md", `${line}\n`);
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));

  // It excuses that one occurrence and nothing else.
  write(repo, "docs/RX.md", `${line}\nlive: ../${RETIRED}/assets/app.js\n`);
  assert.match(messages(validate(repo)), /docs\/RX\.md: Live reference to retired Skill .* \(1 unexcused occurrence\)/u);
});

// The Context ref exemption removes the parsed field values, so a ref that
// spells the name only after JSON unescaping cannot spend its subtraction on a
// live prose mention elsewhere in the same document.
test("the Context ref exemption is structural, not a count", () => {
  const repo = retiredRepo("skill-graph-ref-structural", []);
  // RETIRED carries no "r", so the previous `.replace("r", ...)` was a no-op and
  // the ref went in unescaped: the laundering half of this case never ran. That
  // encoded a bug -- it asserted a defence that was never exercised.
  const escaped = `skills/${RETIRED.replace("a", "\\u0061")}/SKILL.md`;
  write(
    repo,
    ".vibehub/rooms/product/decision-y.yaml",
    `{"kind": "context", "summary": "live prose: read skills/${RETIRED}/SKILL.md today", "source": {"ref": "${escaped}"}}\n`,
  );
  assert.match(messages(validate(repo)), /decision-y\.yaml: Live reference to retired Skill/u);

  // The honest shape still passes: the ref records the proof, the prose is clean.
  write(
    repo,
    ".vibehub/rooms/product/decision-y.yaml",
    `{"kind": "context", "summary": "clean", "source": {"ref": "skills/${RETIRED}/SKILL.md"}}\n`,
  );
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));
});

test("a retired entry needs a non-empty name", () => {
  const repo = retiredRepo("skill-graph-empty-name", []);
  const contract = JSON.parse(readFileSync(join(repo, CONTRACT), "utf8"));
  contract.retired[0].name = "";
  write(repo, CONTRACT, `${JSON.stringify(contract, null, 2)}\n`);
  assert.match(messages(validate(repo)), /needs a non-empty name and its replacement/u);
});

// The directories the scan skips are build output. The list is hardcoded rather
// than derived from .gitignore, so this case fails the moment the two drift:
// anything skipped but not gitignored could hold a tracked live reference.
test("the scan skip list matches .gitignore", () => {
  const source = readFileSync(helper, "utf8");
  const declared = source.match(/const SKILL_SCAN_SKIP = new Set\(\[([^\]]*)\]\)/u);
  assert.ok(declared, "SKILL_SCAN_SKIP is declared as a literal set");
  const skipped = [...declared[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  const ignored = readFileSync(join(root, ".gitignore"), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith("/") && !line.startsWith("#") && !line.startsWith("!"))
    .map((line) => line.replace(/\/$/u, "").replace(/^\//u, ""));
  assert.deepEqual([...skipped].sort(), [".git", ...ignored].sort());
});

test("the checked-in skill graph is development-time only", () => {
  const contract = JSON.parse(readFileSync(join(root, CONTRACT), "utf8"));
  assert.equal(contract.runtime_role, "none");
  assert.equal(contract.owner, "vibehub-core");
  assert.ok(contract.retired.some((entry) => entry.replacement === "vibehub-review"));
  // Every real allowance names an occurrence, not a file.
  for (const entry of contract.retired) {
    for (const allowance of entry.allowed_paths ?? []) {
      assert.ok(allowance.text.includes(entry.name), `${allowance.path} allowance names no occurrence`);
      assert.ok(!/[\n\r]/u.test(allowance.text), `${allowance.path} allowance spans lines`);
      assert.ok(allowance.reason.length > 0);
    }
  }
  // No Skill reads the contract, and the command records nothing in .vibehub/.
  const helperSource = readFileSync(helper, "utf8");
  assert.equal(helperSource.includes("writeDocument(join(repo, \".vibehub\""), false);
  assert.match(helperSource, /Development-time validation only/u);
});

// Everything below attacks the raw-bytes rule directly. The legitimate fields of
// a Context document and of the contract are exempted by consuming THEIR RAW
// SPANS out of the checked-in text. Scanning a re-serialisation of the parse
// instead -- which is what the previous implementation did -- made every byte
// JSON.parse discards invisible, and a shadowed duplicate key is exactly such a
// byte.

const CONTEXT_PATH = ".vibehub/rooms/product/decision-dup.yaml";

test("a duplicate JSON key cannot smuggle a live path into a Context document", () => {
  const repo = retiredRepo("skill-graph-ctx-dup-key", []);

  // Control: the ordinary path works. A plain extra key holding a live path fails.
  write(
    repo,
    CONTEXT_PATH,
    `{"kind": "context", "probe": "../${RETIRED}/assets/app.js", "source": {"ref": "skills/${RETIRED}/SKILL.md"}}\n`,
  );
  assert.match(messages(validate(repo)), /decision-dup\.yaml: Live reference to retired Skill/u);

  // Attack: the same live path under a SHADOWED duplicate of the document's own
  // first key. JSON.parse keeps only the later value, so a re-serialised scan
  // never saw these bytes -- but they are in the file, in plain ASCII.
  write(
    repo,
    CONTEXT_PATH,
    `{"kind": "../${RETIRED}/assets/app.js", "kind": "context", "source": {"ref": "skills/${RETIRED}/SKILL.md"}}\n`,
  );
  assert.match(messages(validate(repo)), /decision-dup\.yaml: Live reference to retired Skill/u);

  // And a shadowed duplicate of the exempt field itself: only the surviving
  // ref's span is consumed, so the shadowed one is unexplained content.
  write(
    repo,
    CONTEXT_PATH,
    `{"kind": "context", "source": {"ref": "../${RETIRED}/assets/app.js", "ref": "skills/${RETIRED}/SKILL.md"}}\n`,
  );
  assert.match(messages(validate(repo)), /decision-dup\.yaml: Live reference to retired Skill/u);

  // The honest shape still passes.
  write(repo, CONTEXT_PATH, `{"kind": "context", "source": {"ref": "skills/${RETIRED}/SKILL.md"}}\n`);
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));
});

test("a duplicate JSON key cannot smuggle a live path into the contract", () => {
  const repo = retiredRepo("skill-graph-contract-dup-key", []);
  const raw = readFileSync(join(repo, CONTRACT), "utf8");
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));

  // A duplicate of an existing top-level key whose SHADOWED value is a live path.
  write(repo, CONTRACT, raw.replace(
    '"owner": "vibehub-core"',
    `"owner": "../${RETIRED}/assets/app.js",\n  "owner": "vibehub-core"`,
  ));
  assert.match(
    messages(validate(repo)),
    /skill-graph\.json: Live reference to retired Skill .* \(1 unexcused occurrence\)/u,
  );

  // A duplicate of an EXEMPT field: retired[].replacement. Only the surviving
  // value's span is consumed.
  write(repo, CONTRACT, raw.replace(
    '"replacement": "vibehub-alpha"',
    `"replacement": "../${RETIRED}/assets/app.js",\n      "replacement": "vibehub-alpha"`,
  ));
  assert.match(messages(validate(repo)), /skill-graph\.json: Live reference to retired Skill/u);
});

// A parsed field value is consumed as the SPAN it occupies, not as "every
// occurrence of this string". A ref that happens to equal a live prose mention
// elsewhere in the same document excuses only itself.
test("an exempt ref excuses its own span, not every copy of its text", () => {
  const repo = retiredRepo("skill-graph-ctx-same-text", []);
  const path = `skills/${RETIRED}/SKILL.md`;
  write(
    repo,
    CONTEXT_PATH,
    `{"kind": "context", "summary": "today you must still read ${path}", "source": {"ref": "${path}"}}\n`,
  );
  assert.match(
    messages(validate(repo)),
    /decision-dup\.yaml: Live reference to retired Skill .* \(1 unexcused occurrence\)/u,
  );
});

// JSON escaping: the raw bytes of the exempt field can be spelled in ways the
// parsed value is not. Consuming the SPAN makes the two agree by construction.
test("JSON escaping in an exempt ref changes nothing", () => {
  const repo = retiredRepo("skill-graph-ctx-escapes", []);
  const escapedName = RETIRED.replace("a", "\\u0061");
  const cases = [
    // Escaped solidi -- legal JSON, and the raw bytes differ from the value.
    `{"kind": "context", "source": {"ref": "skills\\/${RETIRED}\\/SKILL.md"}}`,
    // A \u escape inside the name: the parsed value spells the retired name, the
    // raw bytes never do. This is the laundering shape, and the span is consumed
    // either way.
    `{"kind": "context", "source": {"ref": "skills/${escapedName}/SKILL.md"}}`,
    // A quote inside the value.
    `{"kind": "context", "source": {"ref": "the \\"skills/${RETIRED}/SKILL.md\\" file"}}`,
    // A value that appears zero times literally in the raw text: every character
    // of the name is escaped.
    `{"kind": "context", "source": {"ref": "${[...`skills/${RETIRED}/SKILL.md`].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"}}`,
  ];
  for (const body of cases) {
    write(repo, CONTEXT_PATH, `${body}\n`);
    assert.equal(validate(repo).ok, true, `${body}\n${JSON.stringify(validate(repo))}`);

    // Adding one live prose mention alongside still fails: the escape buys no
    // credit that can be spent elsewhere.
    write(repo, CONTEXT_PATH, `${body.slice(0, -1)}, "summary": "read skills/${RETIRED}/SKILL.md"}\n`);
    assert.match(
      messages(validate(repo)),
      /decision-dup\.yaml: Live reference to retired Skill .* \(1 unexcused occurrence\)/u,
      body,
    );
  }
});

// Not-JSON, and JSON with trailing content after the closing brace, both lose the
// exemption entirely: the file is scanned whole rather than skipped.
test("an unparseable Context document is scanned whole, not skipped", () => {
  const repo = retiredRepo("skill-graph-ctx-unparseable", []);
  for (const body of [
    `{"kind": "context", "source": {"ref": "skills/${RETIRED}/SKILL.md"},}`,
    `{"kind": "context", "source": {"ref": "skills/${RETIRED}/SKILL.md"}} trailing`,
    `{"kind": "context", "source": {"ref": "skills/${RETIRED}/SKILL.md"}}{"kind": "context"}`,
    `not json at all: skills/${RETIRED}/SKILL.md`,
  ]) {
    write(repo, CONTEXT_PATH, `${body}\n`);
    assert.match(messages(validate(repo)), /decision-dup\.yaml: Live reference to retired Skill/u, body);
  }
});

// An unparseable contract cannot reach the retired-name scan at all: the command
// reads it with readDocument first and refuses the whole run.
test("an unparseable contract is refused before anything is exempted", () => {
  const repo = retiredRepo("skill-graph-contract-unparseable", []);
  const raw = readFileSync(join(repo, CONTRACT), "utf8");
  write(repo, CONTRACT, `${raw.trimEnd()} trailing\n`);
  const envelope = validate(repo);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "invalid_document");
});

// A `__proto__` member is an own property to JSON.parse. The positional parser
// has to agree, or a document carrying one would be reported as a parser
// disagreement it is not -- and a live path beside it must still fail.
test("a __proto__ member is not mistaken for a parser disagreement", () => {
  const repo = retiredRepo("skill-graph-ctx-proto", []);
  write(
    repo,
    CONTEXT_PATH,
    `{"kind": "context", "__proto__": {"x": 1}, "source": {"ref": "skills/${RETIRED}/SKILL.md"}}\n`,
  );
  assert.equal(validate(repo).ok, true, JSON.stringify(validate(repo)));

  write(
    repo,
    CONTEXT_PATH,
    `{"kind": "context", "__proto__": "../${RETIRED}/assets/app.js", "source": {"ref": "skills/${RETIRED}/SKILL.md"}}\n`,
  );
  assert.match(messages(validate(repo)), /decision-dup\.yaml: Live reference to retired Skill/u);
});

// The positional parser is recursive, so a document nested far deeper than any
// real Context document exhausts the stack where JSON.parse does not. That must
// be LOUD and must consume nothing: the exemption is reported as not applied and
// the file is scanned whole. A silent skip here would be the next bypass.
test("a document the positional parser cannot handle fails loudly and is still scanned", () => {
  const repo = retiredRepo("skill-graph-ctx-deep", []);
  const deep = `${"[".repeat(20000)}1${"]".repeat(20000)}`;
  write(
    repo,
    CONTEXT_PATH,
    `{"kind": "context", "deep": ${deep}, "source": {"ref": "skills/${RETIRED}/SKILL.md"}}\n`,
  );
  const out = messages(validate(repo));
  assert.match(out, /decision-dup\.yaml: Legitimate-field exemption not applied/u);
  assert.match(out, /decision-dup\.yaml: Live reference to retired Skill/u);
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
