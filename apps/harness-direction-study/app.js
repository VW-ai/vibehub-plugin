const directions = {
  ambient: {
    index: "01",
    name: "Ambient OS",
    strap: "The interface recedes. Work announces itself only when it matters.",
    reference: "Dia × Raycast × execution presence",
    verdict: "Most ownable",
    notes: [
      ["Center of gravity", "The current conversation or intention occupies the field. Navigation lives at the edge and never competes with it."],
      ["Execution language", "Trusted work is expressed as persistent signals and spatial presence, not a dashboard or transcript log."],
      ["Branching", "A subtle lineage rail is always reachable; the full topology appears as a temporary zoom-out state."],
      ["Risk", "Restraint must not become vagueness. Tickets and approvals still need crisp, learnable object surfaces."],
    ],
  },
  spatial: {
    index: "02",
    name: "Spatial Cockpit",
    strap: "Conversations, Tickets and Runs share one navigable field.",
    reference: "Msty × graph workbench × agent canvas",
    verdict: "Most expressive",
    notes: [
      ["Center of gravity", "A zoomable field shows relationships without pretending to be an automatic knowledge graph."],
      ["Execution language", "Runs occupy stable spatial positions, so parallel work can be scanned without opening every transcript."],
      ["Branching", "Forks are first-class paths. Compare is a spatial selection, while Chat remains a normal focused panel."],
      ["Risk", "Canvas mechanics can become the product. Default focus and automatic layout must keep navigation effortless."],
    ],
  },
  kinetic: {
    index: "03",
    name: "Kinetic Command",
    strap: "High signal density for people actively driving several pieces of work.",
    reference: "Linear × Warp/Oz × command palette",
    verdict: "Most immediately usable",
    notes: [
      ["Center of gravity", "A compact work queue makes readiness, activity and attention legible in one scan."],
      ["Execution language", "Rows, timelines and a persistent status lane favor precise supervision over atmosphere."],
      ["Branching", "Branches appear as tabs and compact lineage rather than dominating the application."],
      ["Risk", "This can regress into a polished operations dashboard unless Chat and thought-to-Ticket transitions stay central."],
    ],
  },
};

const state = {
  direction: "compare",
  scene: "home",
  notes: false,
  chrome: true,
};

const compareScreen = document.querySelector("#compare-screen");
const focusScreen = document.querySelector("#focus-screen");
const directionGrid = document.querySelector("#direction-grid");
const focusStage = document.querySelector("#focus-stage");
const notesPanel = document.querySelector("#concept-notes");
const notesContent = document.querySelector("#notes-content");
const keyHint = document.querySelector("#key-hint");

function icon(name) {
  const icons = { home: "⌂", chat: "◌", graph: "⌘", ticket: "□", run: "↗", search: "⌕", more: "•••", context: "◎" };
  return `<span aria-hidden="true">${icons[name] ?? name}</span>`;
}

function ambientShell(scene, mini = false) {
  const views = {
    home: `
      <div class="ao-home">
        <div class="ao-edge-nav"><button class="is-on">${icon("home")}</button><button>${icon("chat")}</button><button>${icon("graph")}</button><button>${icon("ticket")}</button></div>
        <div class="ao-intent">
          <span class="ao-whisper">MONDAY · 3 THREADS IN MOTION</span>
          <h2>What moves next?</h2>
          <button class="ao-prompt" data-demo="prompt"><span>Talk through an idea or name the work…</span><i>↗</i></button>
          <div class="ao-modes"><button class="is-on">Explore</button><button>Start work</button><button data-demo="context">${icon("context")} Context off</button></div>
        </div>
        <button class="ao-signal signal-running" data-demo="run"><i></i><span><b>Rebuild the harness</b><small>Codex · composing shell</small></span><time>03:18</time></button>
        <button class="ao-signal signal-attention"><em>!</em><span><b>Launch narrative</b><small>Your judgment is needed</small></span></button>
        <button class="ao-signal signal-ready"><em>R</em><span><b>Open-source launch</b><small>Ready to start</small></span></button>
        <div class="ao-presence-line"><span>1 running</span><i></i><span>1 needs you</span><i></i><span>1 ready</span></div>
      </div>`,
    chat: `
      <div class="ao-chat">
        <aside class="ao-lineage"><button>Origin</button><i></i><button class="is-on">Main</button><i></i><button data-demo="branch">＋</button></aside>
        <div class="ao-conversation">
          <header><div><span>HARNESS AS A PRODUCT</span><strong>Main conversation</strong></div><button>${icon("more")}</button></header>
          <div class="ao-messages">
            <article class="is-user"><span>YOU</span><p>I want this to feel like a completely different application, not a plugin-shaped feature area.</p></article>
            <article class="is-agent"><span>VIBEHUB · CODEX</span><p>Then DeepSeek Harness becomes the engine and VibeHub owns the application boundary.</p><p>Chat stays open-ended. Structure appears when thought becomes work.</p><div class="ao-inline-actions"><button data-demo="branch">Fork this thought ↗</button><button data-demo="ticket">Make ticket □</button></div></article>
          </div>
          <div class="ao-composer"><span>Keep exploring…</span><button data-demo="context">${icon("context")} Off</button><button>Codex⌄</button><i>↗</i></div>
        </div>
        <div class="ao-branch-ghost" aria-hidden="true"><span>NEW BRANCH</span><b>Application boundary</b></div>
        <button class="ao-live-capsule" data-demo="run"><i></i><span><b>Rebuild the harness</b><small>Composing application shell</small></span><time>03:18</time></button>
      </div>`,
    runs: `
      <div class="ao-runs">
        <header><span>LIVE FIELD</span><strong>Three pieces of work</strong><button>History</button></header>
        <div class="ao-orbit-field">
          <div class="ao-orbit-ring ring-one"></div><div class="ao-orbit-ring ring-two"></div>
          <button class="ao-run-core" data-demo="advance"><span class="live-rings"><i></i><i></i><i></i></span><small>RUNNING · CODEX</small><strong>Rebuild the<br />harness experience</strong><em>Composing the application shell</em><time>03:18</time></button>
          <button class="ao-orbit-item orbit-attention"><span>NEEDS YOU</span><b>Choose launch narrative</b><small>Two viable directions</small></button>
          <button class="ao-orbit-item orbit-ready"><span>READY</span><b>Prepare open-source launch</b><small>5 checks assembled</small></button>
          <button class="ao-orbit-item orbit-proof"><span>EVIDENCE</span><b>DSH extension spike</b><small>7 / 7 accepted</small></button>
        </div>
        <div class="ao-run-footer"><button>Pause all</button><span><i></i> Trusted Run events · local workspace</span><button>Open activity ↗</button></div>
      </div>`,
  };
  return `<div class="concept-app ambient-app ${mini ? "is-mini" : ""}">
    <div class="ao-backdrop"><i></i><i></i><i></i></div>
    <header class="ao-top"><strong><i>V</i> VIBEHUB</strong><button>Wayne’s space⌄</button><div><button>${icon("search")}</button><button>Engine <i class="engine-dot"></i></button><span>W</span></div></header>
    ${views[scene]}
  </div>`;
}

function spatialShell(scene, mini = false) {
  const views = {
    home: `
      <div class="sc-canvas sc-home">
        <div class="sc-grid"></div>
        <div class="sc-coordinate">X 0462　Y 0188　·　PERSONAL FIELD</div>
        <button class="sc-node current-node" data-demo="prompt"><span>START HERE</span><strong>What do you want<br />to move forward?</strong><small>Speak, paste, or open a Ticket</small><i>↗</i></button>
        <button class="sc-node node-chat"><span>CONVERSATION</span><strong>Harness as a product</strong><small>8 branches · active now</small></button>
        <button class="sc-node node-run"><i></i><span>RUNNING</span><strong>Rebuild the harness</strong><small>Codex · 03:18</small></button>
        <button class="sc-node node-attention"><em>!</em><span>NEEDS YOU</span><strong>Launch narrative</strong><small>Decision waiting</small></button>
        <button class="sc-node node-ready"><span>READY</span><strong>Open-source launch</strong><small>5 checks · Codex</small></button>
        <div class="sc-connector c-one"></div><div class="sc-connector c-two"></div><div class="sc-connector c-three"></div>
        <div class="sc-zoom"><button>−</button><span>76%</span><button>＋</button><button>⌖</button></div>
      </div>`,
    chat: `
      <div class="sc-canvas sc-chat">
        <div class="sc-grid"></div><div class="sc-coordinate">CONVERSATION FIELD　/　HARNESS AS A PRODUCT</div>
        <aside class="sc-map-rail"><span>LINEAGE</span><button><i></i>Origin</button><em></em><button class="is-on"><i></i>Main</button><em></em><button data-demo="branch"><i></i>Application shell</button><button data-demo="branch"><i></i>Task-native UX</button></aside>
        <section class="sc-chat-pod">
          <header><div><span>MAIN</span><strong>Harness as a complete product</strong></div><div><button data-demo="context">${icon("context")} Context off</button><button>${icon("more")}</button></div></header>
          <div class="sc-pod-messages"><article><span>YOU</span><p>I want this to feel like a completely different application, not a plugin-shaped feature area.</p></article><article class="agent"><span>VIBEHUB · CODEX</span><p>Then the shell itself becomes the product. DSH supplies sessions, models, tools and approvals underneath.</p><div><button data-demo="branch">Fork ↗</button><button data-demo="ticket">Crystallize Ticket □</button></div></article></div>
          <footer><span>Keep exploring…</span><button>Codex⌄</button><i>↗</i></footer>
        </section>
        <button class="sc-context-pod" data-demo="context"><span>CONTEXT LENS</span><strong>Off · nothing assumed</strong><small>Activate 3 relevant references →</small></button>
        <button class="sc-run-pod"><i></i><span>RUNNING</span><strong>Rebuild the harness</strong><small>Composing shell · 03:18</small></button>
      </div>`,
    runs: `
      <div class="sc-canvas sc-runs">
        <div class="sc-grid"></div><div class="sc-coordinate">EXECUTION FIELD　/　TRUSTED ACTIVITY ONLY</div>
        <div class="sc-run-flow flow-one"></div><div class="sc-run-flow flow-two"></div>
        <article class="sc-run-window primary-run"><header><span><i></i> RUNNING</span><time>03:18</time></header><h3>Rebuild the harness experience</h3><p>Codex · vibehub-plugin</p><div class="sc-step-list"><span class="done">✓ Context assembled</span><span class="done">✓ Direction locked</span><span class="live">● Composing application shell</span><span>○ Verify and gather evidence</span></div><footer><button>Pause</button><button data-demo="advance">Open run ↗</button></footer></article>
        <article class="sc-run-window attention-run"><header><span>! NEEDS YOU</span><time>12m</time></header><h3>Choose launch narrative</h3><p>Two viable directions change the product story.</p><footer><button>Compare decision ↗</button></footer></article>
        <article class="sc-run-window ready-run"><header><span>R READY</span><time>TODAY</time></header><h3>Prepare open-source launch</h3><p>Context assembled · 5 acceptance checks</p><footer><button>Start with Codex ↗</button></footer></article>
        <aside class="sc-run-legend"><span>3 objects</span><i></i><span>1 live</span><i></i><span>1 attention</span><button>Fit field ⌖</button></aside>
      </div>`,
  };
  return `<div class="concept-app spatial-app ${mini ? "is-mini" : ""}">
    <header class="sc-top"><strong><i>V</i> VIBEHUB</strong><nav><button>Field</button><button>Tickets</button><button>Runs</button></nav><div><button>${icon("search")} Command</button><button>W</button></div></header>
    <aside class="sc-dock"><button class="is-on">${icon("home")}<small>Home</small></button><button>${icon("chat")}<small>Chat</small></button><button>${icon("graph")}<small>Graph</small></button><button>${icon("ticket")}<small>Tickets</small></button><button>${icon("run")}<small>Runs</small></button></aside>
    ${views[scene]}
  </div>`;
}

function kineticShell(scene, mini = false) {
  const views = {
    home: `
      <div class="kc-workspace kc-home">
        <header class="kc-page-head"><div><span>MONDAY · AUG 17</span><h2>Personal command</h2></div><button data-demo="prompt">＋ New work <kbd>⌘N</kbd></button></header>
        <button class="kc-command" data-demo="prompt"><span>${icon("search")} Ask, find, or start anything</span><kbd>⌘ K</kbd></button>
        <div class="kc-metrics"><span><b>01</b>RUNNING</span><span><b>01</b>NEEDS YOU</span><span><b>03</b>READY</span><span><b>08</b>CONVERSATIONS</span></div>
        <section class="kc-active-lane"><header><span>IN MOTION</span><button>View runs →</button></header><button class="kc-work-row running" data-demo="run"><i></i><span><small>VH–014 · RUNNING</small><strong>Rebuild the harness experience</strong></span><em>Composing application shell</em><time>03:18</time><b>↗</b></button><button class="kc-work-row attention"><i>!</i><span><small>VH–011 · NEEDS YOU</small><strong>Choose the launch narrative</strong></span><em>Two directions ready to compare</em><time>12m</time><b>↗</b></button></section>
        <section class="kc-ready-lane"><header><span>READY TO MOVE</span><button>All tickets →</button></header><div><button><span>R</span><strong>Prepare open-source launch</strong><small>5 checks · Codex</small></button><button><span>R</span><strong>Map DSH root ownership</strong><small>7 refs · 18m</small></button><button><span>R</span><strong>Draft Chinese positioning</strong><small>3 refs · 25m</small></button></div></section>
      </div>`,
    chat: `
      <div class="kc-workspace kc-chat">
        <header class="kc-chat-tabs"><button>Harness as a product <i></i></button><button class="is-on">Main <span>×</span></button><button>＋</button><div><button data-demo="context">${icon("context")} Context off</button><button>${icon("more")}</button></div></header>
        <div class="kc-chat-layout"><aside><span>BRANCHES · 8</span><button class="is-on"><i></i><strong>Main</strong><small>Now</small></button><button data-demo="branch"><i></i><strong>Application shell</strong><small>12m</small></button><button data-demo="branch"><i></i><strong>Task-native UX</strong><small>8m</small></button><button><i></i><strong>Harness boundary</strong><small>21m</small></button><footer><button>Open graph ⌘</button></footer></aside><section class="kc-transcript"><div class="kc-msg user"><span>YOU · 09:41</span><p>I want this to feel like a completely different application, not a plugin-shaped feature area.</p></div><div class="kc-msg agent"><span>VIBEHUB · CODEX · NOW</span><p>Then DeepSeek Harness becomes the engine. VibeHub owns navigation, Chat chrome, Ticket craft and execution presence.</p><blockquote>Chat stays unconstrained. Structure appears only when thought becomes executable work.</blockquote><footer><button data-demo="branch">Fork</button><button data-demo="ticket">Make ticket</button><button>Copy</button></footer></div><div class="kc-compose"><span>Reply or continue exploring…</span><button>Codex⌄</button><button>↗</button></div></section><aside class="kc-context"><header><span>ACTIVE CONTEXT</span><button>×</button></header><div class="kc-context-off"><i>◎</i><strong>Nothing assumed</strong><p>Activate only when this turn should use workspace memory.</p><button data-demo="context">Use 3 references</button></div><footer>Explicit · reversible · traceable</footer></aside></div>
        <button class="kc-bottom-run" data-demo="run"><i></i><span><strong>VH–014 is running</strong><small>Composing application shell</small></span><time>03:18</time><b>Open ↗</b></button>
      </div>`,
    runs: `
      <div class="kc-workspace kc-runs">
        <header class="kc-page-head"><div><span>EXECUTION</span><h2>Active runs</h2></div><div><button>All</button><button class="is-on">Active 2</button><button>Needs you 1</button><button>History</button></div></header>
        <div class="kc-run-table-head"><span>STATE / WORK</span><span>CURRENT STEP</span><span>AGENT</span><span>ELAPSED</span><span></span></div>
        <article class="kc-run-row is-expanded"><div><i class="live"></i><span><small>VH–014 · RUNNING</small><strong>Rebuild the harness experience</strong></span></div><div><strong>Composing application shell</strong><small>7 files changed · trusted event 18s ago</small></div><div><span class="kc-agent">C</span>Codex</div><time>03:18</time><button>•••</button><section><div><span class="done">✓</span><p><strong>Context assembled</strong><small>4 references</small></p></div><i></i><div><span class="done">✓</span><p><strong>Plan accepted</strong><small>4 steps</small></p></div><i></i><div class="current"><span>●</span><p><strong>Build direction study</strong><small>Working now</small></p></div><i></i><div><span>4</span><p><strong>Visual review</strong><small>Needs owner</small></p></div></section></article>
        <article class="kc-run-row needs-attention"><div><i>!</i><span><small>VH–011 · NEEDS YOU</small><strong>Choose the launch narrative</strong></span></div><div><strong>Two viable directions</strong><small>Human product judgment required</small></div><div><span class="kc-agent">C</span>Codex</div><time>12m</time><button>Review ↗</button></article>
        <article class="kc-run-row is-complete"><div><i>✓</i><span><small>VH–008 · EVIDENCE</small><strong>DSH extension spike</strong></span></div><div><strong>7 / 7 checks proven</strong><small>Awaiting independent closeout</small></div><div><span class="kc-agent">C</span>Codex</div><time>48m</time><button>Inspect ↗</button></article>
        <footer class="kc-activity-footer"><span><i></i> Events are sourced from active executor runs</span><button>Notification policy</button><button data-demo="advance">Simulate next state →</button></footer>
      </div>`,
  };
  return `<div class="concept-app kinetic-app ${mini ? "is-mini" : ""}">
    <aside class="kc-nav"><strong><i>V</i><span>VIBEHUB</span></strong><button class="is-on">${icon("home")}<span>Command</span></button><button>${icon("chat")}<span>Conversations</span><em>8</em></button><button>${icon("ticket")}<span>Tickets</span><em>12</em></button><button>${icon("run")}<span>Runs</span><em class="hot">2</em></button><div></div><button>${icon("graph")}<span>Graph</span></button><button>${icon("more")}<span>Engine</span></button><footer><span>W</span><b>Wayne’s space</b></footer></aside>
    <header class="kc-top"><button>${icon("search")} Search or command <kbd>⌘K</kbd></button><div><span><i></i>Codex connected</span><button>◎</button><button>•••</button></div></header>
    ${views[scene]}
  </div>`;
}

function renderConcept(direction, scene, mini = false) {
  if (direction === "ambient") return ambientShell(scene, mini);
  if (direction === "spatial") return spatialShell(scene, mini);
  return kineticShell(scene, mini);
}

function renderCompare() {
  directionGrid.innerHTML = Object.entries(directions).map(([id, item]) => `
    <article class="direction-card direction-${id}" data-open-direction="${id}">
      <header><div><span>${item.index}</span><h2>${item.name}</h2></div><em>${item.verdict}</em></header>
      <div class="mini-frame">${renderConcept(id, state.scene, true)}</div>
      <footer><p>${item.strap}</p><div><span>${item.reference}</span><button>Open direction ↗</button></div></footer>
    </article>`).join("");
}

function renderFocus() {
  const item = directions[state.direction];
  focusStage.innerHTML = renderConcept(state.direction, state.scene);
  notesContent.innerHTML = `<h2>${item.name}</h2><p>${item.strap}</p>${item.notes.map(([title, body], index) => `<article><span>0${index + 1}</span><div><strong>${title}</strong><p>${body}</p></div></article>`).join("")}<footer><span>REFERENCE MIX</span><p>${item.reference}</p></footer>`;
}

function syncControls() {
  document.querySelectorAll("[data-direction]").forEach((button) => button.classList.toggle("is-active", button.dataset.direction === state.direction));
  document.querySelectorAll("[data-scene]").forEach((button) => button.classList.toggle("is-active", button.dataset.scene === state.scene));
  document.querySelectorAll("[data-action='toggle-notes']").forEach((button) => {
    button.classList.toggle("is-active", state.notes);
    button.setAttribute("aria-pressed", String(state.notes));
  });
  notesPanel.classList.toggle("is-open", state.notes && state.direction !== "compare");
  notesPanel.setAttribute("aria-hidden", String(!(state.notes && state.direction !== "compare")));
  document.body.classList.toggle("notes-open", state.notes);
  document.body.classList.toggle("review-hidden", !state.chrome);
}

function setDirection(direction) {
  if (!directions[direction] && direction !== "compare") return;
  state.direction = direction;
  const comparing = direction === "compare";
  compareScreen.hidden = !comparing;
  focusScreen.hidden = comparing;
  compareScreen.classList.toggle("is-active", comparing);
  focusScreen.classList.toggle("is-active", !comparing);
  if (comparing) renderCompare(); else renderFocus();
  syncControls();
}

function setScene(scene) {
  if (!['home', 'chat', 'runs'].includes(scene)) return;
  state.scene = scene;
  if (state.direction === "compare") renderCompare(); else renderFocus();
  syncControls();
}

function showHint(message) {
  keyHint.textContent = message;
  keyHint.classList.add("is-visible");
  window.clearTimeout(showHint.timeout);
  showHint.timeout = window.setTimeout(() => keyHint.classList.remove("is-visible"), 1800);
}

document.addEventListener("click", (event) => {
  const direction = event.target.closest("[data-direction]")?.dataset.direction ?? event.target.closest("[data-open-direction]")?.dataset.openDirection;
  if (direction) return setDirection(direction);
  const scene = event.target.closest("[data-scene]")?.dataset.scene;
  if (scene) return setScene(scene);
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "compare") return setDirection("compare");
  if (action === "toggle-notes") {
    state.notes = !state.notes;
    syncControls();
    return;
  }
  if (action === "toggle-chrome") {
    state.chrome = !state.chrome;
    syncControls();
    return;
  }
  const demo = event.target.closest("[data-demo]")?.dataset.demo;
  if (!demo) return;
  if (demo === "context") {
    document.querySelectorAll("[data-demo='context']").forEach((node) => node.classList.toggle("demo-active"));
    showHint("Context lens toggled · explicit and reversible");
  } else if (demo === "branch") {
    document.querySelectorAll(".ao-branch-ghost, .sc-map-rail, .kc-chat-layout > aside:first-child").forEach((node) => node.classList.add("demo-active"));
    showHint("New branch created from this exact point");
  } else if (demo === "ticket") {
    showHint("Ticket preview would crystallize from this branch");
  } else if (demo === "run" || demo === "advance") {
    event.target.closest(".concept-app")?.classList.toggle("demo-advanced");
    showHint("Trusted Run event advanced");
  } else {
    showHint("This is the universal capture point");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea")) return;
  const directionsByKey = { "1": "ambient", "2": "spatial", "3": "kinetic" };
  const scenesByKey = { h: "home", c: "chat", r: "runs" };
  if (directionsByKey[event.key]) setDirection(directionsByKey[event.key]);
  else if (scenesByKey[event.key.toLowerCase()]) setScene(scenesByKey[event.key.toLowerCase()]);
  else if (event.key === "Escape") setDirection("compare");
});

renderCompare();
syncControls();
