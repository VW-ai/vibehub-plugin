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

export function defaultDbPath(): string {
  return path.join(os.homedir(), ".vibehub", "workbench.db");
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
