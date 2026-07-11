import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runPreflight,
  selectChecks,
  instanceUrlConfigured,
  defaultChecks,
  SnError,
  SnTruncationError,
} from "../build/index.js";
import { createFakeSnClient } from "../build/http/fake.js";

/** A minimal context with the injected (fake) client every run requires. */
function ctx(extra = {}) {
  return { http: createFakeSnClient(), ...extra };
}

test("instanceUrlConfigured fails when no URL is given", async () => {
  const result = await instanceUrlConfigured.run(ctx());
  assert.equal(result.status, "fail");
});

test("instanceUrlConfigured warns on a non-https URL", async () => {
  const result = await instanceUrlConfigured.run(
    ctx({ instanceUrl: "http://dev12345.service-now.com" }),
  );
  assert.equal(result.status, "warn");
});

test("instanceUrlConfigured passes on a valid https URL", async () => {
  const result = await instanceUrlConfigured.run(
    ctx({ instanceUrl: "https://dev12345.service-now.com" }),
  );
  assert.equal(result.status, "pass");
});

test("runPreflight runs every default check and the summary totals match", async () => {
  const report = await runPreflight(ctx());
  // Check-agnostic: one result per default check, and the summary buckets
  // partition the results exactly.
  assert.equal(report.results.length, defaultChecks.length);
  const { pass, warn, fail } = report.summary;
  assert.equal(pass + warn + fail, report.results.length);
});

test("runPreflight reports ok:false when no instanceUrl is given", async () => {
  const report = await runPreflight(ctx());
  // With no instance URL, instanceUrlConfigured fails, so the run is not ok.
  assert.equal(report.ok, false);
  assert.ok(report.summary.fail >= 1);
});

test("runPreflight ok mirrors the absence of any fail", async () => {
  const report = await runPreflight(ctx());
  assert.equal(report.ok, report.summary.fail === 0);
});

test("selectChecks honours only / skip by check name", () => {
  const names = defaultChecks.map((c) => c.name);
  const only = selectChecks(defaultChecks, { only: [names[0]] });
  assert.deepEqual(
    only.map((c) => c.name),
    [names[0]],
  );

  const skipped = selectChecks(defaultChecks, { skip: [names[0]] });
  assert.ok(!skipped.some((c) => c.name === names[0]));
  assert.equal(skipped.length, defaultChecks.length - 1);
});

test("runPreflight applies ctx.select filtering", async () => {
  const report = await runPreflight(
    ctx({ select: { only: [instanceUrlConfigured.name] } }),
  );
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, instanceUrlConfigured.name);
});

// --- Fail-closed runner guarantees --------------------------------------

test("runPreflight fails closed when a selection matches no checks (vacuous guard)", async () => {
  // A non-empty default set narrowed to zero by `only` naming a check that does
  // not exist must not report a vacuous pass.
  const report = await runPreflight(
    ctx({ select: { only: ["no-such-check"] } }),
  );
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, "preflight");
  assert.match(report.results[0].message, /nothing was verified/i);
});

test("runPreflight with an explicit empty check list is not ok (CC-21)", async () => {
  const report = await runPreflight(ctx(), []);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, "preflight");
  assert.match(report.results[0].message, /nothing was verified/i);
});

test("runPreflight converts a throwing check into a fail result and continues (CC-5)", async () => {
  const throwing = {
    name: "throwing-check",
    description: "always throws an Error",
    run() {
      throw new Error("boom");
    },
  };
  const passing = {
    name: "passing-check",
    description: "always passes",
    run() {
      return { name: "passing-check", status: "pass", message: "ok" };
    },
  };
  const report = await runPreflight(ctx(), [throwing, passing]);
  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["throwing-check"].status, "fail");
  assert.match(byName["throwing-check"].message, /boom/);
  // The run continued: the check after the throwing one still ran and reported.
  assert.equal(byName["passing-check"].status, "pass");
  assert.equal(report.results.length, 2);
});

test("runPreflight handles a check that throws a non-Error value (CC-5)", async () => {
  const throwsString = {
    name: "throws-string",
    description: "throws a bare string",
    run() {
      throw "kaboom";
    },
  };
  const report = await runPreflight(ctx(), [throwsString]);
  assert.equal(report.ok, false);
  assert.equal(report.results[0].status, "fail");
  assert.match(report.results[0].message, /kaboom/);
});

test("runPreflight treats an unrecognised status as fail (CC-6, fail-closed)", async () => {
  const bogus = {
    name: "bogus-status",
    description: "returns a status outside pass/warn/fail",
    run() {
      return { name: "bogus-status", status: "error", message: "weird" };
    },
  };
  const report = await runPreflight(ctx(), [bogus]);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  // No NaN buckets: the summary partitions cleanly into integers.
  assert.ok(Number.isInteger(report.summary.pass));
  assert.ok(Number.isInteger(report.summary.warn));
  assert.ok(Number.isInteger(report.summary.fail));
  assert.equal(report.results[0].status, "fail");
  assert.match(report.results[0].message, /unrecognised status/i);
});

test("runPreflight rejects a check set with duplicate names (CC-46)", async () => {
  const first = {
    name: "dup",
    description: "first with this name",
    run() {
      return { name: "dup", status: "pass", message: "one" };
    },
  };
  const second = {
    name: "dup",
    description: "second with this name",
    run() {
      return { name: "dup", status: "pass", message: "two" };
    },
  };
  const report = await runPreflight(ctx(), [first, second]);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results[0].name, "preflight");
  assert.match(report.results[0].message, /[Dd]uplicate/);
  assert.match(report.results[0].message, /dup/);
});

test("SnTruncationError is re-exported from the package root (WP-A extra)", () => {
  assert.equal(typeof SnTruncationError, "function");
  const err = new SnTruncationError("hit the cap", 10000);
  assert.ok(err instanceof SnError);
  assert.ok(err instanceof Error);
  assert.equal(err.cap, 10000);
  assert.equal(err.name, "SnTruncationError");
});
