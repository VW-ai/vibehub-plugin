import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SCHEMA_VERSION, openDb, type Db } from "../src/db.js";
import { setSetting } from "../src/graph-store.js";
import { upsertRepo } from "../src/team-store.js";
import {
  CHECKPOINT_CADENCE_SETTING_KEY,
  DEFAULT_CHECKPOINT_CADENCE_TURNS,
  resolveCheckpointCadence,
} from "../src/knowledge-checkpoint.js";

const NOW = "2026-07-18T10:00:00.000Z";

describe("checkpoint cadence configuration (one central resolver)", () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-cadence-"));
    db = openDb(path.join(dir, "t.db"));
    upsertRepo(db, "/repo-a", null, "main", NOW);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("defaults, then the global override, then the per-repo override wins", () => {
    expect(resolveCheckpointCadence(db, 1)).toBe(DEFAULT_CHECKPOINT_CADENCE_TURNS);
    setSetting(db, CHECKPOINT_CADENCE_SETTING_KEY, "5");
    expect(resolveCheckpointCadence(db, 1)).toBe(5);
    setSetting(db, CHECKPOINT_CADENCE_SETTING_KEY, "3", 1);
    expect(resolveCheckpointCadence(db, 1)).toBe(3);
    expect(resolveCheckpointCadence(db, 2)).toBe(5);
  });

  it("accepts only explicit positive decimal integers (whitespace tolerated)", () => {
    for (const [value, expected] of [["10", 10], [" 5 ", 5], ["1", 1]] as const) {
      setSetting(db, CHECKPOINT_CADENCE_SETTING_KEY, value);
      expect(resolveCheckpointCadence(db, 1)).toBe(expected);
    }
  });

  it("rejects invalid overrides back to the default (no zero, fractions, or Number() leniency)", () => {
    for (const bad of ["0", "-3", "abc", "2.5", "", "1e3", "0x10", "+5", "9007199254740993"]) {
      setSetting(db, CHECKPOINT_CADENCE_SETTING_KEY, bad);
      expect(resolveCheckpointCadence(db, 1)).toBe(DEFAULT_CHECKPOINT_CADENCE_TURNS);
    }
  });

  it("migration 015 ships empty cadence tables and the provenance task index", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name IN ('task_prompt_cadence','task_prompt_seen') ORDER BY name`,
    ).all()).toEqual([{ name: "task_prompt_cadence" }, { name: "task_prompt_seen" }]);
    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_kb_provenance_task'`,
    ).get()).toEqual({ name: "idx_kb_provenance_task" });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM task_prompt_cadence`).get()).toEqual({ n: 0 });
    expect(db.prepare(`SELECT COUNT(*) AS n FROM task_prompt_seen`).get()).toEqual({ n: 0 });
  });
});
