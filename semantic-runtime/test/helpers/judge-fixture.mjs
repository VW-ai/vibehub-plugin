import { fixture, ACTIONS, SCOPE, bind, mutation, register, capture, assertion, pin } from './exploration-fixture.mjs';
import { JudgeInputs } from '../../src/local/judge-inputs.mjs';

export const JUDGE_ACTIONS = [...ACTIONS, 'judge:execute', 'judge:read', 'source:read', 'model:dispatch'];
export const question = (family = 'context_relevance') => ({ family, text: 'Is the selected event relevant to this exact candidate?' });

/** Real synthetic ingress/exploration fixture; provider settings are composed by runtime tests. */
export function judgeFixture(t, { canonical = false, target_kind = 'context', text = 'Synthetic selected candidate.' } = {}) {
  const f = fixture(t, { canonical });
  Object.assign(f, f.issue({ actions: JUDGE_ACTIONS }));
  f.binding = bind(f, { shared_base: canonical ? pin(f.canonical, []) : null });
  f.head = f.binding.graph_revision;
  f.supportSource = register(f, { partition: 'judge-target-support' });
  f.supportEvent = capture(f, f.supportSource, { text: 'Retained target provenance.', key: 'judge-support', objectId: 'judge-support-object' });
  f.targets = [];
  f.addTarget = ({ name = `target-${f.targets.length}`, kind = target_kind, text: selectedText = text,
    events = [f.supportEvent], parents = [], data = null, base_revision = null, entity_id = name } = {}) => {
    const a = assertion(f, events[0], name, { entity_id, base_revision, parents, events,
      content: { semantic_type: 'judge-target', data: data ?? { schema_version: 1, kind: 'judge_target', target_kind: kind, text: selectedText } } });
    const result = f.explorations.mutate(f.context, mutation(f, f.binding, name, { expected_graph: f.head,
      operation: { kind: 'assert', assertion: a } }));
    f.head = result.receipt.next_graph; f.targets.push(result.revision); return result.revision;
  };
  f.target = f.addTarget();
  f.configuration = { schema_version: 1, scope: SCOPE, settings_project_id: 'synthetic-judge-settings', artifact: null,
    egress_policy: { policy_id: 'synthetic-selected-fields', revision: 'v1', max_sensitivity: 'INTERNAL',
      allowed_providers: ['typesafe', 'vercel', 'openrouter'],
      sources: [f.source, f.supportSource].map(source => ({ registration_id: source.registration_id,
        local_only: false, allowed_providers: ['typesafe', 'vercel', 'openrouter'], text_policy: 'selected-fields' })) } };
  f.request = (extra = {}) => ({ invocation_id: 'synthetic-invocation', node_id: 'judge', epoch: f.epoch, execution: f.execution,
    exploration_id: f.binding.exploration_id, execution_workspace_id: f.binding.execution_workspace_id,
    expected_binding_version: f.binding.binding_version, expected_catalog_version: f.registry.get(f.context).version,
    expected_project_selection_version: null, at: f.head, event_id: f.event.event_id, target_refs: [f.target],
    expected_source_fence: f.feed.head(f.context).sequence, ...extra });
  f.inputs = (configuration = f.configuration) => new JudgeInputs({ store: f.store, authority: f.authority,
    canonical_reader: f.config, configuration });
  return f;
}
