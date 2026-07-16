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

test("connectivity-auth pings (not warns) when only a client cert is configured", async () => {
  // A mutual-TLS client cert identifies the caller on its own, so the check
  // must attempt the ping rather than warn about missing credentials.
  const http = createFakeSnClient({ tables: { sys_user: [{ sys_id: "u1" }] } });
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    tls: { cert: "CERT-PEM", key: "KEY-PEM" },
    http,
  });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "pass");
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

test("connectivity-auth passes against a realistically shaped sys_user row", async () => {
  // A non-throwing query that returns a real, well-shaped API row (reference and
  // empty columns in ServiceNow's { link, value } / "" forms) proves reachable +
  // authenticated. This replaces the old "empty rows still pass" assertion: an
  // empty result is exactly what a hibernating wake-up page would fake, so pass is
  // now pinned to a genuine row and hibernation is modelled as an explicit throw
  // (see the non-JSON 2xx case below).
  const http = createFakeSnClient({
    tables: {
      sys_user: [{ sys_id: "u1", user_name: "admin", email: "" }],
    },
  });
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.status, "pass");
});

test("connectivity-auth fails on a non-JSON 2xx (hibernating) response (CC-1)", async () => {
  // The client throws SnResponseError when a 2xx carries a non-JSON body — a
  // hibernating PDI's wake-up page or an SSO/proxy interstitial answering 200
  // with HTML. A green here would claim "authenticated" against an instance the
  // client never actually reached, so it must fail closed.
  const http = createFakeSnClient({
    tables: { sys_user: [] },
    fail: { response: true },
  });
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "fail");
  assert.match(result.message, /hibernat|non-JSON|interstitial/i);
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

test("connectivity-auth fails an SnAuthError with no HTTP status (no '(HTTP' text)", async () => {
  // A credential problem surfaced without a status code (e.g. the client could
  // not build the auth header) still fails closed, and the message must not
  // fabricate an "(HTTP …)" suffix from a missing status.
  const base = createFakeSnClient({ tables: { sys_user: [{ sys_id: "u1" }] } });
  const http = {
    ...base,
    table() {
      return {
        get: () => Promise.reject(new SnAuthError("missing credentials")),
        query: () => Promise.reject(new SnAuthError("missing credentials")),
      };
    },
  };
  const result = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.name, "connectivity-auth");
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication failed/i);
  assert.doesNotMatch(result.message, /\(HTTP/);
});

test("connectivity-auth fails closed on an unexpected non-Sn throw (catch-all)", async () => {
  // The final catch-all must map any error the client can throw — including a
  // plain Error or a non-Error value — to a well-formed fail carrying the detail.
  const base = createFakeSnClient({ tables: { sys_user: [{ sys_id: "u1" }] } });

  const plain = {
    ...base,
    table() {
      return {
        get: () => Promise.reject(new Error("boom")),
        query: () => Promise.reject(new Error("boom")),
      };
    },
  };
  const plainResult = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http: plain,
  });
  assert.equal(plainResult.status, "fail");
  assert.match(plainResult.message, /failed unexpectedly/i);
  assert.match(plainResult.message, /boom/);

  const nonError = {
    ...base,
    table() {
      return {
        get: () => Promise.reject("boom"),
        query: () => Promise.reject("boom"),
      };
    },
  };
  const nonErrorResult = await connectivityAuth.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http: nonError,
  });
  assert.equal(nonErrorResult.status, "fail");
  assert.match(nonErrorResult.message, /failed unexpectedly/i);
  assert.match(nonErrorResult.message, /boom/);
});
