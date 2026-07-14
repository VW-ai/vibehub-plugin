import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import type { MapSnapshot, Task } from "@vibehub/core/contracts";
import { pillView, taskAge, taskChips } from "../derive";

export interface TaskCardProps {
  task: Task;
  snapshot: MapSnapshot;
  /** Entry stagger index across ALL cards (v8: .05s + .04s * i). */
  index: number;
  hot: boolean;
  onHoverStart: (task: Task) => void;
  onHoverEnd: () => void;
  /** Click / Enter / Space opens the task panel (m2 S4). */
  onOpen: (task: Task) => void;
  /** The CONFLICT pill opens the adjudication card (m3 S4 open path #2). */
  onConflictOpen: (conflictId: string, opener: HTMLElement | null, task?: Task) => void;
}

const STAGGER_BASE_S = 0.05; // v8 first card delay
const STAGGER_STEP_S = 0.04; // v8 per-card increment

export function TaskCard({
  task,
  snapshot,
  index,
  hot,
  onHoverStart,
  onHoverEnd,
  onOpen,
  onConflictOpen,
}: TaskCardProps) {
  const pill = pillView(task);
  const chips = taskChips(task, snapshot);
  const classes = ["task"];
  if (task.state === "done") classes.push("t-done");
  if (hot) classes.push("hot");
  // The CONFLICT pill is its own affordance ("Click to adjudicate" — its v8
  // tooltip): it opens the conflict card, while the rest of the card keeps
  // opening the task panel. Fork logged iter-12.
  const conflictId = pill.kind === "clash" ? task.conflictIds[0] : undefined;
  const pillClick =
    conflictId !== undefined
      ? {
          role: "button" as const,
          tabIndex: 0,
          onClick: (e: ReactMouseEvent<HTMLSpanElement>) => {
            e.stopPropagation(); // the card underneath opens the panel
            onConflictOpen(conflictId, e.currentTarget, task);
          },
          onKeyDown: (e: ReactKeyboardEvent<HTMLSpanElement>) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              onConflictOpen(conflictId, e.currentTarget, task);
            }
          },
        }
      : {};
  return (
    <div
      className={classes.join(" ")}
      style={{ animationDelay: `${STAGGER_BASE_S + STAGGER_STEP_S * index}s` }}
      data-task={task.id}
      tabIndex={0}
      onMouseEnter={() => onHoverStart(task)}
      onMouseLeave={onHoverEnd}
      onFocus={() => onHoverStart(task)}
      onBlur={onHoverEnd}
      onClick={() => onOpen(task)}
      onKeyDown={(e) => {
        // keyboard parity: cards are focusable, so open must be too
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(task);
        }
      }}
    >
      <div className="row1">
        <span className={`pill ${pill.kind}`} data-tip={pill.tip} {...pillClick}>
          {pill.text}
        </span>
        {/* TEXT-long rung: title truncates (CSS ellipsis) + full text on hover */}
        <h3 data-tip={task.title}>{task.title}</h3>
        <span className="age">{taskAge(task, snapshot)}</span>
      </div>
      <div className="row2">
        {chips.map((c, i) => (
          <span key={i} className={`chip ${c.kind}`} data-tip={c.tip}>
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}
