import { test } from "node:test";
import assert from "node:assert/strict";

import { tableAccessSettings } from "../../build/checks/table-access-settings.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";
import { tracked } from "../helpers/seed.js";

const SCOPE = "x_acme_app";
const SCOPE_SYS_ID = "a".repeat(32);
const INSTANCE = "https://dev12345.service-now.com";
const SENTINEL = "SENTINEL_9f3a";
const FIELDS =
  "sys_id,name,access,read_access,create_access,update_access,delete_access,alter_access,actions_access,ws_access";

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
    alter_access: "false",
    actions_access: "false",
    ws_access: "false",
    caller_access: SENTINEL,
    user_role: "",
    ...fields,
  };
}

/** An active table-level read ACL for `name`, shipped in the app scope. */
function readAcl(name, fields = {}) {
  return {
    sys_id: `acl_${name}`,
    name,
    type: "record",
    operation: "read",
    active: "true",
    sys_scope: SCOPE_SYS_ID,
    "sys_scope.scope": SCOPE,
    ...fields,
  };
}

/**
 * Run the check against seeded sys_db_object rows. The pre-trim count
 * defaults to the seeded row count (`null` omits it → ambiguous).
 */
async function run(
  rows,
  { totalCount, fail, scope = SCOPE, acls = [], aclCount } = {},
) {
  const counts =
    totalCount === null ? {} : { sys_db_object: totalCount ?? rows.length };
  if (aclCount !== undefined) counts.sys_security_acl = aclCount;
  const { http, calls } = tracked(
    createFakeSnClient({
      tables: {
        sys_db_object: rows.map((row) => ({ sys_scope: SCOPE_SYS_ID, ...row })),
        sys_scope: [{ sys_id: SCOPE_SYS_ID, scope: SCOPE }],
        sys_security_acl: acls,
      },
      totalCounts: counts,
      fail,
    }),
  );
  const result = await tableAccessSettings.run({
    instanceUrl: INSTANCE,
    http,
    scope,
  });
  assert.equal(result.name, "table-access-settings");
  assert.ok(!result.message.includes(SENTINEL), result.message);
  return { result, calls };
}

test("is registered as a blocker over sys_db_object and its read ACLs", () => {
  assert.ok(defaultChecks.includes(tableAccessSettings));
  const { meta } = tableAccessSettings;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, undefined);
  assert.equal(meta.severity, "blocker");
  assert.deepEqual(meta.tables, ["sys_db_object", "sys_security_acl"]);
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
  assert.equal(calls.filter((c) => c.table === "sys_security_acl").length, 0);
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

test("passes a public table that grants nothing, and web services behind a shipped read ACL", async () => {
  const { result, calls } = await run(
    [
      table("x_acme_app_asset", { access: "public", read_access: "false" }),
      table("x_acme_app_order", { ws_access: "true" }),
    ],
    { acls: [readAcl("x_acme_app_order")] },
  );
  assert.equal(result.status, "pass", result.message);
  const aclRead = calls.filter((c) => c.table === "sys_security_acl");
  assert.equal(aclRead.length, 1);
  assert.equal(
    aclRead[0].params.sysparm_query,
    "type=record^nameINx_acme_app_order",
  );
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
    /^2 table\(s\) in scope "x_acme_app" allow other scopes to change them: x_acme_app_asset \(create\/delete\), x_acme_app_order \(update\)\.$/,
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

test("warns on web-service access with no shipped read ACL", async () => {
  const { result } = await run(
    [
      table("x_acme_app_asset", { ws_access: true }),
      table("x_acme_app_order", { ws_access: "true" }),
      table("x_acme_app_item", { ws_access: "true" }),
      table("x_acme_app_note", { ws_access: "true" }),
    ],
    {
      acls: [
        // Inactive, foreign-scoped and write-only ACLs do not back the read.
        readAcl("x_acme_app_order", { active: "false" }),
        readAcl("x_acme_app_item", {
          sys_scope: "f".repeat(32),
          "sys_scope.scope": "global",
        }),
        readAcl("x_acme_app_note", { operation: "write" }),
      ],
    },
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /4 table\(s\) are web-service accessible with no active read ACL in the app scope: x_acme_app_asset, x_acme_app_order, x_acme_app_item, x_acme_app_note\./,
  );
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.status]),
    [
      ["ws-no-read-acl", "warn"],
      ["ws-no-read-acl", "warn"],
      ["ws-no-read-acl", "warn"],
      ["ws-no-read-acl", "warn"],
    ],
  );
});

test("a user role on the table is not a web-service gate (ACL-10)", async () => {
  // `user_role` only names the role the auto-generated ACLs use; with no read
  // ACL in the app the REST/SOAP surface is ungated, role or not.
  const { result } = await run([
    table("x_acme_app_order", {
      ws_access: "true",
      user_role: { value: "r1", link: "https://x" },
    }),
  ]);
  assert.equal(result.status, "warn", result.message);
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["ws-no-read-acl"],
  );
});

test("fails a web-service table whose read-ACL lookup was security-trimmed", async () => {
  const { result } = await run(
    [table("x_acme_app_order", { ws_access: "true" })],
    { acls: [readAcl("x_acme_app_order")], aclCount: 3 },
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_security_acl read was security-trimmed/);
});

test("fails a public table that allows configuration or UI actions (ACL-11)", async () => {
  const { result } = await run([
    table("x_acme_app_asset", { access: "public", alter_access: "true" }),
    table("x_acme_app_order", { access: "public", actions_access: true }),
  ]);
  assert.equal(result.status, "fail", result.message);
  assert.match(
    result.message,
    /x_acme_app_asset \(alter\), x_acme_app_order \(actions\)/,
  );
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["public-write:alter", "public-write:actions"],
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
    /allow other scopes to change them: x_acme_app_asset \(create\)\./,
  );
  assert.match(
    result.message,
    /readable from every application scope: x_acme_app_order\./,
  );
  assert.match(
    result.message,
    /no active read ACL in the app scope: x_acme_app_asset\./,
  );
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["public-write:create", "public-read", "ws-no-read-acl"],
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
  assert.match(result.message, /security-trimmed.*no active read ACL/);
  assert.equal(result.findings.length, 1);
});

test("maps an auth error to error", async () => {
  const { result } = await run([], {
    fail: { table: { sys_db_object: { auth: true } } },
  });
  assert.equal(result.status, "error");
  assert.match(
    result.message,
    /Authentication failed while checking table access settings/,
  );
});

test("maps a network error to error", async () => {
  const { result } = await run([], {
    fail: { table: { sys_db_object: { network: true } } },
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /Could not reach the instance/);
});

test("maps an HTTP error to error", async () => {
  const { result } = await run([], {
    fail: { table: { sys_db_object: { http: 500 } } },
  });
  assert.equal(result.status, "error");
  assert.match(result.message, /HTTP 500/);
});

test("an operator-bearing scope fails closed without a table read", async () => {
  const { result, calls } = await run([], { scope: "x^ORactive=true" });
  assert.equal(result.status, "fail");
  assert.equal(calls.filter((c) => c.table === "sys_db_object").length, 0);
});
