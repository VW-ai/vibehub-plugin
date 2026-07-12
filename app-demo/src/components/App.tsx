import { useMemo, useState } from "react";
import type { MapFixture, Task } from "../types";
import {
  highlightForLegend,
  highlightForTask,
  type Highlight,
  type LegendKind,
} from "../derive";
import { Titlebar } from "./Titlebar";
import { TaskRail } from "./TaskRail";
import { MapCanvas } from "./MapCanvas";
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
}

export function App({ fixtures, initialFixture, showSwitcher }: AppProps) {
  const [fixtureName, setFixtureName] = useState(initialFixture);
  // Correlate-hover source: either a rail card or a legend entry (never both).
  const [hoverTask, setHoverTask] = useState<Task | null>(null);
  const [legendFilter, setLegendFilter] = useState<LegendKind | null>(null);

  const fixture = fixtures[fixtureName] ?? fixtures[initialFixture]!;

  const highlight = useMemo<Highlight>(() => {
    if (hoverTask) return highlightForTask(hoverTask, fixture);
    if (legendFilter) return highlightForLegend(legendFilter, fixture);
    return NO_HIGHLIGHT;
  }, [hoverTask, legendFilter, fixture]);

  const focus = hoverTask !== null || legendFilter !== null;

  const switchFixture = (name: string) => {
    setFixtureName(name);
    setHoverTask(null);
    setLegendFilter(null);
    const url = new URL(window.location.href);
    url.searchParams.set("fixture", name);
    window.history.replaceState(null, "", url);
  };

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
        />
        <MapCanvas
          fixture={fixture}
          focus={focus}
          litIds={highlight.litIds}
          onFilterStart={setLegendFilter}
          onFilterEnd={() => setLegendFilter(null)}
        />
      </div>
      <Tooltip />
    </div>
  );
}
