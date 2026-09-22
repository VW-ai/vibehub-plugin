import { join } from 'node:path';
import { fixture as explorationFixture, ACTIONS, bind, mutation, executionFor, git } from './exploration-fixture.mjs';

export const ADOPTION_ACTIONS = [...ACTIONS, 'exploration:adopt', 'source:read'];
export function fixture(t, options = {}) {
  const f = explorationFixture(t, options);
  f.context = f.issue({ actions: ADOPTION_ACTIONS }).context;
  const reopen = f.reopen;
  f.reopen = opts => { const h = reopen(opts); h.context = h.issue({ actions: ADOPTION_ACTIONS }).context; return h; };
  f.otherFolder = join(f.root, 'branch-b');
  git(f.folder, 'worktree', 'add', '-b', 'branch-b', f.otherFolder); f.refresh();
  f.executionB = executionFor(f, f.otherFolder);
  f.a = bind(f, { key: 'adoption-a' });
  f.b = bind(f, { key: 'adoption-b', execution: f.executionB });
  f.original = f.explorations.mutate(f.context, mutation(f, f.a, 'adoption-source'));
  return f;
}
export function adoption(f, { key = 'adopt-one', source = f.original, a = f.a, b = f.b, endpoint_map = [], ...extra } = {}) {
  const sourceOrigin = f.store.getSource(f.context, 'exploration-projection', a.exploration_id).value;
  const destinationOrigin = f.store.getSource(f.context, 'exploration-projection', b.exploration_id).value;
  const sourceHead = f.graph.getHead(f.context, { generation_id: a.generation_id }).graph_revision;
  const destinationHead = f.graph.getHead(f.context, { generation_id: b.generation_id }).graph_revision;
  const selection = f.explorations.getSelection(f.context, { exploration_id: b.exploration_id, at: destinationHead });
  return { epoch: f.epoch, idempotency_key: key, publisher_ref: f.publisher.publisher_ref,
    expected_source_fence: f.feed.head(f.context).sequence,
    source: { exploration_id: a.exploration_id, at: source.receipt.next_graph, address: source.revision,
      expected_head: sourceHead, shared_base: sourceOrigin.origin.shared_base },
    destination: { exploration_id: b.exploration_id, execution_workspace_id: b.execution_workspace_id,
      expected_binding_version: b.binding_version, expected_catalog_version: f.registry.get(f.context).version,
      expected_project_selection_version: selection.shared.current_project.version,
      expected_graph: destinationHead, shared_base: destinationOrigin.origin.shared_base }, endpoint_map, ...extra };
}
