// Per-spec attribution and the TM-1 defences — DEV-6 / DR-4 / ARCH-9 / QA-9.
//
// Three properties carry this module and each has its own block below.
//
// Attribution. A suite verdict says "Failed"; a checklist says WHICH spec
// failed. The mapping runs through the projection index, never through test
// names, so the tests that matter are the ones where names would mislead: a
// row belonging to a test nobody planned must not leak into a spec, and a
// planned spec with no row must come back "missing" rather than quietly
// vanishing into a pass.
//
// TM-1 defence #1 is structural and it is asserted on the wire: every read
// sends an explicit `sysparm_fields` allowlist, so a script column is never
// fetched. Asserting the constant against itself would prove nothing; the
// assertions below read the parameters the client was actually handed.
//
// TM-1 defence #2 is `sanitizeMessage`. Its job is to make one instance-authored
// string safe to paste into a `TestEvent`, and "safe" here means three separate
// things — no control characters, no unbounded length, and no *silent* cut.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";

import {
  ATF_TEST_RESULT_ITEM_TABLE,
  ATF_TEST_RESULT_TABLE,
  MAX_ASSERTION_CHARS,
  MAX_RESULT_ITEMS_PER_RESULT,
  MAX_RESULT_ROWS_PER_TEST,
  MAX_STEP_ITEMS,
  RESULT_FIELDS,
  RESULT_ITEM_FIELDS,
  RESULT_QUERY_BATCH,
  TABLE_API_PREFIX,
  fetchResultItems,
  fetchTestResults,
  mapResultStatus,
  parseSpecResults,
  sanitizeMessage,
} from "../build/index.js";

import {
  CANARY,
  assertInfraFault,
  assertNormalisedFault,
  fakeClient,
  scriptedClient,
  seedResult,
  seedResultItem,
  spec,
  suiteResultId,
  sysId,
  tablePage,
} from "./support.js";

const TEST_A = sysId("test-a");
const TEST_B = sysId("test-b");
const ROW_1 = sysId("row-1");
const ROW_2 = sysId("row-2");
/**
 * The `sys_atf_test_suite_result` every read here is scoped to. It is the id
 * the fake instance mints for its first suite trigger, so `seedResult`'s
 * default link and a scripted `resultRow` agree on it.
 */
const RID = suiteResultId(1);

const index = (...pairs) => new Map(pairs);

/** A `sys_atf_test_result` row as the Table API would return it. */
function resultRow(fields) {
  return {
    sys_id: ROW_1,
    test: TEST_A,
    status: "success",
    output: "",
    sys_created_on: "2026-08-21 10:00:00",
    test_suite_result: RID,
    ...fields,
  };
}

describe("sanitizeMessage", () => {
  it("keeps ordinary text untouched", () => {
    assert.equal(sanitizeMessage("expected 3, got 4"), "expected 3, got 4");
  });

  it("keeps tab and newline — they are the shape of a stack trace", () => {
    assert.equal(sanitizeMessage("a\tb\nc"), "a\tb\nc");
  });

  it("replaces every other control character with a space", () => {
    assert.equal(sanitizeMessage("a\u0000b"), "a b", "NUL");
    assert.equal(sanitizeMessage("a\u0007b"), "a b", "BEL");
    assert.equal(sanitizeMessage("a\u001bb"), "a b", "ESC — terminal escapes");
    assert.equal(sanitizeMessage("a\u007fb"), "a b", "DEL");
    assert.equal(sanitizeMessage("a\u009bb"), "a b", "C1 CSI");
  });

  it("replaces the two Unicode line separators, which JSON leaves raw", () => {
    assert.equal(sanitizeMessage("a\u2028b"), "a b");
    assert.equal(sanitizeMessage("a\u2029b"), "a b");
  });

  it("normalises CRLF to a single newline and a lone CR to a newline", () => {
    assert.equal(sanitizeMessage("a\r\nb"), "a\nb");
    assert.equal(sanitizeMessage("a\rb"), "a\nb");
    assert.equal(sanitizeMessage("a\n\rb"), "a\n\nb");
  });

  it("preserves astral characters rather than splitting a surrogate pair", () => {
    assert.equal(sanitizeMessage("a\u{1f600}b"), "a\u{1f600}b");
  });

  it("trims, so a message of pure whitespace becomes empty rather than blank noise", () => {
    assert.equal(sanitizeMessage("  \n\t hi \n "), "hi");
    assert.equal(sanitizeMessage("\u0000\u0001\u0002"), "");
  });

  it("caps at MAX_ASSERTION_CHARS by default", () => {
    const out = sanitizeMessage("a".repeat(MAX_ASSERTION_CHARS + 500));
    assert.ok(out.startsWith("a".repeat(MAX_ASSERTION_CHARS)));
    assert.equal(out.includes("a".repeat(MAX_ASSERTION_CHARS + 1)), false);
  });

  it("says how much it dropped — a silent truncation would hide lost evidence", () => {
    const out = sanitizeMessage("a".repeat(MAX_ASSERTION_CHARS + 500));
    assert.match(out, /…\[truncated 500 chars\]$/);
  });

  it("does not add a marker to a message that exactly fits", () => {
    const exact = "a".repeat(10);
    assert.equal(sanitizeMessage(exact, 10), exact);
    assert.equal(
      sanitizeMessage("a".repeat(11), 10).includes("truncated"),
      true,
    );
  });

  it("counts the cap AFTER scrubbing, so control bytes cannot buy extra room", () => {
    // The NUL becomes a space, and that space costs one of the three allowed
    // characters — a cap measured against the raw string would let "abc"
    // through untouched.
    assert.equal(sanitizeMessage("a\u0000bcd", 3), "a b …[truncated 2 chars]");
  });

  it("clamps a nonsensical cap to one character instead of returning nothing", () => {
    assert.equal(sanitizeMessage("x", 0), "x");
    assert.equal(sanitizeMessage("xy", 0), "x …[truncated 1 chars]");
    assert.equal(sanitizeMessage("xy", -5), "x …[truncated 1 chars]");
  });

  it("MAX_ASSERTION_CHARS is the documented 2000", () => {
    assert.equal(MAX_ASSERTION_CHARS, 2_000);
  });
});

describe("mapResultStatus", () => {
  const cases = {
    pass: ["success", "successful", "pass", "passed", "  SUCCESS  ", "Passed"],
    fail: ["failure", "failed", "fail", "FAILURE"],
    skipped: ["skipped", "skip", "Skipped"],
  };

  for (const [expected, inputs] of Object.entries(cases)) {
    for (const input of inputs) {
      it(`${JSON.stringify(input)} is ${expected}`, () => {
        assert.equal(mapResultStatus(input), expected);
      });
    }
  }

  it("calls anything unrecognised an error rather than guessing pass", () => {
    for (const input of ["", "pending", "running", "aborted", "unknown"]) {
      assert.equal(mapResultStatus(input), "error", JSON.stringify(input));
    }
  });
});

describe("fetchTestResults — the wire", () => {
  it("queries one test with `test=` and orders newest first", async () => {
    const client = scriptedClient(() => tablePage([resultRow({})]));
    await fetchTestResults(client, [TEST_A], RID);
    assert.equal(client.calls[0].method, "GET");
    assert.equal(
      client.calls[0].path,
      `${TABLE_API_PREFIX}${ATF_TEST_RESULT_TABLE}`,
    );
    assert.equal(
      client.paramsOf(0)["sysparm_query"],
      `test_suite_result=${RID}^test=${TEST_A}^ORDERBYDESCsys_created_on`,
    );
  });

  it("queries several tests with a single `IN`", async () => {
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, [TEST_A, TEST_B], RID);
    assert.equal(client.calls.length, 1);
    assert.equal(
      client.paramsOf(0)["sysparm_query"],
      `test_suite_result=${RID}^testIN${TEST_A},${TEST_B}^ORDERBYDESCsys_created_on`,
    );
  });

  it("sends the TM-1 field allowlist, and nothing outside it", async () => {
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, [TEST_A], RID);
    const fields = client.paramsOf(0)["sysparm_fields"].split(",");
    assert.deepEqual(fields, [...RESULT_FIELDS]);
    // The columns that would carry a script body are simply not asked for.
    for (const forbidden of ["script", "sys_class_name", "test.script"]) {
      assert.equal(fields.includes(forbidden), false, forbidden);
    }
  });

  it("asks for raw values, so a display value cannot smuggle in extra text", async () => {
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, [TEST_A], RID);
    assert.equal(client.paramsOf(0)["sysparm_display_value"], "false");
    assert.equal(client.paramsOf(0)["sysparm_exclude_reference_link"], "true");
  });

  it("bounds the page at MAX_RESULT_ROWS_PER_TEST per test", async () => {
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, [TEST_A, TEST_B], RID);
    assert.equal(
      client.paramsOf(0)["sysparm_limit"],
      String(2 * MAX_RESULT_ROWS_PER_TEST),
    );
    assert.equal(MAX_RESULT_ROWS_PER_TEST, 4);
  });

  it("splits into batches of RESULT_QUERY_BATCH, so an encoded query cannot outgrow a URL", async () => {
    const ids = Array.from({ length: RESULT_QUERY_BATCH + 1 }, (_v, i) =>
      sysId(`bulk-${i}`),
    );
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, ids, RID);
    assert.equal(client.calls.length, 2);
    assert.equal(
      client.paramsOf(0)["sysparm_query"].split(",").length,
      RESULT_QUERY_BATCH,
    );
    assert.equal(
      client.paramsOf(1)["sysparm_query"],
      `test_suite_result=${RID}^test=${ids[RESULT_QUERY_BATCH]}^ORDERBYDESCsys_created_on`,
    );
  });

  it("de-duplicates ids and drops empty ones before building the query", async () => {
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, [TEST_A, TEST_A, "", TEST_B], RID);
    assert.equal(
      client.paramsOf(0)["sysparm_query"],
      `test_suite_result=${RID}^testIN${TEST_A},${TEST_B}^ORDERBYDESCsys_created_on`,
    );
  });

  it("issues no request at all for an empty index", async () => {
    const client = scriptedClient(() => tablePage([]));
    assert.equal((await fetchTestResults(client, [], RID)).size, 0);
    assert.equal((await fetchTestResults(client, ["", ""], RID)).size, 0);
    assert.equal(client.calls.length, 0);
  });

  it("honours a caller-supplied result table", async () => {
    const client = scriptedClient(() => tablePage([]));
    await fetchTestResults(client, [TEST_A], RID, {
      resultTable: "u_atf_result",
    });
    assert.equal(client.calls[0].path, `${TABLE_API_PREFIX}u_atf_result`);
  });
});

describe("fetchTestResults — refusals and paging", () => {
  it("refuses to build a query from something that is not a sys_id", async () => {
    const client = scriptedClient(() => tablePage([]));
    await assertInfraFault(
      fetchTestResults(
        client,
        [`${TEST_A}^ORDERBYDESCsys_created_on^ORsys_idISNOTEMPTY`],
        RID,
      ),
      /refusing to build an encoded query/,
    );
    assert.equal(client.calls.length, 0, "nothing was sent");
  });

  it("rejects a body with no `result` array", async () => {
    const client = scriptedClient(() => ({
      data: { result: {} },
      status: 200,
    }));
    await assertInfraFault(
      fetchTestResults(client, [TEST_A], RID),
      /returned no 'result' array \(HTTP 200\)/,
    );
  });

  it("normalises a transport failure on the result read, naming the table", async () => {
    // This path had the same leak as the trigger and the poll and no test at
    // all, which is how a boundary ends up normalising on one path and leaking
    // on another. The read is on the wire like any other, so it answers with
    // the package's one fault type — with the original intact underneath.
    const instance = createFakeInstance();
    instance.faults.add({
      match: { path: `${TABLE_API_PREFIX}${ATF_TEST_RESULT_TABLE}` },
      mode: { kind: "http-error", status: 500 },
    });
    await assertNormalisedFault(
      fetchTestResults(fakeClient(instance), [TEST_A], RID),
      {
        status: 500,
        message: new RegExp(
          `read of ${ATF_TEST_RESULT_TABLE}\\) \\(HTTP 500\\)`,
        ),
      },
    );
  });

  it("keeps the newest row per test regardless of the order they arrive in", async () => {
    const rows = [
      resultRow({
        sys_id: ROW_1,
        sys_created_on: "2026-08-21 09:00:00",
        status: "failure",
      }),
      resultRow({
        sys_id: ROW_2,
        sys_created_on: "2026-08-21 11:00:00",
        status: "success",
      }),
    ];
    const client = scriptedClient(() => tablePage(rows));
    const newest = await fetchTestResults(client, [TEST_A], RID);
    assert.equal(newest.get(TEST_A).sysId, ROW_2);
  });

  it("ignores rows with no test reference or no sys_id — they cannot be attributed", async () => {
    const client = scriptedClient(() =>
      tablePage([
        resultRow({ test: "" }),
        resultRow({ sys_id: "", sys_created_on: "2026-08-21 23:00:00" }),
      ]),
    );
    assert.equal((await fetchTestResults(client, [TEST_A], RID)).size, 0);
  });

  it("falls back to a per-test read only when the page was truncated", async () => {
    const full = Array.from({ length: 8 }, (_v, i) =>
      resultRow({
        sys_id: sysId(`page-${i}`),
        sys_created_on: `2026-08-21 1${i}:00:00`,
      }),
    );
    const client = scriptedClient((args, call) =>
      call === 0
        ? tablePage(full, 9)
        : tablePage([resultRow({ test: TEST_B, sys_id: ROW_2 })]),
    );
    const newest = await fetchTestResults(client, [TEST_A, TEST_B], RID);
    assert.equal(client.calls.length, 2);
    assert.equal(client.paramsOf(1)["sysparm_limit"], "1");
    assert.equal(
      client.paramsOf(1)["sysparm_query"],
      `test_suite_result=${RID}^test=${TEST_B}^ORDERBYDESCsys_created_on`,
    );
    assert.equal(newest.get(TEST_B).sysId, ROW_2);
  });

  it("skips the fallback when the page was complete — no row then means no row", async () => {
    const client = scriptedClient(() => tablePage([resultRow({})], 1));
    const newest = await fetchTestResults(client, [TEST_A, TEST_B], RID);
    assert.equal(client.calls.length, 1);
    assert.equal(newest.has(TEST_B), false);
  });

  it("a starved test really is rescued against a stateful instance", async () => {
    // Nine result rows for A and one older row for B. The batch page holds
    // 2 * MAX_RESULT_ROWS_PER_TEST = 8 rows, all A's, so B is starved out —
    // which is exactly the case the per-test fallback exists for.
    const instance = createFakeInstance();
    const bRow = seedResult(instance, { test: TEST_B, status: "success" });
    for (let i = 0; i < 8; i += 1) {
      seedResult(instance, { test: TEST_A, status: "success" });
    }
    const newestA = seedResult(instance, { test: TEST_A, status: "failure" });

    const client = fakeClient(instance);
    const newest = await fetchTestResults(client, [TEST_A, TEST_B], RID);
    assert.equal(
      instance.requests().length,
      2,
      "one batch page plus one rescue",
    );
    assert.equal(newest.get(TEST_B).sysId, bRow.sys_id);
    assert.equal(
      newest.get(TEST_A).sysId,
      newestA.sys_id,
      "newest wins — an older passing row must not mask the latest failure",
    );
    assert.equal(newest.get(TEST_A).status, "failure");
  });
});

describe("fetchResultItems", () => {
  it("queries by test_result, ordered by step, with the step allowlist", async () => {
    const client = scriptedClient(() => tablePage([]));
    await fetchResultItems(client, [ROW_1, ROW_2]);
    assert.equal(
      client.calls[0].path,
      `${TABLE_API_PREFIX}${ATF_TEST_RESULT_ITEM_TABLE}`,
    );
    assert.equal(
      client.paramsOf(0)["sysparm_query"],
      `test_resultIN${ROW_1},${ROW_2}^ORDERBYorder`,
    );
    assert.deepEqual(client.paramsOf(0)["sysparm_fields"].split(","), [
      ...RESULT_ITEM_FIELDS,
    ]);
    assert.equal(client.paramsOf(0)["sysparm_limit"], "100");
  });

  it("groups the steps under the result row they belong to", async () => {
    const client = scriptedClient(() =>
      tablePage([
        {
          sys_id: sysId("i1"),
          test_result: ROW_1,
          status: "failure",
          output: "x",
          order: "1",
        },
        {
          sys_id: sysId("i2"),
          test_result: ROW_1,
          status: "success",
          output: "",
          order: "2",
        },
        {
          sys_id: sysId("i3"),
          test_result: ROW_2,
          status: "failure",
          output: "y",
          order: "1",
        },
        {
          sys_id: sysId("i4"),
          test_result: "",
          status: "failure",
          output: "z",
          order: "1",
        },
      ]),
    );
    const items = await fetchResultItems(client, [ROW_1, ROW_2]);
    assert.equal(items.get(ROW_1).length, 2);
    assert.equal(items.get(ROW_2).length, 1);
    assert.equal(
      items.size,
      2,
      "the orphaned step is dropped, not bucketed under ''",
    );
  });

  it("issues no fallback when the page was complete", async () => {
    const client = scriptedClient(() =>
      tablePage([
        {
          sys_id: sysId("i1"),
          test_result: ROW_1,
          status: "failure",
          output: "x",
          order: "1",
        },
      ]),
    );
    await fetchResultItems(client, [ROW_1, ROW_2]);
    assert.equal(client.calls.length, 1);
  });

  it("re-reads each result on its own when the shared page was truncated", async () => {
    // A batch page is ordered by `order` ACROSS the results it covers, so
    // truncation does not starve one result — it cuts every result short. A
    // short bucket is indistinguishable from "this result had no more steps",
    // which is a partial read presented as a complete one.
    const client = scriptedClient((args, index) => {
      if (index === 0) {
        return tablePage(
          [
            {
              sys_id: sysId("i1"),
              test_result: ROW_1,
              status: "failure",
              output: "one",
              order: "1",
            },
          ],
          999,
        );
      }
      const query = Object.fromEntries(args.params ?? [])["sysparm_query"];
      const owner = query.startsWith(`test_result=${ROW_1}`) ? ROW_1 : ROW_2;
      return tablePage([
        {
          sys_id: sysId(`f-${owner}-a`),
          test_result: owner,
          status: "failure",
          output: "a",
          order: "1",
        },
        {
          sys_id: sysId(`f-${owner}-b`),
          test_result: owner,
          status: "failure",
          output: "b",
          order: "2",
        },
      ]);
    });

    const items = await fetchResultItems(client, [ROW_1, ROW_2]);

    assert.equal(client.calls.length, 3, "one batch read plus one per result");
    assert.equal(
      client.paramsOf(1)["sysparm_query"],
      `test_result=${ROW_1}^ORDERBYorder`,
    );
    assert.equal(
      client.paramsOf(2)["sysparm_query"],
      `test_result=${ROW_2}^ORDERBYorder`,
    );
    assert.equal(
      client.paramsOf(1)["sysparm_limit"],
      String(MAX_RESULT_ITEMS_PER_RESULT),
    );
    // ROW_2 came back with nothing from the truncated page; reporting it as a
    // result with no failing steps is the false absence this fixes.
    assert.equal(items.get(ROW_2).length, 2);
    // The partial page is discarded, not merged, so its row is not counted twice.
    assert.equal(items.get(ROW_1).length, 2);
    assert.deepEqual(
      items.get(ROW_1).map((item) => item.output),
      ["a", "b"],
    );
  });

  it("refuses a non-sys_id and issues nothing", async () => {
    const client = scriptedClient(() => tablePage([]));
    await assertInfraFault(
      fetchResultItems(client, ["not^a,sys id"]),
      /test result sys_id/,
    );
    assert.equal(client.calls.length, 0);
  });
});

describe("parseSpecResults", () => {
  const specA = spec("a");
  const specB = spec("b");

  /** Answer the result read with `rows`; a step read answers with `items`. */
  function client(rows, items = []) {
    return scriptedClient((args) =>
      args.path.includes(ATF_TEST_RESULT_ITEM_TABLE)
        ? tablePage(items)
        : tablePage(rows),
    );
  }

  it("returns one entry per spec, in index order, never more and never fewer", async () => {
    const results = await parseSpecResults(
      client([resultRow({ test: TEST_A })]),
      index([TEST_A, specA], [TEST_B, specB]),
      RID,
    );
    assert.deepEqual(
      results.map((r) => r.spec.id),
      ["a", "b"],
    );
  });

  it("reports a spec with no result row as missing, with a cause that says why (QA-9)", async () => {
    const [result] = await parseSpecResults(
      client([]),
      index([TEST_A, specA]),
      RID,
    );
    assert.equal(result.raw, "missing");
    assert.equal(result.evidence, undefined);
    assert.match(result.cause, /no sys_atf_test_result row came back/);
    assert.ok(result.cause.includes(TEST_A));
    // OPP-1b: an empty read is not a proof of absence, and this function
    // never watched an execution. Neither claim may come back.
    assert.match(result.cause, /OPP-1b/);
    assert.equal(/row exists/.test(result.cause), false);
    assert.equal(/the suite ran/.test(result.cause), false);
  });

  it("rejects rather than reporting `missing` when the read itself failed", async () => {
    // The DEV-1 line, on the one path where crossing it would be silent:
    // "no row came back" and "we could not ask" look identical from here, and
    // resolving the second as `missing` would blame the tests for a fault of
    // the adapter. Normalising the transport error must not blur that — this
    // is a REJECTION before and after the change, and the outcome list stays
    // unbuilt rather than being filled with `missing`.
    const boom = new Error("ECONNRESET");
    const failing = scriptedClient(() => {
      throw boom;
    });
    await assertNormalisedFault(
      parseSpecResults(failing, index([TEST_A, specA], [TEST_B, specB]), RID),
      { cause: boom, message: /read of sys_atf_test_result/ },
    );
  });

  it("names the caller's table in the missing cause, not the default", async () => {
    const [result] = await parseSpecResults(
      client([]),
      index([TEST_A, specA]),
      RID,
      {
        resultTable: "u_atf_result",
      },
    );
    assert.match(result.cause, /no u_atf_result row came back/);
  });

  it("attributes a pass with the result row as evidence", async () => {
    const [result] = await parseSpecResults(
      client([resultRow({ status: "success" })]),
      index([TEST_A, specA]),
      RID,
    );
    assert.equal(result.raw, "pass");
    assert.deepEqual(result.evidence, { kind: "atf-result", ref: ROW_1 });
    assert.equal(result.assertion, undefined);
    assert.equal(result.artifacts, undefined);
  });

  it("attributes a failure with the row's own output as the assertion", async () => {
    const [result] = await parseSpecResults(
      client([resultRow({ status: "failure", output: "expected 3, got 4" })]),
      index([TEST_A, specA]),
      RID,
    );
    assert.equal(result.raw, "fail");
    assert.equal(result.assertion, "expected 3, got 4");
    assert.deepEqual(result.artifacts, [{ kind: "atf-result", ref: ROW_1 }]);
  });

  it("still says something useful when a failure carries no output", async () => {
    const [result] = await parseSpecResults(
      client([resultRow({ status: "failure", output: "" })]),
      index([TEST_A, specA]),
      RID,
    );
    assert.match(result.assertion, /reports status "failure" with no output/);
  });

  it("sanitises the assertion — instance output is untrusted text (TM-1)", async () => {
    const [result] = await parseSpecResults(
      client([
        resultRow({ status: "failure", output: "a\u0000b\u2028c\r\nd" }),
      ]),
      index([TEST_A, specA]),
      RID,
    );
    assert.equal(result.assertion, "a b c\nd");
  });

  it("honours a narrower assertion cap", async () => {
    const [result] = await parseSpecResults(
      client([resultRow({ status: "failure", output: "x".repeat(50) })]),
      index([TEST_A, specA]),
      RID,
      { maxAssertionChars: 10 },
    );
    assert.equal(result.assertion, `${"x".repeat(10)} …[truncated 40 chars]`);
  });

  it("turns an unrecognised status into an error carrying the raw value", async () => {
    const [result] = await parseSpecResults(
      client([resultRow({ status: "aborted", output: "the runner died" })]),
      index([TEST_A, specA]),
      RID,
    );
    assert.equal(result.raw, "error");
    assert.match(result.cause, /carries status "aborted": the runner died/);
    assert.deepEqual(result.evidence, { kind: "atf-result", ref: ROW_1 });
  });

  it("omits the empty tail when an errored row has no output", async () => {
    const [result] = await parseSpecResults(
      client([resultRow({ status: "aborted", output: "" })]),
      index([TEST_A, specA]),
      RID,
    );
    assert.ok(result.cause.endsWith('carries status "aborted"'), result.cause);
  });

  it("keeps `skipped` as its own outcome rather than folding it into error", async () => {
    const [result] = await parseSpecResults(
      client([resultRow({ status: "skipped" })]),
      index([TEST_A, specA]),
      RID,
    );
    assert.equal(result.raw, "skipped");
  });

  it("does not read step detail unless asked", async () => {
    const scripted = client([resultRow({ status: "failure", output: "boom" })]);
    await parseSpecResults(scripted, index([TEST_A, specA]), RID);
    assert.equal(scripted.calls.length, 1);
  });

  it("appends failing step outputs when step detail is on", async () => {
    const scripted = client(
      [resultRow({ status: "failure", output: "boom" })],
      [
        {
          sys_id: sysId("i1"),
          test_result: ROW_1,
          status: "success",
          output: "fine",
          order: "1",
        },
        {
          sys_id: sysId("i2"),
          test_result: ROW_1,
          status: "failure",
          output: "step blew up",
          order: "2",
        },
      ],
    );
    const [result] = await parseSpecResults(
      scripted,
      index([TEST_A, specA]),
      RID,
      {
        includeStepDetail: true,
      },
    );
    assert.equal(result.assertion, "boom\nstep 2: step blew up");
    assert.equal(
      result.assertion.includes("fine"),
      false,
      "a passing step is not part of the failure story",
    );
  });

  it("labels a step with no order by its sys_id, so the reference is never ambiguous", async () => {
    const scripted = client(
      [resultRow({ status: "failure", output: "" })],
      [
        {
          sys_id: sysId("i9"),
          test_result: ROW_1,
          status: "failure",
          output: "no order",
          order: "",
        },
      ],
    );
    const [result] = await parseSpecResults(
      scripted,
      index([TEST_A, specA]),
      RID,
      {
        includeStepDetail: true,
      },
    );
    assert.equal(result.assertion, `${sysId("i9")}: no order`);
  });

  it("stops after MAX_STEP_ITEMS failing steps — a thousand-step suite cannot flood a report", async () => {
    const items = Array.from({ length: MAX_STEP_ITEMS + 4 }, (_v, i) => ({
      sys_id: sysId(`s${i}`),
      test_result: ROW_1,
      status: "failure",
      output: `step-${i}-failed`,
      order: String(i),
    }));
    const scripted = client(
      [resultRow({ status: "failure", output: "" })],
      items,
    );
    const [result] = await parseSpecResults(
      scripted,
      index([TEST_A, specA]),
      RID,
      {
        includeStepDetail: true,
      },
    );
    // MAX_STEP_ITEMS step lines plus one line saying what was left out. A cut
    // with no mark reads as "these were all the failing steps".
    assert.equal(result.assertion.split("\n").length, MAX_STEP_ITEMS + 1);
    assert.ok(result.assertion.includes("step-4-failed"));
    assert.equal(result.assertion.includes("step-5-failed"), false);
    assert.match(
      result.assertion,
      /\[4 more failing step\(s\) read but not shown\]$/,
    );
    assert.equal(MAX_STEP_ITEMS, 5);
  });

  it("adds no cut marker when nothing was cut — the mark must mean something", async () => {
    const scripted = client(
      [resultRow({ status: "failure", output: "boom" })],
      [
        {
          sys_id: sysId("i1"),
          test_result: ROW_1,
          status: "failure",
          output: "only step",
          order: "1",
        },
      ],
    );
    const [result] = await parseSpecResults(
      scripted,
      index([TEST_A, specA]),
      RID,
      {
        includeStepDetail: true,
      },
    );
    assert.equal(result.assertion, "boom\nstep 1: only step");
    assert.equal(/not shown/.test(result.assertion), false);
  });

  it("still says steps were cut when every step it kept had empty output", async () => {
    // The dropped steps are the only evidence there was, and "with no output"
    // would report a read that returned plenty as a result that produced none.
    const items = Array.from({ length: MAX_STEP_ITEMS + 2 }, (_v, i) => ({
      sys_id: sysId(`e${i}`),
      test_result: ROW_1,
      status: "failure",
      output: i < MAX_STEP_ITEMS ? "" : `late-${i}`,
      order: String(i),
    }));
    const scripted = client(
      [resultRow({ status: "failure", output: "" })],
      items,
    );
    const [result] = await parseSpecResults(
      scripted,
      index([TEST_A, specA]),
      RID,
      {
        includeStepDetail: true,
      },
    );
    assert.equal(
      result.assertion,
      "…[2 more failing step(s) read but not shown]",
    );
    assert.equal(/with no output/.test(result.assertion), false);
  });

  it("reads step detail only for the rows that actually failed", async () => {
    const scripted = client(
      [
        resultRow({ sys_id: ROW_1, test: TEST_A, status: "failure" }),
        resultRow({ sys_id: ROW_2, test: TEST_B, status: "success" }),
      ],
      [],
    );
    await parseSpecResults(
      scripted,
      index([TEST_A, specA], [TEST_B, specB]),
      RID,
      {
        includeStepDetail: true,
      },
    );
    assert.equal(
      scripted.paramsOf(1)["sysparm_query"],
      `test_result=${ROW_1}^ORDERBYorder`,
    );
  });
});

describe("attribution runs through the projection, not through names", () => {
  it("a result row for an unplanned test never leaks into a planned spec", async () => {
    const instance = createFakeInstance();
    const stranger = sysId("test-not-planned");
    seedResult(instance, {
      test: stranger,
      status: "failure",
      output: `a failure of somebody else's test ${CANARY}`,
    });
    const mine = seedResult(instance, { test: TEST_A, status: "success" });

    const results = await parseSpecResults(
      fakeClient(instance),
      index([TEST_A, spec("a")]),
      RID,
    );
    assert.equal(results.length, 1);
    assert.equal(results[0].raw, "pass");
    assert.equal(results[0].evidence.ref, mine.sys_id);
    assert.equal(JSON.stringify(results).includes(CANARY), false);
  });

  it("two specs on the same suite each get their own row", async () => {
    const instance = createFakeInstance();
    seedResult(instance, { test: TEST_A, status: "success" });
    const bRow = seedResult(instance, {
      test: TEST_B,
      status: "failure",
      output: "b is broken",
    });
    seedResultItem(instance, {
      test_result: bRow.sys_id,
      status: "failure",
      output: "the second step failed",
      order: 2,
    });

    const results = await parseSpecResults(
      fakeClient(instance),
      index([TEST_A, spec("a")], [TEST_B, spec("b")]),
      RID,
      { includeStepDetail: true },
    );
    assert.deepEqual(
      results.map((r) => [r.spec.id, r.raw]),
      [
        ["a", "pass"],
        ["b", "fail"],
      ],
    );
    assert.equal(
      results[1].assertion,
      "b is broken\nstep 2: the second step failed",
    );
  });
});

describe("the read is scoped to one suite execution (F1, fail-closed)", () => {
  it("asks for the linkage column, so the client can check it", () => {
    assert.ok(RESULT_FIELDS.includes("test_suite_result"));
  });

  it("refuses a missing, empty or malformed suite result id and issues nothing", async () => {
    const client = scriptedClient(() =>
      assert.fail("an unscoped read must never leave the adapter"),
    );
    for (const bad of [
      undefined,
      "",
      "  ",
      `${RID}^ORtest_suite_resultISEMPTY`,
      { resultTable: "u_atf_result" },
    ]) {
      await assertInfraFault(
        fetchTestResults(client, [TEST_A], bad),
        /suite result/,
      );
      await assertInfraFault(
        parseSpecResults(client, index([TEST_A, spec("a")]), bad),
        /suite result/,
      );
    }
    assert.equal(client.calls.length, 0);
  });

  it("drops rows linked to another execution even if the transport returned them", async () => {
    const client = scriptedClient(() =>
      tablePage([
        resultRow({
          sys_id: ROW_2,
          sys_created_on: "2099-01-01 00:00:00",
          test_suite_result: sysId("someone-else"),
        }),
      ]),
    );
    assert.equal((await fetchTestResults(client, [TEST_A], RID)).size, 0);
  });

  it("drops rows with no execution link at all", async () => {
    const client = scriptedClient(() =>
      tablePage([resultRow({ test_suite_result: "" })]),
    );
    assert.equal((await fetchTestResults(client, [TEST_A], RID)).size, 0);
  });

  it("keeps an older linked row over a newer foreign one", async () => {
    const client = scriptedClient(() =>
      tablePage([
        resultRow({
          sys_id: ROW_2,
          status: "success",
          sys_created_on: "2099-01-01 00:00:00",
          test_suite_result: sysId("someone-else"),
        }),
        resultRow({ sys_id: ROW_1, status: "failure" }),
      ]),
    );
    const newest = await fetchTestResults(client, [TEST_A], RID);
    assert.equal(newest.get(TEST_A).sysId, ROW_1);
    assert.equal(newest.get(TEST_A).suiteResultSysId, RID);
  });

  it("reports a spec whose only row is unlinked as missing, not pass", async () => {
    const instance = createFakeInstance();
    seedResult(instance, { test: TEST_A, status: "success", link: null });
    const [result] = await parseSpecResults(
      fakeClient(instance),
      index([TEST_A, spec("a")]),
      RID,
    );
    assert.equal(result.raw, "missing");
    assert.match(result.cause, new RegExp(`test_suite_result ${RID}`));
  });
});
