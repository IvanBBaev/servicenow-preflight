import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  REPORT_SCHEMA_VERSION,
  formatJson,
  toEnvelope,
} from "../../build/api/report.js";
import { makeFinding, runPreflight } from "../../build/index.js";
import { reportUrl } from "../../build/report/json.js";
import { createFakeSnClient } from "../../build/http/fake.js";
import {
  CONFIG_SCHEMA_FILE,
  SCHEMAS,
  renderConfigSchemaText,
  renderSchema,
} from "../../scripts/gen-schema.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts", "gen-schema.mjs");
const BIN = join(ROOT, "bin", "servicenow-preflight.cjs");
const NOW = new Date("2026-10-24T08:00:00.000Z");

const PASSING = {
  ok: true,
  results: [{ name: "a", status: "pass", message: "fine" }],
  summary: { pass: 1, warn: 0, fail: 0 },
};
const FAILING = {
  ok: false,
  results: [{ name: "b", status: "fail", message: "bad" }],
  summary: { pass: 0, warn: 0, fail: 1 },
};

function loadSchema(file) {
  return JSON.parse(readFileSync(join(ROOT, "schemas", file), "utf8"));
}

/**
 * A minimal validator for the schema subset the generator emits: type,
 * properties, required, items, enum, const and local `$ref`s. Returns the list
 * of violations (empty when valid).
 */
function validate(schema, value, root = schema, path = "$") {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    return validate(root.$defs[name], value, root, path);
  }
  const errors = [];
  if ("const" in schema && value !== schema.const) {
    errors.push(`${path}: expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  }
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [...errors, `${path}: expected object`];
      }
      for (const key of schema.required ?? []) {
        if (!(key in value)) errors.push(`${path}.${key}: required`);
      }
      for (const [key, sub] of Object.entries(schema.properties ?? {})) {
        if (key in value) {
          errors.push(...validate(sub, value[key], root, `${path}.${key}`));
        }
      }
      break;
    }
    case "array":
      if (!Array.isArray(value)) return [...errors, `${path}: expected array`];
      value.forEach((item, i) => {
        errors.push(...validate(schema.items, item, root, `${path}[${i}]`));
      });
      break;
    case "string":
    case "number":
    case "boolean":
      if (typeof value !== schema.type) {
        errors.push(`${path}: expected ${schema.type}`);
      }
      break;
    default:
      break;
  }
  return errors;
}

test("toEnvelope builds the versioned shape for one run", () => {
  const env = toEnvelope(
    [{ instance: "dev", url: "https://x.service-now.com", report: PASSING }],
    {
      version: "9.9.9",
      now: NOW,
    },
  );
  assert.equal(REPORT_SCHEMA_VERSION, 1);
  assert.deepEqual(env, {
    schemaVersion: 1,
    tool: { name: "servicenow-preflight", version: "9.9.9" },
    generatedAt: "2026-10-24T08:00:00.000Z",
    ok: true,
    runs: [
      { instance: "dev", url: "https://x.service-now.com", report: PASSING },
    ],
  });
});

test("toEnvelope is ok only when every run is ok, and omits absent fields", () => {
  const env = toEnvelope([{ report: PASSING }, { report: FAILING }], {
    version: "1.0.0",
    now: NOW,
  });
  assert.equal(env.ok, false);
  assert.deepEqual(Object.keys(env.runs[0]), ["report"]);
});

test("reportUrl keeps only the origin and drops unparseable URLs", () => {
  assert.equal(
    reportUrl("https://user:pw@dev.service-now.com/path?q=1"),
    "https://dev.service-now.com",
  );
  assert.equal(reportUrl("not a url"), undefined);
  assert.equal(reportUrl("mailto:someone"), undefined);
  assert.equal(reportUrl(undefined), undefined);
  const env = toEnvelope([{ url: "nope", report: PASSING }], {
    version: "1",
    now: NOW,
  });
  assert.equal(Object.hasOwn(env.runs[0], "url"), false);
});

test("formatJson pretty-prints with a trailing newline", () => {
  const text = formatJson(
    toEnvelope([{ report: PASSING }], { version: "1", now: NOW }),
  );
  assert.ok(text.endsWith("}\n"));
  assert.equal(JSON.parse(text).schemaVersion, 1);
});

test("an envelope with findings and synthetic rows validates against report.v1.json", async () => {
  const check = {
    name: "with-findings",
    description: "emits findings",
    run: () => ({
      name: "with-findings",
      status: "warn",
      message: "two hits",
      findings: [
        makeFinding("with-findings", "k", "one", {
          table: "sys_script",
          sysId: "abc",
          line: 3,
        }),
        makeFinding("with-findings", "k", "two", { logicalId: "x" }, "warn"),
      ],
    }),
  };
  const report = await runPreflight({ http: createFakeSnClient() }, [check]);
  const dup = await runPreflight({ http: createFakeSnClient() }, [
    check,
    check,
  ]);
  const env = toEnvelope(
    [
      { instance: "dev", url: "https://dev.service-now.com", report },
      { instance: "prod", report: dup },
    ],
    { version: "1.0.0", now: NOW },
  );
  const schema = loadSchema("report.v1.json");
  assert.deepEqual(validate(schema, JSON.parse(formatJson(env))), []);
  assert.deepEqual(
    validate(loadSchema("finding.v1.json"), report.results[0].findings[0]),
    [],
  );
});

test("the validator rejects a malformed envelope", () => {
  const schema = loadSchema("report.v1.json");
  const bad = {
    schemaVersion: 2,
    tool: { name: "servicenow-preflight" },
    ok: "yes",
    runs: [{ report: { ok: true, results: [{ name: "a", status: "meh" }] } }],
  };
  const errors = validate(schema, bad);
  for (const expected of [
    "$.schemaVersion",
    "$.tool.version: required",
    "$.generatedAt: required",
    "$.ok: expected boolean",
    "$.runs[0].report.summary: required",
    "$.runs[0].report.results[0].status",
    "$.runs[0].report.results[0].message: required",
  ]) {
    assert.ok(
      errors.some((e) => e.startsWith(expected)),
      `missing ${expected} in ${errors.join("; ")}`,
    );
  }
});

test("CLI --format json prints a schema-valid envelope (single, no registry)", () => {
  const res = spawnSync(
    process.execPath,
    [
      BIN,
      "--only",
      "instance-url-configured",
      "--instance",
      "https://dev1.service-now.com",
      "--format",
      "json",
    ],
    { cwd: tmpdir(), encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(res.status, 0, res.stderr);
  const env = JSON.parse(res.stdout);
  assert.deepEqual(validate(loadSchema("report.v1.json"), env), []);
  assert.equal(env.runs.length, 1);
  assert.equal(env.runs[0].url, "https://dev1.service-now.com");
  assert.equal(Object.hasOwn(env.runs[0], "instance"), false);
  assert.match(env.tool.version, /^\d+\.\d+\.\d+/);
});

test("CLI run <env> --format json records the instance name", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-json-"));
  try {
    const preflight = join(dir, ".preflight");
    mkdirSync(preflight);
    writeFileSync(
      join(preflight, "instances.json"),
      JSON.stringify({
        version: 1,
        instances: { dev: { url: "https://dev2.service-now.com" } },
      }),
    );
    const res = spawnSync(
      process.execPath,
      [BIN, "run", "dev", "--only", "instance-url-configured", "--json"],
      { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    assert.equal(res.status, 0, res.stderr);
    const env = JSON.parse(res.stdout);
    assert.equal(env.runs[0].instance, "dev");
    assert.equal(env.runs[0].url, "https://dev2.service-now.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the committed schemas match the generator (no drift)", async () => {
  const files = [
    ...SCHEMAS.map((spec) => [spec.file, renderSchema(spec)]),
    [CONFIG_SCHEMA_FILE, await renderConfigSchemaText()],
  ];
  for (const [file, fresh] of files) {
    for (const dir of ["schemas", join("site", "schemas")]) {
      const committed = readFileSync(join(ROOT, dir, file), "utf8");
      assert.equal(committed, fresh, `${dir}/${file} is stale`);
    }
  }
});

test("gen-schema --check detects a missing or stale schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-gen-schema-"));
  try {
    const run = (...args) =>
      spawnSync(process.execPath, [SCRIPT, "--out", dir, ...args], {
        encoding: "utf8",
      });
    assert.equal(run("--check").status, 1);
    assert.equal(run().status, 0);
    assert.equal(run("--check").status, 0);
    const file = join(dir, "report.v1.json");
    writeFileSync(file, readFileSync(file, "utf8").replace('"ok"', '"okay"'));
    const stale = run("--check");
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /npm run gen:schema/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("package.json exports and ships the schemas", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  for (const file of [...SCHEMAS.map((s) => s.file), CONFIG_SCHEMA_FILE]) {
    assert.equal(pkg.exports[`./schemas/${file}`], `./schemas/${file}`);
  }
  assert.ok(pkg.files.includes("schemas"));
});
