import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { AdjudicationAction, AppliedIntervention, ConflictCardSnapshot, LiveShellRepoRef, LiveShellSnapshotV1, MapSnapshot, Task, TaskPanelSnapshot, Territory, WorkbenchBridge, WorkbenchIntervention } from "@vibehub/core/contracts";
import { highlightForLegend, highlightForTask, highlightForTerritory, type LegendKind } from "./derive";
import { deriveInterventionNote, type InterventionReceiptNote } from "./receipt-note-derive";
import { ConflictCard } from "./components/ConflictCard";
import { MapCanvas } from "./components/MapCanvas";
import { ReceiptOutcome } from "./components/ReceiptOutcome";
import { TaskPanel } from "./components/TaskPanel";
import { TaskRail } from "./components/TaskRail";
import { Titlebar } from "./components/Titlebar";
import { Tooltip } from "./components/Tooltip";
import { ActivationEvidenceStrip } from "./components/ActivationEvidenceStrip";
import { ContextFeedbackDock } from "./components/ContextFeedbackDock";
import { SectionEvidenceState } from "./components/SectionEvidenceState";

const EMPTY_IDS = new Set<string>();
const RAIL_MIN = 240;
const RAIL_MAX = 480;
const RAIL_DEFAULT = 300;
const RAIL_STEP = 16;
const RAIL_WIDTH_KEY = "vibehub-workbench.railWidth";

type DetailError = {
  title: string;
  message: string;
  conflictId?: string;
  receipt: InterventionReceiptNote | null;
};
type DetailTarget = { kind: "task" | "conflict"; id: string };
type InterventionResponse = InterventionReceiptNote | string;

const COVERAGE_LABELS = {
  operation_request: "Operation request",
  intervention_queue: "Intervention queue",
  injection_claim: "Injection claim",
  checkpoint: "Checkpoint",
} as const;

function WorkspaceEvidence({ shell }: { shell: LiveShellSnapshotV1 }) {
  const workspace = shell.workspace.data;
  if (!workspace) return <SectionEvidenceState section={shell.workspace} label="Workspace" />;
  const reads = workspace.observedFootprint.filter((item) => item.access === "read").length;
  const writes = workspace.observedFootprint.filter((item) => item.access === "write").length;
  return <header className="workspace-evidence-bar">
    <div className="workspace-facts">
      <span><b>Task</b>{workspace.currentTask ? `${workspace.currentTask.title} · ${workspace.currentTask.state}` : "None observed"}</span>
      <span><b>Session</b>{workspace.currentSession
        ? `${workspace.currentSession.id} · ${workspace.currentSession.identity.agent} · ${workspace.currentSession.startedAt} · ${workspace.currentSession.lifecycle}`
        : "None observed"}</span>
      <span className="declared-scope"><b>Declared scope</b>{workspace.declaredScope.length === 0
        ? "None registered"
        : workspace.declaredScope.map((scope) => <code key={`${scope.mode}:${scope.glob}:${scope.label ?? ""}`}>
            {scope.mode} · {scope.glob}{scope.label ? ` · ${scope.label}` : " · unlabeled"}
          </code>)}</span>
      <span><b>Observed</b>{reads} read · {writes} write</span>
      <span><b>Timeline</b>{workspace.timeline.length}</span>
      <span><b>Receipts</b>{workspace.receipts.length}</span>
    </div>
    <div className="coverage-facts" aria-label="Receipt coverage">
      {(Object.keys(COVERAGE_LABELS) as Array<keyof typeof COVERAGE_LABELS>).map((source) => {
        const coverage = workspace.receiptCoverage[source];
        return <span key={source} data-availability={coverage.availability}>
          <b>{COVERAGE_LABELS[source]}</b>
          <em className="evidence-secondary">{coverage.availability} · {coverage.freshness}</em>
          {coverage.recovery.map((item) => <small className="evidence-secondary" key={`${item.code}:${item.instruction}`}>{item.instruction}</small>)}
        </span>;
      })}
    </div>
    <SectionEvidenceState section={shell.workspace} label="Workspace" />
  </header>;
}

function interventionAccepted(receipt: AppliedIntervention): boolean {
  return receipt.outcome === "applied" || receipt.outcome === "already_applied";
}

function clampRail(width: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(width)));
}

function loadRailWidth(): number {
  try {
    const width = Number(window.localStorage.getItem(RAIL_WIDTH_KEY));
    if (Number.isFinite(width) && width >= RAIL_MIN && width <= RAIL_MAX) return width;
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  return RAIL_DEFAULT;
}

/** Fixture-free production surface. Every detail and action crosses the host bridge. */
function MapController({ snapshot, shell, onShellChange, bridge, repo }: { snapshot: MapSnapshot; shell: LiveShellSnapshotV1; onShellChange: (shell: LiveShellSnapshotV1) => void; bridge: WorkbenchBridge; repo: LiveShellRepoRef }) {
  const [current, setCurrent] = useState(snapshot);
  const [hoverTask, setHoverTask] = useState<Task | null>(null);
  const [hoverTerritory, setHoverTerritory] = useState<Territory | null>(null);
  const [legend, setLegend] = useState<LegendKind | null>(null);
  const [panel, setPanel] = useState<TaskPanelSnapshot | null>(null);
  const [conflict, setConflict] = useState<ConflictCardSnapshot | null>(null);
  const [detailError, setDetailError] = useState<DetailError | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [railWidth, setRailWidth] = useState(loadRailWidth);
  const [railDragging, setRailDragging] = useState(false);
  const railGrabOffset = useRef(0);
  const requestGeneration = useRef(0);
  const detailTarget = useRef<DetailTarget | null>(null);
  const detailOpener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
    } catch {
      // Width remains session-local when storage is unavailable.
    }
  }, [railWidth]);

  const highlight = useMemo(() => {
    if (hoverTask) return highlightForTask(hoverTask, current);
    if (hoverTerritory) return highlightForTerritory(hoverTerritory, current);
    if (legend) return highlightForLegend(legend, current);
    return { litIds: EMPTY_IDS, hotTaskIds: EMPTY_IDS };
  }, [hoverTask, hoverTerritory, legend, current]);
  const modalOpen = panel !== null || conflict !== null || detailError !== null || loadingDetail;
  const focused = !modalOpen && (hoverTask !== null || hoverTerritory !== null || legend !== null);

  const clearHovers = () => {
    setHoverTask(null);
    setHoverTerritory(null);
    setLegend(null);
  };

  const closeDetail = useCallback(() => {
    requestGeneration.current += 1;
    detailTarget.current = null;
    setPanel(null);
    setConflict(null);
    setDetailError(null);
    setLoadingDetail(false);
    const opener = detailOpener.current;
    detailOpener.current = null;
    if (opener) requestAnimationFrame(() => opener.focus());
  }, []);

  const beginDetail = (target: DetailTarget, opener: HTMLElement | null): number | null => {
    const active = detailTarget.current;
    if (active?.kind === target.kind && active.id === target.id) {
      closeDetail();
      return null;
    }
    const generation = ++requestGeneration.current;
    detailTarget.current = target;
    detailOpener.current = opener;
    clearHovers();
    setPanel(null);
    setConflict(null);
    setDetailError(null);
    setLoadingDetail(true);
    return generation;
  };

  const ownsRequest = (generation: number, target: DetailTarget): boolean => {
    const active = detailTarget.current;
    return requestGeneration.current === generation && active?.kind === target.kind && active.id === target.id;
  };

  const openTask = async (task: Task, opener?: HTMLElement | null) => {
    const target: DetailTarget = { kind: "task", id: task.id };
    // A task opened from inside conflict detail replaces that modal. Preserve
    // the durable outer opener instead of capturing a side row that unmounts.
    const durableOpener = opener === undefined
      ? detailOpener.current ?? (document.activeElement as HTMLElement | null)
      : opener;
    const generation = beginDetail(target, durableOpener);
    if (generation === null) return;
    const result = await bridge.getTaskPanel({ ...repo, taskId: task.id });
    if (!ownsRequest(generation, target)) return;
    setLoadingDetail(false);
    if (result.status === "ok") setPanel(result.data);
    else setDetailError({ title: "Task details unavailable", message: result.message, receipt: null });
  };

  const openConflict = async (conflictId: string, opener: HTMLElement | null = null) => {
    const target: DetailTarget = { kind: "conflict", id: conflictId };
    const generation = beginDetail(target, opener ?? (document.activeElement as HTMLElement | null));
    if (generation === null) return;
    const result = await bridge.getConflictDetail({ ...repo, conflictId });
    if (!ownsRequest(generation, target)) return;
    setLoadingDetail(false);
    if (result.status === "ok") setConflict(result.data);
    else setDetailError({
      title: result.status === "evidence_unavailable" ? "Rich evidence unavailable" : "Conflict details unavailable",
      message: result.message,
      receipt: null,
      ...(result.status === "evidence_unavailable" ? { conflictId } : {}),
    });
  };

  useEffect(() => {
    if (!modalOpen || conflict) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDetail();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeDetail, conflict, modalOpen]);

  const refreshAccepted = async (generation: number, target: DetailTarget) => {
    if (target.kind === "task") {
      const [snapshotResult, detailResult] = await Promise.all([
        bridge.getLiveShell(repo),
        bridge.getTaskPanel({ ...repo, taskId: target.id }),
      ]);
      if (!ownsRequest(generation, target)) return;
      if (snapshotResult.status === "ok") {
        onShellChange(snapshotResult.data);
        const map = snapshotResult.data.workspace.data?.map;
        if (map) setCurrent(map);
      }
      if (detailResult.status === "ok") setPanel(detailResult.data);
      return;
    }
    const [snapshotResult, detailResult] = await Promise.all([
      bridge.getLiveShell(repo),
      bridge.getConflictDetail({ ...repo, conflictId: target.id }),
    ]);
    if (!ownsRequest(generation, target)) return;
    if (snapshotResult.status === "ok") {
      onShellChange(snapshotResult.data);
      const map = snapshotResult.data.workspace.data?.map;
      if (map) setCurrent(map);
    }
    if (detailResult.status === "ok") setConflict(detailResult.data);
  };

  const apply = async (intervention: WorkbenchIntervention): Promise<InterventionResponse> => {
    const generation = requestGeneration.current;
    const target = detailTarget.current;
    const result = await bridge.applyIntervention({ ...repo, requestId: crypto.randomUUID(), intervention });
    if (result.status !== "ok") return result.message;
    if (target && interventionAccepted(result.data) && ownsRequest(generation, target)) {
      await refreshAccepted(generation, target);
    }
    // Project once at the one place holding both the intervention and its
    // result; every surface renders this same receipt truth.
    return deriveInterventionNote(intervention, result.data);
  };
  const applyConflict = async (action: AdjudicationAction): Promise<InterventionResponse> => {
    if (!conflict) return "Conflict is no longer open.";
    if (action.kind === "inject_note") {
      const text = action.note?.trim() || conflict.diagnosis?.suggested;
      if (!text) return "A note is required because no stored diagnosis suggestion exists.";
      return apply({ kind: "inject_both", conflictId: conflict.conflict.id, text, contextLocus: `conflict:${conflict.conflict.id}` });
    }
    if (action.kind === "pause_side") return apply({ kind: "pause", taskId: action.taskId, text: "Pause and wait for user guidance.", contextLocus: `conflict:${conflict.conflict.id}` });
    return apply({ kind: "ignore_pair", conflictId: conflict.conflict.id });
  };

  return <div className="window" data-source="workbench-bridge">
    <Titlebar snapshot={current} snapshotNames={[]} activeSnapshot="" onSnapshotChange={() => undefined} onConflictOpen={(id, opener) => void openConflict(id, opener)} />
    <ActivationEvidenceStrip shell={shell} />
    <section className="workspace-region" aria-label="Workspace evidence">
    <WorkspaceEvidence shell={shell} />
    <div
      className={`main${railDragging ? " rail-resizing" : ""}`}
      style={{ "--rail-w": `${railWidth}px` } as CSSProperties}
    >
      <TaskRail snapshot={current} width={railWidth} dim={focused} hotTaskIds={highlight.hotTaskIds}
        onTaskHoverStart={(task) => { if (!modalOpen) setHoverTask(task); }} onTaskHoverEnd={() => setHoverTask(null)}
        onTaskOpen={(task, opener) => void openTask(task, opener)} onConflictOpen={(id, opener) => void openConflict(id, opener)} />
      <div
        className={`divider${railDragging ? " dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the task rail"
        aria-valuemin={RAIL_MIN}
        aria-valuemax={RAIL_MAX}
        aria-valuenow={railWidth}
        tabIndex={0}
        data-tip="Drag to resize the rail · double-click resets · arrow keys nudge"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const main = event.currentTarget.parentElement;
          railGrabOffset.current = main
            ? event.clientX - (main.getBoundingClientRect().left + railWidth)
            : 0;
          event.currentTarget.setPointerCapture(event.pointerId);
          setRailDragging(true);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const main = event.currentTarget.parentElement;
          if (!main) return;
          setRailWidth(clampRail(event.clientX - main.getBoundingClientRect().left - railGrabOffset.current));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          setRailDragging(false);
        }}
        onPointerCancel={() => setRailDragging(false)}
        onDoubleClick={() => setRailWidth(RAIL_DEFAULT)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setRailWidth((width) => clampRail(width - RAIL_STEP));
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            setRailWidth((width) => clampRail(width + RAIL_STEP));
          }
        }}
      />
      <MapCanvas snapshot={current} focus={focused} veiled={modalOpen} litIds={highlight.litIds}
        onFilterStart={setLegend} onFilterEnd={() => setLegend(null)} onTerritoryHoverStart={setHoverTerritory}
        onTerritoryHoverEnd={() => setHoverTerritory(null)} onConflictOpen={(id, opener) => void openConflict(id, opener)} />
      {modalOpen && <div className="scrim" onClick={closeDetail} />}
      {panel && <TaskPanel key={panel.task.id} panel={panel} map={current} onClose={closeDetail}
        onIntervention={(mode, text) => apply({ kind: mode, taskId: panel.task.id, text, contextLocus: `task:${panel.task.id}` })} />}
      {conflict && <div className="center"><ConflictCard key={conflict.conflict.id} snapshot={conflict} onClose={closeDetail}
        onOpenTask={(task) => void openTask(task)} onApply={applyConflict} /></div>}
      {(loadingDetail || detailError) && <div className="center"><aside className="modal bootstrap-state" role="dialog">
        <h2>{loadingDetail ? "Loading details…" : detailError!.title}</h2>{detailError && <p>{detailError.message}</p>}
        {detailError?.receipt && <p role="status">
          <ReceiptOutcome note={detailError.receipt} />
        </p>}
        {detailError?.conflictId && <button type="button" onClick={() => void (async () => {
          const generation = requestGeneration.current;
          const target = detailTarget.current;
          if (!target || target.kind !== "conflict" || target.id !== detailError.conflictId) return;
          const fallback = detailError;
          setDetailError({ ...fallback, receipt: null });
          const response = await apply({ kind: "ignore_pair", conflictId: fallback.conflictId! });
          if (!ownsRequest(generation, target)) return;
          if (typeof response === "string") setDetailError({ ...fallback, message: response, receipt: null });
          else setDetailError({ ...fallback, receipt: response });
        })()}>Ignore this pair</button>}
        <button type="button" onClick={closeDetail}>Close</button>
      </aside></div>}
    </div></section><ContextFeedbackDock shell={shell} /><Tooltip />
  </div>;
}

/** Sole live-shell interaction controller. It never synthesizes workspace data. */
export function WorkbenchMap({ snapshot, bridge, repo }: { snapshot: LiveShellSnapshotV1; bridge: WorkbenchBridge; repo: LiveShellRepoRef }) {
  const [shell, setShell] = useState(snapshot);
  const map = shell.workspace.data?.map ?? null;
  if (map) return <MapController snapshot={map} shell={shell} onShellChange={setShell} bridge={bridge} repo={repo} />;
  return <div className="window live-shell-empty" data-source="workbench-bridge">
    <header className="titlebar" aria-label="Workbench titlebar">
      <div className="lights" aria-hidden="true"><i /><i /><i /></div><span className="wordmark">VibeHub</span>
    </header>
    <ActivationEvidenceStrip shell={shell} />
    <main className="workspace-unavailable" aria-label="Workspace evidence">
      <h1>Workspace evidence unavailable</h1>
      <p>No territory map was returned for this checkout. Nothing has been synthesized.</p>
      <SectionEvidenceState section={shell.workspace} label="Workspace" />
    </main>
    <ContextFeedbackDock shell={shell} /><Tooltip />
  </div>;
}
