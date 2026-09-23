import { contextJudgeFixture, CONTEXT_JUDGE_ACTIONS, head } from './context-judge-fixture.mjs';
import { LocalQueryEngine } from '../../src/application/query/query-engine.mjs';
import { QueryInputs } from '../../src/application/query/query-inputs.mjs';

export const QUERY_ACTIONS = [...new Set([...CONTEXT_JUDGE_ACTIONS, 'query:read'])];
export async function queryFixture(t, options = {}) {
  const f = await contextJudgeFixture(t, options);
  Object.assign(f, f.issue({ actions: QUERY_ACTIONS }));
  f.inputs = () => new QueryInputs({ store: f.store, authority: f.authority, canonical_reader: f.config });
  f.makeQueryEngine = (judge_runtime = null) => new LocalQueryEngine({ store: f.store, authority: f.authority,
    canonical_reader: f.config, judge_runtime });
  f.engine = f.makeQueryEngine();
  f.querySelection = (binding = f.a, extra = {}) => {
    const at = head(f, binding), selected = f.explorations.getSelection(f.context, { exploration_id: binding.exploration_id, at });
    return { exploration_id: binding.exploration_id, at, mode: 'current', expected_shared_base: selected.shared.origin_base.pin,
      heads_cursor: null, ...extra };
  };
  f.queryRequest = (extra = {}) => {
    const own = f.querySelection(f.binding);
    const selected = f.explorations.getSelection(f.context, { exploration_id: own.exploration_id, at: own.at });
    return { schema_version: 1, request_id: 'synthetic-query', consumer: { consumer_id: 'synthetic-consumer', session_id: null, task: null },
      own, related: [], expected_project_selection_version: selected.shared.current_project.version,
      expected_source_fence: f.feed.head(f.context).sequence, exact: [], lineage: null,
      text: { value: '', match: 'all_terms' }, scope: { tickets: [], rooms: [], repositories: [] }, seen_refs: [],
      freshness: { minimum_watermarks: [], max_commit_lag: null, allow_unknown_coverage: true },
      budget: { max_results: 16, token_budget: 262144 }, judge: null, ...extra };
  };
  f.queryJudge = () => {
    const request = f.request();
    return Object.fromEntries(['node_id', 'event_id', 'epoch', 'execution', 'execution_workspace_id',
      'expected_binding_version', 'expected_catalog_version'].map(key => [key, request[key]]));
  };
  return f;
}
export { contextJudgeFixture, publish, head, register, capture, rows, adoption, contextRequest, canonicalRefs,
  gitCodeRef, SCOPE, judgeTransport, judgeResponse, judgeJSON } from './context-judge-fixture.mjs';
