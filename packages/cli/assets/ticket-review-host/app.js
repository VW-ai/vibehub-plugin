(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const NODE = { width: 254, height: 112 };
  const LAYOUT = {
    marginX: 92,
    marginY: 82,
    columnGap: 136,
    rowGap: 68,
    sweeps: 5,
  };
  const MIN_SCALE = 0.12;
  const MAX_SCALE = 2.4;

  const elements = {
    surface: document.querySelector("#surface"),
    sheet: document.querySelector("#sheet"),
    signal: document.querySelector("#signal"),
    signalDetail: document.querySelector("#signalDetail"),
    signalAttention: document.querySelector("#signalAttention"),
    projectName: document.querySelector("#projectName"),
    sourceRef: document.querySelector("#sourceRef"),
    ambientProject: document.querySelector("#ambientProject"),
    ambientBranch: document.querySelector("#ambientBranch"),
    stateDot: document.querySelector("#stateDot"),
    stateLabel: document.querySelector("#stateLabel"),
    sourceStatus: document.querySelector("#sourceStatus"),
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
  if (token) history.replaceState(null, "", location.pathname);
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
  const drafts = new Map();
  const draftNotices = new Map();
  let activeActionKey = null;

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
      renderGraphInspector();
      requestAnimationFrame(frameGraph);
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
    const commit = source.resolvedCommit
      ? source.resolvedCommit.slice(0, 8)
      : "unborn";
    const worktree = worktreeBasename(source.worktreeRoot);
    elements.projectName.textContent = project.name;
    elements.ambientProject.textContent = project.name;
    elements.ambientBranch.textContent =
      `${worktree} · ${project.branch} · ${commit} · Git Ticket ledger`;
    elements.sourceRef.textContent =
      `${worktree} · ${project.branch}@${commit}`;
    elements.sourceRef.title =
      `${source.worktreeRoot}\nWorktree ${source.worktreeIdentity}\nClick to copy full path`;
    elements.sourceRef.setAttribute(
      "aria-label",
      `Worktree ${worktree}. Copy full path.`,
    );
    elements.signalDetail.textContent =
      `${graph.tickets.length} Tickets · ${graph.relations.length} direct unlocks`;
    elements.signalAttention.textContent =
      source.semanticDirty ? "Local" : "Git";
    elements.signalAttention.className =
      `signal-attention${source.semanticDirty ? " dirty" : ""}`;
    elements.stateDot.className =
      `state-dot${source.semanticDirty ? " dirty" : ""}`;
    elements.stateLabel.textContent =
      source.semanticDirty
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
      const geometry = edgeGeometry(from, to, relation.relationRef);
      group.append(
        svg("path", { class: "edge-visible", d: geometry.path }),
        svg("path", { class: "edge-arrow", d: geometry.arrow }),
        svg("path", { class: "edge-hit", d: geometry.path }),
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
      const isSelected =
        selected?.kind === "ticket" && selected.id === ticket.ticketId;
      const group = svg("g", {
        class: classes(
          "ticket-node",
          isSelected ? "selected" : "",
          related && !related.nodes.has(ticket.ticketId) ? "dimmed" : "",
        ),
        transform: `translate(${position.x} ${position.y})`,
        role: "button",
        tabindex: "0",
        "aria-label":
          `${ticket.ticketId}. ${ticket.outcome}. `
          + `${ticket.relationCounts.prerequisites} prerequisites, `
          + `${ticket.relationCounts.dependents} unlocks.`,
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
      );
      const id = svg("text", { class: "ticket-id", x: 15, y: 23 });
      id.textContent = shortTicketId(ticket.ticketId);
      group.append(id);
      wrap(ticket.outcome, 38, 3).forEach((line, index) => {
        const text = svg("text", {
          class: "ticket-outcome",
          x: 15,
          y: 49 + index * 17,
        });
        text.textContent = line;
        group.append(text);
      });
      const meta = svg("text", {
        class: "ticket-meta",
        x: 15,
        y: NODE.height - 12,
      });
      meta.textContent =
        `${ticket.relationCounts.prerequisites} in · `
        + `${ticket.relationCounts.dependents} out · `
        + shortDigest(ticket.ticketRevision);
      group.append(meta);
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
    for (const position of positions.values()) {
      elements.minimap.append(svg("rect", {
        x: position.x,
        y: position.y,
        width: NODE.width,
        height: NODE.height,
        rx: 7,
        fill: "#fbfbfa",
        stroke: "#6b6f75",
        "stroke-width": 3,
      }));
    }
    elements.minimap.append(svg("rect", { class: "minimap-viewport" }));
    updateMinimapViewport();
  }

  function renderGraphInspector() {
    if (!state) return;
    const request = ++subjectRequest;
    const snapshotId = state.graph.snapshotId;
    selected = null;
    elements.workspace.classList.remove("inspector-closed");
    elements.inspector.classList.add("open");
    elements.inspectorEyebrow.textContent = "Current graph";
    elements.inspectorTitle.textContent = "The work that unlocks the outcome";
    elements.inspectorOutcome.textContent =
      `This exact worktree source contains ${state.graph.tickets.length} `
      + `Tickets and ${state.graph.relations.length} direct unlock relations. `
      + "Select any Ticket to read the context a fresh Agent receives.";
    const content = document.createDocumentFragment();
    content.append(
      facts([
        ["Source", sourceLabel(state.graph.source)],
        [
          "Worktree",
          copyableWorktree(state.graph.source),
        ],
        ["Commit", state.graph.source.resolvedCommit || "unborn HEAD"],
        ["Graph", state.graph.source.graphDigest],
        [
          "Local state",
          state.graph.source.semanticDirty
            ? `${dirtyPathCount(state.graph.source)} semantic path changes`
              + `${state.graph.source.dirtyPathsTruncated ? " · list truncated" : ""}`
            : "matches committed Ticket semantics",
        ],
      ]),
    );
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
        section(
          "Pending local semantics",
          list(
            pendingPaths,
            (item) => item,
            "code-ref",
          ),
        ),
      );
    }
    const workspace = reviewWorkspace({
      kind: "graph",
      graphDigest: state.graph.source.graphDigest,
    });
    if (workspace) content.append(workspace);
    const traceSection = section(
      "Trace",
      quietMessage("Reading review facts…"),
    );
    traceSection.dataset.trace = "graph";
    content.append(traceSection);
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
      traceSection.replaceChildren(
        sectionHeading("Trace"),
        traceList(trace.records || []),
      );
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      traceSection.replaceChildren(
        sectionHeading("Trace"),
        quietMessage(error.message, "error"),
      );
      showToast(error.message);
    }
  }

  async function selectTicket(
    ticketId,
    focusInspector = false,
    preserveAction = false,
  ) {
    const ticket = state.graph.tickets.find(
      (item) => item.ticketId === ticketId,
    );
    if (!ticket) return;
    if (!preserveAction) activeActionKey = null;
    const request = ++subjectRequest;
    const snapshotId = state.graph.snapshotId;
    selected = { kind: "ticket", id: ticketId };
    lastFocusedSubject = selected;
    openInspector();
    elements.inspectorEyebrow.textContent =
      `Ticket · ${shortTicketId(ticket.ticketId)}`;
    elements.inspectorTitle.textContent = ticket.outcome;
    elements.inspectorOutcome.textContent = "Reading executable context…";
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
      const traceSection = renderTicketInspection(inspection);
      void loadSubjectTrace(
        request,
        snapshotId,
        { kind: "ticket", ticketId },
        traceSection,
      );
      if (focusInspector) elements.inspectorTitle.focus();
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      elements.inspectorOutcome.textContent = error.message;
      showToast(error.message);
    }
  }

  function renderTicketInspection(inspection) {
    const subject = inspection.subject;
    if (subject?.kind !== "ticket") {
      throw new Error("Ticket inspector received the wrong subject.");
    }
    const ticket = subject.ticket;
    const contextPackage =
      subject.contextPackage ?? inspection.contextPackage ?? {};
    elements.inspectorEyebrow.textContent =
      `Ticket · ${shortTicketId(ticket.ticketId)}`;
    elements.inspectorTitle.textContent = ticket.outcome;
    elements.inspectorOutcome.textContent =
      contextPackage.context || "No additional context was recorded.";
    const content = document.createDocumentFragment();
    content.append(facts([
      ["Revision", ticket.ticketRevision],
      [
        "Topology",
        `${ticket.relationCounts.prerequisites} prerequisites · `
        + `${ticket.relationCounts.dependents} unlocks`,
      ],
      ["Source", sourceLabel(inspection.source || state.graph.source)],
    ]));
    appendSection(
      content,
      "Acceptance",
      list(
        contextPackage.acceptance || [],
        (item) => ({
          title: item.acceptanceId,
          detail: item.criterion,
        }),
      ),
    );
    appendSection(
      content,
      "Constraints",
      list(
        contextPackage.constraints || [],
        (item) => ({ detail: item }),
      ),
    );
    appendSection(
      content,
      "Context references",
      list(
        contextPackage.contextRefs || [],
        (item) => ({ title: item.ref, detail: item.purpose }),
        "code-ref",
      ),
    );
    appendSection(
      content,
      "Typed relations",
      relationList(contextPackage.relations || []),
    );
    appendSection(
      content,
      "Provenance",
      list(
        contextPackage.provenanceRefs || ticket.provenanceRefs || [],
        (item) => ({ title: item }),
        "code-ref",
      ),
    );
    const traceSection = section(
      "Trace",
      quietMessage("Reading review facts…"),
    );
    traceSection.dataset.trace = "ticket";
    content.append(traceSection);
    const workspace = reviewWorkspace(
      exactTicketSubject(ticket),
      { contextPackage },
    );
    if (workspace) content.append(workspace);
    elements.inspectorContent.replaceChildren(content);
    return traceSection;
  }

  async function selectRelation(
    relationRef,
    focusInspector = false,
    preserveAction = false,
  ) {
    const relation = state.graph.relations.find(
      (item) => item.relationRef === relationRef,
    );
    if (!relation) return;
    if (!preserveAction) activeActionKey = null;
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
    const content = document.createDocumentFragment();
    content.append(facts([
      ["Relation", relation.relationRef],
      ["From", relation.prerequisiteTicketId],
      ["To", relation.dependentTicketId],
      ["Source", sourceLabel(inspection.source || state.graph.source)],
    ]));
    appendSection(
      content,
      "Provenance",
      list(
        relation.provenanceRefs || [],
        (item) => ({ title: item }),
        "code-ref",
      ),
    );
    const traceSection = section(
      "Trace",
      quietMessage("Reading review facts…"),
    );
    traceSection.dataset.trace = "relation";
    content.append(traceSection);
    const workspace = reviewWorkspace(exactRelationSubject(relation));
    if (workspace) content.append(workspace);
    elements.inspectorContent.replaceChildren(content);
    return traceSection;
  }

  async function loadSubjectTrace(
    request,
    snapshotId,
    subject,
    traceSection,
  ) {
    try {
      const trace = await api(
        `/api/trace?${subjectQuery(snapshotId, subject)}`,
      );
      if (
        !isCurrentSubjectRequest(request, snapshotId)
        || trace?.snapshotId !== snapshotId
        || !traceSubjectMatches(subject, trace?.subject)
      ) return;
      traceSection.replaceChildren(
        sectionHeading("Trace"),
        traceList(trace.records || []),
      );
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      traceSection.replaceChildren(
        sectionHeading("Trace"),
        quietMessage(error.message, "error"),
      );
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
  }

  function closeInspector() {
    const restore = selected ?? lastFocusedSubject;
    subjectRequest += 1;
    selected = null;
    activeActionKey = null;
    elements.inspector.classList.remove("open");
    elements.workspace.classList.add("inspector-closed");
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
      if (value && typeof value === "object" && value.copyValue) {
        const button = document.createElement("button");
        button.className = "copy-fact";
        button.type = "button";
        button.textContent = value.text;
        button.title = value.title;
        button.setAttribute("aria-label", value.ariaLabel);
        button.addEventListener(
          "click",
          () => void copyText(value.copyValue, value.copiedLabel),
        );
        definition.append(button);
      } else {
        definition.textContent = value;
      }
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

  function appendSection(fragment, title, child) {
    if (child === null) return;
    fragment.append(section(title, child));
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
      const title = document.createElement("strong");
      title.textContent =
        `${relation.type} → ${shortTicketId(relation.targetTicketId)}`;
      const detail = document.createElement("span");
      detail.textContent = relation.rationale || relation.targetTicketId;
      row.append(title, detail);
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

  function sectionHeading(title) {
    const heading = document.createElement("h2");
    heading.textContent = title;
    return heading;
  }

  function quietMessage(message, tone = "") {
    const paragraph = document.createElement("p");
    paragraph.className = classes("quiet-message", tone);
    paragraph.textContent = message;
    return paragraph;
  }

  function traceList(records) {
    if (!records.length) {
      return quietMessage("No review facts are bound to this exact subject.");
    }
    const result = document.createElement("div");
    result.className = "trace-list";
    for (const record of records) {
      const row = document.createElement("article");
      const historical = String(record.status || "").startsWith("historical");
      row.className = classes("trace-row", historical ? "historical" : "");

      const marker = document.createElement("span");
      marker.className = "trace-marker";
      marker.setAttribute("aria-hidden", "true");

      const copy = document.createElement("div");
      copy.className = "trace-copy";
      const title = document.createElement("strong");
      title.textContent = record.summary;
      const meta = document.createElement("span");
      meta.className = "trace-meta";
      meta.textContent = [
        record.subkind || record.kind,
        record.status || "recorded",
        formatInstant(record.occurredAt),
      ].join(" · ");
      copy.append(title, meta);
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
    for (const target of targets) {
      if (target.kind === "url") {
        const link = document.createElement("a");
        link.href = target.target;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = target.label;
        link.title = target.target;
        wrapper.append(link);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = target.label;
      button.title = target.target;
      button.addEventListener(
        "click",
        () => void copyText(target.target, `${target.label} copied`),
      );
      wrapper.append(button);
    }
    return wrapper;
  }

  function reviewWorkspace(subject, options = {}) {
    const rail = document.createElement("div");
    rail.className = "review-rail";
    const interventions = state.interventions || {
      review: { available: false },
      planReview: { available: false },
      protectedDecision: { available: false },
      protectedBoundaries: [],
      authority: { status: "unavailable" },
    };
    const actions = [];
    const authority = interventions.authority || { status: "unavailable" };
    if (subject.kind === "graph" && authority.status === "unenrolled") {
      const enrollmentKey = reviewDraftKey("authority-enroll", subject);
      actions.push(
        actionDisclosure(
          "Enroll decision authority",
          "Bind one named human to this repository with Touch ID, Windows Hello, or a FIDO2 key.",
          "◇",
          enrollmentKey,
          () => authorityEnrollmentForm(subject, enrollmentKey),
        ),
      );
    }
    const canReview = interventions.review?.available === true;
    if (canReview) {
      const commentKey = reviewDraftKey("comment", subject);
      actions.push(
        actionDisclosure(
          "Comment",
          subject.kind === "graph"
            ? "Attach context without changing the plan."
            : subject.kind === "ticket"
              ? "Attach context to this exact Ticket revision."
              : "Attach context to this exact direct unlock.",
          "·",
          commentKey,
          () => commentForm(subject, commentKey),
        ),
      );
      if (subject.kind === "ticket") {
        const editKey = reviewDraftKey("ticket-edit", subject);
        actions.push(
          actionDisclosure(
            "Propose edit",
            "Preserve the Ticket; record a replacement context package.",
            "↗",
            editKey,
            () => ticketEditForm(
              subject,
              options.contextPackage || {},
              editKey,
            ),
          ),
        );
      }
    }
    if (
      subject.kind === "graph"
      && interventions.planReview?.available === true
    ) {
      const planKey = reviewDraftKey("plan", subject);
      actions.push(
        actionDisclosure(
          "Review plan",
          "Record one exact, host-authorized graph decision.",
          "◇",
          planKey,
          () => planDecisionForm(subject, planKey),
        ),
      );
    }
    if (subject.kind === "graph" && authority.status === "active") {
      const revokeKey = reviewDraftKey("authority-revoke", subject);
      actions.push(
        actionDisclosure(
          "Revoke decision authority",
          `Stop trusting ${authority.principalId || "this credential"} after one verified human action.`,
          "×",
          revokeKey,
          () => authorityRevocationForm(subject, revokeKey),
        ),
      );
    }
    if (subject.kind === "ticket") {
      const boundaries = (interventions.protectedBoundaries || [])
        .filter((item) =>
          item.ticketId === subject.ticketId
          && item.ticketRevision === subject.ticketRevision)
        .map((item) => item.boundary);
      const protectedDecision = interventions.protectedDecision
        || { available: false };
      if (boundaries.length || protectedDecision.available === true) {
        const boundaryKey = reviewDraftKey("protected-boundary", subject);
        actions.push(
          actionDisclosure(
            "Decide boundary",
            "Resolve one exact product, design, or architecture choice.",
            "◇",
            boundaryKey,
            () => protectedDecisionForm(
              subject,
              boundaries,
              boundaryKey,
              protectedDecision.ceremony === "webauthn"
                ? "webauthn-decision"
                : "direct",
            ),
          ),
        );
      }
    }
    if (!actions.length) return null;
    rail.append(...actions);
    return section("Review", rail);
  }

  function reviewDraftKey(action, subject) {
    const locus = subject.kind === "graph"
      ? "graph"
      : subject.kind === "ticket"
        ? `ticket:${subject.ticketId}`
        : `relation:${subject.relationRef}`;
    return `${action}:${locus}`;
  }

  function actionDisclosure(
    label,
    detail,
    symbol,
    draftKey,
    buildForm,
  ) {
    const disclosure = document.createElement("details");
    disclosure.className = "review-action";
    const summary = document.createElement("summary");
    const mark = document.createElement("span");
    mark.className = "review-action-mark";
    mark.textContent = symbol;
    mark.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "review-action-copy";
    const title = document.createElement("strong");
    title.textContent = label;
    const hint = document.createElement("span");
    hint.textContent = detail;
    copy.append(title, hint);
    const chevron = document.createElement("span");
    chevron.className = "review-action-chevron";
    chevron.textContent = "›";
    chevron.setAttribute("aria-hidden", "true");
    summary.append(mark, copy, chevron);
    disclosure.append(summary);
    const ensureForm = () => {
      if (disclosure.childElementCount === 1) {
        disclosure.append(buildForm());
      }
    };
    disclosure.addEventListener("toggle", () => {
      if (!disclosure.open) {
        if (activeActionKey === draftKey) activeActionKey = null;
        return;
      }
      activeActionKey = draftKey;
      const parent = disclosure.parentElement;
      if (parent) {
        for (const sibling of parent.children) {
          if (sibling !== disclosure && sibling.matches("details[open]")) {
            sibling.open = false;
          }
        }
      }
      ensureForm();
    });
    if (activeActionKey === draftKey) {
      disclosure.open = true;
      ensureForm();
    }
    return disclosure;
  }

  function commentForm(subject, draftKey) {
    const body = textareaControl({
      name: "body",
      rows: 4,
      placeholder: "What should the next Agent understand?",
      required: true,
    });
    return mutationForm({
      draftKey,
      fields: [
        field("Comment", body),
      ],
      submitLabel: "Record comment",
      submit: () => ({
        route: "/api/review",
        payload: {
          expectedSource: mutationSource(),
          review: {
            type: "comment",
            subject,
            body: body.value.trim(),
          },
        },
        subject,
      }),
    });
  }

  function ticketEditForm(subject, contextPackage, draftKey) {
    const outcome = textareaControl({
      name: "outcome",
      rows: 2,
      value: contextPackage.outcome || "",
      required: true,
    });
    const context = textareaControl({
      name: "context",
      rows: 5,
      value: contextPackage.context || "",
      required: true,
    });
    const body = textareaControl({
      name: "body",
      rows: 3,
      placeholder: "Summarize the change for the next Agent.",
      required: true,
    });
    const rationale = textareaControl({
      name: "rationale",
      rows: 3,
      placeholder: "Why does this make the package more executable?",
      required: true,
    });
    return mutationForm({
      draftKey,
      fields: [
        field("Outcome", outcome),
        field("Context", context),
        field("Review note", body),
        field("Rationale", rationale),
      ],
      submitLabel: "Record proposal",
      submit: ({ setStatus }) => {
        const nextOutcome = outcome.value.trim();
        const nextContext = context.value.trim();
        if (
          nextOutcome === (contextPackage.outcome || "")
          && nextContext === (contextPackage.context || "")
        ) {
          setStatus(
            "Change the outcome or context before recording an edit.",
            "error",
          );
          outcome.focus();
          return null;
        }
        return {
          route: "/api/review",
          payload: {
            expectedSource: mutationSource(),
            review: {
              type: "ticket_edit",
              subject,
              body: body.value.trim(),
              rationale: rationale.value.trim(),
              replacementTicket: replacementTicket(
                subject.ticketId,
                contextPackage,
                nextOutcome,
                nextContext,
              ),
            },
          },
          subject,
        };
      },
    });
  }

  function planDecisionForm(subject, draftKey) {
    const disposition = selectControl([
      ["approve_execution", "Approve execution"],
      ["delegate_within_boundaries", "Delegate within boundaries"],
      ["request_changes", "Request changes"],
    ], "disposition");
    const boundaries = textareaControl({
      name: "delegatedBoundaries",
      rows: 3,
      placeholder: "One boundary per line",
    });
    const boundaryField = field("Delegated boundaries", boundaries);
    const rationale = textareaControl({
      name: "rationale",
      rows: 4,
      placeholder: "Why is this the right decision for this exact graph?",
      required: true,
    });
    const syncFields = () => {
      const delegated = disposition.value === "delegate_within_boundaries";
      boundaryField.hidden = !delegated;
      boundaries.required = delegated;
    };
    disposition.addEventListener("change", syncFields);
    syncFields();
    return mutationForm({
      draftKey,
      fields: [
        field("Decision", disposition),
        boundaryField,
        field("Rationale", rationale),
      ],
      submitLabel: "Record decision",
      submit: () => {
        const delegatedBoundaries = lineValues(boundaries.value);
        return {
          route: "/api/decision",
          ceremony:
            state.interventions?.planReview?.ceremony === "webauthn"
              ? "webauthn-decision"
              : "direct",
          payload: {
            expectedSource: mutationSource(),
            decision: {
              type: "plan_review",
              subject,
              disposition: disposition.value,
              ...(disposition.value === "delegate_within_boundaries"
                ? { delegatedBoundaries }
                : {}),
              rationale: rationale.value.trim(),
              resolutionRefs: [],
            },
          },
          subject,
        };
      },
    });
  }

  function authorityEnrollmentForm(subject, draftKey) {
    const principalId = textareaControl({
      name: "principalId",
      rows: 2,
      placeholder: "A stable named principal, for example human:wayne",
      required: true,
    });
    return mutationForm({
      draftKey,
      fields: [
        field("Principal", principalId),
      ],
      submitLabel: "Enroll with authenticator",
      submit: () => ({
        ceremony: "webauthn-enrollment",
        payload: {
          principalId: principalId.value.trim(),
        },
        subject,
      }),
    });
  }

  function authorityRevocationForm(subject, draftKey) {
    return mutationForm({
      draftKey,
      fields: [
        quietMessage(
          "Revocation takes effect for fresh processes immediately. Existing Git receipts remain visible evidence.",
        ),
      ],
      submitLabel: "Verify and revoke",
      submit: () => ({
        ceremony: "webauthn-revocation",
        payload: {},
        subject,
      }),
    });
  }

  function protectedDecisionForm(
    subject,
    boundaries,
    draftKey,
    ceremony = "direct",
  ) {
    const boundary = boundaries.length
      ? selectControl(
        boundaries.map((item) => [item, item]),
        "boundary",
      )
      : textareaControl({
        name: "boundary",
        rows: 3,
        placeholder: "The exact protected product, design, or architecture choice",
        required: true,
      });
    const disposition = selectControl([
      ["resolve", "Resolve"],
      ["decline", "Decline to resolve"],
    ], "disposition");
    const selection = textareaControl({
      name: "selection",
      rows: 3,
      placeholder: "The selected direction",
      required: true,
    });
    const selectionField = field("Selection", selection);
    const rationale = textareaControl({
      name: "rationale",
      rows: 4,
      placeholder: "Why is this the right human choice?",
      required: true,
    });
    const syncFields = () => {
      const resolves = disposition.value === "resolve";
      selectionField.hidden = !resolves;
      selection.required = resolves;
    };
    disposition.addEventListener("change", syncFields);
    syncFields();
    return mutationForm({
      draftKey,
      fields: [
        field("Protected boundary", boundary),
        field("Decision", disposition),
        selectionField,
        field("Rationale", rationale),
      ],
      submitLabel: ceremony === "webauthn-decision"
        ? "Verify and record decision"
        : "Record decision",
      submit: () => ({
        route: "/api/decision",
        ceremony,
        payload: {
          expectedSource: mutationSource(),
          decision: {
            type: "protected_boundary",
            subject,
            boundary: boundary.value.trim(),
            disposition: disposition.value,
            ...(disposition.value === "resolve"
              ? { selection: selection.value.trim() }
              : {}),
            rationale: rationale.value.trim(),
            resolutionRefs: [],
          },
        },
        subject,
      }),
    });
  }

  function mutationForm({
    draftKey,
    fields,
    submitLabel,
    submit,
  }) {
    const form = document.createElement("form");
    form.className = "review-form";
    form.append(...fields);
    const footer = document.createElement("div");
    footer.className = "review-form-footer";
    const status = document.createElement("p");
    status.className = "review-form-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "review-submit";
    button.textContent = submitLabel;
    footer.append(status, button);
    form.append(footer);

    const setStatus = (message, tone = "") => {
      status.textContent = message;
      status.className = classes("review-form-status", tone);
    };
    restoreFormDraft(form, draftKey);
    const notice = draftNotices.get(draftKey);
    if (notice) setStatus(notice, "attention");
    const persist = () => {
      saveFormDraft(form, draftKey);
      if (draftNotices.has(draftKey)) {
        draftNotices.delete(draftKey);
        setStatus("");
      }
    };
    form.addEventListener("input", persist);
    form.addEventListener("change", persist);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      saveFormDraft(form, draftKey);
      let mutation;
      try {
        mutation = submit({ setStatus });
      } catch (error) {
        setStatus(error.message, "error");
        return;
      }
      if (mutation === null) return;
      void performMutation({
        ...mutation,
        draftKey,
        form,
        button,
        setStatus,
      });
    });
    return form;
  }

  async function performMutation({
    route,
    ceremony = "direct",
    payload,
    subject,
    draftKey,
    form,
    button,
    setStatus,
  }) {
    button.disabled = true;
    form.setAttribute("aria-busy", "true");
    setStatus(
      ceremony === "direct"
        ? "Writing one exact Git review fact…"
        : "Preparing one exact human verification…",
    );
    try {
      const result = await executeMutation({
        route,
        ceremony,
        payload,
        setStatus,
      });
      const documentPath =
        result.attestation?.documentPath
        || result.authority?.profileId
        || result.review?.documentPath
        || result.decision?.documentPath
        || "Git review ledger";
      drafts.delete(draftKey);
      draftNotices.delete(draftKey);
      if (activeActionKey === draftKey) activeActionKey = null;
      setStatus(`Recorded · ${documentPath}`, "success");
      showToast(`Recorded · ${documentPath}`);
      const refreshed = await refresh();
      if (!refreshed) {
        elements.inspectorTitle.textContent =
          "Review recorded; graph refresh failed";
        elements.inspectorOutcome.textContent =
          `The durable fact is at ${documentPath}. Refresh before retrying.`;
        showToast(`Recorded at ${documentPath} · refresh failed`);
        return;
      }
      await restoreSubject(subject, false);
    } catch (error) {
      const stale = String(error.code || "").includes("stale")
        || String(error.code || "").includes("source_changed");
      if (!stale) {
        setStatus(error.message, "error");
        return;
      }
      const notice =
        "Source refreshed. Your draft is preserved; recheck it before recording.";
      draftNotices.set(draftKey, notice);
      activeActionKey = draftKey;
      setStatus("The source changed. Refreshing without losing your draft…");
      const refreshed = await refresh();
      if (refreshed) {
        await restoreSubject(subject, true);
        showToast("Source refreshed · draft preserved");
      } else {
        showToast("Refresh failed · draft preserved in this page");
      }
    } finally {
      if (form.isConnected) {
        button.disabled = false;
        form.removeAttribute("aria-busy");
      }
    }
  }

  async function executeMutation({
    route,
    ceremony,
    payload,
    setStatus,
  }) {
    if (ceremony === "direct") {
      return api(route, {
        method: "POST",
        body: payload,
      });
    }
    const browser = globalThis.SimpleWebAuthnBrowser;
    if (!browser) {
      throw new Error(
        "This browser could not load the local WebAuthn adapter. Restart the installed review host.",
      );
    }
    if (ceremony === "webauthn-enrollment") {
      const challenge = await api("/api/authority/enroll/challenge", {
        method: "POST",
        body: payload,
      });
      setStatus("Confirm enrollment with your authenticator…");
      const credential = await browser.startRegistration({
        optionsJSON: challenge.options,
      });
      setStatus("Verifying the enrolled human authority…");
      return api("/api/authority/enroll/complete", {
        method: "POST",
        body: {
          ceremonyId: challenge.ceremonyId,
          credential,
        },
      });
    }
    if (ceremony === "webauthn-decision") {
      const challenge = await api("/api/decision/challenge", {
        method: "POST",
        body: payload,
      });
      setStatus("Confirm this exact Decision with your authenticator…");
      const credential = await browser.startAuthentication({
        optionsJSON: challenge.options,
      });
      setStatus("Verifying and recording the exact Decision…");
      return api("/api/decision/complete", {
        method: "POST",
        body: {
          ceremonyId: challenge.ceremonyId,
          credential,
        },
      });
    }
    if (ceremony === "webauthn-revocation") {
      const challenge = await api("/api/authority/revoke/challenge", {
        method: "POST",
        body: payload,
      });
      setStatus("Confirm revocation with your authenticator…");
      const credential = await browser.startAuthentication({
        optionsJSON: challenge.options,
      });
      setStatus("Revoking the enrolled authority…");
      return api("/api/authority/revoke/complete", {
        method: "POST",
        body: {
          ceremonyId: challenge.ceremonyId,
          credential,
        },
      });
    }
    throw new Error("The Ticket host exposed an unknown human ceremony.");
  }

  async function restoreSubject(subject, preserveAction) {
    if (subject.kind === "ticket") {
      if (state.graph.tickets.some(
        (ticket) => ticket.ticketId === subject.ticketId,
      )) {
        await selectTicket(subject.ticketId, false, preserveAction);
      }
      return;
    }
    if (subject.kind === "relation") {
      if (state.graph.relations.some(
        (relation) => relation.relationRef === subject.relationRef,
      )) {
        await selectRelation(subject.relationRef, false, preserveAction);
      }
    }
  }

  function saveFormDraft(form, draftKey) {
    const draft = {};
    for (const control of form.querySelectorAll("[name]")) {
      draft[control.name] = control.value;
    }
    drafts.set(draftKey, draft);
  }

  function restoreFormDraft(form, draftKey) {
    const draft = drafts.get(draftKey);
    if (!draft) return;
    for (const control of form.querySelectorAll("[name]")) {
      if (Object.prototype.hasOwnProperty.call(draft, control.name)) {
        control.value = draft[control.name];
        control.dispatchEvent(new Event("change"));
      }
    }
  }

  function field(label, control) {
    const wrapper = document.createElement("label");
    wrapper.className = "review-field";
    const text = document.createElement("span");
    text.textContent = label;
    wrapper.append(text, control);
    return wrapper;
  }

  function textareaControl({
    name,
    rows,
    value = "",
    placeholder = "",
    required = false,
  }) {
    const control = document.createElement("textarea");
    control.name = name;
    control.rows = rows;
    control.value = value;
    control.placeholder = placeholder;
    control.required = required;
    control.spellcheck = true;
    return control;
  }

  function selectControl(options, name) {
    const control = document.createElement("select");
    control.name = name;
    for (const [value, label] of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      control.append(option);
    }
    return control;
  }

  function mutationSource() {
    const source = state?.graph?.source;
    if (
      source?.mode !== "worktree"
      || !source.semanticLedgerDigest
    ) {
      throw new Error(
        "This graph source cannot accept durable review facts. Refresh it.",
      );
    }
    return {
      sourceToken: source.sourceToken,
      worktreeIdentity: source.worktreeIdentity,
      resolvedCommit: source.resolvedCommit,
      graphDigest: source.graphDigest,
      semanticLedgerDigest: source.semanticLedgerDigest,
    };
  }

  function exactTicketSubject(ticket) {
    return {
      kind: "ticket",
      ticketId: ticket.ticketId,
      ticketRevision: ticket.ticketRevision,
    };
  }

  function exactRelationSubject(relation) {
    const dependent = state.graph.tickets.find(
      (ticket) => ticket.ticketId === relation.dependentTicketId,
    );
    if (!dependent) {
      throw new Error("The direct unlock has no visible dependent Ticket.");
    }
    return {
      kind: "relation",
      relationRef: relation.relationRef,
      prerequisiteTicketId: relation.prerequisiteTicketId,
      dependentTicketId: relation.dependentTicketId,
      dependentTicketRevision: dependent.ticketRevision,
    };
  }

  function replacementTicket(
    ticketId,
    contextPackage,
    outcome,
    context,
  ) {
    return {
      schema_version: 1,
      kind: "ticket",
      ticket_id: ticketId,
      outcome,
      context,
      acceptance: (contextPackage.acceptance || []).map((item) => ({
        acceptance_id: item.acceptanceId,
        criterion: item.criterion,
      })),
      constraints: [...(contextPackage.constraints || [])],
      context_refs: (contextPackage.contextRefs || []).map((item) => ({
        ref: item.ref,
        purpose: item.purpose,
      })),
      relations: (contextPackage.relations || []).map((relation) => ({
        type: relation.type,
        target_ticket_id: relation.targetTicketId,
        ...(relation.rationale
          ? { rationale: relation.rationale }
          : {}),
      })),
      provenance_refs: [...(contextPackage.provenanceRefs || [])],
    };
  }

  function lineValues(value) {
    return value
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
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

  function edgeGeometry(from, to, relationRef) {
    const x1 = from.x + NODE.width + 7;
    const y1 = from.y + NODE.height / 2;
    const x2 = to.x - 2;
    const y2 = to.y + NODE.height / 2;
    const arrow =
      `M ${x2 - 7} ${y2 - 3.5} L ${x2} ${y2} `
      + `L ${x2 - 7} ${y2 + 3.5} Z`;
    if (Math.abs(y2 - y1) < 1) {
      return { path: `M ${x1} ${y1} H ${x2}`, arrow };
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
    elements.loadingState.hidden = true;
    elements.stateDot.className = "state-dot error";
    elements.stateLabel.textContent = "Unavailable";
    elements.signalAttention.textContent = "Error";
    elements.signalAttention.className = "signal-attention error";
    elements.signalDetail.textContent = error.message;
    elements.inspectorTitle.textContent = "Ticket graph unavailable";
    elements.inspectorOutcome.textContent = error.message;
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

  function dirtyPathCount(source) {
    return `${source.dirtyPaths.length}${source.dirtyPathsTruncated ? "+" : ""}`;
  }

  function worktreeBasename(worktreeRoot) {
    const normalized = String(worktreeRoot || "worktree")
      .replace(/[\\/]+$/u, "");
    return normalized.split(/[\\/]/u).at(-1) || "worktree";
  }

  function copyableWorktree(source) {
    const worktree = worktreeBasename(source.worktreeRoot);
    return {
      text: worktree,
      title: `${source.worktreeRoot}\nWorktree ${source.worktreeIdentity}\nClick to copy full path`,
      ariaLabel: `Worktree ${worktree}. Copy full path.`,
      copyValue: source.worktreeRoot,
      copiedLabel: "Worktree path copied",
    };
  }

  async function copyText(value, copiedLabel) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(copiedLabel);
    } catch {
      showToast("Copy unavailable · full path is in the hover detail");
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

  elements.signal.addEventListener("click", () => {
    const open = elements.surface.classList.toggle("open");
    elements.signal.setAttribute("aria-expanded", String(open));
    elements.sheet.setAttribute("aria-hidden", String(!open));
    elements.sheet.inert = !open;
    if (!open && elements.sheet.contains(document.activeElement)) {
      elements.signal.focus();
    } else if (open) {
      requestAnimationFrame(frameGraph);
    }
  });
  elements.sourceStatus.addEventListener(
    "click",
    () => void refresh("Graph refreshed from Git"),
  );
  elements.sourceRef.addEventListener("click", () => {
    if (!state) return;
    void copyText(
      state.graph.source.worktreeRoot,
      "Worktree path copied",
    );
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
      activeActionKey = null;
      renderGraphInspector();
      renderGraph();
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
    if (event.key === "Escape" && selected) closeInspector();
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
