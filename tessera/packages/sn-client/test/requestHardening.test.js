// Transport hardening, delegated decisions 2026-09-26 (review-w5a repros):
//   1. The HTTP method is upper-cased at the top of snRequest and anything
//      outside GET/POST/PATCH/PUT/DELETE is refused before any gate runs, so a
//      lower- or mixed-case method is journalled and sent as its canonical
//      value (method1.mjs: `delete` was journalled as `execute`).
//   2. OAuth token fetches are single-flight per cache key, and a 401 drops
//      the cached token only when it is still the one that was rejected
//      (auth1.mjs: 20 concurrent cold requests made 20 token requests, and 20
//      more after a revocation).
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
  invalidateTokens,
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
  "SN_API_KEY",
  "SN_BEARER_TOKEN",
  "SN_OAUTH_CLIENT_ID",
  "SN_OAUTH_CLIENT_SECRET",
  "SN_OAUTH_GRANT",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
];

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
  docsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-request-"));
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
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  reloadCredentialsFromEnv();
  invalidateTokens();
  fs.rmSync(docsDir, { recursive: true, force: true });
});

describe("the HTTP method is canonicalised before any gate", () => {
  function stubOk() {
    globalThis.fetch = (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return Promise.resolve(jsonResponse({ result: { sys_id: "s1" } }));
    };
  }

  for (const [raw, upper, action] of [
    ["delete", "DELETE", "delete"],
    ["Delete", "DELETE", "delete"],
    ["post", "POST", "create"],
    ["patch", "PATCH", "update"],
    ["pUt", "PUT", "update"],
  ]) {
    it(`journals and sends ${JSON.stringify(raw)} as ${upper}`, async () => {
      stubOk();
      const target =
        upper === "POST"
          ? "/api/now/table/incident"
          : "/api/now/table/incident/abc";
      await snRequest({ method: raw, path: target, body: {} });
      assert.deepEqual(
        calls.map((c) => c.method),
        [upper],
      );
      const entries = journalEntries();
      assert.equal(entries.length, 1);
      assert.equal(entries[0].action, action);
      assert.equal(entries[0].table, "incident");
    });
  }

  it("still applies the write gates to a lower-case method", async () => {
    process.env.SN_READONLY = "1";
    stubOk();
    await assert.rejects(
      snRequest({ method: "delete", path: "/api/now/table/incident/abc" }),
      (error) => {
        assert.equal(error.status, 403);
        assert.match(error.message, /DELETE \/api\/now\/table\/incident\/abc/);
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  it("treats a lower-case get as a read (not journalled)", async () => {
    stubOk();
    await snRequest({ method: "get", path: "/api/now/table/incident" });
    assert.deepEqual(
      calls.map((c) => c.method),
      ["GET"],
    );
    assert.deepEqual(journalEntries(), []);
  });

  for (const bad of ["HEAD", "OPTIONS", "TRACE", "CONNECT", "", " POST", 42]) {
    it(`refuses method ${JSON.stringify(bad)} before any request`, async () => {
      process.env.SN_READONLY = "1";
      stubOk();
      await assert.rejects(
        snRequest({ method: bad, path: "/api/now/table/incident" }),
        (error) => {
          assert.ok(error instanceof ServiceNowError);
          assert.match(error.message, /Unsupported HTTP method/);
          return true;
        },
      );
      assert.equal(calls.length, 0);
      assert.deepEqual(journalEntries(), []);
    });
  }
});

describe("OAuth token fetch is single-flight", () => {
  let tokenCalls;
  let issued;
  let revoked;
  let failNextToken;

  function useOAuth() {
    process.env.SN_AUTH = "oauth";
    process.env.SN_OAUTH_CLIENT_ID = "cid";
    process.env.SN_OAUTH_CLIENT_SECRET = "csecret";
    process.env.SN_OAUTH_GRANT = "client_credentials";
    reloadCredentialsFromEnv();
    invalidateTokens();
    tokenCalls = 0;
    issued = 0;
    revoked = new Set();
    failNextToken = false;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.endsWith("/oauth_token.do")) {
        tokenCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (failNextToken) {
          failNextToken = false;
          return jsonResponse({ error: "server_error" }, 500);
        }
        issued += 1;
        return jsonResponse({ access_token: `tok${issued}`, expires_in: 1800 });
      }
      calls.push({ url: u, auth: init.headers.Authorization });
      if (revoked.has(init.headers.Authorization)) {
        return new Response("{}", { status: 401 });
      }
      return jsonResponse({ result: [] });
    };
  }

  const burst = (n) =>
    Promise.allSettled(
      Array.from({ length: n }, () =>
        snRequest({ method: "GET", path: "/api/now/table/incident" }),
      ),
    );

  it("makes ONE token request for 20 concurrent cold requests", async () => {
    useOAuth();
    const results = await burst(20);
    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal(tokenCalls, 1);
    assert.ok(calls.every((c) => c.auth === "Bearer tok1"));
  });

  it("makes ONE token request when 20 concurrent requests hit a revoked token", async () => {
    useOAuth();
    await burst(1);
    assert.equal(tokenCalls, 1);
    revoked.add("Bearer tok1");
    tokenCalls = 0;
    const results = await burst(20);
    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal(tokenCalls, 1);
  });

  it("does not drop a fresher token when a stale request's 401 arrives late", async () => {
    useOAuth();
    await burst(1); // tok1 cached
    revoked.add("Bearer tok1");
    tokenCalls = 0;
    // Two requests leave with tok1. The first 401 arrives at once, triggers the
    // refresh and caches tok2; the second 401 (a request that was in flight
    // before the refresh) arrives well after that. It must NOT evict tok2 —
    // compare-and-invalidate — so exactly one token request is made.
    const inner = globalThis.fetch;
    let apiCall = 0;
    globalThis.fetch = async (url, init) => {
      if (
        !String(url).endsWith("/oauth_token.do") &&
        init.headers.Authorization === "Bearer tok1"
      ) {
        apiCall += 1;
        if (apiCall === 2) await new Promise((r) => setTimeout(r, 80));
      }
      return inner(url, init);
    };
    const results = await burst(2);
    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal(tokenCalls, 1);
    const retried = calls.filter((c) => c.auth !== "Bearer tok1");
    assert.ok(retried.length >= 2);
    assert.ok(retried.every((c) => c.auth === "Bearer tok2"));
  });

  it("clears the in-flight entry on rejection, so the next call refetches", async () => {
    useOAuth();
    failNextToken = true;
    const first = await burst(10);
    assert.ok(first.every((r) => r.status === "rejected"));
    assert.equal(tokenCalls, 1, "all ten waiters shared the failed fetch");
    const second = await burst(3);
    assert.ok(second.every((r) => r.status === "fulfilled"));
    assert.equal(tokenCalls, 2);
  });

  it("does not cache a token fetched with credentials invalidated mid-flight", async () => {
    useOAuth();
    const pending = burst(1);
    // Credentials change while the first fetch is in flight.
    await new Promise((resolve) => setTimeout(resolve, 5));
    invalidateTokens();
    await pending;
    tokenCalls = 0;
    await burst(1);
    assert.equal(tokenCalls, 1, "the pre-invalidation token was not cached");
  });
});
