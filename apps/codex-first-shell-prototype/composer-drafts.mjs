export const MAX_DRAFT_THREADS = 5;

function cloneDraft(draft = {}) {
  return {
    text: String(draft.text ?? "").slice(0, 32_000),
    quote: draft.quote ? structuredClone(draft.quote) : null,
    attachments: (draft.attachments ?? []).slice(0, 3).map((item) => ({ ...item })),
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
