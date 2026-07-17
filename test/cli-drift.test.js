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
    // test-drift plus the two version-parity results (OPP-1 / OPP-5), which
    // are advisory warns here because the manifests predate version capture.
    assert.equal(report.results.length, 3);
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

test("drift without two positionals prints usage guidance and exits 2", () => {
  const dir = tempProject();
  try {
    const res = runCli(["drift", "staging"], { cwd: dir });
    // A usage error (missing positional) exits 2 (CC-41), distinct from a
    // check/drift failure (exit 1).
    assert.equal(res.status, 2);
    assert.match(res.stderr, /drift needs two instances/);
    assert.match(res.stderr, /drift <source> <target>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift with no positionals at all prints usage guidance and exits 2", () => {
  const dir = tempProject();
  try {
    const res = runCli(["drift"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /drift needs two instances/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift rejects comparing an instance to itself and exits 2 (CC-35)", () => {
  const dir = tempProject();
  try {
    // src === dst always reports a clean promote (a manifest never drifts from
    // itself) — almost certainly a typo, so reject it before loading anything.
    const res = runCli(["drift", "prod", "prod"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /two different instances/);
    assert.match(res.stderr, /"prod" for both source and target/);
    assert.doesNotMatch(res.stderr, /at .*\.js:\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift rejects a positional instance name with a path separator and exits 2 (CC-14)", () => {
  const dir = tempProject();
  try {
    // A crafted positional must not walk the tree into another directory's
    // manifest — it is validated before it becomes a path.
    const res = runCli(["drift", "a/b", "prod"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /path separators or ".."/);
    assert.doesNotMatch(res.stderr, /at .*\.js:\d+/);
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
  // The SN-1 empty-snapshot override flag is documented.
  assert.match(res.stdout, /--allow-empty/);
  // The manifest-age gate is documented, with its duration syntax.
  assert.match(res.stdout, /--max-age/);
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
  // cleanly when no registry can resolve it — no crash, no stack trace. Absent a
  // registry this is a usage error, so it exits 2 (CC-41).
  const dir = tempProject();
  try {
    const res = runCli(["definitely-not-a-subcommand"], { cwd: dir });
    assert.equal(res.status, 2);
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

// --- drift: manifest-freshness gate (--max-age) ----------------------------

test("drift warns (exit 0) when a compared manifest is older than 30 days", () => {
  const dir = tempProject();
  try {
    const tests = [{ id: "x/a", name: "A", active: true }];
    // Source synced 40 days ago (stale); target fresh. No test drift, so the
    // only signal is a manifest-freshness warning — informational, not blocking.
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests,
      suites: [],
      syncedAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      tests,
      suites: [],
      syncedAt: new Date().toISOString(),
    });

    const res = runCli(["drift", "staging", "prod", "--format", "json"], {
      cwd: dir,
    });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    const freshness = report.results.find(
      (r) => r.name === "manifest-freshness",
    );
    assert.ok(freshness, "a manifest-freshness result should be present");
    assert.equal(freshness.status, "warn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift --max-age fails (exit 1) when a manifest is older than the limit", () => {
  const dir = tempProject();
  try {
    const tests = [{ id: "x/a", name: "A", active: true }];
    // Source synced 10 days ago; --max-age 7d turns that into a hard block even
    // though there is no test drift.
    writeStateManifest(dir, "staging", {
      instance: "staging",
      tests,
      suites: [],
      syncedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      tests,
      suites: [],
      syncedAt: new Date().toISOString(),
    });

    const res = runCli(["drift", "staging", "prod", "--max-age", "7d"], {
      cwd: dir,
    });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /manifest-freshness/);
    assert.match(res.stdout, /--max-age/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift with a malformed --max-age duration is a usage error (exit 2)", () => {
  const dir = tempProject();
  try {
    const res = runCli(["drift", "staging", "prod", "--max-age", "soon"], {
      cwd: dir,
    });
    // Bad duration is rejected during parsing, before any manifest is loaded.
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Invalid --max-age/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- sync: argument parsing + clean failures (no live network) -------------

test("sync without an instance name errors cleanly and exits 2", () => {
  const dir = tempProject();
  try {
    writeRegistry(dir, { dev: { url: "https://dev12345.service-now.com" } });
    const res = runCli(["sync"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /sync needs an instance name/);
    assert.match(res.stderr, /servicenow-preflight sync <env>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync without a registry errors cleanly and exits 2", () => {
  const dir = tempProject();
  try {
    const res = runCli(["sync", "dev"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /sync needs a registry/);
    assert.match(res.stderr, /\.preflight\/instances\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync --allow-empty is a recognized flag (parses, then fails on the missing registry)", () => {
  const dir = tempProject();
  try {
    // No registry present. If --allow-empty were unknown, the arg parser would
    // reject it up front with "Unknown option"; instead parsing succeeds and the
    // run proceeds to the registry-load step, proving the flag is wired in.
    const res = runCli(["sync", "dev", "--allow-empty"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /sync needs a registry/);
    assert.doesNotMatch(res.stderr, /Unknown option/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync for an unknown instance lists the known instances and exits 2", () => {
  const dir = tempProject();
  try {
    writeRegistry(dir, { dev: { url: "https://dev12345.service-now.com" } });
    const res = runCli(["sync", "staging"], { cwd: dir });
    assert.equal(res.status, 2);
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

// --- drift: version parity (OPP-1 / OPP-5) ----------------------------------

test("drift on pre-capture manifests reports advisory version-parity warns (exit 0)", () => {
  const dir = tempProject();
  try {
    // Manifests written BEFORE version capture existed: no identity, no apps.
    // Schema compatibility is non-negotiable — they must load cleanly and the
    // parity checks must downgrade to advisories, never crash or block.
    const tests = [{ id: "x/a", name: "A", active: true }];
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
    const instance = report.results.find(
      (r) => r.name === "instance-version-parity",
    );
    const apps = report.results.find((r) => r.name === "app-version-parity");
    assert.ok(instance, "an instance-version-parity result should be present");
    assert.ok(apps, "an app-version-parity result should be present");
    assert.equal(instance.status, "warn");
    assert.equal(apps.status, "warn");
    assert.match(instance.message, /predates version capture/);
    assert.match(instance.message, /re-run sync/);
    assert.match(apps.message, /predates version capture/);
    assert.match(apps.message, /re-run sync/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift blocks (exit 1) on a platform build-name mismatch (OPP-1)", () => {
  const dir = tempProject();
  try {
    // No test drift at all — the ONLY blocker is the instance-version skew.
    const tests = [{ id: "x/a", name: "A", active: true }];
    writeStateManifest(dir, "staging", {
      instance: "staging",
      identity: { buildName: "Yokohama", war: "glide-yokohama.war" },
      apps: [{ id: "x_acme_app", version: "1.0.0" }],
      tests,
      suites: [],
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      identity: { buildName: "Xanadu", war: "glide-xanadu.war" },
      apps: [{ id: "x_acme_app", version: "1.0.0" }],
      tests,
      suites: [],
    });

    const res = runCli(["drift", "staging", "prod", "--format", "json"], {
      cwd: dir,
    });
    assert.equal(res.status, 1);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, false);
    const instance = report.results.find(
      (r) => r.name === "instance-version-parity",
    );
    assert.equal(instance.status, "fail");
    assert.match(instance.message, /Platform version mismatch/);
    assert.match(instance.message, /Yokohama/);
    assert.match(instance.message, /Xanadu/);
    // The app inventories match, so app parity passes alongside.
    const apps = report.results.find((r) => r.name === "app-version-parity");
    assert.equal(apps.status, "pass");
    assert.equal(report.summary.fail, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift blocks (exit 1) when the target runs a lower app version (OPP-5)", () => {
  const dir = tempProject();
  try {
    const tests = [{ id: "x/a", name: "A", active: true }];
    const identity = { buildName: "Xanadu", war: "glide-xanadu.war" };
    writeStateManifest(dir, "staging", {
      instance: "staging",
      identity,
      apps: [{ id: "x_acme_app", name: "Acme App", version: "2.1.0" }],
      tests,
      suites: [],
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      identity,
      apps: [{ id: "x_acme_app", name: "Acme App", version: "2.0.5" }],
      tests,
      suites: [],
    });

    const res = runCli(["drift", "staging", "prod"], { cwd: dir });
    assert.equal(res.status, 1);
    // Pretty output names the check, the app and the direction of the drift.
    assert.match(res.stdout, /app-version-parity/);
    assert.match(res.stdout, /x_acme_app/);
    assert.match(res.stdout, /lower version on target "prod"/);
    assert.match(res.stdout, /1 failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("drift passes cleanly (exit 0) when identity and apps match on both sides", () => {
  const dir = tempProject();
  try {
    const tests = [{ id: "x/a", name: "A", active: true }];
    const identity = { buildName: "Xanadu", war: "glide-xanadu.war" };
    const apps = [
      { id: "x_acme_app", name: "Acme App", version: "1.2.3" },
      { id: "com.snc.incident", version: "10.0.1" },
    ];
    writeStateManifest(dir, "staging", {
      instance: "staging",
      identity,
      apps,
      tests,
      suites: [],
    });
    writeStateManifest(dir, "prod", {
      instance: "prod",
      identity,
      apps,
      tests,
      suites: [],
    });

    const res = runCli(["drift", "staging", "prod", "--format", "json"], {
      cwd: dir,
    });
    assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    assert.equal(report.ok, true);
    // Full capture on both sides: every result is a positive pass — no warns.
    assert.equal(report.summary.warn, 0);
    assert.equal(report.summary.fail, 0);
    assert.equal(
      report.results.find((r) => r.name === "instance-version-parity").status,
      "pass",
    );
    assert.equal(
      report.results.find((r) => r.name === "app-version-parity").status,
      "pass",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
