/**
 * S3 placeholder entry. S4 (dynamize) replaces this with the React map
 * component; react/react-dom are already installed for that stage.
 * For now it proves the toolchain + fixtures wire up end-to-end.
 */
import "./tokens.css";
import { fixtures, v8Baseline } from "./fixtures";

const root = document.getElementById("root");
if (root) {
  const names = Object.keys(fixtures).join(", ");
  root.textContent =
    `Vibehub workbench demo — S3 scaffold. ` +
    `${v8Baseline.tasks.length} tasks / ${v8Baseline.territories.length} territories / ` +
    `${v8Baseline.conflicts.length} conflict in baseline. Fixtures: ${names}. ` +
    `Map component lands at S4.`;
  root.style.cssText =
    "font-family:var(--sans);font-size:var(--fs-4);color:var(--ink-500);padding:var(--sp-6)";
}
