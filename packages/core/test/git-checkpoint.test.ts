import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitGitCheckpoint,
  prepareGitCheckpoint,
  type GitCheckpointScope,
} from "../src/git-checkpoint.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });

describe("generic Git checkpoint kernel", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rolls back the original branch when HEAD switches before ref advance", () => {
    const repository = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibehub-git-checkpoint-"),
    );
    roots.push(repository);
    git(repository, "init", "-b", "main");
    git(repository, "config", "user.name", "Checkpoint Kernel Test");
    git(repository, "config", "user.email", "checkpoint-kernel@example.test");
    fs.mkdirSync(path.join(repository, ".checkpoint"));
    const statePath = path.join(repository, ".checkpoint", "state.txt");
    fs.writeFileSync(statePath, "before\n");
    git(repository, "add", "-A");
    git(repository, "commit", "-m", "seed checkpoint scope");
    git(repository, "branch", "other");
    git(repository, "switch", "-c", "feature");
    fs.writeFileSync(statePath, "after\n");

    let reflogReads = 0;
    const scope: GitCheckpointScope = {
      label: "kernel checkpoint",
      relativeRoot: ".checkpoint",
      commitSubject: "checkpoint: test branch race",
      get reflogMessage(): string {
        reflogReads += 1;
        if (reflogReads === 4) {
          git(repository, "switch", "other");
        }
        return "kernel checkpoint";
      },
      digestTrailer: "VibeHub-Test-Digest",
      inspectWorktree: () => ({
        digest: fs.readFileSync(statePath, "utf8").trim(),
      }),
      inspectCommit: (repoRoot, commitSha) => ({
        digest: git(
          repoRoot,
          "show",
          `${commitSha}:.checkpoint/state.txt`,
        ).trim(),
      }),
    };
    const receipt = prepareGitCheckpoint({ repoRoot: repository, scope });

    expect(() => commitGitCheckpoint({
      repoRoot: repository,
      scope,
      receipt,
      actor: "agent:test",
      requestId: "request:branch-race",
      now: "2026-07-29T08:00:00.000Z",
    })).toThrow(/branch changed during checkpoint/u);
    expect(reflogReads).toBeGreaterThanOrEqual(4);
    expect(git(repository, "rev-parse", "refs/heads/feature").trim())
      .toBe(receipt.headSha);
    expect(git(repository, "rev-parse", "refs/heads/other").trim())
      .toBe(receipt.headSha);
    expect(git(repository, "branch", "--show-current").trim()).toBe("other");
    expect(fs.readFileSync(statePath, "utf8")).toBe("after\n");
  });
});
