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
import { spawnSync } from "node:child_process";
import { buildPluginArtifact } from "./build-plugin-artifact.mjs";

const temp = mkdtempSync(join(tmpdir(), "vibehub-plugin-verify-"));
const artifact = join(temp, "plugin");
const repo = join(temp, "repo");

function invoke(helper, domain, operation, input) {
  let inputPath;
  if (input !== undefined) {
    inputPath = join(temp, `${domain}-${operation}-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(inputPath, `${JSON.stringify(input)}\n`);
  }
  const args = [helper, domain, operation, "--repo", repo];
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
    "skills/vibehub-ingest/SKILL.md",
    "skills/vibehub-ticket-run/SKILL.md",
    "skills/scripts/vh.mjs",
    "skills/contracts/context.schema.json",
    "skills/contracts/ticket.schema.json",
  ]) {
    if (!existsSync(join(artifact, required))) throw new Error(`artifact missing ${required}`);
  }
  for (const forbidden of [
    ".mcp.json",
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

  const helper = join(artifact, "skills", "scripts", "vh.mjs");
  mkdirSync(repo, { recursive: true });
  invoke(helper, "project", "init");
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
  });
  const query = invoke(helper, "context", "query", { query: "runtime service" });
  if (query.data.count !== 1) throw new Error("installed Context roundtrip failed");

  process.stdout.write(`${JSON.stringify({ ok: true, artifact: "skill-first", ...stats })}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
