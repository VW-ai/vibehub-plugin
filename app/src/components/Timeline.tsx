import { useLayoutEffect, useRef, useState } from "react";
import type { TaskPanelSnapshot } from "@vibehub/core/contracts";
import { milestoneEvents } from "../panel-derive";
import { TimelineEntry } from "./TimelineEntry";

type Tier = "all" | "ms";

export interface TimelineProps {
  panel: TaskPanelSnapshot;
}

/**
 * Section 2 — the human timeline: tier bar + the panel's ONLY scroll region.
 * S2 behaviors preserved: opens scrolled to the newest event (the waiting
 * cause is why the panel is open), scroll-aware shadow seam under the bar.
 * The Milestones tier is DERIVED (isMilestone, 023 whitelist) — coarser
 * than the S2 static's hand-tagged set (DECISIONS-NEEDED iter-6).
 */
export function Timeline({ panel }: TimelineProps) {
  const [tier, setTier] = useState<Tier>("all");
  const [scrolled, setScrolled] = useState(false);
  const tlRef = useRef<HTMLDivElement>(null);

  // Open at the newest event (S2: tl.scrollTop = tl.scrollHeight).
  useLayoutEffect(() => {
    const el = tlRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      setScrolled(el.scrollTop > 0);
    }
  }, []);

  const events =
    tier === "ms" ? milestoneEvents(panel.timeline) : panel.timeline;
  const writeScopeLabels = panel.task.scopes
    .filter((s) => s.mode === "write")
    .map((s) => `w ${s.label}`)
    .join(", ");

  return (
    <>
      <div className={`tlbar${scrolled ? " scrolled" : ""}`}>
        <h4 data-tip="Everything that happened, in plain language — the agent's reports and your interventions share one history">
          Timeline
        </h4>
        <div className="seg" role="tablist" aria-label="Timeline detail level">
          <button
            type="button"
            className={tier === "all" ? "on" : ""}
            data-tip="Every event: self-reports, questions, injections, plus mechanical steps like test runs and reads"
            onClick={() => setTier("all")}
          >
            All
          </button>
          <button
            type="button"
            className={tier === "ms" ? "on" : ""}
            data-tip="Milestones only: the launch prompt, commits, state changes, your interventions, and the questions that parked the task. Everything else lives under All."
            onClick={() => setTier("ms")}
          >
            Milestones
          </button>
        </div>
      </div>
      <div
        className="tl"
        ref={tlRef}
        onScroll={() => setScrolled((tlRef.current?.scrollTop ?? 0) > 0)}
      >
        {panel.timeline.length === 0 ? (
          // N=0 rung, honest: a queued task has no session and no history.
          <div className="tl-empty">
            Not launched yet — no session, no history. Launch it from the map
            rail and its founding prompt appears here.
          </div>
        ) : (
          events.map((e) => (
            <TimelineEntry key={e.id} event={e} writeScopeLabels={writeScopeLabels} />
          ))
        )}
      </div>
    </>
  );
}
