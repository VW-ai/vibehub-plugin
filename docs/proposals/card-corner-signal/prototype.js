import { deriveCardSignal } from "./phase-model.mjs";

const cases = [
  {
    id: "draft-open",
    ticketId: "ticket-shape-context-boundary",
    outcome: "Define the Task without pretending its acceptance is executable.",
    facts: { outcomeStatus: null, dependenciesResolved: true, maturity: "draft", nextAction: "REFINE", runtime: null, archived: false },
  },
  {
    id: "draft-blocked",
    ticketId: "ticket-integrate-human-decision",
    outcome: "Carry the chosen interaction contract into the production Workbench.",
    facts: { outcomeStatus: null, dependenciesResolved: false, maturity: "firm", nextAction: "WAIT", runtime: null, archived: false },
  },
  {
    id: "draft-deviated",
    ticketId: "ticket-repair-closeout-contract",
    outcome: "Revise the path after independent closeout found a material contract gap.",
    facts: { outcomeStatus: "deviated", dependenciesResolved: true, maturity: "firm", nextAction: "REPLAN", runtime: null, archived: false },
  },
  {
    id: "draft-needs",
    ticketId: "ticket-choose-public-hostname",
    outcome: "Select the exact hostname and replacement boundary before deployment planning continues.",
    facts: { outcomeStatus: null, dependenciesResolved: true, maturity: "draft", nextAction: "REFINE", runtime: { trust: "trusted", freshness: "active", operation: "plan", state: "waiting_human" }, archived: false },
  },
  {
    id: "ready-agent",
    ticketId: "ticket-implement-state-projection",
    outcome: "Add the accepted four-phase projection without changing raw lifecycle truth.",
    facts: { outcomeStatus: null, dependenciesResolved: true, maturity: "firm", nextAction: "EXECUTE", runtime: null, archived: false },
  },
  {
    id: "ready-human",
    ticketId: "ticket-decide-state-contract",
    outcome: "Owner accepts or corrects the exact phase and corner-signal contract.",
    facts: { outcomeStatus: null, dependenciesResolved: true, maturity: "firm", nextAction: "NEEDS_HUMAN", runtime: null, archived: false },
  },
  {
    id: "running-live",
    ticketId: "ticket-verify-wide-narrow-ui",
    outcome: "Exercise wide, narrow, keyboard, reduced-motion, selected, dimmed, and long-copy behavior in the production-shaped interaction frame.",
    facts: { outcomeStatus: null, dependenciesResolved: true, maturity: "firm", nextAction: "EXECUTE", runtime: { trust: "trusted", freshness: "active", operation: "execute", state: "running" }, archived: false },
  },
  {
    id: "running-waiting",
    ticketId: "ticket-build-installed-artifact",
    outcome: "Build matching Codex and Claude artifacts after the local verification tool returns.",
    facts: { outcomeStatus: null, dependenciesResolved: true, maturity: "firm", nextAction: "EXECUTE", runtime: { trust: "trusted", freshness: "active", operation: "execute", state: "waiting_tool" }, archived: false },
  },
  {
    id: "running-needs",
    ticketId: "ticket-resolve-runtime-permission",
    outcome: "Continue the trusted execution after the user resolves the exact permission boundary.",
    facts: { outcomeStatus: null, dependenciesResolved: true, maturity: "firm", nextAction: "NEEDS_HUMAN", runtime: { trust: "trusted", freshness: "active", operation: "execute", state: "waiting_human" }, archived: false },
  },
  {
    id: "running-closeout",
    ticketId: "ticket-independent-closeout",
    outcome: "Adjudicate acceptance-linked proof independently without rerunning implementation.",
    facts: { outcomeStatus: null, dependenciesResolved: true, maturity: "firm", nextAction: "CLOSE_OUT", runtime: null, archived: false },
  },
  {
    id: "done",
    ticketId: "ticket-apply-card-anatomy",
    outcome: "The compact graph card anatomy is independently accepted and retained.",
    facts: { outcomeStatus: "successful", dependenciesResolved: true, maturity: "firm", nextAction: "DONE", runtime: null, archived: false },
  },
];

const icons = {
  DRAFT: "draft",
  READY: "ready",
  RUNNING: "running",
  DONE: "done",
  BLOCKED: "blocked",
  DEVIATED: "deviated",
  NEEDS_YOU: "needs",
  VERIFYING: "verifying",
  WAITING: "waiting",
};

const graphWorld = document.querySelector("#graphWorld");
const viewportFrame = document.querySelector("#viewportFrame");
const focusToggle = document.querySelector("#focusToggle");
let selectedId = "running-closeout";
let causalFocus = false;

function setViewport(mode) {
  viewportFrame.dataset.viewport = mode;
  document.querySelectorAll("[data-viewport]").forEach((peer) => {
    const active = peer.dataset.viewport === mode;
    peer.classList.toggle("active", active);
    peer.setAttribute("aria-pressed", String(active));
  });
}

function icon(name, className = "") {
  return `<svg class="${className}" aria-hidden="true"><use href="#icon-${icons[name] || name}"/></svg>`;
}

function ariaName(item, signal) {
  const corner = signal.substate
    ? ` Corner signal ${signal.substate.replace("_", " ")}.`
    : " No corner signal.";
  const live = signal.live ? " Trusted live presence." : " No live presence claim.";
  return `${item.ticketId}. ${item.outcome} ${signal.primary}.${corner} ${signal.explanation}${live}`;
}

function render() {
  graphWorld.replaceChildren();
  cases.forEach((item, index) => {
    const signal = deriveCardSignal(item.facts);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-card phase-${signal.primary.toLowerCase()}${signal.substate ? ` signal-${signal.substate.toLowerCase().replace("_", "-")}` : ""}`;
    button.dataset.caseId = item.id;
    button.setAttribute("aria-label", ariaName(item, signal));
    button.setAttribute("aria-pressed", String(item.id === selectedId));
    if (item.id === selectedId) button.classList.add("selected");
    if (causalFocus && Math.abs(cases.findIndex((entry) => entry.id === selectedId) - index) > 1) {
      button.classList.add("dimmed");
    }
    button.innerHTML = `
      <span class="accent" aria-hidden="true"></span>
      ${signal.substate ? `<span class="corner-signal">${icon(signal.substate)} ${signal.substate.replace("_", " ")}</span>` : ""}
      <span class="task-id">${item.ticketId}</span>
      <strong>${item.outcome}</strong>
      <span class="card-bottom"><span>1 in · 2 out</span><span class="phase">${icon(signal.primary)} ${signal.primary}</span></span>
      ${signal.live ? '<span class="live-presence"><i aria-hidden="true"></i>LIVE</span>' : ""}
      <span class="card-explanation">${signal.explanation}</span>`;
    const select = () => {
      selectedId = item.id;
      render();
      updateInspector(item, signal);
    };
    button.addEventListener("click", select);
    button.addEventListener("focus", () => updateInspector(item, signal));
    graphWorld.append(button);
  });
}

function updateInspector(item, signal = deriveCardSignal(item.facts)) {
  document.querySelector("#inspectorPhase").textContent = [signal.primary, signal.substate].filter(Boolean).join(" · ");
  document.querySelector("#inspectorTitle").textContent = item.outcome;
  document.querySelector("#inspectorExplanation").textContent = signal.explanation;
  document.querySelector("#inspectorAction").textContent = signal.action;
  document.querySelector("#inspectorPrimary").textContent = signal.primary;
  document.querySelector("#inspectorSubstate").textContent = signal.substate?.replace("_", " ") || "empty";
  document.querySelector("#inspectorLive").textContent = signal.live ? "Trusted and unexpired" : "No claim";
  document.querySelector("#inspectorFacts").textContent = JSON.stringify(item.facts, null, 2);
}

for (const button of document.querySelectorAll("[data-viewport]")) {
  button.addEventListener("click", () => {
    setViewport(button.dataset.viewport);
  });
}

focusToggle.addEventListener("click", () => {
  causalFocus = !causalFocus;
  focusToggle.setAttribute("aria-pressed", String(causalFocus));
  focusToggle.classList.toggle("active", causalFocus);
  render();
});

const requestedViewport = new URLSearchParams(window.location.search).get("viewport");
if (requestedViewport === "narrow" || window.matchMedia("(max-width: 430px)").matches) {
  setViewport("narrow");
}
render();
updateInspector(cases.find((item) => item.id === selectedId));
