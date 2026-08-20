import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach } from "node:test";
import { buildCodexMarketplace } from "../scripts/build-codex-marketplace.mjs";
import { buildClaudeMarketplace } from "../scripts/build-claude-marketplace.mjs";

const temporaryRoots = new Set();

afterEach(() => {
  for (const path of temporaryRoots) rmSync(path, { recursive: true, force: true });
  temporaryRoots.clear();
});

function temporaryRoot(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.add(path);
  return path;
}

function invoke(helper, repo, domain, operation, input) {
  const args = [helper, domain, operation, "--repo", repo];
  if (input !== undefined) {
    const inputPath = join(repo, `.input-${domain}-${operation}.json`);
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
    args.push("--input", inputPath);
  }
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  return { status: result.status, envelope: JSON.parse(result.stdout) };
}

function exerciseInstalledHelper(helper, label) {
  const current = temporaryRoot(`vibehub-${label}-current-`);
  assert.equal(invoke(helper, current, "project", "init").status, 0);
  const currentCompatibility = invoke(helper, current, "project", "compatibility");

  const migration = temporaryRoot(`vibehub-${label}-migration-`);
  mkdirSync(join(migration, ".vibehub", "rooms"), { recursive: true });
  const migrationCompatibility = invoke(helper, migration, "project", "compatibility");
  const refusedLegacyWrite = invoke(helper, migration, "ticket", "apply", { tickets: [] });

  const newer = temporaryRoot(`vibehub-${label}-newer-`);
  assert.equal(invoke(helper, newer, "project", "init").status, 0);
  writeFileSync(
    join(newer, ".vibehub", "version.yaml"),
    `${JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 3 })}\n`,
  );
  const newerCompatibility = invoke(helper, newer, "project", "compatibility");
  const refusedNewerWrite = invoke(helper, newer, "ticket", "apply", { tickets: [] });

  assert.equal(refusedLegacyWrite.envelope.error.code, "format_mismatch");
  assert.equal(refusedNewerWrite.envelope.error.code, "format_mismatch");
  return {
    current: currentCompatibility.envelope.data.state,
    migration: migrationCompatibility.envelope.data.state,
    migrationDetected: migrationCompatibility.envelope.data.detected_format,
    newer: newerCompatibility.envelope.data.state,
  };
}

test("Codex and Claude Code marketplace artifacts expose identical format behavior", () => {
  const output = temporaryRoot("vibehub-host-marketplaces-");
  const codex = buildCodexMarketplace({ outputRoot: join(output, "codex"), offline: true });
  const claude = buildClaudeMarketplace({ outputRoot: join(output, "claude"), offline: true });

  for (const pluginRoot of [codex.pluginRoot, claude.pluginRoot]) {
    assert.ok(existsSync(join(pluginRoot, "skills", "contracts", "project-format.schema.json")));
    assert.ok(existsSync(join(pluginRoot, "skills", "contracts", "acceptance-authority.md")));
    assert.ok(existsSync(join(pluginRoot, "skills", "vibehub-migrate", "references", "migrations.json")));
  }
  const codexVersion = JSON.parse(
    readFileSync(join(codex.pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  ).version;
  const claudeVersion = JSON.parse(
    readFileSync(join(claude.pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
  ).version;
  assert.equal(codexVersion, claudeVersion);
  const skillNames = (pluginRoot) => readdirSync(join(pluginRoot, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("vibehub-"))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(skillNames(codex.pluginRoot), skillNames(claude.pluginRoot));
  for (const relativePath of [
    join("skills", "contracts", "project-format.schema.json"),
    join("skills", "contracts", "acceptance-authority.md"),
    join("skills", "vibehub-migrate", "references", "migrations.json"),
  ]) {
    assert.equal(
      readFileSync(join(codex.pluginRoot, relativePath), "utf8"),
      readFileSync(join(claude.pluginRoot, relativePath), "utf8"),
    );
  }

  const codexBehavior = exerciseInstalledHelper(
    join(codex.pluginRoot, "skills", "scripts", "vh.mjs"),
    "codex",
  );
  const claudeBehavior = exerciseInstalledHelper(
    join(claude.pluginRoot, "skills", "scripts", "vh.mjs"),
    "claude",
  );
  assert.deepEqual(codexBehavior, {
    current: "CURRENT",
    migration: "MIGRATION_REQUIRED",
    migrationDetected: "0.5-unversioned",
    newer: "UNSUPPORTED_NEWER",
  });
  assert.deepEqual(claudeBehavior, codexBehavior);
});
