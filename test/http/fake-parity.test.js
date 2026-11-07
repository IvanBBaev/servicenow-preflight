import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  CLOCK,
  createSnClient,
  SnAuthError,
  SnHttpError,
  SnNetworkError,
} from "../../build/http/client.js";
import { createFakeSnClient } from "../../build/http/fake.js";
import { errorResult } from "../../build/checks/cert-common.js";

// QA-1: fake-vs-real parity for failures. Every check test that forces a
// failure through the fake must see the error class (and status) a real
// instance would produce through `SnClient`, or it pins a verdict no user ever
// sees. Each case runs the same failure through the real client (stubbed
// fetch) and through the fake, and asserts they agree on the error class, the
// status, the auth diagnosis and the check verdict from `errorResult`.

const INSTANCE = "https://dev12345.service-now.com";
const TABLE = "incident";

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
let handler;

beforeEach(() => {
  handler = null;
  globalThis.fetch = (url, init) => {
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

function response(status, message = "denied") {
  const payload = JSON.stringify({ error: { message } });
  return {
    status,
    statusText: "",
    headers: status === 429 ? { "retry-after": "0" } : undefined,
    text: () => Promise.resolve(payload),
  };
}

/** A real client whose Retry-After waits resolve at once (virtual clock). */
function realClient() {
  let now = Date.parse("2026-01-01T00:00:00Z");
  return createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "basic", user: "admin", pass: "secret" },
    [CLOCK]: {
      now: () => now,
      sleep(ms) {
        now += ms;
        return Promise.resolve();
      },
    },
  });
}

async function caught(read) {
  try {
    await read();
  } catch (err) {
    return err;
  }
  assert.fail("expected the read to reject");
}

const CASES = [
  { label: "401", real: () => response(401), fake: { http: 401 } },
  { label: "401 (auth)", real: () => response(401), fake: { auth: true } },
  { label: "403", real: () => response(403), fake: { http: 403 } },
  {
    label: "403 (forbidden)",
    real: () => response(403),
    fake: { forbidden: true },
  },
  { label: "404", real: () => response(404), fake: { http: 404 } },
  {
    label: "429 (retry budget exhausted)",
    real: () => response(429, "throttled"),
    fake: { http: 429 },
  },
  { label: "500", real: () => response(500, "boom"), fake: { http: 500 } },
  {
    label: "network error",
    real: () => {
      throw new TypeError("fetch failed");
    },
    fake: { network: true },
  },
];

for (const { label, real, fake } of CASES) {
  test(`parity: a ${label} failure raises the same error from the fake and the real client`, async () => {
    handler = real;
    const realErr = await caught(() => realClient().table(TABLE).query());
    const fakeErr = await caught(() =>
      createFakeSnClient({ fail: { table: { [TABLE]: fake } } })
        .table(TABLE)
        .query(),
    );

    assert.equal(fakeErr.constructor, realErr.constructor);
    assert.ok(
      [SnAuthError, SnHttpError, SnNetworkError].includes(realErr.constructor),
    );
    assert.equal(fakeErr.status, realErr.status);
    if (realErr instanceof SnAuthError) {
      assert.deepEqual(fakeErr.diagnosis, realErr.diagnosis);
    }
    assert.equal(
      errorResult("c", TABLE, fakeErr).status,
      errorResult("c", TABLE, realErr).status,
    );
  });
}

test("parity: 401/403 are auth failures, other statuses HTTP errors — all error rows", async () => {
  const verdict = async (fake) =>
    errorResult(
      "c",
      TABLE,
      await caught(() =>
        createFakeSnClient({ fail: { table: { [TABLE]: fake } } })
          .table(TABLE)
          .query(),
      ),
    ).status;
  assert.equal(await verdict({ http: 401 }), "error");
  assert.equal(await verdict({ http: 403 }), "error");
  assert.equal(await verdict({ forbidden: true }), "error");
  assert.equal(await verdict({ http: 404 }), "error");
  assert.equal(await verdict({ http: 500 }), "error");
});

test("parity: a 403 diagnosis names the table, on every fake entry point", async () => {
  const hint =
    "The account authenticates but lacks read access to incident (ACL or role).";
  const http = createFakeSnClient({ fail: { http: 403 } });
  for (const read of [
    () => http.table(TABLE).query(),
    () => http.table(TABLE).queryWithMeta(),
    () => http.table(TABLE).get("x"),
    () => http.request("GET", `/api/now/table/${TABLE}`),
  ]) {
    const err = await caught(read);
    assert.ok(err instanceof SnAuthError);
    assert.equal(err.status, 403);
    assert.deepEqual(err.diagnosis, [hint]);
  }
});
