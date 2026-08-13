(() => {
  "use strict";

  const NODE = Object.freeze({ width: 232, height: 96 });
  const LAYOUT = Object.freeze({
    marginX: 84,
    marginY: 72,
    rankGap: 108,
    siblingGap: 44,
    sweeps: 12,
  });

  function layoutGraph(tickets, relations, direction = "ltr", options = {}) {
    const leftToRight = direction !== "ttb";
    const ids = tickets.map((ticket) => ticket.ticketId).sort();
    const validIds = new Set(ids);
    const validRelations = relations
      .filter((relation) => validIds.has(relation.prerequisiteTicketId)
        && validIds.has(relation.dependentTicketId))
      .slice()
      .sort((left, right) => left.relationRef.localeCompare(right.relationRef));
    const outgoing = new Map(ids.map((id) => [id, []]));
    const incoming = new Map(ids.map((id) => [id, []]));
    const indegree = new Map(ids.map((id) => [id, 0]));
    for (const relation of validRelations) {
      outgoing.get(relation.prerequisiteTicketId).push(relation.dependentTicketId);
      incoming.get(relation.dependentTicketId).push(relation.prerequisiteTicketId);
      indegree.set(
        relation.dependentTicketId,
        indegree.get(relation.dependentTicketId) + 1,
      );
    }
    for (const neighbors of [...outgoing.values(), ...incoming.values()]) {
      neighbors.sort();
    }

    const rankById = longestPathRanks(ids, outgoing, indegree);
    const layerCount = Math.max(0, ...rankById.values()) + 1;
    const layers = Array.from({ length: layerCount }, () => []);
    const itemByKey = new Map();
    for (const id of ids) {
      const item = { key: id, ticketId: id, rank: rankById.get(id), real: true };
      layers[item.rank].push(item);
      itemByKey.set(item.key, item);
    }

    const chains = new Map();
    const adjacentEdges = [];
    for (const relation of validRelations) {
      const sourceRank = rankById.get(relation.prerequisiteTicketId);
      const targetRank = rankById.get(relation.dependentTicketId);
      const chain = [relation.prerequisiteTicketId];
      for (let rank = sourceRank + 1; rank < targetRank; rank += 1) {
        const key = `@${relation.relationRef}:${rank}`;
        const item = { key, relationRef: relation.relationRef, rank, real: false };
        layers[rank].push(item);
        itemByKey.set(key, item);
        chain.push(key);
      }
      chain.push(relation.dependentTicketId);
      chains.set(relation.relationRef, chain);
      for (let index = 0; index < chain.length - 1; index += 1) {
        adjacentEdges.push({
          from: chain[index],
          to: chain[index + 1],
          relationRef: relation.relationRef,
        });
      }
    }

    for (const layer of layers) {
      layer.sort((left, right) => left.key.localeCompare(right.key));
    }
    const predecessors = new Map([...itemByKey.keys()].map((key) => [key, []]));
    const successors = new Map([...itemByKey.keys()].map((key) => [key, []]));
    for (const edge of adjacentEdges) {
      successors.get(edge.from).push(edge.to);
      predecessors.get(edge.to).push(edge.from);
    }
    minimizeCrossings(layers, predecessors, successors);

    const siblingSize = leftToRight ? NODE.height : NODE.width;
    const rankSize = leftToRight ? NODE.width : NODE.height;
    const layerSpan = (count) => count === 0
      ? 0
      : count * siblingSize + (count - 1) * LAYOUT.siblingGap;
    const maxSpan = Math.max(0, ...layers.map((layer) => layerSpan(layer.length)));
    const itemPositions = new Map();
    const positions = new Map();
    layers.forEach((layer, rank) => {
      const inset = (maxSpan - layerSpan(layer.length)) / 2;
      layer.forEach((item, siblingIndex) => {
        const rankPosition = (leftToRight ? LAYOUT.marginX : LAYOUT.marginY)
          + rank * (rankSize + LAYOUT.rankGap);
        const siblingPosition = (leftToRight ? LAYOUT.marginY : LAYOUT.marginX)
          + inset + siblingIndex * (siblingSize + LAYOUT.siblingGap);
        const position = leftToRight
          ? { x: rankPosition, y: siblingPosition }
          : { x: siblingPosition, y: rankPosition };
        itemPositions.set(item.key, position);
        if (item.real) positions.set(item.ticketId, position);
      });
    });

    if (options.fixedPositions instanceof Map) {
      for (const [ticketId, fixed] of options.fixedPositions) {
        if (!positions.has(ticketId)) continue;
        const position = { x: fixed.x, y: fixed.y };
        positions.set(ticketId, position);
        itemPositions.set(ticketId, position);
      }
      const fixedIds = new Set(options.fixedPositions.keys());
      const occupied = [...positions.entries()]
        .filter(([id]) => fixedIds.has(id))
        .map(([, position]) => position);
      const step = (leftToRight ? NODE.height : NODE.width) + LAYOUT.siblingGap;
      for (const [ticketId, position] of positions) {
        if (fixedIds.has(ticketId)) continue;
        const candidate = { ...position };
        while (occupied.some((item) => rectanglesOverlap(candidate, item))) {
          if (leftToRight) candidate.y += step;
          else candidate.x += step;
        }
        positions.set(ticketId, candidate);
        itemPositions.set(ticketId, candidate);
        occupied.push(candidate);
      }
    }

    const ports = relationPorts(validRelations, direction, positions);
    const routes = routeRelations(
      validRelations,
      chains,
      itemByKey,
      itemPositions,
      ports,
      direction,
    );
    return Object.freeze({
      positions,
      routes,
      ports,
      rankById,
      layers: layers.map((layer) => layer.map((item) => item.key)),
    });
  }

  function rectanglesOverlap(left, right) {
    return left.x < right.x + NODE.width
      && left.x + NODE.width > right.x
      && left.y < right.y + NODE.height
      && left.y + NODE.height > right.y;
  }

  function longestPathRanks(ids, outgoing, initialIndegree) {
    const indegree = new Map(initialIndegree);
    const ranks = new Map(ids.map((id) => [id, 0]));
    const queue = ids.filter((id) => indegree.get(id) === 0).sort();
    let visited = 0;
    while (queue.length) {
      const id = queue.shift();
      visited += 1;
      for (const dependent of outgoing.get(id)) {
        ranks.set(dependent, Math.max(ranks.get(dependent), ranks.get(id) + 1));
        indegree.set(dependent, indegree.get(dependent) - 1);
        if (indegree.get(dependent) === 0) {
          queue.push(dependent);
          queue.sort();
        }
      }
    }
    if (visited !== ids.length) {
      throw new Error("The Ticket graph contains a cycle and cannot be laid out.");
    }
    return ranks;
  }

  function minimizeCrossings(layers, predecessors, successors) {
    const indices = () => new Map(layers.flatMap((layer) =>
      layer.map((item, index) => [item.key, index])));
    for (let sweep = 0; sweep < LAYOUT.sweeps; sweep += 1) {
      const forward = sweep % 2 === 0;
      const layerIndices = forward
        ? Array.from({ length: layers.length - 1 }, (_, index) => index + 1)
        : Array.from({ length: layers.length - 1 }, (_, index) => layers.length - index - 2);
      for (const layerIndex of layerIndices) {
        const positions = indices();
        const neighbors = forward ? predecessors : successors;
        const previousOrder = new Map(
          layers[layerIndex].map((item, index) => [item.key, index]),
        );
        layers[layerIndex].sort((left, right) => {
          const leftMedian = median(neighbors.get(left.key), positions);
          const rightMedian = median(neighbors.get(right.key), positions);
          return compareNullable(leftMedian, rightMedian)
            || previousOrder.get(left.key) - previousOrder.get(right.key)
            || left.key.localeCompare(right.key);
        });
        transposeLayer(layers, layerIndex, predecessors, successors);
      }
    }
  }

  function median(neighbors, indices) {
    if (!neighbors?.length) return null;
    const values = neighbors
      .map((key) => indices.get(key))
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => left - right);
    if (!values.length) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2
      ? values[middle]
      : (values[middle - 1] + values[middle]) / 2;
  }

  function compareNullable(left, right) {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return left - right;
  }

  function transposeLayer(layers, layerIndex, predecessors, successors) {
    const layer = layers[layerIndex];
    if (layer.length < 2) return;
    let changed = true;
    let passes = 0;
    while (changed && passes < layer.length) {
      changed = false;
      passes += 1;
      for (let index = 0; index < layer.length - 1; index += 1) {
        const before = localCrossings(layers, layerIndex, predecessors, successors);
        [layer[index], layer[index + 1]] = [layer[index + 1], layer[index]];
        const after = localCrossings(layers, layerIndex, predecessors, successors);
        if (after < before) changed = true;
        else [layer[index], layer[index + 1]] = [layer[index + 1], layer[index]];
      }
    }
  }

  function localCrossings(layers, layerIndex, predecessors, successors) {
    const order = new Map(layers.flatMap((layer) =>
      layer.map((item, index) => [item.key, index])));
    let count = 0;
    if (layerIndex > 0) {
      const edges = layers[layerIndex].flatMap((item) =>
        predecessors.get(item.key).map((neighbor) => [neighbor, item.key]));
      count += inversionCount(edges, order);
    }
    if (layerIndex < layers.length - 1) {
      const edges = layers[layerIndex].flatMap((item) =>
        successors.get(item.key).map((neighbor) => [item.key, neighbor]));
      count += inversionCount(edges, order);
    }
    return count;
  }

  function inversionCount(edges, order) {
    let count = 0;
    for (let left = 0; left < edges.length; left += 1) {
      for (let right = left + 1; right < edges.length; right += 1) {
        const [leftFrom, leftTo] = edges[left];
        const [rightFrom, rightTo] = edges[right];
        if ((order.get(leftFrom) - order.get(rightFrom))
          * (order.get(leftTo) - order.get(rightTo)) < 0) {
          count += 1;
        }
      }
    }
    return count;
  }

  function relationPorts(relations, direction = "ltr", positions = new Map()) {
    const incoming = new Map();
    const outgoing = new Map();
    for (const relation of relations) {
      if (!incoming.has(relation.dependentTicketId)) incoming.set(relation.dependentTicketId, []);
      if (!outgoing.has(relation.prerequisiteTicketId)) outgoing.set(relation.prerequisiteTicketId, []);
      incoming.get(relation.dependentTicketId).push(relation);
      outgoing.get(relation.prerequisiteTicketId).push(relation);
    }
    const result = new Map(relations.map((relation) => [
      relation.relationRef,
      { source: 0, target: 0 },
    ]));
    const siblingCoordinate = (ticketId) => {
      const position = positions.get(ticketId);
      if (!position) return 0;
      return direction === "ttb" ? position.x : position.y;
    };
    const assign = (groups, endpoint, otherId) => {
      for (const group of groups.values()) {
        group.sort((left, right) =>
          siblingCoordinate(otherId(left)) - siblingCoordinate(otherId(right))
          || otherId(left).localeCompare(otherId(right))
          || left.relationRef.localeCompare(right.relationRef));
        const baseSpacing = direction === "ttb" ? 14 : 11;
        const usableSpan = direction === "ttb"
          ? NODE.width - 28
          : NODE.height - 20;
        const spacing = group.length > 1
          ? Math.min(baseSpacing, usableSpan / (group.length - 1))
          : 0;
        group.forEach((relation, index) => {
          result.get(relation.relationRef)[endpoint] =
            (index - (group.length - 1) / 2) * spacing;
        });
      }
    };
    assign(incoming, "target", (relation) => relation.prerequisiteTicketId);
    assign(outgoing, "source", (relation) => relation.dependentTicketId);
    return result;
  }

  function routeRelations(relations, chains, itemByKey, itemPositions, ports, direction) {
    const leftToRight = direction !== "ttb";
    const gapGroups = new Map();
    for (const relation of relations) {
      const chain = chains.get(relation.relationRef);
      for (let index = 0; index < chain.length - 1; index += 1) {
        const gap = itemByKey.get(chain[index]).rank;
        if (!gapGroups.has(gap)) gapGroups.set(gap, []);
        const from = itemPositions.get(chain[index]);
        const to = itemPositions.get(chain[index + 1]);
        gapGroups.get(gap).push({
          ref: relation.relationRef,
          order: leftToRight
            ? (from.y + to.y) / 2
            : (from.x + to.x) / 2,
        });
      }
    }
    const laneByGap = new Map();
    for (const [gap, entries] of gapGroups) {
      entries.sort((left, right) => left.order - right.order || left.ref.localeCompare(right.ref));
      const laneSpacing = entries.length > 1
        ? Math.min(2.5, 72 / (entries.length - 1))
        : 0;
      entries.forEach((entry, index) => {
        laneByGap.set(
          `${gap}:${entry.ref}`,
          (index - (entries.length - 1) / 2) * laneSpacing,
        );
      });
    }

    const routes = new Map();
    for (const relation of relations) {
      const chain = chains.get(relation.relationRef);
      const source = itemPositions.get(chain[0]);
      const target = itemPositions.get(chain.at(-1));
      const port = ports.get(relation.relationRef) || { source: 0, target: 0 };
      const points = leftToRight
        ? [{ x: source.x + NODE.width + 7, y: source.y + NODE.height / 2 + port.source }]
        : [{ x: source.x + NODE.width / 2 + port.source, y: source.y + NODE.height + 7 }];
      for (let index = 0; index < chain.length - 1; index += 1) {
        const from = itemPositions.get(chain[index]);
        const to = itemPositions.get(chain[index + 1]);
        const gap = itemByKey.get(chain[index]).rank;
        const isTarget = index === chain.length - 2;
        const lane = laneByGap.get(`${gap}:${relation.relationRef}`) || 0;
        if (leftToRight) {
          const channel = (from.x + NODE.width + to.x) / 2 + lane;
          const destinationY = isTarget
            ? target.y + NODE.height / 2 + port.target
            : to.y + NODE.height / 2;
          points.push({ x: channel, y: points.at(-1).y });
          points.push({ x: channel, y: destinationY });
          points.push({ x: isTarget ? target.x - 2 : to.x + NODE.width / 2, y: destinationY });
        } else {
          const channel = (from.y + NODE.height + to.y) / 2 + lane;
          const destinationX = isTarget
            ? target.x + NODE.width / 2 + port.target
            : to.x + NODE.width / 2;
          points.push({ x: points.at(-1).x, y: channel });
          points.push({ x: destinationX, y: channel });
          points.push({ x: destinationX, y: isTarget ? target.y - 2 : to.y + NODE.height / 2 });
        }
      }
      const obstacles = [...itemByKey.values()]
        .filter((item) => item.real
          && item.ticketId !== relation.prerequisiteTicketId
          && item.ticketId !== relation.dependentTicketId)
        .map((item) => itemPositions.get(item.key));
      const compact = routeAroundCards(compactPoints(points), obstacles);
      const end = compact.at(-1);
      const arrow = leftToRight
        ? `M ${end.x - 7} ${end.y - 3.5} L ${end.x} ${end.y} L ${end.x - 7} ${end.y + 3.5} Z`
        : `M ${end.x - 3.5} ${end.y - 7} L ${end.x} ${end.y} L ${end.x + 3.5} ${end.y - 7} Z`;
      routes.set(relation.relationRef, Object.freeze({
        path: pathFromPoints(compact),
        arrow,
        handle: handlePoint(compact),
        points: compact,
        segments: pointSegments(compact),
      }));
    }
    return routes;
  }

  function routeAroundCards(points, obstacles) {
    if (!points.some((point, index) => index > 0
      && obstacles.some((obstacle) => segmentCrossesRectangle(points[index - 1], point, obstacle)))) {
      return points;
    }
    const start = points[0];
    const end = points.at(-1);
    const clearance = 12;
    const xs = [...new Set([
      start.x,
      end.x,
      ...obstacles.flatMap((item) => [item.x - clearance, item.x + NODE.width + clearance]),
    ])].sort((left, right) => left - right);
    const ys = [...new Set([
      start.y,
      end.y,
      ...obstacles.flatMap((item) => [item.y - clearance, item.y + NODE.height + clearance]),
    ])].sort((left, right) => left - right);
    const pointAt = (xIndex, yIndex) => ({ x: xs[xIndex], y: ys[yIndex] });
    const valid = (point) => !obstacles.some((item) => pointInsideRectangle(point, item));
    const startIndex = `${xs.indexOf(start.x)}:${ys.indexOf(start.y)}`;
    const endIndex = `${xs.indexOf(end.x)}:${ys.indexOf(end.y)}`;
    const best = new Map([[`${startIndex}:n`, 0]]);
    const previous = new Map();
    const queue = [{ key: `${startIndex}:n`, pointKey: startIndex, direction: "n", cost: 0 }];
    let finalKey = null;
    while (queue.length) {
      queue.sort((left, right) => left.cost - right.cost || left.key.localeCompare(right.key));
      const current = queue.shift();
      if (current.cost !== best.get(current.key)) continue;
      if (current.pointKey === endIndex) {
        finalKey = current.key;
        break;
      }
      const [xIndex, yIndex] = current.pointKey.split(":").map(Number);
      const from = pointAt(xIndex, yIndex);
      const neighbors = [
        [xIndex - 1, yIndex, "h"],
        [xIndex + 1, yIndex, "h"],
        [xIndex, yIndex - 1, "v"],
        [xIndex, yIndex + 1, "v"],
      ];
      for (const [nextX, nextY, direction] of neighbors) {
        if (nextX < 0 || nextX >= xs.length || nextY < 0 || nextY >= ys.length) continue;
        const to = pointAt(nextX, nextY);
        if (!valid(to) || obstacles.some((item) => segmentCrossesRectangle(from, to, item))) continue;
        const pointKey = `${nextX}:${nextY}`;
        const key = `${pointKey}:${direction}`;
        const distance = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
        const bend = current.direction !== "n" && current.direction !== direction ? 24 : 0;
        const cost = current.cost + distance + bend;
        if (cost >= (best.get(key) ?? Number.POSITIVE_INFINITY)) continue;
        best.set(key, cost);
        previous.set(key, current.key);
        queue.push({ key, pointKey, direction, cost });
      }
    }
    if (!finalKey) return points;
    const result = [];
    for (let key = finalKey; key; key = previous.get(key)) {
      const [xIndex, yIndex] = key.split(":").map(Number);
      result.push(pointAt(xIndex, yIndex));
    }
    return compactPoints(result.reverse());
  }

  function pointInsideRectangle(point, rectangle) {
    return point.x > rectangle.x
      && point.x < rectangle.x + NODE.width
      && point.y > rectangle.y
      && point.y < rectangle.y + NODE.height;
  }

  function segmentCrossesRectangle(from, to, rectangle) {
    const epsilon = 0.001;
    if (Math.abs(from.y - to.y) < epsilon) {
      return from.y > rectangle.y + epsilon
        && from.y < rectangle.y + NODE.height - epsilon
        && Math.max(from.x, to.x) > rectangle.x + epsilon
        && Math.min(from.x, to.x) < rectangle.x + NODE.width - epsilon;
    }
    if (Math.abs(from.x - to.x) < epsilon) {
      return from.x > rectangle.x + epsilon
        && from.x < rectangle.x + NODE.width - epsilon
        && Math.max(from.y, to.y) > rectangle.y + epsilon
        && Math.min(from.y, to.y) < rectangle.y + NODE.height - epsilon;
    }
    return true;
  }

  function compactPoints(points) {
    const unique = points.filter((point, index) => index === 0
      || point.x !== points[index - 1].x
      || point.y !== points[index - 1].y);
    const compact = [];
    for (const point of unique) {
      const before = compact.at(-2);
      const previous = compact.at(-1);
      if (before && previous
        && ((before.x === previous.x && previous.x === point.x)
          || (before.y === previous.y && previous.y === point.y))) {
        compact[compact.length - 1] = point;
      } else {
        compact.push(point);
      }
    }
    return compact;
  }

  function pathFromPoints(points) {
    if (!points.length) return "";
    return points.slice(1).reduce((path, point, index) => {
      const previous = points[index];
      if (point.y === previous.y) return `${path} H ${point.x}`;
      if (point.x === previous.x) return `${path} V ${point.y}`;
      return `${path} L ${point.x} ${point.y}`;
    }, `M ${points[0].x} ${points[0].y}`);
  }

  function pointSegments(points) {
    return points.slice(1).map((point, index) => ({
      x1: points[index].x,
      y1: points[index].y,
      x2: point.x,
      y2: point.y,
    }));
  }

  function handlePoint(points) {
    if (points.length < 2) return points[0] || { x: 0, y: 0 };
    const end = points.at(-1);
    const before = points.at(-2);
    return {
      x: end.x + (before.x - end.x) * 0.45,
      y: end.y + (before.y - end.y) * 0.45,
    };
  }

  globalThis.VibeHubGraphLayout = Object.freeze({
    LAYOUT,
    NODE,
    layoutGraph,
    pointSegments,
  });
})();
