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

  it("binds an execution start to HEAD and exact non-ledger worktree bytes", () => {
    const isolated = makeScratchRepo();
    try {
      fs.mkdirSync(
        path.join(isolated.work, ".vibehub", "tickets"),
        { recursive: true },
      );
      fs.writeFileSync(
        path.join(isolated.work, ".vibehub", "tickets", "protocol.yaml"),
        "semantic one\n",
      );
      const clean = GitFacade.worktreeSourceSnapshotAt(
        isolated.work,
        [".vibehub/tickets"],
      );
      isolated.write("src/local.ts", "one\n");
      const dirty = GitFacade.worktreeSourceSnapshotAt(
        isolated.work,
        [".vibehub/tickets"],
      );
      expect(dirty.sourceDigest).not.toBe(clean.sourceDigest);
      expect(dirty.changedPaths).toContain("src/local.ts");

      fs.writeFileSync(
        path.join(isolated.work, ".vibehub", "tickets", "protocol.yaml"),
        "semantic two\n",
      );
      const semanticOnly = GitFacade.worktreeSourceSnapshotAt(
        isolated.work,
        [".vibehub/tickets"],
      );
      expect(semanticOnly.sourceDigest).toBe(dirty.sourceDigest);
      expect(semanticOnly.changedPaths)
        .not.toContain(".vibehub/tickets/protocol.yaml");

      isolated.write("src/local.ts", "two\n");
      expect(GitFacade.worktreeSourceSnapshotAt(
        isolated.work,
        [".vibehub/tickets"],
      ).sourceDigest).not.toBe(dirty.sourceDigest);
    } finally {
      isolated.cleanup();
    }
  });

  it("binds staged index blobs and modes when worktree bytes and MM flags match", () => {
    const isolated = makeScratchRepo();
    try {
      const statusForSource = () =>
        GitFacade.statusPathsAt(isolated.work, ".")
          .find((entry) => entry.path === "src/shared.ts");

      isolated.write("src/shared.ts", "staged one\n");
      git(isolated.work, "add", "src/shared.ts");
      isolated.write("src/shared.ts", "worktree bytes\n");
      expect(statusForSource()).toMatchObject({
        indexStatus: "M",
        worktreeStatus: "M",
      });
      const firstBlob = git(
        isolated.work,
        "ls-files",
        "--stage",
        "--",
        "src/shared.ts",
      ).trim();
      const firstSnapshot = GitFacade.worktreeSourceSnapshotAt(isolated.work);

      isolated.write("src/shared.ts", "staged two\n");
      git(isolated.work, "add", "src/shared.ts");
      isolated.write("src/shared.ts", "worktree bytes\n");
      expect(statusForSource()).toMatchObject({
        indexStatus: "M",
        worktreeStatus: "M",
      });
      const secondBlob = git(
        isolated.work,
        "ls-files",
        "--stage",
        "--",
        "src/shared.ts",
      ).trim();
      const secondSnapshot = GitFacade.worktreeSourceSnapshotAt(isolated.work);

      expect(fs.readFileSync(
        path.join(isolated.work, "src/shared.ts"),
        "utf8",
      )).toBe("worktree bytes\n");
      expect(firstBlob).not.toBe(secondBlob);
      expect(secondSnapshot.sourceDigest).not.toBe(firstSnapshot.sourceDigest);

      isolated.write("src/shared.ts", "staged mode\n");
      git(isolated.work, "add", "src/shared.ts");
      git(isolated.work, "update-index", "--chmod=-x", "src/shared.ts");
      isolated.write("src/shared.ts", "worktree bytes\n");
      fs.utimesSync(
        path.join(isolated.work, "src/shared.ts"),
        new Date(2_000_000_000_000),
        new Date(2_000_000_000_000),
      );
      expect(statusForSource()).toMatchObject({
        indexStatus: "M",
        worktreeStatus: "M",
      });
      const nonExecutableEntry = git(
        isolated.work,
        "ls-files",
        "--stage",
        "--",
        "src/shared.ts",
      ).trim();
      const nonExecutableObjectId = nonExecutableEntry.split(" ")[1]!;
      const nonExecutableSnapshot =
        GitFacade.worktreeSourceSnapshotAt(isolated.work);

      git(
        isolated.work,
        "update-index",
        "--cacheinfo",
        `100755,${nonExecutableObjectId},src/shared.ts`,
      );
      fs.utimesSync(
        path.join(isolated.work, "src/shared.ts"),
        new Date(2_000_000_010_000),
        new Date(2_000_000_010_000),
      );
      expect(statusForSource()).toMatchObject({
        indexStatus: "M",
        worktreeStatus: "M",
      });
      const executableEntry = git(
        isolated.work,
        "ls-files",
        "--stage",
        "--",
        "src/shared.ts",
      ).trim();
      const executableSnapshot =
        GitFacade.worktreeSourceSnapshotAt(isolated.work);

      expect(nonExecutableEntry).toMatch(/^100644 [0-9a-f]+ 0\t/);
      expect(executableEntry).toMatch(/^100755 [0-9a-f]+ 0\t/);
      expect(executableEntry.split(" ")[1])
        .toBe(nonExecutableObjectId);
      expect(executableSnapshot.sourceDigest)
        .not.toBe(nonExecutableSnapshot.sourceDigest);
    } finally {
      isolated.cleanup();
    }
  });

  it("reads the index owned by the current linked worktree", () => {
    const isolated = makeScratchRepo();
    try {
      const linked = path.join(isolated.root, "linked-source");
      git(
        isolated.work,
        "worktree",
        "add",
        "-b",
        "feat/linked-source",
        linked,
      );
      const writeLinked = (content: string) =>
        fs.writeFileSync(path.join(linked, "src/shared.ts"), content);

      writeLinked("linked staged\n");
      git(linked, "add", "src/shared.ts");
      writeLinked("shared worktree bytes\n");
      const beforeMainIndexChange =
        GitFacade.worktreeSourceSnapshotAt(linked);

      isolated.write("src/shared.ts", "main staged\n");
      git(isolated.work, "add", "src/shared.ts");
      isolated.write("src/shared.ts", "main worktree\n");
      const afterMainIndexChange =
        GitFacade.worktreeSourceSnapshotAt(linked);

      expect(afterMainIndexChange.sourceDigest)
        .toBe(beforeMainIndexChange.sourceDigest);

      writeLinked("linked staged two\n");
      git(linked, "add", "src/shared.ts");
      writeLinked("shared worktree bytes\n");
      expect(GitFacade.worktreeSourceSnapshotAt(linked).sourceDigest)
        .not.toBe(beforeMainIndexChange.sourceDigest);
    } finally {
      isolated.cleanup();
    }
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

  it("handles symlink and gitlink commit inventory rows with stable content hashes", () => {
    const isolated = makeScratchRepo();
    try {
      const baseline = git(isolated.work, "rev-parse", "HEAD").trim();
      fs.symlinkSync("README.md", path.join(isolated.work, "linked.md"));
      git(isolated.work, "add", "linked.md");
      git(isolated.work, "update-index", "--add", "--cacheinfo", `160000,${baseline},vendor/submodule`);
      git(isolated.work, "commit", "-m", "add non-regular entries");
      const target = git(isolated.work, "rev-parse", "HEAD").trim();
      expect(GitFacade.commitInventory(isolated.work, baseline, target)).toEqual(expect.arrayContaining([
        expect.objectContaining({path:"linked.md",changeKind:"added",contentHash:expect.any(String)}),
        expect.objectContaining({path:"vendor/submodule",changeKind:"added",contentHash:expect.any(String)}),
      ]));
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
