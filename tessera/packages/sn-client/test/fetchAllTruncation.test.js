// `queryTable({ fetchAll: true })` names WHY a read is partial.
//
// A fetchAll read stops on one of two signals: the SN_MAX_RECORDS cap, or a
// page shorter than it asked for. The second is the normal end of a result
// set — except when the instance's own X-Total-Count says more rows match.
// That is what ServiceNow renders when read ACLs remove rows from a page (the
// count is taken before the ACL filter), or when the count is simply
// inconsistent. All three partial cases are flagged `truncated` exactly as
// before (fail-closed); what changes is the reason code and the wording, so a
// short page is no longer reported as "stopped at the SN_MAX_RECORDS cap".
//
// The short page is a GENUINE one: a row-level read ACL on the fake instance
// hides a row from the page while X-Total-Count still counts it.
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

/** Route the global fetch to a fake instance holding ROWS; count requests. */
function fakeInstance(readAclRules) {
  const fake = createFakeInstance({
    host: HOST,
    state: { [TABLE]: ROWS.map((row) => ({ ...row })) },
    ...(readAclRules ? { readAcl: { rules: readAclRules } } : {}),
  });
  const calls = [];
  globalThis.fetch = (input, init) => {
    calls.push(String(input));
    return fake.fetch(input, init);
  };
  return calls;
}

/** A stub transport that never sends X-Total-Count. */
function noCountInstance(pages) {
  const calls = [];
  globalThis.fetch = (input) => {
    calls.push(String(input));
    const body = { result: pages[calls.length - 1] ?? [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return calls;
}

const warnings = () => logged.filter((entry) => entry.level === "warn");

describe("queryTable fetchAll — why a read is partial", () => {
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

  it("control: every row readable and under the cap is complete, with no reason", async () => {
    fakeInstance();
    const res = await tableApi.queryTable({
      table: TABLE,
      fetchAll: true,
      limit: 2,
    });
    assert.equal(res.records.length, 6);
    assert.equal(res.total, 6);
    assert.equal(res.truncated, undefined);
    assert.equal(res.truncationReason, undefined);
    assert.deepEqual(warnings(), []);
  });

  it("a short page while X-Total-Count reports more rows is `short-page`, not the cap", async () => {
    // Row 2 is hidden by a row-level read ACL: the first page (limit 2) comes
    // back with one row, while X-Total-Count still says 6.
    const calls = fakeInstance([
      { table: TABLE, when: (row) => row.name === "Include2" },
    ]);

    const res = await tableApi.queryTable({
      table: TABLE,
      fetchAll: true,
      limit: 2,
    });

    assert.equal(calls.length, 1, "paging stops on the short page");
    assert.deepEqual(
      res.records.map((row) => row.name),
      ["Include1"],
    );
    assert.equal(res.total, 6);
    assert.equal(res.truncated, true, "still fail-closed: the read is partial");
    assert.equal(res.truncationReason, "short-page");

    const [warn, ...rest] = warnings();
    assert.deepEqual(rest, []);
    assert.match(warn.message, /short page/);
    assert.match(warn.message, /X-Total-Count/);
    assert.doesNotMatch(warn.message, /stopped at the SN_MAX_RECORDS cap/);
    assert.equal(warn.fields.reason, "short-page");
    assert.equal(warn.fields.returned, 1);
    assert.equal(warn.fields.total, 6);

    const text = tableApi.describeTruncation(res);
    assert.match(text, /X-Total-Count reports 6/);
    assert.match(text, /only 1 (row|were)/);
    assert.match(text, /read ACL/);
    assert.doesNotMatch(text, /(hit|stopped at) the SN_MAX_RECORDS cap/);
    assert.match(text, /raising SN_MAX_RECORDS will not help/);
  });

  it("the cap reached while X-Total-Count reports more rows is `cap`", async () => {
    process.env.SN_MAX_RECORDS = "3";
    const calls = fakeInstance();

    const res = await tableApi.queryTable({
      table: TABLE,
      fetchAll: true,
      limit: 2,
    });

    assert.equal(calls.length, 2);
    assert.equal(res.records.length, 3);
    assert.equal(res.total, 6);
    assert.equal(res.truncated, true);
    assert.equal(res.truncationReason, "cap");

    const [warn] = warnings();
    assert.match(warn.message, /SN_MAX_RECORDS cap/);
    assert.equal(warn.fields.reason, "cap");

    const text = tableApi.describeTruncation(res);
    assert.match(text, /SN_MAX_RECORDS cap/);
    assert.match(text, /3 of 6/);
  });

  it("a cap equal to the row count is not a truncation", async () => {
    process.env.SN_MAX_RECORDS = "6";
    fakeInstance();
    const res = await tableApi.queryTable({
      table: TABLE,
      fetchAll: true,
      limit: 2,
    });
    assert.equal(res.records.length, 6);
    assert.equal(res.truncated, undefined);
    assert.equal(res.truncationReason, undefined);
    assert.deepEqual(warnings(), []);
  });

  it("the cap reached with no X-Total-Count is `no-total`: more rows may exist", async () => {
    process.env.SN_MAX_RECORDS = "2";
    noCountInstance([[ROWS[0], ROWS[1]]]);

    const res = await tableApi.queryTable({
      table: TABLE,
      fetchAll: true,
      limit: 2,
    });

    assert.equal(res.records.length, 2);
    assert.equal(res.total, undefined);
    assert.equal(res.truncated, true);
    assert.equal(res.truncationReason, "no-total");

    const [warn] = warnings();
    assert.match(warn.message, /SN_MAX_RECORDS cap/);
    assert.match(warn.message, /no X-Total-Count/);
    assert.equal(warn.fields.reason, "no-total");

    const text = tableApi.describeTruncation(res);
    assert.match(text, /no X-Total-Count/);
    assert.match(text, /may exist/);
  });

  it("a short page with no X-Total-Count is the end once an empty probe confirms it", async () => {
    const calls = noCountInstance([[ROWS[0], ROWS[1]], [ROWS[2]]]);
    const res = await tableApi.queryTable({
      table: TABLE,
      fetchAll: true,
      limit: 2,
    });
    assert.equal(res.records.length, 3);
    assert.equal(calls.length, 3, "one probe past the short page");
    assert.equal(res.truncated, undefined);
    assert.equal(res.truncationReason, undefined);
    assert.deepEqual(warnings(), []);
  });
});
