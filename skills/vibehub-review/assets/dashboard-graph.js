(function (root) {
  function mergeTicketSources(personal, native, nativeEdges) {
    const candidates = new Map();
    for (const item of personal.filter((t) => t.type !== 'goal')) {
      const paths = [
        ...new Set((item.externalKeys || []).filter((k) => k.system === 'vibehub-ticket').map((k) => k.key)),
      ];
      if (paths.length !== 1) continue;
      const matches = candidates.get(paths[0]) || [];
      matches.push(item);
      candidates.set(paths[0], matches);
    }
    const nativeCounts = new Map();
    for (const item of native) nativeCounts.set(item.path, (nativeCounts.get(item.path) || 0) + 1);
    const replacements = new Map(),
      ids = new Map(),
      remaining = [];
    for (const item of native) {
      const matches = candidates.get(item.path) || [];
      if (matches.length !== 1 || nativeCounts.get(item.path) !== 1) {
        remaining.push(item);
        continue;
      }
      const linked = matches[0];
      ids.set(item.id, linked.id);
      replacements.set(linked.id, {
        ...linked,
        ...item,
        id: linked.id,
        originalId: item.originalId || item.id,
        title: linked.title,
        type: linked.type,
        relations: [...(linked.relations || []), ...(item.relations || [])],
        personalPath: linked.path,
        attention: undefined,
        working: item.state === 'IN_PROGRESS',
        state: item.state,
      });
    }
    const mergedItems = [...personal.map((t) => replacements.get(t.id) || t), ...remaining];
    return {
      items: mergedItems.map((item) =>
        item.blockingTicketIds
          ? { ...item, blockingTicketIds: item.blockingTicketIds.map((id) => ids.get(id) || id) }
          : item,
      ),
      edges: nativeEdges.map((e) => ({ ...e, from: ids.get(e.from) || e.from, to: ids.get(e.to) || e.to })),
    };
  }
  function layoutGraph(items, edges, { maxWidth = 1600, direction = 'ttb' } = {}) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const valid = edges
      .filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
      .sort(
        (a, b) =>
          a.from.localeCompare(b.from) ||
          a.to.localeCompare(b.to) ||
          Number(!!a.membership) - Number(!!b.membership),
      );
    const next = new Map(items.map((t) => [t.id, []])),
      previous = new Map(items.map((t) => [t.id, []]));
    for (const e of valid) {
      next.get(e.from).push(e.to);
      previous.get(e.to).push(e.from);
    }
    const remaining = new Map([...previous].map(([id, parents]) => [id, parents.length]));
    const ready = [...byId.keys()].filter((id) => !remaining.get(id)).sort(),
      order = [],
      ranks = new Map();
    while (ready.length) {
      const id = ready.shift();
      order.push(id);
      ranks.set(id, ranks.get(id) || 0);
      for (const child of next.get(id)) {
        ranks.set(child, Math.max(ranks.get(child) || 0, ranks.get(id) + 1));
        remaining.set(child, remaining.get(child) - 1);
        if (!remaining.get(child)) {
          ready.push(child);
          ready.sort();
        }
      }
    }
    const visited = new Set(order),
      cyclic = [...byId.keys()].filter((id) => !visited.has(id)).sort();
    cyclic.forEach((id) => {
      ranks.set(id, ranks.get(id) || 0);
      order.push(id);
    });
    const unseen = new Set([...byId.keys()].sort()),
      components = [];
    while (unseen.size) {
      const queue = [unseen.values().next().value],
        component = [];
      unseen.delete(queue[0]);
      while (queue.length) {
        const id = queue.shift();
        component.push(id);
        for (const neighbor of [...next.get(id), ...previous.get(id)].sort())
          if (unseen.delete(neighbor)) queue.push(neighbor);
      }
      components.push(component);
    }
    const hasOpenGoal = (ids) =>
      ids.some((id) => byId.get(id).type === 'goal' && stageFor(byId.get(id)) !== 'completed');
    const laneOrder = { attention: 0, running: 1, ready: 2, waiting: 3, completed: 4 };
    const priority = new Map(items.map((item) => [item.id, laneOrder[workflowFor(item, items, edges).lane]]));
    const componentPriority = (ids) => Math.min(...ids.map((id) => priority.get(id)));
    components.sort(
      (a, b) =>
        Number(hasOpenGoal(b)) - Number(hasOpenGoal(a)) ||
        componentPriority(a) - componentPriority(b) ||
        b.length - a.length ||
        a[0].localeCompare(b[0]),
    );
    const cardWidth = 248,
      cardHeight = 120,
      padding = 48;
    const horizontal = direction === 'ltr';
    const rankStep = horizontal ? cardWidth + 100 : cardHeight + 110;
    const crossStep = horizontal ? cardHeight + 48 : cardWidth + 64;
    const positions = new Map();
    let shelfX = padding,
      shelfY = padding,
      shelfHeight = 0,
      width = 0;
    for (const component of components) {
      const layers = [];
      for (const id of component) (layers[ranks.get(id)] ||= []).push(id);
      const maxRows = Math.max(...layers.filter(Boolean).map((layer) => layer.length));
      const componentWidth = horizontal
        ? (layers.length - 1) * rankStep + cardWidth
        : (maxRows - 1) * crossStep + cardWidth;
      const componentHeight = horizontal
        ? (maxRows - 1) * crossStep + cardHeight
        : (layers.length - 1) * rankStep + cardHeight;
      if (shelfX > padding && shelfX + componentWidth + padding > maxWidth) {
        shelfY += shelfHeight + 96;
        shelfX = padding;
        shelfHeight = 0;
      }
      const ordinal = new Map();
      layers.forEach((layer, rank) => {
        const center = (id) => {
          const parents = previous.get(id).filter((p) => ordinal.has(p));
          return parents.length ? parents.reduce((sum, p) => sum + ordinal.get(p), 0) / parents.length : 0;
        };
        layer.sort((a, b) => center(a) - center(b) || a.localeCompare(b));
        layer.forEach((id, index) => {
          const cross = ((maxRows - layer.length) * crossStep) / 2 + index * crossStep;
          ordinal.set(id, cross);
          positions.set(id, {
            id,
            x: shelfX + (horizontal ? rank * rankStep : cross),
            y: shelfY + (horizontal ? cross : rank * rankStep),
            width: cardWidth,
            height: cardHeight,
            incoming: valid.filter((e) => !e.membership && e.to === id).length,
            outgoing: valid.filter((e) => !e.membership && e.from === id).length,
            gutter: horizontal ? shelfY : shelfX,
          });
        });
      });
      width = Math.max(width, shelfX + componentWidth + padding);
      shelfX += componentWidth + 96;
      shelfHeight = Math.max(shelfHeight, componentHeight);
    }
    const branchColors = new Map(),
      edgeColors = new Map();
    let colorCursor = 0;
    for (const id of order) {
      if (!branchColors.has(id)) branchColors.set(id, colorCursor++ % 3);
      const children = valid.filter((e) => e.from === id && !e.membership);
      children.forEach((edge, index) => {
        const color = index ? colorCursor++ % 3 : branchColors.get(id);
        edgeColors.set(edge, color);
        if (!branchColors.has(edge.to)) branchColors.set(edge.to, color);
      });
      positions.get(id).color = branchColors.get(id);
    }
    const point = (primary, cross) => (horizontal ? { x: primary, y: cross } : { x: cross, y: primary });
    const route = (points) => {
      let path = `M${points[0].x} ${points[0].y}`;
      for (let i = 1; i < points.length - 1; i++) {
        const before = points[i - 1],
          corner = points[i],
          after = points[i + 1];
        const enter = Math.hypot(corner.x - before.x, corner.y - before.y),
          leave = Math.hypot(after.x - corner.x, after.y - corner.y);
        if (!enter || !leave) continue;
        const radius = Math.min(14, enter / 2, leave / 2);
        const start = {
          x: corner.x + ((before.x - corner.x) * radius) / enter,
          y: corner.y + ((before.y - corner.y) * radius) / enter,
        };
        const end = {
          x: corner.x + ((after.x - corner.x) * radius) / leave,
          y: corner.y + ((after.y - corner.y) * radius) / leave,
        };
        path += ` L${start.x} ${start.y} Q${corner.x} ${corner.y} ${end.x} ${end.y}`;
      }
      return path + ` L${points.at(-1).x} ${points.at(-1).y}`;
    };
    const connections = valid.map((edge, index) => {
      const from = positions.get(edge.from),
        to = positions.get(edge.to);
      const start = horizontal
        ? point(from.x + cardWidth, from.y + cardHeight / 2)
        : point(from.y + cardHeight, from.x + cardWidth / 2);
      const end = horizontal ? point(to.x, to.y + cardHeight / 2) : point(to.y, to.x + cardWidth / 2);
      const primary = (p) => (horizontal ? p.x : p.y),
        cross = (p) => (horizontal ? p.y : p.x);
      const sp = primary(start),
        tp = primary(end),
        sc = cross(start),
        tc = cross(end);
      let points, waypoint;
      if (tp > sp && tp - sp < rankStep) {
        const mid = (sp + tp) / 2;
        points = [start, point(mid, sc), point(mid, tc), end];
        waypoint = point(tp - 20, tc);
      } else {
        const side = Math.min(from.gutter, to.gutter) - 20 - (index % 3) * 8;
        points = [
          start,
          point(sp + 24, sc),
          point(sp + 24, side),
          point(tp - 24, side),
          point(tp - 24, tc),
          end,
        ];
        waypoint = point((sp + tp) / 2, side);
      }
      return {
        ...edge,
        d: route(points),
        sx: start.x,
        sy: start.y,
        tx: end.x,
        ty: end.y,
        waypoint,
        color: edge.membership ? 3 : edgeColors.get(edge),
      };
    });
    return {
      items: order.map((id) => byId.get(id)),
      nodes: order.map((id) => positions.get(id)),
      connections,
      width: Math.max(width, cardWidth + padding * 2),
      height: shelfY + shelfHeight + padding,
      cyclic,
      direction,
    };
  }

  function stageFor(item) {
    const state = (item.state || '').toUpperCase();
    if (['DONE', 'ARCHIVED', 'COMPLETED'].includes(state)) return 'completed';
    if (item.attention === 'needs_you' || state === 'NEEDS YOU') return 'attention';
    if (item.working || ['WORKING', 'RUNNING', 'IN_PROGRESS'].includes(state)) return 'running';
    return state === 'BLOCKED' ? 'waiting' : 'ready';
  }
  function goalScope(goalId, items) {
    const ids = new Set([goalId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of items)
        if (
          !ids.has(item.id) &&
          (item.relations || []).some((r) => ['task_of', 'sub_goal_of'].includes(r.type) && ids.has(r.target))
        ) {
          ids.add(item.id);
          changed = true;
        }
    }
    return ids;
  }
  function workflowFor(item, items, edges) {
    const byId = new Map(items.map((t) => [t.id, t]));
    const blockers = [
      ...new Set([
        ...(item.blockingTicketIds || []),
        ...edges
          .filter(
            (e) =>
              !e.membership &&
              e.to === item.id &&
              (!byId.has(e.from) || stageFor(byId.get(e.from)) !== 'completed'),
          )
          .map((e) => e.from),
      ]),
    ];
    const downstream = new Set(),
      pending = [item.id];
    while (pending.length) {
      const id = pending.pop();
      for (const edge of edges)
        if (!edge.membership && edge.from === id && edge.to !== item.id && !downstream.has(edge.to)) {
          downstream.add(edge.to);
          pending.push(edge.to);
        }
    }
    let lane = 'ready',
      label = 'Open';
    if (stageFor(item) === 'completed') {
      lane = 'completed';
      label = 'Completed';
    } else if (stageFor(item) === 'attention') {
      lane = 'attention';
      label = 'Needs your input';
    } else if (stageFor(item) === 'running') {
      lane = 'running';
      label = 'In progress';
    } else if (blockers.length || item.state === 'BLOCKED') {
      lane = 'waiting';
      label = 'Waiting on dependencies';
    }
    return {
      lane,
      label,
      blockers,
      downstream: [...downstream].filter((id) => byId.has(id) && stageFor(byId.get(id)) !== 'completed'),
      detail: item.workState?.detail || label,
    };
  }
  function executionSummary(tickets, items, edges) {
    const groups = { attention: [], running: [], ready: [], waiting: [], completed: [] };
    for (const item of tickets.filter((t) => !['goal', 'epic'].includes(t.type))) {
      const workflow = workflowFor(item, items, edges);
      groups[workflow.lane].push({ item, ...workflow });
    }
    groups.attention.sort(
      (a, b) => b.downstream.length - a.downstream.length || a.item.id.localeCompare(b.item.id),
    );
    return groups;
  }
  function fromRepositoryGraph(tree, graph, projectName = '') {
    const key = (kind, id) => `native:${tree.id}:${kind}:${id}`;
    const base = (kind, id) => ({
      id: key(kind, id),
      originalId: id,
      workspace: tree.id,
      type: kind,
      source: {
        kind: 'native',
        workspace: tree.id,
        recordKind: kind,
        id,
        path: `${tree.path}/.vibehub/${kind}s/${id}.yaml`,
      },
      path: `${tree.path}/.vibehub/${kind}s/${id}.yaml`,
      projects: [projectName, tree.branch].filter(Boolean),
      relations: [],
    });
    const items = [];
    for (const { goal } of graph.hierarchy?.goals || [])
      items.push({
        ...base('goal', goal.goal_id),
        title: goal.title,
        outcome: goal.description || '',
        criteria: goal.success_criteria || [],
        state: 'OPEN',
      });
    for (const { epic } of graph.hierarchy?.epics || [])
      items.push({
        ...base('epic', epic.epic_id),
        title: epic.title,
        outcome: epic.outcome || '',
        criteria: epic.acceptance || [],
        state: 'OPEN',
        relations: [{ type: 'sub_goal_of', target: key('goal', epic.goal_id) }],
      });
    for (const ticket of graph.tickets)
      items.push({
        ...base('ticket', ticket.ticketId),
        title: ticket.ticketId.replace(/^ticket-/, '').replaceAll('-', ' '),
        outcome: ticket.outcome,
        state: ticket.capabilities?.operational?.summary?.label || ticket.status.toUpperCase(),
        status: ticket.status,
        updates: ticket.updates || [],
        blockingTicketIds: (ticket.blockingTicketIds || []).map((id) => key('ticket', id)),
        workState: ticket.workState,
        ticket: true,
        relations: ticket.hierarchy?.epic
          ? [{ type: 'task_of', target: key('epic', ticket.hierarchy.epic.epic_id) }]
          : [],
      });
    const edges = graph.relations.map((r) => ({
      from: key('ticket', r.prerequisiteTicketId),
      to: key('ticket', r.dependentTicketId),
      membership: false,
    }));
    for (const item of items)
      for (const relation of item.relations)
        edges.push({ from: relation.target, to: item.id, membership: true });
    return { items, edges };
  }
  function personalWork(tickets) {
    const key = (id) => `personal:${id}`;
    return tickets.map((item) => ({
      ...item,
      id: key(item.id),
      originalId: item.id,
      source: { kind: 'personal', id: item.id, path: item.path },
      relations: (item.relations || []).map((relation) => ({ ...relation, target: key(relation.target) })),
    }));
  }
  function workModel(items, edges) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const incoming = new Map(),
      outgoing = new Map(),
      members = new Map();
    for (const item of items) {
      incoming.set(item.id, []);
      outgoing.set(item.id, []);
      members.set(item.id, []);
    }
    for (const edge of edges) {
      if (edge.membership) members.get(edge.from)?.push(edge.to);
      else {
        incoming.get(edge.to)?.push(edge.from);
        outgoing.get(edge.from)?.push(edge.to);
      }
    }
    return { items, edges, byId, incoming, outgoing, members };
  }
  function visibleWork(model, selection) {
    const { items, edges } = model,
      group = (item) => ['goal', 'epic'].includes(item.type);
    const descendants = (id) => goalScope(id, items);
    let scoped;
    if (selection.parent) {
      const ids = descendants(selection.parent);
      scoped = items.filter((item) => ids.has(item.id) && item.id !== selection.parent);
    } else if (selection.surface === 'goals') scoped = items.filter((item) => item.type === 'goal');
    else if (selection.scope === 'unassigned')
      scoped = items.filter(
        (item) => !group(item) && !(item.relations || []).some((r) => r.type === 'task_of'),
      );
    else scoped = items.filter((item) => !group(item));
    const lanes = selection.lanes || new Set();
    const laneFor = (item) => {
      if (!group(item)) return workflowFor(item, items, edges).lane;
      const ids = descendants(item.id),
        children = items.filter((t) => ids.has(t.id) && !group(t));
      const own = workflowFor(item, items, edges).lane;
      if (item.source?.kind === 'personal' && (!children.length || own === 'completed')) return own;
      const summary = executionSummary(children, items, edges);
      return (
        ['attention', 'running', 'ready', 'waiting', 'completed'].find((lane) => summary[lane].length) ||
        'ready'
      );
    };
    const query = (selection.query || '').toLowerCase();
    const active = selection.view === 'canvas' && selection.history !== 'all' && lanes.size === 0;
    const visible = scoped.filter(
      (item) =>
        (!lanes.size || lanes.has(laneFor(item))) &&
        (!active || laneFor(item) !== 'completed') &&
        `${item.originalId || item.id} ${item.title} ${item.outcome || ''} ${(item.projects || []).join(' ')}`
          .toLowerCase()
          .includes(query),
    );
    const ids = new Set(visible.map((item) => item.id)),
      hidden = new Map(visible.map((item) => [item.id, 0]));
    for (const edge of edges) {
      if (ids.has(edge.from) && !ids.has(edge.to)) hidden.set(edge.from, hidden.get(edge.from) + 1);
      if (ids.has(edge.to) && !ids.has(edge.from)) hidden.set(edge.to, hidden.get(edge.to) + 1);
    }
    return {
      items: visible,
      edges: edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
      hidden,
      lanes: ['attention', 'running', 'ready', 'waiting', 'completed'].filter(
        (lane) => !lanes.size || lanes.has(lane),
      ),
      count: visible.length,
      totalCount: scoped.length,
      active,
      laneFor,
    };
  }
  const api = {
    layoutGraph,
    stageFor,
    goalScope,
    workflowFor,
    executionSummary,
    mergeTicketSources,
    fromRepositoryGraph,
    personalWork,
    workModel,
    visibleWork,
  };
  root.VibeHubDashboardGraph = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
