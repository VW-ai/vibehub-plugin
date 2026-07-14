/**
 * menubar-derive rollup tests (m5, S3 gate) — the pure MapSnapshot →
 * MenubarSummary rollup: counts, zeros-hidden, badge cap, oldest-first
 * interleave (waiting × conflict), conflict-pair-as-one-row, staleness,
 * overflow copy, and the N=0 quiet line.
 *
 * rev-2 (Wayne verdict ⑦, decision-workbench-003): the badge counts waiting
 * tasks + conflict PAIRS (a pair counts once); its tip enumerates both
 * ("1 waiting · 1 conflict"). Changed assertions from the iter-20 suite:
 * busy badge 1→2; stale badge 1→2 (still gray/static); flood exact 143→145;
 * the "conflict-only never shows a badge" case now DOES show a badge.
 */
import { describe, expect, it } from "vitest";
import type { MapSnapshot, Task } from "@vibehub/core/contracts";
import { BADGE_CAP, MAX_NEEDS_YOU_ROWS, deriveMenubar, deskClock } from "../../src/menubar-derive";
import {
  menubarFixtures,
  menubarFlood,
  menubarOverload,
  menubarQuiet,
  menubarStale,
  v8Baseline,
} from "../fixtures";

/* ── synthetic scaffolding for targeted cases ───────────────────────────── */

const CAP = "2026-07-12T10:22:00-07:00";
const CAP_MS = Date.parse(CAP);
const minsAgo = (m: number) => new Date(CAP_MS - m * 60_000).toISOString();

function task(id: string, state: Task["state"], sinceMin: number): Task {
  return {
    id,
    title: `Task ${id}`,
    state,
    signalTier: "hooks",
    conflictIds: [],
    scopes: [],
    git: { branch: `vibehub/${id}` },
    stateSince: minsAgo(sinceMin),
    lastEventAt: minsAgo(sinceMin),
  };
}

function fixture(partial: Partial<MapSnapshot>): MapSnapshot {
  return {
    capturedAt: CAP,
    repo: { slug: "acme/demo", defaultBranch: "main", branchCount: 3 },
    sync: { lastFetchAt: minsAgo(1), lastHookEventAt: minsAgo(1), stale: false },
    tasks: [],
    territories: [
      {
        id: "t-x",
        name: "Exports",
        anchoredFileCount: 9,
        subBlocks: [{ id: "s-x", name: "CSV writer", anchoredFileCount: 3 }],
      },
    ],
    occupancy: [],
    conflicts: [],
    ...partial,
  };
}

/* ── busy (v8Baseline verbatim) ─────────────────────────────────────────── */

describe("busy = v8Baseline", () => {
  const s = deriveMenubar(v8Baseline);

  it("counts + stat pills match the map titlebar (1 waiting · 1 conflict · 3 running)", () => {
    expect(s.stats.map((x) => x.text)).toEqual(["1 waiting", "1 conflict", "3 running"]);
    // rev-2 verdict ⑦: badge = waiting + conflict pairs = 2 (was 1)
    expect(s.badge).not.toBeNull();
    expect(s.badge!.text).toBe("2");
    expect(s.badge!.exact).toBe(2);
    expect(s.badge!.tip).toBe("1 waiting · 1 conflict need you");
    expect(s.badge!.stale).toBe(false);
    expect(s.quiet).toBeNull();
    expect(s.staleNote).toBeNull();
    expect(s.fresh).toEqual({
      text: "Synced 42s ago",
      tip: "Last git fetch + hook event",
      stale: false,
    });
  });

  it("needs-you: waiting task + the conflict pair as ONE subject-labeled row", () => {
    expect(s.needsYou.total).toBe(2);
    expect(s.needsYou.moreCount).toBe(0);
    expect(s.needsYou.moreText).toBeNull();
    const [r1, r2] = s.needsYou.rows;
    // waiting 12m is OLDER as a decision than the conflict detected 8m ago
    expect(r1).toMatchObject({ kind: "waiting", pillText: "WAITING", age: "12m" });
    expect(r1!.title).toBe("Refactor auth flow");
    // conflict age basis = detectedAt (10:13:40 → 8m), NOT the older writer's 31m
    expect(r2).toMatchObject({ kind: "conflict", pillText: "CONFLICT", age: "8m" });
    expect(r2!.title).toBe("Order state machine — 2 writing");
    expect(r2!.tip).toContain("'Auto-retry failed payments' and 'Cancel orders on timeout'");
    expect(r2!.tip).toContain("3 shared symbols");
  });

  it("item tip enumerates both needs-you kinds (rev-2 verdict ⑦)", () => {
    expect(s.itemTip).toBe("Vibehub — 1 waiting · 1 conflict need you.");
  });

  it("a single waiting task and nothing else keeps the always-watching promise", () => {
    const s1 = deriveMenubar(fixture({ tasks: [task("w", "waiting", 3)] }));
    expect(s1.itemTip).toBe(
      "Vibehub — 1 task waiting on you. The app keeps watching from here even when the window is closed.",
    );
    expect(s1.badge!.tip).toBe("1 waiting needs you");
  });
});

/* ── oldest-first interleave across kinds ───────────────────────────────── */

describe("needs-you ordering", () => {
  it("a conflict detected BEFORE a task started waiting sorts first", () => {
    const fx = fixture({
      tasks: [
        task("w1", "waiting", 5),
        { ...task("a", "running", 40), conflictIds: ["c1"] },
        { ...task("b", "running", 20), conflictIds: ["c1"] },
      ],
      conflicts: [
        {
          id: "c1",
          taskIds: ["a", "b"],
          territoryId: "t-x",
          subBlockId: "s-x",
          sharedSymbols: ["CsvWriter.write"],
          severity: "red",
          detectedAt: minsAgo(15),
        },
      ],
    });
    const rows = deriveMenubar(fx).needsYou.rows;
    expect(rows.map((r) => r.kind)).toEqual(["conflict", "waiting"]);
    expect(rows[0]!.age).toBe("15m");
    expect(rows[0]!.title).toBe("CSV writer — 2 writing");
    expect(rows[0]!.tip).toContain("1 shared symbol)");
  });

  it("conflict without a sub-block falls back to the territory name", () => {
    const fx = fixture({
      tasks: [
        { ...task("a", "running", 30), conflictIds: ["c2"] },
        { ...task("b", "running", 10), conflictIds: ["c2"] },
      ],
      conflicts: [
        {
          id: "c2",
          taskIds: ["a", "b"],
          territoryId: "t-x",
          sharedSymbols: ["exportAll", "EXPORT_DIR"],
          severity: "yellow",
          detectedAt: minsAgo(4),
        },
      ],
    });
    const s = deriveMenubar(fx);
    expect(s.needsYou.rows[0]!.title).toBe("Exports — 2 writing");
    // rev-2 verdict ⑦ (REVOKES iter-20): a conflict-only state DOES badge —
    // the pair counts once, and the tip names what kind of attention it is
    expect(s.badge).toMatchObject({ text: "1", exact: 1, stale: false });
    expect(s.badge!.tip).toBe("1 conflict needs you");
    // the item tip and stats surface it too (never quiet)
    expect(s.quiet).toBeNull();
    expect(s.stats.map((x) => x.kind)).toEqual(["clash", "alive"]);
    expect(s.itemTip).toBe("Vibehub — 1 conflict needs adjudication.");
  });
});

/* ── quiet ──────────────────────────────────────────────────────────────── */

describe("quiet", () => {
  it("no badge, only the alive stat, honest all-quiet line", () => {
    const s = deriveMenubar(menubarQuiet);
    expect(s.badge).toBeNull();
    expect(s.stats.map((x) => x.text)).toEqual(["3 running"]);
    expect(s.needsYou.total).toBe(0);
    expect(s.needsYou.rows).toEqual([]);
    expect(s.quiet!.text).toBe("All quiet — 3 running, nothing needs you.");
    expect(s.fresh.text).toBe("Synced 18s ago");
    expect(s.itemTip).toBe("Vibehub — all quiet. 3 sessions running, nothing needs you.");
  });

  it("true N=0 (nothing running either) stays honest, zero stats rendered", () => {
    const s = deriveMenubar(fixture({ tasks: [task("d", "done", 60)] }));
    expect(s.stats).toEqual([]);
    expect(s.badge).toBeNull();
    expect(s.quiet!.text).toBe("All quiet — nothing running, nothing needs you.");
    expect(s.itemTip).toContain("No sessions running");
  });
});

/* ── stale (decision-github-002 honesty) ────────────────────────────────── */

describe("stale", () => {
  const s = deriveMenubar(menubarStale);

  it("badge keeps the last-known count (waiting + pair) but is marked stale (gray/static)", () => {
    // rev-2 verdict ⑦: 1 waiting + 1 conflict pair = 2 (was 1)
    expect(s.badge).toMatchObject({ text: "2", exact: 2, stale: true });
    expect(s.badge!.tip).toContain("Last known: 1 waiting · 1 conflict");
    expect(s.badge!.tip).toContain("47m");
  });

  it("freshness + honesty note label the two channels, counts unchanged", () => {
    expect(s.fresh).toMatchObject({ text: "Synced 47m ago", stale: true });
    expect(s.staleNote!.text).toBe(
      "Showing last known repo state — sessions still report via hooks. Open Vibehub to sync.",
    );
    expect(s.staleNote!.tip).toContain("hooks");
    expect(s.stats.map((x) => x.text)).toEqual(["1 waiting", "1 conflict", "3 running"]);
    expect(s.itemTip).toContain("last known: 1 waiting · 1 conflict");
  });

  it("never-fetched repos are stale by construction", () => {
    const s0 = deriveMenubar(
      fixture({ sync: { lastFetchAt: null, lastHookEventAt: null, stale: true } }),
    );
    expect(s0.fresh).toMatchObject({ text: "Never synced", stale: true });
  });
});

/* ── overload / flood: caps + overflow copy ─────────────────────────────── */

describe("overload ×12", () => {
  const s = deriveMenubar(menubarOverload);

  it("top-3 oldest first, remainder collapses to the waiting-only copy", () => {
    expect(s.needsYou.total).toBe(12);
    expect(s.needsYou.rows).toHaveLength(MAX_NEEDS_YOU_ROWS);
    expect(s.needsYou.rows.map((r) => r.age)).toEqual(["52m", "47m", "41m"]);
    expect(s.needsYou.rows[0]!.title).toBe(
      "Reconcile invoice line items against the payments ledger export",
    );
    expect(s.needsYou.moreCount).toBe(9);
    expect(s.needsYou.moreText).toBe("and 9 more waiting…");
    expect(s.badge!.text).toBe("12");
    expect(s.stats.map((x) => x.text)).toEqual(["12 waiting", "5 running"]);
  });
});

describe("flood 99+", () => {
  const s = deriveMenubar(menubarFlood);

  it("badge caps at 99+ with the exact waiting+pair count preserved", () => {
    // rev-2 verdict ⑦: 143 waiting + 2 conflict pairs = 145
    expect(s.badge).toMatchObject({ text: "99+", exact: 145, stale: false });
    expect(s.badge!.tip).toContain("143 waiting · 2 conflicts");
    expect(s.itemTip).toBe(
      "Vibehub — 143 waiting · 2 conflicts (the badge caps at 99+).",
    );
  });

  it("needs-you 145 (143 waiting + 2 conflict pairs), generic overflow copy", () => {
    expect(s.needsYou.total).toBe(145);
    expect(s.needsYou.moreCount).toBe(142);
    // a conflict hides below the fold → NOT the waiting-only phrasing
    expect(s.needsYou.moreText).toBe("and 142 more…");
    // one-unit age rule (derive.ts): 104m → 2h, 72m → 1h — never "1h44m"
    expect(s.needsYou.rows.map((r) => r.age)).toEqual(["2h", "1h", "58m"]);
    expect(s.needsYou.rows.map((r) => r.kind)).toEqual(["waiting", "conflict", "waiting"]);
    expect(s.needsYou.rows[1]!.title).toBe("Order state machine — 2 writing");
    expect(s.stats.map((x) => x.text)).toEqual(["143 waiting", "2 conflicts", "31 running"]);
  });

  it("cap boundary: 99 renders plain, 100 caps", () => {
    const mk = (n: number) =>
      fixture({ tasks: Array.from({ length: n }, (_, i) => task(`w${i}`, "waiting", i + 1)) });
    expect(deriveMenubar(mk(BADGE_CAP)).badge!.text).toBe("99");
    expect(deriveMenubar(mk(BADGE_CAP + 1)).badge!.text).toBe("99+");
    expect(deriveMenubar(mk(BADGE_CAP + 1)).badge!.exact).toBe(BADGE_CAP + 1);
  });

  it("conflict pairs count toward the cap (98 waiting + 1 pair = 99; 99 + 1 caps)", () => {
    const mk = (n: number) =>
      fixture({
        tasks: [
          ...Array.from({ length: n }, (_, i) => task(`w${i}`, "waiting", i + 1)),
          { ...task("a", "running", 40), conflictIds: ["c1"] },
          { ...task("b", "running", 20), conflictIds: ["c1"] },
        ],
        conflicts: [
          {
            id: "c1",
            taskIds: ["a", "b"],
            territoryId: "t-x",
            subBlockId: "s-x",
            sharedSymbols: ["CsvWriter.write"],
            severity: "red",
            detectedAt: minsAgo(15),
          },
        ],
      });
    expect(deriveMenubar(mk(BADGE_CAP - 1)).badge).toMatchObject({
      text: "99",
      exact: BADGE_CAP,
    });
    const capped = deriveMenubar(mk(BADGE_CAP)).badge!;
    expect(capped.text).toBe("99+");
    expect(capped.exact).toBe(BADGE_CAP + 1);
    expect(capped.tip).toContain("99 waiting · 1 conflict");
  });
});

/* ── registry sanity + desk clock ───────────────────────────────────────── */

describe("registry + clock", () => {
  it("all five variants are registered and share the demo capturedAt", () => {
    expect(Object.keys(menubarFixtures)).toEqual([
      "busy",
      "quiet",
      "stale",
      "overload",
      "flood",
    ]);
    for (const fx of Object.values(menubarFixtures)) {
      expect(fx.capturedAt).toBe(v8Baseline.capturedAt);
      // generated task ids stay unique (deterministic fixtures cannot collide)
      expect(new Set(fx.tasks.map((t) => t.id)).size).toBe(fx.tasks.length);
    }
  });

  it("deskClock renders the ISO's own local parts, timezone-free", () => {
    expect(deskClock("2026-07-12T10:22:00-07:00")).toBe("Sun Jul 12  10:22");
    expect(deskClock("2026-01-01T09:05:00+02:00")).toBe("Thu Jan 1  09:05");
  });
});
