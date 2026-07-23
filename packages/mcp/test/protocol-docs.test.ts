import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workbenchRoot = fileURLToPath(new URL("../../../", import.meta.url));
const legacyName = /kb_record|kb_apply_distillation/;

const read = (root: string, relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");
const markdownFiles = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const absolute = path.join(directory, entry.name);
  if (entry.isDirectory()) return markdownFiles(absolute);
  return entry.isFile() && entry.name.endsWith(".md") ? [absolute] : [];
});

function expectLegacyNamesOnlyInHistory(root: string, relativePath: string): void {
  const occurrences = read(root, relativePath).split("\n").filter((line) => legacyName.test(line));
  expect(occurrences, relativePath).not.toEqual([]);
  for (const line of occurrences) {
    expect(line, `${relativePath}: legacy MCP name lacks an explicit historical marker`)
      .toMatch(/histor|历史|legacy|旧|移除|removed|v0\.1/i);
  }
}

function expectPackagedProtocolDocs(root: string): void {
  expectLegacyNamesOnlyInHistory(root, "README.md");
  for (const absolute of markdownFiles(path.join(root, "skills"))) {
    expect(fs.readFileSync(absolute, "utf8"), path.relative(root, absolute)).not.toMatch(legacyName);
  }
  const guidance = `${read(root, "README.md")}\n${read(root, "skills/_stdlib/operations.md")}`;
  expect(guidance).toContain("`kb_operation`");
  expect(guidance).toContain("`distill_operation`");
  expect(guidance).toContain("optional top-level tool field");
  expect(guidance).toContain("transport correlation ID");
}

function governanceRootFor(root: string): string | null {
  return fs.existsSync(path.join(root, "META/project.yaml"))
    ? root
    : null;
}

describe("MCP v0.2 active protocol documentation", () => {
  it("always validates packaged README, skills, adapters, and request identity", () => {
    expectPackagedProtocolDocs(workbenchRoot);
  });

  it("validates repository governance when META is present", () => {
    const repoRoot = governanceRootFor(workbenchRoot);
    if (repoRoot === null) return;

    expectLegacyNamesOnlyInHistory(
      repoRoot,
      "META/legacy-21-workbench/design-claude-code-integration.md",
    );

    const design = read(repoRoot, "META/legacy-21-workbench/design-claude-code-integration.md");
    expect(design).toContain("§3 MCP server:端点 + 质量闸(已定案;v0.2 current)");
    expect(design).toContain("`kb_operation` 与 `distill_operation` 可选接收顶层 logical `requestId`");
    expect(design).toContain("`extra.requestId` 只做传输关联");

    const delivery = read(
      repoRoot,
      "META/02-01-claude-code/specs/decision-workbench-007.yaml",
    );
    expect(delivery).not.toMatch(legacyName);
    expect(delivery).toContain("progressive manual");
    expect(delivery).toContain("pause 优先");

    const boundary = read(
      repoRoot,
      "META/02-host-integrations/specs/decision-workbench-009.yaml",
    );
    expect(boundary).not.toMatch(legacyName);
    expect(boundary).toContain("MCP=deterministic capabilities");
    expect(boundary).toContain("skills=how well");
  });

  it("supports a standalone workbench root without weakening packaged legacy checks", () => {
    const standalone = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-protocol-docs-"));
    try {
      fs.copyFileSync(path.join(workbenchRoot, "README.md"), path.join(standalone, "README.md"));
      fs.cpSync(path.join(workbenchRoot, "skills"), path.join(standalone, "skills"), { recursive: true });

      expect(governanceRootFor(standalone)).toBeNull();
      expect(() => expectPackagedProtocolDocs(standalone)).not.toThrow();

      fs.appendFileSync(path.join(standalone, "README.md"), "\nUse kb_record for current writes.\n");
      expect(() => expectPackagedProtocolDocs(standalone)).toThrow(/historical marker/);
    } finally {
      fs.rmSync(standalone, { recursive: true, force: true });
    }
  });

  it("does not classify a repository with META but a missing required design as standalone", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "vibehub-protocol-governance-"));
    const root = repo;
    try {
      fs.mkdirSync(path.join(repo, "META"), { recursive: true });
      fs.writeFileSync(path.join(repo, "META/project.yaml"), "project:\n  name: test\n");

      const governanceRoot = governanceRootFor(root);
      expect(governanceRoot).toBe(repo);
      if (governanceRoot === null) return;
      expect(() => read(governanceRoot, "META/legacy-21-workbench/design-claude-code-integration.md"))
        .toThrow(/ENOENT/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
