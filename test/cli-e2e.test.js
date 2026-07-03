import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runPreflight } from "../build/index.js";
import { formatJUnit } from "../build/report/junit.js";
import { formatSarif } from "../build/report/sarif.js";
import { createFakeSnClient } from "../build/http/fake.js";

// Absolute path to the CommonJS launcher (the real process entry).
const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

/**
 * Run the built CLI binary with `args`. We isolate it from any ambient
 * credentials / config file by pointing `cwd` at an empty temp dir and
 * stripping SNPF_* from the environment, so runs are deterministic.
 */
function runCli(args, { cwd, env } = {}) {
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("SNPF_")) delete cleanEnv[key];
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? tmpdir(),
    env: { ...cleanEnv, ...env },
    encoding: "utf8",
  });
}

test("CLI --only runs just the named check and exits 0 on pass", () => {
  const res = runCli([
    "--only",
    "instance-url-configured",
    "--instance",
    "https://dev12345.service-now.com",
    "--format",
    "json",
  ]);
  assert.equal(res.status, 0);
  const report = JSON.parse(res.stdout);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].name, "instance-url-configured");
  assert.equal(report.results[0].status, "pass");
  assert.equal(report.ok, true);
});

test("CLI exits 1 when a check fails (no instance URL)", () => {
  const res = runCli(["--only", "instance-url-configured", "--format", "json"]);
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
});

test("CLI --skip drops the named check from the default run", () => {
  const res = runCli([
    "--skip",
    "instance-url-configured",
    "--instance",
    "https://dev12345.service-now.com",
    "--format",
    "json",
  ]);
  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  const names = report.results.map((r) => r.name);
  assert.ok(!names.includes("instance-url-configured"));
  // The remaining default checks all ran.
  assert.ok(report.results.length >= 1);
});

test("CLI --format junit emits a well-formed JUnit document", () => {
  const res = runCli([
    "--only",
    "instance-url-configured",
    "--instance",
    "https://dev12345.service-now.com",
    "--format",
    "junit",
  ]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(res.stdout, /<testsuite name="servicenow-preflight"/);
  assert.match(res.stdout, /name="instance-url-configured"/);
});

test("CLI --format sarif emits a valid SARIF 2.1.0 log", () => {
  const res = runCli([
    "--only",
    "instance-url-configured",
    "--instance",
    "https://dev12345.service-now.com",
    "--format",
    "sarif",
  ]);
  assert.equal(res.status, 0);
  const log = JSON.parse(res.stdout);
  assert.equal(log.version, "2.1.0");
  assert.equal(log.runs[0].tool.driver.name, "servicenow-preflight");
});

test("CLI --help prints usage and exits 0 without running checks", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
  assert.match(res.stdout, /--only/);
  assert.match(res.stdout, /--format/);
});

test("CLI reads instance + selection from a --config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-cli-"));
  const cfgPath = join(dir, "preflight.config.json");
  writeFileSync(
    cfgPath,
    JSON.stringify({
      instanceUrl: "https://dev12345.service-now.com",
      select: { only: ["instance-url-configured"] },
    }),
  );
  try {
    const res = runCli(["--config", cfgPath, "--format", "json"], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].name, "instance-url-configured");
    assert.equal(report.results[0].status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflight + fake client feeds a reporter end-to-end", async () => {
  // The library path: build a context with the fake client, run every default
  // check, then render the report through both reporters. Exercises the same
  // wiring the CLI uses, but without a live instance.
  const http = createFakeSnClient();
  const report = await runPreflight({
    instanceUrl: "https://dev12345.service-now.com",
    http,
  });

  // instanceUrlConfigured passes; the rest warn/pass without network state.
  assert.equal(
    report.results.length,
    report.summary.pass + report.summary.warn + report.summary.fail,
  );

  const junit = formatJUnit(report);
  assert.match(junit, /<testsuite name="servicenow-preflight"/);
  assert.match(junit, /tests="\d+"/);

  const sarif = JSON.parse(formatSarif(report));
  assert.equal(sarif.version, "2.1.0");
  // Every SARIF result maps to a non-pass check.
  assert.equal(
    sarif.runs[0].results.length,
    report.summary.warn + report.summary.fail,
  );
});

// --- Multi-instance subcommands -------------------------------------------

/** Seed a temp project with `.preflight/instances.json` and return its dir. */
function projectWithRegistry(instances, scope) {
  const dir = mkdtempSync(join(tmpdir(), "snpf-mi-"));
  mkdirSync(join(dir, ".preflight"), { recursive: true });
  writeFileSync(
    join(dir, ".preflight", "instances.json"),
    JSON.stringify({ version: 1, ...(scope ? { scope } : {}), instances }),
  );
  return dir;
}

/** Write a committed state manifest for `instance` under `dir`. */
function writeStateManifest(dir, instance, manifest) {
  mkdirSync(join(dir, ".preflight", "state"), { recursive: true });
  writeFileSync(
    join(dir, ".preflight", "state", `${instance}.state.json`),
    JSON.stringify(manifest),
  );
}

test("CLI run <env> resolves the instance URL from the registry", () => {
  const dir = projectWithRegistry({
    dev: { url: "https://dev12345.service-now.com", stage: "dev" },
  });
  try {
    const res = runCli(
      ["dev", "--only", "instance-url-configured", "--format", "json"],
      { cwd: dir },
    );
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.results[0].name, "instance-url-configured");
    assert.equal(report.results[0].status, "pass");
    assert.match(report.results[0].message, /dev12345/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI run --all aggregates a report per instance", () => {
  const dir = projectWithRegistry({
    dev: { url: "https://dev12345.service-now.com", stage: "dev" },
    prod: { url: "https://prod98765.service-now.com", stage: "prod" },
  });
  try {
    const res = runCli(
      ["run", "--all", "--only", "instance-url-configured", "--format", "json"],
      { cwd: dir },
    );
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);
    assert.deepEqual(Object.keys(out.instances).sort(), ["dev", "prod"]);
    assert.equal(out.instances.dev.results[0].status, "pass");
    assert.equal(out.instances.prod.results[0].status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI run --all without a registry errors cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-mi-"));
  try {
    const res = runCli(["run", "--all"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--all needs a registry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI run <unknown-env> lists the known instances", () => {
  const dir = projectWithRegistry({
    dev: { url: "https://dev12345.service-now.com" },
  });
  try {
    const res = runCli(["staging"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Unknown instance "staging"/);
    assert.match(res.stderr, /Known instances: dev/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI sync without a registry errors cleanly", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-mi-"));
  try {
    const res = runCli(["sync", "dev"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /sync needs a registry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI sync without an instance name errors cleanly", () => {
  const dir = projectWithRegistry({
    dev: { url: "https://dev12345.service-now.com" },
  });
  try {
    const res = runCli(["sync"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /sync needs an instance name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI drift passes (exit 0) when the target has every active source test", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-mi-"));
  try {
    const tests = [
      { id: "x/a", name: "A", active: true },
      { id: "x/b", name: "B", active: true },
    ];
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests,
      suites: [],
    });
    writeStateManifest(dir, "prod", { instance: "prod", tests, suites: [] });
    const res = runCli(["drift", "staging", "prod", "--format", "json"], {
      cwd: dir,
    });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.results[0].name, "test-drift");
    assert.equal(report.results[0].status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI drift fails (exit 1) when the target is missing an active source test", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-mi-"));
  try {
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests: [
        { id: "x/a", name: "A", active: true },
        { id: "x/b", name: "B", active: true },
      ],
      suites: [],
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      tests: [{ id: "x/a", name: "A", active: true }],
      suites: [],
    });
    const res = runCli(["drift", "staging", "prod", "--format", "json"], {
      cwd: dir,
    });
    assert.equal(res.status, 1);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.results[0].status, "fail");
    assert.match(report.results[0].message, /missing on "prod"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI drift errors when a manifest is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-mi-"));
  try {
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests: [],
      suites: [],
    });
    const res = runCli(["drift", "staging", "prod"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No manifest for "prod"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI drift without two instances prints usage guidance", () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-mi-"));
  try {
    const res = runCli(["drift", "staging"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /drift needs two instances/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
