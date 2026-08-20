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
    "docs/assets/local-graph/quiet-workbench-desktop-2x.png",
    "docs/assets/local-graph/workbench-ticket-action-2x.png",
    "docs/assets/local-graph/workbench-rooms-narrow-2x.png",
    "docs/assets/local-graph/readme-capture-manifest.json",
    "docs/CONCEPT.md",
    "docs/INSTALL.md",
    "docs/RELEASE.md",
    "skills/vibehub-ingest/SKILL.md",
    "skills/vibehub-ticket-run/SKILL.md",
    "skills/scripts/vh.mjs",
    "skills/scripts/vh-ui.mjs",
    "skills/vibehub-ticket-review/assets/index.html",
    "skills/vibehub-ticket-review/assets/app.css",
    "skills/vibehub-ticket-review/assets/app-layout.js",
    "skills/vibehub-ticket-review/assets/app.js",
    "skills/vibehub-ticket-review/assets/vibehub-mark.svg",
    "skills/vibehub-ticket-review/references/ticket-lifecycle.json",
    "skills/vibehub-setup/references/architecture-boundary.md",
    "skills/vibehub-ingest/references/knowledge-governance.json",
    "skills/vibehub-migrate/SKILL.md",
    "skills/vibehub-migrate/references/migrations.json",
    "skills/contracts/project-format.schema.json",
    "skills/contracts/context.schema.json",
    "skills/contracts/ticket.schema.json",
    "skills/contracts/evidence.schema.json",
    "skills/contracts/acceptance-authority.md",
    "skills/contracts/dependency-hygiene.json",
    "skills/contracts/ticket-next-action.md",
  ]) {
    if (!existsSync(join(artifact, required))) throw new Error(`artifact missing ${required}`);
  }
  const installedReadme = readFileSync(join(artifact, "README.md"), "utf8");
  for (const narrative of [
    "Stop managing chats. Manage the work.",
    "Turn one coding request into a Git-native Ticket with the exact Context needed",
    "work produces acceptance-linked Evidence; a separate Agent decides the Outcome; accepted learning returns to Context",
    "Git keeps the history reviewable and reversible",
  ]) {
    if (!installedReadme.includes(narrative)) {
      throw new Error(`installed README is missing public-site narrative: ${narrative}`);
    }
  }
  if ([...installedReadme.matchAll(/href="https:\/\/vibehub\.icu"/gu)].length !== 1
    || /https:\/\/www\.vibehub\.icu|https:\/\/[^"<\s]*\.pages\.dev/iu.test(installedReadme)) {
    throw new Error("installed README does not retain the one canonical vibehub.icu link");
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
    || lifecycle.resource_policy?.cross_task_discovery !== "forbidden"
    || lifecycle.planning_contracts?.dependency_hygiene !== "../../contracts/dependency-hygiene.json"
    || lifecycle.next_action_routing?.EXECUTE?.owner !== "vibehub-ticket-run"
    || lifecycle.next_action_routing?.CLOSE_OUT?.owner !== "vibehub-ticket-closeout"
    || lifecycle.next_action_routing?.CLOSE_OUT?.independent_agent !== true) {
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
      schema_version: 2,
      kind: "ticket",
      ticket_id: "ticket-build-entry-fixture",
      outcome: "The concrete entry fixture produces one executable checked-in Ticket.",
      deliveries: [],
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
  invoke(helper, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "entry-human-proof",
    ticket_id: "ticket-build-entry-fixture",
    acceptance_ids: ["entry-reaches-ready-ticket"],
    summary: "The human explicitly confirmed the clean entry fixture.",
    refs: ["conversation:artifact-verification-human-input"],
    origin: "human",
    recorded_at: "2026-08-09T08:00:00.000Z",
  });
  const closeoutFrontier = invoke(helper, "ticket", "frontier");
  if (closeoutFrontier.data.count !== 0
    || closeoutFrontier.data.ready_to_closeout[0]?.ticket?.ticket_id
      !== "ticket-build-entry-fixture") {
    throw new Error("installed next-action projection did not route complete Evidence to closeout");
  }
  invoke(helper, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "ticket-build-entry-fixture",
    status: "successful",
    accepted_acceptance_ids: ["entry-reaches-ready-ticket"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["entry-human-proof"],
    summary: "The installed artifact completed the executable entry Ticket.",
    closed_at: "2026-08-09T08:01:00.000Z",
  });
  invoke(helper, "ticket", "apply", {
    tickets: [{
      schema_version: 2,
      kind: "ticket",
      ticket_id: "ticket-human-authority-fixture",
      outcome: "The installed projection preserves criterion-level human authority.",
      deliveries: [],
      context: "Exercise human Evidence and attention independently of executable entry routing.",
      acceptance: [{
        acceptance_id: "owner-confirms-authority",
        criterion: "The owner explicitly confirms the protected fixture.",
        authority: "human",
      }],
      constraints: ["Agent Evidence cannot substitute for the owner."],
      context_refs: [],
      relations: [],
      provenance_refs: ["test:installed-human-authority"],
    }],
  });
  invoke(helper, "ticket", "evidence", {
    schema_version: 1,
    kind: "ticket_evidence",
    evidence_id: "installed-human-authority-proof",
    ticket_id: "ticket-human-authority-fixture",
    acceptance_ids: ["owner-confirms-authority"],
    summary: "The human explicitly confirmed the protected fixture.",
    refs: ["conversation:artifact-verification-human-authority"],
    origin: "human",
    recorded_at: "2026-08-09T08:02:00.000Z",
  });
  invoke(helper, "ticket", "closeout", {
    schema_version: 1,
    kind: "ticket_outcome",
    ticket_id: "ticket-human-authority-fixture",
    status: "successful",
    accepted_acceptance_ids: ["owner-confirms-authority"],
    unresolved_acceptance_ids: [],
    evidence_ids: ["installed-human-authority-proof"],
    summary: "The installed artifact preserved the protected human boundary.",
    closed_at: "2026-08-09T08:03:00.000Z",
  });

  const installedScript = readFileSync(
    join(artifact, "skills", "vibehub-ticket-review", "assets", "app.js"),
    "utf8",
  );
  const installedModel = readFileSync(
    join(artifact, "skills", "vibehub-ticket-review", "assets", "app-model.js"),
    "utf8",
  );
  const installedLayout = readFileSync(
    join(artifact, "skills", "vibehub-ticket-review", "assets", "app-layout.js"),
    "utf8",
  );
  const installedHost = readFileSync(
    join(artifact, "skills", "scripts", "vh-ui.mjs"),
    "utf8",
  );
  const installedHtml = readFileSync(
    join(artifact, "skills", "vibehub-ticket-review", "assets", "index.html"),
    "utf8",
  );
  const installedFavicon = readFileSync(join(
    artifact,
    "skills",
    "vibehub-ticket-review",
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
  if (/id="closeoutQueue"/u.test(installedHtml)
    || /function renderCloseoutQueue/u.test(installedScript)
    || !/eyebrow\.textContent = "Recommended action"/u.test(installedScript)
    || !/label: "Copy prompt"/u.test(installedScript)
    || !/if \(contextPackage\.agentPayload\) return canonical;/u.test(installedScript)
    || !/action === "CLOSE_OUT" \|\| runtimeEligible/u.test(installedModel)
    || !/No trusted runtime source is connected/u.test(installedHost)
    || !/requiresIndependentAgent: true/u.test(installedHost)
    || !/reviewInputs/u.test(installedHost)
    || !/evidenceRefs/u.test(installedHost)) {
    throw new Error("installed local UI is missing the bounded independent-closeout handoff");
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
    (ticket) => ticket.ticketId === "ticket-human-authority-fixture",
  );
  if (installedTicket.capabilities.attention.summary.label !== "COMPLETE"
    || allState.data.interventions.authority.status !== "available") {
    throw new Error("installed UI human-attention projection failed");
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
