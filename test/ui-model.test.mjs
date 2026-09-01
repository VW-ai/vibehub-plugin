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

function projectedTicket(
  label,
  attentionLabel = "PENDING",
  nextAction = label === "READY" ? "EXECUTE" : "REFINE",
) {
  return {
    ticketId: "draft-work",
    outcome: "Rewrite this draft into an executable Ticket.",
    relationCounts: { prerequisites: 1, dependents: 2 },
    capabilities: {
      operational: {
        availability: "available",
        summary: {
          label,
          detail: label === "REFINE"
            ? "Prerequisites are done, but maturity is draft."
            : "Executable now.",
          references: [],
        },
      },
      attention: {
        availability: "available",
        summary: {
          label: attentionLabel,
          detail: "One owner decision remains.",
          humanAcceptanceCount: 1,
          humanEvidenceCount: 0,
        },
      },
      nextAction: {
        availability: "available",
        summary: {
          action: nextAction,
          reason: "fixture_reason",
          detail: `The canonical next action is ${nextAction}.`,
          acceptanceIds: ["works"],
          blockingTicketIds: [],
        },
      },
    },
  };
}

test("production workbench derives four primary phases from canonical next action", () => {
  const model = loadWorkbenchModel();
  const refine = projectedTicket("REFINE");
  const ready = projectedTicket("READY", "COMPLETE");
  ready.ticketId = "ready-work";

  const presentation = model.ticketNodePresentation(refine);
  assert.equal(presentation.stateLabel, "DRAFT");
  assert.match(presentation.className, /(?:^| )phase-draft(?: |$)/u);
  assert.doesNotMatch(presentation.className, /attention-pending/u);
  assert.match(presentation.ariaLabel, /Phase DRAFT/u);
  assert.match(presentation.ariaLabel, /Next action REFINE/u);
  assert.match(presentation.ariaLabel, /No live execution claim/u);

  const counts = model.operationalCounts([refine, ready]);
  assert.equal(counts.READY, 1);
  assert.equal(counts.DRAFT, 1);
  assert.equal(counts.RUNNING, 0);
  assert.match(model.graphSummary(counts), /1 ready · 1 draft/u);
  assert.match(model.graphNarrative(counts), /1 ready, 1 draft/u);
  assert.equal(model.causalPriority("DRAFT") < model.causalPriority("DONE"), true);

  const readyFrontier = [refine, ready].filter(
    (ticket) => model.ticketOperationalState(ticket)?.label === "READY",
  );
  assert.deepEqual(readyFrontier.map((ticket) => ticket.ticketId), ["ready-work"]);

  const refineHandoff = model.agentHandoffInstruction(
    "draft-work",
    model.ticketNextAction(refine),
    "REFINE",
  );
  assert.match(refineHandoff, /vibehub-ticket-plan/u);
  assert.match(refineHandoff, /maturity: firm/u);
  assert.match(refineHandoff, /do not start vibehub-ticket-run/u);
  const readyHandoff = model.agentHandoffInstruction(
    "ready-work",
    model.ticketNextAction(ready),
    "READY",
  );
  assert.match(readyHandoff, /vibehub-ticket-run/u);
  assert.doesNotMatch(readyHandoff, /vibehub-ticket-plan/u);
});

test("production workbench routes execution and adjudication from host next action", () => {
  const model = loadWorkbenchModel();
  const closeout = projectedTicket("READY", "RECORDED", "CLOSE_OUT");
  closeout.ticketId = "fully-evidenced";
  // Runtime presence is intentionally extra presentation state and cannot
  // rewrite the canonical next-action capability.
  const next = model.ticketNextAction(closeout);
  assert.equal(next.action, "CLOSE_OUT");
  const presentation = model.ticketNodePresentation(closeout);
  assert.match(presentation.className, /(?:^| )next-close-out(?: |$)/u);
  assert.match(presentation.className, /(?:^| )phase-running(?: |$)/u);
  assert.match(presentation.className, /(?:^| )substate-verifying(?: |$)/u);
  assert.equal(presentation.phase.live, false);
  assert.match(presentation.ariaLabel, /Next action CLOSE_OUT/u);
  assert.match(
    model.agentHandoffInstruction(closeout.ticketId, next, "READY"),
    /vibehub-ticket-closeout/u,
  );
  assert.doesNotMatch(
    model.agentHandoffInstruction(closeout.ticketId, next, "READY"),
    /vibehub-ticket-run/u,
  );

  const needsHuman = projectedTicket("READY", "PENDING", "NEEDS_HUMAN");
  assert.match(
    model.agentHandoffInstruction(
      "owner-decision",
      model.ticketNextAction(needsHuman),
      "READY",
    ),
    /wait for explicit human input/u,
  );
});

test("canonical precedence yields one deterministic phase and substate", () => {
  const model = loadWorkbenchModel();
  const cases = [
    ["DONE", "DONE", null],
    ["REPLAN", "DRAFT", "DEVIATED"],
    ["WAIT", "DRAFT", "BLOCKED"],
    ["REFINE", "DRAFT", null],
    ["EXECUTE", "READY", null],
    ["NEEDS_HUMAN", "READY", "NEEDS_YOU"],
    ["CLOSE_OUT", "RUNNING", "VERIFYING"],
  ];
  for (const [action, phase, substate] of cases) {
    const ticket = projectedTicket("READY", "PENDING", action);
    ticket.ticketId = action.toLowerCase();
    const result = model.ticketPhasePresentation(ticket);
    assert.deepEqual([result.label, result.substate, result.live], [phase, substate, false]);
    if (["READY", "RUNNING"].includes(phase)) {
      assert.notEqual(result.substate, "BLOCKED");
      assert.notEqual(result.substate, "DEVIATED");
    }
  }
});

test("trusted scoped runtime is the only source of live Running", () => {
  const model = loadWorkbenchModel();
  const now = Date.parse("2026-08-20T12:00:00Z");
  const ready = projectedTicket("READY", "COMPLETE", "EXECUTE");
  ready.ticketId = "ready-work";
  const runtime = {
    availability: "available",
    summary: {
      trustedSource: "dsh-runtime",
      ticketId: "ready-work",
      runId: "run-1",
      operation: "execute",
      state: "running",
      observedAt: "2026-08-20T11:59:00Z",
      expiresAt: "2026-08-20T12:01:00Z",
    },
  };
  ready.capabilities.runtime = runtime;
  assert.deepEqual(
    { ...model.ticketPhasePresentation(ready, { now }) },
    {
      label: "RUNNING",
      key: "running",
      substate: null,
      substateKey: null,
      stage: "running",
      live: true,
      runtime: model.ticketRuntimeState(ready, { now }),
      operational: model.ticketOperationalState(ready),
      attention: model.ticketAttentionState(ready),
      nextAction: model.ticketNextAction(ready),
    },
  );
  for (const mutation of [
    { trustedSource: "" },
    { ticketId: "other" },
    { operation: "plan" },
    { state: "completed" },
    { expiresAt: "2026-08-20T11:59:59Z" },
  ]) {
    const candidate = structuredClone(ready);
    Object.assign(candidate.capabilities.runtime.summary, mutation);
    const phase = model.ticketPhasePresentation(candidate, { now });
    assert.equal(phase.label, "READY");
    assert.equal(phase.live, false);
  }
});

test("production workbench model projects four phases and one substate slot", () => {
  const model = loadWorkbenchModel();
  const ready = projectedTicket("READY", "COMPLETE", "EXECUTE");
  ready.ticketId = "ready-work";
  const refine = projectedTicket("REFINE", "UPCOMING");
  refine.ticketId = "refine-work";
  const deviated = projectedTicket("DEVIATED", "COMPLETE", "REPLAN");
  deviated.ticketId = "deviated-work";
  const closeout = projectedTicket("READY", "RECORDED", "CLOSE_OUT");
  closeout.ticketId = "closeout-work";
  const human = projectedTicket("READY", "PENDING", "NEEDS_HUMAN");
  human.ticketId = "human-work";

  const overview = model.workbenchOverview(
    [ready, refine, deviated, closeout, human],
    {
      semanticDirty: true,
      dirtyPaths: [".vibehub/tickets/ready-work.yaml"],
      dirtyPathsTruncated: false,
    },
  );
  assert.equal(
    overview.phases.READY.map((ticket) => ticket.ticketId).join(","),
    "ready-work,human-work",
  );
  assert.equal(
    overview.phases.RUNNING.map((ticket) => ticket.ticketId).join(","),
    "closeout-work",
  );
  assert.equal(
    overview.phases.DRAFT.map((ticket) => ticket.ticketId).join(","),
    "refine-work,deviated-work",
  );
  assert.equal(
    overview.needsYou.map((ticket) => ticket.ticketId).join(","),
    "human-work",
  );
  assert.equal(
    overview.deviated.map((ticket) => ticket.ticketId).join(","),
    "deviated-work",
  );
  assert.equal(overview.substates.VERIFYING[0].ticketId, "closeout-work");
  const counts = model.operationalCounts([ready, refine, deviated, closeout, human]);
  assert.match(model.graphSummary(counts, overview), /1 running · 2 ready · 2 draft/u);
  assert.match(model.graphNarrative(counts, overview), /1 running, 2 ready, 2 draft/u);
  assert.equal(overview.sourceDirty, true);
  assert.equal(overview.sourceDirtyCount, 1);
  assert.equal("implementing" in overview, false);
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
