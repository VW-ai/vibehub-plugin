import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { root, run, tempRepo } from "./helpers.mjs";

const graphPath = "skills/vibehub-core/contracts/skill-graph.json";
const lifecyclePath = "skills/vibehub-review/references/ticket-lifecycle.json";
const graph = JSON.parse(readFileSync(join(root, graphPath), "utf8"));
const lifecycle = JSON.parse(readFileSync(join(root, lifecyclePath), "utf8"));

function write(repo, path, value) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), typeof value === "string" ? value : JSON.stringify(value));
}

function fixture() {
  const repo = tempRepo("record-events");
  write(repo, graphPath, { ...graph, retired: [] });
  write(repo, lifecyclePath, lifecycle);
  for (const skill of graph.skills) {
    const references = [...skill.invokes, ...skill.presents, ...skill.routes]
      .map((name) => `$${name}`).join(" ");
    write(repo, `skills/${skill.name}/SKILL.md`, `---\nname: ${skill.name}\ndescription: Test skill.\n---\n${references}\n`);
  }
  return repo;
}

test("record events resolve to their shipped Skill owners", () => {
  const repo = fixture();
  const result = run(repo, "skills", "validate").envelope;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.events, 4);
  for (const event of lifecycle.events) {
    const owner = graph.skills.find((skill) => skill.name === event.owner);
    assert.ok(owner.events.includes(event.event), `${event.event} has no owner`);
  }
});

test("the helper rejects a lifecycle event assigned to a different Skill", () => {
  const repo = fixture();
  const changed = structuredClone(lifecycle);
  changed.events[0].owner = "vibehub-review";
  write(repo, lifecyclePath, changed);
  const result = run(repo, "skills", "validate").envelope;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "validation_error");
  assert.match(JSON.stringify(result.error.details), /in the graph and by vibehub-review in the lifecycle/u);
});

test("the helper rejects a declared event missing from the lifecycle", () => {
  const repo = fixture();
  write(repo, lifecyclePath, { ...lifecycle, events: lifecycle.events.slice(1) });
  const result = run(repo, "skills", "validate").envelope;
  assert.equal(result.ok, false);
  assert.match(JSON.stringify(result.error.details), /is not an event/u);
});
