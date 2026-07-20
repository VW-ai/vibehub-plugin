import type { LiveShellSnapshotV1 } from "@vibehub/core/contracts";
import { SectionEvidenceState } from "./SectionEvidenceState";

const labels = { installed: "Installed", connected: "Connected", activated: "Activated" } as const;

export function ActivationEvidenceStrip({ shell }: { shell: LiveShellSnapshotV1 }) {
  const activation = shell.activation.data;
  return <section className="activation-strip" aria-label="Activation evidence">
    <div className="activation-identity">
      <span className="eyebrow">LIVE SHELL</span>
      {shell.identity.data
        ? <dl className="identity-fields">
            <div><dt>Repository</dt><dd><code>{shell.identity.data.repoRoot}</code></dd></div>
            <div><dt>Checkout</dt><dd><code>{shell.identity.data.checkoutRoot}</code></dd></div>
            <div><dt>Host</dt><dd>{shell.identity.data.host}</dd></div>
          </dl>
        : <span>Repository identity unavailable</span>}
      <SectionEvidenceState section={shell.identity} label="Identity" />
    </div>
    <div className="activation-proof-list">
      {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => {
        const proof = activation?.[key];
        return <div className="activation-proof" data-proof={proof?.state ?? "unknown"} key={key} title={proof?.evidence.join(" · ") || "No evidence recorded"}>
          <i aria-hidden="true" /><span>{labels[key]}</span><b className="evidence-secondary">{proof?.state.replace("_", " ") ?? "unknown"}</b>
          <small className="evidence-secondary">{proof?.evidence.join(" · ") || "No evidence recorded"}</small>
        </div>;
      })}
    </div>
    <SectionEvidenceState section={shell.activation} label="Activation" />
  </section>;
}
