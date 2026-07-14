export interface TranscriptTailProps {
  lines: string[];
  show: boolean;
}

/**
 * On-demand read-only transcript tail (mock option C: never persistent).
 * Rendered hidden and toggled via .show so the deck's "View transcript"
 * pressed state and the tail always agree (S2 behavior).
 */
export function TranscriptTail({ lines, show }: TranscriptTailProps) {
  const body =
    lines.length > 0
      ? lines.join("\n")
      : "(nothing emitted yet — the session just started)";
  return (
    <div
      className={`tail${show ? " show" : ""}`}
      data-tip="Read-only tail of the live session transcript — the raw feed behind the timeline"
    >
      [transcript tail · read-only]{"\n"}
      {body}
    </div>
  );
}
