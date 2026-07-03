import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";

import {
  createSnClient,
  SnAuthError,
  SnNetworkError,
  SnHttpError,
} from "../../build/http/client.js";

const INSTANCE = "https://dev12345.service-now.com";
const AUTH = { kind: "basic", user: "admin", pass: "secret" };

const realFetch = globalThis.fetch;

/** Set per test: (url, init) => fake Response, or throw to simulate a fetch reject. */
let handler;
/** Every (url, init) pair the client passed to fetch, in order. */
let calls;

/** Build a minimal Response-like object the client consumes (status + text()). */
function fakeResponse({ status = 200, body = undefined, statusText = "" }) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { status, statusText, text: () => Promise.resolve(text) };
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
