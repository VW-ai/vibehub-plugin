import type { MapFixture, Territory } from "../types";
import type { LegendKind } from "../derive";
import { TerritoryBlock } from "./TerritoryBlock";
import { Legend } from "./Legend";

/**
 * S5 density-aware legend clearance (SCALE-EXTREMES: SCREEN sizes / N=many).
 * v8's own deepest rect bottoms out at 92.5% (t-store / t-fe: top+height)
 * and empirically clears the floating legend at the 1280×800 minimum
 * viewport. Any fixture that reaches deeper (forty-territories bottom row
 * ends at 97.4%) would run under the legend, hiding territory feet. When
 * that happens the territory field reserves the legend band at the bottom
 * (48px = 12px legend offset + 30px legend height + 6px clearance) so the
 * percent layout compresses instead of colliding. v8-baseline's max bottom
 * IS the threshold, so the baseline stays pixel-identical.
 */
const V8_MAX_BOTTOM_PCT = 92.5;

function needsLegendBand(fixture: MapFixture): boolean {
  return fixture.territories.some(
    (t) => t.demoLayout && t.demoLayout.top + t.demoLayout.height > V8_MAX_BOTTOM_PCT,
  );
}

export interface MapCanvasProps {
  fixture: MapFixture;
  /** Correlate-hover focus mode: dim everything except lit territories. */
  focus: boolean;
  /** Task panel open: blur the canvas 1.5px (S2 context rendering). */
  veiled: boolean;
  litIds: Set<string>;
  onFilterStart: (kind: LegendKind) => void;
  onFilterEnd: () => void;
  /** Reverse correlate: territory hover highlights its tasks in the rail. */
  onTerritoryHoverStart: (terr: Territory) => void;
  onTerritoryHoverEnd: () => void;
  /** Clash sub-block chips open the conflict card (m3 S4 open path #1). */
  onConflictOpen: (conflictId: string, opener: HTMLElement | null) => void;
}

export function MapCanvas({
  fixture,
  focus,
  veiled,
  litIds,
  onFilterStart,
  onFilterEnd,
  onTerritoryHoverStart,
  onTerritoryHoverEnd,
  onConflictOpen,
}: MapCanvasProps) {
  const empty = fixture.territories.length === 0;
  const band = needsLegendBand(fixture);
  return (
    <section
      className={`canvas${focus ? " focus" : ""}${veiled ? " veiled" : ""}`}
      aria-hidden={veiled || undefined}
    >
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
        <div className={`field${band ? " with-legend-band" : ""}`}>
          {fixture.territories.map((t, i) => (
            <TerritoryBlock
              key={t.id}
              terr={t}
              fixture={fixture}
              index={i}
              count={fixture.territories.length}
              lit={litIds.has(t.id)}
              onHoverStart={onTerritoryHoverStart}
              onHoverEnd={onTerritoryHoverEnd}
              onConflictOpen={onConflictOpen}
            />
          ))}
        </div>
      )}
      {!empty && <Legend onFilterStart={onFilterStart} onFilterEnd={onFilterEnd} />}
    </section>
  );
}
