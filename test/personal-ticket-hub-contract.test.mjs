import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseRecord,
  validateSchema,
  validateSemantics,
  verifyContractFixtures
} from "../docs/proposals/personal-ticket-hub/scripts/contract-validator.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_ROOT = path.join(ROOT, "docs/proposals/personal-ticket-hub");
const CONTRACTS = path.join(CONTRACT_ROOT, "contracts");
const FIXTURES = path.join(CONTRACT_ROOT, "fixtures");

function json(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(CONTRACT_ROOT, relativePath), "utf8"));
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(filePath) : [filePath];
  });
}

test("Personal Hub schema and semantic fixtures have their declared outcomes", () => {
  assert.deepEqual(verifyContractFixtures(CONTRACT_ROOT), { ok: true, failures: [] });
});

test("all valid records pass their strict schema and store-wide semantic checks", () => {
  const projectSchema = json("contracts/personal-project.schema.json");
  const ticketSchema = json("contracts/personal-ticket.schema.json");
  const paths = [
    path.join(FIXTURES, "valid/sample-app.yaml"),
    ...walkFiles(path.join(FIXTURES, "valid")).filter((filePath) => path.basename(filePath).startsWith("pt-"))
  ];

  for (const filePath of paths) {
    const record = parseRecord(filePath);
    const schema = record.kind === "personal_project" ? projectSchema : ticketSchema;
    assert.deepEqual(validateSchema(record, schema), [], filePath);
  }
  assert.deepEqual(validateSemantics(paths), []);
});

test("strict schema rejection paths report stable error codes", () => {
  const cases = [
    { value: {}, schema: { type: "object", required: ["title"] }, code: "required" },
    { value: 4, schema: { type: "string" }, code: "type" },
    { value: "draft", schema: { const: "ready" }, code: "const" },
    { value: "paused", schema: { enum: ["draft", "ready"] }, code: "enum" },
    { value: "a", schema: { type: "string", minLength: 2 }, code: "min-length" },
    { value: "abc", schema: { type: "string", maxLength: 2 }, code: "max-length" },
    { value: "ABC", schema: { type: "string", pattern: "^[a-z]+$" }, code: "pattern" },
    { value: -1, schema: { type: "integer", minimum: 0 }, code: "minimum" },
    { value: ["same", "same"], schema: { type: "array", uniqueItems: true }, code: "unique-items" },
    {
      value: { state: "ready" },
      schema: {
        type: "object",
        properties: { state: { enum: ["draft", "ready"] }, acceptance: { type: "array" } },
        if: { type: "object", properties: { state: { const: "ready" } } },
        then: { type: "object", required: ["acceptance"] }
      },
      code: "required"
    }
  ];

  for (const { value, schema, code } of cases) {
    assert.ok(validateSchema(value, schema).some((error) => error.code === code), code);
  }
});

test("date-time validation rejects normalized calendar dates and invalid clocks", () => {
  const schema = { type: "string", format: "date-time" };
  const valid = ["2024-02-29T23:59:59Z", "2025-01-01T00:00:00.123-05:00"];
  const invalid = [
    "2025-02-29T00:00:00Z",
    "2025-02-30T00:00:00Z",
    "2025-13-01T00:00:00Z",
    "2025-01-01T24:00:00Z",
    "2025-01-01T00:60:00Z",
    "2025-01-01T00:00:60Z"
  ];

  for (const value of valid) assert.deepEqual(validateSchema(value, schema), [], value);
  for (const value of invalid) {
    assert.ok(validateSchema(value, schema).some((error) => error.code === "format-date-time"), value);
  }
});

test("string length counts Unicode code points rather than UTF-16 code units", () => {
  const schema = { type: "string", minLength: 2, maxLength: 160 };
  assert.deepEqual(validateSchema(`界${"😀".repeat(159)}`, schema), []);
  assert.ok(validateSchema("😀", schema).some((error) => error.code === "min-length"));
  assert.ok(validateSchema("😀".repeat(161), schema).some((error) => error.code === "max-length"));
});

test("standalone contract validator reports success and failure through its exit code", () => {
  const script = path.join(CONTRACT_ROOT, "scripts/contract-validator.mjs");
  const success = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.deepEqual(JSON.parse(success.stdout), { ok: true, failures: [] });

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "personal-hub-contract-"));
  try {
    fs.cpSync(CONTRACT_ROOT, temporaryRoot, { recursive: true });
    const manifestPath = path.join(temporaryRoot, "fixtures/manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.structural_valid.push({
      path: "invalid/pt-unknown-field.yaml",
      schema: "personal-ticket.schema.json"
    });
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const failure = spawnSync(process.execPath, [script, temporaryRoot], { encoding: "utf8" });
    assert.equal(failure.status, 1, failure.stderr);
    assert.equal(JSON.parse(failure.stdout).ok, false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("semantic authority is versioned and separate from structural schemas", () => {
  const semantics = json("contracts/semantic-contract.json");
  assert.equal(semantics.schema_version, 1);
  assert.equal(semantics.kind, "personal_ticket_semantics");
  assert.deepEqual(semantics.lifecycle.states, ["inbox", "draft", "ready", "archived"]);
  assert.deepEqual(semantics.lifecycle.readiness_affecting_fields, [
    "title",
    "desired_outcome",
    "source_refs",
    "source_excerpt",
    "acceptance",
    "next_gate"
  ]);
  assert.deepEqual(semantics.projections.active.state_in, ["inbox", "draft", "ready"]);
  assert.equal(semantics.projections.unassigned.project_refs_length, 0);
  assert.equal(semantics.source_policy.prior_transcript_harvest, false);
  assert.equal(semantics.source_policy.implicit_repository_scan, false);
});

test("configuration pointer and store marker have distinct strict authority", () => {
  const configSchema = json("contracts/personal-hub-config.schema.json");
  const storeSchema = json("contracts/personal-ticket-store.schema.json");
  const semantics = json("contracts/semantic-contract.json");

  assert.equal(configSchema.additionalProperties, false);
  assert.deepEqual(configSchema.required, ["schema_version", "kind", "data_root"]);
  assert.equal(storeSchema.additionalProperties, false);
  assert.deepEqual(storeSchema.required, ["schema_version", "kind", "format_version"]);
  assert.deepEqual(semantics.configuration.pointer_owns, ["data_root"]);
  assert.equal(semantics.configuration.store_marker_filename, "store.yaml");
  assert.equal(semantics.configuration.provider_secrets_allowed, false);
  assert.equal(semantics.configuration.project_context_allowed, false);
});

test("contract and fixture bytes contain no known private pilot identifiers", () => {
  const forbidden = [
    ["mint", "y"].join(""),
    ["Mint", "y-Dental"].join(""),
    ["C", "RM-"].join(""),
    ["SCR", "APE-"].join(""),
    ["F", "B-"].join("")
  ];
  const files = [...walkFiles(CONTRACTS), ...walkFiles(FIXTURES)];

  for (const filePath of files) {
    const contents = fs.readFileSync(filePath, "utf8");
    for (const pattern of forbidden) {
      assert.equal(contents.includes(pattern), false, `${filePath} contains a private pilot identifier`);
    }
  }
});

test("public Personal Hub artifacts contain no machine-local or private pilot metadata", () => {
  const forbiddenText = [
    ["mint", "y"].join(""),
    ["Vic", "tor"].join(""),
    ["No", "mi"].join(""),
    ["C", "RM-"].join(""),
    ["SCR", "APE-"].join(""),
    ["F", "B-"].join(""),
    "/Users/",
    "/home/",
    ["auto", "-socialmedia"].join("")
  ];
  const provenanceFiles = [
    ...walkFiles(path.join(ROOT, ".vibehub/evidence"))
      .filter((filePath) => filePath.includes("ticket-personal-hub-")),
    ...walkFiles(path.join(ROOT, ".vibehub/outcomes"))
      .filter((filePath) => path.basename(filePath).startsWith("ticket-personal-hub-"))
  ];
  const files = [
    ...walkFiles(path.join(ROOT, "docs/proposals/personal-ticket-hub")),
    path.join(ROOT, "docs/designs/personal-ticket-hub.md"),
    path.join(ROOT, "docs/PERSONAL_TICKET_HUB_SOLUTION.zh-CN.md"),
    path.join(ROOT, "docs/PERSONAL_TICKET_HUB_DESIGN_NOTES.zh-CN.md"),
    ...walkFiles(path.join(ROOT, "docs/demos")),
    ...provenanceFiles,
    ...walkFiles(path.join(ROOT, ".vibehub/tickets"))
      .filter((filePath) => path.basename(filePath).startsWith("ticket-personal-hub-")),
    path.join(ROOT, ".vibehub/rooms/product/decision-personal-ticket-hub-separate-application.yaml")
  ];

  for (const filePath of files) {
    const contents = fs.readFileSync(filePath, "utf8");
    for (const pattern of forbiddenText) {
      assert.equal(contents.includes(pattern), false, `${filePath} contains ${pattern}`);
    }
    assert.doesNotMatch(contents, /(?:vibehub-personal@|commit:)[0-9a-f]{7,40}/i, filePath);
    const normalized = contents.toLocaleLowerCase("en-US").replace(/[\s_-]+/g, "");
    for (const pattern of [
      ["auto", "social", "media"].join(""),
      ["social", "publisher"].join(""),
      ["insta", "gram"].join("")
    ]) {
      assert.equal(normalized.includes(pattern), false, `${filePath} contains normalized private project metadata`);
    }
  }

  for (const filePath of provenanceFiles) {
    const contents = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(contents, /<(?:private-repo-commit|workspace)>/, filePath);
  }
});
