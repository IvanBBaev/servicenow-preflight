import { test } from "node:test";
import assert from "node:assert/strict";

import { scheduledJobRunAs } from "../../build/checks/scheduled-job-run-as.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/** Assemble a fake client from Scheduled Job fixtures plus options. */
function makeHttp({ jobs = [], fail, totalCounts, referenceFields } = {}) {
  return createFakeSnClient({
    tables: { sysauto_script: jobs },
    totalCounts,
    referenceFields,
    fail,
  });
}

function run(http, extra = {}) {
  return scheduledJobRunAs.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

test("scheduled-job-run-as keeps its registered name", async () => {
  const result = await run(makeHttp());
  assert.equal(result.name, "scheduled-job-run-as");
});

test("warns when no scope is set", async () => {
  const result = await scheduledJobRunAs.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /scope/i);
});

test("warns (never passes) on an ambiguous zero-row read (SN-1)", async () => {
  const result = await run(makeHttp({ jobs: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /cannot confirm/i);
});

test("passes when the instance proves the scope ships no Scheduled Jobs", async () => {
  const result = await run(
    makeHttp({ jobs: [], totalCounts: { sysauto_script: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to check/i);
});

test("warns (advisory rule) on a security-trimmed zero-row read", async () => {
  const result = await run(
    makeHttp({ jobs: [], totalCounts: { sysauto_script: 3 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /\b3\b/);
});

test("warns when a job pins 'Run as' to a named user", async () => {
  const jobs = [
    { sys_id: "job1", name: "Nightly Cleanup", run_as: "" },
    {
      sys_id: "job2",
      name: "Data Sync",
      run_as: "6816f79cc0a8016401c5a33be04be441",
    },
  ];
  const result = await run(makeHttp({ jobs }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /Data Sync/);
  assert.doesNotMatch(result.message, /Nightly Cleanup/);
  assert.match(result.message, /Leave 'Run as' empty/);
});

test("unwraps a run_as delivered as a { link, value } reference", async () => {
  const jobs = [
    { sys_id: "job1", name: "Data Sync", run_as: { value: "abc123" } },
  ];
  const result = await run(
    makeHttp({ jobs, referenceFields: { sysauto_script: ["run_as"] } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Data Sync/);
});

test("a pinned job on a trimmed read still reports, with the incomplete note", async () => {
  const jobs = [{ sys_id: "job1", name: "Data Sync", run_as: "abc123" }];
  const result = await run(
    makeHttp({ jobs, totalCounts: { sysauto_script: 10 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Data Sync/);
  assert.match(result.message, /may be incomplete/i);
});

test("a clean-looking but trimmed read never passes", async () => {
  const jobs = [{ sys_id: "job1", name: "Nightly Cleanup", run_as: "" }];
  const result = await run(
    makeHttp({ jobs, totalCounts: { sysauto_script: 4 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /security-trimmed/i);
});

test("passes when every job leaves 'Run as' empty", async () => {
  const jobs = [
    { sys_id: "job1", name: "Nightly Cleanup", run_as: "" },
    { sys_id: "job2", name: "Data Sync", run_as: "" },
  ];
  const result = await run(makeHttp({ jobs }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /All 2 Scheduled Job/);
});

test("fails (not passes) when authentication is rejected", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication failed/i);
});

test("warns when the instance is unreachable", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /could not reach/i);
});

test("warns on an HTTP error from the table read", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sysauto_script: { http: 403 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /403/);
});
