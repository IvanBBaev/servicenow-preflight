import { test } from "node:test";
import assert from "node:assert/strict";

import { restEndpointSecurity } from "../../build/checks/rest-endpoint-security.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * Route the fake's single global query filter by table name. The backing-ACL
 * probe asks for `type=REST_Endpoint^active=true`, so `sys_security_acl` rows
 * are filtered down to exactly those — proving a differently-typed or inactive
 * ACL never satisfies the probe.
 */
function queryFilter(table, rows) {
  if (table === "sys_security_acl") {
    return rows.filter(
      (r) => r.type === "REST_Endpoint" && r.active === "true",
    );
  }
  return rows;
}

/** Assemble a fake client from REST-operation / ACL fixtures plus options. */
function makeHttp({ ops = [], acls = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: {
      sys_ws_operation: ops,
      sys_security_acl: acls,
    },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return restEndpointSecurity.run({
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

/** A fully-secured resource, for pass-path fixtures. */
function securedOp(overrides = {}) {
  return {
    sys_id: "op1",
    name: "getRecords",
    http_method: "GET",
    requires_authentication: "true",
    requires_acl_authorization: "true",
    ...overrides,
  };
}

const ENDPOINT_ACL = {
  sys_id: "acl1",
  name: "x_acme_app/records",
  type: "REST_Endpoint",
  active: "true",
};

test("rest-endpoint-security keeps its registered name", async () => {
  const result = await run(makeHttp());
  assert.equal(result.name, "rest-endpoint-security");
});

test("warns when no scope is set", async () => {
  const result = await restEndpointSecurity.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /scope/i);
});

test("warns (never passes) on an ambiguous zero-row read (SN-1)", async () => {
  const result = await run(makeHttp({ ops: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /cannot confirm/i);
});

test("passes when the instance proves the scope ships no REST resources", async () => {
  const result = await run(
    makeHttp({ ops: [], totalCounts: { sys_ws_operation: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to secure/i);
});

test("fails on a security-trimmed zero-row read (SN-1)", async () => {
  const result = await run(
    makeHttp({ ops: [], totalCounts: { sys_ws_operation: 6 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /\b6\b/);
});

test("fails on an anonymously reachable resource", async () => {
  const ops = [
    securedOp(),
    securedOp({
      sys_id: "op2",
      name: "openDoor",
      http_method: "POST",
      requires_authentication: "false",
    }),
  ];
  const result = await run(makeHttp({ ops, acls: [ENDPOINT_ACL] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /do not require authentication/);
  assert.match(result.message, /openDoor \[POST\]/);
});

test("an anonymous resource outranks the trimmed-read verdict, with the incomplete note", async () => {
  const ops = [securedOp({ requires_authentication: "false" })];
  const result = await run(
    makeHttp({ ops, totalCounts: { sys_ws_operation: 12 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /do not require authentication/);
  assert.match(result.message, /may be incomplete/i);
});

test("warns when an authenticated resource skips ACL authorization", async () => {
  const ops = [
    securedOp(),
    securedOp({
      sys_id: "op2",
      name: "listAll",
      requires_acl_authorization: "false",
    }),
  ];
  const result = await run(makeHttp({ ops, acls: [ENDPOINT_ACL] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /skip ACL authorization/);
  assert.match(result.message, /listAll \[GET\]/);
});

test("warns when resources enforce ACL authorization but no REST_Endpoint ACL ships", async () => {
  // The only seeded ACL is the wrong type, so the scope-level probe finds no
  // active REST_Endpoint ACL backing the enforcement.
  const acls = [{ ...ENDPOINT_ACL, type: "record" }];
  const result = await run(makeHttp({ ops: [securedOp()], acls }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no active REST_Endpoint ACL/);
});

test("an inactive REST_Endpoint ACL does not back the enforcement", async () => {
  const acls = [{ ...ENDPOINT_ACL, active: "false" }];
  const result = await run(makeHttp({ ops: [securedOp()], acls }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no active REST_Endpoint ACL/);
});

test("passes when every resource is authenticated, ACL-enforcing, and backed", async () => {
  const result = await run(
    makeHttp({ ops: [securedOp()], acls: [ENDPOINT_ACL] }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /All 1 active scripted REST/);
});

test("skips the backing-ACL probe when no resource enforces ACL authorization", async () => {
  const ops = [securedOp({ requires_acl_authorization: "false" })];
  const { http, calls } = tracked(makeHttp({ ops }));
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.equal(calls.filter((c) => c.table === "sys_security_acl").length, 0);
});

test("fails on a partially trimmed resource read even when every visible one is clean", async () => {
  const result = await run(
    makeHttp({
      ops: [securedOp()],
      acls: [ENDPOINT_ACL],
      totalCounts: { sys_ws_operation: 9 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_ws_operation/);
  assert.match(result.message, /security-trimmed/i);
});

test("fails on a trimmed backing-ACL read rather than calling the ACL missing", async () => {
  const result = await run(
    makeHttp({
      ops: [securedOp()],
      acls: [ENDPOINT_ACL],
      totalCounts: { sys_security_acl: 5 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_security_acl/);
  assert.match(result.message, /security-trimmed/i);
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
    makeHttp({ fail: { table: { sys_ws_operation: { http: 502 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /502/);
});
