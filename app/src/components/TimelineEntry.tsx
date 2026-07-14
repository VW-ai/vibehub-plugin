import { useState } from "react";
import type { TimelineEvent } from "@vibehub/core/contracts";
import { eventVoice, isMechanical, timeTip } from "../panel-derive";
import { clockTime } from "../derive";

/** v8 chevron (inline SVG only — no emoji per taste profile). */
function Chevron() {
  return (
    <svg className="car" width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface TimelineEntryProps {
  event: TimelineEvent;
  /** Declared write scope labels ("w auth") — off-scope tooltip context. */
  writeScopeLabels: string;
}

/**
 * One timeline row — markup + chrome copy ported from the approved S2
 * static per event type. All CONTENT (prompts, reports, files, counts,
 * shas) comes from the event; the templates only explain semantics.
 */
export function TimelineEntry({ event: e, writeScopeLabels }: TimelineEntryProps) {
  // file_change expandable state (S2: .ev.open toggles the file list)
  const [open, setOpen] = useState(false);

  const classes = ["ev", eventVoice(e)];
  if (isMechanical(e)) classes.push("mech");
  if (e.type === "file_change" && open) classes.push("open");

  return (
    <div className={classes.join(" ")}>
      <span className="t" data-tip={timeTip(e)}>
        {clockTime(e.at)}
      </span>
      <span className="dot" />
      {body(e, open, () => setOpen((v) => !v), writeScopeLabels)}
    </div>
  );
}

function body(
  e: TimelineEvent,
  open: boolean,
  toggle: () => void,
  writeScopeLabels: string,
) {
  switch (e.type) {
    case "launch":
      return (
        <div
          className="body"
          data-tip="Your launch prompt — the task's founding instruction, kept verbatim at the top of its history"
        >
          <div className="who">You · launched</div>
          &ldquo;{e.prompt}&rdquo;
        </div>
      );
    case "self_report":
      return (
        <div
          className="body"
          data-tip="The agent narrates its own plan at each turn — these self-reports are the backbone of the timeline"
        >
          {e.kicker && <b>{e.kicker}</b>} &ldquo;{e.text}&rdquo;
          {e.footprintCorroboration && (
            <div
              className="subnote"
              data-tip="The system cross-checks self-reports against the git footprint — here they agree, which is why the marker stays low-key"
            >
              &#8627; system flagged the same thing: footprint outside declared scope
            </div>
          )}
        </div>
      );
    case "test_run":
      return (
        <div
          className="body"
          data-tip="Mechanical step, captured from hooks. Hidden when the toggle is on Milestones."
        >
          Ran the test suite — {e.passed} passing, {e.failed} failing
          {e.note ? ` (${e.note})` : ""}
        </div>
      );
    case "file_change": {
      const inScope = e.files.filter((f) => !f.offScope);
      const outScope = e.files.filter((f) => f.offScope);
      return (
        <div className="body">
          <button
            type="button"
            className="filestoggle"
            data-tip="Edits are collapsed into one entry per work burst — click to see the file list"
            aria-expanded={open}
            onClick={toggle}
          >
            <b>
              {e.files.length} file{e.files.length === 1 ? "" : "s"} changed
            </b>
            <Chevron />
          </button>
          <div className="files">
            {inScope.map((f) => (
              <span key={f.path}>
                {f.path}
                <br />
              </span>
            ))}
            {outScope.length > 0 && (
              <span
                className="out"
                data-tip={`${outScope.length === 1 ? "This one sits" : `These ${outScope.length} sit`} outside the declared write scope '${writeScopeLabels}' — the source of the off-scope marker in the header`}
              >
                {outScope.map((f) => f.path).join(" · ")} &nbsp;— outside declared
                scope
              </span>
            )}
          </div>
        </div>
      );
    }
    case "file_read":
      return (
        <div
          className="body"
          data-tip="Mechanical step, captured from hooks. Hidden when the toggle is on Milestones."
        >
          Read {e.count} file{e.count === 1 ? "" : "s"} in {e.territoryName} (
          {e.inDeclaredScope ? "declared read scope" : "outside declared read scopes"})
        </div>
      );
    case "user_injection":
      return (
        <div
          className="body"
          data-tip={
            e.mode === "inject"
              ? "A hook claimed this queued injection for its response. Claude has not acknowledged receipt."
              : "A hook claimed this queued pause instruction for its response. Claude has not acknowledged receipt."
          }
        >
          <div className="who">
            {e.mode === "inject" ? "You · injection picked up by hook" : "You · pause request picked up by hook"}
          </div>
          &ldquo;{e.text}&rdquo;
        </div>
      );
    case "user_intervention":
      return (
        <div className="body" data-tip={
          e.action === "inject"
            ? "Queued in SQLite. Delivery is recorded separately only when a hook observes it."
            : e.action === "pause"
              ? "Pause requested in SQLite. The agent has not necessarily stopped yet."
              : "This canonical task/branch pair is now ignored for conflict display."
        }>
          <div className="who">
            {e.action === "inject" ? "You · injection queued" : e.action === "pause" ? "You · pause requested" : "You · ignored conflict pair"}
          </div>
          &ldquo;{e.text}&rdquo;
        </div>
      );
    case "agent_ack":
      return (
        <div className="body" data-tip="The agent confirms how it absorbed your injection">
          {e.kicker && <b>{e.kicker}</b>} {e.text}
        </div>
      );
    case "question":
      return (
        <div
          className="body"
          data-tip="This question is why the task is WAITING. Answer below — Send delivers it immediately; the agent is parked."
        >
          <b>Stopped to ask you:</b> &ldquo;{e.text}&rdquo;
        </div>
      );
    case "cross_read_notice":
      return (
        <div
          className="body"
          data-tip="Read/read overlap is not a conflict — no one is writing the same thing. Shown quietly so you know the tasks are near each other."
        >
          Also reading <span className="mono">{e.file}</span> alongside &ldquo;
          {e.otherTaskTitle}&rdquo; — read/read overlap, not a conflict
        </div>
      );
    case "commit":
      return (
        <div
          className="body"
          data-tip={`A commit landed on the task's branch — the strongest milestone anchor${
            e.filesChanged !== undefined
              ? ` · ${e.filesChanged} file${e.filesChanged === 1 ? "" : "s"} changed`
              : ""
          }`}
        >
          <b>Committed.</b> <span className="mono">{e.sha}</span> &ldquo;{e.message}
          &rdquo;
        </div>
      );
    case "state_transition":
      return (
        <div
          className="body"
          data-tip="The task changed state — mapped mechanically from hook signals, never inferred"
        >
          <b>
            {cap(e.from)} &rarr; {cap(e.to)}.
          </b>
          {e.cause ? ` ${e.cause}` : ""}
        </div>
      );
  }
}
