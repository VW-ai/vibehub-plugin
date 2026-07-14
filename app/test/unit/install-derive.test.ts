/**
 * Unit tests for the pre-mapping footprint packing engine (iter-15 rule,
 * install-derive.ts) — the loop's first pure-logic test surface.
 * Deterministic by construction: fixed timestamps, no Date.now().
 */
import { describe, expect, it } from "vitest";
import {
  PACK_DEFAULTS,
  collapsedChipText,
  floorFrac,
  footprintDims,
  footprintFootText,
  packFootprints,
  type PackedBlock,
} from "../../src/install-derive";
import type { UncategorizedFootprint } from "@vibehub/core/contracts";
import {
  installNineFootprints,
  installTinyRepo,
  installTwoTasks,
} from "../fixtures";

function fp(
  taskId: string,
  filesTouched: number,
  firstSeenAt: string,
): UncategorizedFootprint {
  return { taskId, filesTouched, firstSeenAt };
}

/** Region bounds from the default insets: x ∈ [6, 94], y ∈ [12, 84]. */
function expectInsideRegion(b: PackedBlock) {
  const { insets } = PACK_DEFAULTS;
  expect(b.left).toBeGreaterThanOrEqual(insets.left - 1e-6);
  expect(b.left + b.width).toBeLessThanOrEqual(100 - insets.right + 1e-6);
  expect(b.top).toBeGreaterThanOrEqual(insets.top - 1e-6);
  expect(b.top + b.height).toBeLessThanOrEqual(100 - insets.bottom + 1e-6);
}

function overlaps(a: PackedBlock, b: PackedBlock): boolean {
  return (
    a.left < b.left + b.width - 1e-6 &&
    b.left < a.left + a.width - 1e-6 &&
    a.top < b.top + b.height - 1e-6 &&
    b.top < a.top + a.height - 1e-6
  );
}

describe("footprintDims (clamp + sqrt damping)", () => {
  it("floor: a tiny fraction of a huge repo clamps to the 24×26 floor block", () => {
    // 3 of 40,000 files → 0.0075% ≪ the 6.24% floor
    expect(footprintDims(3, 40000)).toEqual({ width: 24, height: 26 });
    // the map fixtures' floor case: 3 of 640 = 0.47% < 6.24%
    expect(footprintDims(3, 640)).toEqual({ width: 24, height: 26 });
  });

  it("cap: touching most of a tiny repo clamps to 60% area (gray stays 'the whole repo')", () => {
    // 10 of 12 files = 83% raw → capped at 60%
    const d = footprintDims(10, 12);
    expect((d.width / 100) * (d.height / 100)).toBeCloseTo(0.6, 6);
    // floor aspect preserved (sqrt scaling in BOTH dimensions)
    expect(d.width / d.height).toBeCloseTo(24 / 26, 6);
  });

  it("sqrt damping between the rungs: area is linear in files, dims grow by sqrt", () => {
    // iter-15's worked example: 120 of ~640 files → ~18.75% area, ≈42%×45%
    const d120 = footprintDims(120, 640);
    expect((d120.width / 100) * (d120.height / 100)).toBeCloseTo(120 / 640, 6);
    expect(d120.width).toBeCloseTo(24 * Math.sqrt(120 / 640 / floorFrac(PACK_DEFAULTS)), 6);
    expect(d120.width).toBeCloseTo(41.6, 1);
    expect(d120.height).toBeCloseTo(45.1, 1);
    // doubling files doubles area ⇒ each dimension grows by sqrt(2)
    const d60 = footprintDims(60, 640);
    expect(d120.width / d60.width).toBeCloseTo(Math.SQRT2, 6);
    expect(d120.height / d60.height).toBeCloseTo(Math.SQRT2, 6);
  });
});

describe("packFootprints (shelf packing)", () => {
  it("N=1 degenerates to S1's block exactly: floor at bottom-left (6, 58)", () => {
    const r = packFootprints([fp("t1", 3, "2026-07-12T10:18:20-07:00")], 640);
    expect(r.collapsedTaskIds).toEqual([]);
    expect(r.blocks).toEqual([
      { taskId: "t1", left: 6, top: 58, width: 24, height: 26 },
    ]);
  });

  it("two-tasks: oldest first from bottom-left, 3% gutter, bottom-aligned on one shelf", () => {
    const r = packFootprints(installTwoTasks.footprints, 640);
    expect(r.collapsedTaskIds).toEqual([]);
    expect(r.blocks).toHaveLength(2);
    const [tracing, health] = r.blocks as [PackedBlock, PackedBlock];
    // launch order: request-tracing (11m ago) is OLDER than health (4m ago)
    expect(tracing.taskId).toBe("install-task-tracing");
    expect(health.taskId).toBe("install-task-health");
    // oldest starts at the bottom-left origin
    expect(tracing.left).toBeCloseTo(6, 6);
    expect(tracing.width).toBeCloseTo(41.6, 1);
    expect(tracing.height).toBeCloseTo(45.1, 1);
    // 3% gutter between blocks
    expect(health.left).toBeCloseTo(tracing.left + tracing.width + 3, 6);
    expect(health.width).toBe(24);
    // bottom-aligned per shelf: both bottoms on the 84% baseline
    expect(tracing.top + tracing.height).toBeCloseTo(84, 6);
    expect(health.top + health.height).toBeCloseTo(84, 6);
  });

  it("wraps upward to a new shelf when the row is full (4 floors → 3 + 1)", () => {
    const fps = [1, 2, 3, 4].map((i) =>
      fp(`t${i}`, 2, `2026-07-12T10:0${i}:00-07:00`),
    );
    const r = packFootprints(fps, 640);
    expect(r.collapsedTaskIds).toEqual([]);
    const bottoms = r.blocks.map((b) => b.top + b.height);
    // shelf 1: three floors bottom at 84; shelf 2: one floor at 84-26-3=55
    expect(bottoms.slice(0, 3)).toEqual([84, 84, 84]);
    expect(bottoms[3]).toBeCloseTo(55, 6);
    expect(r.blocks[3]!.left).toBe(6); // new shelf restarts at the left edge
  });

  it("shrinks all blocks together before collapsing anything (3 mid-size blocks)", () => {
    const fps = [1, 2, 3].map((i) =>
      fp(`t${i}`, 120, `2026-07-12T10:0${i}:00-07:00`),
    );
    const r = packFootprints(fps, 640);
    // they fit by shrinking — nobody collapses
    expect(r.collapsedTaskIds).toEqual([]);
    expect(r.blocks).toHaveLength(3);
    for (const b of r.blocks) {
      expectInsideRegion(b);
      // shrunk below natural (41.6) but never below the floor (24)
      expect(b.width).toBeGreaterThanOrEqual(24 - 1e-6);
      expect(b.width).toBeLessThan(41.6);
    }
  });

  it("overflow ladder: 9 floors → 6 visible, the 3 OLDEST collapse to the +N chip", () => {
    const r = packFootprints(installNineFootprints.footprints, 640);
    expect(r.blocks).toHaveLength(6);
    // the three oldest (launched first) are the ones collapsed
    expect(r.collapsedTaskIds).toEqual([
      "install-task-nine-0",
      "install-task-nine-1",
      "install-task-nine-2",
    ]);
    expect(collapsedChipText(r.collapsedTaskIds.length)).toBe("+3 earlier sessions");
    // survivors render oldest-first from the bottom-left
    expect(r.blocks[0]!.taskId).toBe("install-task-nine-3");
    for (const b of r.blocks) expectInsideRegion(b);
  });

  it("is deterministic and input-order independent", () => {
    const fps = installNineFootprints.footprints;
    const shuffled = [...fps].reverse();
    const a = packFootprints(fps, 640);
    const b = packFootprints(shuffled, 640);
    const c = packFootprints(fps, 640);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it("invariants hold on every fixture: inside the region, no pairwise overlap", () => {
    const cases: [UncategorizedFootprint[], number][] = [
      [installTwoTasks.footprints, 640],
      [installNineFootprints.footprints, 640],
      [installTinyRepo.footprints, 12], // cap block + near-floor block + shrink ladder
    ];
    for (const [fps, repoFiles] of cases) {
      const r = packFootprints(fps, repoFiles);
      for (const b of r.blocks) expectInsideRegion(b);
      for (let i = 0; i < r.blocks.length; i++)
        for (let j = i + 1; j < r.blocks.length; j++)
          expect(overlaps(r.blocks[i]!, r.blocks[j]!)).toBe(false);
      // visible + collapsed account for every footprint exactly once
      expect(r.blocks.length + r.collapsedTaskIds.length).toBe(fps.length);
    }
  });

  it("foot text follows the ONE app number rule (≥1000 abbreviates, exact separately)", () => {
    expect(footprintFootText(1)).toBe("1 file · not yet mapped to features");
    expect(footprintFootText(200)).toBe("200 files · not yet mapped to features");
    expect(footprintFootText(1204)).toBe("1.2k files · not yet mapped to features");
  });
});
