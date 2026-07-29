import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_TICKET_STORE_RELATIVE_PATH,
  GIT_TICKET_STORE_SCHEMA_VERSION,
  GitFacade,
  GitTicketReviewProjectionSourceProviderV0,
  openDb,
  upsertRepo,
  type Db,
  type GitTicketDefinitionRevisionV0,
} from "../src/index.js";
import {
  TICKET_PROPOSAL_MAX_OUTPUT_BYTES,
  TICKET_PROPOSAL_VALIDATION_CHECK_CODES,
  type TicketGraphChangeProposalV0,
  type TicketProposalValidationRecordInputV0,
} from "../src/contract/ticket-proposal.js";
import {
  GitTicketGenerationPublisherV0,
} from "../src/git-ticket-store.js";
import {
  TicketProposalServiceV0,
  type TicketProposalRepositoryScopeV0,
} from "../src/ticket-proposal-service.js";
import { git, makeScratchRepo, type ScratchRepo } from "./helpers.js";

const NOW = "2026-07-29T12:00:00.000Z";

function existingDefinition(input: {
  ticketId: string;
  revision?: number;
  outcome?: string;
  parentId?: string | null;
  dependsOn?: string[];
}): GitTicketDefinitionRevisionV0 {
  return {
    schemaVersion: GIT_TICKET_STORE_SCHEMA_VERSION,
    kind: "ticket_definition_revision",
    ticketId: input.ticketId,
    definitionRevision: input.revision ?? 1,
    created: {
      at: "2026-07-28T12:00:00.000Z",
      by: "agent:planner",
      reason: "Accepted outline planning",
      source: { kind: "plan", ref: "plan:ticket-proposal-test" },
    },
    outcome: input.outcome ?? `Deliver ${input.ticketId}`,
    parentId: input.parentId ?? null,
    dependsOn: (input.dependsOn ?? []).slice().sort().map((ticketId) => ({
      ticketId,
    })),
    provenanceRefs: ["fixture:accepted-outline"],
  };
}

function proposalScope(
  repo: ScratchRepo,
  repoId: number,
): TicketProposalRepositoryScopeV0 {
  const session = GitFacade.sessionContextAt(repo.work);
  const repositoryRoot = fs.realpathSync(session.repoRoot);
  const common = fs.statSync(path.join(repositoryRoot, ".git"), {
    bigint: true,
  });
  return {
    repoId,
    repositoryRoot,
    worktreeRoot: fs.realpathSync(session.toplevel),
    repositoryIncarnation: [
      "git-common-dir",
      common.dev.toString(),
      common.ino.toString(),
      common.birthtimeMs.toString(),
    ].join(":"),
  };
}

function validationInput(
  proposal: TicketGraphChangeProposalV0,
  outcome:
    | "passed"
    | "failed"
    | "inconclusive" = "passed",
): TicketProposalValidationRecordInputV0 {
  const checks = TICKET_PROPOSAL_VALIDATION_CHECK_CODES.map(
    (code, index) => ({
      localRef: `check-${index}`,
      code,
      subject: { kind: "proposal" as const },
      outcome: index === 0 ? outcome : "passed" as const,
      summary: `${code}: ${index === 0 ? outcome : "passed"}`,
      evidenceRefs: [`evidence:${code}`],
    }),
  );
  return {
    schemaVersion: 1,
    proposalId: proposal.proposalId,
    expectedProposalDigest: proposal.proposalDigest,
    expectedCandidateDigest: proposal.mechanicalReview.candidateDigest,
    validator: {
      id: "semantic-validator",
      version: "1.0.0",
      artifactDigest: "a".repeat(64),
    },
    policy: {
      id: "proposal-policy",
      version: "1",
      artifactDigest: "b".repeat(64),
    },
    checks,
    findings: outcome === "passed"
      ? []
      : [{
          localRef: "finding-0",
          checkLocalRef: checks[0]!.localRef,
          subject: { kind: "proposal" as const },
          impact: "blocking" as const,
          code: "semantic_gap",
          summary: "The proposal does not establish this check.",
          evidenceRefs: ["evidence:semantic-gap"],
        }],
    indicatedAuthoritySignals: ["risk_policy"],
  };
}

describe("TicketProposalServiceV0", () => {
  const repos: ScratchRepo[] = [];
  const dbs: Db[] = [];
  const dbRoots: string[] = [];

  afterEach(() => {
    dbs.splice(0).forEach((db) => db.close());
    repos.splice(0).forEach((repo) => repo.cleanup());
    dbRoots.splice(0).forEach((root) =>
      fs.rmSync(root, { recursive: true, force: true }));
  });

  const setup = (): {
    repo: ScratchRepo;
    db: Db;
    repoId: number;
    scope: TicketProposalRepositoryScopeV0;
    service: TicketProposalServiceV0;
  } => {
    const repo = makeScratchRepo();
    repos.push(repo);
    const dbRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "vh-ticket-proposal-")),
    );
    dbRoots.push(dbRoot);
    const db = openDb(path.join(dbRoot, "operational.sqlite"));
    dbs.push(db);
    const registered = upsertRepo(db, repo.work, null, "main", NOW);
    return {
      repo,
      db,
      repoId: registered.id,
      scope: proposalScope(repo, registered.id),
      service: new TicketProposalServiceV0(db),
    };
  };

  const context = (requestId: string) => ({
    actor: "agent:ticket-shaper",
    requestId,
    now: NOW,
  });

  it("materializes deterministic bootstrap identities without publishing", () => {
    const { repo, db, scope, service } = setup();
    const proposal = service.submit(scope, context("bootstrap-proposal"), {
      schemaVersion: 1,
      kind: "graph_change",
      observedSnapshotId: null,
      reason: "Shape the first executable outline",
      source: { kind: "plan", ref: "plan:bootstrap" },
      authorAssessment: {
        changeClass: "decomposition",
        authoritySignals: [],
        introducesHumanGate: false,
        rationale: "The accepted outcome needs independently executable work.",
      },
      changes: [{
        op: "create",
        localRef: "root",
        definition: {
          outcome: "Deliver the accepted workflow",
          parent: null,
          dependsOn: [],
        },
      }, {
        op: "create",
        localRef: "implementation",
        definition: {
          outcome: "Implement the accepted workflow",
          parent: { kind: "local", localRef: "root" },
          dependsOn: [{
            target: { kind: "local", localRef: "root" },
            rationale: "The implementation realizes the accepted boundary.",
          }],
        },
      }],
    });

    expect(proposal).toMatchObject({
      schemaVersion: 1,
      kind: "graph_change",
      effect: "review_contribution_only",
      graphMutationApplied: false,
      reviewRequirement: {
        independentMachineValidation: "required",
        authorityStatus: "not_granted",
        routeHint: "human_authority_indicated",
        indicatedAuthoritySignals: ["initial_plan_authority"],
      },
      mechanicalReview: {
        status: "passed",
        baseTicketCount: 0,
        candidateTicketCount: 2,
      },
    });
    if (proposal.kind !== "graph_change") throw new Error("expected graph proposal");
    const root = proposal.changes.find(
      (change) => change.op === "create" && change.localRef === "root",
    );
    const implementation = proposal.changes.find(
      (change) => change.op === "create"
        && change.localRef === "implementation",
    );
    if (root?.op !== "create" || implementation?.op !== "create") {
      throw new Error("expected both created Tickets");
    }
    expect(root.ticketId).toMatch(/^tkt-[0-9a-f]{64}$/);
    expect(root.definition).toMatchObject({
      ticketId: root.ticketId,
      definitionRevision: 1,
      created: {
        at: NOW,
        by: "agent:ticket-shaper",
        reason: "Shape the first executable outline",
        trust: "claimed_unverified",
      },
    });
    expect(implementation.definition.parentId).toBe(root.ticketId);
    expect(implementation.definition.dependsOn).toEqual([{
      ticketId: root.ticketId,
      rationale: "The implementation realizes the accepted boundary.",
    }]);
    expect(root.definition.provenanceRefs).toContain(
      `ticket-proposal:${proposal.proposalId}`,
    );
    expect(fs.existsSync(
      path.join(repo.work, GIT_TICKET_STORE_RELATIVE_PATH),
    )).toBe(false);

    const stored = db.prepare(
      `SELECT payload,proposal_digest proposalDigest
       FROM ticket_proposals`,
    ).get() as { payload: string; proposalDigest: string };
    expect(JSON.parse(stored.payload)).toEqual(proposal);
    expect(stored.proposalDigest).toBe(proposal.proposalDigest);
    expect(() => db.prepare(
      `UPDATE ticket_proposals SET author='human:forged'`,
    ).run()).toThrow(/immutable/);
    expect(() => db.prepare(
      `DELETE FROM ticket_proposals`,
    ).run()).toThrow(/immutable/);
  });

  it("prepares create and revise changes against exact target revisions", () => {
    const { repo, scope, service } = setup();
    const publisher = new GitTicketGenerationPublisherV0();
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions: [existingDefinition({ ticketId: "TKT-ROOT" })],
    });
    const proposal = service.submit(scope, context("revise-and-create"), {
      schemaVersion: 1,
      kind: "graph_change",
      observedSnapshotId: first.snapshotId,
      reason: "Refine the accepted outline",
      authorAssessment: {
        changeClass: "elaboration",
        authoritySignals: [],
        introducesHumanGate: false,
        rationale: "The promise is unchanged and receives executable detail.",
      },
      changes: [{
        op: "revise",
        ticketId: "TKT-ROOT",
        expectedDefinitionRevision: 1,
        replacement: {
          outcome: "Deliver the accepted workflow with verified behavior",
          parent: null,
          dependsOn: [],
        },
      }, {
        op: "create",
        localRef: "verification",
        definition: {
          outcome: "Verify the accepted workflow behavior",
          parent: { kind: "ticket", ticketId: "TKT-ROOT" },
          dependsOn: [{ target: {
            kind: "ticket",
            ticketId: "TKT-ROOT",
          } }],
        },
      }],
    });

    if (proposal.kind !== "graph_change") throw new Error("expected graph proposal");
    const revised = proposal.changes.find(
      (change) => change.op === "revise",
    );
    expect(revised).toMatchObject({
      op: "revise",
      ticketId: "TKT-ROOT",
      expectedDefinitionRevision: 1,
      previousOutcome: "Deliver TKT-ROOT",
      previousParentId: null,
      dependencyDelta: {
        addedPrerequisiteTicketIds: [],
        removedPrerequisiteTicketIds: [],
      },
      definition: {
        definitionRevision: 2,
        created: {
          at: "2026-07-28T12:00:00.000Z",
          by: "agent:planner",
        },
        provenanceRefs: expect.arrayContaining([
          "fixture:accepted-outline",
          `ticket-proposal:${proposal.proposalId}`,
        ]),
      },
    });
    expect(proposal.mechanicalReview).toMatchObject({
      baseTicketCount: 1,
      candidateTicketCount: 2,
      revisedTicketIds: ["TKT-ROOT"],
    });
    expect(proposal.reviewRequirement).toMatchObject({
      routeHint: "delegated_application_candidate",
      indicatedAuthoritySignals: [],
    });
    expect(new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope)).toMatchObject({
      status: "available",
      source: {
        ticketDefinitions: [{
          ticketId: "TKT-ROOT",
          definitionRevision: 1,
        }],
      },
    });

    expect(() => service.submit(
      scope,
      context("stale-target-revision"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: first.snapshotId,
        reason: "Attempt a stale target edit",
        authorAssessment: {
          changeClass: "elaboration",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "Fixture mismatch.",
        },
        changes: [{
          op: "revise",
          ticketId: "TKT-ROOT",
          expectedDefinitionRevision: 2,
          replacement: {
            outcome: "A mismatched revision",
            parent: null,
            dependsOn: [],
          },
        }],
      },
    )).toThrowError(expect.objectContaining({ code: "cas_conflict" }));

    const current = existingDefinition({
      ticketId: "TKT-ROOT",
      revision: 2,
      outcome: "Deliver the externally revised workflow",
    });
    const second = publisher.publish(scope, {
      expectedSnapshotId: first.snapshotId,
      definitions: [current],
    });
    expect(second.snapshotId).not.toBe(first.snapshotId);
    expect(() => service.submit(
      scope,
      context("stale-snapshot"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: first.snapshotId,
        reason: "Do not silently rebase this stale proposal",
        authorAssessment: {
          changeClass: "elaboration",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "Fixture stale base.",
        },
        changes: [{
          op: "create",
          localRef: "stale-child",
          definition: {
            outcome: "A child from a stale graph",
            parent: { kind: "ticket", ticketId: "TKT-ROOT" },
            dependsOn: [],
          },
        }],
      },
    )).toThrowError(expect.objectContaining({
      code: "ticket_store_cas_conflict",
    }));
  });

  it("uses the publisher's canonical order for mixed-case dependencies", () => {
    const { scope, service } = setup();
    const publisher = new GitTicketGenerationPublisherV0();
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions: [existingDefinition({ ticketId: "TKT-ROOT" })],
    });
    const proposal = service.submit(scope, context("canonical-dependencies"), {
      schemaVersion: 1,
      kind: "graph_change",
      observedSnapshotId: first.snapshotId,
      reason: "Prepare a dependency set with existing and generated IDs",
      authorAssessment: {
        changeClass: "decomposition",
        authoritySignals: [],
        introducesHumanGate: false,
        rationale: "The accepted boundary needs two prerequisites.",
      },
      changes: [{
        op: "create",
        localRef: "generated-prerequisite",
        definition: {
          outcome: "Prepare the generated prerequisite",
          parent: null,
          dependsOn: [],
        },
      }, {
        op: "create",
        localRef: "dependent",
        definition: {
          outcome: "Use both prerequisites",
          parent: null,
          dependsOn: [{
            target: {
              kind: "local",
              localRef: "generated-prerequisite",
            },
          }, {
            target: { kind: "ticket", ticketId: "TKT-ROOT" },
          }],
        },
      }],
    });

    if (proposal.kind !== "graph_change") throw new Error("expected graph proposal");
    const dependent = proposal.changes.find(
      (change) => change.op === "create" && change.localRef === "dependent",
    );
    if (dependent?.op !== "create") throw new Error("expected dependent create");
    expect(dependent.definition.dependsOn.map((item) => item.ticketId))
      .toEqual([
        "TKT-ROOT",
        expect.stringMatching(/^tkt-[0-9a-f]{64}$/),
      ]);
  });

  it("rejects duplicate, dangling, cyclic, and no-op graph changes", () => {
    const { scope, service } = setup();
    const publisher = new GitTicketGenerationPublisherV0();
    const first = publisher.publish(scope, {
      expectedSnapshotId: null,
      definitions: [existingDefinition({ ticketId: "TKT-ROOT" })],
    });
    const base = {
      schemaVersion: 1 as const,
      kind: "graph_change" as const,
      observedSnapshotId: first.snapshotId,
      reason: "Exercise proposal guards",
      authorAssessment: {
        changeClass: "decomposition" as const,
        authoritySignals: [],
        introducesHumanGate: false,
        rationale: "Fixture.",
      },
    };

    expect(() => service.submit(scope, context("duplicate-local"), {
      ...base,
      changes: [{
        op: "create",
        localRef: "same",
        definition: {
          outcome: "First",
          parent: null,
          dependsOn: [],
        },
      }, {
        op: "create",
        localRef: "same",
        definition: {
          outcome: "Second",
          parent: null,
          dependsOn: [],
        },
      }],
    })).toThrowError(expect.objectContaining({ code: "validation_error" }));

    expect(() => service.submit(scope, context("dangling-local"), {
      ...base,
      changes: [{
        op: "create",
        localRef: "child",
        definition: {
          outcome: "Child",
          parent: { kind: "local", localRef: "missing" },
          dependsOn: [],
        },
      }],
    })).toThrowError(expect.objectContaining({ code: "validation_error" }));

    expect(() => service.submit(scope, context("cyclic-dependency"), {
      ...base,
      changes: [{
        op: "create",
        localRef: "one",
        definition: {
          outcome: "One",
          parent: null,
          dependsOn: [{
            target: { kind: "local", localRef: "two" },
          }],
        },
      }, {
        op: "create",
        localRef: "two",
        definition: {
          outcome: "Two",
          parent: null,
          dependsOn: [{
            target: { kind: "local", localRef: "one" },
          }],
        },
      }],
    })).toThrowError(expect.objectContaining({
      code: "ticket_store_publish_invalid",
    }));

    expect(() => service.submit(scope, context("no-op-revision"), {
      ...base,
      changes: [{
        op: "revise",
        ticketId: "TKT-ROOT",
        expectedDefinitionRevision: 1,
        replacement: {
          outcome: "Deliver TKT-ROOT",
          parent: null,
          dependsOn: [],
        },
      }],
    })).toThrowError(expect.objectContaining({ code: "validation_error" }));
  });

  it("binds comments to exact current Ticket and relation subjects", () => {
    const { scope, service } = setup();
    const first = new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions: [
        existingDefinition({ ticketId: "TKT-ROOT" }),
        existingDefinition({
          ticketId: "TKT-CHILD",
          parentId: "TKT-ROOT",
          dependsOn: ["TKT-ROOT"],
        }),
      ],
    });
    const loaded = new GitTicketReviewProjectionSourceProviderV0()
      .loadLatest(scope);
    if (loaded.status !== "available") throw new Error("expected graph");
    const source = loaded.source as {
      directUnlocks: Array<{
        relationRef: string;
        prerequisiteTicketId: string;
        dependentTicketId: string;
      }>;
    };
    const relation = source.directUnlocks[0]!;
    const ticketComment = service.submit(
      scope,
      context("ticket-comment"),
      {
        schemaVersion: 1,
        kind: "comment",
        observedSnapshotId: first.snapshotId,
        subject: {
          kind: "ticket",
          ticketId: "TKT-ROOT",
          definitionRevision: 1,
        },
        body: "Keep this exact accepted outcome visible during execution.",
      },
    );
    expect(ticketComment).toMatchObject({
      kind: "comment",
      subject: {
        kind: "ticket",
        ticketId: "TKT-ROOT",
        definitionRevision: 1,
      },
      effect: "review_contribution_only",
    });
    expect(() => service.submit(
      scope,
      context("stale-ticket-comment"),
      {
        schemaVersion: 1,
        kind: "comment",
        observedSnapshotId: first.snapshotId,
        subject: {
          kind: "ticket",
          ticketId: "TKT-ROOT",
          definitionRevision: 2,
        },
        body: "This revision binding is stale.",
      },
    )).toThrowError(expect.objectContaining({ code: "cas_conflict" }));

    const proposal = service.submit(scope, context("relation-comment"), {
      schemaVersion: 1,
      kind: "comment",
      observedSnapshotId: first.snapshotId,
      subject: { kind: "relation", ...relation },
      body: "This dependency needs a stronger verification rationale.",
    });
    expect(proposal).toMatchObject({
      kind: "comment",
      effect: "review_contribution_only",
      reviewRequirement: {
        independentMachineValidation: "not_applicable",
        authorityStatus: "not_granted",
        routeHint: "comment_only",
      },
    });

    expect(() => service.submit(scope, context("forged-relation-comment"), {
      schemaVersion: 1,
      kind: "comment",
      observedSnapshotId: first.snapshotId,
      subject: {
        kind: "relation",
        ...relation,
        dependentTicketId: "TKT-ROOT",
      },
      body: "Forged endpoint binding.",
    })).toThrowError(expect.objectContaining({ code: "not_found" }));
  });

  it("only indicates human authority; it never grants it", () => {
    const { scope, service } = setup();
    const proposal = service.submit(scope, context("experience-expansion"), {
      schemaVersion: 1,
      kind: "graph_change",
      observedSnapshotId: null,
      reason: "Expose a preference-bearing experience decision",
      authorAssessment: {
        changeClass: "expansion",
        authoritySignals: ["experience_product"],
        introducesHumanGate: true,
        rationale: "This changes the authorized product experience.",
      },
      changes: [{
        op: "create",
        localRef: "decision",
        definition: {
          outcome: "Decide the preference-bearing product experience",
          parent: null,
          dependsOn: [],
        },
      }],
    });
    expect(proposal.reviewRequirement).toEqual({
      independentMachineValidation: "required",
      authorityStatus: "not_granted",
      routeHint: "human_authority_indicated",
      indicatedAuthoritySignals: [
        "experience_product",
        "initial_plan_authority",
      ],
    });
    expect(proposal.graphMutationApplied).toBe(false);
  });

  it("rechecks repository incarnation before recording a proposal", () => {
    const { repo, db, scope, service } = setup();
    const retired = path.join(repo.root, "retired-proposal-worktree");
    fs.renameSync(repo.work, retired);
    fs.mkdirSync(repo.work);
    git(repo.work, "init", "-b", "main");
    fs.writeFileSync(path.join(repo.work, "README.md"), "replacement\n");
    git(repo.work, "add", "README.md");
    git(repo.work, "commit", "-m", "replace repository incarnation");

    expect(() => service.submit(
      scope,
      context("stale-repository-incarnation"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: null,
        reason: "This must not bind across repository replacement",
        authorAssessment: {
          changeClass: "decomposition",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "Fixture.",
        },
        changes: [{
          op: "create",
          localRef: "replacement",
          definition: {
            outcome: "Never record against the replacement repository",
            parent: null,
            dependsOn: [],
          },
        }],
      },
    )).toThrowError(expect.objectContaining({
      code: "ticket_store_scope_mismatch",
    }));
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 0 });
  });

  it("inspects strict proposal payloads and paginates over a stable high-water mark", () => {
    const { db, scope, service } = setup();
    const submit = (requestId: string) => service.submit(
      scope,
      context(requestId),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: null,
        reason: `Shape ${requestId}`,
        authorAssessment: {
          changeClass: "decomposition",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "Fixture.",
        },
        changes: [{
          op: "create",
          localRef: "root",
          definition: {
            outcome: `Deliver ${requestId}`,
            parent: null,
            dependsOn: [],
          },
        }],
      },
    );
    const first = submit("ledger-first");
    const second = submit("ledger-second");
    const pageOne = service.list(
      scope,
      context("list-first-page"),
      { limit: 1 },
    );
    expect(pageOne.items.map((item) => item.proposalId))
      .toEqual([second.proposalId]);
    expect(pageOne.page).toEqual({ count: 1, totalItems: 2 });
    expect(pageOne.nextCursor).toEqual(expect.any(String));

    const late = submit("ledger-late");
    const pageTwo = service.list(
      scope,
      context("list-second-page"),
      { limit: 1, cursor: pageOne.nextCursor! },
    );
    expect(pageTwo.items.map((item) => item.proposalId))
      .toEqual([first.proposalId]);
    expect(pageTwo.page.totalItems).toBe(2);
    expect(service.list(scope, context("list-fresh"), {}).items[0]!.proposalId)
      .toBe(late.proposalId);
    expect(service.inspect(
      scope,
      context("inspect-proposal"),
      { proposalId: first.proposalId },
    )).toEqual(first);
    expect(() => service.list(
      scope,
      context("cursor-filter-mismatch"),
      { kind: "comment", cursor: pageOne.nextCursor! },
    )).toThrowError(expect.objectContaining({ code: "validation_error" }));

    db.exec(`DROP TRIGGER ticket_proposals_immutable_update`);
    const corrupt = { ...first, reason: "tampered after recording" };
    const payload = JSON.stringify(corrupt);
    db.prepare(
      `UPDATE ticket_proposals SET payload=?,byte_length=?
       WHERE proposal_id=?`,
    ).run(
      payload,
      Buffer.byteLength(payload, "utf8"),
      first.proposalId,
    );
    expect(() => service.inspect(
      scope,
      context("inspect-corrupt-proposal"),
      { proposalId: first.proposalId },
    )).toThrowError(expect.objectContaining({ code: "internal_error" }));
  });

  it("validates only exact added and removed dependency deltas", () => {
    const { scope, service } = setup();
    const snapshot = new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions: [
        existingDefinition({ ticketId: "TKT-A" }),
        existingDefinition({ ticketId: "TKT-B" }),
        existingDefinition({ ticketId: "TKT-C" }),
        existingDefinition({
          ticketId: "TKT-TARGET",
          dependsOn: ["TKT-A", "TKT-B"],
        }),
      ],
    });
    const submitted = service.submit(
      scope,
      context("dependency-delta-target"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: snapshot.snapshotId,
        reason: "Replace one prerequisite and add a dependent Ticket",
        authorAssessment: {
          changeClass: "elaboration",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "The accepted outcome stays inside delegated scope.",
        },
        changes: [{
          op: "revise",
          ticketId: "TKT-TARGET",
          expectedDefinitionRevision: 1,
          replacement: {
            outcome: "Deliver TKT-TARGET with the revised prerequisite",
            parent: null,
            dependsOn: [{
              target: { kind: "ticket", ticketId: "TKT-B" },
            }, {
              target: { kind: "ticket", ticketId: "TKT-C" },
            }],
          },
        }, {
          op: "create",
          localRef: "dependent",
          definition: {
            outcome: "Consume the revised target",
            parent: null,
            dependsOn: [{
              target: { kind: "ticket", ticketId: "TKT-TARGET" },
            }],
          },
        }],
      },
    );
    if (submitted.kind !== "graph_change") {
      throw new Error("expected graph proposal");
    }
    const revision = submitted.changes.find(
      (change) => change.op === "revise",
    );
    const created = submitted.changes.find(
      (change) => change.op === "create",
    );
    if (revision?.op !== "revise" || created?.op !== "create") {
      throw new Error("expected revision and create");
    }
    expect(revision).toMatchObject({
      previousOutcome: "Deliver TKT-TARGET",
      previousParentId: null,
      dependencyDelta: {
        addedPrerequisiteTicketIds: ["TKT-C"],
        removedPrerequisiteTicketIds: ["TKT-A"],
      },
    });
    expect(revision.definition.dependsOn.map((item) => item.ticketId))
      .toEqual(["TKT-B", "TKT-C"]);
    expect(created.dependencyDelta).toEqual({
      addedPrerequisiteTicketIds: ["TKT-TARGET"],
      removedPrerequisiteTicketIds: [],
    });

    const exactDeltas = validationInput(submitted);
    exactDeltas.checks[0]!.subject = {
      kind: "dependency_change",
      change: "added",
      prerequisiteTicketId: "TKT-C",
      dependentTicketId: "TKT-TARGET",
    };
    exactDeltas.checks[1]!.subject = {
      kind: "dependency_change",
      change: "removed",
      prerequisiteTicketId: "TKT-A",
      dependentTicketId: "TKT-TARGET",
    };
    exactDeltas.checks[2]!.subject = {
      kind: "dependency_change",
      change: "added",
      prerequisiteTicketId: "TKT-TARGET",
      dependentTicketId: created.ticketId,
    };
    expect(() => service.recordValidation(
      scope,
      context("dependency-delta-valid"),
      exactDeltas,
    )).not.toThrow();

    const retained = validationInput(submitted);
    retained.checks[0]!.subject = {
      kind: "dependency_change",
      change: "added",
      prerequisiteTicketId: "TKT-B",
      dependentTicketId: "TKT-TARGET",
    };
    expect(() => service.recordValidation(
      scope,
      context("dependency-delta-retained"),
      retained,
    )).toThrowError(expect.objectContaining({ code: "validation_error" }));

    const wrongDirection = validationInput(submitted);
    wrongDirection.checks[0]!.subject = {
      kind: "dependency_change",
      change: "added",
      prerequisiteTicketId: "TKT-A",
      dependentTicketId: "TKT-TARGET",
    };
    expect(() => service.recordValidation(
      scope,
      context("dependency-delta-wrong-direction"),
      wrongDirection,
    )).toThrowError(expect.objectContaining({ code: "validation_error" }));
  });

  it("rejects materialized proposal output above 8 MiB before persistence", () => {
    const { db, scope, service } = setup();
    const largeOutcome = "🧭".repeat(20_000);
    const definitions = Array.from({ length: 106 }, (_, index) =>
      existingDefinition({
        ticketId: `TKT-LARGE-${index}`,
        outcome: largeOutcome,
      }));
    const snapshot = new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions,
    });
    expect(() => service.submit(
      scope,
      context("materialized-output-too-large"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: snapshot.snapshotId,
        reason: "Exercise the materialized proposal output boundary",
        authorAssessment: {
          changeClass: "elaboration",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "Fixture.",
        },
        changes: definitions.map((definition, index) => ({
          op: "revise" as const,
          ticketId: definition.ticketId,
          expectedDefinitionRevision: 1,
          replacement: {
            outcome: `Deliver the bounded revision ${index}`,
            parent: null,
            dependsOn: [],
          },
        })),
      },
    )).toThrowError(expect.objectContaining({
      code: "validation_error",
      details: {
        maximumBytes: TICKET_PROPOSAL_MAX_OUTPUT_BYTES,
      },
      nextSafeActions: expect.arrayContaining([
        "Split the proposal into smaller bounded contributions and retry.",
      ]),
    }));
    expect(TICKET_PROPOSAL_MAX_OUTPUT_BYTES).toBe(8_388_608);
    expect(db.prepare(
      `SELECT COUNT(*) count FROM ticket_proposals`,
    ).get()).toEqual({ count: 0 });
  });

  it("records append-only validation evidence without granting authority or maturity", () => {
    const { db, scope, service } = setup();
    const submitted = service.submit(
      scope,
      context("validation-target"),
      {
        schemaVersion: 1,
        kind: "graph_change",
        observedSnapshotId: null,
        reason: "Shape a validation target",
        authorAssessment: {
          changeClass: "decomposition",
          authoritySignals: [],
          introducesHumanGate: false,
          rationale: "Fixture.",
        },
        changes: [{
          op: "create",
          localRef: "root",
          definition: {
            outcome: "Deliver the validated behavior",
            parent: null,
            dependsOn: [],
          },
        }],
      },
    );
    if (submitted.kind !== "graph_change") {
      throw new Error("expected graph proposal");
    }

    const passed = service.recordValidation(
      scope,
      context("validation-passed"),
      validationInput(submitted),
    );
    expect(passed).toMatchObject({
      conclusion: "passed",
      effect: "validation_evidence_only",
      maturityEffect: "none",
      authorityGranted: false,
      applicationAuthorized: false,
      graphMutationApplied: false,
      producer: {
        kind: "claimed_machine_validator",
        invokedBy: {
          kind: "claimed_actor",
          ref: "agent:ticket-shaper",
        },
        trust: "claimed_unverified",
      },
      indicatedAuthoritySignals: [
        "initial_plan_authority",
        "risk_policy",
      ],
    });
    expect(passed.validationReceiptId).toMatch(/^tpv-[0-9a-f]{64}$/);
    expect(passed.checks.map((check) => check.code))
      .toEqual(TICKET_PROPOSAL_VALIDATION_CHECK_CODES);

    const failed = service.recordValidation(
      scope,
      context("validation-failed"),
      validationInput(submitted, "failed"),
    );
    expect(failed.conclusion).toBe("failed");
    expect(failed.findings[0]).toMatchObject({
      impact: "blocking",
      checkLocalRef: "check-0",
    });
    expect(service.inspectValidation(
      scope,
      context("validation-inspect"),
      { validationReceiptId: passed.validationReceiptId },
    )).toEqual(passed);

    const pageOne = service.listValidations(
      scope,
      context("validation-list-first"),
      { proposalId: submitted.proposalId, limit: 1 },
    );
    expect(pageOne.items[0]).toMatchObject({
      validationReceiptId: failed.validationReceiptId,
      conclusion: "failed",
      checkCount: 6,
      findingCount: 1,
      blockingFindingCount: 1,
      advisoryFindingCount: 0,
      effect: "validation_evidence_only",
      maturityEffect: "none",
      authorityGranted: false,
      applicationAuthorized: false,
      graphMutationApplied: false,
    });
    const inconclusive = service.recordValidation(
      scope,
      context("validation-inconclusive"),
      validationInput(submitted, "inconclusive"),
    );
    expect(inconclusive.conclusion).toBe("inconclusive");
    const pageTwo = service.listValidations(
      scope,
      context("validation-list-second"),
      {
        proposalId: submitted.proposalId,
        limit: 1,
        cursor: pageOne.nextCursor!,
      },
    );
    expect(pageTwo.items[0]!.validationReceiptId)
      .toBe(passed.validationReceiptId);
    expect(pageTwo.page.totalItems).toBe(2);

    expect(() => db.prepare(
      `UPDATE ticket_proposal_validation_receipts
       SET conclusion='passed' WHERE validation_receipt_id=?`,
    ).run(failed.validationReceiptId)).toThrow(/immutable/);
    expect(() => db.prepare(
      `DELETE FROM ticket_proposal_validation_receipts
       WHERE validation_receipt_id=?`,
    ).run(failed.validationReceiptId)).toThrow(/immutable/);

    const staleCandidate = validationInput(submitted);
    staleCandidate.expectedCandidateDigest = "c".repeat(64);
    expect(() => service.recordValidation(
      scope,
      context("validation-stale-candidate"),
      staleCandidate,
    )).toThrowError(expect.objectContaining({ code: "cas_conflict" }));

    const forgedSubject = validationInput(submitted);
    forgedSubject.checks[0]!.subject = {
      kind: "ticket_change",
      ticketId: "TKT-NOT-IN-PROPOSAL",
      definitionRevision: 1,
    };
    expect(() => service.recordValidation(
      scope,
      context("validation-forged-subject"),
      forgedSubject,
    )).toThrowError(expect.objectContaining({ code: "validation_error" }));

    const snapshot = new GitTicketGenerationPublisherV0().publish(scope, {
      expectedSnapshotId: null,
      definitions: [existingDefinition({ ticketId: "TKT-COMMENT" })],
    });
    const comment = service.submit(
      scope,
      context("validation-comment-target"),
      {
        schemaVersion: 1,
        kind: "comment",
        observedSnapshotId: snapshot.snapshotId,
        subject: {
          kind: "ticket",
          ticketId: "TKT-COMMENT",
          definitionRevision: 1,
        },
        body: "Comments remain direct review contributions.",
      },
    );
    const commentValidation = validationInput(submitted);
    commentValidation.proposalId = comment.proposalId;
    commentValidation.expectedProposalDigest = comment.proposalDigest;
    expect(() => service.recordValidation(
      scope,
      context("validation-comment-rejected"),
      commentValidation,
    )).toThrowError(expect.objectContaining({ code: "validation_error" }));

    db.exec(
      `DROP TRIGGER ticket_proposal_validation_receipts_immutable_update`,
    );
    db.prepare(
      `UPDATE ticket_proposal_validation_receipts
       SET authority_signal_count=6 WHERE validation_receipt_id=?`,
    ).run(failed.validationReceiptId);
    expect(() => service.listValidations(
      scope,
      context("validation-corrupt-authority-count-list"),
      { proposalId: submitted.proposalId },
    )).toThrowError(expect.objectContaining({ code: "internal_error" }));
    db.prepare(
      `UPDATE ticket_proposal_validation_receipts
       SET authority_signal_count=2 WHERE validation_receipt_id=?`,
    ).run(failed.validationReceiptId);
    db.prepare(
      `UPDATE ticket_proposal_validation_receipts
       SET finding_count=201,blocking_finding_count=201,
           advisory_finding_count=0
       WHERE validation_receipt_id=?`,
    ).run(passed.validationReceiptId);
    expect(() => service.listValidations(
      scope,
      context("validation-corrupt-finding-count-list"),
      { proposalId: submitted.proposalId },
    )).toThrowError(expect.objectContaining({ code: "internal_error" }));
    db.prepare(
      `UPDATE ticket_proposal_validation_receipts
       SET finding_count=0,blocking_finding_count=0,
           advisory_finding_count=0
       WHERE validation_receipt_id=?`,
    ).run(passed.validationReceiptId);
    const stored = db.prepare(
      `SELECT payload FROM ticket_proposal_validation_receipts
       WHERE validation_receipt_id=?`,
    ).get(passed.validationReceiptId) as { payload: string };
    const corrupt = JSON.parse(stored.payload) as Record<string, unknown>;
    corrupt["maturityEffect"] = "granted";
    const corruptPayload = JSON.stringify(corrupt);
    db.prepare(
      `UPDATE ticket_proposal_validation_receipts
       SET payload=?,byte_length=? WHERE validation_receipt_id=?`,
    ).run(
      corruptPayload,
      Buffer.byteLength(corruptPayload, "utf8"),
      passed.validationReceiptId,
    );
    expect(() => service.inspectValidation(
      scope,
      context("validation-corrupt-inspect"),
      { validationReceiptId: passed.validationReceiptId },
    )).toThrowError(expect.objectContaining({ code: "internal_error" }));
  });
});
