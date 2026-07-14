import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  doctorRuntime,
  initializeRuntime,
  sha256,
  type ManagedAssetManifest,
} from "../src/index.js";
import { makeScratchRepo } from "./helpers.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const scratch = makeScratchRepo();
  roots.push(scratch.root);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-init-"));
  roots.push(state);
  const pluginRoot = path.join(state, "plugin");
  fs.mkdirSync(pluginRoot);
  const target = path.join(pluginRoot, "hooks.json");
  const content = "managed-v1\n";
  const manifest: ManagedAssetManifest = {
    schemaVersion: 1,
    releaseVersion: "1.0.0",
    assets: [{
      source: "builtin://hooks.json",
      target,
      content,
      checksum: sha256(content),
      version: "1.0.0",
      repairPolicy: "replace-managed",
    }],
  };
  return { scratch, state, pluginRoot, target, content, manifest, dbPath: path.join(state, "workbench.db") };
}

function debris(root: string): string[] {
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((name) => name.includes(".vibehub-") || name.endsWith(".tmp") || name.endsWith(".bak"));
}

describe("runtime initialization and doctor", () => {
  it("initializes and migrates SQLite, canonicalizes the repo, and is idempotent", () => {
    const x = setup();
    const first = initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    const second = initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });

    expect(first.ok).toBe(true);
    expect(first.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(first.managedAssets[0]?.status).toBe("installed");
    expect(second.repo.id).toBe(first.repo.id);
    expect(second.managedAssets[0]?.status).toBe("healthy");
  });

  it("repairs a changed file only after the state ledger proves VibeHub ownership", () => {
    const x = setup();
    initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    fs.writeFileSync(x.target, "corrupt\n");

    const repaired = initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    expect(repaired.managedAssets[0]?.status).toBe("repaired");
    expect(fs.readFileSync(x.target, "utf8")).toBe(x.content);
  });

  it("does not overwrite an unowned existing file and reports an explicit conflict", () => {
    const x = setup();
    fs.mkdirSync(path.dirname(x.target), { recursive: true });
    fs.writeFileSync(x.target, "user-owned\n");

    const result = initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    expect(result.ok).toBe(false);
    expect(result.conflicts[0]).toMatchObject({ target: x.target, status: "conflict" });
    expect(fs.readFileSync(x.target, "utf8")).toBe("user-owned\n");
  });

  it("preflights the whole manifest so a conflict prevents partial installation", () => {
    const x = setup();
    fs.mkdirSync(path.dirname(x.target), { recursive: true });
    fs.writeFileSync(x.target, "user-owned\n");
    const secondTarget = path.join(x.state, "plugin", "skills", "shared.md");
    const secondContent = "managed shared reference\n";
    x.manifest.assets.push({
      source: "builtin://skills/shared.md",
      target: secondTarget,
      content: secondContent,
      checksum: sha256(secondContent),
      version: "1.0.0",
      repairPolicy: "replace-managed",
    });

    const result = initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    expect(result.ok).toBe(false);
    expect(result.managedAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: x.target, status: "conflict" }),
      expect.objectContaining({ target: secondTarget, status: "missing" }),
    ]));
    expect(fs.existsSync(secondTarget)).toBe(false);
  });

  it("rejects symlink targets without following them or changing the external user file", () => {
    const x = setup();
    const external = path.join(x.state, "user-owned.txt");
    fs.writeFileSync(external, "do not touch\n");
    fs.symlinkSync(external, x.target);

    const result = initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    expect(result.ok).toBe(false);
    expect(result.conflicts[0]?.message).toMatch(/symlink/);
    expect(fs.readFileSync(external, "utf8")).toBe("do not touch\n");
    expect(fs.lstatSync(x.target).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(x.state, "managed-assets.json"))).toBe(false);
  });

  it("rejects a symlink ancestor and never writes through it", () => {
    const x = setup();
    const externalDir = path.join(x.state, "external-user-dir");
    fs.mkdirSync(externalDir);
    const linkedDir = path.join(x.pluginRoot, "linked");
    fs.symlinkSync(externalDir, linkedDir);
    const content = "must stay internal\n";
    x.manifest.assets = [{
      source: "builtin://linked/hooks.json",
      target: path.join(linkedDir, "hooks.json"),
      content,
      checksum: sha256(content),
      version: "1",
      repairPolicy: "replace-managed",
    }];

    const result = initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    expect(result.ok).toBe(false);
    expect(result.conflicts[0]?.message).toMatch(/symlink ancestor/);
    expect(fs.readdirSync(externalDir)).toEqual([]);
    expect(fs.existsSync(path.join(x.state, "managed-assets.json"))).toBe(false);
  });

  it("preflights every target type before any rename or ledger write", () => {
    const x = setup();
    const firstTarget = path.join(x.pluginRoot, "first.txt");
    const invalidTarget = path.join(x.pluginRoot, "invalid");
    fs.mkdirSync(invalidTarget);
    const first = "first\n";
    const invalid = "invalid\n";
    x.manifest.assets = [
      { source: "builtin://first", target: firstTarget, content: first, checksum: sha256(first), version: "1", repairPolicy: "replace-managed" },
      { source: "builtin://invalid", target: invalidTarget, content: invalid, checksum: sha256(invalid), version: "1", repairPolicy: "replace-managed" },
    ];

    const result = initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    expect(result.ok).toBe(false);
    expect(result.conflicts[0]?.message).toMatch(/not a regular file/);
    expect(fs.existsSync(firstTarget)).toBe(false);
    expect(fs.existsSync(path.join(x.state, "managed-assets.json"))).toBe(false);
  });

  it("rolls back a new multi-asset install when a fault follows the first committed rename", () => {
    const x = setup();
    const secondTarget = path.join(x.pluginRoot, "skills", "shared.md");
    const secondContent = "shared\n";
    x.manifest.assets.push({ source: "builtin://shared", target: secondTarget, content: secondContent, checksum: sha256(secondContent), version: "1", repairPolicy: "replace-managed" });
    expect(() => initializeRuntime({
      repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest,
      managedAssetFault: ({ phase, committedTargets }) => { if (phase === "after-target-rename" && committedTargets === 1) throw new Error("fault after first rename"); },
    })).toThrow(/fault after first rename/);
    expect(fs.existsSync(x.target)).toBe(false);
    expect(fs.existsSync(secondTarget)).toBe(false);
    expect(fs.existsSync(path.join(x.state, "managed-assets.json"))).toBe(false);
    expect(debris(x.state)).toEqual([]);
  });

  it("restores repaired targets and the exact prior ledger after a mid-commit fault", () => {
    const x = setup();
    const secondTarget = path.join(x.pluginRoot, "second.txt");
    const secondContent = "second-v1\n";
    x.manifest.assets.push({ source: "builtin://second", target: secondTarget, content: secondContent, checksum: sha256(secondContent), version: "1", repairPolicy: "replace-managed" });
    initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    const ledger = fs.readFileSync(path.join(x.state, "managed-assets.json"));
    fs.writeFileSync(x.target, "user-drift-one\n");
    fs.writeFileSync(secondTarget, "user-drift-two\n");
    expect(() => initializeRuntime({
      repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest,
      managedAssetFault: ({ phase, committedTargets, target }) => { if (String(phase) === "before-target-rename" && committedTargets === 1 && target === secondTarget) throw new Error("repair fault"); },
    })).toThrow(/repair fault/);
    expect(fs.readFileSync(x.target, "utf8")).toBe("user-drift-one\n");
    expect(fs.readFileSync(secondTarget, "utf8")).toBe("user-drift-two\n");
    expect(fs.readFileSync(path.join(x.state, "managed-assets.json"))).toEqual(ledger);
    expect(debris(x.state)).toEqual([]);
  });

  it("doctor is read-only, stable JSON-shaped, and unhealthy before init", () => {
    const x = setup();
    const before = doctorRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    expect(before).toMatchObject({
      schemaVersion: 1,
      healthy: false,
      db: { status: "missing", expectedSchemaVersion: CURRENT_SCHEMA_VERSION },
      nativeDependency: { status: "healthy", module: "better-sqlite3" },
      repo: { status: "uninitialized" },
      managedAssets: { status: "unhealthy" },
    });
    expect(fs.existsSync(x.dbPath)).toBe(false);

    initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    expect(doctorRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest }).healthy).toBe(true);
  });

  it("healthy doctor does not mutate the DB or create SQLite sidecars", () => {
    const x = setup();
    initializeRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });
    const beforeNames = fs.readdirSync(x.state).sort();
    const before = fs.statSync(x.dbPath);
    const beforeHash = sha256(fs.readFileSync(x.dbPath));

    const result = doctorRuntime({ repoPath: x.scratch.work, dbPath: x.dbPath, stateDir: x.state, allowedAssetRoot: x.pluginRoot, manifest: x.manifest });

    const after = fs.statSync(x.dbPath);
    expect(result.healthy).toBe(true);
    expect(fs.readdirSync(x.state).sort()).toEqual(beforeNames);
    expect(sha256(fs.readFileSync(x.dbPath))).toBe(beforeHash);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(beforeNames.some((name) => name.endsWith("-wal") || name.endsWith("-shm"))).toBe(false);
  });
});
