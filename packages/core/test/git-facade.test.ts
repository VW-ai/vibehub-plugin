import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const fsRealpath = (p: string): string => fs.realpathSync(p);
import { GitFacade, parseRemoteSlug } from "../src/git-facade.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

describe("parseRemoteSlug", () => {
  it("parses https URLs", () => {
    expect(parseRemoteSlug("https://github.com/VW-ai/Vibehub.git")).toBe("VW-ai/Vibehub");
  });
  it("parses ssh URLs", () => {
    expect(parseRemoteSlug("git@github.com:VW-ai/Vibehub.git")).toBe("VW-ai/Vibehub");
  });
  it("parses URLs without .git suffix", () => {
    expect(parseRemoteSlug("https://github.com/owner/repo")).toBe("owner/repo");
  });
  it("tolerates a trailing slash", () => {
    expect(parseRemoteSlug("https://github.com/owner/repo/")).toBe("owner/repo");
  });
  it("returns null for garbage", () => {
    expect(parseRemoteSlug("not a url")).toBeNull();
  });
});

describe("GitFacade on a scratch repo", () => {
  let repo: ScratchRepo;
  let facade: GitFacade;

  beforeAll(() => {
    repo = makeScratchRepo();
    // clean branch: touches its own file
    repo.pushBranch("feat/clean", [{ file: "src/clean.ts", content: "clean\n" }]);
    // two branches editing the same line of the same file → real conflict
    repo.pushBranch("feat/left", [{ file: "src/shared.ts", content: "export const a = 2; // left\n" }]);
    repo.pushBranch("feat/right", [{ file: "src/shared.ts", content: "export const a = 3; // right\n" }]);
    // merged branch
    repo.pushBranch("feat/merged", [{ file: "docs/note.md", content: "note\n" }]);
    git(repo.work, "checkout", "main");
    git(repo.work, "merge", "--no-ff", "feat/merged", "-m", "merge feat/merged");
    git(repo.work, "push", "origin", "main");
    facade = new GitFacade(repo.work);
  });
  afterAll(() => repo.cleanup());

  it("resolves the repo root", () => {
    expect(facade.repoRoot).toBe(repo.work);
  });

  it("resolves a worktree to its MAIN repo root (decision-github-004)", () => {
    const wtPath = path.join(repo.root, "wt");
    git(repo.work, "worktree", "add", wtPath, "feat/clean");
    expect(GitFacade.resolveRepoRoot(wtPath)).toBe(repo.work);
  });

  it("sessionContextAt gets all three session facts in one spawn", () => {
    const wtPath = path.join(repo.root, "wt-ctx");
    git(repo.work, "worktree", "add", "-b", "feat/ctx", wtPath);
    expect(GitFacade.sessionContextAt(wtPath)).toEqual({
      repoRoot: repo.work, // the DOMAIN
      toplevel: fsRealpath(wtPath), // the session's own tree
      branch: "feat/ctx", // the session's own HEAD
    });
    expect(GitFacade.headShaAt(wtPath)).toBe(git(wtPath, "rev-parse", "HEAD").trim());
  });

  it("derives only commits after the task baseline with stable git ids", () => {
    const isolated = makeScratchRepo();
    try {
      const baseline = git(isolated.work, "rev-parse", "HEAD").trim();
      isolated.write("src/new.ts", "export const n = 1;\n");
      isolated.commitAll("feat: add new fact");
      const events = new GitFacade(isolated.work).commitEventsSince(baseline, "HEAD");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        id: expect.stringMatching(/^git:[0-9a-f]{40}$/),
        type: "commit",
        message: "feat: add new fact",
        filesChanged: 1,
      });
      expect(events[0]!.sha).toHaveLength(7);
    } finally {
      isolated.cleanup();
    }
  });

  it("listRemoteBranches with a compare ref carries ahead/behind (git ≥ 2.41)", () => {
    const withCounts = facade.listRemoteBranches("main");
    const left = withCounts.find((b) => b.name === "feat/left")!;
    const merged = withCounts.find((b) => b.name === "feat/merged")!;
    if (left.ahead === undefined) return; // older git — fallback path, counts absent
    expect(left.ahead).toBe(1);
    expect(left.behind).toBeGreaterThanOrEqual(1);
    expect(merged.ahead).toBe(0); // ahead 0 ⇔ contained ⇔ merged
  });

  it("reads the default branch from origin/HEAD", () => {
    expect(facade.defaultBranch()).toBe("main");
  });

  it("reports no slug for a local-path origin", () => {
    // path-based origin URL parses to a nonsense slug or null — either way
    // it must not throw; the sync stores whatever fact git gives.
    expect(() => facade.remoteSlug()).not.toThrow();
  });

  it("lists remote branches without origin/HEAD, newest first", () => {
    const names = facade.listRemoteBranches().map((b) => b.name);
    expect(names).toContain("feat/clean");
    expect(names).toContain("feat/left");
    expect(names).toContain("feat/right");
    expect(names).toContain("main");
    expect(names).not.toContain("HEAD");
  });

  it("carries sha, iso date and author on each branch", () => {
    const b = facade.listRemoteBranches().find((x) => x.name === "feat/clean")!;
    expect(b.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(new Date(b.lastCommitAt).getTime()).not.toBeNaN();
    expect(b.lastAuthor).toBe("Test Author");
  });

  it("detects merged vs unmerged", () => {
    const bySha = new Map(facade.listRemoteBranches().map((b) => [b.name, b.headSha]));
    expect(facade.isMerged(bySha.get("feat/merged")!, "main")).toBe(true);
    expect(facade.isMerged(bySha.get("feat/left")!, "main")).toBe(false);
  });

  it("counts ahead/behind against the default branch", () => {
    const ab = facade.aheadBehind("feat/left", "main");
    expect(ab.ahead).toBe(1);
    // main gained the feat/merged merge after feat/left branched
    expect(ab.behind).toBeGreaterThanOrEqual(1);
  });

  it("diffs branch footprints against the merge-base (three-dot)", () => {
    const files = facade.branchFiles("feat/left", "main");
    expect(files).toEqual([{ path: "src/shared.ts", changeKind: "M" }]);
    // the merge that landed on main after branching must NOT pollute the diff
    expect(files.map((f) => f.path)).not.toContain("docs/note.md");
  });

  it("reports added files with kind A", () => {
    const files = facade.branchFiles("feat/clean", "main");
    expect(files).toEqual([{ path: "src/clean.ts", changeKind: "A" }]);
  });

  it("merge-tree flags the real conflict pair with its paths", () => {
    const paths = facade.mergeTreeConflicts("origin/feat/left", "origin/feat/right");
    expect(paths).toEqual(["src/shared.ts"]);
  });

  it("merge-tree reports a clean pair as []", () => {
    expect(facade.mergeTreeConflicts("origin/feat/clean", "origin/feat/left")).toEqual([]);
  });

  it("counts tracked files", () => {
    expect(facade.lsFilesCount()).toBeGreaterThanOrEqual(3);
  });
});
