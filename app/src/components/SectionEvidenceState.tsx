import type { LiveShellSection } from "@vibehub/core/contracts";

export function SectionEvidenceState({ section, label }: {
  section: LiveShellSection<unknown>;
  label: string;
}) {
  if (section.availability === "available" && section.freshness === "live") return null;
  return <div className="section-evidence-state" role="status" data-availability={section.availability} data-freshness={section.freshness}>
    <strong>{label}: {section.availability}</strong>
    <span className="evidence-secondary">{section.freshness} evidence</span>
    {section.recovery.map((item) => <span className="recovery-copy evidence-secondary" key={`${item.code}:${item.instruction}`}>{item.instruction}</span>)}
  </div>;
}
