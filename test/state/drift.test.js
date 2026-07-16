import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeDrift,
  stalenessResults,
  versionParityResults,
  FRESHNESS_CHECK,
  DEFAULT_STALE_WARN_MS,
  INSTANCE_VERSION_CHECK,
  APP_VERSION_CHECK,
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

// --- versionParityResults (OPP-1 / OPP-5) ------------------------------------

/** Build a manifest fixture with optional version-capture fields. */
function versioned(instance, { identity, apps } = {}) {
  return {
    instance,
    ...(identity ? { identity } : {}),
    ...(apps ? { apps } : {}),
    tests: [],
    suites: [],
  };
}

/** Split parity results by check name for targeted assertions. */
function byCheck(results) {
  return {
    instance: results.filter((r) => r.name === INSTANCE_VERSION_CHECK),
    apps: results.filter((r) => r.name === APP_VERSION_CHECK),
  };
}

const FULL_IDENTITY = { buildName: "Xanadu", war: "glide-xanadu-07-02-2026" };

test("version-parity check names are stable", () => {
  assert.equal(INSTANCE_VERSION_CHECK, "instance-version-parity");
  assert.equal(APP_VERSION_CHECK, "app-version-parity");
});

test("manifests that predate version capture yield exactly two advisory warns", () => {
  // Both sides written before OPP-1/OPP-5 existed: no identity, no apps. Drift
  // must degrade to an advisory — never crash, never fail purely for absence.
  const results = versionParityResults(versioned("staging"), versioned("prod"));
  assert.equal(results.length, 2);
  for (const r of results) {
    assert.equal(r.status, "warn");
    assert.match(r.message, /predates version capture/);
    assert.match(r.message, /re-run sync/);
  }
  const { instance, apps } = byCheck(results);
  assert.equal(instance.length, 1);
  assert.equal(apps.length, 1);
});

test("a single side lacking identity is named in the advisory warn", () => {
  const results = versionParityResults(
    versioned("staging", { identity: FULL_IDENTITY, apps: [] }),
    versioned("prod", { apps: [] }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance.length, 1);
  assert.equal(instance[0].status, "warn");
  assert.match(instance[0].message, /target "prod"/);
  assert.doesNotMatch(instance[0].message, /source "staging"/);
});

test("a glide.buildname mismatch fails the promote gate (OPP-1)", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: { buildName: "Xanadu", war: "w1" },
      apps: [],
    }),
    versioned("prod", {
      identity: { buildName: "Washington", war: "w1" },
      apps: [],
    }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance.length, 1);
  assert.equal(instance[0].status, "fail");
  assert.match(instance[0].message, /Xanadu/);
  assert.match(instance[0].message, /Washington/);
  assert.match(instance[0].message, /mismatch/i);
});

test("matching buildnames with differing glide.war warn on patch-level skew", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: { buildName: "Xanadu", war: "glide-a" },
      apps: [],
    }),
    versioned("prod", {
      identity: { buildName: "Xanadu", war: "glide-b" },
      apps: [],
    }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "warn");
  assert.match(instance[0].message, /patch levels differ/);
  assert.match(instance[0].message, /glide-a/);
  assert.match(instance[0].message, /glide-b/);
});

test("identical platform identities pass with explicit positive evidence", () => {
  const results = versionParityResults(
    versioned("staging", { identity: FULL_IDENTITY, apps: [] }),
    versioned("prod", { identity: FULL_IDENTITY, apps: [] }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "pass");
  assert.match(instance[0].message, /Xanadu/);
});

test("an unreadable buildname on one side warns as unverified (fail-closed)", () => {
  // Identity captured, but glide.buildname itself was ACL-hidden at sync time.
  const results = versionParityResults(
    versioned("staging", { identity: { war: "glide-a" }, apps: [] }),
    versioned("prod", { identity: FULL_IDENTITY, apps: [] }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "warn");
  assert.match(instance[0].message, /unverified/);
  assert.match(instance[0].message, /source "staging"/);
});

test("matching buildnames with an unreadable war on one side warn as unverified", () => {
  const results = versionParityResults(
    versioned("staging", { identity: { buildName: "Xanadu" }, apps: [] }),
    versioned("prod", { identity: FULL_IDENTITY, apps: [] }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "warn");
  assert.match(instance[0].message, /patch-level parity is unverified/);
});

test("an unreadable buildname on the TARGET side is named in the unverified warn", () => {
  // Mirror of the source-side case: only the target lacks glide.buildname.
  const results = versionParityResults(
    versioned("staging", { identity: FULL_IDENTITY, apps: [] }),
    versioned("prod", { identity: { war: "glide-a" }, apps: [] }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "warn");
  assert.match(instance[0].message, /unverified/);
  assert.match(instance[0].message, /target "prod"/);
  assert.doesNotMatch(instance[0].message, /source "staging"/);
});

test("both sides lacking glide.buildname pass when glide.war is identical (OPP-1 war fallback)", () => {
  // Some instances genuinely never set glide.buildname; glide.war alone still
  // pins the patch level, so an identical war on both is a legitimate pass.
  const results = versionParityResults(
    versioned("staging", { identity: { war: "glide-a" }, apps: [] }),
    versioned("prod", { identity: { war: "glide-a" }, apps: [] }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "pass");
  assert.match(instance[0].message, /not set on either instance/);
  assert.match(instance[0].message, /glide\.war/);
  assert.match(instance[0].message, /glide-a/);
});

test("both sides lacking glide.buildname warn when glide.war differs (OPP-1 war fallback)", () => {
  const results = versionParityResults(
    versioned("staging", { identity: { war: "glide-a" }, apps: [] }),
    versioned("prod", { identity: { war: "glide-b" }, apps: [] }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "warn");
  assert.match(instance[0].message, /not set on either instance/);
  assert.match(instance[0].message, /patch levels differ/);
  assert.match(instance[0].message, /glide-a/);
  assert.match(instance[0].message, /glide-b/);
});

test("both sides lacking glide.buildname warn as unverified when glide.war is unreadable", () => {
  const results = versionParityResults(
    versioned("staging", { identity: {}, apps: [] }),
    versioned("prod", { identity: { war: "glide-a" }, apps: [] }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "warn");
  assert.match(instance[0].message, /not set on either instance/);
  assert.match(instance[0].message, /unverified/);
  assert.match(instance[0].message, /source "staging"/);
});

test("a glide.buildname mismatch still FAILS even when one war is identical (fail beats war fallback)", () => {
  // Guard: the war fallback only applies when buildname is absent on BOTH sides.
  // A present-but-differing buildname must still hard-fail regardless of war.
  const results = versionParityResults(
    versioned("staging", {
      identity: { buildName: "Xanadu", war: "glide-a" },
      apps: [],
    }),
    versioned("prod", {
      identity: { buildName: "Washington", war: "glide-a" },
      apps: [],
    }),
  );
  const { instance } = byCheck(results);
  assert.equal(instance[0].status, "fail");
});

test("an app recorded on the source but missing on the target warns, not fails (OPP-5)", () => {
  // Absence alone is expected on a first-ever deploy or for in-development
  // apps — advisory, never a blocking fail (the OPP-5 false-fail fix).
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_acme_app", name: "Acme App", version: "1.2.3" }],
    }),
    versioned("prod", { identity: FULL_IDENTITY, apps: [] }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, "warn");
  assert.match(apps[0].message, /not installed on target "prod"/);
  assert.match(apps[0].message, /x_acme_app \(Acme App\)/);
  assert.match(apps[0].message, /confirm each is intended/);
});

test("a target version below the source version fails (downgrade)", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_acme_app", version: "2.1.0" }],
    }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_acme_app", version: "2.0.5" }],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps[0].status, "fail");
  assert.match(apps[0].message, /lower version/);
  assert.match(apps[0].message, /2\.0\.5/);
  assert.match(apps[0].message, /2\.1\.0/);
});

test("a missing app warns while a real downgrade fails (OPP-5 split)", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [
        { id: "x_missing", version: "1.0.0" },
        { id: "x_regressed", version: "2.0.0" },
      ],
    }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_regressed", version: "1.5.0" }],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps.length, 2);
  const fail = apps.find((r) => r.status === "fail");
  const warn = apps.find((r) => r.status === "warn");
  // The downgrade blocks and names only the regressed app.
  assert.match(fail.message, /blocks the promote/);
  assert.match(fail.message, /x_regressed/);
  assert.doesNotMatch(fail.message, /x_missing/);
  // The missing app is advisory only.
  assert.match(warn.message, /x_missing/);
  assert.match(warn.message, /not installed on target/);
});

test("a target version equal or newer than the source passes", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [
        { id: "x_same", version: "1.0.0" },
        { id: "x_newer", version: "1.2" },
      ],
    }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [
        { id: "x_same", version: "1.0.0" },
        // Newer on the target is fine; zero-padding makes 1.2.0 == 1.2 too.
        { id: "x_newer", version: "1.3.0" },
      ],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, "pass");
  assert.match(apps[0].message, /All 2 recorded app\(s\)/);
});

test("unparseable versions warn naming the app, never a silent pass", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_weird", version: "Madrid" }],
    }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_weird", version: "1.0.0" }],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, "warn");
  assert.match(apps[0].message, /x_weird/);
  assert.match(apps[0].message, /cannot be compared/);
  assert.match(apps[0].message, /unverified/);
});

test("a source version the target cannot confirm warns as unverified", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_acme_app", version: "1.2.3" }],
    }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_acme_app" }],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps[0].status, "warn");
  assert.match(apps[0].message, /x_acme_app/);
  assert.match(apps[0].message, /unknown/);
  assert.match(apps[0].message, /unverified/);
});

test("a versionless source app is satisfied by presence alone", () => {
  // The source recorded no version, so presence is the only expectation.
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_acme_app" }],
    }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_acme_app", version: "9.9.9" }],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps[0].status, "pass");
});

test("apps present only on the target are not a finding, just a count", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_shared", version: "1.0.0" }],
    }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [
        { id: "x_shared", version: "1.0.0" },
        { id: "x_extra_one", version: "1.0.0" },
        { id: "x_extra_two", version: "2.0.0" },
      ],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, "pass");
  assert.match(apps[0].message, /2 app\(s\) present only on the target/);
});

test("an empty source app list passes with nothing to gate", () => {
  const results = versionParityResults(
    versioned("staging", { identity: FULL_IDENTITY, apps: [] }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_whatever", version: "1.0.0" }],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].status, "pass");
  assert.match(apps[0].message, /No apps recorded/);
});

test("hard failures and advisories are reported as separate app-parity results", () => {
  const results = versionParityResults(
    versioned("staging", {
      identity: FULL_IDENTITY,
      apps: [
        { id: "x_downgrade", version: "2.0.0" },
        { id: "x_unverifiable", version: "1.0.0" },
      ],
    }),
    versioned("prod", {
      identity: FULL_IDENTITY,
      apps: [{ id: "x_downgrade", version: "1.0.0" }, { id: "x_unverifiable" }],
    }),
  );
  const { apps } = byCheck(results);
  assert.equal(apps.length, 2);
  const fail = apps.find((r) => r.status === "fail");
  const warn = apps.find((r) => r.status === "warn");
  assert.match(fail.message, /x_downgrade/);
  assert.match(warn.message, /x_unverifiable/);
});

test("long offender lists truncate to three names plus a (+N more) suffix", () => {
  const sourceApps = ["a", "b", "c", "d", "e"].map((s) => ({
    id: `x_${s}`,
    version: "1.0.0",
  }));
  const results = versionParityResults(
    versioned("staging", { identity: FULL_IDENTITY, apps: sourceApps }),
    versioned("prod", { identity: FULL_IDENTITY, apps: [] }),
  );
  const { apps } = byCheck(results);
  // Missing-on-target is advisory now; the truncation logic is identical.
  assert.equal(apps[0].status, "warn");
  assert.match(apps[0].message, /5 app\(s\)/);
  assert.match(apps[0].message, /not installed on target/);
  assert.match(apps[0].message, /x_a, x_b, x_c \(\+2 more\)/);
  assert.doesNotMatch(apps[0].message, /x_d/);
});

test("versionParityResults always emits at least one result per dimension", () => {
  // Clean pass on both dimensions still yields positive gate evidence — the
  // deliberate contrast with stalenessResults, which is silent when fresh.
  const clean = versionParityResults(
    versioned("staging", { identity: FULL_IDENTITY, apps: [] }),
    versioned("prod", { identity: FULL_IDENTITY, apps: [] }),
  );
  assert.equal(clean.length, 2);
  assert.deepEqual(
    clean.map((r) => r.status),
    ["pass", "pass"],
  );
});
