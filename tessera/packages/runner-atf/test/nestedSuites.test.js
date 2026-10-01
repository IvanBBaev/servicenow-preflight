// Wave 13 — nested child suites (TODO wave 12 residual).
//
// A suite can contain child suites. ServiceNow gives each child its own
// `sys_atf_test_suite_result` row, pointing at the parent execution's row via
// `parent`, and a test that ran inside a child links its `sys_atf_test_result`
// to the CHILD's row. Before wave 13 the runner read only the root row's
// results, so such a test came back `missing`: fail-closed, but wrong.
//
// What these tests pin down:
//   - the tree is discovered downwards from THIS run's root only (DEV-6/DR-4:
//     another run's child rows never become evidence);
//   - a test is joined worst-of across the tree, so a green row in one suite
//     cannot mask a red one in a sibling;
//   - every way the tree can be unreadable — too deep, too big, cyclic, a
//     child this session may not read, a row whose place cannot be proven —
//     is a DEV-1 fault, never a partial GO.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";

import {
  ATF_SUITE_RESULT_TABLE,
  ATF_TEST_RESULT_TABLE,
  MAX_RESULT_ROWS_PER_TEST,
  MAX_SUITE_DEPTH,
  MAX_SUITE_RESULTS,
  RESULT_FIELDS,
  RESULT_QUERY_BATCH,
  SUITE_RESULT_FIELDS,
  TABLE_API_PREFIX,
  createAtfRunner,
  fetchSuiteResultTree,
  fetchTestResults,
  parseSpecResults,
  resolveSuiteTreeCaps,
} from "../build/index.js";

import {
  assertInfraFault,
  collector,
  fakeClient,
  isSuiteTreeRead,
  makeCtx,
  manualClock,
  plan,
  scriptedClient,
  seedResult,
  spec,
  suiteResultId,
  sysId,
  tablePage,
} from "./support.js";

const SUITE_TREE_PATH = `${TABLE_API_PREFIX}${ATF_SUITE_RESULT_TABLE}`;
const RESULT_PATH = `${TABLE_API_PREFIX}${ATF_TEST_RESULT_TABLE}`;
const ROOT = suiteResultId(1);

/**
 * A runner on a fake instance whose `setup(executionId, root)` runs once, just
 * before the first progress poll — i.e. after the trigger minted the run's
 * root suite-result row, which is when a real instance starts writing child
 * suite rows and per-test rows.
 */
function nestedHarness(instance, setup, options = {}) {
  const inner = fakeClient(instance);
  let prepared = false;
  const client = {
    calls: inner.calls,
    async request(args) {
      if (!prepared && args.path.startsWith("/api/sn_cicd/progress/")) {
        prepared = true;
        const executionId = args.path.slice("/api/sn_cicd/progress/".length);
        setup(executionId, instance.cicd.peek(executionId).resultSysId);
      }
      return inner.request(args);
    },
  };
  const clock = manualClock();
  const runner = createAtfRunner({
    client,
    now: clock.now,
    sleep: clock.sleep,
    initialIntervalMs: 1,
    ...options,
  });
  return { client, runner };
}

function outcomeOf(result, id) {
  const found = result.outcomes.filter((outcome) => outcome.spec.id === id);
  assert.equal(found.length, 1, `expected exactly one outcome for ${id}`);
  return found[0];
}

/** Record one per-test row for `test` under `link` (a root or child row). */
function record(instance, executionId, test, status, link, output = "") {
  return instance.cicd.recordTestResult(executionId, {
    test,
    status,
    output,
    ...(link === undefined ? {} : { suiteResultSysId: link }),
  });
}

async function runPlan(instance, ids, setup, options) {
  const { specs, projection, testSysIdOf } = plan(ids.map((id) => ({ id })));
  const { client, runner } = nestedHarness(
    instance,
    (executionId, root) => setup({ executionId, root, testSysIdOf }),
    options,
  );
  const events = collector();
  const result = await runner.run(makeCtx({ projection }), specs, events.emit);
  return { client, events, result };
}

function runPlanRejecting(instance, ids, setup, options) {
  const { specs, projection, testSysIdOf } = plan(ids.map((id) => ({ id })));
  const { client, runner } = nestedHarness(
    instance,
    (executionId, root) => setup({ executionId, root, testSysIdOf }),
    options,
  );
  const events = collector();
  return {
    client,
    events,
    promise: runner.run(makeCtx({ projection }), specs, events.emit),
  };
}

const fake = (extra = {}) =>
  createFakeInstance({ cicd: { pollsToComplete: 1 }, ...extra });

describe("nested child suites — results found under the tree (fake instance)", () => {
  it("1 level: a test that ran inside a child suite is attributed, not missing", async () => {
    const instance = fake();
    const { client, events, result } = await runPlan(
      instance,
      ["alpha", "beta"],
      ({ executionId, testSysIdOf }) => {
        const child = instance.cicd.recordChildSuiteResult(executionId);
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "success",
          child.sys_id,
        );
        record(instance, executionId, testSysIdOf("beta"), "success");
      },
    );
    assert.equal(outcomeOf(result, "alpha").raw, "pass");
    assert.equal(outcomeOf(result, "beta").raw, "pass");
    assert.equal(events.of("pass").length, 2);

    // Wire: the tree read is the TM-1 allowlist, scoped by THIS run's root.
    const treeReads = client.calls.filter((c) => c.path === SUITE_TREE_PATH);
    assert.equal(
      treeReads[0].params.sysparm_query,
      `parent=${ROOT}^ORDERBYsys_id`,
    );
    assert.equal(
      treeReads[0].params.sysparm_fields,
      SUITE_RESULT_FIELDS.join(","),
    );
    assert.equal(
      treeReads[0].params.sysparm_limit,
      String(MAX_SUITE_RESULTS - 1 + 1),
      "one row past the remaining budget, so an overflow is observed",
    );
    // The result read spans the root and the child.
    const resultReads = client.calls.filter((c) => c.path === RESULT_PATH);
    assert.equal(resultReads.length, 1);
    const child = instance.tables
      .all(ATF_SUITE_RESULT_TABLE)
      .find((row) => row.parent === ROOT);
    assert.match(
      resultReads[0].params.sysparm_query,
      new RegExp(`^test_suite_resultIN${ROOT},${child.sys_id}\\^testIN`),
    );
    assert.equal(resultReads[0].params.sysparm_fields, RESULT_FIELDS.join(","));
  });

  it("2 levels: a grandchild's pass and a child's failure are both attributed", async () => {
    const instance = fake();
    const { client, events, result } = await runPlan(
      instance,
      ["alpha", "beta", "gamma"],
      ({ executionId, testSysIdOf }) => {
        const child = instance.cicd.recordChildSuiteResult(executionId);
        const grandchild = instance.cicd.recordChildSuiteResult(executionId, {
          parent: child.sys_id,
        });
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "success",
          grandchild.sys_id,
        );
        record(
          instance,
          executionId,
          testSysIdOf("beta"),
          "failure",
          child.sys_id,
          "beta broke",
        );
        record(instance, executionId, testSysIdOf("gamma"), "success");
      },
    );
    assert.deepEqual(
      result.outcomes.map((o) => [o.spec.id, o.raw]),
      [
        ["alpha", "pass"],
        ["beta", "fail"],
        ["gamma", "pass"],
      ],
    );
    assert.equal(events.of("fail")[0].assertion, "beta broke");
    // Levels 1, 2, then the level-3 read that proves the tree ends.
    assert.equal(
      client.calls.filter((c) => c.path === SUITE_TREE_PATH).length,
      3,
    );
  });

  it("joins worst-of: a pass in the root does not mask a failure in a child", async () => {
    const instance = fake();
    const { events, result } = await runPlan(
      instance,
      ["alpha"],
      ({ executionId, testSysIdOf }) => {
        const child = instance.cicd.recordChildSuiteResult(executionId);
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "failure",
          child.sys_id,
          "red in the child",
        );
        // Written LAST, so "newest wins" would have picked it.
        record(instance, executionId, testSysIdOf("alpha"), "success");
      },
    );
    assert.equal(outcomeOf(result, "alpha").raw, "fail");
    assert.deepEqual(events.of("pass"), []);
    assert.equal(events.of("fail")[0].assertion, "red in the child");
  });

  it("joins worst-of across siblings, whichever wrote last", async () => {
    const instance = fake();
    const { result } = await runPlan(
      instance,
      ["alpha"],
      ({ executionId, testSysIdOf }) => {
        const one = instance.cicd.recordChildSuiteResult(executionId);
        const two = instance.cicd.recordChildSuiteResult(executionId);
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "failure",
          one.sys_id,
        );
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "success",
          two.sys_id,
        );
      },
    );
    assert.equal(outcomeOf(result, "alpha").raw, "fail");
  });

  it("stays run-scoped: another run's child suite rows are never evidence", async () => {
    const instance = fake();
    const { events, result } = await runPlan(
      instance,
      ["alpha"],
      ({ testSysIdOf }) => {
        // A child row of some OTHER execution, and a green row linked to it.
        const foreign = instance.tables.insert(ATF_SUITE_RESULT_TABLE, {
          parent: sysId("someone-elses-root"),
        });
        seedResult(instance, {
          test: testSysIdOf("alpha"),
          status: "success",
          link: foreign.sys_id,
        });
      },
    );
    assert.equal(outcomeOf(result, "alpha").raw, "missing");
    assert.deepEqual(events.of("pass"), []);
  });

  it("a child's result row this session may not read leaves the spec not green", async () => {
    const instance = fake({
      readAcl: {
        rules: [
          {
            table: ATF_TEST_RESULT_TABLE,
            when: (row) => row.output === "hidden",
          },
        ],
      },
    });
    const { events, result } = await runPlan(
      instance,
      ["alpha"],
      ({ executionId, testSysIdOf }) => {
        const child = instance.cicd.recordChildSuiteResult(executionId);
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "success",
          child.sys_id,
          "hidden",
        );
      },
    );
    assert.equal(outcomeOf(result, "alpha").raw, "missing");
    assert.deepEqual(events.of("pass"), []);
    assert.match(
      events.of("error")[0].cause,
      /or any of the 1 other suite result\(s\) read with it \(nested child suites\)/,
    );
  });

  it("a spec found nowhere in the tree is still `missing` (QA-9)", async () => {
    const instance = fake();
    const { result } = await runPlan(instance, ["alpha"], ({ executionId }) => {
      instance.cicd.recordChildSuiteResult(executionId);
    });
    assert.equal(outcomeOf(result, "alpha").raw, "missing");
  });
});

describe("nested child suites — an unreadable tree is a DEV-1 fault, never a partial GO", () => {
  it("a parent cycle rejects", async () => {
    const instance = fake();
    const { events, promise } = runPlanRejecting(
      instance,
      ["alpha"],
      ({ executionId, root, testSysIdOf }) => {
        const child = instance.cicd.recordChildSuiteResult(executionId);
        // Corrupt data: the root now claims the child as its parent.
        instance.tables.update(ATF_SUITE_RESULT_TABLE, root, {
          parent: child.sys_id,
        });
        record(instance, executionId, testSysIdOf("alpha"), "success");
      },
    );
    await assertInfraFault(promise, /appears twice .* \(a parent cycle\)/);
    assert.deepEqual(events.of("pass"), []);
  });

  it("a row naming itself as its parent rejects", async () => {
    const tree = scriptedClient(({ params }) => {
      const query = new URLSearchParams(params)
        .get("sysparm_query")
        .replace(/\^ORDERBYsys_id$/, "");
      const id = query.slice("parent=".length);
      return tablePage([{ sys_id: id === ROOT ? sysId("c") : id, parent: id }]);
    });
    await assertInfraFault(fetchSuiteResultTree(tree, ROOT), /a parent cycle/);
    assert.equal(tree.calls.length, 2);
  });

  it("the depth cap: one level too deep rejects; exactly at the cap reads", async () => {
    const deep =
      (instance) =>
      ({ executionId, testSysIdOf }) => {
        const child = instance.cicd.recordChildSuiteResult(executionId);
        const grandchild = instance.cicd.recordChildSuiteResult(executionId, {
          parent: child.sys_id,
        });
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "success",
          grandchild.sys_id,
        );
      };
    const over = fake();
    const rejected = runPlanRejecting(over, ["alpha"], deep(over), {
      results: { maxSuiteDepth: 1 },
    });
    await assertInfraFault(
      rejected.promise,
      /deeper than 1 level\(s\) \(maxSuiteDepth\)/,
    );
    assert.deepEqual(rejected.events.of("pass"), []);

    const at = fake();
    const { result } = await runPlan(at, ["alpha"], deep(at), {
      results: { maxSuiteDepth: 2 },
    });
    assert.equal(outcomeOf(result, "alpha").raw, "pass");
  });

  it("the default depth cap is enforced without an option", async () => {
    const instance = fake();
    const rejected = runPlanRejecting(
      instance,
      ["alpha"],
      ({ executionId, root }) => {
        let parent = root;
        for (let level = 0; level <= MAX_SUITE_DEPTH; level += 1) {
          parent = instance.cicd.recordChildSuiteResult(executionId, {
            parent,
          }).sys_id;
        }
      },
    );
    await assertInfraFault(
      rejected.promise,
      new RegExp(`deeper than ${MAX_SUITE_DEPTH} level`),
    );
  });

  it("the row cap: one row too many rejects; exactly at the cap reads", async () => {
    const wide =
      (instance) =>
      ({ executionId, testSysIdOf }) => {
        const a = instance.cicd.recordChildSuiteResult(executionId);
        instance.cicd.recordChildSuiteResult(executionId, { parent: a.sys_id });
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "success",
          a.sys_id,
        );
      };
    const over = fake();
    const rejected = runPlanRejecting(over, ["alpha"], wide(over), {
      results: { maxSuiteResults: 2 },
    });
    await assertInfraFault(
      rejected.promise,
      /more than 2 rows \(maxSuiteResults\)/,
    );
    assert.deepEqual(rejected.events.of("pass"), []);

    const at = fake();
    const { result } = await runPlan(at, ["alpha"], wide(at), {
      results: { maxSuiteResults: 3 },
    });
    assert.equal(outcomeOf(result, "alpha").raw, "pass");
  });

  it("an ACL-trimmed child suite result rejects instead of reading a partial tree", async () => {
    const instance = fake({
      readAcl: {
        rules: [
          {
            table: ATF_SUITE_RESULT_TABLE,
            when: (row) => row.test_suite === "secret-child",
          },
        ],
      },
    });
    const { events, promise } = runPlanRejecting(
      instance,
      ["alpha", "beta"],
      ({ executionId, testSysIdOf }) => {
        instance.cicd.recordChildSuiteResult(executionId);
        const secret = instance.cicd.recordChildSuiteResult(executionId, {
          suiteSysId: "secret-child",
        });
        // Green in the visible tree, red in the child we may not read: a
        // partial tree would report this spec as a pass.
        record(instance, executionId, testSysIdOf("alpha"), "success");
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "failure",
          secret.sys_id,
        );
        record(instance, executionId, testSysIdOf("beta"), "success");
      },
    );
    await assertInfraFault(
      promise,
      /counted 2 child sys_atf_test_suite_result row\(s\) .* but returned 1: a child suite result this session may not read \(OPP-1b\)/,
    );
    assert.deepEqual(events.of("pass"), []);
  });

  it("a child whose `parent` column this session may not read rejects", async () => {
    const instance = fake({
      readAcl: {
        rules: [{ table: ATF_SUITE_RESULT_TABLE, fields: ["parent"] }],
      },
    });
    const { promise } = runPlanRejecting(
      instance,
      ["alpha"],
      ({ executionId, testSysIdOf }) => {
        const child = instance.cicd.recordChildSuiteResult(executionId);
        record(
          instance,
          executionId,
          testSysIdOf("alpha"),
          "success",
          child.sys_id,
        );
      },
    );
    await assertInfraFault(
      promise,
      /came back with parent "", which is not a row this read asked about/,
    );
  });
});

describe("fetchSuiteResultTree — the bounded traversal on the wire", () => {
  const routed = (childrenOf, totals = {}) =>
    scriptedClient(({ params }) => {
      // Wave 15: the tree read is sys_id-ordered (stable offset paging).
      const query = new URLSearchParams(params)
        .get("sysparm_query")
        .replace(/\^ORDERBYsys_id$/, "");
      const parents = query.startsWith("parentIN")
        ? query.slice("parentIN".length).split(",")
        : [query.slice("parent=".length)];
      const rows = parents.flatMap((parent) =>
        (childrenOf[parent] ?? []).map((id) => ({ sys_id: id, parent })),
      );
      return tablePage(rows, totals[query] ?? rows.length);
    });

  it("a root with no child suite is one read and a one-row tree", async () => {
    const client = routed({});
    assert.deepEqual(await fetchSuiteResultTree(client, ROOT), {
      root: ROOT,
      ids: [ROOT],
      depth: 0,
    });
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].path, SUITE_TREE_PATH);
    assert.equal(client.calls[0].method, "GET");
  });

  it("walks level by level with `parentIN` and returns the ids root first", async () => {
    const [a, b, a1, b1] = ["a", "b", "a1", "b1"].map(sysId);
    const client = routed({ [ROOT]: [a, b], [a]: [a1], [b]: [b1] });
    const tree = await fetchSuiteResultTree(client, ROOT);
    assert.deepEqual(tree, { root: ROOT, ids: [ROOT, a, b, a1, b1], depth: 2 });
    assert.deepEqual(
      client.calls.map((_c, i) => client.paramsOf(i).sysparm_query),
      [`parent=${ROOT}`, `parentIN${a},${b}`, `parentIN${a1},${b1}`].map(
        (query) => `${query}^ORDERBYsys_id`,
      ),
    );
    // The budget shrinks as the tree grows: limit = remaining + 1.
    assert.deepEqual(
      client.calls.map((_c, i) => client.paramsOf(i).sysparm_limit),
      [
        String(MAX_SUITE_RESULTS),
        String(MAX_SUITE_RESULTS - 2),
        String(MAX_SUITE_RESULTS - 4),
      ],
    );
  });

  it("batches a wide frontier by RESULT_QUERY_BATCH", async () => {
    const kids = Array.from({ length: RESULT_QUERY_BATCH + 5 }, (_v, i) =>
      sysId(`kid-${i}`),
    );
    const client = routed({ [ROOT]: kids });
    const tree = await fetchSuiteResultTree(client, ROOT, {
      maxSuiteResults: 200,
    });
    assert.equal(tree.ids.length, kids.length + 1);
    assert.deepEqual(
      client.calls
        .slice(1)
        .map((_c, i) => client.paramsOf(i + 1).sysparm_query.split(",").length),
      [RESULT_QUERY_BATCH, 5],
    );
  });

  it("an X-Total-Count above the rows returned rejects (ACL-trimmed or short page)", async () => {
    const client = routed({ [ROOT]: [sysId("a")] }, { [`parent=${ROOT}`]: 2 });
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT),
      /counted 2 .* but returned 1/,
    );
  });

  it("a total above the budget is a cap overflow even when the page is short", async () => {
    const client = routed({ [ROOT]: [sysId("a")] }, { [`parent=${ROOT}`]: 50 });
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT, { maxSuiteResults: 10 }),
      /more than 10 rows \(maxSuiteResults\)/,
    );
  });

  it("a row whose parent was not asked about rejects (a dropped query condition)", async () => {
    const client = scriptedClient(() =>
      tablePage([{ sys_id: sysId("stray"), parent: sysId("elsewhere") }]),
    );
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT),
      /which is not a row this read asked about/,
    );
  });

  it("a row with a malformed sys_id rejects before it can reach a query", async () => {
    const client = scriptedClient(() =>
      tablePage([{ sys_id: "x^ORsys_idISNOTEMPTY", parent: ROOT }]),
    );
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT),
      /has sys_id "x\^ORsys_idISNOTEMPTY", which is not a sys_id/,
    );
    assert.equal(client.calls.length, 1);
  });

  it("a malformed or absent root id rejects before any request", async () => {
    for (const bad of ["", "a^b", undefined, { resultTable: "x" }]) {
      const client = scriptedClient(() => assert.fail("no request expected"));
      await assertInfraFault(
        fetchSuiteResultTree(client, bad),
        /without an execution link/,
      );
    }
  });

  it("a transport fault is normalised, not swallowed into a shallower tree", async () => {
    const client = scriptedClient(() => {
      throw new Error("socket hang up");
    });
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT),
      /socket hang up/,
    );
  });

  it("an invalid cap is a TypeError, before any request", async () => {
    for (const key of ["maxSuiteDepth", "maxSuiteResults"]) {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const client = scriptedClient(() => assert.fail("no request expected"));
        await assert.rejects(
          fetchSuiteResultTree(client, ROOT, { [key]: bad }),
          (error) =>
            error instanceof TypeError &&
            error.message.startsWith(`${key} must be a positive integer`),
        );
        assert.throws(
          () =>
            createAtfRunner({
              client,
              results: { [key]: bad },
            }),
          (error) =>
            error instanceof TypeError &&
            error.message.startsWith(
              `createAtfRunner: results.${key} must be a positive integer`,
            ),
        );
      }
    }
    assert.deepEqual(resolveSuiteTreeCaps(), {
      maxDepth: MAX_SUITE_DEPTH,
      maxResults: MAX_SUITE_RESULTS,
    });
  });
});

describe("parseSpecResults / fetchTestResults over several suite results", () => {
  const TEST_A = sysId("test-a");
  const TEST_B = sysId("test-b");
  const CHILD = sysId("child");
  const row = (fields) => ({
    sys_id: sysId("row"),
    test: TEST_A,
    status: "success",
    output: "",
    sys_created_on: "2026-08-21 10:00:00",
    test_suite_result: ROOT,
    ...fields,
  });

  it("a one-element list reads exactly like the single-id form", async () => {
    const asString = scriptedClient(() => tablePage([]));
    const asList = scriptedClient(() => tablePage([]));
    await fetchTestResults(asString, [TEST_A], ROOT);
    await fetchTestResults(asList, [TEST_A], [ROOT]);
    assert.deepEqual(asList.paramsOf(0), asString.paramsOf(0));
  });

  it("scopes by `test_suite_resultIN` and sizes the page per (test, suite result)", async () => {
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, [TEST_A, TEST_B], [ROOT, CHILD]);
    assert.deepEqual(client.paramsOf(0), {
      sysparm_query: `test_suite_resultIN${ROOT},${CHILD}^testIN${TEST_A},${TEST_B}^ORDERBYDESCsys_created_on`,
      sysparm_fields: RESULT_FIELDS.join(","),
      sysparm_limit: String(2 * 2 * MAX_RESULT_ROWS_PER_TEST),
      sysparm_display_value: "false",
      sysparm_exclude_reference_link: "true",
    });
  });

  it("chunks a large tree's links by RESULT_QUERY_BATCH", async () => {
    const links = Array.from({ length: RESULT_QUERY_BATCH + 1 }, (_v, i) =>
      sysId(`link-${i}`),
    );
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, [TEST_A], links);
    assert.equal(client.calls.length, 2);
    assert.equal(
      client.paramsOf(1).sysparm_query,
      `test_suite_result=${links[RESULT_QUERY_BATCH]}^test=${TEST_A}^ORDERBYDESCsys_created_on`,
    );
  });

  it("refuses a row linked outside the list, even when the server sends it", async () => {
    const client = scriptedClient(() =>
      tablePage([row({ test_suite_result: sysId("other-run") })]),
    );
    const rows = await fetchTestResults(client, [TEST_A], [ROOT, CHILD]);
    assert.equal(rows.size, 0);
  });

  it("an empty list, or a malformed element, rejects before any request", async () => {
    for (const bad of [[], [ROOT, "a^b"], [ROOT, undefined]]) {
      const client = scriptedClient(() => assert.fail("no request expected"));
      await assertInfraFault(
        parseSpecResults(client, new Map([[TEST_A, spec("a")]]), bad),
        /without an execution link/,
      );
    }
  });

  it("ranks fail > error > skipped > pass, and keeps the newest on a tie", async () => {
    const cases = [
      [["success", "failure"], "fail"],
      [["success", "weird"], "error"],
      [["weird", "failure"], "fail"],
      [["success", "skipped"], "skipped"],
      [["skipped", "weird"], "error"],
    ];
    for (const [[rootStatus, childStatus], expected] of cases) {
      const client = scriptedClient(() =>
        tablePage([
          row({ sys_id: sysId("r1"), status: rootStatus }),
          row({
            sys_id: sysId("r2"),
            status: childStatus,
            test_suite_result: CHILD,
          }),
        ]),
      );
      const [result] = await parseSpecResults(
        client,
        new Map([[TEST_A, spec("a")]]),
        [ROOT, CHILD],
      );
      assert.equal(result.raw, expected, `${rootStatus} + ${childStatus}`);
    }

    const tie = scriptedClient(() =>
      tablePage([
        row({ sys_id: sysId("old"), status: "failure", output: "old" }),
        row({
          sys_id: sysId("new"),
          status: "failure",
          output: "new",
          test_suite_result: CHILD,
          sys_created_on: "2026-08-21 11:00:00",
        }),
      ]),
    );
    const [tied] = await parseSpecResults(tie, new Map([[TEST_A, spec("a")]]), [
      ROOT,
      CHILD,
    ]);
    assert.equal(tied.evidence.ref, sysId("new"));
  });

  it("a truncated page re-reads every test, then every unseen (test, suite result) pair", async () => {
    // Page 1 is truncated and shows TEST_A only under ROOT (a pass). The
    // per-test re-read is truncated too, so each unseen pair is read on its
    // own — and CHILD holds TEST_A's failure.
    const client = scriptedClient(({ params }) => {
      const query = new URLSearchParams(params).get("sysparm_query");
      if (query.startsWith(`test_suite_result=${CHILD}^test=${TEST_A}`)) {
        return tablePage([
          row({
            sys_id: sysId("hidden-red"),
            status: "failure",
            test_suite_result: CHILD,
          }),
        ]);
      }
      if (query.startsWith("test_suite_result=")) return tablePage([]);
      return tablePage([row({ sys_id: sysId("green") })], 999);
    });
    const [a, b] = await parseSpecResults(
      client,
      new Map([
        [TEST_A, spec("a")],
        [TEST_B, spec("b")],
      ]),
      [ROOT, CHILD],
    );
    assert.equal(a.raw, "fail");
    assert.equal(a.evidence.ref, sysId("hidden-red"));
    assert.equal(b.raw, "missing");
    assert.deepEqual(
      client.calls.map((_c, i) => [
        client.paramsOf(i).sysparm_query.split("^ORDERBY")[0],
        client.paramsOf(i).sysparm_limit,
      ]),
      [
        [`test_suite_resultIN${ROOT},${CHILD}^testIN${TEST_A},${TEST_B}`, "16"],
        [`test_suite_resultIN${ROOT},${CHILD}^test=${TEST_A}`, "8"],
        [`test_suite_result=${CHILD}^test=${TEST_A}`, "1"],
        [`test_suite_resultIN${ROOT},${CHILD}^test=${TEST_B}`, "8"],
        [`test_suite_result=${ROOT}^test=${TEST_B}`, "1"],
        [`test_suite_result=${CHILD}^test=${TEST_B}`, "1"],
      ],
    );
  });

  it("an untruncated per-test re-read needs no per-pair reads", async () => {
    const client = scriptedClient(({ params }) => {
      const query = new URLSearchParams(params).get("sysparm_query");
      if (query.includes("^testIN")) return tablePage([], 999);
      return tablePage([
        row({
          sys_id: sysId("c"),
          status: "failure",
          test_suite_result: CHILD,
        }),
      ]);
    });
    const [a] = await parseSpecResults(
      client,
      new Map([
        [TEST_A, spec("a")],
        [TEST_B, spec("b")],
      ]),
      [ROOT, CHILD],
    );
    assert.equal(a.raw, "fail");
    assert.equal(
      client.calls.length,
      3,
      "one batch read + one re-read per test",
    );
  });

  it("the runner's tree read is the only extra request of a flat suite", async () => {
    const instance = fake();
    const { client, result } = await runPlan(
      instance,
      ["alpha"],
      ({ executionId, testSysIdOf }) => {
        record(instance, executionId, testSysIdOf("alpha"), "success");
      },
    );
    assert.equal(outcomeOf(result, "alpha").raw, "pass");
    const reads = client.calls.filter((c) =>
      c.path.startsWith(TABLE_API_PREFIX),
    );
    assert.deepEqual(
      reads.map((c) => [c.path, c.params.sysparm_query.split("^ORDERBY")[0]]),
      [
        [SUITE_TREE_PATH, `parent=${ROOT}`],
        [
          RESULT_PATH,
          `test_suite_result=${ROOT}^test=${instance.tables.all(ATF_TEST_RESULT_TABLE)[0].test}`,
        ],
      ],
    );
    assert.ok(client.calls.some((c) => isSuiteTreeRead(c)));
  });
});
