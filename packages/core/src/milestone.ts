/**
 * Milestone classification for user-typed prompts — the MECHANICAL tier of
 * decision-workbench-001 (实质性注入才升里程碑档,"继续/好的"类不升,防止长
 * session 的里程碑档被灌水). The thin-LLM refinement is checkpoint-gated and,
 * per decision-project-013, could never live in the CLI anyway — so this pure
 * function is the always-on fallback, and "ambiguous" is the only bucket an
 * LLM will ever re-judge (asynchronously, outside the hook path).
 *
 * Buckets:
 * - "routine":   pure acknowledgements — never milestone-tier;
 * - "milestone": clearly substantive — new direction, structure, payload;
 * - "ambiguous": short but not a known ack. The honest middle: UI treats it
 *   as milestone until an LLM downgrades it (decision-project-023 leans
 *   toward SHOWING the user's actions, not hiding them).
 */
export type PromptClassification = "milestone" | "routine" | "ambiguous";

/**
 * Pure acknowledgements, matched after stripping ALL whitespace and
 * punctuation and lowercasing — so "好的,继续!" and "ok go ahead" both hit.
 * Deliberately finite: anything not listed falls to length rules.
 */
const ACKS = new Set([
  // English
  "ok", "okay", "k", "y", "yes", "yep", "yeah", "sure", "fine", "good",
  "go", "goon", "goahead", "continue", "proceed", "doit", "done", "thanks",
  "thankyou", "soundsgood", "looksgood", "lgtm", "correct", "right", "cool",
  "okcontinue", "okgo", "yesplease", "please",
  // Chinese
  "嗯", "好", "行", "对", "好的", "好啊", "好吧", "可以", "继续", "继续吧",
  "对的", "是的", "没问题", "可以的", "行吧", "去吧", "做吧", "好的继续",
  "嗯嗯", "谢谢", "辛苦了",
]);

/**
 * A prompt at or past this weighted length is substantive on its face — a
 * genuine mid-flight instruction rarely fits under one short sentence, and
 * a false "milestone" costs one extra timeline row while a false "routine"
 * hides a user action (023 forbids leaning that way). CJK characters count
 * double: one hanzi carries roughly the information of two latin letters,
 * so a 30-hanzi instruction is as substantive as a 60-letter one. Tunable,
 * awaits benchmark against real session transcripts.
 */
const SUBSTANTIVE_MIN_WEIGHT = 60;

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/u;

function weightedLength(text: string): number {
  let w = 0;
  for (const ch of text) w += CJK.test(ch) ? 2 : 1;
  return w;
}

export function classifyUserPrompt(raw: string): PromptClassification {
  const text = raw.trim();
  if (!text) return "routine";
  // strip whitespace + common CJK/latin punctuation for ack matching
  const norm = text.toLowerCase().replace(/[\s,,、;;.。!!??~~…'"“”()()\-]+/gu, "");
  if (!norm || ACKS.has(norm)) return "routine";
  // structure = payload: multi-line, code, or an explicit path/URL
  if (/\n/.test(text) || text.includes("```") || /\bhttps?:\/\//.test(text) || /\S+\/\S+\.\w+/.test(text)) {
    return "milestone";
  }
  if (weightedLength(text) >= SUBSTANTIVE_MIN_WEIGHT) return "milestone";
  return "ambiguous";
}
