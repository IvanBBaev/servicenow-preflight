import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  createSnClient,
  SnAuthError,
  SnError,
} from "../../build/http/client.js";
import { decodeBase32, totp } from "../../build/http/totp.js";

const INSTANCE = "https://dev12345.service-now.com";
const SEED = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const KEY = decodeBase32(SEED);

for (const name of [
  "SNPF_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
]) {
  delete process.env[name];
}

const realFetch = globalThis.fetch;
let handler;
let calls;

function response(status, body, headers = {}) {
  const text = body === undefined ? "" : JSON.stringify(body);
  return { status, statusText: "", headers, text: () => Promise.resolve(text) };
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (url, init) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(handler(calls.length));
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The password the Authorization header of call `i` carried. */
function sentPassword(i) {
  const value = calls[i].init.headers.Authorization;
  assert.match(value, /^Basic /);
  const decoded = Buffer.from(value.slice(6), "base64").toString("utf8");
  assert.ok(decoded.startsWith("admin:"));
  return decoded.slice("admin:".length);
}

function client(mfa) {
  return createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "basic", user: "admin", pass: "secret", mfa },
  });
}

test("mfa: the password carries the current window's TOTP code", async () => {
  let now = 59_000;
  handler = () => response(200, { result: [] });
  const sn = client({ totpSecret: SEED, now: () => now });
  await sn.table("sys_user").query({});
  assert.equal(sentPassword(0), `secret${totp(KEY, 59_000)}`);
  assert.equal(sentPassword(0), "secret287082");
  now = 61_000;
  await sn.table("sys_user").query({});
  assert.equal(sentPassword(1), `secret${totp(KEY, 61_000)}`);
  assert.notEqual(sentPassword(0), sentPassword(1));
});

test("mfa: digits and period are honoured", async () => {
  handler = () => response(200, { result: [] });
  await client({ totpSecret: SEED, digits: 8, period: 60, now: () => 59_000 })
    .table("sys_user")
    .query({});
  assert.equal(
    sentPassword(0),
    `secret${totp(KEY, 59_000, { digits: 8, period: 60 })}`,
  );
});

test("mfa: a code rejected at a window boundary is retried once with the next window", async () => {
  handler = (n) =>
    n === 1
      ? response(401, { error: { message: "User Not Authenticated" } })
      : response(200, { result: [] });
  const rows = await client({ totpSecret: SEED, now: () => 59_900 })
    .table("sys_user")
    .query({});
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 2);
  assert.equal(sentPassword(0), `secret${totp(KEY, 59_900)}`);
  // The clock is still in window 1, so the retry uses window 2's code.
  assert.equal(sentPassword(1), `secret${totp(KEY, 60_000)}`);
});

test("mfa: a second 401 is terminal and never leaks the seed or a code", async () => {
  handler = () =>
    response(401, { error: { message: "User Not Authenticated" } });
  const err = await client({ totpSecret: SEED, now: () => 59_000 })
    .table("sys_user")
    .query({})
    .catch((e) => e);
  assert.ok(err instanceof SnAuthError);
  assert.equal(calls.length, 2);
  assert.match(err.diagnosis[0], /MFA one-time password was rejected/);
  const text = `${err.message}\n${err.diagnosis.join("\n")}\n${err.stack}`;
  for (const secret of [SEED, totp(KEY, 59_000), totp(KEY, 60_000), "secret"]) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
});

test("mfa: a fixed code is sent as-is and a 401 is not retried", async () => {
  handler = () =>
    response(401, { error: { message: "User Not Authenticated" } });
  await assert.rejects(
    client({ code: "123456" }).table("sys_user").query({}),
    SnAuthError,
  );
  assert.equal(calls.length, 1);
  assert.equal(sentPassword(0), "secret123456");
});

test("mfa: a Retry-After wait takes a fresh code", async () => {
  let now = 59_000;
  handler = (n) => {
    if (n === 1) {
      now = 61_000;
      return response(
        429,
        { error: { message: "slow down" } },
        { "retry-after": "0" },
      );
    }
    return response(200, { result: [] });
  };
  await client({ totpSecret: SEED, now: () => now })
    .table("sys_user")
    .query({});
  assert.equal(calls.length, 2);
  assert.equal(sentPassword(1), `secret${totp(KEY, 61_000)}`);
});

test("mfa: an MFA challenge without a seed names SNPF_MFA_TOTP_SECRET", async () => {
  handler = () =>
    response(401, {
      error: { message: "Multi-factor authentication required" },
    });
  const err = await createSnClient({
    instanceUrl: INSTANCE,
    auth: { kind: "basic", user: "admin", pass: "secret" },
  })
    .table("sys_user")
    .query({})
    .catch((e) => e);
  assert.ok(err instanceof SnAuthError);
  assert.match(err.diagnosis[0], /SNPF_MFA_TOTP_SECRET/);
});

test("mfa: invalid settings fail at construction without echoing them", () => {
  assert.throws(
    () => client({ totpSecret: "not base32 !1" }),
    (err) =>
      err instanceof SnError &&
      /base32/.test(err.message) &&
      !err.message.includes("!1"),
  );
  assert.throws(
    () => client({ code: "12ab" }),
    (err) => err instanceof SnError && !err.message.includes("12ab"),
  );
  assert.throws(() => client({}), SnError);
  assert.throws(() => client({ totpSecret: SEED, digits: 4 }), /digits/);
});
