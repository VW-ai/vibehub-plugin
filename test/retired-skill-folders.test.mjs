// `skills retired` — the check vibehub-setup runs while it inspects a
// checkout, so a Skill folder left behind by a rename is named instead of
// silently offering the Agent two Skills for the same job.
//
// The retired name is never written literally here. It is read from the same
// shared contract the helper reads, which is both the point of the feature and
// what keeps this file from becoming a live reference `skills validate` has to
// excuse.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { root, run, tempRepo } from "./helpers.mjs";

const contract = JSON.parse(readFileSync(
  join(root, "skills", "vibehub-core", "contracts", "skill-graph.json"),
  "utf8",
));
const entries = Array.isArray(contract.retired) ? contract.retired : [];
const sample = entries[0] ?? null;

function installSkill(repo, location, name) {
  const directory = join(repo, ...location.split("/"), name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: An installed copy of the ${name} Skill.\n---\n`,
  );
  return directory;
}

test("a project with a retired folder is told the exact path and the replacement", () => {
  if (!sample) {
    assert.deepEqual(run(tempRepo("retired-none-declared"), "skills", "retired").envelope.data.retired, []);
    return;
  }
  const repo = tempRepo("retired-present");
  installSkill(repo, ".claude/skills", sample.name);
  installSkill(repo, ".claude/skills", sample.replacement);
  installSkill(repo, ".agents/skills", sample.name);

  const { envelope } = run(repo, "skills", "retired");
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.scanned, [".claude/skills", ".agents/skills"]);
  assert.deepEqual(
    envelope.data.retired.map((found) => [found.path, found.replacement, found.replacement_installed]),
    [
      [`.claude/skills/${sample.name}`, sample.replacement, true],
      [`.agents/skills/${sample.name}`, sample.replacement, false],
    ],
  );
  // Every location the check knows about is reported, so a reader can see
  // which directories were looked at and which were absent.
  assert.ok(envelope.data.locations.includes("skills"));
});

test("the report leaves the user's agent Skill directory exactly as it found it", () => {
  if (!sample) return;
  const repo = tempRepo("retired-read-only");
  const installed = installSkill(repo, ".claude/skills", sample.name);

  assert.equal(run(repo, "skills", "retired").envelope.data.retired.length, 1);

  assert.ok(existsSync(installed), "the retired folder was removed");
  assert.deepEqual(readdirSync(installed), ["SKILL.md"], "the retired folder's contents changed");
  assert.match(readFileSync(join(installed, "SKILL.md"), "utf8"), /^---\nname: /u);
  // Nothing is written into the project either: this is a read, not a write.
  assert.equal(existsSync(join(repo, ".vibehub")), false);

  // Running it again reports the same thing, because the first run changed
  // nothing that the second one would see.
  assert.equal(run(repo, "skills", "retired").envelope.data.retired.length, 1);
});

test("a project holding only the replacement produces nothing to report", () => {
  if (!sample) return;
  const repo = tempRepo("retired-replacement-only");
  installSkill(repo, ".claude/skills", sample.replacement);
  installSkill(repo, ".agents/skills", sample.replacement);

  const { envelope } = run(repo, "skills", "retired");
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.scanned, [".claude/skills", ".agents/skills"]);
  assert.deepEqual(envelope.data.retired, []);
});

test("a project that never installed through skills.sh is unaffected", () => {
  const repo = tempRepo("retired-absent");
  writeFileSync(join(repo, "README.md"), "# A project with no agent Skill directories\n");

  const { envelope } = run(repo, "skills", "retired");
  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.data.scanned, []);
  assert.deepEqual(envelope.data.retired, []);
});

test("this repository's own vendored skills/ tree carries no retired folder", () => {
  const { envelope } = run(root, "skills", "retired");
  assert.equal(envelope.ok, true);
  assert.ok(envelope.data.scanned.includes("skills"));
  assert.deepEqual(envelope.data.retired, []);
});

test("setup's SKILL.md cites the check and states it only reports", () => {
  const body = readFileSync(join(root, "skills", "vibehub-setup", "SKILL.md"), "utf8");
  assert.match(body, /vh\.mjs skills retired --repo/u);
  assert.match(body, /never deletes,\s+moves, or rewrites anything inside an agent Skill directory/u);
  assert.match(body, /When `retired` is empty/u);
  // The names must come from the contract, not from the prose.
  for (const entry of entries) {
    assert.equal(body.includes(entry.name), false, "setup's prose hard-codes a retired Skill name");
  }
});
