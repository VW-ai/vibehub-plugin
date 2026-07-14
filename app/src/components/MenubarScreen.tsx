/**
 * MenubarScreen (m5, S4) — the "app closed but still watching" surface,
 * dynamized from the approved M0 menubar artifact. A separate
 * preview render path like InstallScreen: `?menubar=<variant>` renders a generic
 * desktop + menubar strip + the Vibehub item + its dropdown INSTEAD of the
 * map window. Everything product-visible comes from one MapSnapshot through
 * the pure rollup (deriveMenubar) — the menubar can never disagree with the
 * map (S3 design; no menubar snapshot shape exists).
 *
 * S5 interactions:
 *  - item click toggles the dropdown (starts OPEN on load — the dropdown IS
 *    the preview subject, and parity shots need it; real app starts closed);
 *  - Escape and outside-click close it and return focus to the item;
 *  - selecting anything inside (rows / stat pills / overflow / footer) closes
 *    the menu like a real menubar selection — the open-main-window intent
 *    each button carries lives in its tooltip (preview has no main window to
 *    open; fork logged iter-20);
 *  - all rows are native <button>s → tabbable, Enter/Space fire click.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MapSnapshot } from "@vibehub/core/contracts";
import { deriveMenubar } from "../menubar-derive";
import { Tooltip } from "./Tooltip";

const STAND_IN_TIP = "decorative stand-in in this preview";

/** The map's identity at 15px: three rounded territory blocks. */
function TerritoryGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.5 3.25c0-.97.78-1.75 1.75-1.75h3c.97 0 1.75.78 1.75 1.75v3c0 .97-.78 1.75-1.75 1.75h-3A1.75 1.75 0 0 1 1.5 6.25Zm8.5-.5c0-.69.56-1.25 1.25-1.25h2c.69 0 1.25.56 1.25 1.25v5.5c0 .69-.56 1.25-1.25 1.25h-2c-.69 0-1.25-.56-1.25-1.25ZM2 11.25c0-.69.56-1.25 1.25-1.25h5c.69 0 1.25.56 1.25 1.25v2c0 .69-.56 1.25-1.25 1.25h-5C2.56 14.5 2 13.94 2 13.25Z" />
    </svg>
  );
}

function RepoGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

function PlusGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </svg>
  );
}

/* System-ish stand-ins for the strip (no trademarks; all tooltipped). */
function StripStandIns() {
  const tip = `Your other status items — ${STAND_IN_TIP}s`;
  return (
    <>
      <span className="sit" data-tip={tip}>
        <svg width="15" height="13" viewBox="0 0 17 14" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="1" y="3.5" width="12" height="7" rx="2" />
          <path d="M14.5 6v2.4" strokeLinecap="round" />
          <rect x="2.6" y="5.1" width="7.4" height="3.8" rx="1" fill="currentColor" stroke="none" />
        </svg>
      </span>
      <span className="sit" data-tip={tip}>
        <svg width="14" height="12" viewBox="0 0 16 13" fill="currentColor">
          <path d="M8 10.4a1.5 1.5 0 1 1 0 2.1 1.5 1.5 0 0 1 0-2.1ZM5.5 8.2a4.3 4.3 0 0 1 5 0l-1 1.3a2.7 2.7 0 0 0-3 0Zm-2.3-2.4a7.6 7.6 0 0 1 9.6 0l-1 1.3a6 6 0 0 0-7.6 0Zm-2.3-2.3a11 11 0 0 1 14.2 0l-1 1.3a9.4 9.4 0 0 0-12.2 0Z" />
        </svg>
      </span>
      <span className="sit" data-tip={tip}>
        <svg width="14" height="12" viewBox="0 0 15 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <path d="M2 3.5h11M2 6.5h11M2 9.5h11" />
          <circle cx="10" cy="3.5" r="1.7" fill="var(--card)" />
          <circle cx="5" cy="6.5" r="1.7" fill="var(--card)" />
          <circle cx="9" cy="9.5" r="1.7" fill="var(--card)" />
        </svg>
      </span>
    </>
  );
}

export interface MenubarScreenProps {
  snapshot: MapSnapshot;
  /** Dev switcher entries (`?switcher=0` hides it, same rule everywhere). */
  variantNames: string[];
  activeVariant: string;
  showSwitcher: boolean;
  onSwitch: (name: string) => void;
}

export function MenubarScreen({
  snapshot,
  variantNames,
  activeVariant,
  showSwitcher,
  onSwitch,
}: MenubarScreenProps) {
  const s = useMemo(() => deriveMenubar(snapshot), [snapshot]);

  // The dropdown IS the preview subject → starts open (parity with the static).
  const [open, setOpen] = useState(true);
  const itemRef = useRef<HTMLButtonElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);

  // macOS menus right-align under their item — anchor recomputed on resize.
  const [anchorRight, setAnchorRight] = useState(8);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = itemRef.current?.getBoundingClientRect();
      if (r) setAnchorRight(Math.max(8, window.innerWidth - r.right - 2));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  /** Close + focus returns to the item (Escape / outside / selection). */
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => itemRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (dropRef.current?.contains(t)) return;
      if (itemRef.current?.contains(t)) return; // the item's click toggles
      close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const ny = s.needsYou;

  return (
    <div className="mbdesk">
      {/* ── menubar strip: generic system-ish context scaffolding ── */}
      <div className="menubar">
        <span className="os" data-tip={`Your system menu — ${STAND_IN_TIP}`}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5c2.6 2 5.5 2.4 5.5 6.1 0 3.4-2.5 6-5.5 6.9C5 13.6 2.5 11 2.5 7.6 2.5 3.9 5.4 3.5 8 1.5Z" />
          </svg>
        </span>
        <span className="appname" data-tip={`The frontmost app's menus — ${STAND_IN_TIP}`}>
          Shell
        </span>
        <div className="menus" data-tip={`The frontmost app's menus — ${STAND_IN_TIP}`}>
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Window</span>
          <span>Help</span>
        </div>
        <div className="mb-spacer" />
        <div className="status">
          <StripStandIns />
          <button
            ref={itemRef}
            className={`vhitem${open ? " open" : ""}`}
            data-tip={s.itemTip}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => (open ? close() : setOpen(true))}
          >
            <TerritoryGlyph size={15} />
            {s.badge && (
              <span
                className={`badge${s.badge.stale ? " stale" : ""}`}
                data-tip={s.badge.tip}
              >
                {s.badge.text}
              </span>
            )}
          </button>
          <span className="clock" data-tip={`Your system clock — ${STAND_IN_TIP}`}>
            {s.clockText}
          </span>
        </div>
      </div>

      {/* ── the dropdown ── */}
      {open && (
        <div
          ref={dropRef}
          className="drop"
          style={{ right: `${anchorRight}px` }}
          role="menu"
          aria-label="Vibehub summary"
        >
          <div className="rline">
            <RepoGlyph />
            <span className="name" data-tip={s.repoTip}>
              {s.repoSlug}
            </span>
            <span className="gap" />
            <span
              className={`fresh${s.fresh.stale ? " stale" : ""}`}
              data-tip={s.fresh.tip}
            >
              <span className="dot" />
              {s.fresh.text}
            </span>
          </div>

          {s.staleNote && (
            <p className="stalenote" data-tip={s.staleNote.tip}>
              {s.staleNote.text}
            </p>
          )}

          {s.stats.length > 0 && (
            <div className="counts">
              {s.stats.map((st) => (
                <button
                  key={st.kind}
                  className={`stat ${st.kind}`}
                  data-tip={st.tip}
                  onClick={close}
                >
                  {st.text}
                </button>
              ))}
            </div>
          )}

          {s.quiet && (
            <p className="quietline" data-tip={s.quiet.tip}>
              <CheckGlyph />
              {s.quiet.text}
            </p>
          )}

          {ny.rows.length > 0 && (
            <>
              <div className="mb-div" />
              <div
                className="gh"
                data-tip="What's blocked on you right now, oldest first — the same list as the app's Needs-you rail"
              >
                Needs you <b>{ny.total}</b>
              </div>
              {ny.rows.map((r) => (
                <button
                  key={r.key}
                  className="item"
                  data-row={r.key}
                  data-kind={r.kind}
                  data-tip={r.tip}
                  onClick={close}
                >
                  <span className={`pill ${r.pill}`}>{r.pillText}</span>
                  <span className="t">{r.title}</span>
                  <span className="age">{r.age}</span>
                </button>
              ))}
              {ny.moreText && (
                <button
                  className="more"
                  data-tip={ny.moreTip ?? undefined}
                  onClick={close}
                >
                  {ny.moreText}
                </button>
              )}
            </>
          )}

          <div className="mb-div" />

          <div className="mb-foot">
            <button
              className="open-app"
              data-tip="Opens the main window on the map — the full picture behind these counts"
              onClick={close}
            >
              <TerritoryGlyph size={11} />
              Open Vibehub
            </button>
            <button
              className="start-task"
              data-tip="Assemble context and launch a Claude Code session on a new branch — opens the main window to configure it"
              onClick={close}
            >
              <PlusGlyph />
              Start a task
            </button>
          </div>
        </div>
      )}

      <Tooltip />

      {showSwitcher && variantNames.length > 1 && (
        <select
          className="snapshot-switch mb-switch"
          aria-label="Preview menubar variant"
          value={activeVariant}
          onChange={(e) => onSwitch(e.target.value)}
        >
          {variantNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
