import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:https";
import { once, getEventListeners } from "node:events";

import {
  CLOCK,
  TRANSPORT_WRAP,
  createSnClient,
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  withSignal,
} from "../../build/http/client.js";
import { diagnoseAuthFailure } from "../../build/http/diagnose.js";
import { createLimiter } from "../../build/http/limiter.js";
import { resolveProxy } from "../../build/http/proxy.js";
import { linkRunContext, resolveScope } from "../../build/http/query.js";

/**
 * RR-60: HTTP robustness regressions (AUDIT-2026-11-12 HTTP-3, HTTP-7…HTTP-14,
 * HTTP-16…HTTP-18). Each test pins one finding; waits run on a virtual clock.
 */

for (const name of [
  "SNPF_PROXY",
  "SNPF_NO_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
]) {
  delete process.env[name];
}

const INSTANCE = "https://dev12345.service-now.com";
const BASIC = { kind: "basic", user: "admin", pass: "secret" };
const OAUTH = { kind: "oauth-client", clientId: "cid", clientSecret: "csec" };

const realFetch = globalThis.fetch;
let handler;
let calls;

function fakeResponse({ status = 200, body, headers, text } = {}) {
  const payload =
    text !== undefined ? text : body === undefined ? "" : JSON.stringify(body);
  return {
    status,
    statusText: "",
    headers,
    text: () => Promise.resolve(payload),
  };
}

beforeEach(() => {
  handler = null;
  calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    try {
      return Promise.resolve(handler(String(url), init));
    } catch (err) {
      return Promise.reject(err);
    }
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A virtual clock: `sleep` records the wait and advances time at once. */
function fakeClock() {
  const sleeps = [];
  let now = Date.parse("2026-01-01T00:00:00Z");
  return {
    sleeps,
    now: () => now,
    sleep(ms) {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
  };
}

const isTokenPost = (url) => url.endsWith("/oauth_token.do");
const ok = () => fakeResponse({ body: { result: { sys_id: "z" } } });

function client(extra = {}) {
  return createSnClient({
    instanceUrl: INSTANCE,
    auth: BASIC,
    cicdPollIntervalMs: 0,
    ...extra,
  });
}

const settledProgress = () =>
  fakeResponse({
    body: {
      result: {
        status: 2,
        links: {
          results: { id: "r1", url: "/api/sn_cicd/testsuite/results/r1" },
        },
      },
    },
  });

// --- HTTP-3: the progress poll stays on the configured origin --------------

for (const [label, progress] of [
  [
    "an id with a foreign url",
    { id: "p1", url: "https://localhost:8443/api/sn_cicd/progress/p1" },
  ],
  [
    "a url only",
    { url: "https://evil.example.com/api/sn_cicd/progress/p1?x=1" },
  ],
]) {
  test(`HTTP-3: a progress link with ${label} is polled on the instance`, async () => {
    handler = (url, init) => {
      if (init.method === "POST") {
        return fakeResponse({
          body: { result: { status: 1, links: { progress } } },
        });
      }
      return settledProgress();
    };
    const out = await client().cicd.runTestSuite("suite-1");
    assert.equal(out.status, "success");
    assert.ok(calls[1].url.startsWith(`${INSTANCE}/api/sn_cicd/progress/p1`));
    assert.ok(calls.every((c) => c.url.startsWith(INSTANCE)));
  });
}

// --- HTTP-7: Retry-After parsing --------------------------------------------

for (const [value, expected] of [
  ["1.5", 1500],
  ["+5", 5000],
  ["0", 250],
]) {
  test(`HTTP-7: Retry-After "${value}" waits ${expected} ms`, async () => {
    let hits = 0;
    handler = () =>
      ++hits === 1
        ? fakeResponse({ status: 429, headers: { "retry-after": value } })
        : ok();
    const clock = fakeClock();
    await client({ [CLOCK]: clock })
      .table("incident")
      .get("z");
    assert.deepEqual(clock.sleeps, [expected]);
  });
}

// --- HTTP-9: network error cause and redirect target -------------------------

test("HTTP-9: a network failure names the underlying cause", async () => {
  const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), {
    code: "ECONNREFUSED",
  });
  handler = () => {
    throw new TypeError("fetch failed", { cause });
  };
  await assert.rejects(client().table("incident").get("z"), (err) => {
    assert.ok(err instanceof SnNetworkError);
    assert.match(err.message, /ECONNREFUSED/);
    assert.ok(err.cause, "the original error is kept as the cause");
    return true;
  });
});

test("HTTP-9: a redirect is refused naming its target without the query", async () => {
  handler = () =>
    fakeResponse({
      status: 302,
      headers: { location: "https://sso.example.com/login.do?token=abc" },
    });
  await assert.rejects(client().table("incident").get("z"), (err) => {
    assert.ok(err instanceof SnNetworkError);
    assert.match(err.message, /302/);
    assert.match(err.message, /https:\/\/sso\.example\.com\/login\.do/);
    assert.doesNotMatch(err.message, /token=abc/);
    return true;
  });
});

// --- HTTP-10: token endpoint 429/5xx and caller abort ------------------------

test("HTTP-10: a token-endpoint 429 is retried after its Retry-After", async () => {
  let posts = 0;
  handler = (url) => {
    if (!isTokenPost(url)) return ok();
    return ++posts === 1
      ? fakeResponse({ status: 429, headers: { "retry-after": "2" } })
      : fakeResponse({ body: { access_token: "acc" } });
  };
  const clock = fakeClock();
  await client({ auth: OAUTH, [CLOCK]: clock })
    .table("incident")
    .get("z");
  assert.equal(posts, 2);
  assert.deepEqual(clock.sleeps, [2000]);
  assert.equal(calls.at(-1).init.headers.Authorization, "Bearer acc");
});

test("HTTP-10: a persistent token-endpoint 503 is an SnHttpError, not an auth failure", async () => {
  handler = (url) =>
    isTokenPost(url)
      ? fakeResponse({ status: 503, body: { error: { message: "down" } } })
      : ok();
  const clock = fakeClock();
  await assert.rejects(
    client({ auth: OAUTH, [CLOCK]: clock })
      .table("incident")
      .get("z"),
    (err) => {
      assert.ok(err instanceof SnHttpError);
      assert.ok(!(err instanceof SnAuthError));
      assert.equal(err.status, 503);
      return true;
    },
  );
  assert.equal(calls.filter((c) => isTokenPost(c.url)).length, 4);
});

test("HTTP-10: a caller abort ends a wait on a hanging token request", async () => {
  handler = (url, init) =>
    isTokenPost(url)
      ? new Promise((_, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(init.signal.reason),
          ),
        )
      : ok();
  const ac = new AbortController();
  const pending = withSignal(
    client({ auth: OAUTH, timeoutMs: 1500 }),
    ac.signal,
  )
    .table("incident")
    .get("z")
    .catch((err) => err);
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  const outcome = await Promise.race([
    pending,
    new Promise((r) => setTimeout(() => r("still waiting"), 500)),
  ]);
  assert.ok(outcome instanceof SnNetworkError, `got ${String(outcome)}`);
  assert.match(outcome.message, /abort/i);
  await pending;
});

// --- HTTP-14: a rotated refresh token is used for the next exchange ----------

test("HTTP-14: the refresh token the endpoint rotates is presented next time", async () => {
  let posts = 0;
  let apiHits = 0;
  handler = (url) => {
    if (isTokenPost(url)) {
      posts++;
      return fakeResponse({
        body: {
          access_token: `acc-${posts}`,
          refresh_token: `rt-${posts + 1}`,
        },
      });
    }
    // The first API call finds the token stale, forcing a second exchange.
    return ++apiHits === 1 ? fakeResponse({ status: 401, body: {} }) : ok();
  };
  await client({
    auth: {
      kind: "oauth-refresh",
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt-1",
    },
  })
    .table("incident")
    .get("z");
  const presented = calls
    .filter((c) => isTokenPost(c.url))
    .map((c) => new URLSearchParams(c.init.body).get("refresh_token"));
  assert.deepEqual(presented, ["rt-1", "rt-2"]);
});

// --- HTTP-16: an unusable private key is an SnAuthError ----------------------

test("HTTP-16: a malformed JWT private key is an SnAuthError without key material", async () => {
  const privateKey =
    // Not a key: base64 of "not-a-key-secret" in a PEM frame, built up so a
    // secret scanner does not mistake the fixture for real key material.
    ["BEGIN", "END"]
      .map((edge) => `-----${edge} PRIVATE KEY-----`)
      .join("\nbm90LWEta2V5LXNlY3JldA==\n") + "\n";
  handler = () => fakeResponse({ body: { access_token: "acc" } });
  await assert.rejects(
    client({ auth: { kind: "oauth-jwt", clientId: "cid", privateKey } })
      .table("incident")
      .get("z"),
    (err) => {
      assert.ok(err instanceof SnAuthError, `got ${err?.constructor?.name}`);
      assert.match(err.message, /private key/);
      assert.ok(!err.message.includes("bm90LWEta2V5LXNlY3JldA"));
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

// --- HTTP-17: a token-endpoint 403 is diagnosed as an OAuth problem ----------

test("HTTP-17: a 403 from the token endpoint gets token hints, not ACL hints", () => {
  const hints = diagnoseAuthFailure({
    status: 403,
    authKind: "oauth-client",
    tokenEndpoint: true,
  });
  assert.match(hints[0], /token endpoint/i);
  assert.ok(hints.some((h) => /OAuth application registry/.test(h)));
  assert.ok(!hints.some((h) => /\bACL\b|role/i.test(h)), hints.join(" | "));
});

// --- HTTP-11: NO_PROXY wildcard and CIDR forms --------------------------------

test("HTTP-11: NO_PROXY honours *.domain and CIDR ranges", () => {
  const env = (noProxy) => ({
    HTTPS_PROXY: "http://proxy.corp:3128",
    NO_PROXY: noProxy,
  });
  const via = (url, noProxy) => resolveProxy(url, { env: env(noProxy) });
  assert.equal(
    via("https://dev1.service-now.com", "*.service-now.com"),
    undefined,
  );
  assert.equal(via("https://10.1.2.3", "10.0.0.0/8"), undefined);
  assert.equal(via("https://[fd00::5]", "fd00::/8"), undefined);
  // A hostname never matches a CIDR; a range that does not contain the IP,
  // a malformed range and an inner wildcard all keep the proxy.
  assert.ok(via("https://dev1.service-now.com", "10.0.0.0/8"));
  assert.ok(via("https://11.1.2.3", "10.0.0.0/8"));
  assert.ok(via("https://10.1.2.3", "10.0.0.0/99"));
  assert.ok(via("https://dev1.service-now.com", "dev*.service-now.com"));
});

// --- HTTP-13: a backward clock step does not stall the limiter ---------------

test("HTTP-13: a backward clock step keeps the limiter wait short", async () => {
  let t = 10_000_000;
  const waits = [];
  const limiter = createLimiter({
    rps: 10,
    now: () => t,
    sleep: (ms) => {
      waits.push(ms);
      return new Promise(() => {});
    },
  });
  (await limiter.acquire())();
  t -= 3_600_000; // NTP / VM resume steps the wall clock back an hour.
  void limiter.acquire();
  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= 100, `waited ${waits[0]} ms`);
});

// --- HTTP-8: one check's abort does not cancel a shared scope lookup ---------

test("HTTP-8: an aborted check does not fail the scope lookup it shares", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const rows = [{ sys_id: "a".repeat(32), scope: "x_acme_app" }];
  const httpFor = (signal) => ({
    table: () => ({
      query: () =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new SnNetworkError("aborted")),
          );
          void gate.then(() => resolve(rows));
        }),
    }),
  });
  const root = { http: httpFor(undefined) };
  const acA = new AbortController();
  const acB = new AbortController();
  const a = { http: httpFor(acA.signal), signal: acA.signal };
  const b = { http: httpFor(acB.signal), signal: acB.signal };
  linkRunContext(a, root);
  linkRunContext(b, root);
  const pa = resolveScope(a, "x_acme_app");
  const pb = resolveScope(b, "x_acme_app");
  acA.abort();
  await assert.rejects(pa, SnNetworkError);
  release();
  const resolved = await pb;
  assert.equal(resolved.clause, `sys_scope=${"a".repeat(32)}`);
});

// --- node transport: HTTP-12 BOM, HTTP-18 abort-listener cleanup -------------

const fixture = (name) =>
  readFileSync(
    fileURLToPath(new URL(`../fixtures/tls/${name}`, import.meta.url)),
    "utf8",
  );

async function withMtlsServer(onRequest, fn) {
  const server = createServer(
    {
      key: fixture("server.key"),
      cert: fixture("server.crt"),
      ca: fixture("client.crt"),
      requestCert: true,
      rejectUnauthorized: true,
    },
    onRequest,
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    return await fn(`https://localhost:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

const tls = () => ({
  cert: fixture("client.crt"),
  key: fixture("client.key"),
  ca: fixture("server.crt"),
});

test("HTTP-12: the node transport parses a BOM-prefixed JSON body", async () => {
  await withMtlsServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("﻿" + JSON.stringify({ result: { sys_id: "x" } }));
    },
    async (instanceUrl) => {
      const rec = await createSnClient({ instanceUrl, tls: tls() })
        .table("incident")
        .get("x");
      assert.deepEqual(rec, { sys_id: "x" });
    },
  );
});

test("HTTP-18: the node transport removes its abort listener after a request", async () => {
  const longLived = new AbortController().signal;
  await withMtlsServer(
    (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: { sys_id: "x" } }));
    },
    async (instanceUrl) => {
      const http = createSnClient({
        instanceUrl,
        tls: tls(),
        [TRANSPORT_WRAP]: (inner) => (url, init) =>
          inner(url, { ...init, signal: longLived }),
      });
      for (let i = 0; i < 3; i++) await http.table("incident").get("x");
      // Let the sockets' close events run.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(getEventListeners(longLived, "abort").length, 0);
    },
  );
});
