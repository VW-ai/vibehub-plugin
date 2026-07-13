import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { openDb, type Db } from "../src/db.js";
import { upsertRepo } from "../src/team-store.js";
import {
  addAnchor,
  addEdge,
  edgesFrom,
  featuresForFile,
  getSetting,
  listTerritories,
  readSpec,
  recordSpec,
  markSpecStale,
  applyDistillation,
  retrieveKnowledge,
  setSetting,
  upsertFeature,
  upsertSpec,
} from "../src/graph-store.js";

const T0 = "2026-07-12T10:00:00.000Z";

describe("GraphStore (图域 + 配置域)", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-graph-"));
    db = openDb(path.join(dir, "t.db"));
    upsertRepo(db, "/repo", null, "main", T0);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds territories with sub-blocks and DERIVED anchoredFileCount", () => {
    upsertFeature(db, { id: "orders", repoId: 1, name: "Payments & Orders", now: T0 });
    upsertFeature(db, { id: "orders/osm", repoId: 1, parentId: "orders", name: "Order state machine", now: T0 });
    upsertFeature(db, { id: "auth", repoId: 1, name: "Auth & Sessions", now: T0 });
    addAnchor(db, { repoId: 1, featureId: "orders", file: "src/orders/index.ts" });
    addAnchor(db, { repoId: 1, featureId: "orders/osm", file: "src/orders/osm.ts", symbol: "OrderStateMachine" });
    addAnchor(db, { repoId: 1, featureId: "orders/osm", file: "src/orders/osm.ts", symbol: "guards" }); // same file
    addAnchor(db, { repoId: 1, featureId: "auth", file: "src/auth/login.ts" });

    const terrs = listTerritories(db, 1);
    expect(terrs.map((t) => t.id)).toEqual(["auth", "orders"]);
    const orders = terrs.find((t) => t.id === "orders")!;
    // territory count includes its sub-blocks' files, distinct
    expect(orders.anchoredFileCount).toBe(2);
    expect(orders.subBlocks).toEqual([
      { id: "orders/osm", name: "Order state machine", anchoredFileCount: 1 },
    ]);
  });

  it("attributes files to features; unanchored file = [] (honest gray)", () => {
    upsertFeature(db, { id: "auth", repoId: 1, name: "Auth", now: T0 });
    addAnchor(db, { repoId: 1, featureId: "auth", file: "src/auth/login.ts" });
    expect(featuresForFile(db, 1, "src/auth/login.ts")).toEqual(["auth"]);
    expect(featuresForFile(db, 1, "src/unknown.ts")).toEqual([]);
  });

  it("round-trips specs and edges", () => {
    upsertFeature(db, { id: "auth", repoId: 1, name: "Auth", now: T0 });
    upsertSpec(db, {
      id: "decision-auth-001", repoId: 1, featureId: "auth",
      type: "decision", state: "draft",
      summary: "JWT in httpOnly cookies", detail: "…",
    }, T0);
    upsertSpec(db, {
      id: "decision-auth-001", repoId: 1, featureId: "auth",
      type: "decision", state: "active",
      summary: "JWT in httpOnly cookies", detail: "…",
    }, T0);
    expect(readSpec(db, "decision-auth-001")!.state).toBe("active");

    addEdge(db, 1, "decision-auth-001", "auth", "belongs_to");
    expect(edgesFrom(db, "decision-auth-001")).toEqual([
      { toId: "auth", type: "belongs_to" },
    ]);
  });

  it("rejects an invalid spec state at the schema level (no D — 026)", () => {
    expect(() =>
      upsertSpec(db, {
        id: "x", repoId: 1, featureId: null, type: "decision",
        state: "deleted" as never, summary: "nope", detail: null,
      }, T0),
    ).toThrow(/CHECK/);
  });

  it("records all seven spec types with server-generated ids", () => {
    const types = [
      "intent", "decision", "constraint", "convention",
      "contract", "context", "change",
    ] as const;
    for (const [i, type] of types.entries()) {
      const result = recordSpec(db, 1, {
        type, summary: `${type} fact`, detail: null,
      }, T0, () => `server-${i}`);
      expect(result.spec.id).toBe(`server-${i}`);
      expect(result.spec.type).toBe(type);
      expect(result.spec.state).toBe("draft");
    }
  });

  it("supersedes atomically and only marks stale without deleting", () => {
    const old = recordSpec(db, 1, {
      type: "decision", summary: "Use REST", detail: null,
    }, T0, () => "old").spec;
    const next = recordSpec(db, 1, {
      type: "decision", summary: "Use tRPC", detail: null, supersedes: old.id,
    }, T0, () => "next").spec;
    expect(readSpec(db, old.id)?.state).toBe("superseded");
    expect(edgesFrom(db, next.id)).toContainEqual({ toId: old.id, type: "supersedes" });

    markSpecStale(db, next.id, T0);
    expect(readSpec(db, next.id)?.state).toBe("stale");
    expect(db.prepare("SELECT COUNT(*) AS n FROM specs").get()).toEqual({ n: 2 });
  });

  it("applies a distillation manifest in one transaction and caches layout", () => {
    applyDistillation(db, 1, {
      features: [
        { id: "auth", name: "Auth" },
        { id: "auth/session", parentId: "auth", name: "Sessions" },
      ],
      anchors: [
        { featureId: "auth/session", file: "src/auth/session.ts", symbol: "Session" },
      ],
      relations: [
        { fromId: "auth/session", toId: "auth", type: "part_of" },
      ],
    }, T0);
    expect(featuresForFile(db, 1, "src/auth/session.ts")).toEqual(["auth/session"]);
    expect(edgesFrom(db, "auth/session")).toContainEqual({ toId: "auth", type: "part_of" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM feature_layouts").get() as { n: number }).n).toBe(1);
  });

  it("rolls back the whole distillation manifest on an invalid anchor", () => {
    expect(() => applyDistillation(db, 1, {
      features: [{ id: "auth", name: "Auth" }],
      anchors: [{ featureId: "missing", file: "src/auth.ts" }],
      relations: [],
    }, T0)).toThrow(/missing feature/);
    expect(listTerritories(db, 1)).toEqual([]);
  });

  it("retrieves path-bound context before topic-only matches deterministically", () => {
    upsertFeature(db, { id: "auth", repoId: 1, name: "Auth", now: T0 });
    const pathBound = recordSpec(db, 1, {
      type: "constraint", summary: "Tokens stay in cookies", detail: "Auth boundary",
      featureId: "auth",
    }, T0, () => "path-bound").spec;
    addAnchor(db, { repoId: 1, specId: pathBound.id, file: "src/auth/login.ts" });
    recordSpec(db, 1, {
      type: "context", summary: "Auth tokens research", detail: null,
    }, T0, () => "topic-only");

    const results = retrieveKnowledge(db, 1, {
      query: "auth tokens",
      paths: ["src/auth/login.ts"],
      limit: 8,
    });
    expect(results.map((r) => r.spec.id)).toEqual(["path-bound", "topic-only"]);
    expect(results[0]!.matchedPaths).toEqual(["src/auth/login.ts"]);
  });

  it("computes and caches the territory layout once (蒸馏时算一次)", async () => {
    const { computeAndCacheTerritoryLayout, readTerritoryLayouts } = await import(
      "../src/graph-store.js"
    );
    upsertFeature(db, { id: "auth", repoId: 1, name: "Auth", now: T0 });
    upsertFeature(db, { id: "orders", repoId: 1, name: "Orders", now: T0 });
    addAnchor(db, { repoId: 1, featureId: "auth", file: "a1.ts" });
    addAnchor(db, { repoId: 1, featureId: "auth", file: "a2.ts" });
    addAnchor(db, { repoId: 1, featureId: "orders", file: "o1.ts" });

    expect(readTerritoryLayouts(db, 1).size).toBe(0); // never computed

    const computed = computeAndCacheTerritoryLayout(db, 1, T0);
    const cached = readTerritoryLayouts(db, 1);
    expect(cached.size).toBe(2);
    expect(cached.get("auth")).toEqual(computed.get("auth"));
    // auth (2 files) gets ~2× orders' (1 file) area — approximate because
    // the cached rects carry the visual gutter inset (absolute per block)
    const a = cached.get("auth")!;
    const o = cached.get("orders")!;
    const ratio = (a.width * a.height) / (o.width * o.height);
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);

    // recompute replaces wholesale (new distillation invalidates old rects)
    upsertFeature(db, { id: "billing", repoId: 1, name: "Billing", now: T0 });
    addAnchor(db, { repoId: 1, featureId: "billing", file: "b1.ts" });
    computeAndCacheTerritoryLayout(db, 1, T0);
    expect(readTerritoryLayouts(db, 1).size).toBe(3);
  });

  it("settings: repo-scoped value shadows global", () => {
    setSetting(db, "fetch.interval", "60");
    expect(getSetting(db, "fetch.interval", 1)).toBe("60"); // falls back to global
    setSetting(db, "fetch.interval", "120", 1);
    expect(getSetting(db, "fetch.interval", 1)).toBe("120");
    expect(getSetting(db, "fetch.interval")).toBe("60"); // global untouched
    expect(getSetting(db, "missing")).toBeNull();
  });
});

describe("migration ladder", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-mig-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("fresh db lands on the latest user_version", () => {
    const db = openDb(path.join(dir, "t.db"));
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(db.prepare("SELECT COUNT(*) AS n FROM scope_patterns").get()).toEqual({ n: 0 });
    db.close();
  });

  it("a v1 database upgrades in place, keeping its data", () => {
    const p = path.join(dir, "old.db");
    // simulate an M1 ① database: only migration 001 applied, with data
    const raw = new Database(p);
    raw.exec(`
      CREATE TABLE repos (
        id INTEGER PRIMARY KEY, root_path TEXT NOT NULL UNIQUE, slug TEXT,
        default_branch TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sync_state (repo_id INTEGER PRIMARY KEY REFERENCES repos(id),
        last_fetch_at TEXT, last_fetch_ok INTEGER,
        gh_available INTEGER NOT NULL DEFAULT 0, repo_files INTEGER, last_synced_at TEXT);
      CREATE TABLE team_branches (repo_id INTEGER NOT NULL, name TEXT NOT NULL,
        head_sha TEXT NOT NULL, last_commit_at TEXT NOT NULL,
        last_author TEXT NOT NULL DEFAULT '', ahead INTEGER NOT NULL DEFAULT 0,
        behind INTEGER NOT NULL DEFAULT 0, merged INTEGER NOT NULL DEFAULT 0,
        pr_number INTEGER, pr_state TEXT, pr_title TEXT, PRIMARY KEY (repo_id, name));
      CREATE TABLE team_branch_files (repo_id INTEGER NOT NULL, branch TEXT NOT NULL,
        path TEXT NOT NULL, change_kind TEXT NOT NULL, PRIMARY KEY (repo_id, branch, path));
      CREATE TABLE team_conflicts (repo_id INTEGER NOT NULL, branch_a TEXT NOT NULL,
        branch_b TEXT NOT NULL, path TEXT NOT NULL, first_detected_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL, PRIMARY KEY (repo_id, branch_a, branch_b, path));
      INSERT INTO repos (root_path, slug, default_branch, created_at)
        VALUES ('/repo', 'o/n', 'main', '${T0}');
      PRAGMA user_version = 1;
    `);
    raw.close();

    const db = openDb(p);
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    // v1 data survived
    expect((db.prepare("SELECT slug FROM repos").get() as { slug: string }).slug).toBe("o/n");
    // v2 tables exist
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    db.close();
  });
});
