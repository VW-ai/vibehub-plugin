import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { computeMappingChecksum, CURRENT_SCHEMA_VERSION, openDb } from "../src/db.js";
import { listTerritories, readSpec, readTerritoryLayouts } from "../src/graph-store.js";
import { OperationDispatcher } from "../src/operation-dispatcher.js";

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
    expect(CURRENT_SCHEMA_VERSION).toBe(20);
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
    const raw=new Database(file);raw.exec(`DROP TRIGGER IF EXISTS ticket_proposal_validations_closed_after_decision; DROP TABLE IF EXISTS ticket_proposal_application_receipts; DROP TABLE IF EXISTS ticket_proposal_application_intents; DROP TABLE IF EXISTS ticket_proposal_authority_decisions; DROP TABLE IF EXISTS ticket_proposal_validation_receipts; DROP TABLE IF EXISTS ticket_proposals; DROP TABLE IF EXISTS operation_request_receipts; DROP TABLE IF EXISTS operation_outcome_blobs; DROP TABLE IF EXISTS distill_scope_dispositions; DROP TABLE IF EXISTS task_prompt_cadence; DROP TABLE IF EXISTS task_prompt_seen; DROP TABLE IF EXISTS repo_semantic_authority; DROP INDEX IF EXISTS idx_kb_provenance_task; PRAGMA user_version=11;`);raw.close();
    const upgraded=openDb(file);
    expect(upgraded.pragma("user_version",{simple:true})).toBe(CURRENT_SCHEMA_VERSION);
    expect(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='distill_scope_dispositions'`).get()).toEqual({name:"distill_scope_dispositions"});
    expect(upgraded.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='operation_outcome_blobs'`).get()).toEqual({name:"operation_outcome_blobs"});
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

  it("upgrades v16 inline operation receipts without changing their replay",()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vibehub-receipt-v16-"));dirs.push(dir);
    const file=path.join(dir,"legacy-v16.db"),repoRoot=path.join(dir,"repo");
    fs.mkdirSync(repoRoot);
    let db=openDb(file);
    db.prepare(`INSERT INTO repos(root_path,default_branch,created_at) VALUES(?,'main',?)`).run(repoRoot,T0);
    const context={repoId:1,actor:"legacy-reader",requestId:"legacy-inline",now:T0};
    const first=new OperationDispatcher(db).dispatch("kb.status",context,{});
    expect(first).toMatchObject({ok:true});
    db.close();

    const raw=new Database(file);
    raw.exec(`
      DROP TRIGGER IF EXISTS ticket_proposal_validations_closed_after_decision;
      DROP TABLE ticket_proposal_application_receipts;
      DROP TABLE ticket_proposal_application_intents;
      DROP TABLE ticket_proposal_authority_decisions;
      DROP TABLE ticket_proposal_validation_receipts;
      DROP TABLE ticket_proposals;
      DROP TRIGGER operation_request_receipt_blob_binding_insert;
      ALTER TABLE operation_request_receipts DROP COLUMN outcome_blob_digest;
      DROP TABLE operation_outcome_blobs;
      PRAGMA user_version=16;
    `);
    raw.close();

    db=openDb(file);
    expect(db.prepare(
      `SELECT outcome_blob_digest outcomeBlobDigest
       FROM operation_request_receipts
       WHERE repo_id=1 AND request_id='legacy-inline'`,
    ).get()).toEqual({outcomeBlobDigest:null});
    expect(new OperationDispatcher(db).dispatch(
      "kb.status",
      context,
      {},
    )).toEqual(first);
    const legacyEnvelope=JSON.stringify({
      ok:true,
      data:{states:{},unplaced:0},
      meta:{
        operation:"kb.status",
        repoId:1,
        requestId:"legacy-column-list",
        at:T0,
      },
    });
    expect(()=>db.prepare(
      `INSERT INTO operation_request_receipts(
         repo_id,request_id,operation,payload_hash,
         outcome_kind,outcome,created_at
       ) VALUES(1,'legacy-column-list','kb.status','hash','success',?,?)`,
    ).run(legacyEnvelope,T0)).not.toThrow();
    db.close();
  });

  it("refuses to bless v18 proposal rows with absent required JSON keys", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibehub-proposal-v18-corrupt-"),
    );
    dirs.push(dir);
    const file = path.join(dir, "legacy-v18.db");
    openDb(file).close();

    const raw = new Database(file);
    raw.exec(`
      DROP TRIGGER IF EXISTS ticket_proposal_validations_closed_after_decision;
      DROP TABLE ticket_proposal_application_receipts;
      DROP TABLE ticket_proposal_application_intents;
      DROP TABLE ticket_proposal_authority_decisions;
      DROP TRIGGER ticket_proposals_required_payload_insert;
      DROP TABLE ticket_proposal_validation_receipts;
      PRAGMA user_version=18;
    `);
    raw.prepare(
      `INSERT INTO repos(
         root_path,default_branch,created_at
       ) VALUES('/proposal-v18-corrupt','main',?)`,
    ).run(T0);
    const proposalId = `tgp-${"1".repeat(64)}`;
    const proposalDigest = "2".repeat(64);
    const scopeRef = `tps-${"3".repeat(64)}`;
    // v18's table CHECK evaluates to NULL, and therefore passes, when a
    // required payload key such as graphMutationApplied is absent.
    const payload = JSON.stringify({
      schemaVersion: 1,
      proposalId,
      proposalDigest,
      scopeRef,
      kind: "graph_change",
      observedSnapshotId: null,
      submittedAt: T0,
      proposer: { kind: "claimed_actor", ref: "agent:legacy" },
      effect: "review_contribution_only",
    });
    raw.prepare(
      `INSERT INTO ticket_proposals(
         repo_id,scope_ref,proposal_id,proposal_digest,kind,
         observed_snapshot_id,repository_root,worktree_root,
         repository_incarnation,author,request_id,submitted_at,
         payload,byte_length
       ) VALUES(1,?,?,?,'graph_change',NULL,'/proposal-v18-corrupt',
                '/proposal-v18-corrupt','legacy-incarnation',
                'agent:legacy','legacy-corrupt',?,?,?)`,
    ).run(
      scopeRef,
      proposalId,
      proposalDigest,
      T0,
      payload,
      Buffer.byteLength(payload, "utf8"),
    );
    raw.close();

    expect(() => openDb(file)).toThrow(/CHECK constraint failed/);
    const inspect = new Database(file);
    expect(inspect.pragma("user_version", { simple: true })).toBe(18);
    expect(inspect.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
         AND name='ticket_proposal_validation_receipts'`,
    ).get()).toBeUndefined();
    expect(inspect.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='trigger'
         AND name='ticket_proposals_required_payload_insert'`,
    ).get()).toBeUndefined();
    inspect.close();
  });

  it("upgrades valid v18 ledgers with strict proposal and validation guards", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibehub-proposal-v18-valid-"),
    );
    dirs.push(dir);
    const file = path.join(dir, "legacy-v18.db");
    openDb(file).close();
    const raw = new Database(file);
    raw.exec(`
      DROP TRIGGER IF EXISTS ticket_proposal_validations_closed_after_decision;
      DROP TABLE ticket_proposal_application_receipts;
      DROP TABLE ticket_proposal_application_intents;
      DROP TABLE ticket_proposal_authority_decisions;
      DROP TRIGGER ticket_proposals_required_payload_insert;
      DROP TABLE ticket_proposal_validation_receipts;
      PRAGMA user_version=18;
    `);
    raw.close();

    const upgraded = openDb(file);
    expect(upgraded.pragma("user_version", { simple: true })).toBe(20);
    expect(upgraded.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
         AND name='ticket_proposal_validation_receipts'`,
    ).get()).toEqual({ name: "ticket_proposal_validation_receipts" });
    upgraded.prepare(
      `INSERT INTO repos(
         root_path,default_branch,created_at
       ) VALUES('/proposal-v18-valid','main',?)`,
    ).run(T0);
    const payload = JSON.stringify({
      schemaVersion: 1,
      proposalId: `tgp-${"1".repeat(64)}`,
      proposalDigest: "2".repeat(64),
      scopeRef: `tps-${"3".repeat(64)}`,
      kind: "graph_change",
      observedSnapshotId: null,
      submittedAt: T0,
      proposer: { kind: "claimed_actor", ref: "agent:legacy" },
      effect: "review_contribution_only",
    });
    expect(() => upgraded.prepare(
      `INSERT INTO ticket_proposals(
         repo_id,scope_ref,proposal_id,proposal_digest,kind,
         observed_snapshot_id,repository_root,worktree_root,
         repository_incarnation,author,request_id,submitted_at,
         payload,byte_length
       ) VALUES(1,?,?,?,'graph_change',NULL,'/proposal-v18-valid',
                '/proposal-v18-valid','legacy-incarnation',
                'agent:legacy','legacy-invalid',?,?,?)`,
    ).run(
      `tps-${"3".repeat(64)}`,
      `tgp-${"1".repeat(64)}`,
      "2".repeat(64),
      T0,
      payload,
      Buffer.byteLength(payload, "utf8"),
    )).toThrow(/missing required bound fields/);
    upgraded.close();
  });

  it("upgrades v19 with a closed authority decision and crash-reconcilable application ledger", () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibehub-ticket-application-v19-"),
    );
    dirs.push(dir);
    const file = path.join(dir, "legacy-v19.db");
    openDb(file).close();
    const raw = new Database(file);
    raw.exec(`
      DROP TRIGGER ticket_proposal_validations_closed_after_decision;
      DROP TABLE ticket_proposal_application_receipts;
      DROP TABLE ticket_proposal_application_intents;
      DROP TABLE ticket_proposal_authority_decisions;
      PRAGMA user_version=19;
    `);
    raw.close();

    const db = openDb(file);
    expect(db.pragma("user_version", { simple: true })).toBe(20);
    expect(db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table' AND name LIKE 'ticket_proposal_%'
       ORDER BY name`,
    ).all()).toEqual([
      { name: "ticket_proposal_application_intents" },
      { name: "ticket_proposal_application_receipts" },
      { name: "ticket_proposal_authority_decisions" },
      { name: "ticket_proposal_validation_receipts" },
      { name: "ticket_proposals" },
    ]);
    const blobBinding = db.prepare(
      `SELECT sql FROM sqlite_master
       WHERE type='trigger'
         AND name='operation_request_receipt_blob_binding_insert'`,
    ).get() as { sql: string };
    expect(blobBinding.sql).toContain("'ticket.proposal.review.inspect'");
    expect(blobBinding.sql).toContain("'ticket.proposal.authority.decide'");
    expect(blobBinding.sql).toContain("'ticket.proposal.apply'");

    db.prepare(
      `INSERT INTO repos(
         root_path,default_branch,created_at
       ) VALUES('/ticket-application-v19','main',?)`,
    ).run(T0);
    const scopeRef = `tps-${"1".repeat(64)}`;
    const proposalId = `tgp-${"2".repeat(64)}`;
    const proposalDigest = "3".repeat(64);
    const candidateDigest = "4".repeat(64);
    const repositoryIncarnation = "ticket-application-incarnation";
    const proposal = {
      schemaVersion: 1,
      proposalId,
      proposalDigest,
      scopeRef,
      kind: "graph_change",
      observedSnapshotId: null,
      submittedAt: T0,
      proposer: { kind: "claimed_actor", ref: "agent:migration-test" },
      reason: "exercise the terminal authority and application ledger",
      source: null,
      authorAssessment: {},
      changes: [{}],
      mechanicalReview: { status: "passed", candidateDigest },
      reviewRequirement: {
        independentMachineValidation: "required",
        authorityStatus: "not_granted",
        routeHint: "human_authority_indicated",
        indicatedAuthoritySignals: ["initial_plan_authority"],
      },
      effect: "review_contribution_only",
      graphMutationApplied: false,
    };
    const proposalPayload = JSON.stringify(proposal);
    db.prepare(
      `INSERT INTO ticket_proposals(
         repo_id,scope_ref,proposal_id,proposal_digest,kind,
         observed_snapshot_id,repository_root,worktree_root,
         repository_incarnation,author,request_id,submitted_at,
         payload,byte_length
       ) VALUES(
         1,@scopeRef,@proposalId,@proposalDigest,'graph_change',
         NULL,'/ticket-application-v19','/ticket-application-v19',
         @repositoryIncarnation,'agent:migration-test','proposal-request',
         @submittedAt,@payload,@byteLength
       )`,
    ).run({
      scopeRef,
      proposalId,
      proposalDigest,
      repositoryIncarnation,
      submittedAt: T0,
      payload: proposalPayload,
      byteLength: Buffer.byteLength(proposalPayload, "utf8"),
    });

    const validationReceiptId = `tpv-${"5".repeat(64)}`;
    const validationReceiptDigest = "6".repeat(64);
    const validatorArtifactDigest = "7".repeat(64);
    const policyArtifactDigest = "8".repeat(64);
    const checks = [
      "promise_preservation",
      "containment_truth",
      "dependency_truth",
      "change_classification",
      "delegated_scope",
      "protected_boundaries",
    ].map((code) => ({ code, outcome: "passed" }));
    const validation = {
      schemaVersion: 1,
      kind: "ticket_proposal_validation_receipt",
      validationReceiptId,
      validationReceiptDigest,
      scopeRef,
      target: {
        kind: "ticket_graph_change_proposal",
        proposalId,
        proposalDigest,
        observedSnapshotId: null,
        candidateDigest,
      },
      recordedAt: T0,
      producer: {
        kind: "claimed_machine_validator",
        id: "migration-validator",
        version: "1",
        artifactDigest: validatorArtifactDigest,
        trust: "claimed_unverified",
        invokedBy: { kind: "claimed_actor", ref: "agent:migration-test" },
      },
      policy: {
        id: "migration-policy",
        version: "1",
        artifactDigest: policyArtifactDigest,
        trust: "claimed_unverified",
      },
      conclusion: "passed",
      checks,
      findings: [],
      indicatedAuthoritySignals: ["initial_plan_authority"],
      effect: "validation_evidence_only",
      maturityEffect: "none",
      authorityGranted: false,
      applicationAuthorized: false,
      graphMutationApplied: false,
    };
    const insertValidation = db.prepare(
      `INSERT INTO ticket_proposal_validation_receipts(
         repo_id,scope_ref,validation_receipt_id,
         validation_receipt_digest,proposal_id,proposal_digest,
         observed_snapshot_id,candidate_digest,repository_root,
         worktree_root,repository_incarnation,author,request_id,
         recorded_at,validator_id,validator_version,
         validator_artifact_digest,policy_id,policy_version,
         policy_artifact_digest,conclusion,check_count,finding_count,
         blocking_finding_count,advisory_finding_count,
         authority_signal_count,payload,byte_length
       ) VALUES(
         1,@scopeRef,@validationReceiptId,@validationReceiptDigest,
         @proposalId,@proposalDigest,NULL,@candidateDigest,
         '/ticket-application-v19','/ticket-application-v19',
         @repositoryIncarnation,'agent:migration-test',@requestId,@recordedAt,
         'migration-validator','1',@validatorArtifactDigest,
         'migration-policy','1',@policyArtifactDigest,
         'passed',6,0,0,0,1,@payload,@byteLength
       )`,
    );
    const validationPayload = JSON.stringify(validation);
    insertValidation.run({
      scopeRef,
      validationReceiptId,
      validationReceiptDigest,
      proposalId,
      proposalDigest,
      candidateDigest,
      repositoryIncarnation,
      requestId: "validation-request",
      recordedAt: T0,
      validatorArtifactDigest,
      policyArtifactDigest,
      payload: validationPayload,
      byteLength: Buffer.byteLength(validationPayload, "utf8"),
    });
    const validationThroughSequence = (db.prepare(
      `SELECT sequence FROM ticket_proposal_validation_receipts
       WHERE repo_id=1 AND validation_receipt_id=?`,
    ).get(validationReceiptId) as { sequence: number }).sequence;

    const authorityDecisionId = `tgd-${"9".repeat(64)}`;
    const authorityDecisionDigest = "a".repeat(64);
    const validationSetDigest = "b".repeat(64);
    const providerArtifactDigest = "c".repeat(64);
    const authenticationContextDigest = "d".repeat(64);
    const basisDigest = "e".repeat(64);
    const acceptedValidations = [{
      validationReceiptId,
      validationReceiptDigest,
    }];
    const authoritySignals = ["initial_plan_authority"];
    const decision = {
      schemaVersion: 1,
      kind: "ticket_proposal_authority_decision",
      authorityDecisionId,
      authorityDecisionDigest,
      scopeRef,
      target: {
        kind: "ticket_graph_change_proposal",
        proposalId,
        proposalDigest,
        observedSnapshotId: null,
        candidateDigest,
      },
      validationSet: {
        digest: validationSetDigest,
        throughSequence: validationThroughSequence,
        count: 1,
        accepted: acceptedValidations,
      },
      requiredPath: "human_authority",
      disposition: "authorized",
      decidedAt: T0,
      provider: {
        kind: "trusted_host_authority_provider",
        id: "migration-authority",
        version: "1",
        artifactDigest: providerArtifactDigest,
        trust: "host_injected",
      },
      principal: {
        kind: "human",
        ref: "human:migration-test",
        authenticationContextDigest,
        trust: "host_authenticated",
      },
      basis: {
        kind: "human_authority",
        ref: "approval:migration-test",
        digest: basisDigest,
      },
      resolvedAssessment: {
        changeClass: "expansion",
        authoritySignals,
      },
      rationale: "human authority accepted the validated exact candidate",
      effect: "authority_decision_only",
      maturityEffect: "none",
      authorityGranted: true,
      applicationAuthorized: true,
      graphMutationApplied: false,
    };
    const insertDecision = db.prepare(
      `INSERT INTO ticket_proposal_authority_decisions(
         repo_id,scope_ref,authority_decision_id,
         authority_decision_digest,proposal_id,proposal_digest,
         observed_snapshot_id,candidate_digest,validation_set_digest,
         validation_through_sequence,validation_set_count,
         accepted_validations,required_path,disposition,provider_kind,
         provider_id,provider_version,provider_artifact_digest,
         provider_trust,principal_kind,principal_ref,
         principal_authentication_context_digest,principal_trust,
         basis_kind,basis_ref,basis_digest,resolved_change_class,
         resolved_authority_signals,authority_signal_count,rationale,
         request_id,decided_at,payload,byte_length
       ) VALUES(
         1,@scopeRef,@authorityDecisionId,@authorityDecisionDigest,
         @proposalId,@proposalDigest,NULL,@candidateDigest,
         @validationSetDigest,@validationThroughSequence,1,
         @acceptedValidations,'human_authority','authorized',
         'trusted_host_authority_provider','migration-authority','1',
         @providerArtifactDigest,'host_injected',@principalKind,
         @principalRef,@authenticationContextDigest,
         'host_authenticated','human_authority','approval:migration-test',
         @basisDigest,'expansion',@authoritySignals,1,
         'human authority accepted the validated exact candidate',
         'authority-request',@decidedAt,@payload,@byteLength
       )`,
    );
    const invalidDecisionPayload = JSON.stringify({
      ...decision,
      basis: undefined,
    });
    expect(() => insertDecision.run({
      scopeRef,
      authorityDecisionId,
      authorityDecisionDigest,
      proposalId,
      proposalDigest,
      candidateDigest,
      validationSetDigest,
      validationThroughSequence,
      acceptedValidations: JSON.stringify(acceptedValidations),
      providerArtifactDigest,
      principalKind: "human",
      principalRef: "human:migration-test",
      authenticationContextDigest,
      basisDigest,
      authoritySignals: JSON.stringify(authoritySignals),
      decidedAt: T0,
      payload: invalidDecisionPayload,
      byteLength: Buffer.byteLength(invalidDecisionPayload, "utf8"),
    })).toThrow(/authority decision binding is invalid/);
    const invalidDecisionMaturityPayload = JSON.stringify({
      ...decision,
      maturityEffect: "granted",
    });
    expect(() => insertDecision.run({
      scopeRef,
      authorityDecisionId,
      authorityDecisionDigest,
      proposalId,
      proposalDigest,
      candidateDigest,
      validationSetDigest,
      validationThroughSequence,
      acceptedValidations: JSON.stringify(acceptedValidations),
      providerArtifactDigest,
      principalKind: "human",
      principalRef: "human:migration-test",
      authenticationContextDigest,
      basisDigest,
      authoritySignals: JSON.stringify(authoritySignals),
      decidedAt: T0,
      payload: invalidDecisionMaturityPayload,
      byteLength: Buffer.byteLength(invalidDecisionMaturityPayload, "utf8"),
    })).toThrow(/authority decision binding is invalid/);
    const invalidHumanPrincipalPayload = JSON.stringify({
      ...decision,
      principal: {
        ...decision.principal,
        kind: "service",
        ref: "service:migration-test",
      },
    });
    expect(() => insertDecision.run({
      scopeRef,
      authorityDecisionId,
      authorityDecisionDigest,
      proposalId,
      proposalDigest,
      candidateDigest,
      validationSetDigest,
      validationThroughSequence,
      acceptedValidations: JSON.stringify(acceptedValidations),
      providerArtifactDigest,
      principalKind: "service",
      principalRef: "service:migration-test",
      authenticationContextDigest,
      basisDigest,
      authoritySignals: JSON.stringify(authoritySignals),
      decidedAt: T0,
      payload: invalidHumanPrincipalPayload,
      byteLength: Buffer.byteLength(invalidHumanPrincipalPayload, "utf8"),
    })).toThrow(/CHECK constraint failed/);
    const decisionPayload = JSON.stringify(decision);
    insertDecision.run({
      scopeRef,
      authorityDecisionId,
      authorityDecisionDigest,
      proposalId,
      proposalDigest,
      candidateDigest,
      validationSetDigest,
      validationThroughSequence,
      acceptedValidations: JSON.stringify(acceptedValidations),
      providerArtifactDigest,
      principalKind: "human",
      principalRef: "human:migration-test",
      authenticationContextDigest,
      basisDigest,
      authoritySignals: JSON.stringify(authoritySignals),
      decidedAt: T0,
      payload: decisionPayload,
      byteLength: Buffer.byteLength(decisionPayload, "utf8"),
    });

    const lateValidationReceiptId = `tpv-${"f".repeat(64)}`;
    const lateValidationReceiptDigest = "0".repeat(64);
    const lateValidation = {
      ...validation,
      validationReceiptId: lateValidationReceiptId,
      validationReceiptDigest: lateValidationReceiptDigest,
    };
    const lateValidationPayload = JSON.stringify(lateValidation);
    expect(() => insertValidation.run({
      scopeRef,
      validationReceiptId: lateValidationReceiptId,
      validationReceiptDigest: lateValidationReceiptDigest,
      proposalId,
      proposalDigest,
      candidateDigest,
      repositoryIncarnation,
      requestId: "late-validation-request",
      recordedAt: T0,
      validatorArtifactDigest,
      policyArtifactDigest,
      payload: lateValidationPayload,
      byteLength: Buffer.byteLength(lateValidationPayload, "utf8"),
    })).toThrow(/validation set is closed/);

    const applicationIntentId = `tai-${"1".repeat(64)}`;
    const applicationIntentDigest = "2".repeat(64);
    const storeId = `ticket-store-${"3".repeat(32)}`;
    const candidateSnapshotId = `tgs-${"4".repeat(64)}`;
    const candidateDefinitions = JSON.stringify([{ id: "ticket-a" }]);
    const intent = {
      schemaVersion: 1,
      kind: "ticket_proposal_application_intent",
      applicationIntentId,
      applicationIntentDigest,
      scopeRef,
      target: {
        kind: "ticket_graph_change_proposal",
        proposalId,
        proposalDigest,
        observedSnapshotId: null,
        candidateDigest,
      },
      authorityDecision: {
        authorityDecisionId,
        authorityDecisionDigest,
      },
      preparedAt: T0,
      publication: {
        baseSnapshotId: null,
        storeId,
        candidateSnapshotId,
        candidateDigest,
        ticketCount: 1,
        directUnlockCount: 0,
      },
      effect: "pending_canonical_graph_publication",
      maturityEffect: "none",
      graphMutationApplied: false,
    };
    const insertApplicationIntent = db.prepare(
      `INSERT INTO ticket_proposal_application_intents(
         repo_id,scope_ref,application_intent_id,
         application_intent_digest,authority_decision_id,
         authority_decision_digest,proposal_id,proposal_digest,
         observed_snapshot_id,candidate_digest,repository_incarnation,
         base_snapshot_id,store_id,candidate_snapshot_id,ticket_count,
         direct_unlock_count,candidate_definitions,candidate_byte_length,
         request_id,prepared_at,payload,byte_length
       ) VALUES(
         1,@scopeRef,@applicationIntentId,@applicationIntentDigest,
         @authorityDecisionId,@authorityDecisionDigest,@proposalId,
         @proposalDigest,NULL,@candidateDigest,@repositoryIncarnation,
         NULL,@storeId,@candidateSnapshotId,1,0,@candidateDefinitions,
         @candidateByteLength,'application-intent-request',@preparedAt,
         @payload,@byteLength
       )`,
    );
    const applicationIntentInsertArgs = (payload: string) => ({
      scopeRef,
      applicationIntentId,
      applicationIntentDigest,
      authorityDecisionId,
      authorityDecisionDigest,
      proposalId,
      proposalDigest,
      candidateDigest,
      repositoryIncarnation,
      storeId,
      candidateSnapshotId,
      candidateDefinitions,
      candidateByteLength: Buffer.byteLength(candidateDefinitions, "utf8"),
      preparedAt: T0,
      payload,
      byteLength: Buffer.byteLength(payload, "utf8"),
    });
    const invalidIntentMaturityPayload = JSON.stringify({
      ...intent,
      maturityEffect: "granted",
    });
    expect(() => insertApplicationIntent.run(
      applicationIntentInsertArgs(invalidIntentMaturityPayload),
    )).toThrow(/application intent binding is invalid/);
    const intentPayload = JSON.stringify(intent);
    insertApplicationIntent.run(applicationIntentInsertArgs(intentPayload));

    const applicationReceiptId = `tar-${"5".repeat(64)}`;
    const applicationReceiptDigest = "6".repeat(64);
    const receipt = {
      schemaVersion: 1,
      kind: "ticket_proposal_application_receipt",
      applicationReceiptId,
      applicationReceiptDigest,
      scopeRef,
      applicationIntentId,
      applicationIntentDigest,
      authorityDecision: {
        authorityDecisionId,
        authorityDecisionDigest,
      },
      target: {
        kind: "ticket_graph_change_proposal",
        proposalId,
        proposalDigest,
        observedSnapshotId: null,
        candidateDigest,
      },
      recordedAt: T0,
      publication: {
        status: "published",
        previousSnapshotId: null,
        snapshotId: candidateSnapshotId,
        ticketCount: 1,
        directUnlockCount: 0,
      },
      effect: "ticket_graph_publication",
      maturityEffect: "none",
      graphMutationApplied: true,
    };
    const insertApplicationReceipt = db.prepare(
      `INSERT INTO ticket_proposal_application_receipts(
         repo_id,scope_ref,application_receipt_id,
         application_receipt_digest,application_intent_id,
         application_intent_digest,authority_decision_id,
         authority_decision_digest,proposal_id,proposal_digest,
         observed_snapshot_id,candidate_digest,publication_status,
         previous_snapshot_id,snapshot_id,ticket_count,
         direct_unlock_count,request_id,recorded_at,payload,byte_length
       ) VALUES(
         1,@scopeRef,@applicationReceiptId,@applicationReceiptDigest,
         @applicationIntentId,@applicationIntentDigest,
         @authorityDecisionId,@authorityDecisionDigest,@proposalId,
         @proposalDigest,NULL,@candidateDigest,'published',NULL,
         @candidateSnapshotId,1,0,'application-receipt-request',
         @recordedAt,@payload,@byteLength
       )`,
    );
    const applicationReceiptInsertArgs = (payload: string) => ({
      scopeRef,
      applicationReceiptId,
      applicationReceiptDigest,
      applicationIntentId,
      applicationIntentDigest,
      authorityDecisionId,
      authorityDecisionDigest,
      proposalId,
      proposalDigest,
      candidateDigest,
      candidateSnapshotId,
      recordedAt: T0,
      payload,
      byteLength: Buffer.byteLength(payload, "utf8"),
    });
    const invalidReceiptMaturityPayload = JSON.stringify({
      ...receipt,
      maturityEffect: "granted",
    });
    expect(() => insertApplicationReceipt.run(
      applicationReceiptInsertArgs(invalidReceiptMaturityPayload),
    )).toThrow(/application receipt binding is invalid/);
    const receiptPayload = JSON.stringify(receipt);
    insertApplicationReceipt.run(
      applicationReceiptInsertArgs(receiptPayload),
    );

    expect(() => db.prepare(
      `UPDATE ticket_proposal_authority_decisions
       SET rationale=rationale WHERE repo_id=1`,
    ).run()).toThrow(/authority decisions are immutable/);
    expect(() => db.prepare(
      `DELETE FROM ticket_proposal_application_intents WHERE repo_id=1`,
    ).run()).toThrow(/application intents are immutable/);
    expect(() => db.prepare(
      `UPDATE ticket_proposal_application_receipts
       SET recorded_at=recorded_at WHERE repo_id=1`,
    ).run()).toThrow(/application receipts are immutable/);
    expect(db.prepare(`PRAGMA foreign_key_check`).all()).toEqual([]);
    db.close();
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
