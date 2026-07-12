import type { MapFixture, Task } from "../types";
import { pillView, taskAge, taskChips } from "../derive";

export interface TaskCardProps {
  task: Task;
  fixture: MapFixture;
  /** Entry stagger index across ALL cards (v8: .05s + .04s * i). */
  index: number;
  hot: boolean;
  onHoverStart: (task: Task) => void;
  onHoverEnd: () => void;
  /** Click / Enter / Space opens the task panel (m2 S4). */
  onOpen: (task: Task) => void;
}

const STAGGER_BASE_S = 0.05; // v8 first card delay
const STAGGER_STEP_S = 0.04; // v8 per-card increment

export function TaskCard({
  task,
  fixture,
  index,
  hot,
  onHoverStart,
  onHoverEnd,
  onOpen,
}: TaskCardProps) {
  const pill = pillView(task);
  const chips = taskChips(task, fixture);
  const classes = ["task"];
  if (task.state === "done") classes.push("t-done");
  if (hot) classes.push("hot");
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
        <span className={`pill ${pill.kind}`} data-tip={pill.tip}>
          {pill.text}
        </span>
        {/* TEXT-long rung: title truncates (CSS ellipsis) + full text on hover */}
        <h3 data-tip={task.title}>{task.title}</h3>
        <span className="age">{taskAge(task, fixture)}</span>
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
