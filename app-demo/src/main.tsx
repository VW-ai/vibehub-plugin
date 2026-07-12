import { createRoot } from "react-dom/client";
import "./tokens.css";
import "./app.css";
import { fixtures } from "./fixtures";
import { App } from "./components/App";

const DEFAULT_FIXTURE = "v8-baseline";

const params = new URLSearchParams(window.location.search);
const requested = params.get("fixture");
const initialFixture =
  requested && requested in fixtures ? requested : DEFAULT_FIXTURE;
// `?switcher=0` hides the dev fixture switcher (used for parity screenshots).
const showSwitcher = params.get("switcher") !== "0";
// `?panel=<name>` opens a task-panel fixture on load (dev path to extremes,
// e.g. ?panel=marathon → panel-marathon). Unknown names are ignored.
const initialPanel = params.get("panel") ?? undefined;
// `?conflict=<name>` opens a conflict-card fixture on load (dev path to all
// five fixtures, e.g. ?conflict=yellow-stale → conflict-yellow-stale).
// Ignored when ?panel= is also present (the two modals are exclusive).
const initialConflict = params.get("conflict") ?? undefined;
// `?install=<name>` renders the first-run screen (m4): the connection-state
// layer above the map. All 10 install fixtures are reachable by name
// (e.g. ?install=connect, ?install=nine-footprints). Unknown names → map.
const initialInstall = params.get("install") ?? undefined;
// `?menubar=<variant>` renders the menubar surface (m5): a generic desktop +
// the Vibehub menubar item + dropdown INSTEAD of the map window. Accepts the
// five S1 variant names (busy/quiet/stale/overload/flood) or the bare flag
// `?menubar=1` (→ busy). Unknown names fall through to the map.
const initialMenubar = params.get("menubar") ?? undefined;

// `?fixture=live` loads a REAL team snapshot exported by
// `vibehub team fixture --out public/live-fixture.json` (M1 ① vertical
// slice: git+gh → SQLite → this map, zero server). Missing/invalid file
// falls back to the default fixture with a console warning — the demo's
// 20 canned fixtures stay untouched.
async function resolveFixtures(): Promise<{
  all: typeof fixtures;
  initial: string;
}> {
  if (requested !== "live") return { all: fixtures, initial: initialFixture };
  try {
    const res = await fetch("/live-fixture.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const live = await res.json();
    return { all: { ...fixtures, live }, initial: "live" };
  } catch (err) {
    console.warn(
      "live fixture unavailable — run `vibehub team fixture` first; falling back",
      err,
    );
    return { all: fixtures, initial: DEFAULT_FIXTURE };
  }
}

const rootEl = document.getElementById("root");
if (rootEl) {
  void resolveFixtures().then(({ all, initial }) => {
    createRoot(rootEl).render(
      <App
        fixtures={all}
        initialFixture={initial}
        showSwitcher={showSwitcher}
        initialPanel={initialPanel}
        initialConflict={initialConflict}
        initialInstall={initialInstall}
        initialMenubar={initialMenubar}
      />,
    );
  });
}
