import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as publicCore from "../src/index.js";
import {
  GIT_TICKET_STORE_RELATIVE_PATH,
  GIT_TICKET_STORE_SCHEMA_VERSION,
  GitFacade,
  GitTicketReviewProjectionSourceProviderV0,
  GitTicketStoreErrorV0,
  gitTicketRevisionRelativePathV0,
  serializeGitTicketStoreDocumentV0,
  ticketReviewProjectionSourceV0Schema,
  type GitTicketDefinitionRevisionV0,
  type TicketReviewRepositoryScopeV0,
} from "../src/index.js";
import {
  GitTicketGenerationPublisherV0,
  gitTicketRepositoryIncarnationV0,
  prepareGitTicketGenerationV0,
  type GitTicketAuthoringScopeV0,
  type GitTicketFencedGenerationPublishRequestV0,
} from "../src/git-ticket-store.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

const CREATED_AT = "2026-07-28T12:00:00.000Z";
const STORE_ID = "ticket-store-0123456789abcdef0123456789abcdef";

function definition(input: {
  id: string;
  revision?: number;
  outcome?: string;
  parentId?: string | null;
  dependsOn?: string[];
  creator?: string;
}): GitTicketDefinitionRevisionV0 {
  return {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_definition_revision",
    ticketId: input.id,
    definitionRevision: input.revision ?? 1,
    created: {
      at: CREATED_AT,
      by: input.creator ?? "agent:planner",
      reason: "Prepared by the Ticket shaping intelligence",
      source: { kind: "plan", ref: "plan:publisher-test" },
    },
    outcome: input.outcome ?? `Deliver ${input.id}`,
    parentId: input.parentId ?? null,
    dependsOn: (input.dependsOn ?? []).slice().sort().map((ticketId) => ({
      ticketId,
    })),
    provenanceRefs: ["test:git-ticket-publisher"],
  };
}

function scopeFor(
  worktreeRoot: string,
  repoId = 1,
): TicketReviewRepositoryScopeV0 {
  const session = GitFacade.sessionContextAt(worktreeRoot);
  return {
    repoId,
    repositoryRoot: fs.realpathSync(session.repoRoot),
    worktreeRoot: fs.realpathSync(session.toplevel),
  };
}

function authoringScopeFor(
  worktreeRoot: string,
  repoId = 1,
): GitTicketAuthoringScopeV0 {
  const scope = scopeFor(worktreeRoot, repoId);
  return {
    ...scope,
    repositoryIncarnation: gitTicketRepositoryIncarnationV0(
      scope.repositoryRoot,
    ),
  };
}

function writerLockRoot(worktreeRoot: string): string {
  return GitFacade.gitPathAt(
    worktreeRoot,
    "vibehub/ticket-publisher-v1/lock",
  );
}

function writerLockOwnerPath(worktreeRoot: string): string {
  const root = writerLockRoot(worktreeRoot);
  const entries = fs.readdirSync(root);
  if (entries.length !== 1) {
    throw new Error("expected one Ticket writer-lock owner");
  }
  return path.join(root, entries[0]!);
}

function readWriterLock(worktreeRoot: string): string {
  return fs.readFileSync(writerLockOwnerPath(worktreeRoot), "utf8");
}

function fencedRequest(
  definitions: GitTicketDefinitionRevisionV0[],
  expectedSnapshotId: string | null,
  input: {
    applicationIntentId?: string;
    intentDigest?: string;
    storeId?: string;
  } = {},
): GitTicketFencedGenerationPublishRequestV0 {
  const bootstrapStoreId = input.storeId ?? STORE_ID;
  const prepared = prepareGitTicketGenerationV0(
    bootstrapStoreId,
    definitions,
  );
  return {
    expectedSnapshotId,
    definitions,
    bootstrapStoreId,
    fence: {
      applicationIntentId: input.applicationIntentId
        ?? "ticket-application-intent:test-001",
      intentDigest: input.intentDigest ?? "a".repeat(64),
      candidateSnapshotId: prepared.generation.snapshotId,
    },
  };
}

describe("Git Ticket outline generation preparation", () => {
  it("keeps the authority-neutral publisher outside the package root", () => {
    expect(publicCore).not.toHaveProperty("GitTicketGenerationPublisherV0");
    expect(publicCore).not.toHaveProperty("prepareGitTicketGenerationV0");
    expect(publicCore).not.toHaveProperty(
      "loadCurrentGitTicketAuthoringBaseV0",
    );
    expect(publicCore).not.toHaveProperty(
      "validateGitTicketRevisionTransitionV0",
    );
    expect(publicCore).not.toHaveProperty(
      "gitTicketRepositoryIncarnationV0",
    );
    expect(publicCore).not.toHaveProperty("TicketProposalServiceV0");
    expect(publicCore).not.toHaveProperty(
      "GitTicketFencedPublicationSessionV0",
    );
  });

  it("compiles one deterministic canonical generation without filesystem state", () => {
    const definitions = [
      definition({
        id: "TKT-002",
        parentId: "TKT-001",
        dependsOn: ["TKT-001"],
      }),
      definition({ id: "TKT-001" }),
    ];
    const prepared = prepareGitTicketGenerationV0(STORE_ID, definitions);
    const reordered = prepareGitTicketGenerationV0(
      STORE_ID,
      definitions.slice().reverse(),
    );

    expect(prepared.definitions.map((item) => item.ticketId)).toEqual([
      "TKT-001",
      "TKT-002",
    ]);
    expect(reordered.generation).toEqual(prepared.generation);
    expect(prepared.generationBytes).toBe(
      serializeGitTicketStoreDocumentV0(prepared.generation),
    );
    expect(prepared.latest.snapshotId).toBe(prepared.generation.snapshotId);
    expect(prepared.relationCount).toBe(1);
  });

  it("rejects an invalid graph before producing a prepared bundle", () => {
    expect(() => prepareGitTicketGenerationV0(STORE_ID, [
      definition({ id: "TKT-001", dependsOn: ["TKT-002"] }),
      definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
    ])).toThrowError(expect.objectContaining({
      code: "ticket_store_publish_invalid",
    }));
  });
});

describe("GitTicketGenerationPublisherV0", () => {
  const repos: ScratchRepo[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    repos.splice(0).forEach((repo) => repo.cleanup());
  });

  const make = (): ScratchRepo => {
    const repo = makeScratchRepo();
    repos.push(repo);
    return repo;
  };

  it("atomically bootstraps a complete store and fresh readers reconstruct it", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const provider = new GitTicketReviewProjectionSourceProviderV0();
    const storeRoot = path.join(repo.work, GIT_TICKET_STORE_RELATIVE_PATH);
    const originalRename = fs.renameSync;
    let observedBefore = false;
    let observedAfter = false;
    vi.spyOn(fs, "renameSync").mockImplementation(((source, target) => {
      if (String(target) === storeRoot) {
        expect(provider.loadLatest(scope)).toEqual({
          status: "no_ticket_graph",
        });
        observedBefore = true;
        originalRename(source, target);
        expect(provider.loadLatest(scope)).toMatchObject({
          status: "available",
          source: {
            ticketDefinitions: [
              { ticketId: "TKT-001" },
              { ticketId: "TKT-002" },
            ],
          },
        });
        observedAfter = true;
        return;
      }
      originalRename(source, target);
    }) as typeof fs.renameSync);

    const published = new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions: [
        definition({ id: "TKT-001" }),
        definition({
          id: "TKT-002",
          parentId: "TKT-001",
          dependsOn: ["TKT-001"],
        }),
      ],
    });

    expect(published).toMatchObject({
      status: "published",
      previousSnapshotId: null,
      ticketCount: 2,
      directUnlockCount: 1,
    });
    expect(observedBefore).toBe(true);
    expect(observedAfter).toBe(true);
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(false);
    expect(new GitTicketReviewProjectionSourceProviderV0()
      .loadSnapshot(scope, published.snapshotId)).toMatchObject({
      status: "available",
    });
  });

  it("bootstraps deterministically and retains the exact fence until release", () => {
    const repo = make();
    const scope = authoringScopeFor(repo.work);
    const definitions = [
      definition({ id: "TKT-001" }),
      definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
    ];
    const request = fencedRequest(definitions, null);
    const lockRoot = writerLockRoot(repo.work);
    const session = new GitTicketGenerationPublisherV0()
      .publishFenced(scope, request);

    expect(session.result).toEqual({
      status: "published",
      previousSnapshotId: null,
      snapshotId: request.fence.candidateSnapshotId,
      ticketCount: 2,
      directUnlockCount: 1,
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(
        repo.work,
        GIT_TICKET_STORE_RELATIVE_PATH,
        "protocol.yaml",
      ),
      "utf8",
    ))).toMatchObject({ storeId: STORE_ID });
    expect(JSON.parse(readWriterLock(repo.work))).toMatchObject({
      fence: request.fence,
    });
    expect(writerLockRoot(repo.work).startsWith(
      `${GitFacade.gitPathAt(repo.work, ".")}${path.sep}`,
    )).toBe(true);
    expect(git(repo.work, "status", "--short", "--untracked-files=all"))
      .not.toContain("ticket-publisher");
    expect(() => new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: request.fence.candidateSnapshotId,
      definitions,
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_writer_busy",
    }));

    session.release();
    session.release();
    expect(fs.existsSync(lockRoot)).toBe(false);
  });

  it("isolates operational writer locks between linked worktrees", () => {
    const repo = make();
    const linked = path.join(repo.root, "ticket-linked");
    git(repo.work, "worktree", "add", "-b", "ticket-linked", linked);
    const publisher = new GitTicketGenerationPublisherV0();
    const mainRequest = fencedRequest(
      [definition({ id: "TKT-001" })],
      null,
      { applicationIntentId: "ticket-application-intent:main-worktree" },
    );
    const linkedRequest = fencedRequest(
      [definition({ id: "TKT-001" })],
      null,
      { applicationIntentId: "ticket-application-intent:linked-worktree" },
    );

    const mainSession = publisher.publishFenced(
      authoringScopeFor(repo.work),
      mainRequest,
    );
    const linkedSession = publisher.publishFenced(
      authoringScopeFor(linked),
      linkedRequest,
    );

    expect(writerLockRoot(repo.work)).not.toBe(writerLockRoot(linked));
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(true);
    expect(fs.existsSync(writerLockRoot(linked))).toBe(true);
    expect(mainSession.release()).toBe(true);
    expect(linkedSession.release()).toBe(true);
  });

  it("ignores a partial staged lock left by a crashed acquirer", () => {
    const repo = make();
    const partialStage = GitFacade.gitPathAt(
      repo.work,
      `vibehub/ticket-publisher-v1/.lock-stage-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(partialStage, { recursive: true });
    fs.writeFileSync(path.join(partialStage, "partial"), "truncated");

    const published = new GitTicketGenerationPublisherV0().publish(
      scopeFor(repo.work),
      {
        expectedSnapshotId: null,
        definitions: [definition({ id: "TKT-001" })],
      },
    );

    expect(published.status).toBe("published");
    expect(fs.existsSync(partialStage)).toBe(true);
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(false);
  });

  it("adopts an exact fence and reconciles when its candidate is current", () => {
    const repo = make();
    const scope = authoringScopeFor(repo.work);
    const request = fencedRequest(
      [definition({ id: "TKT-001" })],
      null,
    );
    const publisher = new GitTicketGenerationPublisherV0();
    const firstSession = publisher.publishFenced(scope, request);
    const lockRoot = writerLockRoot(repo.work);
    const retainedLock = readWriterLock(repo.work);

    const recoveredSession = publisher.publishFenced(scope, request);
    expect(recoveredSession.result).toEqual({
      status: "reconciled",
      previousSnapshotId: null,
      snapshotId: request.fence.candidateSnapshotId,
      ticketCount: 1,
      directUnlockCount: 0,
    });
    expect(readWriterLock(repo.work)).toBe(retainedLock);

    recoveredSession.release();
    firstSession.release();
    expect(fs.existsSync(lockRoot)).toBe(false);

    const receiptRecoverySession = publisher.publishFenced(scope, request);
    expect(receiptRecoverySession.result.status).toBe("reconciled");
    expect(fs.existsSync(lockRoot)).toBe(true);
    receiptRecoverySession.release();
  });

  it("cannot let an old releaser remove a successor writer lock", () => {
    const repo = make();
    const scope = authoringScopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const firstRequest = fencedRequest(
      [definition({ id: "TKT-001" })],
      null,
      { applicationIntentId: "ticket-application-intent:release-race-a" },
    );
    const firstSession = publisher.publishFenced(scope, firstRequest);
    const firstOwnerPath = writerLockOwnerPath(repo.work);
    const firstReleasingPath = path.join(
      path.dirname(firstOwnerPath),
      path.basename(firstOwnerPath).replace(/^owner-/u, "releasing-"),
    );
    const successorRequest = fencedRequest(
      [
        definition({ id: "TKT-001" }),
        definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
      ],
      firstSession.result.snapshotId,
      { applicationIntentId: "ticket-application-intent:release-race-b" },
    );
    const originalUnlink = fs.unlinkSync;
    let successorSession:
      | ReturnType<GitTicketGenerationPublisherV0["publishFenced"]>
      | undefined;
    vi.spyOn(fs, "unlinkSync").mockImplementation(((target) => {
      originalUnlink(target);
      if (
        String(target) === firstReleasingPath
        && successorSession === undefined
      ) {
        successorSession = publisher.publishFenced(scope, successorRequest);
      }
    }) as typeof fs.unlinkSync);

    expect(firstSession.release()).toBe(true);
    expect(successorSession?.result).toMatchObject({
      status: "published",
      snapshotId: successorRequest.fence.candidateSnapshotId,
    });
    expect(JSON.parse(readWriterLock(repo.work))).toMatchObject({
      fence: successorRequest.fence,
    });

    vi.restoreAllMocks();
    expect(successorSession?.release()).toBe(true);
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(false);
  });

  it("does not release an exact completed fence over a different head", () => {
    const repo = make();
    const scope = authoringScopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const baseRequest = fencedRequest(
      [definition({ id: "TKT-001" })],
      null,
      { applicationIntentId: "ticket-application-intent:cleanup-base" },
    );
    const baseSession = publisher.publishFenced(scope, baseRequest);
    baseSession.release();
    const candidateRequest = fencedRequest(
      [
        definition({ id: "TKT-001" }),
        definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
      ],
      baseSession.result.snapshotId,
      { applicationIntentId: "ticket-application-intent:cleanup-candidate" },
    );
    publisher.publishFenced(scope, candidateRequest);
    const latestPath = path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
      "latest.yaml",
    );
    fs.writeFileSync(
      latestPath,
      serializeGitTicketStoreDocumentV0({
        schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
        kind: "ticket_latest",
        storeId: STORE_ID,
        snapshotId: baseSession.result.snapshotId,
      }),
    );

    expect(publisher.releaseCompletedFence(
      scope,
      candidateRequest.fence,
    )).toBe(false);
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(true);

    fs.writeFileSync(
      latestPath,
      serializeGitTicketStoreDocumentV0({
        schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
        kind: "ticket_latest",
        storeId: STORE_ID,
        snapshotId: candidateRequest.fence.candidateSnapshotId,
      }),
    );
    expect(publisher.releaseCompletedFence(
      scope,
      candidateRequest.fence,
    )).toBe(true);
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(false);
  });

  it("adopts an exact fence and resumes when its publication base is current", () => {
    const repo = make();
    const scope = authoringScopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const firstRequest = fencedRequest(
      [definition({ id: "TKT-001" })],
      null,
      { applicationIntentId: "ticket-application-intent:base" },
    );
    const firstSession = publisher.publishFenced(scope, firstRequest);
    firstSession.release();

    const definitions = [
      definition({
        id: "TKT-001",
        revision: 2,
        outcome: "Deliver the recovered exact candidate",
      }),
      definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
    ];
    const request = fencedRequest(
      definitions,
      firstSession.result.snapshotId,
      {
        applicationIntentId: "ticket-application-intent:resume",
        intentDigest: "b".repeat(64),
      },
    );
    const latestPath = path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
      "latest.yaml",
    );
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(((source, target) => {
      if (String(target) === latestPath) {
        throw Object.assign(new Error("injected fenced latest fault"), {
          code: "EIO",
        });
      }
      originalRename(source, target);
    }) as typeof fs.renameSync);

    expect(() => publisher.publishFenced(scope, request)).toThrowError(
      expect.objectContaining({ code: "ticket_store_corrupt" }),
    );
    vi.restoreAllMocks();
    expect(new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [
          { ticketId: "TKT-001", definitionRevision: 1 },
        ],
      },
    });

    const recoveredSession = publisher.publishFenced(scope, request);
    expect(recoveredSession.result).toMatchObject({
      status: "published",
      previousSnapshotId: firstSession.result.snapshotId,
      snapshotId: request.fence.candidateSnapshotId,
    });
    recoveredSession.release();
    expect(new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [
          { ticketId: "TKT-001", definitionRevision: 2 },
          { ticketId: "TKT-002", definitionRevision: 1 },
        ],
      },
    });
  });

  it("never adopts a foreign or malformed fenced writer lock", () => {
    const repo = make();
    const scope = authoringScopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const request = fencedRequest(
      [definition({ id: "TKT-001" })],
      null,
    );
    const ownerSession = publisher.publishFenced(scope, request);
    const lockRoot = writerLockRoot(repo.work);
    const ownerBytes = readWriterLock(repo.work);
    const foreignRequest = {
      ...request,
      fence: {
        ...request.fence,
        applicationIntentId: "ticket-application-intent:foreign",
      },
    };

    expect(() => publisher.publishFenced(
      scope,
      foreignRequest,
    )).toThrowError(expect.objectContaining({
      code: "ticket_store_writer_busy",
    }));
    expect(readWriterLock(repo.work)).toBe(ownerBytes);
    ownerSession.release();

    const malformedToken = crypto.randomUUID();
    fs.mkdirSync(lockRoot);
    const malformedOwner = path.join(
      lockRoot,
      `owner-${malformedToken}.json`,
    );
    fs.writeFileSync(malformedOwner, `${malformedToken}\n`);
    expect(() => publisher.publishFenced(scope, request)).toThrowError(
      expect.objectContaining({ code: "ticket_store_writer_busy" }),
    );
    expect(fs.readFileSync(malformedOwner, "utf8")).toMatch(/\n$/u);
  });

  it("retains its fence when neither the base nor candidate is current", () => {
    const repo = make();
    const scope = authoringScopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const baseRequest = fencedRequest(
      [definition({ id: "TKT-001" })],
      null,
      { applicationIntentId: "ticket-application-intent:stale-base" },
    );
    const baseSession = publisher.publishFenced(scope, baseRequest);
    baseSession.release();
    const competing = publisher.publish(scope, {
      expectedSnapshotId: baseSession.result.snapshotId,
      definitions: [
        definition({
          id: "TKT-001",
          revision: 2,
          outcome: "A different already-published graph",
        }),
      ],
    });
    const staleRequest = fencedRequest(
      [
        definition({ id: "TKT-001" }),
        definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
      ],
      baseSession.result.snapshotId,
      {
        applicationIntentId: "ticket-application-intent:stale-candidate",
        intentDigest: "c".repeat(64),
      },
    );
    const lockRoot = writerLockRoot(repo.work);

    expect(() => publisher.publishFenced(scope, staleRequest)).toThrowError(
      expect.objectContaining({
        code: "ticket_store_cas_conflict",
        details: {
          expectedSnapshotId: baseSession.result.snapshotId,
          actualSnapshotId: competing.snapshotId,
          candidateSnapshotId: staleRequest.fence.candidateSnapshotId,
        },
      }),
    );
    expect(JSON.parse(readWriterLock(repo.work))).toMatchObject({
      fence: staleRequest.fence,
    });
  });

  it("reports bootstrap uncertainty after the complete store becomes visible", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const storeRoot = path.join(repo.work, GIT_TICKET_STORE_RELATIVE_PATH);
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let storeRenamed = false;
    vi.spyOn(fs, "renameSync").mockImplementation(((source, target) => {
      originalRename(source, target);
      if (String(target) === storeRoot) storeRenamed = true;
    }) as typeof fs.renameSync);
    vi.spyOn(fs, "fsyncSync").mockImplementation(((descriptor) => {
      if (storeRenamed && fs.fstatSync(descriptor).isDirectory()) {
        throw Object.assign(new Error("injected bootstrap parent sync fault"), {
          code: "EIO",
        });
      }
      originalFsync(descriptor);
    }) as typeof fs.fsyncSync);

    let failure: unknown;
    try {
      publisher.publish(scope, {
        expectedSnapshotId: null,
        definitions: [definition({ id: "TKT-001" })],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "ticket_store_commit_uncertain",
      details: {
        previousSnapshotId: null,
      },
    });
    vi.restoreAllMocks();

    expect(new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [{ ticketId: "TKT-001" }],
      },
    });
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(true);
  });

  it("publishes a monotonic second generation and retains the first", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const firstDefinitions = [definition({ id: "TKT-001" })];
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions: firstDefinitions,
    });
    const second = publisher.publish(scope, {
      expectedSnapshotId: first.snapshotId,
      definitions: [
        definition({
          id: "TKT-001",
          revision: 2,
          outcome: "Deliver the refined stable TKT-001 promise",
        }),
        definition({
          id: "TKT-002",
          parentId: "TKT-001",
          dependsOn: ["TKT-001"],
        }),
      ],
    });

    expect(second).toMatchObject({
      status: "published",
      previousSnapshotId: first.snapshotId,
      ticketCount: 2,
    });
    const provider = new GitTicketReviewProjectionSourceProviderV0();
    expect(provider.loadSnapshot(scope, first.snapshotId)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [
          { ticketId: "TKT-001", definitionRevision: 1 },
        ],
      },
    });
    expect(provider.loadLatest(scope)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [
          { ticketId: "TKT-001", definitionRevision: 2 },
          { ticketId: "TKT-002", definitionRevision: 1 },
        ],
      },
    });
  });

  it("fails stale non-identical publication without moving latest", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions: [definition({ id: "TKT-001" })],
    });
    const secondDefinitions = [
      definition({ id: "TKT-001" }),
      definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
    ];
    const second = publisher.publish(scope, {
      expectedSnapshotId: first.snapshotId,
      definitions: secondDefinitions,
    });

    expect(() => publisher.publish(scope, {
      expectedSnapshotId: first.snapshotId,
      definitions: [
        ...secondDefinitions,
        definition({ id: "TKT-003", dependsOn: ["TKT-002"] }),
      ],
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_cas_conflict",
    }));
    const latest = new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope);
    expect(latest).toMatchObject({ status: "available" });
    expect(latest.status === "available"
      ? ticketReviewProjectionSourceV0Schema.parse(latest.source)
        .ticketDefinitions.map((item) => item.ticketId)
      : []).toEqual(["TKT-001", "TKT-002"]);
    expect(second.snapshotId).not.toBe(first.snapshotId);
  });

  it("converges when the exact candidate is already current", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const definitions = [definition({ id: "TKT-001" })];
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions,
    });
    const replay = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions,
    });

    expect(replay).toEqual({
      status: "unchanged",
      previousSnapshotId: first.snapshotId,
      snapshotId: first.snapshotId,
      ticketCount: 1,
      directUnlockCount: 0,
    });
  });

  it("allows only one winner for two cross-process writers on one head", async () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const first = new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions: [definition({ id: "TKT-001" })],
    });
    const gate = path.join(repo.root, "publisher-gate");
    const readyA = path.join(repo.root, "publisher-ready-a");
    const readyB = path.join(repo.root, "publisher-ready-b");
    const worker = new URL(
      "./fixtures/ticket-publish-worker.mjs",
      import.meta.url,
    );
    const runWorker = (
      outcome: string,
      ready: string,
    ): Promise<{ ok: boolean; result?: { snapshotId: string }; error?: {
      code: string;
    } }> => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        worker.pathname,
        repo.work,
        first.snapshotId,
        outcome,
        ready,
        gate,
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) {
          reject(new Error(`publisher worker exited ${code}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout));
      });
    });
    const workerA = runWorker("Winner candidate A", readyA);
    const workerB = runWorker("Winner candidate B", readyB);
    await waitForPaths([readyA, readyB]);
    fs.writeFileSync(gate, "go\n");
    const results = await Promise.all([workerA, workerB]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)?.error?.code).toMatch(
      /ticket_store_(?:writer_busy|cas_conflict)/u,
    );
    const latest = new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope);
    expect(latest).toMatchObject({ status: "available" });
    expect(latest.status === "available"
      ? ticketReviewProjectionSourceV0Schema.parse(latest.source)
        .ticketDefinitions[0]?.outcome
      : null).toMatch(/^Winner candidate [AB]$/u);
    expect(new GitTicketReviewProjectionSourceProviderV0()
      .loadSnapshot(scope, first.snapshotId)).toMatchObject({
      status: "available",
    });
  });

  it("rejects invalid candidates before a canonical store appears", () => {
    const repo = make();
    const scope = scopeFor(repo.work);

    expect(() => new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions: [
        definition({ id: "TKT-001", parentId: "TKT-002" }),
        definition({ id: "TKT-002", parentId: "TKT-001" }),
      ],
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_publish_invalid",
    }));
    expect(fs.existsSync(
      path.join(repo.work, GIT_TICKET_STORE_RELATIVE_PATH),
    )).toBe(false);
  });

  it("enforces monotonic revisions, immutable creation, and no omission", () => {
    const cases: GitTicketDefinitionRevisionV0[][] = [
      [],
      [definition({ id: "TKT-001", revision: 2 })],
      [definition({
        id: "TKT-001",
        outcome: "Changed without advancing the revision",
      })],
      [definition({
        id: "TKT-001",
        revision: 2,
      })],
      [definition({
        id: "TKT-001",
        revision: 2,
        outcome: "Changed with rewritten creation provenance",
        creator: "agent:other",
      })],
    ];
    for (const candidate of cases) {
      const repo = make();
      const scope = scopeFor(repo.work);
      const publisher = new GitTicketGenerationPublisherV0();
      const first = publisher.publish(scope, {
        expectedSnapshotId: null,
        definitions: [definition({ id: "TKT-001" })],
      });
      expect(() => publisher.publish(scope, {
        expectedSnapshotId: first.snapshotId,
        definitions: candidate,
      })).toThrowError(GitTicketStoreErrorV0);
    }
  });

  it("rejects a different document already occupying an immutable revision", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions: [definition({ id: "TKT-001" })],
    });
    const occupied = definition({
      id: "TKT-001",
      revision: 2,
      outcome: "An orphaned incompatible revision",
    });
    const occupiedPath = path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
      gitTicketRevisionRelativePathV0("TKT-001", 2),
    );
    fs.mkdirSync(path.dirname(occupiedPath), { recursive: true });
    fs.writeFileSync(
      occupiedPath,
      serializeGitTicketStoreDocumentV0(occupied),
    );

    expect(() => publisher.publish(scope, {
      expectedSnapshotId: first.snapshotId,
      definitions: [definition({
        id: "TKT-001",
        revision: 2,
        outcome: "The intended compatible refinement",
      })],
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_revision_conflict",
    }));
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(false);
  });

  it("fails closed on an existing writer lock", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const lockRoot = writerLockRoot(repo.work);
    const malformedToken = crypto.randomUUID();
    fs.mkdirSync(lockRoot, { recursive: true });
    const malformedOwner = path.join(
      lockRoot,
      `owner-${malformedToken}.json`,
    );
    fs.writeFileSync(malformedOwner, `${malformedToken}\n`);

    expect(() => new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions: [definition({ id: "TKT-001" })],
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_writer_busy",
    }));
    expect(fs.readFileSync(malformedOwner, "utf8")).toMatch(/\n$/u);
    expect(fs.existsSync(
      path.join(repo.work, GIT_TICKET_STORE_RELATIVE_PATH),
    )).toBe(false);
  });

  it("keeps the old graph readable and fences recovery after a commit fault", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions: [definition({ id: "TKT-001" })],
    });
    const latestPath = path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
      "latest.yaml",
    );
    const originalRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation(((source, target) => {
      if (String(target) === latestPath) {
        throw Object.assign(new Error("injected latest fault"), {
          code: "EIO",
        });
      }
      originalRename(source, target);
    }) as typeof fs.renameSync);

    expect(() => publisher.publish(scope, {
      expectedSnapshotId: first.snapshotId,
      definitions: [
        definition({ id: "TKT-001" }),
        definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
      ],
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_corrupt",
    }));
    vi.restoreAllMocks();

    expect(new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [{ ticketId: "TKT-001" }],
      },
    });
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(true);
    expect(() => publisher.publish(scope, {
      expectedSnapshotId: first.snapshotId,
      definitions: [definition({ id: "TKT-001" })],
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_writer_busy",
    }));
  });

  it("reports commit uncertainty after latest is visible but its sync fails", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const publisher = new GitTicketGenerationPublisherV0();
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions: [definition({ id: "TKT-001" })],
    });
    const latestPath = path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
      "latest.yaml",
    );
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let latestRenamed = false;
    vi.spyOn(fs, "renameSync").mockImplementation(((source, target) => {
      originalRename(source, target);
      if (String(target) === latestPath) latestRenamed = true;
    }) as typeof fs.renameSync);
    vi.spyOn(fs, "fsyncSync").mockImplementation(((descriptor) => {
      if (latestRenamed && fs.fstatSync(descriptor).isDirectory()) {
        throw Object.assign(new Error("injected post-rename sync fault"), {
          code: "EIO",
        });
      }
      originalFsync(descriptor);
    }) as typeof fs.fsyncSync);

    let failure: unknown;
    try {
      publisher.publish(scope, {
        expectedSnapshotId: first.snapshotId,
        definitions: [
          definition({ id: "TKT-001" }),
          definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
        ],
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "ticket_store_commit_uncertain",
      details: {
        previousSnapshotId: first.snapshotId,
      },
    });
    vi.restoreAllMocks();

    expect(new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [
          { ticketId: "TKT-001" },
          { ticketId: "TKT-002" },
        ],
      },
    });
    expect(fs.existsSync(writerLockRoot(repo.work))).toBe(true);
  });

  it("does not follow a symlinked control directory outside the worktree", () => {
    const repo = make();
    const scope = scopeFor(repo.work);
    const outside = path.join(repo.root, "outside");
    fs.mkdirSync(outside);
    const sentinel = path.join(outside, "sentinel");
    fs.writeFileSync(sentinel, "unchanged\n");
    fs.symlinkSync(outside, path.join(repo.work, ".vibehub"));

    expect(() => new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions: [definition({ id: "TKT-001" })],
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_corrupt",
    }));
    expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged\n");
    expect(fs.readdirSync(outside)).toEqual(["sentinel"]);
  });
});

async function waitForPaths(paths: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!paths.every((target) => fs.existsSync(target))) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${paths.join(", ")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
