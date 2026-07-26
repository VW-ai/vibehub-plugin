import type {
  CornerSignalAvailability,
  CornerSignalConflictDecisionV1,
  CornerSignalFreshness,
  CornerSignalSnapshotV1,
} from "@vibehub/core/contracts";

export interface CornerSignalView {
  title: string;
  repository: string;
  repoRoot: string | null;
  checkoutRoot: string | null;
  host: "claude-code" | "codex" | null;
  branch: string;
  availability: CornerSignalAvailability;
  availabilityLabel: string;
  freshness: CornerSignalFreshness;
  freshnessLabel: string;
  decision: CornerSignalConflictDecisionV1 | null;
  evidence: string[];
  recovery: string[];
}

export function cornerSignalView(
  snapshot: CornerSignalSnapshotV1,
  now: Date = new Date(),
): CornerSignalView {
  const identity = snapshot.identity.data;
  const decision = snapshot.signal.data?.state === "conflict"
    ? snapshot.signal.data
    : null;
  const freshness = effectiveFreshness(snapshot, now);
  const recovery = snapshot.recovery.map((action) => action.instruction);
  if (freshness === "stale") {
    recovery.push(
      "Run vibehub visual refresh for this checkout before relying on the displayed conflict evidence.",
    );
  }
  return {
    title: decision
      ? "Scope may be changing"
      : snapshot.signal.data?.state === "clear"
        ? freshness === "stale"
          ? "Conflict evidence may be stale"
          : snapshot.availability === "partial"
            ? "Conflict evidence is incomplete"
            : "No shared conflict observed"
        : "Corner signal unavailable",
    repository: identity ? basename(identity.repoRoot) : "Repository unavailable",
    repoRoot: identity?.repoRoot ?? null,
    checkoutRoot: identity?.checkoutRoot ?? null,
    host: identity?.host ?? null,
    branch: identity?.branch ?? "detached",
    availability: snapshot.availability,
    availabilityLabel: snapshot.availability === "available"
      ? "Canonical evidence"
      : snapshot.availability === "partial"
        ? "Partial evidence"
        : "Evidence unavailable",
    freshness,
    freshnessLabel: freshness === "live"
      ? "Fresh projection"
      : freshness === "stale"
        ? "Stale projection"
        : "Freshness unknown",
    decision,
    evidence: snapshot.signal.data?.state === "clear"
      ? snapshot.signal.data.evidence
      : decision
        ? decision.detail.data?.symbols.map((symbol) => symbol.file)
          ?? decision.conflict.sharedSymbols
        : [],
    recovery: [...new Set(recovery)],
  };
}

export function scheduleStaleTransition(
  snapshot: CornerSignalSnapshotV1,
  callback: () => void,
  now: () => Date = () => new Date(),
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
): () => void {
  if (effectiveFreshness(snapshot, now()) !== "live") return () => undefined;
  const delay = Math.max(0, Date.parse(snapshot.staleAfter) - now().getTime() + 1);
  if (!Number.isFinite(delay)) return () => undefined;
  const timer = schedule(callback, delay);
  return () => clearTimeout(timer);
}

export function committedExpandedState(
  current: boolean,
  requested: boolean,
  succeeded: boolean,
): boolean {
  return succeeded ? requested : current;
}

export function effectiveFreshness(
  snapshot: CornerSignalSnapshotV1,
  now: Date,
): CornerSignalFreshness {
  if (snapshot.freshness !== "live") return snapshot.freshness;
  const staleAfter = Date.parse(snapshot.staleAfter);
  return Number.isFinite(staleAfter) && now.getTime() <= staleAfter
    ? "live"
    : "stale";
}

function basename(value: string): string {
  const normalized = value.replace(/\/+$/u, "");
  return normalized.split("/").pop() || value;
}
