/**
 * InstallChecklist (m4, S4) — the connect card's three-row checklist,
 * rendered PURELY from InstallStep[] (snapshot data via install-types).
 * Ported from the approved M0 first-run artifact: circle = pending, check = done,
 * breathe dot = now (the pre-connect screen's ONE persistent animation),
 * ✗ + mono "failed" in need tokens = failed (text pill first, color
 * reinforces), with the reason row + Retry beneath (Retry reruns ONLY the
 * failed step — steps are independent, iter-15 fork).
 */
import type { InstallStep } from "@vibehub/core/contracts";

function CircleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path
        d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM.5 8a7.5 7.5 0 1 1 15 0 7.5 7.5 0 0 1-15 0Z"
        fillRule="evenodd"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
    </svg>
  );
}

function FailIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
    </svg>
  );
}

/**
 * Per-step explanation copy, keyed by step id × status. CHROME, not data
 * (same rule as derive.ts pill/legend words): the copy explains what
 * decision-project-025's three install actions touch; the step's mechanical
 * truth (label, status, failure) all comes from the snapshot. Unknown step
 * ids fall back to the label — the shape survives installer changes.
 */
const STEP_TIPS: Record<string, { pending: string; now: string; done: string }> = {
  hooks: {
    pending:
      "Adds Vibehub to your Claude Code hooks (settings.json). Every session in this repo reports its events — you keep working in your terminal exactly as before.",
    now: "Adding Vibehub to this repo's Claude Code hooks (settings.json) — local file edit, no network.",
    done: "Done — Vibehub is in this repo's Claude Code hooks (settings.json). Sessions here now report their events.",
  },
  mcp: {
    pending:
      "Registers the Vibehub MCP server with Claude Code so sessions can declare scopes and self-report. Local process, no network.",
    now: "Registering the Vibehub MCP server with Claude Code — local process, no network.",
    done: "Done — the Vibehub MCP server is registered with Claude Code. Local process, no network.",
  },
  db: {
    pending:
      "One SQLite file next to your repo config. Everything Vibehub knows lives in it — yours to inspect or delete.",
    now: "Creating one SQLite file next to your repo config. Everything Vibehub knows lives in it — yours to inspect or delete.",
    done: "Done — one SQLite file next to your repo config. Everything Vibehub knows lives in it — yours to inspect or delete.",
  },
};

function stepTip(step: InstallStep): string {
  if (step.status === "failed" && step.failure) {
    return `${step.failure.codeRef} ${step.failure.reason} — this step failed. The other steps are independent; Retry runs only this one.`;
  }
  const tips = STEP_TIPS[step.id];
  if (!tips) return step.label;
  if (step.status === "done") return tips.done;
  if (step.status === "now") return tips.now;
  return tips.pending;
}

export interface InstallChecklistProps {
  steps: InstallStep[];
  /** Retry the failed step (preview path: rerun + complete). Absent = no retry UI action wired (pristine checklist). */
  onRetry?: ((stepId: string) => void) | undefined;
}

export function InstallChecklist({ steps, onRetry }: InstallChecklistProps) {
  return (
    <div className="steps">
      {steps.map((s) => (
        <div key={s.id}>
          <div
            className={`step${s.status === "pending" ? " pend" : ""}`}
            data-step={s.id}
            data-status={s.status}
            data-tip={stepTip(s)}
          >
            <span
              className={`ic${s.status === "done" ? " done" : ""}${s.status === "failed" ? " fail" : ""}`}
            >
              {s.status === "done" ? (
                <CheckIcon />
              ) : s.status === "failed" ? (
                <FailIcon />
              ) : s.status === "now" ? (
                <span className="busy" />
              ) : (
                <CircleIcon />
              )}
            </span>
            {s.label}
            {s.status === "done" && <span className="st done">done</span>}
            {s.status === "now" && <span className="st">now</span>}
            {s.status === "failed" && <span className="st fail">failed</span>}
          </div>
          {s.status === "failed" && s.failure && (
            <div
              className="why"
              data-tip={
                s.failure.fix
                  ? `The step touched ${s.failure.codeRef}. \`${s.failure.fix}\`, then retry.`
                  : `The step touched ${s.failure.codeRef} and reported: ${s.failure.reason}.`
              }
            >
              <code>{s.failure.codeRef}</code> {s.failure.reason}
              <button
                className="retry"
                type="button"
                data-tip="Runs this step again. The finished steps stay done — nothing reruns."
                onClick={() => onRetry?.(s.id)}
              >
                Retry
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
