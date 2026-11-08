// RR-5 (DEV-6 = DX-2): an unknown SNPF_AUTH is a config error (exit 2) listing
// the valid values; the selector is case-insensitive and `bearer` / `oauth`
// are aliases of `token`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAuthFromEnv } from "../build/config.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

const VALID = [
  "basic",
  "token",
  "apikey",
  "oauth-password",
  "oauth-client",
  "oauth-refresh",
  "oauth-jwt",
];

/** Assert `fn` throws a UsageError whose message matches every pattern. */
function throwsUsage(fn, ...patterns) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, "UsageError");
    for (const p of patterns) assert.match(err.message, p);
    return true;
  });
}

test("SNPF_AUTH=bearer is an alias of token", () => {
  assert.deepEqual(
    resolveAuthFromEnv({ SNPF_AUTH: "bearer", SNPF_TOKEN: "tok" }),
    { kind: "oauth", token: "tok" },
  );
});

test("SNPF_AUTH=oauth stays an alias of token", () => {
  assert.deepEqual(
    resolveAuthFromEnv({ SNPF_AUTH: "oauth", SNPF_TOKEN: "tok" }),
    { kind: "oauth", token: "tok" },
  );
});

test("SNPF_AUTH is trimmed and case-insensitive", () => {
  assert.deepEqual(
    resolveAuthFromEnv({ SNPF_AUTH: "  Bearer ", SNPF_TOKEN: "tok" }),
    { kind: "oauth", token: "tok" },
  );
  assert.deepEqual(
    resolveAuthFromEnv({ SNPF_AUTH: "APIKEY", SNPF_API_KEY: "k" }),
    { kind: "apikey", apiKey: "k" },
  );
});

test("a blank SNPF_AUTH means auto-detect", () => {
  assert.deepEqual(resolveAuthFromEnv({ SNPF_AUTH: "  ", SNPF_TOKEN: "t" }), {
    kind: "oauth",
    token: "t",
  });
});

test("an unknown SNPF_AUTH is a UsageError listing every valid value", () => {
  throwsUsage(
    () =>
      resolveAuthFromEnv({
        SNPF_AUTH: "bsaic",
        SNPF_USER: "a",
        SNPF_PASS: "p",
      }),
    /SNPF_AUTH is "bsaic", which is not a known auth method/,
    new RegExp(`Use one of: ${VALID.join(", ")}`),
    /bearer = token/,
  );
});

test("an unknown SNPF_AUTH is rejected even when other credentials resolve", () => {
  // Auto-detection would find basic auth; the explicit typo must still fail.
  throwsUsage(
    () => resolveAuthFromEnv({ SNPF_AUTH: "tokn", SNPF_TOKEN: "secret-value" }),
    /"tokn"/,
  );
});

test("the error never echoes credential values", () => {
  assert.throws(
    () =>
      resolveAuthFromEnv({
        SNPF_AUTH: "nope",
        SNPF_USER: "alice",
        SNPF_PASS: "hunter2",
        SNPF_TOKEN: "tok-xyz",
      }),
    (err) =>
      !err.message.includes("hunter2") &&
      !err.message.includes("tok-xyz") &&
      !err.message.includes("alice"),
  );
});

test("SNPF_AUTH=mtls points at the SNPF_MTLS_* variables", () => {
  throwsUsage(
    () => resolveAuthFromEnv({ SNPF_AUTH: "mtls" }),
    /not a known auth method/,
    /SNPF_MTLS_CERT and SNPF_MTLS_KEY/,
  );
});

test("an unknown selector under an instance prefix names both forms", () => {
  throwsUsage(
    () => resolveAuthFromEnv({ SNPF_DEV_AUTH: "nope" }, "dev"),
    /SNPF_DEV_AUTH \(or SNPF_AUTH\) is "nope"/,
  );
});

test("an alias with missing inputs names the missing variable", () => {
  throwsUsage(
    () => resolveAuthFromEnv({ SNPF_AUTH: "bearer" }),
    /SNPF_AUTH is "token" but SNPF_TOKEN is not set\./,
  );
});

function runCli(args, env = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("SNPF_") || key === "CI") delete clean[key];
  }
  const cwd = mkdtempSync(join(tmpdir(), "snpf-authsel-"));
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

const URL_ = "http://127.0.0.1:1";
const ONLY = ["--only", "connectivity-auth"];

test("CLI: an unknown SNPF_AUTH exits 2 with the valid list", () => {
  const res = runCli(["run", "-i", URL_, ...ONLY], {
    SNPF_AUTH: "nope",
    SNPF_TOKEN: "x",
  });
  assert.equal(res.status, 2, res.stderr);
  assert.match(
    res.stderr,
    /SNPF_AUTH is "nope", which is not a known auth method/,
  );
  assert.match(res.stderr, /oauth-jwt/);
  assert.equal(res.stdout, "");
});

test("CLI: SNPF_AUTH=bearer with SNPF_TOKEN resolves (no config error)", () => {
  const res = runCli(["run", "-i", URL_, ...ONLY], {
    SNPF_AUTH: "bearer",
    SNPF_TOKEN: "x",
    CI: "true",
  });
  assert.notEqual(res.status, 2, res.stderr);
  assert.doesNotMatch(
    res.stderr,
    /not a known auth method|No credentials resolved/,
  );
});

test("CLI: --help documents the bearer alias", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /bearer and oauth are aliases of token/);
});
