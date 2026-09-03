import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { context, room, run, tempRepo, writeRoom } from "./helpers.mjs";

// One file with four sections, the shape the Peel rerun hit: sibling rooms have
// to own topical slices of a single document or per-room accountability is lost.
const PRD = [
  "Draft PRD.",
  "",
  "# Positioning",
  "",
  "why the product exists",
  "",
  "# Domain model",
  "",
  "the objects",
  "",
  "# Fork flow",
  "",
  "branch from here",
];

function writeSource(repo, relative, lines) {
  const path = join(repo, ...relative.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  return relative;
}

function prdRepo(label) {
  const repo = tempRepo(label);
  assert.equal(run(repo, "project", "init").status, 0);
  writeSource(repo, "docs/prd.md", PRD);
  return repo;
}

function sh(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function gitPrdRepo(label) {
  const repo = tempRepo(label);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "test@vibehub.dev");
  sh(repo, "config", "user.name", "VibeHub Test");
  assert.equal(run(repo, "project", "init").status, 0);
  writeSource(repo, "docs/prd.md", PRD);
  return repo;
}

test("a room may anchor one segment of a file and answers only for that segment", () => {
  const repo = prdRepo("segment-anchor-one");
  writeRoom(repo, "fork-flow", room("fork-flow", { anchors: ["docs/prd.md#fork-flow"] }));

  const validated = run(repo, "project", "validate");
  assert.equal(validated.status, 0, validated.stdout);

  const data = run(repo, "context", "coverage").envelope.data;
  assert.equal(data.rooms.length, 1);
  assert.deepEqual(data.rooms[0].files, [
    { path: "docs/prd.md", skipped: null, segment_count: 1, uncovered: ["docs/prd.md#fork-flow"] },
  ]);
  assert.equal(data.segments_total, 1);
  assert.equal(data.uncovered_total, 1);
  assert.deepEqual(data.rooms[0].unresolved_anchors, []);
});

test("sibling rooms split one file into disjoint segments and their coverage sums to the whole", () => {
  const repo = prdRepo("segment-anchor-siblings");
  writeRoom(repo, "product", room("product", { anchors: ["docs/prd.md#_preamble"] }));
  writeRoom(repo, "positioning", room("positioning", { anchors: ["docs/prd.md#positioning"] }));
  writeRoom(repo, "domain-model", room("domain-model", { anchors: ["docs/prd.md#domain-model"] }));
  writeRoom(repo, "fork-flow", room("fork-flow", { anchors: ["docs/prd.md#fork-flow"] }));

  const validated = run(repo, "project", "validate");
  assert.equal(validated.status, 0, validated.stdout);

  const whole = run(repo, "source", "segment", undefined, ["--path", "docs/prd.md"]).envelope.data;
  const data = run(repo, "context", "coverage").envelope.data;
  assert.equal(data.segments_total, whole.segment_count);

  // Every segment of the file is owned by exactly one room.
  const owned = data.rooms.flatMap((item) => item.files.flatMap((file) => file.uncovered));
  assert.deepEqual([...owned].sort(), whole.segments.map((item) => item.id).sort());
  assert.equal(new Set(owned).size, owned.length);

  // Each room reports its own uncovered segments, not the file's.
  const scoped = run(repo, "context", "coverage", undefined, ["--room", "positioning"]).envelope.data;
  assert.deepEqual(scoped.rooms.map((item) => item.room), ["positioning"]);
  assert.deepEqual(scoped.rooms[0].files[0].uncovered, ["docs/prd.md#positioning"]);
  assert.equal(scoped.uncovered_total, 1);
});

test("two rooms claiming one segment, and a segment inside a sibling's prefix, are both rejected", () => {
  const same = prdRepo("segment-anchor-same");
  writeRoom(same, "positioning", room("positioning", { anchors: ["docs/prd.md#positioning"] }));
  writeRoom(same, "strategy", room("strategy", { anchors: ["docs/prd.md#positioning"] }));
  const collided = run(same, "project", "validate");
  assert.notEqual(collided.status, 0);
  assert.match(JSON.stringify(collided.envelope.error.details), /claim overlapping territory/);
  assert.match(JSON.stringify(collided.envelope.error.details), /docs\/prd\.md#positioning/);

  const inside = prdRepo("segment-anchor-inside-prefix");
  writeRoom(inside, "docs-owner", room("docs-owner", { anchors: ["docs"] }));
  writeRoom(inside, "positioning", room("positioning", { anchors: ["docs/prd.md#positioning"] }));
  const swallowed = run(inside, "project", "validate");
  assert.notEqual(swallowed.status, 0);
  assert.match(JSON.stringify(swallowed.envelope.error.details), /claim overlapping territory/);

  // The same anchor under a parent room is containment, not collision.
  const nested = prdRepo("segment-anchor-nested");
  writeRoom(nested, "docs-owner", room("docs-owner", { anchors: ["docs"] }));
  writeRoom(nested, "docs-owner/positioning", room("positioning", { anchors: ["docs/prd.md#positioning"] }));
  assert.equal(run(nested, "project", "validate").status, 0);

  // Disjoint segments of the same file never collide.
  const disjoint = prdRepo("segment-anchor-disjoint");
  writeRoom(disjoint, "positioning", room("positioning", { anchors: ["docs/prd.md#positioning"] }));
  writeRoom(disjoint, "domain-model", room("domain-model", { anchors: ["docs/prd.md#domain-model"] }));
  assert.equal(run(disjoint, "project", "validate").status, 0);
});

test("one coverage_exception settles its segment wherever it is counted, without duplication", () => {
  const repo = prdRepo("segment-anchor-exception");
  writeRoom(repo, "product", room("product", {
    anchors: ["docs/prd.md#_preamble"],
    coverage_exceptions: [
      { segment: "docs/prd.md#_preamble", reason: "front matter carries no claim" },
      { segment: "docs/prd.md#domain-model", reason: "restated verbatim in the positioning section" },
    ],
  }));
  writeRoom(repo, "domain-model", room("domain-model", { anchors: ["docs/prd.md#domain-model"] }));
  assert.equal(run(repo, "project", "validate").status, 0);

  const data = run(repo, "context", "coverage").envelope.data;
  assert.equal(data.uncovered_total, 0);
  // The exception is declared once, in the room that owns the preamble, and it
  // still settles the segment counted in the sibling room.
  const owner = data.rooms.find((item) => item.room === "domain-model");
  assert.deepEqual(owner.files[0].uncovered, []);
  assert.equal(owner.files[0].segment_count, 1);
  assert.equal(run(repo, "context", "coverage", undefined, ["--room", "domain-model"]).envelope.data.uncovered_total, 0);
});

test("a citation covers a segment anchored by another room, as citations already do", () => {
  const repo = prdRepo("segment-anchor-citation");
  writeRoom(repo, "positioning", room("positioning", { anchors: ["docs/prd.md#positioning"] }));
  writeRoom(repo, "domain-model", room("domain-model", { anchors: ["docs/prd.md#domain-model"] }));
  const captured = run(repo, "context", "put", context({
    source: { ref: "docs/prd.md#domain-model", quote: "the objects", captured_at: "2026-09-01T00:00:00.000Z" },
  }), ["--room", "positioning"]);
  assert.equal(captured.status, 0, captured.stdout);

  const data = run(repo, "context", "coverage", undefined, ["--room", "domain-model"]).envelope.data;
  assert.equal(data.uncovered_total, 0);
});

test("an anchor naming a segment that does not exist is reported, not silently empty", () => {
  const repo = prdRepo("segment-anchor-unresolved");
  writeRoom(repo, "typo", room("typo", { anchors: ["docs/prd.md#frok-flow", "docs/gone.md#intro"] }));
  assert.equal(run(repo, "project", "validate").status, 0);

  const data = run(repo, "context", "coverage").envelope.data;
  assert.deepEqual(data.rooms[0].unresolved_anchors, ["docs/gone.md#intro", "docs/prd.md#frok-flow"]);
  assert.equal(data.segments_total, 0);
});

test("a room anchoring segments drifts on its own segments and not on the rest of the file", () => {
  const repo = gitPrdRepo("segment-anchor-drift");
  writeRoom(repo, "fork-flow", room("fork-flow", { anchors: ["docs/prd.md#fork-flow"] }));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "baseline");

  const aligned = run(repo, "room", "align", undefined, ["--room", "fork-flow"]);
  assert.equal(aligned.status, 0, aligned.stdout);
  assert.equal(aligned.envelope.data.aligned_files, 1);
  const stamped = run(repo, "room", "drift").envelope.data.rooms.find((item) => item.room === "fork-flow");
  assert.equal(stamped.state, "FRESH");

  // Another section of the same file changes: the anchored segment's bytes are
  // untouched, so this room is not drifted.
  const edited = [...PRD];
  edited[4] = "why the product exists, restated";
  writeSource(repo, "docs/prd.md", edited);
  assert.equal(run(repo, "room", "drift").envelope.data.rooms.find((item) => item.room === "fork-flow").state, "FRESH");

  // The anchored section changes: drifted, and named by segment id.
  const forked = [...edited];
  forked[12] = "branch from here, with an execution location";
  writeSource(repo, "docs/prd.md", forked);
  const drifted = run(repo, "room", "drift").envelope.data.rooms.find((item) => item.room === "fork-flow");
  assert.equal(drifted.state, "DRIFTED");
  assert.deepEqual(drifted.changed, ["docs/prd.md#fork-flow"]);

  // Renaming the anchored heading removes the segment the room was aligned to.
  const renamed = [...forked];
  renamed[10] = "# Forking";
  writeSource(repo, "docs/prd.md", renamed);
  const gone = run(repo, "room", "drift").envelope.data.rooms.find((item) => item.room === "fork-flow");
  assert.equal(gone.state, "DRIFTED");
  assert.deepEqual(gone.deleted, ["docs/prd.md#fork-flow"]);
});

test("a path-prefix room still stamps file paths and blob hashes, unchanged", () => {
  const repo = gitPrdRepo("segment-anchor-prefix-unchanged");
  writeRoom(repo, "docs-owner", room("docs-owner", { anchors: ["docs"] }));
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "baseline");
  assert.equal(run(repo, "room", "align", undefined, ["--room", "docs-owner"]).status, 0);

  const stamp = JSON.parse(spawnSync("cat", [join(repo, ".vibehub", "rooms", "docs-owner", "room.yaml")], { encoding: "utf8" }).stdout);
  assert.deepEqual(stamp.alignment.anchor_hashes.map((item) => item.path), ["docs/prd.md"]);
  assert.equal(stamp.alignment.anchor_hashes[0].blob, sh(repo, "hash-object", "docs/prd.md"));

  const edited = [...PRD];
  edited[4] = "why the product exists, restated";
  writeSource(repo, "docs/prd.md", edited);
  const drifted = run(repo, "room", "drift").envelope.data.rooms.find((item) => item.room === "docs-owner");
  assert.equal(drifted.state, "DRIFTED");
  assert.deepEqual(drifted.changed, ["docs/prd.md"]);
});

// --- A source file whose own path contains "#" -----------------------------
//
// `source segment` mints ids as `<file path>#<slug>`, so for docs/a#b.md it
// emits "docs/a#b.md#_preamble" — a string with two "#". Parsing that at the
// FIRST "#" read it as a segment of the nonexistent file "docs/a", which made
// the tool unable to parse the id it had just emitted.

function hashPathRepo(label) {
  const repo = tempRepo(label);
  assert.equal(run(repo, "project", "init").status, 0);
  writeSource(repo, "docs/a#b.md", ["Body of the hash-named file."]);
  return repo;
}

test("a segment of a file whose path contains # resolves from the id source segment emits", () => {
  const repo = hashPathRepo("segment-anchor-hash-path");
  const minted = run(repo, "source", "segment", undefined, ["--path", "docs/a#b.md"]).envelope.data;
  assert.deepEqual(minted.segments.map((item) => item.id), ["docs/a#b.md#_preamble"]);

  writeRoom(repo, "probe", room("probe", { anchors: [minted.segments[0].id] }));
  assert.equal(run(repo, "project", "validate").status, 0);

  const data = run(repo, "context", "coverage").envelope.data;
  assert.deepEqual(data.rooms[0].unresolved_anchors, []);
  assert.deepEqual(data.rooms[0].files, [
    { path: "docs/a#b.md", skipped: null, segment_count: 1, uncovered: ["docs/a#b.md#_preamble"] },
  ]);
  assert.equal(data.files_examined, 1);
  assert.equal(data.uncovered_total, 1);
});

test("a prefix anchor is judged against the real path, so docs/a does not own a segment of docs/a#b.md", () => {
  // "docs/a" is not a path-segment-boundary prefix of "docs/a#b.md", so the two
  // rooms name disjoint sets and must both be allowed to stand.
  const repo = hashPathRepo("segment-anchor-hash-no-collision");
  writeRoom(repo, "probe", room("probe", { anchors: ["docs/a#b.md#_preamble"] }));
  writeRoom(repo, "sib", room("sib", { anchors: ["docs/a"] }));
  const validated = run(repo, "project", "validate");
  assert.equal(validated.status, 0, validated.stdout);

  // And the same judgement at the write, not only in repository validation.
  const written = hashPathRepo("segment-anchor-hash-no-collision-write");
  writeRoom(written, "probe", room("probe", { anchors: ["docs/a#b.md#_preamble"] }));
  const put = run(written, "room", "put", room("sib", { anchors: ["docs/a"] }), ["--room", "sib"]);
  assert.equal(put.status, 0, put.stdout);
});

test("a prefix anchor that really does contain the segment's file still collides", () => {
  const repo = hashPathRepo("segment-anchor-hash-collision");
  writeRoom(repo, "probe", room("probe", { anchors: ["docs/a#b.md#_preamble"] }));
  writeRoom(repo, "wide", room("wide", { anchors: ["docs"] }));
  const swallowed = run(repo, "project", "validate");
  assert.notEqual(swallowed.status, 0);
  assert.match(JSON.stringify(swallowed.envelope.error.details), /claim overlapping territory/);

  const written = hashPathRepo("segment-anchor-hash-collision-write");
  writeRoom(written, "probe", room("probe", { anchors: ["docs/a#b.md#_preamble"] }));
  const put = run(written, "room", "put", room("wide", { anchors: ["docs"] }), ["--room", "wide"]);
  assert.notEqual(put.status, 0);
  assert.match(put.envelope.error.message, /claim overlapping territory \(docs\)/);
});

test("re-putting a room to add a coverage_exception keeps its drift state when alignment is carried through", () => {
  // The documented Pass 4 path: `room put` is a whole-document replace that
  // never stamps, so the caller must carry `alignment` through by hand. This
  // pins the behaviour the documentation now names — carried through, the stamp
  // survives; dropped, the room goes back to never-aligned.
  const repo = gitPrdRepo("segment-anchor-reput-alignment");
  const created = run(repo, "room", "put", room("fork-flow", { anchors: ["docs/prd.md#fork-flow"] }), ["--room", "fork-flow"]);
  assert.equal(created.status, 0, created.stdout);
  sh(repo, "add", "-A");
  sh(repo, "commit", "-qm", "baseline");
  assert.equal(run(repo, "room", "align", undefined, ["--room", "fork-flow"]).status, 0);

  const roomPath = join(repo, ".vibehub", "rooms", "fork-flow", "room.yaml");
  const stamped = JSON.parse(readFileSync(roomPath, "utf8"));
  assert.equal(run(repo, "room", "drift").envelope.data.rooms.find((item) => item.room === "fork-flow").state, "FRESH");

  const withException = {
    ...stamped,
    coverage_exceptions: [{ segment: "docs/prd.md#fork-flow", reason: "Restated in the domain model." }],
  };
  const reput = run(repo, "room", "put", withException, ["--room", "fork-flow"]);
  assert.equal(reput.status, 0, reput.stdout);
  const after = run(repo, "room", "drift").envelope.data.rooms.find((item) => item.room === "fork-flow");
  assert.equal(after.state, "FRESH");
  assert.deepEqual(JSON.parse(readFileSync(roomPath, "utf8")).alignment, stamped.alignment);
  assert.equal(run(repo, "context", "coverage").envelope.data.uncovered_total, 0);

  // Dropping the block is what the documentation warns about: no error, but the
  // room reports never-aligned. `room put` must not restore it implicitly.
  const dropped = { ...withException };
  delete dropped.alignment;
  assert.equal(run(repo, "room", "put", dropped, ["--room", "fork-flow"]).status, 0);
  assert.equal(JSON.parse(readFileSync(roomPath, "utf8")).alignment, undefined);
  assert.equal(run(repo, "room", "drift").envelope.data.rooms.find((item) => item.room === "fork-flow").state, "UNKNOWN");
});
