import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./helpers.mjs";

test("setup offers the GitHub mirror once and every listed source file exists", () => {
  const skill = readFileSync(join(root, "skills", "vibehub-setup", "SKILL.md"), "utf8");
  assert.match(skill, /Optional, asked once/);
  assert.match(skill, /nothing for an Agent to run or check/);
  const sources = [...skill.matchAll(/^\s+(\.\.\/vibehub-core\/[^\s]+)\s+→\s+(\S+)$/gmu)];
  assert.equal(sources.length, 5);
  for (const [, src] of sources) assert.ok(existsSync(join(root, "skills", "vibehub-setup", src)), `missing ${src}`);
  assert.deepEqual(sources.map(([, , dst]) => dst), [
    ".github/workflows/sync-issues.yml",
    "scripts/vibehub/sync-github-issues.mjs",
    "scripts/vibehub/scripts/vh.mjs",
    "scripts/vibehub/contracts/versions.json",
    "scripts/vibehub/contracts/dependency-hygiene.json",
  ]);
});

test("no Skill, project instruction, or hook asks an Agent to run the Issues sync", () => {
  for (const file of ["CLAUDE.md", "AGENTS.md"]) {
    if (existsSync(join(root, file))) assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /sync-github-issues|sync-issues/);
  }
  const skills = readFileSync(join(root, "skills", "vibehub-setup", "SKILL.md"), "utf8");
  assert.doesNotMatch(skills, /run (the )?sync-github-issues/i);
});
