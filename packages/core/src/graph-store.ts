/**
 * GraphStore — 图域 + 配置域 read/write (decision-project-011/014/025).
 * SQLite backend of the two-backend GraphStore idea (Postgres = the team
 * server variant behind the same semantics).
 *
 * Territory / SubBlock (contract map-types.ts) are both anchor clusters →
 * one `features` table with parent_id; anchoredFileCount is DERIVED
 * (count distinct anchor files), never stored.
 */
import type { SubBlock, Territory } from "./contract/map-types.js";
import type { Db } from "./db.js";

/* ── features (territories & sub-blocks) ────────────────────────────────── */

export function upsertFeature(
  db: Db,
  f: {
    id: string;
    repoId: number;
    parentId?: string;
    name: string;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO features (id, repo_id, parent_id, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       parent_id = excluded.parent_id, name = excluded.name,
       updated_at = excluded.updated_at`,
  ).run(f.id, f.repoId, f.parentId ?? null, f.name, f.now, f.now);
}

/**
 * The map's territories: top-level features with their sub-blocks and
 * DERIVED anchoredFileCount (a sub-block's anchors count toward both the
 * sub-block and its parent territory).
 */
export function listTerritories(db: Db, repoId: number): Territory[] {
  const features = db
    .prepare(
      `SELECT id, parent_id AS parentId, name FROM features
       WHERE repo_id = ? ORDER BY name`,
    )
    .all(repoId) as Array<{ id: string; parentId: string | null; name: string }>;
  const fileCount = db.prepare(
    `SELECT COUNT(DISTINCT file) AS n FROM anchors
     WHERE feature_id = ? OR feature_id IN
       (SELECT id FROM features WHERE parent_id = ?)`,
  );
  const count = (id: string): number => (fileCount.get(id, id) as { n: number }).n;

  const tops = features.filter((f) => f.parentId === null);
  return tops.map((t) => {
    const subBlocks: SubBlock[] = features
      .filter((f) => f.parentId === t.id)
      .map((s) => ({ id: s.id, name: s.name, anchoredFileCount: count(s.id) }));
    return { id: t.id, name: t.name, anchoredFileCount: count(t.id), subBlocks };
  });
}

/* ── anchors ────────────────────────────────────────────────────────────── */

export function addAnchor(
  db: Db,
  a: {
    repoId: number;
    featureId?: string;
    specId?: string;
    file: string;
    symbol?: string;
  },
): void {
  db.prepare(
    `INSERT INTO anchors (repo_id, feature_id, spec_id, file, symbol)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(a.repoId, a.featureId ?? null, a.specId ?? null, a.file, a.symbol ?? null);
}

/**
 * Attribute a file path to its feature(s) — the join that turns a raw
 * footprint into territory occupancy. [] = uncategorized (the honest gray).
 */
export function featuresForFile(
  db: Db,
  repoId: number,
  file: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT feature_id AS id FROM anchors
       WHERE repo_id = ? AND file = ? AND feature_id IS NOT NULL`,
    )
    .all(repoId, file) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/* ── specs & edges ──────────────────────────────────────────────────────── */

export interface SpecRow {
  id: string;
  repoId: number;
  featureId: string | null;
  type: "intent" | "decision" | "constraint" | "convention" | "contract" | "context" | "change";
  state: "draft" | "active" | "stale" | "superseded";
  summary: string;
  detail: string | null;
}

export function upsertSpec(db: Db, s: SpecRow, now: string): void {
  db.prepare(
    `INSERT INTO specs (id, repo_id, feature_id, type, state, summary, detail, created_at, updated_at)
     VALUES (@id, @repoId, @featureId, @type, @state, @summary, @detail, @now, @now)
     ON CONFLICT(id) DO UPDATE SET
       feature_id = excluded.feature_id, type = excluded.type,
       state = excluded.state, summary = excluded.summary,
       detail = excluded.detail, updated_at = excluded.updated_at`,
  ).run({ ...s, now } as unknown as Record<string, unknown>);
}

export function readSpec(db: Db, id: string): SpecRow | null {
  const r = db
    .prepare(
      `SELECT id, repo_id AS repoId, feature_id AS featureId, type, state, summary, detail
       FROM specs WHERE id = ?`,
    )
    .get(id) as SpecRow | undefined;
  return r ?? null;
}

export function addEdge(
  db: Db,
  repoId: number,
  fromId: string,
  toId: string,
  type: string,
): void {
  db.prepare(
    `INSERT INTO edges (repo_id, from_id, to_id, type) VALUES (?, ?, ?, ?)`,
  ).run(repoId, fromId, toId, type);
}

export function edgesFrom(
  db: Db,
  fromId: string,
): Array<{ toId: string; type: string }> {
  return db
    .prepare(`SELECT to_id AS toId, type FROM edges WHERE from_id = ?`)
    .all(fromId) as Array<{ toId: string; type: string }>;
}

/* ── settings (配置域; repoId 0 = global) ───────────────────────────────── */

export function setSetting(
  db: Db,
  key: string,
  value: string,
  repoId = 0,
): void {
  db.prepare(
    `INSERT INTO settings (repo_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(repo_id, key) DO UPDATE SET value = excluded.value`,
  ).run(repoId, key, value);
}

/** Repo-scoped value wins over the global one; null when neither is set. */
export function getSetting(db: Db, key: string, repoId = 0): string | null {
  const r = db
    .prepare(
      `SELECT value FROM settings WHERE key = ? AND repo_id IN (?, 0)
       ORDER BY repo_id DESC LIMIT 1`,
    )
    .get(key, repoId) as { value: string } | undefined;
  return r?.value ?? null;
}
