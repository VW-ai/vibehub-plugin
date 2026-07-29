/**
 * SQLite door — WAL mode, ~/.vibehub by default (decision-project-016:
 * hooks are short-lived CLIs writing straight to SQLite; WAL lets the app
 * read while hooks write).
 *
 * SQLite is operational truth and the legacy authority for repositories that
 * have not crossed the decision-project-028 per-repository Git semantic store boundary.
 * One database holds every repo, scoped by repos.id (decision-project-025:
 * 同一 SQLite 按 repo 分域). This slice ships the TEAM-VISIBILITY subset of the 运行域/配置域
 * tables; M1 slice ② adds the full three-domain schema on top via the same
 * migration ladder.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Db = Database.Database;

/** ~/.vibehub — the one place the data dir is spelled. */
export function vibehubHome(): string {
  return path.join(os.homedir(), ".vibehub");
}

export function defaultDbPath(): string {
  return path.join(vibehubHome(), "workbench.db");
}

/**
 * The one DB-path policy for every adapter (CLI, vite middleware, future
 * Tauri shell): explicit flag > VIBEHUB_DB env > default.
 */
export function resolveDbPath(explicit?: string): string {
  return explicit ?? process.env["VIBEHUB_DB"] ?? defaultDbPath();
}

const MIGRATIONS: string[] = [
  // 001 — team-visibility slice (M1 ①): repos + sync + team facts.
  `
  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    root_path TEXT NOT NULL UNIQUE,
    slug TEXT,
    default_branch TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sync_state (
    repo_id INTEGER PRIMARY KEY REFERENCES repos(id),
    last_fetch_at TEXT,
    last_fetch_ok INTEGER,
    gh_available INTEGER NOT NULL DEFAULT 0,
    repo_files INTEGER,
    last_synced_at TEXT
  );

  CREATE TABLE team_branches (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    name TEXT NOT NULL,
    head_sha TEXT NOT NULL,
    last_commit_at TEXT NOT NULL,
    last_author TEXT NOT NULL DEFAULT '',
    ahead INTEGER NOT NULL DEFAULT 0,
    behind INTEGER NOT NULL DEFAULT 0,
    merged INTEGER NOT NULL DEFAULT 0,
    pr_number INTEGER,
    pr_state TEXT,
    pr_title TEXT,
    PRIMARY KEY (repo_id, name)
  );

  CREATE TABLE team_branch_files (
    repo_id INTEGER NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    change_kind TEXT NOT NULL,
    PRIMARY KEY (repo_id, branch, path)
  );

  CREATE TABLE team_conflicts (
    repo_id INTEGER NOT NULL,
    branch_a TEXT NOT NULL,
    branch_b TEXT NOT NULL,
    path TEXT NOT NULL,
    first_detected_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, branch_a, branch_b, path)
  );
  `,

  // 002 — the three-domain schema (M1 ②, decision-project-025), translated
  // 1:1 from the five contract files (packages/core/src/contract/).
  // Rule inherited from the contract: DERIVED IS NEVER STORED — no milestone
  // tier, no twist rows, no filesTouched counters, no layout geometry, no
  // session ordinals; those are all pure functions over these facts.
  `
  /* ── 运行域 (run domain) ─────────────────────────────────────────────── */

  /* Task — contract map-types.ts. One row per 事 (decision-project-017/024:
     one thing = one branch = one PR). state/state_since/last_event_at from
     hook or watcher timestamps; status_detail verbatim hook payload
     (NULL on the basic tier — never synthesized). */
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    title TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','waiting','stalled','done')),
    signal_tier TEXT NOT NULL CHECK (signal_tier IN ('hooks','basic')),
    branch TEXT,
    worktree_path TEXT,
    pr_number INTEGER,
    pr_state TEXT CHECK (pr_state IN ('open','merged','closed')),
    state_since TEXT NOT NULL,
    last_event_at TEXT NOT NULL,
    status_detail TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_tasks_repo_state ON tasks(repo_id, state);
  CREATE INDEX idx_tasks_repo_branch ON tasks(repo_id, branch);

  /* Session — contract panel-types.ts SessionIdentity. sessionOrdinal /
     sessionCount are DERIVED by counting rows per task (ORDER BY started_at);
     previousEnded* read from the prior row. */
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT REFERENCES tasks(id),
    agent TEXT NOT NULL,
    transcript_path TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    end_reason TEXT CHECK (end_reason IN ('context_limit','user_ended','completed'))
  );
  CREATE INDEX idx_sessions_task ON sessions(task_id, started_at);

  /* TimelineEvent — contract panel-types.ts discriminated union (11 types).
     The union member's own fields travel in payload (JSON, validated by the
     typed store); the discriminant + timestamp are columns so timelines are
     queryable without parsing. Hook events are appended by the short-lived
     'vibehub hook' CLI (decision-project-016: 采集永不依赖 app 活着). */
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT REFERENCES tasks(id),
    session_id TEXT REFERENCES sessions(id),
    type TEXT NOT NULL CHECK (type IN (
      'launch','self_report','file_change','file_read','test_run',
      'user_injection','agent_ack','question','cross_read_notice',
      'commit','state_transition')),
    at TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload))
  );
  CREATE INDEX idx_events_task_at ON events(task_id, at);

  /* Footprint — one raw file touch (PostToolUse Edit/Write/Read paths).
     Everything footprint-shaped in the contract is derived from here:
     ScopeDeclaration.filesTouched, TwistEvidence.offScopeFiles,
     UncategorizedFootprint (count/firstSeenAt/sampleFiles), SymbolTouch,
     ConflictDiagnosis.stalenessEditsSince. */
  CREATE TABLE footprints (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    session_id TEXT REFERENCES sessions(id),
    path TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('edit','read')),
    at TEXT NOT NULL
  );
  CREATE INDEX idx_footprints_task ON footprints(task_id, at);
  CREATE INDEX idx_footprints_repo_path ON footprints(repo_id, path);

  /* ScopeDeclaration — contract map-types.ts; registered via MCP at launch
     (decision-project-020). seq preserves declaration order ("in declaration
     order" is contract text). filesTouched is DERIVED from footprints. */
  CREATE TABLE scopes (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    seq INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('write','read')),
    territory_id TEXT NOT NULL,
    sub_block_id TEXT,
    label TEXT NOT NULL,
    PRIMARY KEY (task_id, seq)
  );

  /* InjectionQueue — decision-project-018: 介入原语统一走 SQLite 注入队列,
     hooks 触发点回查 (claim). mode per contract UserInjectionEvent. */
  CREATE TABLE injections (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    mode TEXT NOT NULL CHECK (mode IN ('inject','pause')),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    claimed_at TEXT
  );
  CREATE INDEX idx_injections_pending ON injections(task_id, created_at)
    WHERE claimed_at IS NULL;

  /* Conflict — contract map-types.ts (local pair; the team/branch variant
     stays in team_conflicts). Exactly two concurrent tasks
     (decision-project-020: 并发才算撞, W×W = red / w×r = yellow). */
  CREATE TABLE conflicts (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_a TEXT NOT NULL REFERENCES tasks(id),
    task_b TEXT NOT NULL REFERENCES tasks(id),
    territory_id TEXT NOT NULL,
    sub_block_id TEXT,
    severity TEXT NOT NULL CHECK (severity IN ('red','yellow')),
    detected_at TEXT NOT NULL,
    resolved_at TEXT,
    ignored INTEGER NOT NULL DEFAULT 0
  );

  /* Conflict.sharedSymbols — order-preserving (contract invariant:
     SharedSymbolEvidence aligns 1:1, same names same order). file = the
     anchoring file (conflict-types.ts SharedSymbolEvidence.file). */
  CREATE TABLE conflict_symbols (
    conflict_id TEXT NOT NULL REFERENCES conflicts(id),
    seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    file TEXT NOT NULL,
    PRIMARY KEY (conflict_id, seq)
  );

  /* ConflictDiagnosis — conflict-types.ts zone (b): claude -p output held
     VERBATIM with explicit provenance; sides as JSON (exactly two, in
     conflict.taskIds order). stalenessEditsSince is DERIVED (count edit
     footprints on shared symbols after diagnosed_at). */
  CREATE TABLE conflict_diagnoses (
    conflict_id TEXT PRIMARY KEY REFERENCES conflicts(id),
    verdict TEXT NOT NULL,
    sides TEXT NOT NULL CHECK (json_valid(sides)),
    suggested TEXT NOT NULL,
    diagnosed_at TEXT NOT NULL,
    engine TEXT NOT NULL DEFAULT 'claude-p-local'
  );

  /* Notification ledger — decision-project-020: only red (W×W) may push,
     with a budget; the ledger is how the budget is enforceable. */
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    kind TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    delivered_at TEXT
  );

  /* MappingRun — install-types.ts: the claude -p mapping pass has a start
     and an exit and NOTHING else (no progress fraction — elapsed only). */
  CREATE TABLE mapping_runs (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    started_at TEXT NOT NULL,
    finished_at TEXT
  );

  /* ── 图域 (graph domain) ─────────────────────────────────────────────── */

  /* Territory / SubBlock — map-types.ts: both are anchor clusters from
     distillation, so one table with parent_id (sub-block = child).
     anchoredFileCount is DERIVED (count distinct anchor files). */
  CREATE TABLE features (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    parent_id TEXT REFERENCES features(id),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_features_repo ON features(repo_id, parent_id);

  /* Spec — the invisible knowledge substrate (KB 隐身为地基,intent-002;
     no D — stale/supersede only, decision-project-026). */
  CREATE TABLE specs (
    id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    feature_id TEXT REFERENCES features(id),
    type TEXT NOT NULL CHECK (type IN
      ('intent','decision','constraint','convention','contract','context','change')),
    state TEXT NOT NULL CHECK (state IN ('draft','active','stale','superseded')),
    summary TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_specs_feature ON specs(feature_id);

  /* Anchor — file/symbol ↔ feature attachment; the join that turns raw
     footprint paths into territory occupancy (decision-github-001 row 2). */
  CREATE TABLE anchors (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    feature_id TEXT REFERENCES features(id),
    spec_id TEXT REFERENCES specs(id),
    file TEXT NOT NULL,
    symbol TEXT
  );
  CREATE INDEX idx_anchors_repo_file ON anchors(repo_id, file);
  CREATE INDEX idx_anchors_feature ON anchors(feature_id);

  /* Edge — typed relations between graph nodes (features/specs). */
  CREATE TABLE edges (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    type TEXT NOT NULL
  );
  CREATE INDEX idx_edges_from ON edges(from_id);
  CREATE INDEX idx_edges_to ON edges(to_id);

  /* ── 配置域 (config domain) ──────────────────────────────────────────── */

  /* Key-value settings; repo_id 0 = global (a NULL here would defeat the
     PK's uniqueness — SQLite treats every NULL as distinct). */
  CREATE TABLE settings (
    repo_id INTEGER NOT NULL DEFAULT 0,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (repo_id, key)
  );
  `,

  // 003 — cached territory layout (treemap spike). The squarified layout is
  // computed ONCE per distillation pass (蒸馏时算一次缓存, handoff) and read
  // by every export; a presentation cache, invalidated by recomputing.
  `
  CREATE TABLE feature_layouts (
    feature_id TEXT PRIMARY KEY REFERENCES features(id),
    pct_left REAL NOT NULL,
    pct_top REAL NOT NULL,
    pct_width REAL NOT NULL,
    pct_height REAL NOT NULL,
    computed_at TEXT NOT NULL
  );
  `,

  // 004 — M2 runtime contracts: raw scope patterns are the source fact;
  // territory attribution remains derived. start_head_sha bounds commit
  // derivation to the lifetime of a task. Injection context carries the
  // app locus verbatim (nullable for terminal-authored notes).
  `
  ALTER TABLE tasks ADD COLUMN start_head_sha TEXT;
  ALTER TABLE injections ADD COLUMN context TEXT;

  CREATE TABLE scope_patterns (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    seq INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('write','read')),
    glob TEXT NOT NULL,
    label TEXT,
    status TEXT NOT NULL,
    PRIMARY KEY (task_id, seq)
  );
  CREATE INDEX idx_scope_patterns_repo_task ON scope_patterns(repo_id, task_id);

  CREATE TABLE task_reports (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id),
    status TEXT NOT NULL,
    done TEXT,
    reported_at TEXT NOT NULL
  );
  `,

  // 005 — one off-scope reminder per raw scope declaration. Replacing the
  // declaration deletes these rows, mechanically resetting eligibility.
  `
  ALTER TABLE scope_patterns ADD COLUMN reminded_at TEXT;
  `,

  // 006 — request-id intervention ledger. The receipt is stored in the same
  // transaction as queue/history/conflict mutations, making retries and
  // double-clicks deterministic across processes.
  `
  CREATE TABLE intervention_requests (
    request_id TEXT PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    result TEXT NOT NULL CHECK (json_valid(result)),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_intervention_requests_repo ON intervention_requests(repo_id, created_at);
  `,

  // 007 — repo-scoped request ids, canonical ignored task/branch pairs, and
  // an honest queue-time intervention event distinct from hook-observed
  // delivery. The table rebuild upgrades databases that ran migration 006.
  `
  CREATE TABLE intervention_requests_v2 (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    request_id TEXT NOT NULL,
    result TEXT NOT NULL CHECK (json_valid(result)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, request_id)
  );
  INSERT INTO intervention_requests_v2 (repo_id, request_id, result, created_at)
    SELECT repo_id, request_id, result, created_at FROM intervention_requests;
  DROP TABLE intervention_requests;
  ALTER TABLE intervention_requests_v2 RENAME TO intervention_requests;
  CREATE INDEX idx_intervention_requests_repo ON intervention_requests(repo_id, created_at);

  CREATE TABLE ignored_conflict_pairs (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    side_a TEXT NOT NULL,
    side_b TEXT NOT NULL,
    ignored_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, side_a, side_b),
    CHECK (side_a < side_b)
  );

  ALTER TABLE events RENAME TO events_v6;
  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT REFERENCES tasks(id),
    session_id TEXT REFERENCES sessions(id),
    type TEXT NOT NULL CHECK (type IN (
      'launch','self_report','file_change','file_read','test_run',
      'user_injection','user_intervention','agent_ack','question','cross_read_notice',
      'commit','state_transition')),
    at TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload))
  );
  INSERT INTO events (id, repo_id, task_id, session_id, type, at, payload)
    SELECT id, repo_id, task_id, session_id, type, at, payload FROM events_v6;
  DROP TABLE events_v6;
  CREATE INDEX idx_events_task_at ON events(task_id, at);
  `,

  // 008 — two truth layers. Canonical knowledge keeps immutable authored
  // revisions; an independently immutable mapping version drives map reads.
  // Legacy graph tables remain untouched and read-only for rollback/audit.
  `
  CREATE TABLE kb_features (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    feature_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, feature_id)
  );

  CREATE TABLE kb_specs (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    spec_id TEXT NOT NULL,
    feature_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('draft','active','stale','superseded','deprecated')),
    current_revision INTEGER NOT NULL CHECK (current_revision > 0),
    source_kind TEXT NOT NULL DEFAULT 'canonical' CHECK (source_kind = 'canonical'),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, spec_id),
    FOREIGN KEY (repo_id, feature_id) REFERENCES kb_features(repo_id, feature_id),
    FOREIGN KEY (repo_id, spec_id, current_revision)
      REFERENCES kb_spec_revisions(repo_id, spec_id, revision) DEFERRABLE INITIALLY DEFERRED
  );
  CREATE INDEX idx_kb_specs_feature ON kb_specs(repo_id, feature_id, state);

  CREATE TABLE kb_spec_revisions (
    repo_id INTEGER NOT NULL,
    spec_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    type TEXT NOT NULL CHECK (type IN ('intent','decision','constraint','convention','contract','context','change')),
    summary TEXT NOT NULL,
    detail TEXT,
    priority TEXT,
    layer TEXT,
    domain TEXT,
    tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
    producer TEXT NOT NULL,
    produced_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, spec_id, revision),
    FOREIGN KEY (repo_id, spec_id) REFERENCES kb_specs(repo_id, spec_id)
  );

  CREATE TABLE kb_evidence (
    repo_id INTEGER NOT NULL,
    evidence_id TEXT NOT NULL,
    spec_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    exact_quote TEXT,
    evidence_ref TEXT,
    content_hash TEXT,
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    producer TEXT NOT NULL,
    produced_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, evidence_id),
    CHECK (exact_quote IS NOT NULL OR evidence_ref IS NOT NULL OR content_hash IS NOT NULL),
    FOREIGN KEY (repo_id, spec_id, revision) REFERENCES kb_spec_revisions(repo_id, spec_id, revision)
  );

  CREATE TABLE kb_spec_revision_anchors (
    repo_id INTEGER NOT NULL,
    spec_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    file TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT '',
    line_start INTEGER,
    line_end INTEGER,
    content_hash TEXT,
    PRIMARY KEY (repo_id, spec_id, revision, file, symbol),
    CHECK (line_start IS NULL OR line_start > 0),
    CHECK (line_end IS NULL OR (line_start IS NOT NULL AND line_end >= line_start)),
    FOREIGN KEY (repo_id, spec_id, revision) REFERENCES kb_spec_revisions(repo_id, spec_id, revision)
  );

  CREATE TABLE kb_spec_current_anchors (
    repo_id INTEGER NOT NULL,
    spec_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    file TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT '',
    line_start INTEGER,
    line_end INTEGER,
    content_hash TEXT,
    PRIMARY KEY (repo_id, spec_id, file, symbol),
    FOREIGN KEY (repo_id, spec_id, revision, file, symbol)
      REFERENCES kb_spec_revision_anchors(repo_id, spec_id, revision, file, symbol)
  );
  CREATE INDEX idx_kb_current_anchors_path ON kb_spec_current_anchors(repo_id, file);

  CREATE TABLE kb_spec_relations (
    repo_id INTEGER NOT NULL,
    from_spec_id TEXT NOT NULL,
    to_spec_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('depends_on','relates_to','supersedes','conflicts_with')),
    rationale TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, from_spec_id, to_spec_id, type),
    CHECK (from_spec_id <> to_spec_id),
    FOREIGN KEY (repo_id, from_spec_id) REFERENCES kb_specs(repo_id, spec_id),
    FOREIGN KEY (repo_id, to_spec_id) REFERENCES kb_specs(repo_id, spec_id)
  );
  CREATE INDEX idx_kb_relations_to ON kb_spec_relations(repo_id, to_spec_id, type);

  CREATE TABLE kb_import_audit (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    legacy_table TEXT NOT NULL,
    legacy_row_id TEXT NOT NULL,
    legacy_type TEXT,
    action TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, legacy_table, legacy_row_id)
  );

  CREATE TABLE kb_import_quarantine (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    legacy_table TEXT NOT NULL,
    legacy_row_id TEXT NOT NULL,
    legacy_from_id TEXT,
    legacy_to_id TEXT,
    legacy_type TEXT,
    reason TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload)),
    quarantined_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, legacy_table, legacy_row_id)
  );

  CREATE TABLE mapping_versions (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    version_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('building','finalized')),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('legacy_import','distillation')),
    checksum TEXT NOT NULL,
    created_at TEXT NOT NULL,
    finalized_at TEXT,
    PRIMARY KEY (repo_id, version_id),
    CHECK ((state = 'building' AND finalized_at IS NULL) OR
           (state = 'finalized' AND finalized_at IS NOT NULL))
  );

  CREATE TABLE mapping_version_features (
    repo_id INTEGER NOT NULL,
    version_id TEXT NOT NULL,
    feature_id TEXT NOT NULL,
    parent_feature_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    intent TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active','stale','removed')),
    PRIMARY KEY (repo_id, version_id, feature_id),
    FOREIGN KEY (repo_id, version_id) REFERENCES mapping_versions(repo_id, version_id),
    FOREIGN KEY (repo_id, feature_id) REFERENCES kb_features(repo_id, feature_id),
    FOREIGN KEY (repo_id, version_id, parent_feature_id)
      REFERENCES mapping_version_features(repo_id, version_id, feature_id)
  );
  CREATE INDEX idx_mapping_features_parent ON mapping_version_features(repo_id, version_id, parent_feature_id);

  CREATE TABLE mapping_version_anchors (
    repo_id INTEGER NOT NULL,
    version_id TEXT NOT NULL,
    feature_id TEXT NOT NULL,
    file TEXT NOT NULL,
    symbol TEXT NOT NULL DEFAULT '',
    line_start INTEGER,
    line_end INTEGER,
    content_hash TEXT,
    PRIMARY KEY (repo_id, version_id, feature_id, file, symbol),
    CHECK (line_start IS NULL OR line_start > 0),
    CHECK (line_end IS NULL OR (line_start IS NOT NULL AND line_end >= line_start)),
    FOREIGN KEY (repo_id, version_id, feature_id)
      REFERENCES mapping_version_features(repo_id, version_id, feature_id)
  );
  CREATE INDEX idx_mapping_anchors_path ON mapping_version_anchors(repo_id, version_id, file);

  CREATE TABLE mapping_version_layouts (
    repo_id INTEGER NOT NULL,
    version_id TEXT NOT NULL,
    feature_id TEXT NOT NULL,
    pct_left REAL NOT NULL,
    pct_top REAL NOT NULL,
    pct_width REAL NOT NULL,
    pct_height REAL NOT NULL,
    computed_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, version_id, feature_id),
    FOREIGN KEY (repo_id, version_id, feature_id)
      REFERENCES mapping_version_features(repo_id, version_id, feature_id)
  );

  CREATE TABLE repo_active_mapping (
    repo_id INTEGER PRIMARY KEY REFERENCES repos(id),
    version_id TEXT NOT NULL,
    activated_at TEXT NOT NULL,
    FOREIGN KEY (repo_id, version_id) REFERENCES mapping_versions(repo_id, version_id)
  );

  CREATE TABLE mapping_activation_history (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    seq INTEGER NOT NULL,
    from_version_id TEXT,
    to_version_id TEXT NOT NULL,
    activated_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (repo_id, seq),
    FOREIGN KEY (repo_id, from_version_id) REFERENCES mapping_versions(repo_id, version_id),
    FOREIGN KEY (repo_id, to_version_id) REFERENCES mapping_versions(repo_id, version_id)
  );

  CREATE TABLE kb_mutation_receipts (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    result TEXT NOT NULL CHECK (json_valid(result)),
    created_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, operation, idempotency_key)
  );
  `,

  // 009 — append-only audit trail for canonical KB mutations. Receipts prove
  // idempotency; these events explain who changed canonical knowledge and why.
  `
  CREATE TABLE kb_provenance_events (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    operation TEXT NOT NULL,
    spec_id TEXT,
    actor TEXT NOT NULL,
    task_id TEXT,
    request_id TEXT NOT NULL,
    at TEXT NOT NULL,
    payload TEXT NOT NULL CHECK (json_valid(payload))
  );
  CREATE INDEX idx_kb_provenance_repo_at ON kb_provenance_events(repo_id, at);
  CREATE INDEX idx_kb_provenance_spec ON kb_provenance_events(repo_id, spec_id, at);
  CREATE TRIGGER kb_provenance_events_immutable_update BEFORE UPDATE ON kb_provenance_events
    BEGIN SELECT RAISE(ABORT, 'kb_provenance_events are immutable'); END;
  CREATE TRIGGER kb_provenance_events_immutable_delete BEFORE DELETE ON kb_provenance_events
    BEGIN SELECT RAISE(ABORT, 'kb_provenance_events are immutable'); END;
  `,

  // 010 — versioned, resumable distillation. Candidate truth is isolated
  // from canonical KB truth; finalized mapping projections are the only data
  // eligible for explicit CAS activation.
  `
  CREATE TABLE distill_runs (
    repo_id INTEGER NOT NULL REFERENCES repos(id), run_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('cold','refresh','incremental')),
    base_commit TEXT NOT NULL CHECK(length(base_commit)=40 AND base_commit NOT GLOB '*[^0-9a-f]*'),
    skill_hash TEXT NOT NULL, config_hash TEXT NOT NULL,
    budget TEXT CHECK(budget IS NULL OR json_valid(budget)),
    state TEXT NOT NULL CHECK(state IN ('collecting','running','reconciling','validated','finalized','aborted')),
    inventory_sealed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    aborted_reason TEXT, finalized_version_id TEXT,
    candidate_snapshot_checksum TEXT, reconciled_at TEXT,
    PRIMARY KEY(repo_id,run_id)
  );
  CREATE TABLE distill_inventory (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL, path TEXT NOT NULL,
    classification TEXT NOT NULL CHECK(classification IN ('included','excluded')),
    reason TEXT, content_hash TEXT,
    PRIMARY KEY(repo_id,run_id,path),
    FOREIGN KEY(repo_id,run_id) REFERENCES distill_runs(repo_id,run_id),
    CHECK((classification='included' AND content_hash IS NOT NULL) OR
          (classification='excluded' AND reason IS NOT NULL))
  );
  CREATE TABLE distill_scopes (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL, scope_id TEXT NOT NULL,
    parent_scope_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('analysis','leaf')),
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','failed')),
    worker_id TEXT, lease_token TEXT, lease_generation INTEGER NOT NULL DEFAULT 0,
    lease_expires_at TEXT, result_summary TEXT CHECK(result_summary IS NULL OR json_valid(result_summary)),
    failure_reason TEXT,
    PRIMARY KEY(repo_id,run_id,scope_id),
    FOREIGN KEY(repo_id,run_id) REFERENCES distill_runs(repo_id,run_id),
    FOREIGN KEY(repo_id,run_id,parent_scope_id) REFERENCES distill_scopes(repo_id,run_id,scope_id)
  );
  CREATE TABLE distill_scope_files (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL, path TEXT NOT NULL, scope_id TEXT NOT NULL,
    PRIMARY KEY(repo_id,run_id,path),
    FOREIGN KEY(repo_id,run_id,path) REFERENCES distill_inventory(repo_id,run_id,path),
    FOREIGN KEY(repo_id,run_id,scope_id) REFERENCES distill_scopes(repo_id,run_id,scope_id)
  );
  CREATE TABLE distill_candidate_identities (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('feature','spec','anchor','relation')),
    natural_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(repo_id,run_id,kind,natural_id),
    FOREIGN KEY(repo_id,run_id) REFERENCES distill_runs(repo_id,run_id)
  );
  CREATE TABLE distill_candidate_revisions (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('feature','spec','anchor','relation')),
    natural_id TEXT NOT NULL, revision_hash TEXT NOT NULL, supersedes_hash TEXT,
    source_scope_id TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
    evidence TEXT NOT NULL CHECK(json_valid(evidence)), producer TEXT NOT NULL, produced_at TEXT NOT NULL,
    accepted_lease_token TEXT NOT NULL, accepted_lease_generation INTEGER NOT NULL,
    PRIMARY KEY(repo_id,run_id,revision_hash),
    UNIQUE(repo_id,run_id,kind,natural_id,revision_hash),
    FOREIGN KEY(repo_id,run_id) REFERENCES distill_runs(repo_id,run_id),
    FOREIGN KEY(repo_id,run_id,kind,natural_id) REFERENCES distill_candidate_identities(repo_id,run_id,kind,natural_id),
    FOREIGN KEY(repo_id,run_id,source_scope_id) REFERENCES distill_scopes(repo_id,run_id,scope_id),
    FOREIGN KEY(repo_id,run_id,supersedes_hash) REFERENCES distill_candidate_revisions(repo_id,run_id,revision_hash)
  );
  CREATE INDEX idx_distill_candidates_identity ON distill_candidate_revisions(repo_id,run_id,kind,natural_id);
  CREATE TABLE distill_findings (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL, finding_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK(severity IN ('hard','retryable','review','experimental')),
    code TEXT NOT NULL, subject TEXT, details TEXT NOT NULL CHECK(json_valid(details)), created_at TEXT NOT NULL,
    PRIMARY KEY(repo_id,run_id,finding_id),
    FOREIGN KEY(repo_id,run_id) REFERENCES distill_runs(repo_id,run_id)
  );
  CREATE TABLE distill_version_index (
    repo_id INTEGER NOT NULL, version_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL, natural_id TEXT NOT NULL, revision_hash TEXT NOT NULL,
    PRIMARY KEY(repo_id,version_id,ordinal),
    FOREIGN KEY(repo_id,version_id) REFERENCES mapping_versions(repo_id,version_id)
  );
  CREATE TABLE distill_version_diffs (
    repo_id INTEGER NOT NULL, version_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK(subject_kind IN ('feature','spec','anchor')),
    subject_id TEXT NOT NULL,
    change_kind TEXT NOT NULL CHECK(change_kind IN ('added','changed','removed','matches')),
    details TEXT NOT NULL CHECK(json_valid(details)),
    PRIMARY KEY(repo_id,version_id,subject_kind,subject_id),
    FOREIGN KEY(repo_id,version_id) REFERENCES mapping_versions(repo_id,version_id)
  );
  CREATE TABLE distill_run_versions (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL, version_id TEXT NOT NULL,
    projection_checksum TEXT NOT NULL, candidate_checksum TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(repo_id,run_id), UNIQUE(repo_id,version_id),
    FOREIGN KEY(repo_id,run_id) REFERENCES distill_runs(repo_id,run_id),
    FOREIGN KEY(repo_id,version_id) REFERENCES mapping_versions(repo_id,version_id)
  );
  CREATE TABLE distill_scope_retry_audit (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
    scope_id TEXT NOT NULL, from_generation INTEGER NOT NULL, to_generation INTEGER NOT NULL,
    actor TEXT NOT NULL, request_id TEXT NOT NULL, reason TEXT NOT NULL, retried_at TEXT NOT NULL,
    PRIMARY KEY(repo_id,run_id,seq),
    FOREIGN KEY(repo_id,run_id,scope_id) REFERENCES distill_scopes(repo_id,run_id,scope_id)
  );
  CREATE TABLE distill_scope_correction_audit (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL,
    scope_id TEXT NOT NULL, from_generation INTEGER NOT NULL, to_generation INTEGER NOT NULL,
    actor TEXT NOT NULL, request_id TEXT NOT NULL, reason TEXT NOT NULL, corrected_at TEXT NOT NULL, applied_at TEXT,
    PRIMARY KEY(repo_id,run_id,seq,scope_id),
    FOREIGN KEY(repo_id,run_id,scope_id) REFERENCES distill_scopes(repo_id,run_id,scope_id)
  );
  CREATE TABLE distill_mutation_receipts (
    repo_id INTEGER NOT NULL REFERENCES repos(id), operation TEXT NOT NULL,
    request_id TEXT NOT NULL, input_hash TEXT NOT NULL,
    result TEXT NOT NULL CHECK(json_valid(result)), created_at TEXT NOT NULL,
    PRIMARY KEY(repo_id,operation,request_id)
  );
  CREATE TRIGGER distill_candidate_revisions_immutable_update BEFORE UPDATE ON distill_candidate_revisions
    BEGIN SELECT RAISE(ABORT,'distillation candidate revisions are immutable'); END;
  CREATE TRIGGER distill_candidate_revisions_immutable_delete BEFORE DELETE ON distill_candidate_revisions
    BEGIN SELECT RAISE(ABORT,'distillation candidate revisions are immutable'); END;
  CREATE TRIGGER distill_candidate_identities_immutable_update BEFORE UPDATE ON distill_candidate_identities
    BEGIN SELECT RAISE(ABORT,'distillation candidate identities are immutable'); END;
  CREATE TRIGGER distill_candidate_identities_immutable_delete BEFORE DELETE ON distill_candidate_identities
    BEGIN SELECT RAISE(ABORT,'distillation candidate identities are immutable'); END;
  CREATE TRIGGER distill_candidate_identities_frozen_insert BEFORE INSERT ON distill_candidate_identities
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id AND (r.candidate_snapshot_checksum IS NOT NULL OR r.state IN ('validated','finalized','aborted')))
    BEGIN SELECT RAISE(ABORT,'distillation candidates are frozen'); END;
  CREATE TRIGGER distill_candidate_revisions_frozen_insert BEFORE INSERT ON distill_candidate_revisions
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id AND (r.candidate_snapshot_checksum IS NOT NULL OR r.state IN ('validated','finalized','aborted')))
    BEGIN SELECT RAISE(ABORT,'distillation candidates are frozen'); END;
  CREATE TRIGGER distill_run_state_guard BEFORE UPDATE OF state ON distill_runs
    WHEN NOT (
      (OLD.state='collecting' AND NEW.state IN ('running','aborted')) OR
      (OLD.state='running' AND NEW.state IN ('reconciling','aborted')) OR
      (OLD.state='reconciling' AND NEW.state IN ('validated','aborted')) OR
      (OLD.state='reconciling' AND NEW.state='running' AND NEW.candidate_snapshot_checksum IS NULL AND NEW.reconciled_at IS NULL AND EXISTS(
        SELECT 1 FROM distill_scopes s JOIN distill_scope_correction_audit a
          ON a.repo_id=s.repo_id AND a.run_id=s.run_id AND a.scope_id=s.scope_id AND a.to_generation=s.lease_generation
        WHERE s.repo_id=OLD.repo_id AND s.run_id=OLD.run_id AND s.state='pending' AND a.applied_at IS NULL)) OR
      (OLD.state='validated' AND NEW.state IN ('finalized','aborted'))
    )
    BEGIN SELECT RAISE(ABORT,'invalid distillation run state transition'); END;
  CREATE TRIGGER distill_scope_state_guard BEFORE UPDATE OF state ON distill_scopes
    WHEN NOT (
      (OLD.state='pending' AND NEW.state='leased') OR
      (OLD.state='leased' AND NEW.state IN ('leased','completed','failed')) OR
      (OLD.state='failed' AND NEW.state='pending') OR
      (OLD.state='completed' AND NEW.state='pending' AND EXISTS(
        SELECT 1 FROM distill_scope_correction_audit a WHERE a.repo_id=OLD.repo_id AND a.run_id=OLD.run_id
          AND a.scope_id=OLD.scope_id AND a.from_generation=OLD.lease_generation AND a.to_generation=NEW.lease_generation AND a.applied_at IS NULL))
    )
    BEGIN SELECT RAISE(ABORT,'invalid distillation scope state transition'); END;
  CREATE TRIGGER finalized_distill_index_no_insert BEFORE INSERT ON distill_version_index
    WHEN EXISTS(SELECT 1 FROM mapping_versions v WHERE v.repo_id=NEW.repo_id AND v.version_id=NEW.version_id AND v.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation index is immutable'); END;
  CREATE TRIGGER finalized_distill_index_no_update BEFORE UPDATE ON distill_version_index
    WHEN EXISTS(SELECT 1 FROM mapping_versions v WHERE v.state='finalized' AND ((v.repo_id=OLD.repo_id AND v.version_id=OLD.version_id) OR (v.repo_id=NEW.repo_id AND v.version_id=NEW.version_id)))
    BEGIN SELECT RAISE(ABORT,'finalized distillation index is immutable'); END;
  CREATE TRIGGER finalized_distill_index_no_delete BEFORE DELETE ON distill_version_index
    WHEN EXISTS(SELECT 1 FROM mapping_versions v WHERE v.repo_id=OLD.repo_id AND v.version_id=OLD.version_id AND v.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation index is immutable'); END;
  CREATE TRIGGER finalized_distill_diff_no_insert BEFORE INSERT ON distill_version_diffs
    WHEN EXISTS(SELECT 1 FROM mapping_versions v WHERE v.repo_id=NEW.repo_id AND v.version_id=NEW.version_id AND v.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation diff is immutable'); END;
  CREATE TRIGGER finalized_distill_diff_no_update BEFORE UPDATE ON distill_version_diffs
    WHEN EXISTS(SELECT 1 FROM mapping_versions v WHERE v.state='finalized' AND ((v.repo_id=OLD.repo_id AND v.version_id=OLD.version_id) OR (v.repo_id=NEW.repo_id AND v.version_id=NEW.version_id)))
    BEGIN SELECT RAISE(ABORT,'finalized distillation diff is immutable'); END;
  CREATE TRIGGER finalized_distill_diff_no_delete BEFORE DELETE ON distill_version_diffs
    WHEN EXISTS(SELECT 1 FROM mapping_versions v WHERE v.repo_id=OLD.repo_id AND v.version_id=OLD.version_id AND v.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation diff is immutable'); END;
  CREATE TRIGGER distill_inventory_sealed_insert BEFORE INSERT ON distill_inventory
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id AND r.inventory_sealed_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'distillation inventory is sealed'); END;
  CREATE TRIGGER distill_inventory_sealed_update BEFORE UPDATE ON distill_inventory
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.inventory_sealed_at IS NOT NULL AND
      ((r.repo_id=OLD.repo_id AND r.run_id=OLD.run_id) OR (r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id)))
    BEGIN SELECT RAISE(ABORT,'distillation inventory is sealed'); END;
  CREATE TRIGGER distill_inventory_sealed_delete BEFORE DELETE ON distill_inventory
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=OLD.repo_id AND r.run_id=OLD.run_id AND r.inventory_sealed_at IS NOT NULL)
    BEGIN SELECT RAISE(ABORT,'distillation inventory is sealed'); END;
  CREATE TRIGGER distill_sealed_timestamp_immutable BEFORE UPDATE OF inventory_sealed_at ON distill_runs
    WHEN OLD.inventory_sealed_at IS NOT NULL AND NEW.inventory_sealed_at IS NOT OLD.inventory_sealed_at
    BEGIN SELECT RAISE(ABORT,'distillation sealed timestamp is immutable'); END;
  CREATE TRIGGER distill_candidate_snapshot_guard BEFORE UPDATE OF candidate_snapshot_checksum,reconciled_at ON distill_runs
    WHEN OLD.candidate_snapshot_checksum IS NOT NULL AND
      (NEW.candidate_snapshot_checksum IS NOT OLD.candidate_snapshot_checksum OR NEW.reconciled_at IS NOT OLD.reconciled_at) AND
      NOT (NEW.candidate_snapshot_checksum IS NULL AND NEW.reconciled_at IS NULL AND EXISTS(
        SELECT 1 FROM distill_scopes s WHERE s.repo_id=OLD.repo_id AND s.run_id=OLD.run_id AND s.state='pending'))
    BEGIN SELECT RAISE(ABORT,'distillation candidate snapshot is immutable outside selective retry'); END;
  CREATE TRIGGER distill_finalized_run_immutable BEFORE UPDATE ON distill_runs
    WHEN OLD.state='finalized'
    BEGIN SELECT RAISE(ABORT,'finalized distillation run is immutable'); END;
  CREATE TRIGGER distill_finalized_run_no_delete BEFORE DELETE ON distill_runs
    WHEN OLD.state='finalized'
    BEGIN SELECT RAISE(ABORT,'finalized distillation run is immutable'); END;
  CREATE TRIGGER distill_finalized_scope_no_update BEFORE UPDATE ON distill_scopes
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.state='finalized' AND ((r.repo_id=OLD.repo_id AND r.run_id=OLD.run_id) OR (r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id)))
    BEGIN SELECT RAISE(ABORT,'finalized distillation scope is immutable'); END;
  CREATE TRIGGER distill_finalized_scope_no_insert BEFORE INSERT ON distill_scopes
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id AND r.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation scope is immutable'); END;
  CREATE TRIGGER distill_finalized_scope_no_delete BEFORE DELETE ON distill_scopes
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=OLD.repo_id AND r.run_id=OLD.run_id AND r.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation scope is immutable'); END;
  CREATE TRIGGER distill_finalized_scope_file_no_insert BEFORE INSERT ON distill_scope_files
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id AND r.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation scope files are immutable'); END;
  CREATE TRIGGER distill_finalized_scope_file_no_update BEFORE UPDATE ON distill_scope_files
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.state='finalized' AND ((r.repo_id=OLD.repo_id AND r.run_id=OLD.run_id) OR (r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id)))
    BEGIN SELECT RAISE(ABORT,'finalized distillation scope files are immutable'); END;
  CREATE TRIGGER distill_finalized_scope_file_no_delete BEFORE DELETE ON distill_scope_files
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=OLD.repo_id AND r.run_id=OLD.run_id AND r.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation scope files are immutable'); END;
  CREATE TRIGGER distill_finalized_finding_no_insert BEFORE INSERT ON distill_findings
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id AND r.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation findings are immutable'); END;
  CREATE TRIGGER distill_finalized_finding_no_update BEFORE UPDATE ON distill_findings
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.state='finalized' AND ((r.repo_id=OLD.repo_id AND r.run_id=OLD.run_id) OR (r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id)))
    BEGIN SELECT RAISE(ABORT,'finalized distillation findings are immutable'); END;
  CREATE TRIGGER distill_finalized_finding_no_delete BEFORE DELETE ON distill_findings
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=OLD.repo_id AND r.run_id=OLD.run_id AND r.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation findings are immutable'); END;
  CREATE TRIGGER distill_run_versions_immutable_update BEFORE UPDATE ON distill_run_versions
    BEGIN SELECT RAISE(ABORT,'distillation run version checksums are immutable'); END;
  CREATE TRIGGER distill_run_versions_immutable_delete BEFORE DELETE ON distill_run_versions
    BEGIN SELECT RAISE(ABORT,'distillation run version checksums are immutable'); END;
  CREATE TRIGGER distill_retry_audit_immutable_update BEFORE UPDATE ON distill_scope_retry_audit
    BEGIN SELECT RAISE(ABORT,'distillation retry audit is immutable'); END;
  CREATE TRIGGER distill_retry_audit_immutable_delete BEFORE DELETE ON distill_scope_retry_audit
    BEGIN SELECT RAISE(ABORT,'distillation retry audit is immutable'); END;
  CREATE TRIGGER distill_correction_audit_immutable_update BEFORE UPDATE ON distill_scope_correction_audit
    WHEN NOT (OLD.applied_at IS NULL AND NEW.applied_at IS NOT NULL AND
      NEW.repo_id=OLD.repo_id AND NEW.run_id=OLD.run_id AND NEW.seq=OLD.seq AND NEW.scope_id=OLD.scope_id AND
      NEW.from_generation=OLD.from_generation AND NEW.to_generation=OLD.to_generation AND NEW.actor=OLD.actor AND
      NEW.request_id=OLD.request_id AND NEW.reason=OLD.reason AND NEW.corrected_at=OLD.corrected_at)
    BEGIN SELECT RAISE(ABORT,'distillation correction audit is immutable except one-way application'); END;
  CREATE TRIGGER distill_correction_audit_immutable_delete BEFORE DELETE ON distill_scope_correction_audit
    BEGIN SELECT RAISE(ABORT,'distillation correction audit is immutable'); END;
  CREATE TRIGGER distill_correction_audit_apply AFTER UPDATE OF state ON distill_runs
    WHEN OLD.state='reconciling' AND NEW.state='running'
    BEGIN UPDATE distill_scope_correction_audit SET applied_at=NEW.updated_at
      WHERE repo_id=NEW.repo_id AND run_id=NEW.run_id AND applied_at IS NULL; END;
  CREATE TRIGGER distill_finalized_retry_audit_no_insert BEFORE INSERT ON distill_scope_retry_audit
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id AND r.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation retry audit is immutable'); END;
  CREATE TRIGGER distill_receipts_immutable_update BEFORE UPDATE ON distill_mutation_receipts
    BEGIN SELECT RAISE(ABORT,'distillation mutation receipts are immutable'); END;
  CREATE TRIGGER distill_receipts_immutable_delete BEFORE DELETE ON distill_mutation_receipts
    BEGIN SELECT RAISE(ABORT,'distillation mutation receipts are immutable'); END;
  `,

  // 011 — strict incremental distillation metadata. A run pins the active
  // mapping it was based on; inventory rows carry an exact Git delta class;
  // candidate heads explicitly say whether they upsert or remove an entity.
  `
  ALTER TABLE distill_runs ADD COLUMN baseline_version_id TEXT;
  ALTER TABLE distill_inventory ADD COLUMN change_kind TEXT
    CHECK(change_kind IS NULL OR change_kind IN ('added','modified','renamed','deleted','unchanged'));
  ALTER TABLE distill_inventory ADD COLUMN previous_path TEXT;
  ALTER TABLE distill_candidate_revisions ADD COLUMN action TEXT NOT NULL DEFAULT 'upsert'
    CHECK(action IN ('upsert','remove'));
  CREATE INDEX idx_distill_runs_baseline ON distill_runs(repo_id, baseline_version_id);
  `,

  // 012 — honest, durable file-level unresolved dispositions. Rows are
  // append-only per accepted lease generation so selective correction keeps
  // an immutable audit trail while reconciliation reads only the current
  // completed generation.
  `
  CREATE TABLE distill_scope_dispositions (
    repo_id INTEGER NOT NULL, run_id TEXT NOT NULL, scope_id TEXT NOT NULL,
    path TEXT NOT NULL, accepted_lease_generation INTEGER NOT NULL,
    reason TEXT NOT NULL, evidence TEXT CHECK(evidence IS NULL OR json_valid(evidence)),
    producer TEXT NOT NULL, produced_at TEXT NOT NULL,
    PRIMARY KEY(repo_id,run_id,scope_id,path,accepted_lease_generation),
    FOREIGN KEY(repo_id,run_id,scope_id) REFERENCES distill_scopes(repo_id,run_id,scope_id),
    FOREIGN KEY(repo_id,run_id,path) REFERENCES distill_scope_files(repo_id,run_id,path)
  );
  CREATE INDEX idx_distill_dispositions_current ON distill_scope_dispositions(repo_id,run_id,scope_id,accepted_lease_generation,path);
  CREATE TRIGGER distill_scope_dispositions_integrity BEFORE INSERT ON distill_scope_dispositions
    WHEN NOT EXISTS(
      SELECT 1
      FROM distill_scopes s
      JOIN distill_scope_files sf
        ON sf.repo_id=s.repo_id AND sf.run_id=s.run_id AND sf.scope_id=s.scope_id
      JOIN distill_inventory i
        ON i.repo_id=sf.repo_id AND i.run_id=sf.run_id AND i.path=sf.path
      WHERE s.repo_id=NEW.repo_id AND s.run_id=NEW.run_id AND s.scope_id=NEW.scope_id
        AND sf.path=NEW.path AND s.kind='leaf' AND s.state='completed'
        AND s.lease_generation=NEW.accepted_lease_generation
        AND i.classification='included'
    )
    BEGIN SELECT RAISE(ABORT,'disposition must belong to a completed leaf generation and included owned file'); END;
  CREATE TRIGGER distill_scope_dispositions_immutable_update BEFORE UPDATE ON distill_scope_dispositions
    BEGIN SELECT RAISE(ABORT,'distillation scope dispositions are immutable'); END;
  CREATE TRIGGER distill_scope_dispositions_immutable_delete BEFORE DELETE ON distill_scope_dispositions
    BEGIN SELECT RAISE(ABORT,'distillation scope dispositions are immutable'); END;
  CREATE TRIGGER distill_finalized_disposition_no_insert BEFORE INSERT ON distill_scope_dispositions
    WHEN EXISTS(SELECT 1 FROM distill_runs r WHERE r.repo_id=NEW.repo_id AND r.run_id=NEW.run_id AND r.state='finalized')
    BEGIN SELECT RAISE(ABORT,'finalized distillation dispositions are immutable'); END;
  `,

  // 013 — repository-wide request identity. This is deliberately separate
  // from operation/business idempotency receipts: one request id names one
  // canonical dispatcher invocation, regardless of adapter or business key.
  `
  CREATE TABLE operation_request_receipts (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    request_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('success','error')),
    outcome TEXT NOT NULL CHECK(json_valid(outcome)),
    created_at TEXT NOT NULL,
    PRIMARY KEY(repo_id,request_id),
    CHECK(COALESCE(json_type(outcome,'$.ok') IN ('true','false'),0) AND
          ((outcome_kind='success' AND json_extract(outcome,'$.ok')=1) OR
           (outcome_kind='error' AND json_extract(outcome,'$.ok')=0)))
  );
  CREATE TRIGGER operation_request_receipts_immutable_update BEFORE UPDATE ON operation_request_receipts
    BEGIN SELECT RAISE(ABORT,'operation request receipts are immutable'); END;
  CREATE TRIGGER operation_request_receipts_immutable_delete BEFORE DELETE ON operation_request_receipts
    BEGIN SELECT RAISE(ABORT,'operation request receipts are immutable'); END;
  `,

  // 014 — intervention canonical input hashes. The conditional data step in
  // migrate() also supports historical test/minimal databases that omit the
  // optional App domain or already carried an experimental input_hash column.
  ``,

  // 015 — task-scoped user-turn cadence for the periodic knowledge
  // checkpoint (intent-workbench-003). The hook counts deduplicated user
  // prompts per (repo, task); a reminder fires when enough turns pass with
  // no new canonical knowledge write. kb_provenance_events is the reset
  // evidence: it is written only inside successful canonical KB mutations
  // (failures roll back, idempotent replays return cached receipts without
  // writing, distillation never writes it), so a per-task high-water mark
  // over its monotonic rowids is mechanical success proof. The mark is
  // seeded at first sight so pre-existing writes are baseline, never
  // "recent". Upgraded databases start counting from zero — no backfill;
  // historical turns are not reconstructed. task_prompt_seen is append-only
  // dedup state (same growth class as events/footprints); writes without a
  // task attribution (task_id NULL in provenance) never reset a
  // task-scoped counter.
  `
  CREATE TABLE task_prompt_cadence (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    counted_turns INTEGER NOT NULL DEFAULT 0,
    last_write_turn INTEGER NOT NULL DEFAULT 0,
    last_reminder_turn INTEGER NOT NULL DEFAULT 0,
    provenance_high_water INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo_id, task_id),
    CHECK (counted_turns >= 0 AND last_write_turn <= counted_turns
       AND last_reminder_turn <= counted_turns)
  );

  CREATE TABLE task_prompt_seen (
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    task_id TEXT NOT NULL REFERENCES tasks(id),
    prompt_id TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    PRIMARY KEY (task_id, prompt_id)
  );

  CREATE INDEX idx_kb_provenance_task ON kb_provenance_events(task_id, id);
  `,

  // 016 — operational ledger for the repository-scoped Git semantic
  // authority boundary. Once recorded, absence of the semantic tree is corruption
  // or an old checkout and must never fall back to SQLite semantic writes.
  `
  CREATE TABLE repo_semantic_authority (
    repo_id INTEGER PRIMARY KEY REFERENCES repos(id),
    format TEXT NOT NULL CHECK(format = 'git-semantic-store'),
    initial_semantic_digest TEXT NOT NULL,
    cutover_at TEXT NOT NULL
  );
  `,

  // 017 — content-addressed payload storage for large immutable operation
  // outcomes. Ticket read receipts keep their request identity in the ledger
  // but share one immutable payload across equivalent refreshes.
  `
  CREATE TABLE operation_outcome_blobs (
    digest TEXT PRIMARY KEY
      CHECK(length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
    outcome_kind TEXT NOT NULL CHECK(outcome_kind IN ('success','error')),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    byte_length INTEGER NOT NULL
      CHECK(byte_length >= 0 AND byte_length = length(CAST(payload AS BLOB))),
    created_at TEXT NOT NULL
  );
  ALTER TABLE operation_request_receipts
    ADD COLUMN outcome_blob_digest TEXT
      REFERENCES operation_outcome_blobs(digest)
      CHECK(outcome_blob_digest IS NULL OR
        (length(outcome_blob_digest) = 64 AND
         outcome_blob_digest NOT GLOB '*[^0-9a-f]*'));
  CREATE TRIGGER operation_outcome_blobs_immutable_update
    BEFORE UPDATE ON operation_outcome_blobs
    BEGIN SELECT RAISE(ABORT,'operation outcome blobs are immutable'); END;
  CREATE TRIGGER operation_outcome_blobs_immutable_delete
    BEFORE DELETE ON operation_outcome_blobs
    BEGIN SELECT RAISE(ABORT,'operation outcome blobs are immutable'); END;
  CREATE TRIGGER operation_request_receipt_blob_binding_insert
    BEFORE INSERT ON operation_request_receipts
    WHEN NEW.outcome_blob_digest IS NOT NULL AND (
      NEW.operation NOT IN (
        'ticket.graph.snapshot',
        'ticket.subject.inspect',
        'ticket.trace.list'
      ) OR
      COALESCE(json_type(NEW.outcome,'$.outcomeBlob') <> 'text',1) OR
      COALESCE(json_extract(NEW.outcome,'$.outcomeBlob') <>
        NEW.outcome_blob_digest,1) OR
      NOT EXISTS (
        SELECT 1 FROM operation_outcome_blobs b
        WHERE b.digest=NEW.outcome_blob_digest
          AND b.outcome_kind=NEW.outcome_kind
      )
    )
    BEGIN SELECT RAISE(ABORT,'operation outcome blob binding is invalid'); END;
  `,

  // 018 — immutable, scope-bound Ticket proposal contributions. A proposal
  // is review material only: this ledger carries no mutable approval/status
  // field and cannot mutate the Git-native Ticket graph. Submission shares
  // the dispatcher's SQLite transaction with its request receipt.
  `
  CREATE TABLE ticket_proposals (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    scope_ref TEXT NOT NULL
      CHECK(length(scope_ref)=68 AND substr(scope_ref,1,4)='tps-' AND
            substr(scope_ref,5) NOT GLOB '*[^0-9a-f]*'),
    proposal_id TEXT NOT NULL
      CHECK(length(proposal_id)=68 AND substr(proposal_id,1,4)='tgp-' AND
            substr(proposal_id,5) NOT GLOB '*[^0-9a-f]*'),
    proposal_digest TEXT NOT NULL
      CHECK(length(proposal_digest)=64 AND
            proposal_digest NOT GLOB '*[^0-9a-f]*'),
    kind TEXT NOT NULL CHECK(kind IN ('comment','graph_change')),
    observed_snapshot_id TEXT
      CHECK(observed_snapshot_id IS NULL OR
            (length(observed_snapshot_id)=68 AND
             substr(observed_snapshot_id,1,4)='tgs-' AND
             substr(observed_snapshot_id,5) NOT GLOB '*[^0-9a-f]*')),
    repository_root TEXT NOT NULL CHECK(length(repository_root)>0),
    worktree_root TEXT NOT NULL CHECK(length(worktree_root)>0),
    repository_incarnation TEXT NOT NULL
      CHECK(length(repository_incarnation)>0),
    author TEXT NOT NULL CHECK(length(author)>0),
    task_id TEXT REFERENCES tasks(id),
    request_id TEXT NOT NULL CHECK(length(request_id)>0),
    submitted_at TEXT NOT NULL CHECK(length(submitted_at)>0),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    byte_length INTEGER NOT NULL
      CHECK(byte_length>=0 AND
            byte_length=length(CAST(payload AS BLOB))),
    UNIQUE(repo_id,proposal_id),
    UNIQUE(repo_id,request_id),
    CHECK(json_extract(payload,'$.schemaVersion')=1 AND
          json_extract(payload,'$.proposalId')=proposal_id AND
          json_extract(payload,'$.proposalDigest')=proposal_digest AND
          json_extract(payload,'$.scopeRef')=scope_ref AND
          json_extract(payload,'$.kind')=kind AND
          json_extract(payload,'$.observedSnapshotId')
            IS observed_snapshot_id AND
          json_extract(payload,'$.submittedAt')=submitted_at AND
          json_extract(payload,'$.proposer.kind')='claimed_actor' AND
          json_extract(payload,'$.proposer.ref')=author AND
          json_extract(payload,'$.effect')='review_contribution_only' AND
          json_extract(payload,'$.graphMutationApplied')=0)
  );
  CREATE INDEX idx_ticket_proposals_scope_sequence
    ON ticket_proposals(repo_id,scope_ref,sequence);
  CREATE TRIGGER ticket_proposals_immutable_update
    BEFORE UPDATE ON ticket_proposals
    BEGIN SELECT RAISE(ABORT,'Ticket proposals are immutable'); END;
  CREATE TRIGGER ticket_proposals_immutable_delete
    BEFORE DELETE ON ticket_proposals
    BEGIN SELECT RAISE(ABORT,'Ticket proposals are immutable'); END;

  DROP TRIGGER operation_request_receipt_blob_binding_insert;
  CREATE TRIGGER operation_request_receipt_blob_binding_insert
    BEFORE INSERT ON operation_request_receipts
    WHEN NEW.outcome_blob_digest IS NOT NULL AND (
      NEW.operation NOT IN (
        'ticket.graph.snapshot',
        'ticket.subject.inspect',
        'ticket.trace.list',
        'ticket.proposal.submit'
      ) OR
      COALESCE(json_type(NEW.outcome,'$.outcomeBlob') <> 'text',1) OR
      COALESCE(json_extract(NEW.outcome,'$.outcomeBlob') <>
        NEW.outcome_blob_digest,1) OR
      NOT EXISTS (
        SELECT 1 FROM operation_outcome_blobs b
        WHERE b.digest=NEW.outcome_blob_digest
          AND b.outcome_kind=NEW.outcome_kind
      )
    )
    BEGIN SELECT RAISE(ABORT,'operation outcome blob binding is invalid'); END;
  `,

  // 019 — queryable proposal ledger and append-only proposal-specific
  // validation evidence. Migration refuses to bless any v18 proposal that
  // exploited SQLite's NULL-valued CHECK behavior for absent JSON keys.
  // Validation receipts bind one exact graph-change proposal/candidate and
  // explicitly grant neither maturity nor application authority.
  `
  CREATE TRIGGER ticket_proposals_required_payload_insert
    BEFORE INSERT ON ticket_proposals
    WHEN
      COALESCE(json_type(NEW.payload) <> 'object',1) OR
      COALESCE(json_type(NEW.payload,'$.schemaVersion') <> 'integer',1) OR
      COALESCE(json_extract(NEW.payload,'$.schemaVersion') <> 1,1) OR
      COALESCE(json_type(NEW.payload,'$.proposalId') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,'$.proposalId') <>
        NEW.proposal_id,1) OR
      COALESCE(json_type(NEW.payload,'$.proposalDigest') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,'$.proposalDigest') <>
        NEW.proposal_digest,1) OR
      COALESCE(json_type(NEW.payload,'$.scopeRef') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,'$.scopeRef') <> NEW.scope_ref,1) OR
      COALESCE(json_type(NEW.payload,'$.kind') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,'$.kind') <> NEW.kind,1) OR
      (
        NEW.observed_snapshot_id IS NULL AND
        COALESCE(json_type(NEW.payload,'$.observedSnapshotId') <> 'null',1)
      ) OR
      (
        NEW.observed_snapshot_id IS NOT NULL AND (
          COALESCE(json_type(NEW.payload,'$.observedSnapshotId') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,'$.observedSnapshotId') <>
            NEW.observed_snapshot_id,1)
        )
      ) OR
      COALESCE(json_type(NEW.payload,'$.submittedAt') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,'$.submittedAt') <>
        NEW.submitted_at,1) OR
      COALESCE(json_type(NEW.payload,'$.proposer') <> 'object',1) OR
      COALESCE(json_type(NEW.payload,'$.proposer.kind') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,'$.proposer.kind') <>
        'claimed_actor',1) OR
      COALESCE(json_type(NEW.payload,'$.proposer.ref') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,'$.proposer.ref') <> NEW.author,1) OR
      COALESCE(json_type(NEW.payload,'$.effect') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,'$.effect') <>
        'review_contribution_only',1) OR
      COALESCE(json_type(NEW.payload,'$.graphMutationApplied') <>
        'false',1) OR
      COALESCE(json_type(NEW.payload,'$.reviewRequirement') <>
        'object',1) OR
      COALESCE(json_type(NEW.payload,
        '$.reviewRequirement.independentMachineValidation') <> 'text',1) OR
      COALESCE(json_type(NEW.payload,
        '$.reviewRequirement.authorityStatus') <> 'text',1) OR
      COALESCE(json_extract(NEW.payload,
        '$.reviewRequirement.authorityStatus') <> 'not_granted',1) OR
      COALESCE(json_type(NEW.payload,
        '$.reviewRequirement.routeHint') <> 'text',1) OR
      COALESCE(json_type(NEW.payload,
        '$.reviewRequirement.indicatedAuthoritySignals') <> 'array',1) OR
      (
        NEW.kind='comment' AND (
          NEW.observed_snapshot_id IS NULL OR
          COALESCE(json_type(NEW.payload,'$.subject') <> 'object',1) OR
          COALESCE(json_type(NEW.payload,'$.body') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.reviewRequirement.independentMachineValidation') <>
            'not_applicable',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.reviewRequirement.routeHint') <> 'comment_only',1) OR
          COALESCE(json_array_length(NEW.payload,
            '$.reviewRequirement.indicatedAuthoritySignals') <> 0,1)
        )
      ) OR
      (
        NEW.kind='graph_change' AND (
          COALESCE(json_type(NEW.payload,'$.reason') <> 'text',1) OR
          COALESCE(json_type(NEW.payload,'$.source')
            NOT IN ('object','null'),1) OR
          COALESCE(json_type(NEW.payload,'$.authorAssessment') <>
            'object',1) OR
          COALESCE(json_type(NEW.payload,'$.changes') <> 'array',1) OR
          COALESCE(json_array_length(NEW.payload,'$.changes') < 1,1) OR
          COALESCE(json_type(NEW.payload,'$.mechanicalReview') <>
            'object',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.mechanicalReview.status') <> 'passed',1) OR
          COALESCE(json_type(NEW.payload,
            '$.mechanicalReview.candidateDigest') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.reviewRequirement.independentMachineValidation') <>
            'required',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.reviewRequirement.routeHint')
            NOT IN ('delegated_application_candidate',
                    'human_authority_indicated'),1)
        )
      )
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal payload is missing required bound fields'); END;

  CREATE TABLE ticket_proposals_migration_019_guard (
    invalid INTEGER NOT NULL CHECK(invalid=0)
  );
  INSERT INTO ticket_proposals_migration_019_guard(invalid)
    SELECT 1
    WHERE EXISTS (
      SELECT 1 FROM ticket_proposals p
      WHERE
        COALESCE(json_type(p.payload) <> 'object',1) OR
        COALESCE(json_type(p.payload,'$.schemaVersion') <> 'integer',1) OR
        COALESCE(json_extract(p.payload,'$.schemaVersion') <> 1,1) OR
        COALESCE(json_type(p.payload,'$.proposalId') <> 'text',1) OR
        COALESCE(json_extract(p.payload,'$.proposalId') <> p.proposal_id,1) OR
        COALESCE(json_type(p.payload,'$.proposalDigest') <> 'text',1) OR
        COALESCE(json_extract(p.payload,'$.proposalDigest') <>
          p.proposal_digest,1) OR
        COALESCE(json_type(p.payload,'$.scopeRef') <> 'text',1) OR
        COALESCE(json_extract(p.payload,'$.scopeRef') <> p.scope_ref,1) OR
        COALESCE(json_type(p.payload,'$.kind') <> 'text',1) OR
        COALESCE(json_extract(p.payload,'$.kind') <> p.kind,1) OR
        (
          p.observed_snapshot_id IS NULL AND
          COALESCE(json_type(p.payload,'$.observedSnapshotId') <> 'null',1)
        ) OR
        (
          p.observed_snapshot_id IS NOT NULL AND (
            COALESCE(json_type(p.payload,'$.observedSnapshotId') <> 'text',1) OR
            COALESCE(json_extract(p.payload,'$.observedSnapshotId') <>
              p.observed_snapshot_id,1)
          )
        ) OR
        COALESCE(json_type(p.payload,'$.submittedAt') <> 'text',1) OR
        COALESCE(json_extract(p.payload,'$.submittedAt') <> p.submitted_at,1) OR
        COALESCE(json_type(p.payload,'$.proposer') <> 'object',1) OR
        COALESCE(json_type(p.payload,'$.proposer.kind') <> 'text',1) OR
        COALESCE(json_extract(p.payload,'$.proposer.kind') <>
          'claimed_actor',1) OR
        COALESCE(json_type(p.payload,'$.proposer.ref') <> 'text',1) OR
        COALESCE(json_extract(p.payload,'$.proposer.ref') <> p.author,1) OR
        COALESCE(json_type(p.payload,'$.effect') <> 'text',1) OR
        COALESCE(json_extract(p.payload,'$.effect') <>
          'review_contribution_only',1) OR
        COALESCE(json_type(p.payload,'$.graphMutationApplied') <> 'false',1) OR
        COALESCE(json_type(p.payload,'$.reviewRequirement') <> 'object',1) OR
        COALESCE(json_type(p.payload,
          '$.reviewRequirement.independentMachineValidation') <> 'text',1) OR
        COALESCE(json_type(p.payload,
          '$.reviewRequirement.authorityStatus') <> 'text',1) OR
        COALESCE(json_extract(p.payload,
          '$.reviewRequirement.authorityStatus') <> 'not_granted',1) OR
        COALESCE(json_type(p.payload,
          '$.reviewRequirement.routeHint') <> 'text',1) OR
        COALESCE(json_type(p.payload,
          '$.reviewRequirement.indicatedAuthoritySignals') <> 'array',1) OR
        (
          p.kind='comment' AND (
            p.observed_snapshot_id IS NULL OR
            COALESCE(json_type(p.payload,'$.subject') <> 'object',1) OR
            COALESCE(json_type(p.payload,'$.body') <> 'text',1) OR
            COALESCE(json_extract(p.payload,
              '$.reviewRequirement.independentMachineValidation') <>
              'not_applicable',1) OR
            COALESCE(json_extract(p.payload,
              '$.reviewRequirement.routeHint') <> 'comment_only',1) OR
            COALESCE(json_array_length(p.payload,
              '$.reviewRequirement.indicatedAuthoritySignals') <> 0,1)
          )
        ) OR
        (
          p.kind='graph_change' AND (
            COALESCE(json_type(p.payload,'$.reason') <> 'text',1) OR
            COALESCE(json_type(p.payload,'$.source')
              NOT IN ('object','null'),1) OR
            COALESCE(json_type(p.payload,'$.authorAssessment') <>
              'object',1) OR
            COALESCE(json_type(p.payload,'$.changes') <> 'array',1) OR
            COALESCE(json_array_length(p.payload,'$.changes') < 1,1) OR
            COALESCE(json_type(p.payload,'$.mechanicalReview') <>
              'object',1) OR
            COALESCE(json_extract(p.payload,
              '$.mechanicalReview.status') <> 'passed',1) OR
            COALESCE(json_type(p.payload,
              '$.mechanicalReview.candidateDigest') <> 'text',1) OR
            COALESCE(json_extract(p.payload,
              '$.reviewRequirement.independentMachineValidation') <>
              'required',1) OR
            COALESCE(json_extract(p.payload,
              '$.reviewRequirement.routeHint')
              NOT IN ('delegated_application_candidate',
                      'human_authority_indicated'),1)
          )
        )
    );
  DROP TABLE ticket_proposals_migration_019_guard;

  CREATE TABLE ticket_proposal_validation_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    scope_ref TEXT NOT NULL
      CHECK(length(scope_ref)=68 AND substr(scope_ref,1,4)='tps-' AND
            substr(scope_ref,5) NOT GLOB '*[^0-9a-f]*'),
    validation_receipt_id TEXT NOT NULL
      CHECK(length(validation_receipt_id)=68 AND
            substr(validation_receipt_id,1,4)='tpv-' AND
            substr(validation_receipt_id,5) NOT GLOB '*[^0-9a-f]*'),
    validation_receipt_digest TEXT NOT NULL
      CHECK(length(validation_receipt_digest)=64 AND
            validation_receipt_digest NOT GLOB '*[^0-9a-f]*'),
    proposal_id TEXT NOT NULL
      CHECK(length(proposal_id)=68 AND substr(proposal_id,1,4)='tgp-' AND
            substr(proposal_id,5) NOT GLOB '*[^0-9a-f]*'),
    proposal_digest TEXT NOT NULL
      CHECK(length(proposal_digest)=64 AND
            proposal_digest NOT GLOB '*[^0-9a-f]*'),
    observed_snapshot_id TEXT
      CHECK(observed_snapshot_id IS NULL OR
            (length(observed_snapshot_id)=68 AND
             substr(observed_snapshot_id,1,4)='tgs-' AND
             substr(observed_snapshot_id,5) NOT GLOB '*[^0-9a-f]*')),
    candidate_digest TEXT NOT NULL
      CHECK(length(candidate_digest)=64 AND
            candidate_digest NOT GLOB '*[^0-9a-f]*'),
    repository_root TEXT NOT NULL CHECK(length(repository_root)>0),
    worktree_root TEXT NOT NULL CHECK(length(worktree_root)>0),
    repository_incarnation TEXT NOT NULL
      CHECK(length(repository_incarnation)>0),
    author TEXT NOT NULL CHECK(length(author)>0),
    task_id TEXT REFERENCES tasks(id),
    request_id TEXT NOT NULL CHECK(length(request_id)>0),
    recorded_at TEXT NOT NULL CHECK(length(recorded_at)>0),
    validator_id TEXT NOT NULL CHECK(length(validator_id)>0),
    validator_version TEXT NOT NULL CHECK(length(validator_version)>0),
    validator_artifact_digest TEXT NOT NULL
      CHECK(length(validator_artifact_digest)=64 AND
            validator_artifact_digest NOT GLOB '*[^0-9a-f]*'),
    policy_id TEXT NOT NULL CHECK(length(policy_id)>0),
    policy_version TEXT NOT NULL CHECK(length(policy_version)>0),
    policy_artifact_digest TEXT NOT NULL
      CHECK(length(policy_artifact_digest)=64 AND
            policy_artifact_digest NOT GLOB '*[^0-9a-f]*'),
    conclusion TEXT NOT NULL
      CHECK(conclusion IN ('passed','failed','inconclusive')),
    check_count INTEGER NOT NULL CHECK(check_count=6),
    finding_count INTEGER NOT NULL CHECK(finding_count>=0),
    blocking_finding_count INTEGER NOT NULL
      CHECK(blocking_finding_count>=0),
    advisory_finding_count INTEGER NOT NULL
      CHECK(advisory_finding_count>=0),
    authority_signal_count INTEGER NOT NULL
      CHECK(authority_signal_count>=0),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    byte_length INTEGER NOT NULL
      CHECK(byte_length>=0 AND
            byte_length=length(CAST(payload AS BLOB))),
    UNIQUE(repo_id,validation_receipt_id),
    UNIQUE(repo_id,request_id),
    FOREIGN KEY(repo_id,proposal_id)
      REFERENCES ticket_proposals(repo_id,proposal_id),
    CHECK(blocking_finding_count+advisory_finding_count=finding_count)
  );
  CREATE INDEX idx_ticket_proposal_validations_scope_sequence
    ON ticket_proposal_validation_receipts(repo_id,scope_ref,sequence);
  CREATE INDEX idx_ticket_proposal_validations_proposal_sequence
    ON ticket_proposal_validation_receipts(
      repo_id,scope_ref,proposal_id,sequence
    );
  CREATE TRIGGER ticket_proposal_validation_receipts_immutable_update
    BEFORE UPDATE ON ticket_proposal_validation_receipts
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal validation receipts are immutable'); END;
  CREATE TRIGGER ticket_proposal_validation_receipts_immutable_delete
    BEFORE DELETE ON ticket_proposal_validation_receipts
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal validation receipts are immutable'); END;
  CREATE TRIGGER ticket_proposal_validation_receipts_binding_insert
    BEFORE INSERT ON ticket_proposal_validation_receipts
    WHEN
      COALESCE(json_type(NEW.payload) <> 'object',1) OR
      COALESCE(json_extract(NEW.payload,'$.schemaVersion') <> 1,1) OR
      COALESCE(json_extract(NEW.payload,'$.kind') <>
        'ticket_proposal_validation_receipt',1) OR
      COALESCE(json_extract(NEW.payload,'$.validationReceiptId') <>
        NEW.validation_receipt_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.validationReceiptDigest') <>
        NEW.validation_receipt_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.scopeRef') <> NEW.scope_ref,1) OR
      COALESCE(json_extract(NEW.payload,'$.target.kind') <>
        'ticket_graph_change_proposal',1) OR
      COALESCE(json_extract(NEW.payload,'$.target.proposalId') <>
        NEW.proposal_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.target.proposalDigest') <>
        NEW.proposal_digest,1) OR
      (
        NEW.observed_snapshot_id IS NULL AND
        COALESCE(json_type(NEW.payload,
          '$.target.observedSnapshotId') <> 'null',1)
      ) OR
      (
        NEW.observed_snapshot_id IS NOT NULL AND (
          COALESCE(json_type(NEW.payload,
            '$.target.observedSnapshotId') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.target.observedSnapshotId') <> NEW.observed_snapshot_id,1)
        )
      ) OR
      COALESCE(json_extract(NEW.payload,'$.target.candidateDigest') <>
        NEW.candidate_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.recordedAt') <>
        NEW.recorded_at,1) OR
      COALESCE(json_extract(NEW.payload,'$.producer.kind') <>
        'claimed_machine_validator',1) OR
      COALESCE(json_extract(NEW.payload,'$.producer.id') <>
        NEW.validator_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.producer.version') <>
        NEW.validator_version,1) OR
      COALESCE(json_extract(NEW.payload,'$.producer.artifactDigest') <>
        NEW.validator_artifact_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.producer.trust') <>
        'claimed_unverified',1) OR
      COALESCE(json_extract(NEW.payload,'$.producer.invokedBy.kind') <>
        'claimed_actor',1) OR
      COALESCE(json_extract(NEW.payload,'$.producer.invokedBy.ref') <>
        NEW.author,1) OR
      COALESCE(json_extract(NEW.payload,'$.policy.id') <>
        NEW.policy_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.policy.version') <>
        NEW.policy_version,1) OR
      COALESCE(json_extract(NEW.payload,'$.policy.artifactDigest') <>
        NEW.policy_artifact_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.policy.trust') <>
        'claimed_unverified',1) OR
      COALESCE(json_extract(NEW.payload,'$.conclusion') <>
        NEW.conclusion,1) OR
      COALESCE(json_type(NEW.payload,'$.checks') <> 'array',1) OR
      COALESCE(json_array_length(NEW.payload,'$.checks') <>
        NEW.check_count,1) OR
      EXISTS (
        SELECT 1 FROM json_each(NEW.payload,'$.checks') c
        WHERE COALESCE(json_extract(c.value,'$.code') NOT IN (
          'promise_preservation','containment_truth','dependency_truth',
          'change_classification','delegated_scope','protected_boundaries'
        ),1)
      ) OR
      COALESCE((
        SELECT COUNT(DISTINCT json_extract(c.value,'$.code'))
        FROM json_each(NEW.payload,'$.checks') c
      ) <> 6,1) OR
      COALESCE(json_type(NEW.payload,'$.findings') <> 'array',1) OR
      COALESCE(json_array_length(NEW.payload,'$.findings') <>
        NEW.finding_count,1) OR
      EXISTS (
        SELECT 1 FROM json_each(NEW.payload,'$.findings') f
        WHERE COALESCE(json_extract(f.value,'$.impact')
          NOT IN ('blocking','advisory'),1)
      ) OR
      COALESCE((
        SELECT COUNT(*) FROM json_each(NEW.payload,'$.findings') f
        WHERE json_extract(f.value,'$.impact')='blocking'
      ) <> NEW.blocking_finding_count,1) OR
      COALESCE((
        SELECT COUNT(*) FROM json_each(NEW.payload,'$.findings') f
        WHERE json_extract(f.value,'$.impact')='advisory'
      ) <> NEW.advisory_finding_count,1) OR
      COALESCE(json_type(NEW.payload,'$.indicatedAuthoritySignals') <>
        'array',1) OR
      COALESCE(json_array_length(NEW.payload,'$.indicatedAuthoritySignals') <>
        NEW.authority_signal_count,1) OR
      EXISTS (
        SELECT 1 FROM json_each(
          NEW.payload,'$.indicatedAuthoritySignals'
        ) s
        WHERE COALESCE(s.type <> 'text' OR s.value NOT IN (
          'initial_plan_authority','experience_product',
          'principle_deviation','permission_side_effect','risk_policy'
        ),1)
      ) OR
      COALESCE(json_extract(NEW.payload,'$.effect') <>
        'validation_evidence_only',1) OR
      COALESCE(json_extract(NEW.payload,'$.maturityEffect') <> 'none',1) OR
      COALESCE(json_type(NEW.payload,'$.authorityGranted') <> 'false',1) OR
      COALESCE(json_type(NEW.payload,'$.applicationAuthorized') <>
        'false',1) OR
      COALESCE(json_type(NEW.payload,'$.graphMutationApplied') <>
        'false',1) OR
      NOT EXISTS (
        SELECT 1 FROM ticket_proposals p
        WHERE p.repo_id=NEW.repo_id
          AND p.scope_ref=NEW.scope_ref
          AND p.proposal_id=NEW.proposal_id
          AND p.proposal_digest=NEW.proposal_digest
          AND p.kind='graph_change'
          AND p.observed_snapshot_id IS NEW.observed_snapshot_id
          AND COALESCE(json_type(p.payload,
            '$.mechanicalReview.candidateDigest')='text',0)
          AND json_extract(p.payload,
            '$.mechanicalReview.candidateDigest')=NEW.candidate_digest
      )
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal validation receipt binding is invalid'); END;

  DROP TRIGGER operation_request_receipt_blob_binding_insert;
  CREATE TRIGGER operation_request_receipt_blob_binding_insert
    BEFORE INSERT ON operation_request_receipts
    WHEN NEW.outcome_blob_digest IS NOT NULL AND (
      NEW.operation NOT IN (
        'ticket.graph.snapshot',
        'ticket.subject.inspect',
        'ticket.trace.list',
        'ticket.proposal.submit',
        'ticket.proposal.inspect',
        'ticket.proposal.list',
        'ticket.proposal.validation.record',
        'ticket.proposal.validation.list',
        'ticket.proposal.validation.inspect'
      ) OR
      COALESCE(json_type(NEW.outcome,'$.outcomeBlob') <> 'text',1) OR
      COALESCE(json_extract(NEW.outcome,'$.outcomeBlob') <>
        NEW.outcome_blob_digest,1) OR
      NOT EXISTS (
        SELECT 1 FROM operation_outcome_blobs b
        WHERE b.digest=NEW.outcome_blob_digest
          AND b.outcome_kind=NEW.outcome_kind
      )
    )
    BEGIN SELECT RAISE(ABORT,'operation outcome blob binding is invalid'); END;
  `,

  // 020 — immutable authority decisions and crash-reconcilable Ticket graph
  // application facts. Decisions close the proposal-validation ledger for one
  // exact proposal/candidate. Intents retain the complete candidate separately
  // from their public receipt so a post-publication crash can reconstruct the
  // exact publish request. Application receipts are terminal publication facts;
  // none of these tables carries mutable workflow status.
  `
  CREATE TABLE ticket_proposal_authority_decisions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    scope_ref TEXT NOT NULL
      CHECK(length(scope_ref)=68 AND substr(scope_ref,1,4)='tps-' AND
            substr(scope_ref,5) NOT GLOB '*[^0-9a-f]*'),
    authority_decision_id TEXT NOT NULL
      CHECK(length(authority_decision_id)=68 AND
            substr(authority_decision_id,1,4)='tgd-' AND
            substr(authority_decision_id,5) NOT GLOB '*[^0-9a-f]*'),
    authority_decision_digest TEXT NOT NULL
      CHECK(length(authority_decision_digest)=64 AND
            authority_decision_digest NOT GLOB '*[^0-9a-f]*'),
    proposal_id TEXT NOT NULL
      CHECK(length(proposal_id)=68 AND substr(proposal_id,1,4)='tgp-' AND
            substr(proposal_id,5) NOT GLOB '*[^0-9a-f]*'),
    proposal_digest TEXT NOT NULL
      CHECK(length(proposal_digest)=64 AND
            proposal_digest NOT GLOB '*[^0-9a-f]*'),
    observed_snapshot_id TEXT
      CHECK(observed_snapshot_id IS NULL OR
            (length(observed_snapshot_id)=68 AND
             substr(observed_snapshot_id,1,4)='tgs-' AND
             substr(observed_snapshot_id,5) NOT GLOB '*[^0-9a-f]*')),
    candidate_digest TEXT NOT NULL
      CHECK(length(candidate_digest)=64 AND
            candidate_digest NOT GLOB '*[^0-9a-f]*'),
    validation_set_digest TEXT NOT NULL
      CHECK(length(validation_set_digest)=64 AND
            validation_set_digest NOT GLOB '*[^0-9a-f]*'),
    validation_through_sequence INTEGER NOT NULL
      CHECK(validation_through_sequence>=0),
    validation_set_count INTEGER NOT NULL CHECK(validation_set_count>=0),
    accepted_validations TEXT NOT NULL
      CHECK(json_valid(accepted_validations) AND
            json_type(accepted_validations)='array'),
    required_path TEXT NOT NULL
      CHECK(required_path IN ('delegated_policy','human_authority')),
    disposition TEXT NOT NULL
      CHECK(disposition IN ('authorized','rejected')),
    provider_kind TEXT NOT NULL
      CHECK(provider_kind='trusted_host_authority_provider'),
    provider_id TEXT NOT NULL CHECK(length(provider_id)>0),
    provider_version TEXT NOT NULL CHECK(length(provider_version)>0),
    provider_artifact_digest TEXT NOT NULL
      CHECK(length(provider_artifact_digest)=64 AND
            provider_artifact_digest NOT GLOB '*[^0-9a-f]*'),
    provider_trust TEXT NOT NULL CHECK(provider_trust='host_injected'),
    principal_kind TEXT NOT NULL CHECK(principal_kind IN ('human','service')),
    principal_ref TEXT NOT NULL CHECK(length(principal_ref)>0),
    principal_authentication_context_digest TEXT NOT NULL
      CHECK(length(principal_authentication_context_digest)=64 AND
            principal_authentication_context_digest
              NOT GLOB '*[^0-9a-f]*'),
    principal_trust TEXT NOT NULL CHECK(principal_trust='host_authenticated'),
    basis_kind TEXT NOT NULL
      CHECK(basis_kind IN ('human_authority','delegation')),
    basis_ref TEXT NOT NULL CHECK(length(basis_ref)>0),
    basis_digest TEXT NOT NULL
      CHECK(length(basis_digest)=64 AND
            basis_digest NOT GLOB '*[^0-9a-f]*'),
    resolved_change_class TEXT NOT NULL
      CHECK(resolved_change_class IN
        ('elaboration','decomposition','expansion')),
    resolved_authority_signals TEXT NOT NULL
      CHECK(json_valid(resolved_authority_signals) AND
            json_type(resolved_authority_signals)='array'),
    authority_signal_count INTEGER NOT NULL
      CHECK(authority_signal_count>=0 AND authority_signal_count<=5),
    rationale TEXT NOT NULL CHECK(length(rationale)>0),
    request_id TEXT NOT NULL CHECK(length(request_id)>0),
    decided_at TEXT NOT NULL CHECK(length(decided_at)>0),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    byte_length INTEGER NOT NULL
      CHECK(byte_length>=0 AND
            byte_length=length(CAST(payload AS BLOB))),
    UNIQUE(repo_id,authority_decision_id),
    UNIQUE(repo_id,request_id),
    UNIQUE(repo_id,proposal_id),
    FOREIGN KEY(repo_id,proposal_id)
      REFERENCES ticket_proposals(repo_id,proposal_id),
    CHECK(
      required_path<>'human_authority' OR principal_kind='human'
    ),
    CHECK(
      (required_path='human_authority' AND basis_kind='human_authority') OR
      (required_path='delegated_policy' AND basis_kind='delegation')
    )
  );
  CREATE INDEX idx_ticket_proposal_authority_scope_sequence
    ON ticket_proposal_authority_decisions(repo_id,scope_ref,sequence);
  CREATE INDEX idx_ticket_proposal_authority_proposal
    ON ticket_proposal_authority_decisions(
      repo_id,scope_ref,proposal_id,sequence
    );
  CREATE TRIGGER ticket_proposal_authority_decisions_immutable_update
    BEFORE UPDATE ON ticket_proposal_authority_decisions
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal authority decisions are immutable'); END;
  CREATE TRIGGER ticket_proposal_authority_decisions_immutable_delete
    BEFORE DELETE ON ticket_proposal_authority_decisions
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal authority decisions are immutable'); END;
  CREATE TRIGGER ticket_proposal_authority_decisions_binding_insert
    BEFORE INSERT ON ticket_proposal_authority_decisions
    WHEN
      COALESCE(json_type(NEW.payload) <> 'object',1) OR
      COALESCE(json_type(NEW.payload,'$.schemaVersion') <> 'integer',1) OR
      COALESCE(json_extract(NEW.payload,'$.schemaVersion') <> 1,1) OR
      COALESCE(json_extract(NEW.payload,'$.kind') <>
        'ticket_proposal_authority_decision',1) OR
      COALESCE(json_extract(NEW.payload,'$.authorityDecisionId') <>
        NEW.authority_decision_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.authorityDecisionDigest') <>
        NEW.authority_decision_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.scopeRef') <> NEW.scope_ref,1) OR
      COALESCE(json_extract(NEW.payload,'$.target.kind') <>
        'ticket_graph_change_proposal',1) OR
      COALESCE(json_extract(NEW.payload,'$.target.proposalId') <>
        NEW.proposal_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.target.proposalDigest') <>
        NEW.proposal_digest,1) OR
      (
        NEW.observed_snapshot_id IS NULL AND
        COALESCE(json_type(NEW.payload,
          '$.target.observedSnapshotId') <> 'null',1)
      ) OR
      (
        NEW.observed_snapshot_id IS NOT NULL AND (
          COALESCE(json_type(NEW.payload,
            '$.target.observedSnapshotId') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.target.observedSnapshotId') <> NEW.observed_snapshot_id,1)
        )
      ) OR
      COALESCE(json_extract(NEW.payload,'$.target.candidateDigest') <>
        NEW.candidate_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.validationSet.digest') <>
        NEW.validation_set_digest,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.validationSet.throughSequence') <>
        NEW.validation_through_sequence,1) OR
      COALESCE(json_extract(NEW.payload,'$.validationSet.count') <>
        NEW.validation_set_count,1) OR
      COALESCE(json_type(NEW.payload,'$.validationSet.accepted') <>
        'array',1) OR
      COALESCE(json_extract(NEW.payload,'$.validationSet.accepted') <>
        json(NEW.accepted_validations),1) OR
      COALESCE(json_extract(NEW.payload,'$.requiredPath') <>
        NEW.required_path,1) OR
      COALESCE(json_extract(NEW.payload,'$.disposition') <>
        NEW.disposition,1) OR
      COALESCE(json_extract(NEW.payload,'$.decidedAt') <> NEW.decided_at,1) OR
      COALESCE(json_extract(NEW.payload,'$.provider.kind') <>
        NEW.provider_kind,1) OR
      COALESCE(json_extract(NEW.payload,'$.provider.id') <>
        NEW.provider_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.provider.version') <>
        NEW.provider_version,1) OR
      COALESCE(json_extract(NEW.payload,'$.provider.artifactDigest') <>
        NEW.provider_artifact_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.provider.trust') <>
        NEW.provider_trust,1) OR
      COALESCE(json_extract(NEW.payload,'$.principal.kind') <>
        NEW.principal_kind,1) OR
      COALESCE(json_extract(NEW.payload,'$.principal.ref') <>
        NEW.principal_ref,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.principal.authenticationContextDigest') <>
        NEW.principal_authentication_context_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.principal.trust') <>
        NEW.principal_trust,1) OR
      COALESCE(json_extract(NEW.payload,'$.basis.kind') <>
        NEW.basis_kind,1) OR
      COALESCE(json_extract(NEW.payload,'$.basis.ref') <>
        NEW.basis_ref,1) OR
      COALESCE(json_extract(NEW.payload,'$.basis.digest') <>
        NEW.basis_digest,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.resolvedAssessment.changeClass') <>
        NEW.resolved_change_class,1) OR
      COALESCE(json_type(NEW.payload,
        '$.resolvedAssessment.authoritySignals') <> 'array',1) OR
      COALESCE(json_extract(NEW.payload,
        '$.resolvedAssessment.authoritySignals') <>
        json(NEW.resolved_authority_signals),1) OR
      COALESCE(json_array_length(NEW.resolved_authority_signals) <>
        NEW.authority_signal_count,1) OR
      COALESCE(json_extract(NEW.payload,'$.rationale') <> NEW.rationale,1) OR
      COALESCE(json_extract(NEW.payload,'$.effect') <>
        'authority_decision_only',1) OR
      COALESCE(json_extract(NEW.payload,'$.maturityEffect') <> 'none',1) OR
      COALESCE(json_type(NEW.payload,'$.graphMutationApplied') <>
        'false',1) OR
      (
        NEW.disposition='authorized' AND (
          COALESCE(json_type(NEW.payload,'$.authorityGranted') <>
            'true',1) OR
          COALESCE(json_type(NEW.payload,'$.applicationAuthorized') <>
            'true',1)
        )
      ) OR
      (
        NEW.disposition='rejected' AND (
          COALESCE(json_type(NEW.payload,'$.authorityGranted') <>
            'false',1) OR
          COALESCE(json_type(NEW.payload,'$.applicationAuthorized') <>
            'false',1)
        )
      ) OR
      EXISTS (
        SELECT 1
        FROM json_each(NEW.resolved_authority_signals) s
        WHERE COALESCE(s.type <> 'text' OR s.value NOT IN (
          'initial_plan_authority','experience_product',
          'principle_deviation','permission_side_effect','risk_policy'
        ),1)
      ) OR
      COALESCE((
        SELECT COUNT(DISTINCT s.value)
        FROM json_each(NEW.resolved_authority_signals) s
      ) <> NEW.authority_signal_count,1) OR
      EXISTS (
        SELECT 1
        FROM json_each(NEW.accepted_validations) a
        WHERE COALESCE(a.type <> 'object',1) OR
          COALESCE(json_type(a.value,'$.validationReceiptId') <> 'text',1) OR
          COALESCE(json_type(a.value,
            '$.validationReceiptDigest') <> 'text',1)
      ) OR
      COALESCE((
        SELECT COUNT(DISTINCT
          json_extract(a.value,'$.validationReceiptId'))
        FROM json_each(NEW.accepted_validations) a
      ) <> json_array_length(NEW.accepted_validations),1) OR
      COALESCE((
        SELECT COUNT(*)
        FROM ticket_proposal_validation_receipts v
        WHERE v.repo_id=NEW.repo_id
          AND v.scope_ref=NEW.scope_ref
          AND v.proposal_id=NEW.proposal_id
          AND v.sequence<=NEW.validation_through_sequence
      ) <> NEW.validation_set_count,1) OR
      EXISTS (
        SELECT 1
        FROM ticket_proposal_validation_receipts v
        WHERE v.repo_id=NEW.repo_id
          AND v.scope_ref=NEW.scope_ref
          AND v.proposal_id=NEW.proposal_id
          AND v.sequence>NEW.validation_through_sequence
      ) OR
      (
        NEW.disposition='authorized' AND (
          json_array_length(NEW.accepted_validations)<1 OR
          EXISTS (
            SELECT 1
            FROM json_each(NEW.accepted_validations) a
            WHERE NOT EXISTS (
              SELECT 1
              FROM ticket_proposal_validation_receipts v
              WHERE v.repo_id=NEW.repo_id
                AND v.scope_ref=NEW.scope_ref
                AND v.proposal_id=NEW.proposal_id
                AND v.proposal_digest=NEW.proposal_digest
                AND v.observed_snapshot_id IS NEW.observed_snapshot_id
                AND v.candidate_digest=NEW.candidate_digest
                AND v.validation_receipt_id=json_extract(
                  a.value,'$.validationReceiptId')
                AND v.validation_receipt_digest=json_extract(
                  a.value,'$.validationReceiptDigest')
                AND v.sequence<=NEW.validation_through_sequence
                AND v.conclusion='passed'
                AND v.blocking_finding_count=0
            )
          )
        )
      ) OR
      NOT EXISTS (
        SELECT 1
        FROM ticket_proposals p
        WHERE p.repo_id=NEW.repo_id
          AND p.scope_ref=NEW.scope_ref
          AND p.proposal_id=NEW.proposal_id
          AND p.proposal_digest=NEW.proposal_digest
          AND p.kind='graph_change'
          AND p.observed_snapshot_id IS NEW.observed_snapshot_id
          AND COALESCE(json_extract(p.payload,
            '$.mechanicalReview.candidateDigest')=
            NEW.candidate_digest,0)
      )
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal authority decision binding is invalid'); END;

  CREATE TRIGGER ticket_proposal_validations_closed_after_decision
    BEFORE INSERT ON ticket_proposal_validation_receipts
    WHEN EXISTS (
      SELECT 1
      FROM ticket_proposal_authority_decisions d
      WHERE d.repo_id=NEW.repo_id
        AND d.scope_ref=NEW.scope_ref
        AND d.proposal_id=NEW.proposal_id
    )
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal validation set is closed by its authority decision');
    END;

  CREATE TABLE ticket_proposal_application_intents (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    scope_ref TEXT NOT NULL
      CHECK(length(scope_ref)=68 AND substr(scope_ref,1,4)='tps-' AND
            substr(scope_ref,5) NOT GLOB '*[^0-9a-f]*'),
    application_intent_id TEXT NOT NULL
      CHECK(length(application_intent_id)=68 AND
            substr(application_intent_id,1,4)='tai-' AND
            substr(application_intent_id,5) NOT GLOB '*[^0-9a-f]*'),
    application_intent_digest TEXT NOT NULL
      CHECK(length(application_intent_digest)=64 AND
            application_intent_digest NOT GLOB '*[^0-9a-f]*'),
    authority_decision_id TEXT NOT NULL
      CHECK(length(authority_decision_id)=68 AND
            substr(authority_decision_id,1,4)='tgd-' AND
            substr(authority_decision_id,5) NOT GLOB '*[^0-9a-f]*'),
    authority_decision_digest TEXT NOT NULL
      CHECK(length(authority_decision_digest)=64 AND
            authority_decision_digest NOT GLOB '*[^0-9a-f]*'),
    proposal_id TEXT NOT NULL
      CHECK(length(proposal_id)=68 AND substr(proposal_id,1,4)='tgp-' AND
            substr(proposal_id,5) NOT GLOB '*[^0-9a-f]*'),
    proposal_digest TEXT NOT NULL
      CHECK(length(proposal_digest)=64 AND
            proposal_digest NOT GLOB '*[^0-9a-f]*'),
    observed_snapshot_id TEXT
      CHECK(observed_snapshot_id IS NULL OR
            (length(observed_snapshot_id)=68 AND
             substr(observed_snapshot_id,1,4)='tgs-' AND
             substr(observed_snapshot_id,5) NOT GLOB '*[^0-9a-f]*')),
    candidate_digest TEXT NOT NULL
      CHECK(length(candidate_digest)=64 AND
            candidate_digest NOT GLOB '*[^0-9a-f]*'),
    repository_incarnation TEXT NOT NULL
      CHECK(length(repository_incarnation)>0),
    base_snapshot_id TEXT
      CHECK(base_snapshot_id IS NULL OR
            (length(base_snapshot_id)=68 AND
             substr(base_snapshot_id,1,4)='tgs-' AND
             substr(base_snapshot_id,5) NOT GLOB '*[^0-9a-f]*')),
    store_id TEXT NOT NULL
      CHECK(length(store_id)=45 AND
            substr(store_id,1,13)='ticket-store-' AND
            substr(store_id,14) NOT GLOB '*[^0-9a-f]*'),
    candidate_snapshot_id TEXT NOT NULL
      CHECK(length(candidate_snapshot_id)=68 AND
            substr(candidate_snapshot_id,1,4)='tgs-' AND
            substr(candidate_snapshot_id,5) NOT GLOB '*[^0-9a-f]*'),
    ticket_count INTEGER NOT NULL CHECK(ticket_count>0),
    direct_unlock_count INTEGER NOT NULL CHECK(direct_unlock_count>=0),
    candidate_definitions TEXT NOT NULL
      CHECK(json_valid(candidate_definitions) AND
            json_type(candidate_definitions)='array'),
    candidate_byte_length INTEGER NOT NULL
      CHECK(candidate_byte_length>=2 AND
            candidate_byte_length<=33554432 AND
            candidate_byte_length=
              length(CAST(candidate_definitions AS BLOB))),
    request_id TEXT NOT NULL CHECK(length(request_id)>0),
    prepared_at TEXT NOT NULL CHECK(length(prepared_at)>0),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    byte_length INTEGER NOT NULL
      CHECK(byte_length>=0 AND
            byte_length=length(CAST(payload AS BLOB))),
    UNIQUE(repo_id,application_intent_id),
    UNIQUE(repo_id,request_id),
    UNIQUE(repo_id,proposal_id),
    UNIQUE(repo_id,authority_decision_id),
    FOREIGN KEY(repo_id,proposal_id)
      REFERENCES ticket_proposals(repo_id,proposal_id),
    FOREIGN KEY(repo_id,authority_decision_id)
      REFERENCES ticket_proposal_authority_decisions(
        repo_id,authority_decision_id
      )
  );
  CREATE INDEX idx_ticket_proposal_application_intents_scope_sequence
    ON ticket_proposal_application_intents(repo_id,scope_ref,sequence);
  CREATE INDEX idx_ticket_proposal_application_intents_proposal
    ON ticket_proposal_application_intents(
      repo_id,scope_ref,proposal_id,sequence
    );
  CREATE TRIGGER ticket_proposal_application_intents_immutable_update
    BEFORE UPDATE ON ticket_proposal_application_intents
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal application intents are immutable'); END;
  CREATE TRIGGER ticket_proposal_application_intents_immutable_delete
    BEFORE DELETE ON ticket_proposal_application_intents
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal application intents are immutable'); END;
  CREATE TRIGGER ticket_proposal_application_intents_binding_insert
    BEFORE INSERT ON ticket_proposal_application_intents
    WHEN
      COALESCE(json_type(NEW.payload) <> 'object',1) OR
      COALESCE(json_extract(NEW.payload,'$.schemaVersion') <> 1,1) OR
      COALESCE(json_extract(NEW.payload,'$.kind') <>
        'ticket_proposal_application_intent',1) OR
      COALESCE(json_extract(NEW.payload,'$.applicationIntentId') <>
        NEW.application_intent_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.applicationIntentDigest') <>
        NEW.application_intent_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.scopeRef') <> NEW.scope_ref,1) OR
      COALESCE(json_extract(NEW.payload,'$.target.kind') <>
        'ticket_graph_change_proposal',1) OR
      COALESCE(json_extract(NEW.payload,'$.target.proposalId') <>
        NEW.proposal_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.target.proposalDigest') <>
        NEW.proposal_digest,1) OR
      (
        NEW.observed_snapshot_id IS NULL AND
        COALESCE(json_type(NEW.payload,
          '$.target.observedSnapshotId') <> 'null',1)
      ) OR
      (
        NEW.observed_snapshot_id IS NOT NULL AND (
          COALESCE(json_type(NEW.payload,
            '$.target.observedSnapshotId') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.target.observedSnapshotId') <> NEW.observed_snapshot_id,1)
        )
      ) OR
      COALESCE(json_extract(NEW.payload,'$.target.candidateDigest') <>
        NEW.candidate_digest,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.authorityDecision.authorityDecisionId') <>
        NEW.authority_decision_id,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.authorityDecision.authorityDecisionDigest') <>
        NEW.authority_decision_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.preparedAt') <>
        NEW.prepared_at,1) OR
      (
        NEW.base_snapshot_id IS NULL AND
        COALESCE(json_type(NEW.payload,
          '$.publication.baseSnapshotId') <> 'null',1)
      ) OR
      (
        NEW.base_snapshot_id IS NOT NULL AND (
          COALESCE(json_type(NEW.payload,
            '$.publication.baseSnapshotId') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.publication.baseSnapshotId') <> NEW.base_snapshot_id,1)
        )
      ) OR
      COALESCE(json_extract(NEW.payload,'$.publication.storeId') <>
        NEW.store_id,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.publication.candidateSnapshotId') <>
        NEW.candidate_snapshot_id,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.publication.candidateDigest') <> NEW.candidate_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.publication.ticketCount') <>
        NEW.ticket_count,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.publication.directUnlockCount') <>
        NEW.direct_unlock_count,1) OR
      COALESCE(json_extract(NEW.payload,'$.effect') <>
        'pending_canonical_graph_publication',1) OR
      COALESCE(json_extract(NEW.payload,'$.maturityEffect') <> 'none',1) OR
      COALESCE(json_type(NEW.payload,'$.graphMutationApplied') <>
        'false',1) OR
      COALESCE(json_array_length(NEW.candidate_definitions) <>
        NEW.ticket_count,1) OR
      NEW.base_snapshot_id IS NOT NEW.observed_snapshot_id OR
      NOT EXISTS (
        SELECT 1
        FROM ticket_proposal_authority_decisions d
        JOIN ticket_proposals p
          ON p.repo_id=d.repo_id AND p.proposal_id=d.proposal_id
        WHERE d.repo_id=NEW.repo_id
          AND d.scope_ref=NEW.scope_ref
          AND d.authority_decision_id=NEW.authority_decision_id
          AND d.authority_decision_digest=NEW.authority_decision_digest
          AND d.proposal_id=NEW.proposal_id
          AND d.proposal_digest=NEW.proposal_digest
          AND d.observed_snapshot_id IS NEW.observed_snapshot_id
          AND d.candidate_digest=NEW.candidate_digest
          AND d.disposition='authorized'
          AND p.scope_ref=NEW.scope_ref
          AND p.repository_incarnation=NEW.repository_incarnation
      )
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal application intent binding is invalid'); END;

  CREATE TABLE ticket_proposal_application_receipts (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    scope_ref TEXT NOT NULL
      CHECK(length(scope_ref)=68 AND substr(scope_ref,1,4)='tps-' AND
            substr(scope_ref,5) NOT GLOB '*[^0-9a-f]*'),
    application_receipt_id TEXT NOT NULL
      CHECK(length(application_receipt_id)=68 AND
            substr(application_receipt_id,1,4)='tar-' AND
            substr(application_receipt_id,5) NOT GLOB '*[^0-9a-f]*'),
    application_receipt_digest TEXT NOT NULL
      CHECK(length(application_receipt_digest)=64 AND
            application_receipt_digest NOT GLOB '*[^0-9a-f]*'),
    application_intent_id TEXT NOT NULL
      CHECK(length(application_intent_id)=68 AND
            substr(application_intent_id,1,4)='tai-' AND
            substr(application_intent_id,5) NOT GLOB '*[^0-9a-f]*'),
    application_intent_digest TEXT NOT NULL
      CHECK(length(application_intent_digest)=64 AND
            application_intent_digest NOT GLOB '*[^0-9a-f]*'),
    authority_decision_id TEXT NOT NULL
      CHECK(length(authority_decision_id)=68 AND
            substr(authority_decision_id,1,4)='tgd-' AND
            substr(authority_decision_id,5) NOT GLOB '*[^0-9a-f]*'),
    authority_decision_digest TEXT NOT NULL
      CHECK(length(authority_decision_digest)=64 AND
            authority_decision_digest NOT GLOB '*[^0-9a-f]*'),
    proposal_id TEXT NOT NULL
      CHECK(length(proposal_id)=68 AND substr(proposal_id,1,4)='tgp-' AND
            substr(proposal_id,5) NOT GLOB '*[^0-9a-f]*'),
    proposal_digest TEXT NOT NULL
      CHECK(length(proposal_digest)=64 AND
            proposal_digest NOT GLOB '*[^0-9a-f]*'),
    observed_snapshot_id TEXT
      CHECK(observed_snapshot_id IS NULL OR
            (length(observed_snapshot_id)=68 AND
             substr(observed_snapshot_id,1,4)='tgs-' AND
             substr(observed_snapshot_id,5) NOT GLOB '*[^0-9a-f]*')),
    candidate_digest TEXT NOT NULL
      CHECK(length(candidate_digest)=64 AND
            candidate_digest NOT GLOB '*[^0-9a-f]*'),
    publication_status TEXT NOT NULL
      CHECK(publication_status IN ('published','reconciled')),
    previous_snapshot_id TEXT
      CHECK(previous_snapshot_id IS NULL OR
            (length(previous_snapshot_id)=68 AND
             substr(previous_snapshot_id,1,4)='tgs-' AND
             substr(previous_snapshot_id,5) NOT GLOB '*[^0-9a-f]*')),
    snapshot_id TEXT NOT NULL
      CHECK(length(snapshot_id)=68 AND substr(snapshot_id,1,4)='tgs-' AND
            substr(snapshot_id,5) NOT GLOB '*[^0-9a-f]*'),
    ticket_count INTEGER NOT NULL CHECK(ticket_count>0),
    direct_unlock_count INTEGER NOT NULL CHECK(direct_unlock_count>=0),
    request_id TEXT NOT NULL CHECK(length(request_id)>0),
    recorded_at TEXT NOT NULL CHECK(length(recorded_at)>0),
    payload TEXT NOT NULL CHECK(json_valid(payload)),
    byte_length INTEGER NOT NULL
      CHECK(byte_length>=0 AND
            byte_length=length(CAST(payload AS BLOB))),
    UNIQUE(repo_id,application_receipt_id),
    UNIQUE(repo_id,request_id),
    UNIQUE(repo_id,application_intent_id),
    UNIQUE(repo_id,proposal_id),
    FOREIGN KEY(repo_id,proposal_id)
      REFERENCES ticket_proposals(repo_id,proposal_id),
    FOREIGN KEY(repo_id,authority_decision_id)
      REFERENCES ticket_proposal_authority_decisions(
        repo_id,authority_decision_id
      ),
    FOREIGN KEY(repo_id,application_intent_id)
      REFERENCES ticket_proposal_application_intents(
        repo_id,application_intent_id
      )
  );
  CREATE INDEX idx_ticket_proposal_application_receipts_scope_sequence
    ON ticket_proposal_application_receipts(repo_id,scope_ref,sequence);
  CREATE INDEX idx_ticket_proposal_application_receipts_proposal
    ON ticket_proposal_application_receipts(
      repo_id,scope_ref,proposal_id,sequence
    );
  CREATE TRIGGER ticket_proposal_application_receipts_immutable_update
    BEFORE UPDATE ON ticket_proposal_application_receipts
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal application receipts are immutable'); END;
  CREATE TRIGGER ticket_proposal_application_receipts_immutable_delete
    BEFORE DELETE ON ticket_proposal_application_receipts
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal application receipts are immutable'); END;
  CREATE TRIGGER ticket_proposal_application_receipts_binding_insert
    BEFORE INSERT ON ticket_proposal_application_receipts
    WHEN
      COALESCE(json_type(NEW.payload) <> 'object',1) OR
      COALESCE(json_extract(NEW.payload,'$.schemaVersion') <> 1,1) OR
      COALESCE(json_extract(NEW.payload,'$.kind') <>
        'ticket_proposal_application_receipt',1) OR
      COALESCE(json_extract(NEW.payload,'$.applicationReceiptId') <>
        NEW.application_receipt_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.applicationReceiptDigest') <>
        NEW.application_receipt_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.scopeRef') <> NEW.scope_ref,1) OR
      COALESCE(json_extract(NEW.payload,'$.applicationIntentId') <>
        NEW.application_intent_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.applicationIntentDigest') <>
        NEW.application_intent_digest,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.authorityDecision.authorityDecisionId') <>
        NEW.authority_decision_id,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.authorityDecision.authorityDecisionDigest') <>
        NEW.authority_decision_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.target.kind') <>
        'ticket_graph_change_proposal',1) OR
      COALESCE(json_extract(NEW.payload,'$.target.proposalId') <>
        NEW.proposal_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.target.proposalDigest') <>
        NEW.proposal_digest,1) OR
      (
        NEW.observed_snapshot_id IS NULL AND
        COALESCE(json_type(NEW.payload,
          '$.target.observedSnapshotId') <> 'null',1)
      ) OR
      (
        NEW.observed_snapshot_id IS NOT NULL AND (
          COALESCE(json_type(NEW.payload,
            '$.target.observedSnapshotId') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.target.observedSnapshotId') <> NEW.observed_snapshot_id,1)
        )
      ) OR
      COALESCE(json_extract(NEW.payload,'$.target.candidateDigest') <>
        NEW.candidate_digest,1) OR
      COALESCE(json_extract(NEW.payload,'$.recordedAt') <>
        NEW.recorded_at,1) OR
      COALESCE(json_extract(NEW.payload,'$.publication.status') <>
        NEW.publication_status,1) OR
      (
        NEW.previous_snapshot_id IS NULL AND
        COALESCE(json_type(NEW.payload,
          '$.publication.previousSnapshotId') <> 'null',1)
      ) OR
      (
        NEW.previous_snapshot_id IS NOT NULL AND (
          COALESCE(json_type(NEW.payload,
            '$.publication.previousSnapshotId') <> 'text',1) OR
          COALESCE(json_extract(NEW.payload,
            '$.publication.previousSnapshotId') <>
            NEW.previous_snapshot_id,1)
        )
      ) OR
      COALESCE(json_extract(NEW.payload,'$.publication.snapshotId') <>
        NEW.snapshot_id,1) OR
      COALESCE(json_extract(NEW.payload,'$.publication.ticketCount') <>
        NEW.ticket_count,1) OR
      COALESCE(json_extract(NEW.payload,
        '$.publication.directUnlockCount') <>
        NEW.direct_unlock_count,1) OR
      COALESCE(json_extract(NEW.payload,'$.effect') <>
        'ticket_graph_publication',1) OR
      COALESCE(json_extract(NEW.payload,'$.maturityEffect') <> 'none',1) OR
      COALESCE(json_type(NEW.payload,'$.graphMutationApplied') <>
        'true',1) OR
      NOT EXISTS (
        SELECT 1
        FROM ticket_proposal_application_intents i
        JOIN ticket_proposal_authority_decisions d
          ON d.repo_id=i.repo_id
         AND d.authority_decision_id=i.authority_decision_id
        WHERE i.repo_id=NEW.repo_id
          AND i.scope_ref=NEW.scope_ref
          AND i.application_intent_id=NEW.application_intent_id
          AND i.application_intent_digest=NEW.application_intent_digest
          AND i.authority_decision_id=NEW.authority_decision_id
          AND i.authority_decision_digest=NEW.authority_decision_digest
          AND i.proposal_id=NEW.proposal_id
          AND i.proposal_digest=NEW.proposal_digest
          AND i.observed_snapshot_id IS NEW.observed_snapshot_id
          AND i.candidate_digest=NEW.candidate_digest
          AND i.base_snapshot_id IS NEW.previous_snapshot_id
          AND i.candidate_snapshot_id=NEW.snapshot_id
          AND i.ticket_count=NEW.ticket_count
          AND i.direct_unlock_count=NEW.direct_unlock_count
          AND d.disposition='authorized'
      )
    BEGIN SELECT RAISE(ABORT,
      'Ticket proposal application receipt binding is invalid'); END;

  DROP TRIGGER operation_request_receipt_blob_binding_insert;
  CREATE TRIGGER operation_request_receipt_blob_binding_insert
    BEFORE INSERT ON operation_request_receipts
    WHEN NEW.outcome_blob_digest IS NOT NULL AND (
      NEW.operation NOT IN (
        'ticket.graph.snapshot',
        'ticket.subject.inspect',
        'ticket.trace.list',
        'ticket.proposal.submit',
        'ticket.proposal.inspect',
        'ticket.proposal.list',
        'ticket.proposal.validation.record',
        'ticket.proposal.validation.list',
        'ticket.proposal.validation.inspect',
        'ticket.proposal.review.inspect',
        'ticket.proposal.authority.decide',
        'ticket.proposal.apply'
      ) OR
      COALESCE(json_type(NEW.outcome,'$.outcomeBlob') <> 'text',1) OR
      COALESCE(json_extract(NEW.outcome,'$.outcomeBlob') <>
        NEW.outcome_blob_digest,1) OR
      NOT EXISTS (
        SELECT 1 FROM operation_outcome_blobs b
        WHERE b.digest=NEW.outcome_blob_digest
          AND b.outcome_kind=NEW.outcome_kind
      )
    )
    BEGIN SELECT RAISE(ABORT,'operation outcome blob binding is invalid'); END;
  `,
];

/** Stable schema version reported by `vibehub doctor --json`. */
export const CURRENT_SCHEMA_VERSION = MIGRATIONS.length;

export interface DatabaseInspection {
  exists: boolean;
  readable: boolean;
  schemaVersion: number | null;
  expectedSchemaVersion: number;
  sqliteVersion: string | null;
  error?: string;
}

/** Read-only health probe. It never creates or migrates a database. */
export function inspectDatabase(dbPath: string = defaultDbPath()): DatabaseInspection {
  if (!fs.existsSync(dbPath)) {
    return {
      exists: false,
      readable: false,
      schemaVersion: null,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      sqliteVersion: null,
    };
  }
  try {
    return withReadonlyDb(dbPath, (db) => {
      const schemaVersion = db.pragma("user_version", { simple: true }) as number;
      const sqlite = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
      return { exists: true, readable: true, schemaVersion, expectedSchemaVersion: CURRENT_SCHEMA_VERSION, sqliteVersion: sqlite.version };
    });
  } catch (error) {
    return {
      exists: true,
      readable: false,
      schemaVersion: null,
      expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
      sqliteVersion: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function openDb(dbPath: string = defaultDbPath()): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("foreign_keys = ON");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Strict read-only door for doctor/inspection. No mkdir, WAL pragma, or migration. */
function openReadonlyDb(dbPath: string): Db {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * Run a read-only query against a disposable SQLite snapshot. SQLite may
 * create `-shm`/`-wal` bookkeeping even for a readonly WAL database; keeping
 * that activity in a temp directory makes doctor observationally readonly on
 * the user's DB path while still using fileMustExist + readonly SQLite.
 */
export function withReadonlyDb<T>(dbPath: string, read: (db: Db) => T): T {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-doctor-"));
  const snapshot = path.join(temp, "snapshot.db");
  try {
    fs.copyFileSync(dbPath, snapshot, fs.constants.COPYFILE_EXCL);
    for (const suffix of ["-wal", "-shm"] as const) {
      const source = dbPath + suffix;
      if (fs.existsSync(source)) fs.copyFileSync(source, snapshot + suffix);
    }
    const db = openReadonlyDb(snapshot);
    try {
      return read(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function migrate(db: Db): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${version} is newer than supported version ${MIGRATIONS.length}`,
    );
  }
  for (let v = version; v < MIGRATIONS.length; v++) {
    const apply = db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      if (v === 7) importLegacyGraphV2(db);
      if (v === 13) migrateInterventionReceiptHashes(db);
      db.pragma(`user_version = ${v + 1}`);
    });
    apply();
  }
}

function migrateInterventionReceiptHashes(db: Db): void {
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='intervention_requests'`).get();
  if (!exists) return;
  const columns = db.pragma("table_info(intervention_requests)") as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "input_hash")) {
    db.exec(`ALTER TABLE intervention_requests ADD COLUMN input_hash TEXT`);
  }
  db.exec(`
    UPDATE intervention_requests
      SET input_hash = 'legacy-unverifiable:' || repo_id || ':' || request_id
      WHERE input_hash IS NULL;
    CREATE TRIGGER IF NOT EXISTS intervention_requests_require_input_hash_insert
      BEFORE INSERT ON intervention_requests
      WHEN NEW.input_hash IS NULL OR length(NEW.input_hash) = 0
      BEGIN SELECT RAISE(ABORT,'intervention input hash is required'); END;
    CREATE TRIGGER IF NOT EXISTS intervention_requests_input_hash_immutable
      BEFORE UPDATE OF input_hash ON intervention_requests
      BEGIN SELECT RAISE(ABORT,'intervention input hash is immutable'); END;
  `);
}

type MappingChecksumRow = Record<string, string | number | null>;

/** Stable checksum over the complete mapping projection, never row insertion order. */
export function computeMappingChecksum(db: Db, repoId: number, versionId: string): string {
  const select = (sql: string): MappingChecksumRow[] =>
    db.prepare(sql).all(repoId, versionId) as MappingChecksumRow[];
  const projection = {
    features: select(`SELECT feature_id, parent_feature_id, name, description, intent, lifecycle
      FROM mapping_version_features WHERE repo_id = ? AND version_id = ? ORDER BY feature_id`),
    anchors: select(`SELECT feature_id, file, symbol, line_start, line_end, content_hash
      FROM mapping_version_anchors WHERE repo_id = ? AND version_id = ?
      ORDER BY feature_id, file, symbol`),
    layouts: select(`SELECT feature_id, pct_left, pct_top, pct_width, pct_height
      FROM mapping_version_layouts WHERE repo_id = ? AND version_id = ? ORDER BY feature_id`),
  };
  return crypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

const assertion = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`KB_V2_IMPORT_ASSERTION: ${message}`);
};

/** Migration-008 data step. Called only inside the migration transaction. */
function importLegacyGraphV2(db: Db): void {
  const hasTable = (name: string): boolean => db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(name) !== undefined;
  const repos = db.prepare(`SELECT id, created_at AS createdAt FROM repos ORDER BY id`).all() as
    Array<{ id: number; createdAt: string }>;
  const importedAt = new Map(repos.map((repo) => [repo.id, repo.createdAt]));
  const features = (hasTable("features") ? db.prepare(`SELECT id, repo_id AS repoId, parent_id AS parentId, name,
    created_at AS createdAt FROM features ORDER BY repo_id, id`).all() : []) as Array<{
      id: string; repoId: number; parentId: string | null; name: string; createdAt: string;
    }>;
  const specs = (hasTable("specs") ? db.prepare(`SELECT id, repo_id AS repoId, feature_id AS featureId, type, state,
    summary, detail, created_at AS createdAt, updated_at AS updatedAt
    FROM specs ORDER BY repo_id, id`).all() : []) as Array<{
      id: string; repoId: number; featureId: string | null; type: string; state: string;
      summary: string; detail: string | null; createdAt: string; updatedAt: string;
    }>;
  const anchors = (hasTable("anchors") ? db.prepare(`SELECT id, repo_id AS repoId, feature_id AS featureId,
    spec_id AS specId, file, symbol FROM anchors ORDER BY repo_id, id`).all() : []) as Array<{
      id: number; repoId: number; featureId: string | null; specId: string | null;
      file: string; symbol: string | null;
    }>;
  const edges = (hasTable("edges") ? db.prepare(`SELECT id, repo_id AS repoId, from_id AS fromId, to_id AS toId, type
    FROM edges ORDER BY repo_id, id`).all() : []) as Array<{
      id: number; repoId: number; fromId: string; toId: string; type: string;
    }>;
  const rawLayouts = (hasTable("feature_layouts") ? db.prepare(`SELECT feature_id AS featureId,
    pct_left AS pctLeft, pct_top AS pctTop, pct_width AS pctWidth,
    pct_height AS pctHeight, computed_at AS computedAt
    FROM feature_layouts ORDER BY feature_id`).all() : []) as Array<{
      featureId: string; pctLeft: number; pctTop: number;
      pctWidth: number; pctHeight: number; computedAt: string;
    }>;
  const layouts: Array<(typeof rawLayouts)[number] & { repoId: number }> = [];

  const featureKeys = new Set(features.map((row) => `${row.repoId}\0${row.id}`));
  const specKeys = new Set(specs.map((row) => `${row.repoId}\0${row.id}`));
  for (const feature of features) {
    assertion(!feature.parentId || featureKeys.has(`${feature.repoId}\0${feature.parentId}`),
      `feature ${feature.repoId}/${feature.id} has missing parent ${feature.parentId}`);
  }
  for (const spec of specs) {
    assertion(!spec.featureId || featureKeys.has(`${spec.repoId}\0${spec.featureId}`),
      `spec ${spec.repoId}/${spec.id} has missing feature ${spec.featureId}`);
  }
  for (const anchor of anchors) {
    assertion(!anchor.featureId || featureKeys.has(`${anchor.repoId}\0${anchor.featureId}`),
      `anchor ${anchor.id} has missing feature ${anchor.featureId}`);
    assertion(!anchor.specId || specKeys.has(`${anchor.repoId}\0${anchor.specId}`),
      `anchor ${anchor.id} has missing spec ${anchor.specId}`);
  }

  const insertFeatureIdentity = db.prepare(`INSERT INTO kb_features
    (repo_id, feature_id, created_at) VALUES (?, ?, ?)`);
  for (const feature of features) insertFeatureIdentity.run(feature.repoId, feature.id, feature.createdAt);

  const insertSpec = db.prepare(`INSERT INTO kb_specs
    (repo_id, spec_id, feature_id, state, current_revision, source_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 'canonical', ?, ?)`);
  const insertRevision = db.prepare(`INSERT INTO kb_spec_revisions
    (repo_id, spec_id, revision, type, summary, detail, priority, layer, domain, tags, producer, produced_at)
    VALUES (?, ?, 1, ?, ?, ?, NULL, NULL, NULL, '[]', 'migration-008', ?)`);
  const insertEvidence = db.prepare(`INSERT INTO kb_evidence
    (repo_id, evidence_id, spec_id, revision, source_type, source_ref, exact_quote,
     evidence_ref, content_hash, confidence, producer, produced_at)
    VALUES (?, ?, ?, 1, 'legacy_import', ?, NULL, ?, ?, NULL, 'migration-008', ?)`);
  for (const spec of specs) {
    insertSpec.run(spec.repoId, spec.id, spec.featureId, spec.state, spec.createdAt, spec.updatedAt);
    insertRevision.run(spec.repoId, spec.id, spec.type, spec.summary, spec.detail, spec.updatedAt);
    const evidenceRef = `legacy:specs:${spec.id}`;
    const contentHash = crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex");
    insertEvidence.run(spec.repoId, `legacy-spec:${spec.id}`, spec.id, evidenceRef, evidenceRef, contentHash, spec.updatedAt);
  }

  const canonicalLegacyPath = (file: string): string | null => {
    const slashed = file.replace(/\\/g, "/");
    if (path.posix.isAbsolute(slashed)) return null;
    const normalized = path.posix.normalize(slashed.replace(/^\.\//, ""));
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
    return normalized;
  };
  const validAnchors: typeof anchors = [];
  for (const anchor of anchors) {
    const file = canonicalLegacyPath(anchor.file);
    if (file) {
      validAnchors.push({ ...anchor, file });
      db.prepare(`INSERT INTO kb_import_audit
        (repo_id, legacy_table, legacy_row_id, legacy_type, action, imported_at)
        VALUES (?, 'anchors', ?, NULL, 'imported', ?)`).run(anchor.repoId, String(anchor.id), importedAt.get(anchor.repoId));
    } else {
      db.prepare(`INSERT INTO kb_import_quarantine
        (repo_id, legacy_table, legacy_row_id, legacy_from_id, legacy_to_id, legacy_type, reason, payload, quarantined_at)
        VALUES (?, 'anchors', ?, ?, ?, NULL, 'invalid_anchor_path', ?, ?)`)
        .run(anchor.repoId, String(anchor.id), anchor.featureId, anchor.specId, JSON.stringify(anchor), importedAt.get(anchor.repoId));
      db.prepare(`INSERT INTO kb_import_audit
        (repo_id, legacy_table, legacy_row_id, legacy_type, action, imported_at)
        VALUES (?, 'anchors', ?, NULL, 'quarantined_invalid_path', ?)`)
        .run(anchor.repoId, String(anchor.id), importedAt.get(anchor.repoId));
    }
  }

  const insertRevisionAnchor = db.prepare(`INSERT OR IGNORE INTO kb_spec_revision_anchors
    (repo_id, spec_id, revision, file, symbol) VALUES (?, ?, 1, ?, ?)`);
  const insertCurrentAnchor = db.prepare(`INSERT OR IGNORE INTO kb_spec_current_anchors
    (repo_id, spec_id, revision, file, symbol) VALUES (?, ?, 1, ?, ?)`);
  for (const anchor of validAnchors) {
    if (anchor.specId) {
      insertRevisionAnchor.run(anchor.repoId, anchor.specId, anchor.file, anchor.symbol ?? "");
      insertCurrentAnchor.run(anchor.repoId, anchor.specId, anchor.file, anchor.symbol ?? "");
    }
  }

  const recognized = new Set(["depends_on", "relates_to", "supersedes", "conflicts_with"]);
  const insertRelation = db.prepare(`INSERT OR IGNORE INTO kb_spec_relations
    (repo_id, from_spec_id, to_spec_id, type, rationale, created_at) VALUES (?, ?, ?, ?, NULL, ?)`);
  const insertAudit = db.prepare(`INSERT INTO kb_import_audit
    (repo_id, legacy_table, legacy_row_id, legacy_type, action, imported_at)
    VALUES (?, 'edges', ?, ?, ?, ?)`);
  const insertQuarantine = db.prepare(`INSERT INTO kb_import_quarantine
    (repo_id, legacy_table, legacy_row_id, legacy_from_id, legacy_to_id, legacy_type,
     reason, payload, quarantined_at) VALUES (?, 'edges', ?, ?, ?, ?, ?, ?, ?)`);
  const acceptedRelationKeys = new Set<string>();
  const supersedes = new Map<string, Set<string>>();
  const wouldCycle = (repoId: number, from: string, to: string): boolean => {
    const target = `${repoId}\0${from}`;
    const pending = [`${repoId}\0${to}`];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === target) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of supersedes.get(current) ?? []) pending.push(`${repoId}\0${next}`);
    }
    return false;
  };
  for (const edge of edges) {
    const bothSpecs = specKeys.has(`${edge.repoId}\0${edge.fromId}`) && specKeys.has(`${edge.repoId}\0${edge.toId}`);
    if (recognized.has(edge.type) && bothSpecs && edge.fromId !== edge.toId) {
      const from = edge.type === "supersedes" ? edge.toId : edge.fromId;
      const to = edge.type === "supersedes" ? edge.fromId : edge.toId;
      if (edge.type === "supersedes" && wouldCycle(edge.repoId, from, to)) {
        insertQuarantine.run(edge.repoId, String(edge.id), edge.fromId, edge.toId, edge.type,
          "supersedes_cycle", JSON.stringify(edge), importedAt.get(edge.repoId));
        insertAudit.run(edge.repoId, String(edge.id), edge.type, "quarantined_cycle", importedAt.get(edge.repoId));
        continue;
      }
      insertRelation.run(edge.repoId, from, to, edge.type, importedAt.get(edge.repoId));
      acceptedRelationKeys.add(`${edge.repoId}\0${from}\0${to}\0${edge.type}`);
      if (edge.type === "supersedes") {
        const key = `${edge.repoId}\0${from}`;
        supersedes.set(key, new Set([...(supersedes.get(key) ?? []), to]));
      }
      insertAudit.run(edge.repoId, String(edge.id), edge.type,
        edge.type === "supersedes" ? "inverted_new_to_old" : "imported", importedAt.get(edge.repoId));
    } else {
      insertQuarantine.run(edge.repoId, String(edge.id), edge.fromId, edge.toId, edge.type,
        "unsupported_or_non_spec_relation", JSON.stringify(edge), importedAt.get(edge.repoId));
    }
  }

  for (const layout of rawLayouts) {
    const owners = [...new Set(features.filter((feature) => feature.id === layout.featureId).map((feature) => feature.repoId))];
    if (owners.length === 1) {
      layouts.push({ ...layout, repoId: owners[0]! });
      db.prepare(`INSERT INTO kb_import_audit
        (repo_id, legacy_table, legacy_row_id, legacy_type, action, imported_at)
        VALUES (?, 'feature_layouts', ?, NULL, 'imported', ?)`)
        .run(owners[0], layout.featureId, importedAt.get(owners[0]!));
    } else {
      const auditRepo = owners[0] ?? repos[0]?.id;
      if (auditRepo === undefined) throw new Error(`KB_V2_IMPORT_ASSERTION: layout ${layout.featureId} has no repository owner`);
      db.prepare(`INSERT INTO kb_import_quarantine
        (repo_id, legacy_table, legacy_row_id, legacy_from_id, legacy_to_id, legacy_type, reason, payload, quarantined_at)
        VALUES (?, 'feature_layouts', ?, ?, NULL, NULL, 'ambiguous_legacy_feature_id', ?, ?)`)
        .run(auditRepo, layout.featureId, layout.featureId, JSON.stringify({ ...layout, candidateRepoIds: owners }), importedAt.get(auditRepo));
      db.prepare(`INSERT INTO kb_import_audit
        (repo_id, legacy_table, legacy_row_id, legacy_type, action, imported_at)
        VALUES (?, 'feature_layouts', ?, NULL, 'quarantined_ambiguous_owner', ?)`)
        .run(auditRepo, layout.featureId, importedAt.get(auditRepo));
    }
  }

  const insertVersion = db.prepare(`INSERT INTO mapping_versions
    (repo_id, version_id, state, source_kind, checksum, created_at, finalized_at)
    VALUES (?, 'legacy-v7', 'building', 'legacy_import', '', ?, NULL)`);
  const insertVersionFeature = db.prepare(`INSERT INTO mapping_version_features
    (repo_id, version_id, feature_id, parent_feature_id, name, lifecycle)
    VALUES (?, 'legacy-v7', ?, ?, ?, 'active')`);
  const insertVersionAnchor = db.prepare(`INSERT OR IGNORE INTO mapping_version_anchors
    (repo_id, version_id, feature_id, file, symbol) VALUES (?, 'legacy-v7', ?, ?, ?)`);
  const insertVersionLayout = db.prepare(`INSERT INTO mapping_version_layouts
    (repo_id, version_id, feature_id, pct_left, pct_top, pct_width, pct_height, computed_at)
    VALUES (?, 'legacy-v7', ?, ?, ?, ?, ?, ?)`);
  for (const repo of repos) insertVersion.run(repo.id, repo.createdAt);
  // Parent rows must precede children because the composite self-FK is immediate.
  const remaining = [...features];
  const inserted = new Set<string>();
  while (remaining.length) {
    const ready = remaining.filter((row) => !row.parentId || inserted.has(`${row.repoId}\0${row.parentId}`));
    assertion(ready.length > 0, "feature hierarchy contains a cycle");
    for (const row of ready) {
      insertVersionFeature.run(row.repoId, row.id, row.parentId, row.name);
      inserted.add(`${row.repoId}\0${row.id}`);
      remaining.splice(remaining.indexOf(row), 1);
    }
  }
  for (const anchor of validAnchors) if (anchor.featureId) {
    insertVersionAnchor.run(anchor.repoId, anchor.featureId, anchor.file, anchor.symbol ?? "");
  }
  for (const layout of layouts) {
    insertVersionLayout.run(layout.repoId, layout.featureId, layout.pctLeft, layout.pctTop,
      layout.pctWidth, layout.pctHeight, layout.computedAt);
  }
  const finalize = db.prepare(`UPDATE mapping_versions SET state = 'finalized', checksum = ?, finalized_at = ?
    WHERE repo_id = ? AND version_id = 'legacy-v7'`);
  const activate = db.prepare(`INSERT INTO repo_active_mapping (repo_id, version_id, activated_at)
    VALUES (?, 'legacy-v7', ?)`);
  const history = db.prepare(`INSERT INTO mapping_activation_history
    (repo_id, seq, from_version_id, to_version_id, activated_at, reason)
    VALUES (?, 1, NULL, 'legacy-v7', ?, 'migration-008')`);
  for (const repo of repos) {
    const checksum = computeMappingChecksum(db, repo.id, "legacy-v7");
    finalize.run(checksum, repo.createdAt, repo.id);
    activate.run(repo.id, repo.createdAt);
    history.run(repo.id, repo.createdAt);
    assertion(computeMappingChecksum(db, repo.id, "legacy-v7") === checksum,
      `mapping checksum mismatch for repo ${repo.id}`);
  }

  const scalar = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  assertion(scalar(`SELECT COUNT(*) AS n FROM kb_features`) === features.length, "feature row count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM kb_specs`) === specs.length, "spec row count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM kb_spec_revisions`) === specs.length, "revision row count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM kb_evidence`) === specs.length, "evidence row count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM mapping_versions`) === repos.length, "mapping version count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM repo_active_mapping`) === repos.length, "active mapping count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM mapping_activation_history`) === repos.length,
    "activation history count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM mapping_version_features`) === features.length,
    "mapping feature row count mismatch");
  const distinct = <T>(rows: T[], key: (row: T) => string): number => new Set(rows.map(key)).size;
  assertion(scalar(`SELECT COUNT(*) AS n FROM mapping_version_anchors`) ===
    distinct(validAnchors.filter((row) => row.featureId), (row) =>
      `${row.repoId}\0${row.featureId}\0${row.file}\0${row.symbol ?? ""}`),
  "mapping anchor row count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM kb_spec_revision_anchors`) ===
    distinct(validAnchors.filter((row) => row.specId), (row) =>
      `${row.repoId}\0${row.specId}\0${row.file}\0${row.symbol ?? ""}`),
  "spec revision anchor row count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM kb_spec_current_anchors`) ===
    scalar(`SELECT COUNT(*) AS n FROM kb_spec_revision_anchors`), "current anchor projection mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM mapping_version_layouts`) === layouts.length,
    "mapping layout row count mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM kb_import_audit WHERE legacy_table = 'edges'
      AND action <> 'quarantined_cycle'`) +
    scalar(`SELECT COUNT(*) AS n FROM kb_import_quarantine WHERE legacy_table = 'edges'`) === edges.length,
  "edge import accounting mismatch");
  assertion(scalar(`SELECT COUNT(*) AS n FROM kb_spec_relations`) === acceptedRelationKeys.size,
    "canonical relation row count mismatch");
  const fk = db.prepare(`PRAGMA foreign_key_check`).all();
  assertion(fk.length === 0, `foreign_key_check returned ${fk.length} row(s)`);

  db.exec(`
    CREATE TRIGGER kb_spec_revisions_immutable_update BEFORE UPDATE ON kb_spec_revisions
      BEGIN SELECT RAISE(ABORT, 'kb_spec_revisions are immutable'); END;
    CREATE TRIGGER kb_spec_revisions_immutable_delete BEFORE DELETE ON kb_spec_revisions
      BEGIN SELECT RAISE(ABORT, 'kb_spec_revisions are immutable'); END;
    CREATE TRIGGER kb_evidence_immutable_update BEFORE UPDATE ON kb_evidence
      BEGIN SELECT RAISE(ABORT, 'kb_evidence is immutable'); END;
    CREATE TRIGGER kb_evidence_immutable_delete BEFORE DELETE ON kb_evidence
      BEGIN SELECT RAISE(ABORT, 'kb_evidence is immutable'); END;
    CREATE TRIGGER kb_specs_lifecycle_guard BEFORE UPDATE OF state ON kb_specs
      WHEN OLD.state <> NEW.state AND NOT (
        (OLD.state = 'draft' AND NEW.state IN ('active','deprecated')) OR
        (OLD.state = 'active' AND NEW.state IN ('stale','superseded','deprecated')) OR
        (OLD.state = 'stale' AND NEW.state IN ('superseded','deprecated'))
      )
      BEGIN SELECT RAISE(ABORT, 'invalid kb spec lifecycle transition'); END;
    CREATE TRIGGER kb_supersedes_cycle_guard BEFORE INSERT ON kb_spec_relations
      WHEN NEW.type = 'supersedes' AND EXISTS (
        WITH RECURSIVE successors(spec_id) AS (
          SELECT NEW.to_spec_id
          UNION
          SELECT r.to_spec_id FROM kb_spec_relations r JOIN successors s
            ON r.repo_id = NEW.repo_id AND r.type = 'supersedes' AND r.from_spec_id = s.spec_id
        ) SELECT 1 FROM successors WHERE spec_id = NEW.from_spec_id
      )
      BEGIN SELECT RAISE(ABORT, 'supersedes relation cycle'); END;
    CREATE TRIGGER active_mapping_requires_finalized_insert BEFORE INSERT ON repo_active_mapping
      WHEN NOT EXISTS (SELECT 1 FROM mapping_versions v WHERE v.repo_id = NEW.repo_id
        AND v.version_id = NEW.version_id AND v.state = 'finalized')
      BEGIN SELECT RAISE(ABORT, 'active mapping must be finalized'); END;
    CREATE TRIGGER active_mapping_requires_finalized_update BEFORE UPDATE OF version_id ON repo_active_mapping
      WHEN NOT EXISTS (SELECT 1 FROM mapping_versions v WHERE v.repo_id = NEW.repo_id
        AND v.version_id = NEW.version_id AND v.state = 'finalized')
      BEGIN SELECT RAISE(ABORT, 'active mapping must be finalized'); END;
    CREATE TRIGGER finalized_mapping_features_no_insert BEFORE INSERT ON mapping_version_features
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.repo_id = NEW.repo_id
        AND v.version_id = NEW.version_id AND v.state = 'finalized')
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_features_no_update BEFORE UPDATE ON mapping_version_features
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.state = 'finalized' AND
        ((v.repo_id = OLD.repo_id AND v.version_id = OLD.version_id) OR
         (v.repo_id = NEW.repo_id AND v.version_id = NEW.version_id)))
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_features_no_delete BEFORE DELETE ON mapping_version_features
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.repo_id = OLD.repo_id
        AND v.version_id = OLD.version_id AND v.state = 'finalized')
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_anchors_no_insert BEFORE INSERT ON mapping_version_anchors
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.repo_id = NEW.repo_id
        AND v.version_id = NEW.version_id AND v.state = 'finalized')
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_anchors_no_update BEFORE UPDATE ON mapping_version_anchors
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.state = 'finalized' AND
        ((v.repo_id = OLD.repo_id AND v.version_id = OLD.version_id) OR
         (v.repo_id = NEW.repo_id AND v.version_id = NEW.version_id)))
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_anchors_no_delete BEFORE DELETE ON mapping_version_anchors
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.repo_id = OLD.repo_id
        AND v.version_id = OLD.version_id AND v.state = 'finalized')
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_layouts_no_insert BEFORE INSERT ON mapping_version_layouts
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.repo_id = NEW.repo_id
        AND v.version_id = NEW.version_id AND v.state = 'finalized')
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_layouts_no_update BEFORE UPDATE ON mapping_version_layouts
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.state = 'finalized' AND
        ((v.repo_id = OLD.repo_id AND v.version_id = OLD.version_id) OR
         (v.repo_id = NEW.repo_id AND v.version_id = NEW.version_id)))
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_layouts_no_delete BEFORE DELETE ON mapping_version_layouts
      WHEN EXISTS (SELECT 1 FROM mapping_versions v WHERE v.repo_id = OLD.repo_id
        AND v.version_id = OLD.version_id AND v.state = 'finalized')
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_version_no_update BEFORE UPDATE ON mapping_versions
      WHEN OLD.state = 'finalized'
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
    CREATE TRIGGER finalized_mapping_version_no_delete BEFORE DELETE ON mapping_versions
      WHEN OLD.state = 'finalized'
      BEGIN SELECT RAISE(ABORT, 'finalized mapping is immutable'); END;
  `);
  for (const table of ["features", "specs", "anchors", "edges", "feature_layouts"] as const) {
    if (!hasTable(table)) continue;
    for (const verb of ["INSERT", "UPDATE", "DELETE"] as const) {
      db.exec(`CREATE TRIGGER legacy_${table}_${verb.toLowerCase()}_frozen
        BEFORE ${verb} ON ${table}
        BEGIN SELECT RAISE(ABORT, 'legacy graph is read-only'); END;`);
    }
  }
}
