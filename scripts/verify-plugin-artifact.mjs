#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { buildPluginArtifact } from "./build-plugin-artifact.mjs";

const temp = mkdtempSync(join(tmpdir(), "vibehub-plugin-verify-"));
const artifact = join(temp, "plugin");
const repo = join(temp, "repo");
let uiHost;

function invoke(helper, domain, operation, input, flags = []) {
  let inputPath;
  if (input !== undefined) {
    inputPath = join(temp, `${domain}-${operation}-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
  }
  const args = [helper, domain, operation, "--repo", repo, ...flags];
  if (inputPath) args.push("--input", inputPath);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stdout || result.stderr);
  return JSON.parse(result.stdout);
}

try {
  const stats = buildPluginArtifact({ artifactRoot: artifact });
  for (const required of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "assets/brand/vibehub-logo-dark.svg",
    "assets/brand/vibehub-logo.svg",
    "CHANGELOG.md",
    "docs/assets/local-graph/quiet-workbench-desktop.jpg",
    "docs/CONCEPT.md",
    "docs/INSTALL.md",
    "docs/RELEASE.md",
    "skills/vibehub-ingest/SKILL.md",
    "skills/vibehub-ticket-run/SKILL.md",
    "skills/scripts/vh.mjs",
    "skills/scripts/vh-ui.mjs",
    "skills/vibehub-ticket-review/assets/index.html",
    "skills/vibehub-ticket-review/assets/app.css",
    "skills/vibehub-ticket-review/assets/app.js",
    "skills/vibehub-ticket-review/references/ticket-lifecycle.json",
    "skills/vibehub-setup/references/architecture-boundary.md",
    "skills/vibehub-ingest/references/knowledge-governance.json",
    "skills/vibehub-migrate/SKILL.md",
    "skills/vibehub-migrate/references/migrations.json",
    "skills/contracts/project-format.schema.json",
    "skills/contracts/context.schema.json",
    "skills/contracts/ticket.schema.json",
  ]) {
    if (!existsSync(join(artifact, required))) throw new Error(`artifact missing ${required}`);
  }
  for (const forbidden of [
    ".mcp.json",
    "apps",
    "codex",
    "hooks",
    "runtime",
    "packages",
    "node_modules",
  ]) {
    if (existsSync(join(artifact, forbidden))) throw new Error(`artifact contains forbidden ${forbidden}`);
  }
  const codex = JSON.parse(readFileSync(join(artifact, ".codex-plugin", "plugin.json"), "utf8"));
  if (codex.mcpServers || codex.hooks) throw new Error("Codex manifest still requires MCP or hooks");
  if (JSON.stringify(codex.interface?.defaultPrompt) !== JSON.stringify(["Start this with VibeHub."])) {
    throw new Error("Codex manifest does not expose the one canonical VibeHub entry");
  }
  const installedPlanSkill = readFileSync(
    join(artifact, "skills", "vibehub-ticket-plan", "SKILL.md"),
    "utf8",
  );
  if (!installedPlanSkill.includes("Start this with VibeHub.")
    || !installedPlanSkill.includes("$vibehub-setup")
    || !installedPlanSkill.includes("then\n   resume this workflow")) {
    throw new Error("installed Ticket Plan does not route the canonical entry through Setup");
  }
  const lifecycle = JSON.parse(readFileSync(join(
    artifact,
    "skills",
    "vibehub-ticket-review",
    "references",
    "ticket-lifecycle.json",
  ), "utf8"));
  if (lifecycle.presenter !== "vibehub-ticket-review"
    || lifecycle.resource_policy?.cross_task_discovery !== "forbidden") {
    throw new Error("installed Ticket lifecycle contract is invalid");
  }

  const helper = join(artifact, "skills", "scripts", "vh.mjs");
  mkdirSync(repo, { recursive: true });
  invoke(helper, "project", "init");
  mkdirSync(join(repo, ".vibehub", "rooms", "product"), { recursive: true });
  writeFileSync(join(repo, ".vibehub", "rooms", "product", "room.yaml"), `${JSON.stringify({
    schema_version: 1,
    kind: "room",
    room_id: "product",
    description: "Product-wide decisions of the verification repo.",
    boundary: "Everything product-wide, nothing subsystem-specific.",
    anchors: [],
    stale: false,
  }, null, 2)}\n`);
  invoke(helper, "context", "put", {
    schema_version: 1,
    kind: "context",
    context_id: "decision-clean-install",
    type: "decision",
    state: "active",
    summary: "The installed plugin works without a runtime service",
    detail: "Skills read and write checked-in JSON-compatible YAML directly.",
    tags: ["install"],
    source: { ref: "verification", captured_at: "2026-07-31T22:00:00.000Z" },
    evidence: [{ ref: "scripts/verify-plugin-artifact.mjs", note: "Fresh-process artifact verification." }],
    relations: [],
  }, ["--room", "product"]);
  const query = invoke(helper, "context", "query", { query: "runtime service" });
  if (query.data.count !== 1) throw new Error("installed Context roundtrip failed");
  invoke(helper, "ticket", "apply", {
    tickets: [{
      schema_version: 1,
      kind: "ticket",
      ticket_id: "ticket-build-entry-fixture",
      outcome: "The concrete entry fixture produces one executable checked-in Ticket.",
      context: "A clean installed plugin received a concrete deliverable followed by the exact canonical entry Start this with VibeHub.",
      acceptance: [{
        acceptance_id: "entry-reaches-ready-ticket",
        criterion: "The initialized repository exposes this applied Ticket as READY.",
      }],
      constraints: ["Reuse Setup and Ticket Plan without a router or runtime service."],
      context_refs: [],
      relations: [],
      provenance_refs: ["prompt:Start-this-with-VibeHub"],
    }],
  });
  const frontier = invoke(helper, "ticket", "frontier");
  if (frontier.data.count !== 1
    || frontier.data.ready[0]?.ticket?.ticket_id !== "ticket-build-entry-fixture") {
    throw new Error("canonical entry scenario did not reach a READY Ticket");
  }

  const installedScript = readFileSync(
    join(artifact, "skills", "vibehub-ticket-review", "assets", "app.js"),
    "utf8",
  );
  if (/\/api\/(?:review|decision)/u.test(installedScript)) {
    throw new Error("installed local UI still contains writable review routes");
  }
  if (/history\.replaceState/u.test(installedScript)
    || !/copyText\(location\.href, "Authorized link copied"\)/u.test(installedScript)) {
    throw new Error("installed local UI does not preserve a portable authorized URL");
  }
  const uiModule = await import(pathToFileURL(
    join(artifact, "skills", "scripts", "vh-ui.mjs"),
  ).href);
  uiHost = uiModule.startVibeHubUi({
    repoRoot: repo,
    token: "artifact-verification-token",
    tokenLifetimeMs: 60_000,
  });
  const { origin } = await uiHost.ready;
  const health = await (await fetch(`${origin}/health`)).json();
  if (!health.ok || health.readOnly !== true) {
    throw new Error("installed UI health check failed");
  }
  const stateResponse = await fetch(`${origin}/api/state`, {
    headers: { Authorization: `Bearer ${uiHost.token}` },
  });
  const state = await stateResponse.json();
  if (!state.ok || state.data.graph.tickets.length !== 1) {
    throw new Error("installed UI graph projection failed");
  }
  await uiHost.close();
  uiHost = undefined;

  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact: "skill-first-with-local-ui",
    ui: "read-only-loopback",
    ...stats,
  })}\n`);
} finally {
  if (uiHost) await uiHost.close();
  rmSync(temp, { recursive: true, force: true });
}
