/**
 * SCALE-EXTREMES fixtures for the conflict card (LOOP.md protocol):
 *
 * conflictExtreme1200Symbols — NUMBER-huge + N=many: 1,200 shared symbols
 *   (two tasks both regenerating the same OpenAPI client — the one realistic
 *   way a symbol intersection explodes). Exercises:
 *   - the h4 count abbreviation past 999 ("1.2k" via formatCount, exact
 *     "1,200" in the tooltip via exactCount — the map's NUMBER-huge rule);
 *   - the 3 + "+1197 more" overflow ladder with .cbody as the only scroll
 *     region;
 *   - TEXT-long symbol names (every 97th row carries a ~90-char generated
 *     name);
 *   - a large staleness count (diagnosis mid-stream; editsSince COMPUTED
 *     from the generated touch times, so the fixture cannot lie about it).
 *   Generated programmatically but DETERMINISTICALLY (pure index arithmetic
 *   — no Date.now, no random; panel-marathon precedent).
 *
 * conflictExtremeOneSymbol — N=1 (the S1 notes' explicit "needs a fixture
 *   case by S3"): a single shared symbol, detected 45 seconds ago (seconds
 *   age rung), no diagnosis yet. The symbol list renders one row, no
 *   "+N more" toggle.
 */
import type {
  ConflictCardFixture,
  SharedSymbolEvidence,
} from "../conflict-types";

/* ── 1200 shared symbols ────────────────────────────────────────────────── */

const GEN_W = "task-regen-openapi-client";
const GEN_R = "task-api-client-fetch"; // also a writer — W × W

/** Seconds-of-day → fixed-day ISO string (deterministic, zero Date math). */
function atSec(secOfDay: number): string {
  const h = String(Math.floor(secOfDay / 3600)).padStart(2, "0");
  const m = String(Math.floor((secOfDay % 3600) / 60)).padStart(2, "0");
  const s = String(secOfDay % 60).padStart(2, "0");
  return `2026-07-12T${h}:${m}:${s}-07:00`;
}

const GEN_START = 9 * 3600; // both regenerators start burning at 09:00:00
const GEN_DIAGNOSED_AT = atSec(9 * 3600 + 40 * 60); // 09:40:00, mid-stream

const RESOURCES = [
  "orders", "payments", "refunds", "customers", "invoices", "webhooks",
  "subscriptions", "disputes", "payouts", "balances", "sessions", "tokens",
];
const VERBS = ["list", "get", "create", "update", "cancel", "retry"];

function genSymbols(): SharedSymbolEvidence[] {
  const out: SharedSymbolEvidence[] = [];
  for (let i = 0; i < 1200; i++) {
    const res = RESOURCES[i % RESOURCES.length]!;
    const verb = VERBS[Math.floor(i / RESOURCES.length) % VERBS.length]!;
    // TEXT-long rung: every 97th symbol gets a generated ~90-char name.
    const name =
      i % 97 === 0
        ? `GeneratedApiClient.${verb}${res[0]!.toUpperCase()}${res.slice(1)}WithPaginationAndIdempotencyKeyRetryPolicyOverride_v${i}`
        : `GeneratedApiClient.${verb}_${res}_${i}`;
    out.push({
      name,
      file: `src/api/generated/${res}.ts`,
      touches: [
        // 3-second cadence per side, one second apart — a codegen sweep.
        { taskId: GEN_W, action: "edit", at: atSec(GEN_START + 3 * i) },
        { taskId: GEN_R, action: "edit", at: atSec(GEN_START + 3 * i + 1) },
      ],
    });
  }
  return out;
}

const genSymbolList = genSymbols();

/** Staleness COMPUTED from the generated touches (cannot lie): every edit
 *  event strictly after diagnosedAt counts, both sides. */
const genEditsSince = genSymbolList.reduce(
  (n, s) => n + s.touches.filter((t) => t.at > GEN_DIAGNOSED_AT).length,
  0,
);

export const conflictExtreme1200Symbols = {
  capturedAt: atSec(10 * 3600 + 5 * 60), // 10:05:00
  conflict: {
    id: "conflict-generated-client",
    taskIds: [GEN_W, GEN_R],
    territoryId: "t-api",
    subBlockId: "s-generated-client",
    sharedSymbols: genSymbolList.map((s) => s.name),
    severity: "red",
    detectedAt: atSec(9 * 3600 + 12 * 60), // 09:12 → "53m"
  },
  tasks: [
    {
      id: GEN_W,
      title: "Regenerate the OpenAPI client from the v3 spec",
      state: "running",
      signalTier: "hooks",
      conflictIds: ["conflict-generated-client"],
      scopes: [
        {
          mode: "write",
          territoryId: "t-api",
          subBlockId: "s-generated-client",
          label: "api/generated",
          filesTouched: 12,
        },
      ],
      git: {
        branch: "vibehub/regen-openapi-v3",
        worktreePath: "~/dev/worktrees/regen-openapi",
      },
      stateSince: atSec(9 * 3600), // running since 09:00 → "1h"
      lastEventAt: atSec(10 * 3600 + 4 * 60 + 40),
      statusDetail:
        "Writing the same symbols as 'Migrate the API client to the fetch wrapper' (Generated API client).",
    },
    {
      id: GEN_R,
      title: "Migrate the API client to the fetch wrapper",
      state: "running",
      signalTier: "hooks",
      conflictIds: ["conflict-generated-client"],
      scopes: [
        {
          mode: "write",
          territoryId: "t-api",
          subBlockId: "s-generated-client",
          label: "api/generated",
          filesTouched: 12,
        },
      ],
      git: {
        branch: "vibehub/api-client-fetch-wrapper",
        worktreePath: "~/dev/worktrees/fetch-wrapper",
      },
      stateSince: atSec(9 * 3600 + 2 * 60), // running since 09:02 → "1h"
      lastEventAt: atSec(10 * 3600 + 4 * 60 + 55),
      statusDetail:
        "Other side of the same conflict — either card opens the same adjudication.",
    },
  ],
  crumb: {
    resourceName: "Generated API client",
    territoryName: "API Layer",
    subBlockName: "Generated API client",
    anchorFile: "src/api/generated/index.ts",
  },
  symbols: genSymbolList,
  diagnosis: {
    verdict:
      "Real conflict — both tasks regenerate the same client; every run overwrites the other's output wholesale.",
    sides: [
      {
        taskId: GEN_W,
        label: "Regen",
        doing:
          "Running the v3 codegen sweep — rewrites every file under `src/api/generated/` on each pass.",
      },
      {
        taskId: GEN_R,
        label: "Fetch",
        doing:
          "Rewriting the same generated modules by hand to swap the transport to the fetch wrapper.",
      },
    ],
    suggested:
      "Pause one side — hand-edits inside a codegen output directory cannot coexist with regeneration. Land the v3 regen first, then point the fetch-wrapper task at the codegen templates instead of the generated files.",
    provenance: { diagnosedAt: GEN_DIAGNOSED_AT, engine: "claude-p-local" },
    stalenessEditsSince: genEditsSince,
  },
} satisfies ConflictCardFixture;

/* ── one shared symbol ──────────────────────────────────────────────────── */

export const conflictExtremeOneSymbol = {
  capturedAt: "2026-07-12T11:15:00-07:00",
  conflict: {
    id: "conflict-flag-defaults",
    taskIds: ["task-dark-mode", "task-flag-cleanup"],
    territoryId: "t-fe",
    subBlockId: "s-feature-flags",
    sharedSymbols: ["FEATURE_FLAG_DEFAULTS"],
    severity: "red",
    detectedAt: "2026-07-12T11:14:15-07:00", // capturedAt 11:15 → "45s"
  },
  tasks: [
    {
      id: "task-dark-mode",
      title: "Ship dark mode behind a flag",
      state: "running",
      signalTier: "hooks",
      conflictIds: ["conflict-flag-defaults"],
      scopes: [
        {
          mode: "write",
          territoryId: "t-fe",
          subBlockId: "s-feature-flags",
          label: "web-ui/flags",
          filesTouched: 1,
        },
      ],
      git: {
        branch: "vibehub/dark-mode-flag",
        worktreePath: "~/dev/worktrees/dark-mode",
      },
      stateSince: "2026-07-12T10:58:00-07:00", // "running 17m"
      lastEventAt: "2026-07-12T11:14:15-07:00",
      statusDetail:
        "Writing the same symbol as 'Remove expired feature flags' (FEATURE_FLAG_DEFAULTS).",
    },
    {
      id: "task-flag-cleanup",
      title: "Remove expired feature flags",
      state: "running",
      signalTier: "hooks",
      conflictIds: ["conflict-flag-defaults"],
      scopes: [
        {
          mode: "write",
          territoryId: "t-fe",
          subBlockId: "s-feature-flags",
          label: "web-ui/flags",
          filesTouched: 3,
        },
      ],
      git: {
        branch: "vibehub/remove-expired-flags",
        worktreePath: "~/dev/worktrees/flag-cleanup",
      },
      stateSince: "2026-07-12T11:03:00-07:00", // "running 12m"
      lastEventAt: "2026-07-12T11:14:00-07:00",
      statusDetail:
        "Other side of the same conflict — either card opens the same adjudication.",
    },
  ],
  crumb: {
    resourceName: "Feature flags",
    territoryName: "Web UI",
    subBlockName: "Feature flags",
    anchorFile: "src/web/flags/defaults.ts",
  },
  symbols: [
    {
      name: "FEATURE_FLAG_DEFAULTS",
      file: "src/web/flags/defaults.ts",
      touches: [
        { taskId: "task-dark-mode", action: "edit", at: "2026-07-12T11:14:15-07:00" },
        { taskId: "task-flag-cleanup", action: "edit", at: "2026-07-12T11:12:30-07:00" },
      ],
    },
  ],
  // no diagnosis — detected 45s ago; zone b renders the dashed empty state.
} satisfies ConflictCardFixture;
