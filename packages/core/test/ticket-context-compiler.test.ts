import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  TICKET_CONTEXT_MAX_FILE_BYTES,
  compileTicketContextFiles,
} from "../src/ticket-context-compiler.js";
import { TicketLedgerError } from "../src/ticket-ledger/contract.js";

describe("Ticket context file compilation", () => {
  const roots: string[] = [];

  const root = (): string => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibehub-ticket-context-"),
    );
    roots.push(directory);
    return directory;
  };

  afterEach(() => {
    for (const directory of roots.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("compiles exact UTF-8 files and directories deterministically", () => {
    const directory = root();
    fs.mkdirSync(path.join(directory, "docs"));
    fs.writeFileSync(path.join(directory, "docs", "b.md"), "beta\n");
    fs.writeFileSync(path.join(directory, "docs", "a.md"), "alpha\n");
    fs.writeFileSync(path.join(directory, "contract.md"), "contract\n");

    const first = compileTicketContextFiles(directory, [
      { ref: "docs", purpose: "Implementation evidence" },
      { ref: "contract.md", purpose: "Governing contract" },
    ]);
    const second = compileTicketContextFiles(directory, [
      { ref: "contract.md", purpose: "Governing contract" },
      { ref: "docs", purpose: "Implementation evidence" },
    ]);

    expect(first).toEqual(second);
    expect(first.fileCount).toBe(3);
    expect(first.entries.map((entry) => entry.ref)).toEqual([
      "contract.md",
      "docs",
    ]);
    expect(first.entries[1]?.files.map((file) => file.path)).toEqual([
      "docs/a.md",
      "docs/b.md",
    ]);
    expect(first.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("fails closed on missing, traversal, symlink, binary, and oversized context", () => {
    const directory = root();
    fs.writeFileSync(path.join(directory, "plain.md"), "plain\n");
    fs.symlinkSync("plain.md", path.join(directory, "linked.md"));
    fs.writeFileSync(path.join(directory, "binary.dat"), Buffer.from([0, 1]));
    fs.writeFileSync(
      path.join(directory, "large.txt"),
      Buffer.alloc(TICKET_CONTEXT_MAX_FILE_BYTES + 1, 0x61),
    );

    for (const ref of [
      "missing.md",
      "../outside.md",
      "linked.md",
      "binary.dat",
      "large.txt",
    ]) {
      expect(() => compileTicketContextFiles(directory, [{
        ref,
        purpose: "Required",
      }])).toThrow(TicketLedgerError);
    }
  });

  it("rejects overlapping references instead of duplicating packet content", () => {
    const directory = root();
    fs.mkdirSync(path.join(directory, "docs"));
    fs.writeFileSync(path.join(directory, "docs", "a.md"), "alpha\n");

    expect(() => compileTicketContextFiles(directory, [
      { ref: "docs", purpose: "Directory" },
      { ref: "docs/a.md", purpose: "File" },
    ])).toThrow(/overlap/u);
  });

  it("excludes the semantic Ticket ledger with component-safe matching", () => {
    const directory = root();
    fs.mkdirSync(
      path.join(directory, ".vibehub", "tickets", "tickets"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(directory, ".vibehub", "tickets", "protocol.yaml"),
      "schema_version: 1\n",
    );
    fs.writeFileSync(
      path.join(
        directory,
        ".vibehub",
        "tickets",
        "tickets",
        "subject.yaml",
      ),
      "kind: ticket\n",
    );
    fs.mkdirSync(
      path.join(directory, ".vibehub", "tickets2"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(directory, ".vibehub", "tickets2", "context.md"),
      "ordinary repository context\n",
    );

    for (const ref of [
      ".vibehub",
      ".vibehub/tickets",
      ".vibehub/tickets/protocol.yaml",
      ".vibehub/tickets/tickets/subject.yaml",
      ".VIBEHub/TICKETS/protocol.yaml",
    ]) {
      expect(() => compileTicketContextFiles(directory, [{
        ref,
        purpose: "Must remain a first-class semantic fact",
      }])).toThrowError(
        expect.objectContaining({
          code: "invalid_path",
          details: expect.objectContaining({
            excludedRoot: ".vibehub/tickets",
          }),
        }),
      );
    }

    expect(compileTicketContextFiles(directory, [{
      ref: ".vibehub/tickets2",
      purpose: "Ordinary lookalike repository context",
    }])).toMatchObject({
      entries: [{
        ref: ".vibehub/tickets2",
        files: [{
          path: ".vibehub/tickets2/context.md",
          content: "ordinary repository context\n",
        }],
      }],
    });
  });

  it("excludes Git administration segments without rejecting lookalikes", () => {
    const directory = root();
    fs.mkdirSync(path.join(directory, ".git"), { recursive: true });
    fs.writeFileSync(path.join(directory, ".git", "config"), "[core]\n");
    fs.mkdirSync(path.join(directory, ".github"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, ".github", "workflows.md"),
      "ordinary context\n",
    );
    fs.writeFileSync(path.join(directory, ".gitkeep"), "keep\n");
    fs.mkdirSync(
      path.join(directory, "docs", "vendor", ".git"),
      { recursive: true },
    );
    fs.writeFileSync(
      path.join(directory, "docs", "readme.md"),
      "visible context\n",
    );
    fs.writeFileSync(
      path.join(directory, "docs", "vendor", ".git", "config"),
      "[core]\n",
    );

    for (const ref of [
      ".git",
      ".GIT/config",
      "vendor/.GiT/config",
    ]) {
      expect(() => compileTicketContextFiles(directory, [{
        ref,
        purpose: "Must not expose Git administration data",
      }])).toThrowError(
        expect.objectContaining({
          code: "invalid_path",
          details: expect.objectContaining({
            excludedSegment: ".git",
          }),
        }),
      );
    }
    expect(() => compileTicketContextFiles(directory, [{
      ref: "docs",
      purpose: "Directory containing nested repository metadata",
    }])).toThrowError(
      expect.objectContaining({
        code: "invalid_path",
        details: expect.objectContaining({
          path: "docs/vendor/.git",
          excludedSegment: ".git",
        }),
      }),
    );

    expect(compileTicketContextFiles(directory, [
      {
        ref: ".github",
        purpose: "Component-safe directory lookalike",
      },
      {
        ref: ".gitkeep",
        purpose: "Component-safe file lookalike",
      },
    ])).toMatchObject({
      entries: [
        {
          ref: ".github",
          files: [{ path: ".github/workflows.md" }],
        },
        {
          ref: ".gitkeep",
          files: [{ path: ".gitkeep" }],
        },
      ],
    });
  });
});
