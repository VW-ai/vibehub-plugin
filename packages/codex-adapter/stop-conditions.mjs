// The adapter stop conditions pinned in upstream-lock.json, evaluated against
// what a running host has actually observed. Every condition resolves to one
// of five statuses:
//
//   pass            proven by an observation of this runtime;
//   violated        the pin is broken; the host must halt reuse visibly;
//   unverified      no observation could prove it yet (named honestly);
//   structural      guaranteed by how the host is composed, not by a probe;
//   not-applicable  the condition names a seam this shell does not have.
//
// The module is pure: it never talks to the app-server. The host feeds it the
// initialize result, the account read, the schema probe, runtime -32601
// observations and the restart recovery record, and acts on firstViolation().

import pinnedLock from "./upstream-lock.json" with { type: "json" };

export const STOP_CONDITION_IDS = Object.freeze([...pinnedLock.stopConditions]);
export const STOP_CONDITION_STATUSES = Object.freeze(["pass", "violated", "unverified", "structural", "not-applicable"]);

const PROTOCOL_HASH = "generated-protocol-hash-changed";
const REQUIRED_MISSING = "required-request-or-event-missing";
const AUTH_UNAVAILABLE = "managed-auth-status-unavailable";
const RESTART_RECOVERY = "thread-restart-recovery-unavailable";
const APPROVAL_HIDDEN_STATE = "approval-cannot-round-trip-without-hidden-state";
const AUDIO_REMOVED = "audio-input-removed";
const DSH_PROFILE = "dsh-profile-cannot-own-one-idempotent-app-server-process";
const TWO_AGENT_LOOPS = "same-user-action-routes-through-two-agent-loops";

export function observedRuntimeVersion(initialized) {
  return String(initialized?.userAgent ?? "").match(/^[^/\s]+\/(\d+\.\d+\.\d+)/u)?.[1] ?? null;
}

function condition(id, status, detail) {
  if (!STOP_CONDITION_STATUSES.includes(status)) throw new Error(`Unknown stop-condition status ${status}`);
  return { id, status, detail };
}

function list(values, limit = 6) {
  const items = [...values];
  const shown = items.slice(0, limit).join(", ");
  return items.length > limit ? `${shown} (+${items.length - limit} more)` : shown;
}

function probeChecks(schemaProbe, kinds) {
  return (schemaProbe?.checks ?? []).filter((check) => kinds.includes(check.kind));
}

export function evaluateStopConditions({
  lock = pinnedLock,
  initialized = null,
  observedVersion = observedRuntimeVersion(initialized),
  account = null,
  accountError = null,
  schemaProbe = null,
  schemaProbeError = null,
  missingMethods = [],
  recovery = null,
  staleRequestIds = [],
  carrierIds = [],
  dshProfile = null,
} = {}) {
  const pinnedVersion = lock.codex.version;
  const pinnedHash = lock.codex.protocolSchemaSha256;
  const conditions = [];

  // generated-protocol-hash-changed: the version and the generated protocol
  // schema are pinned together; a different binary is a different protocol.
  if (observedVersion && observedVersion !== pinnedVersion) {
    conditions.push(condition(PROTOCOL_HASH, "violated", `Codex app-server ${observedVersion} is running but the lock pins ${pinnedVersion} (protocol schema ${pinnedHash.slice(0, 12)}…).`));
  } else if (schemaProbe) {
    const proven = schemaProbe.schemaSha256 === pinnedHash;
    conditions.push(condition(PROTOCOL_HASH, proven ? "pass" : "violated", proven
      ? `codex app-server generate-json-schema hashes to the pinned ${pinnedHash.slice(0, 12)}… for ${observedVersion ?? pinnedVersion}.`
      : `codex app-server generate-json-schema hashes to ${String(schemaProbe.schemaSha256).slice(0, 12)}…, not the pinned ${pinnedHash.slice(0, 12)}….`));
  } else if (observedVersion === pinnedVersion) {
    conditions.push(condition(PROTOCOL_HASH, "unverified", `Codex app-server ${observedVersion} matches the pinned version; its generated protocol schema was not re-hashed against this binary${schemaProbeError ? ` (${schemaProbeError})` : ""}. Run npm run probe:codex against the pinned binary to prove it.`));
  } else {
    conditions.push(condition(PROTOCOL_HASH, "unverified", "The runtime version could not be read from initialize.userAgent, so the protocol pin is unproven."));
  }

  // required-request-or-event-missing: a -32601 for any pinned request at
  // runtime is a violation on its own; the generated schema proves the rest.
  const missing = [...new Set(missingMethods)].filter((method) => lock.requiredRequests.includes(method));
  if (missing.length) {
    conditions.push(condition(REQUIRED_MISSING, "violated", `The runtime rejected pinned request${missing.length === 1 ? "" : "s"} ${list(missing)} as unknown (-32601).`));
  } else if (schemaProbe) {
    const unproven = probeChecks(schemaProbe, ["request", "server-request", "notification"]).filter((check) => !check.proven).map((check) => `${check.kind} ${check.method}`);
    conditions.push(condition(REQUIRED_MISSING, unproven.length ? "violated" : "pass", unproven.length
      ? `The generated schema omits ${list(unproven)}.`
      : `Every pinned request, server request and notification is present in the generated schema.`));
  } else {
    conditions.push(condition(REQUIRED_MISSING, "unverified", "No pinned request has been rejected as unknown by this runtime; generated-schema coverage was not probed."));
  }

  // managed-auth-status-unavailable: account/read must answer, authenticated
  // or not. VibeHub never persists credentials, so an unreadable status is a
  // halt rather than a guess.
  if (accountError || !account) {
    conditions.push(condition(AUTH_UNAVAILABLE, "violated", `account/read did not answer${accountError ? `: ${accountError}` : ""}.`));
  } else {
    conditions.push(condition(AUTH_UNAVAILABLE, "pass", `account/read answered (authenticated: ${Boolean(account.authenticated)}${account.accountType ? `, ${account.accountType}` : ""}).`));
  }

  // thread-restart-recovery-unavailable: proven only by an observed restart
  // in this host process; every Thread identity and Task link known before
  // the exit must resolve again afterwards.
  if (!recovery) {
    conditions.push(condition(RESTART_RECOVERY, "unverified", "No app-server restart has been observed in this host process; Thread identity and Task linkage recovery is proven when one happens."));
  } else if (recovery.error) {
    conditions.push(condition(RESTART_RECOVERY, "violated", `The app-server could not be restarted${recovery.attempts ? ` after ${recovery.attempts} attempt${recovery.attempts === 1 ? "" : "s"}` : ""}: ${recovery.error}`));
  } else {
    const missingThreads = recovery.missingThreadIds ?? [];
    const lostLinks = recovery.lostTaskLinks ?? [];
    if (missingThreads.length || lostLinks.length) {
      const parts = [];
      if (missingThreads.length) parts.push(`Thread${missingThreads.length === 1 ? "" : "s"} ${list(missingThreads)} did not come back`);
      if (lostLinks.length) parts.push(`Task link${lostLinks.length === 1 ? "" : "s"} ${list(lostLinks.map((link) => `${link.ticketId}→${link.threadId}`))} lost`);
      conditions.push(condition(RESTART_RECOVERY, "violated", `After restart (generation ${recovery.generation ?? "?"}), ${parts.join("; ")}.`));
    } else {
      conditions.push(condition(RESTART_RECOVERY, "pass", `After restart (generation ${recovery.generation ?? "?"}), ${(recovery.recoveredThreadIds ?? []).length} known Thread identit${(recovery.recoveredThreadIds ?? []).length === 1 ? "y" : "ies"} and ${(recovery.recoveredTaskLinks ?? []).length} Task link${(recovery.recoveredTaskLinks ?? []).length === 1 ? "" : "s"} resolved from Codex again.`));
    }
  }

  // approval-cannot-round-trip-without-hidden-state: a request is answered
  // only to the process generation that asked; anything pending at exit is
  // resolved as runtime_exited, never replayed to a new process.
  if (staleRequestIds.length) {
    conditions.push(condition(APPROVAL_HIDDEN_STATE, "violated", `Request${staleRequestIds.length === 1 ? "" : "s"} ${list(staleRequestIds)} from an earlier process generation ${staleRequestIds.length === 1 ? "is" : "are"} still pending.`));
  } else {
    conditions.push(condition(APPROVAL_HIDDEN_STATE, "structural", "Approval and input requests are answered only to the process generation that asked; requests pending at exit are resolved as runtime_exited and never replayed."));
  }

  // audio-input-removed: the stable audio Turn inputs must stay in the
  // generated schema.
  if (schemaProbe) {
    const removed = probeChecks(schemaProbe, ["audio-input"]).filter((check) => !check.proven).map((check) => check.method);
    conditions.push(condition(AUDIO_REMOVED, removed.length ? "violated" : "pass", removed.length
      ? `The generated schema no longer carries Turn input${removed.length === 1 ? "" : "s"} ${list(removed)}.`
      : `Turn inputs ${list(lock.audio.stableTurnInputs)} are present in the generated schema.`));
  } else {
    conditions.push(condition(AUDIO_REMOVED, "unverified", `Turn inputs ${list(lock.audio.stableTurnInputs)} are pinned; the generated schema was not probed against this binary.`));
  }

  // dsh-profile-cannot-own-one-idempotent-app-server-process: no DSH profile
  // takes part in the Codex-first shell.
  if (dshProfile === null) {
    conditions.push(condition(DSH_PROFILE, "not-applicable", "No DSH profile is in this shell; the codex adapter client owns the single app-server process."));
  } else {
    conditions.push(condition(DSH_PROFILE, dshProfile.ownsSingleProcess ? "pass" : "violated", dshProfile.ownsSingleProcess
      ? "The DSH profile owns exactly one idempotent app-server process."
      : "The DSH profile cannot own one idempotent app-server process."));
  }

  // same-user-action-routes-through-two-agent-loops: the shared harness
  // router holds exactly one selected adapter.
  const carriers = [...new Set(carrierIds)];
  conditions.push(condition(TWO_AGENT_LOOPS, carriers.length === 1 ? "structural" : "violated", carriers.length === 1
    ? `Every user action routes through the single selected harness (${carriers[0]}).`
    : carriers.length === 0 ? "No harness carrier is selected." : `More than one harness carrier is selected: ${list(carriers)}.`));

  const byId = new Map(conditions.map((entry) => [entry.id, entry]));
  const ordered = STOP_CONDITION_IDS.map((id) => byId.get(id) ?? condition(id, "unverified", "Not evaluated."));
  return {
    evaluatedAt: new Date().toISOString(),
    pinnedVersion,
    observedVersion,
    conditions: ordered,
    violated: ordered.filter((entry) => entry.status === "violated").map((entry) => entry.id),
    ok: ordered.every((entry) => entry.status !== "violated"),
  };
}

export function firstViolation(report) {
  return report?.conditions?.find((entry) => entry.status === "violated") ?? null;
}
