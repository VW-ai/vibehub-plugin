(() => {
  "use strict";

  const TICKET_STATES = new Set(["OPEN", "IN_PROGRESS", "DONE", "BLOCKED"]);
  const ATTENTION_STATES = new Set(["PENDING", "RECORDED"]);
  const LAYOUT_DIRECTIONS = new Set(["ltr", "ttb"]);
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
    const label = operational?.label ?? "OPEN";
    const runtime = label === "DONE" ? null : ticketRuntimeState(ticket, options);
    const substate = runtime?.state === "waiting_human" ? "NEEDS_YOU"
      : runtime?.state === "waiting_tool" ? "WAITING" : null;
    return {
      label,
      key: label.toLowerCase().replaceAll("_", "-"),
      substate,
      substateKey: substate?.toLowerCase().replaceAll("_", "-") ?? null,
      stage: runtime?.state?.replaceAll("_", "-") ?? null,
      live: Boolean(runtime?.live),
      runtime,
      operational,
      attention,
    };
  }

  function operationalCounts(tickets, options = {}) {
    const counts = { OPEN: 0, BLOCKED: 0, IN_PROGRESS: 0, DONE: 0 };
    for (const ticket of tickets) counts[ticketPhasePresentation(ticket, options).label] += 1;
    return counts;
  }

  function workbenchOverview(tickets, source = {}, options = {}) {
    const phases = { OPEN: [], BLOCKED: [], IN_PROGRESS: [], DONE: [] };
    const substates = { NEEDS_YOU: [], WAITING: [] };
    for (const ticket of tickets) {
      const presentation = ticketPhasePresentation(ticket, options);
      phases[presentation.label].push(ticket);
      if (presentation.substate) substates[presentation.substate].push(ticket);
    }
    return {
      phases,
      substates,
      ready: phases.OPEN,
      running: phases.IN_PROGRESS,
      needsYou: substates.NEEDS_YOU,
      blocked: phases.BLOCKED,
      sourceDirty: Boolean(source.semanticDirty),
      sourceDirtyCount: Array.isArray(source.dirtyPaths) ? source.dirtyPaths.length : 0,
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
    for (const label of ["IN_PROGRESS", "OPEN", "BLOCKED", "DONE"]) {
      if (counts[label]) parts.push(`${counts[label]} ${label.toLowerCase().replaceAll("_", " ")}`);
    }
    const needsYou = overview?.needsYou?.length ?? 0;
    if (needsYou) parts.push(`${needsYou} need you`);
    return parts.join(" · ") || "No Tickets";
  }

  function graphNarrative(counts, overview = null) {
    const needsYou = overview?.needsYou?.length ?? 0;
    const sentences = [
      `${counts.IN_PROGRESS} in progress`,
      `${counts.OPEN} open`,
      `${counts.BLOCKED} blocked`,
      `${counts.DONE} done`,
    ];
    return `${sentences.join(", ")}.${needsYou ? ` ${needsYou} need human attention.` : ""}`;
  }

  function causalPriority(label) {
    return { IN_PROGRESS: 0, OPEN: 1, BLOCKED: 2, DONE: 3 }[label] ?? 4;
  }

  function agentHandoffInstruction(ticketId, stateLabel = null) {
    return `Read VibeHub task ${ticketId} and its context in this exact worktree. `
      + `Its recorded state is ${stateLabel || "unavailable"}. `
      + "Use the user's chosen skills and working methods for the requested work. "
      + "Record meaningful progress, results and status with vibehub-ticket. "
      + "Keep task records local unless sharing was explicitly requested.";
  }

  function ticketNodePresentation(ticket, { selected = false, dimmed = false } = {}) {
    const phase = ticketPhasePresentation(ticket);
    const { operational, attention } = phase;
    const classNames = [
      "ticket-node",
      selected ? "selected" : "",
      dimmed ? "dimmed" : "",
      `phase-${phase.key}`,
      phase.substateKey ? `substate-${phase.substateKey}` : "",
      phase.live ? "is-live" : "",
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
      + (phase.live ? " Live agent session observed." : " No live agent session observed.");
    return {
      className: classNames.join(" "),
      ariaLabel,
      stateLabel: phase.label,
      phase,
      operational,
      attention,
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
    ticketOperationalState,
    ticketRuntimeState,
    workbenchOverview,
  });
})();
