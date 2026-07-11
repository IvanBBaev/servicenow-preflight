import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeDrift,
  stalenessResults,
  FRESHNESS_CHECK,
  DEFAULT_STALE_WARN_MS,
} from "../../build/state/drift.js";

/**
 * Build a `StateManifest` fixture. `tests` is a list of `[id, name, active?]`
 * tuples; `active` is omitted from the entry when left undefined so we can
 * exercise both the "active field present" and "active field absent" branches
 * of `isActive` (which treats only an explicit `active: false` as inactive).
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

test("identical manifests produce no drift and a clean promote", () => {
  const source = manifest("staging", [
    ["x/a", "A"],
    ["x/b", "B"],
  ]);
  const target = manifest("prod", [
    ["x/a", "A"],
    ["x/b", "B"],
  ]);
  const drift = computeDrift(source, target);

  assert.equal(drift.ok, true);
  assert.deepEqual(drift.missingOnTarget, []);
  assert.deepEqual(drift.extraOnTarget, []);
  assert.equal(drift.sourceActiveCount, 2);
  assert.equal(drift.targetCount, 2);
  assert.equal(drift.source, "staging");
  assert.equal(drift.target, "prod");
});

test("an active source test missing on the target is the blocking drift", () => {
  const source = manifest("staging", [
    ["x/a", "A"],
    ["x/b", "B"],
  ]);
  const target = manifest("prod", [["x/a", "A"]]);
  const drift = computeDrift(source, target);

  // x/b is validated upstream but absent downstream -> blocks the promote.
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.missingOnTarget, [{ id: "x/b", name: "B" }]);
  assert.deepEqual(drift.extraOnTarget, []);
  assert.equal(drift.sourceActiveCount, 2);
  assert.equal(drift.targetCount, 1);
});

test("a target-only test is informational (extraOnTarget), not blocking", () => {
  const source = manifest("staging", [["x/a", "A"]]);
  const target = manifest("prod", [
    ["x/a", "A"],
    ["x/legacy", "Legacy"],
  ]);
  const drift = computeDrift(source, target);

  assert.equal(drift.ok, true);
  assert.deepEqual(drift.missingOnTarget, []);
  assert.deepEqual(drift.extraOnTarget, [{ id: "x/legacy", name: "Legacy" }]);
  assert.equal(drift.sourceActiveCount, 1);
  assert.equal(drift.targetCount, 2);
});

test("direction matters: swapping source and target flips the buckets", () => {
  const staging = manifest("staging", [
    ["x/a", "A"],
    ["x/b", "B"],
  ]);
  const prod = manifest("prod", [["x/a", "A"]]);

  // staging -> prod: x/b is missing downstream (blocks).
  const forward = computeDrift(staging, prod);
  assert.equal(forward.ok, false);
  assert.deepEqual(forward.missingOnTarget, [{ id: "x/b", name: "B" }]);
  assert.deepEqual(forward.extraOnTarget, []);

  // prod -> staging: x/b is now extra on the target (informational only).
  const reverse = computeDrift(prod, staging);
  assert.equal(reverse.ok, true);
  assert.deepEqual(reverse.missingOnTarget, []);
  assert.deepEqual(reverse.extraOnTarget, [{ id: "x/b", name: "B" }]);
});

test("an inactive source test missing downstream does not block the promote", () => {
  const source = manifest("staging", [
    ["x/a", "A"],
    ["x/b", "B", false],
  ]);
  const target = manifest("prod", [["x/a", "A"]]);
  const drift = computeDrift(source, target);

  // The deactivated x/b is intentionally missing; not a regression.
  assert.equal(drift.ok, true);
  assert.equal(drift.sourceActiveCount, 1);
  assert.deepEqual(drift.missingOnTarget, []);
});

test("a test with active === true is treated as active", () => {
  const source = manifest("staging", [["x/a", "A", true]]);
  const target = manifest("prod", []);
  const drift = computeDrift(source, target);

  assert.equal(drift.sourceActiveCount, 1);
  assert.equal(drift.ok, false);
  assert.deepEqual(drift.missingOnTarget, [{ id: "x/a", name: "A" }]);
});

test("an inactive source test present on the target is neither missing nor extra", () => {
  // x/b is inactive on the source but exists on the target: it is filtered out
  // of the source-active set (so not missing) and, because it exists on the
  // source index, is not extra either.
  const source = manifest("staging", [
    ["x/a", "A"],
    ["x/b", "B", false],
  ]);
  const target = manifest("prod", [
    ["x/a", "A"],
    ["x/b", "B"],
  ]);
  const drift = computeDrift(source, target);

  assert.equal(drift.ok, true);
  assert.equal(drift.sourceActiveCount, 1);
  assert.equal(drift.targetCount, 2);
  assert.deepEqual(drift.missingOnTarget, []);
  assert.deepEqual(drift.extraOnTarget, []);
});

test("an active source test whose only target copy is inactive is MISSING (CC-3)", () => {
  // The target still carries a row for x/b, but it is deactivated there. A
  // deactivated test does not run, so for drift purposes it is *absent*: the
  // active source coverage x/b has no live counterpart downstream and must
  // block the promote. (Against the old code, which indexed target.tests
  // unfiltered, x/b would match the dead row and drift would wrongly pass.)
  const source = manifest("staging", [
    ["x/a", "A"],
    ["x/b", "B"],
  ]);
  const target = manifest("prod", [
    ["x/a", "A"],
    ["x/b", "B", false],
  ]);
  const drift = computeDrift(source, target);

  assert.equal(drift.ok, false);
  assert.deepEqual(drift.missingOnTarget, [{ id: "x/b", name: "B" }]);
  assert.deepEqual(drift.extraOnTarget, []);
  assert.equal(drift.sourceActiveCount, 2);
  // targetCount reflects only the ACTIVE target tests now (x/a); x/b is dead.
  assert.equal(drift.targetCount, 1);
});

test("drift buckets are sorted by logical id", () => {
  const source = manifest("staging", [
    ["x/z", "Z"],
    ["x/a", "A"],
    ["x/m", "M"],
  ]);
  const target = manifest("prod", [
    ["x/y", "Y"],
    ["x/b", "B"],
  ]);
  const drift = computeDrift(source, target);

  assert.deepEqual(
    drift.missingOnTarget.map((e) => e.id),
    ["x/a", "x/m", "x/z"],
  );
  assert.deepEqual(
    drift.extraOnTarget.map((e) => e.id),
    ["x/b", "x/y"],
  );
});

test("empty manifests on both sides yield an empty, ok report", () => {
  const drift = computeDrift(manifest("staging", []), manifest("prod", []));

  assert.equal(drift.ok, true);
  assert.equal(drift.sourceActiveCount, 0);
  assert.equal(drift.targetCount, 0);
  assert.deepEqual(drift.missingOnTarget, []);
  assert.deepEqual(drift.extraOnTarget, []);
  assert.equal(drift.source, "staging");
  assert.equal(drift.target, "prod");
});

test("simultaneous missing and extra drift are reported in their own buckets", () => {
  const source = manifest("staging", [
    ["x/a", "A"],
    ["x/only-source", "OnlySource"],
  ]);
  const target = manifest("prod", [
    ["x/a", "A"],
    ["x/only-target", "OnlyTarget"],
  ]);
  const drift = computeDrift(source, target);

  assert.equal(drift.ok, false);
  assert.deepEqual(drift.missingOnTarget, [
    { id: "x/only-source", name: "OnlySource" },
  ]);
  assert.deepEqual(drift.extraOnTarget, [
    { id: "x/only-target", name: "OnlyTarget" },
  ]);
});

// ---------------------------------------------------------------------------
// stalenessResults — manifest freshness (drift --max-age gate)
// ---------------------------------------------------------------------------

/** A fixed reference "now" so age assertions are deterministic. */
const NOW = Date.parse("2026-07-10T00:00:00.000Z");
const DAY_MS = 86_400_000;

/** Build a manifest tagged with a `syncedAt` (`undefined` omits the field). */
function synced(instance, syncedAt) {
  return {
    instance,
    tests: [],
    suites: [],
    ...(syncedAt === undefined ? {} : { syncedAt }),
  };
}

/** An ISO timestamp `days` before {@link NOW}. */
function daysAgo(days) {
  return new Date(NOW - days * DAY_MS).toISOString();
}

test("DEFAULT_STALE_WARN_MS is 30 days", () => {
  assert.equal(DEFAULT_STALE_WARN_MS, 30 * DAY_MS);
});

test("stalenessResults returns nothing when every manifest is fresh", () => {
  const refs = [
    { role: "source", manifest: synced("staging", daysAgo(1)) },
    { role: "target", manifest: synced("prod", daysAgo(2)) },
  ];
  assert.deepEqual(stalenessResults(refs, { now: NOW }), []);
});

test("stalenessResults warns when a manifest is older than the warn threshold", () => {
  const refs = [{ role: "source", manifest: synced("staging", daysAgo(40)) }];
  const results = stalenessResults(refs, { now: NOW });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, FRESHNESS_CHECK);
  assert.equal(results[0].status, "warn");
  assert.match(results[0].message, /source "staging"/);
  assert.match(results[0].message, /older than/);
});

test("stalenessResults fails a manifest older than --max-age", () => {
  const refs = [{ role: "source", manifest: synced("staging", daysAgo(10)) }];
  const results = stalenessResults(refs, {
    now: NOW,
    warnAfterMs: DEFAULT_STALE_WARN_MS,
    maxAgeMs: 7 * DAY_MS,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, FRESHNESS_CHECK);
  assert.equal(results[0].status, "fail");
  assert.match(results[0].message, /--max-age/);
  assert.match(results[0].message, /exceeding/);
});

test("stalenessResults ignores a missing syncedAt when no --max-age is set", () => {
  const refs = [{ role: "source", manifest: synced("staging", undefined) }];
  // Without a hard age gate an unknown freshness is not surfaced at all.
  assert.deepEqual(stalenessResults(refs, { now: NOW }), []);
});

test("stalenessResults fails closed on a missing syncedAt under --max-age", () => {
  const refs = [{ role: "source", manifest: synced("staging", undefined) }];
  const results = stalenessResults(refs, { now: NOW, maxAgeMs: 7 * DAY_MS });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "fail");
  assert.match(results[0].message, /no recorded syncedAt/);
});

test("stalenessResults fails closed on an unparseable syncedAt under --max-age", () => {
  const refs = [{ role: "source", manifest: synced("staging", "not-a-date") }];
  const results = stalenessResults(refs, { now: NOW, maxAgeMs: 7 * DAY_MS });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "fail");
  assert.match(results[0].message, /no recorded syncedAt/);
});

test("stalenessResults formats a sub-second age as 0s and defaults now to Date.now", () => {
  const refs = [
    {
      role: "source",
      manifest: synced("staging", new Date(Date.now() - 500).toISOString()),
    },
  ];
  // warnAfterMs: 0 makes any positive age warn; omitting `now` exercises the
  // Date.now() default, and a ~500 ms age renders as the "0s" sub-second floor.
  const results = stalenessResults(refs, { warnAfterMs: 0 });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, "warn");
  assert.match(results[0].message, /0s/);
});
