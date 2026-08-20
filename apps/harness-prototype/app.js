const views = [...document.querySelectorAll("[data-view-panel]")];
const navItems = [...document.querySelectorAll(".nav-item")];
const contextButton = document.querySelector("#contextButton");
const attachedContext = document.querySelector("#attachedContext");
const contextSheet = document.querySelector("#contextSheet");
const ticketSheet = document.querySelector("#ticketSheet");
const sheetBackdrop = document.querySelector("#sheetBackdrop");
const toast = document.querySelector("#toast");
const activityDock = document.querySelector(".activity-dock");

const initialState = () => ({
  view: "chat",
  thread: "main",
  contextOn: false,
  ticketCreated: false,
  runState: "idle",
  converged: false,
  extraMessages: [],
});

let state = initialState();
let toastTimer;

const threadCopy = {
  main: {
    title: "Design the task-oriented Harness",
    path: "Exploration / Main",
    sidebar: "Main exploration",
    messages: [
      { role: "user", body: "We want VibeHub to become a task-oriented Harness. Chat should stay native, but it should be much easier to branch an idea, bring useful thinking back, turn it into a Ticket, and actually start the work." },
      { role: "assistant", body: "The product can stay simple at its center: a strong Agent conversation with explicit controls around it. The durable system appears only when it is useful—Context before a turn, Ticket when intent becomes bounded, and Execution after Start.", ideas: true },
      { role: "user", body: "The execution needs to feel real. Ticket and Context should surface like annotations or attached objects, so I can sense what is happening without reading internal files." },
      { role: "assistant", body: "Then the UI should separate three truths without separating the experience: the current conversation line, the durable action being crafted, and the trusted live activity emitted by an executor. They stay connected, but none impersonates another.", actions: true },
    ],
  },
  "ticket-craft": {
    title: "How should Ticket craft feel?",
    path: "Exploration / Main / Ticket craft",
    sidebar: "Fork · Ticket craft",
    origin: "Forked from the assistant’s description of explicit controls around normal Chat.",
    messages: [
      { role: "user", body: "Explore the moment when a useful conversation should become a Ticket. I do not want a form-heavy workflow." },
      { role: "assistant", body: "Treat Ticket craft as a reversible preview. The current branch supplies the proposed outcome; scoped Context and source References sit beside it; readiness is explained before any file is written. The user can keep chatting if the work is not bounded yet." },
      { role: "user", body: "And once it is Ready, Start should feel immediate." },
      { role: "assistant", body: "Yes. The Ticket is the stable action object, while the chosen Agent is replaceable. Start binds them for this run and opens a live activity surface without changing the meaning of Ready itself.", actions: true },
    ],
  },
  execution: {
    title: "Make execution strongly perceptible",
    path: "Exploration / Main / Execution presence",
    sidebar: "Fork · Execution presence",
    origin: "Forked from the question of how Agent work should remain visible while the user continues thinking.",
    messages: [
      { role: "user", body: "How do we make the user strongly feel that execution is happening, without flooding the Chat with logs?" },
      { role: "assistant", body: "Use a persistent but quiet activity dock for orientation, then a dedicated Run surface for depth. The dock names the current step and attention state. The Run view shows durable events, tool activity, approvals, failures, and Evidence as a chronological projection." },
      { role: "user", body: "It must be honest. Ticket state cannot pretend something is live." },
      { role: "assistant", body: "Exactly. Running, Waiting, Failed, and Completed come only from a trusted Run event source. In the absence of that source, the activity dock says nothing is running—even when a Ticket is Ready.", actions: true },
    ],
  },
};

const runStates = {
  idle: { eyebrow: "No active run", title: "Nothing is running", copy: "Start a Ready Ticket to create a trusted execution stream.", dock: "Nothing running", progress: 0, step: "—" },
  queued: { eyebrow: "Queued", title: "Waiting to begin", copy: "The Ticket is ready and the executor has been selected.", dock: "Queued for current Agent", progress: 8, step: "Queued" },
  running: { eyebrow: "Running", title: "Building the local product surface", copy: "The executor is editing the prototype and reporting tool activity from the current step.", dock: "Building the local product surface…", progress: 46, step: "Step 2 of 4" },
  waiting: { eyebrow: "Needs you", title: "Waiting at an exact authority boundary", copy: "The Agent needs permission to open the local prototype in Safari. Other execution is paused.", dock: "Waiting for browser permission", progress: 57, step: "Attention required" },
  failed: { eyebrow: "Failed", title: "The preview server did not start", copy: "The failure belongs to one step. The Ticket and completed work remain intact and retryable.", dock: "Preview start failed", progress: 63, step: "Step 3 failed" },
  evidence: { eyebrow: "Recording evidence", title: "Verifying the completed product loop", copy: "Acceptance-linked observations are being attached without claiming the Ticket is closed.", dock: "Recording acceptance evidence…", progress: 82, step: "Step 4 of 4" },
  completed: { eyebrow: "Completed", title: "Execution finished with Evidence", copy: "The run is complete. Independent closeout can now judge the Ticket against its acceptance.", dock: "Run completed · 6 Evidence", progress: 100, step: "Ready for closeout" },
};

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2400);
}

function setView(name) {
  state.view = name;
  for (const view of views) {
    const active = view.dataset.viewPanel === name;
    view.hidden = !active;
    view.classList.toggle("active", active);
  }
  for (const item of navItems) item.classList.toggle("active", item.dataset.view === name || (name === "compare" && item.dataset.view === "graph"));
  if (name === "chat") renderChat();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function messageMarkup(message) {
  const avatar = message.role === "user" ? "You" : "VH";
  const label = message.role === "user" ? "You" : "Agent";
  const ideas = message.ideas ? `
    <div class="idea-grid">
      <article class="idea-card"><span>Line 01</span><strong>Ticket craft</strong><p>Explore how useful thinking becomes bounded work.</p><button type="button" data-fork="ticket-craft">Fork this thought →</button></article>
      <article class="idea-card"><span>Line 02</span><strong>Execution presence</strong><p>Explore how active work remains visible and honest.</p><button type="button" data-fork="execution">Fork this thought →</button></article>
      <article class="idea-card"><span>Line 03</span><strong>Context control</strong><p>Inspect when project knowledge joins the next turn.</p><button type="button" data-context-action>Open Context →</button></article>
    </div>` : "";
  const actions = message.actions ? `<div class="assistant-actions"><button class="message-action" type="button" data-view="compare">Compare sibling branches</button><button class="message-action" type="button" data-ticket-action>Make this a Ticket</button></div>` : "";
  return `<article class="message ${message.role}"><div class="message-avatar">${avatar}</div><div class="message-body"><div class="message-meta"><strong>${label}</strong><span>now</span></div><p>${message.body}</p>${ideas}${actions}</div></article>`;
}

function renderChat() {
  const thread = threadCopy[state.thread];
  document.querySelector("#chatTitle").textContent = thread.title;
  document.querySelector("#branchPath").textContent = thread.path;
  document.querySelector("#sidebarBranch").textContent = thread.sidebar;
  document.querySelector("#dockBranch").textContent = thread.sidebar;
  const branchNotice = document.querySelector("#branchNotice");
  branchNotice.hidden = !thread.origin;
  document.querySelector("#branchNoticeCopy").textContent = thread.origin || "";
  const extra = state.thread === "main" ? state.extraMessages : [];
  document.querySelector("#chatStream").innerHTML = [...thread.messages, ...extra].map(messageMarkup).join("");
}

function setThread(thread) {
  state.thread = thread;
  setView("chat");
  showToast(thread === "main" ? "Returned to Main" : `Forked into ${threadCopy[thread].title}`);
}

function setContext(on) {
  state.contextOn = on;
  contextButton.setAttribute("aria-pressed", String(on));
  contextButton.innerHTML = `<span class="diamond" aria-hidden="true"></span>Context ${on ? "on · 3" : "off"}`;
  attachedContext.hidden = !on;
  document.querySelector("#dockContextTitle").textContent = on ? "3 scoped references" : "Not active";
  document.querySelector("#dockContextCopy").textContent = on ? "Attached to the next turn" : "Chat uses only this thread";
}

function openSheet(sheet) {
  sheet.hidden = false;
  sheet.inert = false;
  sheetBackdrop.hidden = false;
  sheet.querySelector("button")?.focus();
}

function closeSheets() {
  for (const sheet of [contextSheet, ticketSheet]) { sheet.hidden = true; sheet.inert = true; }
  sheetBackdrop.hidden = true;
}

function createTicket() {
  state.ticketCreated = true;
  document.querySelector("#ticketCount").textContent = "1";
  document.querySelector("#ticketEmpty").hidden = true;
  document.querySelector("#ticketContract").hidden = false;
  document.querySelector("#dockTicketTitle").textContent = "Ready · Harness prototype";
  document.querySelector("#dockTicketCopy").textContent = "Current Agent · no blockers";
  closeSheets();
  setView("ticket");
  showToast("Ticket crafted from the current conversation");
}

function startTicket() {
  state.runState = "queued";
  renderRun();
  setView("run");
  showToast("Ticket queued for the current Agent");
}

function renderRun() {
  const run = runStates[state.runState];
  const active = state.runState !== "idle";
  document.querySelector("#runEyebrow").textContent = run.eyebrow;
  document.querySelector("#runStatusTitle").textContent = run.title;
  document.querySelector("#runStatusCopy").textContent = run.copy;
  document.querySelector("#runIndicator").style.background = state.runState === "failed" ? "var(--red)" : state.runState === "waiting" ? "var(--amber)" : "var(--accent)";
  const advance = document.querySelector("#advanceRun");
  advance.textContent = ({ idle: "Start a Ticket first", queued: "Begin demo run", running: "Advance to attention", waiting: "Resolve below", failed: "Retry step", evidence: "Finish run", completed: "Run complete" })[state.runState];
  advance.disabled = state.runState === "idle" || state.runState === "waiting" || state.runState === "completed";
  document.querySelector("#attentionCard").hidden = state.runState !== "waiting";
  document.querySelector("#dockEmpty").hidden = active;
  document.querySelector("#dockLive").hidden = !active;
  document.querySelector("#dockState").textContent = run.eyebrow;
  document.querySelector("#dockCopy").textContent = run.dock;
  document.querySelector("#dockProgress").style.width = `${run.progress}%`;
  document.querySelector("#dockStep").textContent = run.step;
  document.querySelector("#dockTime").textContent = state.runState === "completed" ? "just now" : "live";
  document.querySelector("#dockPulse").className = `dock-pulse ${active ? "live" : "inactive"}`;
  document.querySelector("#activityPulse").hidden = !active;
  for (const button of document.querySelectorAll("[data-run-state]")) button.classList.toggle("active", button.dataset.runState === state.runState);

  const order = ["queued", "running", "waiting", "evidence", "completed"];
  const currentIndex = order.indexOf(state.runState);
  const steps = [
    ["Read Ticket and scoped Context", "3 Context · 1 source branch"],
    ["Build the interaction surface", state.runState === "failed" ? "Preview start failed" : "3 files changed · tool activity"],
    ["Open local browser preview", state.runState === "waiting" ? "Waiting for your approval" : "Safari · local host"],
    ["Record acceptance Evidence", state.runState === "completed" ? "6 Evidence attached" : "Pending verification"],
  ];
  const activeStep = state.runState === "queued" ? 0 : state.runState === "running" || state.runState === "failed" ? 1 : state.runState === "waiting" ? 2 : 3;
  document.querySelector("#executionTimeline").innerHTML = steps.map((step, index) => {
    const done = state.runState === "completed" || (currentIndex > 0 && index < activeStep);
    const failed = state.runState === "failed" && index === activeStep;
    const marker = done ? "✓" : failed ? "!" : String(index + 1);
    const cls = failed ? "failed" : index === activeStep && state.runState !== "completed" ? "active" : "";
    const evidence = index === 3 && (state.runState === "evidence" || state.runState === "completed") ? "evidence-link" : "";
    return `<li class="execution-step ${cls}"><span class="step-mark">${marker}</span><span><strong>${step[0]}</strong><small class="${evidence}">${step[1]}</small></span><time>${done ? "done" : index === activeStep ? "now" : "upcoming"}</time></li>`;
  }).join("");
}

function advanceRun() {
  const next = { queued: "running", running: "waiting", failed: "evidence", evidence: "completed" }[state.runState];
  if (next) { state.runState = next; renderRun(); }
}

document.addEventListener("click", (event) => {
  const viewButton = event.target.closest("[data-view]");
  if (viewButton) setView(viewButton.dataset.view);
  const forkButton = event.target.closest("[data-fork]");
  if (forkButton) setThread(forkButton.dataset.fork);
  const node = event.target.closest("[data-thread]");
  if (node) setThread(node.dataset.thread);
  if (event.target.closest("[data-context-action]")) openSheet(contextSheet);
  if (event.target.closest("[data-ticket-action]")) openSheet(ticketSheet);
  const close = event.target.closest("[data-close-sheet]");
  if (close) closeSheets();
  const runStateButton = event.target.closest("[data-run-state]");
  if (runStateButton) { state.runState = runStateButton.dataset.runState; renderRun(); }
});

contextButton.addEventListener("click", () => {
  setContext(!state.contextOn);
  if (state.contextOn) { openSheet(contextSheet); showToast("3 scoped Context will inform the next turn"); }
  else showToast("Context is off for the next turn");
});
document.querySelector("#inspectContext").addEventListener("click", () => openSheet(contextSheet));
document.querySelector("#dockContext").addEventListener("click", () => openSheet(contextSheet));
for (const button of [document.querySelector("#makeTicketTop"), document.querySelector("#makeTicketEmpty")]) button.addEventListener("click", () => openSheet(ticketSheet));
document.querySelector("#confirmTicket").addEventListener("click", createTicket);
document.querySelector("#startTicket").addEventListener("click", startTicket);
document.querySelector("#advanceRun").addEventListener("click", advanceRun);
document.querySelector("#approveAttention").addEventListener("click", () => { state.runState = "evidence"; renderRun(); showToast("Approved once · execution resumed"); });
document.querySelector("#denyAttention").addEventListener("click", () => { showToast("Execution remains paused at this step"); });
document.querySelector("#bringBack").addEventListener("click", () => {
  state.converged = true;
  state.thread = "main";
  state.extraMessages = [{ role: "assistant", body: "Brought back from Ticket craft and Execution presence: keep Chat native; make Ticket creation a reversible preview; and project trusted Run events into a persistent activity dock plus a detailed execution timeline. Nothing becomes durable until the user chooses to craft the Ticket.", actions: true }];
  setView("chat");
  showToast("Two branches brought back into Main");
});
document.querySelector("#chatComposer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#composerInput");
  const body = input.value.trim();
  if (!body) return;
  state.extraMessages.push({ role: "user", body }, { role: "assistant", body: state.contextOn ? "I’ll answer with the three visible project Context references attached to this turn. The prototype keeps the conversation natural while showing exactly what informed it." : "This remains a normal Agent turn. Turn Context on only when you want the current Workspace to inform the answer." });
  input.value = "";
  renderChat();
  document.querySelector("#chatStream").lastElementChild?.scrollIntoView({ behavior: "smooth" });
});
document.querySelector("#resetDemo").addEventListener("click", () => {
  state = initialState();
  setContext(false);
  document.querySelector("#ticketCount").textContent = "0";
  document.querySelector("#ticketEmpty").hidden = false;
  document.querySelector("#ticketContract").hidden = true;
  document.querySelector("#dockTicketTitle").textContent = "Not crafted";
  document.querySelector("#dockTicketCopy").textContent = "Explore until work is bounded";
  renderRun();
  setView("chat");
  closeSheets();
  showToast("Prototype reset");
});
sheetBackdrop.addEventListener("click", closeSheets);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeSheets();
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") document.querySelector("#chatComposer").requestSubmit();
});
activityDock.querySelector("header").addEventListener("click", () => {
  if (window.matchMedia("(max-width: 760px)").matches) activityDock.classList.toggle("mobile-open");
});

setContext(false);
renderChat();
renderRun();
setView("chat");
