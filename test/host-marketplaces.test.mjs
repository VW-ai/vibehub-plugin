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
import { pathToFileURL } from "node:url";
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

  const baseTicket = {
    schema_version: 2,
    kind: "ticket",
    ticket_id: "completed-baseline",
    outcome: "The baseline is complete.",
    deliveries: [],
    context: "Cross-host dependency advice fixture.",
    acceptance: [{ acceptance_id: "works", criterion: "The baseline works." }],
    constraints: [],
    context_refs: [],
    relations: [],
    provenance_refs: ["test:host-marketplaces"],
  };
  assert.equal(invoke(helper, current, "ticket", "apply", { tickets: [baseTicket] }).status, 0);
  assert.equal(invoke(helper, current, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "baseline-proof",
    ticket_id: "completed-baseline",
    acceptance_ids: ["works"],
    summary: "The installed baseline passed.",
    refs: ["test:host-marketplaces"],
    recorded_at: "2026-08-20T00:00:00.000Z",
  }).status, 0);
  assert.equal(invoke(helper, current, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "completed-baseline",
    status: "successful",
    accepted_acceptance_ids: ["works"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["baseline-proof"],
    summary: "The installed baseline was independently accepted.",
    closed_at: "2026-08-20T00:01:00.000Z",
  }).status, 0);
  const consumer = {
    ...baseTicket,
    ticket_id: "candidate-consumer",
    outcome: "The candidate consumes the baseline.",
    relations: [{
      type: "depends_on",
      target_ticket_id: "completed-baseline",
      rationale: "Consumes the exact completed artifact.",
    }],
  };
  const advised = invoke(helper, current, "ticket", "apply", { tickets: [consumer] });
  assert.equal(advised.status, 0);
  assert.deepEqual(
    advised.envelope.data.advice.map(({ code, level, blocking, ticket_id, target_ticket_id }) => ({
      code, level, blocking, ticket_id, target_ticket_id,
    })),
    [{
      code: "completed-dependency-review",
      level: "advisory",
      blocking: false,
      ticket_id: "candidate-consumer",
      target_ticket_id: "completed-baseline",
    }],
  );

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
    dependencyAdvice: advised.envelope.data.advice[0].code,
  };
}

async function exerciseInstalledFavicon(pluginRoot, label) {
  const repo = temporaryRoot(`vibehub-${label}-favicon-`);
  const helper = join(pluginRoot, "skills", "scripts", "vh.mjs");
  assert.equal(invoke(helper, repo, "project", "init").status, 0);
  const faviconPath = join(
    pluginRoot,
    "skills",
    "vibehub-ticket-review",
    "assets",
    "vibehub-mark.svg",
  );
  const canonicalPath = join(pluginRoot, "assets", "brand", "vibehub-mark.svg");
  const html = readFileSync(join(
    pluginRoot,
    "skills",
    "vibehub-ticket-review",
    "assets",
    "index.html",
  ), "utf8");
  const faviconBytes = readFileSync(faviconPath);
  assert.deepEqual(faviconBytes, readFileSync(canonicalPath));
  assert.match(
    html,
    /<link rel="icon" type="image\/svg\+xml" href="\/vibehub-mark\.svg">/u,
  );
  const uiModule = await import(pathToFileURL(
    join(pluginRoot, "skills", "scripts", "vh-ui.mjs"),
  ).href);
  const host = uiModule.startVibeHubUi({
    repoRoot: repo,
    token: `${label}-favicon-token`,
    tokenLifetimeMs: 60_000,
  });
  try {
    const { origin } = await host.ready;
    const response = await fetch(`${origin}/vibehub-mark.svg`);
    assert.equal(response.status, 200);
    assert.equal(response.redirected, false);
    assert.equal(response.headers.get("content-type"), "image/svg+xml");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), faviconBytes);
    const head = await fetch(`${origin}/vibehub-mark.svg`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-type"), "image/svg+xml");
    const write = await fetch(`${origin}/vibehub-mark.svg`, { method: "POST" });
    assert.equal(write.status, 405);
    assert.equal((await write.json()).error.code, "read_only");
    return {
      bytes: faviconBytes.length,
      contentType: response.headers.get("content-type"),
      href: "/vibehub-mark.svg",
    };
  } finally {
    await host.close();
  }
}

test("Codex and Claude Code marketplace artifacts expose identical format behavior", async () => {
  const output = temporaryRoot("vibehub-host-marketplaces-");
  const codex = buildCodexMarketplace({ outputRoot: join(output, "codex"), offline: true });
  const claude = buildClaudeMarketplace({ outputRoot: join(output, "claude"), offline: true });

  for (const pluginRoot of [codex.pluginRoot, claude.pluginRoot]) {
    assert.ok(existsSync(join(pluginRoot, "skills", "contracts", "project-format.schema.json")));
    assert.ok(existsSync(join(pluginRoot, "skills", "contracts", "acceptance-authority.md")));
    assert.ok(existsSync(join(pluginRoot, "skills", "contracts", "dependency-hygiene.json")));
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
    join("skills", "contracts", "dependency-hygiene.json"),
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
    dependencyAdvice: "completed-dependency-review",
  });
  assert.deepEqual(claudeBehavior, codexBehavior);
  const codexFavicon = await exerciseInstalledFavicon(codex.pluginRoot, "codex");
  const claudeFavicon = await exerciseInstalledFavicon(claude.pluginRoot, "claude");
  assert.deepEqual(claudeFavicon, codexFavicon);
});
