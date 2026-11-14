// RR-11b (DEV-9): unknown check names in --only / --skip / config `select`
// are a usage error (exit 2) with a did-you-mean hint, and the policy,
// per-check options and selection share one known-name set.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const dir = mkdtempSync(join(tmpdir(), "snpf-select-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("run --only with an unknown name exits 2 and points at list", () => {
  withTempDir((dir) => {
    const res = runCli(["run", "--only", "nope"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(
      res.stderr,
      /--only names unknown check\(s\): nope\. Run "servicenow-preflight list"\./,
    );
    assert.equal(res.stdout, "");
  });
});

test("run --skip with an unknown name exits 2", () => {
  withTempDir((dir) => {
    const res = runCli(["run", "--skip=nope"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--skip names unknown check\(s\): nope/);
    assert.match(res.stderr, /servicenow-preflight list/);
  });
});

test("a typo next to a valid name exits 2 and suggests the nearest name", () => {
  withTempDir((dir) => {
    const res = runCli(
      ["run", "--only", "secret-in-scripts,conection-credentials"],
      { cwd: dir },
    );
    assert.equal(res.status, 2);
    assert.match(res.stderr, /unknown check\(s\): conection-credentials\./);
    assert.match(
      res.stderr,
      /Did you mean: "conection-credentials" → connection-credentials\?/,
    );
  });
});

test("config select.only with a typo exits 2 naming the config key", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ select: { only: ["platfrom-release"] } }),
    );
    const res = runCli(["run"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(
      res.stderr,
      /Config select\.only names unknown check\(s\): platfrom-release/,
    );
    assert.match(res.stderr, /platform-release/);
  });
});

test("config select.skip with a typo exits 2", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ select: { skip: ["nope"] } }),
    );
    const res = runCli(["run"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Config select\.skip names unknown check\(s\)/);
  });
});

test("a CLI --only overrides a config select.only typo", () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, "preflight.config.json"),
      JSON.stringify({ select: { only: ["nope"] } }),
    );
    const res = runCli(["run", "--only", "platform-release"], { cwd: dir });
    assert.doesNotMatch(res.stderr, /unknown check/);
    assert.notEqual(res.status, 2);
  });
});

test("doctor --only with an unknown name exits 2", () => {
  withTempDir((dir) => {
    const res = runCli(["doctor", "--only", "nope"], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /--only names unknown check\(s\): nope/);
  });
});

test("--severity test-drift=off is accepted (one shared name set)", () => {
  withTempDir((dir) => {
    const res = runCli(
      ["run", "--only", "platform-release", "--severity", "test-drift=off"],
      { cwd: dir },
    );
    assert.doesNotMatch(res.stderr, /unknown check/);
    assert.notEqual(res.status, 2);
  });
});
