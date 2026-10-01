// Wave 15 — reads without `X-Total-Count` (TODO 2026-09-25 residual).
//
// The Table API applies read ACLs AFTER limit/offset, so a window can come
// back short while later offsets still hold rows. With `X-Total-Count` the
// count (taken before the ACL filter) exposes that; without it a short page
// used to be read as "the end of results", and a row hidden that way could
// silently shrink the nested-suite tree or starve a (test, suite result) pair
// — whose failing row then never reached the worst-of join.
//
// `@tessera/sn-client`'s `fetchAll` now probes one window past a short,
// non-empty page when the count is absent; the runner's own `readTable`
// mirrors that probe. What these tests pin down:
//   - a trimmed window with rows past it is never a complete read: the
//     suite-tree read faults (DEV-1), the result read falls back per test;
//   - a probe that fails is treated the same way (never "complete");
//   - a genuinely short last page costs exactly one extra, empty request
//     (plus, since wave 16, one Stats count — see statsCount.test.js);
//   - an empty page is not probed (wave 16: a Stats count confirms it);
//   - with `X-Total-Count` present nothing changes: no probe is ever sent.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";
import { ServiceNowError } from "@tessera/sn-client";

import {
  ATF_SUITE_RESULT_TABLE,
  ATF_TEST_RESULT_TABLE,
  TABLE_API_PREFIX,
  fetchSuiteResultTree,
  fetchTestResults,
} from "../build/index.js";

import {
  assertInfraFault,
  fakeClient,
  scriptedClient,
  seedResult,
  sysId,
} from "./support.js";

const SUITE_TREE_PATH = `${TABLE_API_PREFIX}${ATF_SUITE_RESULT_TABLE}`;
const RESULT_PATH = `${TABLE_API_PREFIX}${ATF_TEST_RESULT_TABLE}`;
const ROOT = sysId("root");
const CHILD = sysId("child");

/** A fake that never sends `X-Total-Count`, optionally with row read ACLs. */
function noCount(rules) {
  return createFakeInstance({
    omitTotalCount: true,
    ...(rules === undefined ? {} : { readAcl: { rules } }),
  });
}

/** Insert `n` child suite-result rows under `parent`, sys_id-ordered by label. */
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

const probes = (client) =>
  client.calls.filter((call) => call.params.sysparm_offset !== undefined);

describe("fetchSuiteResultTree without X-Total-Count", () => {
  it("a trimmed first window with rows past it rejects instead of a partial tree", async () => {
    const instance = noCount(hideSecretSuites);
    // Budget 4 -> the level-1 read asks for 4 rows. c1 is hidden, so the
    // window returns 3 (<= the 3 remaining) and used to read as complete —
    // silently dropping c1 and c5.
    children(instance, ROOT, ["c1", "c2", "c3", "c4", "c5"], new Set(["c1"]));
    const client = fakeClient(instance);
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT, { maxSuiteResults: 4 }),
      /returned 3 of a 4-row window with no X-Total-Count while a later offset still held rows/,
    );
    assert.equal(probes(client).length, 1);
    assert.equal(probes(client)[0].params.sysparm_offset, "4");
  });

  it("a trimmed window on a deeper level rejects too", async () => {
    const instance = noCount(hideSecretSuites);
    const [a] = children(instance, ROOT, ["a"]);
    // After level 1 the tree holds 2 rows, so level 2 asks for 3 (budget 4).
    children(instance, a, ["a1", "a2", "a3", "a4"], new Set(["a1"]));
    const client = fakeClient(instance);
    await assertInfraFault(
      fetchSuiteResultTree(client, ROOT, { maxSuiteResults: 4 }),
      /depth 2 returned 2 of a 3-row window with no X-Total-Count/,
    );
  });

  it("a genuinely short last page costs one empty probe and reads the whole tree", async () => {
    const instance = noCount();
    const [a, b] = children(instance, ROOT, ["a", "b"]);
    const client = fakeClient(instance);
    const tree = await fetchSuiteResultTree(client, ROOT);
    assert.deepEqual(tree, { root: ROOT, ids: [ROOT, a, b], depth: 1 });
    // Level 1 read, its probe, its Stats count (wave 16), level 2 read
    // (empty: no probe), its Stats count.
    assert.equal(client.calls.length, 5);
    const [first, probe, , second] = client.calls;
    assert.equal(probe.path, SUITE_TREE_PATH);
    assert.equal(probe.params.sysparm_query, first.params.sysparm_query);
    assert.equal(probe.params.sysparm_limit, first.params.sysparm_limit);
    // The probe starts one requested window past the page, not one row count.
    assert.equal(probe.params.sysparm_offset, first.params.sysparm_limit);
    assert.equal(second.params.sysparm_offset, undefined);
    // Offset paging needs a stable order: the read is sys_id-ordered.
    assert.match(first.params.sysparm_query, /\^ORDERBYsys_id$/);
  });

  it("an empty page is not probed; one Stats count confirms the end (wave 16)", async () => {
    const client = fakeClient(noCount());
    const tree = await fetchSuiteResultTree(client, ROOT);
    assert.deepEqual(tree, { root: ROOT, ids: [ROOT], depth: 0 });
    assert.equal(client.calls.length, 2);
    assert.deepEqual(probes(client), []);
    assert.equal(
      client.calls[1].path,
      "/api/now/stats/sys_atf_test_suite_result",
    );
  });

  it("a failed probe rejects: the end of the tree was never confirmed", async () => {
    const boom = new ServiceNowError("ServiceNow API error (503)", 503, {});
    const client = scriptedClient(({ params }) => {
      if (params.get("sysparm_offset") !== null) throw boom;
      return { data: { result: [{ sys_id: sysId("a"), parent: ROOT }] } };
    });
    await assert.rejects(fetchSuiteResultTree(client, ROOT), (error) => {
      assert.equal(error.name, "AtfInfrastructureError");
      assert.match(
        error.message,
        /could not confirm the end of the page: the follow-up request .* failed/,
      );
      assert.match(error.message, /HTTP 503/);
      assert.equal(error.cause?.cause, boom);
      return true;
    });
    assert.equal(client.calls.length, 2);
  });

  it("with X-Total-Count present no probe is ever sent", async () => {
    const instance = createFakeInstance({
      readAcl: { rules: hideSecretSuites },
    });
    children(instance, ROOT, ["a", "b"]);
    const client = fakeClient(instance);
    await fetchSuiteResultTree(client, ROOT);
    assert.deepEqual(probes(client), []);
  });
});

describe("fetchTestResults without X-Total-Count", () => {
  const alpha = sysId("test-alpha");
  const beta = sysId("test-beta");
  const at = (second) => `2026-01-01 00:00:${String(second).padStart(2, "0")}`;

  /**
   * Batch window = 2 tests x 2 links x 4 = 16 rows, newest first: beta's
   * green row, then 16 alpha rows (one hidden by a read ACL), then beta's RED
   * row under the child suite at offset 17. The first window returns 15 rows.
   */
  function starvedSibling(rules) {
    const instance = noCount(rules);
    seedResult(instance, {
      test: beta,
      status: "success",
      link: ROOT,
      sys_created_on: at(59),
    });
    for (let i = 0; i < 16; i += 1) {
      seedResult(instance, {
        test: alpha,
        status: "success",
        link: ROOT,
        output: i === 3 ? "hidden" : "",
        sys_created_on: at(50 - i),
      });
    }
    seedResult(instance, {
      test: beta,
      status: "failure",
      link: CHILD,
      sys_created_on: at(0),
    });
    return instance;
  }

  const hideOutput = [
    { table: ATF_TEST_RESULT_TABLE, when: (row) => row.output === "hidden" },
  ];

  it("a trimmed batch page cannot hide a sibling's failure from the worst-of join", async () => {
    const client = fakeClient(starvedSibling(hideOutput));
    const rows = await fetchTestResults(client, [alpha, beta], [ROOT, CHILD]);
    assert.equal(rows.get(beta)?.status, "failure");
    // The batch read's probe comes first; the per-test re-reads may probe too.
    assert.equal(probes(client)[0]?.params.sysparm_offset, "16");
    // The per-test re-read happened (the fallback a truncated page triggers).
    assert.ok(
      client.calls.some((call) =>
        call.params.sysparm_query.includes(`^test=${beta}^`),
      ),
    );
  });

  it("a failed probe is treated as a partial page: the per-test fallback runs", async () => {
    const boom = new ServiceNowError("ServiceNow API error (500)", 500, {});
    const row = (test, second) => ({
      sys_id: sysId(`r-${test}`),
      test,
      status: "failure",
      output: "",
      sys_created_on: at(second),
      test_suite_result: ROOT,
    });
    const client = scriptedClient(({ params }) => {
      if (params.get("sysparm_offset") !== null) throw boom;
      const query = params.get("sysparm_query") ?? "";
      if (query.includes(`^test=${beta}^`))
        return { data: { result: [row(beta, 1)] } };
      if (query.includes(`^test=${alpha}^`)) {
        return { data: { result: [row(alpha, 2)] } };
      }
      // The batch page: alpha only, short, no count.
      return { data: { result: [row(alpha, 2)] } };
    });
    const rows = await fetchTestResults(client, [alpha, beta], ROOT);
    assert.equal(rows.get(beta)?.status, "failure");
    assert.equal(
      client.calls.filter((call) => call.params.get("sysparm_offset") !== null)
        .length,
      1,
    );
  });

  it("a genuinely short page costs one empty probe and no fallback", async () => {
    const instance = noCount();
    seedResult(instance, { test: alpha, status: "success", link: ROOT });
    seedResult(instance, { test: beta, status: "failure", link: ROOT });
    const client = fakeClient(instance);
    const rows = await fetchTestResults(client, [alpha, beta], ROOT);
    assert.equal(rows.get(alpha)?.status, "success");
    assert.equal(rows.get(beta)?.status, "failure");
    // Page, probe, and (wave 16) one Stats count that agrees.
    assert.equal(client.calls.length, 3);
    assert.equal(client.calls[1].path, RESULT_PATH);
    assert.equal(client.calls[1].params.sysparm_offset, "8");
    assert.equal(client.calls[2].path, "/api/now/stats/sys_atf_test_result");
  });

  it("with X-Total-Count present the result read is unchanged: no probe", async () => {
    const instance = createFakeInstance();
    seedResult(instance, { test: alpha, status: "success", link: ROOT });
    const client = fakeClient(instance);
    await fetchTestResults(client, [alpha, beta], ROOT);
    assert.equal(client.calls.length, 1);
    assert.deepEqual(probes(client), []);
  });
});
