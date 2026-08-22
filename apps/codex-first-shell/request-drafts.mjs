// requestUserInput answers are drafted in page memory keyed by the exact
// pending request id, so an intentional route change (Tasks, a Task Workspace,
// Rooms) and keyed streaming patches can both rebuild the card and put the
// typed values back. Nothing is written to browser storage; drafts are pruned
// as soon as the host no longer reports the request as pending.
export const MAX_REQUEST_DRAFTS = 16;

function normalizedEntry(entry) {
  return {
    choice: entry?.choice == null ? null : String(entry.choice).slice(0, 2_000),
    other: String(entry?.other ?? "").slice(0, 8_000),
    direct: String(entry?.direct ?? "").slice(0, 8_000),
  };
}

export function draftIsEmpty(draft) {
  return !Object.values(draft ?? {}).some((entry) => entry?.choice || entry?.other || entry?.direct);
}

export function requestDraftFromForm(form) {
  const draft = {};
  for (const fieldset of form.querySelectorAll("fieldset[data-question-id]")) {
    draft[fieldset.dataset.questionId] = normalizedEntry({
      choice: fieldset.querySelector('input[type="radio"]:checked')?.value ?? null,
      other: fieldset.querySelector("[data-request-other]")?.value ?? "",
      direct: fieldset.querySelector("[data-request-answer]")?.value ?? "",
    });
  }
  return draft;
}

export function applyRequestDraft(form, draft) {
  for (const fieldset of form.querySelectorAll("fieldset[data-question-id]")) {
    const entry = draft?.[fieldset.dataset.questionId];
    if (!entry) continue;
    for (const radio of fieldset.querySelectorAll('input[type="radio"]')) radio.checked = radio.value === entry.choice;
    const other = fieldset.querySelector("[data-request-other]");
    if (other) other.value = entry.other ?? "";
    const direct = fieldset.querySelector("[data-request-answer]");
    if (direct) direct.value = entry.direct ?? "";
  }
}

// Exact answer ids: every key is the question id the request declared and
// each value list carries the chosen option label, the typed Other value or
// the free-form answer, never the "__other__" sentinel.
export function answersFromDraft(draft) {
  const answers = {};
  let invalid = false;
  for (const [questionId, raw] of Object.entries(draft ?? {})) {
    const entry = normalizedEntry(raw);
    const values = [];
    if (entry.choice && entry.choice !== "__other__") values.push(entry.choice);
    const other = entry.choice === "__other__" ? entry.other.trim() : "";
    if (other) values.push(other);
    const direct = entry.direct.trim();
    if (direct) values.push(direct);
    if (!values.length) invalid = true;
    answers[questionId] = { answers: values };
  }
  return { answers, invalid: invalid || !Object.keys(answers).length };
}

export function saveRequestDraft(store, requestId, draft, maximum = MAX_REQUEST_DRAFTS) {
  const id = String(requestId ?? "");
  if (!id) return;
  store.delete(id);
  if (draftIsEmpty(draft)) return;
  store.set(id, Object.fromEntries(Object.entries(draft).map(([questionId, entry]) => [questionId, normalizedEntry(entry)])));
  while (store.size > maximum) store.delete(store.keys().next().value);
}

export function loadRequestDraft(store, requestId) {
  return store.get(String(requestId ?? "")) ?? null;
}

export function pruneRequestDrafts(store, liveRequestIds) {
  for (const id of [...store.keys()]) if (!liveRequestIds.has(id)) store.delete(id);
}
