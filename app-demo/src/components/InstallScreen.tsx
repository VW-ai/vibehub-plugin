/**
 * InstallScreen (m4, S4) — the first-run / empty-install screen, dynamized
 * from static/empty-install-s2.html (the approved S2 artifact). This is the
 * App's connection-state layer: it renders INSTEAD of the mapped-repo map
 * path whenever a RepoConnection is the subject (dev path: ?install=).
 *
 * State routing is fully implied by the fixture data (never a variant name):
 *   connection none        → ConnectCard (Moment A)
 *   connection connecting  → ConnectCard with the InstallChecklist mid-flight
 *                            or failed (Moments A′/A″)
 *   connection connected   → full-bleed UNCATEGORIZED territory; guidance +
 *                            "Map this repo" (Moment B), MappingRun status
 *                            chip while a pass runs, and pre-mapping session
 *                            footprints placed by packFootprints (Moment C)
 *
 * The iter-15 storyboard (hard swap, no morph) runs behind the demo CTA
 * click path ONLY — direct ?install= loads stay static for parity shots:
 *   CTA → installing fixture → steps advance (demo pacing) → last check
 *   lands → hold 400ms (2×--t-base) → card exits (reverse cardIn, 200ms) →
 *   connected chrome enters (200ms, single stagger step).
 */
import { useEffect, useState } from "react";
import type { MapFixture, Task } from "../types";
import type { InstallFixture, InstallStep, UncategorizedFootprint } from "../install-types";
import {
  collapsedChipText,
  footprintExactFiles,
  footprintFootText,
  packFootprints,
} from "../install-derive";
import { relAge } from "../derive";
import { ConnectCard } from "./ConnectCard";
import { TaskCard } from "./TaskCard";
import { Tooltip } from "./Tooltip";

/* ── demo pacing (NOT product timing) ────────────────────────────────────
   STEP_MS: the real installer drives step statuses from CLI exits; the demo
   needs *some* cadence to be watchable — tunable, demo-only. HOLD_MS/EXIT_MS
   are the iter-15 storyboard values, derived from the motion tokens
   (2×--t-base / --t-base). */
const STEP_MS = 900;
const HOLD_MS = 400;
const EXIT_MS = 200;

/**
 * The uncategorized territory rect — presentation constant measured from the
 * approved S2 static (same caveat as DemoLayout in types.ts).
 */
const TERRITORY_RECT = { left: "3%", top: "4.5%", width: "94%", height: "88%" };

/** One demo tick: the running step completes, the next pending starts. */
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
  fixture: InstallFixture;
  /** Dev switcher entries (`?switcher=0` hides it, same rule as the map). */
  installNames: string[];
  activeInstall: string;
  showSwitcher: boolean;
  onSwitch: (name: string) => void;
}

export function InstallScreen({
  fixture,
  installNames,
  activeInstall,
  showSwitcher,
  onSwitch,
}: InstallScreenProps) {
  type DemoPhase = "idle" | "running" | "exiting" | "entered";
  const [phase, setPhase] = useState<DemoPhase>("idle");
  const [stepsOverride, setStepsOverride] = useState<InstallStep[] | null>(null);
  // "Map this repo" demo: local MappingRun override (no mapping-with-tasks
  // fixture exists; the chip state must still be reachable — no dead pixels).
  const [mappingOverride, setMappingOverride] = useState<InstallFixture["mapping"] | null>(null);

  const conn = fixture.connection;
  const mapping = mappingOverride ?? fixture.mapping;

  /* ── demo machine (CTA / Retry click path only) ─────────────────────── */
  const onPick = () => {
    setPhase("running");
    onSwitch("installing"); // the static's CTA demoed the same swap
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

  // manual fixture switches reset any demo in flight / local overrides
  const switchTo = (name: string) => {
    setPhase("idle");
    setStepsOverride(null);
    setMappingOverride(null);
    onSwitch(name);
  };

  /* ── derived views ──────────────────────────────────────────────────── */
  const connected = conn.kind === "connected";
  const running = fixture.tasks.filter((t) => t.state === "running").length;

  // Reuse the map's TaskCard (pill/age/chips) via a minimal MapFixture join —
  // territories stay empty on purpose: nothing is mapped yet.
  const mapLike: MapFixture | null =
    connected && fixture.repo && fixture.sync
      ? {
          capturedAt: fixture.capturedAt,
          repo: fixture.repo,
          sync: fixture.sync,
          tasks: fixture.tasks,
          territories: [],
          occupancy: [],
          conflicts: [],
        }
      : null;

  const packing = connected
    ? packFootprints(fixture.footprints, conn.repoFiles)
    : { blocks: [], collapsedTaskIds: [] };
  const taskById = (id: string): Task | undefined => fixture.tasks.find((t) => t.id === id);

  const freshAgeS = fixture.sync?.lastFetchAt
    ? (Date.parse(fixture.capturedAt) - Date.parse(fixture.sync.lastFetchAt)) / 1000
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
          fixture.repo && (
            <div className="repo" data-tip="Switch repository · one window per repo">
              <RepoIcon />
              {fixture.repo.slug}{" "}
              <span className="branch">
                {fixture.repo.defaultBranch} · {fixture.repo.branchCount} branch
                {fixture.repo.branchCount === 1 ? "" : "es"}
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
        {connected && fixture.sync?.lastFetchAt && freshAgeS !== null && (
          <div
            className="fresh"
            data-tip={
              fixture.sync.lastHookEventAt === null
                ? "Hooks installed and first git fetch done · click to sync now"
                : "Last git fetch + hook event · click to sync now"
            }
          >
            <span className="dot" />
            {freshAgeS < 1
              ? "Synced just now"
              : `Synced ${relAge(fixture.sync.lastFetchAt, fixture.capturedAt)} ago`}
          </div>
        )}
        {showSwitcher && installNames.length > 1 && (
          <select
            className="fixture-switch"
            aria-label="Demo install fixture"
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
        <aside className="rail">
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
                    fixture.tasks.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        fixture={mapLike}
                        index={cardIndex++}
                        hot={false}
                        onHoverStart={noop}
                        onHoverEnd={noop}
                        onOpen={noop} /* panel wiring = S5 interactions */
                        onConflictOpen={noop}
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

        <section className="canvas">
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
              className="terr quiet"
              style={TERRITORY_RECT}
              data-tip={`Every file in ${fixture.repo?.slug ?? "this repo"} lives here until the repo is mapped. Sessions, states and interventions all work without a map.`}
            >
              <div className="label">UNCATEGORIZED</div>
              <div
                className="foot"
                data-tip="Mapping is optional and never blocks anything — it only makes footprints land on named features instead of this gray."
              >
                this repo hasn&rsquo;t been mapped yet
              </div>

              {fixture.tasks.length === 0 && (
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
                      data-tip={`Your local claude is reading the repo to sketch feature territories — started ${relAge(mapping.startedAt, fixture.capturedAt)} ago, usually ~10 minutes total. Everything keeps working while it runs. Click to stop the pass; nothing you've done is touched.`}
                      onClick={() => setMappingOverride({ kind: "none" })}
                    >
                      <span className="dot" />
                      Mapping this repo{" "}
                      <span className="t">{relAge(mapping.startedAt, fixture.capturedAt)}</span>
                    </button>
                  ) : (
                    <button
                      className="mapbtn"
                      type="button"
                      data-tip={MAP_BTN_TIP}
                      onClick={() =>
                        setMappingOverride({ kind: "running", startedAt: fixture.capturedAt })
                      }
                    >
                      Map this repo
                    </button>
                  )}
                </div>
              )}

              {fixture.tasks.length > 0 &&
                // Moment C: the map action stays reachable, compact (iter-14).
                (mapping.kind === "running" ? (
                  <button
                    className="mapstat corner"
                    type="button"
                    data-tip={`Your local claude is reading the repo to sketch feature territories — started ${relAge(mapping.startedAt, fixture.capturedAt)} ago, usually ~10 minutes total. Everything keeps working while it runs. Click to stop the pass; nothing you've done is touched.`}
                    onClick={() => setMappingOverride({ kind: "none" })}
                  >
                    <span className="dot" />
                    Mapping this repo{" "}
                    <span className="t">{relAge(mapping.startedAt, fixture.capturedAt)}</span>
                  </button>
                ) : (
                  <button
                    className="mapbtn corner"
                    type="button"
                    data-tip={MAP_BTN_TIP}
                    onClick={() =>
                      setMappingOverride({ kind: "running", startedAt: fixture.capturedAt })
                    }
                  >
                    Map this repo
                  </button>
                ))}

              {packing.blocks.map((b) => {
                const task = taskById(b.taskId);
                const fp = fixture.footprints.find((f) => f.taskId === b.taskId);
                if (!task || !fp) return null;
                return (
                  <div
                    key={b.taskId}
                    className="fp"
                    data-fp={b.taskId}
                    style={{
                      left: `${b.left}%`,
                      top: `${b.top}%`,
                      width: `${b.width}%`,
                      height: `${b.height}%`,
                    }}
                    data-tip={footprintTip(task.title, fp)}
                  >
                    <div className="who">{task.title}</div>
                    <div className="files">{footprintFootText(fp.filesTouched)}</div>
                  </div>
                );
              })}

              {packing.collapsedTaskIds.length > 0 && (
                <button
                  className="fp-chip"
                  type="button"
                  data-tip={`${packing.collapsedTaskIds.length} earlier session${packing.collapsedTaskIds.length === 1 ? "" : "s"} collapsed so the newest stay legible: ${packing.collapsedTaskIds
                    .map((id) => taskById(id)?.title ?? id)
                    .join(", ")}. They'll attach to named features once the repo is mapped.`}
                >
                  {collapsedChipText(packing.collapsedTaskIds.length)}
                </button>
              )}
            </div>
          )}
        </section>
      </div>
      <Tooltip />
    </div>
  );
}
