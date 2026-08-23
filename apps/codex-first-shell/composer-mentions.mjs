// File and skill mentions in the Composer. `@` opens a picker fed by the
// host's searchFiles (fuzzyFileSearch rooted at the bound repository), `$`
// one fed by listSkills (skills/list). A pick inserts a placeholder into the
// text (`@file_name`, `$skill`) and keeps a chip; at send each chip is one
// text_elements entry whose byteRange is the UTF-8 byte span of its
// placeholder (measured with TextEncoder) and one mention or skill input
// with name and path. Replay parses the same text_elements back into chips.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const MENTION_TRIGGERS = Object.freeze({ "@": "mention", "$": "skill" });
export const MENTION_QUERY_LIMIT = 80;
// Characters that may continue a placeholder; the character after a
// placeholder must not be one, so `@a.md` never matches inside `@a.mdx`.
const TOKEN_CHARACTER = /[\p{L}\p{N}_./\\:-]/u;

export function byteLength(text) {
  return encoder.encode(String(text ?? "")).length;
}

export function placeholderFor(kind, name) {
  return `${kind === "skill" ? "$" : "@"}${name}`;
}

// The trigger token the caret sits in: a `@` or `$` at the start of the
// text or after whitespace, followed by the query typed so far without any
// whitespace. Null when the caret is not inside such a token.
export function activeTrigger(text, caret) {
  const source = String(text ?? "");
  const position = Math.max(0, Math.min(Number(caret) || 0, source.length));
  let start = position;
  while (start > 0 && !/\s/u.test(source[start - 1])) start -= 1;
  const token = source.slice(start, position);
  const kind = MENTION_TRIGGERS[token[0]];
  if (!kind || (start > 0 && !/\s/u.test(source[start - 1]))) return null;
  const query = token.slice(1);
  if (query.length > MENTION_QUERY_LIMIT) return null;
  return { kind, start, end: position, query };
}

// The text with the trigger token replaced by the placeholder and one space,
// and the caret placed after it.
export function insertPlaceholder(text, trigger, placeholder) {
  const source = String(text ?? "");
  const rest = source.slice(trigger.end);
  const spaced = rest.startsWith(" ") ? rest : ` ${rest}`;
  return { text: `${source.slice(0, trigger.start)}${placeholder}${spaced}`, caret: trigger.start + placeholder.length + 1 };
}

// The text with one whole occurrence of a placeholder removed (the
// `ordinal`-th, counting from 0, so the chip's own occurrence goes when the
// same placeholder appears more than once), with the space that followed it.
export function removePlaceholder(text, placeholder, ordinal = 0) {
  const source = String(text ?? "");
  let at = -1;
  let from = 0;
  for (let count = 0; count <= ordinal; count += 1) {
    at = findPlaceholder(source, placeholder, from);
    if (at < 0) return source;
    from = at + placeholder.length;
  }
  const end = at + placeholder.length;
  return `${source.slice(0, at)}${source[end] === " " ? source.slice(end + 1) : source.slice(end)}`;
}

function findPlaceholder(text, placeholder, from) {
  let at = text.indexOf(placeholder, from);
  while (at >= 0) {
    const before = at === 0 ? "" : text[at - 1];
    const after = text[at + placeholder.length] ?? "";
    if ((before === "" || /\s/u.test(before)) && (after === "" || !TOKEN_CHARACTER.test(after))) return at;
    at = text.indexOf(placeholder, at + 1);
  }
  return -1;
}

// What a Turn carries for the chips still present in the text: text_elements
// with UTF-8 byte spans (in text order) and one mention or skill item per
// chip. A chip whose placeholder the text no longer holds is dropped. Items
// keep the chips' own order; the host accepts ranges in any order.
export function composeTextElements(text, chips) {
  const source = String(text ?? "");
  const located = [];
  let cursor = 0;
  for (const chip of chips ?? []) {
    const placeholder = chip.placeholder ?? placeholderFor(chip.kind, chip.name);
    const at = findPlaceholder(source, placeholder, cursor);
    if (at < 0) continue;
    located.push({ chip, placeholder, at });
    cursor = at + placeholder.length;
  }
  const elements = located.map(({ placeholder, at }) => {
    const start = byteLength(source.slice(0, at));
    return { byteRange: { start, end: start + byteLength(placeholder) }, placeholder };
  });
  const items = located.map(({ chip }) => ({ type: chip.kind === "skill" ? "skill" : "mention", name: chip.name, path: chip.path }));
  return { elements, items };
}

// Replay: the text split into plain segments and the placeholders its
// text_elements name, each placeholder located by its UTF-8 byte span. An
// element that does not describe a valid span of the text is ignored, so a
// malformed range never hides text.
export function parseTextElements(text, elements) {
  const source = String(text ?? "");
  const bytes = encoder.encode(source);
  const ranges = (Array.isArray(elements) ? elements : [])
    .map((element) => element?.byteRange)
    .filter((range) => range && Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end > range.start && range.end <= bytes.length)
    .sort((left, right) => left.start - right.start);
  const segments = [];
  let byteCursor = 0;
  for (const range of ranges) {
    if (range.start < byteCursor) continue;
    const placeholder = decoder.decode(bytes.subarray(range.start, range.end));
    if (byteLength(placeholder) !== range.end - range.start) continue;
    const before = decoder.decode(bytes.subarray(byteCursor, range.start));
    if (byteLength(before) !== range.start - byteCursor) continue;
    if (before) segments.push({ text: before });
    segments.push({ placeholder, kind: placeholder.startsWith("$") ? "skill" : "mention" });
    byteCursor = range.end;
  }
  const tail = decoder.decode(bytes.subarray(byteCursor));
  if (tail) segments.push({ text: tail });
  return segments;
}

// The chips a persisted user message carried, from its mention and skill
// items, so a queued follow-up can be edited and re-sent with fresh ranges.
export function chipsFromItems(input) {
  return (input ?? []).filter((item) => item.type === "mention" || item.type === "skill").map((item) => ({ kind: item.type, name: item.name, path: item.path, placeholder: placeholderFor(item.type, item.name) }));
}
