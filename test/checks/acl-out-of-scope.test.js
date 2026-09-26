import { test } from "node:test";
import assert from "node:assert/strict";

import { aclOutOfScope } from "../../build/checks/acl-out-of-scope.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const SCOPE_SYS_ID = "b".repeat(32);
const INSTANCE = "https://dev12345.service-now.com";

/** Filter ACLs by the `type=` term the check sends, like the real query. */
function queryFilter(table, rows, params) {
  if (table === "sys_security_acl") {
    const type = /(?:^|\^)type=([^^]+)/.exec(params?.sysparm_query ?? "")?.[1];
    return type === undefined ? rows : rows.filter((r) => r.type === type);
  }
  return rows;
}

/** Assemble a fake client from ACL / table / scope fixtures plus options. */
function makeHttp({
  acls = [],
  tables = [],
  scopes = [],
  fail,
  totalCounts,
} = {}) {
  return createFakeSnClient({
    tables: {
      sys_security_acl: acls,
      sys_db_object: tables,
      sys_scope: scopes,
    },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return aclOutOfScope.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** Wrap a fake client so every `queryWithMeta` call is recorded. */
function tracked(http) {
  const calls = [];
  return {
    http: {
      ...http,
      table(name) {
        const t = http.table(name);
        return {
          get: (id, params) => t.get(id, params),
          query: (params) => t.query(params),
          queryWithMeta: (params) => {
            calls.push({ table: name, params });
            return t.queryWithMeta(params);
          },
        };
      },
    },
    calls,
  };
}

let seq = 0;
function acl(
  name,
  { operation = "read", active = true, type = "record" } = {},
) {
  seq += 1;
  return {
    sys_id: `acl${seq}`,
    name,
    type,
    operation,
    active: active ? "true" : "false",
  };
}

function table(name) {
  return { sys_id: `t_${name}`, name };
}

test("is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(aclOutOfScope));
  assert.equal(aclOutOfScope.name, "acl-out-of-scope");
});

test("warns and skips when no scope is set", async () => {
  const result = await run(makeHttp(), { scope: "" });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("warns (not applicable) for the global scope", async () => {
  const result = await run(makeHttp({ acls: [acl("incident")] }), {
    scope: "global",
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /global scope/);
});

test("passes when every ACL targets the app's own tables", async () => {
  const result = await run(
    makeHttp({
      tables: [table("x_acme_app_asset")],
      acls: [
        acl("x_acme_app_asset"),
        acl("x_acme_app_asset.cost", { operation: "write" }),
        acl("x_acme_app_asset.*"),
      ],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /All 3 record ACL\(s\)/);
});

test("fails a table-level ACL on an out-of-box table, naming it and its operation", async () => {
  const result = await run(
    makeHttp({
      tables: [table("x_acme_app_asset")],
      acls: [acl("x_acme_app_asset"), acl("incident", { operation: "write" })],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 ACL\(s\)/);
  assert.match(result.message, /incident \(write\)/);
  assert.doesNotMatch(result.message, /x_acme_app_asset/);
});

test("fails wildcard ACLs on a foreign table and on every table", async () => {
  const result = await run(
    makeHttp({ acls: [acl("incident.*"), acl("*"), acl("*.*")] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /3 ACL\(s\)/);
  assert.match(result.message, /incident\.\* \(read\)/);
  assert.match(result.message, /\* \(read\)/);
});

test("fails a field ACL for a non-app field on a foreign table", async () => {
  const result = await run(
    makeHttp({ acls: [acl("incident.short_description")] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /incident\.short_description/);
});

test("only warns for a field ACL guarding the app's own field on a foreign table", async () => {
  const result = await run(
    makeHttp({
      acls: [acl("incident.x_acme_app_risk", { operation: "write" })],
    }),
  );
  assert.equal(result.status, "warn", result.message);
  assert.match(result.message, /incident\.x_acme_app_risk \(write\)/);
  assert.match(result.message, /adding fields to out-of-box tables/);
});

test("a blocking finding also lists the own-field ACLs", async () => {
  const result = await run(
    makeHttp({ acls: [acl("incident"), acl("task.x_acme_app_flag")] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Also 1 field ACL\(s\).*task\.x_acme_app_flag/);
});

test("inactive foreign ACLs are still reported, marked inactive", async () => {
  const result = await run(
    makeHttp({ acls: [acl("incident", { active: false })] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /incident \(read, inactive\)/);
});

test("a namespaced table invisible in sys_db_object still counts as the app's own", async () => {
  const result = await run(
    makeHttp({ tables: [], acls: [acl("x_acme_app_hidden")] }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("an in-scope table without the namespace prefix counts as the app's own", async () => {
  const result = await run(
    makeHttp({ tables: [table("u_legacy")], acls: [acl("u_legacy")] }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("matches table names case-insensitively and keeps the original in messages", async () => {
  const result = await run(
    makeHttp({
      tables: [table("x_acme_app_asset")],
      acls: [acl("X_ACME_APP_ASSET"), acl("Incident")],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Incident \(read\)/);
  assert.match(result.message, /1 ACL\(s\)/);
});

test("the bare namespace without separator is not the app's", async () => {
  const result = await run(makeHttp({ acls: [acl("x_acme_application")] }));
  assert.equal(result.status, "fail");
});

test("a scope given by sys_id uses the resolved namespace", async () => {
  const result = await run(
    makeHttp({
      scopes: [{ sys_id: SCOPE_SYS_ID, scope: SCOPE }],
      acls: [acl("x_acme_app_asset"), acl("incident")],
    }),
    { scope: SCOPE_SYS_ID },
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /incident/);
  assert.doesNotMatch(result.message, /x_acme_app_asset/);
});

test("an unresolved sys_id scope falls back to the scope's table list only", async () => {
  const result = await run(
    makeHttp({
      tables: [table("x_acme_app_asset")],
      acls: [acl("x_acme_app_asset"), acl("x_acme_app_other")],
    }),
    { scope: SCOPE_SYS_ID },
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /x_acme_app_other/);
});

test("ignores ACLs of other types (ui_page, rest_endpoint, …)", async () => {
  const result = await run(
    makeHttp({
      acls: [
        acl("x_acme_app_dash", { type: "ui_page" }),
        acl("sys_user", { type: "rest_endpoint" }),
      ],
      totalCounts: { sys_security_acl: 0 },
    }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("passes when the instance reports the scope ships no record ACLs", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_security_acl: 0 } }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /No record ACLs in scope/);
});

test("fails on a security-trimmed zero-row ACL read (SN-1)", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_security_acl: 8 } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /8 match but 0 are visible/);
});

test("warns on an ambiguous zero-row ACL read", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails on a partially trimmed ACL read even when every visible ACL is fine", async () => {
  const result = await run(
    makeHttp({
      acls: [acl("x_acme_app_asset")],
      totalCounts: { sys_security_acl: 4 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_security_acl read was security-trimmed/);
});

test("a finding under a trimmed table read notes the incomplete view", async () => {
  const result = await run(
    makeHttp({ acls: [acl("incident")], totalCounts: { sys_db_object: 3 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /may be incomplete/);
});

test("reads record ACLs and tables with the scope filter, unpaged", async () => {
  const { http, calls } = tracked(makeHttp({ acls: [acl("x_acme_app_a")] }));
  await run(http);
  const aclRead = calls.find((c) => c.table === "sys_security_acl");
  assert.match(aclRead.params.sysparm_query, /x_acme_app.*\^type=record$/);
  assert.equal(aclRead.params.sysparm_limit, undefined);
  const tableRead = calls.find((c) => c.table === "sys_db_object");
  assert.match(tableRead.params.sysparm_query, /x_acme_app/);
  assert.equal(tableRead.params.sysparm_limit, undefined);
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
    makeHttp({
      acls: [acl("incident")],
      fail: { table: { sys_db_object: { http: 403 } } },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
