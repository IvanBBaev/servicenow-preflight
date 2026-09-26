import { test } from "node:test";
import assert from "node:assert/strict";

import { tableCrudAcl } from "../../build/checks/table-crud-acl.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const CRUD = ["create", "read", "write", "delete"];

/**
 * Route the fake's single global query filter by table name. The ACL lookup
 * arrives as `type=record^nameIN<a>,<b>,…` in chunked batches, so
 * `sys_security_acl` is filtered by type and by the batch's name membership —
 * case-insensitively, the way the real encoded-query `IN` matches.
 */
function queryFilter(table, rows, params) {
  if (table === "sys_security_acl") {
    const q = params?.sysparm_query ?? "";
    const inMatch = /nameIN([^^]+)/.exec(q);
    const type = /(?:^|\^)type=([^^]+)/.exec(q)?.[1];
    const names = inMatch
      ? new Set(inMatch[1].split(",").map((n) => n.toLowerCase()))
      : undefined;
    return rows.filter(
      (r) =>
        (type === undefined || r.type === type) &&
        (!names || names.has(String(r.name).toLowerCase())),
    );
  }
  return rows;
}

/** Assemble a fake client from table / ACL fixtures plus options. */
function makeHttp({ tables = [], acls = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: { sys_db_object: tables, sys_security_acl: acls },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return tableCrudAcl.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** Wrap a fake client so every `query`/`queryWithMeta` call is recorded. */
function tracked(http) {
  const calls = [];
  return {
    http: {
      ...http,
      table(name) {
        const t = http.table(name);
        return {
          get: (id, params) => t.get(id, params),
          query: (params) => {
            calls.push({ table: name, params });
            return t.query(params);
          },
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

/** A base (non-extended) custom table row. */
function baseTable(name, sysId = `t_${name}`) {
  return { sys_id: sysId, name, super_class: "", "super_class.name": "" };
}

/** A custom table that extends `parent`. */
function extendedTable(name, parent) {
  return {
    sys_id: `t_${name}`,
    name,
    super_class: `t_${parent}`,
    "super_class.name": parent,
  };
}

/** Table-level `record` ACLs for `table`, one per operation. */
function aclsFor(table, ops = CRUD, { active = true } = {}) {
  return ops.map((op) => ({
    sys_id: `acl_${table}_${op}`,
    name: table,
    type: "record",
    operation: op,
    active: active ? "true" : "false",
  }));
}

test("is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(tableCrudAcl));
  assert.equal(tableCrudAcl.name, "table-crud-acl");
});

test("warns and skips when no scope is set", async () => {
  const result = await run(makeHttp(), { scope: "  " });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when every table has all four active CRUD ACLs", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset"), baseTable("x_acme_order")],
      acls: [...aclsFor("x_acme_asset"), ...aclsFor("x_acme_order")],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /All 2 table\(s\)/);
});

test("matches ACL names and operations case-insensitively", async () => {
  const acls = aclsFor("X_ACME_ASSET", ["CREATE", "Read", "write", "Delete"]);
  const result = await run(
    makeHttp({ tables: [baseTable("x_acme_asset")], acls }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("fails a base table missing an operation, naming table and operation", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset"), baseTable("x_acme_order")],
      acls: [
        ...aclsFor("x_acme_asset", ["create", "read", "write"]),
        ...aclsFor("x_acme_order"),
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 table\(s\)/);
  assert.match(result.message, /x_acme_asset \(no delete ACL\)/);
  assert.doesNotMatch(result.message, /x_acme_order/);
});

test("fails a table with no ACLs at all, listing every operation", async () => {
  const result = await run(makeHttp({ tables: [baseTable("x_acme_asset")] }));
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /x_acme_asset \(no create\/read\/write\/delete ACL\)/,
  );
});

test("an inactive ACL does not cover its operation and is called out", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset")],
      acls: [
        ...aclsFor("x_acme_asset", ["create", "read", "delete"]),
        ...aclsFor("x_acme_asset", ["write"], { active: false }),
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /x_acme_asset \(write ACL inactive\)/);
});

test("field-level ACLs never stand in for a table-level ACL", async () => {
  const fieldAcls = CRUD.flatMap((op) => [
    {
      sys_id: `f_${op}`,
      name: "x_acme_asset.*",
      type: "record",
      operation: op,
      active: "true",
    },
    {
      sys_id: `g_${op}`,
      name: "x_acme_asset.cost",
      type: "record",
      operation: op,
      active: "true",
    },
  ]);
  const result = await run(
    makeHttp({ tables: [baseTable("x_acme_asset")], acls: fieldAcls }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /no create\/read\/write\/delete ACL/);
});

test("ACLs of another type or a non-CRUD operation do not count", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset")],
      acls: [
        ...aclsFor("x_acme_asset", ["create", "read", "write"]),
        {
          sys_id: "ui",
          name: "x_acme_asset",
          type: "ui_page",
          operation: "delete",
          active: "true",
        },
        {
          sys_id: "exec",
          name: "x_acme_asset",
          type: "record",
          operation: "execute",
          active: "true",
        },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /x_acme_asset \(no delete ACL\)/);
});

test("warns (not fails) when only extended tables have gaps, naming the parent", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset"), extendedTable("x_acme_task", "task")],
      acls: [...aclsFor("x_acme_asset"), ...aclsFor("x_acme_task", ["read"])],
    }),
  );
  assert.equal(result.status, "warn", result.message);
  assert.match(
    result.message,
    /x_acme_task \(no create\/write\/delete ACL\) — inherits from "task"/,
  );
  assert.match(result.message, /certification expects app-specific ACLs/);
});

test("an extended table whose parent name is unreadable still warns", async () => {
  const table = { ...extendedTable("x_acme_task", "task") };
  delete table["super_class.name"];
  const result = await run(makeHttp({ tables: [table] }));
  assert.equal(result.status, "warn", result.message);
  assert.match(result.message, /inherits from its parent table/);
});

test("a base-table gap fails and still reports extended-table gaps", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset"), extendedTable("x_acme_task", "task")],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /x_acme_asset \(no create/);
  assert.match(result.message, /1 extended table\(s\) also rely on inherited/);
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
    makeHttp({ tables: [], totalCounts: { sys_db_object: 3 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /3 match but 0 are visible/);
});

test("warns on an ambiguous zero-row table read (no pre-trim count)", async () => {
  const result = await run(makeHttp({ tables: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails on a partially trimmed table read even when every visible table is covered", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset")],
      acls: aclsFor("x_acme_asset"),
      totalCounts: { sys_db_object: 5 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_db_object read was security-trimmed/);
});

test("fails on a trimmed ACL read rather than trusting the visible ACLs", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset")],
      acls: aclsFor("x_acme_asset"),
      totalCounts: { sys_security_acl: 9 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_security_acl read was security-trimmed/);
});

test("a trimmed read with only extended-table gaps still fails, listing them", async () => {
  const result = await run(
    makeHttp({
      tables: [extendedTable("x_acme_task", "task")],
      totalCounts: { sys_security_acl: 2 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
  assert.match(result.message, /rely on inherited ACLs: x_acme_task/);
});

test("a concrete gap outranks a trimmed read and notes the incomplete view", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset")],
      totalCounts: { sys_db_object: 4 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /x_acme_asset \(no create/);
  assert.match(result.message, /may be incomplete/);
});

test("a table name that is not safely queryable fails as unverifiable", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme^ORname=x", "t_bad"), baseTable("")],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /2 table\(s\) could not be verified/);
  assert.match(result.message, /x_acme\^ORname=x/);
  assert.match(result.message, /t_/);
});

test("queries scope-filtered tables and type=record ACLs by name, unpaged", async () => {
  const { http, calls } = tracked(
    makeHttp({
      tables: [baseTable("x_acme_asset")],
      acls: aclsFor("x_acme_asset"),
    }),
  );
  await run(http);
  const tableRead = calls.find((c) => c.table === "sys_db_object");
  assert.match(tableRead.params.sysparm_query, /x_acme_app/);
  assert.equal(tableRead.params.sysparm_limit, undefined);
  const aclRead = calls.find((c) => c.table === "sys_security_acl");
  assert.equal(aclRead.params.sysparm_query, "type=record^nameINx_acme_asset");
  assert.equal(aclRead.params.sysparm_limit, undefined);
});

test("batches the ACL lookup so many tables never build one oversized IN", async () => {
  const names = Array.from({ length: 150 }, (_, i) => `x_acme_t${i}`);
  const { http, calls } = tracked(
    makeHttp({
      tables: names.map((n) => baseTable(n)),
      acls: names.flatMap((n) => aclsFor(n)),
    }),
  );
  const result = await run(http);
  assert.equal(result.status, "pass", result.message);
  const aclReads = calls.filter((c) => c.table === "sys_security_acl");
  assert.equal(aclReads.length, 2);
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

test("warns (degraded) on an HTTP error reading the ACL table", async () => {
  const result = await run(
    makeHttp({
      tables: [baseTable("x_acme_asset")],
      fail: { table: { sys_security_acl: { http: 403 } } },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
