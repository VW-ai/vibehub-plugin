import { useEffect, useMemo, useRef, useState } from "react";
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
  // Panel opener = a rail card (looked up by task id, still mounted under
  // the scrim); conflict opener = the exact element (pill / sub chip /
  // titlebar stat), captured at open time. null for ?panel= / ?conflict=.
  const openerTaskId = useRef<string | null>(null);
  const conflictOpener = useRef<HTMLElement | null>(null);

  const openTask = (task: Task) => {
    // Opening the panel kills any live correlate-hover (the scrim takes over)
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

  return (
    <div className="window">
      <Titlebar
        fixture={fixture}
        fixtureNames={showSwitcher ? Object.keys(fixtures) : []}
        activeFixture={fixtureName}
        onFixtureChange={switchFixture}
        onConflictOpen={openConflict}
      />
      <div className="main">
        <TaskRail
          fixture={fixture}
          dim={focus}
          hotTaskIds={highlight.hotTaskIds}
          onTaskHoverStart={setHoverTask}
          onTaskHoverEnd={() => setHoverTask(null)}
          onTaskOpen={openTask}
          onConflictOpen={openConflict}
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
