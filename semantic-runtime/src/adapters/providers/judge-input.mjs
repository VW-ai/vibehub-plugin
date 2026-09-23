export const RELATIONAL_FAMILIES = new Set(['acceptance_relevance', 'context_relevance']);

export function minimizedJudgeState(event, stateRefs) {
  return {
    event: {
      type: event.type,
      timestamp: event.timestamp,
      text: event.payload.text,
    },
    candidates: stateRefs.map(item => ({ id: item.id, type: item.type, text: item.text })),
  };
}
