/**
 * extreme-scope-overload — N=many on chips: one task declaring 9 scopes
 * (breadth is legal and unpunished per decision-project-020). RULE REVISION
 * (Wayne 2026-07-12 review): the rail card WRAPS all its chips and grows
 * taller — 9 scopes + branch render as 10 visible chips. The old +N collapse
 * survives only past PATHOLOGICAL_MAX (12) chips, exercised here by the
 * 14-scope task below. Also carries a NUMBER-huge territory (100 000 anchored
 * files → must render abbreviated "100k" with exact-count tooltip) and a
 * TEXT-long task title (must truncate with hover-full-text).
 */
import type { MapFixture, ScopeDeclaration } from "../types";

const nineScopes: ScopeDeclaration[] = [
  { mode: "write", territoryId: "x-core", label: "core", filesTouched: 3 },
  { mode: "write", territoryId: "x-api", label: "api", filesTouched: 2 },
  { mode: "read", territoryId: "x-auth", label: "auth" },
  { mode: "read", territoryId: "x-billing", label: "billing" },
  { mode: "read", territoryId: "x-search", label: "search" },
  { mode: "read", territoryId: "x-mail", label: "mail" },
  { mode: "read", territoryId: "x-jobs", label: "jobs" },
  { mode: "read", territoryId: "x-infra", label: "infra" },
  { mode: "read", territoryId: "x-vendored", label: "vendored-monolith-compat" },
];

/* Pathological chip count (rev-1): 14 scope declarations + branch = 15
 * chips — beyond PATHOLOGICAL_MAX (12), so this card wraps ~3 rows then
 * collapses the tail into +N (first 11 visible + "+4"). Multiple
 * declarations per territory are legal: each is a separate path-scoped
 * registration within the territory. */
const fourteenScopes: ScopeDeclaration[] = [
  { mode: "write", territoryId: "x-core", label: "core/errors", filesTouched: 4 },
  { mode: "write", territoryId: "x-core", label: "core/result-types", filesTouched: 2 },
  { mode: "write", territoryId: "x-api", label: "api/middleware", filesTouched: 3 },
  { mode: "read", territoryId: "x-api", label: "api/handlers" },
  { mode: "read", territoryId: "x-auth", label: "auth/sessions" },
  { mode: "read", territoryId: "x-auth", label: "auth/oauth" },
  { mode: "read", territoryId: "x-billing", label: "billing/invoices" },
  { mode: "read", territoryId: "x-billing", label: "billing/webhooks" },
  { mode: "read", territoryId: "x-search", label: "search/indexer" },
  { mode: "read", territoryId: "x-mail", label: "mail/templates" },
  { mode: "read", territoryId: "x-jobs", label: "jobs/scheduler" },
  { mode: "read", territoryId: "x-infra", label: "infra/terraform" },
  { mode: "read", territoryId: "x-infra", label: "infra/ci-runners" },
  { mode: "read", territoryId: "x-vendored", label: "vendored/shims" },
];

export const extremeScopeOverload = {
  capturedAt: "2026-07-12T10:22:00-07:00",
  repo: {
    slug: "acme/megarepo",
    defaultBranch: "main",
    branchCount: 214,
  },
  sync: {
    lastFetchAt: "2026-07-12T10:20:00-07:00",
    lastHookEventAt: "2026-07-12T10:21:00-07:00",
    stale: false,
  },
  tasks: [
    {
      id: "task-nine-scopes",
      title: "Unify error handling across services",
      state: "running",
      signalTier: "hooks",
      conflictIds: [],
      scopes: nineScopes,
      git: {
        branch: "acme/unify-error-handling",
        worktreePath: "~/dev/megarepo-wt/errors",
      },
      stateSince: "2026-07-12T09:30:00-07:00",
      lastEventAt: "2026-07-12T10:21:00-07:00",
      statusDetail: "Agent actively producing — tool calls and edits flowing.",
    },
    {
      id: "task-long-title",
      title:
        "Investigate and fix the intermittent 502s from the payments gateway when the upstream connection pool is exhausted during regional failover and write a regression test that reproduces the exhaustion deterministically",
      // "basic" tier can NEVER infer "waiting" (decision-project-021), so this
      // long-title task is honestly "stalled" — it exercises long-title
      // truncation AND the reduced-perception label at the same time.
      state: "stalled",
      signalTier: "basic",
      conflictIds: [],
      scopes: [{ mode: "write", territoryId: "x-infra", label: "infra" }],
      git: { branch: "acme/fix-payments-gateway-502s" },
      stateSince: "2026-07-12T10:05:00-07:00",
      lastEventAt: "2026-07-12T10:05:00-07:00",
    },
    {
      id: "task-pathological-scopes",
      title: "Audit error propagation repo-wide",
      state: "running",
      signalTier: "hooks",
      conflictIds: [],
      scopes: fourteenScopes,
      git: {
        branch: "acme/audit-error-propagation-sweep",
        worktreePath: "~/dev/megarepo-wt/audit",
      },
      stateSince: "2026-07-12T09:55:00-07:00",
      lastEventAt: "2026-07-12T10:20:00-07:00",
      statusDetail: "Sweeping error paths service by service.",
    },
  ],
  territories: [
    {
      id: "x-core",
      name: "Core Domain",
      anchoredFileCount: 100000,
      subBlocks: [],
      demoLayout: { left: 3, top: 4.5, width: 45, height: 50 },
    },
    {
      id: "x-api",
      name: "Public API",
      anchoredFileCount: 320,
      subBlocks: [],
      demoLayout: { left: 51, top: 4.5, width: 22, height: 30 },
    },
    {
      id: "x-auth",
      name: "Auth",
      anchoredFileCount: 41,
      subBlocks: [],
      demoLayout: { left: 76, top: 4.5, width: 21, height: 30 },
    },
    {
      id: "x-billing",
      name: "Billing",
      anchoredFileCount: 77,
      subBlocks: [],
      demoLayout: { left: 51, top: 37, width: 22, height: 26 },
    },
    {
      id: "x-search",
      name: "Search",
      anchoredFileCount: 55,
      subBlocks: [],
      demoLayout: { left: 76, top: 37, width: 21, height: 26 },
    },
    {
      id: "x-mail",
      name: "Mail",
      anchoredFileCount: 18,
      subBlocks: [],
      demoLayout: { left: 3, top: 57, width: 22, height: 35 },
    },
    {
      id: "x-jobs",
      name: "Background Jobs",
      anchoredFileCount: 29,
      subBlocks: [],
      demoLayout: { left: 27, top: 57, width: 21, height: 35 },
    },
    {
      id: "x-infra",
      name: "Infra & Deploy",
      anchoredFileCount: 63,
      subBlocks: [],
      demoLayout: { left: 51, top: 66, width: 22, height: 26 },
    },
    {
      id: "x-vendored",
      name: "Vendored Monolith Compatibility Shims",
      anchoredFileCount: 8421,
      subBlocks: [],
      demoLayout: { left: 76, top: 66, width: 21, height: 26 },
    },
  ],
  occupancy: [
    {
      territoryId: "x-core",
      writingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      readingTaskIds: [],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "x-api",
      writingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      readingTaskIds: [],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "x-auth",
      writingTaskIds: [],
      readingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "x-billing",
      writingTaskIds: [],
      readingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "x-search",
      writingTaskIds: [],
      readingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "x-mail",
      writingTaskIds: [],
      readingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "x-jobs",
      writingTaskIds: [],
      readingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "x-infra",
      writingTaskIds: ["task-long-title"],
      readingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      doneTodayTaskIds: [],
    },
    {
      territoryId: "x-vendored",
      writingTaskIds: [],
      readingTaskIds: ["task-nine-scopes", "task-pathological-scopes"],
      doneTodayTaskIds: [],
    },
  ],
  conflicts: [],
} satisfies MapFixture;
