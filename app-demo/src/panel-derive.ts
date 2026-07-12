/**
 * panel-derive.ts — pure derivations from a TaskPanelFixture.
 * Same hard rule as derive.ts: no stored view flags, everything the panel
 * shows is fixture data or a mechanical join computed here.
 */
import type { TimelineEvent } from "./panel-types";

/**
 * Milestone tier — DERIVED, never stored (decision-project-023).
 *
 * The whitelist is mechanical, zero LLM/semantic judgment:
 *   - commit            → 最强锚点 ("commit 为锚")
 *   - state_transition  → 转折为节 (021 transitions)
 *   - launch / user_injection → user actions, MUST always show (023
 *     constraint: 用户的介入动作必入时间线, both tiers)
 *   - question          → carrier of the →waiting transition (every question
 *     flips the task to waiting per 021, so it IS a whitelisted transition;
 *     hiding it would hide the reason the panel is open)
 *
 * Everything else (self_report, agent_ack, file_change, file_read, test_run,
 * cross_read_notice) shows only under "All".
 *
 * NOTE: this is intentionally COARSER than the S2 static's hand-tagged .ms
 * set (which kept self-reports + file bursts) — 023's milestone档 wins over
 * the mock. Fork logged: DECISIONS-NEEDED iter-6.
 */
export function isMilestone(e: TimelineEvent): boolean {
  switch (e.type) {
    case "commit":
    case "state_transition":
    case "launch":
    case "user_injection":
    case "question":
      return true;
    default:
      return false;
  }
}

/** The Milestones-tier view of a timeline (order preserved). */
export function milestoneEvents(timeline: TimelineEvent[]): TimelineEvent[] {
  return timeline.filter(isMilestone);
}

/**
 * Dot/tint channel per entry (S2 classes): who authored the entry.
 *   - "user"  → blue dot + tinted body (launch, injection)
 *   - "ask"   → red dot + need-tinted body (question)
 *   - "cross" → outline dot, quietest (cross-read notice)
 *   - "agent" → green dot (everything the agent/git did)
 * One visual channel per job (LOOP.md guideline 6).
 */
export type EventVoice = "user" | "ask" | "cross" | "agent";

export function eventVoice(e: TimelineEvent): EventVoice {
  switch (e.type) {
    case "launch":
    case "user_injection":
      return "user";
    case "question":
      return "ask";
    case "cross_read_notice":
      return "cross";
    default:
      return "agent";
  }
}

/**
 * Mechanical (quiet gray fs-2) entries per S2: tool-level noise.
 * Distinct from the milestone tier: mech styles the entry, tier filters it.
 */
export function isMechanical(e: TimelineEvent): boolean {
  return e.type === "test_run" || e.type === "file_read";
}
