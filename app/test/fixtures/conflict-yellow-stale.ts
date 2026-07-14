/**
 * conflict-yellow-stale — the EXACT content of the approved S2 static's
 * yellow variant (static/conflict-card-s2.html, `?v=yellow`): W × R on
 * "Template registry", detected 10:44 (31m), 12 shared symbols (UI shows
 * 3 + "+9 more"), LONG task and symbol names (TEXT-long extreme — the
 * 61-char `NotificationTemplateRegistry.resolveLocalizedTemplateVariant`),
 * batching rewrite running 1h × localization task waiting 5m.
 *
 * The diagnosis is STALE: it ran at 11:02, and the batching rewrite edited
 * 3 shared symbols after that (11:03 localeFallbackChain, 11:05
 * templateCacheKey, 11:08 TemplateCompiler.compile — the fixture's own
 * touch times ARE the evidence) ⇒ stalenessEditsSince 3, neutral dot,
 * "· 3 edits since" marker. Reads after 11:02 do NOT count — the verdict
 * goes stale when the code changes, not when someone looks at it.
 */
import type {
  ConflictCardSnapshot,
  SharedSymbolEvidence,
  SymbolTouch,
} from "@vibehub/core/contracts";

const W = "task-notification-batching";
const R = "task-localized-templates";

/** One W×R evidence row (write always task W, read always task R here). */
function wr(name: string, file: string, editAt: string, readAt: string): SharedSymbolEvidence {
  const touches: [SymbolTouch, SymbolTouch] = [
    { taskId: W, action: "edit", at: editAt },
    { taskId: R, action: "read", at: readAt },
  ];
  return { name, file, touches };
}

const REG = "src/notifications/templates/registry.ts";
const T = (hm: string) => `2026-07-12T${hm}:00-07:00`;

/** All 12 rows, names/files/times verbatim from the S2 tooltips. */
const symbols: SharedSymbolEvidence[] = [
  wr("templateRegistry.resolve", REG, T("10:41"), T("10:44")),
  wr(
    "NotificationTemplateRegistry.resolveLocalizedTemplateVariant",
    REG,
    T("10:47"),
    T("10:52"),
  ),
  wr("TEMPLATE_DEFAULTS", REG, T("10:49"), T("10:55")),
  wr("templateRegistry.register", REG, T("10:50"), T("10:58")),
  wr("digestWindow.schedule", "src/notifications/digest.ts", T("10:52"), T("11:01")),
  wr("ratelimit.perChannel", "src/notifications/ratelimit.ts", T("10:54"), T("11:01")),
  wr("ChannelPolicy.evaluate", "src/notifications/policy.ts", T("10:57"), T("11:02")),
  wr("renderDigestEmail", "src/notifications/render.ts", T("10:59"), T("11:04")),
  wr("renderTransactionalEmail", "src/notifications/render.ts", T("11:01"), T("11:05")),
  wr("localeFallbackChain", "src/notifications/locale.ts", T("11:03"), T("11:07")),
  wr("templateCacheKey", "src/notifications/cache.ts", T("11:05"), T("11:09")),
  wr("TemplateCompiler.compile", "src/notifications/compiler.ts", T("11:08"), T("11:11")),
];

export const conflictYellowStale = {
  capturedAt: T("11:15"),
  conflict: {
    id: "conflict-templates",
    taskIds: [W, R],
    territoryId: "t-notify",
    subBlockId: "s-templates",
    sharedSymbols: symbols.map((s) => s.name),
    severity: "yellow",
    detectedAt: T("10:44"), // capturedAt 11:15 → "31m"
  },
  tasks: [
    {
      id: W,
      title:
        "Rewrite the notification batching pipeline to support per-channel rate limits and digest windows",
      state: "running",
      signalTier: "hooks",
      conflictIds: ["conflict-templates"],
      scopes: [
        {
          mode: "write",
          territoryId: "t-notify",
          subBlockId: "s-templates",
          label: "notify/templates",
          filesTouched: 7, // S2 chip tooltip: "7 files touched here so far"
        },
      ],
      git: {
        branch: "vibehub/notification-batching-rate-limits",
        worktreePath: "~/dev/worktrees/batching",
      },
      stateSince: T("10:15"), // pause menu: "running 1h" (60m → 1h)
      lastEventAt: T("11:14"),
      statusDetail: "Agent actively producing — tool calls and edits flowing.",
    },
    {
      id: R,
      title:
        "Generate localized email templates for all transactional notification flows",
      state: "waiting",
      signalTier: "hooks",
      conflictIds: ["conflict-templates"],
      scopes: [
        {
          mode: "read",
          territoryId: "t-notify",
          subBlockId: "s-templates",
          label: "notify/templates",
        },
      ],
      git: {
        branch: "vibehub/localized-transactional-templates",
        worktreePath: "~/dev/worktrees/l10n-templates",
      },
      stateSince: T("11:10"), // pause menu no-op row: "waiting 5m", asked at 11:10
      lastEventAt: T("11:10"),
      statusDetail: "Agent stopped and asked a question. Parked until you answer.",
    },
  ],
  crumb: {
    resourceName: "Template registry",
    territoryName: "Notifications",
    subBlockName: "Template registry",
    anchorFile: REG,
  },
  symbols,
  diagnosis: {
    verdict: "Not blocking — the reader consumes a stable surface.",
    sides: [
      {
        taskId: W,
        label: "Batching",
        doing:
          "Rewriting registry internals; the `resolve()` signature and template shape are unchanged so far.",
      },
      {
        taskId: R,
        label: "Templates",
        doing:
          "Only calls the registry's public API to look up defaults and locale fallbacks — it never touches the files being rewritten.",
      },
    ],
    suggested:
      "Safe to let both run. If the batching rewrite changes `resolve()`'s signature this pair should be re-diagnosed — a note to the batching task to flag signature changes would cover it.",
    provenance: { diagnosedAt: T("11:02"), engine: "claude-p-local" },
    // Edits after 11:02: 11:03 + 11:05 + 11:08 (see the touch times above).
    stalenessEditsSince: 3,
  },
} satisfies ConflictCardSnapshot;
