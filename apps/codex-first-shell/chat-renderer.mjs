import { parseQuotedMessage } from "./quote-source.mjs";

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

const INLINE_TOKEN_OPEN = "\uE000";
const INLINE_TOKEN_CLOSE = "\uE001";
const MAX_BLOCK_DEPTH = 8;
const FENCE_OPEN = /^ {0,3}(?:(`{3,})[ \t]*([^`]*)|(~{3,})[ \t]*(.*))$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/;

// Inline rules never cross a delimiter of their own kind, so each attempt is
// bounded by the distance to the next delimiter and malformed input stays linear.
function emphasis(text) {
  return text
    .replace(/\*\*(?=\S)((?:[^*\n]|\*(?!\*))*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/__(?=\S)((?:[^_\n]|_(?!_))*?\S)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)((?:[^~\n]|~(?!~))*?\S)~~/g, "<del>$1</del>");
}

function restoreTokens(text, tokens) {
  let output = text;
  for (let pass = 0; pass < 4 && output.includes(INLINE_TOKEN_OPEN); pass += 1) {
    output = output.replace(/\uE000(\d+)\uE001/g, (_, index) => tokens[Number(index)] ?? "");
  }
  return output.replace(/[\uE000\uE001]/g, "");
}

// Escape first; then code spans and links become opaque tokens so emphasis
// rules can neither rewrite code nor mangle an href.
function inlineMarkdown(value) {
  const tokens = [];
  const hold = (html) => { tokens.push(html); return `${INLINE_TOKEN_OPEN}${tokens.length - 1}${INLINE_TOKEN_CLOSE}`; };
  const escaped = escapeHtml(String(value ?? "").replace(/[\uE000\uE001]/g, ""));
  const withCode = escaped.replace(/(`+)(?!`)([^`][^\n]*?[^`]|[^`])\1(?!`)/g, (_, _fence, code) => hold(`<code>${code}</code>`));
  const withLinks = withCode.replace(/\[([^\]\n]{1,400})\]\((https?:\/\/[^\s)<>]{1,2000})\)/g, (_, label, href) => hold(`<a href="${href}" target="_blank" rel="noreferrer noopener">${restoreTokens(emphasis(label), tokens)}</a>`));
  return restoreTokens(emphasis(withLinks), tokens);
}

function leadingSpaces(line) {
  return line.match(/^ */)[0].length;
}

function startsBlock(line) {
  return FENCE_OPEN.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function codeBlockMarkup(body, language, budget, context) {
  const code = takeText(budget, body, DOM_LIMITS.codeCharacters);
  const label = language ? `<span>${escapeHtml(language.slice(0, 48))}</span>` : "";
  const identity = context.codeIndex++;
  return `<div class="code-block">${label}<button type="button" data-copy-code="${identity}" aria-label="Copy code block ${identity + 1}">Copy</button><pre tabindex="0" aria-label="Code block"><code>${escapeHtml(code.text)}</code></pre>${omissionMarkup(code.omitted)}</div>`;
}

// A fence only opens at line start; it closes at a line-start fence of the same
// character and at least the same length. An unclosed fence (common mid-stream)
// stays code until the end of the bounded text.
function parseFence(lines, start, open, budget, context) {
  const marker = open[1] ?? open[3];
  const info = (open[1] ? open[2] : open[4]) ?? "";
  const body = [];
  let index = start + 1;
  while (index < lines.length) {
    const close = FENCE_CLOSE.exec(lines[index]);
    if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { index += 1; break; }
    body.push(lines[index]);
    index += 1;
  }
  return { html: codeBlockMarkup(body.join("\n"), info.trim().split(/\s+/)[0] ?? "", budget, context), next: index };
}

function parseQuote(lines, start, budget, depth, context) {
  const inner = [];
  let index = start;
  while (index < lines.length) {
    const match = QUOTE.exec(lines[index]);
    if (!match) break;
    inner.push(match[1]);
    index += 1;
  }
  return { html: `<blockquote>${renderBlocks(inner, budget, depth + 1, context)}</blockquote>`, next: index };
}

function listKind(match) {
  const ordered = /\d/.test(match[2][0]);
  return { ordered, kind: ordered ? match[2].at(-1) : match[2] };
}

// Items of one list share a marker kind; lines indented to the item's content
// column belong to the item and are parsed recursively, so nested lists,
// quotes and fences inside items render as structure instead of literal text.
function parseList(lines, start, first, budget, depth, context) {
  const { ordered, kind } = listKind(first);
  const items = [];
  let index = start;
  while (index < lines.length) {
    let probe = index;
    while (probe < lines.length && !lines[probe].trim()) probe += 1;
    const match = probe < lines.length ? LIST_ITEM.exec(lines[probe]) : null;
    if (!match || RULE.test(lines[probe])) break;
    const candidate = listKind(match);
    if (candidate.ordered !== ordered || candidate.kind !== kind) break;
    index = probe + 1;
    const contentIndent = match[1].length + match[2].length + Math.max(1, Math.min(4, match[3].length));
    const body = [match[4]];
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        let next = index;
        while (next < lines.length && !lines[next].trim()) next += 1;
        if (next < lines.length && leadingSpaces(lines[next]) >= contentIndent) { body.push(""); index = next; continue; }
        break;
      }
      if (leadingSpaces(line) >= contentIndent) { body.push(line.slice(contentIndent)); index += 1; continue; }
      break;
    }
    items.push(`<li>${renderBlocks(body, budget, depth + 1, context).replace(/^<p>([\s\S]*?)<\/p>/, "$1")}</li>`);
  }
  const startNumber = ordered ? Number.parseInt(first[2], 10) : 1;
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}${ordered && startNumber !== 1 ? ` start="${startNumber}"` : ""}>${items.join("")}</${tag}>`, next: index };
}

function renderBlocks(lines, budget, depth, context) {
  if (depth > MAX_BLOCK_DEPTH) return lines.filter((line) => line.trim()).map((line) => `<p>${inlineMarkdown(line.trim())}</p>`).join("");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = FENCE_OPEN.exec(line);
    if (fence) { const result = parseFence(lines, index, fence, budget, context); blocks.push(result.html); index = result.next; continue; }
    const heading = HEADING.exec(line);
    if (heading) { const level = Math.min(4, heading[1].length + 1); blocks.push(`<h${level}>${inlineMarkdown(heading[2] ?? "")}</h${level}>`); index += 1; continue; }
    if (RULE.test(line)) { blocks.push("<hr>"); index += 1; continue; }
    if (QUOTE.test(line)) { const result = parseQuote(lines, index, budget, depth, context); blocks.push(result.html); index = result.next; continue; }
    const item = LIST_ITEM.exec(line);
    if (item) { const result = parseList(lines, index, item, budget, depth, context); blocks.push(result.html); index = result.next; continue; }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && (!paragraph.length || !startsBlock(lines[index]))) { paragraph.push(lines[index].trim()); index += 1; }
    blocks.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
  }
  return blocks.join("");
}

export function renderMarkdown(value, budget = createRenderBudget(), maximum = DOM_LIMITS.itemTextCharacters) {
  const bounded = takeText(budget, value, maximum);
  const lines = bounded.text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length)));
  return `${renderBlocks(lines, budget, 0, { codeIndex: 0 })}${omissionMarkup(bounded.omitted)}`;
}

export function renderQuoteSource(source, currentThreadId = null) {
  if (!source) return "";
  const identity = `Thread ${source.threadId} · Turn ${source.turnId} · Item ${source.itemId}`;
  const where = source.threadId === currentThreadId ? "this Thread" : "another Thread";
  return `<small class="quote-source" data-quote-thread="${escapeHtml(source.threadId)}" data-quote-turn="${escapeHtml(source.turnId)}" data-quote-item="${escapeHtml(source.itemId)}" title="${escapeHtml(identity)}" aria-label="Quoted from ${escapeHtml(identity)}">Quoted from a Codex Turn in ${where}</small>`;
}

// Human messages replayed from Thread history render their serialized quote
// source as an identity chip between the quoted block and the message body.
export function renderUserMessageText(text, budget = createRenderBudget(), { currentThreadId = null } = {}) {
  const { quoted, source, body } = parseQuotedMessage(text);
  if (!source) return renderMarkdown(text, budget);
  return `${renderMarkdown(quoted, budget)}${renderQuoteSource(source, currentThreadId)}${renderMarkdown(body, budget)}`;
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
