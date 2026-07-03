import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runPreflight,
  selectChecks,
  instanceUrlConfigured,
  defaultChecks,
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
