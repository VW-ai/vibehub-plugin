import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Layout = "v1-content-addressed-manifest" | "v2-stable-identity-derived-index";

interface SpikeSpec {
  spec_id: string;
  state: "draft" | "active" | "stale" | "superseded" | "deprecated";
  current_revision: number;
  summary: string;
  detail: string;
  evidence: string[];
  relations: string[];
  revisions: Array<{ revision: number; summary: string }>;
}

const canonical = (value: unknown): Json => {
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) return value as Json;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonical(item)]));
};

const serialize = (value: unknown): string => `${JSON.stringify(canonical(value), null, 2)}\n`;
const digest = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");
const idPath = (id: string): string => `sha256-${digest(id)}.yaml`;

const run = (cwd: string, ...args: string[]): string => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: "Merge Spike",
    GIT_AUTHOR_EMAIL: "merge-spike@example.test",
    GIT_COMMITTER_NAME: "Merge Spike",
    GIT_COMMITTER_EMAIL: "merge-spike@example.test",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  },
});

const write = (root: string, relative: string, bytes: string): void => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
};

const removeStore = (root: string): void => {
  fs.rmSync(path.join(root, ".vibehub"), { recursive: true, force: true });
};

function writeStore(root: string, layout: Layout, specs: SpikeSpec[]): void {
  removeStore(root);
  if (layout === "v1-content-addressed-manifest") {
    const base = ".vibehub/semantic-store/v1";
    const entries = specs.slice().sort((a, b) => a.spec_id < b.spec_id ? -1 : 1).map((spec) => {
      const bytes = serialize({ schema_version: 1, kind: "spec", ...spec });
      const sha256 = digest(bytes);
      const file = `specs/sha256-${sha256}.yaml`;
      write(root, `${base}/${file}`, bytes);
      return { id: spec.spec_id, file, sha256 };
    });
    write(root, `${base}/manifest.yaml`, serialize({
      schema_version: 1,
      format: "vibehub.git-semantic-store",
      specs: entries,
      semantic_digest: digest(serialize(entries)),
    }));
    return;
  }

  const base = ".vibehub/semantic-store/v2";
  write(root, `${base}/protocol.yaml`, serialize({
    format: "vibehub.git-semantic-store",
    schema_version: 2,
    indexing: "stable-identity-paths",
    integrity: "derived-from-canonical-tree",
  }));
  for (const spec of specs) {
    write(root, `${base}/specs/${idPath(spec.spec_id)}`, serialize({
      schema_version: 2,
      kind: "spec",
      ...spec,
    }));
  }
}

function baseSpecs(): SpikeSpec[] {
  return [
    {
      spec_id: "decision-a",
      state: "active",
      current_revision: 1,
      summary: "A base summary",
      detail: "A base detail",
      evidence: ["evidence-a"],
      relations: [],
      revisions: [{ revision: 1, summary: "A base summary" }],
    },
    {
      spec_id: "decision-b",
      state: "active",
      current_revision: 1,
      summary: "B base summary",
      detail: "B base detail",
      evidence: ["evidence-b"],
      relations: [],
      revisions: [{ revision: 1, summary: "B base summary" }],
    },
  ];
}

interface MergeResult {
  clean: boolean;
  conflicts: string[];
  root: string;
}

function mergeScenario(
  layout: Layout,
  mutateA: (specs: SpikeSpec[]) => void,
  mutateB: (specs: SpikeSpec[]) => void,
): MergeResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-semantic-merge-"));
  run(root, "init", "-b", "main");
  writeStore(root, layout, baseSpecs());
  run(root, "add", "-A");
  run(root, "commit", "-m", "base");

  run(root, "switch", "-c", "branch-a");
  const branchA = baseSpecs();
  mutateA(branchA);
  writeStore(root, layout, branchA);
  run(root, "add", "-A");
  run(root, "commit", "-m", "branch a");

  run(root, "switch", "main");
  run(root, "switch", "-c", "branch-b");
  const branchB = baseSpecs();
  mutateB(branchB);
  writeStore(root, layout, branchB);
  run(root, "add", "-A");
  run(root, "commit", "-m", "branch b");

  run(root, "switch", "branch-a");
  const merged = spawnSync("git", ["merge", "--no-edit", "branch-b"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Merge Spike",
      GIT_AUTHOR_EMAIL: "merge-spike@example.test",
      GIT_COMMITTER_NAME: "Merge Spike",
      GIT_COMMITTER_EMAIL: "merge-spike@example.test",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  const conflicts = run(root, "diff", "--name-only", "--diff-filter=U")
    .trim().split("\n").filter(Boolean);
  return { clean: merged.status === 0, conflicts, root };
}

function readV2Spec(root: string, id: string): SpikeSpec {
  const bytes = fs.readFileSync(path.join(
    root,
    ".vibehub/semantic-store/v2/specs",
    idPath(id),
  ), "utf8");
  const parsed = JSON.parse(bytes) as SpikeSpec;
  if (serialize(parsed) !== bytes) throw new Error(`merged spec is not canonical: ${id}`);
  return parsed;
}

describe("Git semantic store merge ergonomics spike", () => {
  const roots: string[] = [];
  afterEach(() => roots.splice(0).forEach((root) =>
    fs.rmSync(root, { recursive: true, force: true })));

  const keep = (result: MergeResult): MergeResult => {
    roots.push(result.root);
    return result;
  };

  it("proves the v1 global manifest conflicts even when branches change different specs", () => {
    const result = keep(mergeScenario(
      "v1-content-addressed-manifest",
      (specs) => { specs[0]!.summary = "A changed on branch A"; },
      (specs) => { specs[1]!.summary = "B changed on branch B"; },
    ));
    expect(result.clean).toBe(false);
    expect(result.conflicts).toContain(".vibehub/semantic-store/v1/manifest.yaml");
  });

  it("proves v1 content paths prevent same-spec disjoint-field three-way merge", () => {
    const result = keep(mergeScenario(
      "v1-content-addressed-manifest",
      (specs) => { specs[0]!.summary = "summary changed on branch A"; },
      (specs) => { specs[0]!.evidence.push("evidence-from-branch-b"); },
    ));
    expect(result.clean).toBe(false);
    expect(result.conflicts).toContain(".vibehub/semantic-store/v1/manifest.yaml");
    expect(result.conflicts.some((file) => file.includes("/specs/"))).toBe(true);
  });

  it("proves stable identity paths with no committed global digest merge unrelated specs cleanly", () => {
    const result = keep(mergeScenario(
      "v2-stable-identity-derived-index",
      (specs) => { specs[0]!.summary = "A changed on branch A"; },
      (specs) => { specs[1]!.summary = "B changed on branch B"; },
    ));
    expect(result).toMatchObject({ clean: true, conflicts: [] });
    expect(readV2Spec(result.root, "decision-a").summary).toBe("A changed on branch A");
    expect(readV2Spec(result.root, "decision-b").summary).toBe("B changed on branch B");
  });

  it("lets Git merge disjoint fields on one stable spec and preserves both edits", () => {
    const result = keep(mergeScenario(
      "v2-stable-identity-derived-index",
      (specs) => { specs[0]!.summary = "summary changed on branch A"; },
      (specs) => { specs[0]!.evidence.push("evidence-from-branch-b"); },
    ));
    expect(result).toMatchObject({ clean: true, conflicts: [] });
    const merged = readV2Spec(result.root, "decision-a");
    expect(merged.summary).toBe("summary changed on branch A");
    expect(merged.evidence).toEqual(["evidence-a", "evidence-from-branch-b"]);
  });

  it.each([
    {
      name: "same field",
      mutateA: (specs: SpikeSpec[]) => { specs[0]!.summary = "branch A verdict"; },
      mutateB: (specs: SpikeSpec[]) => { specs[0]!.summary = "branch B verdict"; },
    },
    {
      name: "concurrent revision number",
      mutateA: (specs: SpikeSpec[]) => {
        specs[0]!.current_revision = 2;
        specs[0]!.revisions.push({ revision: 2, summary: "branch A revision" });
      },
      mutateB: (specs: SpikeSpec[]) => {
        specs[0]!.current_revision = 2;
        specs[0]!.revisions.push({ revision: 2, summary: "branch B revision" });
      },
    },
    {
      name: "lifecycle verdict",
      mutateA: (specs: SpikeSpec[]) => { specs[0]!.state = "stale"; },
      mutateB: (specs: SpikeSpec[]) => { specs[0]!.state = "deprecated"; },
    },
    {
      name: "concurrent relation append",
      mutateA: (specs: SpikeSpec[]) => { specs[0]!.relations.push("depends_on:decision-b"); },
      mutateB: (specs: SpikeSpec[]) => { specs[0]!.relations.push("relates_to:decision-b"); },
    },
  ])("surfaces $name as an explicit same-spec conflict for PR review", ({ mutateA, mutateB }) => {
    const result = keep(mergeScenario("v2-stable-identity-derived-index", mutateA, mutateB));
    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([
      `.vibehub/semantic-store/v2/specs/${idPath("decision-a")}`,
    ]);
  });

  it("surfaces delete-versus-amend as an explicit modify/delete conflict", () => {
    const result = keep(mergeScenario(
      "v2-stable-identity-derived-index",
      (specs) => { specs.splice(0, 1); },
      (specs) => { specs[0]!.summary = "amended while the other branch deletes"; },
    ));
    expect(result.clean).toBe(false);
    expect(result.conflicts).toEqual([
      `.vibehub/semantic-store/v2/specs/${idPath("decision-a")}`,
    ]);
  });
});
