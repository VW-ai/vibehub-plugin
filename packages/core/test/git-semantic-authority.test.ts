import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GIT_SEMANTIC_STORE_RELATIVE_PATH,
  DistillationService,
  KnowledgeService,
  OperationDispatcher,
  inspectGitSemanticStoreWorktree,
  materializeSemanticCacheFromWorktree,
  migrateSqliteSemanticStoreToGitV2,
  openDb,
  replaceGitSemanticStoreV2,
  stableSemanticPath,
  upsertRepo,
} from "../src/index.js";

const NOW = "2026-07-20T10:00:00.000Z";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Semantic Authority Test",
    GIT_AUTHOR_EMAIL: "semantic-authority@example.test",
    GIT_COMMITTER_NAME: "Semantic Authority Test",
    GIT_COMMITTER_EMAIL: "semantic-authority@example.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  },
});

describe("Git semantic authority cutover", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) =>
    fs.rmSync(root, { recursive: true, force: true })));

  it("performs a repo-scoped cutover and keeps SQLite semantic rows cache-only", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-authority-"));
    roots.push(root);
    const repo = path.join(root, "repo");
    const dbPath = path.join(root, "operational.db");
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "# authority\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");

    const db = openDb(dbPath);
    const row = upsertRepo(db, repo, "vibehub/authority", "main", NOW);
    db.prepare(`INSERT INTO kb_features(repo_id,feature_id,created_at)
      VALUES (?, 'feature/auth', ?)`).run(row.id, NOW);
    db.close();

    const migrated = migrateSqliteSemanticStoreToGitV2({
      sourceDbPath: dbPath,
      sourceRepoId: row.id,
      repoRoot: repo,
    });
    expect(migrated).toMatchObject({ featureCount: 1, specCount: 0 });
    expect(fs.existsSync(path.join(
      repo,
      GIT_SEMANTIC_STORE_RELATIVE_PATH,
      "protocol.yaml",
    ))).toBe(true);

    const operational = openDb(dbPath);
    const dispatcher = new OperationDispatcher(operational);
    const context = {
      repoId: row.id,
      actor: "wayne",
      taskId: "task:authority",
      requestId: "request:create",
      now: NOW,
    };
    const input = {
      idempotencyKey: "create-decision",
      specs: [{
        id: "decision-auth",
        featureId: "feature/auth",
        type: "decision",
        summary: "Git is durable truth",
        evidence: [{
          sourceType: "review",
          sourceRef: "architecture:028",
          exactQuote: "approved",
          confidence: 1,
        }],
      }],
    };
    expect(dispatcher.dispatch("kb.draft.apply", context, input)).toMatchObject({
      ok: true,
      data: { created: ["decision-auth"] },
    });

    expect(operational.prepare(`SELECT COUNT(*) n FROM kb_specs
      WHERE repo_id=?`).get(row.id)).toEqual({ n: 0 });
    expect(operational.prepare(`SELECT COUNT(*) n FROM kb_mutation_receipts
      WHERE repo_id=?`).get(row.id)).toEqual({ n: 1 });
    expect(inspectGitSemanticStoreWorktree(repo)).toMatchObject({
      featureCount: 1,
      specCount: 1,
    });
    expect(dispatcher.dispatch("kb.spec.get", {
      ...context,
      requestId: "request:read",
    }, { id: "decision-auth" })).toMatchObject({
      ok: true,
      data: { id: "decision-auth", summary: "Git is durable truth" },
    });
    expect(() => new KnowledgeService(operational).getSpec(row.id, "decision-auth"))
      .toThrow(/repository-aware OperationDispatcher/);

    operational.prepare(`DELETE FROM kb_mutation_receipts WHERE repo_id=?`).run(row.id);
    expect(dispatcher.dispatch("kb.draft.apply", {
      ...context,
      requestId: "request:recovered-retry",
    }, input)).toMatchObject({
      ok: true,
      data: { created: ["decision-auth"] },
    });

    expect(dispatcher.dispatch("kb.draft.apply", {
      ...context,
      requestId: "request:conflict",
    }, {
      ...input,
      specs: [{
        ...input.specs[0],
        id: "decision-other",
      }],
    })).toMatchObject({
      ok: false,
      error: { code: "idempotency_conflict" },
    });
    const storePath = path.join(repo, GIT_SEMANTIC_STORE_RELATIVE_PATH);
    const heldStore = path.join(repo, ".vibehub", "semantic-store", "held-v2");
    fs.renameSync(storePath, heldStore);
    expect(dispatcher.dispatch("kb.status", {
      ...context,
      requestId: "request:missing-store",
    }, {})).toMatchObject({
      ok: false,
      error: { code: "semantic_store_missing" },
    });
    fs.renameSync(heldStore, storePath);
    operational.close();

    const rebuiltPath = path.join(root, "rebuilt.db");
    const rebuilt = materializeSemanticCacheFromWorktree({
      repoRoot: repo,
      targetDbPath: rebuiltPath,
    });
    const rebuiltDb = openDb(rebuiltPath);
    expect(new KnowledgeService(rebuiltDb).getSpec(rebuilt.repoId, "decision-auth"))
      .toMatchObject({ summary: "Git is durable truth" });
    rebuiltDb.close();
  });

  it("aborts a candidate write when the semantic worktree changed concurrently", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-authority-cas-"));
    roots.push(root);
    const repo = path.join(root, "repo");
    const dbPath = path.join(root, "source.db");
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "# cas\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");
    const db = openDb(dbPath);
    const row = upsertRepo(db, repo, null, "main", NOW);
    db.prepare(`INSERT INTO kb_features(repo_id,feature_id,created_at)
      VALUES (?, 'feature/auth', ?)`).run(row.id, NOW);
    const service = new KnowledgeService(db);
    service.applyDraftBatch(row.id, {
      idempotencyKey: "seed",
      specs: [{
        id: "decision-auth",
        featureId: "feature/auth",
        type: "decision",
        summary: "Before",
        evidence: [{
          sourceType: "test",
          sourceRef: "test:cas",
          exactQuote: "before",
        }],
      }],
    }, {
      actor: "test",
      taskId: "task:cas",
      requestId: "request:seed",
      now: NOW,
    });
    db.close();
    migrateSqliteSemanticStoreToGitV2({
      sourceDbPath: dbPath,
      sourceRepoId: row.id,
      repoRoot: repo,
    });
    const before = inspectGitSemanticStoreWorktree(repo);
    const candidatePath = path.join(root, "candidate.db");
    const candidate = materializeSemanticCacheFromWorktree({
      repoRoot: repo,
      targetDbPath: candidatePath,
    });
    const specPath = path.join(repo, stableSemanticPath("specs", "decision-auth"));
    const document = JSON.parse(fs.readFileSync(specPath, "utf8")) as {
      revisions: Array<{ summary: string }>;
    };
    document.revisions[0]!.summary = "Concurrent edit";
    fs.writeFileSync(specPath, `${JSON.stringify(document, null, 2)}\n`);

    expect(() => replaceGitSemanticStoreV2({
      sourceDbPath: candidatePath,
      sourceRepoId: candidate.repoId,
      repoRoot: repo,
      expectedSemanticDigest: before.semanticDigest,
    })).toThrow(/concurrent worktree semantic change/);
    expect(JSON.parse(fs.readFileSync(specPath, "utf8"))).toMatchObject({
      revisions: [{ summary: "Concurrent edit" }],
    });
  });

  it("promotes finalized feature identities into Git without moving distillation state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-authority-distill-"));
    roots.push(root);
    const repo = path.join(root, "repo");
    const dbPath = path.join(root, "operational.db");
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    fs.writeFileSync(path.join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "initial");
    const commit = git(repo, "rev-parse", "HEAD").trim();
    const db = openDb(dbPath);
    const row = upsertRepo(db, repo, null, "main", NOW);
    db.close();
    migrateSqliteSemanticStoreToGitV2({
      sourceDbPath: dbPath,
      sourceRepoId: row.id,
      repoRoot: repo,
    });

    const operational = openDb(dbPath);
    const service = new DistillationService(operational);
    const context = {
      actor: "distiller",
      taskId: "task:distill",
      requestId: "request:distill",
      now: NOW,
    };
    service.start(row.id, {
      runId: "run-1",
      mode: "cold",
      baseCommit: commit,
      skillHash: "skill",
      configHash: "config",
    }, context);
    service.putInventory(row.id, {
      runId: "run-1",
      rows: [{ path: "a.ts", classification: "included", contentHash: "hash-a" }],
    }, context);
    service.sealInventory(row.id, { runId: "run-1" }, context);
    service.planScopes(row.id, {
      runId: "run-1",
      scopes: [{ scopeId: "leaf", parentScopeId: null, kind: "leaf", files: ["a.ts"] }],
    }, context);
    const lease = service.claimScope(row.id, {
      runId: "run-1",
      workerId: "worker",
      leaseSeconds: 60,
    }, context)!;
    service.putCandidate(row.id, {
      runId: "run-1",
      kind: "feature",
      naturalId: "feature/a",
      sourceScopeId: "leaf",
      leaseToken: lease.leaseToken,
      generation: lease.generation,
      payload: { name: "Feature A" },
      evidence: [{ sourceRef: "a.ts", contentHash: "hash-a" }],
    }, context);
    service.putCandidate(row.id, {
      runId: "run-1",
      kind: "anchor",
      naturalId: "feature/a:a.ts",
      sourceScopeId: "leaf",
      leaseToken: lease.leaseToken,
      generation: lease.generation,
      payload: { featureId: "feature/a", file: "a.ts", contentHash: "hash-a" },
      evidence: [{ sourceRef: "a.ts", contentHash: "hash-a" }],
    }, context);
    service.completeScope(row.id, {
      runId: "run-1",
      scopeId: "leaf",
      leaseToken: lease.leaseToken,
      generation: lease.generation,
      coveredFiles: ["a.ts"],
    }, context);
    service.reconcile(row.id, { runId: "run-1" }, context);
    service.validate(row.id, { runId: "run-1" }, context);
    const finalized = new OperationDispatcher(operational, { repoRoot: repo }).dispatch(
      "distill.finalize",
      { ...context, repoId: row.id, requestId: "request:finalize" },
      { runId: "run-1" },
    );
    expect(finalized).toMatchObject({ ok: true });
    expect(inspectGitSemanticStoreWorktree(repo)).toMatchObject({
      featureCount: 1,
      specCount: 0,
      provenanceCount: 1,
    });
    expect(operational.prepare(`SELECT COUNT(*) n FROM distill_runs
      WHERE repo_id=?`).get(row.id)).toEqual({ n: 1 });
    operational.close();
  });
});
