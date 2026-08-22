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
