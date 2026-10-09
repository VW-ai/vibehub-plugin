import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../skills/vibehub-review/assets/dashboard-graph.js';
const { fromRepositoryGraph, personalWork, mergeTicketSources, workModel, visibleWork, layoutGraph } =
  globalThis.VibeHubDashboardGraph;
const tree = { id: 'one', path: '/one', branch: 'main' };
const native = () => ({
  hierarchy: {
    goals: [{ goal: { goal_id: 'goal-launch', title: 'Launch', description: 'A usable release' } }],
    epics: [
      { epic: { epic_id: 'epic-reader', goal_id: 'goal-launch', title: 'Reader', outcome: 'Read the work' } },
    ],
  },
  tickets: [
    {
      ticketId: 'same',
      outcome: 'Current work',
      status: 'open',
      updates: [{ summary: 'Reopened' }],
      blockingTicketIds: [],
      capabilities: { operational: { summary: { label: 'OPEN' } } },
      hierarchy: { epic: { epic_id: 'epic-reader' } },
    },
    {
      ticketId: 'done',
      outcome: 'Earlier work',
      status: 'done',
      updates: [],
      blockingTicketIds: [],
      capabilities: { operational: { summary: { label: 'DONE' } } },
    },
  ],
  relations: [{ prerequisiteTicketId: 'done', dependentTicketId: 'same' }],
});

test('native projection preserves exact workspaces and Goal/Epic membership beside real task status', () => {
  const one = fromRepositoryGraph(tree, native(), 'Project'),
    two = fromRepositoryGraph({ ...tree, id: 'two', path: '/two' }, native(), 'Project');
  assert.equal(new Set([...one.items, ...two.items].map((item) => item.id)).size, 8);
  assert.deepEqual(
    one.items.map((item) => [item.originalId, item.type]),
    [
      ['goal-launch', 'goal'],
      ['epic-reader', 'epic'],
      ['same', 'ticket'],
      ['done', 'ticket'],
    ],
  );
  assert.equal(one.items[2].source.path, '/one/.vibehub/tickets/same.yaml');
  assert.equal(one.items[2].status, 'open');
  assert.equal(one.items[2].updates[0].summary, 'Reopened');
  assert.deepEqual(one.edges, [
    { from: 'native:one:ticket:done', to: 'native:one:ticket:same', membership: false },
    { from: 'native:one:goal:goal-launch', to: 'native:one:epic:epic-reader', membership: true },
    { from: 'native:one:epic:epic-reader', to: 'native:one:ticket:same', membership: true },
  ]);
});

test('an exact personal binding keeps both personal and native membership without cross-worktree adoption', () => {
  const personal = personalWork([
    { id: 'goal', type: 'goal', title: 'Personal goal', relations: [], projects: [] },
    {
      id: 'same',
      type: 'task',
      title: 'My task',
      relations: [{ type: 'task_of', target: 'goal' }],
      projects: [],
      externalKeys: [{ system: 'vibehub-ticket', key: '/one/.vibehub/tickets/same.yaml' }],
    },
  ]);
  const one = fromRepositoryGraph(tree, native()),
    two = fromRepositoryGraph({ ...tree, id: 'two', path: '/two' }, native());
  const merged = mergeTicketSources(personal, [...one.items, ...two.items], [...one.edges, ...two.edges]);
  assert.equal(merged.items.length, 9);
  const task = merged.items.find((item) => item.id === 'personal:same');
  assert.equal(task.workspace, 'one');
  assert.deepEqual(
    task.relations.map((r) => r.target),
    ['personal:goal', 'native:one:epic:epic-reader'],
  );
  assert.ok(merged.items.some((item) => item.id === 'native:two:ticket:same'));
  const visible = visibleWork(workModel(merged.items, merged.edges), {
    parent: 'native:one:goal:goal-launch',
    lanes: new Set(),
  });
  assert.deepEqual(
    visible.items.map((item) => item.id),
    ['personal:same', 'native:one:epic:epic-reader'],
  );
});

test('one visible set controls scopes, composed lanes, Active/All and hidden connections', () => {
  const projected = fromRepositoryGraph(tree, native()),
    model = workModel(projected.items, projected.edges);
  const all = visibleWork(model, { surface: 'tickets', scope: 'all', view: 'board' });
  assert.equal(all.count, 2);
  assert.equal(all.totalCount, 2);
  assert.equal(all.lanes.length, 5);
  const active = visibleWork(model, { surface: 'tickets', view: 'canvas', history: 'active' });
  assert.deepEqual(
    active.items.map((item) => item.originalId),
    ['same'],
  );
  assert.equal(active.hidden.get('native:one:ticket:same'), 2);
  assert.equal(active.edges.length, 0);
  const done = visibleWork(model, {
    surface: 'tickets',
    view: 'canvas',
    history: 'active',
    lanes: new Set(['completed']),
  });
  assert.deepEqual(
    done.items.map((item) => item.originalId),
    ['done'],
  );
  assert.equal(done.active, false);
  assert.deepEqual(done.lanes, ['completed']);
  const composed = visibleWork(model, {
    surface: 'tickets',
    view: 'board',
    lanes: new Set(['ready', 'completed']),
  });
  assert.equal(composed.count, 2);
  assert.deepEqual(composed.lanes, ['ready', 'completed']);
  assert.deepEqual(
    visibleWork(model, { surface: 'tickets', scope: 'unassigned' }).items.map((item) => item.originalId),
    ['done'],
  );
  assert.equal(
    visibleWork(workModel([projected.items[3]], []), {
      surface: 'tickets',
      view: 'canvas',
      history: 'active',
    }).count,
    0,
  );
});

test('both layout directions retain splits, merges, cycles and readable non-overlapping cards', () => {
  const items = ['root', 'left', 'right', 'merge', 'cycle-a', 'cycle-b'].map((id) => ({ id, state: 'OPEN' }));
  const edges = [
    ['root', 'left'],
    ['root', 'right'],
    ['left', 'merge'],
    ['right', 'merge'],
    ['cycle-a', 'cycle-b'],
    ['cycle-b', 'cycle-a'],
  ].map(([from, to]) => ({ from, to }));
  for (const direction of ['ltr', 'ttb']) {
    const graph = layoutGraph(items, edges, { direction, maxWidth: 1100 });
    assert.equal(graph.nodes.length, 6);
    assert.equal(graph.connections.length, 6);
    assert.deepEqual(graph.cyclic, ['cycle-a', 'cycle-b']);
    const positions = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const node of graph.nodes)
      for (const other of graph.nodes)
        if (node.id !== other.id)
          assert.ok(
            node.x + node.width <= other.x ||
              other.x + other.width <= node.x ||
              node.y + node.height <= other.y ||
              other.y + other.height <= node.y,
          );
    const root = positions.get('root'),
      left = positions.get('left');
    assert.ok(direction === 'ltr' ? left.x > root.x + root.width : left.y > root.y + root.height);
    for (const edge of graph.connections) {
      const from = positions.get(edge.from),
        to = positions.get(edge.to);
      assert.equal(
        direction === 'ltr' ? edge.sx : edge.sy,
        direction === 'ltr' ? from.x + from.width : from.y + from.height,
      );
      assert.equal(direction === 'ltr' ? edge.tx : edge.ty, direction === 'ltr' ? to.x : to.y);
    }
  }
});

test('personal goals keep explicit completion and empty-goal state while native goals aggregate tasks', () => {
  const personal = personalWork([
    { id: 'finished', type: 'goal', title: 'Finished', state: 'done', projects: [], relations: [] },
    {
      id: 'needs-review',
      type: 'goal',
      title: 'Needs review',
      state: 'open',
      attention: 'needs_you',
      projects: [],
      relations: [],
    },
    { id: 'closed-parent', type: 'goal', title: 'Closed parent', state: 'done', projects: [], relations: [] },
    {
      id: 'open-child',
      type: 'task',
      title: 'Open child',
      state: 'OPEN',
      projects: [],
      relations: [{ type: 'task_of', target: 'closed-parent' }],
    },
  ]);
  const projection = fromRepositoryGraph(tree, native()),
    model = workModel([...personal, ...projection.items], projection.edges);
  const all = visibleWork(model, { surface: 'goals', view: 'canvas', history: 'all' });
  assert.equal(all.laneFor(personal[0]), 'completed');
  assert.equal(all.laneFor(personal[1]), 'attention');
  assert.equal(all.laneFor(personal[2]), 'completed');
  assert.equal(all.laneFor(projection.items[0]), 'ready');
  const active = visibleWork(model, { surface: 'goals', view: 'canvas', history: 'active' });
  assert.deepEqual(
    active.items.map((item) => item.originalId),
    ['needs-review', 'goal-launch'],
  );
});

test('live all-scope API projection includes unrelated completed tasks and refreshes current status', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { run, ticket } = await import('./helpers.mjs');
  const { startVibeHubUi } = await import('../skills/vibehub-core/scripts/vh-ui.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'vh-dashboard-model-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', repo]);
  const apply = (domain, operation, input) => {
    const result = run(repo, domain, operation, input);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    return result.envelope.data;
  };
  apply('project', 'init');
  apply('ticket', 'apply', {
    validation: { independent: false, note: 'Dashboard behavior fixture' },
    goals: [
      {
        schema_version: 1,
        kind: 'goal',
        goal_id: 'release',
        title: 'Release',
        description: 'Make the reader usable',
        success_criteria: ['People can read their work'],
        context_refs: [],
        provenance_refs: [],
      },
    ],
    epics: [
      {
        schema_version: 1,
        kind: 'epic',
        epic_id: 'reader',
        goal_id: 'release',
        title: 'Reader',
        outcome: 'Read tasks',
        context_refs: [],
        provenance_refs: [],
      },
    ],
    tickets: [{ ...ticket('current'), epic_id: 'reader' }, ticket('unrelated-done')],
  });
  apply('ticket', 'update', {
    ticket_id: 'unrelated-done',
    update_id: 'finished',
    summary: 'Finished earlier',
    status: 'done',
    recorded_at: '2026-10-01T12:00:00Z',
  });
  const host = startVibeHubUi({ repoRoot: repo, dashboardRoots: [repo] });
  const ready = await host.ready;
  t.after(() => host.close());
  const headers = { Authorization: `Bearer ${host.token}` };
  const read = async (path) => {
    const response = await fetch(`${ready.origin}${path}`, { headers });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const discovery = await read('/api/dashboard'),
    tree = discovery.projects[0].worktrees[0];
  const snapshot = await read(`/api/state?workspace=${tree.id}&scope=all`);
  const graph = await read(`/api/tickets?workspace=${tree.id}&scope=all`);
  for (const source of [snapshot.graph, graph]) {
    const projected = fromRepositoryGraph(tree, source, 'Project'),
      model = workModel(projected.items, projected.edges);
    assert.deepEqual(projected.items.map((item) => item.type).sort(), ['epic', 'goal', 'ticket', 'ticket']);
    assert.equal(visibleWork(model, { surface: 'tickets', view: 'board' }).count, 2);
    assert.equal(visibleWork(model, { surface: 'tickets', view: 'canvas', history: 'active' }).count, 1);
    assert.deepEqual(
      visibleWork(model, { surface: 'tickets', view: 'canvas', lanes: new Set(['completed']) }).items.map(
        (item) => item.originalId,
      ),
      ['unrelated-done'],
    );
  }
  apply('ticket', 'update', {
    ticket_id: 'unrelated-done',
    update_id: 'reopened',
    summary: 'More work needed',
    status: 'in_progress',
    recorded_at: '2026-10-02T12:00:00Z',
  });
  const updated = fromRepositoryGraph(tree, await read(`/api/tickets?workspace=${tree.id}&scope=all`));
  const active = visibleWork(workModel(updated.items, updated.edges), {
    surface: 'tickets',
    view: 'canvas',
    history: 'active',
  });
  assert.equal(active.count, 2);
  const reopened = active.items.find((item) => item.originalId === 'unrelated-done');
  assert.equal(active.laneFor(reopened), 'running');
  assert.equal(reopened.updates.at(-1).summary, 'More work needed');
});

test('native Tickets show their title when present and the humanized ID otherwise', () => {
  const graph = native();
  graph.tickets[0].title = 'Current release work';
  const items = fromRepositoryGraph(tree, graph, 'Project').items.filter((item) => item.type === 'ticket');
  assert.deepEqual(items.map((item) => item.title), ['Current release work', 'done']);
});
