// RR-4 (DX-1): a partial credential set is a config error (exit 2) naming the
// missing variable, and under CI a target with no credentials at all is exit 2
// instead of an all-warn green run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAuthFromEnv, resolveTlsFromEnv } from "../build/config.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

/** Assert `fn` throws a UsageError whose message matches `pattern`. */
function throwsUsage(fn, pattern) {
  assert.throws(
    fn,
    (err) => err.name === "UsageError" && pattern.test(err.message),
  );
}

const partialSets = [
  [
    "basic: user without pass",
    { SNPF_USER: "a" },
    /SNPF_USER is set but SNPF_PASS is not\./,
  ],
  [
    "basic: pass without user",
    { SNPF_PASS: "p" },
    /SNPF_PASS is set but SNPF_USER is not\./,
  ],
  [
    "OAuth: client id without secret",
    { SNPF_OAUTH_CLIENT_ID: "id" },
    /SNPF_OAUTH_CLIENT_ID is set but SNPF_OAUTH_CLIENT_SECRET is not\./,
  ],
  [
    "OAuth: client secret without id",
    { SNPF_OAUTH_CLIENT_SECRET: "s" },
    /SNPF_OAUTH_CLIENT_SECRET is set but SNPF_OAUTH_CLIENT_ID is not\./,
  ],
  [
    "OAuth: refresh token without client",
    { SNPF_OAUTH_REFRESH_TOKEN: "r" },
    /SNPF_OAUTH_REFRESH_TOKEN is set but SNPF_OAUTH_CLIENT_ID and SNPF_OAUTH_CLIENT_SECRET are not\./,
  ],
  [
    "OAuth: JWT key without client",
    { SNPF_OAUTH_JWT_KEY: "k" },
    /SNPF_OAUTH_JWT_KEY is set but SNPF_OAUTH_CLIENT_ID and SNPF_OAUTH_CLIENT_SECRET are not\./,
  ],
  [
    "token: selector without SNPF_TOKEN",
    { SNPF_AUTH: "token" },
    /SNPF_AUTH is "token" but SNPF_TOKEN is not set\./,
  ],
  [
    "basic: selector with half the inputs",
    { SNPF_AUTH: "basic", SNPF_USER: "a" },
    /SNPF_AUTH is "basic" but SNPF_PASS is not set\./,
  ],
  [
    "apikey: selector without SNPF_API_KEY",
    { SNPF_AUTH: "apikey" },
    /SNPF_AUTH is "apikey" but SNPF_API_KEY is not set\./,
  ],
  [
    "oauth-password: selector missing the user pair",
    {
      SNPF_AUTH: "oauth-password",
      SNPF_OAUTH_CLIENT_ID: "i",
      SNPF_OAUTH_CLIENT_SECRET: "s",
    },
    /but SNPF_USER and SNPF_PASS are not set\./,
  ],
  [
    "oauth-jwt: selector without key or assertion",
    { SNPF_AUTH: "oauth-jwt", SNPF_OAUTH_CLIENT_ID: "i" },
    /but SNPF_OAUTH_JWT_KEY or SNPF_OAUTH_JWT_ASSERTION is not set\./,
  ],
  [
    "oauth-refresh: selector without refresh token",
    {
      SNPF_AUTH: "oauth-refresh",
      SNPF_OAUTH_CLIENT_ID: "i",
      SNPF_OAUTH_CLIENT_SECRET: "s",
    },
    /but SNPF_OAUTH_REFRESH_TOKEN is not set\./,
  ],
];

for (const [label, env, pattern] of partialSets) {
  test(`resolveAuthFromEnv: partial set is a UsageError (${label})`, () => {
    throwsUsage(() => resolveAuthFromEnv(env), pattern);
  });
}

test("resolveAuthFromEnv: a blank partner counts as missing (empty CI secret)", () => {
  throwsUsage(
    () => resolveAuthFromEnv({ SNPF_USER: "a", SNPF_PASS: "" }),
    /SNPF_PASS is not/,
  );
});

test("resolveAuthFromEnv: messages name variables, never values", () => {
  try {
    resolveAuthFromEnv({ SNPF_USER: "alice-secret-name" });
    assert.fail("expected a UsageError");
  } catch (err) {
    assert.doesNotMatch(err.message, /alice-secret-name/);
  }
});

test("resolveAuthFromEnv: a partial set under an instance prefix names both forms", () => {
  throwsUsage(
    () => resolveAuthFromEnv({ SNPF_DEV_USER: "a" }, "dev"),
    /SNPF_DEV_USER \(or SNPF_USER\) is set but SNPF_DEV_PASS \(or SNPF_PASS\) is not\./,
  );
});

test("resolveAuthFromEnv: nothing set at all is still no auth, not an error", () => {
  assert.equal(resolveAuthFromEnv({}), undefined);
  assert.equal(
    resolveAuthFromEnv({ SNPF_USER: "", SNPF_TOKEN: "  " }),
    undefined,
  );
});

test("resolveAuthFromEnv: a complete method wins over a stray half of another", () => {
  assert.deepEqual(resolveAuthFromEnv({ SNPF_TOKEN: "t", SNPF_USER: "a" }), {
    kind: "oauth",
    token: "t",
  });
});

test("resolveAuthFromEnv: an unknown SNPF_AUTH kind is left to its own handling", () => {
  assert.equal(resolveAuthFromEnv({ SNPF_AUTH: "nope" }), undefined);
});

test("resolveTlsFromEnv: a cert without its key (and the reverse) is a UsageError", () => {
  throwsUsage(
    () => resolveTlsFromEnv({ SNPF_MTLS_CERT: "certpem" }),
    /SNPF_MTLS_CERT is set but SNPF_MTLS_KEY is not\./,
  );
  throwsUsage(
    () => resolveTlsFromEnv({ SNPF_MTLS_KEY: "keypem" }),
    /SNPF_MTLS_KEY is set but SNPF_MTLS_CERT is not\./,
  );
});

// ---------- CLI ----------

/** Run the CLI in an empty dir with no ambient SNPF_* or CI variables. */
function runCli(args, env = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("SNPF_") || key === "CI") delete clean[key];
  }
  const cwd = mkdtempSync(join(tmpdir(), "snpf-cred-"));
  try {
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...clean, ...env },
      encoding: "utf8",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// Port 1 refuses at once: the run never gets credentials checked by a server.
const URL_ = "http://127.0.0.1:1";
const ONLY = ["--only", "connectivity-auth"];

test("CLI: CI=true with no credentials exits 2 and names the variables", () => {
  const res = runCli(["run", "-i", URL_, ...ONLY], { CI: "true" });
  assert.equal(res.status, 2, res.stderr);
  assert.match(
    res.stderr,
    /No credentials resolved for http:\/\/127\.0\.0\.1:1 and CI is set/,
  );
  assert.match(res.stderr, /SNPF_USER and SNPF_PASS/);
  assert.match(res.stderr, /SNPF_TOKEN/);
  assert.match(res.stderr, /--allow-no-auth/);
  assert.equal(res.stdout, "");
});

test("CLI: CI=false or CI=0 counts as not CI", () => {
  for (const CI of ["false", "0", ""]) {
    const res = runCli(["run", "-i", URL_, ...ONLY], { CI });
    assert.notEqual(res.status, 2, `CI=${CI}: ${res.stderr}`);
  }
});

test("CLI: --allow-no-auth lets a CI run proceed without credentials", () => {
  const res = runCli(["run", "-i", URL_, ...ONLY, "--allow-no-auth"], {
    CI: "true",
  });
  assert.notEqual(res.status, 2, res.stderr);
  assert.doesNotMatch(res.stderr, /No credentials resolved/);
});

test("CLI: locally (no CI) a run with no credentials still proceeds", () => {
  const res = runCli(["run", "-i", URL_, ...ONLY]);
  assert.notEqual(res.status, 2, res.stderr);
  assert.doesNotMatch(res.stderr, /No credentials resolved/);
});

test("CLI: a replay needs no credentials even under CI", () => {
  const replay = fileURLToPath(
    new URL("./fixtures/replay-sample", import.meta.url),
  );
  const res = runCli(["run", "--replay", replay, ...ONLY], { CI: "true" });
  assert.notEqual(res.status, 2, res.stderr);
});

test("CLI: a partial credential set exits 2 and names the missing half", () => {
  const res = runCli(["run", "-i", URL_, ...ONLY], { SNPF_USER: "a" });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /SNPF_USER is set but SNPF_PASS is not\./);
});

test("CLI: a partial mTLS set exits 2", () => {
  const res = runCli(["run", "-i", URL_, ...ONLY], { SNPF_MTLS_CERT: "pem" });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /SNPF_MTLS_CERT is set but SNPF_MTLS_KEY is not\./);
});

test("CLI: --help documents --allow-no-auth", () => {
  const res = runCli(["--help"]);
  assert.match(res.stdout, /--allow-no-auth/);
});
