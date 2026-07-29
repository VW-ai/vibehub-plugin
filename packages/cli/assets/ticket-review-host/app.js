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

  function svg(tag, attributes = {}) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    return element;
  }

  async function api(path) {
    if (!token) {
      throw new Error(
        "The local Ticket capability is missing. Open the exact link printed by VibeHub.",
      );
    }
    const response = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const envelope = await response.json();
    if (!response.ok || !envelope.ok) {
      throw new Error(
        envelope?.error?.message || `Ticket host returned ${response.status}`,
      );
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
    } catch (error) {
      if (request !== graphRequest) return;
      renderError(error);
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
    subjectRequest += 1;
    selected = null;
    elements.workspace.classList.remove("inspector-closed");
    elements.inspector.classList.add("open");
    elements.inspectorEyebrow.textContent = "Current graph";
    elements.inspectorTitle.textContent = "The work that unlocks the outcome";
    elements.inspectorOutcome.textContent =
      `This exact worktree source contains ${state.graph.tickets.length} `
      + `Tickets and ${state.graph.relations.length} direct unlock relations. `
      + "Select any Ticket to read the context a fresh Agent receives.";
    elements.inspectorContent.replaceChildren(
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
      elements.inspectorContent.append(
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
  }

  async function selectTicket(ticketId, focusInspector = false) {
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
      const [inspection, trace] = await Promise.all([
        api(`/api/subject?${query}`),
        api(`/api/trace?${query}`).catch(() => null),
      ]);
      if (!isCurrentSubjectResponse(
        request,
        snapshotId,
        { kind: "ticket", ticketId },
        inspection,
        trace,
      )) return;
      renderTicketInspection(inspection, trace);
      if (focusInspector) elements.inspectorTitle.focus();
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      elements.inspectorOutcome.textContent = error.message;
      showToast(error.message);
    }
  }

  function renderTicketInspection(inspection, trace) {
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
    appendSection(
      content,
      "Trace",
      list(
        trace?.records || [],
        (item) => ({
          title: item.summary,
          detail: `${item.kind} · ${item.occurredAt}`,
        }),
      ),
    );
    elements.inspectorContent.replaceChildren(content);
  }

  async function selectRelation(relationRef, focusInspector = false) {
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
      const [inspection, trace] = await Promise.all([
        api(`/api/subject?${query}`),
        api(`/api/trace?${query}`).catch(() => null),
      ]);
      if (!isCurrentSubjectResponse(
        request,
        snapshotId,
        { kind: "relation", relationRef },
        inspection,
        trace,
      )) return;
      renderRelationInspection(inspection, trace);
      if (focusInspector) elements.inspectorTitle.focus();
    } catch (error) {
      if (!isCurrentSubjectRequest(request, snapshotId)) return;
      elements.inspectorOutcome.textContent = error.message;
      showToast(error.message);
    }
  }

  function renderRelationInspection(inspection, trace) {
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
    appendSection(
      content,
      "Trace",
      list(
        trace?.records || [],
        (item) => ({
          title: item.summary,
          detail: `${item.kind} · ${item.occurredAt}`,
        }),
      ),
    );
    elements.inspectorContent.replaceChildren(content);
  }

  function subjectQuery(snapshotId, subject) {
    const query = new URLSearchParams({
      snapshotId,
      kind: subject.kind,
    });
    if (subject.kind === "ticket") {
      query.set("ticketId", subject.ticketId);
    } else {
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
    const identityMatches = subject.kind === "ticket"
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
