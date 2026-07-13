import {
  applyDistillation,
  markSpecStale,
  readTask,
  recordSpec,
  replaceScopePatterns,
  retrieveKnowledge,
  saveTaskReport,
  type Db,
  type DistillationManifest,
  type SpecType,
} from "@vibehub/core";

export interface CapabilityContext {
  db: Db;
  repoId: number;
  taskId: string;
  now?: () => string;
}

export function createCapabilities(ctx: CapabilityContext) {
  const now = (): string => ctx.now?.() ?? new Date().toISOString();
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

    kbRetrieve(input: { query?: string; paths?: string[]; limit?: number }) {
      return retrieveKnowledge(ctx.db, ctx.repoId, input);
    },

    kbRecord(input: {
      type?: SpecType;
      summary?: string;
      detail?: string;
      featureId?: string;
      supersedes?: string;
      marksStale?: string;
    }) {
      requireTask();
      if (input.marksStale) {
        if (input.type || input.summary || input.supersedes) {
          throw new Error("marksStale is a standalone operation");
        }
        markSpecStale(ctx.db, input.marksStale, now());
        return { markedStale: input.marksStale };
      }
      if (!input.type || !input.summary) {
        throw new Error("type and summary are required when recording a fact");
      }
      return recordSpec(ctx.db, ctx.repoId, {
        type: input.type,
        summary: input.summary,
        detail: input.detail ?? null,
        ...(input.featureId ? { featureId: input.featureId } : {}),
        ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      }, now());
    },

    kbApplyDistillation(manifest: DistillationManifest): { applied: true } {
      applyDistillation(ctx.db, ctx.repoId, manifest, now());
      return { applied: true };
    },

    getManual(_input: { topic?: string } = {}) {
      return {
        text:
          "Vibehub keeps team context local. Hooks trigger at the right time; " +
          "skills own semantic workflow; MCP capabilities validate and persist mechanical facts. " +
          "Use vibehub-query for context pulls, vibehub-ingest for discussions, and " +
          "vibehub-distill for first-run repository mapping.",
      };
    },
  };
}
