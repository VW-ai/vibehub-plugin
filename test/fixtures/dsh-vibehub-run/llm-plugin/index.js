import { readFileSync } from "node:fs";

export const name = "vibehub-e2e-replay";
export const inject = ["llm"];

const scriptPath = process.env.DSH_VIBEHUB_REPLAY_FILE;
if (!scriptPath) throw new Error("DSH_VIBEHUB_REPLAY_FILE is required");
const script = JSON.parse(readFileSync(scriptPath, "utf8"));
const paceMs = Number(process.env.DSH_VIBEHUB_REPLAY_PACE_MS ?? 180);

export function apply(ctx) {
  let cursor = 0;
  ctx.on("llm/stream", async function* vibehubReplay(options, next) {
    if (options.purpose) {
      yield* next();
      return;
    }
    const entry = script[cursor++];
    if (!entry || entry.kind !== "chunks") {
      throw new Error(`VibeHub E2E replay exhausted at model call ${cursor}`);
    }
    for (const chunk of entry.chunks) {
      if (paceMs > 0) await new Promise((resolve) => setTimeout(resolve, paceMs));
      yield chunk;
    }
  });
}
