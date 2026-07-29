import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GIT_TICKET_STORE_FORMAT,
  GIT_TICKET_STORE_RELATIVE_PATH,
  GIT_TICKET_STORE_SCHEMA_VERSION,
  GitFacade,
  GitTicketReviewProjectionSourceProviderV0,
  GitTicketStoreErrorV0,
  TicketReviewReadServiceV0,
  deriveTicketReviewSnapshotIdV0,
  gitTicketGenerationDigestV0,
  gitTicketGenerationRelativePathV0,
  gitTicketRevisionRelativePathV0,
  serializeGitTicketStoreDocumentV0,
  type GitTicketDefinitionRevisionV0,
  type TicketReviewProjectionSourceV0,
  type TicketReviewRepositoryScopeV0,
} from "../src/index.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

const STORE_ID = "ticket-store-0123456789abcdef0123456789abcdef";
const CREATED_AT = "2026-07-28T12:00:00.000Z";

function hash(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function definition(input: {
  id: string;
  revision?: number;
  outcome?: string;
  parentId?: string | null;
  dependsOn?: string[];
}): GitTicketDefinitionRevisionV0 {
  return {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_definition_revision",
    ticketId: input.id,
    definitionRevision: input.revision ?? 1,
    created: {
      at: CREATED_AT,
      by: "agent:planner",
      reason: "Decomposed from the accepted project outcome",
      source: { kind: "plan", ref: "plan:fixture" },
    },
    outcome: input.outcome ?? `Deliver ${input.id}`,
    parentId: input.parentId ?? null,
    dependsOn: (input.dependsOn ?? []).sort().map((ticketId) => ({
      ticketId,
    })),
    provenanceRefs: ["fixture:ticket-store"],
  };
}

function sourceFor(
  storeId: string,
  generationDigest: string,
  definitions: GitTicketDefinitionRevisionV0[],
): TicketReviewProjectionSourceV0 {
  const snapshotRevision = [
    "ticket-generation",
    storeId,
    generationDigest,
  ].join(":");
  return {
    schemaVersion: 1,
    snapshotRevision,
    projectionWatermark: snapshotRevision,
    ticketDefinitions: definitions.map((item) => ({
      ticketId: item.ticketId,
      definitionRevision: item.definitionRevision,
      outcome: item.outcome,
      provenanceRefs: [
        `ticket-definition:${item.ticketId}:revision:${item.definitionRevision}`,
        ...item.provenanceRefs,
      ],
    })),
    directUnlocks: definitions.flatMap((item) =>
      item.dependsOn.map((dependency) => ({
        relationRef: `tur-${hash(serializeGitTicketStoreDocumentV0({
          snapshotRevision,
          prerequisiteTicketId: dependency.ticketId,
          dependentTicketId: item.ticketId,
        }))}`,
        prerequisiteTicketId: dependency.ticketId,
        dependentTicketId: item.ticketId,
        provenanceRefs: [
          `ticket-definition:${item.ticketId}:revision:${item.definitionRevision}`,
        ],
      }))),
    currentCapabilityProjections: [],
    traceRecords: [],
  };
}

function writeCanonical(target: string, value: unknown): string {
  const bytes = serializeGitTicketStoreDocumentV0(value);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return bytes;
}

function publish(
  repo: string,
  rawDefinitions: GitTicketDefinitionRevisionV0[],
  storeId = STORE_ID,
  allowInvalidGraph = false,
): { snapshotId: string; source: TicketReviewProjectionSourceV0 } {
  const store = path.join(repo, GIT_TICKET_STORE_RELATIVE_PATH);
  const protocol = {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    format: GIT_TICKET_STORE_FORMAT,
    storeId,
    indexing: "stable-ticket-revision-paths",
    integrity: "immutable-generations-pointer-v1",
    projector: "ticket-review-v0",
  };
  const protocolPath = path.join(store, "protocol.yaml");
  if (!fs.existsSync(protocolPath)) writeCanonical(protocolPath, protocol);

  const definitions = rawDefinitions.slice()
    .sort((left, right) => left.ticketId.localeCompare(right.ticketId));
  const entries = definitions.map((item) => {
    const file = gitTicketRevisionRelativePathV0(
      item.ticketId,
      item.definitionRevision,
    );
    const absolute = path.join(store, file);
    const bytes = serializeGitTicketStoreDocumentV0(item);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    if (fs.existsSync(absolute)) {
      expect(fs.readFileSync(absolute, "utf8")).toBe(bytes);
    } else {
      fs.writeFileSync(absolute, bytes, { flag: "wx" });
    }
    return {
      ticketId: item.ticketId,
      definitionRevision: item.definitionRevision,
      file,
      sha256: hash(bytes),
    };
  });
  const generationDigest = gitTicketGenerationDigestV0(storeId, entries);
  const source = sourceFor(storeId, generationDigest, definitions);
  const snapshotId = allowInvalidGraph
    ? `tgs-${hash(serializeGitTicketStoreDocumentV0({
      invalidFixture: generationDigest,
    }))}`
    : deriveTicketReviewSnapshotIdV0(source);
  const generation = {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_generation",
    storeId,
    snapshotId,
    generationDigest,
    tickets: entries,
  };
  const generationPath = path.join(
    store,
    gitTicketGenerationRelativePathV0(snapshotId),
  );
  if (!fs.existsSync(generationPath)) {
    writeCanonical(generationPath, generation);
  }
  const latestPath = path.join(store, "latest.yaml");
  const stagedLatest = path.join(store, `.latest-${crypto.randomUUID()}.tmp`);
  writeCanonical(stagedLatest, {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_latest",
    storeId,
    snapshotId,
  });
  fs.renameSync(stagedLatest, latestPath);
  return { snapshotId, source };
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

describe("GitTicketReviewProjectionSourceProviderV0", () => {
  const repos: ScratchRepo[] = [];
  const extraRoots: string[] = [];
  afterEach(() => {
    extraRoots.splice(0).forEach((root) =>
      fs.rmSync(root, { recursive: true, force: true }));
    repos.splice(0).forEach((repo) => repo.cleanup());
  });

  const make = (): ScratchRepo => {
    const repo = makeScratchRepo();
    repos.push(repo);
    return repo;
  };

  it("retains exact generations across provider instances after latest changes", () => {
    const repo = make();
    const firstPublished = publish(repo.work, [
      definition({ id: "TKT-001" }),
      definition({
        id: "TKT-002",
        parentId: "TKT-001",
        dependsOn: ["TKT-001"],
      }),
    ]);
    const scope = scopeFor(repo.work);
    const firstService = new TicketReviewReadServiceV0(
      new GitTicketReviewProjectionSourceProviderV0(),
    );
    const firstPage = firstService.graphSnapshot(scope, { pageSize: 1 });
    expect(firstPage).toMatchObject({
      snapshotId: firstPublished.snapshotId,
      summary: { ticketCount: 2, directUnlockCount: 1 },
      page: { offset: 0, count: 1, totalItems: 3 },
    });
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPublished = publish(repo.work, [
      definition({ id: "TKT-001" }),
      definition({
        id: "TKT-002",
        revision: 2,
        outcome: "Deliver the refined second outcome",
        parentId: "TKT-001",
        dependsOn: ["TKT-001"],
      }),
      definition({
        id: "TKT-003",
        parentId: "TKT-001",
        dependsOn: ["TKT-002"],
      }),
    ]);
    expect(secondPublished.snapshotId).not.toBe(firstPublished.snapshotId);

    const freshService = new TicketReviewReadServiceV0(
      new GitTicketReviewProjectionSourceProviderV0(),
    );
    const oldSecondPage = freshService.graphSnapshot(scope, {
      pageSize: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(oldSecondPage).toMatchObject({
      snapshotId: firstPublished.snapshotId,
      page: { offset: 1, count: 1, totalItems: 3 },
    });
    const oldInspection = freshService.subjectInspect(scope, {
      snapshotId: firstPublished.snapshotId,
      subject: { kind: "ticket", ticketId: "TKT-002" },
    });
    expect(oldInspection.subject).toMatchObject({
      kind: "ticket",
      ticket: { ticketId: "TKT-002", definitionRevision: 1 },
    });
    expect(freshService.graphSnapshot(scope)).toMatchObject({
      snapshotId: secondPublished.snapshotId,
      summary: { ticketCount: 3, directUnlockCount: 2 },
    });
  });

  it("reconstructs an older retained generation in a fresh Node process", () => {
    const repo = make();
    const first = publish(repo.work, [
      definition({ id: "TKT-001" }),
    ]);
    publish(repo.work, [
      definition({ id: "TKT-001" }),
      definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
    ]);
    const worker = new URL(
      "./fixtures/ticket-snapshot-worker.mjs",
      import.meta.url,
    );
    const output = execFileSync(
      process.execPath,
      [worker.pathname, repo.work, first.snapshotId],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [{ ticketId: "TKT-001" }],
        directUnlocks: [],
      },
    });
  });

  it("reads the old complete pointer when latest is atomically replaced", () => {
    const repo = make();
    const first = publish(repo.work, [
      definition({ id: "TKT-001" }),
    ]);
    const store = path.join(repo.work, GIT_TICKET_STORE_RELATIVE_PATH);
    const latestPath = path.join(store, "latest.yaml");
    const firstPointer = fs.readFileSync(latestPath, "utf8");
    const second = publish(repo.work, [
      definition({ id: "TKT-001" }),
      definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
    ]);
    const secondPointer = fs.readFileSync(latestPath, "utf8");
    fs.writeFileSync(latestPath, firstPointer);
    const replacement = path.join(store, "latest.next.yaml");
    fs.writeFileSync(replacement, secondPointer);

    const originalFstat = fs.fstatSync;
    let fstatCalls = 0;
    vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor: number) => {
      fstatCalls += 1;
      if (fstatCalls === 2) fs.renameSync(replacement, latestPath);
      return originalFstat(descriptor);
    }) as typeof fs.fstatSync);
    const loaded = new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scopeFor(repo.work));

    expect(loaded).toMatchObject({
      status: "available",
      source: { ticketDefinitions: [{ ticketId: "TKT-001" }] },
    });
    expect(deriveTicketReviewSnapshotIdV0(
      (loaded as { status: "available"; source: TicketReviewProjectionSourceV0 })
        .source,
    )).toBe(first.snapshotId);
    expect(first.snapshotId).not.toBe(second.snapshotId);
  });

  it("returns honest absent and expired results without a published store", () => {
    const repo = make();
    const provider = new GitTicketReviewProjectionSourceProviderV0();
    const scope = scopeFor(repo.work);
    expect(provider.loadLatest(scope)).toEqual({
      status: "no_ticket_graph",
    });
    expect(provider.loadSnapshot(scope, `tgs-${"a".repeat(64)}`)).toEqual({
      status: "snapshot_expired",
    });
    expect(provider.loadSnapshot(scope, "../../outside")).toEqual({
      status: "snapshot_expired",
    });

    writeCanonical(
      path.join(repo.work, GIT_TICKET_STORE_RELATIVE_PATH, "protocol.yaml"),
      {
        schemaVersion: 1,
        format: GIT_TICKET_STORE_FORMAT,
        storeId: STORE_ID,
        indexing: "stable-ticket-revision-paths",
        integrity: "immutable-generations-pointer-v1",
        projector: "ticket-review-v0",
      },
    );
    expect(provider.loadLatest(scope)).toEqual({
      status: "no_ticket_graph",
    });
  });

  it("partitions exact reads by verified repository and worktree scope", () => {
    const repo = make();
    const published = publish(repo.work, [
      definition({ id: "TKT-001" }),
    ]);
    const linkedRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "vh-ticket-worktree-")),
    );
    extraRoots.push(linkedRoot);
    const linked = path.join(linkedRoot, "linked");
    git(repo.work, "worktree", "add", "-b", "ticket-other", linked);

    const provider = new GitTicketReviewProjectionSourceProviderV0();
    expect(provider.loadSnapshot(
      scopeFor(linked),
      published.snapshotId,
    )).toEqual({ status: "snapshot_expired" });

    const other = make();
    expect(() => provider.loadLatest({
      repoId: 1,
      repositoryRoot: scopeFor(repo.work).repositoryRoot,
      worktreeRoot: other.work,
    })).toThrow(GitTicketStoreErrorV0);
  });

  it("classifies retained corruption instead of disguising it as expiry", () => {
    const repo = make();
    const published = publish(repo.work, [
      definition({ id: "TKT-001" }),
    ]);
    const revisionPath = path.join(
      repo.work,
      GIT_TICKET_STORE_RELATIVE_PATH,
      gitTicketRevisionRelativePathV0("TKT-001", 1),
    );
    fs.appendFileSync(revisionPath, "\n");
    const provider = new GitTicketReviewProjectionSourceProviderV0();

    expect(() => provider.loadSnapshot(
      scopeFor(repo.work),
      published.snapshotId,
    )).toThrowError(expect.objectContaining({
      code: "ticket_store_corrupt",
    }));
  });

  it("rejects symlinked and special store members without following them", () => {
    const repo = make();
    publish(repo.work, [definition({ id: "TKT-001" })]);
    const store = path.join(repo.work, GIT_TICKET_STORE_RELATIVE_PATH);
    const protocol = path.join(store, "protocol.yaml");
    const outside = path.join(repo.root, "outside.yaml");
    fs.writeFileSync(outside, fs.readFileSync(protocol));
    fs.rmSync(protocol);
    fs.symlinkSync(outside, protocol);
    const provider = new GitTicketReviewProjectionSourceProviderV0();

    expect(() => provider.loadLatest(scopeFor(repo.work))).toThrowError(
      expect.objectContaining({ code: "ticket_store_corrupt" }),
    );
  });

  it("rejects missing endpoints and cycles in a published generation", () => {
    const cases = [
      [
        definition({ id: "TKT-001", parentId: "TKT-missing" }),
      ],
      [
        definition({ id: "TKT-001", dependsOn: ["TKT-002"] }),
        definition({ id: "TKT-002", dependsOn: ["TKT-001"] }),
      ],
      [
        definition({ id: "TKT-001", parentId: "TKT-002" }),
        definition({ id: "TKT-002", parentId: "TKT-001" }),
      ],
    ];
    for (const definitions of cases) {
      const repo = make();
      publish(repo.work, definitions, STORE_ID, true);
      expect(() =>
        new GitTicketReviewProjectionSourceProviderV0()
          .loadLatest(scopeFor(repo.work))).toThrowError(
        expect.objectContaining({ code: "ticket_store_corrupt" }),
      );
    }
  });
});
