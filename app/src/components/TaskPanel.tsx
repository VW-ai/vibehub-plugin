import { useState } from "react";
import type { AppliedIntervention, MapSnapshot } from "@vibehub/core/contracts";
import type { TaskPanelSnapshot } from "@vibehub/core/contracts";
import { PanelIdentity } from "./PanelIdentity";
import { Timeline } from "./Timeline";
import { TranscriptTail } from "./TranscriptTail";
import { InterventionDeck } from "./InterventionDeck";

export interface TaskPanelProps {
  panel: TaskPanelSnapshot;
  /** The map snapshot underneath (territory-name resolution for scope tips). */
  map: MapSnapshot;
  onClose: () => void;
  onIntervention?: (mode: "inject" | "pause", text: string) => Promise<AppliedIntervention | string>;
}

/**
 * The task panel (m2) — S2's three sections, dynamized: identity (flex:none)
 * / human timeline (flex:1, the only scroll region) / intervention deck
 * (flex:none, pinned — no timeline length can push it off-screen).
 * Slides in 200ms over the dimmed+scrimmed map; the parent (App) owns
 * open/close (X · Escape · scrim click) and remounts per task via key.
 */
export function TaskPanel({ panel, map, onClose, onIntervention }: TaskPanelProps) {
  const [tailShown, setTailShown] = useState(false);
  return (
    <aside className="panel" role="dialog" aria-label={`Task: ${panel.task.title}`}>
      <PanelIdentity panel={panel} map={map} onClose={onClose} />
      <Timeline panel={panel} />
      <TranscriptTail lines={panel.transcriptTail} show={tailShown} />
      <InterventionDeck
        state={panel.task.state}
        tailShown={tailShown}
        onToggleTail={() => setTailShown((v) => !v)}
        {...(onIntervention ? { onSend: onIntervention } : {})}
      />
    </aside>
  );
}
