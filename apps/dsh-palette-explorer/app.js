const palettes = [
  {
    id: "true-black",
    name: "True Black",
    intent: "OLED-black, hard white, maximum spatial silence.",
    strength: "The cleanest and most product-like at night; graph lines disappear until needed.",
    risk: "High contrast can feel severe during long sessions.",
  },
  {
    id: "graphite",
    name: "Graphite",
    intent: "Neutral charcoal with a restrained cool cast; closest to Codex.",
    strength: "Best balance of hierarchy, calm surfaces and long-session comfort.",
    risk: "The safest option; it may need stronger brand personality in final polish.",
  },
  {
    id: "soft-black",
    name: "Soft Black",
    intent: "Lifted black and softer white for lower contrast and less screen glare.",
    strength: "Quiet, comfortable, and forgiving across dense Chat and Task surfaces.",
    risk: "Can become flat if borders and elevation are not disciplined.",
  },
  {
    id: "cool-mono",
    name: "Cool Mono",
    intent: "Blue-black neutrals without a visible blue accent.",
    strength: "Technical and precise while remaining essentially black and white.",
    risk: "May drift back toward the blue-gray feeling the owner rejected.",
  },
  {
    id: "warm-mono",
    name: "Warm Mono",
    intent: "Brown-black neutrals and warm white without paper or sepia treatment.",
    strength: "More human and less sterile while preserving a dark application feel.",
    risk: "Warmth must stay subtle or it begins to feel editorial.",
  },
];

const root = document.documentElement;
const fullShell = document.querySelector("#fullShell");
const overview = document.querySelector("#overview");
const compareButton = document.querySelector("#compareAll");
const paletteName = document.querySelector("#paletteName");
const paletteNumber = document.querySelector("#paletteNumber");
const paletteIntent = document.querySelector("#paletteIntent");
const tokenStrip = document.querySelector("#tokenStrip");
const surfaceTitle = document.querySelector("#surfaceTitle");
const surfaceMeta = document.querySelector("#surfaceMeta");
const toast = document.querySelector("#toast");

if (new URLSearchParams(window.location.search).get("frame") === "narrow") {
  document.body.dataset.frame = "narrow";
}

let activePalette = palettes[1];
let activeView = "graph";
let compareMode = false;

function tokenValues() {
  const style = getComputedStyle(root);
  return ["--bg", "--sidebar", "--surface", "--surface-2", "--border", "--text", "--muted", "--accent"]
    .map((name) => ({ name, value: style.getPropertyValue(name).trim() }));
}

function renderTokens() {
  tokenStrip.replaceChildren(...tokenValues().map(({ name, value }) => {
    const token = document.createElement("i");
    token.title = `${name}: ${value}`;
    token.style.setProperty("--token", value);
    return token;
  }));
}

function choosePalette(id, announce = true) {
  const next = palettes.find((palette) => palette.id === id);
  if (!next) return;
  activePalette = next;
  root.dataset.palette = next.id;
  document.querySelectorAll("[data-palette-choice]").forEach((button) => {
    const selected = button.dataset.paletteChoice === next.id;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  paletteName.textContent = next.name;
  paletteNumber.textContent = `${String(palettes.indexOf(next) + 1).padStart(2, "0")} / ${String(palettes.length).padStart(2, "0")}`;
  paletteIntent.textContent = next.intent;
  renderTokens();
  if (announce) showToast(`${next.name} · ${next.intent}`);
}

function chooseView(view) {
  activeView = view;
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  document.querySelectorAll("[data-surface]").forEach((surface) => surface.classList.toggle("active", surface.dataset.surface === view));
  const labels = {
    graph: ["Tasks", "Current graph · vibehub-plugin"],
    chat: ["Harness product direction", "Chat · native DSH Session"],
    task: ["Compare shell palette directions", "Task Workspace · Needs you"],
  };
  [surfaceTitle.textContent, surfaceMeta.textContent] = labels[view];
}

function previewMarkup(palette) {
  return `
    <article class="palette-preview palette-${palette.id}">
      <header><div><strong>${palette.name}</strong><small>${palette.intent}</small></div><button type="button" data-inspect="${palette.id}">Inspect full size</button></header>
      <div class="mini-shell"><aside class="mini-side"><strong>VibeHub</strong><span>New chat</span><span class="active">Tasks · 8</span><span>Rooms · 4</span><span>Workspace</span><span>Chats</span></aside><section class="mini-main"><h3>Task graph</h3><article class="mini-card"><small>RUNNING · NEEDS YOU</small><b>Compare shell palettes</b><p>Same geometry, monochrome tokens.</p></article><article class="mini-card"><small>DRAFT · BLOCKED</small><b>Build visual system</b><p>Waiting for product surfaces.</p></article></section></div>
    </article>`;
}

function renderOverview() {
  overview.innerHTML = palettes.map(previewMarkup).join("");
}

function setCompareMode(enabled) {
  compareMode = enabled;
  fullShell.hidden = enabled;
  overview.hidden = !enabled;
  compareButton.textContent = enabled ? "Back to full size" : "Compare all";
  compareButton.setAttribute("aria-pressed", String(enabled));
  if (enabled) renderOverview();
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 1800);
}

document.addEventListener("click", (event) => {
  const paletteButton = event.target.closest("button[data-palette-choice]");
  if (paletteButton) choosePalette(paletteButton.dataset.paletteChoice);

  const viewButton = event.target.closest("button[data-view]");
  if (viewButton) chooseView(viewButton.dataset.view);

  const inspectButton = event.target.closest("button[data-inspect]");
  if (inspectButton) {
    choosePalette(inspectButton.dataset.inspect, false);
    setCompareMode(false);
    document.querySelector(`[data-palette-choice="${inspectButton.dataset.inspect}"]`)?.focus({ preventScroll: true });
  }
});

compareButton.addEventListener("click", () => setCompareMode(!compareMode));

document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const index = Number(event.key) - 1;
  if (index >= 0 && index < palettes.length) choosePalette(palettes[index].id);
  if (event.key.toLowerCase() === "c") setCompareMode(!compareMode);
  if (["g", "h", "t"].includes(event.key.toLowerCase())) {
    chooseView({ g: "graph", h: "chat", t: "task" }[event.key.toLowerCase()]);
  }
});

renderOverview();
choosePalette(activePalette.id, false);
chooseView(activeView);
