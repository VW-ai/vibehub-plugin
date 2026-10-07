import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { root, run, tempRepo } from "./helpers.mjs";

const skillsRoot = join(root, "skills");
const skillNames = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("vibehub-"))
  .map((entry) => entry.name);
const bodies = new Map(skillNames.map((name) => [
  name, readFileSync(join(skillsRoot, name, "SKILL.md"), "utf8"),
]));

function invoke(repo, domain, operation, input) {
  const result = run(repo, domain, operation, input);
  assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope));
  return result.envelope.data;
}

test("shipped Skills have discoverable frontmatter and resolving resource links", () => {
  for (const [name, body] of bodies) {
    const frontmatter = body.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
    assert.ok(frontmatter, `${name} has no frontmatter`);
    assert.equal(frontmatter.match(/^name: (.+)$/mu)?.[1], name);
    assert.match(frontmatter, /^description: .+$/mu);
    const directory = join(skillsRoot, name);
    const resources = [
      ...[...body.matchAll(/`((?:\.\.\/|references\/|contracts\/|scripts\/|templates\/)[^`\s<>]+)`/gu)].map((match) => match[1]),
      ...[...body.matchAll(/\]\(((?:\.\.\/|references\/)[^)]+)\)/gu)].map((match) => match[1]),
    ];
    for (const resource of resources) {
      assert.equal(existsSync(resolve(directory, resource)), true, `${name} cannot resolve ${resource}`);
    }
    const metadataPath = join(directory, "agents", "openai.yaml");
    if (existsSync(metadataPath)) {
      assert.match(readFileSync(metadataPath, "utf8"), new RegExp(`\\$${name}\\b`, "u"));
    }
  }
});

test("every helper command cited by a Skill resolves to a real operation", () => {
  const repo = tempRepo("skill-command-surface");
  invoke(repo, "project", "init");
  const cited = new Set();
  for (const body of bodies.values()) {
    for (const match of body.matchAll(/vh\.mjs (\w[\w-]*) (\w[\w-]*)/gu)) {
      cited.add(`${match[1]} ${match[2]}`);
    }
  }
  for (const command of cited) {
    const [domain, operation] = command.split(" ");
    const envelope = run(repo, domain, operation).envelope;
    if (!envelope.ok) {
      assert.ok(!["unsupported_domain", "unsupported_operation", "invalid_argument"].includes(envelope.error.code), `${command}: ${JSON.stringify(envelope)}`);
    }
  }
});

test("the Ticket Skill's literal compact examples create and complete a task", () => {
  const repo = tempRepo("skill-ticket-examples");
  invoke(repo, "project", "init");
  const examples = [...bodies.get("vibehub-ticket").matchAll(/```json\n([\s\S]*?)\n```/gu)]
    .map((match) => JSON.parse(match[1]));
  const definition = examples.find((example) => example.outcome);
  const update = examples.find((example) => example.update_id);
  invoke(repo, "ticket", "put", definition);
  const created = invoke(repo, "ticket", "get", { ticket_id: definition.ticket_id });
  assert.equal(created.ticket.outcome, "Users can reset a forgotten password.");
  assert.equal(created.ticket.status, "open");
  assert.deepEqual(created.ticket.updates, []);
  invoke(repo, "ticket", "update", update);
  const completed = invoke(repo, "ticket", "get", { ticket_id: definition.ticket_id });
  assert.equal(completed.ticket.status, "done");
  assert.equal(completed.ticket.updates[0].summary, "The reset form is complete and the browser check passed.");
  assert.equal(completed.ticket_state.state, "DONE");
  invoke(repo, "ticket", "update", update);
  assert.equal(invoke(repo, "ticket", "get", { ticket_id: definition.ticket_id }).ticket.updates.length, 1);
});

test("the Ticket Skill's dependency example records a prerequisite without requiring a development workflow", () => {
  const repo = tempRepo("skill-ticket-dependency");
  invoke(repo, "project", "init");
  invoke(repo, "ticket", "put", { ticket_id: "account-store", outcome: "Account records persist." });
  const literal = bodies.get("vibehub-ticket").match(/`(\{"type":"depends_on"[^`]+\})`/u)?.[1];
  assert.ok(literal, "the dependency example is missing");
  const relation = JSON.parse(literal.replace("<ticket-id>", "account-store").replace("<required input>", "Stored accounts"));
  invoke(repo, "ticket", "put", { ticket_id: "password-reset", outcome: "Users reset passwords.", relations: [relation] });
  const task = invoke(repo, "ticket", "get", { ticket_id: "password-reset" });
  assert.deepEqual(task.blocking_ticket_ids, ["account-store"]);
  assert.equal(task.ticket_state.state, "BLOCKED");
  invoke(repo, "ticket", "update", { ticket_id: "password-reset", update_id: "started", summary: "Building the reset form.", status: "in_progress" });
  const started = invoke(repo, "ticket", "get", { ticket_id: "password-reset" });
  assert.equal(started.ticket_state.state, "IN_PROGRESS");
  assert.deepEqual(started.blocking_ticket_ids, ["account-store"]);
});

test("schema versions and migration destinations agree with the shipped contracts", () => {
  const directory = join(skillsRoot, "vibehub-core", "contracts");
  const versions = JSON.parse(readFileSync(join(directory, "versions.json"), "utf8"));
  for (const [name, version] of Object.entries(versions.document_schemas)) {
    const schema = JSON.parse(readFileSync(join(directory, `${name.replaceAll("_", "-")}.schema.json`), "utf8"));
    assert.equal(schema.properties.schema_version.const, version, name);
  }
  const migrations = JSON.parse(readFileSync(join(skillsRoot, "vibehub-migrate", "references", "migrations.json"), "utf8"));
  assert.equal(migrations.current_format, versions.project_format);
  assert.equal(migrations.migrations.at(-1).to, `format-${versions.project_format}`);
});
