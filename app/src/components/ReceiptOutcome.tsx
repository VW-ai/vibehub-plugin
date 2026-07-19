import type { InterventionReceiptNote } from "../receipt-note-derive";

/**
 * The one rendering of an applied-intervention receipt body. The shared
 * receipt outcome (queued/skipped/failed) leads only when deterministic
 * evidence supported the projection — the raw bridge outcome stays visible
 * beside it. Weak evidence renders the raw outcome alone and is never
 * upgraded to a queued claim (decision-workbench-016).
 */
export function ReceiptOutcome({ note }: { note: InterventionReceiptNote }) {
  const { result, receiptOutcome } = note;
  return (
    <>
      <b>{receiptOutcome ?? result.outcome}</b>
      {receiptOutcome !== null && ` (${result.outcome})`}
      {result.message ? ` — ${result.message}` : " — No additional message."}{" "}
      <time dateTime={result.acceptedAt}>{result.acceptedAt}</time>
    </>
  );
}
