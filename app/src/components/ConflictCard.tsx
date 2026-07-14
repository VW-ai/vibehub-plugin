import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { Task } from "@vibehub/core/contracts";
import type { AdjudicationAction, AppliedIntervention, ConflictCardSnapshot } from "@vibehub/core/contracts";
import {
  BETWEEN_TIP,
  CLOSE_TIP,
  CONFLICT_PILL_TIP,
  PREVIEW_TIP,
  DIAG_EMPTY,
  DIAG_H4_TIP,
  FEEDBACK_CLOSE,
  IGNORE_CONFIRM,
  INJECT_TIP,
  PAUSE_TRIGGER_TIP,
  RERUN_STUB,
  RUN_STUB,
  SIDE_LABEL_TIP,
  SIDE_ROW_TIP,
  SUGGESTED_TIP,
  VISIBLE_SYMBOLS,
  type FeedbackView,
  crumbSegs,
  detectedAge,
  gradeView,
  ignoreFeedback,
  ignoreTip,
  injectFeedback,
  noteView,
  pauseFeedback,
  pauseRows,
  provenanceView,
  sideViews,
  symbolCount,
  symbolRow,
  symbolToggle,
  titleTip,
} from "../conflict-derive";

/** S2: inject textarea autogrow floor / ceiling (identical to the deck's). */
const TEXTAREA_FLOOR_PX = 52;
const TEXTAREA_CEIL_PX = 124;

/**
 * Backtick code tokens (iter-11 fork #4): diagnosis text carries the model's
 * `backticks` verbatim; the UI renders those spans in mono — the data is
 * never rewritten.
 */
function codeSpans(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={k++} className="code">
        {m[1]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

function Caret() {
  return (
    <svg className="car" width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

export interface ConflictCardProps {
  snapshot: ConflictCardSnapshot;
  onClose: () => void;
  /** Side rows open the task's panel (S2 tooltip promise, wired at S4). */
  onOpenTask: (task: Task) => void;
  /** Production callback. Absent only in the fixture harness. */
  onApply?: (action: AdjudicationAction) => Promise<AppliedIntervention | string>;
}

/**
 * The conflict adjudication card (m3) — S2's three zones, dynamized:
 * (a) static evidence: header + crumb + grading strip + the pair + shared
 *     symbols with per-row provenance; (b) on-demand AI diagnosis (done /
 *     dashed-empty from `snapshot.diagnosis` presence); (c) adjudication
 *     footer (inject note / pause one side / ignore pair).
 * The parent (App) owns open/close; Escape is handled HERE so an open pause
 * menu swallows the first Escape (menu closes, card stays — S2 behavior).
 */
export function ConflictCard({ snapshot, onClose, onOpenTask, onApply }: ConflictCardProps) {
  const [symsOpen, setSymsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [seams, setSeams] = useState({ top: false, bottom: false });
  /* Adjudication receipt. Production sets it only after the bridge confirms
     the transaction; the isolated fixture harness keeps its preview path. */
  const [feedback, setFeedback] = useState<{
    action: AdjudicationAction;
    view: FeedbackView;
  } | null>(null);
  /* S5: inline permanence gate for "Ignore this pair". */
  const [confirmIgnore, setConfirmIgnore] = useState(false);
  /* S5: honest run/re-run stub note in zone b (toggles; no fake progress). */
  const [stubNote, setStubNote] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<AppliedIntervention | null>(null);
  const [applying, setApplying] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const fdbkCloseRef = useRef<HTMLButtonElement>(null);
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const confirmRef = useRef(confirmIgnore);
  confirmRef.current = confirmIgnore;

  /* scroll-aware seams (S2 R1 fix #3): grade casts down once scrolled past
     the top, footer casts up while content hides below; off when it fits.
     Re-checked on scroll, body resize (textarea autogrow flexes the body)
     and symbol expand/collapse (layout effect dependency). */
  const recalcSeams = () => {
    const b = bodyRef.current;
    if (!b) return;
    setSeams({
      top: b.scrollTop > 0,
      bottom: b.scrollTop + b.clientHeight < b.scrollHeight - 1,
    });
  };
  useLayoutEffect(recalcSeams, [symsOpen, snapshot, feedback, confirmIgnore, stubNote]);
  useEffect(() => {
    const b = bodyRef.current;
    if (!b || !window.ResizeObserver) return;
    const ro = new ResizeObserver(recalcSeams);
    ro.observe(b);
    return () => ro.disconnect();
  }, []);

  /* Escape: an open pause menu takes it first, then an open ignore-confirm
     (permanence gate cancels — S5), then the card closes (same path as X /
     scrim — focus returns to the opener via App). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (menuOpenRef.current) setMenuOpen(false);
      else if (confirmRef.current) setConfirmIgnore(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  /* pause menu closes on any outside click (S2). */
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  /* S5 focus discipline: the confirm opens on the SAFE option (Keep — Enter
     must not destroy); the feedback band opens on its Close button so the
     outcome is keyboard-reachable in one keystroke. */
  useEffect(() => {
    if (confirmIgnore) keepRef.current?.focus();
  }, [confirmIgnore]);
  useEffect(() => {
    if (feedback) fdbkCloseRef.current?.focus();
  }, [feedback]);

  const autogrow = () => {
    const t = noteRef.current;
    if (!t) return;
    t.style.height = `${TEXTAREA_FLOOR_PX}px`;
    t.style.height = `${Math.min(t.scrollHeight, TEXTAREA_CEIL_PX)}px`;
  };

  /* ── adjudication handlers ─────────────────────────────────────────────── */

  const applyReal = async (action: AdjudicationAction, view: FeedbackView) => {
    if (!onApply) { setFeedback({ action, view }); return; }
    setApplying(true); setActionError(null); setReceipt(null);
    const response = await onApply(action);
    setApplying(false);
    if (typeof response === "string") {
      setActionError(response);
      return;
    }
    setReceipt(response);
    if (response.outcome === "applied" || response.outcome === "already_applied") {
      if (noteRef.current) noteRef.current.value = "";
      if (response.outcome === "already_applied") {
        setFeedback(null);
        return;
      }
      const confirmed = action.kind === "inject_note"
        ? { ...view, pill: "QUEUED" as const, text: "Coordination note queued to both tasks. Hook pickup and delivery remain separate later facts.", tip: "SQLite accepted both queue rows atomically; neither task is shown as having received the note yet." }
        : action.kind === "pause_side"
          ? { ...view, pill: "REQUESTED" as const, text: "Pause requested. The task is not shown as stopped until runtime evidence says so.", tip: "SQLite accepted the pause request; later hook/runtime evidence determines pickup and state." }
          : view;
      setFeedback({ action, view: confirmed });
    } else setFeedback(null);
  };

  const inject = () => {
    const note = noteRef.current?.value.trim() ?? "";
    if (note === "" && !snapshot.diagnosis) {
      // Nothing to default to (no Suggested line) — an empty send would be
      // an empty message. Honest response: hand focus to the note.
      noteRef.current?.focus();
      return;
    }
    const action: AdjudicationAction =
      note === "" ? { kind: "inject_note" } : { kind: "inject_note", note };
    void applyReal(action, injectFeedback(note));
  };

  const pauseSide = (task: Task, noop: boolean) => {
    setMenuOpen(false);
    if (noop) return; // pausing an already-waiting task does nothing (S2)
    const action: AdjudicationAction = { kind: "pause_side", taskId: task.id };
    void applyReal(action, pauseFeedback(snapshot, task));
  };

  const ignorePair = () => {
    setConfirmIgnore(false);
    const action: AdjudicationAction = { kind: "ignore_pair" };
    void applyReal(action, ignoreFeedback(snapshot));
  };

  const openSide = (task: Task) => onOpenTask(task);
  const sideKey = (e: ReactKeyboardEvent, task: Task) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openSide(task);
    }
  };

  const age = detectedAge(snapshot);
  const grade = gradeView(snapshot);
  const sides = sideViews(snapshot);
  const count = symbolCount(snapshot);
  const toggle = symbolToggle(snapshot);
  const shown = symsOpen ? snapshot.symbols : snapshot.symbols.slice(0, VISIBLE_SYMBOLS);
  const note = noteView(snapshot);
  const prov = snapshot.diagnosis
    ? provenanceView(snapshot, snapshot.diagnosis)
    : null;

  return (
    <div
      className="modal"
      role="dialog"
      aria-label={`Conflict: ${snapshot.crumb.resourceName}`}
    >
      {/* zone a: header */}
      <header className="chead">
        <div className="row1">
          <span className="pill clash" data-tip={CONFLICT_PILL_TIP}>
            CONFLICT
          </span>
          <h2 data-tip={titleTip(snapshot)}>{snapshot.crumb.resourceName}</h2>
          <span className="age" data-tip={age.tip}>
            {age.text}
          </span>
          <button
            type="button"
            className="pclose"
            data-tip={CLOSE_TIP}
            aria-label="Close conflict card"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>
        <div className="crumb">
          {crumbSegs(snapshot).map((seg, i) => (
            <span key={i} style={{ display: "contents" }}>
              {i > 0 && <span className="sep" />}
              <span className={`m${seg.mono ? " mono" : ""}`} data-tip={seg.tip}>
                {seg.text}
              </span>
            </span>
          ))}
        </div>
      </header>

      {/* grading strip */}
      <div
        className={`grade ${grade.cls}${seams.top ? " seam" : ""}`}
        data-tip={grade.tip}
      >
        <b>{grade.kicker}</b>
        <span>{grade.text}</span>
      </div>

      <div className="cbody" ref={bodyRef} onScroll={recalcSeams}>
        {/* zone a1: the two tasks */}
        <section>
          <h4 data-tip={BETWEEN_TIP}>Between</h4>
          {sides.map((s) => (
            <div
              key={s.task.id}
              className="side"
              data-tip={SIDE_ROW_TIP}
              tabIndex={0}
              onClick={() => openSide(s.task)}
              onKeyDown={(e) => sideKey(e, s.task)}
            >
              <span className={`pill ${s.pill.kind}`} data-tip={s.pill.tip}>
                {s.pill.text}
              </span>
              <h3 data-tip={s.task.title}>{s.task.title}</h3>
              <div className="chips">
                {s.chips.map((c, i) => (
                  <span key={i} className={`chip ${c.kind}`} data-tip={c.tip}>
                    {c.label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </section>

        {/* zone a2: shared symbols */}
        <section className={`shared${symsOpen ? " open" : ""}`}>
          <h4 data-tip={count.tip}>
            Shared symbols <span className="mono">{count.text}</span>
          </h4>
          {shown.map((s) => {
            const row = symbolRow(snapshot, s);
            return (
              <div className="sym" key={s.name}>
                <span className="dot" />
                <span className="name" data-tip={row.nameTip}>
                  {row.name}
                </span>
                <span className="who" data-tip={row.whoTip}>
                  {row.who}
                </span>
              </div>
            );
          })}
          {toggle && (
            <button
              type="button"
              className="symtoggle"
              data-tip={toggle.tip}
              aria-expanded={symsOpen}
              onClick={() => setSymsOpen((v) => !v)}
            >
              <span className="lbl">{symsOpen ? "show less" : toggle.moreLabel}</span>
              <Caret />
            </button>
          )}
        </section>

        {/* zone b: AI diagnosis */}
        <section className="diag">
          <h4 data-tip={DIAG_H4_TIP}>AI diagnosis</h4>
          {snapshot.diagnosis && prov ? (
            <>
              <div className="verdict">
                <b>{codeSpans(snapshot.diagnosis.verdict)}</b>
                {snapshot.diagnosis.sides.map((side) => (
                  <div className="vline" key={side.taskId}>
                    <span className="vk" data-tip={SIDE_LABEL_TIP}>
                      {side.label}
                    </span>
                    <span className="vt">{codeSpans(side.doing)}</span>
                  </div>
                ))}
                <div className="vline">
                  <span className="vk" data-tip={SUGGESTED_TIP}>
                    Suggested
                  </span>
                  <span className="vt">{codeSpans(snapshot.diagnosis.suggested)}</span>
                </div>
              </div>
              <div className={`prov${prov.stale ? " stale" : ""}`}>
                <span className="pdot" />
                <span className="m" data-tip={prov.tip}>
                  {prov.text}
                </span>
                {prov.edits && (
                  <span className="edits" data-tip={prov.edits.tip}>
                    {prov.edits.text}
                  </span>
                )}
                <button
                  type="button"
                  disabled={Boolean(onApply)}
                  data-tip={onApply ? "Diagnosis generation is unsupported until external-model use is separately approved." : prov.rerunTip}
                  aria-pressed={stubNote}
                  onClick={() => setStubNote((v) => !v)}
                >
                  Re-run
                </button>
              </div>
              {stubNote && (
                <p className="stubnote" data-tip={PREVIEW_TIP}>
                  {codeSpans(RERUN_STUB)}
                </p>
              )}
            </>
          ) : (
            // true empty state → dashed placeholder is sanctioned here
            <div className="diag-empty">
              <p>{DIAG_EMPTY.p}</p>
              <p className="cap">
                {DIAG_EMPTY.capBefore}
                <i>{DIAG_EMPTY.capEm}</i>
                {DIAG_EMPTY.capAfter}
              </p>
              <button
                type="button"
                disabled={Boolean(onApply)}
                data-tip={onApply ? "Diagnosis generation is unsupported until external-model use is separately approved." : DIAG_EMPTY.buttonTip}
                aria-pressed={stubNote}
                onClick={() => setStubNote((v) => !v)}
              >
                {DIAG_EMPTY.button}
              </button>
              {stubNote && (
                <p className="stubnote" data-tip={PREVIEW_TIP}>
                  {codeSpans(RUN_STUB)}
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      {/* zone c: adjudication — actions, or the confirmed feedback band */}
      <footer className={`cfoot${seams.bottom ? " seam" : ""}`}>
        {actionError && <p className="stubnote" role="alert">{actionError}</p>}
        {receipt && !feedback && <p className="stubnote" role="status">
          <b>{receipt.outcome}</b>{receipt.message ? ` — ${receipt.message}` : " — No additional message."}{" "}
          <time dateTime={receipt.acceptedAt}>{receipt.acceptedAt}</time>
        </p>}
        {feedback ? (
          <div
            className="fdbk"
            data-kind={feedback.action.kind}
            role="status"
            aria-live="polite"
          >
            <span className={`pill ${feedback.view.kind}`} data-tip={feedback.view.tip}>
              {feedback.view.pill}
            </span>
            <p>
              {feedback.view.text}{" "}
              {!onApply && <span className="preview" data-tip={PREVIEW_TIP}>preview</span>}
              {receipt && <><br /><b>{receipt.outcome}</b>{receipt.message ? ` — ${receipt.message}` : " — No additional message."}{" "}<time dateTime={receipt.acceptedAt}>{receipt.acceptedAt}</time></>}
            </p>
            <button
              type="button"
              className="quiet"
              ref={fdbkCloseRef}
              data-tip={FEEDBACK_CLOSE.tip}
              onClick={onClose}
            >
              {FEEDBACK_CLOSE.label}
            </button>
          </div>
        ) : (
          <>
            <textarea
              ref={noteRef}
              placeholder={note.placeholder}
              data-tip={note.tip}
              onInput={autogrow}
            />
            <div className="actions">
              <button type="button" className="send" disabled={applying} data-tip={INJECT_TIP} onClick={inject}>
                Inject to both
              </button>
              <div className={`split${menuOpen ? " open" : ""}`}>
                <button
                  type="button"
                  className="quiet"
                  data-tip={PAUSE_TRIGGER_TIP}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmIgnore(false); // one open decision at a time
                    setMenuOpen((v) => !v);
                  }}
                >
                  Pause one side
                  <Caret />
                </button>
                {menuOpen && (
                  <div className="pmenu" role="menu">
                    {pauseRows(snapshot).map((r) => (
                      <button
                        type="button"
                        role="menuitem"
                        key={r.task.id}
                        className={r.noop ? "noop" : ""}
                        data-tip={r.tip}
                        onClick={() => pauseSide(r.task, r.noop)}
                      >
                        <b>{r.name}</b>
                        <span className="st">{r.st}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <span className="gap" />
              {confirmIgnore ? (
                <span className="confirm" role="group" aria-label="Confirm ignore">
                  <span className="q">{IGNORE_CONFIRM.q}</span>
                  <button
                    type="button"
                    className="doit"
                    data-tip={IGNORE_CONFIRM.confirmTip}
                    onClick={ignorePair}
                  >
                    {IGNORE_CONFIRM.confirm}
                  </button>
                  <button
                    type="button"
                    className="keep"
                    ref={keepRef}
                    data-tip={IGNORE_CONFIRM.keepTip}
                    onClick={() => setConfirmIgnore(false)}
                  >
                    {IGNORE_CONFIRM.keep}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="ignore"
                  data-tip={ignoreTip(snapshot)}
                  onClick={() => {
                    setMenuOpen(false); // one open decision at a time
                    setConfirmIgnore(true);
                  }}
                >
                  Ignore this pair
                </button>
              )}
            </div>
          </>
        )}
      </footer>
    </div>
  );
}
