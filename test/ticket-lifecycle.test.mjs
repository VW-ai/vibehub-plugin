import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const lifecyclePath = join(
  root,
  "skills",
  "vibehub-ticket-review",
  "references",
  "ticket-lifecycle.json",
);
const skillPaths = new Map([
  ["vibehub-ticket-plan", "skills/vibehub-ticket-plan/SKILL.md"],
  ["vibehub-ticket-validate", "skills/vibehub-ticket-validate/SKILL.md"],
  ["vibehub-ticket-run", "skills/vibehub-ticket-run/SKILL.md"],
  ["vibehub-ticket-closeout", "skills/vibehub-ticket-closeout/SKILL.md"],
  ["vibehub-pr", "skills/vibehub-pr/SKILL.md"],
  ["vibehub-ticket-review", "skills/vibehub-ticket-review/SKILL.md"],
]);
const allowedPresentations = new Set(["none", "conversation", "review"]);
const allowedSurfaces = new Set([
  "none",
  "conversation",
  "graph",
  "execution",
  "contract",
  "log",
  "requested",
]);
const allowedContinuations = new Set(["continue", "wait", "report"]);

function readLifecycle() {
  return JSON.parse(readFileSync(lifecyclePath, "utf8"));
}

function validateLifecycle(contract) {
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.presenter, "vibehub-ticket-review");
  assert.equal(
    contract.planning_contracts.dependency_hygiene,
    "../../contracts/dependency-hygiene.json",
  );
  assert.equal(contract.resource_policy.scope, "current-agent-task");
  assert.equal(contract.resource_policy.reuse_live_host, true);
  assert.equal(contract.resource_policy.reuse_browser_tab, true);
  assert.equal(contract.resource_policy.cross_task_discovery, "forbidden");
  assert.ok(Array.isArray(contract.events) && contract.events.length > 0);
  const eventIds = new Set();
  for (const event of contract.events) {
    assert.match(event.event, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
    assert.equal(eventIds.has(event.event), false, `duplicate event: ${event.event}`);
    eventIds.add(event.event);
    assert.equal(skillPaths.has(event.owner), true, `unknown owner: ${event.owner}`);
    assert.equal(
      allowedPresentations.has(event.presentation),
      true,
      `unknown presentation: ${event.presentation}`,
    );
    assert.equal(
      allowedSurfaces.has(event.surface),
      true,
      `unknown surface: ${event.surface}`,
    );
    assert.equal(
      allowedContinuations.has(event.continuation),
      true,
      `unknown continuation: ${event.continuation}`,
    );
    assert.equal(event.fallback, "conversation");
    if (event.human_boundary) assert.equal(event.continuation, "wait");
    if (event.continuation === "wait") assert.equal(event.human_boundary, true);
    if (event.presentation === "none") assert.equal(event.surface, "none");
    if (event.presentation === "conversation") {
      assert.equal(event.surface, "conversation");
    }
    if (event.presentation === "review") {
      assert.notEqual(event.surface, "none");
      assert.notEqual(event.surface, "conversation");
    }
  }
  return contract;
}

function changed(contract, eventId, patch) {
  return {
    ...contract,
    events: contract.events.map((event) =>
      event.event === eventId ? { ...event, ...patch } : { ...event }),
  };
}

test("Ticket lifecycle has one valid owner and non-conflicting behavior per event", () => {
  const contract = validateLifecycle(readLifecycle());
  const duplicated = {
    ...contract,
    events: [...contract.events, { ...contract.events[0] }],
  };
  assert.throws(() => validateLifecycle(duplicated), /duplicate event/u);
  assert.throws(
    () => validateLifecycle(changed(contract, "plan-applied", { owner: "unknown" })),
    /unknown owner/u,
  );
  assert.throws(
    () => validateLifecycle(changed(contract, "plan-applied", { surface: "proof" })),
    /unknown surface/u,
  );
  assert.throws(
    () => validateLifecycle(changed(contract, "execution-needs-human", {
      continuation: "continue",
    })),
  );
});

test("Ticket Skills own only their lifecycle transitions", () => {
  const contract = validateLifecycle(readLifecycle());
  const skillBodies = new Map(
    [...skillPaths].map(([skill, path]) => [
      skill,
      readFileSync(join(root, path), "utf8"),
    ]),
  );
  for (const [skill, body] of skillBodies) {
    const expectedReference = skill === "vibehub-ticket-review"
      ? "references/ticket-lifecycle.json"
      : "../vibehub-ticket-review/references/ticket-lifecycle.json";
    assert.equal(body.includes(expectedReference), true, `${skill} misses lifecycle reference`);
  }
  for (const event of contract.events) {
    for (const [skill, body] of skillBodies) {
      assert.equal(
        body.includes(`\`${event.event}\``),
        skill === event.owner,
        `${event.event} ownership drifted into ${skill}`,
      );
    }
  }
});

test("Lifecycle scenarios preserve proactive review and quiet execution", () => {
  const events = new Map(
    validateLifecycle(readLifecycle()).events.map((event) => [event.event, event]),
  );
  assert.deepEqual(
    ["plan-applied", "execution-needs-human", "closeout-recorded", "pr-review-ready"]
      .map((id) => events.get(id).presentation),
    ["review", "review", "review", "review"],
  );
  assert.deepEqual(
    [events.get("ready-execution").presentation, events.get("ready-execution").continuation],
    ["none", "continue"],
  );
  assert.equal(events.get("plan-applied").surface, "execution");
  assert.deepEqual(
    [events.get("execution-needs-human").surface, events.get("execution-needs-human").continuation],
    ["contract", "wait"],
  );
  assert.equal(events.get("closeout-recorded").surface, "log");
  assert.equal(events.get("explicit-review").surface, "requested");
});
