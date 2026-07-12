import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { MapFixture, Task, Territory } from "../types";
import type { TaskPanelFixture } from "../panel-types";
import type { ConflictCardFixture } from "../conflict-types";
import {
  highlightForLegend,
  highlightForTask,
  highlightForTerritory,
  type Highlight,
  type LegendKind,
} from "../derive";
import { SCRIM_TIP } from "../conflict-derive";
import {
  conflictCardForConflict,
  conflictFixtureByName,
  installFixtureByName,
  installFixtures,
  menubarFixtureByName,
  menubarFixtures,
  panelFixtureByName,
  panelForTask,
} from "../fixtures";
import { InstallScreen } from "./InstallScreen";
import { MenubarScreen } from "./MenubarScreen";
import { Titlebar } from "./Titlebar";
import { TaskRail } from "./TaskRail";
import { MapCanvas } from "./MapCanvas";
import { TaskPanel } from "./TaskPanel";
import { ConflictCard } from "./ConflictCard";
import { Tooltip } from "./Tooltip";

const NO_HIGHLIGHT: Highlight = {
  litIds: new Set<string>(),
  hotTaskIds: new Set<string>(),
};

/* ── resizable rail/canvas split (rev-1, Wayne verdict 2026-07-12) ────────
 * Pointer-events drag (no library), clamped 240–480px; double-click resets
 * to v8's 300px; divider is focusable and arrow keys nudge ±16px (one
 * spacing token above --sp-3 — big enough to see, small enough to aim);
 * the chosen width persists locally. Chip wrapping responds live (flex). */
const RAIL_MIN = 240;
const RAIL_MAX = 480;
const RAIL_DEFAULT = 300; // v8's fixed rail width
const RAIL_STEP = 16;
const RAIL_WIDTH_KEY = "vibehub-demo.railWidth";

function clampRail(w: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(w)));
}

function loadRailWidth(): number {
  try {
    const v = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    if (Number.isFinite(v) && v >= RAIL_MIN && v <= RAIL_MAX) return v;
  } catch {
    /* storage unavailable (private mode) → session-only default */
  }
  return RAIL_DEFAULT;
}

export interface AppProps {
  fixtures: Record<string, MapFixture>;
  initialFixture: string;
  /** Dev switcher visibility (`?switcher=0` hides it for parity shots). */
  showSwitcher: boolean;
  /** `?panel=<name>` dev param: open a panel fixture directly on load. */
  initialPanel?: string | undefined;
  /** `?conflict=<name>` dev param: open a conflict card directly on load. */
  initialConflict?: string | undefined;
  /**
   * `?install=<name>` dev param (m4 S4): render the first-run screen — the
   * connection-state layer ABOVE the map render path. In the real app this
   * layer is driven by the stored RepoConnection; the demo reaches every
   * state through the install fixtures.
   */
  initialInstall?: string | undefined;
  /**
   * `?menubar=<variant>` dev param (m5 S4): render the menubar surface — a
   * separate demo render path (like InstallScreen) showing the closed-app
   * "still watching" state. Variants busy/quiet/stale/overload/flood map to
   * MapFixtures through the pure rollup; `1` → busy; unknown → map.
   */
  initialMenubar?: string | undefined;
}

export function App({
  fixtures,
  initialFixture,
  showSwitcher,
  initialPanel,
  initialConflict,
  initialInstall,
  initialMenubar,
}: AppProps) {
  // Menubar surface (m5): its own demo route, above every window layer —
  // the whole point is that the main window is CLOSED. Unknown names fall
  // through to the install/map paths.
  const [menubarName, setMenubarName] = useState<string | null>(() =>
    initialMenubar && menubarFixtureByName(initialMenubar)
      ? initialMenubar === "1"
        ? "busy"
        : initialMenubar
      : null,
  );
  // Connection-state layer (m4): while a first-run fixture is the subject,
  // the map path below never renders. Unknown names fall through to the map.
  const [installName, setInstallName] = useState<string | null>(() =>
    initialInstall && installFixtureByName(initialInstall) ? initialInstall : null,
  );
  const [fixtureName, setFixtureName] = useState(initialFixture);
  // Correlate-hover source: a rail card, a territory (reverse direction),
  // or a legend entry — only one can be the source at a time.
  const [hoverTask, setHoverTask] = useState<Task | null>(null);
  const [hoverTerr, setHoverTerr] = useState<Territory | null>(null);
  const [legendFilter, setLegendFilter] = useState<LegendKind | null>(null);
  // Task panel (m2): clicking a rail card opens it over the dimmed map.
  const [panel, setPanel] = useState<TaskPanelFixture | null>(() =>
    initialPanel ? panelFixtureByName(initialPanel) : null,
  );
  // Conflict card (m3): sub-block chip / rail CONFLICT pill / titlebar stat.
  // Mutually exclusive with the panel — one modal surface at a time (fork
  // logged iter-12): opening either closes the other.
  const [conflict, setConflict] = useState<ConflictCardFixture | null>(() =>
    initialConflict && !initialPanel ? conflictFixtureByName(initialConflict) : null,
  );

  const fixture = fixtures[fixtureName] ?? fixtures[initialFixture]!;

  // Resizable rail/canvas split (rev-1): width state + drag/keyboard wiring.
  const [railWidth, setRailWidth] = useState(loadRailWidth);
  const [railDragging, setRailDragging] = useState(false);
  // Grab offset: pointer x − rail right edge at pointerdown. Subtracting it
  // on move keeps the divider under the finger (no jump on grab) and makes
  // the width track the pointer exactly, wherever on the 7px hit area the
  // drag started.
  const railGrabOffset = useRef(0);
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
    } catch {
      /* storage unavailable → the width simply doesn't persist */
    }
  }, [railWidth]);

  const highlight = useMemo<Highlight>(() => {
    if (hoverTask) return highlightForTask(hoverTask, fixture);
    if (hoverTerr) return highlightForTerritory(hoverTerr, fixture);
    if (legendFilter) return highlightForLegend(legendFilter, fixture);
    return NO_HIGHLIGHT;
  }, [hoverTask, hoverTerr, legendFilter, fixture]);

  const focus = hoverTask !== null || hoverTerr !== null || legendFilter !== null;

  const clearHovers = () => {
    setHoverTask(null);
    setHoverTerr(null);
    setLegendFilter(null);
  };

  const switchFixture = (name: string) => {
    setFixtureName(name);
    clearHovers();
    setPanel(null); // a modal belongs to the fixture it was opened from
    setConflict(null);
    const url = new URL(window.location.href);
    url.searchParams.set("fixture", name);
    window.history.replaceState(null, "", url);
  };

  // Focus returns to the opener on close (keyboard parity: a keyboard user
  // who opened with Enter must land back where they were — recorded
  // principle, Room 20 decision-ledger-viz-001 / dialog convention).
  // Panel opener = a rail card (looked up by task id — the rail stays live
  // and mounted beside the scrimmed canvas); conflict opener = the exact
  // element (pill / sub chip / titlebar stat), captured at open time.
  // null for ?panel= / ?conflict=.
  const openerTaskId = useRef<string | null>(null);
  const conflictOpener = useRef<HTMLElement | null>(null);

  const openTask = (task: Task) => {
    // rev-2 (Wayne verdict ④): the rail stays LIVE under an open panel —
    // clicking the SAME card toggles its panel closed; clicking another card
    // swaps the panel content in place (one click, remount via key below).
    if (panel && panel.task.id === task.id) {
      closePanel();
      return;
    }
    // Opening the panel kills any live correlate-hover (the canvas veils)
    // and closes the conflict card (mutual exclusivity).
    clearHovers();
    setConflict(null);
    openerTaskId.current = task.id;
    setPanel(panelForTask(task, fixture));
  };
  const closePanel = () => {
    setPanel(null);
    const id = openerTaskId.current;
    if (id) {
      // after the unmount paints — the card is still mounted under the scrim
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`)
          ?.focus();
      });
    }
  };

  /**
   * Conflict open path shared by all three entry points. A conflict with no
   * authored card fixture falls back to opening the task's panel (the card
   * cannot be honestly synthesized — see fixtures/index.ts); `task` is the
   * fallback subject (the pill's own task; the sub chip / stat pass the
   * conflict's first task).
   */
  const openConflict = (conflictId: string, opener: HTMLElement | null, task?: Task) => {
    // rev-2 (Wayne verdict ④, same treatment as the panel): the pill of the
    // conflict already on screen toggles its card closed; a different
    // conflict swaps the card in place (remount via key below).
    if (conflict && conflict.conflict.id === conflictId) {
      closeConflict();
      return;
    }
    const card = conflictCardForConflict(conflictId);
    if (!card) {
      const fallback =
        task ??
        fixture.tasks.find((t) =>
          fixture.conflicts.some((c) => c.id === conflictId && c.taskIds.includes(t.id)),
        );
      if (fallback) openTask(fallback);
      return;
    }
    clearHovers();
    setPanel(null); // mutual exclusivity
    conflictOpener.current = opener;
    setConflict(card);
  };
  const closeConflict = () => {
    setConflict(null);
    const el = conflictOpener.current;
    if (el) {
      requestAnimationFrame(() => el.focus());
    }
  };

  /** Side rows in the conflict card open that task's panel (S2 promise). */
  const openTaskFromConflict = (task: Task) => {
    // Prefer the map's own task record (same ids on v8-baseline); fall back
    // to the card's standalone copy for ?conflict= fixtures not on this map.
    const mapTask = fixture.tasks.find((t) => t.id === task.id) ?? task;
    openTask(mapTask);
  };

  // Escape closes the panel (alongside X and scrim click). The conflict
  // card handles its own Escape (an open pause menu swallows the first one).
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel(); // same path as X — focus returns
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);

  /* ── menubar surface (m5 S4) — its own render path, no window at all ── */
  const menubarFixture = menubarName ? menubarFixtureByName(menubarName) : null;
  if (menubarName && menubarFixture) {
    const switchMenubar = (name: string) => {
      if (!menubarFixtureByName(name)) return;
      setMenubarName(name);
      const url = new URL(window.location.href);
      url.searchParams.set("menubar", name);
      window.history.replaceState(null, "", url);
    };
    return (
      <MenubarScreen
        fixture={menubarFixture}
        variantNames={Object.keys(menubarFixtures)}
        activeVariant={menubarName}
        showSwitcher={showSwitcher}
        onSwitch={switchMenubar}
      />
    );
  }

  /* ── connection-state layer (m4 S4) — above the map render path ─────── */
  const installFixture = installName ? installFixtureByName(installName) : null;
  if (installName && installFixture) {
    const switchInstall = (name: string) => {
      if (!installFixtureByName(name)) return;
      setInstallName(name);
      const url = new URL(window.location.href);
      url.searchParams.set("install", name);
      window.history.replaceState(null, "", url);
    };
    return (
      <InstallScreen
        fixture={installFixture}
        installNames={Object.keys(installFixtures)}
        activeInstall={installName}
        showSwitcher={showSwitcher}
        onSwitch={switchInstall}
      />
    );
  }

  // rev-2 (Wayne verdict ④ — "左栏不要变灰"): while a modal surface (panel /
  // conflict card) is open, the rail stays fully LIVE; the scrim covers the
  // CANVAS only (left edge = rail width, via the --rail-w custom property).
  // Correlate is suppressed while a modal is open — the canvas is veiled, so
  // lighting footprints under the scrim would be dishonest half-feedback;
  // cards keep their normal hover affordance (fork logged, DECISIONS-NEEDED).
  const modalOpen = panel !== null || conflict !== null;

  return (
    <div className="window">
      <Titlebar
        fixture={fixture}
        fixtureNames={showSwitcher ? Object.keys(fixtures) : []}
        activeFixture={fixtureName}
        onFixtureChange={switchFixture}
        onConflictOpen={openConflict}
      />
      <div
        className={`main${railDragging ? " rail-resizing" : ""}`}
        style={{ "--rail-w": `${railWidth}px` } as CSSProperties}
      >
        <TaskRail
          fixture={fixture}
          width={railWidth}
          dim={focus}
          hotTaskIds={highlight.hotTaskIds}
          onTaskHoverStart={(t) => {
            if (!modalOpen) setHoverTask(t);
          }}
          onTaskHoverEnd={() => setHoverTask(null)}
          onTaskOpen={openTask}
          onConflictOpen={openConflict}
        />
        <div
          className={`divider${railDragging ? " dragging" : ""}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the task rail"
          aria-valuemin={RAIL_MIN}
          aria-valuemax={RAIL_MAX}
          aria-valuenow={railWidth}
          tabIndex={0}
          data-tip="Drag to resize the rail · double-click resets · arrow keys nudge"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault(); // no text selection while dragging
            const main = e.currentTarget.parentElement;
            railGrabOffset.current = main
              ? e.clientX - (main.getBoundingClientRect().left + railWidth)
              : 0;
            e.currentTarget.setPointerCapture(e.pointerId);
            setRailDragging(true);
          }}
          onPointerMove={(e) => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
            const main = e.currentTarget.parentElement;
            if (!main) return;
            setRailWidth(
              clampRail(
                e.clientX -
                  main.getBoundingClientRect().left -
                  railGrabOffset.current,
              ),
            );
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setRailDragging(false);
          }}
          onPointerCancel={() => setRailDragging(false)}
          onDoubleClick={() => setRailWidth(RAIL_DEFAULT)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setRailWidth((w) => clampRail(w - RAIL_STEP));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              setRailWidth((w) => clampRail(w + RAIL_STEP));
            }
          }}
        />
        <MapCanvas
          fixture={fixture}
          focus={focus}
          veiled={panel !== null || conflict !== null}
          litIds={highlight.litIds}
          onFilterStart={setLegendFilter}
          onFilterEnd={() => setLegendFilter(null)}
          onTerritoryHoverStart={setHoverTerr}
          onTerritoryHoverEnd={() => setHoverTerr(null)}
          onConflictOpen={openConflict}
        />
        {panel && (
          <>
            <div
              className="scrim"
              data-tip="Click anywhere on the map to close the panel"
              onClick={closePanel}
            />
            {/* key: switching tasks remounts the panel (fresh tier/tail/scroll) */}
            <TaskPanel
              key={panel.task.id}
              panel={panel}
              map={fixture}
              onClose={closePanel}
            />
          </>
        )}
        {conflict && (
          <>
            <div className="scrim" data-tip={SCRIM_TIP} onClick={closeConflict} />
            <div className="center">
              {/* key: switching conflicts remounts the card (fresh expand/menu) */}
              <ConflictCard
                key={conflict.conflict.id}
                fixture={conflict}
                onClose={closeConflict}
                onOpenTask={openTaskFromConflict}
              />
            </div>
          </>
        )}
      </div>
      <Tooltip />
    </div>
  );
}
