/**
 * menubar-derive.ts (m5, S3) — the pure rollup MapSnapshot → MenubarSummary.
 *
 * HARD RULE (same as derive.ts): zero hardcoded CONTENT — everything shown
 * is snapshot data or a mechanical join of it. The only literals are UI copy
 * explaining state semantics (chrome, honest per LOOP.md guideline 4).
 *
 * Encoded S1 open questions (notes/menubar.md):
 *   1. No menubar snapshot shape — this file IS the reuse.
 *   4. "Needs you" ordering = waiting tasks and conflict subjects interleaved
 *      by age, OLDEST FIRST. Conflict age basis = detectedAt (when the pair
 *      started needing adjudication) — fork logged iter-20; the S1 static's
 *      hand-written "31m" used the older writer's runtime instead.
 */
import type { Conflict, MapSnapshot, Task } from "@vibehub/core/contracts";
import type {
  MenubarBadgeView,
  MenubarFreshView,
  MenubarStatView,
  MenubarSummary,
  NeedsYouRowView,
  NeedsYouView,
  StaleNoteView,
} from "./menubar-types";
import { clockTime, relAge } from "./derive";

/**
 * Badge cap (iter-19 fork, approved S1): the menubar item is the tiniest
 * surface in the product — three-digit-plus counts would stretch it into the
 * clock. Exact counts always travel in the tips.
 */
export const BADGE_CAP = 99;

/**
 * Row cap (approved S1): the dropdown stays glanceable and never scrolls —
 * the full list is the main window's job.
 */
export const MAX_NEEDS_YOU_ROWS = 3;

/* ── needs-you rows ─────────────────────────────────────────────────────── */

function waitingRow(t: Task, fx: MapSnapshot): NeedsYouRowView {
  const age = relAge(t.stateSince, fx.capturedAt);
  const detail = t.statusDetail ?? "stopped and needs your input.";
  return {
    key: t.id,
    kind: "waiting",
    pill: "need",
    pillText: "WAITING",
    title: t.title,
    age,
    basisIso: t.stateSince,
    tip: `'${t.title}' — ${detail} Waiting ${age} — opens the main window at this task.`,
  };
}

/** The contested subject: sub-block name, else territory name, else the id. */
function conflictSubject(c: Conflict, fx: MapSnapshot): string {
  const terr = fx.territories.find((t) => t.id === c.territoryId);
  if (!terr) return c.territoryId;
  if (c.subBlockId) {
    const sub = terr.subBlocks.find((b) => b.id === c.subBlockId);
    if (sub) return sub.name;
  }
  return terr.name;
}

function conflictRow(c: Conflict, fx: MapSnapshot): NeedsYouRowView {
  const subject = conflictSubject(c, fx);
  const [a, b] = c.taskIds.map(
    (id) => fx.tasks.find((t) => t.id === id)?.title ?? id,
  );
  const n = c.sharedSymbols.length;
  return {
    key: c.id,
    kind: "conflict",
    pill: "clash",
    pillText: "CONFLICT",
    // v8's own .sub.clash copy: the pair is ONE row named by its subject.
    title: `${subject} — ${c.taskIds.length} writing`,
    age: relAge(c.detectedAt, fx.capturedAt),
    basisIso: c.detectedAt,
    tip: `'${a}' and '${b}' both declared writes on ${subject} (${n} shared symbol${n === 1 ? "" : "s"}). Opens the adjudication card.`,
  };
}

function needsYou(fx: MapSnapshot): NeedsYouView {
  const rows: NeedsYouRowView[] = [
    ...fx.tasks.filter((t) => t.state === "waiting").map((t) => waitingRow(t, fx)),
    ...fx.conflicts.map((c) => conflictRow(c, fx)),
  ].sort(
    // Oldest first; ties break by key for determinism.
    (x, y) =>
      Date.parse(x.basisIso) - Date.parse(y.basisIso) ||
      x.key.localeCompare(y.key),
  );
  const top = rows.slice(0, MAX_NEEDS_YOU_ROWS);
  const hidden = rows.slice(MAX_NEEDS_YOU_ROWS);
  const moreCount = hidden.length;
  const allWaiting = hidden.every((r) => r.kind === "waiting");
  return {
    total: rows.length,
    rows: top,
    moreCount,
    moreText:
      moreCount === 0
        ? null
        : allWaiting
          ? `and ${moreCount} more waiting…`
          : `and ${moreCount} more…`,
    moreTip:
      moreCount === 0
        ? null
        : allWaiting
          ? `${moreCount} more task${moreCount === 1 ? " is" : "s are"} waiting on you — opens the main window at the full Needs-you list`
          : `${moreCount} more items need you — opens the main window at the full Needs-you list`,
  };
}

/* ── counts (zeros hidden — iter-14) ────────────────────────────────────── */

function stats(
  waiting: number,
  conflicts: number,
  running: number,
): MenubarStatView[] {
  const out: MenubarStatView[] = [];
  if (waiting > 0)
    out.push({
      kind: "need",
      text: `${waiting} waiting`,
      tip:
        waiting === 1
          ? "One task is waiting on your input — opens the main window at it"
          : `${waiting} tasks are waiting on your input — opens the main window at the list`,
    });
  if (conflicts > 0)
    out.push({
      kind: "clash",
      text: `${conflicts} conflict${conflicts === 1 ? "" : "s"}`,
      tip:
        conflicts === 1
          ? "Two tasks are writing the same symbol — opens the conflict"
          : `${conflicts} symbol conflicts between concurrent writers — opens the oldest`,
    });
  if (running > 0)
    out.push({
      kind: "alive",
      text: `${running} running`,
      tip: "Tasks making progress. Nothing needed from you",
    });
  return out;
}

/* ── freshness / staleness ──────────────────────────────────────────────── */

function fetchAge(fx: MapSnapshot): string | null {
  return fx.sync.lastFetchAt === null
    ? null
    : relAge(fx.sync.lastFetchAt, fx.capturedAt);
}

function fresh(fx: MapSnapshot): MenubarFreshView {
  const age = fetchAge(fx);
  if (age === null)
    return {
      text: "Never synced",
      tip: "No git fetch has happened yet — open Vibehub to sync",
      stale: true,
    };
  if (fx.sync.stale)
    return {
      text: `Synced ${age} ago`,
      tip: `The app hasn't fetched the repo for ${age} — it syncs while the window is open. Hook events still arrive live.`,
      stale: true,
    };
  return { text: `Synced ${age} ago`, tip: "Last git fetch + hook event", stale: false };
}

function staleNote(fx: MapSnapshot): StaleNoteView | null {
  if (!fx.sync.stale) return null;
  return {
    text: "Showing last known repo state — sessions still report via hooks. Open Vibehub to sync.",
    tip: "Sessions report through the installed hooks even with the app closed, so task states are current. Branch, teammate and PR data need a git fetch — that happens when the window is open.",
  };
}

/* ── badge + item tip ───────────────────────────────────────────────────── */

/**
 * "1 waiting · 1 conflict" — the badge/item enumeration (zeros hidden, same
 * rule as the stat pills). Empty string when nothing needs you.
 */
function needsEnum(waiting: number, conflicts: number): string {
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (conflicts > 0) parts.push(`${conflicts} conflict${conflicts === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * rev-2 (Wayne verdict ⑦, decision-workbench-003): the badge counts
 * everything that NEEDS YOU — waiting tasks + conflict PAIRS (a pair counts
 * once, same as its single needs-you row). REVOKES iter-20's waiting-only
 * badge. Stale behavior unchanged: gray + static, last-known count.
 */
function badge(
  fx: MapSnapshot,
  waiting: number,
  conflicts: number,
): MenubarBadgeView | null {
  const total = waiting + conflicts;
  if (total === 0) return null;
  const capped = total > BADGE_CAP;
  const text = capped ? `${BADGE_CAP}+` : String(total);
  const parts = needsEnum(waiting, conflicts);
  const age = fetchAge(fx);
  const tip = fx.sync.stale
    ? `Last known: ${parts}. Repo data hasn't synced for ${age ?? "ever"}, so this count may be behind.`
    : capped
      ? `${parts} — the badge caps at ${BADGE_CAP}+, exact counts live here and in the dropdown`
      : `${parts} need${total === 1 ? "s" : ""} you`;
  return { text, exact: total, stale: fx.sync.stale, tip };
}

function itemTip(
  fx: MapSnapshot,
  waiting: number,
  conflicts: number,
  running: number,
): string {
  const parts = needsEnum(waiting, conflicts);
  const total = waiting + conflicts;
  if (fx.sync.stale) {
    const age = fetchAge(fx) ?? "ever";
    return `Vibehub — last known: ${parts || "nothing needed you"}. Repo data hasn't synced for ${age}; open the window to sync.`;
  }
  if (total === 0)
    return `Vibehub — all quiet. ${running === 0 ? "No sessions running" : `${running} session${running === 1 ? "" : "s"} running`}, nothing needs you.`;
  if (waiting === 0)
    return `Vibehub — ${conflicts} conflict${conflicts === 1 ? "" : "s"} need${conflicts === 1 ? "s" : ""} adjudication.`;
  if (total > BADGE_CAP)
    return `Vibehub — ${parts} (the badge caps at ${BADGE_CAP}+).`;
  if (total === 1)
    return "Vibehub — 1 task waiting on you. The app keeps watching from here even when the window is closed.";
  return `Vibehub — ${parts} need you.`;
}

/* ── desktop clock (context scaffolding, still data-driven) ─────────────── */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Sun Jul 12  10:22" straight from the ISO string's own local parts (same
 * no-timezone rule as clockTime — previews render identically everywhere).
 */
export function deskClock(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return clockTime(iso);
  const [, y, mo, d] = m;
  const dow = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
  return `${WEEKDAYS[dow]} ${MONTHS[Number(mo) - 1]} ${Number(d)}  ${clockTime(iso)}`;
}

/* ── the rollup ─────────────────────────────────────────────────────────── */

export function deriveMenubar(fx: MapSnapshot): MenubarSummary {
  const waiting = fx.tasks.filter((t) => t.state === "waiting").length;
  const conflicts = fx.conflicts.length;
  const running = fx.tasks.filter((t) => t.state === "running").length;
  const ny = needsYou(fx);
  const quiet =
    ny.total === 0
      ? {
          text:
            running > 0
              ? `All quiet — ${running} running, nothing needs you.`
              : "All quiet — nothing running, nothing needs you.",
          tip:
            running > 0
              ? `Nothing is waiting on you and nothing is in conflict. The ${running} running session${running === 1 ? "" : "s"} will surface here the moment they need you.`
              : "Nothing is waiting on you and nothing is in conflict. Sessions will surface here the moment they need you.",
        }
      : null;
  return {
    repoSlug: fx.repo.slug,
    repoTip: "The repo this window watches — one window per repo",
    fresh: fresh(fx),
    staleNote: staleNote(fx),
    stats: stats(waiting, conflicts, running),
    badge: badge(fx, waiting, conflicts),
    needsYou: ny,
    quiet,
    itemTip: itemTip(fx, waiting, conflicts, running),
    clockText: deskClock(fx.capturedAt),
  };
}
