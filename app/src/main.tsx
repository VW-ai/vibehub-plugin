import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  MapSnapshot,
  WorkbenchBridgeErrorStatus,
} from "@vibehub/core/contracts";
import "./tokens.css";
import "./app.css";
import { WorkbenchMap } from "./WorkbenchMap";
import { bridgeFromHost, requestInitialSnapshot } from "./workbench-host";

type BootState =
  | { status: "loading" }
  | { status: "ok"; snapshot: MapSnapshot }
  | { status: WorkbenchBridgeErrorStatus; message: string };

const TITLES: Record<WorkbenchBridgeErrorStatus, string> = {
  bridge_unavailable: "Workbench bridge unavailable",
  db_missing: "VibeHub is not initialized",
  repo_uninitialized: "Repository is not initialized",
  unsynced: "Repository has not synced yet",
  not_found: "Workbench data was not found",
  evidence_unavailable: "Rich evidence is unavailable",
  idempotency_conflict: "Request conflicts with an earlier intervention",
  internal_error: "Workbench could not be loaded",
};

export function ProductionApp() {
  const [boot, setBoot] = useState<BootState>({ status: "loading" });
  const load = useCallback(() => {
    setBoot({ status: "loading" });
    void requestInitialSnapshot(window.__VIBEHUB_WORKBENCH_HOST__).then((result) => {
      setBoot(
        result.status === "ok"
          ? { status: "ok", snapshot: result.data }
          : { status: result.status, message: result.message },
      );
    });
  }, []);

  useEffect(load, [load]);
  if (boot.status === "ok") {
    const connected = bridgeFromHost(window.__VIBEHUB_WORKBENCH_HOST__);
    if (connected) return <WorkbenchMap snapshot={boot.snapshot} bridge={connected.bridge} repo={connected.repo} />;
    return <main className="bootstrap-state"><h1>Workbench bridge unavailable</h1><p>The bridge disconnected after loading the snapshot.</p></main>;
  }

  const loading = boot.status === "loading";
  return (
    <main
      className="bootstrap-state"
      aria-labelledby="bootstrap-title"
      data-status={boot.status}
    >
      <p className="bootstrap-kicker">LOCAL WORKBENCH</p>
      <h1 id="bootstrap-title">
        {loading ? "Loading repository…" : TITLES[boot.status]}
      </h1>
      {!loading && <p>{boot.message}</p>}
      {!loading && (
        <button type="button" onClick={load}>
          Try again
        </button>
      )}
    </main>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<ProductionApp />);
