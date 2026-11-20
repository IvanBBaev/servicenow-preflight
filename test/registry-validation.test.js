// RR-56 (AUDIT-2026-11-12 ST-20, ST-22, ST-23, CFG-10, CFG-11, CFG-12): the
// registry is validated on load — field types, unknown keys, instance names,
// and the credential env prefix each instance derives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PREFLIGHT_DIR,
  REGISTRY_BASENAME,
  loadRegistry,
  resolveInstance,
  promotionChain,
  validateInstanceName,
} from "../build/registry.js";
import { UsageError } from "../build/config.js";

const URL_A = "https://a.service-now.com";
const URL_B = "https://b.service-now.com";
const URL_C = "https://c.service-now.com";

/** Load `registry` (object, or raw JSON text) from a fresh temp dir. */
async function load(registry) {
  const dir = mkdtempSync(join(tmpdir(), "snpf-regval-"));
  try {
    mkdirSync(join(dir, PREFLIGHT_DIR), { recursive: true });
    writeFileSync(
      join(dir, PREFLIGHT_DIR, REGISTRY_BASENAME),
      typeof registry === "string" ? registry : JSON.stringify(registry),
    );
    return await loadRegistry(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Assert that loading `registry` throws a UsageError matching `pattern`. */
async function rejects(registry, pattern) {
  await assert.rejects(load(registry), (err) => {
    assert.ok(err instanceof UsageError, `expected UsageError, got ${err}`);
    assert.match(err.message, pattern);
    return true;
  });
}

const one = (name, def = {}) => ({
  version: 1,
  instances: { [name]: { url: URL_A, ...def } },
});

// ---------- ST-20: derived-prefix collisions ----------

test("ST-20: prod-eu, prod_eu and prod.eu share PROD_EU and are rejected", async () => {
  for (const other of ["prod_eu", "prod.eu"]) {
    await rejects(
      {
        version: 1,
        instances: { "prod-eu": { url: URL_A }, [other]: { url: URL_B } },
      },
      new RegExp(
        `"prod-eu" and "${other.replace(".", "\\.")}" share the credential env prefix PROD_EU`,
      ),
    );
  }
});

test("ST-20: an explicit envPrefix equal to another instance's derived prefix is rejected", async () => {
  await rejects(
    {
      version: 1,
      instances: {
        prod: { url: URL_A },
        live: { url: URL_B, envPrefix: "prod" },
      },
    },
    /"prod" and "live" share the credential env prefix PROD/,
  );
});

test("ST-20: a distinct envPrefix resolves the collision", async () => {
  const reg = await load({
    version: 1,
    instances: {
      "prod-eu": { url: URL_A },
      prod_eu: { url: URL_B, envPrefix: "PROD_EU2" },
    },
  });
  assert.equal(resolveInstance(reg, "prod-eu").envPrefix, "PROD_EU");
  assert.equal(resolveInstance(reg, "prod_eu").envPrefix, "PROD_EU2");
});

test("CFG-12: nested prefixes whose remainder is reserved are rejected (PROD / PROD_NO)", async () => {
  await rejects(
    {
      version: 1,
      instances: { prod: { url: URL_A }, prod_no: { url: URL_B } },
    },
    /prefixes PROD \("prod"\) and PROD_NO \("prod_no"\) overlap — SNPF_PROD_NO_PROXY/,
  );
});

test("CFG-12: nested prefixes with a harmless remainder load (PROD / PROD_EU)", async () => {
  const reg = await load({
    version: 1,
    instances: { prod: { url: URL_A }, prod_eu: { url: URL_B } },
  });
  assert.equal(resolveInstance(reg, "prod_eu").envPrefix, "PROD_EU");
});

// ---------- CFG-12: reserved and empty prefixes ----------

test("CFG-12: an instance named `no` is rejected — SNPF_NO_PROXY would read as the proxy", async () => {
  await rejects(one("no"), /prefix NO is reserved — under it SNPF_NO_PROXY/);
});

test("CFG-12: `oauth-refresh` is rejected — the refresh token would read as a bearer token", async () => {
  await rejects(
    one("oauth-refresh"),
    /prefix OAUTH_REFRESH is reserved — under it SNPF_OAUTH_REFRESH_TOKEN/,
  );
});

test("CFG-12: a reserved name loads once a safe envPrefix is set", async () => {
  const reg = await load(one("no", { envPrefix: "NORWAY" }));
  assert.equal(resolveInstance(reg, "no").envPrefix, "NORWAY");
});

test("CFG-12: a reserved explicit envPrefix is rejected", async () => {
  await rejects(
    one("dev", { envPrefix: "no" }),
    /prefix NO is reserved .*Choose another "envPrefix"/,
  );
});

test("CFG-12: a non-ASCII name with no A-Z/0-9 derives an empty prefix and is rejected", async () => {
  await rejects(one("прод"), /derives an empty credential env prefix/);
});

test("CFG-12: a non-ASCII name loads with an explicit envPrefix", async () => {
  const reg = await load(one("прод", { envPrefix: "PROD" }));
  assert.equal(resolveInstance(reg, "прод").envPrefix, "PROD");
});

test("CFG-12: an explicit envPrefix must be upper-snake", async () => {
  for (const bad of ["my-dev", "dev_", "_dev", "a b", "dé"]) {
    await rejects(one("dev", { envPrefix: bad }), /must be\s+upper-snake/);
  }
  // Case is applied by namespacedEnv, so a lower-case prefix is accepted.
  const reg = await load(one("dev", { envPrefix: "my_dev" }));
  assert.equal(resolveInstance(reg, "dev").envPrefix, "my_dev");
});

// ---------- ST-22: field types ----------

test("ST-22: a numeric envPrefix is a UsageError, not a raw TypeError", async () => {
  await rejects(
    one("dev", { envPrefix: 7 }),
    /"envPrefix" must be a string \(got number\)/,
  );
});

test("ST-22: a non-string stage or scope is rejected", async () => {
  await rejects(one("dev", { stage: 3 }), /"stage" must be a string/);
  await rejects(
    one("dev", { scope: { a: 1 } }),
    /"scope" must be a string \(got object\)/,
  );
  await rejects(
    { version: 1, scope: ["x_app"], instances: { dev: { url: URL_A } } },
    /"scope" must be a string \(got array\)/,
  );
});

test("ST-22: an instance entry that is an array is rejected", async () => {
  await rejects(
    { version: 1, instances: { dev: [URL_A] } },
    /instance "dev" must be a JSON object/,
  );
});

// ---------- CFG-11: unknown keys ----------

test("CFG-11: a `promotesto` typo is rejected with a hint", async () => {
  await rejects(
    {
      version: 1,
      instances: {
        dev: { url: URL_A, promotesto: "prod" },
        prod: { url: URL_B },
      },
    },
    /instance "dev": unknown key "promotesto" \(did you mean "promotesTo"\?\)/,
  );
});

test("CFG-11: an unknown top-level key is rejected", async () => {
  await rejects(
    { version: 1, instances: { dev: { url: URL_A } }, extraTop: 1 },
    /unknown key "extraTop"\. Allowed keys: \$schema, version, scope, instances/,
  );
});

test("CFG-11: every documented key, and $schema, still loads", async () => {
  const reg = await load({
    $schema: "./schema.json",
    version: 1,
    scope: "x_app",
    instances: {
      dev: {
        url: URL_A,
        stage: "dev",
        promotesTo: "prod",
        scope: "x_other",
        envPrefix: "DEV",
      },
      prod: { url: URL_B, stage: "prod", promotesTo: null },
    },
  });
  assert.deepEqual(promotionChain(reg, "dev", "prod"), ["dev", "prod"]);
});

// ---------- ST-23: instance names ----------

test("ST-23: unsafe names are rejected by the allow-list", async () => {
  for (const name of [
    "a\u0000b",
    "a\nb",
    "C:prod",
    "--all",
    "-rf",
    "*",
    "a?b",
    "%2e%2e",
    "__proto__",
    "_dev",
    ".hidden",
    "prod.",
  ]) {
    await rejects(one(name), /must start with a\s+letter or digit/);
  }
});

test("ST-23: Windows device names are rejected, with or without an extension", async () => {
  for (const name of ["CON", "con", "nul", "COM1", "lpt9", "aux.eu", "PRN"]) {
    await rejects(one(name), /reserved Windows device name/);
  }
  // A device name inside a longer word is fine.
  const reg = await load(one("console"));
  assert.equal(resolveInstance(reg, "console").name, "console");
});

test("ST-23: an NFD name is rejected; the NFC spelling loads", async () => {
  const nfc = "café";
  const nfd = "café";
  await rejects(one(nfd), /not in Unicode NFC/);
  const reg = await load(one(nfc));
  assert.equal(resolveInstance(reg, nfc).name, nfc);
});

test("ST-23: the same rules guard names given on the command line", () => {
  for (const name of ["--all", "CON", "a\u0000b", "café", "prod."]) {
    assert.throws(
      () => validateInstanceName(name, "drift <source>"),
      UsageError,
    );
  }
  for (const name of ["dev", "dev-us.east", "prod_eu", "QA2", "café", "прод"]) {
    assert.equal(validateInstanceName(name, "drift <source>"), name);
  }
});

// ---------- CFG-10: inherited names ----------

test("CFG-10: resolveInstance does not resolve an inherited Object property", async () => {
  const reg = await load(one("dev"));
  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    assert.throws(
      () => resolveInstance(reg, name),
      (err) =>
        err instanceof UsageError && /Unknown instance/.test(err.message),
    );
  }
});

test("CFG-10: an instance actually named `constructor` resolves as itself", async () => {
  const reg = await load({
    version: 1,
    instances: {
      constructor: { url: URL_A, promotesTo: "prod" },
      prod: { url: URL_C },
    },
  });
  assert.equal(resolveInstance(reg, "constructor").url, URL_A);
  assert.deepEqual(promotionChain(reg, "constructor", "prod"), [
    "constructor",
    "prod",
  ]);
  assert.equal(promotionChain(reg, "toString", "prod"), undefined);
});
