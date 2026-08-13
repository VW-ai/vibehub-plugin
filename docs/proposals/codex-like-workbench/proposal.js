(() => {
  "use strict";
  const overviewButton = document.querySelector("#overviewButton");
  const overviewPanel = document.querySelector("#overviewPanel");
  const copyButton = document.querySelector("#copyButton");
  const toast = document.querySelector("#toast");
  const graphWorld = document.querySelector("#graphWorld");
  const tabs = [...document.querySelectorAll("[role=tab]")];
  const inspectorBody = document.querySelector("#inspectorBody");
  const inspectorTitle = document.querySelector(".inspector-header h2");
  const inspectorEyebrow = document.querySelector(".inspector-header .eyebrow");
  const panels = {
    execution: inspectorBody.innerHTML,
    contract: `
      <section class="panel-section"><span class="section-label">Outcome</span><p>A concrete token system and two-axis state language are reviewable without touching production UI.</p></section>
      <section class="panel-section"><div class="section-heading"><span class="section-label">Acceptance</span><span>5 criteria</span></div>
        <button class="context-row" type="button"><span class="context-icon">1</span><span><strong>One coherent token system</strong><small>typography · space · shape · motion</small></span><span>›</span></button>
        <button class="context-row" type="button"><span class="context-icon">2</span><span><strong>State and attention remain separate</strong><small>five operational · four attention states</small></span><span>›</span></button>
        <button class="context-row" type="button"><span class="context-icon">3</span><span><strong>Victor product value is retained</strong><small>graph · cone · Inspector · source · handoff</small></span><span>›</span></button>
      </section>
      <section class="panel-section"><span class="section-label">Guardrail</span><p>Proposal only. Production Workbench assets and lifecycle semantics remain unchanged.</p></section>`,
    log: `
      <section class="panel-section"><span class="section-label">Evidence timeline</span>
        <div class="action-callout"><span class="play">◇</span><div><strong>Proposal awaiting independent proof</strong><p>Real-size browser review and mechanical contrast checks will attach here.</p></div></div>
      </section>
      <section class="panel-section compact-proof"><span class="section-label">Outcome</span><span class="proof-value">Not recorded</span></section>`,
  };

  overviewButton.addEventListener("click", () => {
    overviewPanel.hidden = !overviewPanel.hidden;
    overviewButton.setAttribute("aria-expanded", String(!overviewPanel.hidden));
  });

  copyButton.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(location.href); } catch {}
    toast.classList.add("visible");
    setTimeout(() => toast.classList.remove("visible"), 1100);
  });

  for (const button of document.querySelectorAll("[data-direction]")) {
    button.addEventListener("click", () => {
      const direction = button.dataset.direction;
      graphWorld.classList.toggle("ttb", direction === "ttb");
      for (const edge of document.querySelectorAll(".edge")) {
        edge.setAttribute("d", edge.dataset[direction]);
      }
      const handle = document.querySelector(".relation-handle");
      handle.setAttribute("cx", handle.dataset[`${direction}X`]);
      handle.setAttribute("cy", handle.dataset[`${direction}Y`]);
      for (const peer of document.querySelectorAll("[data-direction]")) {
        const active = peer === button;
        peer.classList.toggle("active", active);
        peer.setAttribute("aria-pressed", String(active));
      }
    });
  }

  for (const ticket of document.querySelectorAll(".ticket")) {
    ticket.addEventListener("click", () => {
      const previous = document.querySelector(".ticket.selected");
      previous?.classList.remove("selected");
      previous?.removeAttribute("aria-current");
      ticket.classList.add("selected");
      ticket.setAttribute("aria-current", "true");
      inspectorTitle.textContent = ticket.querySelector("strong").textContent;
      inspectorEyebrow.textContent = `Ticket · ${ticket.querySelector(".state").textContent.trim().replace(/^[^A-Z]+/u, "")}`;
    });
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      for (const peer of tabs) peer.setAttribute("aria-selected", String(peer === tab));
      inspectorBody.innerHTML = panels[tab.dataset.tab];
    });
  }
})();
