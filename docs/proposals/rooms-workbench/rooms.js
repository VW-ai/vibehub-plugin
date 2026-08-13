(() => {
  "use strict";
  const rooms = {
    workbench: {
      state: "FRESH", contexts: 2, tickets: 19,
      boundary: "Read-only graph projection, local loopback host, visual language, and interaction. Canonical YAML remains outside this Room.",
      context: [["constraint", "Quiet intelligence standard"], ["contract", "Canonical Agent output"]],
      ticketsList: ["ticket-propose-codex-like-workbench-visual-language", "ticket-prepare-rooms-workbench-proposal", "ticket-workbench-canvas-first-overview"],
      drift: [["check", "All 8 anchored files match alignment hashes"], ["archive", "Last aligned commit · 5e54b3a"]],
    },
    product: {
      state: "DRIFTED", contexts: 15, tickets: 26,
      boundary: "Product-wide direction and conventions. Not implementation of one subsystem.",
      context: [["decision", "Person-centered Ticket attention"], ["intent", "Queryable Ticket history"], ["decision", "Speed-first Skill plugin"]],
      ticketsList: ["ticket-focus-product-on-one-line-entry", "ticket-integrate-workbench-web-upgrade-pr", "ticket-publish-v070-ui-release"],
      drift: [["drift", "1 changed · docs/LOCAL_GRAPH_DESIGN.md"], ["drift", "6 added · docs/proposals/**"], ["forward", "Review Context, then align or mark stale"]],
    },
    knowledge: {
      state: "FRESH", contexts: 8, tickets: 7,
      boundary: "Context capture, Room taxonomy, retrieval, migration, and distillation.",
      context: [["decision", "Room taxonomy"], ["decision", "Drift snapshot hashes"], ["contract", "Core domain semantics"]],
      ticketsList: ["ticket-room-taxonomy-foundation", "ticket-context-always-roomed", "ticket-room-retrieval-and-discovery"],
      drift: [["check", "All anchored files match alignment hashes"]],
    },
    "ticket-lifecycle": {
      state: "FRESH", contexts: 1, tickets: 13,
      boundary: "Ticket planning, validation, execution, Evidence, and independent closeout.",
      context: [["decision", "Draft Ticket maturity"]],
      ticketsList: ["ticket-draft-ticket-maturity", "ticket-encode-human-acceptance-authority", "ticket-queryable-archived-ticket-history"],
      drift: [["check", "All 13 anchored files match alignment hashes"]],
    },
  };
  const panel = document.querySelector("#roomsPanel");
  const roomsButton = document.querySelector("#roomsButton");
  const detail = document.querySelector("#roomDetail");
  const empty = document.querySelector("#emptyDetail");
  const content = document.querySelector("#detailContent");
  const tabs = [...document.querySelectorAll("[role=tab]")];
  let selected = "workbench";
  let view = "context";
  const icon = (name) => `<svg aria-hidden="true"><use href="#icon-${name}"/></svg>`;

  function render() {
    if (!selected) return;
    const room = rooms[selected];
    document.querySelector("#roomTitle").textContent = selected;
    document.querySelector("#roomBoundary").textContent = room.boundary;
    document.querySelector("#contextCount").textContent = room.contexts;
    document.querySelector("#ticketCount").textContent = room.tickets;
    const state = document.querySelector("#roomState");
    const stateIcon = room.state === "FRESH" ? "check" : "drift";
    state.innerHTML = `${icon(stateIcon)}${room.state}`;
    state.className = `state-label ${room.state === "FRESH" ? "fresh-label" : "drift-label"}`;
    const rows = view === "context" ? room.context.map(([type, label]) => ["context", label, type])
      : view === "tickets" ? room.ticketsList.map((label) => ["ticket", label, "consuming Ticket"])
        : room.drift.map(([icon, label]) => [icon, label, room.state]);
    content.innerHTML = rows.map(([iconName, label, meta]) => `<div class="list-row"><span class="list-icon">${icon(iconName)}</span><span><strong>${label}</strong><small>${meta}</small></span><span>${icon("forward")}</span></div>`).join("");
  }

  function setPanelOpen(open) {
    panel.hidden = !open;
    roomsButton.setAttribute("aria-expanded", String(open));
    roomsButton.classList.toggle("active", open);
  }
  roomsButton.addEventListener("click", () => setPanelOpen(panel.hidden));
  document.querySelector("#closeRooms").addEventListener("click", () => setPanelOpen(false));
  for (const item of document.querySelectorAll("[data-room]")) item.addEventListener("click", () => {
    if (selected === item.dataset.room && !detail.hidden) {
      selected = null;
      detail.hidden = true; empty.hidden = false;
      for (const peer of document.querySelectorAll("[data-room]")) peer.setAttribute("aria-selected", "false");
      return;
    }
    selected = item.dataset.room;
    detail.hidden = false; empty.hidden = true;
    for (const peer of document.querySelectorAll("[data-room]")) peer.setAttribute("aria-selected", String(peer === item));
    render();
  });
  for (const tab of tabs) tab.addEventListener("click", () => {
    view = tab.dataset.view;
    for (const peer of tabs) peer.setAttribute("aria-selected", String(peer === tab));
    render();
  });
  document.querySelector("#showTickets").addEventListener("click", () => {
    for (const ticket of document.querySelectorAll(".ticket")) ticket.classList.toggle("receded", !ticket.dataset.rooms.split(" ").includes(selected));
    document.querySelector("#filterName").textContent = selected;
    document.querySelector("#filterStatus").hidden = false;
  });
  document.querySelector("#clearFilter").addEventListener("click", () => {
    for (const ticket of document.querySelectorAll(".ticket")) ticket.classList.remove("receded");
    document.querySelector("#filterStatus").hidden = true;
  });
  render();
})();
