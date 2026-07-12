/**
 * Squarified treemap — the real layout pass that replaces the v8 hand-tuned
 * demoLayout (contract map-types.ts: "later replaced by a real layout
 * algorithm"; handoff: 蒸馏时算一次缓存).
 *
 * Classic Bruls / Huizing / van Wijk (2000): greedily fill rows along the
 * short side of the remaining rect, adding items while the row's WORST
 * aspect ratio keeps improving. Deterministic: ties keep input order after
 * the weight-descending sort.
 *
 * Pure geometry — no DB, no signals. Weights come from distillation facts
 * (anchoredFileCount); a non-positive weight is a caller bug, not a layout
 * case, so it throws.
 */
import type { DemoLayout } from "./contract/map-types.js";

export interface TreemapItem {
  id: string;
  /** Relative area, e.g. anchoredFileCount. Must be > 0. */
  weight: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Worst aspect ratio a row would have at side length `side`. */
function worstAspect(rowAreas: number[], side: number): number {
  const total = rowAreas.reduce((a, b) => a + b, 0);
  let worst = 1;
  for (const area of rowAreas) {
    // row thickness = total / side; item length = area / thickness
    const thickness = total / side;
    const length = area / thickness;
    const ratio = Math.max(thickness / length, length / thickness);
    if (ratio > worst) worst = ratio;
  }
  return worst;
}

/**
 * Squarified layout of `items` into `canvas` (same units in = out; the
 * fixture layer passes percent). Area of each rect is exactly proportional
 * to its weight. Returns rects keyed by item id.
 */
export function squarify(
  items: TreemapItem[],
  canvas: Rect,
): Map<string, Rect> {
  for (const it of items) {
    if (!(it.weight > 0)) {
      throw new Error(`treemap weight must be > 0 (${it.id}: ${it.weight})`);
    }
  }
  const out = new Map<string, Rect>();
  if (items.length === 0) return out;

  // normalize weights to canvas area, sort descending (stable)
  const canvasArea = canvas.width * canvas.height;
  const totalWeight = items.reduce((a, b) => a + b.weight, 0);
  const scaled = items
    .map((it, i) => ({ id: it.id, area: (it.weight / totalWeight) * canvasArea, i }))
    .sort((a, b) => b.area - a.area || a.i - b.i);

  let rest: Rect = { ...canvas };
  let row: typeof scaled = [];

  const layoutRow = (finalRow: typeof scaled): void => {
    const rowArea = finalRow.reduce((a, b) => a + b.area, 0);
    const horizontal = rest.width >= rest.height; // row fills the short side
    const side = horizontal ? rest.height : rest.width;
    const thickness = rowArea / side;
    let offset = 0;
    for (const item of finalRow) {
      const length = item.area / thickness;
      out.set(
        item.id,
        horizontal
          ? { left: rest.left, top: rest.top + offset, width: thickness, height: length }
          : { left: rest.left + offset, top: rest.top, width: length, height: thickness },
      );
      offset += length;
    }
    rest = horizontal
      ? { left: rest.left + thickness, top: rest.top, width: rest.width - thickness, height: rest.height }
      : { left: rest.left, top: rest.top + thickness, width: rest.width, height: rest.height - thickness };
  };

  for (const item of scaled) {
    const side = Math.min(rest.width, rest.height);
    const withItem = [...row, item];
    if (
      row.length === 0 ||
      worstAspect(withItem.map((r) => r.area), side) <=
        worstAspect(row.map((r) => r.area), side)
    ) {
      row = withItem;
    } else {
      layoutRow(row);
      row = [item];
    }
  }
  if (row.length > 0) layoutRow(row);
  return out;
}

/**
 * Territory layout in the map's coordinate language: percent rects inside
 * the canvas with a uniform gutter between blocks. Canvas margins and
 * gutter are PRESENTATION-ONLY choices (tunable; defaults eyeballed
 * against the v8 baseline's breathing room, no captured signal involved).
 */
export interface LayoutOptions {
  /** Outer margins, percent of canvas. */
  margin?: { left: number; top: number; right: number; bottom: number };
  /** Gutter between blocks, percent (applied as half-inset per side). */
  gapPct?: number;
}

export const DEFAULT_LAYOUT: Required<LayoutOptions> = {
  // v8's map keeps ~2% side margins and stops at 92.5% bottom (the legend
  // band rule in MapCanvas keys off exactly that line).
  margin: { left: 2, top: 4, right: 2, bottom: 7.5 },
  gapPct: 1,
};

export function layoutTerritories(
  items: TreemapItem[],
  opts: LayoutOptions = {},
): Map<string, DemoLayout> {
  const { margin, gapPct } = { ...DEFAULT_LAYOUT, ...opts };
  const canvas: Rect = {
    left: margin.left,
    top: margin.top,
    width: 100 - margin.left - margin.right,
    height: 100 - margin.top - margin.bottom,
  };
  const rects = squarify(items, canvas);
  const half = gapPct / 2;
  const out = new Map<string, DemoLayout>();
  for (const [id, r] of rects) {
    out.set(id, {
      left: r.left + half,
      top: r.top + half,
      width: Math.max(r.width - gapPct, 0),
      height: Math.max(r.height - gapPct, 0),
    });
  }
  return out;
}
