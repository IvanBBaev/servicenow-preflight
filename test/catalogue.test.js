import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultChecks,
  describeChecks,
  findCheck,
  testDrift,
} from "../build/index.js";

const NO_TABLES = new Set(["instance-url-configured", "connectivity-auth"]);

test("every default check declares verdicts, severity and tables", () => {
  for (const check of defaultChecks) {
    const meta = check.meta;
    assert.ok(meta, `${check.name} has no meta`);
    for (const verdict of ["pass", "warn", "fail"]) {
      assert.equal(typeof meta.verdicts?.[verdict], "string", check.name);
      assert.ok(meta.verdicts[verdict].length > 0, check.name);
    }
    assert.ok(
      meta.severity === "blocker" || meta.severity === "advisory",
      check.name,
    );
    assert.ok(Array.isArray(meta.tables), `${check.name} tables`);
    if (!NO_TABLES.has(check.name)) {
      assert.ok(meta.tables.length > 0, `${check.name} reads no tables`);
    }
    assert.ok(meta.remediation && meta.remediation.length > 0, check.name);
    assert.equal(meta.offline, undefined, check.name);
    assert.equal(meta.serial, undefined, check.name);
  }
});

test("advisory checks are the five that never fail on a finding", () => {
  const advisory = defaultChecks
    .filter((check) => check.meta?.severity === "advisory")
    .map((check) => check.name)
    .sort();
  assert.deepEqual(advisory, [
    "mobile-menu-hygiene",
    "module-roles",
    "portal-roles",
    "scheduled-job-run-as",
    "script-hygiene",
  ]);
});

test("certification rule ids look like CHECKLIST headings", () => {
  for (const check of [...defaultChecks, testDrift]) {
    const rule = check.meta?.rule;
    if (rule !== undefined) assert.match(rule, /^\d+\.\d+$/, check.name);
  }
  assert.equal(findCheck("table-crud-acl").meta.rule, "1.1");
});

test("describeChecks covers the default suite in order", () => {
  const described = describeChecks(defaultChecks);
  assert.equal(described.length, 23);
  assert.deepEqual(
    described.map((d) => d.name),
    defaultChecks.map((c) => c.name),
  );
  assert.ok(described.every((d) => d.inDefaultSuite));
});

test("describeChecks tolerates a check without meta and preserves order", () => {
  const bare = { name: "zz-bare", description: "Bare.", run: () => undefined };
  const described = describeChecks([bare, testDrift]);
  assert.deepEqual(
    described.map((d) => d.name),
    ["zz-bare", "test-drift"],
  );
  assert.deepEqual(described[0].meta, {});
  assert.equal(described[0].inDefaultSuite, false);
  assert.equal(described[1].inDefaultSuite, false);
  assert.equal(describeChecks([bare], [bare])[0].inDefaultSuite, true);
});

test("findCheck finds test-drift though it is not in the default suite", () => {
  assert.equal(findCheck("test-drift"), testDrift);
  assert.equal(findCheck("table-crud-acl")?.name, "table-crud-acl");
  assert.equal(findCheck("nope"), undefined);
  assert.equal(findCheck("test-drift", defaultChecks), undefined);
});
