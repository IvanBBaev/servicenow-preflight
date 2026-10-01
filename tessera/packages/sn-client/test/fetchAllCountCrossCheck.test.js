// Wave 16 — `countRows` (Aggregate/Stats API count) and the opt-in
// `fetchAll` `crossCheckCount`, driven end to end through the stateful fake.
//
// Without X-Total-Count a Table API window that read ACLs trim to ZERO rows,
// or a trimmed LAST window, is indistinguishable from the end of results
// (fetchAllTruncationFake.test.js pins that residual with the option off).
// With `crossCheckCount: true` the read asks the Stats API how many rows
// match once paging is done, and a count above the rows read flags the read
// `count-mismatch`; a count that cannot be obtained flags it
// `count-unavailable`. Whether the REAL Stats API count honours row-level
// read ACLs is unverified — the fake's `statsCount.aclFiltered` models both.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";

import {
  aggregateApi,
  reloadCredentialsFromEnv,
  setLogSink,
  tableApi,
} from "../build/index.js";

const HOST = "dev12345.service-now.com";
const TABLE = "sys_script_include";
const hex = (n) => String(n).padStart(32, "0");
const ROWS = [1, 2, 3, 4, 5, 6].map((n) => ({
  sys_id: hex(n),
  name: `Include${n}`,
  active: n <= 4 ? "true" : "false",
}));

let savedEnv = {};
let originalFetch;
let originalConsoleError;
let logged;

function clearSnEnv() {
  savedEnv = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  }
}

function restoreSnEnv() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("SN_")) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  reloadCredentialsFromEnv();
}

/**
 * Route the global fetch to a fake holding ROWS. `hidden` names rows a
 * row-level read ACL removes; `noTotal` turns on `omitTotalCount`;
 * `statsCount` is passed through. Returns the fake and every request URL.
 */
function fakeInstance({ hidden = [], noTotal = true, statsCount } = {}) {
  const fake = createFakeInstance({
    host: HOST,
    state: { [TABLE]: ROWS.map((row) => ({ ...row })) },
    ...(hidden.length > 0
      ? {
          readAcl: {
            rules: [{ table: TABLE, when: (row) => hidden.includes(row.name) }],
          },
        }
      : {}),
    ...(noTotal ? { omitTotalCount: true } : {}),
    ...(statsCount ? { statsCount } : {}),
  });
  const calls = [];
  globalThis.fetch = (input, init) => {
    calls.push(new URL(String(input)));
    return fake.fetch(input, init);
  };
  return { fake, calls };
}

const isStats = (url) => url.pathname.startsWith("/api/now/stats/");
const statsCalls = (calls) => calls.filter(isStats);
const tableOffsets = (calls) =>
  calls
    .filter((url) => !isStats(url))
    .map((url) => Number(url.searchParams.get("sysparm_offset") ?? "0"));
const names = (res) => res.records.map((row) => row.name);
const warnings = () => logged.filter((entry) => entry.level === "warn");

const readAll = (extra = {}) =>
  tableApi.queryTable({
    table: TABLE,
    fetchAll: true,
    limit: 2,
    crossCheckCount: true,
    ...extra,
  });

describe("countRows / fetchAll crossCheckCount (wave 16)", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalConsoleError = console.error;
    console.error = () => {};
    logged = [];
    setLogSink((level, message, fields) =>
      logged.push({ level, message, fields }),
    );
    clearSnEnv();
    process.env.SN_INSTANCE = "dev12345";
    process.env.SN_USER = "admin";
    process.env.SN_PASSWORD = "s3cret";
    process.env.SN_MAX_RETRIES = "0";
    process.env.SN_LOG_LEVEL = "warn";
    reloadCredentialsFromEnv();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
    setLogSink(null);
    restoreSnEnv();
  });

  describe("countRows", () => {
    it("returns the parsed count and sends sysparm_count + sysparm_query", async () => {
      const { calls } = fakeInstance();
      const res = await aggregateApi.countRows({
        table: TABLE,
        query: "active=true",
      });
      assert.deepEqual(res, { ok: true, count: 4 });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].pathname, `/api/now/stats/${TABLE}`);
      assert.equal(calls[0].searchParams.get("sysparm_count"), "true");
      assert.equal(calls[0].searchParams.get("sysparm_query"), "active=true");
    });

    it("omits sysparm_query when no query is given", async () => {
      const { calls } = fakeInstance();
      assert.deepEqual(await aggregateApi.countRows({ table: TABLE }), {
        ok: true,
        count: 6,
      });
      assert.equal(calls[0].searchParams.has("sysparm_query"), false);
    });

    it("a count of zero is a real zero", async () => {
      fakeInstance();
      assert.deepEqual(
        await aggregateApi.countRows({ table: TABLE, query: "name=nobody" }),
        { ok: true, count: 0 },
      );
    });

    for (const fault of ["non-numeric-count", "missing-count"]) {
      it(`fail-closed: "${fault}" is a malformed-response failure, never 0`, async () => {
        fakeInstance({ statsCount: { fault } });
        const res = await aggregateApi.countRows({ table: TABLE });
        assert.equal(res.ok, false);
        assert.equal(res.reason, "malformed-response");
        assert.equal(typeof res.message, "string");
        assert.equal("count" in res, false);
      });
    }

    it("a JSON-number count (not the real string shape) is accepted", async () => {
      fakeInstance({ statsCount: { fault: "numeric-count" } });
      assert.deepEqual(await aggregateApi.countRows({ table: TABLE }), {
        ok: true,
        count: 6,
      });
    });

    it("an HTTP error is a request-failed failure, not a throw", async () => {
      const { fake } = fakeInstance();
      fake.faults.add({
        match: { path: "/api/now/stats/" },
        mode: { kind: "http-error", status: 403, message: "stats ACL" },
      });
      const res = await aggregateApi.countRows({ table: TABLE });
      assert.equal(res.ok, false);
      assert.equal(res.reason, "request-failed");
      assert.match(res.message, /stats ACL/);
    });

    describe("parseStatsCount (fail-closed)", () => {
      const parse = aggregateApi.parseStatsCount;
      for (const [label, body, expected] of [
        ["string count", { result: { stats: { count: "12" } } }, 12],
        ["zero string", { result: { stats: { count: "0" } } }, 0],
        ["number count", { result: { stats: { count: 3 } } }, 3],
        ["empty string", { result: { stats: { count: "" } } }, undefined],
        ["blank string", { result: { stats: { count: " " } } }, undefined],
        ["negative", { result: { stats: { count: "-1" } } }, undefined],
        ["fraction", { result: { stats: { count: "1.5" } } }, undefined],
        ["exponent", { result: { stats: { count: "1e3" } } }, undefined],
        ["hex", { result: { stats: { count: "0x10" } } }, undefined],
        ["padded", { result: { stats: { count: " 7" } } }, undefined],
        [
          "unsafe",
          { result: { stats: { count: "9007199254740993" } } },
          undefined,
        ],
        ["NaN number", { result: { stats: { count: Number.NaN } } }, undefined],
        ["negative number", { result: { stats: { count: -2 } } }, undefined],
        ["fraction number", { result: { stats: { count: 2.5 } } }, undefined],
        ["null count", { result: { stats: { count: null } } }, undefined],
        ["boolean count", { result: { stats: { count: true } } }, undefined],
        ["missing count", { result: { stats: {} } }, undefined],
        ["missing stats", { result: {} }, undefined],
        ["array result", { result: [] }, undefined],
        ["null stats", { result: { stats: null } }, undefined],
        ["missing result", {}, undefined],
        ["null body", null, undefined],
      ]) {
        it(`${label} → ${String(expected)}`, () => {
          assert.equal(parse(body), expected);
        });
      }
    });
  });

  describe("fetchAll with crossCheckCount (no X-Total-Count)", () => {
    it("a genuine complete read passes with exactly one count call", async () => {
      const { calls } = fakeInstance();
      const res = await readAll();
      assert.deepEqual(
        names(res),
        ROWS.map((row) => row.name),
      );
      assert.equal(res.truncated, undefined);
      assert.equal(res.truncationReason, undefined);
      assert.equal(res.count, 6);
      assert.equal(statsCalls(calls).length, 1);
      // The count runs after paging completes, and is the last request.
      assert.equal(isStats(calls[calls.length - 1]), true);
      assert.deepEqual(warnings(), []);
    });

    it("the count uses the caller's filter, not the ORDERBY paging appends", async () => {
      const { calls } = fakeInstance();
      const res = await readAll({ query: "active=true" });
      assert.equal(res.records.length, 4);
      assert.equal(res.truncated, undefined);
      const [stats] = statsCalls(calls);
      assert.equal(stats.searchParams.get("sysparm_query"), "active=true");
      const unfiltered = await readAll();
      assert.equal(unfiltered.truncated, undefined);
      const last = statsCalls(calls).at(-1);
      assert.equal(last.searchParams.has("sysparm_query"), false);
    });

    it("detects a MIDDLE window trimmed to zero rows: `count-mismatch`", async () => {
      const { calls } = fakeInstance({ hidden: ["Include3", "Include4"] });
      const res = await readAll();
      assert.deepEqual(tableOffsets(calls), [0, 2]);
      assert.deepEqual(names(res), ["Include1", "Include2"]);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "count-mismatch");
      assert.equal(res.count, 6);
      const [warn, ...rest] = warnings();
      assert.deepEqual(rest, []);
      assert.equal(warn.fields.reason, "count-mismatch");
      assert.equal(warn.fields.count, 6);
      assert.equal(warn.fields.returned, 2);
      assert.match(
        `${TABLE} ${tableApi.describeTruncation(res)}`,
        /Stats API counts 6 .* only 2 were returned/,
      );
    });

    it("detects the LAST window trimmed to zero rows: `count-mismatch`", async () => {
      const { calls } = fakeInstance({ hidden: ["Include5", "Include6"] });
      const res = await readAll();
      assert.deepEqual(tableOffsets(calls), [0, 2, 4]);
      assert.equal(res.records.length, 4);
      assert.equal(res.truncationReason, "count-mismatch");
      assert.equal(res.truncated, true);
    });

    it("detects a partially trimmed LAST window (the probe finds nothing after it)", async () => {
      const { calls } = fakeInstance({ hidden: ["Include6"] });
      const res = await readAll();
      assert.deepEqual(tableOffsets(calls), [0, 2, 4, 6]);
      assert.equal(res.records.length, 5);
      assert.equal(res.truncationReason, "count-mismatch");
    });

    it("detects a trimmed FIRST window that empties the read", async () => {
      fakeInstance({ hidden: ["Include1", "Include2"] });
      const res = await readAll();
      assert.deepEqual(res.records, []);
      assert.equal(res.truncationReason, "count-mismatch");
    });

    it("a failed count call is `count-unavailable` (partial, fail closed), rows kept", async () => {
      const { fake } = fakeInstance();
      fake.faults.add({
        match: { path: "/api/now/stats/" },
        mode: { kind: "transport-error" },
      });
      const res = await readAll();
      assert.equal(res.records.length, 6);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "count-unavailable");
      assert.equal(res.count, undefined);
      // The transport logs its own warn first; select fetchAll's.
      const warn = warnings().find(
        (w) => w.fields?.reason === "count-unavailable",
      );
      assert.ok(warn, "fetchAll logs a count-unavailable warn");
      assert.equal(typeof warn.fields.error, "string");
      assert.match(
        tableApi.describeTruncation(res),
        /count .* could not be obtained/,
      );
    });

    it("a malformed count is `count-unavailable`, never read as zero", async () => {
      fakeInstance({ statsCount: { fault: "non-numeric-count" } });
      const res = await readAll();
      assert.equal(res.truncationReason, "count-unavailable");
    });

    it("a count BELOW the rows read is also a mismatch (inconsistent paging)", async () => {
      const { fake } = fakeInstance();
      fake.faults.add({
        match: { path: "/api/now/stats/" },
        mode: {
          kind: "http-error",
          status: 200,
          body: { result: { stats: { count: "5" } } },
        },
      });
      const res = await readAll();
      assert.equal(res.records.length, 6);
      assert.equal(res.truncationReason, "count-mismatch");
      assert.equal(res.count, 5);
    });

    it("an existing no-total reason wins and no count is requested", async () => {
      process.env.SN_MAX_RECORDS = "4";
      reloadCredentialsFromEnv();
      const { calls } = fakeInstance();
      const res = await readAll();
      assert.equal(res.truncationReason, "no-total");
      assert.equal(statsCalls(calls).length, 0);
    });

    it("observed trimming (`short-page-no-total`) wins and no count is requested", async () => {
      const { calls } = fakeInstance({ hidden: ["Include2"] });
      const res = await readAll();
      assert.equal(res.truncationReason, "short-page-no-total");
      assert.equal(statsCalls(calls).length, 0);
    });

    it("with an offset, the rows expected are the count minus the offset", async () => {
      fakeInstance();
      const res = await readAll({ offset: 2 });
      assert.equal(res.records.length, 4);
      assert.equal(res.truncated, undefined);
      assert.equal(res.count, 6);
    });

    it("ACL-FILTERED count (fake opt-in): the trimmed window goes undetected — no false GO, no false alarm", async () => {
      // If the real Stats API honours row-level read ACLs, the count equals
      // the visible rows and the cross-check detects nothing. It can never
      // make a partial read look MORE complete than without it.
      const { calls } = fakeInstance({
        hidden: ["Include3", "Include4"],
        statsCount: { aclFiltered: true },
      });
      const res = await readAll();
      assert.equal(res.records.length, 2);
      assert.equal(res.count, 4);
      // 4 visible rows but only 2 read: still a mismatch here, because the
      // trimmed window hid rows BEFORE the visible Include5/Include6.
      assert.equal(res.truncationReason, "count-mismatch");
      assert.equal(statsCalls(calls).length, 1);
    });

    it("ACL-FILTERED count, trimmed LAST window: undetected (the documented limit)", async () => {
      fakeInstance({
        hidden: ["Include5", "Include6"],
        statsCount: { aclFiltered: true },
      });
      const res = await readAll();
      assert.equal(res.records.length, 4);
      assert.equal(res.count, 4);
      assert.equal(res.truncated, undefined);
    });
  });

  describe("crossCheckCount is inert where it does not apply", () => {
    it("option off: the zero-row trimmed window still reads as the end, no stats call", async () => {
      const { calls } = fakeInstance({ hidden: ["Include3", "Include4"] });
      const res = await readAll({ crossCheckCount: undefined });
      assert.equal(res.records.length, 2);
      assert.equal(res.truncated, undefined);
      assert.equal(res.count, undefined);
      assert.equal(statsCalls(calls).length, 0);
    });

    it("option off: a stats fault is never reached", async () => {
      const { fake, calls } = fakeInstance();
      fake.faults.add({
        match: { path: "/api/now/stats/" },
        mode: { kind: "transport-error" },
      });
      const res = await readAll({ crossCheckCount: false });
      assert.equal(res.truncated, undefined);
      assert.equal(statsCalls(calls).length, 0);
    });

    it("with X-Total-Count the header decides and no count is requested", async () => {
      const { calls } = fakeInstance({ noTotal: false, hidden: ["Include5"] });
      const res = await readAll();
      assert.equal(res.truncationReason, "short-page");
      assert.equal(statsCalls(calls).length, 0);
      const clean = fakeInstance({ noTotal: false });
      const ok = await readAll();
      assert.equal(ok.truncated, undefined);
      assert.equal(statsCalls(clean.calls).length, 0);
    });

    it("a single-page read (no fetchAll) never requests a count", async () => {
      const { calls } = fakeInstance();
      await tableApi.queryTable({
        table: TABLE,
        limit: 2,
        crossCheckCount: true,
      });
      assert.equal(statsCalls(calls).length, 0);
    });
  });
});
