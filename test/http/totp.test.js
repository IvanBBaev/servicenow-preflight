import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decodeBase32,
  hotp,
  totp,
  totpOptionsProblem,
  totpWindow,
} from "../../build/http/totp.js";

// RFC 6238 Appendix B seeds: ASCII "1234567890" repeated to the HMAC size.
const SHA1_KEY = Buffer.from("12345678901234567890");
const SHA256_KEY = Buffer.from("12345678901234567890123456789012");
const SHA512_KEY = Buffer.from(
  "1234567890123456789012345678901234567890123456789012345678901234",
);

const VECTORS = [
  // [unix seconds, SHA-1, SHA-256, SHA-512]
  [59, "94287082", "46119246", "90693936"],
  [1111111109, "07081804", "68084774", "25091201"],
  [1111111111, "14050471", "67062674", "99943326"],
  [1234567890, "89005924", "91819424", "93441116"],
  [2000000000, "69279037", "90698825", "38618901"],
  [20000000000, "65353130", "77737706", "47863826"],
];

test("totp: RFC 6238 Appendix B vectors (8 digits, SHA-1/256/512)", () => {
  for (const [seconds, sha1, sha256, sha512] of VECTORS) {
    const ms = seconds * 1000;
    assert.equal(totp(SHA1_KEY, ms, { digits: 8 }), sha1, `sha1 @${seconds}`);
    assert.equal(
      totp(SHA256_KEY, ms, { digits: 8, algorithm: "sha256" }),
      sha256,
      `sha256 @${seconds}`,
    );
    assert.equal(
      totp(SHA512_KEY, ms, { digits: 8, algorithm: "sha512" }),
      sha512,
      `sha512 @${seconds}`,
    );
  }
});

test("totp: the 6-digit default is the low six digits of the 8-digit code", () => {
  for (const [seconds, sha1] of VECTORS) {
    assert.equal(totp(SHA1_KEY, seconds * 1000), sha1.slice(2));
  }
});

test("totp: the window follows the period", () => {
  assert.equal(totpWindow(59_000), 1);
  assert.equal(totpWindow(60_000), 2);
  assert.equal(totpWindow(59_000, 60), 0);
  // A 60 s period uses counter floor(t / 60).
  assert.equal(totp(SHA1_KEY, 119_000, { period: 60 }), hotp(SHA1_KEY, 1));
});

test("decodeBase32: decodes the RFC seed, ignoring case, spaces and padding", () => {
  const seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.deepEqual(decodeBase32(seed), SHA1_KEY);
  assert.deepEqual(
    decodeBase32("gezd gnbv gy3t qojq gezd gnbv gy3t qojq"),
    SHA1_KEY,
  );
  assert.deepEqual(decodeBase32("MZXW6==="), Buffer.from("foo"));
});

test("decodeBase32: rejects bad input without echoing it", () => {
  assert.throws(() => decodeBase32("  "), /empty/);
  assert.throws(
    () => decodeBase32("NOT-BASE32-018!"),
    (err) =>
      /not valid base32/.test(err.message) && !err.message.includes("018"),
  );
});

test("totpOptionsProblem: digits 6..8 and period 1..300 only", () => {
  assert.equal(totpOptionsProblem({}), undefined);
  assert.equal(totpOptionsProblem({ digits: 8, period: 60 }), undefined);
  assert.match(totpOptionsProblem({ digits: 5 }), /digits/);
  assert.match(totpOptionsProblem({ digits: 6.5 }), /digits/);
  assert.match(totpOptionsProblem({ period: 0 }), /period/);
  assert.match(totpOptionsProblem({ period: 301 }), /period/);
});
