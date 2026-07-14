/**
 * InstallScreen (m4, S4) — the first-run / empty-install screen, dynamized
 * from the approved M0 first-run artifact. This is the
 * App's connection-state layer: it renders INSTEAD of the mapped-repo map
 * path whenever a RepoConnection is the subject (dev path: ?install=).
 *
 * State routing is fully implied by the snapshot data (never a variant name):
 *   connection none        → ConnectCard (Moment A)
 *   connection connecting  → ConnectCard with the InstallChecklist mid-flight
 *                            or failed (Moments A′/A″)
 *   connection connected   → full-bleed UNCATEGORIZED territory; guidance +
 *                            "Map this repo" (Moment B), MappingRun status
 *                            chip while a pass runs, and pre-mapping session
 *                            footprints placed by packFootprints (Moment C)
 *
 * The iter-15 storyboard (hard swap, no morph) runs behind the preview CTA
 * click path ONLY — direct ?install= loads stay static for parity shots:
 *   CTA → installing snapshot → steps advance (preview pacing) → last check
 *   lands → hold 400ms (2×--t-base) → card exits (reverse cardIn, 200ms) →
 *   connected chrome enters (200ms, single stagger step).
 *
 * S5 interactions: rail cards + footprints (+ the popover rows) open the
 * task panel — synthetic (launch row only, honesty rules in
 * snapshots/synthetic-panel.ts) since no pre-mapping task has an authored
 * panel. The "+N earlier sessions" chip opens a listing popover (the
 * collapsed sessions CANNOT honestly be re-shown as blocks: they collapsed
 * precisely because the floors no longer fit — fork logged iter-18).
 */
import { useEffect, useRef, useState } from "react";
import type { MapSnapshot, Task } from "@vibehub/core/contracts";
import type { TaskPanelSnapshot } from "@vibehub/core/contracts";
import type { InstallSnapshot, InstallStep, UncategorizedFootprint } from "@vibehub/core/contracts";
import {
  collapsedChipText,
  footprintExactFiles,
  footprintFootText,
  packFootprints,
} from "../install-derive";
import { relAge } from "../derive";
import { ConnectCard } from "./ConnectCard";
import { TaskCard } from "./TaskCard";
import { TaskPanel } from "./TaskPanel";
import { Tooltip } from "./Tooltip";

/* ── preview pacing (NOT product timing) ────────────────────────────────────
   STEP_MS: the real installer drives step statuses from CLI exits; the preview
   needs *some* cadence to be watchable — tunable, preview-only. HOLD_MS/EXIT_MS
   are the iter-15 storyboard values, derived from the motion tokens
   (2×--t-base / --t-base). */
const STEP_MS = 900;
const HOLD_MS = 400;
const EXIT_MS = 200;

/**
 * The uncategorized territory rect — presentation constant measured from the
 * approved S2 static (same caveat as TerritoryLayout in types.ts).
 */
const TERRITORY_RECT = { left: "3%", top: "4.5%", width: "94%", height: "88%" };

/** One preview tick: the running step completes, the next pending starts. */
function advanceSteps(steps: InstallStep[]): InstallStep[] {
  const out: InstallStep[] = steps.map((s) => ({ id: s.id, label: s.label, status: s.status }));
  const now = out.find((s) => s.status === "now");
  if (now) now.status = "done";
  const next = out.find((s) => s.status === "pending");
  if (next) next.status = "now";
  return out;
}

function RepoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
    </svg>
  );
}

function LaunchIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
    </svg>
  );
}

/** Footprint tooltip: count (exact) + the sampled paths, detail-on-demand. */
function footprintTip(title: string, fp: UncategorizedFootprint): string {
  const noun = fp.filesTouched === 1 ? "file" : "files";
  const sampled = fp.sampleFiles?.length
    ? `: ${fp.sampleFiles.join(", ")}${fp.sampleFiles.length < fp.filesTouched ? ", …" : ""}`
    : "";
  return `'${title}' has edited ${footprintExactFiles(fp.filesTouched)} ${noun} this session${sampled}. They'll attach to named features once the repo is mapped.`;
}

const MAP_BTN_TIP =
  "Runs one pass of your local claude (`claude -p`) to read the repo and sketch feature territories. ~10 minutes on a big repo — your machine, your account, no extra API key. Everything keeps working while it runs.";

export interface InstallScreenProps {
  snapshot: InstallSnapshot;
  resolveTaskPanel: (task: Task, map: MapSnapshot) => TaskPanelSnapshot;
  /** Dev switcher entries (`?switcher=0` hides it, same rule as the map). */
  installNames: string[];
  activeInstall: string;
  showSwitcher: boolean;
  onSwitch: (name: string) => void;
}

export function InstallScreen({
  snapshot,
  resolveTaskPanel,
  installNames,
  activeInstall,
  showSwitcher,
  onSwitch,
}: InstallScreenProps) {
  type TransitionPhase = "idle" | "running" | "exiting" | "entered";
  const [phase, setPhase] = useState<TransitionPhase>("idle");
  const [stepsOverride, setStepsOverride] = useState<InstallStep[] | null>(null);
  // "Map this repo" preview: local MappingRun override (no mapping-with-tasks
  // snapshot exists; the chip state must still be reachable — no dead pixels).
  const [mappingOverride, setMappingOverride] = useState<InstallSnapshot["mapping"] | null>(null);
  // Task panel (S5): rail cards, footprints and popover rows all open it.
  const [panel, setPanel] = useState<TaskPanelSnapshot | null>(null);
  // Focus returns to the exact opener on close (keyboard parity — same
  // recorded principle as the map screen). Selector, not element: rail
  // cards stay mounted under the scrim and are re-queried at close time.
  const openerSelector = useRef<string | null>(null);
  // "+N earlier sessions" popover (S5, fork iter-18: listing, not re-packing).
  const [chipOpen, setChipOpen] = useState(false);
  // Correlate-hover (S5): card ↔ footprint, one source at a time — the map's
  // dim/lit language (dim .14 + ring + scale). A collapsed task lights the
  // +N chip instead (its block has no pixels to light — honest).
  const [hoverTaskId, setHoverTaskId] = useState<string | null>(null);

  const conn = snapshot.connection;
  const mapping = mappingOverride ?? snapshot.mapping;

  /* ── preview machine (CTA / Retry click path only) ─────────────────────── */
  const onPick = () => {
    setPhase("running");
    onSwitch("installing"); // the approved storyboard used the same swap
  };
  const onRetry = (stepId: string) => {
    if (conn.kind !== "connecting") return;
    setStepsOverride(
      (stepsOverride ?? conn.steps).map((s) =>
        s.id === stepId ? { id: s.id, label: s.label, status: "now" as const } : s,
      ),
    );
    setPhase("running");
  };

  useEffect(() => {
    if (phase !== "running" || conn.kind !== "connecting") return;
    const steps = stepsOverride ?? conn.steps;
    if (steps.some((s) => s.status !== "done")) {
      const t = setTimeout(() => setStepsOverride(advanceSteps(steps)), STEP_MS);
      return () => clearTimeout(t);
    }
    // storyboard t=0: the last check just landed — the user must SEE it
    // (hold 400ms = 2×--t-base), then the exit phase takes over below
    const t = setTimeout(() => setPhase("exiting"), HOLD_MS);
    return () => clearTimeout(t);
  }, [phase, stepsOverride, conn]);

  useEffect(() => {
    if (phase !== "exiting") return;
    // card exits (reverse cardIn, 200ms) → hard swap, chrome enters (200ms)
    const t = setTimeout(() => {
      setPhase("entered");
      setStepsOverride(null);
      onSwitch("connected");
    }, EXIT_MS);
    return () => clearTimeout(t);
  }, [phase]);

  // manual snapshot switches reset any preview in flight / local overrides
  const switchTo = (name: string) => {
    setPhase("idle");
    setStepsOverride(null);
    setMappingOverride(null);
    setPanel(null); // a modal belongs to the snapshot it was opened from
    setChipOpen(false);
    onSwitch(name);
  };

  /* ── derived views ──────────────────────────────────────────────────── */
  const connected = conn.kind === "connected";
  const running = snapshot.tasks.filter((t) => t.state === "running").length;

  // Reuse the map's TaskCard (pill/age/chips) via a minimal MapSnapshot join —
  // territories stay empty on purpose: nothing is mapped yet.
  const mapLike: MapSnapshot | null =
    connected && snapshot.repo && snapshot.sync
      ? {
          capturedAt: snapshot.capturedAt,
          repo: snapshot.repo,
          sync: snapshot.sync,
          tasks: snapshot.tasks,
          territories: [],
          occupancy: [],
          conflicts: [],
        }
      : null;

  const packing = connected
    ? packFootprints(snapshot.footprints, conn.repoFiles)
    : { blocks: [], collapsedTaskIds: [] };
  const taskById = (id: string): Task | undefined => snapshot.tasks.find((t) => t.id === id);

  /* ── task panel (S5): synthetic — launch row only, honesty rules ─────── */
  const openTask = (task: Task, opener: string) => {
    if (!mapLike) return;
    setChipOpen(false);
    setHoverTaskId(null); // the scrim takes over — correlate yields
    openerSelector.current = opener;
    setPanel(resolveTaskPanel(task, mapLike));
  };
  const closePanel = () => {
    setPanel(null);
    const sel = openerSelector.current;
    if (sel) {
      // after the unmount paints — the opener is still mounted under the scrim
      requestAnimationFrame(() => document.querySelector<HTMLElement>(sel)?.focus());
    }
  };

  // Escape closes the panel (alongside X and scrim click) — same path as X,
  // so focus returns to the opener.
  useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel]);

  // The +N popover yields on Escape (focus back to the chip) / outside click.
  useEffect(() => {
    if (!chipOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setChipOpen(false);
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>(".fp-chip")?.focus(),
        );
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest(".fp-pop") && !t?.closest(".fp-chip")) setChipOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [chipOpen]);

  const freshAgeS = snapshot.sync?.lastFetchAt
    ? (Date.parse(snapshot.capturedAt) - Date.parse(snapshot.sync.lastFetchAt)) / 1000
    : null;

  const noop = () => {};
  let cardIndex = 0;

  return (
    <div className={`window first-run${phase === "entered" ? " enter" : ""}`}>
      <div className="titlebar">
        <div className="lights">
          <i />
          <i />
          <i />
        </div>
        <div className="wordmark">Vibehub</div>
        {!connected ? (
          <div
            className="norepo"
            data-tip="Vibehub watches one repo per window. Nothing is watched yet — connect a repo to start."
          >
            <RepoIcon />
            No repo connected
          </div>
        ) : (
          snapshot.repo && (
            <div className="repo" data-tip="Switch repository · one window per repo">
              <RepoIcon />
              {snapshot.repo.slug}{" "}
              <span className="branch">
                {snapshot.repo.defaultBranch} · {snapshot.repo.branchCount} branch
                {snapshot.repo.branchCount === 1 ? "" : "es"}
              </span>
            </div>
          )
        )}
        <div className="spacer" />
        {/* zero-count stats are hidden, not rendered as "0 waiting" noise */}
        {running > 0 && (
          <div className="stat alive" data-tip="Tasks making progress. Nothing needed from you">
            {running} running
          </div>
        )}
        {connected && snapshot.sync?.lastFetchAt && freshAgeS !== null && (
          <div
            className="fresh"
            data-tip={
              snapshot.sync.lastHookEventAt === null
                ? "Hooks installed and first git fetch done · click to sync now"
                : "Last git fetch + hook event · click to sync now"
            }
          >
            <span className="dot" />
            {freshAgeS < 1
              ? "Synced just now"
              : `Synced ${relAge(snapshot.sync.lastFetchAt, snapshot.capturedAt)} ago`}
          </div>
        )}
        {showSwitcher && installNames.length > 1 && (
          <select
            className="snapshot-switch"
            aria-label="Preview install snapshot"
            value={activeInstall}
            onChange={(e) => switchTo(e.target.value)}
          >
            {installNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="main">
        <aside className={`rail${hoverTaskId !== null ? " dim" : ""}`}>
          <div className="tasks">
            {!connected ? (
              // Moment A: true empty rail — dashed placeholder, connect is the
              // screen's ONE primary action (no launch button, iter-14 fork).
              <div
                className="rail-empty"
                data-tip="Tasks are Claude Code sessions on their own branches. The rail fills in as you launch them — or as hooks pick up sessions you start in your terminal."
              >
                <b>No tasks yet</b>
                Connect a repo to start.
              </div>
            ) : (
              <>
                <div className="group zero">
                  <h4 data-tip="Tasks that stopped to ask you something land here. None yet.">
                    Needs you <b>0</b>
                  </h4>
                </div>
                <div className={`group${running === 0 ? " zero" : ""}`}>
                  <h4
                    data-tip={
                      running === 0
                        ? "Live sessions land here — launched from Vibehub or picked up from your terminal by the installed hooks."
                        : "Live sessions — launched from Vibehub or picked up from your terminal by the installed hooks."
                    }
                  >
                    Running <b>{running}</b>
                  </h4>
                  {mapLike &&
                    snapshot.tasks.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        snapshot={mapLike}
                        index={cardIndex++}
                        hot={hoverTaskId === t.id}
                        onHoverStart={(task) => setHoverTaskId(task.id)}
                        onHoverEnd={() => setHoverTaskId(null)}
                        onOpen={(task) =>
                          openTask(task, `[data-task="${CSS.escape(task.id)}"]`)
                        }
                        onConflictOpen={noop} /* pre-mapping tasks carry no conflicts */
                      />
                    ))}
                </div>
                <div className="group zero">
                  <h4 data-tip="Tasks finished today. None yet.">
                    Done today <b>0</b>
                  </h4>
                </div>
              </>
            )}
          </div>
          {connected && (
            <button
              className="launch"
              type="button"
              data-tip="Assemble context and launch a Claude Code session on a new branch"
            >
              <LaunchIcon />
              Start a task
            </button>
          )}
        </aside>

        <section
          className={`canvas${panel ? " veiled" : ""}`}
          aria-hidden={panel !== null || undefined}
        >
          <div className="grid" />

          {!connected && (
            <ConnectCard
              connection={conn}
              stepsOverride={stepsOverride}
              exiting={phase === "exiting"}
              onPick={onPick}
              onRetry={onRetry}
            />
          )}

          {connected && (
            <div
              className={`terr quiet${hoverTaskId !== null && packing.blocks.length + packing.collapsedTaskIds.length > 0 ? " fpfocus" : ""}`}
              style={TERRITORY_RECT}
              data-tip={`Every file in ${snapshot.repo?.slug ?? "this repo"} lives here until the repo is mapped. Sessions, states and interventions all work without a map.`}
            >
              <div className="label">UNCATEGORIZED</div>
              <div
                className="foot"
                data-tip="Mapping is optional and never blocks anything — it only makes footprints land on named features instead of this gray."
              >
                this repo hasn&rsquo;t been mapped yet
              </div>

              {snapshot.tasks.length === 0 && (
                // Moment B: guidance stays until the first footprint replaces
                // it (iter-15: no timer — a timer is an invisible new concept).
                <div className="guide">
                  <p data-tip="The installed hooks watch every Claude Code session in this repo — launched from here or straight from your shell.">
                    Work normally in your terminal — sessions appear here as they happen.
                  </p>
                  {mapping.kind === "running" ? (
                    <button
                      className="mapstat"
                      type="button"
                      data-tip={`Your local claude is reading the repo to sketch feature territories — started ${relAge(mapping.startedAt, snapshot.capturedAt)} ago, usually ~10 minutes total. Everything keeps working while it runs. Click to stop the pass; nothing you've done is touched.`}
                      onClick={() => setMappingOverride({ kind: "none" })}
                    >
                      <span className="dot" />
                      Mapping this repo{" "}
                      <span className="t">{relAge(mapping.startedAt, snapshot.capturedAt)}</span>
                    </button>
                  ) : (
                    <button
                      className="mapbtn"
                      type="button"
                      data-tip={MAP_BTN_TIP}
                      onClick={() =>
                        setMappingOverride({ kind: "running", startedAt: snapshot.capturedAt })
                      }
                    >
                      Map this repo
                    </button>
                  )}
                </div>
              )}

              {snapshot.tasks.length > 0 &&
                // Moment C: the map action stays reachable, compact (iter-14).
                (mapping.kind === "running" ? (
                  <button
                    className="mapstat corner"
                    type="button"
                    data-tip={`Your local claude is reading the repo to sketch feature territories — started ${relAge(mapping.startedAt, snapshot.capturedAt)} ago, usually ~10 minutes total. Everything keeps working while it runs. Click to stop the pass; nothing you've done is touched.`}
                    onClick={() => setMappingOverride({ kind: "none" })}
                  >
                    <span className="dot" />
                    Mapping this repo{" "}
                    <span className="t">{relAge(mapping.startedAt, snapshot.capturedAt)}</span>
                  </button>
                ) : (
                  <button
                    className="mapbtn corner"
                    type="button"
                    data-tip={MAP_BTN_TIP}
                    onClick={() =>
                      setMappingOverride({ kind: "running", startedAt: snapshot.capturedAt })
                    }
                  >
                    Map this repo
                  </button>
                ))}

              {packing.blocks.map((b) => {
                const task = taskById(b.taskId);
                const fp = snapshot.footprints.find((f) => f.taskId === b.taskId);
                if (!task || !fp) return null;
                return (
                  <div
                    key={b.taskId}
                    className={`fp${hoverTaskId === b.taskId ? " lit" : ""}`}
                    data-fp={b.taskId}
                    role="button"
                    tabIndex={0}
                    onMouseEnter={() => setHoverTaskId(task.id)}
                    onMouseLeave={() => setHoverTaskId(null)}
                    onFocus={() => setHoverTaskId(task.id)}
                    onBlur={() => setHoverTaskId(null)}
                    style={{
                      left: `${b.left}%`,
                      top: `${b.top}%`,
                      width: `${b.width}%`,
                      height: `${b.height}%`,
                    }}
                    data-tip={footprintTip(task.title, fp)}
                    onClick={() =>
                      openTask(task, `[data-fp="${CSS.escape(task.id)}"]`)
                    }
                    onKeyDown={(e) => {
                      // keyboard parity: focusable, so open must be too
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openTask(task, `[data-fp="${CSS.escape(task.id)}"]`);
                      }
                    }}
                  >
                    <div className="who">{task.title}</div>
                    <div className="files">{footprintFootText(fp.filesTouched)}</div>
                  </div>
                );
              })}

              {packing.collapsedTaskIds.length > 0 && (
                <button
                  className={`fp-chip${hoverTaskId !== null && packing.collapsedTaskIds.includes(hoverTaskId) ? " hot" : ""}`}
                  type="button"
                  aria-haspopup="true"
                  aria-expanded={chipOpen}
                  data-tip={`${packing.collapsedTaskIds.length} earlier session${packing.collapsedTaskIds.length === 1 ? "" : "s"} collapsed so the newest stay legible. Click to list them — each opens its task. They'll attach to named features once the repo is mapped.`}
                  onClick={() => setChipOpen((v) => !v)}
                >
                  {collapsedChipText(packing.collapsedTaskIds.length)}
                </button>
              )}

              {chipOpen && packing.collapsedTaskIds.length > 0 && (
                // The collapsed sessions, listed (oldest first, the packing
                // order). NOT re-shown as blocks: they collapsed precisely
                // because the floors no longer fit (fork iter-18). Space
                // yields back on Escape / outside click / chip re-click.
                <div className="fp-pop" role="dialog" aria-label="Earlier sessions">
                  {packing.collapsedTaskIds.map((id) => {
                    const task = taskById(id);
                    const fp = snapshot.footprints.find((f) => f.taskId === id);
                    if (!task || !fp) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        className="row"
                        data-pop-task={task.id}
                        data-tip={footprintTip(task.title, fp)}
                        onClick={() => openTask(task, ".fp-chip")}
                      >
                        <span className="t">{task.title}</span>
                        <span className="n">
                          {footprintExactFiles(fp.filesTouched)}{" "}
                          {fp.filesTouched === 1 ? "file" : "files"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>

        {panel && mapLike && (
          <>
            <div
              className="scrim"
              data-tip="Click anywhere on the map to close the panel"
              onClick={closePanel}
            />
            {/* key: switching tasks remounts the panel (fresh tier/tail/scroll) */}
            <TaskPanel key={panel.task.id} panel={panel} map={mapLike} onClose={closePanel} />
          </>
        )}
      </div>
      <Tooltip />
    </div>
  );
}
