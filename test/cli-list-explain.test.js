import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultChecks } from "../build/index.js";

const BIN = fileURLToPath(
  new URL("../bin/servicenow-preflight.cjs", import.meta.url),
);

// No SNPF_* env, an empty cwd: list/explain need no config or network.
function runCli(args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("SNPF_")) delete env[key];
  }
  const cwd = mkdtempSync(join(tmpdir(), "snpf-list-"));
  try {
    return spawnSync(process.execPath, [BIN, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("list prints one line per default check plus a drift-only line", () => {
  const res = runCli(["list"]);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split("\n");
  assert.equal(lines.length, defaultChecks.length + 1);
  assert.equal(defaultChecks.length, 33);
  const drift = lines.filter((l) => l.includes("(drift only)"));
  assert.equal(drift.length, 1);
  assert.match(drift[0], /^test-drift /);
  assert.match(
    lines.find((l) => l.startsWith("table-crud-acl ")),
    /blocker\s+1\.1\s+/,
  );
});

test("list --format json parses as the catalogue", () => {
  const res = runCli(["list", "--format", "json"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.length, 34);
  const drift = out.find((d) => d.name === "test-drift");
  assert.equal(drift.inDefaultSuite, false);
  assert.equal(typeof out[0].meta, "object");
  assert.deepEqual(JSON.parse(runCli(["list", "--json"]).stdout), out);
});

test("explain shows rule title, tables, verdicts and remediation", () => {
  const res = runCli(["explain", "table-crud-acl"]);
  assert.equal(res.status, 0, res.stderr);
  const check = defaultChecks.find((c) => c.name === "table-crud-acl");
  assert.ok(res.stdout.includes(check.meta.remediation));
  assert.match(res.stdout, /Rule:\s+1\.1 — Every custom table has CRUD ACLs/);
  assert.match(res.stdout, /Tables:\s+sys_db_object, sys_security_acl/);
  assert.match(res.stdout, /^ {2}fail {2}/m);

  const drift = runCli(["explain", "test-drift"]);
  assert.equal(drift.status, 0);
  assert.match(drift.stdout, /^test-drift \(drift only\)/);
  assert.doesNotMatch(drift.stdout, /Rule:/);
});

test("explain --format json parses as one descriptor", () => {
  const res = runCli(["explain", "atf-run", "--format=json"]);
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.name, "atf-run");
  assert.equal(out.inDefaultSuite, true);
  assert.equal(typeof out.meta.remediation, "string");
});

test("explain of an unknown check exits 2 with suggestions", () => {
  const res = runCli(["explain", "table-crud"]);
  assert.equal(res.status, 2);
  assert.match(
    res.stderr,
    /Unknown check "table-crud"\. Run "servicenow-preflight list"\. Did you mean: table-crud-acl\?/,
  );
  const none = runCli(["explain", "nope"]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /Unknown check "nope"/);
  assert.equal(none.stdout, "");
});

test("list/explain refuse bad arguments with exit 2", () => {
  for (const args of [
    ["explain"],
    ["explain", "atf-run", "atf-enablement"],
    ["list", "extra"],
    ["list", "--format", "sarif"],
    ["explain", "atf-run", "--format", "junit"],
  ]) {
    const res = runCli(args);
    assert.equal(res.status, 2, args.join(" "));
  }
});
