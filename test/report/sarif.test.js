import { test } from "node:test";
import assert from "node:assert/strict";

import { formatSarif } from "../../build/report/sarif.js";

/** Build a PreflightReport from a list of results (summary derived). */
function report(results) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const r of results) summary[r.status] += 1;
  return { ok: summary.fail === 0, results, summary };
}

const MIXED = report([
  { name: "instanceUrlConfigured", status: "pass", message: "URL ok" },
  { name: "authResolves", status: "warn", message: "using basic auth" },
  { name: "updateSetOpen", status: "fail", message: "no open update set" },
  { name: "scopeExists", status: "fail", message: "scope not found" },
]);

test("formatSarif returns a valid SARIF 2.1.0 log skeleton", () => {
  const log = JSON.parse(formatSarif(MIXED));

  assert.equal(log.version, "2.1.0");
  assert.equal(typeof log.$schema, "string");
  assert.match(log.$schema, /sarif-schema-2\.1\.0\.json$/);
  assert.ok(Array.isArray(log.runs));
  assert.equal(log.runs.length, 1);

  const [run] = log.runs;
  assert.equal(run.tool.driver.name, "servicenow-preflight");
  assert.ok(Array.isArray(run.results));
});

test("formatSarif emits one result per non-pass check (pass omitted)", () => {
  const { runs } = JSON.parse(formatSarif(MIXED));
  const { results } = runs[0];

  // 1 warn + 2 fail = 3; the single pass is dropped.
  assert.equal(results.length, 3);
  assert.ok(
    results.every((r) => r.ruleId !== "instanceUrlConfigured"),
    "passing check must not appear in results[]",
  );
});

test("formatSarif maps fail -> error and warn -> warning", () => {
  const { runs } = JSON.parse(formatSarif(MIXED));
  const byRule = Object.fromEntries(runs[0].results.map((r) => [r.ruleId, r]));

  assert.equal(byRule.authResolves.level, "warning");
  assert.equal(byRule.updateSetOpen.level, "error");
  assert.equal(byRule.scopeExists.level, "error");
});

test("formatSarif carries ruleId (check name) and message.text (check message)", () => {
  const { runs } = JSON.parse(formatSarif(MIXED));
  const result = runs[0].results.find((r) => r.ruleId === "updateSetOpen");

  assert.ok(result, "expected a result for the failing check");
  assert.equal(result.ruleId, "updateSetOpen");
  assert.equal(result.message.text, "no open update set");
});

test("formatSarif advertises one driver rule per distinct non-pass check", () => {
  const { runs } = JSON.parse(formatSarif(MIXED));
  const rules = runs[0].tool.driver.rules;

  assert.ok(Array.isArray(rules), "driver.rules must be an array");
  const ids = rules.map((r) => r.id);
  // 1 warn + 2 fail = 3 distinct rule ids; the pass check is not advertised.
  assert.deepEqual(ids, ["authResolves", "updateSetOpen", "scopeExists"]);
  assert.ok(!ids.includes("instanceUrlConfigured"));
});

test("formatSarif de-duplicates driver rules by check name", () => {
  const dup = report([
    { name: "atfRun", status: "fail", message: "suite A red" },
    { name: "atfRun", status: "fail", message: "suite B red" },
  ]);
  const { runs } = JSON.parse(formatSarif(dup));

  // Two results, but a single rule descriptor for the shared ruleId.
  assert.equal(runs[0].results.length, 2);
  assert.deepEqual(
    runs[0].tool.driver.rules.map((r) => r.id),
    ["atfRun"],
  );
});

test("formatSarif gives every result a well-formed physical location", () => {
  const { runs } = JSON.parse(formatSarif(MIXED));
  for (const result of runs[0].results) {
    assert.ok(Array.isArray(result.locations), "result.locations must exist");
    assert.equal(result.locations.length, 1);
    const uri = result.locations[0].physicalLocation.artifactLocation.uri;
    assert.equal(typeof uri, "string");
    assert.ok(uri.length > 0);
  }
});

test("formatSarif produces an empty results[] when all checks pass", () => {
  const allPass = report([
    { name: "a", status: "pass", message: "ok" },
    { name: "b", status: "pass", message: "ok" },
  ]);
  const { runs } = JSON.parse(formatSarif(allPass));

  assert.deepEqual(runs[0].results, []);
});

test("formatSarif returns syntactically valid, pretty-printed JSON", () => {
  const out = formatSarif(MIXED);

  assert.doesNotThrow(() => JSON.parse(out));
  // Pretty-printed (2-space indent) => contains newlines.
  assert.ok(out.includes("\n"));
});
