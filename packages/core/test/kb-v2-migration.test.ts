import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeMappingChecksum, CURRENT_SCHEMA_VERSION, openDb } from "../src/db.js";
import { listTerritories, readSpec, readTerritoryLayouts } from "../src/graph-store.js";

const T0 = "2026-07-13T00:00:00.000Z";

function createLegacyV7(file: string): Database.Database {
  const db = new Database(file);
  db.pragma("foreign_keys = OFF");
  db.exec(`
    CREATE TABLE repos (id INTEGER PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, slug TEXT,
      default_branch TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE features (id TEXT PRIMARY KEY, repo_id INTEGER NOT NULL, parent_id TEXT,
      name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE specs (id TEXT PRIMARY KEY, repo_id INTEGER NOT NULL, feature_id TEXT,
      type TEXT NOT NULL, state TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE anchors (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, feature_id TEXT,
      spec_id TEXT, file TEXT NOT NULL, symbol TEXT);
    CREATE TABLE edges (id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL,
      from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL);
    CREATE TABLE feature_layouts (feature_id TEXT PRIMARY KEY, pct_left REAL NOT NULL,
      pct_top REAL NOT NULL, pct_width REAL NOT NULL, pct_height REAL NOT NULL,
      computed_at TEXT NOT NULL);
    PRAGMA user_version = 7;
  `);
  return db;
}

function seedRepo(db: Database.Database, repoId: number, suffix: string): void {
  db.prepare(`INSERT INTO repos VALUES (?, ?, ?, 'main', ?)`).run(repoId, `/repo-${suffix}`, suffix, T0);
  db.prepare(`INSERT INTO features VALUES ('root', ?, NULL, ?, ?, ?)`).run(repoId, `Root ${suffix}`, T0, T0);
  db.prepare(`INSERT INTO features VALUES ('child', ?, 'root', ?, ?, ?)`).run(repoId, `Child ${suffix}`, T0, T0);
  db.prepare(`INSERT INTO specs VALUES ('old', ?, 'root', 'decision', 'superseded', ?, NULL, ?, ?)`).run(repoId, `Old ${suffix}`, T0, T0);
  db.prepare(`INSERT INTO specs VALUES ('new', ?, 'child', 'decision', 'active', ?, ?, ?, ?)`).run(repoId, `New ${suffix}`, `Detail ${suffix}`, T0, T0);
  db.prepare(`INSERT INTO anchors (repo_id, feature_id, file, symbol) VALUES (?, 'child', 'src/a.ts', 'A')`).run(repoId);
  db.prepare(`INSERT INTO anchors (repo_id, spec_id, file, symbol) VALUES (?, 'new', 'src/a.ts', 'A')`).run(repoId);
  // Legacy direction was NEW -> OLD; v2 canonical direction is OLD -> NEW.
  db.prepare(`INSERT INTO edges (repo_id, from_id, to_id, type) VALUES (?, 'new', 'old', 'supersedes')`).run(repoId);
  db.prepare(`INSERT INTO edges (repo_id, from_id, to_id, type) VALUES (?, 'old', 'new', 'depends_on')`).run(repoId);
  db.prepare(`INSERT INTO edges (repo_id, from_id, to_id, type) VALUES (?, 'child', 'root', 'part_of')`).run(repoId);
  db.prepare(`INSERT INTO edges (repo_id, from_id, to_id, type) VALUES (?, 'new', 'free text', 'explains')`).run(repoId);
  db.prepare(`INSERT INTO feature_layouts VALUES ('root', 1, 2, 60, 90, ?)`).run(T0);
}

function legacyGraphProjection(db: Database.Database, repoId: number): string {
  const features = db.prepare(`SELECT id, parent_id AS parentId, name FROM features WHERE repo_id = ? ORDER BY name`)
    .all(repoId) as Array<{ id: string; parentId: string | null; name: string }>;
  const count = db.prepare(`SELECT COUNT(DISTINCT file) AS n FROM anchors WHERE repo_id = ?
    AND (feature_id = ? OR feature_id IN (SELECT id FROM features WHERE repo_id = ? AND parent_id = ?))`);
  const n = (id: string): number => (count.get(repoId, id, repoId, id) as { n: number }).n;
  return JSON.stringify(features.filter((row) => !row.parentId).map((row) => ({
    id: row.id, name: row.name, anchoredFileCount: n(row.id),
    subBlocks: features.filter((child) => child.parentId === row.id)
      .map((child) => ({ id: child.id, name: child.name, anchoredFileCount: n(child.id) })),
  })));
}

describe("migration 008 — canonical KB and immutable mapping boundary", () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

  it("imports every legacy repo losslessly with repo-scoped identities, audited direction, and quarantine", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-kbv2-")); dirs.push(dir);
    const file = path.join(dir, "legacy.db");
    const raw = createLegacyV7(file);
    seedRepo(raw, 1, "one");
    raw.prepare(`INSERT INTO edges (repo_id, from_id, to_id, type) VALUES (1, 'old', 'new', 'supersedes')`).run();
    raw.prepare(`INSERT INTO anchors (repo_id, feature_id, file) VALUES (1, 'root', '../escape.ts')`).run();
    raw.prepare(`INSERT INTO anchors (repo_id, spec_id, file) VALUES (1, 'new', '/absolute.ts')`).run();
    raw.prepare(`INSERT INTO anchors (repo_id, feature_id, file) VALUES (1, 'root', './src/normalized.ts')`).run();
    // Legacy global PKs cannot physically repeat IDs. Re-create the second repo's
    // rows after dropping only those PKs to model databases produced by imports.
    raw.exec(`
      CREATE TABLE features_dupe AS SELECT * FROM features WHERE 0;
      CREATE TABLE specs_dupe AS SELECT * FROM specs WHERE 0;
    `);
    raw.prepare(`INSERT INTO repos VALUES (2, '/repo-two', 'two', 'main', ?)`).run(T0);
    raw.prepare(`INSERT INTO features_dupe VALUES ('root', 2, NULL, 'Root two', ?, ?)`).run(T0, T0);
    raw.prepare(`INSERT INTO specs_dupe VALUES ('new', 2, 'root', 'context', 'draft', 'New two', NULL, ?, ?)`).run(T0, T0);
    // Fold duplicate-source fixtures into PK-free legacy views consumed by migration.
    raw.exec(`
      ALTER TABLE features RENAME TO features_pk;
      CREATE TABLE features AS SELECT * FROM features_pk UNION ALL SELECT * FROM features_dupe;
      ALTER TABLE specs RENAME TO specs_pk;
      CREATE TABLE specs AS SELECT * FROM specs_pk UNION ALL SELECT * FROM specs_dupe;
      DROP TABLE features_pk; DROP TABLE features_dupe; DROP TABLE specs_pk; DROP TABLE specs_dupe;
    `);
    raw.close();

    const db = openDb(file);
    expect(CURRENT_SCHEMA_VERSION).toBe(14);
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare(`SELECT repo_id, feature_id FROM kb_features WHERE feature_id = 'root' ORDER BY repo_id`).all())
      .toEqual([{ repo_id: 1, feature_id: "root" }, { repo_id: 2, feature_id: "root" }]);
    expect(db.prepare(`SELECT repo_id, spec_id FROM kb_specs WHERE spec_id = 'new' ORDER BY repo_id`).all())
      .toEqual([{ repo_id: 1, spec_id: "new" }, { repo_id: 2, spec_id: "new" }]);
    expect(db.prepare(`SELECT from_spec_id, to_spec_id, type FROM kb_spec_relations WHERE repo_id = 1 ORDER BY type`).all())
      .toEqual([
        { from_spec_id: "old", to_spec_id: "new", type: "depends_on" },
        { from_spec_id: "old", to_spec_id: "new", type: "supersedes" },
      ]);
    expect(db.prepare(`SELECT action FROM kb_import_audit WHERE repo_id = 1 AND legacy_type = 'supersedes'`).get())
      .toEqual({ action: "inverted_new_to_old" });
    expect(db.prepare(`SELECT legacy_type, reason FROM kb_import_quarantine
      WHERE repo_id = 1 AND legacy_table = 'edges' ORDER BY legacy_type, reason`).all())
      .toEqual([
        { legacy_type: "explains", reason: "unsupported_or_non_spec_relation" },
        { legacy_type: "part_of", reason: "unsupported_or_non_spec_relation" },
        { legacy_type: "supersedes", reason: "supersedes_cycle" },
      ]);
    expect(db.prepare(`SELECT action FROM kb_import_audit WHERE repo_id = 1 AND legacy_table = 'edges'
      AND legacy_type = 'supersedes' ORDER BY legacy_row_id DESC LIMIT 1`).get()).toEqual({ action: "quarantined_cycle" });
    expect(db.prepare(`SELECT reason FROM kb_import_quarantine WHERE legacy_table = 'anchors' ORDER BY legacy_row_id`).all())
      .toEqual([{ reason: "invalid_anchor_path" }, { reason: "invalid_anchor_path" }]);
    expect(db.prepare(`SELECT file FROM mapping_version_anchors WHERE file = 'src/normalized.ts'`).get())
      .toEqual({ file: "src/normalized.ts" });
    expect(db.prepare(`SELECT evidence_ref, content_hash FROM kb_evidence`).all().every((row) => {
      const value = row as { evidence_ref: string | null; content_hash: string | null };
      return Boolean(value.evidence_ref && value.content_hash);
    })).toBe(true);
    expect(db.prepare(`SELECT reason FROM kb_import_quarantine WHERE legacy_table = 'feature_layouts'`).all())
      .toEqual([{ reason: "ambiguous_legacy_feature_id" }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM mapping_version_layouts`).get()).toEqual({ n: 0 });
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    const versions = db.prepare(`SELECT repo_id, version_id, state, checksum FROM mapping_versions ORDER BY repo_id`).all() as
      Array<{ repo_id: number; version_id: string; state: string; checksum: string }>;
    expect(versions.every((row) => row.state === "finalized" && row.checksum === computeMappingChecksum(db, row.repo_id, row.version_id))).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM kb_spec_revisions`).get()).toEqual({ n: 3 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM kb_evidence`).get()).toEqual({ n: 3 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM kb_spec_current_anchors`).get()).toEqual({ n: 1 });
    db.close();
  });

  it("upgrades v11 databases with immutable unresolved scope dispositions",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vibehub-unresolved-migration-"));dirs.push(dir);
    const file=path.join(dir,"legacy-v11.db"),db=openDb(file);db.close();
    const raw=new Database(file);raw.exec(`DROP TABLE IF EXISTS distill_scope_dispositions; DROP TABLE IF EXISTS operation_request_receipts; PRAGMA user_version=11;`);raw.close();
    const upgraded=openDb(file);
    expect(upgraded.pragma("user_version",{simple:true})).toBe(CURRENT_SCHEMA_VERSION);
    expect(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='distill_scope_dispositions'`).get()).toEqual({name:"distill_scope_dispositions"});
    upgraded.prepare(`INSERT INTO repos(root_path,default_branch,created_at) VALUES('/integrity','main',?)`).run(T0);
    const insertReceipt=upgraded.prepare(`INSERT INTO operation_request_receipts(repo_id,request_id,operation,payload_hash,outcome_kind,outcome,created_at) VALUES(1,?,'kb.status','hash','success',?,?)`);
    expect(()=>insertReceipt.run('missing-ok','{}',T0)).toThrow(/CHECK constraint/);
    expect(()=>insertReceipt.run('non-boolean-ok','{"ok":"true"}',T0)).toThrow(/CHECK constraint/);
    upgraded.prepare(`INSERT INTO distill_runs(repo_id,run_id,mode,base_commit,skill_hash,config_hash,state,created_at,updated_at) VALUES(1,'r','cold',?,'s','c','running',?,?)`).run("a".repeat(40),T0,T0);
    upgraded.prepare(`INSERT INTO distill_inventory(repo_id,run_id,path,classification,content_hash,reason) VALUES(1,'r','owned.ts','included','h',NULL),(1,'r','other.ts','included','h',NULL),(1,'r','excluded.ts','excluded',NULL,'generated_or_dependency')`).run();
    upgraded.prepare(`INSERT INTO distill_scopes(repo_id,run_id,scope_id,kind,state,lease_generation) VALUES(1,'r','leaf','leaf','completed',2),(1,'r','other','leaf','completed',2),(1,'r','analysis','analysis','completed',2)`).run();
    upgraded.prepare(`INSERT INTO distill_scope_files(repo_id,run_id,path,scope_id) VALUES(1,'r','owned.ts','leaf'),(1,'r','other.ts','other'),(1,'r','excluded.ts','leaf')`).run();
    const insert=upgraded.prepare(`INSERT INTO distill_scope_dispositions(repo_id,run_id,scope_id,path,accepted_lease_generation,reason,producer,produced_at) VALUES(1,'r',?,?,?,'reason','worker',?)`);
    expect(()=>insert.run('leaf','other.ts',2,T0)).toThrow(/completed leaf generation/);
    expect(()=>insert.run('analysis','owned.ts',2,T0)).toThrow(/completed leaf generation/);
    expect(()=>insert.run('leaf','owned.ts',1,T0)).toThrow(/completed leaf generation/);
    expect(()=>insert.run('leaf','excluded.ts',2,T0)).toThrow(/completed leaf generation/);
    expect(insert.run('leaf','owned.ts',2,T0).changes).toBe(1);
    upgraded.close();
  });

  it("cuts map/spec readers to the active v2 mapping without changing the legacy snapshot shape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-kbv2-parity-")); dirs.push(dir);
    const file = path.join(dir, "legacy.db");
    const raw = createLegacyV7(file); seedRepo(raw, 1, "one");
    const before = legacyGraphProjection(raw, 1);
    raw.close();
    const db = openDb(file);
    expect(JSON.stringify(listTerritories(db, 1))).toBe(before);
    expect(listTerritories(db, 1)).toEqual([
      { id: "root", name: "Root one", anchoredFileCount: 1, subBlocks: [
        { id: "child", name: "Child one", anchoredFileCount: 1 },
      ] },
    ]);
    expect(readTerritoryLayouts(db, 1).get("root")).toEqual({ left: 1, top: 2, width: 60, height: 90 });
    expect(readSpec(db, 1, "new")).toMatchObject({ id: "new", repoId: 1, featureId: "child", state: "active", summary: "New one" });
    db.close();
  });

  it("rolls the migration back when an explicit import assertion fails", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-kbv2-rollback-")); dirs.push(dir);
    const file = path.join(dir, "legacy.db");
    const raw = createLegacyV7(file);
    raw.prepare(`INSERT INTO repos VALUES (1, '/repo', 'repo', 'main', ?)`).run(T0);
    raw.prepare(`INSERT INTO specs VALUES ('orphan', 1, 'missing', 'context', 'draft', 'x', NULL, ?, ?)`).run(T0, T0);
    raw.close();
    expect(() => openDb(file)).toThrow(/KB_V2_IMPORT_ASSERTION/);
    const inspect = new Database(file);
    expect(inspect.pragma("user_version", { simple: true })).toBe(7);
    expect(inspect.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='kb_specs'`).get()).toBeUndefined();
    inspect.close();
  });

  it("hard-freezes every legacy graph table after import", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-kbv2-freeze-")); dirs.push(dir);
    const file = path.join(dir, "legacy.db");
    const raw = createLegacyV7(file); seedRepo(raw, 1, "one"); raw.close();
    const db = openDb(file);
    const statements = [
      [`features`, `INSERT INTO features SELECT id || '-x', repo_id, parent_id, name, created_at, updated_at FROM features LIMIT 1`, `UPDATE features SET name = name`, `DELETE FROM features`],
      [`specs`, `INSERT INTO specs SELECT id || '-x', repo_id, feature_id, type, state, summary, detail, created_at, updated_at FROM specs LIMIT 1`, `UPDATE specs SET summary = summary`, `DELETE FROM specs`],
      [`anchors`, `INSERT INTO anchors (repo_id, feature_id, spec_id, file, symbol) SELECT repo_id, feature_id, spec_id, file || '.x', symbol FROM anchors LIMIT 1`, `UPDATE anchors SET file = file`, `DELETE FROM anchors`],
      [`edges`, `INSERT INTO edges (repo_id, from_id, to_id, type) SELECT repo_id, from_id, to_id, type FROM edges LIMIT 1`, `UPDATE edges SET type = type`, `DELETE FROM edges`],
      [`feature_layouts`, `INSERT INTO feature_layouts SELECT feature_id || '-x', pct_left, pct_top, pct_width, pct_height, computed_at FROM feature_layouts LIMIT 1`, `UPDATE feature_layouts SET pct_left = pct_left`, `DELETE FROM feature_layouts`],
    ] as const;
    for (const [, ...sql] of statements) for (const statement of sql) {
      expect(() => db.exec(statement)).toThrow(/legacy graph is read-only/);
    }
    expect(db.prepare(`SELECT COUNT(*) AS n FROM kb_features`).get()).toEqual({ n: 2 });
    db.close();
  });
});
