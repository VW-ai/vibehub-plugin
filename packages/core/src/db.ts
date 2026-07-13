/**
 * SQLite door — WAL mode, ~/.vibehub by default (decision-project-016:
 * hooks are short-lived CLIs writing straight to SQLite; WAL lets the app
 * read while hooks write).
 *
 * SQLite is the source of truth (decision-project-014); one database holds
 * every repo, scoped by repos.id (decision-project-025: 同一 SQLite 按 repo
 * 分域). This slice ships the TEAM-VISIBILITY subset of the 运行域/配置域
 * tables; M1 slice ② adds the full three-domain schema on top via the same
 * migration ladder.
 */
import Database from "better-sqlite3";
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
  // 1:1 from the five contract files (workbench/packages/core/src/contract/).
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
];

export function openDb(dbPath: string = defaultDbPath()): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    const apply = db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    });
    apply();
  }
}
