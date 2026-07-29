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
    proposalRef: document.querySelector("#proposalRef"),
    ambientProject: document.querySelector("#ambientProject"),
    ambientBranch: document.querySelector("#ambientBranch"),
    stateDot: document.querySelector("#stateDot"),
    stateLabel: document.querySelector("#stateLabel"),
    reviewStatus: document.querySelector("#reviewStatus"),
    workspace: document.querySelector(".workspace"),
    canvas: document.querySelector("#canvas"),
    graph: document.querySelector("#graph"),
    world: document.querySelector("#world"),
    edgeLayer: document.querySelector("#edgeLayer"),
    nodeLayer: document.querySelector("#nodeLayer"),
    minimap: document.querySelector("#minimap"),
    loadingState: document.querySelector("#loadingState"),
    inspector: document.querySelector("#inspector"),
    closeInspector: document.querySelector("#closeInspector"),
    inspectorEyebrow: document.querySelector("#inspectorEyebrow"),
    inspectorTitle: document.querySelector("#inspectorTitle"),
    inspectorOutcome: document.querySelector("#inspectorOutcome"),
    candidateFact: document.querySelector("#candidateFact"),
    candidateLabel: document.querySelector("#candidateLabel"),
    validationFact: document.querySelector("#validationFact"),
    validationLabel: document.querySelector("#validationLabel"),
    authorityFact: document.querySelector("#authorityFact"),
    authorityLabel: document.querySelector("#authorityLabel"),
    relationSection: document.querySelector("#relationSection"),
    relationList: document.querySelector("#relationList"),
    validationSection: document.querySelector("#validationSection"),
    validationList: document.querySelector("#validationList"),
    decisionSection: document.querySelector("#decisionSection"),
    decisionTitle: document.querySelector("#decisionTitle"),
    decisionDetail: document.querySelector("#decisionDetail"),
    rationale: document.querySelector("#rationale"),
    rejectButton: document.querySelector("#rejectButton"),
    authorizeButton: document.querySelector("#authorizeButton"),
    decisionNote: document.querySelector("#decisionNote"),
    toast: document.querySelector("#toast"),
  };

  let token = location.hash.slice(1);
  if (token) history.replaceState(null, "", location.pathname);
  let state = null;
  let positions = new Map();
  let selected = null;
  let panX = 0;
  let panY = 0;
  let scale = 1;
  let dragging = null;
  let suppressCanvasClick = false;
  let lastFocusedSubject = null;
  let toastTimer = null;

  function svg(tag, attributes = {}) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    return element;
  }

  async function api(path, options = {}) {
    if (!token) {
      throw new Error("The local review capability is missing. Open the exact link printed by VibeHub.");
    }
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    const envelope = await response.json();
    if (!response.ok || !envelope.ok) {
      throw new Error(envelope?.error?.message || `Review host returned ${response.status}`);
    }
    return envelope.data;
  }

  async function refresh(message) {
    setBusy(true);
    try {
      state = await api("/api/state");
      render();
      if (message) showToast(message);
    } catch (error) {
      renderError(error);
    } finally {
      setBusy(false);
    }
  }

  function render() {
    const graph = state.graph;
    positions = layoutGraph(graph.tickets, graph.relations);
    renderChrome();
    renderGraph();
    renderMinimap();
    renderPlanInspector();
    requestAnimationFrame(frameGraph);
  }

  function renderChrome() {
    const { project, proposal, review, graph } = state;
    elements.projectName.textContent = project.name;
    elements.ambientProject.textContent = project.name;
    elements.ambientBranch.textContent = `${project.branch} · local trusted review`;
    elements.proposalRef.textContent = shortRef(proposal.proposalId);
    elements.signalDetail.textContent =
      `${graph.tickets.length} Tickets · ${graph.relations.length} direct unlocks`;
    const tone = statusTone(review.eligibility.status);
    elements.signalAttention.textContent =
      humanStatus(review.eligibility.status);
    elements.signalAttention.className = `signal-attention ${tone}`.trim();
    elements.stateDot.className = `state-dot ${tone}`.trim();
    elements.stateLabel.textContent = humanStatus(review.eligibility.status);
  }

  function renderGraph() {
    elements.edgeLayer.replaceChildren();
    elements.nodeLayer.replaceChildren();
    const related = selected ? causalCone(selected) : null;

    for (const relation of state.graph.relations) {
      const from = positions.get(relation.prerequisiteTicketId);
      const to = positions.get(relation.dependentTicketId);
      if (!from || !to) continue;
      const group = svg("g", {
        class: classes(
          "edge",
          selected?.kind === "relation" && selected.id === relation.relationRef ? "selected" : "",
          related?.relations.has(relation.relationRef) ? "related" : "",
          related && !related.relations.has(relation.relationRef) ? "dimmed" : "",
        ),
        role: "button",
        tabindex: "0",
        "aria-label": `${relation.prerequisiteTicketId} unlocks ${relation.dependentTicketId}`,
      });
      group.dataset.relationRef = relation.relationRef;
      const geometry = edgeGeometry(from, to, relation.relationRef);
      const visible = svg("path", {
        class: "edge-visible",
        d: geometry.path,
      });
      const arrow = svg("path", {
        class: "edge-arrow",
        d: geometry.arrow,
      });
      const hit = svg("path", { class: "edge-hit", d: geometry.path });
      group.append(visible, arrow, hit);
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectRelation(relation.relationRef);
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectRelation(relation.relationRef, true);
        }
      });
      elements.edgeLayer.append(group);
    }

    for (const ticket of state.graph.tickets) {
      const position = positions.get(ticket.ticketId);
      if (!position) continue;
      const isSelected = selected?.kind === "ticket" && selected.id === ticket.ticketId;
      const group = svg("g", {
        class: classes(
          "ticket-node",
          ticket.state,
          isSelected ? "selected" : "",
          related && !related.nodes.has(ticket.ticketId) ? "dimmed" : "",
        ),
        transform: `translate(${position.x} ${position.y})`,
        role: "button",
        tabindex: "0",
        "aria-label": `${ticket.ticketId}. ${ticket.outcome}. ${ticket.relationCounts.prerequisites} prerequisites, ${ticket.relationCounts.dependents} unlocks.`,
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
      if (ticket.state !== "existing") {
        const change = svg("text", {
          class: "ticket-change",
          x: NODE.width - 14,
          y: 23,
          "text-anchor": "end",
        });
        change.textContent = ticket.state;
        group.append(change);
      }
      const lines = wrap(ticket.outcome, 38, 3);
      lines.forEach((line, index) => {
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
        `${ticket.relationCounts.prerequisites} in · ${ticket.relationCounts.dependents} out · r${ticket.definitionRevision}`;
      group.append(meta);
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        selectTicket(ticket.ticketId);
      });
      group.addEventListener("keydown", (event) => onNodeKey(event, ticket.ticketId));
      elements.nodeLayer.append(group);
    }
    applyTransform();
  }

  function renderMinimap() {
    elements.minimap.replaceChildren();
    const bounds = graphBounds();
    if (!bounds) return;
    elements.minimap.setAttribute("viewBox", `${bounds.x - 20} ${bounds.y - 20} ${bounds.width + 40} ${bounds.height + 40}`);
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
    elements.minimap.append(svg("rect", {
      class: "minimap-viewport",
    }));
    updateMinimapViewport();
  }

  function renderPlanInspector() {
    const { proposal, review, graph } = state;
    const stale = review.eligibility.status === "stale";
    const applied = review.eligibility.status === "applied";
    const appliedSnapshot = review.application?.publication.snapshotId ?? null;
    const showingAppliedSnapshot =
      appliedSnapshot !== null && graph.snapshotId === appliedSnapshot;
    selected = null;
    elements.workspace.classList.remove("inspector-closed");
    elements.inspector.classList.add("open");
    elements.candidateLabel.textContent = stale
      ? "Stale proposal"
      : applied
        ? "Applied proposal"
        : "Candidate";
    elements.validationLabel.textContent = "Validation";
    elements.authorityLabel.textContent = "Authority";
    elements.decisionSection.hidden = false;
    elements.decisionSection.classList.toggle(
      "complete",
      review.eligibility.status === "applied",
    );
    elements.inspectorEyebrow.textContent = "Plan review";
    elements.inspectorTitle.textContent = proposal.reason;
    elements.inspectorOutcome.textContent = stale
      ? `This proposal no longer matches the canonical Ticket head. The canvas shows the current canonical graph (${graph.tickets.length} Tickets, ${graph.relations.length} direct unlock relations), not a reconstructed candidate. Replan against the current snapshot.`
      : applied
        ? showingAppliedSnapshot
          ? `This proposal published the canonical snapshot shown on the canvas (${graph.tickets.length} Ticket outlines, ${graph.relations.length} direct unlock relations). Publication does not claim execution maturity.`
          : `This proposal published ${shortRef(appliedSnapshot)}. The canvas shows the newer current canonical head ${shortRef(graph.snapshotId)}, not the historical candidate.`
        : `This immutable candidate contains ${graph.tickets.length} Ticket outlines and ${graph.relations.length} direct unlock relations. Scenario is a review lens; publication does not claim execution maturity.`;
    elements.candidateFact.textContent = `${shortDigest(proposal.candidateDigest)} · ${proposal.createdTicketCount} new · ${proposal.revisedTicketCount} revised`;
    elements.validationFact.textContent =
      review.validations.length === 0
        ? "No complete passing validation"
        : `${review.validations.length} receipt${review.validations.length === 1 ? "" : "s"} · ${shortDigest(review.validationSet.digest)}`;
    elements.authorityFact.textContent =
      review.decision
        ? `${review.decision.disposition} · ${review.decision.requiredPath}`
        : review.requiredPath ?? "not resolved";
    elements.relationSection.hidden = true;
    renderValidationEvidence(review.validations);
    renderDecision();
  }

  function renderValidationEvidence(validations) {
    elements.validationList.replaceChildren();
    elements.validationSection.hidden = validations.length === 0;
    for (const validation of validations) {
      const record = document.createElement("details");
      record.className = `validation-record ${validation.conclusion}`;
      const summary = document.createElement("summary");
      const validator = document.createElement("strong");
      validator.textContent =
        `${validation.validator.id}@${validation.validator.version}`;
      const conclusion = document.createElement("span");
      conclusion.textContent = validation.conclusion;
      summary.append(validator, conclusion);

      const facts = document.createElement("dl");
      appendFact(
        facts,
        "Receipt",
        `${shortRef(validation.validationReceiptId)} · ${shortDigest(validation.validationReceiptDigest)}`,
      );
      appendFact(
        facts,
        "Checks",
        `${validation.checkCount} · ${validation.blockingFindingCount} blocking · ${validation.advisoryFindingCount} advisory`,
      );
      appendFact(
        facts,
        "Policy",
        `${validation.policy.id}@${validation.policy.version}`,
      );
      appendFact(facts, "Trust", validation.validator.trust);
      record.append(summary, facts);
      elements.validationList.append(record);
    }
  }

  function appendFact(list, label, value) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const definition = document.createElement("dd");
    term.textContent = label;
    definition.textContent = value;
    row.append(term, definition);
    list.append(row);
  }

  function renderDecision() {
    const { review, proposal, controls, graph } = state;
    const appliedSnapshot = review.application?.publication.snapshotId ?? null;
    const showingAppliedSnapshot =
      appliedSnapshot !== null && graph.snapshotId === appliedSnapshot;
    const rationaleValid = elements.rationale.value.trim().length >= 12;
    elements.decisionSection.classList.toggle(
      "complete",
      review.eligibility.status === "applied",
    );
    elements.rejectButton.hidden = !controls.canDecide;
    elements.authorizeButton.hidden = !(controls.canDecide || controls.canApply);
    elements.rationale.hidden = !controls.canDecide;
    document.querySelector('label[for="rationale"]').hidden = !controls.canDecide;

    if (review.eligibility.status === "applied") {
      elements.decisionTitle.textContent = "Canonical graph published";
      elements.decisionDetail.textContent = showingAppliedSnapshot
        ? `The exact candidate is the canonical snapshot shown as ${shortRef(appliedSnapshot)}.`
        : `This proposal published ${shortRef(appliedSnapshot)}; the canvas now shows current head ${shortRef(graph.snapshotId)}.`;
      elements.decisionNote.textContent = "Authority and publication receipts are immutable.";
    } else if (review.eligibility.status === "validation_required") {
      elements.decisionTitle.textContent = "Independent validation required";
      elements.decisionDetail.textContent =
        "Use VibeHub Ticket Validate against this exact proposal before requesting human authority.";
      elements.decisionNote.textContent = review.eligibility.reasons.join(" ");
    } else if (review.eligibility.status === "authority_required") {
      if (review.requiredPath === "delegated_policy") {
        elements.decisionTitle.textContent = "Delegated policy required";
        elements.decisionDetail.textContent =
          "This local human surface cannot invent or substitute a durable delegated-policy basis.";
        elements.decisionNote.textContent =
          "Resolve this proposal through a configured trusted policy provider.";
      } else {
        elements.decisionTitle.textContent = "Review before publication";
        elements.decisionDetail.textContent =
          "Your explicit local decision will bind the complete validation set. Caller identity and page JSON cannot mint authority.";
        elements.authorizeButton.textContent =
          controls.decisionLabel || "Authorize and publish";
        elements.authorizeButton.disabled = !rationaleValid;
        elements.rejectButton.disabled = !rationaleValid;
        elements.decisionNote.textContent = rationaleValid
          ? "The decision is exact, terminal, and proposal-specific."
          : "A rationale of at least 12 characters is required.";
      }
    } else if (review.eligibility.status === "application_ready") {
      elements.decisionTitle.textContent = "Authorized and ready to publish";
      elements.decisionDetail.textContent =
        "The trusted decision already binds this candidate and validation set.";
      elements.authorizeButton.textContent = controls.decisionLabel || "Publish authorized graph";
      elements.authorizeButton.disabled = false;
      elements.decisionNote.textContent = "Publication is crash-reconcilable and idempotent.";
    } else {
      elements.decisionTitle.textContent = humanStatus(review.eligibility.status);
      elements.decisionDetail.textContent = review.eligibility.reasons.join(" ");
      elements.decisionNote.textContent = "This proposal cannot advance from its current state.";
    }
  }

  function selectTicket(ticketId, focusInspector = false) {
    const ticket = state.graph.tickets.find((item) => item.ticketId === ticketId);
    if (!ticket) return;
    selected = { kind: "ticket", id: ticketId };
    lastFocusedSubject = selected;
    elements.workspace.classList.remove("inspector-closed");
    elements.inspector.classList.add("open");
    elements.inspectorEyebrow.textContent =
      `Ticket · ${ticket.state} · ${shortTicketId(ticket.ticketId)}`;
    elements.inspectorTitle.textContent = ticket.outcome;
    elements.inspectorOutcome.textContent =
      "This proposal carries an outline definition. Executable context and runtime capability facts are not available yet.";
    elements.candidateLabel.textContent = "Definition";
    elements.validationLabel.textContent = "Capability";
    elements.authorityLabel.textContent = "Topology";
    elements.candidateFact.textContent =
      `${ticket.ticketId} · r${ticket.definitionRevision}`;
    elements.validationFact.textContent = "outline only";
    elements.authorityFact.textContent =
      `${ticket.relationCounts.prerequisites} prerequisites · ${ticket.relationCounts.dependents} unlocks`;
    renderRelations(ticketId);
    elements.validationSection.hidden = true;
    elements.decisionSection.hidden = true;
    renderGraph();
    if (focusInspector) elements.inspectorTitle.focus();
  }

  function selectRelation(relationRef, focusInspector = false) {
    const relation = state.graph.relations.find((item) => item.relationRef === relationRef);
    if (!relation) return;
    selected = { kind: "relation", id: relationRef };
    lastFocusedSubject = selected;
    elements.workspace.classList.remove("inspector-closed");
    elements.inspector.classList.add("open");
    elements.inspectorEyebrow.textContent = "Direct unlock";
    elements.inspectorTitle.textContent =
      `${shortTicketId(relation.prerequisiteTicketId)} → ${shortTicketId(relation.dependentTicketId)}`;
    elements.inspectorOutcome.textContent =
      relation.rationale || "No additional rationale was attached to this direct dependency.";
    elements.candidateLabel.textContent = "Relation";
    elements.validationLabel.textContent = "Direction";
    elements.authorityLabel.textContent = "Change";
    elements.candidateFact.textContent = shortRef(relation.relationRef);
    elements.validationFact.textContent =
      `${relation.prerequisiteTicketId} → ${relation.dependentTicketId}`;
    elements.authorityFact.textContent = relation.state;
    elements.relationSection.hidden = true;
    elements.validationSection.hidden = true;
    elements.decisionSection.hidden = true;
    renderGraph();
    if (focusInspector) elements.inspectorTitle.focus();
  }

  function renderRelations(ticketId) {
    elements.relationList.replaceChildren();
    const relations = state.graph.relations.filter(
      (relation) =>
        relation.prerequisiteTicketId === ticketId
        || relation.dependentTicketId === ticketId,
    );
    elements.relationSection.hidden = relations.length === 0;
    for (const relation of relations) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "relation-row";
      const address = document.createElement("strong");
      const incoming = relation.dependentTicketId === ticketId;
      const otherTicket = incoming
        ? relation.prerequisiteTicketId
        : relation.dependentTicketId;
      address.textContent =
        `${incoming ? "requires" : "unlocks"} ${shortTicketId(otherTicket)}`;
      address.title =
        `${relation.prerequisiteTicketId} → ${relation.dependentTicketId}`;
      const rationale = document.createElement("span");
      rationale.textContent = relation.rationale || "Direct execution dependency";
      row.append(address, rationale);
      row.addEventListener("click", () => selectRelation(relation.relationRef));
      elements.relationList.append(row);
    }
  }

  function layoutGraph(tickets, relations) {
    const ids = tickets.map((ticket) => ticket.ticketId).sort();
    const outgoing = new Map(ids.map((id) => [id, []]));
    const incoming = new Map(ids.map((id) => [id, []]));
    const indegree = new Map(ids.map((id) => [id, 0]));
    for (const relation of relations) {
      if (!outgoing.has(relation.prerequisiteTicketId)
        || !incoming.has(relation.dependentTicketId)) continue;
      outgoing.get(relation.prerequisiteTicketId).push(relation.dependentTicketId);
      incoming.get(relation.dependentTicketId).push(relation.prerequisiteTicketId);
      indegree.set(relation.dependentTicketId, indegree.get(relation.dependentTicketId) + 1);
    }
    for (const values of [...outgoing.values(), ...incoming.values()]) values.sort();
    const rank = new Map(ids.map((id) => [id, 0]));
    const queue = ids.filter((id) => indegree.get(id) === 0);
    const visited = [];
    while (queue.length) {
      queue.sort();
      const id = queue.shift();
      visited.push(id);
      for (const dependent of outgoing.get(id)) {
        rank.set(dependent, Math.max(rank.get(dependent), rank.get(id) + 1));
        indegree.set(dependent, indegree.get(dependent) - 1);
        if (indegree.get(dependent) === 0) queue.push(dependent);
      }
    }
    if (visited.length !== ids.length) {
      throw new Error("The candidate graph contains a cycle and cannot be laid out.");
    }
    const layers = new Map();
    for (const id of ids) {
      const layer = rank.get(id);
      if (!layers.has(layer)) layers.set(layer, []);
      layers.get(layer).push(id);
    }
    const orderedLayers = [...layers.entries()].sort((a, b) => a[0] - b[0]);
    const indexMap = () => new Map(
      orderedLayers.flatMap(([, layer]) => layer.map((id, index) => [id, index])),
    );
    for (let sweep = 0; sweep < LAYOUT.sweeps; sweep += 1) {
      const forward = sweep % 2 === 0;
      const sequence = forward ? orderedLayers : [...orderedLayers].reverse();
      const indices = indexMap();
      for (const [, layer] of sequence) {
        layer.sort((left, right) => {
          const leftNeighbors = forward ? incoming.get(left) : outgoing.get(left);
          const rightNeighbors = forward ? incoming.get(right) : outgoing.get(right);
          const leftScore = barycenter(leftNeighbors, indices);
          const rightScore = barycenter(rightNeighbors, indices);
          return leftScore - rightScore || left.localeCompare(right);
        });
      }
    }
    const result = new Map();
    for (const [layerIndex, layer] of orderedLayers) {
      layer.forEach((id, row) => {
        result.set(id, {
          x: LAYOUT.marginX + layerIndex * (NODE.width + LAYOUT.columnGap),
          y: LAYOUT.marginY + row * (NODE.height + LAYOUT.rowGap),
        });
      });
    }
    return result;
  }

  function barycenter(neighbors, indices) {
    if (!neighbors.length) return Number.MAX_SAFE_INTEGER;
    return neighbors.reduce((sum, id) => sum + (indices.get(id) ?? 0), 0) / neighbors.length;
  }

  function edgeGeometry(from, to, relationRef) {
    const x1 = from.x + NODE.width + 7;
    const y1 = from.y + NODE.height / 2;
    const x2 = to.x - 2;
    const y2 = to.y + NODE.height / 2;
    const arrow =
      `M ${x2 - 7} ${y2 - 3.5} L ${x2} ${y2} L ${x2 - 7} ${y2 + 3.5} Z`;
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
    const maxX = Math.max(...values.map((value) => value.x + NODE.width));
    const maxY = Math.max(...values.map((value) => value.y + NODE.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function fitGraph() {
    const bounds = graphBounds();
    if (!bounds) return;
    const rect = elements.canvas.getBoundingClientRect();
    const padding = 74;
    scale = clamp(
      Math.min(
        (rect.width - padding * 2) / bounds.width,
        (rect.height - padding * 2) / bounds.height,
      ),
      MIN_SCALE,
      1.2,
    );
    panX = (rect.width - bounds.width * scale) / 2 - bounds.x * scale;
    panY = (rect.height - bounds.height * scale) / 2 - bounds.y * scale;
    applyTransform();
  }

  function frameGraph() {
    const bounds = graphBounds();
    if (!bounds) return;
    const rect = elements.canvas.getBoundingClientRect();
    const mobileInspector =
      window.innerWidth <= 760 && elements.inspector.classList.contains("open");
    const visibleHeight = mobileInspector
      ? Math.max(180, rect.height * 0.38)
      : rect.height;
    const padding = 58;
    const fitScale = Math.min(
      (rect.width - padding * 2) / bounds.width,
      (visibleHeight - padding * 2) / bounds.height,
    );
    scale = clamp(Math.max(fitScale, 0.64), MIN_SCALE, 1);
    panX = bounds.width * scale <= rect.width - padding * 2
      ? (rect.width - bounds.width * scale) / 2 - bounds.x * scale
      : padding - bounds.x * scale;
    panY =
      (visibleHeight - bounds.height * scale) / 2 - bounds.y * scale;
    applyTransform();
  }

  function zoomAt(nextScale, x, y) {
    const rect = elements.canvas.getBoundingClientRect();
    const screenX = x ?? rect.width / 2;
    const screenY = y ?? rect.height / 2;
    const worldX = (screenX - panX) / scale;
    const worldY = (screenY - panY) / scale;
    scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    panX = screenX - worldX * scale;
    panY = screenY - worldY * scale;
    applyTransform();
  }

  function applyTransform() {
    elements.world.setAttribute("transform", `translate(${panX} ${panY}) scale(${scale})`);
    elements.graph.classList.toggle("lod-low", scale < 0.48);
    updateMinimapViewport();
  }

  function updateMinimapViewport() {
    const viewport = elements.minimap.querySelector(".minimap-viewport");
    if (!viewport || scale <= 0) return;
    const rect = elements.canvas.getBoundingClientRect();
    viewport.setAttribute("x", String(-panX / scale));
    viewport.setAttribute("y", String(-panY / scale));
    viewport.setAttribute("width", String(rect.width / scale));
    viewport.setAttribute("height", String(rect.height / scale));
  }

  function causalCone(subject) {
    const selectedRelation = subject.kind === "relation"
      ? state.graph.relations.find((item) => item.relationRef === subject.id)
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
    const relations = new Set([...upstream.relations, ...downstream.relations]);
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
      selectTicket(ticketId, true);
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
    elements.nodeLayer.querySelector(`[data-ticket-id="${CSS.escape(target)}"]`)?.focus();
  }

  async function decide(action) {
    const rationale = elements.rationale.value.trim();
    if (rationale.length < 12) {
      showToast("Write a decision rationale first");
      return;
    }
    setBusy(true);
    try {
      state = await api("/api/decision", {
        method: "POST",
        body: JSON.stringify({
          action,
          rationale,
          expectedProposalDigest: state.proposal.proposalDigest,
          expectedCandidateDigest: state.proposal.candidateDigest,
          expectedValidationSetDigest: state.review.validationSet.digest,
        }),
      });
      selected = null;
      render();
      showToast(action === "authorize" ? "Graph authorized and published" : "Plan rejected with rationale");
    } catch (error) {
      showToast(error.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function applyAuthorized() {
    const decision = state.review.decision;
    if (!decision || decision.disposition !== "authorized") return;
    setBusy(true);
    try {
      state = await api("/api/apply", {
        method: "POST",
        body: JSON.stringify({
          expectedProposalDigest: state.proposal.proposalDigest,
          expectedCandidateDigest: state.proposal.candidateDigest,
          authorityDecisionId: decision.authorityDecisionId,
          expectedAuthorityDecisionDigest: decision.authorityDecisionDigest,
        }),
      });
      selected = null;
      render();
      showToast("Authorized graph published");
    } catch (error) {
      showToast(error.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  function closeInspector() {
    const restore = selected ?? lastFocusedSubject;
    selected = null;
    elements.inspector.classList.remove("open");
    elements.workspace.classList.add("inspector-closed");
    elements.decisionSection.hidden = false;
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

  function setBusy(busy) {
    elements.loadingState.hidden = !busy;
    const status = state?.review?.eligibility?.status;
    const rationaleMissing = elements.rationale.value.trim().length < 12;
    elements.authorizeButton.disabled = busy
      || (status === "authority_required" && rationaleMissing)
      || (status !== "authority_required" && status !== "application_ready");
    elements.rejectButton.disabled = busy
      || status !== "authority_required"
      || rationaleMissing;
  }

  function renderError(error) {
    elements.loadingState.hidden = true;
    elements.stateDot.className = "state-dot error";
    elements.stateLabel.textContent = "Unavailable";
    elements.signalDetail.textContent = error.message;
    elements.inspectorTitle.textContent = "Review host unavailable";
    elements.inspectorOutcome.textContent = error.message;
    elements.decisionSection.hidden = true;
  }

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2400);
  }

  function humanStatus(status) {
    return ({
      validation_required: "Validation required",
      authority_required: "Needs your decision",
      application_ready: "Ready to publish",
      applied: "Published",
      rejected: "Changes requested",
      stale: "Stale proposal",
      comment_only: "Comment",
    })[status] || status;
  }

  function statusTone(status) {
    if (status === "applied") return "healthy";
    if (status === "rejected") return "error";
    if (status === "stale") return "stale";
    return "";
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
      while (finalLine
        && displayUnits(`${finalLine}…`) > width) {
        finalLine = Array.from(finalLine).slice(0, -1).join("");
      }
      if (lines.length === 0) lines.push("…");
      else lines[lines.length - 1] = `${finalLine.replace(/[.…]*$/, "")}…`;
    }
    return lines;
  }

  function displayUnits(value) {
    return Array.from(value).reduce(
      (total, character) =>
        total + (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Emoji_Presentation}]/u.test(character) ? 2 : 1),
      0,
    );
  }

  function classes(...values) {
    return values.filter(Boolean).join(" ");
  }

  function shortDigest(value) {
    return `${value.slice(0, 8)}…${value.slice(-5)}`;
  }

  function shortRef(value) {
    return value.length > 28 ? `${value.slice(0, 16)}…${value.slice(-8)}` : value;
  }

  function shortTicketId(value) {
    return `T·${value.slice(-7)}`;
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
    } else if (open && !elements.inspector.classList.contains("open")) {
      renderPlanInspector();
      requestAnimationFrame(frameGraph);
    }
  });
  elements.reviewStatus.addEventListener("click", () => {
    if (!state) return;
    renderPlanInspector();
    renderGraph();
    requestAnimationFrame(frameGraph);
  });
  document.querySelector("#fitGraph").addEventListener("click", fitGraph);
  document.querySelector("#zoomIn").addEventListener("click", () => zoomAt(scale * 1.18));
  document.querySelector("#zoomOut").addEventListener("click", () => zoomAt(scale / 1.18));
  elements.closeInspector.addEventListener("click", closeInspector);
  elements.rationale.addEventListener("input", renderDecision);
  elements.rejectButton.addEventListener("click", () => decide("reject"));
  elements.authorizeButton.addEventListener("click", () => {
    if (state.review.eligibility.status === "application_ready") {
      void applyAuthorized();
    } else {
      void decide("authorize");
    }
  });
  elements.canvas.addEventListener("click", () => {
    if (suppressCanvasClick) {
      suppressCanvasClick = false;
      return;
    }
    if (selected) {
      renderPlanInspector();
      renderGraph();
    }
  });
  elements.canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest(".ticket-node, .edge")) return;
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
  window.addEventListener("resize", () => requestAnimationFrame(frameGraph));
  elements.minimap.addEventListener("click", (event) => {
    event.stopPropagation();
    const bounds = graphBounds();
    if (!bounds) return;
    const rect = elements.minimap.getBoundingClientRect();
    const canvasRect = elements.canvas.getBoundingClientRect();
    const worldX =
      bounds.x - 20 + ((event.clientX - rect.left) / rect.width) * (bounds.width + 40);
    const worldY =
      bounds.y - 20 + ((event.clientY - rect.top) / rect.height) * (bounds.height + 40);
    panX = canvasRect.width / 2 - worldX * scale;
    panY = canvasRect.height / 2 - worldY * scale;
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
