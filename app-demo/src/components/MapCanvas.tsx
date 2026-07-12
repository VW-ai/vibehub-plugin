import type { MapFixture } from "../types";
import type { LegendKind } from "../derive";
import { TerritoryBlock } from "./TerritoryBlock";
import { Legend } from "./Legend";

export interface MapCanvasProps {
  fixture: MapFixture;
  /** Correlate-hover focus mode: dim everything except lit territories. */
  focus: boolean;
  litIds: Set<string>;
  onFilterStart: (kind: LegendKind) => void;
  onFilterEnd: () => void;
}

export function MapCanvas({
  fixture,
  focus,
  litIds,
  onFilterStart,
  onFilterEnd,
}: MapCanvasProps) {
  const empty = fixture.territories.length === 0;
  return (
    <section className={`canvas${focus ? " focus" : ""}`}>
      <div className="grid" />
      {empty ? (
        // N=0 rung: no distillation yet — honest guidance, no fake territories.
        // Dashed outline is sanctioned here only (true empty-state placeholder).
        <div className="canvas-empty">
          <div className="box">
            <b>No map yet</b>
            Vibehub hasn&apos;t distilled {fixture.repo.slug} into territories.
            The map fills in after the first distillation pass — tasks work
            fine without it.
          </div>
        </div>
      ) : (
        fixture.territories.map((t, i) => (
          <TerritoryBlock
            key={t.id}
            terr={t}
            fixture={fixture}
            index={i}
            count={fixture.territories.length}
            lit={litIds.has(t.id)}
          />
        ))
      )}
      {!empty && <Legend onFilterStart={onFilterStart} onFilterEnd={onFilterEnd} />}
    </section>
  );
}
