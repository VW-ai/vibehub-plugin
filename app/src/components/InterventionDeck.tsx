import { useRef, useState } from "react";
import type { AppliedIntervention, TaskState } from "@vibehub/core/contracts";
import { deckPlaceholder, deckTextareaTip, type DeckMode } from "../panel-derive";

/** S2: autogrow floor / ceiling (6 lines of fs-3×1.5 + 2×8 padding). */
const TEXTAREA_FLOOR_PX = 52;
const TEXTAREA_CEIL_PX = 124;

export interface InterventionDeckProps {
  state: TaskState;
  tailShown: boolean;
  onToggleTail: () => void;
  onSend?: (mode: DeckMode, text: string) => Promise<AppliedIntervention | string>;
}

function accepted(receipt: AppliedIntervention): boolean {
  return receipt.outcome === "applied" || receipt.outcome === "already_applied";
}

/**
 * Section 3 — the intervention deck, pinned (never scrolls away).
 * S2 behaviors preserved: mode toggle narrates its contract via the
 * placeholder; textarea autogrows 52→124px then scrolls internally;
 * "View transcript" carries a pressed state while the tail is open.
 * Send crosses the live intervention bridge. Unsupported controls remain
 * explicitly disabled rather than reporting optimistic success.
 */
export function InterventionDeck({ state, tailShown, onToggleTail, onSend }: InterventionDeckProps) {
  const [mode, setMode] = useState<DeckMode>("inject");
  const [receipt, setReceipt] = useState<AppliedIntervention | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  const autogrow = () => {
    const box = boxRef.current;
    if (!box) return;
    box.style.height = `${TEXTAREA_FLOOR_PX}px`;
    box.style.height = `${Math.min(box.scrollHeight, TEXTAREA_CEIL_PX)}px`;
  };

  const send = async () => {
    const text = boxRef.current?.value.trim() ?? "";
    if (!onSend || !text || sending) return;
    setSending(true);
    setError(null);
    setReceipt(null);
    const response = await onSend(mode, text);
    if (typeof response === "string") {
      setError(response);
    } else {
      setReceipt(response);
      if (accepted(response) && boxRef.current) boxRef.current.value = "";
    }
    setSending(false);
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
          disabled={!onSend || sending}
          onClick={() => void send()}
          data-tip={
            state === "waiting"
              ? "Queue the answer above. A later hook pickup is recorded separately."
              : "Queue the message above in the selected mode. This does not claim delivery."
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
          disabled
          data-tip="Resume without answering — the agent will decide on its own and note that you passed"
        >
          Resume
        </button>
        <button
          type="button"
          className="quiet"
          disabled
          data-tip="Diagnosis generation is unsupported until external-model use is separately approved."
        >
          AI diagnosis
        </button>
        <button
          type="button"
          className="quiet"
          disabled
          data-tip="Accept the work as done: closes the task and hands the branch to your normal PR flow"
        >
          Mark done
        </button>
        <span className="gap" />
        <button
          type="button"
          className="term"
          disabled
          data-tip="End the session. The branch and worktree stay on disk — nothing is deleted, you just stop paying attention to it."
        >
          Terminate
        </button>
      </div>
      {error && <p className="stubnote" role="alert">{error}</p>}
      {receipt && <p className="stubnote" role="status">
        <b>{receipt.outcome}</b>{receipt.message ? ` — ${receipt.message}` : " — No additional message."}{" "}
        <time dateTime={receipt.acceptedAt}>{receipt.acceptedAt}</time>
      </p>}
    </footer>
  );
}
