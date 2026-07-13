import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/db.js";
import { appendEvent, upsertTask } from "../src/activity-store.js";
import { readTaskTimeline } from "../src/timeline-read.js";
import { upsertRepo } from "../src/team-store.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

describe("readTaskTimeline commit derivation", () => {
  let repo: ScratchRepo;
  let db: Db;
  let dir: string;

  beforeEach(() => {
    repo = makeScratchRepo();
    git(repo.work, "checkout", "-b", "feat/timeline");
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-timeline-"));
    db = openDb(path.join(dir, "test.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    repo.cleanup();
  });

  it("merges stored hook events with only commits after start_head_sha", () => {
    const now = "2026-07-12T10:00:00.000Z";
    const repoId = upsertRepo(db, repo.work, null, "main", now).id;
    const baseline = git(repo.work, "rev-parse", "HEAD").trim();
    upsertTask(db, {
      id: "branch:feat/timeline", repoId, title: "timeline", state: "running",
      signalTier: "hooks", branch: "feat/timeline", worktreePath: null,
      prNumber: null, prState: null, stateSince: now, lastEventAt: now,
      statusDetail: null, createdAt: now, startHeadSha: baseline,
    });
    appendEvent(db, repoId, "branch:feat/timeline", null, {
      id: "launch-1", at: now, type: "launch", prompt: "Build it",
    });
    repo.write("src/new.ts", "export const value = 1;\n");
    repo.commitAll("feat: add timeline fact");

    const timeline = readTaskTimeline(db, "branch:feat/timeline", repo.work);
    expect(timeline.some((event) => event.id === "launch-1")).toBe(true);
    expect(timeline.filter((event) => event.type === "commit")).toMatchObject([
      { message: "feat: add timeline fact", filesChanged: 1 },
    ]);
    expect(timeline.some((event) => event.type === "commit" && event.message === "initial")).toBe(false);
  });
});
