import { LEGEND_ITEMS, type LegendKind } from "../derive";

const SWATCH_CLASS: Record<LegendKind, string> = {
  w: "lg-w",
  r: "lg-r",
  clash: "lg-c",
  quiet: "lg-q",
};

export interface LegendProps {
  onFilterStart: (kind: LegendKind) => void;
  onFilterEnd: () => void;
}

/** Legend doubles as a hover filter (v8): hovering an entry lights matches. */
export function Legend({ onFilterStart, onFilterEnd }: LegendProps) {
  return (
    <div className="legend">
      {LEGEND_ITEMS.map((item) => (
        <span
          key={item.kind}
          data-tip={item.tip}
          data-kind={item.kind}
          tabIndex={0}
          onMouseEnter={() => onFilterStart(item.kind)}
          onMouseLeave={onFilterEnd}
          onFocus={() => onFilterStart(item.kind)}
          onBlur={onFilterEnd}
        >
          <i className={SWATCH_CLASS[item.kind]} />
          {item.text}
        </span>
      ))}
    </div>
  );
}
