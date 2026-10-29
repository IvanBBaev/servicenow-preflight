import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultChecks, testDrift } from "../build/checks/index.js";
import {
  CONFIG_SCHEMA_ID,
  declaredOptions,
  describeIssue,
  renderConfigSchema,
  validateConfig,
} from "../build/options/config-schema.js";
import { migrateConfig, unifiedDiff } from "../build/options/migrate.js";

const ALL = [...defaultChecks, testDrift];
const problems = (config) => validateConfig(config, ALL).map(describeIssue);

test("every check that reads ctx.options declares an options schema", () => {
  const declared = ALL.filter((c) => c.optionsSchema).map((c) => c.name);
  assert.deepEqual(declared.sort(), [
    "atf-enablement",
    "atf-run",
    "i18n-completeness",
    "platform-release",
    "scoped-app-deps",
  ]);
  assert.deepEqual(Object.keys(declaredOptions(ALL)).sort(), [
    "atfEnablement",
    "atfSuiteId",
    "atfSuiteNames",
    "atfSuites",
    "baseLanguage",
    "languages",
    "platform",
    "requiredApps",
  ]);
});

test("a well-formed config has no issues", () => {
  assert.deepEqual(
    problems({
      $schema:
        "./node_modules/servicenow-preflight/schemas/preflight.config.v1.json",
      instanceUrl: "https://dev1.service-now.com",
      select: { only: ["atf-run"] },
      options: { languages: "fr,de", atfSuites: ["Smoke"] },
      checks: {
        "scoped-app-deps": {
          requiredApps: [{ id: "x_app", minVersion: "1.2" }],
        },
        "atf-enablement": { atfEnablement: { requireClientTestRunner: true } },
        "acl-out-of-scope": { anything: 1 },
      },
      baseline: true,
      severity: { "atf-run": "warn" },
      failOn: "warn",
    }),
    [],
  );
});

test("issues carry dotted paths and did-you-mean hints", () => {
  assert.deepEqual(
    problems({
      instanceURL: "https://x",
      options: { langauges: ["fr"], requiredApps: [{ id: "" }] },
      checks: {
        "atf-run": { atfSuiteID: "x" },
        "scoped-app-dep": {},
      },
      severity: { "atf-run": "error" },
      baseline: "",
    }),
    [
      "checks.atf-run.atfSuiteID: unknown key (did you mean atfSuiteId, atfSuites?)",
      "checks.scoped-app-dep: unknown key (did you mean scoped-app-deps?)",
      'options.requiredApps[0].id: expected non-empty string, got ""',
      "options.langauges: unknown key (did you mean languages?)",
      'baseline: expected boolean or non-empty string, got ""',
      'severity.atf-run: expected one of "fail", "warn", "off", got "error"',
      "instanceURL: unknown key (did you mean instanceUrl?)",
    ],
  );
});

test("the rendered schema is a closed draft 2020-12 document", () => {
  const schema = renderConfigSchema(ALL);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, CONFIG_SCHEMA_ID);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.$schema, {});
  const perCheck = schema.properties.checks.properties;
  assert.deepEqual(Object.keys(perCheck).sort(), ALL.map((c) => c.name).sort());
  const deps = perCheck["scoped-app-deps"];
  assert.equal(deps.additionalProperties, false);
  assert.match(deps.description, /dependencies/);
  assert.deepEqual(deps.properties.requiredApps.items.required, ["id"]);
  // A check without a schema accepts any keys.
  assert.deepEqual(perCheck["acl-out-of-scope"].additionalProperties, {});
  assert.equal(schema.properties.options.additionalProperties, false);
});

test("migrate moves declared options into every owning check", () => {
  const raw = {
    instanceUrl: "https://x",
    options: { atfSuites: ["Smoke"], requiredApps: [{ id: "a" }], custom: 1 },
    checks: { "atf-run": { atfSuites: ["Own"] } },
  };
  const { config, moved, changed } = migrateConfig(raw, ALL);
  assert.equal(changed, true);
  assert.deepEqual(moved, {
    // Registry order.
    atfSuites: ALL.map((c) => c.name).filter((n) => n.startsWith("atf-")),
    requiredApps: ["scoped-app-deps"],
  });
  assert.deepEqual(config.options, { custom: 1 });
  // An existing per-check value wins over the shared one.
  assert.deepEqual(config.checks["atf-run"], { atfSuites: ["Own"] });
  assert.deepEqual(config.checks["atf-enablement"], { atfSuites: ["Smoke"] });
  assert.deepEqual(config.checks["scoped-app-deps"], {
    requiredApps: [{ id: "a" }],
  });
  // The input is untouched.
  assert.deepEqual(raw.options.atfSuites, ["Smoke"]);
});

test("migrate drops an emptied options block and is a no-op when done", () => {
  const first = migrateConfig({ options: { languages: "fr" } }, ALL);
  assert.deepEqual(first.config, {
    checks: { "i18n-completeness": { languages: "fr" } },
  });
  const again = migrateConfig(first.config, ALL);
  assert.equal(again.changed, false);
  assert.equal(migrateConfig({ options: { custom: 1 } }, ALL).changed, false);
  assert.equal(migrateConfig({}, ALL).changed, false);
});

test("unifiedDiff renders headers, hunks and context", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
  const after = ["a", "B", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join(
    "\n",
  );
  assert.equal(
    unifiedDiff("x.json", before, after),
    [
      "--- x.json",
      "+++ x.json (migrated)",
      "@@ -1,5 +1,5 @@",
      " a",
      "-b",
      "+B",
      " c",
      " d",
      " e",
      "@@ -8,3 +8,4 @@",
      " h",
      " i",
      " j",
      "+k",
      "",
    ].join("\n"),
  );
});
