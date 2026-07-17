import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";

import {
  createSnClient,
  SnError,
  SnAuthError,
  SnNetworkError,
  SnHttpError,
  SnResponseError,
  SnTruncationError,
} from "../../build/http/client.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const AUTH = { kind: "basic", user: "admin", pass: "secret" };

// SR-5: the client honours proxy environment variables per request. These
// tests exercise the direct fetch transport, so scrub any proxy variables the
// host machine may carry (node --test runs each file in its own process, so
// this cannot leak into other suites).
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

const realFetch = globalThis.fetch;

/** Set per test: (url, init) => fake Response, or throw to simulate a fetch reject. */
let handler;
/** Every (url, init) pair the client passed to fetch, in order. */
let calls;

/**
 * Build a minimal Response-like object the client consumes. `headers` is a plain
 * record (returned as-is; the transport lower-cases keys). `text`, when given,
 * overrides the body serialisation so a test can hand back a non-JSON payload.
 */
function fakeResponse({
  status = 200,
  body = undefined,
  statusText = "",
  headers = undefined,
  text = undefined,
}) {
  const payload =
    text !== undefined ? text : body === undefined ? "" : JSON.stringify(body);
  return { status, statusText, headers, text: () => Promise.resolve(payload) };
}

beforeEach(() => {
  handler = null;
  calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    try {
      return Promise.resolve(handler(String(url), init));
    } catch (err) {
      // A synchronous throw stands in for a rejected fetch (network failure).
      return Promise.reject(err);
    }
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function client(extra = {}) {
  return createSnClient({
    instanceUrl: INSTANCE,
    auth: AUTH,
    // Poll with no real delay so CI/CD tests run instantly.
    cicdPollIntervalMs: 0,
    ...extra,
  });
}

test("table().get returns the record on a 200 with a result object", async () => {
  handler = () =>
    fakeResponse({ body: { result: { sys_id: "abc", name: "Set" } } });
  const rec = await client().table("sys_update_set").get("abc");
  assert.deepEqual(rec, { sys_id: "abc", name: "Set" });
});

test("table().get returns null on a 404", async () => {
  handler = () => fakeResponse({ status: 404, body: { error: {} } });
  const rec = await client().table("sys_update_set").get("missing");
  assert.equal(rec, null);
});

test("table().get returns null when the result is not a single object", async () => {
  handler = () => fakeResponse({ body: { result: [] } });
  const rec = await client().table("incident").get("x");
  assert.equal(rec, null);
});

test("table().get throws SnHttpError on a non-2xx (non-404) status", async () => {
  handler = () =>
    fakeResponse({ status: 500, body: { error: { message: "boom" } } });
  await assert.rejects(
    () => client().table("incident").get("x"),
    (err) => {
      assert.ok(err instanceof SnHttpError);
      assert.equal(err.status, 500);
      return true;
    },
  );
});

test("table().query honours a caller-supplied sysparm_limit as a single page", async () => {
  handler = () => fakeResponse({ body: { result: [{ sys_id: "1" }] } });
  const rows = await client()
    .table("sys_user_role")
    .query({ sysparm_limit: "10", sysparm_fields: "sys_id" });
  assert.equal(rows.length, 1);
  // Exactly one request — no pagination when the caller bounds the set.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sysparm_limit=10/);
});

test("table().query auto-paginates until a short page ends the run", async () => {
  const fullPage = Array.from({ length: 1000 }, (_, i) => ({
    sys_id: `r${i}`,
  }));
  handler = (url) => {
    const offset = Number(new URL(url).searchParams.get("sysparm_offset"));
    const rows = offset === 0 ? fullPage : [{ sys_id: "last" }];
    return fakeResponse({ body: { result: rows } });
  };
  const rows = await client().table("sys_user_role").query();
  // 1000 (full) + 1 (short) rows, fetched across two pages.
  assert.equal(rows.length, 1001);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /sysparm_offset=0\b/);
  assert.match(calls[1].url, /sysparm_offset=1000\b/);
});

// --- CC-10: the sysparm_limit / sysparm_offset contract ---------------------

test("table().query treats an empty-string sysparm_limit as absent and auto-paginates", async () => {
  handler = (url) => {
    const offset = Number(new URL(url).searchParams.get("sysparm_offset"));
    const rows =
      offset === 0
        ? Array.from({ length: 1000 }, (_, i) => ({ sys_id: `r${i}` }))
        : [{ sys_id: "last" }];
    return fakeResponse({ body: { result: rows } });
  };
  const rows = await client()
    .table("sys_user_role")
    .query({ sysparm_limit: "" });
  // "" did not pin a single page — the client paged to the natural end.
  assert.equal(rows.length, 1001);
  assert.equal(calls.length, 2);
});

test("table().query rejects a sysparm_offset supplied without a sysparm_limit", async () => {
  handler = () => fakeResponse({ body: { result: [] } });
  await assert.rejects(
    () => client().table("incident").query({ sysparm_offset: "100" }),
    (err) => {
      assert.ok(err instanceof SnError);
      assert.match(err.message, /sysparm_offset/);
      assert.match(err.message, /sysparm_limit/);
      return true;
    },
  );
  // Rejected before any request went out — no ambiguous window was fetched.
  assert.equal(calls.length, 0);
});

test("table().query honours an explicit sysparm_offset alongside a sysparm_limit", async () => {
  handler = () => fakeResponse({ body: { result: [{ sys_id: "x" }] } });
  await client()
    .table("incident")
    .query({ sysparm_limit: "10", sysparm_offset: "40" });
  // A single bounded page that preserves the caller's offset.
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sysparm_offset=40\b/);
  assert.match(calls[0].url, /sysparm_limit=10\b/);
});

// --- CC-33: a stable ORDERBY keyed on sys_id while auto-paginating ----------

test("auto-pagination pins ORDERBYsys_id when the query carries no ordering", async () => {
  handler = () => fakeResponse({ body: { result: [] } });
  await client().table("sys_user_role").query({ sysparm_query: "active=true" });
  const q = new URL(calls[0].url).searchParams.get("sysparm_query");
  assert.equal(q, "active=true^ORDERBYsys_id");
});

test("auto-pagination sets ORDERBYsys_id even with no query at all", async () => {
  handler = () => fakeResponse({ body: { result: [] } });
  await client().table("sys_user_role").query();
  const q = new URL(calls[0].url).searchParams.get("sysparm_query");
  assert.equal(q, "ORDERBYsys_id");
});

test("auto-pagination preserves a caller's own ORDERBY clause", async () => {
  handler = () => fakeResponse({ body: { result: [] } });
  await client()
    .table("sys_user_role")
    .query({ sysparm_query: "active=true^ORDERBYDESCsys_created_on" });
  const q = new URL(calls[0].url).searchParams.get("sysparm_query");
  assert.equal(q, "active=true^ORDERBYDESCsys_created_on");
});

// --- CC-9: fail closed at the row cap instead of silently truncating --------

test("auto-pagination throws SnTruncationError at the row cap rather than truncating", async () => {
  // Every page is full, so the run never reaches a natural (short-page) end.
  handler = () =>
    fakeResponse({
      body: {
        result: Array.from({ length: 1000 }, (_, i) => ({ sys_id: `r${i}` })),
      },
    });
  await assert.rejects(
    () => client({ maxRows: 1500 }).table("sys_user_role").query(),
    (err) => {
      assert.ok(err instanceof SnTruncationError);
      assert.equal(err.cap, 1500);
      assert.match(err.message, /cap/i);
      return true;
    },
  );
  // Two full pages (2000 rows) crossed the 1500 cap before the throw.
  assert.equal(calls.length, 2);
});

test("auto-pagination does NOT throw when a full final page reaches X-Total-Count at the cap", async () => {
  // A result set whose size is an exact multiple of the page size AND equals
  // maxRows (here 2000 = 2×1000) would trip the cap on the last full page. The
  // pre-trim X-Total-Count says the set is exhausted, so it must resolve, not
  // throw a false truncation error.
  handler = (url) => {
    const offset = Number(new URL(url).searchParams.get("sysparm_offset"));
    return fakeResponse({
      headers: { "X-Total-Count": "2000" },
      body: {
        result: Array.from({ length: 1000 }, (_, i) => ({
          sys_id: `r${offset + i}`,
        })),
      },
    });
  };
  const rows = await client({ maxRows: 2000 }).table("sys_user_role").query();
  assert.equal(rows.length, 2000);
  // Exactly two pages; the X-Total-Count break fired before the cap throw.
  assert.equal(calls.length, 2);
});

test("request() resolves with status and body for any status (no throw)", async () => {
  handler = () =>
    fakeResponse({ status: 500, body: { error: { message: "x" } } });
  const res = await client().request("GET", "/api/now/table/incident");
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: { message: "x" } });
});

test("a 401 raises SnAuthError carrying the status", async () => {
  handler = () =>
    fakeResponse({ status: 401, body: { error: { message: "bad creds" } } });
  await assert.rejects(
    () => client().request("GET", "/api/now/table/incident"),
    (err) => {
      assert.ok(err instanceof SnAuthError);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("a fetch rejection surfaces as SnNetworkError", async () => {
  handler = () => {
    throw new TypeError("fetch failed");
  };
  await assert.rejects(
    () => client().request("GET", "/api/now/table/incident"),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      return true;
    },
  );
});

test("a timeout is reported as SnNetworkError mentioning the timeout", async () => {
  handler = () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    throw err;
  };
  await assert.rejects(
    () => client({ timeoutMs: 5 }).request("GET", "/api/now/table/x"),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      assert.match(err.message, /timed out/i);
      return true;
    },
  );
});

test("cicd.runTestSuite polls the progress link until the run settles", async () => {
  handler = (url, init) => {
    if (init.method === "POST") {
      // Kickoff: still running, hand back a progress link to follow.
      return fakeResponse({
        body: {
          result: {
            status: 1,
            links: { progress: { id: "p1", url: "/api/sn_cicd/progress/p1" } },
          },
        },
      });
    }
    // Progress poll: now successful, with the results link resolved.
    return fakeResponse({
      body: { result: { status: 2, links: { results: { id: "res-1" } } } },
    });
  };
  const out = await client().cicd.runTestSuite("suite-1");
  assert.equal(out.status, "success");
  assert.equal(out.resultId, "res-1");
});

test("cicd.runTestSuite settles immediately when the kickoff is already terminal", async () => {
  handler = () =>
    fakeResponse({
      body: { result: { status: 2, links: { results: { id: "r0" } } } },
    });
  const out = await client().cicd.runTestSuite("suite-1");
  assert.equal(out.status, "success");
  assert.equal(out.resultId, "r0");
  // No progress GET needed — the single call is the POST kickoff.
  assert.equal(calls.length, 1);
});

test("cicd.runTestSuite gives up as non-terminal after exhausting its polls", async () => {
  handler = () =>
    fakeResponse({
      body: {
        result: {
          status: 1,
          links: { progress: { id: "p1", url: "/api/sn_cicd/progress/p1" } },
        },
      },
    });
  const out = await client({ cicdMaxPolls: 2 }).cicd.runTestSuite("suite-1");
  assert.equal(out.status, "running");
  assert.equal(out.resultId, undefined);
});

test("cicd status maps a status_label string when no numeric code is present", async () => {
  handler = (url, init) => {
    if (init.method === "POST") {
      return fakeResponse({
        body: { result: { status_label: "Success", links: {} } },
      });
    }
    return fakeResponse({ body: { result: {} } });
  };
  const out = await client().cicd.runTestSuite("suite-1");
  assert.equal(out.status, "success");
});

test("cicd status falls back to 'unknown' for an unmapped numeric code", async () => {
  // A numeric status code the client does not recognise must fail closed as
  // "unknown", never as a fabricated pass. With no progress link the run
  // settles immediately on that unknown status.
  handler = () =>
    fakeResponse({ body: { result: { status: 9999, links: {} } } });
  const out = await client().cicd.runTestSuite("suite-1");
  assert.equal(out.status, "unknown");
});

test("cicd status falls back to 'unknown' for a payload with no status field", async () => {
  // Neither `status` nor `status_label` present: the fail-closed default is
  // "unknown" so a malformed CI/CD body can never be read as a terminal pass.
  handler = () => fakeResponse({ body: { result: { links: {} } } });
  const out = await client().cicd.runTestSuite("suite-1");
  assert.equal(out.status, "unknown");
});

test("oauth auth sends a Bearer Authorization header", async () => {
  handler = () => fakeResponse({ body: { result: { sys_id: "z" } } });
  await createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "oauth", token: "tok123" },
  })
    .table("incident")
    .get("z");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok123");
});

test("apikey auth sends x-sn-apikey and no Authorization header", async () => {
  handler = () => fakeResponse({ body: { result: { sys_id: "z" } } });
  await createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "apikey", apiKey: "KEY123" },
  })
    .table("incident")
    .get("z");
  assert.equal(calls[0].init.headers["x-sn-apikey"], "KEY123");
  assert.equal(calls[0].init.headers.Authorization, undefined);
});

/** True for a request to the OAuth token endpoint (as opposed to a REST call). */
function isTokenPost(url) {
  return url.endsWith("/oauth_token.do");
}

/** A handler that mints `accessToken` at the token endpoint and echoes a record elsewhere. */
function grantHandler(accessToken, opts = {}) {
  return (url) =>
    isTokenPost(url)
      ? fakeResponse({ body: { access_token: accessToken, ...opts } })
      : fakeResponse({ body: { result: { sys_id: "z" } } });
}

test("oauth-password grant acquires a token, then calls with the Bearer", async () => {
  handler = grantHandler("acc-pw", { expires_in: 1800 });
  await createSnClient({
    instanceUrl: INSTANCE,
    auth: {
      kind: "oauth-password",
      clientId: "cid",
      clientSecret: "csec",
      user: "u",
      pass: "p",
    },
  })
    .table("incident")
    .get("z");

  // First call is the token POST (form-encoded, no Authorization header).
  const tokenCall = calls[0];
  assert.match(tokenCall.url, /\/oauth_token\.do$/);
  assert.equal(tokenCall.init.method, "POST");
  assert.equal(
    tokenCall.init.headers["Content-Type"],
    "application/x-www-form-urlencoded",
  );
  assert.equal(tokenCall.init.headers.Authorization, undefined);
  const body = new URLSearchParams(tokenCall.init.body);
  assert.equal(body.get("grant_type"), "password");
  assert.equal(body.get("client_id"), "cid");
  assert.equal(body.get("client_secret"), "csec");
  assert.equal(body.get("username"), "u");
  assert.equal(body.get("password"), "p");
  // The REST call then carries the acquired bearer.
  assert.equal(calls[1].init.headers.Authorization, "Bearer acc-pw");
});

test("oauth-client grant posts client_credentials", async () => {
  handler = grantHandler("acc-cc");
  await createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
  })
    .table("incident")
    .get("z");
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get("grant_type"), "client_credentials");
  assert.equal(body.get("client_id"), "cid");
  assert.equal(calls[1].init.headers.Authorization, "Bearer acc-cc");
});

test("oauth-refresh grant posts refresh_token", async () => {
  handler = grantHandler("acc-rt");
  await createSnClient({
    instanceUrl: INSTANCE,
    auth: {
      kind: "oauth-refresh",
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rt",
    },
  })
    .table("incident")
    .get("z");
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("refresh_token"), "rt");
  assert.equal(calls[1].init.headers.Authorization, "Bearer acc-rt");
});

test("a grant flow honours a tokenUrl override", async () => {
  handler = (url) =>
    url === "https://auth.example.com/token"
      ? fakeResponse({ body: { access_token: "acc-ov" } })
      : fakeResponse({ body: { result: { sys_id: "z" } } });
  await createSnClient({
    instanceUrl: INSTANCE,
    auth: {
      kind: "oauth-client",
      clientId: "cid",
      clientSecret: "csec",
      tokenUrl: "https://auth.example.com/token",
    },
  })
    .table("incident")
    .get("z");
  assert.equal(calls[0].url, "https://auth.example.com/token");
  assert.equal(calls[1].init.headers.Authorization, "Bearer acc-ov");
});

test("a plain-http tokenUrl override is refused before any secret is sent", async () => {
  // The grant POSTs client_secret (and, for the password grant, the user's
  // password) in the body — a downgrade to http would put both on the wire.
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: {
          kind: "oauth-client",
          clientId: "cid",
          clientSecret: "csec",
          tokenUrl: "http://auth.example.com/token",
        },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnError);
      assert.match(err.message, /must not.*unencrypted|https/is);
      return true;
    },
  );
  // Nothing left the process: the refusal precedes the token request.
  assert.equal(calls.length, 0);
});

test("a tokenUrl error never echoes the userinfo password", async () => {
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: {
          kind: "oauth-client",
          clientId: "cid",
          clientSecret: "csec",
          tokenUrl: "http://tokenuser:hunter2@auth.example.com/token",
        },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(!err.message.includes("hunter2"));
      assert.ok(!err.message.includes("tokenuser"));
      assert.match(err.message, /auth\.example\.com/);
      return true;
    },
  );
});

test("an instanceUrl carrying userinfo is refused, redacted", () => {
  assert.throws(
    () =>
      createSnClient({
        instanceUrl: "https://admin:hunter2@dev12345.service-now.com",
        auth: AUTH,
      }),
    (err) => {
      assert.ok(err instanceof SnError);
      // URL.origin would drop these credentials silently.
      assert.match(err.message, /userinfo/);
      assert.ok(!err.message.includes("hunter2"));
      return true;
    },
  );
});

test("the instanceUrl path guard redacts the userinfo it echoes", () => {
  assert.throws(
    () =>
      createSnClient({
        instanceUrl: "https://admin:hunter2@dev12345.service-now.com/servicenow",
        auth: AUTH,
      }),
    (err) => {
      assert.match(err.message, /path\/query\/fragment/);
      assert.ok(!err.message.includes("hunter2"));
      return true;
    },
  );
});

test("an acquired OAuth token is cached across requests", async () => {
  handler = grantHandler("acc-cache", { expires_in: 1800 });
  const c = createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
  });
  await c.table("incident").get("a");
  await c.table("incident").get("b");
  // A single token POST served both REST calls.
  assert.equal(calls.filter((x) => isTokenPost(x.url)).length, 1);
});

test("a 401 on a grant flow re-acquires the token and retries once", async () => {
  let apiHits = 0;
  handler = (url) => {
    if (isTokenPost(url)) {
      return fakeResponse({ body: { access_token: "acc-refresh" } });
    }
    apiHits++;
    // First REST hit is a 401 (stale token); the retry succeeds.
    return apiHits === 1
      ? fakeResponse({ status: 401, body: { error: { message: "expired" } } })
      : fakeResponse({ body: { result: { sys_id: "z" } } });
  };
  const rec = await createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
  })
    .table("incident")
    .get("z");
  assert.deepEqual(rec, { sys_id: "z" });
  // Two token POSTs (initial + re-acquire) and two REST calls (401 + retry).
  assert.equal(calls.filter((x) => isTokenPost(x.url)).length, 2);
  assert.equal(apiHits, 2);
});

test("a grant flow surfaces a token-endpoint 401 as SnAuthError", async () => {
  handler = (url) =>
    isTokenPost(url)
      ? fakeResponse({
          status: 401,
          body: { error: { message: "invalid_client" } },
        })
      : fakeResponse({ body: { result: {} } });
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: { kind: "oauth-client", clientId: "cid", clientSecret: "bad" },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnAuthError);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("oauth-jwt grant posts a signed RS256 assertion", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

  let assertion;
  handler = (url, init) => {
    if (isTokenPost(url)) {
      assertion = new URLSearchParams(init.body).get("assertion");
      return fakeResponse({ body: { access_token: "acc-jwt" } });
    }
    return fakeResponse({ body: { result: { sys_id: "z" } } });
  };

  await createSnClient({
    instanceUrl: INSTANCE,
    auth: {
      kind: "oauth-jwt",
      clientId: "cid",
      privateKey: privatePem,
      keyId: "k1",
      subject: "svc-user",
      audience: "https://aud.example.com",
    },
  })
    .table("incident")
    .get("z");

  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(
    body.get("grant_type"),
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  assert.equal(body.get("client_id"), "cid");

  // The assertion is a 3-part JWT; decode header + claims and verify the sig.
  const parts = assertion.split(".");
  assert.equal(parts.length, 3);
  const decode = (s) =>
    JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  const header = decode(parts[0]);
  const claims = decode(parts[1]);
  assert.equal(header.alg, "RS256");
  assert.equal(header.typ, "JWT");
  assert.equal(header.kid, "k1");
  assert.equal(claims.iss, "cid"); // default issuer = clientId
  assert.equal(claims.sub, "svc-user");
  assert.equal(claims.aud, "https://aud.example.com");
  assert.equal(typeof claims.exp, "number");
  assert.ok(claims.exp > claims.iat);

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], "base64url");
  const verified = createVerify("RSA-SHA256")
    .update(signingInput)
    .end()
    .verify(publicKey, signature);
  assert.ok(verified, "the assertion signature must verify against the key");

  assert.equal(calls[1].init.headers.Authorization, "Bearer acc-jwt");
});

test("oauth-jwt uses a pre-signed assertion verbatim when supplied", async () => {
  handler = grantHandler("acc-presigned");
  await createSnClient({
    instanceUrl: INSTANCE,
    auth: {
      kind: "oauth-jwt",
      clientId: "cid",
      assertion: "pre.signed.jwt",
    },
  })
    .table("incident")
    .get("z");
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get("assertion"), "pre.signed.jwt");
});

test("oauth-jwt without a private key or assertion throws SnAuthError", async () => {
  handler = grantHandler("unused");
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: { kind: "oauth-jwt", clientId: "cid" },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnAuthError);
      assert.match(err.message, /assertion or a private key/i);
      return true;
    },
  );
});

test("oauth-jwt signs minimal claims and posts the client_secret when set", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });

  handler = grantHandler("acc-min");
  await createSnClient({
    instanceUrl: INSTANCE,
    // No keyId / subject / audience: exercise the claim/header default branches.
    auth: {
      kind: "oauth-jwt",
      clientId: "cid",
      clientSecret: "csec",
      privateKey: privatePem,
      issuer: "custom-iss",
    },
  })
    .table("incident")
    .get("z");

  const body = new URLSearchParams(calls[0].init.body);
  // clientSecret present → it rides in the token body.
  assert.equal(body.get("client_secret"), "csec");
  const assertion = body.get("assertion");
  const decode = (s) =>
    JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
  const [rawHeader, rawClaims] = assertion.split(".");
  const header = decode(rawHeader);
  const claims = decode(rawClaims);
  // No keyId supplied → no `kid` header.
  assert.equal(header.kid, undefined);
  // Explicit issuer wins; no subject claim; audience defaults to the token URL.
  assert.equal(claims.iss, "custom-iss");
  assert.equal(claims.sub, undefined);
  assert.equal(claims.aud, `${INSTANCE}/oauth_token.do`);
});

test("a token endpoint that omits access_token surfaces as SnAuthError", async () => {
  // A 2xx token response with a non-JSON body (no access_token to parse).
  handler = (url) =>
    isTokenPost(url)
      ? { status: 200, statusText: "OK", text: () => Promise.resolve("nope") }
      : fakeResponse({ body: { result: {} } });
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnAuthError);
      assert.match(err.message, /did not return an access_token/i);
      return true;
    },
  );
});

test("a token endpoint honours a string expires_in and caches accordingly", async () => {
  handler = grantHandler("acc-str", { expires_in: "3600" });
  const c = createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
  });
  await c.table("incident").get("a");
  await c.table("incident").get("b");
  // A parseable (>0) string TTL still caches: a single token POST serves both.
  assert.equal(calls.filter((x) => isTokenPost(x.url)).length, 1);
  assert.equal(calls[1].init.headers.Authorization, "Bearer acc-str");
});

test("a token endpoint error with no detail body still surfaces as SnAuthError", async () => {
  // 500 with an empty body and no statusText: the generic message path.
  handler = (url) =>
    isTokenPost(url)
      ? { status: 500, statusText: "", text: () => Promise.resolve("") }
      : fakeResponse({ body: { result: {} } });
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnAuthError);
      assert.equal(err.status, 500);
      assert.match(err.message, /OAuth token request failed \(500\)/);
      return true;
    },
  );
});

test("an OAuth token request that cannot reach the endpoint is a SnNetworkError", async () => {
  handler = (url) => {
    if (isTokenPost(url)) throw new TypeError("fetch failed");
    return fakeResponse({ body: { result: {} } });
  };
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      assert.match(err.message, /token endpoint/i);
      return true;
    },
  );
});

test("an OAuth token request timeout is a SnNetworkError mentioning the timeout", async () => {
  handler = (url) => {
    if (isTokenPost(url)) {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }
    return fakeResponse({ body: { result: {} } });
  };
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        timeoutMs: 5,
        auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      assert.match(err.message, /timed out/i);
      return true;
    },
  );
});

test("no auth configured sends neither Authorization nor x-sn-apikey", async () => {
  handler = () => fakeResponse({ body: { result: { sys_id: "z" } } });
  await createSnClient({ instanceUrl: INSTANCE }).table("incident").get("z");
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.headers["x-sn-apikey"], undefined);
});

// --- CC-1: a non-JSON 2xx body fails closed as SnResponseError --------------

test("CC-1: a 200 with a non-JSON body on a query throws SnResponseError", async () => {
  // A hibernating PDI answers 200 with an HTML wake-up page, not API JSON.
  handler = () =>
    fakeResponse({ status: 200, text: "<html>Instance is waking up…</html>" });
  await assert.rejects(
    () => client().table("incident").query({ sysparm_limit: "1" }),
    (err) => {
      assert.ok(err instanceof SnResponseError);
      assert.equal(err.status, 200);
      assert.match(err.message, /hibernat|interstitial/i);
      return true;
    },
  );
});

test("CC-1: a 200 with a non-JSON body on get() carries a body snippet", async () => {
  handler = () =>
    fakeResponse({
      status: 200,
      text: "Please wait while the instance wakes.",
    });
  await assert.rejects(
    () => client().table("incident").get("abc"),
    (err) => {
      assert.ok(err instanceof SnResponseError);
      assert.equal(err.status, 200);
      assert.match(err.bodySnippet, /Please wait/);
      return true;
    },
  );
});

test("CC-1: a non-JSON body on a non-2xx status stays an SnHttpError", async () => {
  // Only a *successful* status is the dangerous case; a 502 HTML page must
  // still surface as the ordinary HTTP error, not SnResponseError.
  handler = () =>
    fakeResponse({ status: 502, text: "<html>Bad Gateway</html>" });
  await assert.rejects(
    () => client().table("incident").get("abc"),
    (err) => {
      assert.ok(err instanceof SnHttpError);
      assert.ok(!(err instanceof SnResponseError));
      assert.equal(err.status, 502);
      return true;
    },
  );
});

// --- CC-7: a body read that rejects mid-stream is a network error -----------

test("CC-7: a response body read that rejects surfaces as SnNetworkError", async () => {
  handler = () => ({
    status: 200,
    statusText: "OK",
    headers: undefined,
    text: () => Promise.reject(new Error("ECONNRESET")),
  });
  await assert.rejects(
    () => client().request("GET", "/api/now/table/incident"),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      return true;
    },
  );
});

test("CC-7: a token-endpoint body read that rejects surfaces as SnNetworkError", async () => {
  handler = (url) =>
    isTokenPost(url)
      ? {
          status: 200,
          statusText: "OK",
          headers: undefined,
          text: () => Promise.reject(new Error("ECONNRESET")),
        }
      : fakeResponse({ body: { result: {} } });
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      assert.match(err.message, /token endpoint/i);
      return true;
    },
  );
});

// --- CC-11: an instanceUrl with a path prefix is rejected -------------------

test("CC-11: an instanceUrl carrying a path prefix is rejected at construction", () => {
  assert.throws(
    () =>
      createSnClient({
        instanceUrl: "https://proxy.example.com/servicenow",
        auth: AUTH,
      }),
    (err) => {
      assert.ok(err instanceof SnError);
      assert.match(err.message, /path/i);
      assert.match(err.message, /servicenow/);
      return true;
    },
  );
});

// --- CC-12: RFC 6749 OAuth error bodies are surfaced ------------------------

test("CC-12: an RFC 6749 error body (error + error_description) is surfaced", async () => {
  handler = (url) =>
    isTokenPost(url)
      ? fakeResponse({
          status: 400,
          body: {
            error: "invalid_grant",
            error_description: "user credentials are invalid",
          },
        })
      : fakeResponse({ body: { result: {} } });
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: {
          kind: "oauth-password",
          clientId: "cid",
          clientSecret: "csec",
          user: "u",
          pass: "p",
        },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnAuthError);
      assert.match(err.message, /invalid_grant: user credentials are invalid/);
      return true;
    },
  );
});

test("CC-12: an RFC 6749 error body with only the code surfaces that code", async () => {
  handler = (url) =>
    isTokenPost(url)
      ? fakeResponse({ status: 401, body: { error: "invalid_client" } })
      : fakeResponse({ body: { result: {} } });
  await assert.rejects(
    () =>
      createSnClient({
        instanceUrl: INSTANCE,
        auth: { kind: "oauth-client", clientId: "cid", clientSecret: "bad" },
      })
        .table("incident")
        .get("z"),
    (err) => {
      assert.ok(err instanceof SnAuthError);
      assert.match(err.message, /invalid_client/);
      return true;
    },
  );
});

// --- CC-13: transient poll failures are tolerated ---------------------------

/** A kickoff handler that hands back a progress link, then defers to `onPoll`. */
function runningKickoff(onPoll) {
  return (url, init) => {
    if (init.method === "POST") {
      return fakeResponse({
        body: {
          result: {
            status: 1,
            links: { progress: { id: "p1", url: "/api/sn_cicd/progress/p1" } },
          },
        },
      });
    }
    return onPoll(url, init);
  };
}

/** A settled-success progress payload, with the results link resolved. */
function settledOk() {
  return fakeResponse({
    body: { result: { status: 2, links: { results: { id: "r" } } } },
  });
}

test("CC-13: a transient 5xx on a progress poll is tolerated", async () => {
  let polls = 0;
  handler = runningKickoff(() => {
    polls += 1;
    return polls === 1
      ? fakeResponse({ status: 500, body: { error: { message: "blip" } } })
      : settledOk();
  });
  const out = await client().cicd.runTestSuite("suite-1");
  assert.equal(out.status, "success");
  assert.equal(polls, 2);
});

test("CC-13: an early 404 on a progress poll (record lag) is tolerated", async () => {
  let polls = 0;
  handler = runningKickoff(() => {
    polls += 1;
    return polls === 1
      ? fakeResponse({ status: 404, body: { error: { message: "not yet" } } })
      : settledOk();
  });
  const out = await client().cicd.runTestSuite("suite-1");
  assert.equal(out.status, "success");
  assert.equal(polls, 2);
});

test("CC-13: persistent poll failures beyond the tolerance give up with the error", async () => {
  handler = runningKickoff(() =>
    fakeResponse({ status: 503, body: { error: { message: "down" } } }),
  );
  await assert.rejects(
    () => client().cicd.runTestSuite("suite-1"),
    (err) => {
      assert.ok(err instanceof SnHttpError);
      assert.equal(err.status, 503);
      return true;
    },
  );
});

// --- a server-supplied progress URL cannot redirect the credential ----------

test("a cross-origin progress link is refused, not followed with the token", async () => {
  // The kickoff payload is server-supplied: a compromised or hostile instance
  // naming another host would otherwise get the Authorization header delivered
  // to it verbatim.
  handler = (url, init) => {
    if (init.method === "POST") {
      return fakeResponse({
        body: {
          result: {
            status: 1,
            links: {
              progress: {
                id: "p1",
                url: "https://attacker.example.com/api/sn_cicd/progress/p1",
              },
            },
          },
        },
      });
    }
    return settledOk();
  };
  await assert.rejects(
    () => client().cicd.runTestSuite("suite-1"),
    (err) => {
      assert.ok(err instanceof SnError);
      assert.match(err.message, /attacker\.example\.com/);
      assert.match(err.message, /not the configured instance origin/);
      return true;
    },
  );
  // The POST kickoff is the only request that ever left: no poll was issued.
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((c) => String(c.url).includes("attacker.example.com")));
});

// --- CC-31: never follow redirects on an API call ---------------------------

test("CC-31: the client sets redirect: 'error' on every request", async () => {
  handler = () => fakeResponse({ body: { result: { sys_id: "z" } } });
  await client().table("incident").get("z");
  assert.equal(calls[0].init.redirect, "error");
});

// --- CC-32: the default CI/CD poll budget is 450 ----------------------------

test("CC-32: the default CI/CD poll budget is 450 (≈15 min at 2s)", async () => {
  // Always still running: the run never settles, so the whole budget is spent.
  handler = runningKickoff(() =>
    fakeResponse({
      body: {
        result: {
          status: 1,
          links: { progress: { id: "p1", url: "/api/sn_cicd/progress/p1" } },
        },
      },
    }),
  );
  const out = await client().cicd.runTestSuite("suite-1");
  assert.equal(out.status, "running");
  // 1 POST kickoff + 450 progress polls at the default budget.
  assert.equal(calls.length, 451);
});

// --- CC-34: coalesce concurrent token acquisition; token-aware invalidate ---

test("CC-34: concurrent first requests share a single token acquisition", async () => {
  handler = grantHandler("acc-concurrent", { expires_in: 1800 });
  const c = createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
  });
  // Fire three requests in the same tick, before any token is cached.
  await Promise.all([
    c.table("incident").get("a"),
    c.table("incident").get("b"),
    c.table("incident").get("c"),
  ]);
  // Exactly one token POST served all three (coalesced in-flight acquisition).
  assert.equal(calls.filter((x) => isTokenPost(x.url)).length, 1);
});

test("CC-34: a concurrent stale-token 401 re-acquires once, not once per caller", async () => {
  let tokenPosts = 0;
  let apiHits = 0;
  handler = (url) => {
    if (isTokenPost(url)) {
      tokenPosts += 1;
      return fakeResponse({ body: { access_token: `tok-${tokenPosts}` } });
    }
    apiHits += 1;
    // The two initial REST hits carry the shared (stale) token → 401; the
    // retries, after a single coalesced re-acquire, succeed.
    return apiHits <= 2
      ? fakeResponse({ status: 401, body: { error: { message: "expired" } } })
      : fakeResponse({ body: { result: { sys_id: "z" } } });
  };
  const c = createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "oauth-client", clientId: "cid", clientSecret: "csec" },
  });
  const [a, b] = await Promise.all([
    c.table("incident").get("a"),
    c.table("incident").get("b"),
  ]);
  assert.deepEqual(a, { sys_id: "z" });
  assert.deepEqual(b, { sys_id: "z" });
  // One initial acquisition + one coalesced re-acquisition = 2 token POSTs
  // (a token-aware invalidate keeps the second 401 from evicting the fresh
  // token and stampeding a third acquire).
  assert.equal(tokenPosts, 2);
});

// --- SN-1: surface X-Total-Count / security-trimming via queryWithMeta ------

test("SN-1: queryWithMeta surfaces X-Total-Count and flags security-trimming", async () => {
  handler = () =>
    fakeResponse({
      body: { result: [{ sys_id: "1" }, { sys_id: "2" }] },
      headers: { "X-Total-Count": "50" },
    });
  const res = await client()
    .table("sys_security_acl")
    .queryWithMeta({ sysparm_limit: "10" });
  assert.equal(res.rows.length, 2);
  assert.equal(res.totalCount, 50);
  assert.equal(res.securityTrimmed, true);
});

test("SN-1: queryWithMeta reports securityTrimmed false when the count matches", async () => {
  handler = () =>
    fakeResponse({
      body: { result: [{ sys_id: "1" }, { sys_id: "2" }] },
      headers: { "x-total-count": "2" },
    });
  const res = await client()
    .table("incident")
    .queryWithMeta({ sysparm_limit: "10" });
  assert.equal(res.totalCount, 2);
  assert.equal(res.securityTrimmed, false);
});

test("SN-1: queryWithMeta leaves totalCount undefined when the header is absent", async () => {
  handler = () => fakeResponse({ body: { result: [{ sys_id: "1" }] } });
  const res = await client()
    .table("incident")
    .queryWithMeta({ sysparm_limit: "10" });
  assert.equal(res.totalCount, undefined);
  assert.equal(res.securityTrimmed, false);
});

test("SN-1: a malformed X-Total-Count is ignored (totalCount undefined)", async () => {
  handler = () =>
    fakeResponse({
      body: { result: [{ sys_id: "1" }] },
      headers: { "x-total-count": "not-a-number" },
    });
  const res = await client()
    .table("incident")
    .queryWithMeta({ sysparm_limit: "10" });
  assert.equal(res.totalCount, undefined);
});

test("SN-1: auto-pagination captures X-Total-Count from the first page", async () => {
  handler = (url) => {
    const offset = Number(new URL(url).searchParams.get("sysparm_offset"));
    const rows =
      offset === 0
        ? Array.from({ length: 1000 }, (_, i) => ({ sys_id: `r${i}` }))
        : [{ sys_id: "last" }];
    // Only the first page carries the (pre-trim) count header.
    const headers = offset === 0 ? { "x-total-count": "9999" } : undefined;
    return fakeResponse({ body: { result: rows }, headers });
  };
  const res = await client().table("sys_user_role").queryWithMeta();
  assert.equal(res.rows.length, 1001);
  assert.equal(res.totalCount, 9999);
  assert.equal(res.securityTrimmed, true);
});

test("SN-1: query() still resolves to a bare array (unchanged surface)", async () => {
  handler = () =>
    fakeResponse({
      body: { result: [{ sys_id: "1" }] },
      headers: { "x-total-count": "9" },
    });
  const rows = await client().table("incident").query({ sysparm_limit: "5" });
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 1);
});

test("SN-1: the fake's totalCounts drives queryWithMeta's securityTrimmed", async () => {
  const http = createFakeSnClient({
    tables: { sys_security_acl: [{ sys_id: "a" }] },
    totalCounts: { sys_security_acl: 7 },
  });
  const res = await http.table("sys_security_acl").queryWithMeta();
  assert.equal(res.rows.length, 1);
  assert.equal(res.totalCount, 7);
  assert.equal(res.securityTrimmed, true);
});

test("SN-1/CC-1: the fake can force an SnResponseError (hibernating interstitial)", async () => {
  const http = createFakeSnClient({
    tables: { incident: [] },
    fail: { response: true },
  });
  // The fake throws synchronously; wrap so assert.rejects validates it.
  await assert.rejects(
    async () => http.table("incident").query(),
    (err) => {
      assert.ok(err instanceof SnResponseError);
      return true;
    },
  );
});

// --- SN-6: a capped Retry-After retry on 429 --------------------------------

test("SN-6: a 429 with Retry-After is retried and then succeeds", async () => {
  let hits = 0;
  handler = () => {
    hits += 1;
    return hits === 1
      ? fakeResponse({
          status: 429,
          headers: { "retry-after": "0" },
          body: { error: { message: "slow down" } },
        })
      : fakeResponse({ body: { result: { sys_id: "z" } } });
  };
  const rec = await client().table("incident").get("z");
  assert.deepEqual(rec, { sys_id: "z" });
  assert.equal(hits, 2);
});

test("SN-6: a persistent 429 gives up as SnHttpError after the retry budget", async () => {
  let hits = 0;
  handler = () => {
    hits += 1;
    return fakeResponse({
      status: 429,
      headers: { "retry-after": "0" },
      body: { error: { message: "throttled" } },
    });
  };
  await assert.rejects(
    () => client().table("incident").get("z"),
    (err) => {
      assert.ok(err instanceof SnHttpError);
      assert.equal(err.status, 429);
      assert.match(err.message, /Retry-After retries/);
      return true;
    },
  );
  // Initial attempt + 3 bounded retries = 4 transport hits.
  assert.equal(hits, 4);
});

test("SN-6: a 429 Retry-After given as an HTTP-date is honoured", async () => {
  let hits = 0;
  handler = () => {
    hits += 1;
    return hits === 1
      ? fakeResponse({
          status: 429,
          // A date in the past → an immediate (0ms-clamped) retry.
          headers: { "retry-after": new Date(Date.now() - 1000).toUTCString() },
          body: { error: {} },
        })
      : fakeResponse({ body: { result: { sys_id: "z" } } });
  };
  const rec = await client().table("incident").get("z");
  assert.deepEqual(rec, { sys_id: "z" });
  assert.equal(hits, 2);
});
