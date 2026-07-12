import type { MapFixture, Task } from "../types";
import { groupTasks } from "../derive";
import { TaskCard } from "./TaskCard";

function LaunchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </svg>
  );
}

export interface TaskRailProps {
  fixture: MapFixture;
  /**
   * Resizable split (rev-1, Wayne verdict): the rail's current width in px,
   * driven by the divider in App. Omitted → the CSS default (300px, v8).
   */
  width?: number | undefined;
  /** Correlate-hover: dim the whole rail except hot cards. */
  dim: boolean;
  hotTaskIds: Set<string>;
  onTaskHoverStart: (task: Task) => void;
  onTaskHoverEnd: () => void;
  /** Click / Enter on a card opens the task panel over the map (m2 S4). */
  onTaskOpen: (task: Task) => void;
  /** The CONFLICT pill opens the adjudication card (m3 S4 open path #2). */
  onConflictOpen: (conflictId: string, opener: HTMLElement | null, task?: Task) => void;
}

export function TaskRail({
  fixture,
  width,
  dim,
  hotTaskIds,
  onTaskHoverStart,
  onTaskHoverEnd,
  onTaskOpen,
  onConflictOpen,
}: TaskRailProps) {
  const groups = groupTasks(fixture);
  let cardIndex = 0; // stagger index runs across group boundaries (v8)
  return (
    <aside
      className={`rail${dim ? " dim" : ""}`}
      style={width !== undefined ? { width } : undefined}
    >
      <div className="tasks">
        {groups.length === 0 ? (
          // N=0 rung: honest empty rail — no fake cards, just the truth.
          <div className="rail-empty">
            No tasks yet. Start one below — it runs on its own branch.
          </div>
        ) : (
          groups.map((g) => (
            <div className="group" key={g.title}>
              <h4>
                {g.title} <b>{g.tasks.length}</b>
              </h4>
              {g.tasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  fixture={fixture}
                  index={cardIndex++}
                  hot={hotTaskIds.has(t.id)}
                  onHoverStart={onTaskHoverStart}
                  onHoverEnd={onTaskHoverEnd}
                  onOpen={onTaskOpen}
                  onConflictOpen={onConflictOpen}
                />
              ))}
            </div>
          ))
        )}
      </div>
      <button
        className="launch"
        type="button"
        data-tip="Assemble context and launch a Claude Code session on a new branch"
      >
        <LaunchIcon />
        Start a task
      </button>
    </aside>
  );
}
