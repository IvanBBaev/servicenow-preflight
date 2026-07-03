import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  resolveAuthFromEnv,
  resolveTlsFromEnv,
  namespacedEnv,
} from "../build/config.js";

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

test("resolveAuthFromEnv detects an API key", () => {
  const auth = resolveAuthFromEnv({ SNPF_API_KEY: "key-abc" });
  assert.deepEqual(auth, { kind: "apikey", apiKey: "key-abc" });
});

test("resolveAuthFromEnv prefers a static token over an API key", () => {
  const auth = resolveAuthFromEnv({
    SNPF_TOKEN: "tok",
    SNPF_API_KEY: "key-abc",
  });
  assert.deepEqual(auth, { kind: "oauth", token: "tok" });
});

test("resolveAuthFromEnv detects the client_credentials grant", () => {
  const auth = resolveAuthFromEnv({
    SNPF_OAUTH_CLIENT_ID: "cid",
    SNPF_OAUTH_CLIENT_SECRET: "csecret",
  });
  assert.deepEqual(auth, {
    kind: "oauth-client",
    clientId: "cid",
    clientSecret: "csecret",
  });
});

test("resolveAuthFromEnv detects the password grant (client creds + user/pass)", () => {
  const auth = resolveAuthFromEnv({
    SNPF_OAUTH_CLIENT_ID: "cid",
    SNPF_OAUTH_CLIENT_SECRET: "csecret",
    SNPF_USER: "alice",
    SNPF_PASS: "secret",
  });
  assert.deepEqual(auth, {
    kind: "oauth-password",
    clientId: "cid",
    clientSecret: "csecret",
    user: "alice",
    pass: "secret",
  });
});

test("resolveAuthFromEnv detects the refresh_token grant and carries a token-URL override", () => {
  const auth = resolveAuthFromEnv({
    SNPF_OAUTH_CLIENT_ID: "cid",
    SNPF_OAUTH_CLIENT_SECRET: "csecret",
    SNPF_OAUTH_REFRESH_TOKEN: "rt",
    SNPF_OAUTH_TOKEN_URL: "https://sso.example.com/oauth_token.do",
  });
  assert.deepEqual(auth, {
    kind: "oauth-refresh",
    clientId: "cid",
    clientSecret: "csecret",
    refreshToken: "rt",
    tokenUrl: "https://sso.example.com/oauth_token.do",
  });
});

test("resolveAuthFromEnv detects the JWT-bearer grant with an inline key + claims", () => {
  const auth = resolveAuthFromEnv({
    SNPF_OAUTH_CLIENT_ID: "cid",
    SNPF_OAUTH_CLIENT_SECRET: "csecret",
    SNPF_OAUTH_JWT_KEY:
      "-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----",
    SNPF_OAUTH_JWT_KID: "kid-1",
    SNPF_OAUTH_JWT_SUB: "svc-account",
    SNPF_OAUTH_JWT_AUD: "https://dev12345.service-now.com",
    SNPF_OAUTH_JWT_ISS: "cid",
  });
  assert.deepEqual(auth, {
    kind: "oauth-jwt",
    clientId: "cid",
    clientSecret: "csecret",
    privateKey:
      "-----BEGIN PRIVATE KEY-----\nMII...\n-----END PRIVATE KEY-----",
    keyId: "kid-1",
    subject: "svc-account",
    audience: "https://dev12345.service-now.com",
    issuer: "cid",
  });
});

test("resolveAuthFromEnv honours an explicit SNPF_AUTH=basic selector", () => {
  const auth = resolveAuthFromEnv({
    SNPF_AUTH: "basic",
    SNPF_USER: "alice",
    SNPF_PASS: "secret",
  });
  assert.deepEqual(auth, { kind: "basic", user: "alice", pass: "secret" });
});

test("resolveAuthFromEnv honours an explicit SNPF_AUTH=token selector", () => {
  const auth = resolveAuthFromEnv({ SNPF_AUTH: "token", SNPF_TOKEN: "tok" });
  assert.deepEqual(auth, { kind: "oauth", token: "tok" });
});

test("resolveAuthFromEnv yields undefined for an unknown SNPF_AUTH selector", () => {
  assert.equal(resolveAuthFromEnv({ SNPF_AUTH: "no-such-method" }), undefined);
});

test("resolveAuthFromEnv detects the JWT-bearer grant from a pre-signed assertion", () => {
  const auth = resolveAuthFromEnv({
    SNPF_OAUTH_CLIENT_ID: "cid",
    SNPF_OAUTH_CLIENT_SECRET: "csecret",
    SNPF_OAUTH_JWT_ASSERTION: "pre.signed.jwt",
  });
  assert.deepEqual(auth, {
    kind: "oauth-jwt",
    clientId: "cid",
    clientSecret: "csecret",
    assertion: "pre.signed.jwt",
  });
});

test("resolveAuthFromEnv carries a token-URL override into the password grant", () => {
  const auth = resolveAuthFromEnv({
    SNPF_OAUTH_CLIENT_ID: "cid",
    SNPF_OAUTH_CLIENT_SECRET: "csecret",
    SNPF_USER: "alice",
    SNPF_PASS: "secret",
    SNPF_OAUTH_TOKEN_URL: "https://sso.example.com/oauth_token.do",
  });
  assert.deepEqual(auth, {
    kind: "oauth-password",
    clientId: "cid",
    clientSecret: "csecret",
    user: "alice",
    pass: "secret",
    tokenUrl: "https://sso.example.com/oauth_token.do",
  });
});

test("resolveAuthFromEnv carries a token-URL override into the client_credentials grant", () => {
  const auth = resolveAuthFromEnv({
    SNPF_OAUTH_CLIENT_ID: "cid",
    SNPF_OAUTH_CLIENT_SECRET: "csecret",
    SNPF_OAUTH_TOKEN_URL: "https://sso.example.com/oauth_token.do",
  });
  assert.deepEqual(auth, {
    kind: "oauth-client",
    clientId: "cid",
    clientSecret: "csecret",
    tokenUrl: "https://sso.example.com/oauth_token.do",
  });
});

test("resolveAuthFromEnv honours an explicit SNPF_AUTH selector over auto-detection", () => {
  // Basic creds are present, but the selector forces the API-key method.
  const auth = resolveAuthFromEnv({
    SNPF_AUTH: "apikey",
    SNPF_API_KEY: "key-abc",
    SNPF_USER: "alice",
    SNPF_PASS: "secret",
  });
  assert.deepEqual(auth, { kind: "apikey", apiKey: "key-abc" });
});

test("resolveAuthFromEnv yields undefined when SNPF_AUTH names a method whose inputs are absent", () => {
  assert.equal(resolveAuthFromEnv({ SNPF_AUTH: "apikey" }), undefined);
});

test("resolveAuthFromEnv reads an '@path' JWT key from a file", () => {
  const dir = tempDir();
  try {
    const keyPath = join(dir, "jwt.key");
    const pem =
      "-----BEGIN PRIVATE KEY-----\nFROMFILE\n-----END PRIVATE KEY-----";
    writeFileSync(keyPath, pem);
    const auth = resolveAuthFromEnv({
      SNPF_OAUTH_CLIENT_ID: "cid",
      SNPF_OAUTH_CLIENT_SECRET: "csecret",
      SNPF_OAUTH_JWT_KEY: `@${keyPath}`,
    });
    assert.deepEqual(auth, {
      kind: "oauth-jwt",
      clientId: "cid",
      clientSecret: "csecret",
      privateKey: pem,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAuthFromEnv throws when an '@path' value points at a missing file", () => {
  assert.throws(
    () =>
      resolveAuthFromEnv({
        SNPF_OAUTH_CLIENT_ID: "cid",
        SNPF_OAUTH_CLIENT_SECRET: "csecret",
        SNPF_OAUTH_JWT_KEY: "@/no/such/file.key",
      }),
    /Could not read the file referenced by an SNPF_\* '@' value/,
  );
});

test("resolveTlsFromEnv returns undefined without both cert and key", () => {
  assert.equal(resolveTlsFromEnv({}), undefined);
  assert.equal(resolveTlsFromEnv({ SNPF_MTLS_CERT: "certpem" }), undefined);
});

test("resolveTlsFromEnv reads inline cert/key plus optional CA and passphrase", () => {
  const tls = resolveTlsFromEnv({
    SNPF_MTLS_CERT: "certpem",
    SNPF_MTLS_KEY: "keypem",
    SNPF_MTLS_CA: "capem",
    SNPF_MTLS_PASSPHRASE: "pw",
  });
  assert.deepEqual(tls, {
    cert: "certpem",
    key: "keypem",
    ca: "capem",
    passphrase: "pw",
  });
});

test("resolveTlsFromEnv reads '@path' cert/key material from files", () => {
  const dir = tempDir();
  try {
    const certPath = join(dir, "client.crt");
    const keyPath = join(dir, "client.key");
    writeFileSync(certPath, "CERT-PEM");
    writeFileSync(keyPath, "KEY-PEM");
    const tls = resolveTlsFromEnv({
      SNPF_MTLS_CERT: `@${certPath}`,
      SNPF_MTLS_KEY: `@${keyPath}`,
    });
    assert.deepEqual(tls, { cert: "CERT-PEM", key: "KEY-PEM" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig resolves TLS independently of a missing header auth (cert-only)", async () => {
  const dir = tempDir();
  const certPath = join(dir, "client.crt");
  const keyPath = join(dir, "client.key");
  writeFileSync(certPath, "CERT-PEM");
  writeFileSync(keyPath, "KEY-PEM");
  // Snapshot + clear any real auth env so this run is genuinely cert-only.
  const authKeys = [
    "SNPF_USER",
    "SNPF_PASS",
    "SNPF_TOKEN",
    "SNPF_API_KEY",
    "SNPF_AUTH",
    "SNPF_OAUTH_CLIENT_ID",
    "SNPF_OAUTH_CLIENT_SECRET",
  ];
  const prev = {};
  for (const k of authKeys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SNPF_MTLS_CERT = `@${certPath}`;
  process.env.SNPF_MTLS_KEY = `@${keyPath}`;
  try {
    const loaded = await loadConfig(dir, { skipDotEnv: true });
    assert.equal(loaded.auth, undefined);
    assert.deepEqual(loaded.tls, { cert: "CERT-PEM", key: "KEY-PEM" });
  } finally {
    delete process.env.SNPF_MTLS_CERT;
    delete process.env.SNPF_MTLS_KEY;
    for (const k of authKeys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("namespacedEnv with no prefix returns the env untouched", () => {
  const env = { SNPF_USER: "alice" };
  assert.equal(namespacedEnv(env), env);
  assert.equal(namespacedEnv(env, ""), env);
  assert.equal(namespacedEnv(env, "   "), env);
});

test("namespacedEnv resolves SNPF_<PREFIX>_* before the unprefixed name", () => {
  const src = namespacedEnv(
    { SNPF_USER: "flat", SNPF_DEV_USER: "dev-alice", SNPF_PASS: "flatpass" },
    "dev",
  );
  // Prefixed key wins for SNPF_USER; SNPF_PASS falls back to the flat value.
  assert.equal(src.SNPF_USER, "dev-alice");
  assert.equal(src.SNPF_PASS, "flatpass");
});

test("namespacedEnv falls back to the flat name when no prefixed var is set", () => {
  const src = namespacedEnv({ SNPF_TOKEN: "flat-tok" }, "prod");
  assert.equal(src.SNPF_TOKEN, "flat-tok");
});

test("namespacedEnv leaves non-SNPF keys alone", () => {
  const src = namespacedEnv({ PATH: "/bin", SNPF_DEV_USER: "x" }, "dev");
  assert.equal(src.PATH, "/bin");
});

test("namespacedEnv reflects prefixed keys through the `in` operator", () => {
  const src = namespacedEnv({ SNPF_DEV_TOKEN: "t" }, "dev");
  assert.ok("SNPF_TOKEN" in src);
  assert.ok(!("SNPF_API_KEY" in src));
});

test("resolveAuthFromEnv reads a per-instance prefixed credential", () => {
  const auth = resolveAuthFromEnv(
    { SNPF_TOKEN: "flat-tok", SNPF_DEV_TOKEN: "dev-tok" },
    "dev",
  );
  assert.deepEqual(auth, { kind: "oauth", token: "dev-tok" });
});

test("resolveAuthFromEnv falls back to the flat credential when the stage has none", () => {
  const auth = resolveAuthFromEnv(
    { SNPF_USER: "alice", SNPF_PASS: "secret" },
    "prod",
  );
  assert.deepEqual(auth, { kind: "basic", user: "alice", pass: "secret" });
});

test("resolveTlsFromEnv reads per-instance prefixed mTLS material", () => {
  const tls = resolveTlsFromEnv(
    { SNPF_DEV_MTLS_CERT: "dev-cert", SNPF_DEV_MTLS_KEY: "dev-key" },
    "dev",
  );
  assert.deepEqual(tls, { cert: "dev-cert", key: "dev-key" });
});

test("loadConfig applies an envPrefix to both the instance URL and the auth", async () => {
  const dir = tempDir();
  const keys = [
    "SNPF_INSTANCE",
    "SNPF_DEV_INSTANCE",
    "SNPF_TOKEN",
    "SNPF_DEV_TOKEN",
  ];
  const prev = {};
  for (const k of keys) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  process.env.SNPF_INSTANCE = "https://flat.service-now.com";
  process.env.SNPF_DEV_INSTANCE = "https://dev.service-now.com";
  process.env.SNPF_DEV_TOKEN = "dev-tok";
  try {
    const loaded = await loadConfig(dir, {
      skipDotEnv: true,
      envPrefix: "dev",
    });
    assert.equal(loaded.config.instanceUrl, "https://dev.service-now.com");
    assert.deepEqual(loaded.auth, { kind: "oauth", token: "dev-tok" });
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
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
