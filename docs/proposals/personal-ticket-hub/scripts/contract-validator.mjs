#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONTRACT_ROOT = path.resolve(HERE, "..");

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function joinPath(base, segment) {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$-]*$/.test(String(segment))) {
    return base === "$" ? `$.${segment}` : `${base}.${segment}`;
  }
  return `${base}[${JSON.stringify(segment)}]`;
}

function resolveLocalRef(rootSchema, ref) {
  if (!ref.startsWith("#/")) {
    throw new Error(`Only local schema references are supported: ${ref}`);
  }

  return ref
    .slice(2)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], rootSchema);
}

function isDateTime(value) {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText === undefined ? 0 : Number(offsetHourText);
  const offsetMinute = offsetMinuteText === undefined ? 0 : Number(offsetMinuteText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1] &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59
  );
}

function typeMatches(value, expected) {
  if (expected === "array") return Array.isArray(value);
  if (expected === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (expected === "integer") return Number.isInteger(value);
  return typeof value === expected;
}

function validateNode(value, schema, rootSchema, valuePath, errors) {
  if (schema.$ref) {
    const target = resolveLocalRef(rootSchema, schema.$ref);
    if (!target) throw new Error(`Schema reference does not resolve: ${schema.$ref}`);
    validateNode(value, target, rootSchema, valuePath, errors);
    return;
  }

  if (Object.hasOwn(schema, "const") && !sameValue(value, schema.const)) {
    errors.push({ code: "const", path: valuePath, message: `Expected ${JSON.stringify(schema.const)}.` });
  }

  if (schema.enum && !schema.enum.some((candidate) => sameValue(value, candidate))) {
    errors.push({ code: "enum", path: valuePath, message: "Value is outside the allowed set." });
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push({ code: "type", path: valuePath, message: `Expected ${schema.type}.` });
    return;
  }

  if (typeof value === "string") {
    const codePointLength = [...value].length;
    if (schema.minLength !== undefined && codePointLength < schema.minLength) {
      errors.push({ code: "min-length", path: valuePath, message: `Expected at least ${schema.minLength} characters.` });
    }
    if (schema.maxLength !== undefined && codePointLength > schema.maxLength) {
      errors.push({ code: "max-length", path: valuePath, message: `Expected at most ${schema.maxLength} characters.` });
    }
    if (schema.pattern && !(new RegExp(schema.pattern).test(value))) {
      errors.push({ code: "pattern", path: valuePath, message: `Value does not match ${schema.pattern}.` });
    }
    if (schema.format === "date-time" && !isDateTime(value)) {
      errors.push({ code: "format-date-time", path: valuePath, message: "Expected an RFC 3339 date-time." });
    }
  }

  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push({ code: "minimum", path: valuePath, message: `Expected a value of at least ${schema.minimum}.` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ code: "min-items", path: valuePath, message: `Expected at least ${schema.minItems} items.` });
    }
    if (schema.uniqueItems) {
      const seen = new Set();
      for (const [index, item] of value.entries()) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          errors.push({ code: "unique-items", path: joinPath(valuePath, index), message: "Array items must be unique." });
        }
        seen.add(key);
      }
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(item, schema.items, rootSchema, joinPath(valuePath, index), errors));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push({ code: "required", path: joinPath(valuePath, required), message: "Required property is missing." });
      }
    }

    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push({ code: "additional-properties", path: joinPath(valuePath, key), message: "Unknown property." });
        }
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        validateNode(value[key], childSchema, rootSchema, joinPath(valuePath, key), errors);
      }
    }
  }

  for (const childSchema of schema.allOf ?? []) {
    validateNode(value, childSchema, rootSchema, valuePath, errors);
  }

  if (schema.if) {
    const conditionErrors = [];
    validateNode(value, schema.if, rootSchema, valuePath, conditionErrors);
    validateNode(value, conditionErrors.length === 0 ? schema.then ?? {} : schema.else ?? {}, rootSchema, valuePath, errors);
  }
}

export function validateSchema(value, schema) {
  const errors = [];
  validateNode(value, schema, schema, "$", errors);
  return errors;
}

export function parseRecord(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON-compatible YAML: ${error.message}`);
  }
}

function recordIdentity(record) {
  if (record?.kind === "personal_project") return record.project_id;
  if (record?.kind === "personal_ticket") return record.personal_ticket_id;
  return undefined;
}

export function validateSemantics(inputs) {
  const entries = inputs.map((input) => {
    if (typeof input === "string") return { filePath: input, record: parseRecord(input) };
    return input;
  });
  const errors = [];
  const ids = new Map();
  const projects = new Set();
  const aliases = new Map();
  const externalKeys = new Map();

  for (const { filePath, record } of entries) {
    const id = recordIdentity(record);
    if (!id) continue;

    if (path.basename(filePath) !== `${id}.yaml`) {
      errors.push({ code: "filename-id-mismatch", path: filePath, message: `Filename must be ${id}.yaml.` });
    }

    if (ids.has(id)) {
      errors.push({ code: "duplicate-record-id", path: filePath, message: `Record ID ${id} also appears in ${ids.get(id)}.` });
    } else {
      ids.set(id, filePath);
    }

    if (record.kind === "personal_project") {
      projects.add(record.project_id);
      for (const alias of record.aliases ?? []) {
        const key = alias.trim().toLocaleLowerCase("en-US");
        if (aliases.has(key)) {
          errors.push({ code: "duplicate-project-alias", path: filePath, message: `Project alias ${JSON.stringify(alias)} also appears in ${aliases.get(key)}.` });
        } else {
          aliases.set(key, filePath);
        }
      }
    }

    if (record.kind === "personal_ticket") {
      for (const externalKey of record.external_keys ?? []) {
        const key = JSON.stringify([externalKey.system, externalKey.key]);
        if (externalKeys.has(key)) {
          errors.push({ code: "duplicate-external-key", path: filePath, message: `External key also appears in ${externalKeys.get(key)}.` });
        } else {
          externalKeys.set(key, filePath);
        }
      }
    }
  }

  for (const { filePath, record } of entries) {
    if (record?.kind !== "personal_ticket") continue;
    for (const projectRef of record.project_refs ?? []) {
      if (!projects.has(projectRef)) {
        errors.push({ code: "missing-project-ref", path: filePath, message: `Project ${projectRef} does not resolve.` });
      }
    }
  }

  return errors;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function verifyContractFixtures(contractRoot = DEFAULT_CONTRACT_ROOT) {
  const fixturesRoot = path.join(contractRoot, "fixtures");
  const contractsRoot = path.join(contractRoot, "contracts");
  const manifest = loadJson(path.join(fixturesRoot, "manifest.json"));
  const failures = [];

  for (const fixture of manifest.structural_valid) {
    const filePath = path.join(fixturesRoot, fixture.path);
    const errors = validateSchema(parseRecord(filePath), loadJson(path.join(contractsRoot, fixture.schema)));
    if (errors.length > 0) failures.push({ fixture: fixture.path, expected: "valid", errors });
  }

  for (const fixture of manifest.structural_invalid) {
    const filePath = path.join(fixturesRoot, fixture.path);
    const errors = validateSchema(parseRecord(filePath), loadJson(path.join(contractsRoot, fixture.schema)));
    if (!errors.some((error) => error.code === fixture.expected_code)) {
      failures.push({ fixture: fixture.path, expected: fixture.expected_code, errors });
    }
  }

  for (const fixture of manifest.semantic_invalid) {
    const errors = validateSemantics(fixture.paths.map((relativePath) => path.join(fixturesRoot, relativePath)));
    if (!errors.some((error) => error.code === fixture.expected_code)) {
      failures.push({ fixture: fixture.paths, expected: fixture.expected_code, errors });
    }
  }

  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = verifyContractFixtures(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_CONTRACT_ROOT);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
}
