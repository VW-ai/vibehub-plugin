const state = {
  route: "tasks",
  variant: "tasks-first",
  focusedTask: null,
  workspacePhase: "running",
  graphFocus: { taskId: "prototype", scrollLeft: 118, scrollTop: 34 },
  sidebarOpen: false,
};

const reviewFrame = new URLSearchParams(location.search).get("frame");
if (reviewFrame === "narrow") {
  document.body.dataset.reviewFrame = "narrow";
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
if (reviewFrame === "narrow") $(".review-strip > div:first-child span")?.replaceChildren("390 × 844 review frame");
const surface = $("#surface");
const appFrame = $("#appFrame");
const composerWrap = $("#composerWrap");
const routeTitle = $("#routeTitle");
const routeMeta = $("#routeMeta");
const backToGraph = $("#backToGraph");
const chatAction = $("#chatAction");
const reviewPanel = $("#reviewPanel");
const scrim = $("#scrim");
const toast = $("#toast");
let toastTimer;

const taskData = {
  foundation: { eyebrow: "FOUNDATION", title: "Prove the DSH extension seams", phase: "done", detail: "Official rc.8 Bundle, Slots and Session routing verified." },
  vertical: { eyebrow: "VERTICAL SLICE", title: "Build Task-to-native-Chat loop", phase: "done", detail: "Graph, exact handoff, Skill, Evidence and restart recovery." },
  prototype: { eyebrow: "PRODUCT SHELL", title: "Prototype persistent DSH navigation", phase: "running", detail: "Unify native Chat, Tasks, Graph and focused work without a second app shell." },
  decision: { eyebrow: "OWNER CHOICE", title: "Choose the shell navigation", phase: "draft", detail: "Review sidebar hierarchy, default landing and Focus Route." },
  bridge: { eyebrow: "NATIVE CHAT", title: "Build explicit Chat ↔ Task actions", phase: "draft", detail: "Create, attach and remember without harvesting transcripts." },
  release: { eyebrow: "PREVIEW", title: "Publish the DSH developer preview", phase: "draft", detail: "Versioned install, onboarding, upgrade and clean removal." },
};

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

function phaseLabel(phase) {
  return ({ draft: "Draft", ready: "Ready", running: "Running", done: "Done" })[phase] ?? phase;
}

function graphCard(id, substate = "") {
  const task = taskData[id];
  return `<button class="task-card ${task.phase}" type="button" data-task="${id}" aria-label="${task.title}, ${phaseLabel(task.phase)}${substate ? `, ${substate}` : ""}">
    <span class="card-phase"><i></i>${phaseLabel(task.phase)}</span>
    ${substate ? `<span class="card-substate">${substate}</span>` : ""}
    <small>${task.eyebrow}</small>
    <strong>${task.title}</strong>
    <p>${task.detail}</p>
    <footer><span>${id === "prototype" ? "6 acceptance" : id === "decision" ? "Human decision" : "vibehub-plugin"}</span><span>→</span></footer>
  </button>`;
}

function tasksTemplate() {
  return `<div class="tasks-view">
    <header class="tasks-heading">
      <div><span class="eyebrow">CURRENT WORK</span><h1>Task graph</h1><p>Committed work stays causal. Chat remains one click away in the same shell.</p></div>
      <div class="summary-row" aria-label="Task summary"><button type="button"><strong>1</strong><span>Running</span></button><button type="button"><strong>1</strong><span>Needs you</span></button><button type="button"><strong>2</strong><span>Draft</span></button></div>
    </header>
    <div class="graph-toolbar"><div><button class="active" type="button">Current</button><button type="button">All</button></div><div><button type="button">Product</button><button type="button">Search</button><button type="button">Fit</button></div></div>
    <div class="graph-viewport" id="graphViewport" tabindex="0" aria-label="Task dependency graph">
      <div class="graph-world">
        <svg viewBox="0 0 1260 650" aria-hidden="true"><defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8Z"></path></marker></defs><path d="M275 165H345"></path><path d="M275 415H310V215H345"></path><path d="M585 165H670"></path><path d="M585 165H625V415H670"></path><path d="M910 165H960V290H1005"></path><path d="M910 415H960V290H1005"></path></svg>
        ${graphCard("foundation")}
        ${graphCard("vertical")}
        ${graphCard("prototype", "Verifying")}
        ${graphCard("decision", "Blocked")}
        ${graphCard("bridge")}
        ${graphCard("release", "Blocked")}
      </div>
    </div>
    <footer class="graph-footer"><span>Click a Task to enter its workspace</span><span><kbd>⌘</kbd><kbd>K</kbd> Commands · <kbd>F</kbd> Fit</span></footer>
  </div>`;
}

function chatTemplate() {
  return `<div class="chat-view">
    <header class="chat-heading"><span class="eyebrow">NATIVE DSH CHAT</span><h1>Harness product direction</h1><p>Normal Chat is not forced through a Task protocol.</p></header>
    <div class="turn user"><div>我们要做的是一个 Task-first product，但 Chat 依然应该像 Codex 一样自然。</div></div>
    <div class="turn assistant"><div class="agent-icon">D</div><article><details open><summary>Reasoned about the product boundary <small>4s</small></summary><p>Chat is the Human-led Context Space. A Task becomes primary only after work is bounded and delegated.</p></details><p>So the shell should not make Graph a separate application. Keep Chat and Tasks in one persistent navigation model; let a Chat create or attach a Task explicitly.</p><footer><button type="button">Copy</button><button type="button">Fork</button><button type="button">Create Task</button><button type="button">Remember</button></footer></article></div>
    <div class="chat-context"><span>Chat stays native</span><span>Task actions are additive</span><span>No transcript harvesting</span></div>
  </div>`;
}

function taskWorkspaceTemplate() {
  const phases = {
    running: {
      label: "Running", substate: "Verifying", action: "Inspect execution",
      body: `<section class="run-card"><header><div><span class="live-dot"></span><div><strong>Compatibility and interaction prototype</strong><small>Trusted DSH Session · active now</small></div></div><button type="button">Pause</button></header><div class="run-step done"><i></i><div><strong>Reproduce the full-screen overlay failure</strong><p>Native sidebar disappears; Graph becomes a second app.</p></div><small>Done</small></div><div class="run-step active"><i></i><div><strong>Compose persistent shell prototype</strong><p>Keep Root, Conversation, composer, Sessions and Settings visible.</p><div class="tool-row"><code>read ui-layout/sidebar contracts</code><span>passed</span></div></div><small>Running</small></div><div class="run-step"><i></i><div><strong>Verify wide, narrow and exact return</strong></div><small>Next</small></div></section>`,
    },
    needs: {
      label: "Running", substate: "Needs you", action: "Choose direction",
      body: `<section class="attention-card"><span class="eyebrow">HUMAN BOUNDARY · SHELL COMPOSITION</span><h2>Which sidebar posture should govern V1?</h2><p>The prototype recommends Tasks-first because VibeHub manages work to completion. Chat-first is less disruptive but weakens the product thesis. Both preserve native Chat and the same Focus Route.</p><button type="button" data-choice="A">A · Tasks first <small>Recommended</small></button><button type="button" data-choice="B">B · Chat first</button><button type="button" data-route="chat">Discuss in Chat</button></section>`,
    },
    verifying: {
      label: "Running", substate: "Verifying", action: "Verify & close",
      body: `<section class="evidence-card"><header><div><span class="eyebrow">ACCEPTANCE-LINKED PROOF</span><h2>Independent adjudication is next</h2></div><span>6 / 6</span></header><article><i>✓</i><div><strong>Persistent shell remains visible</strong><p>Wide and narrow review frames preserve native navigation and composer behavior.</p></div><button type="button">Evidence</button></article><article><i>✓</i><div><strong>Graph → Task → Chat → Graph loop</strong><p>One Task identity and exact graph focus survive every transition.</p></div><button type="button">Evidence</button></article><article><i>✓</i><div><strong>DSH composition is bounded</strong><p>Only the Sidebar owner is shadowed; child seats and runtime contracts are explicit.</p></div><button type="button">Evidence</button></article></section>`,
    },
  };
  const phase = phases[state.workspacePhase];
  return `<div class="task-workspace">
    <header class="task-hero"><div><span class="eyebrow">TASK · ticket-prototype-dsh-persistent-shell-navigation</span><h1>Prototype persistent DSH navigation</h1><p>One application shell for native Chat, Tasks, the causal Graph and focused execution.</p></div><div class="phase-stack"><span class="primary-phase"><i></i>${phase.label}</span><span>${phase.substate}</span></div></header>
    <div class="task-tabs" role="tablist" aria-label="Task workspace views"><button class="active" type="button">Execution</button><button type="button">Contract</button><button type="button">Context</button><button type="button">Evidence</button></div>
    <div class="workspace-grid"><div class="workspace-main">${phase.body}</div><aside class="workspace-aside"><section><span class="eyebrow">RECOMMENDED ACTION</span><button class="recommended-action" type="button" data-recommended>${phase.action}<span>→</span></button></section><section><span class="eyebrow">CAUSAL POSITION</span><div class="causal"><i></i><span></span><i class="current"></i><span></span><i></i></div><p>2 prerequisites · unlocks 1 owner decision</p></section><section><span class="eyebrow">CONTEXT</span><button type="button">DSH shell decision <span>×</span></button><button type="button">Human-led / Agent-led spaces <span>×</span></button></section><section><span class="eyebrow">SESSION</span><p>Native DSH Session<br><strong>session:9f82…</strong></p></section></aside></div>
    <footer class="task-steering"><button type="button" data-route="chat">Open Task Chat</button><span>Steering enters the native Session; it does not rewrite the Task contract.</span></footer>
  </div>`;
}

function simpleTemplate(title, body) {
  return `<div class="simple-view"><span class="eyebrow">NATIVE DSH SURFACE</span><h1>${title}</h1><p>${body}</p><div class="simple-card">This destination remains owned by DeepSeek Harness. The prototype only proves that VibeHub navigation can coexist with it.</div></div>`;
}

function setHeader(title, meta, options = {}) {
  routeTitle.textContent = title;
  routeMeta.textContent = meta;
  backToGraph.hidden = !options.back;
  chatAction.hidden = !options.chat;
}

function restoreGraphFocus() {
  requestAnimationFrame(() => {
    const viewport = $("#graphViewport");
    if (!viewport) return;
    viewport.scrollLeft = state.graphFocus.scrollLeft;
    viewport.scrollTop = state.graphFocus.scrollTop;
    const card = $(`[data-task="${state.graphFocus.taskId}"]`, viewport);
    card?.focus({ preventScroll: true });
  });
}

function render() {
  composerWrap.hidden = state.route !== "chat";
  appFrame.dataset.route = state.route;
  $$("[data-route]", $(".sidebar")).forEach(button => button.classList.toggle("active", button.dataset.route === state.route && !button.dataset.chat));
  if (state.route === "tasks") {
    state.focusedTask = null;
    setHeader("Tasks", "Current graph · vibehub-plugin", { chat: true });
    surface.innerHTML = tasksTemplate();
    restoreGraphFocus();
  } else if (state.route === "task") {
    setHeader("Prototype persistent DSH navigation", "Task Workspace · agent-led Context Space", { back: true, chat: true });
    surface.innerHTML = taskWorkspaceTemplate();
  } else if (state.route === "chat") {
    setHeader("Harness product direction", "Chat · native DSH Session · human-led Context Space");
    surface.innerHTML = chatTemplate();
    $("#composerInput").placeholder = "Ask DeepSeek to explore, explain, or do something";
  } else if (state.route === "rooms") {
    setHeader("Rooms", "49 durable Context records");
    surface.innerHTML = simpleTemplate("Rooms", "Project Context remains inspectable and Git-native.");
  } else if (state.route === "settings") {
    setHeader("Settings", "Models, providers, permissions and Plugins");
    surface.innerHTML = simpleTemplate("Settings", "Native DSH settings remain reachable and visually continuous.");
  }
}

function navigate(route) {
  if (state.route === "tasks") {
    const viewport = $("#graphViewport");
    if (viewport) state.graphFocus = { ...state.graphFocus, scrollLeft: viewport.scrollLeft, scrollTop: viewport.scrollTop };
  }
  state.route = route;
  state.sidebarOpen = false;
  appFrame.classList.remove("sidebar-open");
  render();
}

document.addEventListener("click", (event) => {
  const routeButton = event.target.closest("button[data-route]");
  if (routeButton) {
    navigate(routeButton.dataset.route);
    return;
  }
  const taskButton = event.target.closest("button[data-task]");
  if (taskButton) {
    state.graphFocus.taskId = taskButton.dataset.task;
    state.focusedTask = taskButton.dataset.task;
    state.workspacePhase = taskButton.dataset.task === "decision" ? "needs" : "running";
    navigate("task");
    return;
  }
  const variantButton = event.target.closest("button[data-variant]");
  if (variantButton) {
    state.variant = variantButton.dataset.variant;
    appFrame.dataset.variant = state.variant;
    $$("[data-variant]").forEach(button => button.classList.toggle("active", button === variantButton));
    if (state.variant === "chat-first") navigate("chat");
    else navigate("tasks");
    return;
  }
  if (event.target.closest("[data-recommended]")) {
    state.workspacePhase = state.workspacePhase === "running" ? "needs" : state.workspacePhase === "needs" ? "verifying" : "running";
    render();
    return;
  }
  const choice = event.target.closest("[data-choice]");
  if (choice) {
    notify(`Variant ${choice.dataset.choice} recorded in disposable prototype state.`);
    state.workspacePhase = "verifying";
    render();
  }
});

$("#backToGraph").addEventListener("click", () => navigate("tasks"));
$("#chatAction").addEventListener("click", () => navigate("chat"));
$("#reviewNotes").addEventListener("click", () => {
  reviewPanel.hidden = false;
  reviewPanel.inert = false;
  scrim.hidden = false;
  $("button", reviewPanel)?.focus();
});
$("[data-close-panel]").addEventListener("click", () => {
  reviewPanel.hidden = true;
  reviewPanel.inert = true;
  scrim.hidden = true;
  $("#reviewNotes").focus();
});
scrim.addEventListener("click", () => $("[data-close-panel]").click());
$("#collapseSidebar").addEventListener("click", () => appFrame.classList.toggle("sidebar-collapsed"));
$("#openSidebar").addEventListener("click", () => appFrame.classList.toggle("sidebar-open"));
$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#composerInput");
  if (!input.value.trim()) return;
  notify("Sent to the native Chat Session in this disposable prototype.");
  input.value = "";
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !reviewPanel.hidden) $("[data-close-panel]").click();
  if (event.key.toLowerCase() === "g" && !event.metaKey && !event.ctrlKey && !event.altKey && document.activeElement?.tagName !== "TEXTAREA") navigate("tasks");
});

render();
