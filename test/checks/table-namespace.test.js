import { test } from "node:test";
import assert from "node:assert/strict";

import { tableNamespace } from "../../build/checks/table-namespace.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const SCOPE_SYS_ID = "a".repeat(32);
const INSTANCE = "https://dev12345.service-now.com";

/** Assemble a fake client: `scopes` seed sys_scope, `tables` seed sys_db_object. */
function makeHttp({ tables = [], scopes = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: { sys_db_object: tables, sys_scope: scopes },
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return tableNamespace.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** A sys_db_object row. */
function table(name) {
  return { sys_id: `t_${name}`, name };
}

test("is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(tableNamespace));
  assert.equal(tableNamespace.name, "table-namespace");
});

test("warns and skips when no scope is set", async () => {
  const result = await run(makeHttp(), { scope: " " });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when every table carries the namespace prefix", async () => {
  const result = await run(
    makeHttp({
      tables: [table("x_acme_app_asset"), table("X_ACME_APP_Order")],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /All 2 table\(s\).*"x_acme_app_"/);
});

test("fails a table outside the namespace, naming it", async () => {
  const result = await run(
    makeHttp({
      tables: [
        table("x_acme_app_asset"),
        table("u_asset"),
        table("x_acme_other"),
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /2 table\(s\)/);
  assert.match(result.message, /u_asset, x_acme_other/);
  assert.doesNotMatch(result.message, /x_acme_app_asset/);
});

test("the bare namespace without the separator does not count as prefixed", async () => {
  // "x_acme_application" starts with "x_acme_app" but not with "x_acme_app_".
  const result = await run(makeHttp({ tables: [table("x_acme_application")] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /x_acme_application/);
});

test("a table with no name fails, identified by sys_id", async () => {
  const result = await run(makeHttp({ tables: [{ sys_id: "t9", name: "" }] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /\(unnamed t9\)/);
});

test("a scope given by sys_id uses the resolved scope name as the namespace", async () => {
  const http = makeHttp({
    scopes: [{ sys_id: SCOPE_SYS_ID, scope: SCOPE }],
    tables: [table("x_acme_app_asset"), table("u_asset")],
  });
  const result = await run(http, { scope: SCOPE_SYS_ID });
  assert.equal(result.status, "fail");
  assert.match(result.message, /"x_acme_app_"/);
  assert.match(result.message, /u_asset/);
});

test("a scope configured in a different case still matches its tables", async () => {
  // The resolver matches the configured name, so the resolved row can differ
  // from it only in case — and the prefix comparison is case-insensitive.
  const http = makeHttp({
    scopes: [{ sys_id: SCOPE_SYS_ID, scope: "x_acme_app" }],
    tables: [table("x_acme_app_asset")],
  });
  const result = await run(http, { scope: "X_ACME_APP" });
  assert.equal(result.status, "pass", result.message);
});

test("warns when a sys_id scope does not resolve to a name", async () => {
  const result = await run(makeHttp({ tables: [table("u_asset")] }), {
    scope: SCOPE_SYS_ID,
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /namespace is unknown/);
});

test("warns (not applicable) for the global scope", async () => {
  const result = await run(makeHttp({ tables: [table("u_asset")] }), {
    scope: "global",
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /global scope/);
});

test("passes when the instance reports the scope ships no tables", async () => {
  const result = await run(
    makeHttp({ tables: [], totalCounts: { sys_db_object: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /No tables in scope/);
});

test("fails on a security-trimmed zero-row table read (SN-1)", async () => {
  const result = await run(
    makeHttp({ tables: [], totalCounts: { sys_db_object: 7 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /7 match but 0 are visible/);
});

test("warns on an ambiguous zero-row table read (no pre-trim count)", async () => {
  const result = await run(makeHttp({ tables: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails on a partially trimmed read even when every visible table is namespaced", async () => {
  const result = await run(
    makeHttp({
      tables: [table("x_acme_app_asset")],
      totalCounts: { sys_db_object: 3 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_db_object read was security-trimmed/);
});

test("an offending table under a trimmed read notes the incomplete view", async () => {
  const result = await run(
    makeHttp({ tables: [table("u_asset")], totalCounts: { sys_db_object: 3 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /u_asset/);
  assert.match(result.message, /may be incomplete/);
});

test("fails hard on an authentication error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Authentication failed/);
});

test("warns (degraded) on a network error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /Could not reach the instance/);
});

test("warns (degraded) on an HTTP error reading the table list", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sys_db_object: { http: 403 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
