import type {
  AppliedIntervention,
  ConflictCardSnapshot,
  MapSnapshot,
  LiveShellRepoRef,
  LiveShellSnapshotV1,
  TaskPanelSnapshot,
  WorkbenchBridge,
  WorkbenchBridgeResult,
} from "@vibehub/core/contracts";
import {
  isAppliedIntervention,
  isApplyInterventionRequest,
  isBridgeResult,
  isConflictCardSnapshot,
  isConflictDetailRequest,
  isMapSnapshot,
  isLiveShellRepoRef,
  isLiveShellSnapshot,
  isRepoRef,
  isTaskPanelRequest,
  isTaskPanelSnapshot,
} from "./bridge-validation";

export interface WorkbenchHostConfig {
  endpoint: string;
  repo: LiveShellRepoRef;
}

declare global {
  interface Window {
    __VIBEHUB_WORKBENCH_HOST__?: WorkbenchHostConfig;
  }
}

async function call<T>(
  endpoint: string,
  method: string,
  request: unknown,
  requestGuard: (value: unknown) => boolean,
  dataGuard: (value: unknown) => boolean,
  fetchImpl: typeof fetch,
): Promise<WorkbenchBridgeResult<T>> {
  if (!requestGuard(request)) {
    return { status: "bridge_unavailable", message: `Refused malformed ${method} request.` };
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, request }),
    });
    if (!response.ok) {
      return {
        status: "bridge_unavailable",
        message: `Workbench host returned HTTP ${response.status}.`,
      };
    }
    const value: unknown = await response.json();
    if (!isBridgeResult(value, dataGuard)) {
      return { status: "bridge_unavailable", message: `Workbench host returned a malformed ${method} result.` };
    }
    return value as WorkbenchBridgeResult<T>;
  } catch {
    return {
      status: "bridge_unavailable",
      message: "The configured workbench host is unavailable.",
    };
  }
}

export function bridgeFromHost(
  host: WorkbenchHostConfig | undefined,
  fetchImpl: typeof fetch = globalThis.fetch,
): { bridge: WorkbenchBridge; repo: LiveShellRepoRef } | null {
  if (!host || !nonEmptyEndpoint(host.endpoint) || !isLiveShellRepoRef(host.repo)) return null;
  const bridge: WorkbenchBridge = {
    getLiveShell: (repo) => call<LiveShellSnapshotV1>(host.endpoint, "getLiveShell", repo, isLiveShellRepoRef, isLiveShellSnapshot, fetchImpl),
    getSnapshot: (repo) => call<MapSnapshot>(host.endpoint, "getSnapshot", repo, isRepoRef, isMapSnapshot, fetchImpl),
    getTaskPanel: (request) =>
      call<TaskPanelSnapshot>(host.endpoint, "getTaskPanel", request, isTaskPanelRequest, isTaskPanelSnapshot, fetchImpl),
    getConflictDetail: (request) =>
      call<ConflictCardSnapshot>(host.endpoint, "getConflictDetail", request, isConflictDetailRequest, isConflictCardSnapshot, fetchImpl),
    applyIntervention: (request) =>
      call<AppliedIntervention>(host.endpoint, "applyIntervention", request, isApplyInterventionRequest, isAppliedIntervention, fetchImpl),
  };
  return { bridge, repo: host.repo };
}

export function createWorkbenchBridge(
  host: WorkbenchHostConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
): WorkbenchBridge {
  const connected = bridgeFromHost(host, fetchImpl);
  if (!connected) throw new Error("invalid workbench host configuration");
  return connected.bridge;
}

const nonEmptyEndpoint = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

export async function requestInitialSnapshot(
  host: WorkbenchHostConfig | undefined,
): Promise<WorkbenchBridgeResult<LiveShellSnapshotV1>> {
  const connected = bridgeFromHost(host);
  if (!connected) {
    return {
      status: "bridge_unavailable",
      message:
        "No native workbench host is connected. Open this build from the VibeHub app, or use the configured loopback development host.",
    };
  }
  return connected.bridge.getLiveShell(connected.repo);
}
