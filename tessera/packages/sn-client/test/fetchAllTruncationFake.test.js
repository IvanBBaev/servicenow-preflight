// `queryTable({ fetchAll: true })` truncation reasons, driven end to end
// through the stateful fake instance (wave 14).
//
// fetchAllTruncation.test.js covers `cap` and `short-page` against the fake,
// but reaches `no-total` only through a hand-rolled stub transport, because
// sn-client never sends `sysparm_no_count` and the fake always emitted
// X-Total-Count. The fake's opt-in `omitTotalCount` closes that gap, so every
// case below is a real paged Table API read: real offsets, real ORDERBY, a
// real row-level read ACL trimming a page.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { createFakeInstance } from "@tessera/fake-instance";

import {
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
 * row-level read ACL removes; `noTotal` turns on the fake's `omitTotalCount`.
 * Returns the parsed URL of every request sent.
 */
function fakeInstance({ hidden = [], noTotal = false } = {}) {
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
  });
  const calls = [];
  globalThis.fetch = (input, init) => {
    calls.push(new URL(String(input)));
    return fake.fetch(input, init);
  };
  return calls;
}

const offsets = (calls) =>
  calls.map((url) => Number(url.searchParams.get("sysparm_offset") ?? "0"));
const limits = (calls) =>
  calls.map((url) => Number(url.searchParams.get("sysparm_limit")));
const names = (res) => res.records.map((row) => row.name);
const warnings = () => logged.filter((entry) => entry.level === "warn");

const readAll = (extra = {}) =>
  tableApi.queryTable({ table: TABLE, fetchAll: true, limit: 2, ...extra });

describe("queryTable fetchAll truncation against the fake instance", () => {
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

  describe("with X-Total-Count (the fake's default)", () => {
    it("pages by offset under ORDERBYsys_id and ends complete on the last short page", async () => {
      const calls = fakeInstance();
      const res = await readAll({ limit: 4 });
      assert.deepEqual(offsets(calls), [0, 4]);
      assert.deepEqual(limits(calls), [4, 4]);
      for (const url of calls) {
        assert.equal(url.searchParams.get("sysparm_query"), "ORDERBYsys_id");
      }
      assert.deepEqual(
        names(res),
        ROWS.map((row) => row.name),
      );
      assert.equal(res.total, 6);
      assert.equal(res.truncated, undefined);
      assert.equal(res.truncationReason, undefined);
      assert.deepEqual(warnings(), []);
    });

    it("a read ACL trimming a LATER page is `short-page`, with every earlier row kept", async () => {
      const calls = fakeInstance({ hidden: ["Include5"] });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2, 4]);
      assert.deepEqual(names(res), [
        "Include1",
        "Include2",
        "Include3",
        "Include4",
        "Include6",
      ]);
      assert.equal(res.total, 6);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "short-page");
      const [warn, ...rest] = warnings();
      assert.deepEqual(rest, []);
      assert.equal(warn.fields.reason, "short-page");
      assert.equal(warn.fields.returned, 5);
      assert.match(
        tableApi.describeTruncation(res),
        /X-Total-Count reports 6 matching rows but only 5 were returned/,
      );
    });

    it("a short page on the request that would reach the cap is `short-page`, not `cap`", async () => {
      // Cap 4, page 2: the second request asks for exactly the last 2 rows
      // the cap allows, and the ACL removes one of them. The loop never gets
      // to observe the cap, so raising SN_MAX_RECORDS is correctly NOT advised.
      process.env.SN_MAX_RECORDS = "4";
      const calls = fakeInstance({ hidden: ["Include4"] });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2]);
      assert.deepEqual(names(res), ["Include1", "Include2", "Include3"]);
      assert.equal(res.total, 6);
      assert.equal(res.truncationReason, "short-page");
      assert.match(
        tableApi.describeTruncation(res),
        /raising SN_MAX_RECORDS will not help/,
      );
    });

    it("a read ACL on rows past the cap is never reached: the reason is `cap`", async () => {
      process.env.SN_MAX_RECORDS = "2";
      const calls = fakeInstance({ hidden: ["Include5"] });
      const res = await readAll();
      assert.equal(calls.length, 1);
      assert.deepEqual(names(res), ["Include1", "Include2"]);
      assert.equal(res.total, 6);
      assert.equal(res.truncationReason, "cap");
      assert.match(tableApi.describeTruncation(res), /2 of 6 matching rows/);
    });

    it("the count honours sysparm_query: a filtered read under the cap is complete", async () => {
      process.env.SN_MAX_RECORDS = "3";
      fakeInstance();
      const res = await readAll({
        query: "nameINInclude1,Include3,Include5",
      });
      assert.deepEqual(names(res), ["Include1", "Include3", "Include5"]);
      assert.equal(res.total, 3);
      assert.equal(res.truncated, undefined);
      assert.deepEqual(warnings(), []);
    });
  });

  describe("without X-Total-Count (fake `omitTotalCount`)", () => {
    it("the cap reached is `no-total`: more rows may exist", async () => {
      process.env.SN_MAX_RECORDS = "3";
      const calls = fakeInstance({ noTotal: true });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2]);
      assert.deepEqual(
        limits(calls),
        [2, 1],
        "the last page asks only for what the cap allows",
      );
      assert.deepEqual(names(res), ["Include1", "Include2", "Include3"]);
      assert.equal(res.total, undefined);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "no-total");

      const [warn, ...rest] = warnings();
      assert.deepEqual(rest, []);
      assert.match(warn.message, /no X-Total-Count/);
      assert.equal(warn.fields.reason, "no-total");
      assert.equal(warn.fields.returned, 3);
      assert.equal(warn.fields.cap, 3);
      assert.equal(warn.fields.total, undefined);

      const text = tableApi.describeTruncation(res);
      assert.match(text, /after 3 rows/);
      assert.match(text, /no X-Total-Count/);
      assert.match(text, /may exist/);
      assert.match(text, /raise SN_MAX_RECORDS/);
    });

    it("fail-closed: a cap equal to the row count is still `no-total` (nothing proves the end)", async () => {
      // Contrast fetchAllTruncation.test.js: with the header, the same read is
      // complete. Without it, three full pages exhaust the cap and the loop
      // cannot know no seventh row exists.
      process.env.SN_MAX_RECORDS = "6";
      const calls = fakeInstance({ noTotal: true });
      const res = await readAll();
      assert.equal(calls.length, 3);
      assert.equal(res.records.length, 6);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "no-total");
    });

    it("a short last page is confirmed final by one empty probe: complete", async () => {
      // Without the header a short page cannot be told from an ACL-trimmed
      // one, so the next raw offset is probed once. Zero rows there proves
      // the end: one extra request, no flag.
      const calls = fakeInstance({ noTotal: true });
      const res = await readAll({ limit: 4 });
      assert.deepEqual(offsets(calls), [0, 4, 8]);
      assert.equal(res.records.length, 6);
      assert.equal(res.total, undefined);
      assert.equal(res.truncated, undefined);
      assert.equal(res.truncationReason, undefined);
      assert.deepEqual(warnings(), []);
    });

    it("regression (was a known gap): an ACL-trimmed FIRST page is paged past and flagged `short-page-no-total`", async () => {
      // A read ACL hides Include2, so the first page (limit 2) holds one row.
      // The probe at raw offset 2 finds more rows, so the short page was
      // trimmed, not the end: paging continues by the raw window (never by
      // the rows returned, which would re-read Include2's slot) and the
      // result is flagged partial — the ACL-hidden rows are not in it.
      const calls = fakeInstance({ hidden: ["Include2"], noTotal: true });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2, 4, 6]);
      assert.deepEqual(names(res), [
        "Include1",
        "Include3",
        "Include4",
        "Include5",
        "Include6",
      ]);
      assert.equal(res.total, undefined);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "short-page-no-total");

      const [warn, ...rest] = warnings();
      assert.deepEqual(rest, []);
      assert.match(warn.message, /no X-Total-Count/);
      assert.equal(warn.fields.reason, "short-page-no-total");
      assert.equal(warn.fields.returned, 5);

      const text = tableApi.describeTruncation(res);
      assert.match(text, /no X-Total-Count/);
      assert.match(text, /read ACLs/);
      assert.match(text, /raising SN_MAX_RECORDS will not help/);
    });

    it("a trimmed MIDDLE page keeps every row before and after it, flagged `short-page-no-total`", async () => {
      const calls = fakeInstance({ hidden: ["Include4"], noTotal: true });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2, 4, 6]);
      assert.deepEqual(names(res), [
        "Include1",
        "Include2",
        "Include3",
        "Include5",
        "Include6",
      ]);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "short-page-no-total");
      assert.equal(warnings().length, 1);
    });

    it("two trimmed pages still end on one empty page (the budget is one request past the data)", async () => {
      const calls = fakeInstance({
        hidden: ["Include2", "Include4"],
        noTotal: true,
      });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2, 4, 6]);
      assert.deepEqual(names(res), [
        "Include1",
        "Include3",
        "Include5",
        "Include6",
      ]);
      assert.equal(res.truncationReason, "short-page-no-total");
    });

    it("a failing probe marks the read partial (`probe-failed`) instead of complete or thrown", async () => {
      // The first page is short; the request that would tell the end of
      // results from a trimmed page fails. Nothing proves the end, so the
      // rows read so far come back flagged — never as the complete set.
      const calls = fakeInstance({ hidden: ["Include2"], noTotal: true });
      const inner = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(String(input));
        if (url.searchParams.get("sysparm_offset") === "2") {
          calls.push(url);
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: "boom" } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return inner(input, init);
      };
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2]);
      assert.deepEqual(names(res), ["Include1"]);
      assert.equal(res.total, undefined);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "probe-failed");

      const [warn, ...rest] = warnings().filter(
        (entry) => entry.fields?.reason !== undefined,
      );
      assert.deepEqual(rest, []);
      assert.equal(warn.fields.reason, "probe-failed");
      assert.equal(warn.fields.returned, 1);
      assert.equal(typeof warn.fields.error, "string");

      const text = tableApi.describeTruncation(res);
      assert.match(text, /after 1 rows/);
      assert.match(text, /no X-Total-Count/);
      assert.match(text, /failed/);
      assert.match(text, /may exist/);
    });

    it("a failing request after a FULL page still throws (only the probe is softened)", async () => {
      const calls = fakeInstance({ noTotal: true });
      const inner = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(String(input));
        if (url.searchParams.get("sysparm_offset") === "2") {
          calls.push(url);
          return Promise.resolve(
            new Response(JSON.stringify({ error: { message: "boom" } }), {
              status: 500,
              headers: { "content-type": "application/json" },
            }),
          );
        }
        return inner(input, init);
      };
      await assert.rejects(readAll());
    });

    it("trimming then the cap: the cap reason (`no-total`) wins, still partial", async () => {
      // Delegated precedence: the cap is the actionable cause (raise
      // SN_MAX_RECORDS); both reasons flag the read partial.
      process.env.SN_MAX_RECORDS = "3";
      const calls = fakeInstance({ hidden: ["Include2"], noTotal: true });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2]);
      assert.deepEqual(names(res), ["Include1", "Include3", "Include4"]);
      assert.equal(res.truncated, true);
      assert.equal(res.truncationReason, "no-total");
    });

    it("RESIDUAL (characterised, not endorsed): a FULLY trimmed page with no count still reads as the end", async () => {
      // A read ACL hiding a whole page renders zero rows, which is exactly
      // the end-of-results signal. Probing past an empty page would be
      // unbounded, so this stays undetectable without X-Total-Count.
      const calls = fakeInstance({
        hidden: ["Include3", "Include4"],
        noTotal: true,
      });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0, 2]);
      assert.deepEqual(names(res), ["Include1", "Include2"]);
      assert.equal(res.truncated, undefined);
    });

    it("with the header nothing is probed: a trimmed page stops the read at once", async () => {
      const calls = fakeInstance({ hidden: ["Include2"] });
      const res = await readAll();
      assert.deepEqual(offsets(calls), [0]);
      assert.equal(res.truncationReason, "short-page");
    });

    it("control: the same ACL WITH the header is flagged `short-page`", async () => {
      fakeInstance({ hidden: ["Include2"] });
      const res = await readAll();
      assert.deepEqual(names(res), ["Include1"]);
      assert.equal(res.total, 6);
      assert.equal(res.truncationReason, "short-page");
    });
  });
});
