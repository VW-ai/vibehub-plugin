/* Deterministic card layout. Membership stays distinct from dependency arrows. */
(function (root) {
  // Explicit local-file bindings join personal goal membership to native execution.
  // Exact paths keep identical ticket IDs in different worktrees independent.
  function mergeTicketSources(personal, native, nativeEdges) {
    const candidates = new Map();
    for (const item of personal.filter(t => t.type !== 'goal')) {
      const paths = [...new Set((item.externalKeys || []).filter(k => k.system === 'vibehub-ticket').map(k => k.key))];
      if (paths.length !== 1) continue;
      const matches = candidates.get(paths[0]) || []; matches.push(item); candidates.set(paths[0], matches);
    }
    const nativeCounts = new Map();
    for (const item of native) nativeCounts.set(item.path, (nativeCounts.get(item.path) || 0) + 1);
    const replacements = new Map(), ids = new Map(), remaining = [];
    for (const item of native) {
      const matches = candidates.get(item.path) || [];
      if (matches.length !== 1 || nativeCounts.get(item.path) !== 1) { remaining.push(item); continue; }
      const linked = matches[0]; ids.set(item.id, linked.id);
      replacements.set(linked.id, { ...linked, ...item, id: linked.id, originalId: item.originalId || item.id,
        title: linked.title, type: linked.type, relations: linked.relations, personalPath: linked.path,
        attention: undefined, working: Boolean(linked.working && item.nextAction?.action === 'EXECUTE'),
        state: linked.working && item.nextAction?.action === 'EXECUTE' ? 'WORKING' : item.state });
    }
    return { items: [...personal.map(t => replacements.get(t.id) || t), ...remaining],
      edges: nativeEdges.map(e => ({ ...e, from: ids.get(e.from) || e.from, to: ids.get(e.to) || e.to })) };
  }
  function layoutGraph(items, edges, { maxWidth = 1600 } = {}) {
    const byId = new Map(items.map(item => [item.id, item]));
    const valid = edges.filter(e => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
      .sort((a,b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || Number(!!a.membership)-Number(!!b.membership));
    const next = new Map(items.map(t => [t.id, []])), previous = new Map(items.map(t => [t.id, []]));
    for (const e of valid) { next.get(e.from).push(e.to); previous.get(e.to).push(e.from); }
    const remaining = new Map([...previous].map(([id, parents]) => [id, parents.length]));
    const ready = [...byId.keys()].filter(id => !remaining.get(id)).sort(), order = [], ranks = new Map();
    while (ready.length) {
      const id = ready.shift(); order.push(id); ranks.set(id, ranks.get(id) || 0);
      for (const child of next.get(id)) {
        ranks.set(child, Math.max(ranks.get(child) || 0, ranks.get(id) + 1));
        remaining.set(child, remaining.get(child) - 1);
        if (!remaining.get(child)) { ready.push(child); ready.sort(); }
      }
    }
    const visited = new Set(order), cyclic = [...byId.keys()].filter(id => !visited.has(id)).sort();
    // Cyclic/blocked nodes still get cards and their original edges.
    cyclic.forEach(id => { ranks.set(id, ranks.get(id) || 0); order.push(id); });
    const unseen = new Set([...byId.keys()].sort()), components = [];
    while (unseen.size) {
      const queue = [unseen.values().next().value], component = []; unseen.delete(queue[0]);
      while (queue.length) {
        const id = queue.shift(); component.push(id);
        for (const neighbor of [...next.get(id), ...previous.get(id)].sort()) if (unseen.delete(neighbor)) queue.push(neighbor);
      }
      components.push(component);
    }
    const hasOpenGoal = ids => ids.some(id => byId.get(id).type === 'goal' && stageFor(byId.get(id)) !== 'completed');
    const laneOrder={attention:0,running:1,ready:2,planned:3,waiting:4,completed:5};
    const priority=new Map(items.map(item=>[item.id,laneOrder[workflowFor(item,items,edges).lane]]));
    const componentPriority=ids=>Math.min(...ids.map(id=>priority.get(id)));
    components.sort((a,b) => Number(hasOpenGoal(b))-Number(hasOpenGoal(a)) || componentPriority(a)-componentPriority(b) || b.length - a.length || a[0].localeCompare(b[0]));
    const cardWidth = 320, cardHeight = 200, column = 416, row = 328, padding = 48;
    const positions = new Map(); let shelfX = padding, shelfY = padding, shelfHeight = 0, width = 0;
    for (const component of components) {
      const layers = [];
      for (const id of component) (layers[ranks.get(id)] ||= []).push(id);
      const maxRows = Math.max(...layers.filter(Boolean).map(layer => layer.length));
      const componentWidth = (maxRows - 1) * column + cardWidth;
      const componentHeight = (layers.length - 1) * row + cardHeight;
      if (shelfX > padding && shelfX + componentWidth + padding > maxWidth) { shelfY += shelfHeight + 96; shelfX = padding; shelfHeight = 0; }
      const ordinal = new Map();
      layers.forEach((layer, rank) => {
        const center = id => {
          const parents = previous.get(id).filter(p => ordinal.has(p));
          return parents.length ? parents.reduce((sum,p) => sum + ordinal.get(p), 0) / parents.length : 0;
        };
        layer.sort((a,b) => center(a) - center(b) || a.localeCompare(b));
        layer.forEach((id,index) => {
          const x = shelfX + (maxRows-layer.length)*column/2 + index*column;
          ordinal.set(id, x);
          positions.set(id, { id, x, y: shelfY+rank*row, width: cardWidth, height: cardHeight,
            incoming: valid.filter(e => !e.membership && e.to === id).length,
            outgoing: valid.filter(e => !e.membership && e.from === id).length, left: shelfX });
        });
      });
      width = Math.max(width, shelfX + componentWidth + padding);
      shelfX += componentWidth + 96; shelfHeight = Math.max(shelfHeight, componentHeight);
    }
    const branchColors = new Map(), edgeColors = new Map(); let colorCursor = 0;
    for (const id of order) {
      if (!branchColors.has(id)) branchColors.set(id, colorCursor++ % 3);
      const children = valid.filter(e => e.from === id && !e.membership);
      children.forEach((edge,index) => {
        const color = index ? colorCursor++ % 3 : branchColors.get(id);
        edgeColors.set(edge, color);
        if (!branchColors.has(edge.to)) branchColors.set(edge.to,color);
      });
      positions.get(id).color = branchColors.get(id);
    }
    const connections = valid.map((edge, index) => {
      const from = positions.get(edge.from), to = positions.get(edge.to);
      const sx = from.x+cardWidth/2, sy = from.y+cardHeight, tx = to.x+cardWidth/2, ty = to.y;
      const my = (sy+ty)/2, radius = Math.min(24, Math.abs(tx-sx)/2), direction = tx >= sx ? 1 : -1;
      let d, waypoint;
      if (ty-sy > 0 && ty-sy < row) {
        d = sx === tx ? `M${sx} ${sy} V${ty}` : `M${sx} ${sy} V${my-radius} Q${sx} ${my} ${sx+radius*direction} ${my} H${tx-radius*direction} Q${tx} ${my} ${tx} ${my+radius} V${ty}`;
        waypoint = { x:tx, y:ty-28 };
      } else {
        // Long/returning links use the component gutter, never cross intermediate cards.
        const side = Math.min(from.left,to.left)-20-(index%3)*8;
        const forward = ty > sy;
        d = `M${sx} ${sy} V${sy+20} Q${sx} ${sy+32} ${sx-12} ${sy+32} H${side+12} Q${side} ${sy+32} ${side} ${sy+(forward ? 44 : 20)} V${ty-(forward ? 56 : 32)} Q${side} ${ty-44} ${side+12} ${ty-44} H${tx-12} Q${tx} ${ty-44} ${tx} ${ty-32} V${ty}`;
        waypoint = { x:side, y:(sy+ty)/2 };
      }
      return { ...edge, d, sx, sy, tx, ty, waypoint, color: edge.membership ? 3 : edgeColors.get(edge) };
    });
    return { items: order.map(id => byId.get(id)), nodes: order.map(id => positions.get(id)), connections,
      width: Math.max(width, cardWidth+padding*2), height: shelfY+shelfHeight+padding, cyclic };
  }
  function stageFor(item) {
    const state = (item.state || '').toUpperCase();
    if (['DONE','ARCHIVED','COMPLETED'].includes(state)) return 'completed';
    if (item.attention === 'needs_you' || state === 'NEEDS YOU' || item.nextAction?.action === 'NEEDS_HUMAN') return 'attention';
    if (item.working || ['WORKING','RUNNING','IN_PROGRESS'].includes(state)) return 'running';
    return 'planned';
  }
  function goalScope(goalId, items) {
    const ids = new Set([goalId]); let changed = true;
    while (changed) {
      changed = false;
      for (const item of items) if (!ids.has(item.id) && (item.relations || []).some(r => ['task_of','sub_goal_of'].includes(r.type) && ids.has(r.target))) {
        ids.add(item.id); changed = true;
      }
    }
    return ids;
  }
  // A read projection, never a replacement for the engine's execution authority.
  function workflowFor(item, items, edges) {
    const byId=new Map(items.map(t=>[t.id,t])), action=item.nextAction?.action;
    const blockers=edges.filter(e=>!e.membership && e.to===item.id && (!byId.has(e.from) || stageFor(byId.get(e.from))!=='completed')).map(e=>e.from);
    const downstream=new Set(), pending=[item.id];
    while(pending.length) {
      const id=pending.pop();
      for(const edge of edges) if(!edge.membership && edge.from===id && edge.to!==item.id && !downstream.has(edge.to)) { downstream.add(edge.to); pending.push(edge.to); }
    }
    let lane='planned', label='Needs planning';
    if(stageFor(item)==='completed' || action==='DONE') { lane='completed'; label='Completed'; }
    else if(action==='WAIT' || (!action && blockers.length)) { lane='waiting'; label='Waiting on dependencies'; }
    else if(stageFor(item)==='attention') { lane='attention'; label='Needs your input'; }
    else if(stageFor(item)==='running') { lane='running'; label='Agent working'; }
    else if(action==='EXECUTE' || (!action && item.state==='READY')) { lane='ready'; label='Ready to execute'; }
    else if(action==='CLOSE_OUT') { lane='ready'; label='Ready for review'; }
    else if(action==='REFINE') label='Refine acceptance';
    else if(action==='REPLAN') label='Replan required';
    else if(item.state==='BLOCKED') { lane='waiting'; label='Blocked'; }
    return {lane,label,action,blockers,downstream:[...downstream].filter(id=>byId.has(id) && stageFor(byId.get(id))!=='completed'),detail:item.nextAction?.detail||label};
  }
  function executionSummary(tickets, items, edges) {
    const groups={attention:[],running:[],ready:[],waiting:[],planned:[],completed:[]};
    for(const item of tickets.filter(t=>t.type!=='goal')) { const workflow=workflowFor(item,items,edges); groups[workflow.lane].push({item,...workflow}); }
    groups.attention.sort((a,b)=>b.downstream.length-a.downstream.length || a.item.id.localeCompare(b.item.id));
    return groups;
  }
  root.VibeHubDashboardGraph = { layoutGraph, stageFor, goalScope, workflowFor, executionSummary, mergeTicketSources };
  if (typeof module !== 'undefined') module.exports = { layoutGraph, stageFor, goalScope, workflowFor, executionSummary, mergeTicketSources };
})(globalThis);
