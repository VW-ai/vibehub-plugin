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
  const guidance = `${read(root, "README.md")}\n${read(root, "skills/_stdlib/db-operations.md")}`;
  expect(guidance).toContain("`kb_operation`");
  expect(guidance).toContain("`distill_operation`");
  expect(guidance).toContain("optional top-level tool field");
  expect(guidance).toContain("transport correlation ID");
}

function governanceRootFor(root: string): string | null {
  const candidate = path.dirname(root);
  return fs.existsSync(path.join(candidate, "META/21-workbench"))
    ? candidate
    : null;
}

describe("MCP v0.2 active protocol documentation", () => {
  it("always validates packaged README, skills, adapters, and request identity", () => {
    expectPackagedProtocolDocs(workbenchRoot);
  });

  it("validates repository governance when META is present", () => {
    const repoRoot = governanceRootFor(workbenchRoot);
    if (repoRoot === null) return;

    for (const relativePath of [
      "META/21-workbench/design-claude-code-integration.md",
      "META/21-workbench/specs/decision-workbench-007.yaml",
      "META/21-workbench/specs/decision-workbench-009.yaml",
    ]) expectLegacyNamesOnlyInHistory(repoRoot, relativePath);

    const design = read(repoRoot, "META/21-workbench/design-claude-code-integration.md");
    expect(design).toContain("§3 MCP server:端点 + 质量闸(已定案;v0.2 current)");
    expect(design).toContain("`kb_operation` 与 `distill_operation` 可选接收顶层 logical `requestId`");
    expect(design).toContain("`extra.requestId` 只做传输关联");

    for (const decision of ["007", "009"]) {
      const text = read(repoRoot, `META/21-workbench/specs/decision-workbench-${decision}.yaml`);
      expect(text).toContain("2026-07-13 MCP v0.2 澄清(现行约束)");
      expect(text).toContain("`kb_operation`");
      expect(text).toContain("`distill_operation`");
    }
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
    const root = path.join(repo, "workbench");
    try {
      fs.mkdirSync(root);
      fs.mkdirSync(path.join(repo, "META/21-workbench"), { recursive: true });

      const governanceRoot = governanceRootFor(root);
      expect(governanceRoot).toBe(repo);
      if (governanceRoot === null) return;
      expect(() => read(governanceRoot, "META/21-workbench/design-claude-code-integration.md"))
        .toThrow(/ENOENT/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
