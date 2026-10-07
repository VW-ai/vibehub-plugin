const PRIMARY_PHASES = Object.freeze(["DRAFT", "READY", "RUNNING", "DONE"]);
const SUBSTATES = Object.freeze([
  "BLOCKED",
  "DEVIATED",
  "NEEDS_YOU",
  "VERIFYING",
  "WAITING",
]);

const ALLOWED_COMBINATIONS = Object.freeze({
  DRAFT: Object.freeze([null, "BLOCKED", "DEVIATED", "NEEDS_YOU", "WAITING"]),
  READY: Object.freeze([null, "NEEDS_YOU"]),
  RUNNING: Object.freeze([null, "NEEDS_YOU", "VERIFYING", "WAITING"]),
  DONE: Object.freeze([null]),
});

const NON_SUCCESS_OUTCOMES = new Set(["partial", "failed", "deviated"]);
const ACTIVE_RUNTIME_STATES = new Set([
  "queued",
  "running",
  "waiting_tool",
  "waiting_human",
]);

export function isAllowedCombination(primary, substate = null) {
  return PRIMARY_PHASES.includes(primary)
    && ALLOWED_COMBINATIONS[primary].includes(substate);
}

function trustedActiveRuntime(runtime) {
  return runtime?.trust === "trusted"
    && runtime?.freshness === "active"
    && ["plan", "execute", "closeout"].includes(runtime?.operation)
    && ACTIVE_RUNTIME_STATES.has(runtime?.state);
}

function primaryPhase(facts) {
  if (facts.outcomeStatus === "successful") return "DONE";
  if (NON_SUCCESS_OUTCOMES.has(facts.outcomeStatus)) return "DRAFT";
  if (facts.dependenciesResolved === false) return "DRAFT";
  if (facts.maturity === "draft") return "DRAFT";
  if (facts.nextAction === "CLOSE_OUT") return "RUNNING";
  if (trustedActiveRuntime(facts.runtime)
    && ["execute", "closeout"].includes(facts.runtime.operation)) return "RUNNING";
  return "READY";
}

function substateFor(primary, facts) {
  if (primary === "DRAFT") {
    if (NON_SUCCESS_OUTCOMES.has(facts.outcomeStatus)) return "DEVIATED";
    if (facts.dependenciesResolved === false) return "BLOCKED";
    if (trustedActiveRuntime(facts.runtime)
      && facts.runtime.operation === "plan"
      && facts.runtime.state === "waiting_human") return "NEEDS_YOU";
    if (trustedActiveRuntime(facts.runtime)
      && facts.runtime.operation === "plan"
      && facts.runtime.state === "waiting_tool") return "WAITING";
    return null;
  }
  if (primary === "READY" && facts.nextAction === "NEEDS_HUMAN") {
    return "NEEDS_YOU";
  }
  if (primary === "RUNNING" && (facts.nextAction === "NEEDS_HUMAN"
    || (trustedActiveRuntime(facts.runtime)
      && facts.runtime.state === "waiting_human"))) {
    return "NEEDS_YOU";
  }
  if (primary === "RUNNING" && facts.nextAction === "CLOSE_OUT") return "VERIFYING";
  if (primary === "RUNNING" && trustedActiveRuntime(facts.runtime)
    && facts.runtime.state === "waiting_tool") return "WAITING";
  return null;
}

function runStageFor(primary, facts) {
  if (primary !== "RUNNING") return null;
  if (facts.nextAction === "CLOSE_OUT") return "closeout";
  if (trustedActiveRuntime(facts.runtime)) return facts.runtime.operation;
  return null;
}

function explanationFor(primary, substate, runStage) {
  if (primary === "DONE") return "Independently accepted.";
  if (substate === "DEVIATED") return "The current contract or path must change before work resumes.";
  if (substate === "BLOCKED") return "A direct prerequisite must finish before this Task can advance.";
  if (primary === "DRAFT" && substate === "NEEDS_YOU") return "Your input is required to stabilize the Task context.";
  if (primary === "DRAFT" && substate === "WAITING") return "Planning is live and waiting on a trusted tool result.";
  if (primary === "DRAFT") return "The outcome or path is still being shaped.";
  if (primary === "READY" && substate === "NEEDS_YOU") return "The Task is stable and you are the next actor.";
  if (primary === "READY") return "The Task is stable and can start.";
  if (substate === "NEEDS_YOU") return "Work is in progress and has reached a human boundary.";
  if (substate === "VERIFYING") return "Execution is complete; independent acceptance is the current stage.";
  if (substate === "WAITING") return "The active work loop is waiting on an Agent or tool, not on you.";
  return "The active work loop is advancing.";
}

function actionFor(primary, substate, runStage) {
  if (substate === "DEVIATED") return "Revise";
  if (substate === "BLOCKED") return "View blocker";
  if (substate === "NEEDS_YOU") return primary === "READY" ? "Decide" : "Respond";
  if (primary === "DRAFT") return "Define";
  if (primary === "READY") return "Start";
  if (primary === "RUNNING" && runStage === "closeout") return "Close out";
  if (primary === "RUNNING") return "Open run";
  return "View outcome";
}

export function deriveCardSignal(facts) {
  const primary = primaryPhase(facts);
  const substate = substateFor(primary, facts);
  const runStage = runStageFor(primary, facts);
  const canonicalConflict = primary === "DONE"
    || substate === "DEVIATED"
    || substate === "BLOCKED";
  const live = !canonicalConflict && trustedActiveRuntime(facts.runtime);
  if (!isAllowedCombination(primary, substate)) {
    throw new TypeError(`Contradictory card signal: ${primary} + ${substate}`);
  }
  return {
    primary,
    substate,
    runStage,
    live,
    action: actionFor(primary, substate, runStage),
    explanation: explanationFor(primary, substate, runStage),
    archiveBoundary: Boolean(facts.archived),
  };
}

export const cardSignalContract = Object.freeze({
  primaryPhases: PRIMARY_PHASES,
  substates: SUBSTATES,
  allowedCombinations: ALLOWED_COMBINATIONS,
});
