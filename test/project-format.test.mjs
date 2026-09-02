import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { run, tempRepo } from "./helpers.mjs";

const marker = {
  schema_version: 1,
  kind: "vibehub_project",
  format_version: 2,
};

function markerPath(repo) {
  return join(repo, ".vibehub", "version.yaml");
}

test("project init writes the canonical format marker and compatibility is current", () => {
  const repo = tempRepo("project-format-current");
  const initialized = run(repo, "project", "init");
  assert.equal(initialized.status, 0, initialized.stdout);
  assert.equal(initialized.envelope.data.format_version, 2);
  assert.deepEqual(JSON.parse(readFileSync(markerPath(repo), "utf8")), marker);

  const compatibility = run(repo, "project", "compatibility");
  assert.equal(compatibility.status, 0, compatibility.stdout);
  assert.deepEqual(
    {
      state: compatibility.envelope.data.state,
      current: compatibility.envelope.data.current_format,
      target: compatibility.envelope.data.target_format,
    },
    { state: "CURRENT", current: 2, target: 2 },
  );
  assert.equal(run(repo, "project", "validate").envelope.data.format_version, 2);
});

test("unversioned 0.4 and 0.5 shapes require migration and every write gate refuses", () => {
  const legacy05 = tempRepo("project-format-legacy-05");
  assert.equal(run(legacy05, "project", "init").status, 0);
  unlinkSync(markerPath(legacy05));

  const compatibility05 = run(legacy05, "project", "compatibility");
  assert.equal(compatibility05.status, 0);
  assert.equal(compatibility05.envelope.data.state, "MIGRATION_REQUIRED");
  assert.equal(compatibility05.envelope.data.detected_format, "0.5-unversioned");
  assert.equal(run(legacy05, "project", "validate").envelope.error.code, "format_mismatch");

  const writes = [
    run(legacy05, "project", "init"),
    run(legacy05, "context", "put", {}, ["--room", "product"]),
    run(legacy05, "room", "align", undefined, ["--room", "product"]),
    run(legacy05, "room", "stale", { reason: "test" }, ["--room", "product"]),
    run(legacy05, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [] }),
    run(legacy05, "ticket", "evidence", {}),
    run(legacy05, "ticket", "closeout", {}),
  ];
  for (const result of writes) {
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.error.code, "format_mismatch", result.stdout);
  }
  assert.equal(existsSync(markerPath(legacy05)), false);

  const legacy04 = tempRepo("project-format-legacy-04");
  mkdirSync(join(legacy04, ".vibehub", "context"), { recursive: true });
  writeFileSync(join(legacy04, ".vibehub", "context", "legacy.yaml"), "{}\n");
  const compatibility04 = run(legacy04, "project", "compatibility");
  assert.equal(compatibility04.status, 0);
  assert.equal(compatibility04.envelope.data.state, "MIGRATION_REQUIRED");
  assert.equal(compatibility04.envelope.data.detected_format, "0.4-unversioned");
});

test("malformed and unsupported-newer format markers fail read-only without mutation", () => {
  const malformed = tempRepo("project-format-malformed");
  assert.equal(run(malformed, "project", "init").status, 0);
  const malformedSource = `${JSON.stringify({ ...marker, extra: true }, null, 2)}\n`;
  writeFileSync(markerPath(malformed), malformedSource);
  for (const operation of ["compatibility", "validate"]) {
    const result = run(malformed, "project", operation);
    assert.notEqual(result.status, 0);
    assert.equal(result.envelope.error.code, "validation_error");
  }
  assert.equal(readFileSync(markerPath(malformed), "utf8"), malformedSource);

  const newer = tempRepo("project-format-newer");
  assert.equal(run(newer, "project", "init").status, 0);
  const newerSource = `${JSON.stringify({ ...marker, format_version: 3 }, null, 2)}\n`;
  writeFileSync(markerPath(newer), newerSource);
  const compatibility = run(newer, "project", "compatibility");
  assert.equal(compatibility.status, 0);
  assert.equal(compatibility.envelope.data.state, "UNSUPPORTED_NEWER");
  assert.equal(compatibility.envelope.data.current_format, 3);
  assert.equal(compatibility.envelope.data.target_format, 2);
  const attemptedWrite = run(newer, "ticket", "apply", { validation: { independent: false, note: "test fixture" }, tickets: [] });
  assert.equal(attemptedWrite.envelope.error.code, "format_mismatch");
  assert.equal(readFileSync(markerPath(newer), "utf8"), newerSource);
});
