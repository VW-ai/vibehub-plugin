import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  KnowledgeService,
  inspectGitSemanticStoreWorktree,
  materializeSemanticCacheFromWorktree,
  migrateMetaSpecsToCanonical,
  migrateSqliteSemanticStoreToGit,
  openDb,
  upsertRepo,
} from "../src/index.js";

const NOW = "2026-07-31T18:00:00.000Z";

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "META Migration Test",
    GIT_AUTHOR_EMAIL: "meta-migration@example.test",
    GIT_COMMITTER_NAME: "META Migration Test",
    GIT_COMMITTER_EMAIL: "meta-migration@example.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  },
});

const writeYaml = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(value));
};

const metaSpec = (
  id: string,
  state: "draft" | "active" | "stale" | "superseded",
  extras: Record<string, unknown> = {},
) => ({
  spec_id: id,
  type: id.startsWith("intent-") ? "intent" : id.startsWith("context-") ? "context" : "decision",
  state,
  intent: { summary: `Summary for ${id}`, detail: `Detail for ${id}` },
  constraints: [{ kind: "must", rule: `Preserve ${id}` }],
  indexing: {
    type: id.startsWith("intent-") ? "intent" : id.startsWith("context-") ? "context" : "decision",
    priority: "P0",
    layer: "feature",
    domain: "migration-test",
    tags: ["meta", "migration"],
  },
  provenance: {
    source_type: "authored_spec",
    confidence: 1,
    source_ref: `fixture:${id}`,
    produced_at: "2026-07-30",
  },
  relations: [],
  anchors: [],
  ...extras,
});

describe("META canonical migration", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) =>
    fs.rmSync(root, { recursive: true, force: true })));

  it("deduplicates current sources and preserves lifecycle, placement, evidence, anchors, and normalized relations atomically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-meta-migration-test-"));
    roots.push(root);
    const repo = path.join(root, "repo");
    const dbPath = path.join(root, "source.db");
    fs.mkdirSync(repo);
    git(repo, "init", "-b", "main");
    fs.writeFileSync(path.join(repo, "README.md"), "# migration\n");
    fs.mkdirSync(path.join(repo, "src"));
    writeYaml(path.join(repo, "META/current-room/room.yaml"), {
      room: { id: "current-room", name: "Current", parent: null },
    });
    writeYaml(path.join(repo, "META/legacy-21-workbench/room.yaml"), {
      id: "legacy-room",
      name: "Legacy",
      parent: "current-room",
    });
    writeYaml(path.join(repo, "META/current-room/specs/decision-current.yaml"),
      metaSpec("decision-current", "active"));
    writeYaml(path.join(repo, "META/current-room/specs/intent-draft.yaml"),
      metaSpec("intent-draft", "draft", { anchors: [{ file: "src/" }] }));
    writeYaml(path.join(repo, "META/current-room/specs/context-stale.yaml"),
      metaSpec("context-stale", "stale", { relations: [
        { target: "decision-current", type: "implements", detail: "Implementation context" },
        { target: "missing-spec", type: "relates_to" },
      ] }));
    writeYaml(path.join(repo, "META/legacy-21-workbench/specs/decision-old.yaml"),
      metaSpec("decision-old", "superseded", { relations: [
        { target: "decision-current", type: "superseded_by" },
      ] }));
    writeYaml(path.join(repo, "META/legacy-21-workbench/specs/decision-current.yaml"), {
      spec_id: "decision-current",
      clarifications: "The current Room copy must win before full legacy validation.",
    });
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "fixture");

    const source = openDb(dbPath);
    const row = upsertRepo(source, repo, "fixture/meta", "main", NOW);
    source.prepare(`INSERT INTO kb_features(repo_id,feature_id,created_at) VALUES(?,? ,?)`)
      .run(row.id, "current-room", NOW);
    source.prepare(`INSERT INTO kb_features(repo_id,feature_id,created_at) VALUES(?,? ,?)`)
      .run(row.id, "legacy-room", NOW);
    new KnowledgeService(source).applySpecBatch(row.id, {
      idempotencyKey: "existing",
      specs: [{
        id: "context-existing",
        type: "context",
        summary: "Existing canonical truth",
        evidence: [{ sourceType: "test", sourceRef: "fixture", exactQuote: "existing" }],
      }],
    }, { actor: "test", taskId: "test", requestId: "existing", now: NOW });
    source.close();
    migrateSqliteSemanticStoreToGit({ sourceDbPath: dbPath, sourceRepoId: row.id, repoRoot: repo });

    const result = migrateMetaSpecsToCanonical({
      repoRoot: repo,
      actor: "migration-test",
      taskId: "task:meta",
      requestId: "request:meta",
      now: NOW,
    });
    expect(result).toMatchObject({
      sourceFileCount: 5,
      selectedSpecCount: 4,
      duplicateSourceCount: 1,
      skippedRelationCount: 1,
      normalizedAnchorPathCount: 1,
      canonicalRelationCount: 2,
      stateCounts: { active: 1, draft: 1, stale: 1, superseded: 1, deprecated: 0 },
      finalSpecCount: 5,
      finalFeatureCount: 2,
    });
    expect(result.skippedSources).toEqual([expect.objectContaining({
      specId: "decision-current",
      sourcePath: "META/legacy-21-workbench/specs/decision-current.yaml",
    })]);

    const cachePath = path.join(root, "rebuilt.db");
    const materialized = materializeSemanticCacheFromWorktree({ repoRoot: repo, targetDbPath: cachePath });
    const rebuilt = openDb(cachePath);
    const service = new KnowledgeService(rebuilt);
    expect(service.getSpec(materialized.repoId, "intent-draft")).toMatchObject({
      state: "draft",
      featureId: "current-room",
      anchors: [{ file: "src", symbol: "" }],
    });
    expect(service.getSpec(materialized.repoId, "decision-old")).toMatchObject({
      state: "superseded",
      featureId: "legacy-room",
      relations: [expect.objectContaining({
        fromSpecId: "decision-old",
        toSpecId: "decision-current",
        type: "supersedes",
      })],
    });
    expect(service.getSpec(materialized.repoId, "context-stale")).toMatchObject({
      state: "stale",
      relations: [expect.objectContaining({ type: "relates_to" })],
      evidence: expect.arrayContaining([expect.objectContaining({ sourceType: "meta_constraint" })]),
      history: [expect.objectContaining({ operation: "meta_canonical_migration" })],
    });
    rebuilt.close();

    const installed = inspectGitSemanticStoreWorktree(repo);
    expect(() => migrateMetaSpecsToCanonical({
      repoRoot: repo,
      actor: "migration-test",
      taskId: "task:meta",
      requestId: "request:retry",
      now: NOW,
    })).toThrow(/canonical spec already exists/);
    expect(inspectGitSemanticStoreWorktree(repo).semanticDigest).toBe(installed.semanticDigest);
  });
});
