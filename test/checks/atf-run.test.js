import { test } from "node:test";
import assert from "node:assert/strict";

import { atfRun } from "../../build/checks/atf-run.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";

/** Build a context around a fake client with the given fixtures + options. */
function ctx({ fixtures = {}, options } = {}) {
  return {
    instanceUrl: INSTANCE,
    http: createFakeSnClient(fixtures),
    options,
  };
}

test("atfRun name is stable", () => {
  assert.equal(atfRun.name, "atf-run");
});

test("warns when no ATF suite is configured", async () => {
  const result = await atfRun.run(ctx());
  assert.equal(result.name, "atf-run");
  assert.equal(result.status, "warn");
  assert.match(result.message, /no atf suite configured/i);
});

test("passes when the suite settles green with no red tests", async () => {
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: {
        cicd: {
          runTestSuite: { status: "success", resultId: "run-1" },
        },
        tables: {
          sys_atf_test_result: [
            { sys_id: "t1", test: "Create incident", status: "success" },
            { sys_id: "t2", test: "Close incident", status: "success" },
          ],
        },
      },
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /all atf tests passed/i);
});

test("passes when the suite reports no per-test rows", async () => {
  // A green suite run with an empty result table should still pass.
  const result = await atfRun.run(
    ctx({
      options: { atfSuites: ["suite-1"] },
      fixtures: {
        cicd: { runTestSuite: { status: "success", resultId: "run-empty" } },
        tables: { sys_atf_test_result: [] },
      },
    }),
  );
  assert.equal(result.status, "pass");
});

test("fails and carries the failing assertion text when a test is red", async () => {
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: {
        cicd: {
          runTestSuite: { status: "success", resultId: "run-1" },
        },
        tables: {
          sys_atf_test_result: [
            { sys_id: "t1", test: "Create incident", status: "success" },
            {
              sys_id: "t2",
              test: "Assert field value",
              status: "failure",
              output: "Expected 'closed' but was 'open'",
            },
          ],
        },
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 atf test/i);
  assert.match(result.message, /Assert field value/);
  // The failing assertion detail must be carried through.
  assert.match(result.message, /Expected 'closed' but was 'open'/);
});

test("treats an 'error' status test as red (fail)", async () => {
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: {
        cicd: {
          runTestSuite: { status: "success", resultId: "run-1" },
        },
        tables: {
          sys_atf_test_result: [
            {
              sys_id: "t1",
              test: "Run script step",
              status: "error",
              output: "TypeError: x is not a function",
            },
          ],
        },
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /TypeError: x is not a function/);
});

test("fails a suite that settled red even with no per-test rows to scope", async () => {
  // A failed terminal status must never be masked as a pass just because we
  // could not enumerate its per-test rows (e.g. no result id was exposed).
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: {
        cicd: { runTestSuite: { status: "failure" } },
        tables: { sys_atf_test_result: [] },
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /suite suite-1/);
});

test("warns when the run is still pending", async () => {
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: {
        cicd: { runTestSuite: { status: "pending" } },
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /pending/i);
});

test("evaluates every suite in a multi-suite list; one red => fail", async () => {
  // queryFilter lets us return per-suite rows keyed off the scoped query.
  const rowsBySuite = {
    "run-1": [{ sys_id: "a", test: "T1", status: "success" }],
    "run-2": [{ sys_id: "b", test: "T2", status: "failure", output: "boom" }],
  };
  const result = await atfRun.run({
    instanceUrl: INSTANCE,
    options: { atfSuites: ["suite-1", "suite-2"] },
    http: createFakeSnClient({
      cicd: {
        runTestSuite: {
          "suite-1": { status: "success", resultId: "run-1" },
          "suite-2": { status: "success", resultId: "run-2" },
        },
      },
      tables: {
        sys_atf_test_result: [...rowsBySuite["run-1"], ...rowsBySuite["run-2"]],
      },
      queryFilter: (table, rows, params) => {
        const q = params?.sysparm_query ?? "";
        const match = q.match(/test_suite_result=(\S+)/);
        const runId = match ? match[1] : undefined;
        return runId && rowsBySuite[runId] ? rowsBySuite[runId] : rows;
      },
    }),
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /boom/);
});

test("passes when every suite in a multi-suite list is green", async () => {
  const result = await atfRun.run({
    instanceUrl: INSTANCE,
    options: { atfSuites: ["suite-1", "suite-2"] },
    http: createFakeSnClient({
      cicd: {
        runTestSuite: {
          "suite-1": { status: "success", resultId: "run-1" },
          "suite-2": { status: "success", resultId: "run-2" },
        },
      },
      tables: {
        sys_atf_test_result: [{ sys_id: "a", test: "T1", status: "success" }],
      },
    }),
  });
  assert.equal(result.status, "pass");
  assert.match(result.message, /2 suite/);
});

test("fails on an auth error from the CI/CD API", async () => {
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: { fail: { cicd: { auth: true } } },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication failed/i);
});

test("warns on a network error (advisory / degraded)", async () => {
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: { fail: { cicd: { network: true } } },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /could not reach/i);
});

test("fails on an HTTP error from the CI/CD API", async () => {
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: { fail: { cicd: { http: 500 } } },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /HTTP 500/);
});

test("derives the suite sys_ids from ctx.manifest when no suite is configured", async () => {
  // No options.atfSuites/atfSuiteId — the suites come from the resolved
  // instance manifest, using *that instance's* sys_ids.
  const result = await atfRun.run({
    instanceUrl: INSTANCE,
    manifest: {
      instance: "dev",
      tests: [],
      suites: [
        { id: "x_acme_app/smoke", sysId: "su1", name: "Smoke", testIds: [] },
        {
          id: "x_acme_app/regression",
          sysId: "su2",
          name: "Regression",
          testIds: [],
        },
      ],
    },
    http: createFakeSnClient({
      cicd: { runTestSuite: { status: "success" } },
      tables: { sys_atf_test_result: [] },
    }),
  });
  assert.equal(result.status, "pass");
  assert.match(result.message, /2 suite/);
});

test("narrows the manifest suites by options.atfSuiteNames (logical id or name)", async () => {
  const result = await atfRun.run({
    instanceUrl: INSTANCE,
    options: { atfSuiteNames: ["x_acme_app/smoke"] },
    manifest: {
      instance: "dev",
      tests: [],
      suites: [
        { id: "x_acme_app/smoke", sysId: "su1", name: "Smoke", testIds: [] },
        {
          id: "x_acme_app/regression",
          sysId: "su2",
          name: "Regression",
          testIds: [],
        },
      ],
    },
    http: createFakeSnClient({
      cicd: { runTestSuite: { status: "success" } },
      tables: { sys_atf_test_result: [] },
    }),
  });
  assert.equal(result.status, "pass");
  // Only the one selected suite ran.
  assert.match(result.message, /1 suite/);
});

test("skips manifest suites that have no sys_id", async () => {
  const result = await atfRun.run({
    instanceUrl: INSTANCE,
    manifest: {
      instance: "dev",
      tests: [],
      suites: [{ id: "x_acme_app/smoke", name: "Smoke", testIds: [] }],
    },
    http: createFakeSnClient(),
  });
  // No runnable suite id → the same "no suite configured" warning.
  assert.equal(result.status, "warn");
  assert.match(result.message, /no atf suite configured/i);
});

test("explicit options.atfSuiteId wins over the manifest suites", async () => {
  const result = await atfRun.run({
    instanceUrl: INSTANCE,
    options: { atfSuiteId: "explicit-suite" },
    manifest: {
      instance: "dev",
      tests: [],
      suites: [
        { id: "x_acme_app/smoke", sysId: "su1", name: "Smoke", testIds: [] },
      ],
    },
    http: createFakeSnClient({
      cicd: {
        runTestSuite: {
          "explicit-suite": { status: "success", resultId: "run-x" },
          // If the manifest suite were (wrongly) chosen, it would fail the run.
          su1: { status: "failure" },
        },
      },
      tables: { sys_atf_test_result: [] },
    }),
  });
  // The explicit suite resolved (mapped success), not the manifest's failing su1.
  assert.equal(result.status, "pass");
  assert.match(result.message, /1 suite/);
});

test("never throws — always returns a well-formed CheckResult", async () => {
  const result = await atfRun.run(
    ctx({
      options: { atfSuiteId: "suite-1" },
      fixtures: { fail: { cicd: { http: 500 } } },
    }),
  );
  assert.equal(typeof result.name, "string");
  assert.ok(["pass", "warn", "fail"].includes(result.status));
  assert.equal(typeof result.message, "string");
});
