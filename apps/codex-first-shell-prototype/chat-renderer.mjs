export const DOM_LIMITS = Object.freeze({
  timelineTextCharacters: 180_000,
  timelineMediaCharacters: 6_000_000,
  itemTextCharacters: 32_000,
  codeCharacters: 24_000,
  outputCharacters: 20_000,
  citationCount: 32,
  changeCount: 32,
  mediaCount: 16,
  mediaUrlCharacters: 1_500_000,
});

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function createRenderBudget(overrides = {}) {
  return {
    textRemaining: overrides.textCharacters ?? DOM_LIMITS.timelineTextCharacters,
    mediaRemaining: overrides.mediaCharacters ?? DOM_LIMITS.timelineMediaCharacters,
    citationsRemaining: overrides.citationCount ?? DOM_LIMITS.citationCount,
    changesRemaining: overrides.changeCount ?? DOM_LIMITS.changeCount,
    mediaCountRemaining: overrides.mediaCount ?? DOM_LIMITS.mediaCount,
  };
}

export function takeText(budget, value, localMaximum = DOM_LIMITS.itemTextCharacters) {
  const source = String(value ?? "");
  const allowed = Math.max(0, Math.min(localMaximum, budget?.textRemaining ?? localMaximum));
  const text = source.slice(0, allowed);
  if (budget) budget.textRemaining = Math.max(0, budget.textRemaining - text.length);
  return { text, omitted: Math.max(0, source.length - text.length), truncated: source.length > text.length };
}

function omissionMarkup(omitted, noun = "characters") {
  return omitted ? `<p class="truncation-note" role="note">${omitted.toLocaleString()} ${noun} omitted from this mounted view. Durable Thread history remains authoritative.</p>` : "";
}

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

export function renderMarkdown(value, budget = createRenderBudget(), maximum = DOM_LIMITS.itemTextCharacters) {
  const bounded = takeText(budget, value, maximum);
  const chunks = bounded.text.split(/```/);
  let codeIndex = 0;
  const markup = chunks.map((chunk, index) => {
    if (index % 2) {
      const [language, ...lines] = chunk.replace(/^\n/, "").split("\n");
      const body = lines.length ? lines.join("\n") : language;
      const code = takeText(budget, body, DOM_LIMITS.codeCharacters);
      const label = lines.length && language.trim() ? `<span>${escapeHtml(language.trim().slice(0, 48))}</span>` : "";
      const identity = codeIndex++;
      return `<div class="code-block">${label}<button type="button" data-copy-code="${identity}" aria-label="Copy code block ${identity + 1}">Copy</button><pre tabindex="0" aria-label="Code block"><code>${escapeHtml(code.text)}</code></pre>${omissionMarkup(code.omitted)}</div>`;
    }
    const blocks = [];
    let list = [];
    let listType = "ul";
    const flushList = () => {
      if (!list.length) return;
      blocks.push(`<${listType}>${list.map((line) => `<li>${inlineMarkdown(line)}</li>`).join("")}</${listType}>`);
      list = [];
      listType = "ul";
    };
    for (const line of chunk.split("\n")) {
      if (/^[-*] /.test(line)) { if (list.length && listType !== "ul") flushList(); listType = "ul"; list.push(line.slice(2)); continue; }
      const ordered = line.match(/^\d+\.\s+(.+)/);
      if (ordered) { if (list.length && listType !== "ol") flushList(); listType = "ol"; list.push(ordered[1]); continue; }
      flushList();
      if (!line.trim()) continue;
      const heading = line.match(/^(#{1,3})\s+(.+)/);
      if (heading) blocks.push(`<h${Math.min(4, heading[1].length + 1)}>${inlineMarkdown(heading[2])}</h${Math.min(4, heading[1].length + 1)}>`);
      else if (/^>\s?/.test(line)) blocks.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
      else if (/^---+$/.test(line.trim())) blocks.push("<hr>");
      else blocks.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    flushList();
    return blocks.join("");
  }).join("");
  return `${markup}${omissionMarkup(bounded.omitted)}`;
}

function imageSource(entry) {
  return entry?.url ?? entry?.imageUrl ?? entry?.image_url ?? entry?.result?.url ?? entry?.result?.imageUrl ?? entry?.result?.image_url;
}

function safeImageMarkup(source, label, budget) {
  const url = String(source ?? "");
  const allowedDataUrl = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(url);
  const allowedLocalAsset = /^\/(?:api\/asset|assets)\//.test(url);
  const withinItem = url.length > 0 && url.length <= DOM_LIMITS.mediaUrlCharacters;
  const withinAggregate = url.length <= (budget?.mediaRemaining ?? DOM_LIMITS.timelineMediaCharacters) && (budget?.mediaCountRemaining ?? 1) > 0;
  if (!allowedDataUrl && !allowedLocalAsset) return `<span class="message-attachment unsupported-media" role="note">▧ ${escapeHtml(label)} · image source is not mounted by this local carrier</span>`;
  if (!withinItem || !withinAggregate) return `<span class="message-attachment unsupported-media" role="note">▧ ${escapeHtml(label)} · image exceeds mounted-view budget</span>`;
  if (budget) {
    budget.mediaRemaining -= url.length;
    budget.mediaCountRemaining -= 1;
  }
  return `<img class="message-image" src="${escapeHtml(url)}" alt="${escapeHtml(label)}">`;
}

export function renderUserMedia(content, budget = createRenderBudget()) {
  const supported = (content ?? []).filter((entry) => ["image", "localImage", "audio", "localAudio", "skill", "mention"].includes(entry.type));
  const mounted = supported.slice(0, Math.max(0, budget.mediaCountRemaining));
  const markup = mounted.map((entry) => {
    if (entry.type === "image") return safeImageMarkup(entry.url, entry.name ?? "Attached image", budget);
    budget.mediaCountRemaining = Math.max(0, budget.mediaCountRemaining - 1);
    if (entry.type === "audio") return '<span class="message-attachment">◉ Audio attachment</span>';
    if (entry.type === "localImage") return `<span class="message-attachment">▧ ${escapeHtml(entry.path?.split("/").pop() ?? "Local image")}</span>`;
    if (entry.type === "localAudio") return `<span class="message-attachment">◉ ${escapeHtml(entry.path?.split("/").pop() ?? "Local audio")}</span>`;
    const name = entry.name ?? "Unnamed reference";
    return `<span class="message-attachment">${entry.type === "skill" ? "$" : "@"}${escapeHtml(name)}</span>`;
  }).join("");
  const omitted = supported.length - mounted.length;
  return `${markup}${omitted > 0 ? omissionMarkup(omitted, "media entries") : ""}`;
}

export function renderMemoryCitations(citation, budget = createRenderBudget()) {
  const entries = citation?.entries ?? [];
  if (!entries.length) return "";
  const count = Math.max(0, Math.min(entries.length, budget.citationsRemaining));
  budget.citationsRemaining -= count;
  const sourceThreads = (citation?.threadIds ?? []).filter(Boolean).slice(0, 16);
  const sourceIdentity = sourceThreads.length
    ? `<div class="citation-threads"><small>Source Thread identity</small>${sourceThreads.map((id) => {
      const full = takeText(budget, id, 256).text;
      return `<span><code tabindex="0" aria-label="Full source Thread id ${escapeHtml(full)}">${escapeHtml(full)}</code><button type="button" data-copy-citation-thread="${escapeHtml(full)}" aria-label="Copy full source Thread id">Copy</button></span>`;
    }).join("")}</div>`
    : "";
  const markup = entries.slice(0, count).map((entry) => {
    const path = takeText(budget, entry.path, 1_024).text;
    const note = takeText(budget, entry.note, 2_000);
    const lines = entry.lineStart ? `:${entry.lineStart}${entry.lineEnd && entry.lineEnd !== entry.lineStart ? `-${entry.lineEnd}` : ""}` : "";
    return `<span><code>${escapeHtml(path)}${escapeHtml(lines)}</code>${note.text ? `<em>${escapeHtml(note.text)}</em>` : ""}${omissionMarkup(note.omitted)}</span>`;
  }).join("");
  return `<aside class="source-citations" aria-label="Memory citations"><strong>Sources</strong>${markup}${entries.length > count ? omissionMarkup(entries.length - count, "citation entries") : ""}${sourceIdentity}</aside>`;
}

export function renderGeneratedImage(item, budget = createRenderBudget()) {
  const source = imageSource(item);
  const image = source
    ? safeImageMarkup(source, "Generated image", budget)
    : '<span class="message-attachment unsupported-media" role="note">▧ Generated image result is not mounted by this local carrier</span>';
  return `<div class="generated-image-result">${image}</div>`;
}

export function renderToolContent(content, budget = createRenderBudget()) {
  const entries = Array.isArray(content) ? content.slice(0, 32) : [];
  const output = entries.map((entry) => {
    if (["text", "inputText"].includes(entry.type)) return `<div class="tool-result">${renderMarkdown(entry.text, budget, DOM_LIMITS.outputCharacters)}</div>`;
    if (["image", "inputImage"].includes(entry.type)) return safeImageMarkup(entry.data ? `data:${entry.mimeType ?? "image/png"};base64,${entry.data}` : imageSource(entry), "Tool image result", budget);
    if (entry.type === "inputAudio") {
      budget.mediaCountRemaining = Math.max(0, budget.mediaCountRemaining - 1);
      return `<span class="message-attachment unsupported-media" role="note">◉ Tool audio result remains available in Thread history${entry.audioUrl ? "; this carrier does not mount the source" : ""}</span>`;
    }
    return `<span class="message-attachment unsupported-media" role="note">◇ ${escapeHtml(entry.type ?? "Unknown")} tool result remains inspectable in Thread history</span>`;
  }).join("");
  return `${output}${Array.isArray(content) && content.length > entries.length ? omissionMarkup(content.length - entries.length, "tool result entries") : ""}`;
}

export function renderAgentMessage(item, budget = createRenderBudget()) {
  const key = item._key ?? item.id;
  return `<div class="turn assistant" data-item-id="${escapeHtml(key)}" data-render-key="${escapeHtml(key)}"><span class="agent-mark">C</span><article class="agent-response${item._live ? " streaming" : ""}">${renderMarkdown(item.text, budget)}${omissionMarkup(item._omittedCharacters)}${renderMemoryCitations(item.memoryCitation, budget)}<footer class="message-actions"><button type="button" data-copy-message="${escapeHtml(key)}">Copy</button><button type="button" data-quote-message="${escapeHtml(key)}">Quote</button><button type="button" disabled title="Planned VibeHub bridge">Remember</button><button type="button" disabled title="Planned VibeHub bridge">Make Task</button></footer></article></div>`;
}
