const references = [
  {
    id: "codex-shell",
    product: "codex",
    productName: "OpenAI Codex",
    title: "项目、线程与当前工作保持在同一层级",
    dimensions: ["shell", "chat", "density"],
    image: "https://developers.openai.com/cookbook/assets/images/long_horizon_codex_app_main_workspace.jpg",
    source: "https://openai.com/index/introducing-the-codex-app/",
    note: "应用壳非常克制。左侧承担长期导航，中间只保留当前任务，环境与模型跟着输入框走。",
    principle: "可以只判断：侧栏密度、中心留白、输入框位置、控制项是否足够安静。",
  },
  {
    id: "codex-empty",
    product: "codex",
    productName: "OpenAI Codex",
    title: "启动任务时没有先展示 Dashboard",
    dimensions: ["shell", "chat", "action"],
    image: "https://i.vimeocdn.com/video/2116374900-3001aee7af7ec8de12e7aeb11e6d6543ebee11f8bedc02f6a1b97533c44a7240-d?f=webp",
    source: "https://openai.com/index/introducing-the-codex-app/",
    note: "第一帧仍然围绕输入展开，没有用数据卡片证明自己是一个强大的工作台。",
    principle: "重点看任务入口是否自然，以及 Local / Worktree / Cloud 这类复杂设置如何退到第二层。",
  },
  {
    id: "claude-home",
    product: "claude",
    productName: "Claude Desktop",
    title: "Chat、Cowork 与 Code 共用一个安静入口",
    dimensions: ["shell", "chat"],
    image: "https://cdn.prod.website-files.com/68a44d4040f98a4adf2207b6/699e2a825db36326599a999e_Screenshot%202026-02-24%20at%202.47.24%E2%80%AFPM.png",
    source: "https://claude.com/resources/tutorials/navigating-the-claude-desktop-app",
    note: "不同能力没有变成不同产品。模式差异被压缩到用户真正需要做决定的位置。",
    principle: "重点看：自然、成熟、没有概念稿味道；同时是否过于普通。",
  },
  {
    id: "claude-chat",
    product: "claude",
    productName: "Claude Desktop",
    title: "对话本身拥有绝大部分视觉空间",
    dimensions: ["chat", "shell"],
    image: "https://cdn.prod.website-files.com/68a44d4040f98a4adf2207b6/69a8c30634a6c3e545269791_69a8a456caa28723041a6eea_699e1b746d83c9fb55a56d31_698be3352261cf694fdae308_698bdd295c5f5d680c01e63c_Screenshot%25252525202026-02-09%2525252520at%25252525204.38.22%25252525E2%2525252580%25252525AFPM.png",
    source: "https://claude.com/resources/tutorials/navigating-the-claude-desktop-app",
    note: "Chrome 很少，视觉节奏主要来自文本、间距和 composer，而不是容器装饰。",
    principle: "重点看：这种原生 Chat 是否正是我们应该先守住的基线。",
  },
  {
    id: "claude-cowork",
    product: "claude",
    productName: "Claude Cowork",
    title: "计划、来源与进度围绕任务逐渐显形",
    dimensions: ["execution", "chat", "action"],
    image: "https://cdn.prod.website-files.com/68a44d4040f98a4adf2207b6/69a8c30634a6c3e54526979c_69a8a456caa28723041a6ee7_699e2c4828218e71872531df_699e289b7bffb76b5ebedc79_Screenshot%252525202026-02-24%25252520at%252525202.39.06%252525E2%25252580%252525AFPM.png",
    source: "https://claude.com/resources/tutorials/navigating-the-claude-desktop-app",
    note: "长任务不是一个独立运维台。它仍然是一场对话，只是侧边出现可检查的计划与产物。",
    principle: "重点看：执行信息贴着工作出现，而不是占据全局 Dashboard。",
  },
  {
    id: "claude-code",
    product: "claude",
    productName: "Claude Code Desktop",
    title: "复杂执行能力通过局部面板进入",
    dimensions: ["execution", "density", "action"],
    image: "https://cdn.prod.website-files.com/68a44d4040f98a4adf2207b6/69a8c30634a6c3e545269794_69a8a455caa28723041a6ee1_699e1b736d83c9fb55a56d2a_698be3342261cf694fdae301_698bdd78a6031117e6bb41d6_Screenshot%25252525202026-02-09%2525252520at%252525252012.52.07%25252525E2%2525252580%25252525AFPM.png",
    source: "https://claude.com/resources/tutorials/navigating-the-claude-desktop-app",
    note: "Diff、terminal 和计划有明确座位，但不要求普通 Chat 永久承担这些结构。",
    principle: "重点看：专业能力的密度是否仍然显得像一个完整应用，而非后台控制台。",
  },
  {
    id: "linear-sidebar",
    product: "linear",
    productName: "Linear",
    title: "导航主动变暗，让工作表面获得注意力",
    dimensions: ["shell", "density"],
    image: "https://webassets.linear.app/images/ornj730p/production/b6d6be14c96978b10553cfb9205be1065087e793-3904x2720.png?auto=format&dpr=2&q=95",
    source: "https://linear.app/now/behind-the-latest-design-refresh",
    note: "这是一次 before / after。新版不是添加美术效果，而是降低非当前区域的存在感。",
    principle: "重点看：导航的好看来自比例、对齐和克制，而不是视觉主题。",
  },
  {
    id: "linear-tabs",
    product: "linear",
    productName: "Linear",
    title: "紧凑 Tab 不再假装成页面标题栏",
    dimensions: ["shell", "action", "density"],
    image: "https://webassets.linear.app/images/ornj730p/production/51c8d03e31853bae9491d8ac5f05bdf1d7921236-3904x2160.png?auto=format&dpr=2&q=95",
    source: "https://linear.app/now/behind-the-latest-design-refresh",
    note: "通过尺寸和占位调整，让多任务切换存在，但不抢当前内容的视觉权重。",
    principle: "重点看：我们的 conversation branch 是否更适合借这种轻量切换，而不是常驻 Graph。",
  },
  {
    id: "linear-borders",
    product: "linear",
    productName: "Linear",
    title: "结构应该被感知，而不是被边框画出来",
    dimensions: ["density", "shell"],
    image: "https://webassets.linear.app/images/ornj730p/production/67561baa677fbc429d94edd080e95aecabb6bae2-3904x2720.png?auto=format&dpr=2&q=95",
    source: "https://linear.app/now/behind-the-latest-design-refresh",
    note: "减少分隔线、弱化容器边缘以后，信息层级反而更清楚。",
    principle: "重点看：上一轮大量卡片、描边和小容器为什么显得便宜。",
  },
  {
    id: "raycast-search",
    product: "raycast",
    productName: "Raycast",
    title: "最重要的动作拥有最明确的位置",
    dimensions: ["action", "density"],
    image: "https://www.raycast.com/uploads/redesign/navbar.png",
    source: "https://www.raycast.com/blog/a-fresh-look-and-feel",
    note: "搜索不是一个普通输入框，而是整个产品的重心；其他信息围绕它组织。",
    principle: "重点看：动作优先不等于做一个巨大 hero，也不需要解释产品概念。",
  },
  {
    id: "raycast-actionbar",
    product: "raycast",
    productName: "Raycast",
    title: "上下文动作集中在稳定的 Action Bar",
    dimensions: ["action", "shell"],
    image: "https://www.raycast.com/uploads/redesign/actionbar.png",
    source: "https://www.raycast.com/blog/a-fresh-look-and-feel",
    note: "当前位置、toast、可用动作和快捷键共享一个稳定区域，用户会逐渐学会速度。",
    principle: "重点看：Ticket / Fork / Bring Back 是否应通过上下文动作层出现。",
  },
  {
    id: "raycast-panel",
    product: "raycast",
    productName: "Raycast",
    title: "需要更多信息时才展开第二个面板",
    dimensions: ["action", "density"],
    image: "https://www.raycast.com/uploads/redesign/actionbar-right.png",
    source: "https://www.raycast.com/blog/a-fresh-look-and-feel",
    note: "默认保持单一焦点，详情是一个可逆的扩展状态，不是永久三栏布局。",
    principle: "重点看：Context inspector 应该何时出现、出现后是否仍然保持焦点。",
  },
  {
    id: "warp-agents",
    product: "warp",
    productName: "Warp",
    title: "多 Agent 状态可以快速扫描",
    dimensions: ["execution", "density"],
    image: "https://b0olj48ynho64j26.public.blob.vercel-storage.com/agent_mgmt_4_07fe813a90.png",
    source: "https://www.warp.dev/blog/reimagining-coding-agentic-development-environment",
    note: "这是最接近执行 supervision 的参考。价值在状态与 attention，不一定在视觉风格。",
    principle: "重点看：哪些信息是运行中真的需要，哪些只是控制台惯性。",
  },
  {
    id: "warp-input",
    product: "warp",
    productName: "Warp",
    title: "一个输入承载 prompt、command 与 context",
    dimensions: ["chat", "action", "execution"],
    image: "https://b0olj48ynho64j26.public.blob.vercel-storage.com/udi_3_f7185bb97c.jpg",
    source: "https://www.warp.dev/blog/reimagining-coding-agentic-development-environment",
    note: "Universal input 把模型、上下文、终端和 Agent 模式放在用户即将行动的位置。",
    principle: "重点看：我们的 Chat composer 是否也应该成为工作转换的唯一稳定入口。",
  },
  {
    id: "warp-notification",
    product: "warp",
    productName: "Warp",
    title: "只有需要注意力的执行才跨越页面",
    dimensions: ["execution", "action"],
    image: "https://b0olj48ynho64j26.public.blob.vercel-storage.com/notification_3_068d3a3893.jpg",
    source: "https://www.warp.dev/blog/reimagining-coding-agentic-development-environment",
    note: "Run 不需要永远占据中央。真正跨页面的是完成、失败和 needs-you。",
    principle: "重点看：VibeHub 的 attention return 是否应比 persistent run dock 更克制。",
  },
  {
    id: "dia-shell",
    product: "dia",
    productName: "Dia",
    title: "Chrome 很少，但窗口仍然有清晰结构",
    dimensions: ["shell", "chat"],
    image: "https://cdn.sanity.io/images/e5fj2khm/production/a7d00e4699171e3827f316d9b89642504154c443-1096x711.png?auto=format&dpr=2&q=100&w=1200",
    source: "https://www.diabrowser.com/",
    note: "低 chrome 不等于神秘或空。熟悉的浏览器空间与 AI 能力被整合，而非重新发明。",
    principle: "重点看：native、轻、日常，而不是概念化的“未来工作台”。",
  },
];

const ratings = new Map();
const filter = { dimension: "all", product: "all" };
const grid = document.querySelector("#reference-grid");
const emptyState = document.querySelector("#empty-state");
const imageDialog = document.querySelector("#image-dialog");
const summaryDialog = document.querySelector("#summary-dialog");
const toast = document.querySelector("#toast");

const ratingLabels = {
  keep: "喜欢整体",
  part: "只要局部",
  reject: "不要",
};

function visibleReferences() {
  return references.filter((item) => {
    const dimensionMatch = filter.dimension === "all" || item.dimensions.includes(filter.dimension);
    const productMatch = filter.product === "all" || item.product === filter.product;
    return dimensionMatch && productMatch;
  });
}

function ratingControls(id, compact = false) {
  const selected = ratings.get(id);
  return `<div class="rating-controls ${compact ? "is-compact" : ""}" data-rating-for="${id}">
    <button class="${selected === "keep" ? "is-selected" : ""}" data-rate="keep"><i></i>${compact ? "喜欢" : "喜欢整体"}</button>
    <button class="${selected === "part" ? "is-selected" : ""}" data-rate="part"><i></i>${compact ? "局部" : "只要局部"}</button>
    <button class="${selected === "reject" ? "is-selected" : ""}" data-rate="reject"><i></i>${compact ? "不要" : "不要"}</button>
  </div>`;
}

function render() {
  const items = visibleReferences();
  document.querySelector("#visible-count").textContent = String(items.length);
  document.querySelector("#rated-count").textContent = String(items.filter((item) => ratings.has(item.id)).length);
  emptyState.hidden = items.length > 0;
  grid.hidden = items.length === 0;
  grid.innerHTML = items.map((item) => `
    <article class="reference-card ${ratings.has(item.id) ? `rated-${ratings.get(item.id)}` : ""}" data-reference-id="${item.id}">
      <button class="image-button" data-action="open-image" aria-label="放大查看 ${item.productName}：${item.title}">
        <img src="${item.image}" alt="${item.productName} 官方界面：${item.title}" loading="lazy" referrerpolicy="no-referrer" />
        <span>Open</span>
      </button>
      <div class="card-content">
        <header><span>${item.productName}</span><div>${item.dimensions.map((dimension) => `<i>${dimension}</i>`).join("")}</div></header>
        <h2>${item.title}</h2>
        <p>${item.note}</p>
        ${ratingControls(item.id)}
      </div>
    </article>`).join("");
}

function setRating(id, value) {
  if (ratings.get(id) === value) ratings.delete(id);
  else ratings.set(id, value);
  render();
  if (imageDialog.open && imageDialog.dataset.referenceId === id) {
    imageDialog.querySelector(".dialog-rating").innerHTML = ratingControls(id, true);
  }
}

function openImage(id) {
  const item = references.find((reference) => reference.id === id);
  if (!item) return;
  imageDialog.dataset.referenceId = id;
  const image = imageDialog.querySelector("img");
  image.src = item.image;
  image.alt = `${item.productName} 官方界面：${item.title}`;
  imageDialog.querySelector(".dialog-product").textContent = item.productName;
  imageDialog.querySelector("h2").textContent = item.title;
  imageDialog.querySelector("aside > p").textContent = item.note;
  imageDialog.querySelector(".dialog-principle").textContent = item.principle;
  const link = imageDialog.querySelector("a");
  link.href = item.source;
  imageDialog.querySelector(".dialog-rating").innerHTML = ratingControls(id, true);
  imageDialog.showModal();
}

function summaryText() {
  const groups = { keep: [], part: [], reject: [] };
  ratings.forEach((value, id) => {
    const item = references.find((reference) => reference.id === id);
    if (item) groups[value].push(`${item.productName} — ${item.title}`);
  });
  return ["VibeHub taste calibration", ...Object.entries(groups).map(([key, items]) => `\n${ratingLabels[key]}\n${items.length ? items.map((item) => `- ${item}`).join("\n") : "- 未选择"}`)].join("\n");
}

function openSummary() {
  const groups = { keep: [], part: [], reject: [] };
  ratings.forEach((value, id) => {
    const item = references.find((reference) => reference.id === id);
    if (item) groups[value].push(item);
  });
  document.querySelector("#summary-content").innerHTML = Object.entries(groups).map(([key, items]) => `
    <section class="summary-group summary-${key}"><header><i></i><strong>${ratingLabels[key]}</strong><span>${items.length}</span></header>
    ${items.length ? `<ul>${items.map((item) => `<li><span>${item.productName}</span>${item.title}</li>`).join("")}</ul>` : `<p>还没有选择。</p>`}</section>`).join("");
  summaryDialog.showModal();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove("is-visible"), 1500);
}

document.addEventListener("click", async (event) => {
  const dimension = event.target.closest("[data-dimension]")?.dataset.dimension;
  if (dimension) {
    filter.dimension = dimension;
    document.querySelectorAll("[data-dimension]").forEach((button) => button.classList.toggle("is-active", button.dataset.dimension === dimension));
    render();
    return;
  }
  const product = event.target.closest("[data-product]")?.dataset.product;
  if (product) {
    filter.product = product;
    document.querySelectorAll("[data-product]").forEach((button) => button.classList.toggle("is-active", button.dataset.product === product));
    render();
    return;
  }
  const rateButton = event.target.closest("[data-rate]");
  if (rateButton) {
    const container = rateButton.closest("[data-rating-for]");
    setRating(container.dataset.ratingFor, rateButton.dataset.rate);
    return;
  }
  const imageButton = event.target.closest("[data-action='open-image']");
  if (imageButton) {
    openImage(imageButton.closest("[data-reference-id]").dataset.referenceId);
    return;
  }
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "open-summary") openSummary();
  if (action === "clear-ratings") {
    ratings.clear();
    summaryDialog.close();
    render();
    showToast("Selections cleared");
  }
  if (action === "copy-summary") {
    try {
      await navigator.clipboard.writeText(summaryText());
      showToast("Taste brief copied");
    } catch {
      showToast("Copy unavailable — selections remain visible here");
    }
  }
});

document.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement) event.target.closest(".image-button, .dialog-image")?.classList.add("image-unavailable");
}, true);

render();
