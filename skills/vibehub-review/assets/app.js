(() => {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const MIN_SCALE = 0.12;
  const MAX_SCALE = 2.4;
  const workbenchModel = globalThis.VibeHubWorkbenchModel;
  const graphLayoutModel = globalThis.VibeHubGraphLayout;
  if (!workbenchModel) {
    throw new Error("VibeHub Workbench presentation model is unavailable.");
  }
  if (!graphLayoutModel) {
    throw new Error("VibeHub Workbench graph layout is unavailable.");
  }
  const { HISTORY_STUB, NODE } = graphLayoutModel;
  const {
    agentHandoffInstruction,
    causalPriority: operationalPriority,
    graphNarrative,
    graphSummary,
    layoutDirectionHref,
    layoutDirectionSpec,
    localFocusHref,
    normalizeLayoutDirection,
    operationalCounts,
    ticketAttentionState,
    ticketNextAction,
    ticketNodePresentation,
    ticketOperationalState,
    ticketPhasePresentation,
    workbenchOverview,
  } = workbenchModel;
  const TICKET_VIEW_IDS = new Map([
    ["execution", "execution"],
    ["contract", "contract"],
    ["log", "evidence"],
  ]);
  const STATE_ICON_IDS = Object.freeze({
    DRAFT: "sliders",
    DONE: "check",
    READY: "play",
    RUNNING: "running",
    ARCHIVED: "archive",
  });
  const SUBSTATE_ICON_IDS = Object.freeze({
    DEVIATED: "alert",
    BLOCKED: "lock",
    NEEDS_YOU: "pending",
    VERIFYING: "recorded",
    WAITING: "upcoming",
  });
  const ROOM_STATE_PRESENTATION = Object.freeze({
    FRESH: { label: "FRESH", icon: "check" },
    DRIFTED: { label: "DRIFTED", icon: "drift" },
    WARNING: { label: "OLD CHECKOUT", icon: "history" },
    STALE: { label: "STALE", icon: "alert-circle" },
    COLD_START: { label: "ROOMS NOT INITIALIZED", icon: "snowflake" },
  });
  const focusQuery = new URLSearchParams(location.search);
  const requestedTicketId = focusQuery.get("ticket");
  const requestedViewId = TICKET_VIEW_IDS.get(focusQuery.get("view"))
    ?? "execution";
  const requestedDirection = normalizeLayoutDirection(
    focusQuery.get("direction"),
  );
  const requestedRoomPath = focusQuery.get("room-focus");
  const requestedRoomsSurface = focusQuery.get("surface") === "rooms"
    || Boolean(requestedRoomPath);

  const elements = {
    projectName: document.querySelector("#projectName"),
    repoBranch: document.querySelector("#repoBranch"),
    sourceRef: document.querySelector("#sourceRef"),
    sourceDock: document.querySelector("#sourceDock"),
    sourceDockPanel: document.querySelector("#sourceDockPanel"),
    sourceDockTitle: document.querySelector("#sourceDockTitle"),
    sourceDockContent: document.querySelector("#sourceDockContent"),
    closeSourceDock: document.querySelector("#closeSourceDock"),
    summaryDraft: document.querySelector("#summaryDraft"),
    summaryReady: document.querySelector("#summaryReady"),
    summaryRunning: document.querySelector("#summaryRunning"),
    summaryDone: document.querySelector("#summaryDone"),
    sourcePath: document.querySelector("#sourcePath"),
    sourceBranch: document.querySelector("#sourceBranch"),
    sourceCommit: document.querySelector("#sourceCommit"),
    sourceDirty: document.querySelector("#sourceDirty"),
    sourceDirtyDot: document.querySelector("#sourceDirtyDot"),
    graphSummary: document.querySelector("#graphSummary"),
    graphSignal: document.querySelector("#graphSignal"),
    graphSignalCount: document.querySelector("#graphSignalCount"),
    overviewPanel: document.querySelector("#overviewPanel"),
    closeOverview: document.querySelector("#closeOverview"),
    stateDot: document.querySelector("#stateDot"),
    stateLabel: document.querySelector("#stateLabel"),
    sourceStatus: document.querySelector("#sourceStatus"),
    copyLink: document.querySelector("#copyLink"),
    roomsButton: document.querySelector("#roomsButton"),
    roomsCount: document.querySelector("#roomsCount"),
    roomsPanel: document.querySelector("#roomsPanel"),
    closeRooms: document.querySelector("#closeRooms"),
    roomsTree: document.querySelector("#roomsTree"),
    roomDetail: document.querySelector("#roomDetail"),
    roomEmpty: document.querySelector("#roomEmpty"),
    roomTitle: document.querySelector("#roomTitle"),
    roomState: document.querySelector("#roomState"),
    roomBoundary: document.querySelector("#roomBoundary"),
    roomContextCount: document.querySelector("#roomContextCount"),
    roomTicketCount: document.querySelector("#roomTicketCount"),
    roomDetailContent: document.querySelector("#roomDetailContent"),
    roomFilterAction: document.querySelector("#roomFilterAction"),
    roomFilterStatus: document.querySelector("#roomFilterStatus"),
    roomFilterName: document.querySelector("#roomFilterName"),
    clearRoomFilter: document.querySelector("#clearRoomFilter"),
    workspace: document.querySelector(".workspace"),
    canvas: document.querySelector("#canvas"),
    graph: document.querySelector("#graph"),
    directionLtr: document.querySelector("#directionLtr"),
    directionTtb: document.querySelector("#directionTtb"),
    scopeCurrent: document.querySelector("#scopeCurrent"),
    scopeAll: document.querySelector("#scopeAll"),
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
    textTooltip: document.querySelector("#textTooltip"),
  };

  let token = location.hash.slice(1);
  let state = null;
  let positions = new Map();
  let graphGeometry = { positions, routes: new Map() };
  let selected = null;
  let lastFocusedSubject = null;
  let graphRequest = 0;
  let subjectRequest = 0;
  let panX = 0;
  let panY = 0;
  let scale = 1;
  let layoutDirection = requestedDirection;
  let dragging = null;
  let suppressCanvasClick = false;
  let toastTimer = null;
  let tooltipAnchor = null;
  let initialFocusPending = Boolean(requestedTicketId);
  let initialRoomsPending = requestedRoomsSurface;
  let selectedRoom = null;
  let roomView = "context";
  let roomFilterSnapshot = null;

  normalizeGraphQueryUrl();

  function graphQuery() {
    const query = new URLSearchParams(location.search);
    return {
      scope: query.get("scope") ?? "current",
      delivery: query.get("delivery"),
      rooms: query.getAll("room").sort(),
      historyIds: query.getAll("history").sort(),
    };
  }

  function normalizeGraphQueryUrl() {
    const url = new URL(location.href);
    if (!url.searchParams.has("scope")) url.searchParams.set("scope", "current");
    for (const key of ["room", "history"]) {
      const values = [...new Set(url.searchParams.getAll(key))].sort();
      url.searchParams.delete(key);
      for (const value of values) url.searchParams.append(key, value);
    }
    history.replaceState(null, "", url.href);
  }

  function svg(tag, attributes = {}) {
    const element = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    return element;
  }

  function svgIcon(iconId, attributes = {}) {
    return svg("use", { href: `#icon-${iconId}`, ...attributes });
  }

  function htmlIcon(iconId) {
    const element = document.createElementNS(SVG, "svg");
    element.setAttribute("aria-hidden", "true");
    element.append(svgIcon(iconId));
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
    const requestUrl = new URL(path, location.origin);
    const query = graphQuery();
    requestUrl.searchParams.set("scope", query.scope);
    if (query.delivery) requestUrl.searchParams.set("delivery", query.delivery);
    for (const room of query.rooms) requestUrl.searchParams.append("room", room);
    for (const id of query.historyIds) requestUrl.searchParams.append("history", id);
    const response = await fetch(`${requestUrl.pathname}${requestUrl.search}`, {
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

  async function refresh(message, { preserveLayout = false } = {}) {
    const request = ++graphRequest;
    subjectRequest += 1;
    setBusy(true);
    try {
      const nextState = await api("/api/state");
      if (request !== graphRequest) return;
      subjectRequest += 1;
      const fixedPositions = preserveLayout ? new Map(positions) : null;
      const previousSelection = preserveLayout ? selected : null;
      state = nextState;
      selected = previousSelection;
      graphGeometry = layoutGraph(
        state.graph.tickets,
        state.graph.relations,
        layoutDirection,
        fixedPositions ? { fixedPositions } : undefined,
      );
      positions = graphGeometry.positions;
      renderChrome();
      renderGraph();
      renderMinimap();
      requestAnimationFrame(preserveLayout ? applyTransform : frameGraph);
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
      } else if (preserveLayout && previousSelection?.kind === "ticket"
        && state.graph.tickets.some((ticket) => ticket.ticketId === previousSelection.id)) {
        await selectTicket(
          previousSelection.id,
          false,
          TICKET_VIEW_IDS.get(new URLSearchParams(location.search).get("view")) ?? "execution",
        );
      } else if (preserveLayout && previousSelection?.kind === "relation"
        && state.graph.relations.some((relation) => relation.relationRef === previousSelection.id)) {
        await selectRelation(previousSelection.id, false);
      } else {
        renderGraphInspector({ open: false });
      }
      if (initialRoomsPending) {
        initialRoomsPending = false;
        toggleRooms(true);
        if (requestedRoomPath
          && (state.rooms?.rooms ?? []).some(
            (room) => room.room === requestedRoomPath,
          )) {
          selectRoom(requestedRoomPath);
        }
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
    const overview = workbenchOverview(graph.tickets, source);
    const deviatedCount = overview.deviated.length;
    elements.projectName.textContent = project.name;
    elements.repoBranch.textContent = project.branch;
    renderSourceDock();
    renderOverview(overview);
    renderGraphSummary(counts, overview);
    renderRooms();
    renderDirectionControl();
    renderScopeControl();
    elements.graphSignalCount.textContent =
      `${counts.RUNNING} running · ${counts.READY} ready · `
      + `${overview.needsYou.length} need you · `
      + (overview.sourceDirty ? "local changes" : "exact source");
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

  function renderDirectionControl() {
    const leftToRight = layoutDirection === "ltr";
    elements.directionLtr.setAttribute("aria-pressed", String(leftToRight));
    elements.directionTtb.setAttribute("aria-pressed", String(!leftToRight));
    elements.graph.setAttribute(
      "aria-label",
      leftToRight
        ? "Left-to-right causal graph"
        : "Top-to-bottom causal graph",
    );
    elements.canvas.dataset.direction = layoutDirection;
    const nextHref = layoutDirectionHref(location.href, layoutDirection);
    if (nextHref !== location.href) history.replaceState(null, "", nextHref);
  }

  function renderScopeControl() {
    const current = graphQuery().scope === "current";
    elements.scopeCurrent.setAttribute("aria-pressed", String(current));
    elements.scopeAll.setAttribute("aria-pressed", String(!current));
  }

  function renderOverview(overview) {
    elements.summaryDraft.textContent = String(overview.phases.DRAFT.length);
    elements.summaryReady.textContent = String(overview.phases.READY.length);
    elements.summaryRunning.textContent = String(overview.phases.RUNNING.length);
    elements.summaryDone.textContent = String(overview.phases.DONE.length);
  }

  function renderGraphSummary(counts, overview) {
    const items = [];
    const add = (count, label, icon, className) => {
      if (!count) return;
      const item = document.createElement("span");
      item.className = classes("canvas-summary-item", className);
      item.setAttribute("role", "listitem");
      const value = document.createElement("b");
      value.textContent = String(count);
      item.append(htmlIcon(icon), value, ` ${label}`);
      items.push(item);
    };
    add(counts.RUNNING, "RUNNING", "running", "phase-running");
    add(counts.READY, "READY", "play", "phase-ready");
    add(counts.DRAFT, "DRAFT", "sliders", "phase-draft");
    add(counts.DONE, "DONE", "check", "phase-done");
    add(overview.needsYou.length, "NEEDS YOU", "pending", "substate-needs-you");
    elements.graphSummary.replaceChildren(...items);
  }

  function renderRooms() {
    const rooms = state.rooms?.rooms ?? [];
    elements.roomsCount.textContent = String(rooms.length);
    elements.roomsTree.replaceChildren(...rooms.map((room) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "treeitem");
      button.setAttribute("aria-selected", String(selectedRoom === room.room));
      button.setAttribute("aria-level", String(room.room.split("/").length));
      button.dataset.room = room.room;
      button.style.setProperty("--room-depth", String(room.room.split("/").length - 1));
      button.append(htmlIcon("room"));
      const label = document.createElement("span");
      label.className = "room-tree-label";
      const strong = document.createElement("strong");
      strong.textContent = room.roomId;
      const small = document.createElement("small");
      small.textContent = `${room.contexts.length} Context · ${room.consumingTickets.length} Tickets`;
      label.append(strong, small);
      const presentation = roomStatePresentation(room.drift.state);
      const drift = document.createElement("span");
      drift.className = `room-drift state-${room.drift.state.toLowerCase()}`;
      drift.append(htmlIcon(presentation.icon));
      if (room.drift.state !== "FRESH") drift.append(presentation.label);
      else drift.setAttribute("aria-label", "Fresh");
      button.append(label, drift);
      button.addEventListener("click", () => selectRoom(
        selectedRoom === room.room ? null : room.room,
      ));
      return button;
    }));
    const active = rooms.find((room) => room.room === selectedRoom);
    elements.roomDetail.hidden = !active;
    elements.roomEmpty.hidden = Boolean(active);
    if (!active) {
      const emptyLabel = elements.roomEmpty.querySelector("strong");
      const coldStart = state.rooms?.coldStart === true;
      const presentation = roomStatePresentation("COLD_START");
      emptyLabel.textContent = coldStart ? presentation.label : "Select a Room";
      const use = elements.roomEmpty.querySelector("use");
      use.setAttribute("href", `#icon-${coldStart ? presentation.icon : "room"}`);
    }
    if (active) renderRoomDetail(active);
    const filteredRooms = graphQuery().rooms;
    elements.roomFilterStatus.hidden = filteredRooms.length === 0;
    elements.roomFilterName.textContent = filteredRooms.join(" + ");
  }

  function selectRoom(room) {
    selectedRoom = room;
    roomView = "context";
    renderRooms();
  }

  function renderRoomDetail(room) {
    const presentation = roomStatePresentation(room.drift.state);
    elements.roomTitle.textContent = room.roomId;
    elements.roomBoundary.textContent = room.boundary;
    elements.roomContextCount.textContent = String(room.contexts.length);
    elements.roomTicketCount.textContent = String(room.consumingTickets.length);
    elements.roomState.className = `room-state state-${room.drift.state.toLowerCase()}`;
    elements.roomState.replaceChildren(
      htmlIcon(presentation.icon),
      document.createTextNode(presentation.label),
    );
    for (const tab of document.querySelectorAll("[data-room-view]")) {
      tab.setAttribute("aria-selected", String(tab.dataset.roomView === roomView));
    }
    const rows = roomView === "context"
      ? room.contexts.map((item) => [item.contextId, item.summary])
      : roomView === "tickets"
        ? room.consumingTickets.map((ticketId) => [ticketId, "Consumes this Room subtree"])
        : roomDriftRows(room);
    const present = rows.length ? rows : [roomEmptyRow(roomView)];
    elements.roomDetailContent.replaceChildren(...present.map(([title, detail]) => {
      const row = document.createElement("div");
      row.className = "room-detail-row";
      const strong = document.createElement("strong");
      strong.textContent = title;
      const small = document.createElement("small");
      small.textContent = detail;
      row.append(strong, small);
      return row;
    }));
    elements.roomFilterAction.disabled = graphQuery().rooms.includes(room.room);
    elements.roomFilterAction.querySelector("span").textContent = elements.roomFilterAction.disabled
      ? "Showing related Tickets"
      : "Show related Tickets";
  }

  function roomEmptyRow(view) {
    if (view === "tickets") {
      return ["No Tickets", "No Ticket consumes this Room subtree yet."];
    }
    return ["No Context", "This Room is an empty shell: its boundary is set and no Context has been written into it yet."];
  }

  function roomStatePresentation(stateLabel) {
    return ROOM_STATE_PRESENTATION[stateLabel]
      ?? { label: String(stateLabel || "COLD_START"), icon: "alert-circle" };
  }

  function roomDriftRows(room) {
    const drift = room.drift;
    const presentation = roomStatePresentation(drift.state);
    if (drift.state === "FRESH") return [["FRESH", "Aligned with the current Git snapshot"]];
    const rows = [];
    if (drift.reason) rows.push([presentation.label, drift.reason]);
    for (const key of ["changed", "added", "deleted"]) {
      if (drift[key]?.length) rows.push([`${drift[key].length} ${key}`, drift[key].join(", ")]);
    }
    return rows.length ? rows : [[presentation.label, "Room alignment needs attention"]];
  }

  function toggleRooms(force = null) {
    const open = force ?? elements.roomsPanel.hidden;
    elements.roomsPanel.hidden = !open;
    elements.roomsPanel.inert = !open;
    elements.roomsButton.setAttribute("aria-expanded", String(open));
    elements.roomsButton.classList.toggle("active", open);
  }

  async function applyRoomFilter() {
    if (!selectedRoom || graphQuery().rooms.includes(selectedRoom)) return;
    roomFilterSnapshot = {
      url: location.href,
      positions: new Map(positions),
      panX,
      panY,
      scale,
      selected,
    };
    const url = new URL(location.href);
    url.searchParams.append("room", selectedRoom);
    history.replaceState(null, "", url.href);
    await refresh(`Showing ${selectedRoom} Tickets`, { preserveLayout: true });
  }

  async function clearRoomFilter() {
    const snapshot = roomFilterSnapshot;
    const url = snapshot ? new URL(snapshot.url) : new URL(location.href);
    if (!snapshot) url.searchParams.delete("room");
    history.replaceState(null, "", url.href);
    if (snapshot) {
      positions = new Map(snapshot.positions);
      panX = snapshot.panX;
      panY = snapshot.panY;
      scale = snapshot.scale;
      selected = snapshot.selected;
    }
    await refresh("Room filter cleared", { preserveLayout: true });
    if (snapshot) {
      await new Promise((resolve) => requestAnimationFrame(
        () => requestAnimationFrame(resolve),
      ));
      panX = snapshot.panX;
      panY = snapshot.panY;
      scale = snapshot.scale;
      applyTransform();
    }
    roomFilterSnapshot = null;
  }

  function renderGraph() {
    elements.edgeLayer.replaceChildren();
    elements.nodeLayer.replaceChildren();
    if (!state) return;
    const stubGeometries = historyStubGeometries();
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
      const geometry = graphGeometry.routes.get(relation.relationRef);
      if (!geometry) continue;
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

    for (const stub of state.graph.stubs ?? []) {
      const geometry = stubGeometries.get(stub.stubRef);
      if (!geometry) continue;
      elements.edgeLayer.append(svg("path", {
        class: "history-stub-link",
        d: geometry.connector.path,
        "aria-hidden": "true",
      }));
      elements.edgeLayer.append(svg("circle", {
        class: "history-stub-knot",
        cx: geometry.connector.start.x,
        cy: geometry.connector.start.y,
        r: 2.75,
        "aria-hidden": "true",
      }));
    }

    for (const stub of state.graph.stubs ?? []) {
      const geometry = stubGeometries.get(stub.stubRef);
      if (!geometry) continue;
      const point = geometry.position;
      const nextTicketLabel = stub.nextTicketIds.join(", ");
      const group = svg("g", {
        class: "history-stub",
        transform: `translate(${point.x} ${point.y})`,
        role: "button",
        tabindex: "0",
        "aria-label": `${stub.hiddenTicketCount} hidden archived Ticket${stub.hiddenTicketCount === 1 ? "" : "s"} ${stub.direction}; reveal next hop: ${nextTicketLabel}`,
      });
      group.dataset.stubRef = stub.stubRef;
      group.append(svg("rect", {
        class: "history-stub-boundary",
        width: HISTORY_STUB.width,
        height: HISTORY_STUB.height,
        rx: 10,
      }));
      const label = svg("text", {
        class: "history-stub-label",
        x: 12,
        y: 30,
      });
      label.textContent = `${stub.hiddenTicketCount} archived`;
      const action = svg("text", {
        class: "history-stub-action",
        x: 12,
        y: 48,
      });
      action.textContent = `reveal ${stub.direction} ${stub.direction === "upstream" ? "←" : "→"}`;
      group.append(label, action);
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        void revealHistory(stub.nextTicketIds);
      });
      group.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          void revealHistory(stub.nextTicketIds);
        }
      });
      elements.nodeLayer.append(group);
    }

    for (const ticket of state.graph.tickets) {
      const position = positions.get(ticket.ticketId);
      if (!position) continue;
      const isSelected =
        selected?.kind === "ticket" && selected.id === ticket.ticketId;
      const presentation = ticketNodePresentation(ticket, {
        selected: isSelected,
        dimmed: Boolean(related && !related.nodes.has(ticket.ticketId)),
      });
      const { phase } = presentation;
      const group = svg("g", {
        class: classes(presentation.className, ticket.archived ? "archived" : ""),
        transform: `translate(${position.x} ${position.y})`,
        role: "button",
        tabindex: "0",
        "aria-label": `${presentation.ariaLabel}${ticket.archived ? " ARCHIVED delivery history." : ""}`,
        "data-full-text": `${ticket.ticketId}\n${ticket.outcome}`,
      });
      group.dataset.ticketId = ticket.ticketId;
      group.append(
        svg("rect", {
          class: "ticket-boundary",
          x: 0,
          y: 0,
          width: NODE.width,
          height: NODE.height,
          rx: 9,
        }),
        svg("circle", {
          class: "ticket-aperture",
          cx: layoutDirection === "ltr" ? NODE.width : NODE.width / 2,
          cy: layoutDirection === "ltr" ? NODE.height / 2 : NODE.height,
          r: 6,
        }),
        svg("line", {
          class: "ticket-proof",
          x1: 9,
          y1: NODE.height - 1.5,
          x2: NODE.width - 9,
          y2: NODE.height - 1.5,
        }),
      );
      if (phase.substate) {
        const substateText = phase.substate.replaceAll("_", " ");
        const substateBadge = svg("g", {
          class: "ticket-substate-badge",
          transform: `translate(${NODE.width - 8} -12)`,
        });
        substateBadge.append(
          svg("rect", { x: -88, y: 0, width: 88, height: 24, rx: 12 }),
          svgIcon(SUBSTATE_ICON_IDS[phase.substate], {
            class: "ticket-substate-icon",
            x: -81,
            y: 4,
            width: 16,
            height: 16,
          }),
        );
        const substateLabel = svg("text", {
          class: "ticket-substate-label",
          x: -61,
          y: 15,
        });
        substateLabel.textContent = substateText;
        substateBadge.append(substateLabel);
        group.append(substateBadge);
      }
      const id = svg("text", { class: "ticket-id", x: 14, y: 22 });
      id.textContent = shortTicketId(ticket.ticketId);
      group.append(id);
      // The state is always a textual label; color is a secondary accent.
      {
        const visibleState = ticket.archived ? "ARCHIVED" : phase.label;
        const stateIcon = svgIcon(STATE_ICON_IDS[visibleState], {
          class: "ticket-state-icon",
          x: NODE.width - 80,
          y: NODE.height - 22,
          width: 14,
          height: 14,
        });
        const status = svg("text", {
          class: "ticket-state",
          x: NODE.width - 14,
          y: NODE.height - 12,
          "text-anchor": "end",
        });
        status.textContent = visibleState;
        group.append(stateIcon, status);
      }
      if (phase.live) {
        group.append(svg("circle", {
          class: "ticket-live-indicator",
          cx: NODE.width - 92,
          cy: NODE.height - 17,
          r: 3,
        }));
      }
      // A 232px card has 204px of copy width after its 14px insets. The
      // selected 12px system monospace face fits 28 display units there;
      // using a wider logical measure lets SVG text escape the card even
      // though the line count is clamped.
      wrap(ticket.outcome, 28, 3).forEach((line, index) => {
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
      group.addEventListener("click", (event) => {
        event.stopPropagation();
        void selectTicket(ticket.ticketId);
      });
      group.addEventListener(
        "keydown",
        (event) => onNodeKey(event, ticket.ticketId),
      );
      elements.nodeLayer.append(group);
      const stateIcon = group.querySelector(".ticket-state-icon");
      const stateLabel = group.querySelector(".ticket-state");
      if (stateIcon && stateLabel) {
        // Keep labels right-aligned, then position the icon from the actual
        // rendered label width. The 18px subtraction is 14px of icon plus a
        // deliberate four-pixel gap, independent of label length.
        const labelWidth = stateLabel.getComputedTextLength();
        stateIcon.setAttribute(
          "x",
          String(NODE.width - 14 - labelWidth - 18),
        );
      }
    }
    applyTransform();
  }

  function historyStubGeometries() {
    const result = new Map();
    const occupied = [...positions.values()].map((position) => ({
      ...position,
      width: NODE.width,
      height: NODE.height,
    }));
    const routes = [...graphGeometry.routes.values()];
    for (const stub of [...(state?.graph?.stubs ?? [])]
      .sort((left, right) => left.stubRef.localeCompare(right.stubRef))) {
      const anchor = positions.get(stub.anchorTicketId);
      if (!anchor) continue;
      const geometry = graphLayoutModel.historyStubGeometry(
        anchor,
        stub.direction,
        layoutDirection,
        occupied,
        routes,
      );
      result.set(stub.stubRef, geometry);
      occupied.push({ ...geometry.position, ...HISTORY_STUB });
    }
    return result;
  }

  async function revealHistory(ticketIds) {
    const url = new URL(location.href);
    const existing = new Set(url.searchParams.getAll("history"));
    for (const id of ticketIds) existing.add(id);
    url.searchParams.delete("history");
    for (const id of [...existing].sort()) url.searchParams.append("history", id);
    history.replaceState(null, "", url.href);
    await refresh("Archived history expanded one hop", { preserveLayout: true });
    const revealedTicket = ticketIds.find((ticketId) =>
      state.graph.tickets.some((ticket) => ticket.ticketId === ticketId));
    if (revealedTicket) {
      elements.nodeLayer
        .querySelector(`[data-ticket-id="${CSS.escape(revealedTicket)}"]`)
        ?.focus();
    }
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
      const route = graphGeometry.routes.get(relation.relationRef);
      if (!route) continue;
      elements.minimap.append(svg("polyline", {
        points: route.points.map((point) => `${point.x},${point.y}`).join(" "),
        fill: "none",
        stroke: "#9aa59f",
        "stroke-width": 4,
      }));
    }
    for (const ticket of state.graph.tickets) {
      const position = positions.get(ticket.ticketId);
      if (!position) continue;
      const presentation = ticketNodePresentation(ticket);
      elements.minimap.append(svg("rect", {
        class: classes(
          "minimap-node",
          ...presentation.className.split(" ").filter((name) => name !== "ticket-node"),
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
    syncFocusUrl();
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
    const overview = workbenchOverview(state.graph.tickets, state.graph.source);
    elements.inspectorOutcome.textContent = graphNarrative(counts, overview);
    const content = document.createDocumentFragment();
    content.append(section(
      "Execution signal",
      stateSummary(counts, overview),
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
    syncFocusUrl(ticketId, initialViewId);
    openInspector();
    elements.inspectorEyebrow.textContent =
      `Ticket · ${ticket.ticketId}`;
    elements.inspectorTitle.textContent = ticket.outcome;
    elements.inspectorTitle.dataset.fullText = ticket.outcome;
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
    elements.inspectorTitle.dataset.fullText = ticket.outcome;
    const operational = ticketOperationalState(ticket);
    const attention = ticketAttentionState(ticket);
    const nextAction = ticketNextAction(ticket);
    elements.inspectorOutcome.hidden = true;
    elements.inspectorOutcome.textContent = "";

    const execution = ticketExecutionPanel(
      ticket,
      contextPackage,
      operational,
      attention,
      nextAction,
    );
    const contract = ticketContractPanel(
      ticket,
      contextPackage,
      inspection,
      nextAction,
    );
    const proof = ticketProofPanel(contextPackage, nextAction);
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
      nextAction,
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
    syncFocusUrl();
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
    syncFocusUrl();
    elements.inspector.classList.remove("open");
    elements.workspace.classList.add("inspector-closed");
    elements.inspector.setAttribute("aria-hidden", "true");
    elements.inspector.inert = true;
    renderGraph();
    requestAnimationFrame(() => focusGraphSubject(restore));
  }

  function syncFocusUrl(ticketId = null, viewId = null) {
    const nextHref = localFocusHref(location.href, ticketId, viewId);
    if (nextHref === location.href) return;
    history.replaceState(null, "", nextHref);
  }

  function openOverview() {
    elements.overviewPanel.hidden = false;
    elements.overviewPanel.inert = false;
    elements.graphSignal.setAttribute("aria-expanded", "true");
    elements.closeOverview.focus();
  }

  function closeOverview(restoreFocus = true) {
    elements.overviewPanel.hidden = true;
    elements.overviewPanel.inert = true;
    elements.graphSignal.setAttribute("aria-expanded", "false");
    if (restoreFocus) elements.graphSignal.focus();
  }

  function toggleOverview() {
    if (elements.overviewPanel.hidden) openOverview();
    else closeOverview();
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
      target.dataset.fullText = relation.targetTicketId;
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
      syncFocusUrl(ticketId, tabs[index].id);
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

  function ticketExecutionPanel(
    ticket,
    contextPackage,
    operational,
    attention,
    nextAction,
  ) {
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

    const phase = ticketPhasePresentation(ticket);
    const signal = document.createElement("section");
    signal.className = classes("recommended-action", `phase-${phase.key}`);
    const heading = document.createElement("div");
    heading.className = "recommended-action-heading";
    const copy = document.createElement("span");
    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Recommended action";
    const label = document.createElement("strong");
    label.className = "recommended-action-title";
    label.textContent = recommendedActionTitle(nextAction?.action);
    label.tabIndex = 0;
    label.dataset.fullText = nextAction?.detail
      || "Inspect the current Ticket context.";
    label.setAttribute("aria-describedby", "textTooltip");
    copy.append(eyebrow, label);
    const closeout = nextAction?.action === "CLOSE_OUT";
    const handoff = actionButton({
      label: "Copy prompt",
      className: classes("agent-handoff", closeout ? "closeout-handoff" : ""),
      onClick: () => void copyPayload(
        agentHandoffPayload(ticket, contextPackage, operational),
        closeout
          ? `Closeout handoff for ${ticket.ticketId} copied`
          : `Ticket ${ticket.ticketId} copied for Agent`,
      ),
    });
    heading.append(copy, handoff);

    const phaseMeta = document.createElement("div");
    phaseMeta.className = "recommended-action-phase";
    phaseMeta.textContent = phase.substate
      ? `${phase.label} · ${phase.substate.replaceAll("_", " ")}`
      : phase.label;

    const metrics = document.createElement("div");
    metrics.className = "ticket-signal-metrics";
    metrics.append(
      signalMetric(`${completed} / ${incoming.length}`, "prerequisites"),
      signalMetric(
        String(Math.max(0, incoming.length - completed)),
        "blockers",
      ),
      signalMetric(String(outgoing.length), "unlocks"),
      signalMetric(nextAction?.action || "—", "next action"),
      signalMetric("Reading", "evidence", "proof-metric"),
    );
    signal.append(heading, phaseMeta, metrics);
    panel.append(signal);

    const review = closeoutReviewBrief(contextPackage, nextAction);
    if (review) panel.append(review);

    if (attention) panel.append(humanAttentionBrief(attention));

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

  function humanAttentionBrief(attention) {
    const labels = {
      UPCOMING: "Human boundary ahead",
      PENDING: "Human evidence pending",
      RECORDED: "Human evidence recorded",
      COMPLETE: "Human boundary accepted",
    };
    const brief = document.createElement("div");
    brief.className = classes(
      "human-attention-brief",
      `attention-${attention.key}`,
    );
    const marker = document.createElement("span");
    marker.className = "human-attention-mark";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = labels[attention.label];
    const detail = document.createElement("span");
    detail.textContent = attention.detail;
    copy.append(title, detail);
    const count = document.createElement("span");
    count.className = "human-attention-count";
    count.textContent = `${attention.humanEvidenceCount} / ${attention.humanAcceptanceCount}`;
    brief.append(marker, copy, count);
    return brief;
  }

  function agentHandoffPayload(ticket, contextPackage, operational) {
    // The canonical host projection owns routing. Operational state and human
    // attention remain separate context; the browser never re-derives whether
    // this Ticket should execute, wait, ask a human, close out, or replan.
    const stateLabel = operational?.label || "UNPROJECTED";
    const nextAction = ticketNextAction(ticket);
    const canonical = contextPackage.agentPayload ?? {
      kind: "vibehub_ticket_handoff",
      ticketId: ticket.ticketId,
    };
    if (contextPackage.agentPayload) return canonical;
    return {
      ...canonical,
      instruction: agentHandoffInstruction(ticket.ticketId, nextAction, stateLabel),
    };
  }

  function recommendedActionTitle(action) {
    return {
      EXECUTE: "Start work",
      REFINE: "Define task",
      REPLAN: "Revise task",
      WAIT: "Review blockers",
      NEEDS_HUMAN: "Respond",
      CLOSE_OUT: "Verify & close",
      DONE: "Review outcome",
    }[action] || "Inspect task";
  }

  function closeoutReviewBrief(contextPackage, nextAction) {
    if (nextAction?.action !== "CLOSE_OUT") return null;
    const acceptance = contextPackage.acceptance || [];
    const evidence = contextPackage.evidence || [];
    const brief = document.createElement("div");
    brief.className = "closeout-review-brief";
    const marker = document.createElement("span");
    marker.className = "closeout-review-mark";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = "Ready for independent closeout";
    const detail = document.createElement("span");
    detail.textContent = `${acceptance.length} / ${acceptance.length} criteria have authority-satisfying Evidence across ${evidence.length} record${evidence.length === 1 ? "" : "s"}. Outcome is pending; Evidence is proof, not judgment.`;
    copy.append(title, detail);
    const action = document.createElement("b");
    action.textContent = "CLOSE OUT";
    brief.append(marker, copy, action);
    return brief;
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
    return operationalPriority(ticketPhasePresentation(ticket).label);
  }

  function causalTicketButton(ticketId) {
    const ticket = state.graph.tickets.find((item) => item.ticketId === ticketId);
    const phase = ticketPhasePresentation(ticket);
    const button = document.createElement("button");
    button.type = "button";
    button.className = classes(
      "causal-ticket",
      `phase-${phase.key}`,
    );
    button.dataset.fullText = ticketId;
    button.setAttribute("aria-label", ticketId);
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
    title.dataset.fullText = ticketId;
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

  function ticketContractPanel(ticket, contextPackage, inspection, nextAction) {
    const panel = document.createElement("section");
    const acceptance = contextPackage.acceptance || [];
    const constraints = contextPackage.constraints || [];
    const contextRefs = contextPackage.contextRefs || [];
    const relations = contextPackage.relations || [];
    const provenanceRefs =
      contextPackage.provenanceRefs || ticket.provenanceRefs || [];
    const summary = contractBrief(acceptance);
    panel.append(summary);
    const review = closeoutReviewBrief(contextPackage, nextAction);
    if (review) panel.append(review);
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

  function contractBrief(acceptance) {
    const acceptanceCount = acceptance.length;
    const humanCount = acceptance.filter(
      (item) => item.authority === "human",
    ).length;
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
    title.textContent = `${acceptanceCount} acceptance condition${acceptanceCount === 1 ? "" : "s"} define success`
      + (humanCount ? ` · ${humanCount} require human authority` : "");
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
      const authority = item.authority || "agent";
      row.className = classes(
        "acceptance-item",
        authority === "human" ? "authority-human" : "",
      );
      row.dataset.acceptanceId = item.acceptanceId;
      row.dataset.authority = authority;
      const summary = document.createElement("summary");
      const marker = document.createElement("span");
      marker.className = "acceptance-marker";
      marker.setAttribute("aria-hidden", "true");
      const title = document.createElement("strong");
      title.textContent = humanizeIdentifier(item.acceptanceId);
      const status = document.createElement("span");
      status.className = "acceptance-status";
      status.textContent = authority === "human"
        ? "Human evidence pending"
        : "Awaiting evidence";
      const meta = document.createElement("span");
      meta.className = "acceptance-meta";
      if (authority === "human") {
        const badge = document.createElement("span");
        badge.className = "acceptance-authority";
        badge.textContent = "Human";
        meta.append(badge);
      }
      meta.append(status);
      summary.append(marker, title, meta);
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
    if (canonical?.room) {
      const roomLabel = document.createElement("span");
      roomLabel.className = "context-room";
      roomLabel.textContent = canonical.room;
      heading.append(roomLabel);
    }
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

  function ticketProofPanel(contextPackage, nextAction) {
    const panel = document.createElement("section");
    const summary = document.createElement("div");
    summary.className = "proof-summary";
    const label = document.createElement("strong");
    label.textContent = "Reading Evidence…";
    const detail = document.createElement("span");
    detail.textContent = "Acceptance-linked Evidence and independent Outcome appear here.";
    summary.append(label, detail);
    panel.append(summary);
    const review = closeoutReviewBrief(contextPackage, nextAction);
    if (review) panel.append(review);
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
    const humanEvidenced = new Set(evidence
      .filter((record) => record.origin === "human")
      .flatMap((record) => record.acceptanceIds || []));
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
      contractDetail.textContent = target.nextAction?.action === "CLOSE_OUT"
        ? "Authority satisfied · independent Outcome pending"
        : "Independent Outcome pending";
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
      detail.textContent = target.nextAction?.action === "CLOSE_OUT"
        ? `${evidenced.size} of ${target.acceptanceCount} criteria are authority-satisfied; independent adjudication is next.`
        : `${evidenced.size} of ${target.acceptanceCount} criteria have Evidence attached.`;
    }

    target.acceptanceRail.querySelectorAll("[data-acceptance-id]").forEach((row) => {
      const id = row.dataset.acceptanceId;
      const human = row.dataset.authority === "human";
      const status = row.querySelector(".acceptance-status");
      row.classList.remove(
        "has-evidence",
        "has-human-evidence",
        "is-accepted",
        "is-unresolved",
      );
      if (accepted.has(id)) {
        row.classList.add("is-accepted");
        status.textContent = human
          ? "Human acceptance verified"
          : "Accepted";
      } else if (unresolved.has(id)) {
        row.classList.add("is-unresolved");
        status.textContent = human
          ? "Human acceptance unresolved"
          : "Unresolved";
      } else if (human && humanEvidenced.has(id)) {
        row.classList.add("has-human-evidence");
        status.textContent = "Human evidence recorded";
      } else if (human) {
        status.textContent = "Human evidence pending";
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
        record.kind === "evidence" ? `${record.origin || "agent"} origin` : null,
        formatInstant(record.occurredAt),
      ].filter(Boolean).join(" · ");
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

  function stateSummary(counts, overview = null) {
    const result = document.createElement("div");
    result.className = "execution-state-copy";
    const primary = document.createElement("strong");
    primary.textContent = graphSummary(counts, overview);
    const detail = document.createElement("span");
    detail.textContent = "Select a Ticket or direct unlock to reveal its exact bounded context and Git trace.";
    result.append(primary, detail);
    return result;
  }

  function executionStateView(ticket) {
    const operational = ticketOperationalState(ticket);
    const phase = ticketPhasePresentation(ticket);
    if (!operational && !phase) return null;
    const wrapper = document.createElement("div");
    wrapper.className = classes(
      "execution-state",
      `phase-${phase.key}`,
    );
    wrapper.setAttribute(
      "aria-label",
      `${phase.label}${phase.substate ? `. ${phase.substate.replaceAll("_", " ")}` : ""}. ${operational?.detail || ""}`,
    );

    const marker = document.createElement("span");
    marker.className = "execution-state-mark";
    marker.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "execution-state-copy";
    const label = document.createElement("strong");
    label.textContent = phase.substate
      ? `${phase.label} · ${phase.substate.replaceAll("_", " ")}`
      : phase.label;
    copy.append(label);
    if (operational?.detail) {
      const detail = document.createElement("span");
      detail.textContent = operational.detail;
      copy.append(detail);
    }
    wrapper.append(marker, copy);

    const references = executionStateReferences(operational?.references || []);
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
      button.dataset.fullText = reference.ref;
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
      label.dataset.fullText = target.target;
      if (label instanceof HTMLAnchorElement) {
        label.href = target.href || target.actions.githubHref;
        label.target = "_blank";
        label.rel = "noreferrer";
        label.classList.add("linked-reference");
        label.setAttribute(
          "aria-label",
          target.actions?.githubHref
            ? `Open ${target.target} on GitHub`
            : `Open ${target.target}`,
        );
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
      label.dataset.fullText = normalized.target;
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

  function layoutGraph(tickets, relations, direction = "ltr", options) {
    return graphLayoutModel.layoutGraph(tickets, relations, direction, options);
  }

  function graphBounds() {
    if (!positions.size) return null;
    const values = [...positions.values()].map((value) => ({
      ...value,
      width: NODE.width,
      height: NODE.height,
    }));
    for (const geometry of historyStubGeometries().values()) {
      values.push({ ...geometry.position, ...HISTORY_STUB });
    }
    const minX = Math.min(...values.map((value) => value.x));
    const minY = Math.min(...values.map((value) => value.y));
    const maxX = Math.max(
      ...values.map((value) => value.x + value.width),
    );
    const maxY = Math.max(
      ...values.map((value) => value.y + value.height),
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
    panX =
      layoutDirection === "ltr" && bounds.width * scale > width - padding * 2
        ? padding - bounds.x * scale
        : (width - bounds.width * scale) / 2 - bounds.x * scale;
    panY = layoutDirection === "ttb"
      && bounds.height * scale > height - padding * 2
      ? padding - bounds.y * scale
      : (height - bounds.height * scale) / 2 - bounds.y * scale;
    applyTransform();
  }

  function setLayoutDirection(direction) {
    const next = normalizeLayoutDirection(direction);
    if (next === layoutDirection) return;
    layoutDirection = next;
    graphGeometry = layoutGraph(
      state.graph.tickets,
      state.graph.relations,
      layoutDirection,
    );
    positions = graphGeometry.positions;
    const nextHref = layoutDirectionHref(location.href, layoutDirection);
    history.replaceState(null, "", nextHref);
    renderDirectionControl();
    renderGraph();
    renderMinimap();
    requestAnimationFrame(frameGraph);
  }

  async function setGraphScope(scope) {
    if (scope === graphQuery().scope) return;
    const url = new URL(location.href);
    url.searchParams.set("scope", scope);
    if (scope === "all") url.searchParams.delete("history");
    history.replaceState(null, "", url.href);
    selected = null;
    await refresh(scope === "all" ? "Showing all Ticket history" : "Showing current work");
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
    const directionSpec = layoutDirectionSpec(layoutDirection);
    const upstream = event.key === directionSpec.upstreamKey;
    const downstream = event.key === directionSpec.downstreamKey;
    if (!upstream && !downstream) return;
    event.preventDefault();
    const relation = state.graph.relations.find((item) =>
      upstream
        ? item.dependentTicketId === ticketId
        : item.prerequisiteTicketId === ticketId,
    );
    const target = upstream
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

  function textTooltipCandidate(target) {
    if (!(target instanceof Element)) return null;
    const explicit = target.closest("[data-full-text]");
    if (explicit?.dataset.fullText?.trim()) {
      return { anchor: explicit, text: explicit.dataset.fullText.trim() };
    }
    let candidate = target instanceof HTMLElement ? target : target.parentElement;
    while (candidate && candidate !== document.body) {
      const text = candidate.textContent?.trim();
      if (
        candidate !== elements.textTooltip
        && text
        && candidate.childElementCount === 0
        && (candidate.scrollWidth > candidate.clientWidth + 1
          || candidate.scrollHeight > candidate.clientHeight + 1)
      ) {
        return { anchor: candidate, text };
      }
      candidate = candidate.parentElement;
    }
    return null;
  }

  function showTextTooltip(candidate) {
    if (!candidate || !candidate.text) {
      hideTextTooltip();
      return;
    }
    tooltipAnchor = candidate.anchor;
    elements.textTooltip.textContent = candidate.text;
    elements.textTooltip.hidden = false;
    const anchorRect = candidate.anchor.getBoundingClientRect();
    const tooltipRect = elements.textTooltip.getBoundingClientRect();
    const left = clamp(
      anchorRect.left,
      12,
      Math.max(12, window.innerWidth - tooltipRect.width - 12),
    );
    const below = anchorRect.bottom + 8;
    const top = below + tooltipRect.height <= window.innerHeight - 12
      ? below
      : Math.max(12, anchorRect.top - tooltipRect.height - 8);
    elements.textTooltip.style.left = `${left}px`;
    elements.textTooltip.style.top = `${top}px`;
  }

  function hideTextTooltip() {
    tooltipAnchor = null;
    elements.textTooltip.hidden = true;
    elements.textTooltip.textContent = "";
    elements.textTooltip.style.removeProperty("left");
    elements.textTooltip.style.removeProperty("top");
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
    elements.sourcePath.textContent = source.worktreeRoot;
    elements.sourcePath.dataset.fullText = source.worktreeRoot;
    elements.sourceBranch.textContent = source.branch || "detached";
    elements.sourceCommit.textContent = source.resolvedCommit
      ? source.resolvedCommit.slice(0, 10)
      : "unborn HEAD";
    elements.sourceCommit.title = source.resolvedCommit || "unborn HEAD";
    elements.sourceDirty.textContent = source.semanticDirty
      ? `${dirtyPathCount(source)} local change`
        + `${source.dirtyPaths.length === 1 && !source.dirtyPathsTruncated ? "" : "s"}`
      : "Clean";
    elements.sourceDirtyDot.className =
      `source-state-dot${source.semanticDirty ? " dirty" : ""}`;
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

  document.addEventListener("pointerover", (event) => {
    showTextTooltip(textTooltipCandidate(event.target));
  });
  document.addEventListener("pointerout", (event) => {
    if (tooltipAnchor?.contains(event.relatedTarget)) return;
    hideTextTooltip();
  });
  document.addEventListener("focusin", (event) => {
    showTextTooltip(textTooltipCandidate(event.target));
  });
  document.addEventListener("focusout", (event) => {
    if (tooltipAnchor?.contains(event.relatedTarget)) return;
    hideTextTooltip();
  });

  elements.sourceStatus.addEventListener(
    "click",
    () => void refresh("Graph refreshed from Git"),
  );
  elements.copyLink.addEventListener("click", () => {
    void copyText(
      location.href,
      "Focused local link copied · valid while this host is running",
    );
  });
  elements.roomsButton.addEventListener("click", () => toggleRooms());
  elements.closeRooms.addEventListener("click", () => {
    toggleRooms(false);
    elements.roomsButton.focus();
  });
  elements.roomsPanel.addEventListener("click", (event) => event.stopPropagation());
  for (const tab of document.querySelectorAll("[data-room-view]")) {
    tab.addEventListener("click", () => {
      roomView = tab.dataset.roomView;
      const room = state?.rooms?.rooms.find((item) => item.room === selectedRoom);
      if (room) renderRoomDetail(room);
    });
  }
  elements.roomFilterAction.addEventListener("click", () => void applyRoomFilter());
  elements.clearRoomFilter.addEventListener("click", () => void clearRoomFilter());
  elements.roomFilterStatus.addEventListener("click", (event) => event.stopPropagation());
  elements.graphSignal.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleOverview();
  });
  elements.overviewPanel.addEventListener("click", (event) => {
    event.stopPropagation();
  });
  elements.closeOverview.addEventListener("click", () => closeOverview());
  elements.sourceRef.addEventListener("click", () => {
    if (!state) return;
    elements.sourceDockPanel.hidden = !elements.sourceDockPanel.hidden;
    elements.sourceRef.setAttribute(
      "aria-expanded",
      String(!elements.sourceDockPanel.hidden),
    );
  });
  elements.closeSourceDock.addEventListener("click", () => {
    elements.sourceDockPanel.hidden = true;
    elements.sourceRef.setAttribute("aria-expanded", "false");
    elements.sourceRef.focus();
  });
  document.querySelector(".graph-tools").addEventListener("click", (event) => {
    event.stopPropagation();
  });
  elements.directionLtr.addEventListener(
    "click",
    () => setLayoutDirection("ltr"),
  );
  elements.directionTtb.addEventListener(
    "click",
    () => setLayoutDirection("ttb"),
  );
  elements.scopeCurrent.addEventListener(
    "click",
    () => void setGraphScope("current"),
  );
  elements.scopeAll.addEventListener(
    "click",
    () => void setGraphScope("all"),
  );
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
    if (!elements.overviewPanel.hidden) closeOverview(false);
    if (selected) {
      closeInspector();
    }
  });
  elements.canvas.addEventListener("pointerdown", (event) => {
    // The controls, Rooms sheet, Inspector, and graph nodes all live inside
    // the canvas shell. Never capture their pointer sequence for panning: a
    // small real-mouse movement would otherwise retarget pointerup/click to
    // the canvas and make every nested button appear inert.
    if (event.button !== 0 || event.target.closest(
      "button, a, input, textarea, select, summary, [role='button'], "
      + "[role='treeitem'], .ticket-node, .edge, .history-stub",
    )) {
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
    if (event.key === "Escape" && !elements.roomsPanel.hidden) {
      toggleRooms(false);
      elements.roomsButton.focus();
      return;
    }
    if (event.key === "Escape" && !elements.overviewPanel.hidden) {
      closeOverview();
      return;
    }
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
