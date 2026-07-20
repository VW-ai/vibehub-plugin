import type { LiveShellContextFeedbackKind, LiveShellSnapshotV1 } from "@vibehub/core/contracts";
import { SectionEvidenceState } from "./SectionEvidenceState";

const LANES: Array<[LiveShellContextFeedbackKind, string]> = [
  ["retrieval", "Retrieval"],
  ["operational_capture", "Operational capture"],
  ["explicit_proposal", "Explicit proposal"],
  ["durable_mutation", "Durable mutation"],
];

export function ContextFeedbackDock({ shell }: { shell: LiveShellSnapshotV1 }) {
  const entries = shell.contextFeedback.data ?? [];
  return <section className="feedback-dock" aria-label="Context feedback evidence">
    <div className="feedback-heading">
      <span><b>Context feedback</b><small className="evidence-secondary">recorded receipts, not inferred completion</small></span>
      <span className="authority-model">β compatibility authority</span>
    </div>
    <div className="feedback-lanes">
      {LANES.map(([kind, label]) => {
        const lane = entries.filter((entry) => entry.kind === kind);
        return <div className="feedback-lane" data-lane={kind} key={kind}>
          <h3>{label}<b>{lane.length}</b></h3>
          <div className="feedback-receipts">
            {lane.length === 0 && <span className="receipt-empty evidence-secondary">No receipt observed</span>}
            {lane.map((entry, index) => <article className="feedback-receipt" key={`${entry.receipt.at}:${index}`}>
              <dl>
                <div><dt>Activity</dt><dd>{entry.receipt.activity} / {entry.receipt.phase}</dd></div>
                <div><dt>Trigger</dt><dd>{entry.receipt.trigger}</dd></div>
                <div><dt>Effects</dt><dd>{entry.receipt.evidence.map((fact) => `${fact.effect}/${fact.outcome}: ${fact.subject}`).join(" · ")}</dd></div>
                <div><dt>Result</dt><dd><strong data-outcome={entry.receipt.outcome}>{entry.receipt.outcome}</strong></dd></div>
                <div><dt>Next</dt><dd>{entry.receipt.nextAction ? `${entry.receipt.nextAction.required ? "Required" : "Optional"}: ${entry.receipt.nextAction.instruction}` : "None recorded"}</dd></div>
              </dl>
              <time className="evidence-secondary">{entry.receipt.at}</time>
            </article>)}
          </div>
        </div>;
      })}
    </div>
    <SectionEvidenceState section={shell.contextFeedback} label="Context feedback" />
  </section>;
}
