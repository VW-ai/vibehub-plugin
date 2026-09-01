import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { context, room, run, tempRepo, writeRoom } from "./helpers.mjs";

const GUIDE = [
  "Intro line.",
  "",
  "# Alpha",
  "",
  "alpha body",
  "",
  "## Beta",
  "",
  "beta body",
  "",
  "```",
  "# not a heading",
  "```",
  "",
  "# Alpha",
  "",
  "second alpha",
];

function writeSource(repo, relative, lines) {
  const path = join(repo, ...relative.split("/"));
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
  return relative;
}

function segment(repo, relative) {
  const result = run(repo, "source", "segment", undefined, ["--path", relative]);
  assert.equal(result.status, 0, result.stdout);
  return result;
}

// Every line of the file belongs to exactly one segment, in order.
function assertContiguous(segments, lineCount) {
  let expected = 1;
  for (const item of segments) {
    assert.equal(item.start, expected, `gap or overlap before ${item.id}`);
    assert.ok(item.end >= item.start, `empty segment ${item.id}`);
    expected = item.end + 1;
  }
  assert.equal(expected - 1, lineCount);
}

function guideRepo(label) {
  const repo = tempRepo(label);
  assert.equal(run(repo, "project", "init").status, 0);
  writeSource(repo, "docs/guide.md", GUIDE);
  return repo;
}

test("markdown splits at heading boundaries and is byte-identical across runs", () => {
  const repo = guideRepo("segment-markdown");
  const first = segment(repo, "docs/guide.md");
  const data = first.envelope.data;

  assert.equal(data.strategy, "markdown-headings");
  assert.equal(data.lines, GUIDE.length);
  assert.deepEqual(data.segments.map((item) => item.id), [
    "docs/guide.md#_preamble",
    "docs/guide.md#alpha",
    "docs/guide.md#beta",
    "docs/guide.md#alpha-2",
  ]);
  // Content before the first heading is its own segment; a heading inside a
  // fenced code block is text, so #beta swallows lines 11-13.
  assert.deepEqual(
    data.segments.map((item) => [item.start, item.end]),
    [[1, 2], [3, 6], [7, 14], [15, 17]],
  );
  assertContiguous(data.segments, GUIDE.length);

  const second = segment(repo, "docs/guide.md");
  assert.equal(second.stdout, first.stdout);
});

test("non-markdown splits into 60-line windows snapped backwards to a blank line", () => {
  const repo = tempRepo("segment-windows");
  assert.equal(run(repo, "project", "init").status, 0);

  // A blank line five lines before the nominal boundary pulls the boundary back.
  const snapped = Array.from({ length: 100 }, (_, index) => (index === 54 ? "" : `line ${index + 1}`));
  writeSource(repo, "src/snapped.txt", snapped);
  const withSnap = segment(repo, "src/snapped.txt").envelope.data;
  assert.equal(withSnap.strategy, "line-windows");
  assert.deepEqual(withSnap.segments.map((item) => item.id), [
    "src/snapped.txt#L1-55",
    "src/snapped.txt#L56-100",
  ]);
  assertContiguous(withSnap.segments, 100);

  // A blank line twenty lines away is out of snapping reach, so the hard
  // 60-line boundary stands. No window ever exceeds 60 lines.
  const unsnapped = Array.from({ length: 100 }, (_, index) => (index === 39 ? "" : `line ${index + 1}`));
  writeSource(repo, "src/unsnapped.txt", unsnapped);
  const withoutSnap = segment(repo, "src/unsnapped.txt").envelope.data;
  assert.deepEqual(withoutSnap.segments.map((item) => item.id), [
    "src/unsnapped.txt#L1-60",
    "src/unsnapped.txt#L61-100",
  ]);
  assertContiguous(withoutSnap.segments, 100);
  for (const item of [...withSnap.segments, ...withoutSnap.segments]) {
    assert.ok(item.end - item.start + 1 <= 60, `${item.id} exceeds the window`);
  }
});

test("a file shorter than one window is a single segment, and an empty file has none", () => {
  const repo = tempRepo("segment-short");
  assert.equal(run(repo, "project", "init").status, 0);

  writeSource(repo, "src/short.txt", ["alpha", "", "beta", "gamma", "delta"]);
  const short = segment(repo, "src/short.txt").envelope.data;
  assert.equal(short.segment_count, 1);
  assert.deepEqual(short.segments.map((item) => item.id), ["src/short.txt#L1-5"]);
  assertContiguous(short.segments, 5);

  writeFileSync(join(repo, "src", "one.txt"), "only\n");
  assert.deepEqual(
    segment(repo, "src/one.txt").envelope.data.segments.map((item) => item.id),
    ["src/one.txt#L1-1"],
  );

  writeFileSync(join(repo, "src", "empty.txt"), "");
  const empty = segment(repo, "src/empty.txt").envelope.data;
  assert.equal(empty.lines, 0);
  assert.deepEqual(empty.segments, []);
});

test("coverage with zero Contexts reports every segment of every anchored file", () => {
  const repo = guideRepo("coverage-empty");
  writeRoom(repo, "guide", room("guide", { anchors: ["docs/"] }));

  const coverage = run(repo, "context", "coverage");
  assert.equal(coverage.status, 0, coverage.stdout);
  const data = coverage.envelope.data;
  assert.equal(data.segments_total, 4);
  assert.equal(data.uncovered_total, 4);
  assert.equal(data.rooms.length, 1);
  assert.equal(data.rooms[0].room, "guide");
  assert.deepEqual(data.rooms[0].files[0].uncovered, [
    "docs/guide.md#_preamble",
    "docs/guide.md#alpha",
    "docs/guide.md#beta",
    "docs/guide.md#alpha-2",
  ]);
});

test("a coverage_exception on the owning room settles a segment and still validates", () => {
  const repo = guideRepo("coverage-exception");
  writeRoom(repo, "guide", room("guide", {
    anchors: ["docs/"],
    coverage_exceptions: [
      { segment: "docs/guide.md#_preamble", reason: "front matter carries no claim" },
      { segment: "docs/guide.md#beta", reason: "duplicated verbatim in the alpha section" },
      { segment: "docs/guide.md#alpha-2", reason: "restates the alpha section" },
    ],
  }));

  const validated = run(repo, "project", "validate");
  assert.equal(validated.status, 0, validated.stdout);

  let data = run(repo, "context", "coverage").envelope.data;
  assert.deepEqual(data.rooms[0].files[0].uncovered, ["docs/guide.md#alpha"]);
  assert.equal(data.uncovered_total, 1);

  const captured = run(repo, "context", "put", context({
    source: {
      ref: "docs/guide.md#alpha",
      quote: "alpha body",
      captured_at: "2026-08-29T00:00:00.000Z",
    },
  }), ["--room", "guide"]);
  assert.equal(captured.status, 0, captured.stdout);

  data = run(repo, "context", "coverage", undefined, ["--room", "guide"]).envelope.data;
  assert.equal(data.uncovered_total, 0);
  assert.deepEqual(data.rooms.map((item) => item.room), ["guide"]);
});

test("a segment cited only through evidence[].ref counts as covered", () => {
  const repo = guideRepo("coverage-evidence");
  writeRoom(repo, "guide", room("guide", { anchors: ["docs/"] }));
  const captured = run(repo, "context", "put", context({
    evidence: [
      { ref: "docs/guide.md#beta", note: "The Beta section states the constraint verbatim." },
    ],
  }), ["--room", "guide"]);
  assert.equal(captured.status, 0, captured.stdout);

  const data = run(repo, "context", "coverage").envelope.data;
  assert.equal(data.uncovered_total, 3);
  assert.ok(!data.rooms[0].files[0].uncovered.includes("docs/guide.md#beta"));

  // A bare file path with no fragment is a claim about the whole file.
  const whole = run(repo, "context", "put", context({
    context_id: "note-whole-guide",
    type: "note",
    summary: "The guide as a whole is the source for the room boundary.",
    source: { ref: "docs/guide.md", captured_at: "2026-08-29T00:00:00.000Z" },
  }), ["--room", "guide"]);
  assert.equal(whole.status, 0, whole.stdout);
  assert.equal(run(repo, "context", "coverage").envelope.data.uncovered_total, 0);
});
