import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

function loadWorkbenchModel() {
  const source = readFileSync(join(
    process.cwd(),
    "skills/vibehub-ticket-review/assets/app-model.js",
  ), "utf8");
  const sandbox = {};
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: "app-model.js" });
  return sandbox.VibeHubWorkbenchModel;
}

function projectedTicket(label, attentionLabel = "PENDING") {
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
    },
  };
}

test("production workbench model renders REFINE as visible but non-executable", () => {
  const model = loadWorkbenchModel();
  const refine = projectedTicket("REFINE");
  const ready = projectedTicket("READY", "COMPLETE");
  ready.ticketId = "ready-work";

  const presentation = model.ticketNodePresentation(refine);
  assert.equal(presentation.stateLabel, "REFINE");
  assert.match(presentation.className, /(?:^| )state-refine(?: |$)/u);
  assert.match(presentation.className, /(?:^| )attention-pending(?: |$)/u);
  assert.match(presentation.ariaLabel, /REFINE/u);
  assert.match(presentation.ariaLabel, /Human attention PENDING/u);

  const counts = model.operationalCounts([refine, ready]);
  assert.equal(counts.READY, 1);
  assert.equal(counts.REFINE, 1);
  assert.match(model.graphSummary(counts), /1 ready · 1 refine/u);
  assert.match(model.graphNarrative(counts), /1 need refinement/u);
  assert.equal(model.causalPriority("REFINE") < model.causalPriority("DONE"), true);

  const readyFrontier = [refine, ready].filter(
    (ticket) => model.ticketOperationalState(ticket)?.label === "READY",
  );
  assert.deepEqual(readyFrontier.map((ticket) => ticket.ticketId), ["ready-work"]);

  const refineHandoff = model.agentHandoffInstruction("draft-work", "REFINE");
  assert.match(refineHandoff, /vibehub-ticket-plan/u);
  assert.match(refineHandoff, /maturity: firm/u);
  assert.match(refineHandoff, /do not start vibehub-ticket-run/u);
  const readyHandoff = model.agentHandoffInstruction("ready-work", "READY");
  assert.match(readyHandoff, /vibehub-ticket-run/u);
  assert.doesNotMatch(readyHandoff, /vibehub-ticket-plan/u);
});
