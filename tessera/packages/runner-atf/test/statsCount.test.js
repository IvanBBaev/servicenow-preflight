// Wave 16 — the Stats-API count cross-check on reads without `X-Total-Count`.
//
// Wave 15 closed the "short non-empty page with rows past it" hole with a
// probe; two holes stayed open (fail-OPEN): a window the read ACLs trimmed to
// ZERO rows read as "no rows", and a trimmed LAST window (nothing past it) was
// indistinguishable from the end. `readTable` now asks the Aggregate (Stats)
// API for the count of the same filter (no ORDERBY) whenever the Table API
// sent no `X-Total-Count` and the read is otherwise complete:
//   - count ≠ rows read      -> `count-mismatch` (incomplete);
//   - count request fails /
//     unreadable count       -> `count-unavailable` (incomplete).
// The suite-tree read turns both into DEV-1 faults; the result and step reads
// turn them into their existing per-item fallbacks. With `X-Total-Count`
// present no stats request is ever sent.
//
// Residual pinned below: if the real Stats API count honours read ACLs (the
// fake's `statsCount.aclFiltered`), a trimmed last window stays invisible.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";
import { ServiceNowError } from "@tessera/sn-client";

import {
  ATF_SUITE_RESULT_TABLE,
  ATF_TEST_RESULT_ITEM_TABLE,
  ATF_TEST_RESULT_TABLE,
  fetchResultItems,
  fetchSuiteResultTree,
  fetchTestResults,
} from "../build/index.js";

import {
  assertInfraFault,
  fakeClient,
  scriptedClient,
  seedResult,
  seedResultItem,
  sysId,
} from "./support.js";

const STATS_PREFIX = "/api/now/stats/";
const ROOT = sysId("root");

/** A fake without `X-Total-Count`, optionally with row read ACLs and stats knobs. */
function noCount(rules, statsCount) {
  return createFakeInstance({
    omitTotalCount: true,
    ...(rules === undefined ? {} : { readAcl: { rules } }),
    ...(statsCount === undefined ? {} : { statsCount }),
  });
}

function children(instance, parent, labels, hidden = new Set()) {
  return labels.map(
    (label) =>
      instance.tables.insert(
        ATF_SUITE_RESULT_TABLE,
        { parent, test_suite: hidden.has(label) ? "secret" : "open" },
        sysId(label),
      ).sys_id,
  );
}

const hideSecretSuites = [
  { table: ATF_SUITE_RESULT_TABLE, when: (row) => row.test_suite === "secret" },
];

const statsCalls = (client) =>
  client.calls.filter((call) => call.path.startsWith(STATS_PREFIX));

describe("fetchSuiteResultTree: Stats count cross-check without X-Total-Count", () => {
  it("a window trimmed to ZERO rows is a fault, not an empty level", async () => {
    // Budget 3 -> the level-1 read asks for 3 rows; c1..c3 are hidden, so the
    // window comes back empty and used to read as "no child suites".
    const instance = noCount(hideSecretSuites);
    children(
      instance,
      ROOT,
      ["c1", "c2", "c3", "c4", "c5"],
      new Set(["c1", "c2", "c3"]),
    );
    const client = fakeClient(instance);
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT, { maxSuiteResults: 3 }),
      /Stats API counted 5 child sys_atf_test_suite_result row\(s\) under execution .* at depth 1 but the Table API returned 0/,
    );
    const [stats] = statsCalls(client);
    assert.ok(stats, "one stats request");
    assert.equal(stats.path, `${STATS_PREFIX}${ATF_SUITE_RESULT_TABLE}`);
    assert.equal(stats.params.sysparm_count, "true");
    // Same filter, no ORDERBY, no paging parameters.
    assert.equal(stats.params.sysparm_query, `parent=${ROOT}`);
    assert.equal(stats.params.sysparm_limit, undefined);
    assert.equal(stats.params.sysparm_offset, undefined);
  });

  it("a zero-row window is caught even when the count is ACL-filtered (visible rows past it)", async () => {
    const instance = noCount(hideSecretSuites, { aclFiltered: true });
    children(
      instance,
      ROOT,
      ["c1", "c2", "c3", "c4", "c5"],
      new Set(["c1", "c2", "c3"]),
    );
    await assertInfraFault(
      fetchSuiteResultTree(fakeClient(instance), ROOT, { maxSuiteResults: 3 }),
      /Stats API counted 2 .* but the Table API returned 0/,
    );
  });

  it("a trimmed LAST window (nothing past it) is a fault under the default count", async () => {
    const instance = noCount(hideSecretSuites);
    children(instance, ROOT, ["a", "b"], new Set(["b"]));
    const client = fakeClient(instance);
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT),
      /Stats API counted 2 .* at depth 1 but the Table API returned 1/,
    );
    // Order: the page, its (empty) probe, then the count.
    assert.equal(client.calls.length, 3);
    assert.ok(client.calls[2].path.startsWith(STATS_PREFIX));
  });

  it("RESIDUAL pinned: an ACL-filtered count cannot see a trimmed last window", async () => {
    const instance = noCount(hideSecretSuites, { aclFiltered: true });
    const [a] = children(instance, ROOT, ["a", "b"], new Set(["b"]));
    const tree = await fetchSuiteResultTree(fakeClient(instance), ROOT);
    // b is silently absent: the count agrees with the rows the ACL let through.
    assert.deepEqual(tree, { root: ROOT, ids: [ROOT, a], depth: 1 });
  });

  it("a genuinely complete read passes, one count per level", async () => {
    const instance = noCount();
    const [a, b] = children(instance, ROOT, ["a", "b"]);
    const client = fakeClient(instance);
    const tree = await fetchSuiteResultTree(client, ROOT);
    assert.deepEqual(tree, { root: ROOT, ids: [ROOT, a, b], depth: 1 });
    // Level 1: page + probe + count; level 2 (empty): page + count.
    assert.equal(client.calls.length, 5);
    assert.equal(statsCalls(client).length, 2);
    assert.equal(
      statsCalls(client)[1].params.sysparm_query,
      `parentIN${a},${b}`,
    );
  });

  it("a failing stats request is a fault (count-unavailable), never a complete tree", async () => {
    const instance = noCount();
    children(instance, ROOT, ["a"]);
    instance.faults.add({
      match: { path: STATS_PREFIX },
      mode: { kind: "http-error", status: 503 },
    });
    await assert.rejects(
      fetchSuiteResultTree(fakeClient(instance), ROOT),
      (error) => {
        assert.equal(error.name, "AtfInfrastructureError");
        assert.match(
          error.message,
          /no X-Total-Count and the Stats API count that would confirm the end of the page is unavailable/,
        );
        assert.match(error.message, /HTTP 503/);
        assert.equal(error.cause?.name, "AtfInfrastructureError");
        return true;
      },
    );
  });

  it("a count BELOW the rows read is a mismatch too", async () => {
    const client = scriptedClient(({ path, params }) => {
      if (path.startsWith(STATS_PREFIX)) {
        return { data: { result: { stats: { count: "0" } } } };
      }
      if (params.get("sysparm_offset") !== null)
        return { data: { result: [] } };
      return {
        data: {
          result: params.get("sysparm_query").startsWith(`parent=${ROOT}`)
            ? [{ sys_id: sysId("a"), parent: ROOT }]
            : [],
        },
      };
    });
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT),
      /Stats API counted 0 .* but the Table API returned 1/,
    );
  });

  it("an instance without the Stats API (404) fails closed", async () => {
    const client = scriptedClient(({ path }) => {
      if (path.startsWith(STATS_PREFIX)) {
        throw new ServiceNowError("ServiceNow API error (404)", 404, {});
      }
      return { data: { result: [] } };
    });
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT),
      /Stats API count .* is unavailable.*HTTP 404/,
    );
  });

  for (const fault of ["non-numeric-count", "missing-count"]) {
    it(`an unreadable count (${fault}) fails closed`, async () => {
      const instance = noCount(undefined, { fault });
      await assertInfraFault(
        fetchSuiteResultTree(fakeClient(instance), ROOT),
        /Stats API count .* is unavailable.*result\.stats\.count is missing or not a non-negative integer/,
      );
    });
  }

  it("with X-Total-Count present no stats request is ever sent", async () => {
    const instance = createFakeInstance({
      readAcl: { rules: hideSecretSuites },
    });
    const [a] = children(instance, ROOT, ["a"]);
    const client = fakeClient(instance);
    const tree = await fetchSuiteResultTree(client, ROOT);
    assert.deepEqual(tree.ids, [ROOT, a]);
    assert.deepEqual(statsCalls(client), []);
  });
});

describe("fetchTestResults: Stats count cross-check without X-Total-Count", () => {
  const alpha = sysId("test-alpha");
  const beta = sysId("test-beta");
  const hideOutput = [
    { table: ATF_TEST_RESULT_TABLE, when: (row) => row.output === "hidden" },
  ];

  it("a hidden row in the last window triggers the per-test fallback", async () => {
    const instance = noCount(hideOutput);
    seedResult(instance, { test: alpha, status: "success", link: ROOT });
    seedResult(instance, {
      test: beta,
      status: "failure",
      link: ROOT,
      output: "hidden",
    });
    const client = fakeClient(instance);
    const rows = await fetchTestResults(client, [alpha, beta], ROOT);
    assert.equal(rows.get(alpha)?.status, "success");
    // beta's row stays unreadable -> absent (reads `missing`, §6a blocking).
    assert.equal(rows.has(beta), false);
    // The batch count mismatched, so each test was re-read on its own.
    assert.ok(
      client.calls.some(
        (call) =>
          !call.path.startsWith(STATS_PREFIX) &&
          call.params.sysparm_query.includes(`^test=${beta}^`),
      ),
    );
    // The count query is the batch filter without its ORDERBY.
    assert.equal(
      statsCalls(client)[0].params.sysparm_query,
      `test_suite_result=${ROOT}^testIN${alpha},${beta}`,
    );
  });

  it("an unavailable count triggers the per-test fallback", async () => {
    // Only alpha has a row: without the count the short page would be the
    // whole answer; with the count unavailable, beta's absence is re-read.
    const instance = noCount();
    seedResult(instance, { test: alpha, status: "success", link: ROOT });
    instance.faults.add({
      match: { path: STATS_PREFIX },
      mode: { kind: "transport-error" },
    });
    const client = fakeClient(instance);
    const rows = await fetchTestResults(client, [alpha, beta], ROOT);
    assert.equal(rows.get(alpha)?.status, "success");
    assert.equal(rows.has(beta), false);
    assert.ok(
      client.calls.some(
        (call) =>
          !call.path.startsWith(STATS_PREFIX) &&
          call.params.sysparm_query.startsWith(
            `test_suite_result=${ROOT}^test=${beta}^`,
          ),
      ),
    );
  });

  it("a complete read costs page + probe + one count and no fallback", async () => {
    const instance = noCount();
    seedResult(instance, { test: alpha, status: "success", link: ROOT });
    seedResult(instance, { test: beta, status: "failure", link: ROOT });
    const client = fakeClient(instance);
    await fetchTestResults(client, [alpha, beta], ROOT);
    assert.equal(client.calls.length, 3);
    assert.equal(statsCalls(client).length, 1);
    assert.equal(
      statsCalls(client)[0].path,
      `${STATS_PREFIX}${ATF_TEST_RESULT_TABLE}`,
    );
  });

  it("with X-Total-Count present no stats request is sent", async () => {
    const instance = createFakeInstance();
    seedResult(instance, { test: alpha, status: "success", link: ROOT });
    const client = fakeClient(instance);
    await fetchTestResults(client, [alpha, beta], ROOT);
    assert.deepEqual(statsCalls(client), []);
  });
});

describe("fetchResultItems: Stats count cross-check without X-Total-Count", () => {
  it("a count mismatch discards the batch page and re-reads per result", async () => {
    const r1 = sysId("result-1");
    const r2 = sysId("result-2");
    const instance = noCount([
      {
        table: ATF_TEST_RESULT_ITEM_TABLE,
        when: (row) => row.output === "hidden",
      },
    ]);
    seedResultItem(instance, { test_result: r1, status: "failure", order: 1 });
    seedResultItem(instance, {
      test_result: r2,
      status: "failure",
      order: 2,
      output: "hidden",
    });
    const client = fakeClient(instance);
    const items = await fetchResultItems(client, [r1, r2]);
    assert.equal(items.get(r1)?.length, 1);
    const tableReads = client.calls.filter(
      (call) => !call.path.startsWith(STATS_PREFIX),
    );
    assert.ok(
      tableReads.some(
        (call) =>
          call.params.sysparm_query === `test_result=${r2}^ORDERBYorder`,
      ),
      "per-result fallback read",
    );
    assert.equal(
      statsCalls(client)[0].params.sysparm_query,
      `test_resultIN${r1},${r2}`,
    );
  });
});
