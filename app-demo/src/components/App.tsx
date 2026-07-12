import { useEffect, useMemo, useRef, useState } from "react";
import type { MapFixture, Task, Territory } from "../types";
import type { TaskPanelFixture } from "../panel-types";
import {
  highlightForLegend,
  highlightForTask,
  highlightForTerritory,
  type Highlight,
  type LegendKind,
} from "../derive";
import { panelFixtureByName, panelForTask } from "../fixtures";
import { Titlebar } from "./Titlebar";
import { TaskRail } from "./TaskRail";
import { MapCanvas } from "./MapCanvas";
import { TaskPanel } from "./TaskPanel";
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
}

export function App({ fixtures, initialFixture, showSwitcher, initialPanel }: AppProps) {
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

  const fixture = fixtures[fixtureName] ?? fixtures[initialFixture]!;

  const highlight = useMemo<Highlight>(() => {
    if (hoverTask) return highlightForTask(hoverTask, fixture);
    if (hoverTerr) return highlightForTerritory(hoverTerr, fixture);
    if (legendFilter) return highlightForLegend(legendFilter, fixture);
    return NO_HIGHLIGHT;
  }, [hoverTask, hoverTerr, legendFilter, fixture]);

  const focus = hoverTask !== null || hoverTerr !== null || legendFilter !== null;

  const switchFixture = (name: string) => {
    setFixtureName(name);
    setHoverTask(null);
    setHoverTerr(null);
    setLegendFilter(null);
    setPanel(null); // a panel belongs to the fixture it was opened from
    const url = new URL(window.location.href);
    url.searchParams.set("fixture", name);
    window.history.replaceState(null, "", url);
  };

  // Focus returns to the opening card on close (keyboard parity: a keyboard
  // user who opened with Enter must land back where they were — recorded
  // principle, Room 20 decision-ledger-viz-001 / dialog convention).
  // null when the panel was opened via the ?panel= dev param (no card).
  const openerTaskId = useRef<string | null>(null);

  const openTask = (task: Task) => {
    // Opening the panel kills any live correlate-hover (the scrim takes over).
    setHoverTask(null);
    setHoverTerr(null);
    setLegendFilter(null);
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

  // Escape closes the panel (alongside X and scrim click).
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel(); // same path as X — focus returns
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);

  return (
    <div className="window">
      <Titlebar
        fixture={fixture}
        fixtureNames={showSwitcher ? Object.keys(fixtures) : []}
        activeFixture={fixtureName}
        onFixtureChange={switchFixture}
      />
      <div className="main">
        <TaskRail
          fixture={fixture}
          dim={focus}
          hotTaskIds={highlight.hotTaskIds}
          onTaskHoverStart={setHoverTask}
          onTaskHoverEnd={() => setHoverTask(null)}
          onTaskOpen={openTask}
        />
        <MapCanvas
          fixture={fixture}
          focus={focus}
          veiled={panel !== null}
          litIds={highlight.litIds}
          onFilterStart={setLegendFilter}
          onFilterEnd={() => setLegendFilter(null)}
          onTerritoryHoverStart={setHoverTerr}
          onTerritoryHoverEnd={() => setHoverTerr(null)}
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
      </div>
      <Tooltip />
    </div>
  );
}
