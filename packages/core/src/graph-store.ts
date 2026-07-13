/**
 * GraphStore — 图域 + 配置域 read/write (decision-project-011/014/025).
 * SQLite backend of the two-backend GraphStore idea (Postgres = the team
 * server variant behind the same semantics).
 *
 * Territory / SubBlock (contract map-types.ts) are both anchor clusters →
 * one `features` table with parent_id; anchoredFileCount is DERIVED
 * (count distinct anchor files), never stored.
 */
import type { DemoLayout, SubBlock, Territory } from "./contract/map-types.js";
import type { Db } from "./db.js";
import { layoutTerritories, type LayoutOptions } from "./treemap.js";
import { canonicalRepoPath } from "./scope-registry.js";
import crypto from "node:crypto";

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

/* ── territory layout cache (treemap spike) ─────────────────────────────── */

/**
 * Compute the squarified layout for the repo's top-level territories
 * (weights = DERIVED anchoredFileCount) and cache it — the once-per-
 * distillation layout pass (handoff: 蒸馏时算一次缓存). Wholesale replace:
 * a new distillation invalidates every rect.
 */
export function computeAndCacheTerritoryLayout(
  db: Db,
  repoId: number,
  now: string,
  opts: LayoutOptions = {},
): Map<string, DemoLayout> {
  const terrs = listTerritories(db, repoId).filter((t) => t.anchoredFileCount > 0);
  const layout = layoutTerritories(
    terrs.map((t) => ({ id: t.id, weight: t.anchoredFileCount })),
    opts,
  );
  const tx = db.transaction(() => {
    db.prepare(
      `DELETE FROM feature_layouts WHERE feature_id IN
         (SELECT id FROM features WHERE repo_id = ?)`,
    ).run(repoId);
    const ins = db.prepare(
      `INSERT INTO feature_layouts (feature_id, pct_left, pct_top, pct_width, pct_height, computed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [id, r] of layout) {
      ins.run(id, r.left, r.top, r.width, r.height, now);
    }
  });
  tx();
  return layout;
}

/** The cached layout; empty map = never computed (caller decides fallback). */
export function readTerritoryLayouts(
  db: Db,
  repoId: number,
): Map<string, DemoLayout> {
  const rows = db
    .prepare(
      `SELECT fl.feature_id AS id, fl.pct_left AS left, fl.pct_top AS top,
              fl.pct_width AS width, fl.pct_height AS height
       FROM feature_layouts fl
       JOIN features f ON f.id = fl.feature_id
       WHERE f.repo_id = ?`,
    )
    .all(repoId) as Array<{ id: string } & DemoLayout>;
  return new Map(rows.map((r) => [r.id, { left: r.left, top: r.top, width: r.width, height: r.height }]));
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

/** Distinct anchored files repo-wide — the gray territory's complement. */
export function countAnchoredFiles(db: Db, repoId: number): number {
  const r = db
    .prepare(`SELECT COUNT(DISTINCT file) AS n FROM anchors WHERE repo_id = ?`)
    .get(repoId) as { n: number };
  return r.n;
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

export type SpecType = SpecRow["type"];

export interface RecordSpecInput {
  type: SpecType;
  summary: string;
  detail: string | null;
  featureId?: string;
  supersedes?: string;
}

/** Deterministic write door used by kb_record; semantic decomposition stays in skills. */
export function recordSpec(
  db: Db,
  repoId: number,
  input: RecordSpecInput,
  now: string,
  makeId: () => string = () => `${input.type}-${crypto.randomUUID()}`,
): { spec: SpecRow; duplicateCandidates: SpecRow[] } {
  const duplicateCandidates = db
    .prepare(
      `SELECT id, repo_id AS repoId, feature_id AS featureId, type, state, summary, detail
       FROM specs WHERE repo_id = ? AND lower(trim(summary)) = lower(trim(?))`,
    )
    .all(repoId, input.summary) as SpecRow[];
  if (input.featureId) {
    const feature = db
      .prepare(`SELECT 1 FROM features WHERE repo_id = ? AND id = ?`)
      .get(repoId, input.featureId);
    if (!feature) throw new Error(`missing feature: ${input.featureId}`);
  }
  const superseded = input.supersedes ? readSpec(db, input.supersedes) : null;
  if (input.supersedes && (!superseded || superseded.repoId !== repoId)) {
    throw new Error(`missing superseded spec: ${input.supersedes}`);
  }
  const spec: SpecRow = {
    id: makeId(),
    repoId,
    featureId: input.featureId ?? null,
    type: input.type,
    state: "draft",
    summary: input.summary,
    detail: input.detail,
  };
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO specs (id, repo_id, feature_id, type, state, summary, detail, created_at, updated_at)
       VALUES (@id, @repoId, @featureId, @type, @state, @summary, @detail, @now, @now)`,
    ).run({ ...spec, now } as unknown as Record<string, unknown>);
    if (input.supersedes) {
      db.prepare(`UPDATE specs SET state = 'superseded', updated_at = ? WHERE id = ?`)
        .run(now, input.supersedes);
      addEdge(db, repoId, spec.id, input.supersedes, "supersedes");
    }
  });
  tx();
  return { spec, duplicateCandidates };
}

export function markSpecStale(db: Db, id: string, now: string): void {
  const result = db
    .prepare(`UPDATE specs SET state = 'stale', updated_at = ? WHERE id = ?`)
    .run(now, id);
  if (result.changes !== 1) throw new Error(`missing spec: ${id}`);
}

export interface KnowledgeResult {
  spec: SpecRow;
  matchedPaths: string[];
  score: number;
}

/** One deterministic retrieval pass; multi-pass query strategy belongs to vibehub-query. */
export function retrieveKnowledge(
  db: Db,
  repoId: number,
  input: { query?: string; paths?: string[]; limit?: number },
): KnowledgeResult[] {
  const terms = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const paths = (input.paths ?? []).map(canonicalRepoPath);
  const specs = db.prepare(
    `SELECT id, repo_id AS repoId, feature_id AS featureId, type, state, summary, detail
     FROM specs WHERE repo_id = ? AND state NOT IN ('stale','superseded')`,
  ).all(repoId) as SpecRow[];
  const anchorsForSpec = db.prepare(
    `SELECT DISTINCT file FROM anchors
     WHERE repo_id = ? AND (spec_id = ? OR feature_id = ?)`,
  );
  return specs
    .map((spec): KnowledgeResult => {
      const anchored = (anchorsForSpec.all(repoId, spec.id, spec.featureId) as Array<{ file: string }>)
        .map((row) => row.file);
      const matchedPaths = paths.filter((p) => anchored.includes(p));
      const summary = spec.summary.toLowerCase();
      const detail = (spec.detail ?? "").toLowerCase();
      const topicScore = terms.reduce(
        (score, term) => score + (summary.includes(term) ? 10 : 0) + (detail.includes(term) ? 3 : 0),
        0,
      );
      return { spec, matchedPaths, score: matchedPaths.length * 100 + topicScore };
    })
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.spec.id.localeCompare(b.spec.id))
    .slice(0, input.limit ?? 8);
}

export interface DistillationManifest {
  features: Array<{ id: string; parentId?: string; name: string }>;
  anchors: Array<{ featureId: string; file: string; symbol?: string }>;
  relations: Array<{ fromId: string; toId: string; type: string }>;
}

/** Atomic mechanical apply for a manifest produced by vibehub-distill. */
export function applyDistillation(
  db: Db,
  repoId: number,
  manifest: DistillationManifest,
  now: string,
): void {
  const ids = new Set<string>();
  for (const feature of manifest.features) {
    if (ids.has(feature.id)) throw new Error(`duplicate feature id: ${feature.id}`);
    ids.add(feature.id);
  }
  const featureExists = (id: string): boolean =>
    ids.has(id) ||
    db.prepare(`SELECT 1 FROM features WHERE repo_id = ? AND id = ?`).get(repoId, id) !== undefined;
  const nodeExists = (id: string): boolean =>
    featureExists(id) ||
    db.prepare(`SELECT 1 FROM specs WHERE repo_id = ? AND id = ?`).get(repoId, id) !== undefined;

  for (const feature of manifest.features) {
    if (feature.parentId && !featureExists(feature.parentId)) {
      throw new Error(`missing parent feature: ${feature.parentId}`);
    }
  }
  const anchors = manifest.anchors.map((anchor) => {
    if (!featureExists(anchor.featureId)) {
      throw new Error(`missing feature for anchor: ${anchor.featureId}`);
    }
    return { ...anchor, file: canonicalRepoPath(anchor.file) };
  });
  for (const relation of manifest.relations) {
    if (!nodeExists(relation.fromId)) throw new Error(`missing relation node: ${relation.fromId}`);
    if (!nodeExists(relation.toId)) throw new Error(`missing relation node: ${relation.toId}`);
  }

  const tx = db.transaction(() => {
    for (const feature of manifest.features) {
      upsertFeature(db, { ...feature, repoId, now });
    }
    for (const anchor of anchors) addAnchor(db, { ...anchor, repoId });
    for (const relation of manifest.relations) {
      addEdge(db, repoId, relation.fromId, relation.toId, relation.type);
    }
    computeAndCacheTerritoryLayout(db, repoId, now);
  });
  tx();
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
