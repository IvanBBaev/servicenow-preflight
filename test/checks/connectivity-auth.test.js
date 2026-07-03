import { test } from "node:test";
import assert from "node:assert/strict";

import { connectivityAuth } from "../../build/checks/connectivity-auth.js";
import { createFakeSnClient } from "../../build/http/fake.js";
import { SnAuthError } from "../../build/http/client.js";

/** Basic auth every "authenticated" path needs so the no-auth branch is skipped. */
const AUTH = { kind: "basic", user: "admin", pass: "secret" };
const INSTANCE = "https://dev12345.service-now.com";

test("connectivity-auth warns when no credentials are configured", async () => {
  // No `auth` on the context: nothing to authenticate with.
  const http = createFakeSnClient({ tables: { sys_user: [{ sys_id: "u1" }] } });
  const result = await connectivityAuth.run({ instanceUrl: INSTANCE, http });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "warn");
});

test("connectivity-auth passes when the authenticated ping succeeds", async () => {
  const http = createFakeSnClient({ tables: { sys_user: [{ sys_id: "u1" }] } });
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "pass");
});

test("connectivity-auth passes even when sys_user returns no rows", async () => {
  // A successful (non-throwing) query still proves reachable + authenticated.
  const http = createFakeSnClient({ tables: { sys_user: [] } });
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.status, "pass");
});

test("connectivity-auth fails on a 401 authentication error", async () => {
  const http = createFakeSnClient({ fail: { auth: true } });
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "fail");
});

test("connectivity-auth warns on a 403 insufficient-rights error", async () => {
  // The fake's forced auth failure is 401; a 403 (reachable but degraded) is
  // modelled by wrapping the fake so the sys_user query throws SnAuthError(403).
  const base = createFakeSnClient({ tables: { sys_user: [{ sys_id: "u1" }] } });
  const http = {
    ...base,
    table() {
      return {
        get: () => Promise.reject(new SnAuthError("forbidden", 403)),
        query: () => Promise.reject(new SnAuthError("forbidden", 403)),
      };
    },
  };
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "warn");
});

test("connectivity-auth fails when the instance is unreachable", async () => {
  const http = createFakeSnClient({ fail: { network: true } });
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "fail");
});

test("connectivity-auth fails on an unexpected non-2xx HTTP status", async () => {
  const http = createFakeSnClient({ fail: { http: 500 } });
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "fail");
});
