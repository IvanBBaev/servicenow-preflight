// Legacy ATF rows (wave 14): rows a pre-marker store wrote fit the `<runId>:`
// naming convention but lack the F2 ownership marker, so teardown refuses
// them as `not-run-owned`. Discovery is read-only; deletion takes the report
// plus exact confirmed sys_ids, re-verifies every row right before the first
// DELETE, and refuses the whole call on any doubt.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  LEGACY_ATF_REPORT_KIND,
  LegacyCleanupRefusalError,
  TestStoreRefusalError,
  createAtfTestStore,
  deleteLegacyAtfRows,
  discoverLegacyAtfRows,
  runOwnershipMarker,
} from "../build/index.js";
import {
  fakeClient,
  makeCtx,
  makeInstance,
  rowCounts,
  spec,
  tempLock,
} from "./support.js";

const LEGACY_RUN = "run-20260920t101500-abcdef01";
const LEGACY_TEST = "a".repeat(32);
const LEGACY_SUITE = "b".repeat(32);
const LEGACY_LINK = "c".repeat(32);
const LEGACY_STEP = "d".repeat(32);
const LEGACY_INPUT = "e".repeat(32);
const LEGACY_RESULT = "f".repeat(32);
const CUSTOMER_TEST = "1".repeat(32);
const CUSTOMER_SUITE = "2".repeat(32);

/** A legacy run (test + suite + link + step + input + terminal result) plus customer rows. */
function legacyState(overrides = {}) {
  return {
    sys_atf_test: [
      {
        sys_id: LEGACY_TEST,
        name: `${LEGACY_RUN}:alpha`,
        description: "projected from spec alpha (tests/alpha.test.ts)",
        sys_created_by: "tessera.author",
      },
      {
        sys_id: CUSTOMER_TEST,
        name: "smoke:login",
        description: "Customer smoke test",
      },
    ],
    sys_atf_test_suite: [
      {
        sys_id: LEGACY_SUITE,
        name: `${LEGACY_RUN}:suite`,
        description: "DEV-8/DEV-19 throwaway suite",
      },
      { sys_id: CUSTOMER_SUITE, name: "Customer nightly", description: "x" },
    ],
    sys_atf_test_suite_test: [
      { sys_id: LEGACY_LINK, test_suite: LEGACY_SUITE, test: LEGACY_TEST },
    ],
    sys_atf_step: [{ sys_id: LEGACY_STEP, test: LEGACY_TEST }],
    sys_variable_value: [
      {
        sys_id: LEGACY_INPUT,
        document: "sys_atf_step",
        document_key: LEGACY_STEP,
        value: "gs.info(1);",
      },
    ],
    sys_atf_test_suite_result: [
      { sys_id: LEGACY_RESULT, test_suite: LEGACY_SUITE, status: "success" },
    ],
    ...overrides,
  };
}

const refusedFor = (reason) => (error) => {
  assert.ok(error instanceof LegacyCleanupRefusalError, String(error));
  assert.ok(error instanceof TestStoreRefusalError);
  assert.equal(error.code, "legacy-cleanup-refused");
  assert.equal(error.reason, reason, error.message);
  assert.match(error.message, /nothing was deleted/);
  return true;
};

const writes = (client) => client.calls.filter((call) => call.method !== "GET");

const allCounts = (instance) => ({
  ...rowCounts(instance),
  sys_atf_test_suite_result: instance.tables.count("sys_atf_test_suite_result"),
});

/** Discover, mutate the instance, then attempt a delete: must refuse with no write. */
async function assertDeleteRefused({
  state,
  mutate,
  confirm,
  reason,
  report: forge,
  options = {},
}) {
  const instance = makeInstance({ state: state ?? legacyState() });
  const client = fakeClient(instance);
  let report = await discoverLegacyAtfRows({ client });
  if (forge) report = forge(report);
  if (mutate) mutate(instance);
  const before = allCounts(instance);
  client.calls.length = 0;
  await assert.rejects(
    deleteLegacyAtfRows({
      client,
      report,
      confirmedSysIds: confirm ?? [LEGACY_TEST, LEGACY_SUITE],
      ...options,
    }),
    refusedFor(reason),
  );
  assert.deepEqual(writes(client), []);
  assert.deepEqual(allCounts(instance), before);
}

describe("discoverLegacyAtfRows()", () => {
  test("lists marker-less rows under a minted run id, with the detail a human needs, via GETs only", async () => {
    const instance = makeInstance({ state: legacyState() });
    const client = fakeClient(instance);
    const report = await discoverLegacyAtfRows({ client });
    assert.deepEqual(writes(client), []);
    assert.equal(report.kind, LEGACY_ATF_REPORT_KIND);
    assert.deepEqual(report.scope, { mintedRunIds: true, runIds: [] });
    assert.deepEqual(report.conflicts, []);
    assert.deepEqual(
      report.candidates.map((c) => [c.table, c.sysId]),
      [
        ["sys_atf_test", LEGACY_TEST],
        ["sys_atf_test_suite", LEGACY_SUITE],
      ],
    );
    const [testRow, suiteRow] = report.candidates;
    assert.equal(testRow.name, `${LEGACY_RUN}:alpha`);
    assert.equal(testRow.runId, LEGACY_RUN);
    assert.equal(testRow.matchedBy, "minted-run-id");
    assert.equal(testRow.createdBy, "tessera.author");
    assert.notEqual(testRow.createdOn, "");
    assert.equal(testRow.steps, 1);
    assert.equal(testRow.stepInputs, 1);
    assert.deepEqual(testRow.links, [
      {
        sysId: LEGACY_LINK,
        suiteSysId: LEGACY_SUITE,
        testSysId: LEGACY_TEST,
        suiteClass: "candidate",
      },
    ]);
    assert.equal(testRow.blockers.length, 1);
    assert.match(testRow.blockers[0], /confirm that suite too/);
    assert.deepEqual(suiteRow.suiteResults, [
      { sysId: LEGACY_RESULT, status: "success", terminal: true },
    ]);
    assert.deepEqual(suiteRow.links, [
      { sysId: LEGACY_LINK, suiteSysId: LEGACY_SUITE, testSysId: LEGACY_TEST },
    ]);
    assert.deepEqual(suiteRow.blockers, []);
  });

  test("marked rows are not candidates; another run's marker is a conflict", async () => {
    const other = "run-20260921t000000-00000000";
    const instance = makeInstance({
      state: legacyState({
        sys_atf_test: [
          {
            name: `${LEGACY_RUN}:owned`,
            description: `${runOwnershipMarker(LEGACY_RUN)}projected`,
          },
          {
            sys_id: "9".repeat(32),
            name: `${LEGACY_RUN}:stolen`,
            description: `${runOwnershipMarker(other)}projected`,
          },
        ],
      }),
    });
    const report = await discoverLegacyAtfRows({
      client: fakeClient(instance),
    });
    assert.deepEqual(
      report.candidates.map((c) => c.sysId),
      [LEGACY_SUITE],
    );
    assert.deepEqual(report.conflicts, [
      {
        table: "sys_atf_test",
        sysId: "9".repeat(32),
        name: `${LEGACY_RUN}:stolen`,
        runId: LEGACY_RUN,
        description: `${runOwnershipMarker(other)}projected`,
      },
    ]);
  });

  test("only the naming convention is in scope: customer, non-minted and wrong-case names are not", async () => {
    const instance = makeInstance({
      state: {
        sys_atf_test: [
          { name: "smoke:login", description: "customer" },
          { name: "run-2026:alpha", description: "legacy?" },
          { name: "RUN-20260920t101500-abcdef01:alpha", description: "x" },
          { name: "run-20260920t101500-ABCDEF01:alpha", description: "x" },
          { name: "run-20260920t101500-abcdef01", description: "no colon" },
          { name: "run-20260920T101500-abcdef01:upper-t", description: "x" },
        ],
      },
    });
    const report = await discoverLegacyAtfRows({
      client: fakeClient(instance),
    });
    assert.deepEqual(
      report.candidates.map((c) => c.name),
      ["run-20260920T101500-abcdef01:upper-t"],
    );
  });

  test("an explicit run id widens the scope to its namespace only", async () => {
    const instance = makeInstance({ state: legacyState() });
    const report = await discoverLegacyAtfRows({
      client: fakeClient(instance),
      runIds: ["smoke", "smoke"],
    });
    assert.deepEqual(report.scope.runIds, ["smoke"]);
    const customer = report.candidates.find((c) => c.sysId === CUSTOMER_TEST);
    assert.equal(customer.matchedBy, "explicit-run-id");
    assert.equal(customer.runId, "smoke");
  });

  test("an unsafe explicit run id is refused before any request", async () => {
    for (const runId of ["", "a^b", "Upper", "a:b", 7]) {
      const instance = makeInstance();
      const client = fakeClient(instance);
      await assert.rejects(
        discoverLegacyAtfRows({ client, runIds: [runId] }),
        refusedFor("confirmation"),
      );
      assert.deepEqual(client.calls, []);
    }
  });

  test("a truncated read refuses instead of returning a partial report", async () => {
    const instance = makeInstance({ state: legacyState() });
    instance.tables.insert("sys_atf_test", {
      name: `${LEGACY_RUN}:beta`,
      description: "legacy",
    });
    await assert.rejects(
      discoverLegacyAtfRows({
        client: fakeClient(instance),
        pageSize: 1,
        maxQueryPages: 1,
      }),
      refusedFor("truncated-read"),
    );
  });

  test("a test linked into a customer suite is reported with a blocker", async () => {
    const state = legacyState();
    state.sys_atf_test_suite_test.push({
      sys_id: "3".repeat(32),
      test_suite: CUSTOMER_SUITE,
      test: LEGACY_TEST,
    });
    const report = await discoverLegacyAtfRows({
      client: fakeClient(makeInstance({ state })),
    });
    const testRow = report.candidates.find((c) => c.sysId === LEGACY_TEST);
    const link = testRow.links.find((l) => l.suiteSysId === CUSTOMER_SUITE);
    assert.equal(link.suiteClass, "foreign");
    assert.ok(testRow.blockers.some((b) => /foreign suite/.test(b)));
  });

  test("a test linked into a run-owned (marked) suite is reported as such, with a blocker", async () => {
    const markedSuite = "4".repeat(32);
    const state = legacyState();
    state.sys_atf_test_suite.push({
      sys_id: markedSuite,
      name: "run-20260929t080000-0badc0de:suite",
      description: `${runOwnershipMarker("run-20260929t080000-0badc0de")}suite`,
    });
    state.sys_atf_test_suite_test.push({
      sys_id: "5".repeat(32),
      test_suite: markedSuite,
      test: LEGACY_TEST,
    });
    const report = await discoverLegacyAtfRows({
      client: fakeClient(makeInstance({ state })),
    });
    const testRow = report.candidates.find((c) => c.sysId === LEGACY_TEST);
    const link = testRow.links.find((l) => l.suiteSysId === markedSuite);
    assert.equal(link.suiteClass, "marked");
    assert.ok(testRow.blockers.some((b) => /marked suite/.test(b)));
    assert.ok(!report.candidates.some((c) => c.sysId === markedSuite));
  });
});

describe("deleteLegacyAtfRows()", () => {
  test("deletes exactly the confirmed rows and their dependants in DEV-13 order; results and customer rows stay", async () => {
    const instance = makeInstance({ state: legacyState() });
    const client = fakeClient(instance);
    const report = await discoverLegacyAtfRows({ client });
    const result = await deleteLegacyAtfRows({
      client,
      report,
      confirmedSysIds: [LEGACY_SUITE, LEGACY_TEST],
    });
    assert.deepEqual(result.deleted, [
      { table: "sys_atf_test_suite_test", sysId: LEGACY_LINK },
      { table: "sys_variable_value", sysId: LEGACY_INPUT },
      { table: "sys_atf_step", sysId: LEGACY_STEP },
      { table: "sys_atf_test", sysId: LEGACY_TEST },
      { table: "sys_atf_test_suite", sysId: LEGACY_SUITE },
    ]);
    assert.deepEqual(allCounts(instance), {
      sys_atf_test: 1,
      sys_atf_step: 0,
      sys_variable_value: 0,
      sys_atf_test_suite: 1,
      sys_atf_test_suite_test: 0,
      sys_atf_test_suite_result: 1,
    });
    assert.equal(instance.tables.all("sys_atf_test")[0].sys_id, CUSTOMER_TEST);
  });

  test("a legacy suite with no result row and a test with no link are deletable", async () => {
    const state = legacyState({
      sys_atf_test_suite_test: [],
      sys_atf_test_suite_result: [],
    });
    const instance = makeInstance({ state });
    const client = fakeClient(instance);
    const report = await discoverLegacyAtfRows({ client });
    await deleteLegacyAtfRows({
      client,
      report,
      confirmedSysIds: [LEGACY_TEST],
    });
    assert.equal(instance.tables.count("sys_atf_test"), 1);
    assert.equal(instance.tables.count("sys_atf_test_suite"), 2);
    await deleteLegacyAtfRows({
      client,
      report,
      confirmedSysIds: [LEGACY_SUITE],
    });
    assert.equal(instance.tables.count("sys_atf_test_suite"), 1);
  });

  test("a row that vanishes between re-verification and its DELETE counts as gone", async () => {
    const instance = makeInstance({ state: legacyState() });
    const inner = fakeClient(instance);
    const client = {
      calls: inner.calls,
      async request(req) {
        if (req.method === "DELETE" && req.path.endsWith(`/${LEGACY_STEP}`)) {
          instance.tables.remove("sys_atf_step", LEGACY_STEP);
        }
        return inner.request(req);
      },
    };
    const report = await discoverLegacyAtfRows({ client });
    const result = await deleteLegacyAtfRows({
      client,
      report,
      confirmedSysIds: [LEGACY_TEST, LEGACY_SUITE],
    });
    assert.ok(
      result.deleted.some(
        (d) => d.table === "sys_atf_step" && d.sysId === LEGACY_STEP,
      ),
    );
    assert.equal(instance.tables.count("sys_atf_test"), 1);
    assert.equal(instance.tables.count("sys_atf_test_suite"), 1);
  });

  test("a live run's own rows are never touched", async () => {
    const lock = tempLock();
    try {
      const instance = makeInstance({ state: legacyState() });
      const client = fakeClient(instance);
      const store = createAtfTestStore({
        client,
        lockPath: lock.lockPath,
        onWarning: () => {},
      });
      await store.project(makeCtx({ runId: "run-20260930t120000-12345678" }), [
        spec("live"),
      ]);
      const report = await discoverLegacyAtfRows({ client });
      assert.deepEqual(
        report.candidates.map((c) => c.sysId).sort(),
        [LEGACY_TEST, LEGACY_SUITE].sort(),
      );
      await deleteLegacyAtfRows({
        client,
        report,
        confirmedSysIds: [LEGACY_TEST, LEGACY_SUITE],
      });
      assert.deepEqual(rowCounts(instance), {
        sys_atf_test: 2,
        sys_atf_step: 1,
        sys_variable_value: 1,
        sys_atf_test_suite: 2,
        sys_atf_test_suite_test: 1,
      });
      store.release();
    } finally {
      lock.cleanup();
    }
  });

  test("refuses an empty confirmation", () =>
    assertDeleteRefused({ confirm: [], reason: "confirmation" }));

  test("refuses a missing confirmation list", () =>
    assertDeleteRefused({
      options: { confirmedSysIds: undefined },
      reason: "confirmation",
    }));

  test("refuses a malformed or duplicated sys_id", async () => {
    await assertDeleteRefused({
      confirm: [LEGACY_TEST.toUpperCase()],
      reason: "confirmation",
    });
    await assertDeleteRefused({
      confirm: [LEGACY_TEST, LEGACY_TEST],
      reason: "confirmation",
    });
    await assertDeleteRefused({
      confirm: [`${LEGACY_TEST}^ORname!=x`],
      reason: "confirmation",
    });
  });

  test("refuses a sys_id that is not a candidate of the report — even a real, deletable-looking row", async () => {
    await assertDeleteRefused({
      confirm: [LEGACY_TEST, LEGACY_SUITE, CUSTOMER_TEST],
      reason: "not-in-report",
    });
    // A legacy row created after the report was taken is not confirmable
    // from that report.
    const late = "4".repeat(32);
    await assertDeleteRefused({
      mutate: (instance) =>
        instance.tables.insert(
          "sys_atf_test",
          { name: `${LEGACY_RUN}:late`, description: "legacy" },
          late,
        ),
      confirm: [late],
      reason: "not-in-report",
    });
  });

  test("refuses something that is not a discovery report", async () => {
    await assertDeleteRefused({
      report: (report) => ({ ...report, kind: "something-else" }),
      reason: "confirmation",
    });
    await assertDeleteRefused({
      report: () => null,
      reason: "confirmation",
    });
  });

  test("refuses a row that gained an ownership marker since the report", () =>
    assertDeleteRefused({
      mutate: (instance) =>
        instance.tables.update("sys_atf_test", LEGACY_TEST, {
          description: `${runOwnershipMarker(LEGACY_RUN)}re-projected`,
        }),
      reason: "row-changed",
    }));

  test("refuses a row that gained ANOTHER run's marker", () =>
    assertDeleteRefused({
      mutate: (instance) =>
        instance.tables.update("sys_atf_test_suite", LEGACY_SUITE, {
          description: "Tessera run someone-else — x",
        }),
      reason: "row-changed",
    }));

  test("refuses a row whose name no longer matches the report", () =>
    assertDeleteRefused({
      mutate: (instance) =>
        instance.tables.update("sys_atf_test", LEGACY_TEST, {
          name: `${LEGACY_RUN}:renamed`,
        }),
      reason: "row-changed",
    }));

  test("refuses a forged report candidate whose name is outside the naming convention", () =>
    assertDeleteRefused({
      report: (report) => ({
        ...report,
        candidates: [
          ...report.candidates,
          {
            ...report.candidates[0],
            table: "sys_atf_test",
            sysId: CUSTOMER_TEST,
            name: "smoke:login",
          },
        ],
      }),
      confirm: [CUSTOMER_TEST],
      reason: "row-changed",
    }));

  test("refuses a forged report candidate that points at a run-owned row", async () => {
    const lock = tempLock();
    try {
      const instance = makeInstance({ state: legacyState() });
      const client = fakeClient(instance);
      const store = createAtfTestStore({
        client,
        lockPath: lock.lockPath,
        onWarning: () => {},
      });
      const runId = "run-20260930t120000-12345678";
      const map = await store.project(makeCtx({ runId }), [spec("live")]);
      const { testSysId } = Object.values(map)[0];
      const report = await discoverLegacyAtfRows({ client });
      const forged = {
        ...report,
        candidates: [
          { ...report.candidates[0], sysId: testSysId, name: `${runId}:live` },
        ],
      };
      const before = allCounts(instance);
      client.calls.length = 0;
      await assert.rejects(
        deleteLegacyAtfRows({
          client,
          report: forged,
          confirmedSysIds: [testSysId],
        }),
        refusedFor("row-changed"),
      );
      assert.deepEqual(writes(client), []);
      assert.deepEqual(allCounts(instance), before);
      store.release();
    } finally {
      lock.cleanup();
    }
  });

  test("refuses a confirmed row that is gone", () =>
    assertDeleteRefused({
      mutate: (instance) => instance.tables.remove("sys_atf_test", LEGACY_TEST),
      reason: "row-changed",
    }));

  test("refuses an empty description (unreadable cannot be told from marker-less)", async () => {
    const state = legacyState();
    state.sys_atf_test[0].description = "";
    await assertDeleteRefused({ state, reason: "empty-description" });
  });

  test("refuses a confirmed test linked into a suite that is not confirmed", async () => {
    // The legacy suite is a candidate but not confirmed.
    await assertDeleteRefused({
      confirm: [LEGACY_TEST],
      reason: "foreign-link",
    });
    // A customer suite links the legacy test.
    const state = legacyState();
    state.sys_atf_test_suite_test.push({
      sys_id: "3".repeat(32),
      test_suite: CUSTOMER_SUITE,
      test: LEGACY_TEST,
    });
    await assertDeleteRefused({ state, reason: "foreign-link" });
  });

  test("refuses a link that appeared after the report", () =>
    assertDeleteRefused({
      mutate: (instance) =>
        instance.tables.insert("sys_atf_test_suite_test", {
          test_suite: CUSTOMER_SUITE,
          test: LEGACY_TEST,
        }),
      reason: "foreign-link",
    }));

  test("refuses a confirmed suite with a non-terminal result", () =>
    assertDeleteRefused({
      mutate: (instance) =>
        instance.tables.insert("sys_atf_test_suite_result", {
          test_suite: LEGACY_SUITE,
          status: "running",
        }),
      reason: "non-terminal",
    }));

  test("refuses on a truncated re-verification read", () =>
    assertDeleteRefused({
      mutate: (instance) =>
        instance.tables.insert("sys_atf_step", { test: LEGACY_TEST }),
      options: { pageSize: 1, maxQueryPages: 1 },
      reason: "truncated-read",
    }));

  test("rejects a non-positive page size or page cap before any request", async () => {
    const instance = makeInstance();
    const client = fakeClient(instance);
    for (const bad of [{ pageSize: 0 }, { maxQueryPages: 1.5 }]) {
      await assert.rejects(
        discoverLegacyAtfRows({ client, ...bad }),
        TypeError,
      );
    }
    assert.deepEqual(client.calls, []);
  });
});
