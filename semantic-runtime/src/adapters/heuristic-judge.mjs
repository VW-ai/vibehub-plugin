// A transparent mechanical baseline. These rule scores are not calibrated
// semantic-model probabilities and cannot demonstrate the PRD's value gate.
export class HeuristicJudge {
  descriptor = { provider: 'local', model: 'lexical-rules-v0', kind: 'heuristic', calibrated: false };

  async evaluate({ event, stateRefs, question }) {
    const content = event.payload.text.toLowerCase();
    const tokens = new Set(content.match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
    const matches = stateRefs.filter(item => {
      const terms = new Set(item.text.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) ?? []);
      return [...terms].filter(term => tokens.has(term)).length >= 2;
    }).map(item => item.id);
    let relevant;
    let target_ids = [];
    switch (question.family) {
      case 'acceptance_relevance':
        target_ids = ['TOOL_RESULT', 'EVIDENCE_CREATED'].includes(event.type) ? matches : [];
        relevant = target_ids.length > 0;
        break;
      case 'durable_cross_ticket_value':
        relevant = event.type === 'HUMAN_DECISION' || /\b(decision|constraint|must always|must never)\b/.test(content);
        break;
      case 'context_relevance':
        target_ids = matches;
        relevant = matches.length > 0;
        break;
      case 'independently_schedulable_work':
        relevant = /\b(follow-up|separate task|independent task)\b/.test(content);
        break;
      default: throw new Error('Unsupported question');
    }
    return { value: { relevant, target_ids }, confidence: 0.85, latency_ms: 0,
      provider: 'local', model: this.descriptor.model, reason_code: relevant ? 'rule_match' : 'no_rule_match' };
  }
}
