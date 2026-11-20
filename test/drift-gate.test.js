// RR-13 (ARC-5): `drift` honours `--fail-on` and `--output` through the
// library's runDrift + evaluate; `sync`, which writes a manifest and no report,
// refuses both flags (exit 2) instead of dropping them silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reportOf } from "./helpers/json-report.js";
import { runDrift } from "../build/api/state.js";
import { evaluate } from "../build/index.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

function runCli(args, cwd) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_")) delete env[key];
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

const TESTS = [{ id: "x/a", name: "A", active: true }];
const IDENTITY = { buildName: "Xanadu", war: "glide-xanadu.war" };
const APPS = [{ id: "x_acme_app", name: "Acme App", version: "1.2.3" }];
const REGISTRY = {
  staging: { url: "https://staging.service-now.com", promotesTo: "prod" },
  prod: { url: "https://prod.service-now.com", promotesTo: null },
};

/** Fully captured manifests: a clean pair compares with no warn at all. */
function manifest(instance, extra = {}) {
  return {
    instance,
    url: REGISTRY[instance]?.url,
    syncedAt: new Date().toISOString(),
    identity: IDENTITY,
    apps: APPS,
    tests: TESTS,
    suites: [],
    ...extra,
  };
}

/** The target carries one extra test: a warn-only drift (no fail row). */
const WARN_ONLY = {
  staging: manifest("staging"),
  prod: manifest("prod", {
    tests: [...TESTS, { id: "x/extra", name: "Extra", active: true }],
  }),
};

/** The target lacks an active source test: a failing drift. */
const FAILING = {
  staging: manifest("staging", {
    tests: [...TESTS, { id: "x/b", name: "B", active: true }],
  }),
  prod: manifest("prod"),
};

function project(manifests, registry = REGISTRY) {
  const dir = mkdtempSync(join(tmpdir(), "snpf-drift-gate-"));
  mkdirSync(join(dir, ".preflight", "state"), { recursive: true });
  if (registry) {
    writeFileSync(
      join(dir, ".preflight", "instances.json"),
      JSON.stringify({ version: 1, instances: registry }),
    );
  }
  for (const [name, m] of Object.entries(manifests)) {
    writeFileSync(
      join(dir, ".preflight", "state", `${name}.state.json`),
      JSON.stringify(m),
    );
  }
  return dir;
}

function withProject(manifests, fn) {
  const dir = project(manifests);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- drift --fail-on -------------------------------------------------------

test("drift --fail-on warn exits 1 on a warn-only drift and says why", () => {
  withProject(WARN_ONLY, (dir) => {
    const plain = runCli(["drift", "staging", "prod"], dir);
    assert.equal(plain.status, 0, plain.stderr);

    for (const flag of [["--fail-on", "warn"], ["--fail-on=warn"]]) {
      const res = runCli(["drift", "staging", "prod", ...flag], dir);
      assert.equal(res.status, 1, `${flag.join(" ")}: ${res.stderr}`);
      assert.match(res.stderr, /1 warning\(s\) with --fail-on warn/);
      assert.match(res.stdout, /Extra/);
    }
  });
});

test("drift --fail-on warn records the threshold in the json envelope", () => {
  withProject(WARN_ONLY, (dir) => {
    const res = runCli(
      ["drift", "staging", "prod", "--fail-on", "warn", "--format", "json"],
      dir,
    );
    assert.equal(res.status, 1, res.stderr);
    assert.equal(JSON.parse(res.stdout).failOn, "warn");
    const report = reportOf(res.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.summary.fail, 0);
    assert.equal(report.summary.warn, 1);
  });
});

test("drift --fail-on fail keeps a warn-only drift at exit 0", () => {
  withProject(WARN_ONLY, (dir) => {
    const res = runCli(
      ["drift", "staging", "prod", "--fail-on", "fail", "--format", "json"],
      dir,
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(JSON.parse(res.stdout).failOn, undefined);
    assert.equal(reportOf(res.stdout).ok, true);
  });
});

test("drift --fail-on warn passes a drift with no warn row", () => {
  withProject(
    { staging: manifest("staging"), prod: manifest("prod") },
    (dir) => {
      const res = runCli(
        ["drift", "staging", "prod", "--fail-on", "warn"],
        dir,
      );
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stderr, "");
    },
  );
});

test("drift --fail-on rejects an unknown level (exit 2)", () => {
  withProject(WARN_ONLY, (dir) => {
    const res = runCli(["drift", "staging", "prod", "--fail-on", "info"], dir);
    assert.equal(res.status, 2);
  });
});

test("drift ignores SNPF_FAIL_ON: the threshold comes from the flag only", () => {
  withProject(WARN_ONLY, (dir) => {
    const res = spawnSync(process.execPath, [BIN, "drift", "staging", "prod"], {
      cwd: dir,
      env: { ...process.env, SNPF_FAIL_ON: "warn" },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
  });
});

// --- drift --output --------------------------------------------------------

test("drift --output writes every requested format besides stdout", () => {
  withProject(FAILING, (dir) => {
    const res = runCli(
      [
        "drift",
        "staging",
        "prod",
        "--output",
        "sarif=out/drift.sarif",
        "--output=json=out/drift.json",
        "--output",
        "junit=out/drift.xml",
        "--output",
        "markdown=out/drift.md",
      ],
      dir,
    );
    // The report files are written even though the gate blocks.
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stdout, /missing on "prod"/);

    const sarif = JSON.parse(
      readFileSync(join(dir, "out/drift.sarif"), "utf8"),
    );
    assert.equal(sarif.version, "2.1.0");
    const ruleIds = sarif.runs[0].results.map((r) => r.ruleId);
    assert.ok(ruleIds.includes("test-drift"), JSON.stringify(ruleIds));

    const json = readFileSync(join(dir, "out/drift.json"), "utf8");
    const report = reportOf(json);
    assert.equal(report.ok, false);
    assert.equal(report.results[0].name, "test-drift");
    assert.equal(report.results[0].status, "fail");

    assert.match(
      readFileSync(join(dir, "out/drift.xml"), "utf8"),
      /<testsuite[^>]*failures="1"/,
    );
    assert.match(readFileSync(join(dir, "out/drift.md"), "utf8"), /test-drift/);
  });
});

test("drift --output json matches the stdout json report exactly", () => {
  withProject(WARN_ONLY, (dir) => {
    const res = runCli(
      [
        "drift",
        "staging",
        "prod",
        "--format",
        "json",
        "--fail-on",
        "warn",
        "--output",
        "json=drift.json",
      ],
      dir,
    );
    assert.equal(res.status, 1, res.stderr);
    const file = JSON.parse(readFileSync(join(dir, "drift.json"), "utf8"));
    const out = JSON.parse(res.stdout);
    assert.deepEqual(file.runs, out.runs);
    assert.equal(file.failOn, "warn");
  });
});

test("drift writes no --output file when the compare cannot run (exit 2)", () => {
  withProject({ prod: manifest("prod") }, (dir) => {
    const res = runCli(
      ["drift", "staging", "prod", "--output", "json=drift.json"],
      dir,
    );
    assert.equal(res.status, 2);
    assert.equal(existsSync(join(dir, "drift.json")), false);
  });
});

// --- sync refuses report flags ---------------------------------------------

for (const [label, flags] of [
  ["--fail-on", ["--fail-on", "warn"]],
  ["--fail-on=", ["--fail-on=fail"]],
  ["--output", ["--output", "json=sync.json"]],
  ["--output=", ["--output=sarif=sync.sarif"]],
]) {
  test(`sync ${label} is a usage error (exit 2) before any request`, () => {
    withProject({}, (dir) => {
      const res = runCli(["sync", "staging", ...flags], dir);
      assert.equal(res.status, 2, res.stderr);
      assert.match(
        res.stderr,
        /--fail-on \/ --output apply to run and drift, not sync/,
      );
      assert.equal(existsSync(join(dir, "sync.json")), false);
      assert.equal(existsSync(join(dir, "sync.sarif")), false);
      assert.equal(
        existsSync(join(dir, ".preflight", "state", "staging.state.json")),
        false,
      );
    });
  });
}

// --- library: runDrift -----------------------------------------------------

/** The drift report the CLI prints for `manifests`, as JSON. */
function cliReport(manifests, extraArgs = []) {
  const dir = project(manifests);
  try {
    const res = runCli(
      ["drift", "staging", "prod", "--format", "json", ...extraArgs],
      dir,
    );
    return reportOf(res.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("runDrift returns the same report the CLI prints", async () => {
  for (const manifests of [WARN_ONLY, FAILING]) {
    const report = await runDrift({
      source: { name: "staging", manifest: manifests.staging },
      target: { name: "prod", manifest: manifests.prod },
      registry: { version: 1, instances: REGISTRY },
    });
    const strip = (r) => ({
      ...r,
      results: r.results.map((row) => {
        const rest = { ...row };
        delete rest.durationMs;
        return rest;
      }),
    });
    assert.deepEqual(strip(report), strip(cliReport(manifests)));
  }
});

test("runDrift + evaluate gives the CLI's --fail-on warn decision", async () => {
  const raw = await runDrift({
    source: { name: "staging", manifest: WARN_ONLY.staging },
    target: { name: "prod", manifest: WARN_ONLY.prod },
    registry: { version: 1, instances: REGISTRY },
  });
  assert.equal(raw.ok, true);
  assert.equal(evaluate(raw).ok, true);
  const strict = evaluate(raw, { failOn: "warn" });
  assert.equal(strict.ok, false);
  assert.equal(strict.failOn, "warn");
  assert.equal(strict.ok, cliReport(WARN_ONLY, ["--fail-on", "warn"]).ok);
});

test("runDrift without a registry warns on promotion order", async () => {
  const report = await runDrift({
    source: { name: "staging", manifest: manifest("staging") },
    target: { name: "prod", manifest: manifest("prod") },
  });
  const order = report.results.find((r) => r.name === "promotion-order");
  assert.equal(order.status, "warn");
  assert.equal(report.ok, true);
});

test("runDrift applies maxAgeMs and allowStageSkip like --max-age / --allow-stage-skip", async () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const old = "2026-11-01T00:00:00Z";
  const stale = await runDrift({
    source: {
      name: "staging",
      manifest: manifest("staging", { syncedAt: old }),
    },
    target: { name: "prod", manifest: manifest("prod", { syncedAt: old }) },
    registry: { version: 1, instances: REGISTRY },
    maxAgeMs: 7 * 86_400_000,
    now,
  });
  assert.equal(stale.ok, false);
  assert.ok(
    stale.results.some(
      (r) => r.name === "manifest-freshness" && r.status === "fail",
    ),
    JSON.stringify(stale.results.map((r) => [r.name, r.status])),
  );

  const chain = {
    dev: { url: "https://dev.service-now.com", promotesTo: "staging" },
    staging: { url: "https://staging.service-now.com", promotesTo: "prod" },
    prod: { url: "https://prod.service-now.com", promotesTo: null },
  };
  const skip = (allowStageSkip) =>
    runDrift({
      source: { name: "dev", manifest: manifest("dev") },
      target: { name: "prod", manifest: manifest("prod") },
      registry: { version: 1, instances: chain },
      allowStageSkip,
    }).then((r) => r.results.find((x) => x.name === "promotion-order").status);
  assert.equal(await skip(false), "fail");
  assert.equal(await skip(true), "warn");
});

test("runDrift fails closed on an aborted signal", async () => {
  const report = await runDrift({
    source: { name: "staging", manifest: manifest("staging") },
    target: { name: "prod", manifest: manifest("prod") },
    registry: { version: 1, instances: REGISTRY },
    signal: AbortSignal.abort(),
  });
  assert.equal(report.ok, false);
  assert.equal(report.results[0].name, "test-drift");
  assert.equal(report.results[0].status, "fail");
});
