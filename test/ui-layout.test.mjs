import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { denseGraphFixtures } from "./fixtures/dense-graph-fixtures.mjs";

function loadLayoutModel() {
  const source = readFileSync(join(
    process.cwd(),
    "skills/vibehub-review/assets/app-layout.js",
  ), "utf8");
  const sandbox = {};
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: "app-layout.js" });
  return sandbox.VibeHubGraphLayout;
}

function overlaps(left, right, node) {
  return left.x < right.x + node.width
    && left.x + node.width > right.x
    && left.y < right.y + node.height
    && left.y + node.height > right.y;
}

function boundsOverlap(left, right) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function segmentCrossesCard(segment, position, node) {
  const epsilon = 0.001;
  const minX = Math.min(segment.x1, segment.x2);
  const maxX = Math.max(segment.x1, segment.x2);
  const minY = Math.min(segment.y1, segment.y2);
  const maxY = Math.max(segment.y1, segment.y2);
  if (Math.abs(segment.y1 - segment.y2) < epsilon) {
    return segment.y1 > position.y + epsilon
      && segment.y1 < position.y + node.height - epsilon
      && maxX > position.x + epsilon
      && minX < position.x + node.width - epsilon;
  }
  if (Math.abs(segment.x1 - segment.x2) < epsilon) {
    return segment.x1 > position.x + epsilon
      && segment.x1 < position.x + node.width - epsilon
      && maxY > position.y + epsilon
      && minY < position.y + node.height - epsilon;
  }
  return false;
}

test("ticket cards reserve breathing room above the bottom status row", () => {
  const model = loadLayoutModel();
  const renderer = readFileSync(join(
    process.cwd(),
    "skills/vibehub-review/assets/app.js",
  ), "utf8");
  assert.equal(model.NODE.width, 232);
  assert.equal(model.NODE.height, 104);
  assert.match(renderer, /y: NODE\.height - 12/u);
  assert.match(renderer, /y: NODE\.height - 10/u);
});

test("left-to-right history stubs leave the causal lane and keep an anchored leader", () => {
  const model = loadLayoutModel();
  const anchor = { x: 84, y: 160 };
  const dependent = { x: 424, y: 160 };
  const route = {
    segments: [{
      x1: anchor.x + model.NODE.width + 7,
      y1: anchor.y + model.NODE.height / 2,
      x2: dependent.x - 2,
      y2: dependent.y + model.NODE.height / 2,
    }],
  };
  const geometry = model.historyStubGeometry(
    anchor,
    "downstream",
    "ltr",
    [
      { ...anchor, ...model.NODE },
      { ...dependent, ...model.NODE },
    ],
    [route],
  );
  const bounds = { ...geometry.position, ...model.HISTORY_STUB };
  assert.equal(boundsOverlap(bounds, { ...anchor, ...model.NODE }), false);
  assert.equal(boundsOverlap(bounds, { ...dependent, ...model.NODE }), false);
  assert.equal(route.segments.some((segment) => segmentCrossesCard(
    segment,
    { x: bounds.x - 8, y: bounds.y - 8 },
    { width: bounds.width + 16, height: bounds.height + 16 },
  )), false);
  assert.equal(geometry.position.y > anchor.y + model.NODE.height, true);
  assert.equal(geometry.connector.path.startsWith("M "), true);
  assert.equal(geometry.connector.start.x, anchor.x + model.NODE.width + 7);
  assert.equal(geometry.connector.start.y, anchor.y + model.NODE.height / 2);
});

test("top-to-bottom history stubs choose a collision-free side deterministically", () => {
  const model = loadLayoutModel();
  const anchor = { x: 240, y: 72 };
  const blockers = [
    { ...anchor, ...model.NODE },
    { x: anchor.x + model.NODE.width + 18, y: 202, ...model.NODE },
  ];
  const route = {
    segments: [{
      x1: anchor.x + model.NODE.width / 2,
      y1: anchor.y + model.NODE.height + 7,
      x2: anchor.x + model.NODE.width / 2,
      y2: 360,
    }],
  };
  const first = model.historyStubGeometry(
    anchor,
    "downstream",
    "ttb",
    blockers,
    [route],
  );
  const second = model.historyStubGeometry(
    anchor,
    "downstream",
    "ttb",
    blockers,
    [route],
  );
  assert.deepEqual(first, second);
  const bounds = { ...first.position, ...model.HISTORY_STUB };
  assert.equal(blockers.some((item) => boundsOverlap(bounds, item)), false);
  assert.equal(route.segments.some((segment) => segmentCrossesCard(
    segment,
    { x: bounds.x - 8, y: bounds.y - 8 },
    { width: bounds.width + 16, height: bounds.height + 16 },
  )), false);
  assert.equal(first.position.x < anchor.x, true);
  assert.equal(first.connector.path.startsWith("M "), true);
});

test("dense fixtures cover wide layers, high-degree causality, long edges, and mixed states", () => {
  const allTickets = denseGraphFixtures.flatMap((fixture) => fixture.tickets);
  assert.equal(denseGraphFixtures.every((fixture) => fixture.tickets.length >= 35), true);
  assert.equal(new Set(allTickets.map((ticket) => ticket.fixtureState)).size, 5);
  assert.equal(
    new Set(allTickets.map((ticket) => ticket.fixtureAttention).filter(Boolean)).size,
    4,
  );
  const wide = denseGraphFixtures[0];
  assert.equal(wide.tickets.filter((ticket) => ticket.ticketId.startsWith("root-")).length, 10);
  assert.equal(wide.relations.filter((item) => item.dependentTicketId === "causal-hub").length, 5);
  assert.equal(wide.relations.filter((item) => item.prerequisiteTicketId === "causal-hub").length, 5);
});

for (const direction of ["ltr", "ttb"]) {
  test(`dense ${direction} layout is deterministic, non-overlapping, and routes around cards`, () => {
    const model = loadLayoutModel();
    for (const fixture of denseGraphFixtures) {
      const first = model.layoutGraph(fixture.tickets, fixture.relations, direction);
      const second = model.layoutGraph(fixture.tickets, fixture.relations, direction);
      assert.deepEqual(
        [...first.positions.entries()],
        [...second.positions.entries()],
        `${fixture.name} positions changed for stable input`,
      );
      assert.deepEqual(
        [...first.routes].map(([ref, route]) => [ref, route.path]),
        [...second.routes].map(([ref, route]) => [ref, route.path]),
        `${fixture.name} routes changed for stable input`,
      );

      const entries = [...first.positions.entries()];
      for (let left = 0; left < entries.length; left += 1) {
        for (let right = left + 1; right < entries.length; right += 1) {
          assert.equal(
            overlaps(entries[left][1], entries[right][1], model.NODE),
            false,
            `${fixture.name}: ${entries[left][0]} overlaps ${entries[right][0]}`,
          );
        }
      }
      for (const [relationRef, route] of first.routes) {
        const relation = fixture.relations.find((item) => item.relationRef === relationRef);
        for (const [ticketId, position] of entries) {
          if (ticketId === relation.prerequisiteTicketId
            || ticketId === relation.dependentTicketId) continue;
          assert.equal(
            route.segments.some((segment) => segmentCrossesCard(segment, position, model.NODE)),
            false,
            `${fixture.name}: ${relationRef} crosses ${ticketId}`,
          );
        }
      }
      const groupedSources = new Map();
      const groupedTargets = new Map();
      for (const relation of fixture.relations) {
        const port = first.ports.get(relation.relationRef);
        if (!groupedSources.has(relation.prerequisiteTicketId)) groupedSources.set(relation.prerequisiteTicketId, []);
        if (!groupedTargets.has(relation.dependentTicketId)) groupedTargets.set(relation.dependentTicketId, []);
        groupedSources.get(relation.prerequisiteTicketId).push(port.source);
        groupedTargets.get(relation.dependentTicketId).push(port.target);
      }
      for (const offsets of [...groupedSources.values(), ...groupedTargets.values()]) {
        assert.equal(new Set(offsets).size, offsets.length, `${fixture.name}: ports coincide`);
        const halfSide = direction === "ttb"
          ? model.NODE.width / 2
          : model.NODE.height / 2;
        assert.equal(
          offsets.every((offset) => Math.abs(offset) <= halfSide - 8),
          true,
          `${fixture.name}: a port escaped its card side`,
        );
      }
    }
  });

  test(`dense ${direction} history expansion preserves existing card coordinates`, () => {
    const model = loadLayoutModel();
    const fixture = denseGraphFixtures[0];
    const hiddenIds = new Set(["root-0", "root-1"]);
    const initialTickets = fixture.tickets.filter((ticket) => !hiddenIds.has(ticket.ticketId));
    const initialRelations = fixture.relations.filter((relation) =>
      !hiddenIds.has(relation.prerequisiteTicketId)
      && !hiddenIds.has(relation.dependentTicketId));
    const initial = model.layoutGraph(initialTickets, initialRelations, direction);
    const expanded = model.layoutGraph(
      fixture.tickets,
      fixture.relations,
      direction,
      { fixedPositions: initial.positions },
    );
    for (const [ticketId, position] of initial.positions) {
      assert.deepEqual(expanded.positions.get(ticketId), position, `${ticketId} moved`);
    }
    const entries = [...expanded.positions.entries()];
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        assert.equal(
          overlaps(entries[left][1], entries[right][1], model.NODE),
          false,
          `${entries[left][0]} overlaps ${entries[right][0]} after expansion`,
        );
      }
    }
    for (const [relationRef, route] of expanded.routes) {
      const relation = fixture.relations.find((item) => item.relationRef === relationRef);
      for (const [ticketId, position] of entries) {
        if (ticketId === relation.prerequisiteTicketId
          || ticketId === relation.dependentTicketId) continue;
        assert.equal(
          route.segments.some((segment) => segmentCrossesCard(segment, position, model.NODE)),
          false,
          `${relationRef} crosses ${ticketId} after expansion`,
        );
      }
    }
  });
}
