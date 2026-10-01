// QA-18 — the CI/CD (ATF) run lifecycle, in the shape `api/atf.ts` drives:
// POST /api/sn_cicd/testsuite/run?sys_id=... then GET /api/sn_cicd/progress/<id>.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { TERMINAL_CICD_STATES, createFakeInstance } from "../build/index.js";

const SUITE = "0000000000000000000000000000aaa1";

let fake;
beforeEach(() => {
  fake = createFakeInstance({
    state: {
      sys_atf_test_suite: [{ sys_id: SUITE, name: "persistent suite" }],
    },
  });
});

const startSuite = (params = {}) =>
  fake.handle({
    method: "POST",
    path: "/api/sn_cicd/testsuite/run",
    params: { sys_id: SUITE, ...params },
  });

const progress = (executionId) =>
  fake.handle({ method: "GET", path: `/api/sn_cicd/progress/${executionId}` });

describe("starting a run", () => {
  it("answers a pending progress payload with a progress link", async () => {
    const res = await startSuite();
    assert.equal(res.status, 200);
    const { result } = res.body;
    assert.equal(result.status, "0");
    assert.equal(result.status_label, "Pending");
    assert.equal(result.percent_complete, "0");
    assert.match(result.links.progress.id, /^[0-9a-f]{32}$/);
    assert.match(
      result.links.progress.url,
      /^https:\/\/[^/]+\/api\/sn_cicd\/progress\/[0-9a-f]{32}$/,
    );
    // Not terminal yet, so no results link.
    assert.equal(result.links.results, undefined);
  });

  it("accepts test_sys_id (api/atf.ts's runAtfTest)", async () => {
    const res = await fake.handle({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params: { test_sys_id: "bbb1" },
    });
    assert.equal(res.status, 200);
    assert.equal(fake.cicd.runs()[0].testSysId, "bbb1");
  });

  it("400s without sys_id or test_sys_id", async () => {
    const res = await fake.handle({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
    });
    assert.equal(res.status, 400);
  });

  it("405s on the wrong method", async () => {
    const res = await fake.handle({
      method: "GET",
      path: "/api/sn_cicd/testsuite/run",
      params: { sys_id: SUITE },
    });
    assert.equal(res.status, 405);
  });

  it("writes an instance-side suite-run row the sweep can query (DESIGN 4b)", async () => {
    await startSuite();
    const rows = fake.tables.all("sys_atf_test_suite_result");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].test_suite, SUITE);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].execution_id, fake.cicd.runs()[0].executionId);
  });

  it("mints deterministic execution ids", async () => {
    const first = (await startSuite()).body.result.links.progress.id;
    const other = createFakeInstance();
    const second = (
      await other.handle({
        method: "POST",
        path: "/api/sn_cicd/testsuite/run",
        params: { sys_id: SUITE },
      })
    ).body.result.links.progress.id;
    assert.equal(first, second);
  });
});

describe("polling to a terminal state", () => {
  it("walks pending -> running -> successful over the configured polls", async () => {
    const id = (await startSuite()).body.result.links.progress.id;

    const running = (await progress(id)).body.result;
    assert.equal(running.status_label, "Running");
    assert.equal(running.percent_complete, "50");
    assert.equal(running.links.results, undefined);

    const done = (await progress(id)).body.result;
    assert.equal(done.status, "2");
    assert.equal(done.status_label, "Successful");
    assert.equal(done.percent_complete, "100");
    assert.match(done.status_message, /successful/);
    assert.equal(typeof done.links.results.id, "string");
  });

  it("keeps answering the terminal payload once finished", async () => {
    const id = (await startSuite()).body.result.links.progress.id;
    await progress(id);
    await progress(id);
    const again = (await progress(id)).body.result;
    assert.equal(again.status_label, "Successful");
    const run = fake.cicd.peek(id);
    assert.equal(run.polls, 2);
    assert.ok(TERMINAL_CICD_STATES.has(run.state));
  });

  it("honours pollsToComplete", async () => {
    const slow = createFakeInstance({ cicd: { pollsToComplete: 4 } });
    const start = await slow.handle({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params: { sys_id: SUITE },
    });
    const id = start.body.result.links.progress.id;
    const labels = [];
    for (let i = 0; i < 4; i += 1) {
      labels.push(
        (
          await slow.handle({
            method: "GET",
            path: `/api/sn_cicd/progress/${id}`,
          })
        ).body.result.status_label,
      );
    }
    assert.deepEqual(labels, ["Running", "Running", "Running", "Successful"]);
  });

  it("reports the pinned outcome for a suite", async () => {
    fake.cicd.setOutcome(SUITE, "failed");
    const id = (await startSuite()).body.result.links.progress.id;
    await progress(id);
    const done = (await progress(id)).body.result;
    assert.equal(done.status, "3");
    assert.equal(done.status_label, "Failed");
  });

  it("mirrors every transition onto the suite-run row", async () => {
    const id = (await startSuite()).body.result.links.progress.id;
    const status = () => fake.tables.all("sys_atf_test_suite_result")[0].status;
    assert.equal(status(), "pending");
    await progress(id);
    assert.equal(status(), "running");
    await progress(id);
    assert.equal(status(), "successful");
    assert.notEqual(
      fake.tables.all("sys_atf_test_suite_result")[0].end_time,
      undefined,
    );
  });

  it("404s an unknown execution id without poisoning the namespace", async () => {
    const res = await progress("deadbeef");
    assert.equal(res.status, 404);
    // Must NOT be the namespace wording: api/plugin.ts would then cache
    // "CI/CD unavailable" for five minutes.
    assert.equal(res.body.error.message, "No Record found");
  });

  it("404s an unknown sn_cicd subpath the same way", async () => {
    const res = await fake.handle({
      method: "GET",
      path: "/api/sn_cicd/nonexistent/thing",
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.message, "No Record found");
  });
});

describe("cancelling", () => {
  it("forces a run terminal and updates the row", async () => {
    const id = (await startSuite()).body.result.links.progress.id;
    assert.equal(fake.cicd.cancel(id), true);
    assert.equal(
      fake.tables.all("sys_atf_test_suite_result")[0].status,
      "canceled",
    );
    const payload = (await progress(id)).body.result;
    assert.equal(payload.status, "4");
    assert.equal(payload.status_label, "Canceled");
  });

  it("refuses to cancel an unknown or already terminal run", async () => {
    assert.equal(fake.cicd.cancel("nope"), false);
    const id = (await startSuite()).body.result.links.progress.id;
    fake.cicd.cancel(id);
    assert.equal(fake.cicd.cancel(id), false);
  });
});

describe("run-id tagging (DESIGN 4a/4b)", () => {
  it("tags the run and its suite-run row, so the sweep can find them", async () => {
    await startSuite({ tessera_run_id: "RUN_DEAD" });
    assert.equal(fake.cicd.runs()[0].runId, "RUN_DEAD");
    const hits = fake.tables.recordsForRun("RUN_DEAD");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].table, "sys_atf_test_suite_result");
    // The persistent suite carries no tag and must stay out of the sweep.
    assert.equal(
      hits.some((hit) => hit.record.sys_id === SUITE),
      false,
    );
  });

  it("honours a custom runIdParam", async () => {
    const custom = createFakeInstance({ runIdParam: "x_run" });
    await custom.handle({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params: { sys_id: SUITE, x_run: "RUN9" },
    });
    assert.equal(custom.cicd.runs()[0].runId, "RUN9");
  });
});

describe("peek and clear", () => {
  it("peek reads without advancing the lifecycle", async () => {
    const id = (await startSuite()).body.result.links.progress.id;
    assert.equal(fake.cicd.peek(id).polls, 0);
    assert.equal(fake.cicd.peek(id).state, "pending");
    assert.equal(fake.cicd.peek("nope"), undefined);
  });

  it("clear drops every run", async () => {
    await startSuite();
    fake.cicd.clear();
    assert.deepEqual(fake.cicd.runs(), []);
  });
});

describe("per-test results linked to the execution (runner-atf F1)", () => {
  const finish = async (id) => {
    let payload;
    for (let i = 0; i < 5; i += 1) payload = (await progress(id)).body.result;
    return payload;
  };

  it("recordTestResult links the row to this run's suite-result row", async () => {
    const id = (await startSuite()).body.result.links.progress.id;
    const row = fake.cicd.recordTestResult(id, {
      test: "t1",
      status: "success",
      output: "ok",
    });
    const suiteResult = fake.tables.all("sys_atf_test_suite_result")[0];
    assert.equal(row.test_suite_result, suiteResult.sys_id);
    assert.equal(row.test, "t1");
    assert.equal(row.status, "success");
    assert.equal(row.output, "ok");
    const stored = fake.tables.all("sys_atf_test_result");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].test_suite_result, suiteResult.sys_id);
    // The join key is exactly what the terminal payload names.
    const payload = await finish(id);
    assert.equal(payload.links.results.id, stored[0].test_suite_result);
  });

  it("links each run's rows to its own suite-result row", async () => {
    const a = (await startSuite()).body.result.links.progress.id;
    const b = (await startSuite()).body.result.links.progress.id;
    const rowA = fake.cicd.recordTestResult(a, {
      test: "t",
      status: "success",
      output: "",
    });
    const rowB = fake.cicd.recordTestResult(b, {
      test: "t",
      status: "failure",
      output: "",
    });
    assert.equal(rowA.test_suite_result, fake.cicd.peek(a).resultSysId);
    assert.equal(rowB.test_suite_result, fake.cicd.peek(b).resultSysId);
    assert.notEqual(rowA.test_suite_result, rowB.test_suite_result);
  });

  it("throws for an unknown execution id and writes nothing", () => {
    assert.throws(
      () =>
        fake.cicd.recordTestResult("nope", {
          test: "t",
          status: "success",
          output: "",
        }),
      /no CI\/CD run with execution id nope/,
    );
    assert.deepEqual(fake.tables.all("sys_atf_test_result"), []);
  });
});

describe("nested child suites (wave 13)", () => {
  const readSuiteResults = (query) =>
    fake.handle({
      method: "GET",
      path: "/api/now/table/sys_atf_test_suite_result",
      params: { sysparm_query: query },
    });

  it("a parent= read of a run with no child suite returns nothing, not every root", async () => {
    // Root rows carry no `parent` key; without the declared column the
    // default "ignore" policy would drop the condition and answer every row.
    const id = (await startSuite()).body.result.links.progress.id;
    await startSuite();
    const root = fake.cicd.peek(id).resultSysId;
    const answer = await readSuiteResults(`parent=${root}`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.body.result, []);
    const inAnswer = await readSuiteResults(`parentIN${root},zzz`);
    assert.deepEqual(inAnswer.body.result, []);
  });

  it("recordChildSuiteResult links a child (and a grandchild) to its parent execution", async () => {
    const id = (await startSuite({ tessera_run_id: "run-9" })).body.result.links
      .progress.id;
    const root = fake.cicd.peek(id).resultSysId;
    const child = fake.cicd.recordChildSuiteResult(id, { suiteSysId: "c1" });
    const grandchild = fake.cicd.recordChildSuiteResult(id, {
      parent: child.sys_id,
    });
    assert.equal(child.parent, root);
    assert.equal(child.test_suite, "c1");
    assert.equal(child.run_id, "run-9");
    assert.equal(grandchild.parent, child.sys_id);
    const children = await readSuiteResults(`parent=${root}`);
    assert.deepEqual(
      children.body.result.map((row) => row.sys_id),
      [child.sys_id],
    );
    // The root row's own shape is unchanged: no `parent` key was added.
    assert.equal(
      Object.hasOwn(
        fake.tables.get("sys_atf_test_suite_result", root),
        "parent",
      ),
      false,
    );
  });

  it("recordTestResult can link a row to a child suite result of the same run", async () => {
    const id = (await startSuite()).body.result.links.progress.id;
    const child = fake.cicd.recordChildSuiteResult(id);
    const row = fake.cicd.recordTestResult(id, {
      test: "t",
      status: "success",
      output: "",
      suiteResultSysId: child.sys_id,
    });
    assert.equal(row.test_suite_result, child.sys_id);
  });

  it("refuses a parent or link outside the run, and an unknown execution", async () => {
    const a = (await startSuite()).body.result.links.progress.id;
    const b = (await startSuite()).body.result.links.progress.id;
    const foreign = fake.cicd.peek(b).resultSysId;
    const before = fake.tables.count("sys_atf_test_suite_result");
    assert.throws(
      () => fake.cicd.recordChildSuiteResult(a, { parent: foreign }),
      /is not a suite-result row of CI\/CD run/,
    );
    assert.throws(
      () =>
        fake.cicd.recordTestResult(a, {
          test: "t",
          status: "success",
          output: "",
          suiteResultSysId: foreign,
        }),
      /is not a suite-result row of CI\/CD run/,
    );
    assert.throws(
      () => fake.cicd.recordChildSuiteResult("nope"),
      /recordChildSuiteResult: no CI\/CD run with execution id nope/,
    );
    assert.equal(fake.tables.count("sys_atf_test_suite_result"), before);
    assert.deepEqual(fake.tables.all("sys_atf_test_result"), []);
  });

  it("keeps a caller's own tableSchema declaration for the suite-result table", async () => {
    const custom = createFakeInstance({
      tableSchema: { sys_atf_test_suite_result: ["label"], other: ["x"] },
    });
    custom.tables.insert("sys_atf_test_suite_result", { status: "done" });
    custom.tables.insert("other", { y: "1" });
    const byLabel = await custom.handle({
      method: "GET",
      path: "/api/now/table/sys_atf_test_suite_result",
      params: { sysparm_query: "label=nope" },
    });
    assert.deepEqual(byLabel.body.result, []);
    const byParent = await custom.handle({
      method: "GET",
      path: "/api/now/table/sys_atf_test_suite_result",
      params: { sysparm_query: "parent=nope" },
    });
    assert.deepEqual(byParent.body.result, []);
    const other = await custom.handle({
      method: "GET",
      path: "/api/now/table/other",
      params: { sysparm_query: "x=nope" },
    });
    assert.deepEqual(other.body.result, []);
  });
});

describe("terminal payload without links.results", () => {
  it("emitResultsLink: false omits it on every terminal payload", async () => {
    const bare = createFakeInstance({
      state: { sys_atf_test_suite: [{ sys_id: SUITE, name: "s" }] },
      cicd: { emitResultsLink: false },
    });
    const start = await bare.handle({
      method: "POST",
      path: "/api/sn_cicd/testsuite/run",
      params: { sys_id: SUITE },
    });
    const id = start.body.result.links.progress.id;
    let payload;
    for (let i = 0; i < 3; i += 1) {
      payload = (
        await bare.handle({
          method: "GET",
          path: `/api/sn_cicd/progress/${id}`,
        })
      ).body.result;
    }
    assert.equal(payload.status_label, "Successful");
    assert.equal(payload.links.progress.id, id);
    assert.equal(payload.links.results, undefined);
  });

  it("withholdResultsLink suppresses it for one run only", async () => {
    const withheld = (await startSuite()).body.result.links.progress.id;
    const normal = (await startSuite()).body.result.links.progress.id;
    assert.equal(fake.cicd.withholdResultsLink(withheld), true);
    assert.equal(fake.cicd.withholdResultsLink("nope"), false);
    fake.cicd.cancel(withheld);
    const canceled = (await progress(withheld)).body.result;
    assert.equal(canceled.status_label, "Canceled");
    assert.equal(canceled.links.results, undefined);
    let payload;
    for (let i = 0; i < 3; i += 1)
      payload = (await progress(normal)).body.result;
    assert.equal(payload.links.results.id, fake.cicd.peek(normal).resultSysId);
  });

  it("the default still emits it once terminal", async () => {
    const id = (await startSuite()).body.result.links.progress.id;
    fake.cicd.cancel(id);
    const payload = (await progress(id)).body.result;
    assert.equal(payload.links.results.id, fake.cicd.peek(id).resultSysId);
  });
});
