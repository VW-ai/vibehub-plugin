import type { CSSProperties } from "react";
import type { MapFixture, Territory } from "../types";
import { territoryView } from "../derive";

export interface TerritoryBlockProps {
  terr: Territory;
  fixture: MapFixture;
  /** Entry stagger index (v8: .08s + .06s * i). */
  index: number;
  /** Total territory count — caps the stagger at scale (N=many rung). */
  count: number;
  lit: boolean;
}

const STAGGER_BASE_S = 0.08; // v8 first territory delay
const STAGGER_STEP_S = 0.06; // v8 increment (v8 hand-eases later ones; ±.04s)
/**
 * N=many rung: at 40 territories the v8 step would put the last entrance at
 * 2.4s (rows simply missing for seconds). Cap the WHOLE stagger window at
 * 0.6s and shrink the step — at v8's N=6 the cap is inactive (0.6/6 = .1 >
 * .06), so baseline parity is untouched.
 */
const STAGGER_WINDOW_S = 0.6;

function rectStyle(terr: Territory, index: number, count: number): CSSProperties {
  const r = terr.demoLayout;
  const step = Math.min(STAGGER_STEP_S, STAGGER_WINDOW_S / Math.max(count, 1));
  return {
    left: `${r?.left ?? 0}%`,
    top: `${r?.top ?? 0}%`,
    width: `${r?.width ?? 20}%`,
    height: `${r?.height ?? 20}%`,
    animationDelay: `${STAGGER_BASE_S + step * index}s`,
  };
}

function subStyle(s: { left?: number; top?: number; right?: number; bottom?: number }): CSSProperties {
  const css: CSSProperties = {};
  if (s.left !== undefined) css.left = s.left;
  if (s.top !== undefined) css.top = s.top;
  if (s.right !== undefined) css.right = s.right;
  if (s.bottom !== undefined) css.bottom = s.bottom;
  return css;
}

export function TerritoryBlock({
  terr,
  fixture,
  index,
  count,
  lit,
}: TerritoryBlockProps) {
  const v = territoryView(terr, fixture);
  const classes = ["terr", ...v.classes];
  if (v.compact) classes.push("compact");
  if (lit) classes.push("lit");
  return (
    <div
      className={classes.join(" ")}
      style={rectStyle(terr, index, count)}
      data-tip={v.tip}
    >
      <div className="label">{v.labelText}</div>
      {v.subs.map((s) => (
        <div
          key={s.sub.id}
          className={`sub${s.kind === "plain" ? "" : ` ${s.kind}`}`}
          style={subStyle(s.style)}
          data-tip={s.tip}
        >
          <em>{s.sub.name}</em>
          {s.cnt && <span className="cnt">{s.cnt}</span>}
        </div>
      ))}
      {v.foot && (
        <div
          className={`foot${v.foot.needInk ? " need-ink" : ""}`}
          {...(v.foot.tip ? { "data-tip": v.foot.tip } : {})}
        >
          {v.foot.text}
        </div>
      )}
    </div>
  );
}
