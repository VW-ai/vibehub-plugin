/**
 * ConnectCard (m4, S4) — the 420px first-run card, centered over the empty
 * canvas. Renders Moments A (RepoConnection none: heading + subline + solid
 * ink-900 CTA + pristine checklist + local-honesty line) and A′/A″
 * (connecting: CTA replaced by the picked path with LEADING-ellipsis
 * truncation, checklist mid-flight or failed). Everything mechanical comes
 * from install-types data; the pre-click checklist renders from
 * PRISTINE_INSTALL_STEPS (S3 open question 2 → resolved: data, not chrome —
 * one row component serves every status, fork logged iter-17).
 */
import type { RepoConnectionConnecting, RepoConnectionNone, InstallStep } from "@vibehub/core/contracts";
import { PRISTINE_INSTALL_STEPS } from "../install-manifest";
import { InstallChecklist } from "./InstallChecklist";

function FolderIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor">
      <path d="M1.75 1h5.5c.966 0 1.75.784 1.75 1.75v1h4.25c.966 0 1.75.784 1.75 1.75v7.75A1.75 1.75 0 0 1 13.25 15H2.75A1.75 1.75 0 0 1 1 13.25V2.75C1 1.784 1.784 1 2.75 1Z" />
    </svg>
  );
}

/**
 * Footer line = consequence honesty. All-pending → the privacy promise;
 * mid-install → expectation; a failed step → what the failure MEANS
 * (keyed by step id — chrome copy, same rule as InstallChecklist tips).
 */
const FAILURE_CONSEQUENCE: Record<string, string> = {
  hooks: "Sessions won't report until hooks install.",
  mcp: "Sessions can't declare scopes until the MCP server registers.",
  db: "Nothing can be recorded until the database is created.",
};

function localLine(steps: InstallStep[], preConnect: boolean): { text: string; tip: string } {
  const failed = steps.find((s) => s.status === "failed");
  if (failed) {
    const done = steps.filter((s) => s.status === "done").length;
    return {
      text: `${done} of ${steps.length} done. ${FAILURE_CONSEQUENCE[failed.id] ?? "The install is incomplete until it succeeds."}`,
      tip: "Hooks are how sessions report their events. Until every step lands, part of Vibehub stays dark — retry the failed step above.",
    };
  }
  return {
    text: preConnect
      ? "All local — no account, no API key."
      : "Usually a few seconds — all local.",
    tip: "Vibehub reads hook events and git on this machine. There is no server, no sign-in, and it never calls a model unless you ask it to.",
  };
}

export interface ConnectCardProps {
  connection: RepoConnectionNone | RepoConnectionConnecting;
  /** Preview-run step statuses overriding the snapshot's (CTA / Retry path). */
  stepsOverride: InstallStep[] | null;
  /** Storyboard t=400ms: reverse-cardIn exit (200ms) before the hard swap. */
  exiting: boolean;
  onPick: () => void;
  onRetry: (stepId: string) => void;
}

export function ConnectCard({
  connection,
  stepsOverride,
  exiting,
  onPick,
  onRetry,
}: ConnectCardProps) {
  const preConnect = connection.kind === "none";
  const steps =
    stepsOverride ?? (connection.kind === "connecting" ? connection.steps : PRISTINE_INSTALL_STEPS);
  const footer = localLine(steps, preConnect);
  return (
    <div className="center">
      <div className={`connect${exiting ? " out" : ""}`}>
        <h2 data-tip="One button. Everything below runs on this Mac — nothing leaves it.">
          Connect this Mac to your repo
        </h2>
        {preConnect ? (
          <>
            <p className="sub">Pick a repo folder and Vibehub starts watching it.</p>
            <button
              className="cta"
              type="button"
              autoFocus /* Moment A keyboard path (iter-15 fork): first run is Enter-to-connect */
              data-tip="Opens the system folder picker. Choosing a repo runs the three steps below — a few seconds, all local."
              onClick={onPick}
            >
              <FolderIcon size={11} />
              Choose repo folder
            </button>
          </>
        ) : (
          <div
            className="path"
            data-tip={`${connection.repoPath} — the folder you picked. Long paths keep their tail; the full path lives here.`}
          >
            <FolderIcon size={11} />
            <span className="p">
              <bdi>{connection.repoPath}</bdi>
            </span>
          </div>
        )}
        <InstallChecklist steps={steps} onRetry={preConnect ? undefined : onRetry} />
        <p className="local" data-tip={footer.tip}>
          {footer.text}
        </p>
      </div>
    </div>
  );
}
