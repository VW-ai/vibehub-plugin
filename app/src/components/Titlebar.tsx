import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";
import type { MapSnapshot } from "@vibehub/core/contracts";
import { freshness, titlebarStats } from "../derive";

/** v8 repo icon (inline SVG only — no emoji per taste profile). */
function RepoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z" />
    </svg>
  );
}

export interface TitlebarProps {
  snapshot: MapSnapshot;
  /** Dev-only snapshot switcher (hidden when only one snapshot exists). */
  snapshotNames: string[];
  activeSnapshot: string;
  onSnapshotChange: (name: string) => void;
  /** The conflict stat opens the adjudication card (m3 S4 open path #3). */
  onConflictOpen: (conflictId: string, opener: HTMLElement | null) => void;
}

export function Titlebar({
  snapshot,
  snapshotNames,
  activeSnapshot,
  onSnapshotChange,
  onConflictOpen,
}: TitlebarProps) {
  const stats = titlebarStats(snapshot);
  const fresh = freshness(snapshot);
  const firstConflictId = snapshot.conflicts[0]?.id;
  return (
    <div className="titlebar">
      <div className="lights">
        <i />
        <i />
        <i />
      </div>
      <div className="wordmark">Vibehub</div>
      <div className="repo" data-tip="Repository shown in this window">
        <RepoIcon />
        {snapshot.repo.slug}{" "}
        <span className="branch">
          {snapshot.repo.defaultBranch} · {snapshot.repo.branchCount} branch
          {snapshot.repo.branchCount === 1 ? "" : "es"}
        </span>
      </div>
      <div className="spacer" />
      {stats.map((s) => {
        // Open path #3: the conflict stat opens the adjudication card
        // (keyboard parity: focusable + Enter/Space, same as the pill).
        const opens = s.kind === "clash" && firstConflictId !== undefined;
        return (
          <div
            key={s.kind}
            className={`stat ${s.kind}`}
            data-tip={s.tip}
            {...(opens
              ? {
                  role: "button" as const,
                  tabIndex: 0,
                  onClick: (e: ReactMouseEvent<HTMLDivElement>) =>
                    onConflictOpen(firstConflictId, e.currentTarget),
                  onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onConflictOpen(firstConflictId, e.currentTarget);
                    }
                  },
                }
              : {})}
          >
            {s.text}
          </div>
        );
      })}
      <div
        className={`fresh${fresh.stale ? " stale" : ""}`}
        data-tip={
          fresh.stale
            ? `Last known repository freshness: ${fresh.text}`
            : `Repository freshness: ${fresh.text}`
        }
      >
        <span className="dot" />
        {fresh.text}
      </div>
      {snapshotNames.length > 1 && (
        <select
          className="snapshot-switch"
          aria-label="Preview snapshot"
          value={activeSnapshot}
          onChange={(e) => onSnapshotChange(e.target.value)}
        >
          {snapshotNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
