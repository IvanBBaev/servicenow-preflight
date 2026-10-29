import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultChecks,
  describeChecks,
  findCheck,
  testDrift,
} from "../build/api/checks.js";

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
  }
});

test("only the ATF checks run serially", () => {
  const serial = defaultChecks
    .filter((check) => check.meta?.serial !== undefined)
    .map((check) => [check.name, check.meta.serial])
    .sort();
  assert.deepEqual(serial, [
    ["atf-enablement", true],
    ["atf-run", true],
  ]);
});

test("advisory checks are the nine that never fail on a finding", () => {
  const advisory = defaultChecks
    .filter((check) => check.meta?.severity === "advisory")
    .map((check) => check.name)
    .sort();
  assert.deepEqual(advisory, [
    "hardcoded-identifiers",
    "inactive-artifacts",
    "log-leftovers",
    "mobile-menu-hygiene",
    "module-roles",
    "notification-conditions",
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
  assert.equal(findCheck("deprecated-apis").meta.rule, "4.7");
  assert.equal(findCheck("inactive-artifacts").meta.rule, "6.6");
});

test("describeChecks covers the default suite in order", () => {
  const described = describeChecks(defaultChecks);
  assert.equal(described.length, 30);
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

test("closestNames suggests by prefix or small edit distance, capped at three", async () => {
  const { closestNames } = await import("../build/api/internal.js");
  const names = ["atf-run", "atf-enablement", "table-crud-acl", "ui-page-acl"];
  assert.deepEqual(closestNames("atf-runn", names), ["atf-run"]);
  assert.deepEqual(closestNames("table-crud", names), ["table-crud-acl"]);
  assert.deepEqual(closestNames("ATF", names), ["atf-run", "atf-enablement"]);
  assert.deepEqual(closestNames("zzzz", names), []);
  assert.deepEqual(closestNames("  ", names), []);
  assert.equal(closestNames("a", ["a", "b", "c", "d"]).length, 3);
});

test("RULE_TITLES covers every rule a check declares", async () => {
  const { RULE_TITLES } = await import("../build/api/internal.js");
  for (const d of describeChecks(defaultChecks)) {
    if (d.meta.rule !== undefined) {
      assert.equal(typeof RULE_TITLES[d.meta.rule], "string", d.name);
    }
  }
});
