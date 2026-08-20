const state = {
  contextOn: false,
  contextCount: 3,
  activeBranch: "main",
  runActive: false,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const transcript = $("#transcript");
const messageInput = $("#messageInput");
const contextToggle = $("#contextToggle");
const composerContext = $("#composerContext");
const contextAttachment = $("#contextAttachment");
const scrim = $("#scrim");
const toast = $("#toast");
const composerZone = $("#composerZone");
const runStrip = $("#runStrip");
const attentionBar = $("#attentionBar");

let toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2200);
}

function activeOverlay() {
  return $(".drawer:not([hidden]), .compare-dialog:not([hidden]), .run-panel:not([hidden]), .command-palette:not([hidden])");
}

function closeOverlay() {
  for (const element of $$(".drawer, .compare-dialog, .run-panel, .command-palette")) {
    element.hidden = true;
    if (element.hasAttribute("inert")) element.inert = true;
  }
  scrim.hidden = true;
}

function openOverlay(id) {
  closeOverlay();
  const element = document.getElementById(id);
  element.hidden = false;
  if (element.hasAttribute("inert")) element.inert = false;
  scrim.hidden = false;
  $("button, textarea, input", element)?.focus();
}

function setContext(enabled) {
  state.contextOn = enabled;
  contextToggle.setAttribute("aria-pressed", String(enabled));
  $("small", contextToggle).textContent = enabled ? "On" : "Off";
  composerContext.classList.toggle("active", enabled);
  composerContext.lastChild.textContent = enabled ? `Context · ${state.contextCount}` : "Context off";
  contextAttachment.hidden = !enabled;
  document.querySelector(".chat-stage").classList.toggle("context-active", enabled);
}

function selectedContextCount() {
  return $$('.reference-list input:checked').length;
}

function syncContextSelection() {
  const count = selectedContextCount();
  $("#contextScopeCount").textContent = `${count} of 18 references selected`;
  $("#applyContext").textContent = count ? `Use ${count} reference${count === 1 ? "" : "s"}` : "Use no Context";
}

function prepareTask() {
  $("#taskSourceBranch").textContent = state.activeBranch === "main" ? "Main conversation" : `${state.activeBranch} branch`;
  $("#taskSourceContext").textContent = state.contextOn ? `${state.contextCount} Context references` : "No Context attached";
  openOverlay("taskDrawer");
}

function addUserMessage(text) {
  const article = document.createElement("article");
  article.className = "message user-message";
  const copy = document.createElement("div");
  copy.className = "message-copy";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  copy.append(paragraph);
  article.append(copy);
  transcript.append(article);

  const reply = document.createElement("article");
  reply.className = "message assistant-message";
  reply.innerHTML = `<header><span class="agent-mark">V</span><strong>VibeHub Agent</strong><small>Codex · now</small></header><div class="message-copy assistant-copy"><p>收到。我们会沿着当前对话继续，不会因为 Context 或 Ticket 控件改变正常 Agent Chat 的能力边界。</p></div>`;
  transcript.append(reply);
  transcript.scrollTop = transcript.scrollHeight;
}

function enterBranch(branch, source = "Execution should be visible only when…") {
  state.activeBranch = branch;
  $("#branchReturn").hidden = branch === "main";
  $("#chatPath").textContent = branch === "main" ? "vibehub-plugin / Main" : `vibehub-plugin / Main / ${branch}`;
  $("#threadBranchLabel").textContent = branch === "main" ? "Main · now" : `${branch} · Fork`;
  if (branch !== "main") $("#branchReturn span").innerHTML = `Forked from <strong>Main</strong> · “${source}”`;
  for (const message of $$(".main-tail")) message.hidden = branch !== "main";
  for (const message of $$(".branch-tail")) message.remove();
  if (branch !== "main") {
    const branchTail = document.createElement("article");
    branchTail.className = "message assistant-message branch-tail latest-message";
    const branchCopy = branch === "ticket"
      ? "This fork can stay focused on the boundary between open exploration and a durable Ticket. Main remains untouched while we test the contract here."
      : branch === "execution"
        ? "This fork isolates execution attention: routine progress stays peripheral; only an exact approval, failure, or judgment crosses the work surface."
        : "This fork starts at the selected answer section. Continue normally here, compare it later, or bring a conclusion back to Main.";
    branchTail.innerHTML = `<header><span class="agent-mark">V</span><strong>VibeHub Agent</strong><small>Fork · inherited context</small></header><div class="message-copy assistant-copy"><p>${branchCopy}</p></div><footer class="message-footer"><button type="button">Copy</button><span>Main history is unchanged</span></footer>`;
    transcript.append(branchTail);
    transcript.scrollTop = transcript.scrollHeight;
  }
  closeOverlay();
  showToast(branch === "main" ? "Returned to Main" : "Fork opened. Main is unchanged.");
}

function startRun() {
  state.runActive = true;
  closeOverlay();
  runStrip.hidden = false;
  document.querySelector(".chat-stage").classList.add("run-active");
  $("#runCount").textContent = "1";
  $("#taskButton").textContent = "Run active";
  $("#taskButton").classList.add("running");
  showToast("Task created. Trusted Run activity is now visible.");
}

$("#branchesButton").addEventListener("click", () => openOverlay("branchDrawer"));
$("#taskButton").addEventListener("click", () => state.runActive ? openOverlay("runPanel") : prepareTask());
$("#inlineTask").addEventListener("click", prepareTask);
$("#contextToggle").addEventListener("click", () => openOverlay("contextDrawer"));
$("#composerContext").addEventListener("click", () => openOverlay("contextDrawer"));
$$('[data-open-context]').forEach((button) => button.addEventListener("click", () => openOverlay("contextDrawer")));
$("#applyContext").addEventListener("click", () => {
  state.contextCount = selectedContextCount();
  setContext(state.contextCount > 0);
  $("#contextCountLabel").textContent = String(state.contextCount);
  closeOverlay();
  showToast(state.contextCount ? `${state.contextCount} references will inform the next turn` : "Context removed from the next turn");
});
$("#removeContext").addEventListener("click", () => setContext(false));
for (const checkbox of $$(".reference-list input")) checkbox.addEventListener("change", syncContextSelection);

$$('[data-fork]').forEach((button) => button.addEventListener("click", () => {
  const branch = button.dataset.fork;
  enterBranch(branch, button.closest(".answer-section")?.querySelector("p")?.textContent.slice(0, 42) || "Latest assistant turn");
}));
$$('[data-branch]').forEach((button) => button.addEventListener("click", () => enterBranch(button.dataset.branch)));
$("#returnMain").addEventListener("click", () => enterBranch("main"));

$("#compareButton").addEventListener("click", () => openOverlay("compareDialog"));
$("#bringBack").addEventListener("click", () => {
  closeOverlay();
  enterBranch("main");
  const article = document.createElement("article");
  article.className = "message assistant-message latest-message";
  article.innerHTML = `<header><span class="agent-mark">V</span><strong>VibeHub Agent</strong><small>Compared branches · now</small></header><div class="message-copy assistant-copy"><p><strong>Brought back from two forks.</strong> Chat should stay fluid until an outcome is bounded; after Start, trusted execution stays quiet and returns only at the exact step that needs the person.</p></div><footer class="message-footer"><span>Sources: Ticket craft · Execution attention</span></footer>`;
  transcript.append(article);
  transcript.scrollTop = transcript.scrollHeight;
});

$("#createAndStart").addEventListener("click", startRun);
$("#runSummary").addEventListener("click", () => openOverlay("runPanel"));
$("#runOpen").addEventListener("click", () => openOverlay("runPanel"));
$("#previewAttention").addEventListener("click", () => {
  closeOverlay();
  runStrip.hidden = true;
  attentionBar.hidden = false;
});
$("#notNow").addEventListener("click", () => {
  attentionBar.hidden = true;
  runStrip.hidden = false;
  showToast("Run remains waiting at step 4");
});
$("#allowOnce").addEventListener("click", () => {
  attentionBar.hidden = true;
  runStrip.hidden = false;
  $("#runLabel").textContent = "Verifying product surface";
  $("#runDetail").textContent = "Permission granted once · step resumed";
  $("#runProgress").style.width = "76%";
  $("#runStep").textContent = "4 / 5";
  showToast("Run resumed from the owning step");
});

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;
  addUserMessage(text);
  messageInput.value = "";
});
messageInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") $("#composer").requestSubmit();
});

for (const button of $$('[data-close]')) button.addEventListener("click", closeOverlay);
scrim.addEventListener("click", closeOverlay);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && activeOverlay()) closeOverlay();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openOverlay("commandPalette");
  }
});

$("#newChat").addEventListener("click", () => { messageInput.focus(); showToast("New Chat stays inside the current Workspace"); });
$("#commandTrigger").addEventListener("click", () => openOverlay("commandPalette"));
$("#engineButton").addEventListener("click", () => showToast("Engine settings preserve DSH models, tools, permissions, and plugins"));
$("#settingsButton").addEventListener("click", () => showToast("Engine settings are secondary to the work surface"));

setContext(false);
syncContextSelection();

const commandInput = $("#commandInput");
const commandButtons = $$("[data-command]");

function visibleCommands() {
  return commandButtons.filter((button) => !button.hidden);
}

function selectCommand(index) {
  const commands = visibleCommands();
  commandButtons.forEach((button) => button.classList.remove("selected"));
  if (commands.length) commands[(index + commands.length) % commands.length].classList.add("selected");
}

function runCommand(name) {
  closeOverlay();
  if (name === "chat") messageInput.focus();
  if (name === "task") prepareTask();
  if (name === "branches") openOverlay("branchDrawer");
  if (name === "context") openOverlay("contextDrawer");
  if (name === "ticket") showToast("Ticket search stays scoped to vibehub-plugin in V1");
}

commandButtons.forEach((button) => button.addEventListener("click", () => runCommand(button.dataset.command)));
commandInput.addEventListener("input", () => {
  const query = commandInput.value.trim().toLowerCase();
  commandButtons.forEach((button) => { button.hidden = query && !button.textContent.toLowerCase().includes(query); });
  selectCommand(0);
});
commandInput.addEventListener("keydown", (event) => {
  const commands = visibleCommands();
  const current = commands.findIndex((button) => button.classList.contains("selected"));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    selectCommand(current + (event.key === "ArrowDown" ? 1 : -1));
  }
  if (event.key === "Enter" && commands.length) {
    event.preventDefault();
    runCommand((commands[current >= 0 ? current : 0]).dataset.command);
  }
});
