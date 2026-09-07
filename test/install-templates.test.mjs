import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import * as fsSync from "node:fs";
import { join } from "node:path";
import { root } from "./helpers.mjs";

const templates = join(root, "skills", "vibehub-core", "templates", "github");

test("GitHub mirror templates match their sources except for the import path and version header", () => {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const script = readFileSync(join(templates, "sync-github-issues.mjs"), "utf8").split("\n");
  assert.equal(script[0], "#!/usr/bin/env node");
  assert.match(script[1], new RegExp(`^// VibeHub template · plugin ${version.replace(/\./g, "\\.")} ·`));
  const source = readFileSync(join(root, "scripts", "sync-github-issues.mjs"), "utf8")
    .replace('"../skills/vibehub-core/scripts/vh.mjs"', '"./scripts/vh.mjs"').split("\n");
  assert.deepEqual([script[0], ...script.slice(2)], source);

  const workflow = readFileSync(join(templates, "sync-issues.yml"), "utf8");
  const sourceWorkflow = readFileSync(join(root, ".github", "workflows", "sync-issues.yml"), "utf8")
    .replace("node scripts/sync-github-issues.mjs", "node scripts/vibehub/sync-github-issues.mjs")
    .replace('- "scripts/sync-github-issues.mjs"', '- "scripts/vibehub/**"');
  assert.equal(workflow, sourceWorkflow);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+issues: write/);
  assert.doesNotMatch(workflow, /git (commit|push)/);
});

test("vibehub-core is a non-invocable carrier for helper, contracts, and templates", () => {
  const skill = readFileSync(join(root, "skills", "vibehub-core", "SKILL.md"), "utf8");
  assert.match(skill, /^name: vibehub-core$/m);
  assert.match(skill, /Nothing here is invoked directly/);
  for (const file of ["scripts/vh.mjs", "scripts/revision-contract.mjs", "scripts/vh-ui.mjs", "contracts/ticket.schema.json", "templates/github/sync-issues.yml", "templates/github/sync-github-issues.mjs"]) {
    assert.ok(existsSync(join(root, "skills", "vibehub-core", file)), `missing ${file}`);
  }
  assert.ok(!existsSync(join(root, "skills", "scripts")));
  assert.ok(!existsSync(join(root, "skills", "contracts")));
});

test("the six-file project copy runs from scripts/vibehub in a clean checkout", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const project = mkdtempSync(join(tmpdir(), "vibehub-mirror-copy-"));
  const core = join(root, "skills", "vibehub-core");
  mkdirSync(join(project, "scripts", "vibehub", "scripts"), { recursive: true });
  mkdirSync(join(project, "scripts", "vibehub", "contracts"), { recursive: true });
  mkdirSync(join(project, ".github", "workflows"), { recursive: true });
  copyFileSync(join(templates, "sync-issues.yml"), join(project, ".github", "workflows", "sync-issues.yml"));
  copyFileSync(join(templates, "sync-github-issues.mjs"), join(project, "scripts", "vibehub", "sync-github-issues.mjs"));
  copyFileSync(join(core, "scripts", "vh.mjs"), join(project, "scripts", "vibehub", "scripts", "vh.mjs"));
  copyFileSync(join(core, "scripts", "revision-contract.mjs"), join(project, "scripts", "vibehub", "scripts", "revision-contract.mjs"));
  copyFileSync(join(core, "contracts", "versions.json"), join(project, "scripts", "vibehub", "contracts", "versions.json"));
  copyFileSync(join(core, "contracts", "dependency-hygiene.json"), join(project, "scripts", "vibehub", "contracts", "dependency-hygiene.json"));
  // minimal valid project so the projection can be computed without any plugin installed
  for (const d of ["tickets", "outcomes", "evidence", "rooms"]) mkdirSync(join(project, ".vibehub", d), { recursive: true });
  writeFileSync(join(project, ".vibehub", "version.yaml"), JSON.stringify({ schema_version: 1, kind: "vibehub_project", format_version: 4 }));
  const { materializeInitialTicket } = await import(join(core, "scripts", "revision-contract.mjs"));
  writeFileSync(join(project, ".vibehub", "tickets", "ticket-demo.yaml"), JSON.stringify(materializeInitialTicket({
    schema_version: 3, kind: "ticket", ticket_id: "ticket-demo", maturity: "firm", outcome: "demo", deliveries: [], context: "c",
    acceptance: [{ acceptance_id: "a", criterion: "x" }], constraints: [], context_refs: [], relations: [], provenance_refs: ["conversation:demo"],
  })));
  const mod = await import(join(project, "scripts", "vibehub", "sync-github-issues.mjs"));
  const projection = mod.computeProjection(project, "acme/demo");
  assert.equal(projection.length, 1);
  assert.equal(projection[0].title, "Demo");
});

test("every VibeHub Skill tells an Agent how to repair a partial install", () => {
  const { readdirSync } = fsSync;
  for (const name of readdirSync(join(root, "skills"))) {
    if (name === "vibehub-core" || !name.startsWith("vibehub-")) continue;
    const skill = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, /npx skills add VW-ai\/vibehub-plugin -s vibehub-core/, `${name} lacks the partial-install repair line`);
  }
});
