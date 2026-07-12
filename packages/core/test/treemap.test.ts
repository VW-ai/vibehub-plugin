import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAYOUT,
  layoutTerritories,
  squarify,
  type TreemapItem,
} from "../src/treemap.js";

const CANVAS = { left: 0, top: 0, width: 100, height: 60 };

const items = (weights: number[]): TreemapItem[] =>
  weights.map((w, i) => ({ id: `t${i}`, weight: w }));

function assertPartition(list: TreemapItem[], rects: Map<string, typeof CANVAS>): void {
  const total = list.reduce((a, b) => a + b.weight, 0);
  const canvasArea = CANVAS.width * CANVAS.height;
  // 1. every item got a rect, area exactly proportional to weight
  for (const it of list) {
    const r = rects.get(it.id)!;
    expect(r).toBeDefined();
    expect(r.width * r.height).toBeCloseTo((it.weight / total) * canvasArea, 6);
    // 2. inside the canvas
    expect(r.left).toBeGreaterThanOrEqual(CANVAS.left - 1e-9);
    expect(r.top).toBeGreaterThanOrEqual(CANVAS.top - 1e-9);
    expect(r.left + r.width).toBeLessThanOrEqual(CANVAS.left + CANVAS.width + 1e-9);
    expect(r.top + r.height).toBeLessThanOrEqual(CANVAS.top + CANVAS.height + 1e-9);
  }
  // 3. no pairwise overlap
  const all = [...rects.values()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i]!;
      const b = all[j]!;
      const overlapW = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
      const overlapH = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
      expect(Math.min(overlapW, overlapH)).toBeLessThanOrEqual(1e-9);
    }
  }
}

const worstRatio = (rects: Map<string, typeof CANVAS>): number =>
  Math.max(
    ...[...rects.values()].map((r) => Math.max(r.width / r.height, r.height / r.width)),
  );

describe("squarify", () => {
  it("partitions the canvas exactly, no overlaps (v8-ish 6 territories)", () => {
    const list = items([48, 31, 27, 18, 12, 9]);
    assertPartition(list, squarify(list, CANVAS));
  });

  it("single item fills the whole canvas", () => {
    const rects = squarify(items([7]), CANVAS);
    expect(rects.get("t0")).toEqual(CANVAS);
  });

  it("equal weights stay near-square (the algorithm's whole point)", () => {
    const rects = squarify(items(Array(9).fill(10)), CANVAS);
    // slice-and-dice would give 9 slivers of ratio 15; squarified stays tight
    expect(worstRatio(rects)).toBeLessThan(3);
  });

  it("handles the N=40 extreme without slivers exploding", () => {
    const list = items(Array.from({ length: 40 }, (_, i) => 5 + ((i * 7) % 23)));
    const rects = squarify(list, CANVAS);
    assertPartition(list, rects);
    expect(worstRatio(rects)).toBeLessThan(6);
  });

  it("survives extreme weight skew (100000 : 1)", () => {
    const list = items([100000, 1]);
    const rects = squarify(list, CANVAS);
    assertPartition(list, rects);
  });

  it("is deterministic, ties kept in input order", () => {
    const list = items([10, 10, 10]);
    const a = squarify(list, CANVAS);
    const b = squarify(list, CANVAS);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it("throws on non-positive weight (a caller bug, not a layout case)", () => {
    expect(() => squarify(items([5, 0]), CANVAS)).toThrow(/weight/);
    expect(() => squarify([{ id: "x", weight: -1 }], CANVAS)).toThrow(/weight/);
  });

  it("empty input → empty layout", () => {
    expect(squarify([], CANVAS).size).toBe(0);
  });
});

describe("layoutTerritories (percent + gutters)", () => {
  it("respects the v8 margins: nothing past 92.5% bottom, 2% sides", () => {
    const layout = layoutTerritories(items([48, 31, 27, 18, 12, 9]));
    for (const r of layout.values()) {
      expect(r.left).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.margin.left);
      expect(r.top).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.margin.top);
      expect(r.left + r.width).toBeLessThanOrEqual(100 - DEFAULT_LAYOUT.margin.right + 1e-9);
      expect(r.top + r.height).toBeLessThanOrEqual(92.5 + 1e-9); // legend band rule
    }
  });

  it("leaves a visible gutter between neighboring blocks", () => {
    const layout = layoutTerritories(items([10, 10]));
    const [a, b] = [...layout.values()];
    const gapX = Math.max(b!.left - (a!.left + a!.width), a!.left - (b!.left + b!.width));
    const gapY = Math.max(b!.top - (a!.top + a!.height), a!.top - (b!.top + b!.height));
    expect(Math.max(gapX, gapY)).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.gapPct - 1e-9);
  });
});
