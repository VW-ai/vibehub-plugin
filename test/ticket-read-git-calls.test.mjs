import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { helper, run, tempRepo } from "./helpers.mjs";

// Reads load the whole repository, so their git work must not grow with the
// number of Tickets whose history the validator checks.
function countingGit(directory) {
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(directory, "git-calls.log");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho x >> "${log}"\nexec "${real}" "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  return {
    count(repo, ...args) {
      rmSync(log, { force: true });
      const result = spawnSync(process.execPath, [helper, ...args, "--repo", repo], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    },
  };
}

function repoWithHistory(label, tickets) {
  const repo = tempRepo(label);
  const commit = (message) => execFileSync("git", [
    "-c", "user.name=VibeHub Test", "-c", "user.email=vibehub@example.test",
    "commit", "-qm", message,
  ], { cwd: repo });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  assert.equal(run(repo, "project", "init").status, 0);
  mkdirSync(join(repo, "docs"));
  for (let index = 0; index < tickets; index += 1) writeFileSync(join(repo, "docs", `old-${index}.md`), `# ${index}\n`);
  execFileSync("git", ["add", "-A"], { cwd: repo });
  commit("docs");
  const docs = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  for (let index = 0; index < tickets; index += 1) {
    assert.equal(run(repo, "ticket", "put", {
      ticket_id: `work-${index}`,
      outcome: `Work ${index}`,
      context_refs: [
        { ref: `docs/old-${index}.md`, purpose: "Current when written." },
        { ref: `commit:${docs}:docs/old-${index}.md`, purpose: "Pinned source." },
      ],
      provenance_refs: [`commit:${docs}`],
    }).status, 0);
  }
  rmSync(join(repo, "docs"), { recursive: true });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  commit("tickets, docs removed");
  return repo;
}

test("Ticket reads use a fixed number of git processes however many refs need history", () => {
  const few = repoWithHistory("git-calls-few", 2);
  const many = repoWithHistory("git-calls-many", 12);
  const git = countingGit(tempRepo("git-calls-bin"));
  for (const operation of [["ticket", "frontier"], ["project", "validate"]]) {
    const small = git.count(few, ...operation);
    const large = git.count(many, ...operation);
    assert.equal(large, small, `${operation.join(" ")}: ${small} git calls for 2 Tickets, ${large} for 12`);
    assert.ok(large <= 6, `${operation.join(" ")} made ${large} git calls`);
  }
  const validated = JSON.parse(spawnSync(process.execPath, [helper, "project", "validate", "--repo", many], { encoding: "utf8" }).stdout);
  assert.equal(validated.data.unverifiable_context_refs.length, 12);
  assert.ok(validated.data.unverifiable_context_refs.every(({ message }) => message.endsWith("(available in recorded history)")));
});
