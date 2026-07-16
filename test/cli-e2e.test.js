import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
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

/**
 * Asynchronous counterpart of {@link runCli}, resolving to the same
 * `{ status, stdout, stderr }` shape once the CLI exits. `runCli` uses
 * `spawnSync`, which blocks this process's event loop for the child's entire
 * lifetime — fine when the child only talks to the outside world, but fatal
 * when it must reach a server running *in this same test process* (e.g. an
 * in-process mock proxy): the blocked loop can never accept the child's
 * connection, so it would hang until the request times out. Awaiting an async
 * `spawn` keeps the loop free to serve those connections.
 */
function runCliAsync(args, { cwd, env } = {}) {
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.startsWith("SNPF_")) delete cleanEnv[key];
  }
  const child = spawn(process.execPath, [BIN, ...args], {
    cwd: cwd ?? tmpdir(),
    env: { ...cleanEnv, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
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
  assert.match(res.stdout, /--version/);
});

test("CLI --version prints the package version and exits 0", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  for (const flag of ["--version", "-v"]) {
    const res = runCli([flag]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), pkg.version);
    // A version query must never run checks or touch an instance.
    assert.equal(res.stderr, "");
  }
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
    // Missing-registry is a usage error → exit 2 (CC-41).
    assert.equal(res.status, 2);
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
    assert.equal(res.status, 2);
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
    assert.equal(res.status, 2);
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
    assert.equal(res.status, 2);
    assert.match(res.stderr, /drift needs two instances/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fail-closed CLI behaviour --------------------------------------------

test("CLI fails closed (exit 1) when --only matches no checks (Q-1 vacuous guard)", () => {
  const res = runCli([
    "--only",
    "no-such-check",
    "--instance",
    "https://dev12345.service-now.com",
    "--format",
    "json",
  ]);
  assert.equal(res.status, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.results[0].name, "preflight");
  assert.match(report.results[0].message, /nothing was verified/i);
});

test("CLI rejects an unknown --format value (Q-4, exit 2)", () => {
  const res = runCli([
    "--only",
    "instance-url-configured",
    "--instance",
    "https://dev12345.service-now.com",
    "--format",
    "xml",
  ]);
  // An unknown --format is a usage error → exit 2 (CC-41).
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown --format/);
  assert.match(res.stderr, /xml/);
});

// --- Empty / malformed registry (CC-19) -----------------------------------

test("CLI run --all against an empty registry fails, never 'All 0 passed' (CC-19)", () => {
  // A registry whose "instances" map is empty must not report a vacuous pass:
  // a pre-deployment gate that verified nothing has to fail closed (exit 2).
  const dir = projectWithRegistry({});
  try {
    const res = runCli(["run", "--all", "--only", "instance-url-configured"], {
      cwd: dir,
    });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /matched no instances/);
    assert.doesNotMatch(res.stdout, /All 0 instance\(s\) passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects a registry whose instances is a JSON array (CC-19, exit 2)", () => {
  const dir = projectWithRegistry([
    { url: "https://dev12345.service-now.com" },
  ]);
  try {
    const res = runCli(["run", "--all"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /has no "instances" map/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- --all aggregate reporters emit ONE valid document (CC-20) -------------

test("CLI run --all --format junit emits a single JUnit document (CC-20)", () => {
  const dir = projectWithRegistry({
    dev: { url: "https://dev12345.service-now.com" },
    prod: { url: "https://prod98765.service-now.com" },
  });
  try {
    const res = runCli(
      [
        "run",
        "--all",
        "--only",
        "instance-url-configured",
        "--format",
        "junit",
      ],
      { cwd: dir },
    );
    assert.equal(res.status, 0, res.stderr);
    // Exactly one prolog and one <testsuites> root — not concatenated documents.
    assert.equal((res.stdout.match(/<\?xml/g) ?? []).length, 1);
    assert.equal((res.stdout.match(/<testsuites\b/g) ?? []).length, 1);
    // One <testsuite> per instance, named after it.
    assert.match(res.stdout, /<testsuite name="dev"/);
    assert.match(res.stdout, /<testsuite name="prod"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI run --all --format sarif emits a single SARIF log with a run per instance (CC-20)", () => {
  const dir = projectWithRegistry({
    dev: { url: "https://dev12345.service-now.com" },
    prod: { url: "https://prod98765.service-now.com" },
  });
  try {
    const res = runCli(
      [
        "run",
        "--all",
        "--only",
        "instance-url-configured",
        "--format",
        "sarif",
      ],
      { cwd: dir },
    );
    assert.equal(res.status, 0, res.stderr);
    // The whole output parses as one JSON SARIF log (not concatenated docs).
    const log = JSON.parse(res.stdout);
    assert.equal(log.version, "2.1.0");
    assert.equal(log.runs.length, 2);
    const ids = log.runs.map((r) => r.automationDetails.id).sort();
    assert.deepEqual(ids, ["dev", "prod"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Argument-parser hardening (CC-22 / CC-23 / CC-24) ---------------------

test("CLI rejects an unknown option (CC-23, exit 2)", () => {
  const res = runCli(["--bogus"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /Unknown option "--bogus"/);
});

test("CLI rejects a value-flag with no value at the end of argv (CC-24, exit 2)", () => {
  const res = runCli(["--instance"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--instance requires a value/);
});

test("CLI rejects a value-flag that would swallow the next option (CC-24, exit 2)", () => {
  // `--only` must not eat `--format` as its value and drop `json` on the floor.
  const res = runCli(["--only", "--format", "json"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--only requires a value/);
});

test("CLI rejects an empty --only value (CC-22, exit 2)", () => {
  const res = runCli(["--only", ""]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /at least one check name/);
});

test("CLI rejects an empty --skip= inline value (CC-22, exit 2)", () => {
  const res = runCli(["--skip="]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /at least one check name/);
});

// --- Split exit codes: usage (2) vs check failure (1) (CC-41) --------------

test("CLI splits exit codes: a check failure is 1, a usage error is 2 (CC-41)", () => {
  // A check that runs and fails → exit 1.
  const failed = runCli([
    "--only",
    "instance-url-configured",
    "--format",
    "json",
  ]);
  assert.equal(failed.status, 1);
  const report = JSON.parse(failed.stdout);
  assert.equal(report.ok, false);

  // A malformed invocation never runs a check → exit 2.
  const misused = runCli(["--nope"]);
  assert.equal(misused.status, 2);
  assert.match(misused.stderr, /Unknown option "--nope"/);
});

// --- Config-file proxy / noProxy reach the client (SR-5) -------------------

/**
 * A minimal CONNECT-capturing mock proxy. Its `connect` handler records the
 * target of every CONNECT the instant it arrives — BEFORE any tunnelling — and
 * then tears the socket down with a 502. We only assert that a CONNECT reached
 * the proxy, not that a real tunnel was established. Kept local to this file
 * (test files do not cross-import).
 */
async function startCapturingProxy() {
  const connects = [];
  const server = createHttpServer();
  server.on("connect", (req, clientSocket) => {
    connects.push(req.url); // e.g. "localhost:39999"
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); // no real tunnel needed
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    connects,
    async stop() {
      server.close();
      await once(server, "close");
    },
  };
}

test("CLI forwards the --config proxy / noProxy settings to the client (SR-5)", async () => {
  // Regression guard for cli.ts runOneInstance: the loaded config's `proxy` and
  // `noProxy` must be forwarded to createSnClient. The proxy is configured ONLY
  // via the --config file (never SNPF_PROXY/HTTPS_PROXY), so a dropped
  // passthrough cannot be masked by resolveProxy's env fallbacks. The single
  // https:// dial is made by connectivity-auth, which only fires when
  // credentials are present — hence SNPF_USER / SNPF_PASS via the env. We assert
  // only on whether the mock proxy saw a CONNECT; the CLI's exit status/stdout
  // are irrelevant (the fake target is unreachable, so the check fails anyway).
  // The proxy runs in this process, so the CLI must be launched with the async
  // `runCliAsync` (never the synchronous `runCli`) — see its doc comment.
  const proxy = await startCapturingProxy();
  const dir = mkdtempSync(join(tmpdir(), "snpf-proxy-"));
  try {
    // (1) With `proxy` set and no bypass, the https dial must tunnel through the
    // proxy: the mock records a CONNECT to the instance host:port.
    const withProxyCfg = join(dir, "with-proxy.config.json");
    writeFileSync(
      withProxyCfg,
      JSON.stringify({
        instanceUrl: "https://localhost:39999",
        proxy: proxy.url,
        select: { only: ["connectivity-auth"] },
      }),
    );
    await runCliAsync(["--config", withProxyCfg], {
      cwd: dir,
      env: { SNPF_USER: "u", SNPF_PASS: "p" },
    });
    // A CONNECT for the instance proves the `proxy` passthrough survived.
    // (Drop it → no proxy → no CONNECT → empty array → this assertion fails.)
    assert.ok(
      proxy.connects.some((c) => c.includes("localhost:39999")),
      `expected a CONNECT to the instance, got ${JSON.stringify(proxy.connects)}`,
    );

    // (2) With `noProxy: "localhost"`, the bypass must reach the client so the
    // request goes direct — the proxy records NO CONNECT.
    proxy.connects.length = 0;
    const noProxyCfg = join(dir, "no-proxy.config.json");
    writeFileSync(
      noProxyCfg,
      JSON.stringify({
        instanceUrl: "https://localhost:39999",
        proxy: proxy.url,
        noProxy: "localhost",
        select: { only: ["connectivity-auth"] },
      }),
    );
    await runCliAsync(["--config", noProxyCfg], {
      cwd: dir,
      env: { SNPF_USER: "u", SNPF_PASS: "p" },
    });
    // No CONNECT proves the `noProxy` passthrough survived.
    // (Drop it → proxy still used → a CONNECT appears → this assertion fails.)
    assert.equal(
      proxy.connects.length,
      0,
      `expected no CONNECT with noProxy set, got ${JSON.stringify(proxy.connects)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await proxy.stop();
  }
});
