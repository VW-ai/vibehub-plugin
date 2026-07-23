import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  diffSemanticRefs,
  durableProvenanceId,
  exportGitSemanticStore,
  materializeSemanticCacheAtRef,
  readSpecAtRef,
  stableSemanticPath,
} from "../src/git-semantic-store.js";
import { KnowledgeService, openDb, upsertRepo } from "../src/index.js";

const NOW = "2026-07-20T08:00:00.000Z";

const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Ref Cache Spike",
    GIT_AUTHOR_EMAIL: "ref-cache@example.test",
    GIT_COMMITTER_NAME: "Ref Cache Spike",
    GIT_COMMITTER_EMAIL: "ref-cache@example.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  },
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const canonical = (value: unknown): Json => {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return value as Json;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
};
const serialize = (value: unknown): string => `${JSON.stringify(canonical(value), null, 2)}\n`;

describe("branch/ref reads and commit-keyed semantic cache spike", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) =>
    fs.rmSync(root, { recursive: true, force: true })));

  it("reads light queries directly from refs and isolates heavy-query caches by commit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-ref-cache-"));
    roots.push(root);
    const repo = path.join(root, "repo");
    const cacheRoot = path.join(root, "cache");
    fs.mkdirSync(repo);
    run(repo, "init", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "# ref cache spike\n");
    run(repo, "add", "-A");
    run(repo, "commit", "-m", "initial");

    const dbPath = path.join(root, "source.db");
    const db = openDb(dbPath);
    const repoRow = upsertRepo(db, repo, "vibehub/ref-cache", "main", NOW);
    db.prepare(`INSERT INTO kb_features (repo_id, feature_id, created_at)
      VALUES (?, 'feature/auth', ?)`).run(repoRow.id, NOW);
    const service = new KnowledgeService(db);
    const context = {
      actor: "wayne",
      taskId: "task:ref-cache",
      requestId: "request:draft",
      now: NOW,
    };
    service.applyDraftBatch(repoRow.id, {
      idempotencyKey: "draft",
      specs: [{
        id: "decision-auth",
        featureId: "feature/auth",
        type: "decision",
        summary: "Main branch summary",
        tags: ["auth"],
        evidence: [{
          sourceType: "conversation",
          sourceRef: "chat:ref-cache",
          exactQuote: "Keep branch truth explicit",
          confidence: 1,
        }],
        anchors: [{ file: "src/auth.ts", symbol: "authenticate" }],
      }],
    }, context);
    service.mutate(repoRow.id, "promote", {
      specId: "decision-auth",
      idempotencyKey: "promote",
    }, { ...context, requestId: "request:promote" });
    db.close();

    const exported = exportGitSemanticStore({
      dbPath,
      repoId: repoRow.id,
      worktreeRoot: repo,
    });
    expect(exported).toMatchObject({ featureCount: 1, specCount: 1 });
    run(repo, "add", "-A");
    run(repo, "commit", "-m", "semantic main");
    const mainCommit = run(repo, "rev-parse", "HEAD").trim();

    run(repo, "switch", "-c", "feature/auth-change");
    const specPath = path.join(repo, stableSemanticPath("specs", "decision-auth"));
    const branchDocument = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
      revisions: Array<{ revision: number; summary: string }>;
    };
    branchDocument.revisions.find((revision) => revision.revision === 1)!.summary =
      "Feature branch summary";
    fs.writeFileSync(specPath, serialize(branchDocument));
    const collidingRepoEvents = [
      {
        event_id: 7,
        operation: "kb.import",
        actor: "branch-a",
        task_id: null,
        request_id: "request:branch-a",
        at: "2026-07-20T09:00:00.000Z",
        payload: { branch: "a" },
      },
      {
        event_id: 7,
        operation: "kb.import",
        actor: "branch-b",
        task_id: null,
        request_id: "request:branch-b",
        at: "2026-07-20T09:00:00.000Z",
        payload: { branch: "b" },
      },
    ];
    for (const { event_id: _localOnly, ...event } of collidingRepoEvents) {
      const durableId = durableProvenanceId(null, { event_id: 7, ...event });
      const target = path.join(
        repo,
        ".vibehub/semantic-store/provenance",
        `sha256-${durableId}.yaml`,
      );
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, serialize({
        schema_version: 2,
        kind: "repo_provenance",
        durable_id: durableId,
        ...event,
      }));
    }
    run(repo, "add", "-A");
    run(repo, "commit", "-m", "change semantic summary");
    const branchCommit = run(repo, "rev-parse", "HEAD").trim();
    const beforeStatus = run(repo, "status", "--porcelain=v1", "--branch");

    const mainRead = readSpecAtRef(repo, "main", "decision-auth");
    const branchRead = readSpecAtRef(repo, "feature/auth-change", "decision-auth");
    expect(mainRead.commit).toBe(mainCommit);
    expect(branchRead.commit).toBe(branchCommit);
    expect((mainRead.spec.revisions as Array<{ summary: string }>)[0]?.summary)
      .toBe("Main branch summary");
    expect((branchRead.spec.revisions as Array<{ summary: string }>)[0]?.summary)
      .toBe("Feature branch summary");
    expect(diffSemanticRefs(repo, "main", "feature/auth-change")).toEqual([{
      status: "modified",
      specId: "decision-auth",
      path: stableSemanticPath("specs", "decision-auth"),
    }]);

    const mainCache = materializeSemanticCacheAtRef({ repoRoot: repo, ref: "main", cacheRoot });
    const branchCache = materializeSemanticCacheAtRef({
      repoRoot: repo,
      ref: "feature/auth-change",
      cacheRoot,
    });
    const repeatedBranchCache = materializeSemanticCacheAtRef({
      repoRoot: repo,
      ref: "feature/auth-change",
      cacheRoot,
    });
    expect(mainCache).toMatchObject({ commit: mainCommit, cacheHit: false });
    expect(branchCache).toMatchObject({ commit: branchCommit, cacheHit: false });
    expect(repeatedBranchCache).toMatchObject({
      commit: branchCommit,
      dbPath: branchCache.dbPath,
      semanticDigest: branchCache.semanticDigest,
      cacheHit: true,
    });
    expect(mainCache.dbPath).not.toBe(branchCache.dbPath);

    const mainDb = openDb(mainCache.dbPath);
    const branchDb = openDb(branchCache.dbPath);
    expect(new KnowledgeService(mainDb).getSpec(mainCache.repoId, "decision-auth").summary)
      .toBe("Main branch summary");
    expect(new KnowledgeService(branchDb).getSpec(branchCache.repoId, "decision-auth").summary)
      .toBe("Feature branch summary");
    expect(mainDb.prepare(`SELECT COUNT(*) AS n FROM kb_provenance_events
      WHERE spec_id IS NULL`).get()).toEqual({ n: 0 });
    expect(branchDb.prepare(`SELECT COUNT(*) AS n FROM kb_provenance_events
      WHERE spec_id IS NULL`).get()).toEqual({ n: 2 });
    mainDb.close();
    branchDb.close();

    const mainReexportRoot = path.join(root, "main-reexport");
    const branchReexportRoot = path.join(root, "branch-reexport");
    fs.mkdirSync(mainReexportRoot);
    fs.mkdirSync(branchReexportRoot);
    expect(exportGitSemanticStore({
      dbPath: mainCache.dbPath,
      repoId: mainCache.repoId,
      worktreeRoot: mainReexportRoot,
    }).semanticDigest).toBe(mainCache.semanticDigest);
    expect(exportGitSemanticStore({
      dbPath: branchCache.dbPath,
      repoId: branchCache.repoId,
      worktreeRoot: branchReexportRoot,
    }).semanticDigest).toBe(branchCache.semanticDigest);

    expect(run(repo, "status", "--porcelain=v1", "--branch")).toBe(beforeStatus);
    expect(run(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("feature/auth-change");
  });

  it("derives collision-safe provenance identity from scope and canonical event content", () => {
    const sharedLocalInteger = 7;
    const eventA = {
      event_id: sharedLocalInteger,
      operation: "kb.import",
      actor: "branch-a",
      task_id: null,
      request_id: "request:a",
      at: NOW,
      payload: { branch: "a" },
    };
    const eventB = {
      event_id: sharedLocalInteger,
      operation: "kb.import",
      actor: "branch-b",
      task_id: null,
      request_id: "request:b",
      at: NOW,
      payload: { branch: "b" },
    };
    expect(durableProvenanceId(null, eventA)).not.toBe(durableProvenanceId(null, eventB));
    expect(durableProvenanceId("decision-a", eventA))
      .not.toBe(durableProvenanceId("decision-b", eventA));
    expect(durableProvenanceId(null, eventA))
      .toBe(durableProvenanceId(null, { ...eventA, event_id: 999 }));
  });
});
