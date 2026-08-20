const state = {
  view: "graph",
  phase: "running",
  branch: "main",
  contextCount: 0,
  broughtBack: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const stage = $("#stage");
const overlay = $("#overlay");
const contextMenu = $("#contextMenu");
const toast = $("#toast");
let toastTimer;

const phaseCopy = {
  explore: {
    title: "Personal task Harness",
    meta: "CONVERSATION · Main · 3 branches · vibehub-plugin",
    placeholder: "Ask Codex to explore, explain, or do something",
    mode: "Normal Chat · no Ticket yet",
    ticketAction: "Create ticket",
  },
  ready: {
    title: "Build the browser vertical slice",
    meta: "TICKET · ticket-build-task-harness-vertical-slice · READY",
    placeholder: "Refine this Ticket or ask a question",
    mode: "Ticket ready · no Run exists",
    ticketAction: "View ticket",
  },
  running: {
    title: "Define the Harness product loop",
    meta: "TICKET · ticket-prototype-task-harness-experience · RUNNING",
    placeholder: "Steer this Run, ask for status, or interrupt",
    mode: "Steering · Ticket remains active",
    ticketAction: "View ticket",
  },
  needs: {
    title: "Choose the DSH shell seam",
    meta: "TICKET · ticket-prototype-task-harness-experience · NEEDS YOU",
    placeholder: "Discuss this request without losing the Run",
    mode: "Run waiting · exact human input required",
    ticketAction: "View ticket",
  },
  review: {
    title: "DeepSeek Harness foundation spike",
    meta: "TICKET · ticket-spike-deepseek-harness-foundations · REVIEW",
    placeholder: "Ask about the result or request a revision",
    mode: "Run completed · Ticket awaits closeout",
    ticketAction: "View ticket",
  },
  done: {
    title: "Prove additive DSH slots",
    meta: "TICKET · ticket-spike-deepseek-harness-foundations · DONE",
    placeholder: "Start follow-up work or ask about this Outcome",
    mode: "Outcome accepted · Evidence preserved",
    ticketAction: "View outcome",
  },
};

function notify(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

function closeLayers() {
  for (const node of $$(".side-panel, .compare-modal")) {
    node.hidden = true;
    if (node.hasAttribute("inert")) node.inert = true;
  }
  contextMenu.hidden = true;
  overlay.hidden = true;
}

function openLayer(id) {
  closeLayers();
  const node = document.getElementById(id);
  node.hidden = false;
  if (node.hasAttribute("inert")) node.inert = false;
  overlay.hidden = false;
  $("button, textarea, input", node)?.focus();
}

function phaseHeader(label, detail, kind = "neutral") {
  return `<header class="surface-header"><div><span class="eyebrow">${label}</span><h1>${detail}</h1></div><span class="state-pill ${kind}">${label}</span></header>`;
}

function graphTemplate() {
  return `
    <div class="graph-home">
      <header class="graph-home-header">
        <div><span class="eyebrow">Current work</span><h1>Ticket graph</h1><p>Tickets are the primary product objects. Dependencies explain what can move next.</p></div>
        <div class="graph-summary" aria-label="Ticket graph summary"><span><strong>1</strong> Active</span><span class="attention"><strong>1</strong> Needs you</span><span><strong>1</strong> Ready</span><span><strong>1</strong> Review</span></div>
      </header>
      <div class="graph-toolbar">
        <div><button class="active" type="button">Now</button><button type="button">All</button></div>
        <button type="button">Room: Product</button><button type="button">Search</button><span></span><button type="button">← →</button><button type="button">Fit</button><button type="button">−</button><button type="button">+</button>
      </div>
      <section class="ticket-graph" aria-label="Ticket dependency graph">
        <div class="graph-world">
          <svg class="graph-edges" viewBox="0 0 1220 610" aria-hidden="true">
            <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8Z"></path></marker></defs>
            <path d="M250 125H315"></path>
            <path d="M250 325H282V175H315"></path>
            <path d="M545 125H625"></path>
            <path d="M545 125H585V325H625"></path>
            <path d="M855 125H895V225H935"></path>
            <path d="M855 325H895V225H935"></path>
            <path d="M855 325H895V455H935"></path>
          </svg>

          <button class="graph-ticket done" style="--x:20px;--y:70px" type="button" data-open-phase="done">
            <span class="ticket-corner recorded">Recorded</span><span class="ticket-id">FOUNDATION</span><strong>Prove DSH extension seams</strong><p>Bundle, Session fork, commands, and client slots work without upstream patches.</p><footer><span>✓ Done</span><small>6 Evidence</small></footer>
          </button>
          <button class="graph-ticket done" style="--x:20px;--y:270px" type="button" data-open-phase="done">
            <span class="ticket-id">DIRECTION</span><strong>Choose the Harness product direction</strong><p>Keep Codex-quality Chat while making Ticket the durable work object.</p><footer><span>✓ Done</span><small>Outcome</small></footer>
          </button>
          <button class="graph-ticket running" style="--x:315px;--y:70px" type="button" data-open-phase="running">
            <span class="ticket-corner active-run">Active Run</span><span class="ticket-id">PRODUCT LOOP</span><strong>Define the Harness product loop</strong><p>Make the graph, Ticket Workspace, Run, attention, and Evidence one continuous system.</p><footer><span>● Running</span><small>Codex · 08:42</small></footer>
          </button>
          <button class="graph-ticket needs" style="--x:625px;--y:70px" type="button" data-open-phase="needs">
            <span class="ticket-corner needs-you">Needs you</span><span class="ticket-id">SHELL DECISION</span><strong>Choose the DSH shell seam</strong><p>Decide whether the first slice uses additive slots or replaces the root shell.</p><footer><span>Ⅱ Waiting</span><small>1 decision</small></footer>
          </button>
          <button class="graph-ticket ready" style="--x:625px;--y:270px" type="button" data-open-phase="ready">
            <span class="ticket-id">VERTICAL SLICE</span><strong>Build the browser vertical slice</strong><p>Connect one Git Workspace, canonical Tickets, trusted Run events, and Codex.</p><footer><span>▶ Ready</span><small>4 acceptance</small></footer>
          </button>
          <button class="graph-ticket review" style="--x:935px;--y:170px" type="button" data-open-phase="review">
            <span class="ticket-corner review-ready">Review</span><span class="ticket-id">EXECUTOR SPIKE</span><strong>Verify the resumable Codex boundary</strong><p>Progress, approval, cancellation, Evidence, and restart fixtures are ready to judge.</p><footer><span>◇ Review</span><small>3 Evidence</small></footer>
          </button>
          <button class="graph-ticket blocked" style="--x:935px;--y:400px" type="button" data-open-phase="ready">
            <span class="ticket-id">OPEN SOURCE</span><strong>Prepare the public Harness release</strong><p>Package the accepted experience and its DSH compatibility contract.</p><footer><span>▣ Blocked</span><small>by 2 Tickets</small></footer>
          </button>
        </div>
        <div class="graph-legend"><span><i class="dot running"></i>Trusted Run</span><span><i class="dot needs"></i>Needs you</span><span><i class="dot ready"></i>Ready</span><span><i class="dot review"></i>Review</span><span><i class="dot done"></i>Done</span><small>Click any Ticket to enter its Workspace</small></div>
      </section>
    </div>`;
}

function exploreTemplate() {
  const branchMessage = state.branch === "main"
    ? "正常聊天不受 Ticket protocol 约束。只有用户显式 Fork，才会产生另一条 Conversation lineage。"
    : state.branch === "ticket"
      ? "这个 Branch 单独探索 Ticket 如何成为持续合同。Main 的后续 turn 没有被带进来。"
      : "这个 Branch 单独探索 Context activation。Main 保持不变，Context 也不会自动写回。";
  return `
    <div class="conversation-surface">
      <article class="turn user-turn"><div class="user-bubble">我们想做一个真正用于完成任务的 Agent Harness。Chat 要自然，但 Ticket 不能变成 secondary。</div></article>
      <article class="turn agent-turn">
        <div class="agent-progress compact"><details open><summary><span class="activity-check">Done</span>Separated the product objects <small>Ticket · Run · Chat · Context</small></summary></details></div>
        <div class="agent-answer"><p>正确的关系不是“Chat 里面加一个 Ticket 卡片”，而是：<strong>Ticket throughout; Chat before and around; Run during.</strong></p><p>${branchMessage}</p></div>
        <footer class="turn-actions"><button type="button">Copy</button><button type="button" data-action="fork">Fork</button><button type="button" data-action="craft-ticket">Create ticket from this turn</button></footer>
      </article>
      ${state.broughtBack ? `<article class="turn agent-turn"><div class="agent-progress compact"><details open><summary><span class="activity-check">Compared</span>Two source branches · sources preserved</summary></details></div><div class="agent-answer"><p><strong>Brought back to Main.</strong> Ticket is the durable contract; Context is an explicit scoped input. The synthesis is a new turn, not a hidden merge.</p></div></article>` : ""}
      <article class="principle-note"><strong>Explore surface</strong><span>Normal Agent Chat stays primary here. Branch, Compare, Bring Back, Context, and Ticket craft are explicit optional actions.</span></article>
    </div>`;
}

function readyTemplate() {
  return `
    <div class="focus-surface ticket-focus">
      ${phaseHeader("Ready", "Build the browser vertical slice", "ready")}
      <p class="surface-lede">The work is bounded and inspectable. Ready does not mean that an Agent is running.</p>
      <section class="contract-grid">
        <article><span class="eyebrow">Desired outcome</span><p>A browser-first VibeHub Harness slice demonstrates the complete Ticket execution loop on top of the DSH runtime.</p></article>
        <article><span class="eyebrow">Readiness</span><dl><div><dt>Owner decisions</dt><dd>Resolved</dd></div><div><dt>Dependencies</dt><dd>2 satisfied</dd></div><div><dt>Executor</dt><dd>Codex</dd></div></dl></article>
      </section>
      <section class="acceptance-list"><header><strong>Acceptance</strong><small>4 criteria</small></header>
        <div><i></i><span>Ticket stays primary from Start through closeout</span><small>required</small></div>
        <div><i></i><span>Trusted Run activity is distinct from Ticket status</span><small>required</small></div>
        <div><i></i><span>Attention returns at the exact owning step</span><small>required</small></div>
        <div><i></i><span>Evidence is linked to acceptance</span><small>required</small></div>
      </section>
      <section class="reference-row"><span class="eyebrow">Attached</span><button type="button">3 Context</button><button type="button">2 References</button><button type="button">1 source Branch</button></section>
      <footer class="surface-actions"><button type="button" data-action="craft-ticket">Refine ticket</button><button class="primary" type="button" data-action="start">Start with Codex</button></footer>
    </div>`;
}

function runningTemplate() {
  return `
    <div class="focus-surface run-focus">
      ${phaseHeader("Running", "Codex is implementing the product loop", "running")}
      <div class="run-now"><span class="run-pulse"></span><div><strong>Building the lifecycle surfaces</strong><small>Step 3 of 5 · 08:42 elapsed</small></div><button type="button">Pause</button><button type="button">Interrupt</button></div>
      <section class="run-layout">
        <div class="run-timeline">
          <article class="run-event complete"><i></i><div><header><strong>Read Ticket and scoped Context</strong><small>00:18</small></header><p>Loaded 6 explicit References. No ambient project corpus was injected.</p></div></article>
          <article class="run-event complete"><i></i><div><header><strong>Mapped product state model</strong><small>01:31</small></header><p>Separated Ticket, Run, and attention state; generated the two entry paths.</p><div class="event-chips"><span>Read 6 files</span><span>Product model</span></div></div></article>
          <article class="run-event current"><i></i><div><header><strong>Implement lifecycle simulator</strong><small>running</small></header><p>Editing the central surface, attention queue, and phase-specific Composer behavior.</p><div class="tool-call"><span>Edited</span><code>apps/harness-codex-base/app.js</code><strong>+286</strong></div><div class="tool-call"><span>Edited</span><code>docs/HARNESS_PRODUCT_LOGIC.md</code><strong>+168</strong></div></div></article>
          <article class="run-event"><i></i><div><header><strong>Verify the behavior</strong><small>queued</small></header></div></article>
          <article class="run-event"><i></i><div><header><strong>Attach Evidence</strong><small>queued</small></header></div></article>
        </div>
        <aside class="run-summary"><span class="eyebrow">Run</span><dl><div><dt>Executor</dt><dd>Codex</dd></div><div><dt>Model</dt><dd>GPT-5.6 Sol</dd></div><div><dt>Workspace</dt><dd>vibehub-plugin</dd></div><div><dt>Changes</dt><dd>3 files</dd></div><div><dt>Tests</dt><dd>pending</dd></div></dl><p>These are trusted Run events. The Ticket itself has not changed state merely because activity exists.</p></aside>
      </section>
      <footer class="surface-actions"><span>Chat remains available below for steering.</span><button class="primary" type="button" data-action="continue-run">Continue demo</button></footer>
    </div>`;
}

function needsTemplate() {
  return `
    <div class="focus-surface attention-focus">
      ${phaseHeader("Needs you", "Choose how VibeHub owns the DSH shell", "attention")}
      <p class="surface-lede">The Run is paused at <strong>Verify the integration boundary</strong>. Nothing else needs your attention.</p>
      <section class="attention-card">
        <span class="eyebrow">Decision required</span>
        <h2>Should V1 replace the DSH root shell now, or use additive conversation slots first?</h2>
        <p>The source spike proves both are possible. Replacing root creates the intended whole-application identity, but also makes VibeHub responsible for recreating every child extension seat.</p>
        <div class="choice-list">
          <button type="button" data-action="answer-attention"><strong>Use additive slots for the first vertical slice</strong><span>Lower integration risk; preserve native Chat while validating the Ticket loop.</span><small>Recommended for V1</small></button>
          <button type="button" data-action="answer-attention"><strong>Replace the root shell now</strong><span>Higher visual control; requires full settings, plugin, model, approval, and responsive ownership.</span><small>Larger scope</small></button>
        </div>
      </section>
      <section class="owning-step"><span class="eyebrow">Owning step</span><strong>4 · Verify the integration boundary</strong><span>Run waiting for human · 03:17</span></section>
      <footer class="surface-actions"><button type="button" data-action="cancel-run">Cancel Run</button><span>The Composer can be used to discuss the choice before answering.</span></footer>
    </div>`;
}

function reviewTemplate() {
  return `
    <div class="focus-surface review-focus">
      ${phaseHeader("Review", "DeepSeek Harness foundation spike", "review")}
      <p class="surface-lede">The Run completed. The Ticket is still open until its acceptance is independently judged.</p>
      <section class="result-summary"><div><span class="eyebrow">Result</span><h2>DSH can host the VibeHub loop without upstream patches.</h2><p>The Bundle booted on loopback, additive client slots rendered inside native Chat, explicit Session fork worked, and a replay compatibility failure exposed the durable event constraint.</p></div><dl><div><dt>Run</dt><dd>Completed</dd></div><div><dt>Files</dt><dd>14 changed</dd></div><div><dt>Tests</dt><dd>99 passed</dd></div></dl></section>
      <section class="evidence-review"><header><strong>Acceptance & Evidence</strong><small>3 of 3 supported</small></header>
        <article><span class="evidence-check">✓</span><div><strong>Bundle installs and boots in an isolated Profile</strong><p>Dumped config shows the VibeHub layer after dsh-base and dsh-web-app.</p><button type="button">Boot transcript</button></div></article>
        <article><span class="evidence-check">✓</span><div><strong>Chat extension seats work without replacing native Chat</strong><p>Fork, Context, Graph, Run, and overlay registrations rendered through official slots.</p><button type="button">Client-slot proof</button></div></article>
        <article><span class="evidence-check">✓</span><div><strong>Replay boundary is explicitly known</strong><p>Unknown non-ignorable events fail Session restore; production events require registered durable schemas.</p><button type="button">Failure observation</button></div></article>
      </section>
      <footer class="surface-actions"><button type="button" data-action="request-revision">Request revision</button><button class="primary" type="button" data-action="accept">Accept closeout</button></footer>
    </div>`;
}

function doneTemplate() {
  return `
    <div class="focus-surface done-focus">
      ${phaseHeader("Done", "Additive DSH extension seams are proven", "done")}
      <p class="surface-lede">The Outcome records what was accepted, why, and which Evidence supports it. Chat and Run logs remain history, not the source of truth.</p>
      <section class="outcome-card"><span class="eyebrow">Outcome</span><h2>Proceed with a single-Workspace browser-first vertical slice.</h2><p>Use DSH as the Session, model, tool, approval, command, and plugin runtime. Build the VibeHub Ticket loop through a compatibility adapter; retain root replacement as a later visual decision.</p><footer><span>Accepted by owner</span><span>6 Evidence items</span><span>commit pending</span></footer></section>
      <section class="writeback-proposals"><header><div><strong>Context writeback proposals</strong><small>Outcome does not update durable Context automatically.</small></div><span>2 proposed</span></header>
        <article><div><strong>DSH unknown event replay constraint</strong><p>Architecture · sourced from the executed failure observation</p></div><div><button type="button" data-action="dismiss-context">Dismiss</button><button type="button" data-action="approve-context">Approve</button></div></article>
        <article><div><strong>Additive slots before root replacement</strong><p>Product architecture · sourced from accepted Outcome</p></div><div><button type="button" data-action="dismiss-context">Dismiss</button><button type="button" data-action="approve-context">Approve</button></div></article>
      </section>
      <footer class="surface-actions"><button type="button" data-action="reopen">Reopen Ticket</button><button class="primary" type="button" data-action="follow-up">Create follow-up Ticket</button></footer>
    </div>`;
}

const templates = { explore: exploreTemplate, ready: readyTemplate, running: runningTemplate, needs: needsTemplate, review: reviewTemplate, done: doneTemplate };

function renderPhase() {
  state.view = "ticket";
  const copy = phaseCopy[state.phase];
  stage.innerHTML = templates[state.phase]();
  $("#workTitle").textContent = copy.title;
  $("#workMeta").textContent = copy.meta;
  $("#prompt").placeholder = copy.placeholder;
  $("#composerMode").textContent = copy.mode;
  $("#ticketButton").textContent = copy.ticketAction;
  $("#prototypeMap").hidden = false;
  $("#backToGraph").hidden = false;
  $("#lineage").hidden = state.phase !== "explore" || state.branch === "main";
  $("#branchesButton").hidden = state.phase !== "explore";
  $("#historyButton").hidden = false;
  $("#ticketButton").hidden = false;
  $("#historyButton").textContent = state.phase === "explore" ? "Chat" : "Open Chat";
  for (const button of $$('[data-phase]')) button.classList.toggle("active", button.dataset.phase === state.phase);
  $("#ticketsHome").classList.remove("active");
  requestAnimationFrame(() => { stage.scrollTop = 0; });
}

function showGraph(message) {
  state.view = "graph";
  closeLayers();
  stage.innerHTML = graphTemplate();
  $("#workTitle").textContent = "vibehub-plugin";
  $("#workMeta").textContent = "CURRENT TICKET GRAPH · main · local";
  $("#prototypeMap").hidden = true;
  $("#backToGraph").hidden = true;
  $("#lineage").hidden = true;
  $("#historyButton").hidden = true;
  $("#branchesButton").hidden = true;
  $("#ticketButton").hidden = true;
  $("#composerMode").textContent = "Capture new work · the graph remains the home surface";
  $("#prompt").placeholder = "Describe new work, search Tickets, or ask about the graph";
  for (const button of $$('[data-phase]')) button.classList.remove("active");
  $("#ticketsHome").classList.add("active");
  requestAnimationFrame(() => { stage.scrollTop = 0; stage.scrollLeft = 0; });
  if (message) notify(message);
}

function setPhase(phase, message) {
  if (!templates[phase]) return;
  state.phase = phase;
  closeLayers();
  renderPhase();
  if (message) notify(message);
}

function enterBranch(branch) {
  state.branch = branch;
  setPhase("explore", branch === "main" ? "Returned to Main" : "Opened an explicit fork from a closed turn");
}

function updateContextCount() {
  const count = $$('#contextMenu input:checked').length;
  $("#contextCount").textContent = `${count} selected`;
  return count;
}

function applyContext() {
  state.contextCount = updateContextCount();
  $("#contextRow").hidden = state.contextCount === 0;
  $("#contextSummaryText").textContent = `${state.contextCount} Workspace reference${state.contextCount === 1 ? "" : "s"}`;
  $("#contextButton small").textContent = state.contextCount ? String(state.contextCount) : "Off";
  closeLayers();
  notify(state.contextCount ? "Context attached to the next turn only" : "No Context attached");
}

stage.addEventListener("click", (event) => {
  const graphTicket = event.target.closest("button[data-open-phase]");
  if (graphTicket) {
    setPhase(graphTicket.dataset.openPhase, "Opened the Ticket Workspace. The graph remains one level above.");
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "fork") enterBranch("context");
  if (action === "craft-ticket") openLayer("ticketPanel");
  if (action === "start") setPhase("running", "Run started. Trusted activity now owns the main surface.");
  if (action === "continue-run") setPhase("needs", "Run paused at the exact step that needs your decision.");
  if (action === "answer-attention") setPhase("review", "Decision recorded. The Run resumed and produced Evidence.");
  if (action === "cancel-run") setPhase("ready", "Run cancelled. The Ticket remains Ready and can be started again.");
  if (action === "request-revision") setPhase("running", "Revision requested. A new Run attempt is active.");
  if (action === "accept") setPhase("done", "Outcome accepted. Evidence remains linked to the Ticket.");
  if (action === "reopen") setPhase("ready", "Ticket reopened. Previous Outcome and Evidence are preserved.");
  if (action === "follow-up") setPhase("ready", "Follow-up Ticket drafted from this Outcome.");
  if (action === "approve-context") { button.closest("article").remove(); notify("Context proposal approved with provenance"); }
  if (action === "dismiss-context") { button.closest("article").remove(); notify("Context proposal dismissed. Outcome is unchanged."); }
});

for (const button of $$('[data-phase]')) button.addEventListener("click", () => setPhase(button.dataset.phase));
$("#ticketsHome").addEventListener("click", () => showGraph("Returned to the Ticket graph"));
$("#backToGraph").addEventListener("click", () => showGraph("Returned to the Ticket graph"));
$("#historyButton").addEventListener("click", () => setPhase("explore", "Opened the conversation attached to this Ticket"));
$("#branchesButton").addEventListener("click", () => openLayer("branchesPanel"));
$("#ticketButton").addEventListener("click", () => openLayer("ticketPanel"));
$("#backToMain").addEventListener("click", () => enterBranch("main"));
$$('[data-branch]').forEach((button) => button.addEventListener("click", () => enterBranch(button.dataset.branch)));
$("#compareBranches").addEventListener("click", () => openLayer("compareModal"));
$("#bringBack").addEventListener("click", () => {
  state.branch = "main";
  state.broughtBack = true;
  setPhase("explore", "Synthesis appended to Main. Both source branches are preserved.");
});

$("#contextButton").addEventListener("click", () => { contextMenu.hidden = false; overlay.hidden = false; updateContextCount(); });
$("#contextSummary").addEventListener("click", () => { contextMenu.hidden = false; overlay.hidden = false; updateContextCount(); });
$("#useContext").addEventListener("click", applyContext);
$("#removeContext").addEventListener("click", () => {
  state.contextCount = 0;
  $("#contextRow").hidden = true;
  $("#contextButton small").textContent = "Off";
  notify("Context removed from the next turn");
});
$$('#contextMenu input').forEach((input) => input.addEventListener("change", updateContextCount));
$("#createTicket").addEventListener("click", () => setPhase("ready", "Ticket saved. No execution has started."));

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const prompt = $("#prompt");
  const text = prompt.value.trim();
  if (!text) return;
  const turn = document.createElement("article");
  turn.className = "inline-steer";
  const user = document.createElement("p");
  user.textContent = text;
  const reply = document.createElement("span");
  reply.textContent = state.phase === "running" || state.phase === "needs"
    ? "Steering message attached to the active Ticket and Run. The durable contract was not silently rewritten."
    : "Normal Agent turn added. VibeHub does not constrain the model or tools in Chat.";
  turn.append(user, reply);
  stage.append(turn);
  prompt.value = "";
  stage.scrollTop = stage.scrollHeight;
  if (state.contextCount) {
    state.contextCount = 0;
    $("#contextRow").hidden = true;
    $("#contextButton small").textContent = "Off";
  }
});

for (const button of $$('[data-close]')) button.addEventListener("click", closeLayers);
overlay.addEventListener("click", closeLayers);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeLayers();
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") $("#composer").requestSubmit();
});
$("#newTask").addEventListener("click", () => setPhase("explore", "New task starts as normal Agent Chat and may later become a Ticket"));

showGraph();
