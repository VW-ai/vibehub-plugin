(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const NODE = { width: 232, height: 96 };
  const LAYOUT = {
    marginX: 80,
    marginY: 76,
    columnGap: 118,
    rowGap: 58,
    sweeps: 5,
  };
  const MIN_SCALE = 0.12;
  const MAX_SCALE = 2.4;
  const TICKET_STATES = new Set([
    "READY",
    "DONE",
    "BLOCKED",
    "DEVIATED",
  ]);
  const TICKET_VIEW_IDS = new Map([
    ["execution", "execution"],
    ["contract", "contract"],
    ["log", "evidence"],
  ]);
  const focusQuery = new URLSearchParams(location.search);
  const requestedTicketId = focusQuery.get("ticket");
  const requestedViewId = TICKET_VIEW_IDS.get(focusQuery.get("view"))
    ?? "execution";

  const elements = {
    projectName: document.querySelector("#projectName"),
    sourceRef: document.querySelector("#sourceRef"),
    sourceDock: document.querySelector("#sourceDock"),
    sourceDockTitle: document.querySelector("#sourceDockTitle"),
    sourceDockContent: document.querySelector("#sourceDockContent"),
    closeSourceDock: document.querySelector("#closeSourceDock"),
    graphSummary: document.querySelector("#graphSummary"),
    graphSignal: document.querySelector("#graphSignal"),
    graphSignalCount: document.querySelector("#graphSignalCount"),
    stateDot: document.querySelector("#stateDot"),
    stateLabel: document.querySelector("#stateLabel"),
    sourceStatus: document.querySelector("#sourceStatus"),
    copyLink: document.querySelector("#copyLink"),
    workspace: document.querySelector(".workspace"),
    canvas: document.querySelector("#canvas"),
    graph: document.querySelector("#graph"),
    world: document.querySelector("#world"),
    edgeLayer: document.querySelector("#edgeLayer"),
    nodeLayer: document.querySelector("#nodeLayer"),
    minimap: document.querySelector("#minimap"),
    emptyState: document.querySelector("#emptyState"),
    loadingState: document.querySelector("#loadingState"),
    inspector: document.querySelector("#inspector"),
    closeInspector: document.querySelector("#closeInspector"),
    inspectorEyebrow: document.querySelector("#inspectorEyebrow"),
    inspectorTitle: document.querySelector("#inspectorTitle"),
    inspectorOutcome: document.querySelector("#inspectorOutcome"),
    inspectorContent: document.querySelector("#inspectorContent"),
    toast: document.querySelector("#toast"),
  };

  let token = location.hash.slice(1);
  let state = null;
  let positions = new Map();
  let selected = null;
  let lastFocusedSubject = null;
  let graphRequest = 0;
  let subjectRequest = 0;
  let panX = 0;
  let panY = 0;
  let scale = 1;
  let dragging = null;
  let suppressCanvasClick = false;
  let toastTimer = null;
  let initialFocusPending = Boolean(requestedTicketId);

  function svg(tag, attributes = {}) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    return element;
  }

  async function api(path, options = {}) {
    if (!token) {
      throw new Error(
        "The local Ticket capability is missing. Open the exact link printed by VibeHub.",
      );
    }
    const body = options.body === undefined
      ? undefined
      : JSON.stringify(options.body);
    const response = await fetch(path, {
      method: options.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
    const envelope = await response.json();
    if (!response.ok || !envelope.ok) {
      const error = new Error(
        envelope?.error?.message || `Ticket host returned ${response.status}`,
      );
      error.code = envelope?.error?.code || "host_error";
      error.status = response.status;
      error.details = envelope?.error?.details ?? null;
      throw error;
    }
    return envelope.data;
  }

  async function refresh(message) {
    const request = ++graphRequest;
    subjectRequest += 1;
    setBusy(true);
    try {
      const nextState = await api("/api/state");
      if (request !== graphRequest) return;
      subjectRequest += 1;
      state = nextState;
      selected = null;
      positions = layoutGraph(state.graph.tickets, state.graph.relations);
      renderChrome();
      renderGraph();
      renderMinimap();
      requestAnimationFrame(frameGraph);
      const focusedTicketExists = initialFocusPending
        && state.graph.tickets.some(
          (ticket) => ticket.ticketId === requestedTicketId,
        );
      initialFocusPending = false;
      if (focusedTicketExists) {
        await selectTicket(
          requestedTicketId,
          false,
          requestedViewId,
        );
      } else {
        renderGraphInspector({ open: false });
      }
      if (message) showToast(message);
      return true;
    } catch (error) {
      if (request !== graphRequest) return;
      renderError(error);
      return false;
    } finally {
      if (request === graphRequest) setBusy(false);
    }
  }

  function renderChrome() {
    const { project, graph } = state;
    const { source } = graph;
    const counts = operationalCounts(graph.tickets);
    const deviatedCount = counts.DEVIATED;
    const commit = source.resolvedCommit
      ? source.resolvedCommit.slice(0, 8)
      : "unborn";
    const worktree = worktreeBasename(source.worktreeRoot);
    elements.projectName.textContent = project.name;
    elements.sourceRef.textContent =
      `${worktree} · ${project.branch}@${commit}`;
    elements.sourceRef.title =
      `${source.worktreeRoot}\nWorktree ${source.worktreeIdentity}\nInspect exact source`;
    elements.sourceRef.setAttribute(
      "aria-label",
      `Worktree ${worktree}. Inspect exact Git source.`,
    );
    renderSourceDock();
    elements.graphSummary.textContent = graphSummary(counts);
    elements.graphSignalCount.textContent =
      `${graph.tickets.length} Ticket${graph.tickets.length === 1 ? "" : "s"}`
      + ` · ${graph.relations.length} direct unlock${graph.relations.length === 1 ? "" : "s"}`;
    document.title = `${project.name} · VibeHub Ticket graph`;
    elements.stateDot.className =
      `state-dot${
        deviatedCount > 0 ? " deviated" : source.semanticDirty ? " dirty" : ""
      }`;
    elements.stateLabel.textContent = deviatedCount > 0
      ? `${deviatedCount} execution deviation${
          deviatedCount === 1 ? "" : "s"
        }`
      : source.semanticDirty
        ? `${dirtyPathCount(source)} local change`
          + `${source.dirtyPaths.length === 1 && !source.dirtyPathsTruncated ? "" : "s"}`
        : "Exact Git source";
    elements.emptyState.hidden = graph.tickets.length !== 0;
    elements.minimap.hidden = graph.tickets.length === 0;
  }

  function renderGraph() {
    elements.edgeLayer.replaceChildren();
    elements.nodeLayer.replaceChildren();
    if (!state) return;
    const related = selected ? causalCone(selected) : null;
    const ports = relationPorts(state.graph.relations);

    for (const relation of state.graph.relations) {
      const from = positions.get(relation.prerequisiteTicketId);
      const to = positions.get(relation.dependentTicketId);
      if (!from || !to) continue;
      const group = svg("g", {
        class: classes(
          "edge",
          selected?.kind === "relation" && selected.id === relation.relationRef
            ? "selected"
            : "",
          related?.relations.has(relation.relationRef) ? "related" : "",
          related && !related.relations.has(relation.relationRef) ? "dimmed" : "",
        ),
        role: "button",
        tabindex: "0",
        "aria-label":
          `${relation.prerequisiteTicketId} unlocks ${relation.dependentTicketId}`,
      });
      group.dataset.relationRef = relation.relationRef;
      const geometry = edgeGeometry(
        from,
        to,
        relation.relationRef,
        ports.get(relation.relationRef),
      );
      group.append(
        svg("path", { class: "edge-visible", d: geometry.path }),
        svg("path", { class: "edge-arrow", d: geometry.arrow }),
        svg("circle", {
          class: "edge-control-halo",
          cx: geometry.handle.x,
          cy: geometry.handle.y,
          r: 11,
        }),
        svg("circle", {
          class: "edge-control",
          cx: geometry.handle.x,
          cy: geometry.handle.y,
          r: 3.5,
        }),
      );
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        void selectRelation(relation.relationRef);
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void selectRelation(relation.relationRef, true);
        }
      });
      elements.edgeLayer.append(group);
    }

    for (const ticket of state.graph.tickets) {
      const position = positions.get(ticket.ticketId);
      if (!position) continue;
      const operational = ticketOperationalState(ticket);
      const isSelected =
        selected?.kind === "ticket" && selected.id === ticket.ticketId;
      const group = svg("g", {
        class: classes(
          "ticket-node",
          isSelected ? "selected" : "",
          related && !related.nodes.has(ticket.ticketId) ? "dimmed" : "",
          operational ? `state-${operational.key}` : "",
        ),
        transform: `translate(${position.x} ${position.y})`,
        role: "button",
        tabindex: "0",
        "aria-label":
          `${ticket.ticketId}. ${ticket.outcome}. `
          + `${ticket.relationCounts.prerequisites} prerequisites, `
          + `${ticket.relationCounts.dependents} unlocks.`
          + (operational
            ? ` ${operational.label}. ${operational.detail || ""}`
            : ""),
      });
      group.dataset.ticketId = ticket.ticketId;
      group.append(
        svg("rect", {
          class: "ticket-boundary",
          x: 0,
          y: 0,
          width: NODE.width,
          height: NODE.height,
          rx: 8,
        }),
        svg("circle", {
          class: "ticket-aperture",
          cx: NODE.width,
          cy: NODE.height / 2,
          r: 7,
        }),
        svg("line", {
          class: "ticket-proof",
          x1: 8,
          y1: NODE.height - 1,
          x2: NODE.width - 8,
          y2: NODE.height - 1,
        }),
      );
      const id = svg("text", { class: "ticket-id", x: 14, y: 20 });
      id.textContent = shortTicketId(ticket.ticketId);
      group.append(id);
      wrap(ticket.outcome, 34, 3).forEach((line, index) => {
        const text = svg("text", {
          class: "ticket-outcome",
          x: 14,
          y: 43 + index * 15,
        });
        text.textContent = line;
        group.append(text);
      });
      const meta = svg("text", {
        class: "ticket-meta",
        x: 14,
        y: NODE.height - 10,
      });
      meta.textContent =
        `${ticket.relationCounts.prerequisites} in · `
        + `${ticket.relationCounts.dependents} out`;
      group.append(meta);
      if (operational) {
        const status = svg("text", {
          class: "ticket-state",
          x: NODE.width - 14,
          y: NODE.height - 10,
          "text-anchor": "end",
        });
        status.textContent = operational.label;
        group.append(status);
      }
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        void selectTicket(ticket.ticketId);
      });
      group.addEventListener(
        "keydown",
        (event) => onNodeKey(event, ticket.ticketId),
      );
      elements.nodeLayer.append(group);
    }
    applyTransform();
  }

  function renderMinimap() {
    elements.minimap.replaceChildren();
    const bounds = graphBounds();
    if (!bounds) return;
    elements.minimap.setAttribute(
      "viewBox",
      `${bounds.x - 20} ${bounds.y - 20} `
      + `${bounds.width + 40} ${bounds.height + 40}`,
    );
    for (const relation of state.graph.relations) {
      const from = positions.get(relation.prerequisiteTicketId);
      const to = positions.get(relation.dependentTicketId);
      if (!from || !to) continue;
      elements.minimap.append(svg("line", {
        x1: from.x + NODE.width,
        y1: from.y + NODE.height / 2,
        x2: to.x,
        y2: to.y + NODE.height / 2,
        stroke: "#a2a8ac",
        "stroke-width": 4,
      }));
    }
    for (const ticket of state.graph.tickets) {
      const position = positions.get(ticket.ticketId);
      if (!position) continue;
      const operational = ticketOperationalState(ticket);
      elements.minimap.append(svg("rect", {
        class: classes(
          "minimap-node",
          operational ? `state-${operational.key}` : "",
        ),
        x: position.x,
        y: position.y,
        width: NODE.width,
        height: NODE.height,
        rx: 7,
        "stroke-width": 3,
      }));
    }
    elements.minimap.append(svg("rect", { class: "minimap-viewport" }));
    updateMinimapViewport();
  }

  function renderGraphInspector({ open = true } = {}) {
    if (!state) return;
    const request = ++subjectRequest;
    const snapshotId = state.graph.snapshotId;
    selected = null;
    if (open) openInspector();
    else {
      elements.workspace.classList.add("inspector-closed");
      elements.inspector.classList.remove("open");
      elements.inspector.setAttribute("aria-hidden", "true");
      elements.inspector.inert = true;
    }
    elements.inspectorEyebrow.textContent = "Current graph";
    elements.inspectorTitle.textContent = "Execution context";
    elements.inspectorOutcome.hidden = false;
    const counts = operationalCounts(state.graph.tickets);
    elements.inspectorOutcome.textContent = graphNarrative(counts);
    const content = document.createDocumentFragment();
    content.append(section(
      "Execution signal",
      stateSummary(counts),
    ));
    content.append(disclosure(
      "Exact Git source",
      facts([
        ["Source", sourceLabel(state.graph.source)],
        [
          "Worktree",
          state.graph.source.worktreeRoot,
        ],
        ["Commit", state.graph.source.resolvedCommit || "unborn HEAD"],
        ["Graph", state.graph.source.graphDigest],
        [
          "Local state",
          state.graph.source.semanticDirty
            ? `${dirtyPathCount(state.graph.source)} VibeHub file changes`
              + `${state.graph.source.dirtyPathsTruncated ? " · list truncated" : ""}`
            : "matches committed VibeHub files",
        ],
      ]),
    ));
    if (state.graph.source.semanticDirty) {
      const pendingPaths = state.graph.source.dirtyPaths.map(
        (item) => ({ title: item }),
      );
      if (state.graph.source.dirtyPathsTruncated) {
        pendingPaths.push({
          title: `${dirtyPathCount(state.graph.source)} paths`,
          detail: "Additional changed paths are not shown.",
        });
      }
      content.append(
        disclosure(
          "Pending local VibeHub files",
          list(
            pendingPaths,
            (item) => item,
            "code-ref",
          ),
        ),
      );
    }
    const traceDisclosure = disclosure(
      "Git trace",
      quietMessage("Reading Git trace…"),
    );
    const traceSection = traceDisclosure.lastElementChild;
    traceSection.dataset.trace = "graph";
    content.append(traceDisclosure);
    elements.inspectorContent.replaceChildren(content);
    void loadGraphTrace(request, snapshotId, traceSection);
  }

  async function loadGraphTrace(request, snapshotId, traceSection) {
    try {
      const query = subjectQuery(snapshotId, { kind: "graph" });
      const [inspection, trace] = await Promise.all([
        api(`/api/subject?${query}`),
        api(`/api/trace?${query}`),
      ]);
      if (!isCurrentSubjectResponse(
        request,
        snapshotId,
        { kind: "graph" },
        inspection,
        trace,
      )) return;
      traceSection.replaceChildren(traceList(trace.records || []));
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      traceSection.replaceChildren(quietMessage(error.message, "error"));
      showToast(error.message);
    }
  }

  async function selectTicket(
    ticketId,
    focusInspector = false,
    initialViewId = "execution",
  ) {
    const ticket = state.graph.tickets.find(
      (item) => item.ticketId === ticketId,
    );
    if (!ticket) return;
    const request = ++subjectRequest;
    const snapshotId = state.graph.snapshotId;
    selected = { kind: "ticket", id: ticketId };
    lastFocusedSubject = selected;
    openInspector();
    elements.inspectorEyebrow.textContent =
      `Ticket · ${ticket.ticketId}`;
    elements.inspectorTitle.textContent = ticket.outcome;
    elements.inspectorOutcome.hidden = false;
    elements.inspectorOutcome.textContent = "Reading current Ticket facts…";
    elements.inspectorContent.replaceChildren(
      facts([
        ["Revision", ticket.ticketRevision],
        [
          "Topology",
          `${ticket.relationCounts.prerequisites} prerequisites · `
          + `${ticket.relationCounts.dependents} unlocks`,
        ],
      ]),
    );
    renderGraph();
    requestAnimationFrame(() => revealTicket(ticketId));
    try {
      const query = subjectQuery(snapshotId, {
        kind: "ticket",
        ticketId,
      });
      const inspection = await api(`/api/subject?${query}`);
      if (!isCurrentSubjectResponse(
        request,
        snapshotId,
        { kind: "ticket", ticketId },
        inspection,
        null,
      )) return;
      const traceTarget = renderTicketInspection(inspection, initialViewId);
      void loadSubjectTrace(
        request,
        snapshotId,
        { kind: "ticket", ticketId },
        traceTarget,
      );
      if (focusInspector) elements.inspectorTitle.focus();
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      elements.inspectorOutcome.textContent = error.message;
      showToast(error.message);
    }
  }

  function renderTicketInspection(inspection, initialViewId = "execution") {
    const subject = inspection.subject;
    if (subject?.kind !== "ticket") {
      throw new Error("Ticket inspector received the wrong subject.");
    }
    const ticket = subject.ticket;
    const contextPackage =
      subject.contextPackage ?? inspection.contextPackage ?? {};
    elements.inspectorEyebrow.textContent =
      `Ticket · ${ticket.ticketId}`;
    elements.inspectorTitle.textContent = ticket.outcome;
    const operational = ticketOperationalState(ticket);
    elements.inspectorOutcome.hidden = true;
    elements.inspectorOutcome.textContent = "";

    const execution = ticketExecutionPanel(ticket, contextPackage, operational);
    const contract = ticketContractPanel(ticket, contextPackage, inspection);
    const proof = ticketProofPanel();
    const view = tabbedTicketView(
      ticket.ticketId,
      [
        { id: "execution", label: "Execution", panel: execution },
        { id: "contract", label: "Contract", panel: contract.panel },
        { id: "evidence", label: "Log", panel: proof.panel },
      ],
      initialViewId,
    );
    const traceSection = proof.traceSection;
    traceSection.dataset.trace = "ticket";
    elements.inspectorContent.replaceChildren(view);
    return {
      traceSection,
      acceptanceRail: contract.acceptanceRail,
      contractSummary: contract.summary,
      proofSummary: proof.summary,
      acceptanceCount: (contextPackage.acceptance || []).length,
    };
  }

  async function selectRelation(
    relationRef,
    focusInspector = false,
  ) {
    const relation = state.graph.relations.find(
      (item) => item.relationRef === relationRef,
    );
    if (!relation) return;
    const request = ++subjectRequest;
    const snapshotId = state.graph.snapshotId;
    selected = { kind: "relation", id: relationRef };
    lastFocusedSubject = selected;
    openInspector();
    elements.inspectorEyebrow.textContent = "Direct unlock";
    elements.inspectorTitle.textContent =
      `${shortTicketId(relation.prerequisiteTicketId)} → `
      + shortTicketId(relation.dependentTicketId);
    elements.inspectorOutcome.textContent =
      relation.rationale || "Direct execution dependency.";
    elements.inspectorOutcome.hidden = false;
    elements.inspectorContent.replaceChildren(
      facts([
        ["Relation", relation.relationRef],
        ["From", relation.prerequisiteTicketId],
        ["To", relation.dependentTicketId],
      ]),
    );
    renderGraph();
    try {
      const query = subjectQuery(snapshotId, {
        kind: "relation",
        relationRef,
      });
      const inspection = await api(`/api/subject?${query}`);
      if (!isCurrentSubjectResponse(
        request,
        snapshotId,
        { kind: "relation", relationRef },
        inspection,
        null,
      )) return;
      const traceSection = renderRelationInspection(inspection);
      void loadSubjectTrace(
        request,
        snapshotId,
        { kind: "relation", relationRef },
        traceSection,
      );
      if (focusInspector) elements.inspectorTitle.focus();
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      elements.inspectorOutcome.textContent = error.message;
      showToast(error.message);
    }
  }

  function renderRelationInspection(inspection) {
    const subject = inspection.subject;
    if (subject?.kind !== "relation") {
      throw new Error("Relation inspector received the wrong subject.");
    }
    const relation = subject.relation;
    elements.inspectorEyebrow.textContent = "Direct unlock";
    elements.inspectorTitle.textContent =
      `${shortTicketId(relation.prerequisiteTicketId)} → `
      + shortTicketId(relation.dependentTicketId);
    elements.inspectorOutcome.textContent =
      relation.rationale || "Direct execution dependency.";
    elements.inspectorOutcome.hidden = false;
    const content = document.createDocumentFragment();
    content.append(disclosure(
      "Exact relation",
      facts([
        ["Relation", relation.relationRef],
        ["From", relation.prerequisiteTicketId],
        ["To", relation.dependentTicketId],
        ["Source", sourceLabel(inspection.source || state.graph.source)],
      ]),
    ));
    appendDisclosure(
      content,
      "Provenance",
      typedReferenceList(relation.provenanceRefs || []),
    );
    const traceDisclosure = disclosure(
      "Git trace",
      quietMessage("Reading Git trace…"),
    );
    const traceSection = traceDisclosure.lastElementChild;
    traceSection.dataset.trace = "relation";
    content.append(traceDisclosure);
    elements.inspectorContent.replaceChildren(content);
    return traceSection;
  }

  async function loadSubjectTrace(
    request,
    snapshotId,
    subject,
    traceTarget,
  ) {
    const traceSection = traceTarget?.traceSection ?? traceTarget;
    try {
      const trace = await api(
        `/api/trace?${subjectQuery(snapshotId, subject)}`,
      );
      if (
        !isCurrentSubjectRequest(request, snapshotId)
        || trace?.snapshotId !== snapshotId
        || !traceSubjectMatches(subject, trace?.subject)
      ) return;
      const records = trace.records || [];
      traceSection.replaceChildren(traceList(records));
      if (traceTarget?.proofSummary) updateTicketProof(traceTarget, records);
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      traceSection.replaceChildren(quietMessage(error.message, "error"));
      showToast(error.message);
    }
  }

  function traceSubjectMatches(expected, actual) {
    if (expected.kind !== actual?.kind) return false;
    if (expected.kind === "graph") return true;
    if (expected.kind === "ticket") {
      return expected.ticketId === actual.ticketId;
    }
    return expected.relationRef === actual.relationRef;
  }

  function subjectQuery(snapshotId, subject) {
    const query = new URLSearchParams({
      snapshotId,
      kind: subject.kind,
    });
    if (subject.kind === "ticket") {
      query.set("ticketId", subject.ticketId);
    } else if (subject.kind === "relation") {
      query.set("relationRef", subject.relationRef);
    }
    return query.toString();
  }

  function isCurrentSubjectRequest(request, snapshotId) {
    return request === subjectRequest
      && state?.graph.snapshotId === snapshotId;
  }

  function isCurrentSubjectResponse(
    request,
    snapshotId,
    subject,
    inspection,
    trace,
  ) {
    const inspectedSubject = inspection?.subject;
    const identityMatches = subject.kind === "graph"
      ? inspectedSubject?.kind === "graph"
      : subject.kind === "ticket"
        ? inspectedSubject?.kind === "ticket"
          && inspectedSubject.ticket?.ticketId === subject.ticketId
        : inspectedSubject?.kind === "relation"
          && inspectedSubject.relation?.relationRef === subject.relationRef;
    return isCurrentSubjectRequest(request, snapshotId)
      && inspection?.snapshotId === snapshotId
      && (trace === null || trace?.snapshotId === snapshotId)
      && identityMatches;
  }

  function openInspector() {
    elements.workspace.classList.remove("inspector-closed");
    elements.inspector.classList.add("open");
    elements.inspector.setAttribute("aria-hidden", "false");
    elements.inspector.inert = false;
  }

  function closeInspector() {
    const restore = selected ?? lastFocusedSubject;
    subjectRequest += 1;
    selected = null;
    elements.inspector.classList.remove("open");
    elements.workspace.classList.add("inspector-closed");
    elements.inspector.setAttribute("aria-hidden", "true");
    elements.inspector.inert = true;
    renderGraph();
    requestAnimationFrame(() => focusGraphSubject(restore));
  }

  function focusGraphSubject(subject) {
    if (!subject) return;
    const selector = subject.kind === "ticket"
      ? `[data-ticket-id="${CSS.escape(subject.id)}"]`
      : `[data-relation-ref="${CSS.escape(subject.id)}"]`;
    elements.graph.querySelector(selector)?.focus();
  }

  function facts(items) {
    const list = document.createElement("dl");
    list.className = "facts";
    for (const [label, value] of items) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const definition = document.createElement("dd");
      term.textContent = label;
      definition.textContent = value;
      row.append(term, definition);
      list.append(row);
    }
    return list;
  }

  function section(title, child) {
    const wrapper = document.createElement("section");
    wrapper.className = "inspector-section";
    const heading = document.createElement("h2");
    heading.textContent = title;
    wrapper.append(heading, child);
    return wrapper;
  }

  function disclosure(title, child, open = false) {
    const details = document.createElement("details");
    details.className = "inspector-disclosure";
    details.open = open;
    const summary = document.createElement("summary");
    summary.textContent = title;
    const body = document.createElement("div");
    body.append(child);
    details.append(summary, body);
    return details;
  }

  function appendSection(fragment, title, child) {
    if (child === null) return;
    fragment.append(section(title, child));
  }

  function appendDisclosure(fragment, title, child, open = false) {
    if (child === null) return;
    fragment.append(disclosure(title, child, open));
  }

  function list(items, project, className = "") {
    if (!items.length) return null;
    const result = document.createElement("ul");
    result.className = "quiet-list";
    for (const item of items) {
      const projected = project(item);
      const row = document.createElement("li");
      if (className) row.classList.add(className);
      if (projected.title) {
        const title = document.createElement("strong");
        title.textContent = projected.title;
        row.append(title);
      }
      if (projected.detail) {
        const detail = document.createElement("span");
        detail.textContent = projected.detail;
        row.append(detail);
      }
      result.append(row);
    }
    return result;
  }

  function relationList(relations) {
    if (!relations.length) return null;
    const wrapper = document.createElement("div");
    wrapper.className = "quiet-list";
    for (const relation of relations) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "relation-row";
      const route = document.createElement("span");
      route.className = "relation-route";
      const current = document.createElement("span");
      current.textContent = "THIS TICKET";
      const arrow = document.createElement("span");
      arrow.className = "relation-route-arrow";
      arrow.textContent = "→";
      const target = document.createElement("strong");
      target.textContent = shortTicketId(relation.targetTicketId);
      route.append(current, arrow, target);
      const detail = document.createElement("span");
      detail.className = "relation-rationale";
      detail.textContent = relation.rationale || relation.targetTicketId;
      row.append(route, detail);
      const projected = state.graph.relations.find(
        (candidate) => candidate.relationRef === relation.relationRef,
      );
      if (projected) {
        row.addEventListener(
          "click",
          () => void selectRelation(projected.relationRef),
        );
      } else {
        row.disabled = true;
      }
      wrapper.append(row);
    }
    return wrapper;
  }

  function quietMessage(message, tone = "") {
    const paragraph = document.createElement("p");
    paragraph.className = classes("quiet-message", tone);
    paragraph.textContent = message;
    return paragraph;
  }

  function textBlock(message) {
    const paragraph = document.createElement("p");
    paragraph.className = "context-copy";
    paragraph.textContent = message;
    return paragraph;
  }

  function tabbedTicketView(ticketId, tabs, initialTabId = "execution") {
    const wrapper = document.createElement("div");
    wrapper.className = "ticket-view";
    const tabList = document.createElement("div");
    tabList.className = "ticket-tabs";
    tabList.setAttribute("role", "tablist");
    tabList.setAttribute("aria-label", "Ticket inspection layers");
    const controls = [];
    const panels = [];

    const activate = (index, focus = false) => {
      controls.forEach((control, candidate) => {
        const active = candidate === index;
        control.setAttribute("aria-selected", String(active));
        control.tabIndex = active ? 0 : -1;
        panels[candidate].hidden = !active;
      });
      if (focus) controls[index].focus();
    };

    tabs.forEach((tab, index) => {
      const control = document.createElement("button");
      const controlId = `ticket-tab-${ticketId}-${tab.id}`;
      const panelId = `ticket-panel-${ticketId}-${tab.id}`;
      control.type = "button";
      control.className = "ticket-tab";
      control.id = controlId;
      control.textContent = tab.label;
      control.setAttribute("role", "tab");
      control.setAttribute("aria-controls", panelId);
      control.addEventListener("click", () => activate(index));
      control.addEventListener("keydown", (event) => {
        let next = null;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        activate(next, true);
      });

      tab.panel.classList.add("ticket-panel");
      tab.panel.id = panelId;
      tab.panel.setAttribute("role", "tabpanel");
      tab.panel.setAttribute("aria-labelledby", controlId);
      controls.push(control);
      panels.push(tab.panel);
      tabList.append(control);
      wrapper.append(tab.panel);
    });
    wrapper.prepend(tabList);
    const initialIndex = tabs.findIndex((tab) => tab.id === initialTabId);
    activate(initialIndex < 0 ? 0 : initialIndex);
    return wrapper;
  }

  function ticketExecutionPanel(ticket, contextPackage, operational) {
    const panel = document.createElement("section");
    const incoming = state.graph.relations.filter(
      (relation) => relation.dependentTicketId === ticket.ticketId,
    );
    const outgoing = state.graph.relations.filter(
      (relation) => relation.prerequisiteTicketId === ticket.ticketId,
    );
    const completed = incoming.filter((relation) => {
      const prerequisite = state.graph.tickets.find(
        (item) => item.ticketId === relation.prerequisiteTicketId,
      );
      return ticketOperationalState(prerequisite)?.label === "DONE";
    }).length;

    const signal = document.createElement("div");
    signal.className = classes(
      "ticket-signal",
      operational ? `state-${operational.key}` : "",
    );
    const heading = document.createElement("div");
    heading.className = "ticket-signal-heading";
    const marker = document.createElement("span");
    marker.className = "ticket-signal-mark";
    marker.setAttribute("aria-hidden", "true");
    const label = document.createElement("strong");
    label.textContent = operational?.label || "TICKET";
    const handoff = actionButton({
      label: "Copy for Agent",
      className: "agent-handoff",
      onClick: () => void copyPayload(
        contextPackage.agentPayload,
        `Ticket ${ticket.ticketId} copied for Agent`,
      ),
    });
    heading.append(marker, label, handoff);

    const metrics = document.createElement("div");
    metrics.className = "ticket-signal-metrics";
    metrics.append(
      signalMetric(`${completed} / ${incoming.length}`, "prerequisites"),
      signalMetric(
        String(Math.max(0, incoming.length - completed)),
        "blockers",
      ),
      signalMetric(String(outgoing.length), "unlocks"),
      signalMetric("Reading", "evidence", "proof-metric"),
    );
    signal.append(heading, metrics);
    panel.append(signal);

    if (
      operational?.detail
      && (operational.label === "BLOCKED" || operational.label === "DEVIATED")
    ) {
      const exception = document.createElement("p");
      exception.className = "ticket-exception";
      exception.textContent = operational.detail;
      panel.append(exception);
    }

    panel.append(ticketSectionHeading(
      "Causal position",
      "Direct prerequisites and immediate unlocks stay in view.",
    ));
    panel.append(causalStrip(ticket.ticketId, incoming, outgoing));

    const context = contextPackage.context;
    if (context) {
      const why = disclosure("Why this Ticket exists", textBlock(context));
      why.classList.add("ticket-why");
      panel.append(why);
    }
    return panel;
  }

  function signalMetric(value, label, extraClass = "") {
    const metric = document.createElement("span");
    metric.className = classes("ticket-metric", extraClass);
    const strong = document.createElement("strong");
    strong.textContent = value;
    const detail = document.createElement("span");
    detail.textContent = label;
    metric.append(strong, detail);
    return metric;
  }

  function causalStrip(ticketId, incoming, outgoing) {
    const strip = document.createElement("div");
    strip.className = "causal-strip";
    strip.append(
      causalGroup(
        "Requires",
        incoming.map((relation) => relation.prerequisiteTicketId),
        "No prerequisites",
      ),
      causalArrow(),
      causalCurrent(ticketId),
      causalArrow(),
      causalGroup(
        "Unlocks",
        outgoing.map((relation) => relation.dependentTicketId),
        "No direct unlock",
      ),
    );
    return strip;
  }

  function causalGroup(label, ticketIds, emptyLabel) {
    const group = document.createElement("div");
    group.className = "causal-group";
    const eyebrow = document.createElement("span");
    eyebrow.className = "causal-label";
    eyebrow.textContent = label;
    group.append(eyebrow);
    if (!ticketIds.length) {
      const empty = document.createElement("span");
      empty.className = "causal-empty";
      empty.textContent = emptyLabel;
      group.append(empty);
      return group;
    }
    const ordered = [...ticketIds].sort((left, right) =>
      causalPriority(left) - causalPriority(right)
      || left.localeCompare(right));
    ordered.slice(0, 3).forEach((ticketId) => {
      group.append(causalTicketButton(ticketId));
    });
    if (ticketIds.length > 3) {
      const all = document.createElement("details");
      all.className = "causal-more";
      const summary = document.createElement("summary");
      summary.textContent = `View all ${ticketIds.length}`;
      const body = document.createElement("div");
      ordered.slice(3).forEach((ticketId) => {
        body.append(causalTicketButton(ticketId));
      });
      all.append(summary, body);
      group.append(all);
    }
    return group;
  }

  function causalPriority(ticketId) {
    const ticket = state.graph.tickets.find((item) => item.ticketId === ticketId);
    return { DEVIATED: 0, BLOCKED: 1, READY: 2, DONE: 3 }[
      ticketOperationalState(ticket)?.label
    ] ?? 4;
  }

  function causalTicketButton(ticketId) {
    const ticket = state.graph.tickets.find((item) => item.ticketId === ticketId);
    const operational = ticketOperationalState(ticket);
    const button = document.createElement("button");
    button.type = "button";
    button.className = classes(
      "causal-ticket",
      operational ? `state-${operational.key}` : "",
    );
    button.title = ticketId;
    const marker = document.createElement("span");
    marker.className = "causal-ticket-state";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.textContent = shortTicketId(ticketId);
    button.append(marker, copy);
    button.addEventListener("click", () => void selectTicket(ticketId, true));
    return button;
  }

  function causalCurrent(ticketId) {
    const current = document.createElement("div");
    current.className = "causal-current";
    const label = document.createElement("span");
    label.textContent = "Selected";
    const title = document.createElement("strong");
    title.textContent = shortTicketId(ticketId);
    title.title = ticketId;
    current.append(label, title);
    return current;
  }

  function causalArrow() {
    const arrow = document.createElement("span");
    arrow.className = "causal-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = "→";
    return arrow;
  }

  function ticketContractPanel(ticket, contextPackage, inspection) {
    const panel = document.createElement("section");
    const acceptance = contextPackage.acceptance || [];
    const constraints = contextPackage.constraints || [];
    const contextRefs = contextPackage.contextRefs || [];
    const relations = contextPackage.relations || [];
    const provenanceRefs =
      contextPackage.provenanceRefs || ticket.provenanceRefs || [];
    const summary = contractBrief(acceptance.length);
    panel.append(summary);
    panel.append(ticketSectionHeading(
      "Acceptance conditions",
      "The exact conditions an independent Outcome can accept.",
    ));
    const acceptanceRail = acceptanceView(acceptance);
    panel.append(acceptanceRail);

    const support = document.createElement("div");
    support.className = "contract-support";
    if (constraints.length) {
      support.append(contractSupportDisclosure({
        title: "Working boundaries",
        detail: `${constraints.length} binding limit${constraints.length === 1 ? "" : "s"} on implementation`,
        count: constraints.length,
        kind: "boundary",
        body: guardrailView(constraints),
      }));
    }

    if (contextRefs.length) {
      const governed = contextRefs.filter((item) => item.canonicalContext).length;
      const sourceRefs = contextRefs.length - governed;
      support.append(contractSupportDisclosure({
        title: "Required context",
        detail: [
          `${governed} governed object${governed === 1 ? "" : "s"}`,
          `${sourceRefs} source reference${sourceRefs === 1 ? "" : "s"}`,
        ].join(" · "),
        count: contextRefs.length,
        kind: "context",
        body: contextObjectView(contextRefs),
      }));
    }

    const audit = document.createElement("div");
    audit.className = "contract-audit";
    const dependencyList = relationList(relations);
    if (dependencyList) {
      audit.append(contractAuditSection("Dependency rationale", dependencyList));
    }
    audit.append(contractAuditSection("Exact source", facts([
      ["Revision", ticket.ticketRevision],
      ["Source", sourceLabel(inspection.source || state.graph.source)],
    ])));
    const provenance = typedReferenceList(provenanceRefs);
    if (provenance) {
      audit.append(contractAuditSection("Provenance", provenance));
    }
    support.append(contractSupportDisclosure({
      title: "Dependency & source",
      detail: `${relations.length} direct dependenc${relations.length === 1 ? "y" : "ies"} · ${provenanceRefs.length} provenance reference${provenanceRefs.length === 1 ? "" : "s"}`,
      count: relations.length + provenanceRefs.length,
      kind: "audit",
      body: audit,
    }));

    if (support.childElementCount) {
      panel.append(ticketSectionHeading(
        "Supporting contract",
        "Open boundaries, context, or audit detail only when needed.",
      ));
      panel.append(support);
    }
    return { panel, acceptanceRail, summary };
  }

  function contractBrief(acceptanceCount) {
    const brief = document.createElement("div");
    brief.className = "contract-brief";
    const marker = document.createElement("span");
    marker.className = "contract-brief-mark";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "contract-brief-copy";
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "Definition of done";
    const title = document.createElement("strong");
    title.textContent = `${acceptanceCount} acceptance condition${acceptanceCount === 1 ? "" : "s"} define success`;
    copy.append(eyebrow, title);
    const status = document.createElement("div");
    status.className = "contract-brief-status";
    const statusValue = document.createElement("strong");
    statusValue.textContent = "Reading Evidence…";
    const statusDetail = document.createElement("span");
    statusDetail.textContent = "Outcome is authoritative";
    status.append(statusValue, statusDetail);
    brief.append(marker, copy, status);
    return brief;
  }

  function contractSupportDisclosure({ title, detail, count, kind, body }) {
    const disclosure = document.createElement("details");
    disclosure.className = "contract-support-disclosure";
    const summary = document.createElement("summary");
    const marker = document.createElement("span");
    marker.className = `contract-support-mark kind-${kind}`;
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "contract-support-copy";
    const label = document.createElement("strong");
    label.textContent = title;
    const description = document.createElement("span");
    description.textContent = detail;
    copy.append(label, description);
    const countLabel = document.createElement("span");
    countLabel.className = "contract-support-count";
    countLabel.textContent = String(count);
    const content = document.createElement("div");
    content.className = "contract-support-body";
    content.append(body);
    summary.append(marker, copy, countLabel);
    disclosure.append(summary, content);
    return disclosure;
  }

  function contractAuditSection(title, body) {
    const section = document.createElement("section");
    section.className = "contract-audit-section";
    const heading = document.createElement("strong");
    heading.textContent = title;
    section.append(heading, body);
    return section;
  }

  function ticketSectionHeading(title, detail) {
    const heading = document.createElement("div");
    heading.className = "ticket-section-heading";
    const label = document.createElement("h2");
    label.textContent = title;
    heading.append(label);
    if (detail) {
      const copy = document.createElement("p");
      copy.textContent = detail;
      heading.append(copy);
    }
    return heading;
  }

  function acceptanceView(items) {
    const rail = document.createElement("div");
    rail.className = "acceptance-rail";
    if (!items.length) {
      rail.append(quietMessage("No acceptance criteria were recorded."));
      return rail;
    }
    for (const item of items) {
      const row = document.createElement("details");
      row.className = "acceptance-item";
      row.dataset.acceptanceId = item.acceptanceId;
      const summary = document.createElement("summary");
      const marker = document.createElement("span");
      marker.className = "acceptance-marker";
      marker.setAttribute("aria-hidden", "true");
      const title = document.createElement("strong");
      title.textContent = humanizeIdentifier(item.acceptanceId);
      const status = document.createElement("span");
      status.className = "acceptance-status";
      status.textContent = "Awaiting evidence";
      summary.append(marker, title, status);
      const criterion = document.createElement("p");
      criterion.textContent = item.criterion;
      row.append(summary, criterion);
      rail.append(row);
    }
    return rail;
  }

  function guardrailView(items) {
    const list = document.createElement("div");
    list.className = "guardrail-list";
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "guardrail-row";
      const marker = document.createElement("span");
      marker.className = "guardrail-marker";
      marker.setAttribute("aria-hidden", "true");
      const copy = document.createElement("span");
      copy.textContent = item;
      row.append(marker, copy);
      list.append(row);
    });
    return list;
  }

  function contextObjectView(items) {
    const grid = document.createElement("div");
    grid.className = "context-grid";
    for (const item of items) {
      const object = item.canonicalContext
        ? canonicalContextObject(item)
        : sourceContextObject(item);
      grid.append(object);
    }
    return grid;
  }

  function contextObjectHeading(item, canonical) {
    const heading = document.createElement("span");
    heading.className = "context-object-heading";
    const type = document.createElement("span");
    type.className = "context-kind";
    type.textContent = canonical?.type || contextKind(item.ref);
    const title = document.createElement("strong");
    title.textContent = canonical?.summary || contextLabel(item.ref);
    const stateLabel = document.createElement("span");
    stateLabel.className = "context-state";
    stateLabel.textContent = canonical?.state || "reference";
    heading.append(type, title, stateLabel);
    return heading;
  }

  function canonicalContextObject(item) {
    const canonical = item.canonicalContext;
    const object = document.createElement("details");
    object.className = "context-object canonical-context";
    const summary = document.createElement("summary");
    summary.append(contextObjectHeading(item, canonical));
    const body = document.createElement("div");
    body.className = "context-object-body";
    const purpose = document.createElement("p");
    purpose.className = "context-purpose";
    purpose.textContent = item.purpose;
    const detail = document.createElement("p");
    detail.textContent = canonical.detail;
    body.append(purpose, detail);
    if ((canonical.tags || []).length) {
      const tags = document.createElement("div");
      tags.className = "context-tags";
      canonical.tags.forEach((tag) => {
        const token = document.createElement("span");
        token.textContent = tag;
        tags.append(token);
      });
      body.append(tags);
    }
    body.append(contextActions({
      kind: "vibehub_context",
      ref: item.ref,
      purpose: item.purpose,
      ...canonical,
    }));
    const factsView = contextFactLedger(canonical);
    if (factsView) body.append(factsView);
    object.append(summary, body);
    return object;
  }

  function sourceContextObject(item) {
    const object = document.createElement("article");
    object.className = "context-object source-context";
    object.append(contextObjectHeading(item, null));
    const purpose = document.createElement("p");
    purpose.textContent = item.purpose;
    object.append(purpose, contextActions({
      kind: "vibehub_source_reference",
      ref: item.ref,
      purpose: item.purpose,
    }));
    return object;
  }

  function contextFactLedger(canonical) {
    const ledger = document.createElement("div");
    ledger.className = "context-ledger";
    const source = contextSourceView(canonical.source);
    if (source) ledger.append(source);
    const evidence = contextEvidenceView(canonical.evidence || []);
    if (evidence) ledger.append(evidence);
    const relations = contextRelationsView(canonical.relations || []);
    if (relations) ledger.append(relations);
    const identity = document.createElement("div");
    identity.className = "context-identity";
    const label = document.createElement("span");
    label.textContent = "Context ID";
    const value = document.createElement("code");
    value.textContent = canonical.contextId;
    identity.append(label, value);
    ledger.append(identity);
    return ledger;
  }

  function contextSourceView(source) {
    if (!source) return null;
    const section = contextLedgerSection("Source", "The exact moment this Context entered the project.");
    const card = document.createElement("article");
    card.className = "context-source-card";
    if (source.quote) {
      const quote = document.createElement("blockquote");
      quote.textContent = source.quote;
      card.append(quote);
    }
    card.append(contextReferenceMeta(source.ref, source.captured_at));
    section.append(card);
    return section;
  }

  function contextEvidenceView(items) {
    if (!items.length) return null;
    const section = contextLedgerSection(
      "Evidence",
      `${items.length} durable record${items.length === 1 ? "" : "s"} supporting this Context.`,
    );
    const list = document.createElement("div");
    list.className = "context-evidence-list";
    items.forEach((item) => {
      const row = document.createElement("article");
      row.className = "context-evidence-row";
      const marker = document.createElement("span");
      marker.className = "context-evidence-marker";
      marker.setAttribute("aria-hidden", "true");
      const copy = document.createElement("div");
      const note = document.createElement("p");
      note.textContent = item.note;
      copy.append(note, contextReferenceMeta(item.ref));
      row.append(marker, copy);
      list.append(row);
    });
    section.append(list);
    return section;
  }

  function contextRelationsView(items) {
    if (!items.length) return null;
    const section = contextLedgerSection(
      "Relations",
      `${items.length} canonical Context connection${items.length === 1 ? "" : "s"}.`,
    );
    const list = document.createElement("div");
    list.className = "context-relation-list";
    items.forEach((item) => {
      const row = document.createElement("div");
      row.className = "context-relation-row";
      const type = document.createElement("span");
      type.textContent = humanizeIdentifier(item.type || "relates to");
      const arrow = document.createElement("span");
      arrow.textContent = "→";
      const target = document.createElement("code");
      target.textContent = item.target_context_id || item.targetContextId || "Context";
      row.append(type, arrow, target);
      list.append(row);
    });
    section.append(list);
    return section;
  }

  function contextLedgerSection(title, detail) {
    const section = document.createElement("section");
    section.className = "context-ledger-section";
    const heading = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = title;
    const description = document.createElement("span");
    description.textContent = detail;
    heading.append(label, description);
    section.append(heading);
    return section;
  }

  function contextReferenceMeta(reference, instant = null) {
    const meta = document.createElement("div");
    meta.className = "context-reference-meta";
    const kind = document.createElement("span");
    kind.className = "reference-kind";
    kind.textContent = referenceKindFromValue(reference);
    const ref = document.createElement("code");
    ref.textContent = reference;
    ref.title = reference;
    meta.append(kind, ref);
    if (instant) {
      const time = document.createElement("time");
      time.dateTime = instant;
      time.textContent = formatInstant(instant);
      meta.append(time);
    }
    return meta;
  }

  function referenceKindFromValue(reference) {
    if (/^https?:/u.test(reference)) return "url";
    if (/^(?:commit|git):/u.test(reference)) return "commit";
    if (/^conversation:/u.test(reference)) return "conversation";
    if (/^test:/u.test(reference)) return "test";
    if (/^browser:/u.test(reference)) return "browser";
    if (/\.(?:md|ya?ml|json|m?js|css|html)$/u.test(reference)) return "file";
    return "reference";
  }

  function contextActions(payload) {
    const actions = document.createElement("div");
    actions.className = "object-actions";
    actions.append(actionButton({
      label: "Copy for Agent",
      className: "agent-handoff compact",
      onClick: () => void copyPayload(payload, "Context copied for Agent"),
    }));
    return actions;
  }

  function contextKind(reference) {
    const name = reference.split("/").at(-1) || reference;
    const prefix = name.split("-")[0];
    if (["decision", "constraint", "contract", "convention"].includes(prefix)) {
      return prefix;
    }
    if (/\.(?:md|yaml)$/u.test(name)) return "document";
    return "source";
  }

  function contextLabel(reference) {
    const name = (reference.split("/").at(-1) || reference)
      .replace(/\.(?:yaml|md|js|css|html)$/u, "")
      .replace(/^(?:decision|constraint|contract|convention)-/u, "");
    return humanizeIdentifier(name);
  }

  function humanizeIdentifier(value) {
    const normalized = String(value).replace(/-/gu, " ");
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
  }

  function ticketProofPanel() {
    const panel = document.createElement("section");
    const summary = document.createElement("div");
    summary.className = "proof-summary";
    const label = document.createElement("strong");
    label.textContent = "Reading Evidence…";
    const detail = document.createElement("span");
    detail.textContent = "Acceptance-linked Evidence and independent Outcome appear here.";
    summary.append(label, detail);
    panel.append(summary);
    panel.append(ticketSectionHeading(
      "Evidence & Outcome",
      "Chronological Evidence and Outcome from the exact Git source.",
    ));
    const traceSection = document.createElement("div");
    traceSection.append(quietMessage("Reading Git trace…"));
    panel.append(traceSection);
    return { panel, traceSection, summary };
  }

  function updateTicketProof(target, records) {
    const evidence = records.filter((record) => record.kind === "evidence");
    const outcomes = records.filter((record) => record.kind === "outcome");
    const evidenced = new Set(evidence.flatMap(
      (record) => record.acceptanceIds || [],
    ));
    const accepted = new Set(outcomes.flatMap(
      (record) => record.acceptedAcceptanceIds || [],
    ));
    const unresolved = new Set(outcomes.flatMap(
      (record) => record.unresolvedAcceptanceIds || [],
    ));

    const contractStatus = target.contractSummary.querySelector(
      ".contract-brief-status",
    );
    const contractValue = contractStatus.querySelector("strong");
    const contractDetail = contractStatus.querySelector("span");
    contractStatus.classList.remove("is-complete", "has-attention");
    if (outcomes.length) {
      contractValue.textContent = unresolved.size
        ? `${accepted.size} accepted · ${unresolved.size} unresolved`
        : `${accepted.size} / ${target.acceptanceCount} accepted`;
      contractDetail.textContent = "Independent Outcome recorded";
      contractStatus.classList.add(
        unresolved.size ? "has-attention" : "is-complete",
      );
    } else {
      contractValue.textContent = `${evidenced.size} / ${target.acceptanceCount} evidenced`;
      contractDetail.textContent = "Independent Outcome pending";
    }

    const metric = elements.inspectorContent.querySelector(".proof-metric strong");
    if (metric) metric.textContent = `${evidenced.size} / ${target.acceptanceCount}`;
    const label = target.proofSummary.querySelector("strong");
    const detail = target.proofSummary.querySelector("span");
    if (!records.length) {
      label.textContent = "No Evidence recorded yet";
      detail.textContent = `${target.acceptanceCount} criteria await acceptance-linked Evidence.`;
    } else {
      label.textContent = `${evidence.length} Evidence · ${outcomes.length ? "Outcome recorded" : "Outcome pending"}`;
      detail.textContent = `${evidenced.size} of ${target.acceptanceCount} criteria have Evidence attached.`;
    }

    target.acceptanceRail.querySelectorAll("[data-acceptance-id]").forEach((row) => {
      const id = row.dataset.acceptanceId;
      const status = row.querySelector(".acceptance-status");
      row.classList.remove("has-evidence", "is-accepted", "is-unresolved");
      if (accepted.has(id)) {
        row.classList.add("is-accepted");
        status.textContent = "Accepted";
      } else if (unresolved.has(id)) {
        row.classList.add("is-unresolved");
        status.textContent = "Unresolved";
      } else if (evidenced.has(id)) {
        row.classList.add("has-evidence");
        status.textContent = "Evidence attached";
      } else {
        status.textContent = "Awaiting evidence";
      }
    });
  }

  function traceList(records) {
    if (!records.length) {
      return quietMessage("No Git trace facts are bound to this exact subject.");
    }
    const result = document.createElement("div");
    result.className = "trace-list";
    for (const record of records) {
      const row = document.createElement("article");
      const historical = String(record.status || "").startsWith("historical");
      const tone = historical ? "" : traceTone(record);
      row.className = classes(
        "trace-row",
        `kind-${record.kind}`,
        historical ? "historical" : "",
        tone ? `trace-${tone}` : "",
      );

      const marker = document.createElement("span");
      marker.className = "trace-marker";
      marker.setAttribute("aria-hidden", "true");

      const copy = document.createElement("div");
      copy.className = "trace-copy";
      const heading = document.createElement("div");
      heading.className = "trace-heading";
      const headingCopy = document.createElement("div");
      const title = document.createElement("strong");
      title.className = "trace-title";
      title.textContent = record.summary;
      title.title = record.summary;
      const meta = document.createElement("span");
      meta.className = "trace-meta";
      meta.textContent = [
        record.subkind || record.kind,
        record.status || "recorded",
        formatInstant(record.occurredAt),
      ].join(" · ");
      headingCopy.append(title, meta);
      heading.append(headingCopy, actionButton({
        label: "Copy for Agent",
        className: "agent-handoff compact",
        onClick: () => void copyPayload(
          record.agentPayload || record,
          `${humanizeIdentifier(record.kind)} copied for Agent`,
        ),
      }));
      copy.append(heading);
      if (record.summary.length > 220) {
        const complete = document.createElement("details");
        complete.className = "trace-record-details";
        const completeSummary = document.createElement("summary");
        completeSummary.textContent = "Read complete record";
        const completeBody = document.createElement("p");
        completeBody.textContent = record.summary;
        complete.append(completeSummary, completeBody);
        copy.append(complete);
      }
      const decision = traceDecisionDetails(record.decision);
      if (decision) copy.append(decision);
      if (record.body) {
        const body = document.createElement("p");
        body.textContent = record.body;
        copy.append(body);
      }
      const targets = traceTargets(record.targets || []);
      if (targets) copy.append(targets);
      row.append(marker, copy);
      result.append(row);
    }
    return result;
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

  function operationalCounts(tickets) {
    const counts = { READY: 0, BLOCKED: 0, DONE: 0, DEVIATED: 0 };
    for (const ticket of tickets) {
      const label = ticketOperationalState(ticket)?.label;
      if (label && Object.hasOwn(counts, label)) counts[label] += 1;
    }
    return counts;
  }

  function graphSummary(counts) {
    const parts = [];
    if (counts.READY) parts.push(`${counts.READY} ready`);
    if (counts.BLOCKED) parts.push(`${counts.BLOCKED} blocked`);
    if (counts.DEVIATED) parts.push(`${counts.DEVIATED} deviation${counts.DEVIATED === 1 ? "" : "s"}`);
    if (!parts.length && counts.DONE) parts.push(`${counts.DONE} proven`);
    return parts.join(" · ") || "No executable Tickets";
  }

  function graphNarrative(counts) {
    if (counts.DEVIATED) {
      return `${counts.DEVIATED} execution deviation${counts.DEVIATED === 1 ? "" : "s"} need attention. `
        + `${counts.READY} Ticket${counts.READY === 1 ? " is" : "s are"} executable now.`;
    }
    if (counts.READY) {
      return `${counts.READY} Ticket${counts.READY === 1 ? " is" : "s are"} executable now. `
        + `${counts.BLOCKED} remain blocked and ${counts.DONE} are proven complete.`;
    }
    if (counts.BLOCKED) {
      return `No Ticket is executable yet; ${counts.BLOCKED} remain blocked by direct prerequisites.`;
    }
    return `${counts.DONE} Ticket${counts.DONE === 1 ? " is" : "s are"} proven complete. The graph is quiet.`;
  }

  function stateSummary(counts) {
    const result = document.createElement("div");
    result.className = "execution-state-copy";
    const primary = document.createElement("strong");
    primary.textContent = graphSummary(counts);
    const detail = document.createElement("span");
    detail.textContent = "Select a Ticket or direct unlock to reveal its exact bounded context and Git trace.";
    result.append(primary, detail);
    return result;
  }

  function executionStateView(ticket) {
    const operational = ticketOperationalState(ticket);
    if (!operational) return null;
    const wrapper = document.createElement("div");
    wrapper.className = classes(
      "execution-state",
      `state-${operational.key}`,
    );
    wrapper.setAttribute(
      "aria-label",
      `${operational.label}. ${operational.detail}`,
    );

    const marker = document.createElement("span");
    marker.className = "execution-state-mark";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "execution-state-copy";
    const label = document.createElement("strong");
    label.textContent = operational.label;
    copy.append(label);
    if (operational.detail) {
      const detail = document.createElement("span");
      detail.textContent = operational.detail;
      copy.append(detail);
    }
    wrapper.append(marker, copy);

    const references = executionStateReferences(operational.references);
    if (references) wrapper.append(references);
    return wrapper;
  }

  function executionStateReferences(references) {
    if (!references.length) return null;
    const wrapper = document.createElement("div");
    wrapper.className = "execution-state-references";
    for (const reference of references) {
      const button = document.createElement("button");
      const linkedTicket = state.graph.tickets.find(
        (ticket) => ticket.ticketId === reference.ref,
      );
      button.type = "button";
      button.textContent = reference.label
        ? `${reference.label} · ${compactReference(reference.ref)}`
        : compactReference(reference.ref);
      button.title = reference.ref;
      if (linkedTicket) {
        button.addEventListener(
          "click",
          () => void selectTicket(linkedTicket.ticketId, true),
        );
      } else {
        button.disabled = true;
      }
      wrapper.append(button);
    }
    return wrapper;
  }

  function compactReference(value) {
    if (value.length <= 38) return value;
    return `${value.slice(0, 22)}…${value.slice(-10)}`;
  }

  function traceTone(record) {
    if (record.kind !== "outcome") return "";
    const terminal = String(record.subkind || record.status || "")
      .replace(/^historical_/u, "");
    if (terminal === "successful") return "done";
    if (terminal === "deviated" || terminal === "failed") return "deviated";
    if (terminal === "partial" || terminal === "stale") return "blocked";
    return "";
  }

  function traceDecisionDetails(decision) {
    if (!decision) return null;
    const details = document.createElement("dl");
    details.className = "trace-decision";
    const append = (label, value) => {
      if (
        value === undefined
        || value === null
        || value === ""
        || (Array.isArray(value) && value.length === 0)
      ) return;
      const term = document.createElement("dt");
      term.textContent = label;
      const definition = document.createElement("dd");
      definition.textContent = Array.isArray(value)
        ? value.join("\n")
        : value;
      details.append(term, definition);
    };
    append("Decision", decision.disposition);
    if (decision.decisionType === "protected_boundary") {
      append("Boundary", decision.boundary);
      append("Selection", decision.selection);
    } else {
      append("Delegated boundaries", decision.delegatedBoundaries);
    }
    append("Resolution refs", decision.resolutionRefs);
    return details;
  }

  function traceTargets(targets) {
    if (!targets.length) return null;
    const wrapper = document.createElement("div");
    wrapper.className = "trace-targets";
    const overview = document.createElement("span");
    overview.className = "reference-overview";
    overview.textContent = `${targets.length} reference${targets.length === 1 ? "" : "s"}`;
    wrapper.append(overview);
    for (const target of targets) {
      const reference = document.createElement("span");
      reference.className = `typed-reference kind-${target.kind || "reference"}`;
      const kind = document.createElement("span");
      kind.className = "reference-kind";
      kind.textContent = target.kind || "reference";
      const label = target.href || target.actions?.githubHref
        ? document.createElement("a")
        : document.createElement("span");
      label.className = "reference-label";
      const labelText = target.label || compactReference(target.target);
      label.title = target.target;
      if (label instanceof HTMLAnchorElement) {
        label.href = target.href || target.actions.githubHref;
        label.target = "_blank";
        label.rel = "noreferrer";
        label.classList.add("linked-reference");
        label.title = target.actions?.githubHref
          ? `Open ${target.target} on GitHub`
          : `Open ${target.target}`;
        label.append(document.createTextNode(labelText), externalLinkIcon());
      } else {
        label.textContent = labelText;
      }
      reference.append(kind, label);
      wrapper.append(reference);
    }
    return wrapper;
  }

  function typedReferenceList(items) {
    if (!items.length) return null;
    const wrapper = document.createElement("div");
    wrapper.className = "typed-reference-list";
    for (const item of items) {
      const normalized = typeof item === "string"
        ? { kind: "reference", label: compactReference(item), target: item }
        : item;
      const row = document.createElement("div");
      row.className = `typed-reference kind-${normalized.kind || "reference"}`;
      const kind = document.createElement("span");
      kind.className = "reference-kind";
      kind.textContent = normalized.kind || "reference";
      const label = document.createElement("span");
      label.className = "reference-label";
      label.textContent = normalized.label;
      label.title = normalized.target;
      row.append(kind, label);
      wrapper.append(row);
    }
    return wrapper;
  }

  function formatInstant(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) return value;
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function layoutGraph(tickets, relations) {
    const ids = tickets.map((ticket) => ticket.ticketId).sort();
    const outgoing = new Map(ids.map((id) => [id, []]));
    const incoming = new Map(ids.map((id) => [id, []]));
    const indegree = new Map(ids.map((id) => [id, 0]));
    for (const relation of relations) {
      if (!outgoing.has(relation.prerequisiteTicketId)
        || !incoming.has(relation.dependentTicketId)) {
        continue;
      }
      outgoing
        .get(relation.prerequisiteTicketId)
        .push(relation.dependentTicketId);
      incoming
        .get(relation.dependentTicketId)
        .push(relation.prerequisiteTicketId);
      indegree.set(
        relation.dependentTicketId,
        indegree.get(relation.dependentTicketId) + 1,
      );
    }
    for (const values of [...outgoing.values(), ...incoming.values()]) {
      values.sort();
    }
    const rank = new Map(ids.map((id) => [id, 0]));
    const queue = ids.filter((id) => indegree.get(id) === 0);
    const visited = [];
    while (queue.length) {
      queue.sort();
      const id = queue.shift();
      visited.push(id);
      for (const dependent of outgoing.get(id)) {
        rank.set(
          dependent,
          Math.max(rank.get(dependent), rank.get(id) + 1),
        );
        indegree.set(dependent, indegree.get(dependent) - 1);
        if (indegree.get(dependent) === 0) queue.push(dependent);
      }
    }
    if (visited.length !== ids.length) {
      throw new Error("The Ticket graph contains a cycle and cannot be laid out.");
    }
    const layers = new Map();
    for (const id of ids) {
      const layer = rank.get(id);
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(id);
    }
    const orderedLayers = [...layers.entries()]
      .sort((left, right) => left[0] - right[0]);
    const indexMap = () => new Map(
      orderedLayers.flatMap(
        ([, layer]) => layer.map((id, index) => [id, index]),
      ),
    );
    for (let sweep = 0; sweep < LAYOUT.sweeps; sweep += 1) {
      const forward = sweep % 2 === 0;
      const sequence = forward
        ? orderedLayers
        : [...orderedLayers].reverse();
      const indices = indexMap();
      for (const [, layer] of sequence) {
        layer.sort((left, right) => {
          const leftNeighbors =
            forward ? incoming.get(left) : outgoing.get(left);
          const rightNeighbors =
            forward ? incoming.get(right) : outgoing.get(right);
          return barycenter(leftNeighbors, indices)
            - barycenter(rightNeighbors, indices)
            || left.localeCompare(right);
        });
      }
    }
    const result = new Map();
    for (const [layerIndex, layer] of orderedLayers) {
      layer.forEach((id, row) => {
        result.set(id, {
          x: LAYOUT.marginX
            + layerIndex * (NODE.width + LAYOUT.columnGap),
          y: LAYOUT.marginY + row * (NODE.height + LAYOUT.rowGap),
        });
      });
    }
    return result;
  }

  function barycenter(neighbors, indices) {
    if (!neighbors.length) return Number.MAX_SAFE_INTEGER;
    return neighbors.reduce(
      (sum, id) => sum + (indices.get(id) ?? 0),
      0,
    ) / neighbors.length;
  }

  function relationPorts(relations) {
    const incoming = new Map();
    for (const relation of relations) {
      if (!incoming.has(relation.dependentTicketId)) {
        incoming.set(relation.dependentTicketId, []);
      }
      incoming.get(relation.dependentTicketId).push(relation);
    }
    const result = new Map(relations.map((relation) => [
      relation.relationRef,
      { target: 0 },
    ]));
    const assign = (groups, endpoint, orderBy) => {
      for (const group of groups.values()) {
        group.sort((left, right) =>
          orderBy(left).localeCompare(orderBy(right))
          || left.relationRef.localeCompare(right.relationRef));
        group.forEach((relation, index) => {
          result.get(relation.relationRef)[endpoint] =
            (index - (group.length - 1) / 2) * 14;
        });
      }
    };
    assign(incoming, "target", (relation) => relation.prerequisiteTicketId);
    return result;
  }

  function edgeGeometry(from, to, relationRef, ports = {}) {
    const x1 = from.x + NODE.width + 7;
    const y1 = from.y + NODE.height / 2;
    const x2 = to.x - 2;
    const y2 = to.y + NODE.height / 2;
    const arrow =
      `M ${x2 - 7} ${y2 - 3.5} L ${x2} ${y2} `
      + `L ${x2 - 7} ${y2 + 3.5} Z`;
    const handleX = clamp(
      x2 - 30 - (ports.target || 0),
      x1 + 18,
      x2 - 12,
    );
    if (Math.abs(y2 - y1) < 1) {
      return {
        path: `M ${x1} ${y1} H ${x2}`,
        arrow,
        handle: { x: handleX, y: y1 },
      };
    }
    const lane = stableLane(relationRef);
    const ratio = 0.5 + lane * 0.035;
    const mid = clamp(
      x1 + (x2 - x1) * ratio,
      x1 + 34,
      x2 - 28,
    );
    return {
      path: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`,
      arrow,
      handle: { x: Math.max(mid + 10, handleX), y: y2 },
    };
  }

  function stableLane(value) {
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.codePointAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (Math.abs(hash) % 7) - 3;
  }

  function graphBounds() {
    if (!positions.size) return null;
    const values = [...positions.values()];
    const minX = Math.min(...values.map((value) => value.x));
    const minY = Math.min(...values.map((value) => value.y));
    const maxX = Math.max(
      ...values.map((value) => value.x + NODE.width),
    );
    const maxY = Math.max(
      ...values.map((value) => value.y + NODE.height),
    );
    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  function fitGraph() {
    const bounds = graphBounds();
    if (!bounds) return;
    const { width, height } = visibleCanvasViewport();
    const padding = 74;
    scale = clamp(
      Math.min(
        (width - padding * 2) / bounds.width,
        (height - padding * 2) / bounds.height,
      ),
      MIN_SCALE,
      1.2,
    );
    panX = (width - bounds.width * scale) / 2 - bounds.x * scale;
    panY = (height - bounds.height * scale) / 2 - bounds.y * scale;
    applyTransform();
  }

  function frameGraph() {
    const bounds = graphBounds();
    if (!bounds) return;
    const { width, height } = visibleCanvasViewport();
    const padding = 58;
    const fitScale = Math.min(
      (width - padding * 2) / bounds.width,
      (height - padding * 2) / bounds.height,
    );
    scale = clamp(Math.max(fitScale, 0.64), MIN_SCALE, 1);
    panX = bounds.width * scale <= width - padding * 2
      ? (width - bounds.width * scale) / 2 - bounds.x * scale
      : padding - bounds.x * scale;
    panY =
      (height - bounds.height * scale) / 2 - bounds.y * scale;
    applyTransform();
  }

  function zoomAt(nextScale, x, y) {
    const { width, height } = visibleCanvasViewport();
    const screenX = x ?? width / 2;
    const screenY = y ?? height / 2;
    const worldX = (screenX - panX) / scale;
    const worldY = (screenY - panY) / scale;
    scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    panX = screenX - worldX * scale;
    panY = screenY - worldY * scale;
    applyTransform();
  }

  function applyTransform() {
    elements.world.setAttribute(
      "transform",
      `translate(${panX} ${panY}) scale(${scale})`,
    );
    elements.graph.classList.toggle("lod-low", scale < 0.48);
    updateMinimapViewport();
  }

  function revealTicket(ticketId) {
    if (window.innerWidth <= 720
      || !elements.inspector.classList.contains("open")) return;
    const position = positions.get(ticketId);
    if (!position) return;
    const { width, height } = visibleCanvasViewport();
    const sideMargin = Math.min(34, width * 0.08);
    const topMargin = Math.min(86, height * 0.16);
    const bottomMargin = Math.min(38, height * 0.08);
    const left = panX + position.x * scale;
    const right = panX + (position.x + NODE.width) * scale;
    const top = panY + position.y * scale;
    const bottom = panY + (position.y + NODE.height) * scale;
    let deltaX = 0;
    let deltaY = 0;
    if (left < sideMargin) deltaX = sideMargin - left;
    else if (right > width - sideMargin) {
      deltaX = width - sideMargin - right;
    }
    if (top < topMargin) deltaY = topMargin - top;
    else if (bottom > height - bottomMargin) {
      deltaY = height - bottomMargin - bottom;
    }
    if (deltaX === 0 && deltaY === 0) return;
    panX += deltaX;
    panY += deltaY;
    applyTransform();
  }

  function visibleCanvasViewport() {
    const canvasRect = elements.canvas.getBoundingClientRect();
    const mobileInspector =
      window.innerWidth <= 760
      && elements.inspector.classList.contains("open");
    const inspectorHeight = mobileInspector
      ? elements.inspector.getBoundingClientRect().height
      : 0;
    return {
      width: canvasRect.width,
      height: Math.max(120, canvasRect.height - inspectorHeight),
    };
  }

  function updateMinimapViewport() {
    const viewport = elements.minimap.querySelector(".minimap-viewport");
    if (!viewport || scale <= 0) return;
    const { width, height } = visibleCanvasViewport();
    viewport.setAttribute("x", String(-panX / scale));
    viewport.setAttribute("y", String(-panY / scale));
    viewport.setAttribute("width", String(width / scale));
    viewport.setAttribute("height", String(height / scale));
  }

  function minimapWorldPoint(clientX, clientY) {
    const matrix = elements.minimap.getScreenCTM();
    const viewBox = elements.minimap.viewBox.baseVal;
    if (!matrix || viewBox.width <= 0 || viewBox.height <= 0) return null;
    const point = elements.minimap.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    const world = point.matrixTransform(matrix.inverse());
    return {
      x: clamp(world.x, viewBox.x, viewBox.x + viewBox.width),
      y: clamp(world.y, viewBox.y, viewBox.y + viewBox.height),
    };
  }

  function causalCone(subject) {
    const selectedRelation = subject.kind === "relation"
      ? state.graph.relations.find(
        (item) => item.relationRef === subject.id,
      )
      : null;
    const upstreamSeed = subject.kind === "ticket"
      ? subject.id
      : selectedRelation?.prerequisiteTicketId;
    const downstreamSeed = subject.kind === "ticket"
      ? subject.id
      : selectedRelation?.dependentTicketId;
    const upstream = directionalCone(upstreamSeed, "upstream");
    const downstream = directionalCone(downstreamSeed, "downstream");
    const nodes = new Set([...upstream.nodes, ...downstream.nodes]);
    const relations = new Set([
      ...upstream.relations,
      ...downstream.relations,
    ]);
    if (selectedRelation) relations.add(selectedRelation.relationRef);
    return { nodes, relations };
  }

  function directionalCone(seed, direction) {
    const nodes = new Set(seed ? [seed] : []);
    const relations = new Set();
    const queue = seed ? [seed] : [];
    while (queue.length) {
      const ticketId = queue.shift();
      for (const relation of state.graph.relations) {
        const matches = direction === "upstream"
          ? relation.dependentTicketId === ticketId
          : relation.prerequisiteTicketId === ticketId;
        if (!matches) continue;
        relations.add(relation.relationRef);
        const next = direction === "upstream"
          ? relation.prerequisiteTicketId
          : relation.dependentTicketId;
        if (!nodes.has(next)) {
          nodes.add(next);
          queue.push(next);
        }
      }
    }
    return { nodes, relations };
  }

  function onNodeKey(event, ticketId) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      void selectTicket(ticketId, true);
      return;
    }
    if (event.key === "Escape") {
      closeInspector();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const relation = state.graph.relations.find((item) =>
      event.key === "ArrowLeft"
        ? item.dependentTicketId === ticketId
        : item.prerequisiteTicketId === ticketId,
    );
    const target = event.key === "ArrowLeft"
      ? relation?.prerequisiteTicketId
      : relation?.dependentTicketId;
    if (!target) return;
    elements.nodeLayer
      .querySelector(`[data-ticket-id="${CSS.escape(target)}"]`)
      ?.focus();
  }

  function setBusy(busy) {
    elements.loadingState.hidden = !busy;
    elements.sourceStatus.disabled = busy;
  }

  function renderError(error) {
    openInspector();
    elements.loadingState.hidden = true;
    elements.stateDot.className = "state-dot error";
    elements.stateLabel.textContent = "Unavailable";
    elements.graphSummary.textContent = "Graph unavailable";
    elements.inspectorTitle.textContent = "Ticket graph unavailable";
    elements.inspectorOutcome.textContent = token
      ? error.message
      : "This address is missing its short-lived access fragment. Return to the terminal that launched VibeHub and copy the complete URL, including the text after #.";
    elements.inspectorContent.replaceChildren();
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => elements.toast.classList.remove("visible"),
      2400,
    );
  }

  function sourceLabel(source) {
    if (!source) return "unknown";
    const commit = source.resolvedCommit
      ? source.resolvedCommit.slice(0, 8)
      : "unborn";
    return `${worktreeBasename(source.worktreeRoot)} · ${commit}`
      + `${source.semanticDirty ? " · local changes" : ""}`;
  }

  function renderSourceDock() {
    if (!state || !elements.sourceDockContent) return;
    const source = state.graph.source;
    elements.sourceDockTitle.textContent =
      `${worktreeBasename(source.worktreeRoot)} · ${state.project.branch}`;
    const content = document.createDocumentFragment();
    const summary = document.createElement("div");
    summary.className = "source-dock-summary";
    const stateMark = document.createElement("span");
    stateMark.className = classes(
      "source-dock-mark",
      source.semanticDirty ? "dirty" : "exact",
    );
    const copy = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = source.semanticDirty
      ? `${dirtyPathCount(source)} local VibeHub change${source.dirtyPaths.length === 1 ? "" : "s"}`
      : "Exact checked-in VibeHub source";
    const detail = document.createElement("span");
    detail.textContent = `${state.project.branch} @ ${source.resolvedCommit?.slice(0, 10) || "unborn"}`;
    copy.append(label, detail);
    summary.append(stateMark, copy);
    content.append(summary);

    const actions = document.createElement("div");
    actions.className = "source-dock-actions";
    actions.append(actionButton({
      label: "Copy for Agent",
      className: "agent-handoff",
      onClick: () => void copyPayload(source.agentPayload, "Git source copied for Agent"),
    }));
    appendOpenActions(actions, source.actions?.worktree);
    appendExternalAction(actions, source.actions?.repository, "GitHub repo");
    appendExternalAction(actions, source.actions?.commit, "Exact commit");
    content.append(actions);
    content.append(facts([
      ["Worktree", source.worktreeRoot],
      ["Branch", source.branch || "detached"],
      ["Commit", source.resolvedCommit || "unborn HEAD"],
      ["Remote", source.remoteOrigin || "No recognized remote"],
      ["Graph", shortDigest(source.graphDigest)],
    ]));
    if (source.semanticDirty) {
      content.append(list(
        source.dirtyPaths.map((path) => ({ title: path })),
        (item) => item,
        "code-ref",
      ));
    }
    elements.sourceDockContent.replaceChildren(content);
  }

  function appendOpenActions(container, actions) {
    appendExternalAction(container, actions?.editorHref, "Open in VS Code");
    appendExternalAction(container, actions?.githubHref, "View HEAD on GitHub");
  }

  function appendExternalAction(container, href, label) {
    if (!href) return;
    const link = document.createElement("a");
    link.className = "mechanical-link";
    link.href = href;
    link.textContent = label;
    link.title = href;
    if (/^https?:/u.test(href)) {
      link.target = "_blank";
      link.rel = "noreferrer";
    }
    container.append(link);
  }

  function copyIcon() {
    const icon = svg("svg", {
      viewBox: "0 0 16 16",
      "aria-hidden": "true",
    });
    icon.append(
      svg("rect", { x: 5.25, y: 5.25, width: 7.5, height: 7.5, rx: 1.25 }),
      svg("path", { d: "M10.5 5.25V4.5A1.25 1.25 0 0 0 9.25 3.25H4.5A1.25 1.25 0 0 0 3.25 4.5v4.75A1.25 1.25 0 0 0 4.5 10.5h.75" }),
    );
    return icon;
  }

  function externalLinkIcon() {
    const icon = svg("svg", {
      viewBox: "0 0 16 16",
      "aria-hidden": "true",
    });
    icon.classList.add("reference-link-icon");
    icon.append(
      svg("path", { d: "M6.25 3.75h6v6" }),
      svg("path", { d: "M12.25 3.75 5.5 10.5" }),
      svg("path", { d: "M10.5 8.75v2.5a1 1 0 0 1-1 1h-5.75v-8h3" }),
    );
    return icon;
  }

  function actionButton({ label, onClick, className = "" }) {
    const button = document.createElement("button");
    button.className = classes("object-action", className);
    button.type = "button";
    button.append(copyIcon(), document.createTextNode(label));
    button.addEventListener("click", onClick);
    return button;
  }

  function copyPayload(payload, copiedLabel) {
    return copyText(JSON.stringify(payload, null, 2), copiedLabel);
  }

  function dirtyPathCount(source) {
    return `${source.dirtyPaths.length}${source.dirtyPathsTruncated ? "+" : ""}`;
  }

  function worktreeBasename(worktreeRoot) {
    const normalized = String(worktreeRoot || "worktree")
      .replace(/[\\/]+$/u, "");
    return normalized.split(/[\\/]/u).at(-1) || "worktree";
  }

  async function copyText(value, copiedLabel) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      showToast(copiedLabel);
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = value;
      fallback.setAttribute("readonly", "");
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.append(fallback);
      fallback.select();
      const copied = document.execCommand("copy");
      fallback.remove();
      showToast(copied ? copiedLabel : "Copy unavailable in this browser");
    }
  }

  function wrap(text, width, maximumLines) {
    const segmenter = typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
    const segments = segmenter
      ? [...segmenter.segment(text)].map((segment) => segment.segment)
      : Array.from(text);
    const lines = [];
    for (let lineIndex = 0; lineIndex < maximumLines; lineIndex += 1) {
      let line = "";
      while (segments.length > 0) {
        const segment = segments[0];
        if (!line && /^\s+$/u.test(segment)) {
          segments.shift();
          continue;
        }
        if (displayUnits(`${line}${segment}`) <= width) {
          line += segment;
          segments.shift();
          continue;
        }
        if (line) break;
        let consumed = "";
        const characters = Array.from(segment);
        while (characters.length > 0
          && displayUnits(`${consumed}${characters[0]}`) <= width) {
          consumed += characters.shift();
        }
        line = consumed;
        if (characters.length === 0) segments.shift();
        else segments[0] = characters.join("");
        break;
      }
      if (!line.trim()) break;
      lines.push(line.trim());
      if (segments.length === 0) break;
    }
    if (segments.some((segment) => segment.trim())) {
      let finalLine = lines.at(-1) ?? "";
      while (finalLine && displayUnits(`${finalLine}…`) > width) {
        finalLine = Array.from(finalLine).slice(0, -1).join("");
      }
      if (lines.length === 0) lines.push("…");
      else lines[lines.length - 1] =
        `${finalLine.replace(/[.…]*$/, "")}…`;
    }
    return lines;
  }

  function displayUnits(value) {
    return Array.from(value).reduce(
      (total, character) =>
        total
        + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Emoji_Presentation}]/u
          .test(character) ? 2 : 1),
      0,
    );
  }

  function classes(...values) {
    return values.filter(Boolean).join(" ");
  }

  function shortDigest(value) {
    const digest = value.startsWith("sha256:") ? value.slice(7) : value;
    return digest.length > 13
      ? `${digest.slice(0, 8)}…${digest.slice(-4)}`
      : digest;
  }

  function shortTicketId(value) {
    return value.length > 28
      ? `${value.slice(0, 16)}…${value.slice(-8)}`
      : value;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  elements.sourceStatus.addEventListener(
    "click",
    () => void refresh("Graph refreshed from Git"),
  );
  elements.copyLink.addEventListener("click", () => {
    void copyText(location.href, "Authorized link copied");
  });
  elements.graphSignal.addEventListener("click", () => {
    renderGraphInspector();
    renderGraph();
  });
  elements.sourceRef.addEventListener("click", () => {
    if (!state) return;
    elements.sourceDock.hidden = !elements.sourceDock.hidden;
    elements.sourceRef.setAttribute(
      "aria-expanded",
      String(!elements.sourceDock.hidden),
    );
  });
  elements.closeSourceDock.addEventListener("click", () => {
    elements.sourceDock.hidden = true;
    elements.sourceRef.setAttribute("aria-expanded", "false");
    elements.sourceRef.focus();
  });
  document.querySelector("#fitGraph").addEventListener("click", fitGraph);
  document
    .querySelector("#zoomIn")
    .addEventListener("click", () => zoomAt(scale * 1.18));
  document
    .querySelector("#zoomOut")
    .addEventListener("click", () => zoomAt(scale / 1.18));
  elements.closeInspector.addEventListener("click", closeInspector);
  elements.canvas.addEventListener("click", () => {
    if (suppressCanvasClick) {
      suppressCanvasClick = false;
      return;
    }
    if (selected) {
      closeInspector();
    }
  });
  elements.canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".ticket-node, .edge")) {
      return;
    }
    dragging = {
      x: event.clientX,
      y: event.clientY,
      panX,
      panY,
      moved: false,
    };
    elements.canvas.classList.add("dragging");
    elements.canvas.setPointerCapture(event.pointerId);
  });
  elements.canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    if (Math.hypot(event.clientX - dragging.x, event.clientY - dragging.y) > 4) {
      dragging.moved = true;
    }
    panX = dragging.panX + event.clientX - dragging.x;
    panY = dragging.panY + event.clientY - dragging.y;
    applyTransform();
  });
  elements.canvas.addEventListener("pointerup", (event) => {
    suppressCanvasClick = Boolean(dragging?.moved);
    dragging = null;
    elements.canvas.classList.remove("dragging");
    elements.canvas.releasePointerCapture(event.pointerId);
  });
  elements.canvas.addEventListener("pointercancel", () => {
    dragging = null;
    elements.canvas.classList.remove("dragging");
  });
  elements.canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = elements.canvas.getBoundingClientRect();
    zoomAt(
      scale * Math.exp(-event.deltaY * 0.0012),
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.inspector.classList.contains("open")) {
      closeInspector();
    }
  });
  window.addEventListener(
    "resize",
    () => requestAnimationFrame(frameGraph),
  );
  elements.minimap.addEventListener("click", (event) => {
    event.stopPropagation();
    const point = minimapWorldPoint(event.clientX, event.clientY);
    if (!point) return;
    const canvasRect = elements.canvas.getBoundingClientRect();
    panX = canvasRect.width / 2 - point.x * scale;
    panY = canvasRect.height / 2 - point.y * scale;
    applyTransform();
  });
  elements.minimap.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fitGraph();
    }
  });

  void refresh();
})();
