import type { MapSnapshot } from "@vibehub/core/contracts";
import type { TaskPanelSnapshot } from "@vibehub/core/contracts";
import { clockTime, pillView, relAge } from "../derive";
import { panelScopeChips, sessionMeta, twistView } from "../panel-derive";

/** v8 close × (inline SVG only). */
function CloseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

/** S2 bolt for the off-scope twist marker (inline SVG only). */
function BoltIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 1.5 3 9h4l-.5 5.5L13 7H9l.5-5.5Z" />
    </svg>
  );
}

export interface PanelIdentityProps {
  panel: TaskPanelSnapshot;
  /** The map snapshot underneath — resolves territory names for scope tips. */
  map: MapSnapshot;
  onClose: () => void;
}

/** Section 1 — identity: pill · title · age · close / meta row / scopes. */
export function PanelIdentity({ panel, map, onClose }: PanelIdentityProps) {
  const { task, session } = panel;
  const pill = pillView(task);
  const chips = panelScopeChips(task, map);
  const meta = session ? sessionMeta(session) : null;
  const twist = twistView(panel);
  return (
    <header className="phead">
      <div className="row1">
        <span className={`pill ${pill.kind}`} data-tip={pill.tip}>
          {pill.text}
        </span>
        {/* TEXT-long rung: single-line ellipsis; the tooltip carries the full title */}
        <h2 data-tip={task.title}>{task.title}</h2>
        <span
          className="age"
          data-tip={`In ${task.state.toUpperCase()} since ${clockTime(task.stateSince)}`}
        >
          {relAge(task.stateSince, panel.capturedAt)}
        </span>
        <button
          type="button"
          className="pclose"
          data-tip="Close the panel and return to the map"
          aria-label="Close panel"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="meta">
        <span className="m" data-tip="Runtime driving this task">
          {session?.agent ?? "No active session"}
        </span>
        <span className="sep" />
        <span
          className="m mono trunc"
          data-tip={`branch ${task.git.branch}${task.git.worktreePath ? " — checked out in its own worktree" : ""}`}
        >
          {task.git.branch}
        </span>
        {task.git.worktreePath && (
          <>
            <span className="sep" />
            <span
              className="m mono trunc"
              style={{ maxWidth: 130 }}
              data-tip={`worktree ${task.git.worktreePath} — full path shown here when the row truncates`}
            >
              {task.git.worktreePath}
            </span>
          </>
        )}
        {meta && <><span className="sep" /><span className="m" data-tip={meta.tip}>{meta.text}</span></>}
      </div>
      <div className="scopes">
        {chips.map((c, i) => (
          <span key={i} className={`chip ${c.kind}`} data-tip={c.tip}>
            {c.label}
          </span>
        ))}
        {twist && (
          <span className="twist" data-tip={twist.tip}>
            <BoltIcon />
            {twist.text}
          </span>
        )}
      </div>
    </header>
  );
}
