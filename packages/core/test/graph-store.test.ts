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
    expect(db.pragma("user_version", { simple: true })).toBe(2);
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
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    // v1 data survived
    expect((db.prepare("SELECT slug FROM repos").get() as { slug: string }).slug).toBe("o/n");
    // v2 tables exist
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
    db.close();
  });
});
