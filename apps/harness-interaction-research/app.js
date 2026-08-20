const sources = [
  { name: "OpenAI Codex", role: "Agent execution", keep: "A delegated thread contains progress, questions, artifacts, diff review, and continuation.", avoid: "A flat thread list cannot explain cross-Task causality.", url: "https://openai.com/index/introducing-the-codex-app/" },
  { name: "Linear", role: "Attention hierarchy", keep: "Orientation chrome recedes; the current work earns the strongest visual weight.", avoid: "Dense metadata where every control competes equally.", url: "https://linear.app/now/behind-the-latest-design-refresh" },
  { name: "Raycast", role: "Action layer", keep: "Contextual actions and shortcuts are visible without becoming a permanent toolbar.", avoid: "Making users discover every action through unlabeled icon chrome.", url: "https://www.raycast.com/blog/a-fresh-look-and-feel" },
  { name: "Things", role: "Human Task model", keep: "Task, Project, heading, and checklist have different weights; capture and search stay cheap.", avoid: "Requiring project taxonomy before the user can capture work.", url: "https://culturedcode.com/things/index.html" },
  { name: "Notion Projects", role: "Overview → work page", keep: "One Task opens into a complete place to understand and do the work.", avoid: "Turning every Task into an empty configurable document system.", url: "https://www.notion.com/product/projects" },
  { name: "Msty Branch Explorer", role: "Branching Chat", keep: "Fork lives on the message; compare is explicit and side by side; lineage stays optional.", avoid: "Forcing ordinary Chat reading through a permanent graph canvas.", url: "https://docs.msty.ai/studio/conversations/branch-explorer" },
  { name: "Superlist", role: "Thinking → action", keep: "Notes, discussion, and Tasks can share one object, then switch to an action-focused projection.", avoid: "Blurring freeform material and executable readiness.", url: "https://help.superlist.com/en/articles/10050-superlist-basics-lists-tasks-sections-meetings-explained" },
  { name: "OpenHands Canvas", role: "Replaceable runtime", keep: "The workspace remains stable while the Agent backend and execution environment change.", avoid: "Making backend topology the product's primary navigation.", url: "https://www.openhands.dev/product/canvas" },
];

const directions = [
  {
    id: "focus",
    name: "A · Focus Route",
    tag: "Recommended",
    thesis: "Graph is a complete home. Opening a Task is a normal focused route with an exact path back to the selected causal position.",
    risk: "Long work can make the dependency graph feel distant. Keep a compact causal breadcrumb and restore the exact viewport on Back.",
    dsh: "Theme override + additive Graph/Task views first. Replace Conversation only if an honest no-Session Task home is impossible; keep Root.",
  },
  {
    id: "lens",
    name: "B · Spatial Lens",
    tag: "Strong continuity",
    thesis: "The selected graph node expands into a wide lens while its causal neighborhood remains visible and receded behind it.",
    risk: "Long Chat, diffs, and accessibility can turn the lens into a full page pretending to be a canvas overlay.",
    dsh: "Graph conversation view plus an internal lens. Use shell.overlay only for true transient attention, never as the ordinary scroll container.",
  },
  {
    id: "split",
    name: "C · Live Split",
    tag: "Coordination heavy",
    thesis: "A persistent causal subgraph shares the window with the active Task Workspace, so switching Tasks never leaves the system view.",
    risk: "It spends space before causality earns it, compresses Chat and review, and easily becomes an operations cockpit.",
    dsh: "Likely needs a Conversation or Root owner replacement and explicit recreation of child slots; highest compatibility cost.",
  },
];

const steps = [
  { id: "home", label: "1 · Graph home" },
  { id: "running", label: "2 · Running" },
  { id: "attention", label: "3 · Needs you" },
  { id: "review", label: "4 · Review" },
];

let currentDirection = "focus";
let currentStep = "home";

function graphMarkup(compact = false) {
  const prefix = compact ? "split-" : "";
  return `
    <div class="${prefix}graph" aria-label="Task dependency graph">
      <div class="graph-label"><strong>Product launch</strong><span>7 current tasks · 1 needs you</span></div>
      <div class="edge" style="left:24%;top:42%;width:22%;transform:rotate(-4deg)"></div>
      <div class="edge" style="left:49%;top:38%;width:20%;transform:rotate(15deg)"></div>
      <button class="node" style="left:8%;top:31%"><small><span>READY</span><span>01</span></small><strong>Confirm product interaction</strong><p>Unlocks the DSH vertical slice</p></button>
      <button class="node selected" style="left:39%;top:27%"><small><span class="status running">● RUNNING</span><span>02</span></small><strong>Research Task Workbench directions</strong><p>3 patterns compared</p></button>
      <button class="node" style="left:69%;top:42%"><small><span class="status needs">NEEDS YOU</span><span>03</span></small><strong>Choose the base direction</strong><p>Blocked on human judgment</p></button>
      <button class="node" style="left:42%;top:65%"><small><span class="status done">DONE</span><span>04</span></small><strong>Verify DSH plugin seams</strong><p>rc.8 source probe passed</p></button>
    </div>`;
}

function taskBody(step) {
  const phase = step === "running" ? "Running" : step === "attention" ? "Needs you" : "Review";
  let center = "";
  if (step === "running") center = `
    <section class="run-panel"><span class="label">LIVE EXECUTION</span>
      <div class="step-row is-done"><i></i><span>Read DSH rc.8 Theme and Slot contracts</span><small>source</small></div>
      <div class="step-row is-running"><i></i><span>Map product patterns to one Task loop</span><small>running · 3m</small></div>
      <div class="step-row"><i></i><span>Prepare direction recommendation</span><small>queued</small></div>
    </section>
    <section class="chat-panel"><span class="label">STEER</span><div class="composer"><span>Ask about this run or change direction…</span><b>↵</b></div></section>`;
  if (step === "attention") center = `
    <section class="attention-panel"><span class="label">BLOCKED AT · DIRECTION SELECTION</span>
      <div class="attention-card"><strong>How should Graph and one Task share space?</strong><p>Focus Route gives autonomous work full space. Spatial Lens preserves stronger graph continuity. Your choice gates the next prototype.</p><div class="choices"><button>Use Focus Route</button><button>Use Spatial Lens</button><button>Discuss</button></div></div>
    </section>
    <section class="chat-panel"><span class="label">DISCUSS WITHOUT LOSING THE REQUEST</span><div class="composer"><span>Ask a parallel question or compare tradeoffs…</span><b>↵</b></div></section>`;
  if (step === "review") center = `
    <section class="review-panel"><span class="label">ACCEPTANCE & EVIDENCE</span>
      <div class="criterion"><b>✓</b><span>Eight official product sources compared</span><small>research doc</small></div>
      <div class="criterion"><b>✓</b><span>Three architectures use the same Task lifecycle</span><small>board</small></div>
      <div class="criterion"><b>✓</b><span>DSH composition and compatibility cost stated</span><small>rc.8 probe</small></div>
      <div class="criterion"><b>○</b><span>Owner selects the base direction</span><small>human</small></div>
    </section>
    <section class="chat-panel"><div class="composer"><span>Request a revision or ask about the evidence…</span><b>↵</b></div></section>`;

  return `<div class="task-route">
    <article class="task-main">
      <button class="back-link">← Tasks · restore graph focus</button>
      <header class="task-heading"><div><h2>Research Task Workbench directions</h2><p>Product launch · Task 02 · linked to 1 Session</p></div><span class="phase-pill">${phase}</span></header>
      ${center}
    </article>
    <aside class="task-aside">
      <section class="aside-block"><strong>Causal position</strong><div class="causal-mini"><i></i><span></span><i class="current"></i><span></span><i></i></div><p>1 prerequisite · unlocks the owner decision</p></section>
      <section class="aside-block"><strong>Context packet</strong><ul><li>Task-first product model</li><li>DSH runtime boundary</li><li>Rejected visual studies</li></ul></section>
      <section class="aside-block"><strong>Sessions</strong><p>Research session · active<br />No executor-internal task graph mirrored</p></section>
    </aside>
  </div>`;
}

function homeFrame() {
  return `<div class="graph-shell"><aside class="graph-rail"><strong>Tasks</strong><div class="rail-item is-active"><span>All work</span><b>7</b></div><div class="rail-item"><span>Needs you</span><b>1</b></div><div class="rail-item"><span>Active</span><b>1</b></div><div class="rail-item"><span>Ready</span><b>2</b></div><div class="rail-item"><span>Done</span><b>3</b></div></aside>${graphMarkup()}</div>`;
}

function renderFrame() {
  const frame = document.querySelector("#frame");
  const direction = directions.find(item => item.id === currentDirection);
  document.querySelector("#direction-thesis").textContent = direction.thesis;
  document.querySelector("#direction-risk").textContent = direction.risk;
  document.querySelector("#direction-dsh").textContent = direction.dsh;
  document.querySelector("#frame-location").textContent = currentStep === "home" ? "Tasks" : "Research Task Workbench directions";
  document.querySelector("#frame-hint").textContent = currentStep === "home" ? "Select a Task to enter its work" : "Task identity persists across Session and Run changes";

  if (currentStep === "home") frame.innerHTML = homeFrame();
  else if (currentDirection === "focus") frame.innerHTML = taskBody(currentStep);
  else if (currentDirection === "lens") frame.innerHTML = `<div class="lens-shell">${homeFrame()}<div class="task-lens">${taskBody(currentStep)}</div></div>`;
  else frame.innerHTML = `<div class="split-shell">${graphMarkup(true)}${taskBody(currentStep)}</div>`;

  document.querySelectorAll(".direction-tabs button").forEach(button => button.classList.toggle("is-active", button.dataset.direction === currentDirection));
  document.querySelectorAll(".step-tabs button").forEach(button => button.classList.toggle("is-active", button.dataset.step === currentStep));
}

function renderControls() {
  const directionTabs = document.querySelector(".direction-tabs");
  directionTabs.innerHTML = directions.map(item => `<button role="tab" data-direction="${item.id}"><strong>${item.name}</strong><span>${item.tag}</span></button>`).join("");
  directionTabs.addEventListener("click", event => {
    const button = event.target.closest("button[data-direction]");
    if (!button) return;
    currentDirection = button.dataset.direction;
    renderFrame();
  });

  const stepTabs = document.querySelector(".step-tabs");
  stepTabs.innerHTML = steps.map(item => `<button role="tab" data-step="${item.id}">${item.label}</button>`).join("");
  stepTabs.addEventListener("click", event => {
    const button = event.target.closest("button[data-step]");
    if (!button) return;
    currentStep = button.dataset.step;
    renderFrame();
  });
}

function renderSources() {
  document.querySelector("#source-grid").innerHTML = sources.map(source => `
    <article class="source-card"><header><div><span class="label">${source.role}</span><h2>${source.name}</h2></div><a href="${source.url}" target="_blank" rel="noreferrer">Official source ↗</a></header>
      <dl><dt>CARRY</dt><dd>${source.keep}</dd><dt>AVOID</dt><dd>${source.avoid}</dd></dl>
    </article>`).join("");
}

document.querySelectorAll(".nav-button").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-button").forEach(item => item.classList.toggle("is-active", item === button));
  document.querySelectorAll(".section").forEach(section => section.classList.toggle("is-active", section.id === button.dataset.section));
}));

document.addEventListener("keydown", event => {
  if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
    const index = steps.findIndex(step => step.id === currentStep);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    currentStep = steps[(index + delta + steps.length) % steps.length].id;
    renderFrame();
  }
});

renderControls();
renderSources();
renderFrame();
