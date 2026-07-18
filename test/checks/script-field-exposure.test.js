import { test } from "node:test";
import assert from "node:assert/strict";

import { scriptFieldExposure } from "../../build/checks/script-field-exposure.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * Route the fake's single global query filter by table name. The dictionary
 * read carries `internal_typeIN<a>,<b>,…` (only script-typed columns), and the
 * ACL read asks for `type=record^operation=write` — both are honoured here so
 * a non-script column or a read ACL seeded alongside never leaks through.
 */
function queryFilter(table, rows, params) {
  if (table === "sys_dictionary") {
    const q = params?.sysparm_query ?? "";
    const inMatch = /internal_typeIN([^^]+)/.exec(q);
    if (!inMatch) return rows;
    const types = new Set(inMatch[1].split(","));
    return rows.filter((r) => types.has(String(r.internal_type)));
  }
  if (table === "sys_security_acl") {
    return rows.filter((r) => r.type === "record" && r.operation === "write");
  }
  return rows;
}

/** Assemble a fake client from dictionary / ACL fixtures plus options. */
function makeHttp({ columns = [], acls = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: {
      sys_dictionary: columns,
      sys_security_acl: acls,
    },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return scriptFieldExposure.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** A script column on an app table, for fixtures. */
const SCRIPT_COLUMN = {
  sys_id: "dict1",
  name: "x_acme_app_task",
  element: "run_script",
  internal_type: "script",
};

/** The exact field write ACL covering {@link SCRIPT_COLUMN}. */
const FIELD_ACL = {
  sys_id: "acl1",
  name: "x_acme_app_task.run_script",
  type: "record",
  operation: "write",
  active: "true",
};

test("script-field-exposure keeps its registered name", async () => {
  const result = await run(makeHttp());
  assert.equal(result.name, "script-field-exposure");
});

test("warns when no scope is set", async () => {
  const result = await scriptFieldExposure.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /scope/i);
});

test("warns (never passes) on an ambiguous zero-row dictionary read (SN-1)", async () => {
  const result = await run(makeHttp({ columns: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /cannot confirm/i);
});

test("passes when the instance proves the scope ships no script columns", async () => {
  const result = await run(
    makeHttp({ columns: [], totalCounts: { sys_dictionary: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to lock down/i);
});

test("fails on a security-trimmed zero-row dictionary read (SN-1)", async () => {
  const result = await run(
    makeHttp({ columns: [], totalCounts: { sys_dictionary: 8 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /\b8\b/);
});

test("non-script columns are excluded by the internal_type filter", async () => {
  const columns = [
    {
      ...SCRIPT_COLUMN,
      sys_id: "dict2",
      element: "notes",
      internal_type: "string",
    },
  ];
  const result = await run(
    makeHttp({ columns, totalCounts: { sys_dictionary: 0 } }),
  );
  assert.equal(result.status, "pass");
});

test("passes when the script column has its exact field write ACL", async () => {
  const result = await run(
    makeHttp({ columns: [SCRIPT_COLUMN], acls: [FIELD_ACL] }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /All 1 script-typed column/);
});

test("the table's wildcard field ACL also covers the column", async () => {
  const acl = { ...FIELD_ACL, name: "x_acme_app_task.*" };
  const result = await run(makeHttp({ columns: [SCRIPT_COLUMN], acls: [acl] }));
  assert.equal(result.status, "pass");
});

test("ACL-name matching is case-insensitive", async () => {
  const acl = { ...FIELD_ACL, name: "X_ACME_APP_TASK.RUN_SCRIPT" };
  const result = await run(makeHttp({ columns: [SCRIPT_COLUMN], acls: [acl] }));
  assert.equal(result.status, "pass");
});

test("fails when a script column has no field write ACL", async () => {
  const result = await run(makeHttp({ columns: [SCRIPT_COLUMN] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /server-side code/);
  assert.match(result.message, /x_acme_app_task\.run_script/);
});

test("a table-level (row) write ACL does not cover the field", async () => {
  const acl = { ...FIELD_ACL, name: "x_acme_app_task" };
  const result = await run(makeHttp({ columns: [SCRIPT_COLUMN], acls: [acl] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /no field write ACL/);
});

test("a read-operation field ACL does not cover the column", async () => {
  const acl = { ...FIELD_ACL, operation: "read" };
  const result = await run(makeHttp({ columns: [SCRIPT_COLUMN], acls: [acl] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /no field write ACL/);
});

test("fails when the only covering ACL is inactive", async () => {
  const acl = { ...FIELD_ACL, active: "false" };
  const result = await run(makeHttp({ columns: [SCRIPT_COLUMN], acls: [acl] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /INACTIVE/);
});

test("fails on a partially trimmed dictionary read even when every visible column is covered", async () => {
  const result = await run(
    makeHttp({
      columns: [SCRIPT_COLUMN],
      acls: [FIELD_ACL],
      totalCounts: { sys_dictionary: 20 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_dictionary/);
  assert.match(result.message, /security-trimmed/i);
});

test("fails on a trimmed ACL read rather than trusting the visible ACLs", async () => {
  const result = await run(
    makeHttp({
      columns: [SCRIPT_COLUMN],
      acls: [FIELD_ACL],
      totalCounts: { sys_security_acl: 30 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_security_acl/);
  assert.match(result.message, /security-trimmed/i);
});

test("a trimmed read still reports the concrete findings it did see", async () => {
  const result = await run(
    makeHttp({
      columns: [SCRIPT_COLUMN],
      totalCounts: { sys_dictionary: 5 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /x_acme_app_task\.run_script/);
  assert.match(result.message, /may be incomplete/i);
});

test("fails (not passes) when authentication is rejected", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication failed/i);
});

test("warns when the instance is unreachable", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /could not reach/i);
});

test("warns on an HTTP error from the table read", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sys_dictionary: { http: 500 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /500/);
});
