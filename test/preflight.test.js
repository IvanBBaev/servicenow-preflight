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

test("instanceUrlConfigured fails on a malformed URL", async () => {
  // A bare hostname with no scheme is the realistic paste-o: `new URL` throws,
  // and the check must surface that as a fail that echoes the offending value.
  const result = await instanceUrlConfigured.run(
    ctx({ instanceUrl: "dev12345.service-now.com" }),
  );
  assert.equal(result.name, "instance-url-configured");
  assert.equal(result.status, "fail");
  assert.match(result.message, /not a valid URL/);
  assert.match(result.message, /dev12345\.service-now\.com/);
});

test("instanceUrlConfigured fails closed on every unparseable URL shape", async () => {
  // Fail-closed doctrine: an unparseable target must never warn or pass its way
  // through, whatever shape the garbage takes. Notably it must not be mistaken
  // for the empty-URL case, nor fall through to the non-https warn.
  const malformed = [
    "not a url",
    "https://",
    "://dev12345.service-now.com",
    "ht!tp://dev12345.service-now.com",
    "  dev12345.service-now.com  ",
  ];
  for (const instanceUrl of malformed) {
    const result = await instanceUrlConfigured.run(ctx({ instanceUrl }));
    assert.equal(result.status, "fail", `expected fail for ${instanceUrl}`);
    assert.match(result.message, /not a valid URL/);
  }
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

test("runPreflight fails closed when the instance URL is unparseable", async () => {
  // End-to-end pin: the malformed-URL fail must propagate to report.ok, so a
  // typo'd target can never be reported as a clean run.
  const report = await runPreflight(
    ctx({
      instanceUrl: "dev12345.service-now.com",
      select: { only: [instanceUrlConfigured.name] },
    }),
  );
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.summary.pass, 0);
  assert.equal(report.summary.warn, 0);
  assert.equal(report.results[0].status, "fail");
  assert.match(report.results[0].message, /not a valid URL/);
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

// --- coerceResult: a bad check return must fail only that check ---------

test("runPreflight treats a check returning null as fail without taking down other checks", async () => {
  const returnsNull = {
    name: "returns-null",
    description: "returns null instead of a CheckResult",
    run() {
      return null;
    },
  };
  const passing = {
    name: "passing-check",
    description: "always passes",
    run() {
      return { name: "passing-check", status: "pass", message: "ok" };
    },
  };
  const report = await runPreflight(ctx(), [returnsNull, passing]);
  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["returns-null"].status, "fail");
  assert.match(byName["returns-null"].message, /returned null/);
  assert.match(byName["returns-null"].message, /treated as fail/);
  // The bad return took down only its own check: the well-behaved check next
  // to it still produced its normal result, and the run itself did not reject.
  assert.equal(byName["passing-check"].status, "pass");
  assert.equal(byName["passing-check"].message, "ok");
  assert.equal(report.results.length, 2);
});

test("runPreflight treats a check returning a primitive as fail, naming the type", async () => {
  const returnsString = {
    name: "returns-string",
    description: "returns a bare string instead of a CheckResult",
    run() {
      return "not a result";
    },
  };
  const returnsUndefined = {
    name: "returns-undefined",
    description: "returns undefined instead of a CheckResult",
    run() {
      return undefined;
    },
  };
  const report = await runPreflight(ctx(), [returnsString, returnsUndefined]);
  assert.equal(report.ok, false);
  const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
  assert.equal(byName["returns-string"].status, "fail");
  assert.match(byName["returns-string"].message, /returned a string/);
  assert.match(byName["returns-string"].message, /treated as fail/);
  assert.equal(byName["returns-undefined"].status, "fail");
  assert.match(byName["returns-undefined"].message, /returned undefined/);
  assert.match(byName["returns-undefined"].message, /treated as fail/);
});

test("runPreflight falls back to the producing check's name when the returned object lacks one", async () => {
  const nameless = {
    name: "nameless-result-check",
    description: "returns an object with no `name` field",
    run() {
      return { status: "pass", message: "looks fine, forgot my name" };
    },
  };
  const report = await runPreflight(ctx(), [nameless]);
  // coerceResult only fills in the missing `name`; it leaves `status` alone,
  // and here it is a valid status, so the summariser counts it as a pass.
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, "nameless-result-check");
  assert.equal(report.results[0].status, "pass");
  assert.equal(report.results[0].message, "looks fine, forgot my name");
  assert.equal(report.ok, true);
  assert.equal(report.summary.pass, 1);
  assert.equal(report.summary.fail, 0);
});

test("SnTruncationError is re-exported from the package root (WP-A extra)", () => {
  assert.equal(typeof SnTruncationError, "function");
  const err = new SnTruncationError("hit the cap", 10000);
  assert.ok(err instanceof SnError);
  assert.ok(err instanceof Error);
  assert.equal(err.cap, 10000);
  assert.equal(err.name, "SnTruncationError");
});
