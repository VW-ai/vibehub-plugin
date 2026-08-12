import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const historyRoot = join(repo, ".vibehub/history/github-pr-18");

test("PR 18 ledger snapshot is complete, byte-stable, and non-canonical", () => {
  const manifest = JSON.parse(readFileSync(join(historyRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.merge_base, "c17e973b3784005f5c0d8baa37b2bd6262d97280");
  assert.equal(manifest.pr_head, "0c21858ca1a4dd1537e75a335f124548a44d3587");
  assert.deepEqual(manifest.counts, { tickets: 10, evidence: 28, outcomes: 7 });
  assert.equal(manifest.records.length, 45);
  assert.equal(new Set(manifest.records.map((record) => record.original_path)).size, 45);

  for (const record of manifest.records) {
    assert.match(record.original_path, /^\.vibehub\/(?:tickets|evidence|outcomes)\//u);
    assert.match(record.archive_path, /^\.vibehub\/history\/github-pr-18\/snapshot\//u);
    const bytes = readFileSync(join(repo, record.archive_path));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(digest, record.sha256, record.original_path);
  }
});
