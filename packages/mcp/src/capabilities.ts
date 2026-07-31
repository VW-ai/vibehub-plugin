import {
  OperationDispatcher,
  operationInputSchemas,
  readTask,
  replaceScopePatterns,
  saveTaskReport,
  type Db,
  type TicketDecisionLocalSignatureTrustProfileResolverV0,
} from "@vw-ai/vibehub-core";
import crypto from "node:crypto";
import { createMcpSessionActor } from "./session-actor.js";

export const TICKET_OPERATION_NAMES = [
  "ticket.graph.snapshot",
  "ticket.subject.inspect",
  "ticket.trace.list",
  "ticket.frontier.read",
  "ticket.context.compile",
  "ticket.run.claim",
  "ticket.run.heartbeat",
  "ticket.run.release",
  "ticket.evidence.append",
  "ticket.closeout.append",
  "ticket.worktree.patch",
  "ticket.review.append",
  "ticket.decision.record",
] as const;
export type TicketOperationName = typeof TICKET_OPERATION_NAMES[number];
const TICKET_OPERATION_NAME_SET = new Set<string>(TICKET_OPERATION_NAMES);
export const KB_OPERATION_NAMES = Object.keys(operationInputSchemas)
  .filter((operation) => operation.startsWith("kb."));
export const DISTILL_OPERATION_NAMES = Object.keys(operationInputSchemas)
  .filter((operation) => operation.startsWith("distill."));

export interface CapabilityContext {
  db: Db;
  repoId: number;
  taskId: string;
  repoRoot?: string;
  actor?: string;
  requestId?: () => string;
  now?: () => string;
  ticketDecisionAttestationTrustProfiles?:
    TicketDecisionLocalSignatureTrustProfileResolverV0;
}

export function createCapabilities(ctx: CapabilityContext) {
  const now = (): string => ctx.now?.() ?? new Date().toISOString();
  // Capture one fallback per capability session. Production injects an actor
  // derived from the MCP connection; direct legacy consumers still get a
  // stable, non-global attribution instead of sharing one global identity.
  const actor = ctx.actor?.trim() || createMcpSessionActor();
  const dispatch=(operation:string,input:Record<string,unknown>,requestId?:string)=>new OperationDispatcher(ctx.db,{
    repoRoot:ctx.repoRoot,
    ticketDecisionAttestationTrustProfiles:
      ctx.ticketDecisionAttestationTrustProfiles,
  }).dispatch(operation,{
    repoId:ctx.repoId,actor,taskId:ctx.taskId,
    requestId:requestId??ctx.requestId?.()??`mcp-${crypto.randomUUID()}`,now:now(),
  },input);
  const requireTask = () => {
    const task = readTask(ctx.db, ctx.taskId);
    if (!task || task.repoId !== ctx.repoId) throw new Error(`missing task: ${ctx.taskId}`);
    return task;
  };

  return {
    registerScope(input: {
      status: string;
      write: Array<{ glob: string; label?: string }>;
      read?: Array<{ glob: string; label?: string }>;
    }): { patterns: number } {
      requireTask();
      if (input.write.length === 0) throw new Error("write scope must not be empty");
      const patterns = [
        ...input.write.map((p) => ({ ...p, mode: "write" as const })),
        ...(input.read ?? []).map((p) => ({ ...p, mode: "read" as const })),
      ];
      replaceScopePatterns(ctx.db, ctx.repoId, ctx.taskId, input.status, patterns);
      return { patterns: patterns.length };
    },

    selfReport(input: { status: string; done?: string }) {
      requireTask();
      const report = saveTaskReport(ctx.db, ctx.taskId, {
        status: input.status,
        done: input.done ?? null,
        reportedAt: now(),
      });
      return { ...report, ...(report.done === null ? {} : { done: report.done }) };
    },

    dispatchOperation(operation:string,input:Record<string,unknown>={},requestId?:string) {
      return dispatchFamily("distill",operation,input,requestId);
    },

    dispatchKnowledge(operation:string,input:Record<string,unknown>={},requestId?:string) {
      return dispatchFamily("kb",operation,input,requestId);
    },

    dispatchTicket(operation:TicketOperationName,input:Record<string,unknown>={},requestId?:string) {
      if(!TICKET_OPERATION_NAME_SET.has(operation)){
        return {
          ok:false as const,
          error:{
            code:"unsupported_operation",
            message:`${operation} does not belong to the ticket operation family`,
            details:{
              operation,
              expectedOperations:[...TICKET_OPERATION_NAMES],
            },
            nextSafeActions:["Choose a registered ticket operation."],
          },
        };
      }
      return dispatch(operation,input,requestId);
    },

    getManual(_input: { topic?: string } = {}) {
      return {
        text:
          "When a checkout contains the canonical Git-native Ticket ledger, its Ticket graph " +
          "is the primary development control plane: use vibehub-ticket-plan to shape a " +
          "deliverable, vibehub-ticket-run to execute one READY Ticket from its compiled " +
          "ContextBinding, and vibehub-ticket-closeout for independent acceptance adjudication. " +
          "VibeHub's local Context Layer remains the governed knowledge infrastructure: use " +
          "vibehub-query for project-wide context gaps, vibehub-ingest for durable cross-Ticket " +
          "semantics, and vibehub-distill for first-run repository mapping. Without a Ticket " +
          "ledger, work context-first. Hooks own timing, skills own semantic workflow, and MCP " +
          "capabilities validate and persist mechanical facts. register_scope and self_report " +
          "are optional coordination tools in both modes.",
      };
    },
  };

  function dispatchFamily(
    family:"kb"|"distill",
    operation:string,
    input:Record<string,unknown>,
    requestId?:string,
  ) {
    if(operation.startsWith(`${family}.`)){
      return dispatch(operation,input,requestId);
    }
    return {
      ok:false as const,
      error:{
        code:"unsupported_operation",
        message:`${operation} does not belong to the ${family} operation family`,
        details:{operation,expectedPrefix:`${family}.`},
        nextSafeActions:[`Choose a registered ${family} operation.`],
      },
    };
  }
}
