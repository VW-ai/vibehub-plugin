import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

function loadWorkbenchModel() {
  const source = readFileSync(join(
    process.cwd(),
    "skills/vibehub-review/assets/app-model.js",
  ), "utf8");
  const sandbox = { URL };
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: "app-model.js" });
  return sandbox.VibeHubWorkbenchModel;
}

function projectedTicket(label) {
  return {
    ticketId: "task",
    status: label === "DONE" ? "done" : label === "IN_PROGRESS" ? "in_progress" : "open",
    outcome: "Remember the task and its result.",
    relationCounts: { prerequisites: 1, dependents: 2 },
    capabilities: {
      operational: { availability: "available", summary: { label, detail: "Recorded task state.", references: [] } },
    },
  };
}

test("Workbench presents recorded task states without prescribing an execution workflow", () => {
  const model = loadWorkbenchModel();
  const items = ["OPEN", "BLOCKED", "IN_PROGRESS", "DONE"].map(projectedTicket);
  assert.deepEqual(items.map(item => model.ticketPhasePresentation(item).label), ["OPEN", "BLOCKED", "IN_PROGRESS", "DONE"]);
  const counts = model.operationalCounts(items);
  assert.deepEqual({ ...counts }, { OPEN: 1, BLOCKED: 1, IN_PROGRESS: 1, DONE: 1 });
  assert.equal(model.graphSummary(counts), "1 in progress · 1 open · 1 blocked · 1 done");
  assert.equal(model.graphNarrative(counts), "1 in progress, 1 open, 1 blocked, 1 done.");
  const presentation = model.ticketNodePresentation(items[0]);
  assert.match(presentation.className, /phase-open/u);
  assert.match(presentation.ariaLabel, /Phase OPEN/u);
  assert.doesNotMatch(presentation.ariaLabel, /Next action/u);
  assert.equal("ticketNextAction" in model, false);
  for (const item of items) {
    const brief = model.agentHandoffInstruction(item.ticketId, item.status);
    assert.match(brief, /user's chosen skills/u);
    assert.match(brief, /Record meaningful progress, results and status/u);
    assert.doesNotMatch(brief, /independent|vibehub-ticket-(run|plan|closeout)|CLOSE_OUT/u);
  }
});

test("live sessions remain separate from recorded task state", () => {
  const model = loadWorkbenchModel();
  const now = Date.parse("2026-08-20T12:00:00Z");
  const item = projectedTicket("OPEN");
  item.capabilities.runtime = {
    availability: "available",
    summary: {
      trustedSource: "dsh-runtime", ticketId: "task", runId: "run-1",
      operation: "execute", state: "running",
      observedAt: "2026-08-20T11:59:00Z", expiresAt: "2026-08-20T12:01:00Z",
    },
  };
  const phase = model.ticketPhasePresentation(item, { now });
  assert.equal(phase.label, "OPEN");
  assert.equal(phase.live, true);
  for (const mutation of [
    { trustedSource: "" }, { ticketId: "other" }, { operation: "plan" },
    { state: "completed" }, { expiresAt: "2026-08-20T11:59:59Z" },
  ]) {
    const candidate = structuredClone(item);
    Object.assign(candidate.capabilities.runtime.summary, mutation);
    assert.equal(model.ticketPhasePresentation(candidate, { now }).live, false);
  }
  item.capabilities.operational.summary.label = "DONE";
  assert.equal(model.ticketPhasePresentation(item, { now }).live, false);
});

test("overview counts explicit progress and blockers independently of historical proof", () => {
  const model = loadWorkbenchModel();
  const open = projectedTicket("OPEN"), blocked = projectedTicket("BLOCKED");
  const progress = projectedTicket("IN_PROGRESS"), done = projectedTicket("DONE");
  open.outcomeHistory = [{ status: "successful" }];
  const overview = model.workbenchOverview([open, blocked, progress, done], {
    semanticDirty: true, dirtyPaths: [".vibehub/tickets/task.yaml"],
  });
  assert.equal(overview.ready[0], open);
  assert.equal(overview.blocked[0], blocked);
  assert.equal(overview.running[0], progress);
  assert.equal(overview.phases.DONE[0], done);
  assert.equal(overview.needsYou.length, 0);
  assert.equal(overview.sourceDirtyCount, 1);
});

test("focused local href preserves the bearer fragment and follows the Inspector lens", () => {
  const model = loadWorkbenchModel();
  const token = "a".repeat(64);
  const base = `http://127.0.0.1:43111/#${token}`;
  const contract = new URL(model.localFocusHref(base, "ready-work", "contract"));
  assert.equal(contract.searchParams.get("ticket"), "ready-work");
  assert.equal(contract.searchParams.get("view"), "contract");
  assert.equal(contract.hash, `#${token}`);

  const log = new URL(model.localFocusHref(contract.href, "ready-work", "evidence"));
  assert.equal(log.searchParams.get("view"), "log");
  assert.equal(log.hash, `#${token}`);

  const cleared = new URL(model.localFocusHref(log.href));
  assert.equal(cleared.search, "");
  assert.equal(cleared.hash, `#${token}`);
});

test("layout direction is explicit, copyable, and safely defaults left-to-right", () => {
  const model = loadWorkbenchModel();
  const token = "b".repeat(64);
  const focused = `http://127.0.0.1:43111/?ticket=ready-work&view=log#${token}`;

  assert.equal(model.normalizeLayoutDirection("ltr"), "ltr");
  assert.equal(model.normalizeLayoutDirection("ttb"), "ttb");
  assert.equal(model.normalizeLayoutDirection("sideways"), "ltr");
  assert.equal(model.normalizeLayoutDirection(null), "ltr");

  const vertical = new URL(model.layoutDirectionHref(focused, "ttb"));
  assert.equal(vertical.searchParams.get("direction"), "ttb");
  assert.equal(vertical.searchParams.get("ticket"), "ready-work");
  assert.equal(vertical.searchParams.get("view"), "log");
  assert.equal(vertical.hash, `#${token}`);

  const fallback = new URL(model.layoutDirectionHref(vertical.href, "diagonal"));
  assert.equal(fallback.searchParams.get("direction"), "ltr");
  assert.equal(fallback.hash, `#${token}`);

  assert.deepEqual({ ...model.layoutDirectionSpec("ltr") }, {
    direction: "ltr",
    rankAxis: "x",
    siblingAxis: "y",
    sourcePort: "right",
    targetPort: "left",
    upstreamKey: "ArrowLeft",
    downstreamKey: "ArrowRight",
  });
  assert.deepEqual({ ...model.layoutDirectionSpec("ttb") }, {
    direction: "ttb",
    rankAxis: "y",
    siblingAxis: "x",
    sourcePort: "bottom",
    targetPort: "top",
    upstreamKey: "ArrowUp",
    downstreamKey: "ArrowDown",
  });
});
