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
    "assets/brand/vibehub-logo-dark.svg",
    "assets/brand/vibehub-logo.svg",
    "CHANGELOG.md",
    "docs/assets/local-graph/quiet-workbench-desktop.jpg",
    "docs/assets/local-graph/quiet-workbench-desktop-2x.png",
    "docs/assets/local-graph/workbench-ticket-action-2x.png",
    "docs/assets/local-graph/workbench-rooms-narrow-2x.png",
    "docs/assets/local-graph/readme-capture-manifest.json",
    "docs/CONCEPT.md",
    "docs/INSTALL.md",
    "docs/RELEASE.md",
    "skills/vibehub-ingest/SKILL.md",
    "skills/vibehub-ticket/SKILL.md",
    "skills/vibehub-core/scripts/vh.mjs",
    "skills/vibehub-core/scripts/session-store.mjs",
    "skills/vibehub-core/scripts/vh-session.mjs",
    "skills/vibehub-core/contracts/agent-session.schema.json",
    "skills/vibehub-core/contracts/agent-session.md",
    "skills/vibehub-core/scripts/revision-contract.mjs",
    "skills/vibehub-core/scripts/vh-ui.mjs",
    "skills/vibehub-core/scripts/vh-start.mjs",
    "skills/vibehub-core/contracts/session-entry.md",
    "skills/vibehub-review/assets/index.html",
    "skills/vibehub-review/assets/app.css",
    "skills/vibehub-review/assets/app-layout.js",
    "skills/vibehub-review/assets/app.js",
    "skills/vibehub-review/assets/vibehub-mark.svg",
    "skills/vibehub-review/references/ticket-lifecycle.json",
    "skills/vibehub-setup/references/architecture-boundary.md",
    "skills/vibehub-ingest/references/knowledge-governance.json",
    "skills/vibehub-migrate/SKILL.md",
    "skills/vibehub-migrate/references/migrations.json",
    "skills/vibehub-core/contracts/project-format.schema.json",
    "skills/vibehub-core/contracts/context.schema.json",
    "skills/vibehub-core/contracts/goal.schema.json",
    "skills/vibehub-core/contracts/epic.schema.json",
    "skills/vibehub-core/contracts/planning-hierarchy.md",
    "skills/vibehub-core/contracts/ticket.schema.json",
    "skills/vibehub-core/contracts/evidence.schema.json",
    "skills/vibehub-core/contracts/outcome.schema.json",
    "skills/vibehub-core/contracts/revision-identity.md",
    "skills/vibehub-core/contracts/acceptance-authority.md",
    "skills/vibehub-core/contracts/dependency-hygiene.json",
    "skills/vibehub-core/contracts/ticket-state.md",
  ]) {
    if (!existsSync(join(artifact, required))) throw new Error(`artifact missing ${required}`);
  }
  const installedReadme = readFileSync(join(artifact, "README.md"), "utf8");
  if ([...installedReadme.matchAll(/href="https:\/\/vibehub\.team"/gu)].length !== 1
    || /https:\/\/www\.vibehub\.team|https:\/\/[^"<\s]*\.pages\.dev/iu.test(installedReadme)) {
    throw new Error("installed README does not retain the one canonical vibehub.team link");
  }
  const readmeImageRefs = new Set([
    ...[...installedReadme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/gu)]
      .map((match) => match[1]),
    ...[...installedReadme.matchAll(/\b(?:src|srcset)="([^"]+)"/gu)]
      .flatMap((match) => match[1].split(",").map((entry) => entry.trim().split(/\s+/u)[0])),
  ]);
  for (const ref of readmeImageRefs) {
    if (/^(?:https?:|data:|#)/u.test(ref)) continue;
    if (!existsSync(join(artifact, ref))) {
      throw new Error(`installed README image target is missing: ${ref}`);
    }
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
  const claudeManifest = JSON.parse(readFileSync(join(artifact, ".claude-plugin", "plugin.json"), "utf8"));
  if (claudeManifest.mcpServers || claudeManifest.hooks) throw new Error("plugin manifest still requires MCP or hooks");
  if (existsSync(join(artifact, ".claude-plugin", "marketplace.json"))) {
    throw new Error("artifact still ships a marketplace manifest");
  }
  const installedBoundary = readFileSync(join(
    artifact,
    "skills",
    "vibehub-setup",
    "references",
    "architecture-boundary.md",
  ), "utf8");
  if (!/One narrow exception is the explicitly invoked `vibehub-upgrade` one-shot/u.test(installedBoundary)
    || !/no general-purpose or globally installed CLI/u.test(installedBoundary)
    || !/never authorizes another\s+filesystem scan/u.test(installedBoundary)
    || !/must not add compatibility shims, telemetry, network reporting/u.test(installedBoundary)) {
    throw new Error("installed architecture boundary is missing the bounded one-shot upgrade exception");
  }
  const installedInstall = readFileSync(join(artifact, "docs", "INSTALL.md"), "utf8");
  if (!installedInstall.includes("tree/<release-tag>")
    || !installedInstall.includes("releases/download/<release-tag>/vibehub-upgrade.tgz")
    || !installedInstall.includes("Nothing is pushed")) {
    throw new Error("installed upgrade documentation is missing same-tag, explicit local-only behavior");
  }
  const lifecycle = JSON.parse(readFileSync(join(
    artifact, "skills", "vibehub-review", "references", "ticket-lifecycle.json",
  ), "utf8"));
  if (lifecycle.presenter !== "vibehub-review"
    || lifecycle.resource_policy?.cross_task_discovery !== "forbidden"
    || lifecycle.next_action_routing !== undefined) {
    throw new Error("installed Ticket contract must describe records without execution routing");
  }

  const helper = join(artifact, "skills", "vibehub-core", "scripts", "vh.mjs");
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
  const firstId = "ticket-build-entry-fixture";
  const secondId = "ticket-dependent-fixture";
  invoke(helper, "ticket", "put", {
    ticket_id: firstId,
    outcome: "A remembered task can use any personal development workflow.",
    context_refs: [{ ref: ".vibehub/rooms/product/decision-clean-install.yaml", purpose: "Project context" }],
  });
  invoke(helper, "ticket", "put", {
    ticket_id: secondId,
    outcome: "The follow-up retains its dependency on the first task.",
    relations: [{ type: "depends_on", target_ticket_id: firstId }],
  });
  const blocked = invoke(helper, "ticket", "get", { ticket_id: secondId }).data;
  if (blocked.status !== "BLOCKED" || "next_action" in blocked) {
    throw new Error("installed tasks must expose dependency facts without workflow routing");
  }
  const completion = {
    ticket_id: firstId, update_id: "completed",
    status: "done", summary: "Completed with the user's chosen Skills.",
    refs: ["scripts/verify-plugin-artifact.mjs"],
  };
  invoke(helper, "ticket", "update", completion);
  invoke(helper, "ticket", "update", completion);
  const done = invoke(helper, "ticket", "get", { ticket_id: firstId }).data;
  if (done.status !== "DONE" || done.ticket.updates.length !== 1 || done.evidence.length !== 0 || done.outcome) {
    throw new Error("installed task completion must be idempotent and need no proof workflow");
  }
  if (invoke(helper, "ticket", "get", { ticket_id: secondId }).data.status !== "OPEN") {
    throw new Error("installed task completion did not unblock the dependent");
  }
  invoke(helper, "ticket", "update", {
    ticket_id: firstId, update_id: "reopened", status: "open", summary: "A follow-up correction is needed.",
  });
  const reopened = invoke(helper, "ticket", "get", { ticket_id: firstId }).data;
  if (reopened.status !== "OPEN" || reopened.ticket.updates.length !== 2
    || invoke(helper, "ticket", "get", { ticket_id: secondId }).data.status !== "BLOCKED") {
    throw new Error("installed task reopen did not preserve history and restore dependency facts");
  }
  for (const ticket_id of [firstId, secondId]) {
    invoke(helper, "ticket", "update", {
      ticket_id, update_id: "finished", status: "done", summary: "The recorded task is complete.",
    });
  }

  const installedScript = readFileSync(
    join(artifact, "skills", "vibehub-review", "assets", "app.js"),
    "utf8",
  );
  const installedModel = readFileSync(
    join(artifact, "skills", "vibehub-review", "assets", "app-model.js"),
    "utf8",
  );
  const installedLayout = readFileSync(
    join(artifact, "skills", "vibehub-review", "assets", "app-layout.js"),
    "utf8",
  );
  const installedHost = readFileSync(
    join(artifact, "skills", "vibehub-core", "scripts", "vh-ui.mjs"),
    "utf8",
  );
  const installedHtml = readFileSync(
    join(artifact, "skills", "vibehub-review", "assets", "index.html"),
    "utf8",
  );
  const installedFavicon = readFileSync(join(
    artifact,
    "skills",
    "vibehub-review",
    "assets",
    "vibehub-mark.svg",
  ));
  const installedCanonicalMark = readFileSync(join(
    artifact,
    "assets",
    "brand",
    "vibehub-mark.svg",
  ));
  if (!installedFavicon.equals(installedCanonicalMark)
    || !/<link rel="icon" type="image\/svg\+xml" href="\/vibehub-mark\.svg">/u.test(installedHtml)) {
    throw new Error("installed local UI favicon is not the canonical VibeHub mark");
  }
  if (/\/api\/(?:review|decision)/u.test(installedScript)) {
    throw new Error("installed local UI still contains writable review routes");
  }
  if (!/history\.replaceState\(null, "", nextHref\)/u.test(installedScript)
    || !/Focused local link copied · valid while this host is running/u.test(installedScript)
    || !/function localFocusHref/u.test(installedModel)
    || !/function layoutDirectionHref/u.test(installedModel)
    || !/function minimizeCrossings/u.test(installedLayout)
    || !/function routeRelations/u.test(installedLayout)
    || !/function setLayoutDirection/u.test(installedScript)) {
    throw new Error("installed local UI does not preserve a focused authorized URL");
  }
  const uiModule = await import(pathToFileURL(
    join(artifact, "skills", "vibehub-core", "scripts", "vh-ui.mjs"),
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
  const faviconResponse = await fetch(`${origin}/vibehub-mark.svg`);
  const faviconBytes = Buffer.from(await faviconResponse.arrayBuffer());
  if (faviconResponse.status !== 200
    || faviconResponse.redirected
    || faviconResponse.headers.get("content-type") !== "image/svg+xml"
    || !faviconBytes.equals(installedCanonicalMark)) {
    throw new Error("installed UI did not serve the canonical SVG favicon exactly");
  }
  const stateResponse = await fetch(`${origin}/api/state`, {
    headers: { Authorization: `Bearer ${uiHost.token}` },
  });
  const state = await stateResponse.json();
  if (!state.ok || state.data.graph.tickets.length !== 0) {
    throw new Error("installed UI current graph did not hide unrelated DONE history");
  }
  const allStateResponse = await fetch(`${origin}/api/state?scope=all`, {
    headers: { Authorization: `Bearer ${uiHost.token}` },
  });
  const allState = await allStateResponse.json();
  if (!allState.ok || allState.data.graph.tickets.length !== 2) {
    throw new Error("installed UI all-history graph projection failed");
  }
  const installedTicket = allState.data.graph.tickets.find(
    (ticket) => ticket.ticketId === firstId,
  );
  if (installedTicket.status !== "done" || installedTicket.workState.state !== "DONE"
    || installedTicket.capabilities.nextAction !== undefined) {
    throw new Error("installed UI does not project recorded task status");
  }
  await uiHost.close();
  uiHost = undefined;

  const entryModule = await import(pathToFileURL(
    join(artifact, "skills", "vibehub-core", "scripts", "vh-start.mjs"),
  ).href);
  const opened = [];
  const entered = await entryModule.enterVibeHub({ repoRoot: repo, openUrl: (url) => opened.push(url) });
  uiHost = entered.handle;
  const reused = await entryModule.enterVibeHub({ repoRoot: repo, reuseUrl: entered.url, openUrl: (url) => opened.push(url) });
  if (entered.reused || !reused.reused || reused.handle || opened.length !== 1 || reused.url !== entered.url) {
    throw new Error("installed VibeHub entry failed automatic dashboard startup or live session reuse");
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
  if (uiHost) {
    try {
      await uiHost.close();
    } catch (error) {
      if (error?.code !== "ERR_SERVER_NOT_RUNNING") throw error;
    }
  }
  rmSync(temp, { recursive: true, force: true });
}
