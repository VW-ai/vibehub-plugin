import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exportGitSemanticStore,
  importGitSemanticStore,
} from "../src/experimental/git-semantic-store/index.js";
import { KnowledgeService, openDb, upsertRepo, type Db } from "../src/index.js";

const T0 = "2026-07-19T10:00:00.000Z";
const T1 = "2026-07-19T11:00:00.000Z";
const T2 = "2026-07-19T12:00:00.000Z";

function seedSemanticSubset(db: Db): number {
  const repo = upsertRepo(db, "/source/repo", "vibehub/repo", "main", T0);
  const other = upsertRepo(db, "/source/other", "vibehub/other", "trunk", T0);
  db.transaction(() => {
    db.prepare(`INSERT INTO kb_features (repo_id, feature_id, created_at) VALUES
      (?, 'feature/auth', ?), (?, 'feature/session', ?)`).run(repo.id, T0, repo.id, T1);
    db.prepare(`INSERT INTO kb_features (repo_id, feature_id, created_at)
      VALUES (?, 'feature/auth', ?)`).run(other.id, T0);

    const insertSpec = db.prepare(`INSERT INTO kb_specs
      (repo_id, spec_id, feature_id, state, current_revision, source_kind, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'canonical', ?, ?)`);
    insertSpec.run(repo.id, "decision-old", "feature/auth", "superseded", 2, T0, T2);
    insertSpec.run(repo.id, "decision-new", "feature/session", "active", 1, T1, T2);
    insertSpec.run(other.id, "decision-old", "feature/auth", "draft", 1, T0, T0);

    const revision = db.prepare(`INSERT INTO kb_spec_revisions
      (repo_id, spec_id, revision, type, summary, detail, priority, layer, domain,
       tags, producer, produced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    revision.run(
      repo.id, "decision-old", 1, "decision", "Use cookie sessions", "Initial",
      "P1", "runtime", "auth", `["auth","session"]`, "alice", T0,
    );
    revision.run(
      repo.id, "decision-old", 2, "decision", "Use signed cookie sessions", "Amended",
      "P1", "runtime", "auth", `["session","auth"]`, "bob", T2,
    );
    revision.run(
      repo.id, "decision-new", 1, "decision", "Replace legacy session format", null,
      null, "runtime", "auth", `["migration"]`, "bob", T1,
    );
    revision.run(
      other.id, "decision-old", 1, "context", "Other repository", null,
      null, null, null, `[]`, "other", T0,
    );

    const evidence = db.prepare(`INSERT INTO kb_evidence
      (repo_id, evidence_id, spec_id, revision, source_type, source_ref, exact_quote,
       evidence_ref, content_hash, confidence, producer, produced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    evidence.run(
      repo.id, "evidence-1", "decision-old", 1, "conversation", "chat:1",
      "cookies are local", null, null, 0.8, "alice", T0,
    );
    evidence.run(
      repo.id, "evidence-2", "decision-old", 2, "code", "src/auth.ts",
      null, "git:abc:src/auth.ts", "sha256:abc", 1, "bob", T2,
    );
    evidence.run(
      repo.id, "evidence-3", "decision-new", 1, "issue", "issue:42",
      null, "https://example.test/42", null, null, "bob", T1,
    );
    evidence.run(
      other.id, "other-evidence", "decision-old", 1, "conversation", "chat:other",
      "other", null, null, 0.5, "other", T0,
    );

    const anchor = db.prepare(`INSERT INTO kb_spec_revision_anchors
      (repo_id, spec_id, revision, file, symbol, line_start, line_end, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    anchor.run(repo.id, "decision-old", 1, "src/auth.ts", "legacy", 4, 8, "old");
    anchor.run(repo.id, "decision-old", 2, "src/auth.ts", "current", 10, 14, "new");
    anchor.run(repo.id, "decision-new", 1, "src/session.ts", "", null, null, null);
    anchor.run(other.id, "decision-old", 1, "other.ts", "", null, null, null);
    db.prepare(`INSERT INTO kb_spec_current_anchors
      SELECT a.repo_id, a.spec_id, a.revision, a.file, a.symbol,
        a.line_start, a.line_end, a.content_hash
      FROM kb_spec_revision_anchors a JOIN kb_specs s
        ON s.repo_id=a.repo_id AND s.spec_id=a.spec_id AND s.current_revision=a.revision`).run();

    db.prepare(`INSERT INTO kb_spec_relations
      (repo_id, from_spec_id, to_spec_id, type, rationale, created_at)
      VALUES (?, 'decision-old', 'decision-new', 'supersedes', 'new format', ?)`)
      .run(repo.id, T2);

    const provenance = db.prepare(`INSERT INTO kb_provenance_events
      (repo_id, operation, spec_id, actor, task_id, request_id, at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    provenance.run(
      repo.id, "kb.draft.apply", "decision-old", "alice", "task:1", "req:1", T0,
      `{"z":1,"a":{"later":false,"first":true}}`,
    );
    provenance.run(
      repo.id, "kb.amend", "decision-old", "bob", null, "req:2", T2,
      `{"revision":2}`,
    );
    provenance.run(
      repo.id, "kb.import", null, "system", null, "req:repo", T0,
      `{"source":"legacy"}`,
    );
    provenance.run(
      other.id, "kb.draft.apply", "decision-old", "other", null, "req:other", T0,
      `{"other":true}`,
    );

    // Explicitly excluded operational/projection state.
    db.prepare(`INSERT INTO mapping_runs (repo_id, started_at, finished_at)
      VALUES (?, ?, ?)`).run(repo.id, T0, T1);
    db.prepare(`INSERT INTO kb_mutation_receipts
      (repo_id, operation, idempotency_key, input_hash, result, created_at)
      VALUES (?, 'kb.draft.apply', 'receipt', 'hash', '{"ok":true}', ?)`).run(repo.id, T0);
  })();
  return repo.id;
}

function semanticProjection(db: Db, repoId: number): unknown {
  const select = (sql: string) => db.prepare(sql).all(repoId) as Array<Record<string, unknown>>;
  const normalizeJsonFields = (
    rows: Array<Record<string, unknown>>,
    fields: string[],
  ): Array<Record<string, unknown>> => rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      fields.includes(key) && typeof value === "string" ? JSON.parse(value) : value,
    ]),
  ));
  return {
    features: select(`SELECT feature_id, created_at FROM kb_features
      WHERE repo_id=? ORDER BY feature_id`),
    specs: select(`SELECT spec_id, feature_id, state, current_revision, source_kind,
      created_at, updated_at FROM kb_specs WHERE repo_id=? ORDER BY spec_id`),
    revisions: normalizeJsonFields(select(`SELECT spec_id, revision, type, summary, detail, priority, layer,
      domain, tags, producer, produced_at FROM kb_spec_revisions
      WHERE repo_id=? ORDER BY spec_id, revision`), ["tags"]),
    evidence: select(`SELECT evidence_id, spec_id, revision, source_type, source_ref,
      exact_quote, evidence_ref, content_hash, confidence, producer, produced_at
      FROM kb_evidence WHERE repo_id=? ORDER BY evidence_id`),
    revisionAnchors: select(`SELECT spec_id, revision, file, symbol, line_start, line_end,
      content_hash FROM kb_spec_revision_anchors
      WHERE repo_id=? ORDER BY spec_id, revision, file, symbol`),
    currentAnchors: select(`SELECT spec_id, revision, file, symbol, line_start, line_end,
      content_hash FROM kb_spec_current_anchors
      WHERE repo_id=? ORDER BY spec_id, file, symbol`),
    relations: select(`SELECT from_spec_id, to_spec_id, type, rationale, created_at
      FROM kb_spec_relations WHERE repo_id=? ORDER BY from_spec_id, type, to_spec_id`),
    provenance: normalizeJsonFields(select(`SELECT id, operation, spec_id, actor, task_id, request_id, at, payload
      FROM kb_provenance_events WHERE repo_id=? ORDER BY id`), ["payload"]),
  };
}

function filesUnder(root: string): Array<{ relative: string; bytes: Buffer }> {
  const visit = (directory: string): string[] => fs.readdirSync(directory)
    .flatMap((name) => {
      const absolute = path.join(directory, name);
      return fs.statSync(absolute).isDirectory() ? visit(absolute) : [absolute];
    });
  return visit(root).sort().map((absolute) => ({
    relative: path.relative(root, absolute),
    bytes: fs.readFileSync(absolute),
  }));
}

describe("experimental Git semantic store spike", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) =>
    fs.rmSync(root, { recursive: true, force: true })));

  it("passes digest, semantic query parity, and byte equality round-trip oracles", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-semantic-store-"));
    roots.push(root);
    const sourceDbPath = path.join(root, "source.db");
    const source = openDb(sourceDbPath);
    const sourceRepoId = seedSemanticSubset(source);
    const sourceProjection = semanticProjection(source, sourceRepoId);
    const sourceService = new KnowledgeService(source);
    const sourceQueries = {
      old: sourceService.getSpec(sourceRepoId, "decision-old"),
      search: sourceService.searchSpecs(sourceRepoId, {
        query: "cookie",
        paths: ["src"],
        includeHistory: true,
      }),
      graph: sourceService.traverseRelations(sourceRepoId, {
        specId: "decision-old",
        direction: "both",
        depth: 2,
      }),
      lineage: sourceService.resolveLineage(sourceRepoId, "decision-old"),
    };
    source.close();

    const firstWorktree = path.join(root, "checkout-a");
    fs.mkdirSync(firstWorktree);
    const exported = exportGitSemanticStore({
      dbPath: sourceDbPath,
      repoId: sourceRepoId,
      worktreeRoot: firstWorktree,
    });
    expect(exported).toMatchObject({ featureCount: 2, specCount: 2 });

    const imported = importGitSemanticStore({
      worktreeRoot: firstWorktree,
      targetDbPath: path.join(root, "rebuilt.db"),
      targetRepoRootPath: path.join(root, "rebuilt-checkout"),
    });
    expect(imported.semanticDigest).toBe(exported.semanticDigest);
    const rebuilt = openDb(imported.dbPath);
    expect(semanticProjection(rebuilt, imported.repoId)).toEqual(sourceProjection);
    const rebuiltService = new KnowledgeService(rebuilt);
    expect({
      old: rebuiltService.getSpec(imported.repoId, "decision-old"),
      search: rebuiltService.searchSpecs(imported.repoId, {
        query: "cookie",
        paths: ["src"],
        includeHistory: true,
      }),
      graph: rebuiltService.traverseRelations(imported.repoId, {
        specId: "decision-old",
        direction: "both",
        depth: 2,
      }),
      lineage: rebuiltService.resolveLineage(imported.repoId, "decision-old"),
    }).toEqual(sourceQueries);
    expect(rebuilt.prepare(`SELECT COUNT(*) AS n FROM mapping_runs`).get()).toEqual({ n: 0 });
    expect(rebuilt.prepare(`SELECT COUNT(*) AS n FROM mapping_versions`).get()).toEqual({ n: 0 });
    expect(rebuilt.prepare(`SELECT COUNT(*) AS n FROM kb_mutation_receipts`).get()).toEqual({ n: 0 });
    expect(rebuilt.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    rebuilt.close();

    const secondWorktree = path.join(root, "checkout-b");
    fs.mkdirSync(secondWorktree);
    const reexported = exportGitSemanticStore({
      dbPath: imported.dbPath,
      repoId: imported.repoId,
      worktreeRoot: secondWorktree,
    });
    expect(reexported.semanticDigest).toBe(exported.semanticDigest);
    expect(filesUnder(reexported.storePath)).toEqual(filesUnder(exported.storePath));
  });

  it("rejects non-canonical protocol bytes and never overwrites a target database", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-semantic-strict-"));
    roots.push(root);
    const sourceDbPath = path.join(root, "source.db");
    const source = openDb(sourceDbPath);
    const repoId = seedSemanticSubset(source);
    source.close();
    const worktree = path.join(root, "checkout");
    fs.mkdirSync(worktree);
    const exported = exportGitSemanticStore({ dbPath: sourceDbPath, repoId, worktreeRoot: worktree });

    const existing = path.join(root, "existing.db");
    fs.writeFileSync(existing, "do-not-touch");
    expect(() => importGitSemanticStore({
      worktreeRoot: worktree,
      targetDbPath: existing,
      targetRepoRootPath: "/target",
    })).toThrow(/already exists/);
    expect(fs.readFileSync(existing, "utf8")).toBe("do-not-touch");

    const manifestPath = path.join(exported.storePath, "manifest.yaml");
    const canonicalManifest = fs.readFileSync(manifestPath);
    fs.appendFileSync(manifestPath, "\n");
    const rejectedTarget = path.join(root, "rejected.db");
    expect(() => importGitSemanticStore({
      worktreeRoot: worktree,
      targetDbPath: rejectedTarget,
      targetRepoRootPath: "/target",
    })).toThrow(/non-canonical/);
    expect(fs.existsSync(rejectedTarget)).toBe(false);

    fs.writeFileSync(manifestPath, canonicalManifest);
    fs.writeFileSync(path.join(exported.storePath, "specs", "unlisted.yaml"), "{}\n");
    expect(() => importGitSemanticStore({
      worktreeRoot: worktree,
      targetDbPath: rejectedTarget,
      targetRepoRootPath: "/target",
    })).toThrow(/inventory/);
    expect(fs.existsSync(rejectedTarget)).toBe(false);
  });
});
