import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Absolute path to the CommonJS launcher (the real process entry).
const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

/**
 * Run the built CLI binary with `args`. We isolate it from any ambient
 * credentials / config file by pointing `cwd` at an empty temp dir and
 * stripping SNPF_* from the environment, so runs are deterministic and never
 * leak a developer's real instance/credentials into an assertion.
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

/** Create an empty temp project dir. */
function tempProject() {
  return mkdtempSync(join(tmpdir(), "snpf-drift-"));
}

/** Seed `.preflight/instances.json` in `dir` with the given instance map. */
function writeRegistry(dir, instances, scope) {
  mkdirSync(join(dir, ".preflight"), { recursive: true });
  writeFileSync(
    join(dir, ".preflight", "instances.json"),
    JSON.stringify({ version: 1, ...(scope ? { scope } : {}), instances }),
  );
}

/** Write a committed state manifest for `instance` under `dir`. */
function writeStateManifest(dir, instance, manifest) {
  mkdirSync(join(dir, ".preflight", "state"), { recursive: true });
  writeFileSync(
    join(dir, ".preflight", "state", `${instance}.state.json`),
    JSON.stringify(manifest),
  );
}

// --- drift: happy path (drift present) ------------------------------------

test("drift blocks (exit 1) and names the drifted test when src has a test dst lacks", () => {
  const dir = tempProject();
  try {
    writeRegistry(dir, {
      staging: { url: "https://staging.service-now.com" },
      prod: { url: "https://prod.service-now.com" },
    });
    // src (staging) has two active tests; dst (prod) is missing "Checkout".
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests: [
        { id: "x/login-flow", name: "Login Flow", active: true },
        { id: "x/checkout", name: "Checkout", active: true },
      ],
      suites: [],
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      tests: [{ id: "x/login-flow", name: "Login Flow", active: true }],
      suites: [],
    });

    const res = runCli(["drift", "staging", "prod"], { cwd: dir });
    assert.equal(res.status, 1, res.stderr);
    // Pretty output names the drifted test and the direction of the drift.
    assert.match(res.stdout, /test-drift/);
    assert.match(res.stdout, /Checkout/);
    assert.match(res.stdout, /missing on "prod"/);
    assert.match(res.stdout, /1 failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift --format json reports ok:false and a failing test-drift result", () => {
  const dir = tempProject();
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
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].name, "test-drift");
    assert.equal(report.results[0].status, "fail");
    assert.match(report.results[0].message, /missing on "prod"/);
    assert.match(report.results[0].message, /\bB\b/);
    assert.equal(report.summary.fail, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift ignores an inactive source test missing downstream (not a regression)", () => {
  const dir = tempProject();
  try {
    // "B" is inactive on the source, so its absence on the target must not block.
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests: [
        { id: "x/a", name: "A", active: true },
        { id: "x/b", name: "B", active: false },
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
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.results[0].status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- drift: no drift -------------------------------------------------------

test("drift passes (exit 0) when both manifests are identical", () => {
  const dir = tempProject();
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

    const res = runCli(["drift", "staging", "prod"], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /No test drift/);
    assert.match(res.stdout, /2 passed|1 passed/);
    assert.match(res.stdout, /0 failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift warns (exit 0) when the target only carries extra tests", () => {
  const dir = tempProject();
  try {
    // The target has everything on the source plus an extra test — informational
    // drift, not a promote blocker.
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests: [{ id: "x/a", name: "A", active: true }],
      suites: [],
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      tests: [
        { id: "x/a", name: "A", active: true },
        { id: "x/extra", name: "Extra", active: true },
      ],
      suites: [],
    });

    const res = runCli(["drift", "staging", "prod", "--format", "json"], {
      cwd: dir,
    });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.results[0].status, "warn");
    assert.match(report.results[0].message, /Extra/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- drift: error paths (offline, no network) ------------------------------

test("drift errors (exit 1) with sync guidance when the src manifest is missing", () => {
  const dir = tempProject();
  try {
    // Only the target manifest exists; the source has never been synced.
    writeStateManifest(dir, "prod", {
      instance: "prod",
      tests: [],
      suites: [],
    });

    const res = runCli(["drift", "staging", "prod"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No manifest for "staging"/);
    assert.match(res.stderr, /servicenow-preflight sync staging/);
    // The message only — no stack trace echoed to the user.
    assert.doesNotMatch(res.stderr, /at .*\.js:\d+/);
    assert.equal(res.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift errors (exit 1) with sync guidance when the dst manifest is missing", () => {
  const dir = tempProject();
  try {
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests: [],
      suites: [],
    });

    const res = runCli(["drift", "staging", "prod"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /No manifest for "prod"/);
    assert.match(res.stderr, /servicenow-preflight sync prod/);
    assert.doesNotMatch(res.stderr, /at .*\.js:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift errors (exit 1) when both manifests are missing (reports the source first)", () => {
  const dir = tempProject();
  try {
    const res = runCli(["drift", "staging", "prod"], { cwd: dir });
    assert.equal(res.status, 1);
    // The source is checked before the target.
    assert.match(res.stderr, /No manifest for "staging"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- argument parsing ------------------------------------------------------

test("drift without two positionals prints usage guidance and exits 1", () => {
  const dir = tempProject();
  try {
    const res = runCli(["drift", "staging"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /drift needs two instances/);
    assert.match(res.stderr, /drift <source> <target>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift with no positionals at all prints usage guidance and exits 1", () => {
  const dir = tempProject();
  try {
    const res = runCli(["drift"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /drift needs two instances/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--help lists both the sync and drift subcommands and exits 0", () => {
  const res = runCli(["--help"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
  assert.match(res.stdout, /servicenow-preflight sync <env>/);
  assert.match(res.stdout, /servicenow-preflight drift <src> <dst>/);
  assert.match(res.stdout, /--with-last-run/);
  assert.match(res.stdout, /--registry/);
});

test("-h short flag prints the same usage and exits 0", () => {
  const res = runCli(["-h"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /Usage:/);
  assert.match(res.stdout, /drift/);
});

test("an unknown bare token is treated as a run env and errors without a registry", () => {
  // There is no dedicated subcommand for an unknown leading token: it falls
  // through to the default `run` command as a positional env name, which fails
  // cleanly (exit 1) when no registry can resolve it — no crash, no stack trace.
  const dir = tempProject();
  try {
    const res = runCli(["definitely-not-a-subcommand"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(
      res.stderr,
      /cannot resolve instance "definitely-not-a-subcommand"/,
    );
    assert.doesNotMatch(res.stderr, /at .*\.js:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--registry <path> points drift at a custom registry location (parsing accepted)", () => {
  // The flag is accepted for every subcommand; drift itself does not consult the
  // registry (it only loads manifests), so the run still reaches the manifest
  // stage and reports the offline drift result rather than a parse error.
  const dir = tempProject();
  try {
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests: [{ id: "x/a", name: "A", active: true }],
      suites: [],
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      tests: [{ id: "x/a", name: "A", active: true }],
      suites: [],
    });
    const res = runCli(
      [
        "drift",
        "staging",
        "prod",
        "--registry",
        "custom/reg.json",
        "--format",
        "json",
      ],
      { cwd: dir },
    );
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.results[0].name, "test-drift");
    assert.equal(report.results[0].status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- sync: argument parsing + clean failures (no live network) -------------

test("sync without an instance name errors cleanly and exits 1", () => {
  const dir = tempProject();
  try {
    writeRegistry(dir, { dev: { url: "https://dev12345.service-now.com" } });
    const res = runCli(["sync"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /sync needs an instance name/);
    assert.match(res.stderr, /servicenow-preflight sync <env>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync without a registry errors cleanly and exits 1", () => {
  const dir = tempProject();
  try {
    const res = runCli(["sync", "dev"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /sync needs a registry/);
    assert.match(res.stderr, /\.preflight\/instances\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync for an unknown instance lists the known instances and exits 1", () => {
  const dir = tempProject();
  try {
    writeRegistry(dir, { dev: { url: "https://dev12345.service-now.com" } });
    const res = runCli(["sync", "staging"], { cwd: dir });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Unknown instance "staging"/);
    assert.match(res.stderr, /Known instances: dev/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync against an unreachable instance fails cleanly without leaking credentials", () => {
  const dir = tempProject();
  try {
    // A registry pointing at a host that does not resolve. With credentials in
    // the environment, the sync attempts the network, fails fast on DNS, and
    // must surface a clean message (exit 1) that never echoes the password or a
    // stack trace.
    writeRegistry(dir, {
      dev: { url: "https://dev-nonexistent-xyz-abc.service-now.com" },
    });
    const secret = "supersecretpw-do-not-leak";
    const res = runCli(["sync", "dev"], {
      cwd: dir,
      env: { SNPF_DEV_USER: "admin", SNPF_DEV_PASS: secret },
    });
    assert.equal(res.status, 1);
    // A helpful, network-level error — not a crash.
    assert.match(
      res.stderr,
      /Could not reach ServiceNow|fetch failed|ENOTFOUND|getaddrinfo/i,
    );
    // The credential must appear in neither stream, nor a raw stack trace.
    assert.ok(!res.stderr.includes(secret), "password must not leak to stderr");
    assert.ok(!res.stdout.includes(secret), "password must not leak to stdout");
    assert.doesNotMatch(res.stderr, /at .*\.js:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
