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

  function operationalCounts(tickets) {
    const counts = {
      READY: 0,
      REFINE: 0,
      BLOCKED: 0,
      DONE: 0,
      DEVIATED: 0,
    };
    for (const ticket of tickets) {
      const label = ticketOperationalState(ticket)?.label;
      if (label && Object.hasOwn(counts, label)) counts[label] += 1;
    }
    return counts;
  }

  function workbenchOverview(tickets, source = {}) {
    const ready = [];
    const deviated = [];
    const humanPending = [];
    const humanUpcoming = [];
    let refineCount = 0;
    for (const ticket of tickets) {
      const operational = ticketOperationalState(ticket);
      const attention = ticketAttentionState(ticket);
      if (operational?.label === "READY") ready.push(ticket);
      if (operational?.label === "REFINE") refineCount += 1;
      if (operational?.label === "DEVIATED") deviated.push(ticket);
      if (attention?.label === "PENDING") humanPending.push(ticket);
      if (attention?.label === "UPCOMING") humanUpcoming.push(ticket);
    }
    return {
      ready,
      deviated,
      humanPending,
      humanUpcoming,
      refineCount,
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

  function graphSummary(counts) {
    const parts = [];
    if (counts.READY) parts.push(`${counts.READY} ready`);
    if (counts.REFINE) parts.push(`${counts.REFINE} refine`);
    if (counts.BLOCKED) parts.push(`${counts.BLOCKED} blocked`);
    if (counts.DEVIATED) {
      parts.push(
        `${counts.DEVIATED} deviation${counts.DEVIATED === 1 ? "" : "s"}`,
      );
    }
    if (!parts.length && counts.DONE) parts.push(`${counts.DONE} proven`);
    return parts.join(" · ") || "No executable Tickets";
  }

  function graphNarrative(counts) {
    if (counts.DEVIATED) {
      return `${counts.DEVIATED} execution deviation${counts.DEVIATED === 1 ? "" : "s"} need attention. `
        + `${counts.READY} Ticket${counts.READY === 1 ? " is" : "s are"} executable now; `
        + `${counts.REFINE} need refinement.`;
    }
    if (counts.READY) {
      return `${counts.READY} Ticket${counts.READY === 1 ? " is" : "s are"} executable now. `
        + `${counts.REFINE} need refinement, ${counts.BLOCKED} remain blocked, and `
        + `${counts.DONE} are proven complete.`;
    }
    if (counts.REFINE) {
      return `No Ticket is executable; ${counts.REFINE} need refinement before execution. `
        + `${counts.BLOCKED} remain blocked and ${counts.DONE} are proven complete.`;
    }
    if (counts.BLOCKED) {
      return `No Ticket is executable yet; ${counts.BLOCKED} remain blocked by direct prerequisites.`;
    }
    return `${counts.DONE} Ticket${counts.DONE === 1 ? " is" : "s are"} proven complete. The graph is quiet.`;
  }

  function causalPriority(label) {
    return {
      DEVIATED: 0,
      BLOCKED: 1,
      READY: 2,
      REFINE: 3,
      DONE: 4,
    }[label] ?? 5;
  }

  function agentHandoffInstruction(ticketId, stateLabel) {
    if (stateLabel === "READY") {
      return `Execute the READY VibeHub Ticket ${ticketId} in this exact `
        + "worktree with the Skill vibehub-ticket-run.";
    }
    if (stateLabel === "REFINE") {
      return `Refine the VibeHub Ticket ${ticketId} in this exact worktree `
        + "with the Skill vibehub-ticket-plan. It is currently REFINE, so "
        + "rewrite the same Ticket's acceptance for real and set maturity: "
        + "firm before execution; do not start vibehub-ticket-run.";
    }
    return `Inspect VibeHub Ticket ${ticketId} (currently ${stateLabel}) `
      + "with the Skill vibehub-ticket-review. It is not READY, so do not "
      + "start vibehub-ticket-run for it.";
  }

  function ticketNodePresentation(ticket, { selected = false, dimmed = false } = {}) {
    const operational = ticketOperationalState(ticket);
    const attention = ticketAttentionState(ticket);
    const classNames = [
      "ticket-node",
      selected ? "selected" : "",
      dimmed ? "dimmed" : "",
      operational ? `state-${operational.key}` : "",
      attention ? `attention-${attention.key}` : "",
    ].filter(Boolean);
    const relationCounts = ticket.relationCounts || {
      prerequisites: 0,
      dependents: 0,
    };
    const ariaLabel = `${ticket.ticketId}. ${ticket.outcome}. `
      + `${relationCounts.prerequisites} prerequisites, `
      + `${relationCounts.dependents} unlocks.`
      + (operational
        ? ` ${operational.label}. ${operational.detail || ""}`
        : "")
      + (attention
        ? ` Human attention ${attention.label}. ${attention.detail || ""}`
        : "");
    return {
      className: classNames.join(" "),
      ariaLabel,
      stateLabel: operational?.label || null,
      operational,
      attention,
    };
  }

  globalThis.VibeHubWorkbenchModel = Object.freeze({
    agentHandoffInstruction,
    causalPriority,
    graphNarrative,
    graphSummary,
    operationalCounts,
    localFocusHref,
    ticketAttentionState,
    ticketNodePresentation,
    ticketOperationalState,
    workbenchOverview,
  });
})();
