// RR-54 (ST-7, ST-8, ST-9, ST-10, ST-24): the drift gate proves the two
// manifests are what they claim to be — each belongs to its name and registry
// URL, the two are different instances synced for one scope — and closes the
// freshness, app-parity and promotion-order holes that let a bad promote pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identityResults,
  loadManifest,
  promotionOrderResult,
  runDrift,
  stalenessResults,
  versionParityResults,
  IDENTITY_CHECK,
  FRESHNESS_CHECK,
  APP_VERSION_CHECK,
  PROMOTION_ORDER_CHECK,
  FUTURE_SYNC_SKEW_MS,
} from "../build/api/state.js";

const NOW = Date.parse("2026-11-20T12:00:00Z");
const TESTS = [{ id: "x/a", name: "A", active: true }];
const IDENTITY = { buildName: "Xanadu", war: "glide-xanadu.war" };
const URLS = {
  staging: "https://staging.service-now.com",
  prod: "https://prod.service-now.com",
};
const REGISTRY = {
  version: 1,
  instances: {
    staging: { url: URLS.staging, promotesTo: "prod" },
    prod: { url: URLS.prod, promotesTo: null },
  },
};

function manifest(instance, extra = {}) {
  return {
    instance,
    url: URLS[instance],
    scope: "x_acme",
    syncedAt: new Date(NOW - 60_000).toISOString(),
    identity: IDENTITY,
    apps: [{ id: "x_acme_app", name: "Acme App", version: "1.2.3" }],
    tests: TESTS,
    suites: [],
    ...extra,
  };
}

async function drift({ source = {}, target = {}, ...opts } = {}) {
  return runDrift({
    source: { name: "staging", manifest: manifest("staging", source) },
    target: { name: "prod", manifest: manifest("prod", target) },
    registry: REGISTRY,
    now: NOW,
    ...opts,
  });
}

function rows(report, check) {
  return report.results.filter((r) => r.name === check);
}

function kinds(report, check) {
  return rows(report, check).flatMap((r) =>
    (r.findings ?? []).map((f) => `${r.status}:${f.kind}`),
  );
}

test("a clean, fully identified pair has a single pass identity row", async () => {
  const report = await drift();
  assert.equal(report.ok, true);
  assert.deepEqual(
    rows(report, IDENTITY_CHECK).map((r) => r.status),
    ["pass"],
  );
  assert.equal(report.summary.warn, 0);
  assert.equal(report.summary.fail, 0);
});

// --- ST-7: identity --------------------------------------------------------

test("ST-7: two registry names pointing at one URL fail as the same instance", async () => {
  const registry = {
    version: 1,
    instances: {
      staging: { url: URLS.staging, promotesTo: "prod" },
      prod: { url: `${URLS.staging}/`, promotesTo: null },
    },
  };
  const report = await drift({ registry, target: { url: URLS.staging } });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report, IDENTITY_CHECK), ["fail:same-instance"]);
});

test("ST-7: URLs compare normalised (case, default port, trailing slash)", async () => {
  const report = await drift({
    target: { url: "HTTPS://Staging.Service-Now.com:443//" },
    registry: {
      version: 1,
      instances: {
        staging: { url: URLS.staging, promotesTo: "prod" },
        prod: { url: URLS.staging, promotesTo: null },
      },
    },
  });
  assert.deepEqual(kinds(report, IDENTITY_CHECK), ["fail:same-instance"]);
});

test("ST-7: a prod manifest copied in as staging fails on its url", async () => {
  // The copy was renamed to say "staging", but it was synced from prod.
  const report = await drift({ source: { url: URLS.prod } });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report, IDENTITY_CHECK), [
    "fail:url-mismatch:source",
    "fail:same-instance",
  ]);
});

test("ST-7: a manifest whose instance is not its name fails (library input)", async () => {
  const report = await drift({ target: { instance: "staging" } });
  assert.equal(report.ok, false);
  assert.ok(
    kinds(report, IDENTITY_CHECK).includes("fail:instance-mismatch:target"),
  );
});

test("ST-7: the same name on both sides fails without a registry", async () => {
  const report = await runDrift({
    source: { name: "staging", manifest: manifest("staging") },
    target: { name: "staging", manifest: manifest("staging") },
    now: NOW,
  });
  assert.ok(kinds(report, IDENTITY_CHECK).includes("fail:same-instance"));
});

test("ST-7: a manifest with no url warns that its origin is unverified", async () => {
  const report = await drift({ target: { url: undefined } });
  assert.equal(report.ok, true);
  assert.deepEqual(kinds(report, IDENTITY_CHECK), [
    "warn:url-unverified:target",
  ]);
});

test("ST-7: loadManifest refuses a non-string, blank or absent instance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snpf-rr54-"));
  try {
    mkdirSync(join(dir, ".preflight", "state"), { recursive: true });
    for (const instance of [42, "", undefined]) {
      const file = join(dir, ".preflight", "state", "staging.state.json");
      const body = { tests: [], suites: [] };
      if (instance !== undefined) body.instance = instance;
      writeFileSync(file, JSON.stringify(body));
      await assert.rejects(
        loadManifest("staging", dir),
        (err) =>
          err.name === "UsageError" && /no valid "instance"/.test(err.message),
        `instance ${JSON.stringify(instance)}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- ST-8: scope -------------------------------------------------------------

test("ST-8: manifests synced for different scopes fail", async () => {
  const report = await drift({ target: { scope: "x_other" } });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report, IDENTITY_CHECK), ["fail:scope-mismatch"]);
});

test("ST-8: scoped against unscoped fails; absent and blank scope agree", async () => {
  const mixed = await drift({ target: { scope: undefined } });
  assert.deepEqual(kinds(mixed, IDENTITY_CHECK), ["fail:scope-mismatch"]);
  const unscoped = await drift({
    source: { scope: undefined },
    target: { scope: "  " },
  });
  assert.deepEqual(
    rows(unscoped, IDENTITY_CHECK).map((r) => r.status),
    ["pass"],
  );
});

// --- ST-9: freshness -------------------------------------------------------

test("ST-9: a syncedAt in the future fails freshness", async () => {
  const future = new Date(NOW + FUTURE_SYNC_SKEW_MS + 60_000).toISOString();
  const report = await drift({ target: { syncedAt: future } });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report, FRESHNESS_CHECK), [
    "fail:future-synced-at:target",
  ]);
});

test("ST-9: clock skew within the tolerance is not a failure", () => {
  const near = new Date(NOW + FUTURE_SYNC_SKEW_MS - 1_000).toISOString();
  const results = stalenessResults(
    [{ role: "target", manifest: manifest("prod", { syncedAt: near }) }],
    { now: NOW },
  );
  assert.deepEqual(results, []);
});

test("ST-9: an unreadable syncedAt warns without --max-age, fails with it", async () => {
  for (const syncedAt of ["not a date", undefined, ""]) {
    const soft = await drift({ target: { syncedAt } });
    assert.deepEqual(
      kinds(soft, FRESHNESS_CHECK),
      ["warn:no-synced-at:target"],
      `syncedAt ${JSON.stringify(syncedAt)}`,
    );
    const hard = await drift({ target: { syncedAt }, maxAgeMs: 86_400_000 });
    assert.deepEqual(kinds(hard, FRESHNESS_CHECK), [
      "fail:no-synced-at:target",
    ]);
  }
});

// --- ST-10: app parity -------------------------------------------------------

test("ST-10: an app recorded on source but missing on target fails", async () => {
  const report = await drift({ target: { apps: [] } });
  assert.equal(report.ok, false);
  assert.deepEqual(kinds(report, APP_VERSION_CHECK), [
    "fail:missing-on-target",
  ]);
  assert.match(
    rows(report, APP_VERSION_CHECK)[0].message,
    /not installed on target "prod"/,
  );
});

test("ST-10: v-prefixed and pre-release versions are compared, not skipped", () => {
  const cases = [
    ["v1.2.3", "1.2.2", "fail"],
    ["1.2.3", "v1.2.3", "pass"],
    ["2.0.0", "2.0.0-rc.1", "fail"],
    ["2.0.0-rc.1", "2.0.0", "pass"],
    ["2.0.0-rc.10", "2.0.0-rc.2", "fail"],
    ["1.2.3+build.7", "1.2.3", "pass"],
  ];
  for (const [source, target, expected] of cases) {
    const results = versionParityResults(
      manifest("staging", {
        apps: [{ id: "x_app", name: "App", version: source }],
      }),
      manifest("prod", {
        apps: [{ id: "x_app", name: "App", version: target }],
      }),
    ).filter((r) => r.name === APP_VERSION_CHECK);
    assert.deepEqual(
      results.map((r) => r.status),
      [expected],
      `${source} → ${target}`,
    );
  }
});

test("ST-10: a source app with no version warns as unverified", async () => {
  const report = await drift({
    source: { apps: [{ id: "x_acme_app", name: "Acme App" }] },
  });
  assert.deepEqual(kinds(report, APP_VERSION_CHECK), ["warn:unverified"]);
});

// --- ST-24: promotion order --------------------------------------------------

test("ST-24: an instance the registry does not declare fails the order", () => {
  const result = promotionOrderResult(REGISTRY, "staging", "prdo");
  assert.equal(result.status, "fail");
  assert.match(result.message, /"prdo" is not declared/);
});

test("ST-24: no registry, or no promotesTo pipeline, stays an advisory warn", () => {
  assert.equal(
    promotionOrderResult(undefined, "staging", "prod").status,
    "warn",
  );
  const flat = {
    version: 1,
    instances: { staging: { url: URLS.staging }, prod: { url: URLS.prod } },
  };
  assert.equal(promotionOrderResult(flat, "staging", "prod").status, "warn");
});

test("ST-24: runDrift with an undeclared target fails the gate", async () => {
  const report = await runDrift({
    source: { name: "staging", manifest: manifest("staging") },
    target: { name: "qa", manifest: manifest("prod", { instance: "qa" }) },
    registry: REGISTRY,
    now: NOW,
  });
  assert.equal(report.ok, false);
  assert.equal(rows(report, PROMOTION_ORDER_CHECK)[0].status, "fail");
});

test("identityResults is exported for library callers", () => {
  const out = identityResults(
    [
      { role: "source", name: "staging", manifest: manifest("staging") },
      { role: "target", name: "prod", manifest: manifest("prod") },
    ],
    REGISTRY,
  );
  assert.deepEqual(
    out.map((r) => r.status),
    ["pass"],
  );
});
