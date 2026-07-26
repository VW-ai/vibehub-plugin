import type {
  Conflict,
  CornerSignalSnapshotV1,
} from "@vibehub/core/contracts";

export interface TauriInternals {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

export interface ProjectionReadV1 {
  schemaVersion: 1;
  availability: "available" | "unavailable";
  contents: string | null;
  reason: string | null;
}

export type CornerSignalLoadResult =
  | { availability: "available"; snapshot: CornerSignalSnapshotV1 }
  | { availability: "unavailable"; reason: string };

export async function readCornerSignal(
  bridge: TauriInternals | undefined = nativeBridge(),
): Promise<CornerSignalLoadResult> {
  if (!bridge) {
    return {
      availability: "unavailable",
      reason: "The native Corner Signal reader is unavailable in this window.",
    };
  }
  try {
    const result = await bridge.invoke<ProjectionReadV1>("read_corner_signal");
    if (result.availability !== "available" || result.contents === null) {
      return {
        availability: "unavailable",
        reason: result.reason ?? "No Corner Signal projection is available.",
      };
    }
    const parsed = JSON.parse(result.contents) as unknown;
    if (!isCornerSignalSnapshot(parsed)) {
      return {
        availability: "unavailable",
        reason: "The Corner Signal projection does not match schema version 1.",
      };
    }
    return { availability: "available", snapshot: parsed };
  } catch (error) {
    return {
      availability: "unavailable",
      reason: `Could not read Corner Signal projection: ${errorMessage(error)}`,
    };
  }
}

export async function setCornerExpanded(expanded: boolean): Promise<void> {
  await invokeHost("set_corner_expanded", { expanded });
}

export async function hideCorner(): Promise<void> {
  await invokeHost("hide_corner");
}

async function invokeHost(
  command: string,
  args?: Record<string, unknown>,
): Promise<void> {
  const bridge = nativeBridge();
  if (!bridge) {
    throw new Error(`The native host command ${command} is unavailable in this window.`);
  }
  await bridge.invoke(command, args);
}

export function isCornerSignalSnapshot(
  value: unknown,
): value is CornerSignalSnapshotV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate["schemaVersion"] !== 1
    || typeof candidate["generation"] !== "string"
    || candidate["generation"].length === 0
    || candidate["selectionMode"] !== "last_writer_selected"
    || typeof candidate["copiedAt"] !== "string"
    || typeof candidate["staleAfter"] !== "string"
    || !isSection(candidate["identity"], isIdentity)
    || !isSection(candidate["signal"], isSignalDecision)
    || !isRecovery(candidate["recovery"])
    || !["available", "partial", "unavailable"].includes(String(candidate["availability"]))
    || !["live", "stale", "unknown"].includes(String(candidate["freshness"]))
  ) return false;
  const identity = candidate["identity"] as Record<string, unknown>;
  const signal = candidate["signal"] as Record<string, unknown>;
  const expectedRecovery = dedupeRecovery([
    ...((identity["recovery"] as unknown[]) ?? []),
    ...((signal["recovery"] as unknown[]) ?? []),
  ]);
  return (
    candidate["availability"] === combineAvailability(
      String(identity["availability"]),
      String(signal["availability"]),
    )
    && candidate["freshness"] === signal["freshness"]
    && sameRecovery(candidate["recovery"] as unknown[], expectedRecovery)
    && (candidate["availability"] === "available"
      || (candidate["recovery"] as unknown[]).length > 0)
  );
}

function isSection(
  value: unknown,
  dataGuard: (data: unknown) => boolean,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const section = value as Record<string, unknown>;
  const availability = String(section["availability"]);
  const recovery = section["recovery"];
  const data = section["data"];
  return (
    ["available", "partial", "unavailable"].includes(availability)
    && ["live", "stale", "unknown"].includes(String(section["freshness"]))
    && isRecovery(recovery)
    && "data" in section
    && (data === null || dataGuard(data))
    && (availability !== "available" || data !== null)
    && (availability !== "unavailable" || data === null)
    && (availability === "available" || (recovery as unknown[]).length > 0)
  );
}

function isIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value["repoRoot"] === "string"
    && typeof value["checkoutRoot"] === "string"
    && (value["host"] === "claude-code" || value["host"] === "codex")
    && (typeof value["branch"] === "string" || value["branch"] === null)
  );
}

function isSignalDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value["state"] === "clear") {
    return isStringArray(value["evidence"]);
  }
  if (value["state"] !== "conflict") return false;
  const conflict = value["conflict"];
  const tasks = value["tasks"];
  return (
    isConflict(conflict)
    && Array.isArray(tasks)
    && tasks.length === 2
    && tasks.every(isTask)
    && tasks[0].id === conflict.taskIds[0]
    && tasks[1].id === conflict.taskIds[1]
    && isSection(
      value["detail"],
      (detail) => isConflictDetail(detail, conflict.taskIds),
    )
    && typeof value["coordinationPrompt"] === "string"
    && value["coordinationPrompt"].length > 0
  );
}

function isConflict(value: unknown): value is Conflict {
  if (!isRecord(value)) return false;
  return (
    typeof value["id"] === "string"
    && Array.isArray(value["taskIds"])
    && value["taskIds"].length === 2
    && value["taskIds"].every((item) => typeof item === "string")
    && typeof value["territoryId"] === "string"
    && (value["subBlockId"] === undefined || typeof value["subBlockId"] === "string")
    && isStringArray(value["sharedSymbols"])
    && (value["severity"] === "red" || value["severity"] === "yellow")
    && typeof value["detectedAt"] === "string"
  );
}

function isTask(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value["git"])) return false;
  return (
    typeof value["id"] === "string"
    && typeof value["title"] === "string"
    && ["queued", "running", "waiting", "stalled", "done"].includes(String(value["state"]))
    && (value["signalTier"] === "hooks" || value["signalTier"] === "basic")
    && isStringArray(value["conflictIds"])
    && Array.isArray(value["scopes"])
    && typeof value["git"]["branch"] === "string"
    && typeof value["stateSince"] === "string"
    && typeof value["lastEventAt"] === "string"
  );
}

function isConflictDetail(value: unknown, taskIds: readonly string[]): boolean {
  if (!isRecord(value) || !Array.isArray(value["symbols"])) return false;
  return value["symbols"].every((symbol) => {
    if (!isRecord(symbol) || !Array.isArray(symbol["touches"])) return false;
    return (
      typeof symbol["name"] === "string"
      && typeof symbol["file"] === "string"
      && symbol["touches"].length === 2
      && sameStringSet(
        symbol["touches"].flatMap((touch) =>
          isRecord(touch) && typeof touch["taskId"] === "string" ? [touch["taskId"]] : []),
        taskIds,
      )
      && symbol["touches"].every((touch) =>
        isRecord(touch)
        && typeof touch["taskId"] === "string"
        && (touch["action"] === "edit" || touch["action"] === "read")
        && typeof touch["at"] === "string"
      )
    );
  });
}

function dedupeRecovery(actions: unknown[]): unknown[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (!isRecord(action)) return false;
    const key = `${String(action["code"])}\0${String(action["instruction"])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameRecovery(left: unknown[], right: unknown[]): boolean {
  return left.length === right.length && left.every((action, index) => {
    const expected = right[index];
    return isRecord(action) && isRecord(expected)
      && action["code"] === expected["code"]
      && action["instruction"] === expected["instruction"];
  });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function isRecovery(value: unknown): boolean {
  const allowed = new Set([
    "initialize_runtime",
    "sync_repository",
    "refresh_projection",
    "retry_read",
    "inspect_conflict_evidence",
  ]);
  return Array.isArray(value) && value.every((action) =>
    isRecord(action)
    && allowed.has(String(action["code"]))
    && typeof action["instruction"] === "string"
    && action["instruction"].length > 0
  );
}

function combineAvailability(left: string, right: string): string {
  if (left === "unavailable" && right === "unavailable") return "unavailable";
  if (left === "available" && right === "available") return "available";
  return "partial";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nativeBridge(): TauriInternals | undefined {
  return typeof window === "undefined" ? undefined : window.__TAURI_INTERNALS__;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
