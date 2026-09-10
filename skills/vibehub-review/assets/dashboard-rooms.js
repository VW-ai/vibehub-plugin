/* Room ancestry is separate from Ticket dependencies. These rails only show
   the recorded parent relation within one workspace. */
(() => {
  'use strict';
  function hierarchy(rooms) {
    const byKey = new Map(rooms.map(room => [room.key, room]));
    const children = new Map(), roots = [];
    for (const room of rooms) {
      const parentKey = `${room.workspace}:${room.parent}`;
      if (room.parent && byKey.has(parentKey) && parentKey !== room.key) {
        if (!children.has(parentKey)) children.set(parentKey, []);
        children.get(parentKey).push(room);
      } else roots.push(room);
    }
    const result = [], seen = new Set();
    function visit(room, depth, parentKey = null) {
      if (seen.has(room.key)) return;
      seen.add(room.key);
      result.push({ ...room, depth, parentKey, tone: result.length % 5 });
      for (const child of children.get(room.key) || []) visit(child, depth + 1, room.key);
    }
    roots.forEach(room => visit(room, 0));
    rooms.forEach(room => { if (!seen.has(room.key)) visit(room, 0); });
    return result;
  }
  function matchingRooms(rooms, matches) {
    const byKey = new Map(rooms.map(room => [room.key, room])), keep = new Set(matches);
    for (const key of matches) {
      let room = byKey.get(key);
      const seen = new Set();
      while (room?.parent && !seen.has(room.key)) {
        seen.add(room.key);
        const parentKey = `${room.workspace}:${room.parent}`;
        room = byKey.get(parentKey);
        if (room) keep.add(parentKey);
      }
    }
    return rooms.filter(room => keep.has(room.key));
  }
  function groupByType(records) {
    const order = ['decision', 'constraint', 'contract', 'intent', 'convention', 'change', 'note'];
    const groups = new Map();
    for (const record of records) {
      if (!groups.has(record.type)) groups.set(record.type, []);
      groups.get(record.type).push(record);
    }
    const rank = type => order.includes(type) ? order.indexOf(type) : order.length;
    return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([type, items]) => ({
      type, records: [...items].sort((a, b) => Number(a.state !== 'active') - Number(b.state !== 'active') || a.summary.localeCompare(b.summary)),
    }));
  }
  function connect(container, entries) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('room-rails');svg.setAttribute('aria-hidden', 'true');
    container.prepend(svg);
    let frame = 0, disposed = false;
    function draw() {
      frame = 0;
      if (disposed || !container.isConnected) return;
      const bounds = container.getBoundingClientRect();
      const step = parseFloat(getComputedStyle(container).getPropertyValue('--room-step'));
      const points = new Map(entries.map(({ room, section }) => {
        const heading = section.querySelector('summary').getBoundingClientRect();
        const rowYs = section.open ? [...section.querySelectorAll('.context-type-heading, .context-row')].filter(row => !row.matches('.context-row') || row.closest('.context-type-group')?.open).map(row => {
          const rect = row.getBoundingClientRect();return rect.top - bounds.top + rect.height / 2;
        }) : [];
        const y = heading.top - bounds.top + heading.height / 2;
        return [room.key, { room, x: 16 + room.depth * step, y, rowYs, end: rowYs.at(-1) ?? y }];
      }));
      svg.setAttribute('width', bounds.width);svg.setAttribute('height', bounds.height);
      svg.replaceChildren();
      // Extend each parent rail through its visible descendants.
      for (const point of [...points.values()].reverse()) {
        const parent = points.get(point.room.parentKey);
        if (parent) parent.end = Math.max(parent.end, point.end);
      }
      function shape(tag, attrs, tone) {
        const node = document.createElementNS(ns, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
        node.setAttribute('class', `room-rail tone-${tone}`);svg.append(node);
      }
      for (const point of points.values()) {
        const { room, x, y, end } = point, parent = points.get(room.parentKey);
        if (parent) {
          const junction = Math.max(parent.y + 16, y - 40), bend = Math.min(16, step);
          shape('path', { d: `M ${parent.x} ${junction} H ${x - bend} Q ${x} ${junction} ${x} ${junction + bend} V ${end}` }, room.tone);
        } else if (end > y) shape('path', { d: `M ${x} ${y} V ${end}` }, room.tone);
      }
      for (const { room, x, y, rowYs } of points.values()) {
        for (const cy of rowYs) shape('circle', { cx: x, cy, r: 3, 'stroke-width': 1.5 }, room.tone);
        shape('circle', { cx: x, cy: y, r: 7 }, room.tone);
      }
    }
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(draw); };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    entries.forEach(({ section }) => section.addEventListener('toggle', schedule, true));
    schedule();
    return () => { disposed = true;observer.disconnect();cancelAnimationFrame(frame); };
  }
  globalThis.VibeHubRooms = { hierarchy, matchingRooms, groupByType, connect };
})();
