/**
 * Scratch-repo builders for integration tests: a bare "origin" plus a work
 * clone, driven by real git — the facade is tested against the real thing,
 * not mocks.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test@example.com",
      // Keep the user's global/system git config out of the tests.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

export function git(cwd: string, ...args: string[]): string {
  return sh(cwd, "git", args);
}

export interface ScratchRepo {
  /** Bare origin path. */
  origin: string;
  /** Work clone path (has `origin` remote). */
  work: string;
  root: string;
  cleanup: () => void;
  /** Write a file in the work clone. */
  write: (rel: string, content: string) => void;
  commitAll: (message: string) => void;
  /** Create branch from origin/main, apply edits, commit, push. */
  pushBranch: (
    name: string,
    edits: Array<{ file: string; content: string }>,
    message?: string,
  ) => void;
}

/** A bare origin + clone with one initial commit on main, origin/HEAD set. */
export function makeScratchRepo(): ScratchRepo {
  // realpath: macOS tmpdir lives behind the /var → /private/var symlink and
  // git reports resolved paths — resolve up front so equality checks hold.
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-test-")),
  );
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  fs.mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");
  git(root, "clone", origin, work);

  const write = (rel: string, content: string): void => {
    const p = path.join(work, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  const commitAll = (message: string): void => {
    git(work, "add", "-A");
    git(work, "commit", "-m", message);
  };

  write("README.md", "# scratch\n");
  write("src/shared.ts", "export const a = 1;\n");
  commitAll("initial");
  git(work, "push", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");

  const pushBranch: ScratchRepo["pushBranch"] = (name, edits, message) => {
    git(work, "checkout", "-b", name, "origin/main");
    for (const e of edits) write(e.file, e.content);
    commitAll(message ?? `work on ${name}`);
    git(work, "push", "-u", "origin", name);
    git(work, "checkout", "main");
  };

  return {
    origin,
    work,
    root,
    write,
    commitAll,
    pushBranch,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}
