import { useMemo, useState } from "react";
import type { AdjudicationAction, ConflictCardSnapshot, MapSnapshot, Task, TaskPanelSnapshot, Territory, WorkbenchBridge, WorkbenchIntervention, WorkbenchRepoRef } from "@vibehub/core/contracts";
import { highlightForLegend, highlightForTask, highlightForTerritory, type LegendKind } from "./derive";
import { ConflictCard } from "./components/ConflictCard";
import { MapCanvas } from "./components/MapCanvas";
import { TaskPanel } from "./components/TaskPanel";
import { TaskRail } from "./components/TaskRail";
import { Titlebar } from "./components/Titlebar";
import { Tooltip } from "./components/Tooltip";

const EMPTY_IDS = new Set<string>();
type DetailError = { title: string; message: string; conflictId?: string };

/** Fixture-free production surface. Every detail and action crosses the host bridge. */
export function WorkbenchMap({ snapshot, bridge, repo }: { snapshot: MapSnapshot; bridge: WorkbenchBridge; repo: WorkbenchRepoRef }) {
  const [current, setCurrent] = useState(snapshot);
  const [hoverTask, setHoverTask] = useState<Task | null>(null);
  const [hoverTerritory, setHoverTerritory] = useState<Territory | null>(null);
  const [legend, setLegend] = useState<LegendKind | null>(null);
  const [panel, setPanel] = useState<TaskPanelSnapshot | null>(null);
  const [conflict, setConflict] = useState<ConflictCardSnapshot | null>(null);
  const [detailError, setDetailError] = useState<DetailError | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const highlight = useMemo(() => {
    if (hoverTask) return highlightForTask(hoverTask, current);
    if (hoverTerritory) return highlightForTerritory(hoverTerritory, current);
    if (legend) return highlightForLegend(legend, current);
    return { litIds: EMPTY_IDS, hotTaskIds: EMPTY_IDS };
  }, [hoverTask, hoverTerritory, legend, current]);
  const modalOpen = panel !== null || conflict !== null || detailError !== null || loadingDetail;
  const focused = !modalOpen && (hoverTask !== null || hoverTerritory !== null || legend !== null);
  const closeDetail = () => { setPanel(null); setConflict(null); setDetailError(null); setLoadingDetail(false); };

  const openTask = async (task: Task) => {
    setLoadingDetail(true); setConflict(null); setDetailError(null);
    const result = await bridge.getTaskPanel({ ...repo, taskId: task.id });
    setLoadingDetail(false);
    if (result.status === "ok") setPanel(result.data);
    else setDetailError({ title: "Task details unavailable", message: result.message });
  };
  const openConflict = async (conflictId: string) => {
    setLoadingDetail(true); setPanel(null); setDetailError(null);
    const result = await bridge.getConflictDetail({ ...repo, conflictId });
    setLoadingDetail(false);
    if (result.status === "ok") setConflict(result.data);
    else setDetailError({
      title: result.status === "evidence_unavailable" ? "Rich evidence unavailable" : "Conflict details unavailable",
      message: result.message,
      ...(result.status === "evidence_unavailable" ? { conflictId } : {}),
    });
  };
  const apply = async (intervention: WorkbenchIntervention): Promise<string | null> => {
    const result = await bridge.applyIntervention({ ...repo, requestId: crypto.randomUUID(), intervention });
    if (result.status !== "ok") return result.message;
    return result.data.outcome === "applied" || result.data.outcome === "already_applied"
      ? null : result.data.message ?? result.data.outcome;
  };
  const refresh = async () => {
    const result = await bridge.getSnapshot(repo);
    if (result.status === "ok") setCurrent(result.data);
  };
  const applyConflict = async (action: AdjudicationAction): Promise<string | null> => {
    if (!conflict) return "Conflict is no longer open.";
    if (action.kind === "inject_note") {
      const text = action.note?.trim() || conflict.diagnosis?.suggested;
      if (!text) return "A note is required because no stored diagnosis suggestion exists.";
      return apply({ kind: "inject_both", conflictId: conflict.conflict.id, text, contextLocus: `conflict:${conflict.conflict.id}` });
    }
    if (action.kind === "pause_side") return apply({ kind: "pause", taskId: action.taskId, text: "Pause and wait for user guidance.", contextLocus: `conflict:${conflict.conflict.id}` });
    const error = await apply({ kind: "ignore_pair", conflictId: conflict.conflict.id });
    if (!error) await refresh();
    return error;
  };

  return <div className="window" data-source="workbench-bridge">
    <Titlebar snapshot={current} snapshotNames={[]} activeSnapshot="" onSnapshotChange={() => undefined} onConflictOpen={(id) => void openConflict(id)} />
    <div className="main">
      <TaskRail snapshot={current} dim={focused} hotTaskIds={highlight.hotTaskIds}
        onTaskHoverStart={(task) => { if (!modalOpen) setHoverTask(task); }} onTaskHoverEnd={() => setHoverTask(null)}
        onTaskOpen={(task) => void openTask(task)} onConflictOpen={(id) => void openConflict(id)} />
      <MapCanvas snapshot={current} focus={focused} veiled={modalOpen} litIds={highlight.litIds}
        onFilterStart={setLegend} onFilterEnd={() => setLegend(null)} onTerritoryHoverStart={setHoverTerritory}
        onTerritoryHoverEnd={() => setHoverTerritory(null)} onConflictOpen={(id) => void openConflict(id)} />
      {modalOpen && <div className="scrim" onClick={closeDetail} />}
      {panel && <TaskPanel key={panel.task.id} panel={panel} map={current} onClose={closeDetail}
        onIntervention={(mode, text) => apply({ kind: mode, taskId: panel.task.id, text, contextLocus: `task:${panel.task.id}` })} />}
      {conflict && <ConflictCard key={conflict.conflict.id} snapshot={conflict} onClose={closeDetail}
        onOpenTask={(task) => void openTask(task)} onApply={applyConflict} />}
      {(loadingDetail || detailError) && <aside className="modal bootstrap-state" role="dialog">
        <h2>{loadingDetail ? "Loading details…" : detailError!.title}</h2>{detailError && <p>{detailError.message}</p>}
        {detailError?.conflictId && <button type="button" onClick={() => void (async () => {
          const error = await apply({ kind: "ignore_pair", conflictId: detailError.conflictId! });
          if (!error) { await refresh(); closeDetail(); }
          else setDetailError({ ...detailError, message: error });
        })()}>Ignore this pair</button>}
        <button type="button" onClick={closeDetail}>Close</button>
      </aside>}
    </div><Tooltip />
  </div>;
}
