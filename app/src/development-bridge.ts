import type {
  AppliedIntervention,
  ConflictCardSnapshot,
  MapSnapshot,
  TaskPanelSnapshot,
  WorkbenchIntervention,
  WorkbenchRepoRef,
} from "@vibehub/core/contracts";
import {
  isAppliedIntervention,
  isApplyInterventionRequest,
  isBridgeResult,
  isConflictCardSnapshot,
  isConflictDetailRequest,
  isMapSnapshot,
  isRepoRef,
  isTaskPanelRequest,
  isTaskPanelSnapshot,
} from "./bridge-validation";

export interface BridgeRuntime {
  readWorkbenchSnapshot(repo: WorkbenchRepoRef): unknown;
  readTaskPanel(repo: WorkbenchRepoRef, taskId: string): unknown;
  readConflictDetail(repo: WorkbenchRepoRef, conflictId: string): unknown;
  applyIntervention(repo: WorkbenchRepoRef, requestId: string, intervention: WorkbenchIntervention): unknown;
}

/** Shared Vite/dogfood wire dispatcher: validate request, dispatch, validate result. */
export function dispatchWorkbenchEnvelope(
  envelope: unknown,
  configuredRepo: WorkbenchRepoRef,
  service: BridgeRuntime,
): unknown {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new Error("malformed bridge envelope");
  }
  const { method, request } = envelope as Record<string, unknown>;
  const validRequest = method === "getSnapshot" ? isRepoRef(request)
    : method === "getTaskPanel" ? isTaskPanelRequest(request)
      : method === "getConflictDetail" ? isConflictDetailRequest(request)
        : method === "applyIntervention" ? isApplyInterventionRequest(request)
          : false;
  if (!validRequest || !isRepoRef(request)) throw new Error("invalid method-specific bridge request");
  if (request.repoRoot !== configuredRepo.repoRoot || request.repoKey !== configuredRepo.repoKey) {
    throw new Error("bridge repository mismatch");
  }

  let result: unknown;
  let guard: (value: unknown) => boolean;
  switch (method) {
    case "getSnapshot":
      result = service.readWorkbenchSnapshot(configuredRepo);
      guard = isMapSnapshot;
      break;
    case "getTaskPanel":
      result = service.readTaskPanel(configuredRepo, (request as WorkbenchRepoRef & { taskId: string }).taskId);
      guard = isTaskPanelSnapshot;
      break;
    case "getConflictDetail":
      result = service.readConflictDetail(configuredRepo, (request as WorkbenchRepoRef & { conflictId: string }).conflictId);
      guard = isConflictCardSnapshot;
      break;
    case "applyIntervention": {
      const input = request as WorkbenchRepoRef & { requestId: string; intervention: WorkbenchIntervention };
      result = service.applyIntervention(configuredRepo, input.requestId, input.intervention);
      guard = isAppliedIntervention;
      break;
    }
    default:
      throw new Error("unknown bridge method");
  }
  if (!isBridgeResult(result, guard)) throw new Error("core returned a malformed method-specific bridge response");
  return result as
    | { status: "ok"; data: MapSnapshot | TaskPanelSnapshot | ConflictCardSnapshot | AppliedIntervention }
    | { status: string; message: string };
}
