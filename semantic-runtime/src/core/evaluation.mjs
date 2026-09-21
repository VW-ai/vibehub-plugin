import { FAMILIES, canonical, requireValue } from './contracts.mjs';

const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;

export function evaluateLabels(decisions, labels, events) {
  if (labels === undefined) return null;
  requireValue(Array.isArray(labels), 'Labels must be an array');
  const eventIds = new Set(events.map(event => event.event_id));
  const seen = new Set();
  const counts = Object.fromEntries(FAMILIES.map(family => [family, {
    labeled: 0, resolved: 0, abstained: 0, true_positive: 0, false_positive: 0,
    false_negative: 0, true_negative: 0, target_true_positive: 0, target_false_positive: 0, target_false_negative: 0,
  }]));
  const actual = new Map(decisions.map(item => [canonical([item.event_id, item.family]), item]));
  for (const label of labels) {
    requireValue(eventIds.has(label.event_id) && FAMILIES.includes(label.family), 'Label references unknown event/family');
    requireValue(typeof label.relevant === 'boolean' && Array.isArray(label.target_ids)
      && label.target_ids.every(id => typeof id === 'string')
      && new Set(label.target_ids).size === label.target_ids.length, 'Invalid label');
    requireValue(label.relevant || label.target_ids.length === 0, 'Negative label cannot have targets');
    const key = canonical([label.event_id, label.family]);
    requireValue(!seen.has(key), 'Duplicate label');
    seen.add(key);
    const decision = actual.get(key);
    const count = counts[label.family];
    const resolved = decision && ['INGEST', 'IGNORE'].includes(decision.action);
    const positive = decision?.action === 'INGEST';
    count.labeled++;
    if (resolved) count.resolved++; else count.abstained++;
    if (positive && label.relevant) count.true_positive++;
    if (positive && !label.relevant) count.false_positive++;
    if (!positive && label.relevant) count.false_negative++;
    if (resolved && !positive && !label.relevant) count.true_negative++;
    const predicted = new Set(positive ? decision.result.value.target_ids : []);
    const expected = new Set(label.target_ids);
    for (const id of predicted) {
      if (expected.has(id)) count.target_true_positive++; else count.target_false_positive++;
    }
    for (const id of expected) if (!predicted.has(id)) count.target_false_negative++;
  }
  return Object.fromEntries(Object.entries(counts).map(([family, count]) => [family, {
    ...count,
    precision: ratio(count.true_positive, count.true_positive + count.false_positive),
    recall: ratio(count.true_positive, count.true_positive + count.false_negative),
    coverage: ratio(count.resolved, count.labeled),
    target_precision: ratio(count.target_true_positive, count.target_true_positive + count.target_false_positive),
    target_recall: ratio(count.target_true_positive, count.target_true_positive + count.target_false_negative),
  }]));
}

export function compareRuns(left, right) {
  requireValue(left.manifest.status === 'complete' && right.manifest.status === 'complete', 'Only completed runs can be compared');
  for (const key of ['tenant_id', 'project_id', 'dataset_hash', 'state_hash']) {
    requireValue(left.manifest[key] === right.manifest[key], `Cannot compare different ${key}`);
  }
  const key = item => canonical([item.event_id, item.family]);
  const a = new Map(left.decisions.map(item => [key(item), item]));
  const b = new Map(right.decisions.map(item => [key(item), item]));
  const changes = [];
  for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const before = a.get(id);
    const after = b.get(id);
    const meaning = value => value ? { action: value.action, value: value.result?.value ?? null, error_code: value.error_code } : null;
    if (canonical(meaning(before)) !== canonical(meaning(after))) {
      const [event_id, family] = JSON.parse(id);
      changes.push({ event_id, family, before: meaning(before), after: meaning(after) });
    }
  }
  return { left: left.manifest.run_id, right: right.manifest.run_id, changed: changes.length, changes };
}
