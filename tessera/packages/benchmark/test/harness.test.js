// DESIGN §13.4 — the substrate harness, proved against @tessera/fake-instance.
//
// Every catalog and adapter here is FIXTURE — not the benchmark set (see
// test/fixtures/). The fake holds the toy source in its tables and SUB-5's
// fresh scope is its own reset(); the runner evaluates that source.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DESIGN_GATE_POLICY,
  GatePolicyError,
  formatS5Record,
  loadCatalog,
  runBenchmark,
  toSpikeFinding,
} from "../build/index.js";
import { createFakeBench } from "./fixtures/fake-substrate.js";
import {
  FIXTURE_GEN_CONFIG as PINNED,
  buildFixtureCatalog,
} from "./fixtures/fixture-catalog.js";

function setup(catalogOptions = {}, benchOptions = {}) {
  const raw = buildFixtureCatalog(catalogOptions);
  const catalog = loadCatalog(raw, DESIGN_GATE_POLICY);
  const bench = createFakeBench(raw, benchOptions);
  const run = (overrides = {}) =>
    runBenchmark({
      runId: "fx-run",
      catalog,
      genConfig: PINNED,
      policy: DESIGN_GATE_POLICY,
      repetitions: 3,
      substrate: bench.substrate,
      pipeline: bench.pipeline,
      ...overrides,
    });
  return { raw, catalog, bench, run };
}
const codes = (record) => record.result.reasons.map((r) => r.code);

describe("runBenchmark — measured", () => {
  test("an all-caught, non-vacuous fixture scores go", async () => {
    const { bench, run, catalog } = setup();
    const record = await run();
    assert.equal(record.result.status, "go");
    assert.equal(record.result.measurement.kill.successes, 30);
    assert.equal(record.result.measurement.falseGreen.successes, 0);
    assert.deepEqual(record.key, {
      platformVersion: "FIXTURE-build",
      mutantSetHash: catalog.mutantSetHash,
      genConfig: PINNED,
    });
    // SUB-2: lease taken once, released once, free again.
    assert.equal(bench.calls.leaseAcquired, 1);
    assert.equal(bench.calls.released, 1);
    assert.equal(bench.leaseHolder(), null);
    // Drift smoke-test ran every baseline before scoring.
    assert.equal(bench.calls.smoked, 35);
    // 65 targets × 3 reps × 2 runs, each with its own run id (SUB-3).
    assert.equal(bench.calls.runIds.length, 65 * 3 * 2);
    assert.equal(new Set(bench.calls.runIds).size, bench.calls.runIds.length);
    assert.ok(bench.calls.runIds.includes("fx-run:m:fx-m-acl-0:r2:mutant"));
    assert.ok(bench.calls.runIds.includes("fx-run:b:fx-b-0:r0:detonator"));
    // SUB-5: a fresh scope for generation and for every run, plus one final
    // restore (delegated decision #21) — before the lease was released.
    assert.equal(bench.calls.resets, 65 * 3 * 3 + 1);
    assert.equal(bench.calls.resetRunIds.at(-1), "fx-run:final");
    assert.equal(bench.calls.resetsAtRelease, 65 * 3 * 3 + 1);
    // No detonator (the last variant driven) is left live.
    assert.ok(bench.allSourcesCorrect());
    // Teardown left nothing staged.
    assert.equal(bench.specRows(), 0);
    // The generator only ever saw correct source.
    assert.equal(bench.calls.generateRunIds.length, 65 * 3);
  });

  test("a fixture go is still an OPEN finding", async () => {
    const { run } = setup();
    const record = await run();
    const finding = toSpikeFinding(record);
    assert.equal(finding.outcome, "open");
    assert.match(finding.decision, /^FIXTURE run \(scored go\)/);
    const json = JSON.parse(formatS5Record(record));
    assert.equal(json.status, "go");
    assert.equal(json.finding.spike, "S5");
    assert.equal(json.key.platformVersion, "FIXTURE-build");
  });

  test("blind mutants miss the per-category floor and the bound", async () => {
    const blind = ["fx-m-acl-0", "fx-m-acl-1", "fx-m-acl-2"];
    const { run } = setup({ blind });
    const record = await run();
    assert.equal(record.result.status, "miss");
    assert.equal(record.result.decision, "descope");
    assert.deepEqual(codes(record), [
      "per-category-floor",
      "kill-rate-lower-bound",
    ]);
    for (const id of blind) {
      const m = record.mutants.find((x) => x.id === id);
      assert.deepEqual(m.caughtPerRep, [false, false, false]);
    }
  });

  test("a vacuous suite on one baseline breaks the false-green bound", async () => {
    const { run } = setup({}, { vacuous: ["fxb1004"] });
    const record = await run();
    assert.deepEqual(codes(record), ["false-green-upper-bound"]);
    const b = record.baselines.find((x) => x.id === "fx-b-4");
    assert.deepEqual(b.vacuousPerRep, [true, true, true]);
  });

  test("vacuous in one rep only is still false-green (worst-of-k)", async () => {
    const { run } = setup({}, { vacuousOnRep: { fxb1009: 1 } });
    const record = await run();
    const b = record.baselines.find((x) => x.id === "fx-b-9");
    assert.deepEqual(b.vacuousPerRep, [false, true, false]);
    assert.equal(record.result.measurement.falseGreen.successes, 1);
  });

  test("an unpinned genConfig is a miss and drives nothing", async () => {
    const { bench, run } = setup();
    const record = await run({ genConfig: { ...PINNED, modelId: "x-latest" } });
    assert.equal(record.result.status, "miss");
    assert.ok(codes(record).includes("generation-unpinned"));
    assert.equal(bench.calls.leaseAcquired, 0);
    assert.equal(bench.calls.runIds.length, 0);
    assert.equal(record.key, null);
  });

  test("a weaker policy or k < 3 is refused before anything runs", async () => {
    const { bench, run } = setup();
    await assert.rejects(
      run({ policy: { ...DESIGN_GATE_POLICY, minKillRate: 0.7 } }),
      GatePolicyError,
    );
    await assert.rejects(run({ repetitions: 2 }), RangeError);
    assert.equal(bench.calls.leaseAcquired, 0);
  });
});

describe("runBenchmark — void (not a fail)", () => {
  const voids = [
    ["SUB-1 unhealthy", { unhealthy: true }, "substrate-unhealthy", false],
    [
      "SUB-1 health check rejects",
      { healthCheckRejects: true },
      "substrate-unhealthy",
      false,
    ],
    [
      "SUB-3 join unpinned",
      { joinUnpinned: true },
      "attribution-join-unpinned",
      false,
    ],
    [
      "SUB-2 lease held",
      { leaseHeldBy: "someone-else" },
      "runner-lease-held",
      false,
    ],
    ["drift smoke red", { drifted: ["fxb1003"] }, "drift-smoke-red", true],
    [
      "SUB-5 reset fails",
      { resetFailsOn: "fx-m-flow-subflow-2:r1" },
      "scope-reset-failed",
      true,
    ],
    ["runner rejects", { runnerRejects: true }, "inconclusive-run", true],
    [
      "inconclusive row",
      { rawOverride: "waiting-timeout" },
      "inconclusive-run",
      true,
    ],
    ["error row", { rawOverride: "error" }, "inconclusive-run", true],
    ["foreign run id", { wrongRunId: true }, "attribution-mismatch", true],
  ];
  for (const [name, options, code, leased] of voids) {
    test(name, async () => {
      const { bench, run } = setup({}, options);
      const record = await run();
      assert.equal(record.result.status, "void");
      assert.equal(record.result.decision, "descope");
      assert.deepEqual(codes(record), [code]);
      assert.equal("measurement" in record.result, false);
      assert.equal(
        toSpikeFinding({
          ...record,
          catalog: { ...record.catalog, fixture: false },
        }).outcome,
        "open",
      );
      // The lease is released whenever it was taken, never taken otherwise.
      assert.equal(bench.calls.leaseAcquired, leased ? 1 : 0);
      assert.equal(bench.calls.released, leased ? 1 : 0);
      if (code === "runner-lease-held") {
        assert.equal(bench.leaseHolder(), "someone-else");
      } else {
        assert.equal(bench.leaseHolder(), null);
      }
      assert.equal(bench.specRows(), 0);
    });
  }

  test("drift smoke red voids before any scored run", async () => {
    const { bench, run } = setup({}, { drifted: ["fxb1000"] });
    const record = await run();
    assert.deepEqual(codes(record), ["drift-smoke-red"]);
    assert.equal(bench.calls.runIds.length, 0);
    assert.notEqual(record.key, null);
    // Nothing was applied, so there is nothing to restore (decision #21).
    assert.equal(bench.calls.resets, 0);
  });

  test("an abort mid-run voids as aborted", async () => {
    const controller = new AbortController();
    const { run } = setup({}, { abortController: controller });
    const record = await run({ signal: controller.signal });
    assert.deepEqual(codes(record), ["aborted"]);
  });

  test("a failed lease release is a warning, not a verdict change", async () => {
    const { run } = setup({}, { releaseRejects: true });
    const record = await run();
    assert.equal(record.result.status, "go");
    assert.deepEqual(record.warnings, [
      "runner lease release failed: release failed (FIXTURE)",
    ]);
  });
});

describe("runBenchmark — final scope restore (delegated decisions #21, #22)", () => {
  test("a mid-run void never leaves the mutant live", async () => {
    const { bench, run } = setup({}, { runnerRejectsOn: ":mutant" });
    const record = await run();
    assert.deepEqual(codes(record), ["inconclusive-run"]);
    assert.match(record.result.reasons[0].detail, /:mutant: runner rejected/);
    assert.equal(bench.calls.resetRunIds.at(-1), "fx-run:final");
    assert.equal(bench.calls.resetsAtRelease, bench.calls.resets);
    assert.ok(bench.allSourcesCorrect());
    assert.deepEqual(record.warnings, []);
  });

  test("a failed final restore voids an otherwise-GO run (fail-closed)", async () => {
    const { bench, run } = setup({}, { resetFailsOn: ":final" });
    const record = await run();
    assert.equal(record.result.status, "void");
    assert.deepEqual(codes(record), ["scope-reset-failed"]);
    assert.match(record.result.reasons[0].detail, /^final scope restore/);
    assert.equal(record.warnings.length, 1);
    assert.match(record.warnings[0], /^final scope restore \(fx-run:final\)/);
    // The observations are kept; the lease is still released.
    assert.equal(record.mutants.length, 30);
    assert.equal(bench.calls.released, 1);
    assert.equal(bench.leaseHolder(), null);
  });

  test("a failed final restore keeps a miss a miss, with a warning", async () => {
    const blind = ["fx-m-acl-0", "fx-m-acl-1", "fx-m-acl-2"];
    const { run } = setup({ blind }, { resetFailsOn: ":final" });
    const record = await run();
    assert.equal(record.result.status, "miss");
    assert.deepEqual(codes(record), [
      "per-category-floor",
      "kill-rate-lower-bound",
    ]);
    assert.equal(record.warnings.length, 1);
    assert.match(record.warnings[0], /^final scope restore/);
  });

  test("a failed final restore keeps the original void reason", async () => {
    const { run } = setup(
      {},
      { runnerRejectsOn: ":mutant", resetFailsOn: ":final" },
    );
    const record = await run();
    assert.deepEqual(codes(record), ["inconclusive-run"]);
    assert.match(record.result.reasons[0].detail, /runner rejected/);
    assert.equal(record.warnings.length, 1);
    assert.match(record.warnings[0], /^final scope restore/);
  });
});

describe("runBenchmark — teardown faults (delegated decision #23)", () => {
  test("a teardown rejection does not replace an in-flight void reason", async () => {
    const { run } = setup({}, { runnerRejects: true, teardownRejects: true });
    const record = await run();
    assert.deepEqual(codes(record), ["inconclusive-run"]);
    assert.match(
      record.result.reasons[0].detail,
      /runner rejected: runner offline \(FIXTURE\)$/,
    );
    assert.equal(
      record.warnings.filter((w) =>
        /store teardown failed while another fault was propagating: teardown failed \(FIXTURE\)$/.test(
          w,
        ),
      ).length,
      1,
    );
  });

  test("a teardown rejection with no fault in flight still voids the run", async () => {
    const { run } = setup({}, { teardownRejects: true });
    const record = await run();
    assert.deepEqual(codes(record), ["inconclusive-run"]);
    assert.equal(
      record.result.reasons[0].detail,
      "infrastructure fault: teardown failed (FIXTURE)",
    );
    assert.deepEqual(record.warnings, []);
  });
});
