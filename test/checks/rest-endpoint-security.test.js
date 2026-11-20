import { test } from "node:test";
import assert from "node:assert/strict";

import { restEndpointSecurity } from "../../build/checks/rest-endpoint-security.js";
import { createFakeSnClient } from "../../build/http/fake.js";
import { inScope } from "../helpers/seed.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * Assemble a fake client from REST-operation / API / ACL / ACL-role fixtures
 * plus options. `roles` defaults to the app-role link that gates `acl1`.
 */
function makeHttp({
  ops = [],
  defs = [],
  acls = [],
  roles = [ROLE_LINK],
  fail,
  totalCounts,
} = {}) {
  return createFakeSnClient({
    tables: {
      sys_ws_operation: inScope(ops, SCOPE, { active: "true" }),
      sys_ws_definition: inScope(defs, SCOPE),
      sys_security_acl: inScope(acls, SCOPE),
      sys_security_acl_role: roles,
    },
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
    enforce_acl: "acl1",
    ...overrides,
  };
}

const ENDPOINT_ACL = {
  sys_id: "acl1",
  name: "x_acme_app/records",
  type: "REST_Endpoint",
  active: "true",
};

/** The `sys_security_acl_role` link that gates `acl1` with an app role. */
const ROLE_LINK = {
  sys_id: "ar1",
  sys_security_acl: "acl1",
  sys_user_role: "r1",
  "sys_user_role.name": "x_acme_app.user",
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
  assert.equal(result.findings, undefined); // F-R-3
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
  // The enforced ACL is the wrong type, so it does not back the resource.
  const acls = [{ ...ENDPOINT_ACL, type: "record" }];
  const result = await run(makeHttp({ ops: [securedOp()], acls }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no active, gated REST_Endpoint ACL/);
});

test("an inactive REST_Endpoint ACL does not back the enforcement", async () => {
  const acls = [{ ...ENDPOINT_ACL, active: "false" }];
  const result = await run(makeHttp({ ops: [securedOp()], acls }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no active, gated REST_Endpoint ACL/);
});

test("an unrelated REST_Endpoint ACL in scope does not back a resource (ACL-9)", async () => {
  // Audit repro 8: the resource enforces only the default ACL, while another
  // in-scope REST_Endpoint ACL exists — the old scope-wide probe passed it.
  const ops = [securedOp({ enforce_acl: "" })];
  const result = await run(makeHttp({ ops, acls: [ENDPOINT_ACL] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /getRecords \[GET\]/);
  assert.equal(result.findings[0].kind, "no-gated-endpoint-acl");
});

test("the global default ACL does not back a resource (ACL-9)", async () => {
  const ops = [securedOp({ enforce_acl: "dflt" })];
  const acls = [
    ENDPOINT_ACL,
    {
      sys_id: "dflt",
      name: "Scripted REST External Default",
      type: "REST_Endpoint",
      active: "true",
      "sys_scope.scope": "global",
    },
  ];
  const result = await run(makeHttp({ ops, acls }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no active, gated REST_Endpoint ACL/);
});

test("an ACL gated only by the public role, or by nothing, does not back a resource (ACL-9)", async () => {
  const ops = [
    securedOp({ enforce_acl: "acl2" }),
    securedOp({ sys_id: "op2", name: "listAll", enforce_acl: "acl3" }),
  ];
  const acls = [
    { ...ENDPOINT_ACL, sys_id: "acl2" },
    { ...ENDPOINT_ACL, sys_id: "acl3" },
  ];
  const roles = [
    {
      sys_id: "ar2",
      sys_security_acl: "acl2",
      sys_user_role: "r0",
      "sys_user_role.name": "public",
    },
  ];
  const result = await run(makeHttp({ ops, acls, roles }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /2 resource\(s\) enforce ACL authorization/);
  assert.deepEqual(
    result.findings.map((f) => f.location.sysId),
    ["op1", "op2"],
  );
});

test("a resource falls back to its API's ACLs, and a gating script backs it (ACL-9)", async () => {
  const ops = [
    // No own ACL list: the API's default list (acl1, role-gated) applies.
    securedOp({ enforce_acl: "", web_service_definition: "def1" }),
    // A script-gated ACL with no role link backs this one.
    securedOp({ sys_id: "op2", name: "byScript", enforce_acl: "acl4" }),
    // An ungated ACL: the only resource reported.
    securedOp({ sys_id: "op3", name: "openList", enforce_acl: "acl5" }),
  ];
  const defs = [
    { sys_id: "def1", name: "records", active: "true", enforce_acl: "acl1" },
  ];
  const acls = [
    ENDPOINT_ACL,
    {
      ...ENDPOINT_ACL,
      sys_id: "acl4",
      script: 'answer = gs.hasRole("x_acme_app.user");',
    },
    { ...ENDPOINT_ACL, sys_id: "acl5", script: "answer = true;" },
  ];
  const result = await run(makeHttp({ ops, defs, acls }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /1 resource\(s\) enforce ACL authorization/);
  assert.match(result.message, /openList \[GET\]/);
  assert.doesNotMatch(result.message, /getRecords|byScript/);
});

test("skips the resources of an explicitly inactive API (ACL-9)", async () => {
  const ops = [
    securedOp(),
    securedOp({
      sys_id: "op2",
      name: "retired",
      requires_authentication: "false",
      web_service_definition: "def2",
    }),
  ];
  const defs = [{ sys_id: "def2", name: "old", active: "false" }];
  const result = await run(makeHttp({ ops, defs, acls: [ENDPOINT_ACL] }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /All 1 active scripted REST/);
  assert.match(result.message, /1 resource\(s\) of an inactive API skipped/);
});

test("fails on a trimmed API read rather than trusting the visible ones (ACL-9)", async () => {
  const ops = [securedOp({ web_service_definition: "def1" })];
  const defs = [{ sys_id: "def1", name: "records", active: "true" }];
  const result = await run(
    makeHttp({
      ops,
      defs,
      acls: [ENDPOINT_ACL],
      totalCounts: { sys_ws_definition: 3 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_ws_definition/);
  assert.match(result.message, /security-trimmed/i);
});

test("fails on a trimmed ACL-role read rather than calling the ACL ungated (ACL-9)", async () => {
  const result = await run(
    makeHttp({
      ops: [securedOp()],
      acls: [ENDPOINT_ACL],
      totalCounts: { sys_security_acl_role: 4 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/i);
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

test("reports error (not passes) when authentication is rejected", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "error");
  assert.match(result.message, /authentication failed/i);
});

test("reports error when the instance is unreachable", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "error");
  assert.match(result.message, /could not reach/i);
});

test("reports error on an HTTP error from the table read", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sys_ws_operation: { http: 502 } } } }),
  );
  assert.equal(result.status, "error");
  assert.match(result.message, /502/);
});

function assertRowFindings(result, table, kinds) {
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    kinds,
  );
  for (const f of result.findings) {
    assert.equal(f.location.table, table);
    assert.ok(f.location.sysId || f.location.logicalId);
    assert.ok(f.location.recordName);
    assert.match(f.id, /^f1:[0-9a-f]{16}$/);
  }
}

test("emits one finding per anonymous resource (F-R-3)", async () => {
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
  assertRowFindings(result, "sys_ws_operation", ["anonymous"]);
  assert.equal(result.findings[0].location.sysId, "op2");
});

test("an unbacked resource is a per-resource warn finding (F-R-3, ACL-9)", async () => {
  const acls = [{ ...ENDPOINT_ACL, type: "record" }];
  const result = await run(makeHttp({ ops: [securedOp()], acls }));
  assert.equal(result.status, "warn");
  assert.equal(result.findings.length, 1);
  assertRowFindings(result, "sys_ws_operation", ["no-gated-endpoint-acl"]);
  assert.equal(result.findings[0].status, "warn");
  assert.equal(result.findings[0].location.sysId, "op1");
});
