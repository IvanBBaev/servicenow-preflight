import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

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
