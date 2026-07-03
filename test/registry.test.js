import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";

import {
  PREFLIGHT_DIR,
  REGISTRY_BASENAME,
  registryPath,
  loadRegistry,
  instanceNames,
  resolveInstance,
} from "../build/registry.js";

/** Make a fresh temp dir; caller removes it. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), "snpf-reg-"));
}

/**
 * Write a `.preflight/instances.json` under `dir` and return its path.
 * `registry` may be an object (JSON-encoded) or a raw string (written verbatim,
 * for malformed-JSON cases).
 */
function writeRegistry(dir, registry) {
  const preflightDir = join(dir, PREFLIGHT_DIR);
  mkdirSync(preflightDir, { recursive: true });
  const path = join(preflightDir, REGISTRY_BASENAME);
  writeFileSync(
    path,
    typeof registry === "string" ? registry : JSON.stringify(registry),
  );
  return path;
}

/** A four-stage promotion chain used by several tests. */
function fullRegistry() {
  return {
    version: 1,
    scope: "x_acme_app",
    instances: {
      dev: {
        url: "https://dev12345.service-now.com",
        stage: "dev",
        promotesTo: "staging",
      },
      staging: {
        url: "https://staging12345.service-now.com",
        stage: "staging",
        promotesTo: "test",
      },
      test: {
        url: "https://test12345.service-now.com",
        stage: "test",
        promotesTo: "prod",
      },
      prod: {
        url: "https://prod12345.service-now.com",
        stage: "prod",
        promotesTo: null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Exported constants
// ---------------------------------------------------------------------------

test("exported constants have their documented values", () => {
  assert.equal(PREFLIGHT_DIR, ".preflight");
  assert.equal(REGISTRY_BASENAME, "instances.json");
});

// ---------------------------------------------------------------------------
// registryPath
// ---------------------------------------------------------------------------

test("registryPath composes .preflight/instances.json under an explicit cwd", () => {
  const dir = tempDir();
  try {
    const path = registryPath(dir);
    assert.equal(path, resolve(dir, PREFLIGHT_DIR, REGISTRY_BASENAME));
    assert.ok(isAbsolute(path));
    assert.ok(path.endsWith(join(PREFLIGHT_DIR, REGISTRY_BASENAME)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registryPath defaults to process.cwd() when no argument is given", () => {
  const path = registryPath();
  assert.equal(path, resolve(process.cwd(), PREFLIGHT_DIR, REGISTRY_BASENAME));
});

test("registryPath resolves a relative cwd against the current directory", () => {
  const path = registryPath(".");
  assert.ok(isAbsolute(path));
  assert.equal(path, resolve(".", PREFLIGHT_DIR, REGISTRY_BASENAME));
});

// ---------------------------------------------------------------------------
// loadRegistry
// ---------------------------------------------------------------------------

test("loadRegistry returns undefined when no registry file is present", async () => {
  const dir = tempDir();
  try {
    const reg = await loadRegistry(dir);
    assert.equal(reg, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRegistry loads a multi-stage registry from the default location", async () => {
  const dir = tempDir();
  try {
    writeRegistry(dir, fullRegistry());
    const reg = await loadRegistry(dir);
    assert.ok(reg);
    assert.equal(reg.version, 1);
    assert.equal(reg.scope, "x_acme_app");
    assert.deepEqual(Object.keys(reg.instances), [
      "dev",
      "staging",
      "test",
      "prod",
    ]);
    assert.equal(reg.instances.dev.url, "https://dev12345.service-now.com");
    assert.equal(reg.instances.prod.promotesTo, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRegistry defaults a missing version to 1 and leaves scope undefined", async () => {
  const dir = tempDir();
  try {
    // No `version`, no `scope` at the registry level.
    writeRegistry(dir, {
      instances: { dev: { url: "https://dev.service-now.com" } },
    });
    const reg = await loadRegistry(dir);
    assert.ok(reg);
    assert.equal(reg.version, 1);
    assert.equal(reg.scope, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRegistry honours an explicit absolute path", async () => {
  const dir = tempDir();
  try {
    const path = writeRegistry(dir, fullRegistry());
    // cwd is a different, empty temp dir to prove the explicit path is used.
    const other = tempDir();
    try {
      const reg = await loadRegistry(other, path);
      assert.ok(reg);
      assert.deepEqual(instanceNames(reg), ["dev", "staging", "test", "prod"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRegistry resolves an explicit relative path against cwd", async () => {
  const dir = tempDir();
  try {
    writeFileSync(
      join(dir, "custom-registry.json"),
      JSON.stringify({
        version: 1,
        instances: { dev: { url: "https://dev.service-now.com" } },
      }),
    );
    const reg = await loadRegistry(dir, "custom-registry.json");
    assert.ok(reg);
    assert.deepEqual(instanceNames(reg), ["dev"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRegistry throws on malformed (non-JSON) content", async () => {
  const dir = tempDir();
  try {
    writeRegistry(dir, "{ not: valid json, ]");
    await assert.rejects(loadRegistry(dir), /is not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRegistry throws when the top level is not a JSON object", async () => {
  const dir = tempDir();
  try {
    writeRegistry(dir, "[1, 2, 3]");
    await assert.rejects(loadRegistry(dir), /is not a JSON object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRegistry throws when the top level is JSON null", async () => {
  const dir = tempDir();
  try {
    writeRegistry(dir, "null");
    await assert.rejects(loadRegistry(dir), /is not a JSON object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadRegistry throws when the "instances" map is absent', async () => {
  const dir = tempDir();
  try {
    writeRegistry(dir, { version: 1 });
    await assert.rejects(loadRegistry(dir), /has no "instances" map/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRegistry throws when an instance is missing its url", async () => {
  const dir = tempDir();
  try {
    writeRegistry(dir, {
      version: 1,
      instances: { dev: { stage: "dev" } },
    });
    await assert.rejects(loadRegistry(dir), /instance "dev" is missing a url/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// instanceNames
// ---------------------------------------------------------------------------

test("instanceNames returns the instance keys in declaration order", () => {
  const reg = fullRegistry();
  assert.deepEqual(instanceNames(reg), ["dev", "staging", "test", "prod"]);
});

test("instanceNames returns an empty array for an empty instances map", () => {
  assert.deepEqual(instanceNames({ version: 1, instances: {} }), []);
});

// ---------------------------------------------------------------------------
// resolveInstance
// ---------------------------------------------------------------------------

test("resolveInstance resolves a known instance with its fields", () => {
  const reg = fullRegistry();
  const resolved = resolveInstance(reg, "staging");
  assert.deepEqual(resolved, {
    name: "staging",
    url: "https://staging12345.service-now.com",
    stage: "staging",
    promotesTo: "test",
    scope: "x_acme_app",
    envPrefix: "STAGING",
  });
});

test("resolveInstance defaults promotesTo to null when the instance omits it", () => {
  const reg = {
    version: 1,
    instances: { dev: { url: "https://dev.service-now.com" } },
  };
  const resolved = resolveInstance(reg, "dev");
  assert.equal(resolved.promotesTo, null);
});

test("resolveInstance falls back to the registry-level scope", () => {
  const reg = {
    version: 1,
    scope: "x_default_app",
    instances: { dev: { url: "https://dev.service-now.com" } },
  };
  assert.equal(resolveInstance(reg, "dev").scope, "x_default_app");
});

test("resolveInstance lets an instance override the registry scope", () => {
  const reg = {
    version: 1,
    scope: "x_default_app",
    instances: {
      dev: { url: "https://dev.service-now.com", scope: "x_dev_app" },
    },
  };
  assert.equal(resolveInstance(reg, "dev").scope, "x_dev_app");
});

test("resolveInstance leaves scope undefined when neither level sets it", () => {
  const reg = {
    version: 1,
    instances: { dev: { url: "https://dev.service-now.com" } },
  };
  assert.equal(resolveInstance(reg, "dev").scope, undefined);
});

test("resolveInstance derives envPrefix from the upper-cased name by default", () => {
  const reg = {
    version: 1,
    instances: { staging: { url: "https://staging.service-now.com" } },
  };
  assert.equal(resolveInstance(reg, "staging").envPrefix, "STAGING");
});

test("resolveInstance sanitises non-word characters in the derived envPrefix", () => {
  const reg = {
    version: 1,
    instances: {
      "dev-us.east": { url: "https://dev.service-now.com" },
    },
  };
  // Non-word runs collapse to a single underscore; no leading/trailing "_".
  assert.equal(resolveInstance(reg, "dev-us.east").envPrefix, "DEV_US_EAST");
});

test("resolveInstance trims leading/trailing separators in the derived envPrefix", () => {
  const reg = {
    version: 1,
    instances: {
      "-dev-": { url: "https://dev.service-now.com" },
    },
  };
  assert.equal(resolveInstance(reg, "-dev-").envPrefix, "DEV");
});

test("resolveInstance honours an explicit envPrefix override (trimmed)", () => {
  const reg = {
    version: 1,
    instances: {
      dev: { url: "https://dev.service-now.com", envPrefix: "  MYDEV  " },
    },
  };
  assert.equal(resolveInstance(reg, "dev").envPrefix, "MYDEV");
});

test("resolveInstance falls back to the derived prefix when the override is blank", () => {
  const reg = {
    version: 1,
    instances: {
      dev: { url: "https://dev.service-now.com", envPrefix: "   " },
    },
  };
  // A whitespace-only override is falsy after trim → derive from the name.
  assert.equal(resolveInstance(reg, "dev").envPrefix, "DEV");
});

test("resolveInstance throws for an unknown instance and lists the known names", () => {
  const reg = fullRegistry();
  assert.throws(
    () => resolveInstance(reg, "qa"),
    /Unknown instance "qa"\. Known instances: dev, staging, test, prod\./,
  );
});

test("resolveInstance reports (none) as the known list for an empty registry", () => {
  const reg = { version: 1, instances: {} };
  assert.throws(
    () => resolveInstance(reg, "dev"),
    /Unknown instance "dev"\. Known instances: \(none\)\./,
  );
});
