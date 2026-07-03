import { test } from "node:test";
import assert from "node:assert/strict";

import { testDrift } from "../../build/checks/test-drift.js";

/**
 * Build a `StateManifest` fixture. `tests` is a list of `[id, name, active?]`
 * tuples; `active` is omitted from the entry when left undefined.
 */
function manifest(instance, tests) {
  return {
    instance,
    tests: tests.map(([id, name, active]) => ({
      id,
      name,
      ...(active === undefined ? {} : { active }),
    })),
    suites: [],
  };
}

test("exposes a stable check name and description", () => {
  assert.equal(testDrift.name, "test-drift");
  assert.equal(typeof testDrift.description, "string");
  assert.ok(testDrift.description.length > 0);
});

test("warns when neither manifest is present (single-instance run)", () => {
  const result = testDrift.run({});
  assert.equal(result.name, "test-drift");
  assert.equal(result.status, "warn");
  assert.match(result.message, /No source\/target manifest/);
});

test("warns when only the source manifest is present", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [["x/a", "A"]]),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No source\/target manifest/);
});

test("warns when only the drift target manifest is present", () => {
  const result = testDrift.run({
    driftTarget: manifest("prod", [["x/a", "A"]]),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No source\/target manifest/);
});

test("fails when an active source test is missing on the promote target", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [
      ["x/a", "A"],
      ["x/b", "B"],
    ]),
    driftTarget: manifest("prod", [["x/a", "A"]]),
  });

  assert.equal(result.name, "test-drift");
  assert.equal(result.status, "fail");
  // Message names the source, target and the drifted test.
  assert.match(result.message, /1 test\(s\)/);
  assert.match(result.message, /present on "staging"/);
  assert.match(result.message, /missing on "prod"/);
  assert.match(result.message, /\bB\b/);
});

test("fail message truncates to three names with a '+N more' tail (>3 drift)", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [
      ["x/a", "Alpha"],
      ["x/b", "Bravo"],
      ["x/c", "Charlie"],
      ["x/d", "Delta"],
      ["x/e", "Echo"],
    ]),
    driftTarget: manifest("prod", []),
  });

  assert.equal(result.status, "fail");
  assert.match(result.message, /5 test\(s\)/);
  // Entries are sorted by id (a,b,c,d,e); only the first three names are shown.
  assert.match(result.message, /Alpha; Bravo; Charlie/);
  assert.match(result.message, /\(\+2 more\)/);
  // The truncated names must NOT appear in the rendered list.
  assert.doesNotMatch(result.message, /Delta/);
  assert.doesNotMatch(result.message, /Echo/);
});

test("exactly three drift entries render without a '+N more' tail", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [
      ["x/a", "Alpha"],
      ["x/b", "Bravo"],
      ["x/c", "Charlie"],
    ]),
    driftTarget: manifest("prod", []),
  });

  assert.equal(result.status, "fail");
  assert.match(result.message, /Alpha; Bravo; Charlie/);
  assert.doesNotMatch(result.message, /more\)/);
});

test("a drifted test with an empty name falls back to its logical id", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [["x/nameless", ""]]),
    driftTarget: manifest("prod", []),
  });

  assert.equal(result.status, "fail");
  assert.match(result.message, /x\/nameless/);
});

test("warns when the target only carries extra tests (informational drift)", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [["x/a", "A"]]),
    driftTarget: manifest("prod", [
      ["x/a", "A"],
      ["x/legacy", "Legacy"],
    ]),
  });

  assert.equal(result.status, "warn");
  assert.match(result.message, /"prod" carries 1 test\(s\)/);
  assert.match(result.message, /not on "staging"/);
  assert.match(result.message, /Legacy/);
});

test("missing drift takes precedence over extra drift (fail wins)", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [
      ["x/a", "A"],
      ["x/only-source", "OnlySource"],
    ]),
    driftTarget: manifest("prod", [
      ["x/a", "A"],
      ["x/only-target", "OnlyTarget"],
    ]),
  });

  // Both buckets are non-empty; the check reports the blocking one.
  assert.equal(result.status, "fail");
  assert.match(result.message, /missing on "prod"/);
  assert.match(result.message, /OnlySource/);
});

test("passes when every active source test exists on the target", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [
      ["x/a", "A"],
      ["x/b", "B"],
    ]),
    driftTarget: manifest("prod", [
      ["x/a", "A"],
      ["x/b", "B"],
    ]),
  });

  assert.equal(result.name, "test-drift");
  assert.equal(result.status, "pass");
  assert.match(result.message, /No test drift/);
  assert.match(result.message, /all 2 active test\(s\)/);
  assert.match(result.message, /"staging"/);
  assert.match(result.message, /"prod"/);
});

test("passes when the only missing source test is inactive", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [
      ["x/a", "A"],
      ["x/b", "B", false],
    ]),
    driftTarget: manifest("prod", [["x/a", "A"]]),
  });

  assert.equal(result.status, "pass");
  // Only one active source test is counted.
  assert.match(result.message, /all 1 active test\(s\)/);
});

test("never throws — always returns a well-formed CheckResult", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [["x/a", "A"]]),
    driftTarget: manifest("prod", [["x/a", "A"]]),
  });

  assert.equal(result.name, "test-drift");
  assert.ok(["pass", "warn", "fail"].includes(result.status));
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
});
