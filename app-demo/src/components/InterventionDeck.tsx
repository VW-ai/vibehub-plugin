import { useRef, useState } from "react";
import type { TaskState } from "../types";
import { deckPlaceholder, deckTextareaTip, type DeckMode } from "../panel-derive";

/** S2: autogrow floor / ceiling (6 lines of fs-3×1.5 + 2×8 padding). */
const TEXTAREA_FLOOR_PX = 52;
const TEXTAREA_CEIL_PX = 124;

export interface InterventionDeckProps {
  state: TaskState;
  tailShown: boolean;
  onToggleTail: () => void;
}

/**
 * Section 3 — the intervention deck, pinned (never scrolls away).
 * S2 behaviors preserved: mode toggle narrates its contract via the
 * placeholder; textarea autogrows 52→124px then scrolls internally;
 * "View transcript" carries a pressed state while the tail is open.
 * Send/Resume/AI diagnosis/Mark done/Terminate are static affordances at
 * S4 (their real actions are S5+ scope); tooltips state their contracts.
 */
export function InterventionDeck({ state, tailShown, onToggleTail }: InterventionDeckProps) {
  const [mode, setMode] = useState<DeckMode>("inject");
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const autogrow = () => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = `${TEXTAREA_FLOOR_PX}px`;
    box.style.height = `${Math.min(box.scrollHeight, TEXTAREA_CEIL_PX)}px`;
  };

  return (
    <footer className="deck">
      <div className="modes" role="tablist" aria-label="Intervention mode">
        <button
          type="button"
          className={mode === "inject" ? "on" : ""}
          data-tip="Queue your message at the agent's next turn boundary — it keeps working and folds your note in"
          onClick={() => setMode("inject")}
        >
          Inject without interrupting
        </button>
        <button
          type="button"
          className={mode === "pause" ? "on" : ""}
          data-tip="Stop the agent first, then talk it through — it stays stopped until you press Resume"
          onClick={() => setMode("pause")}
        >
          Pause &amp; think together
        </button>
      </div>
      <textarea
        ref={boxRef}
        placeholder={deckPlaceholder(state, mode)}
        data-tip={deckTextareaTip(state)}
        onInput={autogrow}
      />
      <div className="actions">
        <button
          type="button"
          className="send"
          data-tip={
            state === "waiting"
              ? "Deliver the message above. The agent resumes with your answer."
              : "Deliver the message above, following the selected mode."
          }
        >
          Send
        </button>
        <button
          type="button"
          className={`quiet${tailShown ? " on" : ""}`}
          data-tip="Open the read-only transcript tail — the raw session feed behind this timeline"
          onClick={onToggleTail}
        >
          View transcript
        </button>
        <button
          type="button"
          className="quiet"
          data-tip="Resume without answering — the agent will decide on its own and note that you passed"
        >
          Resume
        </button>
        <button
          type="button"
          className="quiet"
          data-tip="Run a fresh AI pass that summarizes state, risks, and what it would do next — costs one model call"
        >
          AI diagnosis
        </button>
        <button
          type="button"
          className="quiet"
          data-tip="Accept the work as done: closes the task and hands the branch to your normal PR flow"
        >
          Mark done
        </button>
        <span className="gap" />
        <button
          type="button"
          className="term"
          data-tip="End the session. The branch and worktree stay on disk — nothing is deleted, you just stop paying attention to it."
        >
          Terminate
        </button>
      </div>
    </footer>
  );
}
