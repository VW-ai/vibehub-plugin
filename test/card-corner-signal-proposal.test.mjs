import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  cardSignalContract,
  deriveCardSignal,
  isAllowedCombination,
} from "../docs/proposals/card-corner-signal/phase-model.mjs";

const root = join(process.cwd(), "docs/proposals/card-corner-signal");
const contract = JSON.parse(readFileSync(join(root, "contract.json"), "utf8"));
const fixtureDocument = JSON.parse(readFileSync(join(root, "fixtures.json"), "utf8"));
const html = readFileSync(join(root, "index.html"), "utf8");
const css = readFileSync(join(root, "prototype.css"), "utf8");
const script = readFileSync(join(root, "prototype.js"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");

test("proposal separates canonical truth sources from the four-phase Human model", () => {
  assert.deepEqual(contract.recommendation.primary_phases, ["DRAFT", "READY", "RUNNING", "DONE"]);
  assert.deepEqual(cardSignalContract.primaryPhases, ["DRAFT", "READY", "RUNNING", "DONE"]);
  assert.deepEqual(
    contract.canonical_truth_sources.map((item) => item.fact),
    [
      "maturity",
      "dependency readiness",
      "next action",
      "proof",
      "accepted completion or material deviation",
      "human authority",
      "archive and delivery",
      "live presence",
    ],
  );
  assert.equal(contract.recommendation.live_presence_is_separate, true);
  assert.equal(contract.recommendation.raw_v080_values_remain_unchanged, true);
  assert.deepEqual(contract.current_v080_corpus.observed_combinations, {
    "BLOCKED|WAIT": 4,
    "DONE|DONE": 64,
    "READY|CLOSE_OUT": 6,
    "READY|EXECUTE": 2,
    "READY|NEEDS_HUMAN": 1,
    "REFINE|REFINE": 3,
  });
});

test("the complete adversarial fixture matrix derives exact primary, slot, stage, live, action, and archive facts", () => {
  assert.equal(fixtureDocument.fixtures.length, 22);
  for (const fixture of fixtureDocument.fixtures) {
    const actual = deriveCardSignal(fixture.facts);
    for (const [key, expected] of Object.entries(fixture.expected)) {
      assert.deepEqual(actual[key], expected, `${fixture.id}: ${key}`);
    }
    assert.equal(typeof actual.explanation, "string", `${fixture.id}: explanation`);
    assert.ok(actual.explanation.length > 10, `${fixture.id}: useful explanation`);
  }
});

test("one corner slot rejects contradictory Cartesian combinations and follows exact priority", () => {
  const allowed = {
    DRAFT: [null, "BLOCKED", "DEVIATED", "NEEDS_YOU", "WAITING"],
    READY: [null, "NEEDS_YOU"],
    RUNNING: [null, "NEEDS_YOU", "VERIFYING", "WAITING"],
    DONE: [null],
  };
  for (const primary of cardSignalContract.primaryPhases) {
    for (const substate of [null, ...cardSignalContract.substates]) {
      assert.equal(
        isAllowedCombination(primary, substate),
        allowed[primary].includes(substate),
        `${primary} + ${substate}`,
      );
    }
  }

  const crowdedDraft = deriveCardSignal({
    outcomeStatus: "deviated",
    dependenciesResolved: false,
    maturity: "draft",
    nextAction: "REPLAN",
    runtime: { trust: "trusted", freshness: "active", operation: "plan", state: "waiting_human" },
  });
  assert.deepEqual([crowdedDraft.primary, crowdedDraft.substate, crowdedDraft.live], ["DRAFT", "DEVIATED", false]);

  const blockedBeforeHuman = deriveCardSignal({
    outcomeStatus: null,
    dependenciesResolved: false,
    maturity: "draft",
    nextAction: "WAIT",
    runtime: { trust: "trusted", freshness: "active", operation: "plan", state: "waiting_human" },
  });
  assert.deepEqual([blockedBeforeHuman.primary, blockedBeforeHuman.substate], ["DRAFT", "BLOCKED"]);

  const closeoutWaitingTool = deriveCardSignal({
    outcomeStatus: null,
    dependenciesResolved: true,
    maturity: "firm",
    nextAction: "CLOSE_OUT",
    runtime: { trust: "trusted", freshness: "active", operation: "closeout", state: "waiting_tool" },
  });
  assert.deepEqual([closeoutWaitingTool.primary, closeoutWaitingTool.substate], ["RUNNING", "VERIFYING"]);
});

test("current v0.8 mapping is honest and future runtime is explicit, trusted, scoped, and expiring", () => {
  assert.deepEqual(
    contract.current_v080_corpus.minimal_presentation_mapping.map((item) => [item.next_action, item.primary, item.slot]),
    [
      ["DONE", "DONE", null],
      ["REPLAN", "DRAFT", "DEVIATED"],
      ["WAIT", "DRAFT", "BLOCKED"],
      ["REFINE", "DRAFT", null],
      ["EXECUTE", "READY", null],
      ["NEEDS_HUMAN", "READY", "NEEDS_YOU"],
      ["CLOSE_OUT", "RUNNING", "VERIFYING"],
    ],
  );
  assert.equal(contract.current_v080_corpus.production_runtime_projection, false);
  assert.deepEqual(contract.runtime_capability_boundary.operation_values, ["plan", "execute", "closeout"]);
  assert.deepEqual(
    contract.runtime_capability_boundary.state_values,
    ["queued", "running", "waiting_tool", "waiting_human", "completed", "failed"],
  );
  for (const field of ["trustedSource", "ticketId", "runId", "operation", "state", "observedAt", "expiresAt or terminalAt"]) {
    assert.ok(contract.runtime_capability_boundary.required_fields.includes(field), field);
  }
  assert.match(contract.draft_needs_you.problem, /cannot derive DRAFT \+ NEEDS YOU honestly/u);
  assert.equal(contract.draft_needs_you.options.find((item) => item.option === "Infer from authority:human").decision, "reject");
});

test("materiality and lifecycle transitions cover blocker clear, Run end, closeout failure, and reopen", () => {
  assert.match(contract.material_deviation.safe_v080_threshold, /Every non-success Outcome/u);
  for (const transition of ["blocker clears", "trusted execute ends with incomplete Evidence", "closeout fails or deviates", "work is reopened"]) {
    assert.ok(contract.transitions.some((item) => item.event === transition), transition);
  }
  assert.match(
    contract.transitions.find((item) => item.event === "closeout fails or deviates").to,
    /DRAFT \+ DEVIATED/u,
  );
  assert.match(
    contract.transitions.find((item) => item.event === "trusted execute ends with incomplete Evidence").to,
    /READY/u,
  );
});

test("production-shaped review board is clickable, responsive, quiet, and accessible", () => {
  assert.equal(html.includes("http://") || html.includes("https://"), false);
  assert.match(html, /Production-shaped card signal review board/u);
  assert.match(html, /data-viewport="wide"/u);
  assert.match(html, /data-viewport="narrow"/u);
  assert.match(html, /Recommended primary phase legend/u);
  for (const phase of ["DRAFT", "READY", "RUNNING", "DONE"]) {
    assert.match(html, new RegExp(`<strong>${phase}</strong>`, "u"));
  }
  assert.doesNotMatch(html + script, /Plan with Agent/u);
  assert.match(script, /addEventListener\("click"/u);
  assert.match(script, /addEventListener\("focus"/u);
  assert.match(script, /aria-label/u);
  assert.match(script, /aria-pressed/u);
  assert.match(script, /classList\.add\("dimmed"/u);
  assert.match(css, /\.task-card:hover \.card-explanation, \.task-card:focus-visible \.card-explanation/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
  assert.match(css, /min-height: 44px/u);
  assert.match(css, /\.viewport-frame\[data-viewport="narrow"\]/u);
  assert.match(css, /\.task-card\.selected/u);
  assert.match(css, /\.task-card\.dimmed/u);
  assert.match(css, /\.phase \{[^}]*display: inline-flex;[^}]*align-items: center;/u);
  assert.match(css, /\.phase svg \{ width: 14px; height: 14px; \}/u);
  assert.doesNotMatch(css, /\.phase svg[^}]*transform/u);
  assert.doesNotMatch(css, /\.corner-signal svg[^}]*translateY/u);
  assert.doesNotMatch(css, /\.contract-strip svg[^}]*translateY/u);
});

test("visual budget has four primary entries, bounded color families, and non-color truth", () => {
  assert.equal(contract.visual_budget.primary_legend_entries, 4);
  assert.deepEqual(Object.keys(contract.visual_budget.families), [
    "neutral", "action_blue", "proof_green", "attention_amber", "exception_red",
  ]);
  assert.match(contract.visual_budget.non_color, /text plus a distinct stroke icon or boundary pattern/u);
  assert.match(contract.visual_budget.live, /reduced motion uses a static ring/u);
  assert.equal(contract.visual_budget.narrow_target_px, 44);
  assert.match(css, /phase-ready, \.task-card\.phase-running/u);
  assert.match(css, /border-style: dashed/u);
});

test("proposal keeps raw machine and downstream decision boundaries explicit", () => {
  assert.match(readme, /proposal only — owner decision required/u);
  assert.match(readme, /Raw Ticket status, next_action/u);
  assert.match(readme, /Protected decision and implementation sequence/u);
  assert.equal(contract.downstream_boundaries.length, 7);
  const nextActionContract = readFileSync(join(process.cwd(), "skills/vibehub-core/contracts/ticket-next-action.md"), "utf8");
  const lifecycle = readFileSync(join(process.cwd(), "skills/vibehub-review/references/ticket-lifecycle.json"), "utf8");
  assert.match(nextActionContract, /`REFINE`/u);
  assert.match(nextActionContract, /`CLOSE_OUT`/u);
  assert.match(lifecycle, /"REFINE"/u);
  assert.match(lifecycle, /"CLOSE_OUT"/u);
});
