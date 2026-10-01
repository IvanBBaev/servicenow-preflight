// Wave 16 — the Stats-API count cross-check on reads without `X-Total-Count`.
//
// Discovery (`queryAll` in the store, the legacy reader) keeps paging past a
// short page and stops only on an EMPTY page when the transport reports no
// total. Two holes stayed open (fail-OPEN): a window the read ACLs trimmed to
// zero rows ended discovery early, and rows trimmed out of the last window
// were indistinguishable from the end. Each such read now asks the Aggregate
// (Stats) API for the count of the same filter (no ORDERBY):
//   - count ≠ rows read                   -> refuse (count-mismatch);
//   - count request fails / unreadable    -> refuse (count-unavailable).
// The store throws `TestStoreInfrastructureError`; the legacy reader refuses
// with `truncated-read` — each package path's existing truncation outcome.
// With `X-Total-Count` present no stats request is ever sent.
//
// Residual pinned below: if the real Stats API count honours read ACLs (the
// fake's `statsCount.aclFiltered`), rows hidden by an ACL stay invisible.

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { ServiceNowError } from "@tessera/sn-client";

import {
  LegacyCleanupRefusalError,
  TestStoreInfrastructureError,
  TestStoreRefusalError,
  assertPortRequest,
  createAtfTestStore,
  deleteLegacyAtfRows,
  discoverLegacyAtfRows,
} from "../build/index.js";
import {
  RUN_ID,
  fakeClient,
  makeCtx,
  makeInstance,
  rowCounts,
  spec,
  tempLock,
} from "./support.js";

const STATS_PREFIX = "/api/now/stats/";
const LEGACY_RUN = "run-20260920t101500-abcdef01";

const statsCalls = (client) =>
  client.calls.filter((call) => call.path.startsWith(STATS_PREFIX));

const untriggered = () => makeCtx({ neverTriggered: true });

let lock;
beforeEach(() => {
  lock = tempLock();
});
afterEach(() => lock.cleanup());

/**
 * A fake whose sys_atf_test rows listed in the returned `hidden` set are
 * read-ACL-hidden (the rule is evaluated per read, so rows are hidden only
 * once added — projection itself sees everything).
 */
function aclInstance(statsCount) {
  const hidden = new Set();
  const instance = makeInstance({
    readAcl: {
      rules: [{ table: "sys_atf_test", when: (row) => hidden.has(row.sys_id) }],
    },
    ...(statsCount === undefined ? {} : { statsCount }),
  });
  return { instance, hidden };
}

const sortedTests = (instance) =>
  instance.tables
    .all("sys_atf_test")
    .map((row) => row.sys_id)
    .sort();

async function projected(instance, ids, { pageSize, withTotal = false }) {
  const client = fakeClient(instance, { withTotal });
  const store = createAtfTestStore({
    client,
    lockPath: lock.lockPath,
    onWarning: () => {},
    pageSize,
  });
  await store.project(
    makeCtx(),
    ids.map((id) => spec(id)),
  );
  client.calls.length = 0;
  return { store, client };
}

async function assertTeardownRefused(store, instance, pattern) {
  const before = rowCounts(instance);
  let caught;
  await assert.rejects(store.teardown(untriggered()), (error) => {
    assert.ok(error instanceof TestStoreInfrastructureError, String(error));
    assert.match(error.message, pattern);
    caught = error;
    return true;
  });
  assert.deepEqual(rowCounts(instance), before);
  store.release();
  return caught;
}

describe("store discovery: Stats count cross-check without X-Total-Count", () => {
  test("a middle window trimmed to ZERO rows no longer ends discovery silently", async () => {
    const { instance, hidden } = aclInstance();
    const { store, client } = await projected(
      instance,
      ["a1", "a2", "a3", "a4", "a5", "a6"],
      { pageSize: 2 },
    );
    const ordered = sortedTests(instance);
    hidden.add(ordered[2]);
    hidden.add(ordered[3]);
    await assertTeardownRefused(
      store,
      instance,
      /Stats API counted 6 .*returned 2/,
    );
    // Page 0 (2 rows), page 1 (empty) -> one count; rows 5/6 were never read.
    const tablePages = client.calls.filter(
      (call) => call.path === "/api/now/table/sys_atf_test",
    );
    assert.equal(tablePages.length, 2);
    assert.equal(statsCalls(client).length, 1);
  });

  test("a trimmed LAST window is refused (default fake: count ignores ACLs)", async () => {
    const { instance, hidden } = aclInstance();
    const { store } = await projected(instance, ["a1", "a2", "a3"], {
      pageSize: 2,
    });
    hidden.add(sortedTests(instance)[2]);
    await assertTeardownRefused(
      store,
      instance,
      /Stats API counted 3 .*returned 2/,
    );
  });

  test("a short (trimmed, non-empty) window followed by the end is refused", async () => {
    const { instance, hidden } = aclInstance();
    const { store } = await projected(instance, ["a1", "a2", "a3"], {
      pageSize: 2,
    });
    hidden.add(sortedTests(instance)[1]);
    await assertTeardownRefused(store, instance, /count-mismatch|counted 3/);
  });

  test("RESIDUAL (pinned): an ACL-filtered count cannot see a trimmed last window", async () => {
    const { instance, hidden } = aclInstance({ aclFiltered: true });
    const { store } = await projected(instance, ["a1", "a2", "a3"], {
      pageSize: 2,
    });
    const last = sortedTests(instance)[2];
    hidden.add(last);
    await store.teardown(untriggered());
    // The hidden test survives silently: count (2) == rows read (2).
    assert.deepEqual(
      instance.tables.all("sys_atf_test").map((row) => row.sys_id),
      [last],
    );
  });

  test("a complete read sends one count per exhausted query, without ORDERBY", async () => {
    const instance = makeInstance();
    const { store, client } = await projected(instance, ["a1", "a2"], {
      pageSize: 5,
    });
    await store.teardown(untriggered());
    assert.equal(rowCounts(instance).sys_atf_test, 0);
    const counts = statsCalls(client);
    assert.ok(counts.length > 0);
    for (const call of counts) {
      assert.equal(call.method, "GET");
      assert.equal(call.params.get("sysparm_count"), "true");
      assert.equal(call.params.has("sysparm_limit"), false);
      assert.equal(call.params.has("sysparm_offset"), false);
      assert.doesNotMatch(call.params.get("sysparm_query") ?? "", /ORDERBY/);
    }
    const testCount = counts.find(
      (call) => call.path === `${STATS_PREFIX}sys_atf_test`,
    );
    assert.equal(
      testCount.params.get("sysparm_query"),
      `nameSTARTSWITH${RUN_ID}:`,
    );
  });

  for (const [label, arrange] of [
    [
      "HTTP 503",
      (instance) =>
        instance.faults.add({
          match: { path: STATS_PREFIX },
          mode: { kind: "http-error", status: 503 },
        }),
    ],
    [
      "transport error",
      (instance) =>
        instance.faults.add({
          match: { path: STATS_PREFIX },
          mode: { kind: "transport-error" },
        }),
    ],
    [
      "HTTP 404 (no Stats API)",
      (instance) =>
        instance.faults.add({
          match: { path: STATS_PREFIX },
          mode: { kind: "http-error", status: 404 },
        }),
    ],
  ]) {
    test(`a failed count (${label}) refuses — count-unavailable`, async () => {
      const instance = makeInstance();
      const { store } = await projected(instance, ["a1"], { pageSize: 5 });
      arrange(instance);
      const error = await assertTeardownRefused(
        store,
        instance,
        /Stats API count .*unavailable/,
      );
      assert.ok(error.cause instanceof Error);
    });
  }

  for (const fault of ["non-numeric-count", "missing-count"]) {
    test(`an unreadable count (${fault}) refuses — count-unavailable`, async () => {
      // The fault is live from the start, so project()'s own discovery of
      // existing run rows refuses — before any write.
      const instance = makeInstance({ statsCount: { fault } });
      const before = rowCounts(instance);
      const client = fakeClient(instance, { withTotal: false });
      const store = createAtfTestStore({
        client,
        lockPath: lock.lockPath,
        onWarning: () => {},
      });
      await assert.rejects(store.project(makeCtx(), [spec("a1")]), (error) => {
        assert.ok(error instanceof TestStoreInfrastructureError);
        assert.match(
          error.message,
          /count-unavailable: .*result\.stats\.count is missing or not a non-negative integer/,
        );
        return true;
      });
      assert.deepEqual(rowCounts(instance), before);
      assert.deepEqual(
        client.calls.filter((call) => call.method !== "GET"),
        [],
      );
      store.release();
    });
  }

  test("a count BELOW the rows read is a mismatch too", async () => {
    const instance = makeInstance();
    const base = fakeClient(instance, { withTotal: false });
    const client = {
      calls: base.calls,
      request: (args) =>
        args.path.startsWith(STATS_PREFIX)
          ? Promise.resolve({
              status: 200,
              data: { result: { stats: { count: "0" } } },
            })
          : base.request(args),
    };
    instance.tables.insert("sys_atf_test", { name: `${RUN_ID}:x` });
    const again = createAtfTestStore({
      client,
      lockPath: lock.lockPath,
      onWarning: () => {},
    });
    await assertTeardownRefused(again, instance, /counted 0 .*returned 1/);
  });

  test("with X-Total-Count present no Stats request is ever sent", async () => {
    const { instance, hidden } = aclInstance();
    const { store, client } = await projected(instance, ["a1", "a2", "a3"], {
      pageSize: 2,
      withTotal: true,
    });
    hidden.add(sortedTests(instance)[0]);
    await store.teardown(untriggered());
    assert.equal(statsCalls(client).length, 0);
    assert.equal(rowCounts(instance).sys_atf_test, 1);
  });
});

describe("C5 guard: a GET-only Stats count is the one non-Table path", () => {
  test("GET /api/now/stats/<table> passes; everything else is refused", () => {
    assert.doesNotThrow(() =>
      assertPortRequest({ method: "GET", path: `${STATS_PREFIX}sys_atf_test` }),
    );
    assert.doesNotThrow(() =>
      assertPortRequest({
        method: "POST",
        path: "/api/now/table/sys_atf_test",
      }),
    );
    for (const bad of [
      { method: "POST", path: `${STATS_PREFIX}sys_atf_test` },
      { method: "PATCH", path: `${STATS_PREFIX}sys_atf_test` },
      { method: "DELETE", path: `${STATS_PREFIX}sys_atf_test` },
      { method: "GET", path: STATS_PREFIX },
      { method: "GET", path: `${STATS_PREFIX}sys_atf_test/x` },
      { method: "GET", path: `${STATS_PREFIX}sys_atf_test?sysparm_count=true` },
      { method: "GET", path: "/api/now/statsx/sys_atf_test" },
      { method: "GET", path: "/api/x_tessera/author/step_input" },
    ]) {
      assert.throws(
        () => assertPortRequest(bad),
        (error) =>
          error instanceof TestStoreRefusalError &&
          error.code === "acl-free-endpoint",
        `${bad.method} ${bad.path}`,
      );
    }
  });
});

describe("legacy discovery: Stats count cross-check without X-Total-Count", () => {
  const LEGACY_TEST = "a".repeat(32);

  function legacyInstance(options = {}) {
    const hidden = new Set();
    const instance = makeInstance({
      readAcl: {
        rules: [
          { table: "sys_atf_test", when: (row) => hidden.has(row.sys_id) },
        ],
      },
      state: {
        sys_atf_test: [
          { sys_id: LEGACY_TEST, name: `${LEGACY_RUN}:alpha`, description: "" },
        ],
      },
      ...options,
    });
    return { instance, hidden };
  }

  const refusedTruncated = (pattern) => (error) => {
    assert.ok(error instanceof LegacyCleanupRefusalError, String(error));
    assert.equal(error.reason, "truncated-read", error.message);
    assert.match(error.message, pattern);
    assert.match(error.message, /nothing was deleted/);
    return true;
  };

  test("a hidden legacy row (window trimmed to zero) refuses as truncated-read", async () => {
    const { instance, hidden } = legacyInstance();
    hidden.add(LEGACY_TEST);
    await assert.rejects(
      discoverLegacyAtfRows({
        client: fakeClient(instance, { withTotal: false }),
      }),
      refusedTruncated(/Stats API counted 1 .*returned 0/),
    );
  });

  test("RESIDUAL (pinned): an ACL-filtered count hides the legacy row", async () => {
    const { instance, hidden } = legacyInstance({
      statsCount: { aclFiltered: true },
    });
    hidden.add(LEGACY_TEST);
    const report = await discoverLegacyAtfRows({
      client: fakeClient(instance, { withTotal: false }),
    });
    assert.equal(report.candidates.length, 0);
  });

  test("a complete read reports the row and counts each query without ORDERBY", async () => {
    const { instance } = legacyInstance();
    const client = fakeClient(instance, { withTotal: false });
    const report = await discoverLegacyAtfRows({ client });
    assert.deepEqual(
      report.candidates.map((c) => c.sysId),
      [LEGACY_TEST],
    );
    const counts = statsCalls(client);
    assert.ok(counts.length > 0);
    for (const call of counts) {
      assert.equal(call.method, "GET");
      assert.doesNotMatch(call.params.get("sysparm_query") ?? "", /ORDERBY/);
    }
    assert.ok(
      counts.some(
        (call) =>
          call.path === `${STATS_PREFIX}sys_atf_test` &&
          call.params.get("sysparm_query") === "nameSTARTSWITHrun-",
      ),
    );
  });

  test("a failed count refuses as truncated-read (count-unavailable)", async () => {
    const { instance } = legacyInstance();
    instance.faults.add({
      match: { path: STATS_PREFIX },
      mode: { kind: "http-error", status: 404 },
    });
    await assert.rejects(
      discoverLegacyAtfRows({
        client: fakeClient(instance, { withTotal: false }),
      }),
      refusedTruncated(/Stats API count .*unavailable/),
    );
  });

  test("an unreadable count refuses as truncated-read", async () => {
    const { instance } = legacyInstance({
      statsCount: { fault: "non-numeric-count" },
    });
    await assert.rejects(
      discoverLegacyAtfRows({
        client: fakeClient(instance, { withTotal: false }),
      }),
      refusedTruncated(/unavailable/),
    );
  });

  test("the pre-DELETE re-verification read is cross-checked too", async () => {
    const { instance, hidden } = legacyInstance();
    const client = fakeClient(instance, { withTotal: false });
    const report = await discoverLegacyAtfRows({ client });
    hidden.add(LEGACY_TEST);
    client.calls.length = 0;
    await assert.rejects(
      deleteLegacyAtfRows({ client, report, confirmedSysIds: [LEGACY_TEST] }),
      refusedTruncated(/Stats API counted/),
    );
    assert.deepEqual(
      client.calls.filter((call) => call.method !== "GET"),
      [],
    );
    assert.equal(instance.tables.count("sys_atf_test"), 1);
  });

  test("with X-Total-Count present no Stats request is sent", async () => {
    const { instance } = legacyInstance();
    const client = fakeClient(instance);
    await discoverLegacyAtfRows({ client });
    assert.equal(statsCalls(client).length, 0);
  });
});

// Keep the ServiceNowError import meaningful: the fake transport raises it
// for the Stats faults above, and the store must normalise it.
test("the fake transport raises ServiceNowError for a Stats fault", async () => {
  const instance = makeInstance();
  instance.faults.add({
    match: { path: STATS_PREFIX },
    mode: { kind: "http-error", status: 404 },
  });
  await assert.rejects(
    fakeClient(instance).request({
      method: "GET",
      path: `${STATS_PREFIX}sys_atf_test`,
      params: new URLSearchParams({ sysparm_count: "true" }),
    }),
    ServiceNowError,
  );
});
