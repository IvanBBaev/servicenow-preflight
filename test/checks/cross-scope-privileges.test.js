import { test } from "node:test";
import assert from "node:assert/strict";

import { crossScopePrivileges } from "../../build/checks/cross-scope-privileges.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const SCOPE_ID = "a".repeat(32);
const INSTANCE = "https://dev12345.service-now.com";
const SENTINEL = "SENTINEL_9f3a";
const TABLE = "sys_scope_privilege";
const FIELDS =
  "sys_id,source_scope,target_scope,target_name,target_type,operation,status";

/** A deterministic 32-hex sys_id from a small integer. */
function sid(n) {
  return n.toString(16).padStart(32, "0");
}

let seq = 0;
function priv(targetName, status, operation = "read") {
  seq += 1;
  return {
    sys_id: sid(seq),
    source_scope: SCOPE_ID,
    target_scope: sid(900),
    target_name: targetName,
    target_type: "sys_db_object",
    operation,
    status,
    // A column the check never requests: must never reach a message.
    description: SENTINEL,
  };
}

/** Fake client with the scope resolvable and a request log. */
function makeHttp({
  privs = [],
  scopes = [{ sys_id: SCOPE_ID, scope: SCOPE }],
  fail,
  totalCounts,
} = {}) {
  const http = createFakeSnClient({
    tables: { sys_scope: scopes, [TABLE]: privs },
    totalCounts,
    fail,
  });
  const calls = [];
  return {
    calls,
    http: {
      ...http,
      table(name) {
        const t = http.table(name);
        return {
          ...t,
          get: (id, params) => t.get(id, params),
          query: (params) => t.query(params),
          queryWithMeta: (params) => {
            calls.push({ table: name, params });
            return t.queryWithMeta(params);
          },
        };
      },
    },
  };
}

function run(http, extra = {}) {
  return crossScopePrivileges.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

function assertNoSentinel(result) {
  assert.ok(!result.message.includes(SENTINEL));
  for (const f of result.findings ?? []) {
    assert.ok(!JSON.stringify(f).includes(SENTINEL));
  }
}

test("cross-scope-privileges is registered as a blocker without a rule", () => {
  assert.equal(crossScopePrivileges.name, "cross-scope-privileges");
  assert.ok(defaultChecks.includes(crossScopePrivileges));
  const { meta } = crossScopePrivileges;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, undefined);
  assert.equal(meta.severity, "blocker");
  assert.deepEqual(meta.tables, [TABLE]);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.remediation, /Approve requested privileges/);
});

test("warns when no scope is set", async () => {
  const { http } = makeHttp();
  const result = await run(http, { scope: "" });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("warns when the scope does not resolve to a sys_scope record", async () => {
  const { http, calls } = makeHttp({ scopes: [] });
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.match(result.message, /did not resolve to a sys_scope record/);
  assert.equal(
    calls.filter((c) => c.table === TABLE).length,
    0,
    "no privilege read without a scope sys_id",
  );
});

test("queries by source_scope sys_id with the card's fields and no limit", async () => {
  const { http, calls } = makeHttp({ privs: [priv("incident", "allowed")] });
  await run(http);
  const read = calls.find((c) => c.table === TABLE);
  assert.ok(read);
  assert.equal(read.params.sysparm_query, `source_scope=${SCOPE_ID}`);
  assert.equal(read.params.sysparm_fields, FIELDS);
  assert.equal(read.params.sysparm_limit, undefined);
});

test("passes when every privilege is allowed", async () => {
  const { http } = makeHttp({
    privs: [
      priv("incident", "allowed"),
      priv("GlideHelper", "Allowed", "execute"),
    ],
  });
  const result = await run(http);
  assert.equal(result.status, "pass");
  assert.equal(result.message, "All 2 cross-scope privileges are allowed.");
  assert.equal(result.findings, undefined);
  assertNoSentinel(result);
});

test("passes when the instance reports no privileges", async () => {
  const { http } = makeHttp({ totalCounts: { [TABLE]: 0 } });
  const result = await run(http);
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to check/);
  assert.equal(result.findings, undefined);
});

test("fails on a denied privilege and counts requested ones too", async () => {
  const { http } = makeHttp({
    privs: [
      priv("incident", "denied", "write"),
      priv("cmdb_ci", "requested"),
      priv("x_other.Util", "requested", "execute"),
      priv("problem", "allowed"),
    ],
  });
  const result = await run(http);
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^1 cross-scope privilege is denied: incident \(write\)\./,
  );
  assert.match(
    result.message,
    /2 cross-scope privileges are only requested: cmdb_ci \(read\), x_other\.Util \(execute\)\./,
  );
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.status, f.location.recordName]),
    [
      ["denied", undefined, "incident (write)"],
      ["requested", "warn", "cmdb_ci (read)"],
      ["requested", "warn", "x_other.Util (execute)"],
    ],
  );
  assert.equal(result.findings[0].location.table, TABLE);
  assert.ok(result.findings[0].location.sysId);
  assertNoSentinel(result);
});

test("warns when privileges are only requested", async () => {
  const { http } = makeHttp({
    privs: [priv("cmdb_ci", "REQUESTED"), priv("incident", "allowed")],
  });
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.equal(
    result.message,
    "1 cross-scope privilege is only requested: cmdb_ci (read).",
  );
  assert.equal(result.findings.length, 1);
  assertNoSentinel(result);
});

test("warns with a count on an unknown status", async () => {
  const { http } = makeHttp({
    privs: [priv("incident", SENTINEL), priv("problem", "")],
  });
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.equal(
    result.message,
    "2 cross-scope privileges have an unknown status.",
  );
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["unknown-status", "unknown-status"],
  );
  assertNoSentinel(result);
});

test("fails when the zero-row read was security-trimmed", async () => {
  const { http } = makeHttp({ totalCounts: { [TABLE]: 3 } });
  const result = await run(http);
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
});

test("fails when a non-zero read was security-trimmed", async () => {
  const { http } = makeHttp({
    privs: [priv("incident", "requested")],
    totalCounts: { [TABLE]: 5 },
  });
  const result = await run(http);
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
});

test("a trimmed read with a denied row notes the list may be incomplete", async () => {
  const { http } = makeHttp({
    privs: [priv("incident", "denied")],
    totalCounts: { [TABLE]: 5 },
  });
  const result = await run(http);
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /denied: incident \(read\)\..*may be incomplete/,
  );
});

test("a denied row with unknown statuses mentions the unknown count", async () => {
  const { http } = makeHttp({
    privs: [priv("incident", "denied"), priv("problem", "pending")],
  });
  const result = await run(http);
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /1 cross-scope privilege has an unknown status\./,
  );
});

test("warns when a zero-row read is ambiguous", async () => {
  const { http } = makeHttp();
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails on an auth error", async () => {
  const { http } = makeHttp({ fail: { table: { [TABLE]: { auth: true } } } });
  const result = await run(http);
  assert.equal(result.status, "fail");
});

test("warns on a network error", async () => {
  const { http } = makeHttp({
    fail: { table: { [TABLE]: { network: true } } },
  });
  const result = await run(http);
  assert.equal(result.status, "warn");
});

test("warns on an HTTP error", async () => {
  const { http } = makeHttp({ fail: { table: { [TABLE]: { http: 403 } } } });
  const result = await run(http);
  assert.equal(result.status, "warn");
});

test("falls back to the sys_id when a row has no target_name", async () => {
  const row = { ...priv("", "denied", ""), target_name: "" };
  const { http } = makeHttp({ privs: [row] });
  const result = await run(http);
  assert.equal(result.status, "fail");
  assert.ok(result.message.includes(row.sys_id));
});
