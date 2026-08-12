#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { denseGraphFixtures } from "../test/fixtures/dense-graph-fixtures.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP_PATH = "skills/vibehub-ticket-review/assets/app.js";
const VIEWPORTS = Object.freeze([
  { width: 1440, height: 960 },
  { width: 1180, height: 820 },
]);

function gitShow(ref, path) {
  const result = spawnSync("git", ["show", `${ref}:${path}`], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Unable to read ${ref}:${path}`);
  }
  return result.stdout;
}

function functionSource(source, name) {
  const marker = `  function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Baseline function ${name} is missing`);
  const next = source.indexOf("\n  function ", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next).trim();
}

function baselineModel(ref, direction) {
  const source = gitShow(ref, APP_PATH);
  const layoutName = direction === "ttb" && ref === "v0.7.0"
    ? "layoutGraphTopToBottom"
    : "layoutGraph";
  const names = [layoutName, "barycenter", "relationPorts", "edgeGeometry", "stableLane"];
  const declarations = names.map((name) => functionSource(source, name)).join("\n\n");
  const create = new Function(`
    const NODE = { width: 232, height: 96 };
    const LAYOUT = { marginX: 84, marginY: 72, columnGap: 52, rowGap: 108, sweeps: 5 };
    const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
    ${declarations}
    return {
      layout(tickets, relations) {
        return ${layoutName}(tickets, relations${layoutName === "layoutGraph" ? `, "${direction}"` : ""});
      },
      ports(relations) {
        return relationPorts(relations${ref === "v0.7.0" ? "" : `, "${direction}"`});
      },
      edge(from, to, relationRef, ports) {
        return edgeGeometry(from, to, relationRef, ports${ref === "v0.7.0" ? "" : `, "${direction}"`});
      },
    };
  `);
  return create();
}

function currentModel() {
  const source = readFileSync(resolve(
    ROOT,
    "skills/vibehub-ticket-review/assets/app-layout.js",
  ), "utf8");
  const sandbox = {};
  sandbox.globalThis = sandbox;
  runInNewContext(source, sandbox, { filename: "app-layout.js" });
  return sandbox.VibeHubGraphLayout;
}

function baselineLayout(fixture, direction, ref) {
  const model = baselineModel(ref, direction);
  const positions = model.layout(fixture.tickets, fixture.relations);
  const ports = model.ports(fixture.relations);
  const routes = new Map();
  for (const relation of fixture.relations) {
    const from = positions.get(relation.prerequisiteTicketId);
    const to = positions.get(relation.dependentTicketId);
    const geometry = model.edge(
      from,
      to,
      relation.relationRef,
      ports.get(relation.relationRef),
    );
    routes.set(relation.relationRef, {
      ...geometry,
      segments: pathSegments(geometry.path),
    });
  }
  return { positions, routes };
}

function pathSegments(path) {
  const tokens = path.match(/[MHVL]|-?\d+(?:\.\d+)?/gu) || [];
  const segments = [];
  let index = 0;
  let point = { x: 0, y: 0 };
  while (index < tokens.length) {
    const command = tokens[index++];
    const next = { ...point };
    if (command === "M" || command === "L") {
      next.x = Number(tokens[index++]);
      next.y = Number(tokens[index++]);
    } else if (command === "H") next.x = Number(tokens[index++]);
    else if (command === "V") next.y = Number(tokens[index++]);
    else throw new Error(`Unsupported path token ${command}`);
    if (command !== "M") {
      segments.push({ x1: point.x, y1: point.y, x2: next.x, y2: next.y });
    }
    point = next;
  }
  return segments;
}

function bounds(positions, node) {
  const values = [...positions.values()];
  const minX = Math.min(...values.map((item) => item.x));
  const minY = Math.min(...values.map((item) => item.y));
  const maxX = Math.max(...values.map((item) => item.x + node.width));
  const maxY = Math.max(...values.map((item) => item.y + node.height));
  return { width: maxX - minX, height: maxY - minY };
}

function frameScale(layout, viewport, node) {
  const graph = bounds(layout.positions, node);
  const padding = 58;
  const fit = Math.min(
    (viewport.width - padding * 2) / graph.width,
    (viewport.height - padding * 2) / graph.height,
  );
  return Math.min(1, Math.max(0.12, Math.max(fit, 0.64)));
}

function routeMetrics(routes, scale) {
  const entries = [...routes.entries()];
  let crossings = 0;
  let coincidentLength = 0;
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      let routesCross = false;
      for (const first of entries[left][1].segments) {
        for (const second of entries[right][1].segments) {
          routesCross ||= perpendicularCrossing(first, second);
          coincidentLength += coincidentOverlap(first, second) * scale;
        }
      }
      crossings += routesCross ? 1 : 0;
    }
  }
  return {
    crossings,
    coincidentLength: Number(coincidentLength.toFixed(2)),
  };
}

function perpendicularCrossing(first, second) {
  const firstHorizontal = first.y1 === first.y2;
  const secondHorizontal = second.y1 === second.y2;
  if (firstHorizontal === secondHorizontal) return false;
  const horizontal = firstHorizontal ? first : second;
  const vertical = firstHorizontal ? second : first;
  const minX = Math.min(horizontal.x1, horizontal.x2);
  const maxX = Math.max(horizontal.x1, horizontal.x2);
  const minY = Math.min(vertical.y1, vertical.y2);
  const maxY = Math.max(vertical.y1, vertical.y2);
  return vertical.x1 > minX && vertical.x1 < maxX
    && horizontal.y1 > minY && horizontal.y1 < maxY;
}

function coincidentOverlap(first, second) {
  const firstHorizontal = first.y1 === first.y2;
  const secondHorizontal = second.y1 === second.y2;
  if (firstHorizontal !== secondHorizontal) return 0;
  if (firstHorizontal) {
    if (first.y1 !== second.y1) return 0;
    return overlapLength(first.x1, first.x2, second.x1, second.x2);
  }
  if (first.x1 !== second.x1) return 0;
  return overlapLength(first.y1, first.y2, second.y1, second.y2);
}

function overlapLength(firstStart, firstEnd, secondStart, secondEnd) {
  return Math.max(0,
    Math.min(Math.max(firstStart, firstEnd), Math.max(secondStart, secondEnd))
      - Math.max(Math.min(firstStart, firstEnd), Math.min(secondStart, secondEnd)));
}

export function measureDenseLayouts() {
  const current = currentModel();
  const comparisons = [];
  for (const direction of ["ltr", "ttb"]) {
    const ref = direction === "ttb" ? "v0.7.0" : "edf4140";
    for (const fixture of denseGraphFixtures) {
      const baseline = baselineLayout(fixture, direction, ref);
      const optimized = current.layoutGraph(fixture.tickets, fixture.relations, direction);
      for (const viewport of VIEWPORTS) {
        comparisons.push({
          direction,
          fixture: fixture.name,
          viewport: `${viewport.width}x${viewport.height}`,
          baselineRef: ref,
          baseline: routeMetrics(
            baseline.routes,
            frameScale(baseline, viewport, current.NODE),
          ),
          optimized: routeMetrics(
            optimized.routes,
            frameScale(optimized, viewport, current.NODE),
          ),
        });
      }
    }
  }
  const aggregate = comparisons.reduce((result, item) => {
    result.baseline.crossings += item.baseline.crossings;
    result.baseline.coincidentLength += item.baseline.coincidentLength;
    result.optimized.crossings += item.optimized.crossings;
    result.optimized.coincidentLength += item.optimized.coincidentLength;
    return result;
  }, {
    baseline: { crossings: 0, coincidentLength: 0 },
    optimized: { crossings: 0, coincidentLength: 0 },
  });
  aggregate.baseline.coincidentLength = Number(aggregate.baseline.coincidentLength.toFixed(2));
  aggregate.optimized.coincidentLength = Number(aggregate.optimized.coincidentLength.toFixed(2));
  const reduction = {
    crossings: percentageReduction(
      aggregate.baseline.crossings,
      aggregate.optimized.crossings,
    ),
    coincidentLength: percentageReduction(
      aggregate.baseline.coincidentLength,
      aggregate.optimized.coincidentLength,
    ),
  };
  return { viewports: VIEWPORTS, comparisons, aggregate, reduction };
}

function percentageReduction(baseline, optimized) {
  if (baseline === 0) return optimized === 0 ? 100 : Number.NEGATIVE_INFINITY;
  return Number((((baseline - optimized) / baseline) * 100).toFixed(2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(measureDenseLayouts(), null, 2)}\n`);
}
