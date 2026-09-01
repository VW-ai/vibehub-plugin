(() => {
  "use strict";

  const TICKET_STATES = new Set([
    "READY",
    "REFINE",
    "DONE",
    "BLOCKED",
    "DEVIATED",
  ]);
  const ATTENTION_STATES = new Set([
    "UPCOMING",
    "PENDING",
    "RECORDED",
    "COMPLETE",
  ]);
  const LAYOUT_DIRECTIONS = new Set(["ltr", "ttb"]);
  const NEXT_ACTIONS = new Set([
    "REFINE",
    "WAIT",
    "NEEDS_HUMAN",
    "EXECUTE",
    "CLOSE_OUT",
    "DONE",
    "REPLAN",
  ]);
  const PRIMARY_PHASES = new Set(["DRAFT", "READY", "RUNNING", "DONE"]);
  const LIVE_OPERATIONS = new Set(["execute", "closeout"]);
  const LIVE_STATES = new Set(["running", "waiting_tool", "waiting_human"]);

  function normalizeLayoutDirection(value) {
    return LAYOUT_DIRECTIONS.has(value) ? value : "ltr";
  }

  function layoutDirectionSpec(value) {
    const direction = normalizeLayoutDirection(value);
    return direction === "ltr"
      ? {
          direction,
          rankAxis: "x",
          siblingAxis: "y",
          sourcePort: "right",
          targetPort: "left",
          upstreamKey: "ArrowLeft",
          downstreamKey: "ArrowRight",
        }
      : {
          direction,
          rankAxis: "y",
          siblingAxis: "x",
          sourcePort: "bottom",
          targetPort: "top",
          upstreamKey: "ArrowUp",
          downstreamKey: "ArrowDown",
        };
  }

  function ticketOperationalState(ticket) {
    const slot = ticket?.capabilities?.operational;
    if (slot?.availability !== "available") return null;
    const label = String(slot.summary?.label || "").toUpperCase();
    if (!TICKET_STATES.has(label)) return null;
    return {
      label,
      key: label.toLowerCase(),
      detail: slot.summary?.detail || "",
      references: Array.isArray(slot.summary?.references)
        ? slot.summary.references
        : [],
    };
  }

  function ticketAttentionState(ticket) {
    const slot = ticket?.capabilities?.attention;
    if (slot?.availability !== "available") return null;
    const label = String(slot.summary?.label || "").toUpperCase();
    if (!ATTENTION_STATES.has(label)) return null;
    return {
      label,
      key: label.toLowerCase(),
      detail: slot.summary?.detail || "",
      humanAcceptanceCount: Number(slot.summary?.humanAcceptanceCount) || 0,
      humanEvidenceCount: Number(slot.summary?.humanEvidenceCount) || 0,
    };
  }

  function ticketNextAction(ticket) {
    const slot = ticket?.capabilities?.nextAction;
    if (slot?.availability !== "available") return null;
    const action = String(slot.summary?.action || "").toUpperCase();
    if (!NEXT_ACTIONS.has(action)) return null;
    return {
      action,
      key: action.toLowerCase().replaceAll("_", "-"),
      reason: slot.summary?.reason || "",
      detail: slot.summary?.detail || "",
      acceptanceIds: Array.isArray(slot.summary?.acceptanceIds)
        ? slot.summary.acceptanceIds
        : [],
      blockingTicketIds: Array.isArray(slot.summary?.blockingTicketIds)
        ? slot.summary.blockingTicketIds
        : [],
    };
  }

  function ticketRuntimeState(ticket, { now = Date.now() } = {}) {
    const slot = ticket?.capabilities?.runtime;
    if (slot?.availability !== "available") return null;
    const summary = slot.summary || {};
    const operation = String(summary.operation || "").toLowerCase();
    const state = String(summary.state || "").toLowerCase();
    const observedAt = Date.parse(summary.observedAt || "");
    const expiresAt = Date.parse(summary.expiresAt || "");
    if (!summary.trustedSource || summary.ticketId !== ticket.ticketId) return null;
    if (!summary.runId || !LIVE_OPERATIONS.has(operation) || !LIVE_STATES.has(state)) return null;
    if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt)) return null;
    if (observedAt > now || expiresAt <= now) return null;
    return {
      trustedSource: summary.trustedSource,
      ticketId: summary.ticketId,
      runId: summary.runId,
      operation,
      state,
      observedAt: summary.observedAt,
      expiresAt: summary.expiresAt,
      live: true,
    };
  }

  function ticketPhasePresentation(ticket, options = {}) {
    const operational = ticketOperationalState(ticket);
    const attention = ticketAttentionState(ticket);
    const nextAction = ticketNextAction(ticket);
    const action = nextAction?.action ?? null;
    const runtime = ticketRuntimeState(ticket, options);
    const runtimeEligible = runtime
      && !new Set(["DONE", "REPLAN", "WAIT", "REFINE"]).has(action)
      ? runtime
      : null;
    let label = "DRAFT";
    if (action === "DONE") label = "DONE";
    else if (["REPLAN", "WAIT", "REFINE"].includes(action)) label = "DRAFT";
    else if (action === "CLOSE_OUT" || runtimeEligible) label = "RUNNING";
    else if (["EXECUTE", "NEEDS_HUMAN"].includes(action)) label = "READY";
    else if (operational?.label === "DONE") label = "DONE";
    else if (operational?.label === "READY") label = "READY";

    let substate = null;
    if (action === "REPLAN") substate = "DEVIATED";
    else if (action === "WAIT") substate = "BLOCKED";
    else if (runtimeEligible?.state === "waiting_human") substate = "NEEDS_YOU";
    else if (action === "NEEDS_HUMAN") substate = "NEEDS_YOU";
    else if (action === "CLOSE_OUT") substate = "VERIFYING";
    else if (runtimeEligible?.state === "waiting_tool") substate = "WAITING";

    const stage = action === "CLOSE_OUT"
      ? "verifying"
      : runtimeEligible?.state?.replaceAll("_", "-") ?? null;
    const live = label === "RUNNING" && Boolean(runtimeEligible?.live);
    return {
      label: PRIMARY_PHASES.has(label) ? label : "DRAFT",
      key: label.toLowerCase(),
      substate,
      substateKey: substate?.toLowerCase().replaceAll("_", "-") ?? null,
      stage,
      live,
      runtime: runtimeEligible || null,
      operational,
      attention,
      nextAction,
    };
  }

  function operationalCounts(tickets, options = {}) {
    const counts = { DRAFT: 0, READY: 0, RUNNING: 0, DONE: 0 };
    for (const ticket of tickets) {
      const label = ticketPhasePresentation(ticket, options).label;
      counts[label] += 1;
    }
    return counts;
  }

  function workbenchOverview(tickets, source = {}, options = {}) {
    const phases = { DRAFT: [], READY: [], RUNNING: [], DONE: [] };
    const substates = {
      DEVIATED: [], BLOCKED: [], NEEDS_YOU: [], VERIFYING: [], WAITING: [],
    };
    for (const ticket of tickets) {
      const presentation = ticketPhasePresentation(ticket, options);
      phases[presentation.label].push(ticket);
      if (presentation.substate) substates[presentation.substate].push(ticket);
    }
    return {
      phases,
      substates,
      ready: phases.READY,
      running: phases.RUNNING,
      needsYou: substates.NEEDS_YOU,
      deviated: substates.DEVIATED,
      blocked: substates.BLOCKED,
      sourceDirty: Boolean(source.semanticDirty),
      sourceDirtyCount: Array.isArray(source.dirtyPaths)
        ? source.dirtyPaths.length
        : 0,
      sourceDirtyTruncated: Boolean(source.dirtyPathsTruncated),
    };
  }

  function localFocusHref(currentHref, ticketId = null, viewId = null) {
    const url = new URL(currentHref);
    if (!ticketId) {
      url.searchParams.delete("ticket");
      url.searchParams.delete("view");
      return url.href;
    }
    url.searchParams.set("ticket", ticketId);
    url.searchParams.set(
      "view",
      viewId === "evidence" ? "log" : viewId || "execution",
    );
    return url.href;
  }

  function layoutDirectionHref(currentHref, direction) {
    const url = new URL(currentHref);
    url.searchParams.set("direction", normalizeLayoutDirection(direction));
    return url.href;
  }

  function graphSummary(counts, overview = null) {
    const parts = [];
    for (const label of ["RUNNING", "READY", "DRAFT", "DONE"]) {
      if (counts[label]) parts.push(`${counts[label]} ${label.toLowerCase()}`);
    }
    const needsYou = overview?.needsYou?.length ?? 0;
    if (needsYou) parts.push(`${needsYou} need you`);
    return parts.join(" · ") || "No Tickets";
  }

  function graphNarrative(counts, overview = null) {
    const needsYou = overview?.needsYou?.length ?? 0;
    const sentences = [
      `${counts.RUNNING} running`,
      `${counts.READY} ready`,
      `${counts.DRAFT} draft`,
      `${counts.DONE} done`,
    ];
    return `${sentences.join(", ")}.${needsYou ? ` ${needsYou} need human attention.` : ""}`;
  }

  function causalPriority(label) {
    return { RUNNING: 0, READY: 1, DRAFT: 2, DONE: 3 }[label] ?? 4;
  }

  function agentHandoffInstruction(ticketId, nextAction, stateLabel = null) {
    const action = typeof nextAction === "string"
      ? nextAction
      : nextAction?.action;
    if (action === "EXECUTE") {
      return `Execute the READY VibeHub Ticket ${ticketId} in this exact `
        + "worktree with the Skill vibehub-ticket-run.";
    }
    if (action === "CLOSE_OUT") {
      return `Independently adjudicate VibeHub Ticket ${ticketId} in this exact `
        + "worktree with the Skill vibehub-ticket-closeout. Its current "
        + "acceptance has authority-satisfying Evidence, but no Outcome; do "
        + "not execute the Ticket again merely to increase Evidence count.";
    }
    if (action === "NEEDS_HUMAN") {
      return `Present the Contract for VibeHub Ticket ${ticketId} with the `
        + "Skill vibehub-review and wait for explicit human input. "
        + "Do not substitute Agent-origin Evidence for human authority.";
    }
    if (action === "REFINE") {
      return `Refine the VibeHub Ticket ${ticketId} in this exact worktree `
        + "with the Skill vibehub-ticket-plan. It is currently REFINE, so "
        + "rewrite the same Ticket's acceptance for real and set maturity: "
        + "firm before execution; do not start vibehub-ticket-run.";
    }
    if (action === "REPLAN") {
      return `Replan VibeHub Ticket ${ticketId} in this exact worktree with `
        + "the Skill vibehub-ticket-plan. Its independent Outcome was not "
        + "successful; preserve that Outcome and revise the current contract "
        + "before any new execution.";
    }
    if (action === "WAIT") {
      return `Inspect VibeHub Ticket ${ticketId} with the Skill `
        + "vibehub-review. It is waiting for direct prerequisites; do "
        + "not start vibehub-ticket-run until they close successfully.";
    }
    return `Inspect VibeHub Ticket ${ticketId} (currently ${stateLabel || "unprojected"}) `
      + "with the Skill vibehub-review. Its derived next action is "
      + `${action || "unavailable"}; do not start vibehub-ticket-run.`;
  }

  function ticketNodePresentation(ticket, { selected = false, dimmed = false } = {}) {
    const phase = ticketPhasePresentation(ticket);
    const { operational, attention, nextAction } = phase;
    const classNames = [
      "ticket-node",
      selected ? "selected" : "",
      dimmed ? "dimmed" : "",
      `phase-${phase.key}`,
      phase.substateKey ? `substate-${phase.substateKey}` : "",
      phase.live ? "is-live" : "",
      nextAction ? `next-${nextAction.key}` : "",
    ].filter(Boolean);
    const relationCounts = ticket.relationCounts || {
      prerequisites: 0,
      dependents: 0,
    };
    const ariaLabel = `${ticket.ticketId}. ${ticket.outcome}. `
      + `${relationCounts.prerequisites} prerequisites, `
      + `${relationCounts.dependents} unlocks.`
      + ` Phase ${phase.label}.`
      + (phase.substate ? ` Substate ${phase.substate.replaceAll("_", " ")}.` : "")
      + (phase.live ? " Trusted live execution." : " No live execution claim.")
      + (nextAction
        ? ` Next action ${nextAction.action}. ${nextAction.detail || ""}`
        : "");
    return {
      className: classNames.join(" "),
      ariaLabel,
      stateLabel: phase.label,
      phase,
      operational,
      attention,
      nextAction,
    };
  }

  globalThis.VibeHubWorkbenchModel = Object.freeze({
    agentHandoffInstruction,
    causalPriority,
    graphNarrative,
    graphSummary,
    layoutDirectionHref,
    layoutDirectionSpec,
    operationalCounts,
    localFocusHref,
    normalizeLayoutDirection,
    ticketAttentionState,
    ticketPhasePresentation,
    ticketNodePresentation,
    ticketNextAction,
    ticketOperationalState,
    ticketRuntimeState,
    workbenchOverview,
  });
})();
