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

// --- findings (F-R-5) ---------------------------------------------------------

test("emits one finding per missing and extra test, keyed on the logical id", () => {
  const result = testDrift.run({
    manifest: manifest("staging", [
      ["x/b", "B"],
      ["x/a", "A"],
    ]),
    driftTarget: manifest("prod", [["x/z", "Z"]]),
  });
  assert.equal(result.status, "fail");
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.location.logicalId, f.status]),
    [
      ["missing-on-target", "x/a", "fail"],
      ["missing-on-target", "x/b", "fail"],
      ["extra-on-target", "x/z", "warn"],
    ],
  );
  for (const f of result.findings) assert.match(f.id, /^f1:[0-9a-f]{16}$/);
  assert.match(result.findings[0].message, /"A" is active on "staging"/);
  assert.equal(new Set(result.findings.map((f) => f.id)).size, 3);
});

test("finding ids and order are stable across manifest reordering", () => {
  const run = (src, dst) =>
    testDrift.run({
      manifest: manifest("staging", src),
      driftTarget: manifest("prod", dst),
    }).findings;
  const a = run(
    [
      ["x/a", "A"],
      ["x/b", "B"],
      ["x/c", "C"],
    ],
    [
      ["x/c", "C"],
      ["x/y", "Y"],
      ["x/x", "X"],
    ],
  );
  const b = run(
    [
      ["x/c", "C"],
      ["x/b", "B"],
      ["x/a", "A"],
    ],
    [
      ["x/x", "X"],
      ["x/c", "C"],
      ["x/y", "Y"],
    ],
  );
  assert.deepEqual(a, b);
});

test("a renamed test keeps its finding id", () => {
  const run = (name) =>
    testDrift.run({
      manifest: manifest("staging", [["x/a", name]]),
      driftTarget: manifest("prod", []),
    }).findings[0].id;
  assert.equal(run("Old name"), run("New name"));
});

test("an extra-only drift warns with extra-on-target findings", () => {
  const result = testDrift.run({
    manifest: manifest("staging", []),
    driftTarget: manifest("prod", [["x/z", ""]]),
  });
  assert.equal(result.status, "warn");
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].kind, "extra-on-target");
  assert.match(result.findings[0].message, /"x\/z" exists on "prod"/);
});

test("no drift and no manifests carry no findings", () => {
  const same = manifest("staging", [["x/a", "A"]]);
  assert.equal(
    "findings" in testDrift.run({ manifest: same, driftTarget: same }),
    false,
  );
  assert.equal("findings" in testDrift.run({}), false);
});

test("more than 500 drifted tests are capped and counted", () => {
  const tests = Array.from({ length: 503 }, (_, i) => [`x/t${i}`, `T${i}`]);
  const result = testDrift.run({
    manifest: manifest("staging", tests),
    driftTarget: manifest("prod", []),
  });
  assert.equal(result.findings.length, 500);
  assert.equal(result.findingsTruncated, 3);
});
