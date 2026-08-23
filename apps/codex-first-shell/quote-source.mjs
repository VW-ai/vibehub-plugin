// Quote source identity is serialized into the Turn input itself, so durable
// Codex Thread history carries the exact Thread, Turn and item a quote came
// from, and any replay (including a fresh browser with no local state) can
// render that source again. No browser storage is involved; the line reads
// naturally in any other Codex client that shows the same Thread.
const SOURCE_LINE = /^> — Quoted from Codex thread ([^\s·]{1,128}) · turn ([^\s·]{1,128}) · item ([^\s·]{1,128})[ \t]*$/m;

export function quoteSourceLine(quote) {
  if (!quote?.threadId || !quote?.turnId || !quote?.itemId) return "";
  return `> — Quoted from Codex thread ${quote.threadId} · turn ${quote.turnId} · item ${quote.itemId}`;
}

export function composeQuotedMessage(quote, text) {
  const body = String(text ?? "").trim();
  if (!quote?.text) return body;
  const lines = String(quote.text).split("\n").map((line) => `> ${line}`);
  const sourceLine = quoteSourceLine(quote);
  if (sourceLine) lines.push(sourceLine);
  return `${lines.join("\n")}${body ? `\n\n${body}` : ""}`;
}

// The source line must close a leading quote block; a marker anywhere else is
// ordinary text.
export function parseQuotedMessage(text) {
  const source = String(text ?? "");
  const match = SOURCE_LINE.exec(source);
  if (!match) return { quoted: "", source: null, body: source };
  const quoted = source.slice(0, match.index).replace(/\n$/, "");
  if (quoted.split("\n").some((line) => line && !line.startsWith(">"))) return { quoted: "", source: null, body: source };
  return {
    quoted,
    source: { threadId: match[1], turnId: match[2], itemId: match[3] },
    body: source.slice(match.index + match[0].length).replace(/^\n+/, ""),
  };
}

// ---------------------------------------------------------------------------
// Exact source identity for the explicit VibeHub bridge (Create Task, Attach
// to Task, Remember). A selection is located in the item's own text as
// app-server replay carries it: `start` and `end` are offsets into that text
// and `text_sha256` hashes exactly `text.slice(start, end)`, so the recorded
// origin can be re-verified against Thread history and never depends on how
// the browser rendered the message.
// ---------------------------------------------------------------------------

export function codexThreadRef({ threadId, turnId, itemId = null }) {
  return `codex-thread:${threadId}/turn:${turnId}${itemId ? `/item:${itemId}` : ""}`;
}

export function sourceIdentityLabel({ threadId, turnId, itemId = null }) {
  return `Thread ${threadId} · Turn ${turnId}${itemId ? ` · Item ${itemId}` : ""}`;
}

// Markdown punctuation the carrier consumes while rendering. Dropping it from
// both texts lets a selection made over rendered HTML find its source span.
const MARKDOWN_PUNCTUATION = /[*_`#>~\\[\]()]/u;

function projection(text, { stripMarkdown }) {
  const chars = [];
  const map = [];
  let pendingSpaceAt = -1;
  let lineStart = true;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (/\s/u.test(char)) {
      if (chars.length && pendingSpaceAt < 0) pendingSpaceAt = index;
      if (char === "\n") lineStart = true;
      continue;
    }
    // A list marker at line start is rendered as structure, not text.
    const listMarker = stripMarkdown && lineStart && (char === "-" || char === "+") && /\s/u.test(text[index + 1] ?? "");
    lineStart = false;
    if (listMarker) continue;
    if (stripMarkdown && MARKDOWN_PUNCTUATION.test(char)) continue;
    if (pendingSpaceAt >= 0) {
      chars.push(" ");
      map.push(pendingSpaceAt);
      pendingSpaceAt = -1;
    }
    chars.push(char);
    map.push(index);
  }
  return { text: chars.join(""), map };
}

// Locate a selected passage inside the source text: verbatim first, then with
// whitespace runs collapsed, then with Markdown punctuation dropped. The result
// always names a span of the source text itself; null means the passage could
// not be placed exactly, and the caller must fall back to the whole item.
export function locateSelection(sourceText, selectedText) {
  const source = String(sourceText ?? "");
  const needle = String(selectedText ?? "").trim();
  if (!needle) return null;
  const exact = source.indexOf(needle);
  if (exact >= 0) return { start: exact, end: exact + needle.length, method: "exact" };
  for (const stripMarkdown of [false, true]) {
    const haystack = projection(source, { stripMarkdown });
    const target = projection(needle, { stripMarkdown }).text;
    if (!target) continue;
    const at = haystack.text.indexOf(target);
    if (at < 0) continue;
    let start = haystack.map[at];
    let end = haystack.map[at + target.length - 1] + 1;
    if (stripMarkdown) {
      // Take the emphasis or code markers hugging the span with it, so a
      // passage selected inside **bold** quotes as balanced Markdown.
      while (start > 0 && /[*_`~]/u.test(source[start - 1])) start -= 1;
      while (end < source.length && /[*_`~]/u.test(source[end])) end += 1;
    }
    return { start, end, method: stripMarkdown ? "markdown" : "whitespace" };
  }
  return null;
}

export async function sha256Hex(text, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("SHA-256 is unavailable: the Web Crypto API needs a secure context");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(String(text ?? "")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The origin a Create Task confirmation sends, shaped exactly as
// skills/contracts/ticket.schema.json declares it. `selection` is null when
// the whole finalized message is the source.
export function buildOrigin({ threadId, forkedFromId = null, turnId, itemId = null, selection = null, capturedAt = new Date().toISOString() }) {
  return {
    harness: "codex",
    thread_id: threadId,
    forked_from_id: forkedFromId ?? null,
    turn_id: turnId,
    item_id: itemId ?? null,
    selection: selection ? { start: selection.start, end: selection.end, text_sha256: selection.text_sha256 } : null,
    captured_at: capturedAt,
  };
}

export function describeSelection(selection) {
  if (!selection) return "whole message";
  return `characters ${selection.start}–${selection.end} · sha256 ${String(selection.text_sha256).slice(0, 12)}…`;
}
