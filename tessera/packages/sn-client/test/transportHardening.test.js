// Transport hardening, delegated decisions 2026-09-25 (fail closed):
//   1. A write whose path is not canonical — dot segments raw or
//      percent-encoded, empty segments, `;`, encoded separators — is refused
//      before any policy check, and a write to the Table/Import API family is
//      classified with an ANCHORED regex (optional /v<N>/), so `fetch`'s URL
//      normalisation can no longer send a write to a table other than the one
//      the never-write list, SN_TABLES_ALLOW/DENY and the journal saw.
//   2. Redirects are never followed (API requests and the OAuth token
//      request): a followed 3xx replays credentials and bodies to an unchecked
//      host. A 3xx becomes a ServiceNowError carrying the status, never the
//      Location value.
// The network is stubbed at globalThis.fetch; nothing here reaches an instance.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  snRequest,
  ServiceNowError,
  reloadCredentialsFromEnv,
  setLogSink,
  tableApi,
  invalidateTokens,
  exchangeAuthorizationCode,
} from "../build/index.js";

const OWNED_ENV = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_MAX_RETRIES",
  "SN_LOG_LEVEL",
  "SN_ACTIVE_PROFILE",
  "SN_AUTH",
  "SN_AUTH_MODE",
  "SN_API_KEY",
  "SN_BEARER_TOKEN",
  "SN_OAUTH_CLIENT_ID",
  "SN_OAUTH_CLIENT_SECRET",
  "SN_OAUTH_GRANT",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
];

const EVIL = "https://evil.example/steal";

let saved;
let docsDir;
let calls;
let originalFetch;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  response = () => jsonResponse({ result: { sys_id: "s1" } }),
) {
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(response(url, init));
  };
}

function journalEntries(profile = "default") {
  const file = path.join(docsDir, profile, "write-journal.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  saved = Object.fromEntries(OWNED_ENV.map((key) => [key, process.env[key]]));
  docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-hardening-"));
  calls = [];
  originalFetch = globalThis.fetch;
  for (const key of OWNED_ENV) delete process.env[key];
  process.env.SN_INSTANCE = "dev00001.service-now.com";
  process.env.SN_USER = "admin";
  process.env.SN_PASSWORD = "secret";
  process.env.SN_DOCS_DIR = docsDir;
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_LOG_LEVEL = "error";
  reloadCredentialsFromEnv();
  invalidateTokens();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setLogSink(null);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  reloadCredentialsFromEnv();
  invalidateTokens();
  fs.rmSync(docsDir, { recursive: true, force: true });
});

describe("non-canonical write paths are refused before any policy check", () => {
  // Each of these either resolves (in fetch) to a table other than the one a
  // naive classifier reads, or reaches the table API in a shape no policy can
  // pin to one table. No table policy is configured, so the only thing that
  // can stop them is the canonical-path gate.
  const refused = [
    "/api/now/table/./sys_user_has_role",
    "/api/now/table/%2e/sys_user_has_role",
    "/api/now/table/%2E/sys_user_has_role",
    "/api/now/table/incident/../sys_user_has_role",
    "/api/now/table/incident/%2E%2E/sys_user_has_role",
    "/api/now/table/incident/.%2e/sys_user_has_role",
    "/api/now/table/incident/%2e%2e%2fsys_user_has_role",
    "/api/now/table/incident/%2E%2E%5Csys_user_has_role",
    "/api/now/table/incident/%252e%252e/sys_user_has_role",
    "/api/now/table/incident\\..\\sys_user_has_role",
    "/api/now/table//sys_user_has_role",
    "/api/now//table/sys_user_has_role",
    "/api/now/table/incident;x=1/abc",
    "/api/now/table/sys_user_has_role;/abc",
    "/api/now/table/incident/abc/extra",
    "/x/api/now/table/sys_user_has_role",
    "/API/NOW/TABLE/sys_user_has_role",
    "/api/now/t%61ble/sys_user_has_role",
    "/api/now/table",
    "api/now/table/incident",
  ];
  for (const bad of refused) {
    it(`refuses POST ${bad}`, async () => {
      stubFetch();
      await assert.rejects(
        snRequest({ method: "POST", path: bad, body: { role: "admin" } }),
        (error) => {
          assert.ok(error instanceof ServiceNowError);
          assert.equal(error.status, 403);
          assert.match(error.message, /Refusing/);
          return true;
        },
      );
      assert.equal(calls.length, 0, "no request may leave the process");
      assert.deepEqual(journalEntries(), []);
    });
  }

  // Delegated decision 2026-09-25: a trailing `/` is refused, not classified.
  // The fake instance routes `/api/now/table/incident/` to a record-level 404
  // and a real instance's routing is unknown, so no such write may leave.
  for (const [method, trailing] of [
    ["POST", "/api/now/table/incident/"],
    ["POST", "/api/now/v2/table/incident/"],
    ["PATCH", "/api/now/table/incident/0123456789abcdef/"],
    ["DELETE", "/api/now/table/incident/0123456789abcdef/"],
    ["POST", "/api/now/import/u_import_set/"],
    ["POST", "/api/now/table/incident/?sysparm_fields=sys_id"],
    ["POST", "/api/sn_cicd/testsuite/run/"],
  ]) {
    it(`refuses ${method} ${trailing} (trailing slash)`, async () => {
      stubFetch();
      await assert.rejects(
        snRequest({ method, path: trailing, body: {} }),
        (error) => {
          assert.ok(error instanceof ServiceNowError);
          assert.equal(error.status, 403);
          assert.match(error.message, /^Refusing .*trailing '\/'/);
          return true;
        },
      );
      assert.equal(calls.length, 0, "no request may leave the process");
      assert.deepEqual(journalEntries(), []);
    });
  }

  it("classifies versioned Table API writes, so the never-write list holds", async () => {
    stubFetch();
    for (const versioned of [
      "/api/now/v1/table/sys_user_has_role",
      "/api/now/v2/table/sys_user_has_role/abc",
      "/api/now/v2/import/sys_user_has_role",
    ]) {
      await assert.rejects(
        snRequest({ method: "POST", path: versioned, body: {} }),
        (error) => error.status === 403 && /never-write/.test(error.message),
        versioned,
      );
    }
    assert.equal(calls.length, 0);
  });

  it("applies SN_TABLES_ALLOW to a versioned path's real table", async () => {
    process.env.SN_TABLES_ALLOW = "incident";
    stubFetch();
    await assert.rejects(
      snRequest({
        method: "POST",
        path: "/api/now/v2/table/sys_user",
        body: {},
      }),
      (error) => error.status === 403 && /SN_TABLES_ALLOW/.test(error.message),
    );
    assert.equal(calls.length, 0);
  });

  it("journals a versioned write under the table it actually reached", async () => {
    stubFetch();
    await snRequest({
      method: "PATCH",
      path: "/api/now/v2/table/incident/abc",
      body: { state: "2" },
    });
    const [entry] = journalEntries();
    assert.equal(entry.action, "update");
    assert.equal(entry.table, "incident");
    assert.equal(entry.sys_id, "abc");
  });

  it("still lets canonical writes through", async () => {
    stubFetch();
    for (const [method, ok] of [
      ["POST", "/api/now/table/incident"],
      ["PATCH", "/api/now/table/incident/0123456789abcdef"],
      ["DELETE", "/api/now/table/incident/0123456789abcdef"],
      ["POST", `/api/now/table/${encodeURIComponent("sys user")}`],
      ["POST", "/api/now/import/u_staging/insertMultiple"],
      ["POST", "/api/now/table/incident?sysparm_input_display_value=true"],
      ["POST", "/api/sn_cicd/testsuite/run"],
    ]) {
      await snRequest({ method, path: ok, body: {} });
    }
    assert.equal(calls.length, 7);
  });

  it("leaves reads alone (the gate is write-side, like the table policy)", async () => {
    stubFetch(() => jsonResponse({ result: [] }));
    await snRequest({ method: "GET", path: "/api/now/v2/table/incident" });
    assert.equal(calls.length, 1);
  });
});

describe("table api layer rejects empty and dot table / sys_id arguments", () => {
  const cases = [
    ["updateRecord", () => tableApi.updateRecord(".", "sys_user_has_role", {})],
    ["updateRecord", () => tableApi.updateRecord("..", "x", {})],
    ["updateRecord", () => tableApi.updateRecord("incident", "..", {})],
    ["createRecord", () => tableApi.createRecord("", {})],
    ["deleteRecord", () => tableApi.deleteRecord("incident", "")],
    ["deleteRecord", () => tableApi.deleteRecord("incident", ".")],
    ["getRecord", () => tableApi.getRecord("..", "abc")],
  ];
  for (const [name, call] of cases) {
    it(`${name} refuses a bad argument before any request`, async () => {
      stubFetch();
      await assert.rejects(call(), (error) => {
        assert.ok(error instanceof ServiceNowError);
        assert.match(error.message, /Invalid (table|sys_id)/);
        return true;
      });
      assert.equal(calls.length, 0);
    });
  }
});

describe("redirects are never followed", () => {
  /** A 3xx whose Location and body both name the attacker's host. */
  const redirect = (status) => () =>
    new Response(`moved to ${EVIL}`, {
      status,
      headers: { location: EVIL },
    });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`turns an API ${status} into an error without the Location`, async () => {
      stubFetch(redirect(status));
      process.env.SN_API_KEY = "KEY123";
      await assert.rejects(
        snRequest({
          method: "POST",
          path: "/api/now/table/incident",
          body: {},
        }),
        (error) => {
          assert.ok(error instanceof ServiceNowError);
          assert.equal(error.status, status);
          assert.match(error.message, /redirect/);
          assert.doesNotMatch(error.message, /evil/);
          assert.equal(
            JSON.stringify(error.detail ?? null).includes("evil"),
            false,
          );
          return true;
        },
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].init.redirect, "manual");
      assert.deepEqual(
        journalEntries(),
        [],
        "an unfollowed write applied nothing",
      );
    });
  }

  it("treats a browser-style opaque redirect (status 0) the same way", async () => {
    globalThis.fetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve({
        type: "opaqueredirect",
        status: 0,
        ok: false,
        statusText: "",
        headers: new Headers(),
        text: () => Promise.resolve(""),
      });
    };
    await assert.rejects(
      snRequest({ method: "GET", path: "/api/now/table/incident" }),
      (error) =>
        error instanceof ServiceNowError && /redirect/.test(error.message),
    );
  });

  it("sends the OAuth token request with redirect: manual and refuses a 307", async () => {
    process.env.SN_AUTH = "oauth";
    process.env.SN_OAUTH_CLIENT_ID = "cid";
    process.env.SN_OAUTH_CLIENT_SECRET = "csecret";
    reloadCredentialsFromEnv();
    stubFetch(redirect(307));
    await assert.rejects(
      snRequest({ method: "GET", path: "/api/now/table/incident" }),
      (error) => {
        assert.ok(error instanceof ServiceNowError);
        assert.equal(error.status, 307);
        assert.match(error.message, /OAuth token request/);
        assert.match(error.message, /redirect/);
        assert.doesNotMatch(error.message, /evil/);
        return true;
      },
    );
    assert.equal(calls.length, 1, "the API request is never made");
    assert.match(String(calls[0].url), /\/oauth_token\.do$/);
    assert.equal(calls[0].init.redirect, "manual");
  });

  it("refuses a redirect on the authorization-code exchange too", async () => {
    stubFetch(redirect(308));
    await assert.rejects(
      exchangeAuthorizationCode("dev00001.service-now.com", {
        clientId: "cid",
        clientSecret: "csecret",
        code: "c",
        codeVerifier: "v",
        redirectUri: "http://localhost/cb",
      }),
      (error) => error.status === 308 && !/evil/.test(error.message),
    );
    assert.equal(calls[0].init.redirect, "manual");
  });
});
