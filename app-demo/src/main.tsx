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

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <App
      fixtures={fixtures}
      initialFixture={initialFixture}
      showSwitcher={showSwitcher}
      initialPanel={initialPanel}
    />,
  );
}
