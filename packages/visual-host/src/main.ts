import type {
  CornerSignalConflictDecisionV1,
  CornerSignalSnapshotV1,
  Task,
} from "@vibehub/core/contracts";
import { hideCorner, readCornerSignal, setCornerExpanded } from "./bridge.js";
import {
  committedExpandedState,
  cornerSignalView,
  scheduleStaleTransition,
  type CornerSignalView,
} from "./corner-signal.js";
import "./styles.css";

const rootElement = document.querySelector<HTMLElement>("#app");
if (!rootElement) throw new Error("Visual host root element is missing.");
const root: HTMLElement = rootElement;

let expanded = false;
let copyState: "idle" | "confirm" | "copied" | "error" = "idle";
let operationalAlert: string | null = null;
let cancelStaleTransition: () => void = () => undefined;
let loadState:
  | { kind: "loading" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; snapshot: CornerSignalSnapshotV1 } = {
    kind: "loading",
  };

void loadProjection();
window.addEventListener("vibehub:projection-refresh", () => {
  copyState = "idle";
  void loadProjection(true);
});
window.addEventListener("keydown", async (event) => {
  if (event.key !== "Escape" || !expanded) return;
  event.preventDefault();
  copyState = "idle";
  const current = expanded;
  try {
    await setCornerExpanded(false);
    expanded = committedExpandedState(current, false, true);
    operationalAlert = null;
  } catch (error) {
    expanded = committedExpandedState(current, false, false);
    operationalAlert = `Could not collapse Corner Signal: ${errorMessage(error)}`;
  }
  render("heading");
});

async function loadProjection(refresh = false): Promise<void> {
  const focusTarget = refresh ? activeFocusTarget() : undefined;
  if (!refresh) {
    loadState = { kind: "loading" };
    render();
  }
  const result = await readCornerSignal();
  cancelStaleTransition();
  loadState = result.availability === "available"
    ? {
        kind: "ready",
        snapshot: result.snapshot,
      }
    : { kind: "unavailable", reason: result.reason };
  if (result.availability === "available") {
    cancelStaleTransition = scheduleStaleTransition(
      result.snapshot,
      () => render(activeFocusTarget()),
    );
  }
  render(focusTarget);
}

type FocusTarget = "heading" | "copy" | "receipt" | "hide";

function render(focusTarget?: FocusTarget): void {
  root.replaceChildren(buildShell());
  if (focusTarget === "heading") {
    root.querySelector<HTMLButtonElement>(".signal-heading")?.focus();
  } else if (focusTarget === "copy") {
    root.querySelector<HTMLButtonElement>(".copy-action")?.focus();
  } else if (focusTarget === "receipt") {
    root.querySelector<HTMLElement>(".copy-receipt")?.focus();
  } else if (focusTarget === "hide") {
    root.querySelector<HTMLButtonElement>(".hide-action")?.focus();
  }
}

function buildShell(): HTMLElement {
  const shell = element("section", "corner-shell");
  shell.setAttribute("aria-label", "VibeHub Corner Signal");
  shell.append(buildDragRegion());

  if (loadState.kind === "loading") {
    const status = element("div", "signal-status");
    status.setAttribute("role", "status");
    status.append(
      symbol("·"),
      textElement("span", "signal-title", "Reading Corner Signal…"),
    );
    shell.append(status);
    return shell;
  }

  if (loadState.kind === "unavailable") {
    shell.append(buildHeading({
      title: "Corner signal unavailable",
      repository: "VibeHub",
      repoRoot: null,
      checkoutRoot: null,
      host: null,
      branch: "refresh required",
      availability: "unavailable",
      availabilityLabel: "Evidence unavailable",
      freshness: "unknown",
      freshnessLabel: "Freshness unknown",
      decision: null,
      evidence: [],
      recovery: [],
    }));
    if (operationalAlert) {
      const alert = textElement("p", "operational-alert", operationalAlert);
      alert.setAttribute("role", "alert");
      shell.append(alert);
    }
    if (expanded) {
      shell.append(buildUnavailableSheet(loadState.reason));
    }
    return shell;
  }

  const view = cornerSignalView(loadState.snapshot);
  shell.append(buildHeading(view));
  if (operationalAlert) {
    const alert = textElement("p", "operational-alert", operationalAlert);
    alert.setAttribute("role", "alert");
    shell.append(alert);
  }
  if (expanded) shell.append(buildDecisionSheet(view));
  return shell;
}

function buildDragRegion(): HTMLElement {
  const drag = element("div", "drag-region");
  drag.dataset["tauriDragRegion"] = "";
  const grip = textElement("span", "drag-grip", "•••");
  grip.setAttribute("aria-hidden", "true");
  const hide = textElement("button", "hide-action", "Hide");
  hide.type = "button";
  hide.addEventListener("click", () => {
    void hideCorner().then(() => {
      operationalAlert = null;
    }).catch((error) => {
      operationalAlert = `Could not hide Corner Signal: ${errorMessage(error)}`;
      render("hide");
    });
  });
  drag.append(grip, hide);
  return drag;
}

function buildHeading(view: CornerSignalView): HTMLElement {
  const button = element("button", "signal-heading") as HTMLButtonElement;
  button.type = "button";
  button.setAttribute("aria-expanded", String(expanded));
  const exactIdentity = [
    `Repository root: ${view.repoRoot ?? "unavailable"}`,
    `Checkout root: ${view.checkoutRoot ?? "unavailable"}`,
    `Host: ${view.host ?? "unavailable"}`,
    `Branch: ${view.branch}`,
  ].join("\n");
  button.title = `${expanded ? "Collapse decision sheet" : "Open decision sheet"}\n${exactIdentity}`;
  button.setAttribute("aria-label", `${view.title}. ${exactIdentity.replaceAll("\n", ". ")}`);
  const showCompactState = view.availability !== "available" || view.freshness !== "live";
  if (showCompactState) button.classList.add("has-compact-state");
  button.append(
    symbol("◇"),
    textElement("span", "signal-title", view.title),
    textElement("span", "identity-line", `${view.repository} · ${view.branch}`),
  );
  if (showCompactState) {
    button.append(textElement(
      "span",
      `compact-state availability-${view.availability} freshness-${view.freshness}`,
      `${view.availabilityLabel} · ${view.freshnessLabel}`,
    ));
  }
  button.append(textElement("span", "chevron", expanded ? "⌃" : "⌄"));
  button.addEventListener("click", async () => {
    const current = expanded;
    const requested = !current;
    copyState = "idle";
    try {
      await setCornerExpanded(requested);
      expanded = committedExpandedState(current, requested, true);
      operationalAlert = null;
    } catch (error) {
      expanded = committedExpandedState(current, requested, false);
      operationalAlert = `Could not resize Corner Signal: ${errorMessage(error)}`;
    }
    render("heading");
  });
  return button;
}

function buildUnavailableSheet(reason: string): HTMLElement {
  const sheet = element("div", "decision-sheet");
  sheet.append(
    textElement("p", "plain-evidence", reason),
    recoveryBlock(["Run vibehub visual refresh for an initialized repository, then open Corner Signal again."]),
  );
  return sheet;
}

function buildDecisionSheet(view: CornerSignalView): HTMLElement {
  const sheet = element("div", "decision-sheet");
  sheet.setAttribute("role", "region");
  sheet.setAttribute("aria-label", "Focused conflict decision");

  const meta = element("div", "evidence-meta");
  const availability = textElement(
    "span",
    `availability availability-${view.availability}`,
    view.availabilityLabel,
  );
  availability.title = view.availability === "partial"
    ? "Some canonical evidence is unavailable; follow the recovery guidance below."
    : "Availability comes from the file-backed Core projection.";
  const freshness = textElement("span", `freshness freshness-${view.freshness}`, view.freshnessLabel);
  freshness.title = view.freshness === "stale"
    ? "Refresh the projection before relying on this evidence."
    : "Freshness comes from canonical sync evidence and projection age.";
  meta.append(availability, freshness);
  sheet.append(meta);

  if (!view.decision) {
    for (const item of view.evidence) {
      sheet.append(textElement("p", "plain-evidence", item));
    }
    if (view.recovery.length > 0) sheet.append(recoveryBlock(view.recovery));
    return sheet;
  }

  sheet.append(
    buildTaskSpine(view.decision),
    buildSharedEvidence(view.decision),
    buildPromptAction(view.decision.coordinationPrompt),
  );
  if (view.recovery.length > 0) sheet.append(recoveryBlock(view.recovery));
  return sheet;
}

function buildTaskSpine(decision: CornerSignalConflictDecisionV1): HTMLElement {
  const region = element("section", "task-spine");
  region.setAttribute("aria-label", "Two task paths and their shared resource");
  region.append(
    taskPath(decision.tasks[0], "path-a"),
    taskPath(decision.tasks[1], "path-b"),
  );
  const spine = element("div", "spine-lines");
  spine.setAttribute("aria-hidden", "true");
  spine.append(element("span", "spine-arm spine-arm-a"), element("span", "spine-arm spine-arm-b"), element("span", "spine-stem"));
  const shared = textElement(
    "div",
    "shared-node",
    `${decision.conflict.sharedSymbols.length} shared ${decision.conflict.sharedSymbols.length === 1 ? "resource" : "resources"}`,
  );
  shared.title = decision.conflict.sharedSymbols.join("\n");
  region.append(spine, shared);
  return region;
}

function taskPath(task: Task, className: string): HTMLElement {
  const row = element("div", `task-path ${className}`);
  const dot = element("span", "task-dot");
  dot.setAttribute("aria-hidden", "true");
  const words = element("div", "task-words");
  words.append(
    textElement("strong", "task-title", task.title),
    textElement("span", "task-facts", `${task.git.branch} · ${task.state}`),
  );
  row.title = `${task.title}\nBranch ${task.git.branch}\nState ${task.state}`;
  row.append(dot, words);
  return row;
}

function buildSharedEvidence(decision: CornerSignalConflictDecisionV1): HTMLElement {
  const section = element("section", "shared-evidence");
  section.append(textElement("h2", "section-title", "Shared evidence"));
  const list = element("ul", "evidence-list");
  const rich = decision.detail.data?.symbols;
  if (rich && rich.length > 0) {
    for (const item of rich) {
      const touch = item.touches.map((entry) => entry.action).join(" × ");
      const row = element("li", "evidence-row");
      row.append(
        textElement("span", "resource-symbol", item.name),
        textElement("span", "resource-file", item.file),
        textElement("span", "touch-kind", touch),
      );
      row.title = item.touches
        .map((entry) => `${entry.taskId}: ${entry.action} at ${entry.at}`)
        .join("\n");
      list.append(row);
    }
  } else {
    for (const resource of decision.conflict.sharedSymbols) {
      const row = element("li", "evidence-row");
      row.append(
        textElement("span", "resource-symbol", resource),
        textElement("span", "touch-kind", decision.conflict.severity),
      );
      row.title = `Canonical map evidence for conflict ${decision.conflict.id}`;
      list.append(row);
    }
  }
  section.append(list);
  return section;
}

function buildPromptAction(prompt: string): HTMLElement {
  const section = element("section", "prompt-zone");
  const copy = textElement(
    "button",
    "copy-action",
    copyState === "idle"
      ? "Copy coordination prompt"
      : copyState === "confirm"
        ? "Confirm copy"
        : copyState === "copied"
          ? "Prompt copied"
          : "Retry copy",
  ) as HTMLButtonElement;
  copy.type = "button";
  copy.disabled = copyState === "copied";
  copy.addEventListener("click", async () => {
    if (copyState === "idle" || copyState === "error") {
      copyState = "confirm";
      render("copy");
      return;
    }
    if (copyState === "confirm") {
      try {
        await copyText(prompt);
        copyState = "copied";
      } catch {
        copyState = "error";
      }
      render(copyState === "copied" ? "receipt" : "copy");
    }
  });
  section.append(copy);
  if (copyState === "confirm") {
    const confirmation = textElement(
      "p",
      "copy-confirmation",
      "Copy this evidence-based prompt to the clipboard?",
    );
    confirmation.setAttribute("role", "status");
    section.append(confirmation);
  } else if (copyState === "copied") {
    const copied = textElement("p", "copy-confirmation copy-receipt", "Prompt copied");
    copied.setAttribute("role", "status");
    copied.tabIndex = -1;
    section.append(copied);
  } else if (copyState === "error") {
    const failed = textElement(
      "p",
      "copy-confirmation copy-error",
      "Clipboard copy failed. Retry when clipboard access is available.",
    );
    failed.setAttribute("role", "alert");
    section.append(failed);
  }
  return section;
}

function recoveryBlock(instructions: readonly string[]): HTMLElement {
  const block = element("section", "recovery-block");
  block.append(textElement("h2", "section-title", "Recovery"));
  const list = element("ul", "recovery-list");
  for (const instruction of instructions) {
    list.append(textElement("li", "", instruction));
  }
  block.append(list);
  return block;
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.className = "clipboard-fallback";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy was rejected.");
}

function element(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  value: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function symbol(value: string): HTMLElement {
  const node = textElement("span", "signal-symbol", value);
  node.setAttribute("aria-hidden", "true");
  return node;
}

function activeFocusTarget(): FocusTarget | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  if (active.classList.contains("copy-action")) return "copy";
  if (active.classList.contains("copy-receipt")) return "receipt";
  if (active.classList.contains("hide-action")) return "hide";
  if (active.classList.contains("signal-heading")) return "heading";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
