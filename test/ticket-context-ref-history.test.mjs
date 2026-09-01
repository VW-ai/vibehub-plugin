import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { room, run, tempRepo, ticket, writeRoom } from "./helpers.mjs";

const at = "2026-08-20T09:00:00.000Z";

function sh(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitRepo(label) {
  const repo = tempRepo(label);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@vibehub.dev");
  sh(repo, "config", "user.name", "VibeHub Test");
  assert.equal(run(repo, "project", "init").status, 0);
  return repo;
}

function closeSuccessfully(repo, ticketId) {
  assert.equal(run(repo, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: `${ticketId}-proof`,
    ticket_id: ticketId,
    acceptance_ids: ["works"],
    summary: `${ticketId} passed.`,
    refs: [`test:${ticketId}`],
    recorded_at: at,
  }).status, 0);
  assert.equal(run(repo, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: ticketId,
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: [`${ticketId}-proof`],
    summary: `${ticketId} independently passed.`,
    closed_at: at,
  }).status, 0);
}

// One closed Ticket whose only context ref lives at the old path, closed and
// committed while that path still existed.
function closedTicketOverARename(label) {
  const repo = gitRepo(label);
  mkdirSync(join(repo, "skills", "old-name"), { recursive: true });
  writeFileSync(join(repo, "skills", "old-name", "SKILL.md"), "# old\n");
  const done = ticket("read-the-old-path");
  done.context_refs = [{ ref: "skills/old-name/SKILL.md", purpose: "The surface this Ticket read." }];
  assert.equal(run(repo, "ticket", "apply", { tickets: [done] }).status, 0);
  closeSuccessfully(repo, "read-the-old-path");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "close read-the-old-path while skills/old-name still exists");
  return repo;
}

test("a closed Ticket's context ref resolves at its recorded commit after the path moves", () => {
  const repo = closedTicketOverARename("ticket-ref-rename");
  // The rename the record must survive: nothing under the old path remains.
  sh(repo, "mv", "skills/old-name", "skills/new-name");
  sh(repo, "commit", "-qm", "rename skills/old-name to skills/new-name");

  const validated = run(repo, "project", "validate");
  assert.equal(validated.status, 0, validated.stdout);
  assert.equal(validated.envelope.data.valid, true);
  assert.deepEqual(validated.envelope.data.unverifiable_context_refs, []);

  // The closed Ticket document itself was never rewritten to make this pass.
  const stored = JSON.parse(readFileSync(join(repo, ".vibehub", "tickets", "read-the-old-path.yaml"), "utf8"));
  assert.deepEqual(stored.context_refs.map((item) => item.ref), ["skills/old-name/SKILL.md"]);
  assert.equal(sh(repo, "status", "--porcelain", ".vibehub"), "");
});

test("a closed Ticket's context ref that exists nowhere still fails validation", () => {
  const repo = closedTicketOverARename("ticket-ref-nowhere");
  // Repoint the record at a path that exists in neither the working tree nor
  // any commit. Only the test constructs this; validation must not accept it.
  const ticketPath = join(repo, ".vibehub", "tickets", "read-the-old-path.yaml");
  const stored = JSON.parse(readFileSync(ticketPath, "utf8"));
  stored.context_refs = [{ ref: "skills/never-existed/SKILL.md", purpose: "Never written anywhere." }];
  writeFileSync(ticketPath, `${JSON.stringify(stored, null, 2)}\n`);
  sh(repo, "commit", "-aqm", "repoint the closed record at a path that never existed");

  const validated = run(repo, "project", "validate");
  assert.notEqual(validated.status, 0);
  assert.match(
    JSON.stringify(validated.envelope.error.details),
    /unreadable Ticket context ref: skills\/never-existed\/SKILL.md/u,
  );
});

test("an open Ticket with a dangling context ref still fails against the working tree", () => {
  const repo = closedTicketOverARename("ticket-ref-open");
  sh(repo, "mv", "skills/old-name", "skills/new-name");
  sh(repo, "commit", "-qm", "rename skills/old-name to skills/new-name");

  // Same ref, same commit history — but this Ticket has no Outcome, so its
  // context_refs are a live pointer and must resolve in the working tree.
  const open = ticket("about-to-read-the-old-path");
  open.context_refs = [{ ref: "skills/old-name/SKILL.md", purpose: "About to be read." }];
  const applied = run(repo, "ticket", "apply", { tickets: [open] });
  assert.notEqual(applied.status, 0);
  assert.match(
    JSON.stringify(applied.envelope.error.details),
    /unreadable Ticket context ref: skills\/old-name\/SKILL.md/u,
  );
});

test("a Room anchor stays a live pointer and still reports drift after the same rename", () => {
  const repo = closedTicketOverARename("ticket-ref-room-anchor");
  writeRoom(repo, "skills", room("skills", { anchors: ["skills/old-name"] }));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "anchor the skills room");
  const aligned = run(repo, "room", "align", undefined, ["--room", "skills"]);
  assert.equal(aligned.status, 0, aligned.stdout);
  assert.equal(aligned.envelope.data.aligned_files, 1);

  sh(repo, "mv", "skills/old-name", "skills/new-name");
  sh(repo, "commit", "-qm", "rename skills/old-name to skills/new-name");

  const drift = run(repo, "room", "drift");
  assert.equal(drift.status, 0, drift.stdout);
  const entry = drift.envelope.data.rooms.find((item) => item.room === "skills");
  assert.equal(entry.state, "DRIFTED");
  assert.deepEqual(entry.deleted, ["skills/old-name/SKILL.md"]);
});

test("without readable git history a closed Ticket's ref is unverifiable, not a failure", () => {
  const repo = closedTicketOverARename("ticket-ref-no-git");
  sh(repo, "mv", "skills/old-name", "skills/new-name");
  sh(repo, "commit", "-qm", "rename skills/old-name to skills/new-name");
  // What `git archive` produces, and what the suite's own fixtures look like:
  // the checked-in documents without any history behind them.
  rmSync(join(repo, ".git"), { recursive: true, force: true });

  const validated = run(repo, "project", "validate");
  assert.equal(validated.status, 0, validated.stdout);
  assert.equal(validated.envelope.data.valid, true);
  assert.equal(validated.envelope.data.unverifiable_context_refs.length, 1);
  assert.match(
    validated.envelope.data.unverifiable_context_refs[0].message,
    /unverifiable Ticket context ref: skills\/old-name\/SKILL.md/u,
  );
});
