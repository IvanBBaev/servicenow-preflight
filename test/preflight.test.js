import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runPreflight,
  instanceUrlConfigured,
  defaultChecks,
} from "../build/index.js";

test("instanceUrlConfigured fails when no URL is given", async () => {
  const result = await instanceUrlConfigured.run({});
  assert.equal(result.status, "fail");
});

test("instanceUrlConfigured warns on a non-https URL", async () => {
  const result = await instanceUrlConfigured.run({
    instanceUrl: "http://dev12345.service-now.com",
  });
  assert.equal(result.status, "warn");
});

test("instanceUrlConfigured passes on a valid https URL", async () => {
  const result = await instanceUrlConfigured.run({
    instanceUrl: "https://dev12345.service-now.com",
  });
  assert.equal(result.status, "pass");
});

test("runPreflight aggregates results and reports failure", async () => {
  const report = await runPreflight({});
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results.length, defaultChecks.length);
});

test("runPreflight succeeds when every check passes", async () => {
  const report = await runPreflight({
    instanceUrl: "https://dev12345.service-now.com",
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.pass, 1);
});
