import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resolveAuthFromEnv } from "../build/config.js";

/** Make a fresh temp dir; caller removes it. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), "snpf-cfg-"));
}

test("resolveAuthFromEnv prefers an OAuth token over basic creds", () => {
  const auth = resolveAuthFromEnv({
    SNPF_TOKEN: "tok123",
    SNPF_USER: "alice",
    SNPF_PASS: "secret",
  });
  assert.deepEqual(auth, { kind: "oauth", token: "tok123" });
});

test("resolveAuthFromEnv falls back to basic when only user+pass are set", () => {
  const auth = resolveAuthFromEnv({ SNPF_USER: "alice", SNPF_PASS: "secret" });
  assert.deepEqual(auth, { kind: "basic", user: "alice", pass: "secret" });
});

test("resolveAuthFromEnv returns undefined when no creds are present", () => {
  assert.equal(resolveAuthFromEnv({}), undefined);
});

test("resolveAuthFromEnv ignores a user without a pass", () => {
  assert.equal(resolveAuthFromEnv({ SNPF_USER: "alice" }), undefined);
});

test("loadConfig returns an empty config when no file is present", async () => {
  const dir = tempDir();
  try {
    const loaded = await loadConfig(dir, { skipDotEnv: true });
    assert.deepEqual(loaded.config, {});
    assert.equal(loaded.configPath, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig auto-discovers preflight.config.json", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({
        instanceUrl: "https://dev12345.service-now.com",
        scope: "x_acme_app",
        updateSetId: "abc123",
        select: { skip: ["atf-run"] },
      }),
    );
    const loaded = await loadConfig(dir, { skipDotEnv: true });
    assert.equal(loaded.config.instanceUrl, "https://dev12345.service-now.com");
    assert.equal(loaded.config.scope, "x_acme_app");
    assert.equal(loaded.config.updateSetId, "abc123");
    assert.deepEqual(loaded.config.select, { skip: ["atf-run"] });
    assert.ok(loaded.configPath?.endsWith("preflight.config.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig honours an explicit relative --config path", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "custom.json"),
      JSON.stringify({ instanceUrl: "https://other.service-now.com" }),
    );
    const loaded = await loadConfig(dir, {
      configPath: "custom.json",
      skipDotEnv: true,
    });
    assert.equal(loaded.config.instanceUrl, "https://other.service-now.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig loads a JS config module's default export", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "preflight.config.mjs"),
      'export default { instanceUrl: "https://js.service-now.com", options: { languages: ["de"] } };\n',
    );
    const loaded = await loadConfig(dir, { skipDotEnv: true });
    assert.equal(loaded.config.instanceUrl, "https://js.service-now.com");
    assert.deepEqual(loaded.config.options, { languages: ["de"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig reads instanceUrl from SNPF_INSTANCE when the file omits it", async () => {
  const dir = tempDir();
  const prev = process.env.SNPF_INSTANCE;
  process.env.SNPF_INSTANCE = "https://env.service-now.com";
  try {
    const loaded = await loadConfig(dir, { skipDotEnv: true });
    assert.equal(loaded.config.instanceUrl, "https://env.service-now.com");
  } finally {
    if (prev === undefined) delete process.env.SNPF_INSTANCE;
    else process.env.SNPF_INSTANCE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses a .env file (real env wins over .env)", async () => {
  const dir = tempDir();
  // SNPF_USER is only in .env; SNPF_PASS is set in the real env and must win.
  writeFileSync(
    join(dir, ".env"),
    ["# creds", 'SNPF_USER="fromdotenv"', "SNPF_PASS=shouldNotWin", ""].join(
      "\n",
    ),
  );
  const prevUser = process.env.SNPF_USER;
  const prevPass = process.env.SNPF_PASS;
  delete process.env.SNPF_USER;
  process.env.SNPF_PASS = "realpass";
  try {
    const loaded = await loadConfig(dir);
    // .env supplied the user; the real env kept the pass.
    assert.deepEqual(loaded.auth, {
      kind: "basic",
      user: "fromdotenv",
      pass: "realpass",
    });
  } finally {
    if (prevUser === undefined) delete process.env.SNPF_USER;
    else process.env.SNPF_USER = prevUser;
    if (prevPass === undefined) delete process.env.SNPF_PASS;
    else process.env.SNPF_PASS = prevPass;
    rmSync(dir, { recursive: true, force: true });
  }
});
