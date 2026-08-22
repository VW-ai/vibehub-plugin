export const MAX_DRAFT_THREADS = 5;

function cloneDraft(draft) {
  const source = draft ?? {};
  return {
    text: String(source.text ?? "").slice(0, 32_000),
    quote: source.quote ? structuredClone(source.quote) : null,
    attachments: (source.attachments ?? []).slice(0, 3).map((item) => ({ ...item })),
  };
}

export function saveThreadDraft(store, threadId, draft, maximum = MAX_DRAFT_THREADS) {
  if (!threadId) return;
  const bounded = cloneDraft(draft);
  store.delete(threadId);
  if (bounded.text || bounded.quote || bounded.attachments.length) store.set(threadId, bounded);
  while (store.size > maximum) store.delete(store.keys().next().value);
}

export function loadThreadDraft(store, threadId) {
  return cloneDraft(threadId ? store.get(threadId) : null);
}
