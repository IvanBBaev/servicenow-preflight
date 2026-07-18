import { test } from "node:test";
import assert from "node:assert/strict";

import { clientCallableAcl } from "../../build/checks/client-callable-acl.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * Route the fake's single global query filter by table name. The ACL lookup
 * arrives as `type=client_callable_script_include^nameIN<a>,<b>,…` in chunked
 * batches, so `sys_security_acl` is filtered by the batch's name membership —
 * case-insensitively, the way the real encoded-query `IN` matches.
 */
function queryFilter(table, rows, params) {
  if (table === "sys_security_acl") {
    const q = params?.sysparm_query ?? "";
    const inMatch = /nameIN([^^]+)/.exec(q);
    if (!inMatch) return rows;
    const names = new Set(inMatch[1].split(",").map((n) => n.toLowerCase()));
    return rows.filter((r) => names.has(String(r.name).toLowerCase()));
  }
  return rows;
}

/** Assemble a fake client from Script Include / ACL fixtures plus options. */
function makeHttp({ sis = [], acls = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: {
      sys_script_include: sis,
      sys_security_acl: acls,
    },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return clientCallableAcl.run({
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

/** An SI covered by an active execute ACL, for pass-path fixtures. */
const COVERED_SI = {
  sys_id: "si1",
  name: "AcmeUtil",
  api_name: "x_acme_app.AcmeUtil",
};
const COVERING_ACL = {
  sys_id: "acl1",
  name: "x_acme_app.AcmeUtil",
  operation: "execute",
  active: "true",
  type: "client_callable_script_include",
};

test("client-callable-acl keeps its registered name", async () => {
  const result = await run(makeHttp());
  assert.equal(result.name, "client-callable-acl");
});

test("warns when no scope is set", async () => {
  const result = await clientCallableAcl.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /scope/i);
});

test("warns (never passes) on an ambiguous zero-row SI read (SN-1)", async () => {
  const result = await run(makeHttp({ sis: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /cannot confirm/i);
});

test("passes when the instance proves the scope ships no client-callable SIs", async () => {
  const result = await run(
    makeHttp({ sis: [], totalCounts: { sys_script_include: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to gate/i);
});

test("fails on a security-trimmed zero-row SI read (SN-1)", async () => {
  const result = await run(
    makeHttp({ sis: [], totalCounts: { sys_script_include: 4 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /\b4\b/);
});

test("passes when every SI is gated by an active execute ACL (case-insensitive match)", async () => {
  // The ACL name matches the SI's api_name in a different case — encoded-query
  // matching is case-insensitive on a live instance, so the check must be too.
  const acl = { ...COVERING_ACL, name: "X_ACME_APP.ACMEUTIL" };
  const result = await run(makeHttp({ sis: [COVERED_SI], acls: [acl] }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /All 1 active client-callable/);
});

test("fails when an SI has no execute ACL at all", async () => {
  const result = await run(makeHttp({ sis: [COVERED_SI], acls: [] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /GlideAjax/);
  assert.match(result.message, /AcmeUtil/);
});

test("fails when the only matching execute ACL is inactive", async () => {
  const acl = { ...COVERING_ACL, active: "false" };
  const result = await run(makeHttp({ sis: [COVERED_SI], acls: [acl] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /INACTIVE/);
  assert.match(result.message, /AcmeUtil/);
});

test("a non-execute ACL does not count as the gate", async () => {
  const acl = { ...COVERING_ACL, operation: "read" };
  const result = await run(makeHttp({ sis: [COVERED_SI], acls: [acl] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /no execute ACL/);
});

test("fails when an SI's name cannot be safely queried", async () => {
  // Neither name survives the injection-safe charset — the check must surface
  // the SI as unverifiable rather than silently skipping it.
  const si = { sys_id: "si9", name: "Bad Name!", api_name: "" };
  const result = await run(makeHttp({ sis: [si] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /could not be verified/i);
  assert.match(result.message, /Bad Name!/);
});

test("fails on a partially trimmed SI read even when every visible SI is covered", async () => {
  const result = await run(
    makeHttp({
      sis: [COVERED_SI],
      acls: [COVERING_ACL],
      totalCounts: { sys_script_include: 10 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_script_include/);
  assert.match(result.message, /security-trimmed/i);
});

test("fails on a trimmed ACL read rather than trusting the visible ACLs", async () => {
  const result = await run(
    makeHttp({
      sis: [COVERED_SI],
      acls: [COVERING_ACL],
      totalCounts: { sys_security_acl: 50 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_security_acl/);
  assert.match(result.message, /security-trimmed/i);
});

test("a trimmed read still reports the concrete findings it did see", async () => {
  // One visible SI is missing its ACL AND the SI read is trimmed: the missing
  // gate is already actionable, so it is reported, with the incomplete-view note.
  const result = await run(
    makeHttp({ sis: [COVERED_SI], totalCounts: { sys_script_include: 7 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /AcmeUtil/);
  assert.match(result.message, /may be incomplete/i);
});

test("batches the ACL name lookup in chunks of 100 (SR-1)", async () => {
  const sis = [];
  const acls = [];
  for (let i = 0; i < 150; i += 1) {
    sis.push({ sys_id: `si${i}`, name: `Util${i}`, api_name: "" });
    acls.push({
      sys_id: `acl${i}`,
      name: `Util${i}`,
      operation: "execute",
      active: "true",
      type: "client_callable_script_include",
    });
  }
  const { http, calls } = tracked(makeHttp({ sis, acls }));
  const result = await run(http);
  assert.equal(result.status, "pass");
  const aclCalls = calls.filter((c) => c.table === "sys_security_acl");
  assert.equal(aclCalls.length, 2); // ceil(150 / 100)
  for (const call of aclCalls) {
    assert.match(
      call.params.sysparm_query,
      /type=client_callable_script_include/,
    );
  }
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
    makeHttp({ fail: { table: { sys_script_include: { http: 503 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /503/);
});
