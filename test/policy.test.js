import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyPolicy,
  policySkips,
  validatePolicy,
} from "../build/api/checks.js";
import { parseSeverityFlag } from "../build/api/internal.js";
import { readBaseline } from "../build/api/report.js";
import { UsageError } from "../build/config.js";
import { reportOf } from "./helpers/json-report.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

function runCli(args, { cwd } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_")) delete env[key];
  }
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: cwd ?? tmpdir(),
    env,
    encoding: "utf8",
  });
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "snpf-policy-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function report(results) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const r of results) summary[r.status] += 1;
  return { ok: summary.fail === 0, results, summary };
}

test("applyPolicy promotes a warn to fail and flips ok", () => {
  const r = report([
    { name: "scheduled-job-run-as", status: "warn", message: "1 job" },
    { name: "table-namespace", status: "pass", message: "fine" },
  ]);
  const out = applyPolicy(r, {
    "scheduled-job-run-as": "fail",
    "table-namespace": "fail",
  });
  assert.equal(out.ok, false);
  assert.deepEqual(out.summary, { pass: 1, warn: 0, fail: 1 });
  assert.deepEqual(out.results[0], {
    name: "scheduled-job-run-as",
    status: "fail",
    message: "1 job [severity: fail by policy]",
  });
  // pass rows are untouched; input is not mutated.
  assert.equal(out.results[1], r.results[1]);
  assert.equal(r.results[0].status, "warn");
});

test("applyPolicy demotes a fail to warn and flips ok", () => {
  const out = applyPolicy(
    report([{ name: "table-namespace", status: "fail", message: "x" }]),
    { "table-namespace": "warn" },
  );
  assert.equal(out.ok, true);
  assert.equal(out.results[0].status, "warn");
  assert.equal(out.results[0].message, "x [severity: warn by policy]");
});

test("applyPolicy adds no suffix when the status is unchanged or unlisted", () => {
  const r = report([
    { name: "a", status: "fail", message: "m" },
    { name: "b", status: "warn", message: "n" },
    { name: "c", status: "fail", message: "o" },
  ]);
  const out = applyPolicy(r, { a: "fail", b: "warn", c: "off" });
  assert.deepEqual(out.results, r.results);
  assert.equal(out.ok, false);
  // Inherited object keys are not policy entries.
  assert.deepEqual(
    applyPolicy(
      report([{ name: "toString", status: "warn", message: "t" }]),
      {},
    ).results[0].message,
    "t",
  );
});

test("policySkips lists the checks turned off", () => {
  assert.deepEqual(policySkips({ a: "off", b: "fail", c: "off" }), ["a", "c"]);
  assert.deepEqual(policySkips({}), []);
});

test("validatePolicy lists every unknown name", () => {
  validatePolicy({ a: "fail" }, ["a", "b"]);
  assert.throws(
    () => validatePolicy({ a: "fail", typo: "warn", other: "off" }, ["a"]),
    (err) =>
      err instanceof UsageError &&
      /unknown check\(s\): typo, other/.test(err.message),
  );
});

test("parseSeverityFlag parses name=level and rejects malformed values", () => {
  assert.deepEqual(parseSeverityFlag("table-namespace=warn"), [
    "table-namespace",
    "warn",
  ]);
  assert.deepEqual(parseSeverityFlag(" a = off "), ["a", "off"]);
  for (const bad of ["name", "name=", "=fail", "name=maybe"]) {
    assert.throws(
      () => parseSeverityFlag(bad),
      (err) => err instanceof UsageError,
      bad,
    );
  }
});

// --- CLI ---------------------------------------------------------------------

test("CLI: --severity with an unknown level exits 2", () => {
  const res = runCli(["run", "--severity", "table-namespace=maybe"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /maybe/);
  const eq = runCli(["run", "--severity=table-namespace"]);
  assert.equal(eq.status, 2);
});

test("CLI: an unknown check in the config policy exits 2 before any run", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ severity: { "no-such-check": "fail" } }),
    );
    const res = runCli(["run"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown check\(s\): no-such-check/);
    assert.equal(res.stdout, "");
  });
});

test("CLI: a malformed config severity value exits 2 naming the key", () => {
  withTempDir((dir) => {
    const cfg = join(dir, "preflight.config.json");
    writeFileSync(cfg, JSON.stringify({ severity: { "atf-run": "maybe" } }));
    const res = runCli(["run"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /severity\["atf-run"\]/);
    writeFileSync(cfg, JSON.stringify({ severity: { "atf-run": 3 } }));
    assert.match(runCli(["run"], { cwd: dir }).stderr, /got number/);
    writeFileSync(cfg, JSON.stringify({ severity: ["atf-run"] }));
    assert.match(
      runCli(["run"], { cwd: dir }).stderr,
      /must be an object.*an array/,
    );
  });
});

test("CLI: --severity demotes a failing check; the flag wins over config", () => {
  withTempDir((dir) => {
    const only = ["--only", "instance-url-configured", "--json"];
    const plain = runCli(["run", ...only], { cwd: dir });
    assert.equal(plain.status, 1);

    const demoted = runCli(
      ["run", ...only, "--severity", "instance-url-configured=warn"],
      { cwd: dir },
    );
    assert.equal(demoted.status, 0, demoted.stderr);
    const out = reportOf(demoted.stdout);
    assert.match(out.results[0].message, /\[severity: warn by policy\]$/);

    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ severity: { "instance-url-configured": "warn" } }),
    );
    assert.equal(runCli(["run", ...only], { cwd: dir }).status, 0);
    const flagWins = runCli(
      ["run", ...only, "--severity=instance-url-configured=fail"],
      { cwd: dir },
    );
    assert.equal(flagWins.status, 1);
  });
});

test("CLI: severity off skips the check (the empty-selection guard still fails)", () => {
  const res = runCli([
    "run",
    "--only",
    "instance-url-configured",
    "--severity",
    "instance-url-configured=off",
    "--json",
  ]);
  assert.equal(res.status, 1);
  const out = reportOf(res.stdout);
  assert.equal(
    out.results.some((r) => r.name === "instance-url-configured"),
    false,
  );
});

test("CLI: policy runs before the baseline is recorded", () => {
  withTempDir((dir) => {
    const res = runCli(
      [
        "run",
        "--only",
        "instance-url-configured",
        "--severity",
        "instance-url-configured=warn",
        "--write-baseline",
      ],
      { cwd: dir },
    );
    assert.equal(res.status, 0, res.stderr);
    const [entry] = readBaseline(
      join(dir, ".preflight", "baseline.json"),
    ).entries;
    assert.equal(entry.status, "warn");
    assert.match(entry.message, /\[severity: warn by policy\]$/);
  });
});

test("CLI: --severity is refused outside run", () => {
  const res = runCli(["drift", "a", "b", "--severity", "atf-run=warn"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /run only/);
});
