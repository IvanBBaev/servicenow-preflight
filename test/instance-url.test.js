// RR-11 (DX-4, SEC-7): instance URL normalisation for the --instance flag,
// SNPF_INSTANCE and the config-file instanceUrl, and the cleartext-http
// credential refusal as the CLI surfaces it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, normaliseInstanceUrl } from "../build/config.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "snpf-url-"));
}

function isUsage(pattern) {
  return (err) => err.name === "UsageError" && pattern.test(err.message);
}

test("a bare host gets https:// and a note naming the source", () => {
  const { url, note } = normaliseInstanceUrl(
    "dev12345.service-now.com",
    "--instance",
  );
  assert.equal(url, "https://dev12345.service-now.com");
  assert.match(note, /--instance "dev12345\.service-now\.com" has no scheme/);
  assert.match(note, /using https:\/\/dev12345\.service-now\.com/);
});

test("a bare host keeps its port and loses a trailing slash", () => {
  assert.equal(
    normaliseInstanceUrl(" dev1.service-now.com:8443/ ", "x").url,
    "https://dev1.service-now.com:8443",
  );
  assert.equal(normaliseInstanceUrl("10.0.0.5", "x").url, "https://10.0.0.5");
  assert.equal(
    normaliseInstanceUrl("[::1]:8080", "x").url,
    "https://[::1]:8080",
  );
});

test("a URL with a scheme is returned unchanged, without a note", () => {
  for (const value of [
    "https://dev12345.service-now.com",
    "http://127.0.0.1:1",
  ]) {
    assert.deepEqual(normaliseInstanceUrl(value, "x"), { url: value });
  }
});

test("a malformed value is a UsageError naming the expected shape", () => {
  for (const value of [
    "not a url",
    "dev 1.service-now.com",
    "https://",
    "/x",
  ]) {
    assert.throws(
      () => normaliseInstanceUrl(value, "SNPF_INSTANCE"),
      isUsage(
        /^Instance URL must be https:\/\/<host> \(got ".*" from SNPF_INSTANCE\)/,
      ),
      value,
    );
  }
});

test("a non-http(s) scheme is a UsageError naming the scheme", () => {
  assert.throws(
    () => normaliseInstanceUrl("ftp://dev1.service-now.com", "--instance"),
    isUsage(/the ftp scheme is not supported/),
  );
});

test("the error masks userinfo in the echoed value", () => {
  assert.throws(
    () => normaliseInstanceUrl("admin:hunter2@bad host", "--instance"),
    (err) => {
      assert.equal(err.name, "UsageError");
      assert.ok(!err.message.includes("hunter2"), err.message);
      assert.match(err.message, /\*\*\*@/);
      return true;
    },
  );
});

test("loadConfig normalises a scheme-less SNPF_INSTANCE and warns", async () => {
  const dir = tempDir();
  const warnings = [];
  try {
    const loaded = await loadConfig(dir, {
      env: { SNPF_INSTANCE: "dev1.service-now.com" },
      dotenv: false,
      onWarning: (m) => warnings.push(m),
    });
    assert.equal(loaded.config.instanceUrl, "https://dev1.service-now.com");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /SNPF_INSTANCE "dev1\.service-now\.com"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig normalises a scheme-less config-file instanceUrl", async () => {
  const dir = tempDir();
  const warnings = [];
  try {
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ instanceUrl: "dev2.service-now.com" }),
    );
    const loaded = await loadConfig(dir, {
      env: {},
      dotenv: false,
      onWarning: (m) => warnings.push(m),
    });
    assert.equal(loaded.config.instanceUrl, "https://dev2.service-now.com");
    assert.match(warnings.join("\n"), /instanceUrl in preflight\.config\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig rejects a malformed SNPF_INSTANCE or config instanceUrl", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(
      loadConfig(dir, { env: { SNPF_INSTANCE: "ftp://x" }, dotenv: false }),
      isUsage(/Instance URL must be https:\/\/<host>.*SNPF_INSTANCE/),
    );
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ instanceUrl: "not a url" }),
    );
    await assert.rejects(
      loadConfig(dir, { env: {}, dotenv: false }),
      isUsage(/Instance URL must be https:\/\/<host>.*preflight\.config\.json/),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig parses SNPF_ALLOW_INSECURE_HTTP", async () => {
  const dir = tempDir();
  try {
    const on = await loadConfig(dir, {
      env: { SNPF_ALLOW_INSECURE_HTTP: "1" },
      dotenv: false,
    });
    assert.equal(on.allowInsecureHttp, true);
    const off = await loadConfig(dir, { env: {}, dotenv: false });
    assert.equal(off.allowInsecureHttp, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runCli(args, env = {}) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("SNPF_") || key === "CI") delete clean[key];
  }
  const cwd = tempDir();
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

const ONLY = ["--only", "connectivity-auth"];
const CREDS = { SNPF_USER: "admin", SNPF_PASS: "pw" };

test("CLI: a bare -i host gets a note on stderr, not exit 2 or 3", () => {
  // Port 1 on loopback refuses at once, so no real request leaves the host.
  const res = runCli(["run", "-i", "127.0.0.1:1", ...ONLY]);
  assert.match(res.stderr, /note: --instance "127\.0\.0\.1:1" has no scheme/);
  assert.notEqual(res.status, 2, res.stderr);
  assert.notEqual(res.status, 3, res.stderr);
});

test("CLI: a malformed -i value exits 2 with the expected shape", () => {
  const res = runCli(["run", "-i", "not a url", ...ONLY]);
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /Instance URL must be https:\/\/<host>/);
});

test("CLI: a malformed SNPF_INSTANCE exits 2", () => {
  const res = runCli(["run", ...ONLY], { SNPF_INSTANCE: "ftp://x.example" });
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /ftp scheme is not supported/);
});

test("CLI: http with credentials exits 2 and names the opt-in", () => {
  const res = runCli(["run", "-i", "http://x.service-now.com", ...ONLY], CREDS);
  assert.equal(res.status, 2, res.stderr);
  assert.match(res.stderr, /cleartext http to "http:\/\/x\.service-now\.com"/);
  assert.match(res.stderr, /--allow-insecure-http/);
});

test("CLI: --allow-insecure-http or SNPF_ALLOW_INSECURE_HTTP=1 lifts the refusal", () => {
  // 0.0.0.0 is not a loopback name, so the guard applies; port 1 refuses at
  // once, so the opted-in run fails at the network instead of the guard.
  const url = "http://0.0.0.0:1";
  const refused = runCli(["run", "-i", url, ...ONLY], CREDS);
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /cleartext http/);
  const viaFlag = runCli(
    ["run", "-i", url, ...ONLY, "--allow-insecure-http"],
    CREDS,
  );
  const viaEnv = runCli(["run", "-i", url, ...ONLY], {
    ...CREDS,
    SNPF_ALLOW_INSECURE_HTTP: "1",
  });
  for (const res of [viaFlag, viaEnv]) {
    assert.notEqual(res.status, 2, res.stderr);
    assert.doesNotMatch(res.stderr, /cleartext http/);
  }
});

test("CLI: --help documents --allow-insecure-http and SNPF_ALLOW_INSECURE_HTTP", () => {
  const res = runCli(["--help"]);
  assert.match(res.stdout, /--allow-insecure-http/);
  assert.match(res.stdout, /SNPF_ALLOW_INSECURE_HTTP=1/);
});
