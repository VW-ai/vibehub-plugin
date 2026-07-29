/**
 * Contract-shaped source fixture extracted from the accepted Ticket Review
 * Surface v4. It has no production Ticket authority.
 *
 * The prototype's coordinates, authored operational shorthand, proof values,
 * and raw lens labels are intentionally absent. With no attributable
 * capability or trace receipts in the prototype, the projector must expose
 * those slots as unavailable rather than infer them from presentation data.
 */
import type { TicketReviewProjectionSourceV0 } from "../../src/ticket-review-source.js";

export const ticketReviewV4Source = {
  schemaVersion: 1,
  snapshotRevision: "ticket-review-v4",
  projectionWatermark: "ticket-review-v4:watermark",
  ticketDefinitions: [
    {
      ticketId: "TKT-001",
      definitionRevision: 1,
      outcome:
        "Durable intent compiles into a reviewable, executable, and evidence-backed Ticket Graph.",
    },
    {
      ticketId: "TKT-090",
      definitionRevision: 1,
      outcome:
        "The orchestration graph is shaped from the current intent, constraints, architecture, and project knowledge.",
    },
    {
      ticketId: "TKT-100",
      definitionRevision: 1,
      outcome:
        "A person can see every necessary path, its decisions, and why each Ticket contributes to the deliverable.",
    },
    {
      ticketId: "TKT-104",
      definitionRevision: 1,
      outcome:
        "The intended change is expressed as observable outcomes rather than one static task description.",
    },
    {
      ticketId: "TKT-106",
      definitionRevision: 1,
      outcome:
        "Necessary facts, results, and decisions are synthesized backward from each outcome acceptance.",
    },
    {
      ticketId: "TKT-108",
      definitionRevision: 1,
      outcome:
        "The proposed graph is reachable, necessary, de-duplicated, and correctly related when read from current facts.",
    },
    {
      ticketId: "TKT-107",
      definitionRevision: 1,
      outcome:
        "The coarse outcome graph receives human review or bounded delegation before execution begins.",
    },
    {
      ticketId: "TKT-200",
      definitionRevision: 1,
      outcome:
        "Unblocked work progresses autonomously until a genuine authority or decision boundary is reached.",
    },
    {
      ticketId: "TKT-122",
      definitionRevision: 1,
      outcome:
        "The next Ticket is selected from current dependencies, facts, and delegated authority.",
    },
    {
      ticketId: "TKT-124",
      definitionRevision: 1,
      outcome:
        "The Agent uses native tools and domain intelligence to produce the intended result.",
    },
    {
      ticketId: "TKT-126",
      definitionRevision: 1,
      outcome:
        "Independent verification checks the result against observable acceptance.",
    },
    {
      ticketId: "TKT-128",
      definitionRevision: 1,
      outcome:
        "Execution learning updates bounded follow-up work without changing the approved boundary.",
    },
    {
      ticketId: "TKT-300",
      definitionRevision: 1,
      outcome:
        "Human-owned choices block only the affected branch and resume it with explicit authority.",
    },
    {
      ticketId: "TKT-140",
      definitionRevision: 1,
      outcome:
        "The Agent recognizes that a choice would change the human-authorized experience.",
    },
    {
      ticketId: "TKT-312",
      definitionRevision: 1,
      outcome:
        "Choose how people understand and approve the Ticket Graph without turning it into a dashboard or second object model.",
    },
    {
      ticketId: "TKT-143",
      definitionRevision: 1,
      outcome:
        "The authorized direction becomes a revised, executable dependency path.",
    },
    {
      ticketId: "TKT-144",
      definitionRevision: 1,
      outcome:
        "Independent delegated work keeps moving while the decision branch waits.",
    },
    {
      ticketId: "TKT-400",
      definitionRevision: 1,
      outcome:
        "A material deviation becomes visible and is resolved before the affected path closes.",
    },
    {
      ticketId: "TKT-160",
      definitionRevision: 1,
      outcome:
        "The implementation is compared with the agreed Core-owned architecture.",
    },
    {
      ticketId: "TKT-162",
      definitionRevision: 1,
      outcome:
        "Evidence identifies every component writing canonical Ticket facts.",
    },
    {
      ticketId: "TKT-407",
      definitionRevision: 1,
      outcome:
        "Restore one canonical writer or explicitly revise the architecture principle.",
    },
    {
      ticketId: "TKT-165",
      definitionRevision: 1,
      outcome:
        "CLI, MCP, and direct Core behavior remain semantically identical.",
    },
    {
      ticketId: "TKT-166",
      definitionRevision: 1,
      outcome:
        "The accepted correction or principle change remains traceable.",
    },
    {
      ticketId: "TKT-500",
      definitionRevision: 1,
      outcome:
        "Completion is derived from accepted evidence and any remaining work is explicit.",
    },
    {
      ticketId: "TKT-180",
      definitionRevision: 1,
      outcome:
        "The Run preserves the artifacts needed to evaluate its result.",
    },
    {
      ticketId: "TKT-181",
      definitionRevision: 1,
      outcome: "Each accepted outcome points to inspectable evidence.",
    },
    {
      ticketId: "TKT-182",
      definitionRevision: 1,
      outcome:
        "The result is independently assessed as proven, partial, or failed.",
    },
    {
      ticketId: "TKT-184",
      definitionRevision: 1,
      outcome:
        "Durable facts support completion without a writable status declaration.",
    },
    {
      ticketId: "TKT-185",
      definitionRevision: 1,
      outcome:
        "New learning becomes bounded follow-up Tickets or a closeout proposal.",
    },
  ],
  directUnlocks: [
    {
      relationRef: "ticket-review-v4:direct-unlock:01",
      prerequisiteTicketId: "TKT-090",
      dependentTicketId: "TKT-104",
      rationale:
        "The current project context is required before the intended outcomes can be named.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:02",
      prerequisiteTicketId: "TKT-104",
      dependentTicketId: "TKT-106",
      rationale:
        "Named outcomes are required before their acceptance can be backchained.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:03",
      prerequisiteTicketId: "TKT-090",
      dependentTicketId: "TKT-106",
      rationale:
        "Backchaining must preserve current architecture and authority constraints.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:04",
      prerequisiteTicketId: "TKT-106",
      dependentTicketId: "TKT-108",
      rationale:
        "Backward synthesis must exist before the graph can be normalized from current facts.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:05",
      prerequisiteTicketId: "TKT-108",
      dependentTicketId: "TKT-107",
      rationale:
        "The human reviews or delegates the normalized graph, not an unclean path hypothesis.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:06",
      prerequisiteTicketId: "TKT-107",
      dependentTicketId: "TKT-100",
      rationale:
        "Review or explicit delegation supplies authority for the coarse plan outcome.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:07",
      prerequisiteTicketId: "TKT-090",
      dependentTicketId: "TKT-122",
      rationale: "Ready work selection requires bound context.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:08",
      prerequisiteTicketId: "TKT-107",
      dependentTicketId: "TKT-122",
      rationale: "The approved or delegated graph unlocks scheduling.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:09",
      prerequisiteTicketId: "TKT-122",
      dependentTicketId: "TKT-124",
      rationale:
        "The selected READY Ticket supplies the bounded execution contract.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:10",
      prerequisiteTicketId: "TKT-124",
      dependentTicketId: "TKT-126",
      rationale:
        "Verification evaluates the artifact and evidence produced by execution.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:11",
      prerequisiteTicketId: "TKT-126",
      dependentTicketId: "TKT-128",
      rationale:
        "Graph tending uses verified learning rather than raw activity.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:12",
      prerequisiteTicketId: "TKT-128",
      dependentTicketId: "TKT-200",
      rationale:
        "The loop progresses safely when execution learning remains in the graph.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:13",
      prerequisiteTicketId: "TKT-140",
      dependentTicketId: "TKT-312",
      rationale:
        "Crossing the experience boundary requires an explicit human-owned decision.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:14",
      prerequisiteTicketId: "TKT-312",
      dependentTicketId: "TKT-143",
      rationale:
        "The affected path cannot be replanned until the decision has authority.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:15",
      prerequisiteTicketId: "TKT-140",
      dependentTicketId: "TKT-144",
      rationale:
        "Unaffected delegated work may continue after the boundary is isolated.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:16",
      prerequisiteTicketId: "TKT-143",
      dependentTicketId: "TKT-300",
      rationale:
        "The affected branch must reflect the authorized direction.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:17",
      prerequisiteTicketId: "TKT-144",
      dependentTicketId: "TKT-300",
      rationale:
        "Unrelated work contributes without waiting on the blocked branch.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:18",
      prerequisiteTicketId: "TKT-160",
      dependentTicketId: "TKT-162",
      rationale:
        "The governing principle defines which state writes need tracing.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:19",
      prerequisiteTicketId: "TKT-162",
      dependentTicketId: "TKT-407",
      rationale:
        "The trace provides evidence of the second canonical writer.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:20",
      prerequisiteTicketId: "TKT-407",
      dependentTicketId: "TKT-165",
      rationale:
        "Parity is meaningful only after the deviation is corrected or authorized.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:21",
      prerequisiteTicketId: "TKT-165",
      dependentTicketId: "TKT-166",
      rationale: "The resolution is recorded after parity is proven.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:22",
      prerequisiteTicketId: "TKT-166",
      dependentTicketId: "TKT-400",
      rationale: "Traceable resolution proves the architecture outcome.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:23",
      prerequisiteTicketId: "TKT-124",
      dependentTicketId: "TKT-180",
      rationale: "Execution artifacts feed the evidence closeout path.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:24",
      prerequisiteTicketId: "TKT-180",
      dependentTicketId: "TKT-181",
      rationale:
        "Evidence binding needs concrete artifacts from the Run.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:25",
      prerequisiteTicketId: "TKT-181",
      dependentTicketId: "TKT-182",
      rationale:
        "Outcome review adjudicates evidence already bound to acceptance.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:26",
      prerequisiteTicketId: "TKT-126",
      dependentTicketId: "TKT-182",
      rationale:
        "Verification findings are inputs to semantic outcome review.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:27",
      prerequisiteTicketId: "TKT-182",
      dependentTicketId: "TKT-184",
      rationale:
        "The durable outcome records the independent review result.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:28",
      prerequisiteTicketId: "TKT-184",
      dependentTicketId: "TKT-185",
      rationale:
        "Follow-up work is proposed from the recorded outcome and residual gaps.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:29",
      prerequisiteTicketId: "TKT-128",
      dependentTicketId: "TKT-185",
      rationale:
        "Graph tending and closeout reconcile the same bounded follow-up work.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:30",
      prerequisiteTicketId: "TKT-185",
      dependentTicketId: "TKT-500",
      rationale:
        "The outcome is complete when residual work is explicit.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:31",
      prerequisiteTicketId: "TKT-100",
      dependentTicketId: "TKT-001",
      rationale:
        "The top-level deliverable requires a plan that a human can understand and authorize.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:32",
      prerequisiteTicketId: "TKT-200",
      dependentTicketId: "TKT-001",
      rationale:
        "The top-level deliverable requires safe autonomous progress.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:33",
      prerequisiteTicketId: "TKT-300",
      dependentTicketId: "TKT-001",
      rationale:
        "The top-level deliverable requires human-owned choices to route correctly.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:34",
      prerequisiteTicketId: "TKT-400",
      dependentTicketId: "TKT-001",
      rationale:
        "The top-level deliverable requires architecture coherence.",
    },
    {
      relationRef: "ticket-review-v4:direct-unlock:35",
      prerequisiteTicketId: "TKT-500",
      dependentTicketId: "TKT-001",
      rationale:
        "The top-level deliverable requires an evidence-backed outcome.",
    },
  ],
  currentCapabilityProjections: [],
  traceRecords: [],
} satisfies TicketReviewProjectionSourceV0;
