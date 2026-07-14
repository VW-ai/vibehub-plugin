/**
 * install-derive.ts — pure view-model derivations for the first-run screen.
 *
 * The centerpiece is the pre-mapping FOOTPRINT PACKING rule (iter-15 S2,
 * exercised in the `two-tasks` variant; DECISIONS-NEEDED fork "Pre-mapping
 * footprint packing rule"):
 *
 *   area fraction = clamp(filesTouched / repoFiles, FLOOR, CAP)
 *     - repoFiles = `git ls-files` count captured at connect — a mechanical
 *       git fact, no invented denominator.
 *     - FLOOR = S1's N=1 block (24% × 26% of the gray ≈ 6.24% area — the
 *       measured legibility minimum: the smallest block whose kicker + foot
 *       stay legible at 1280).
 *     - CAP = 60% area (the gray must visibly remain "the whole repo"
 *       while unmapped).
 *   Between the rungs the block scales from the floor block by
 *   sqrt(area ratio) in BOTH dimensions — size is a redundant channel
 *   (the count TEXT in the foot is the first channel, guideline 6), so
 *   sqrt damping is honest.
 *
 *   SHELF PACKING: bottom-left origin, launch order (oldest firstSeenAt
 *   first), left→right with 3% gutters, blocks bottom-aligned per shelf,
 *   wrap upward to a new shelf when the row is full.
 *
 *   OVERFLOW LADDER (N=many): all blocks shrink proportionally down to the
 *   floor (temporary shrink of others — sanctioned strategy), and once at
 *   floor the OLDEST collapse into a "+N earlier sessions" chip pinned
 *   bottom-right of the gray (collapse-to-+N — sanctioned strategy).
 *
 * Everything here is a pure function of (footprints, repoFiles, options):
 * deterministic, no Date.now(), no randomness — unit-tested in
 * install-derive.test.ts.
 */
import type { UncategorizedFootprint } from "@vibehub/core/contracts";
import { formatCount, exactCount } from "./derive";

/* ── options / constants (all measured from the approved S2 static) ─────── */

export interface PackInsets {
  /** % of territory kept clear on each edge (label band top, foot bottom). */
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PackOptions {
  /** Floor block dims, % of territory (S1's N=1 block: 24 × 26). */
  floorW: number;
  floorH: number;
  /** Area-fraction cap (0..1): the gray must stay visibly "the whole repo". */
  capFrac: number;
  /** Gutter between blocks and between shelves, % of territory. */
  gutter: number;
  insets: PackInsets;
}

/**
 * Defaults measured from the approved M0 first-run artifact: the N=1 block
 * sits at left 6%, bottom 84% (→ bottom inset 16), the S2 200-file block
 * tops out at 26% but the label band needs ~12%; right mirrors left.
 * Presentation constants, not signals — tunable, awaits the real layout
 * pass (same caveat as TerritoryLayout in types.ts).
 */
export const PACK_DEFAULTS: PackOptions = {
  floorW: 24,
  floorH: 26,
  capFrac: 0.6,
  gutter: 3,
  insets: { left: 6, right: 6, top: 12, bottom: 16 },
};

/** Floor area fraction implied by the floor dims (0.24 × 0.26 = 0.0624). */
export function floorFrac(o: PackOptions): number {
  return (o.floorW / 100) * (o.floorH / 100);
}

/* ── block sizing (clamp + sqrt damping) ────────────────────────────────── */

export interface BlockDims {
  width: number; // % of territory
  height: number; // % of territory
}

/**
 * Natural (pre-packing) dims of one footprint block:
 * clamp(filesTouched / repoFiles, floorFrac, capFrac), then scale the floor
 * block by sqrt(areaFrac / floorFrac) in both dimensions.
 * repoFiles <= 0 cannot happen for a connected repo (a git repo with zero
 * ls-files has nothing to edit); guarded to the floor for safety.
 */
export function footprintDims(
  filesTouched: number,
  repoFiles: number,
  opts: PackOptions = PACK_DEFAULTS,
): BlockDims {
  const fl = floorFrac(opts);
  const raw = repoFiles > 0 ? filesTouched / repoFiles : 0;
  const frac = Math.min(opts.capFrac, Math.max(fl, raw));
  const scale = Math.sqrt(frac / fl);
  return { width: opts.floorW * scale, height: opts.floorH * scale };
}

/* ── shelf packing + overflow ladder ────────────────────────────────────── */

/** One packed block, in % of the territory rect (CSS-ready). */
export interface PackedBlock {
  taskId: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FootprintPacking {
  /** Visible blocks, oldest first (launch order). */
  blocks: PackedBlock[];
  /**
   * The OLDEST footprints that no longer fit even with every block at the
   * floor — they collapse into the "+N earlier sessions" chip (pinned
   * bottom-right of the gray; rendering is S4's job). Oldest first.
   */
  collapsedTaskIds: string[];
}

interface Sized {
  fp: UncategorizedFootprint;
  natural: BlockDims;
}

/** Deterministic launch order: firstSeenAt ascending, taskId tiebreak. */
function launchOrder(a: UncategorizedFootprint, b: UncategorizedFootprint): number {
  const t = Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt);
  return t !== 0 ? t : a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
}

/**
 * Shrink interpolation: g=1 → natural dims, g=0 → floor dims (linear per
 * dimension, monotone in g — so the largest fitting g is well-defined and
 * binary-searchable). Blocks never go below the floor.
 */
function dimsAt(s: Sized, g: number, o: PackOptions): BlockDims {
  return {
    width: o.floorW + g * (s.natural.width - o.floorW),
    height: o.floorH + g * (s.natural.height - o.floorH),
  };
}

/**
 * One shelf-packing attempt at shrink factor g. Returns the packed rects,
 * or null when the blocks do not fit inside the insets.
 */
function tryPack(sized: Sized[], g: number, o: PackOptions): PackedBlock[] | null {
  const xMin = o.insets.left;
  const xMax = 100 - o.insets.right;
  const yTopLimit = o.insets.top;
  let baseline = 100 - o.insets.bottom; // bottom edge of the current shelf
  let x = xMin;
  let shelfMaxH = 0;
  const out: PackedBlock[] = [];
  for (const s of sized) {
    const d = dimsAt(s, g, o);
    if (d.width > xMax - xMin) return null; // wider than the region
    if (x > xMin && x + d.width > xMax) {
      // wrap upward to a new shelf
      baseline = baseline - shelfMaxH - o.gutter;
      x = xMin;
      shelfMaxH = 0;
    }
    if (baseline - d.height < yTopLimit) return null; // ran out of sky
    out.push({
      taskId: s.fp.taskId,
      left: x,
      top: baseline - d.height, // bottom-aligned per shelf
      width: d.width,
      height: d.height,
    });
    x += d.width + o.gutter;
    shelfMaxH = Math.max(shelfMaxH, d.height);
  }
  return out;
}

/**
 * THE packing rule. Pure + deterministic:
 *  1. sort oldest-first, size every block (clamp + sqrt damping);
 *  2. shelf-pack at natural size (g=1); if it fits, done;
 *  3. otherwise binary-search the largest shrink factor g ∈ [0,1] that
 *     fits (all blocks shrink together, none below the floor);
 *  4. if even g=0 (everything at the floor) does not fit, collapse the
 *     OLDEST footprint into the "+N earlier sessions" chip and retry.
 */
export function packFootprints(
  footprints: UncategorizedFootprint[],
  repoFiles: number,
  options?: Partial<PackOptions>,
): FootprintPacking {
  const o: PackOptions = { ...PACK_DEFAULTS, ...options };
  const ordered = [...footprints].sort(launchOrder);
  const sized: Sized[] = ordered.map((fp) => ({
    fp,
    natural: footprintDims(fp.filesTouched, repoFiles, o),
  }));

  const collapsedTaskIds: string[] = [];
  let live = sized;
  while (live.length > 0) {
    const atNatural = tryPack(live, 1, o);
    if (atNatural) return { blocks: atNatural, collapsedTaskIds };
    if (tryPack(live, 0, o)) {
      // fits somewhere between floor and natural — binary-search largest g
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 24; i++) {
        const mid = (lo + hi) / 2;
        if (tryPack(live, mid, o)) lo = mid;
        else hi = mid;
      }
      const packed = tryPack(live, lo, o);
      if (packed) return { blocks: packed, collapsedTaskIds };
    }
    // even all-at-floor does not fit → collapse the oldest, retry
    const oldest = live[0];
    if (oldest) collapsedTaskIds.push(oldest.fp.taskId);
    live = live.slice(1);
  }
  return { blocks: [], collapsedTaskIds };
}

/* ── small view helpers (text = first channel) ──────────────────────────── */

/**
 * Footprint foot line, e.g. "3 files · not yet mapped to features".
 * NUMBER-huge follows the ONE app rule (≥1000 abbreviates, exact in the
 * tooltip via exactCount) — iter-14 fork kept the threshold app-wide.
 */
export function footprintFootText(filesTouched: number): string {
  return `${formatCount(filesTouched)} file${filesTouched === 1 ? "" : "s"} · not yet mapped to features`;
}

/** Exact count for the tooltip, e.g. "1,204". */
export function footprintExactFiles(filesTouched: number): string {
  return exactCount(filesTouched);
}

/** The overflow chip label. n = collapsedTaskIds.length, n ≥ 1. */
export function collapsedChipText(n: number): string {
  return `+${formatCount(n)} earlier session${n === 1 ? "" : "s"}`;
}
