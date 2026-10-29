import { test } from "node:test";
import assert from "node:assert/strict";

import { tableAccessSettings } from "../../build/checks/table-access-settings.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const SCOPE_SYS_ID = "a".repeat(32);
const INSTANCE = "https://dev12345.service-now.com";
const SENTINEL = "SENTINEL_9f3a";
const FIELDS =
  "sys_id,name,access,read_access,create_access,update_access,delete_access,ws_access,caller_access,user_role";

/** A sys_db_object row: private, web services off, unless overridden. */
function table(name, fields = {}) {
  return {
    sys_id: `t_${name}`,
    name,
    access: "package_private",
    read_access: "true",
    create_access: "false",
    update_access: "false",
    delete_access: "false",
    ws_access: "false",
    caller_access: SENTINEL,
    user_role: "",
    ...fields,
  };
}

/**
 * Run the check against seeded sys_db_object rows. The pre-trim count
 * defaults to the seeded row count (`null` omits it → ambiguous).
 */
async function run(rows, { totalCount, fail, scope = SCOPE } = {}) {
  const calls = [];
  const counts =
    totalCount === null ? {} : { sys_db_object: totalCount ?? rows.length };
  const http = createFakeSnClient({
    tables: {
      sys_db_object: rows,
      sys_scope: [{ sys_id: SCOPE_SYS_ID, scope: SCOPE }],
    },
    totalCounts: counts,
    queryFilter: (t, tableRows, params) => {
      calls.push({ table: t, params });
      return tableRows;
    },
    fail,
  });
  const result = await tableAccessSettings.run({
    instanceUrl: INSTANCE,
    http,
    scope,
  });
  assert.equal(result.name, "table-access-settings");
  assert.ok(!result.message.includes(SENTINEL), result.message);
  return { result, calls };
}

test("is registered as a blocker over sys_db_object", () => {
  assert.ok(defaultChecks.includes(tableAccessSettings));
  const { meta } = tableAccessSettings;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, undefined);
  assert.equal(meta.severity, "blocker");
  assert.deepEqual(meta.tables, ["sys_db_object"]);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.ok(meta.remediation);
});

test("warns and skips when no scope is set", async () => {
  const { result, calls } = await run([], { scope: " " });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
  assert.equal(calls.length, 0);
});

test("reads every Application Access field under the resolved scope clause", async () => {
  const { calls } = await run([table("x_acme_app_asset")]);
  const read = calls.filter((c) => c.table === "sys_db_object");
  assert.equal(read.length, 1);
  assert.equal(read[0].params.sysparm_query, `sys_scope=${SCOPE_SYS_ID}`);
  assert.equal(read[0].params.sysparm_fields, FIELDS);
  assert.equal(read[0].params.sysparm_limit, undefined);
});

test("passes when every table is private", async () => {
  const { result } = await run([
    table("x_acme_app_asset", { create_access: "true", ws_access: "false" }),
    table("x_acme_app_order"),
  ]);
  assert.equal(result.status, "pass", result.message);
  assert.equal(
    result.message,
    "Every in-scope table restricts application access (2 tables).",
  );
  assert.equal(result.findings, undefined);
});

test("passes a public table that grants nothing, and web services with a role", async () => {
  const { result } = await run([
    table("x_acme_app_asset", { access: "public", read_access: "false" }),
    table("x_acme_app_order", {
      ws_access: "true",
      user_role: { value: "r1", link: "https://x" },
    }),
  ]);
  assert.equal(result.status, "pass", result.message);
});

test("fails a public table that lets other scopes write, naming the operations", async () => {
  const { result } = await run([
    table("x_acme_app_asset", {
      access: "public",
      create_access: "true",
      delete_access: "true",
    }),
    table("x_acme_app_order", { access: "PUBLIC", update_access: true }),
    table("x_acme_app_ok"),
  ]);
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^2 table\(s\) in scope "x_acme_app" allow other scopes to write: x_acme_app_asset \(create\/delete\), x_acme_app_order \(update\)\.$/,
  );
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.location.recordName, f.status]),
    [
      ["public-write:create/delete", "x_acme_app_asset", undefined],
      ["public-write:update", "x_acme_app_order", undefined],
    ],
  );
  assert.equal(result.findings[0].location.table, "sys_db_object");
  assert.equal(result.findings[0].location.sysId, "t_x_acme_app_asset");
});

test("warns on a public read-only table", async () => {
  const { result } = await run([
    table("x_acme_app_asset", { access: "public", read_access: true }),
  ]);
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /1 table\(s\) are readable from every application scope: x_acme_app_asset\./,
  );
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.status]),
    [["public-read", "warn"]],
  );
});

test("warns on web-service access without a user role", async () => {
  const { result } = await run([
    table("x_acme_app_asset", { ws_access: true }),
    table("x_acme_app_order", { ws_access: "true", user_role: "  " }),
  ]);
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /2 table\(s\) are web-service accessible without a user role: x_acme_app_asset, x_acme_app_order\./,
  );
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.status]),
    [
      ["ws-no-role", "warn"],
      ["ws-no-role", "warn"],
    ],
  );
});

test("a fail also lists the advisory tables", async () => {
  const { result } = await run([
    table("x_acme_app_asset", {
      access: "public",
      create_access: "true",
      ws_access: "true",
    }),
    table("x_acme_app_order", { access: "public" }),
  ]);
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /allow other scopes to write: x_acme_app_asset \(create\)\./,
  );
  assert.match(
    result.message,
    /readable from every application scope: x_acme_app_order\./,
  );
  assert.match(result.message, /without a user role: x_acme_app_asset\./);
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["public-write:create", "ws-no-role", "public-read"],
  );
});

test("booleans and strings are read alike", async () => {
  const asStrings = await run([
    table("x_acme_app_asset", { access: "public", update_access: "TRUE" }),
  ]);
  const asBooleans = await run([
    table("x_acme_app_asset", { access: "public", update_access: true }),
  ]);
  assert.equal(asStrings.result.status, "fail");
  assert.equal(asBooleans.result.status, "fail");
  assert.equal(asStrings.result.message, asBooleans.result.message);
  const off = await run([
    table("x_acme_app_asset", {
      access: "public",
      read_access: false,
      update_access: false,
      ws_access: false,
    }),
  ]);
  assert.equal(off.result.status, "pass", off.result.message);
});

test("a table without a name is labelled by its sys_id", async () => {
  const { result } = await run([
    {
      ...table(""),
      sys_id: "t_nameless",
      access: "public",
      create_access: "true",
    },
  ]);
  assert.equal(result.status, "fail");
  assert.match(result.message, /t_nameless \(create\)/);
});

test("passes when the instance reports the scope ships no tables", async () => {
  const { result } = await run([], { totalCount: 0 });
  assert.equal(result.status, "pass");
  assert.match(result.message, /No tables in scope "x_acme_app"/);
});

test("fails a zero-row read that was security-trimmed", async () => {
  const { result } = await run([], { totalCount: 3 });
  assert.equal(result.status, "fail");
  assert.match(result.message, /3 match but 0 are visible/);
});

test("warns on an ambiguous zero-row read", async () => {
  const { result } = await run([], { totalCount: null });
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails a partially trimmed read even when the visible tables are clean", async () => {
  const { result } = await run([table("x_acme_app_asset")], { totalCount: 4 });
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
});

test("a trimmed read with offenders notes the list may be incomplete", async () => {
  const { result } = await run(
    [table("x_acme_app_asset", { access: "public", delete_access: "true" })],
    { totalCount: 2 },
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /x_acme_app_asset \(delete\)\..*may be incomplete/,
  );
});

test("a trimmed read with only advisories still fails and keeps the findings", async () => {
  const { result } = await run(
    [table("x_acme_app_asset", { ws_access: "true" })],
    { totalCount: 2 },
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed.*without a user role/);
  assert.equal(result.findings.length, 1);
});

test("maps an auth error to fail", async () => {
  const { result } = await run([], {
    fail: { table: { sys_db_object: { auth: true } } },
  });
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /Authentication failed while checking table access settings/,
  );
});

test("maps a network error to warn", async () => {
  const { result } = await run([], {
    fail: { table: { sys_db_object: { network: true } } },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /Could not reach the instance/);
});

test("maps an HTTP error to warn", async () => {
  const { result } = await run([], {
    fail: { table: { sys_db_object: { http: 403 } } },
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});

test("an operator-bearing scope fails closed without a table read", async () => {
  const { result, calls } = await run([], { scope: "x^ORactive=true" });
  assert.equal(result.status, "fail");
  assert.equal(calls.filter((c) => c.table === "sys_db_object").length, 0);
});
