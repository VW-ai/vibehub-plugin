import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitSemanticCheckpoint,
  KnowledgeService,
  migrateSqliteSemanticStoreToGit,
  openDb,
  prepareSemanticCheckpoint,
  stableSemanticPath,
  upsertRepo,
} from "../src/index.js";

const NOW = "2026-07-22T08:00:00.000Z";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  },
});

function setupRepository(root: string, withRelation = false): string {
  const repo = path.join(root, "repo");
  const dbPath = path.join(root, "source.db");
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Semantic Checkpoint Test");
  git(repo, "config", "user.email", "checkpoint@example.test");
  fs.writeFileSync(path.join(repo, "README.md"), "# checkpoint\n");
  fs.writeFileSync(path.join(repo, "code.ts"), "export const value = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");

  const db = openDb(dbPath);
  const row = upsertRepo(db, repo, "vibehub/checkpoint", "main", NOW);
  db.prepare(
    "INSERT INTO kb_features(repo_id, feature_id, created_at) VALUES (?, ?, ?)",
  ).run(row.id, "feature/checkpoint", NOW);
  if (withRelation) {
    new KnowledgeService(db).applyDraftBatch(row.id, {
      idempotencyKey: "seed-related-specs",
      specs: [
        {
          id: "decision/source",
          featureId: "feature/checkpoint",
          type: "decision",
          summary: "Source depends on target",
          evidence: [{ sourceType: "test", sourceRef: "checkpoint:test", exactQuote: "source" }],
          relations: [{ toSpecId: "decision/target", type: "depends_on" }],
        },
        {
          id: "decision/target",
          featureId: "feature/checkpoint",
          type: "decision",
          summary: "Target exists",
          evidence: [{ sourceType: "test", sourceRef: "checkpoint:test", exactQuote: "target" }],
        },
      ],
    }, {
      actor: "test",
      taskId: "task:seed",
      requestId: "request:seed",
      now: NOW,
    });
  }
  db.close();
  migrateSqliteSemanticStoreToGit({
    sourceDbPath: dbPath,
    sourceRepoId: row.id,
    repoRoot: repo,
  });
  git(repo, "add", ".vibehub/semantic-store");
  git(repo, "commit", "-m", "seed semantic authority");
  return repo;
}

function changeProtocol(repo: string, createdAt: string): void {
  const protocolPath = path.join(repo, ".vibehub/semantic-store/protocol.yaml");
  const protocol = JSON.parse(fs.readFileSync(protocolPath, "utf8")) as {
    repository: { created_at: string };
  };
  protocol.repository.created_at = createdAt;
  fs.writeFileSync(protocolPath, `${JSON.stringify(protocol, null, 2)}\n`);
}

describe("semantic checkpoint commits", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) =>
    fs.rmSync(root, { recursive: true, force: true })));

  it("commits only the receipt-proven semantic paths and preserves user changes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-checkpoint-"));
    roots.push(root);
    const repo = setupRepository(root);
    git(repo, "switch", "-c", "feat/checkpoint");
    changeProtocol(repo, "2026-07-22T08:01:00.000Z");
    fs.writeFileSync(path.join(repo, "code.ts"), "export const value = 2;\n");
    git(repo, "add", "code.ts");
    fs.appendFileSync(path.join(repo, "README.md"), "working tree note\n");

    const receipt = prepareSemanticCheckpoint({ repoRoot: repo });
    expect(receipt.changedPaths).toEqual([
      ".vibehub/semantic-store/protocol.yaml",
    ]);
    const result = commitSemanticCheckpoint({
      repoRoot: repo,
      receipt,
      actor: "agent:codex",
      taskId: "task:checkpoint",
      requestId: "request:checkpoint-1",
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "committed",
      branch: "feat/checkpoint",
      beforeHeadSha: receipt.headSha,
      semanticDigest: receipt.semanticDigest,
      changedPaths: receipt.changedPaths,
    });
    expect(git(repo, "show", "--format=", "--name-only", "HEAD").trim()).toBe(
      ".vibehub/semantic-store/protocol.yaml",
    );
    expect(git(repo, "diff", "--cached", "--name-only").trim()).toBe("code.ts");
    expect(git(repo, "diff", "--name-only").trim()).toBe("README.md");
    expect(git(repo, "show", "-s", "--format=%B", "HEAD")).toContain(
      `VibeHub-Semantic-Digest: ${receipt.semanticDigest}`,
    );

    const noopReceipt = prepareSemanticCheckpoint({ repoRoot: repo });
    expect(noopReceipt.changedPaths).toEqual([]);
    expect(commitSemanticCheckpoint({
      repoRoot: repo,
      receipt: noopReceipt,
      actor: "agent:codex",
      requestId: "request:checkpoint-2",
      now: NOW,
    })).toMatchObject({
      status: "noop",
      commitSha: result.commitSha,
    });
  });

  it("rejects protected branches and stale receipts without creating commits", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-checkpoint-"));
    roots.push(root);
    const repo = setupRepository(root);
    changeProtocol(repo, "2026-07-22T08:02:00.000Z");
    expect(() => prepareSemanticCheckpoint({ repoRoot: repo }))
      .toThrow(/protected branch/);

    git(repo, "restore", ".vibehub/semantic-store/protocol.yaml");
    git(repo, "switch", "-c", "release");
    changeProtocol(repo, "2026-07-22T08:02:30.000Z");
    expect(() => prepareSemanticCheckpoint({
      repoRoot: repo,
      protectedBranches: ["release"],
    })).toThrow(/protected branch/);

    git(repo, "restore", ".vibehub/semantic-store/protocol.yaml");
    git(repo, "switch", "main");
    git(repo, "switch", "-c", "feat/stale-checkpoint");
    changeProtocol(repo, "2026-07-22T08:03:00.000Z");
    const receipt = prepareSemanticCheckpoint({ repoRoot: repo });
    changeProtocol(repo, "2026-07-22T08:04:00.000Z");
    const before = git(repo, "rev-parse", "HEAD").trim();
    expect(() => commitSemanticCheckpoint({
      repoRoot: repo,
      receipt,
      actor: "agent:codex",
      requestId: "request:stale",
      now: NOW,
    })).toThrow(/receipt is stale/);
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(before);
  });

  it("rejects a canonical tree whose cross-spec graph cannot be rebuilt", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-checkpoint-"));
    roots.push(root);
    const repo = setupRepository(root, true);
    git(repo, "switch", "-c", "feat/dangling-relation");
    fs.rmSync(path.join(repo, stableSemanticPath("specs", "decision/target")));

    expect(() => prepareSemanticCheckpoint({ repoRoot: repo }))
      .toThrow();
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(
      git(repo, "rev-parse", "main").trim(),
    );
  });
});
