// DESIGN §13.1 — the Wilson arithmetic and the pure OutcomeGate.
//
// The reference values are the design's own (§13.1 "Decision rule"): 30/30 →
// lower ≈ 0.887 (the exact closed form is 30/(30+z²) = 0.88649, so DESIGN's
// three-decimal figure is rounded up; asserted as 0.8865 below), 29/30 →
// ≈ 0.833, 28/30 → ≈ 0.787, 0/35 → upper ≈ 0.099, and
// M = ceil(z²(1−t)/t) = 35. Two textbook values (0/10, 5/10) pin the formula
// away from the design's own corner cases.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DESIGN_GATE_POLICY,
  GatePolicyError,
  MUTANT_CATEGORIES,
  assertPolicyAtLeastDesign,
  caughtSetDrift,
  collapseCaught,
  collapseVacuous,
  minTrialsForZeroEventUpperBound,
  perCategoryCatchFloor,
  scoreOutcomeGate,
  wilsonInterval,
  zForConfidence,
} from "../build/index.js";

const near = (actual, expected, tol = 5e-4) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} ≈ ${expected} (±${tol})`,
  );

/** k reps of one boolean. */
const reps = (value, k = 3) => Array.from({ length: k }, () => value);

/** `perCategory` mutants per category, the first `missed[c]` of each uncaught. */
function mutantsFor(perCategory, missed = {}) {
  return MUTANT_CATEGORIES.flatMap((category) =>
    Array.from({ length: perCategory }, (_, i) => ({
      id: `${category}-${i}`,
      category,
      caughtPerRep: reps(i >= (missed[category] ?? 0)),
    })),
  );
}
const baselinesFor = (m, vacuous = 0) =>
  Array.from({ length: m }, (_, i) => ({
    id: `b-${i}`,
    vacuousPerRep: reps(i < vacuous),
  }));

const score = (overrides = {}) =>
  scoreOutcomeGate({
    policy: DESIGN_GATE_POLICY,
    mutants: mutantsFor(5),
    baselines: baselinesFor(35),
    repetitions: 3,
    generationPinned: true,
    ...overrides,
  });
const codes = (result) => result.reasons.map((r) => r.code);

describe("Wilson score interval", () => {
  test("z is derived from the confidence level", () => {
    near(zForConfidence(0.95), 1.959964, 1e-6);
    near(zForConfidence(0.99), 2.575829, 1e-6);
    for (const bad of [0, 1, -0.5, 1.5, Number.NaN]) {
      assert.throws(() => zForConfidence(bad), RangeError);
    }
  });

  test("matches the DESIGN §13.1 reference values", () => {
    near(wilsonInterval(30, 30, 0.95).lower, 0.8865);
    near(wilsonInterval(29, 30, 0.95).lower, 0.833);
    near(wilsonInterval(28, 30, 0.95).lower, 0.787);
    near(wilsonInterval(0, 35, 0.95).upper, 0.099);
    assert.equal(minTrialsForZeroEventUpperBound(0.1, 0.95), 35);
  });

  test("matches textbook values away from the corners", () => {
    near(wilsonInterval(0, 10, 0.95).upper, 0.2775);
    const half = wilsonInterval(5, 10, 0.95);
    near(half.lower, 0.2366);
    near(half.upper, 0.7634);
    assert.equal(half.point, 0.5);
  });

  test("bounds are clamped and zero trials is uninformative", () => {
    assert.equal(wilsonInterval(30, 30, 0.95).upper, 1);
    assert.equal(wilsonInterval(0, 35, 0.95).lower, 0);
    const empty = wilsonInterval(0, 0, 0.95);
    assert.deepEqual([empty.lower, empty.upper], [0, 1]);
    assert.ok(Number.isNaN(empty.point));
  });

  test("refuses impossible counts", () => {
    assert.throws(() => wilsonInterval(4, 3, 0.95), RangeError);
    assert.throws(() => wilsonInterval(-1, 3, 0.95), RangeError);
    assert.throws(() => wilsonInterval(1.5, 3, 0.95), RangeError);
    assert.throws(() => wilsonInterval(0, -1, 0.95), RangeError);
  });
});

describe("gate policy", () => {
  test("DESIGN_GATE_POLICY is exactly §13.1 and frozen", () => {
    assert.deepEqual(
      { ...DESIGN_GATE_POLICY },
      {
        minMutants: 30,
        minPerCategory: 5,
        perCategoryFloor: 3,
        minKillRate: 0.8,
        minBaselines: 35,
        maxFalseGreenRate: 0.1,
        minRepetitions: 3,
        confidence: 0.95,
        maxCaughtSetDrift: 2,
      },
    );
    assert.ok(Object.isFrozen(DESIGN_GATE_POLICY));
    assertPolicyAtLeastDesign(DESIGN_GATE_POLICY);
  });

  test("refuses every weaker axis — moving the bar is an ADR", () => {
    const weaker = [
      { minMutants: 29 },
      { minPerCategory: 4 },
      { perCategoryFloor: 2 },
      { minKillRate: 0.79 },
      { minBaselines: 34 },
      { maxFalseGreenRate: 0.11 },
      { minRepetitions: 2 },
      { confidence: 0.9 },
      { maxCaughtSetDrift: 3 },
      { minPerCategory: 10, perCategoryFloor: 5 }, // ratio below 3/5
    ];
    for (const change of weaker) {
      assert.throws(
        () => assertPolicyAtLeastDesign({ ...DESIGN_GATE_POLICY, ...change }),
        GatePolicyError,
        JSON.stringify(change),
      );
      assert.throws(
        () => score({ policy: { ...DESIGN_GATE_POLICY, ...change } }),
        GatePolicyError,
      );
    }
  });

  test("a tighter false-green threshold drags M up by the formula", () => {
    const tighter = { ...DESIGN_GATE_POLICY, maxFalseGreenRate: 0.05 };
    assert.throws(() => assertPolicyAtLeastDesign(tighter), /minBaselines/);
    const m = minTrialsForZeroEventUpperBound(0.05, 0.95);
    assert.equal(m, 73);
    assertPolicyAtLeastDesign({ ...tighter, minBaselines: m });
  });

  test("per-category floor keeps 3/5 and rounds up", () => {
    assert.equal(perCategoryCatchFloor(5, DESIGN_GATE_POLICY), 3);
    assert.equal(perCategoryCatchFloor(6, DESIGN_GATE_POLICY), 4);
    assert.equal(perCategoryCatchFloor(10, DESIGN_GATE_POLICY), 6);
    assert.equal(perCategoryCatchFloor(20, DESIGN_GATE_POLICY), 12);
  });
});

describe("worst-of-k collapse", () => {
  test("caught needs ALL reps; vacuous needs ANY rep", () => {
    assert.equal(collapseCaught([true, true, true]), true);
    assert.equal(collapseCaught([true, false, true]), false);
    assert.equal(collapseCaught([]), false);
    assert.equal(collapseVacuous([false, false, false]), false);
    assert.equal(collapseVacuous([false, true, false]), true);
    assert.equal(collapseVacuous([]), true);
  });

  test("caught-set drift counts every mutant whose reps disagree", () => {
    const drift = caughtSetDrift(
      [
        { id: "a", category: "acl", caughtPerRep: [true, false, true] },
        { id: "b", category: "acl", caughtPerRep: [false, true, false] },
        { id: "c", category: "acl", caughtPerRep: [true, true, true] },
        { id: "d", category: "acl", caughtPerRep: [false, false, false] },
      ],
      3,
    );
    assert.equal(drift.drift, 2);
    assert.deepEqual(drift.caughtPerRep, [2, 2, 2]);
  });
});

describe("scoreOutcomeGate", () => {
  test("30/30 and 0/35 is go", () => {
    const result = score();
    assert.equal(result.status, "go");
    assert.equal(result.decision, "go");
    assert.deepEqual(result.reasons, []);
    near(result.measurement.kill.lower, 0.8865);
    near(result.measurement.falseGreen.upper, 0.099);
  });

  test("the gate tolerates exactly one uncaught mutant", () => {
    const one = score({ mutants: mutantsFor(5, { acl: 1 }) });
    assert.equal(one.status, "go");
    near(one.measurement.kill.lower, 0.833);
    const two = score({
      mutants: mutantsFor(5, { acl: 1, "flow-subflow": 1 }),
    });
    assert.equal(two.status, "miss");
    assert.equal(two.decision, "descope");
    assert.deepEqual(codes(two), ["kill-rate-lower-bound"]);
  });

  test("one vacuous baseline of 35 breaks the false-green bound", () => {
    const result = score({ baselines: baselinesFor(35, 1) });
    assert.equal(result.status, "miss");
    assert.deepEqual(codes(result), ["false-green-upper-bound"]);
    assert.ok(result.measurement.falseGreen.upper > 0.1);
  });

  test("the per-category floor bites even when the bound clears", () => {
    // N = 120 (20 per category): 111/120 clears the lower bound, but one
    // category catching 11 of 20 is below ceil(20 × 3/5) = 12.
    const result = score({ mutants: mutantsFor(20, { acl: 9 }) });
    assert.ok(result.measurement.kill.lower >= 0.8);
    assert.deepEqual(codes(result), ["per-category-floor"]);
    const acl = result.measurement.perCategory.find(
      (c) => c.category === "acl",
    );
    assert.deepEqual(
      { caught: acl.caught, floor: acl.floor, met: acl.met },
      { caught: 11, floor: 12, met: false },
    );
  });

  test("a mutant caught in 2 of 3 reps is not caught", () => {
    const mutants = mutantsFor(5);
    mutants[0] = { ...mutants[0], caughtPerRep: [true, false, true] };
    mutants[1] = { ...mutants[1], caughtPerRep: [true, true, false] };
    const result = score({ mutants });
    assert.equal(result.measurement.kill.successes, 28);
    assert.deepEqual(codes(result), ["kill-rate-lower-bound"]);
  });

  test("a baseline vacuous in 1 of 3 reps is false-green", () => {
    const baselines = baselinesFor(35);
    baselines[7] = { id: "b-7", vacuousPerRep: [false, true, false] };
    const result = score({ baselines });
    assert.equal(result.measurement.falseGreen.successes, 1);
    assert.deepEqual(codes(result), ["false-green-upper-bound"]);
  });

  test("caught-set drift above 2 is a determinism miss; 2 is not", () => {
    const at = (n) => {
      const mutants = mutantsFor(20);
      for (let i = 0; i < n; i += 1) {
        mutants[i * 20] = {
          ...mutants[i * 20],
          caughtPerRep: [true, true, false],
        };
      }
      return score({ mutants });
    };
    assert.equal(at(2).status, "go");
    assert.equal(at(2).measurement.determinism.drift, 2);
    assert.deepEqual(codes(at(3)), ["determinism-variance"]);
  });

  test("composition floors: N, per category and M", () => {
    const thin = mutantsFor(5).filter((m) => m.id !== "acl-0");
    const result = score({ mutants: thin, baselines: baselinesFor(34) });
    assert.equal(result.status, "miss");
    const details = result.reasons
      .filter((r) => r.code === "composition")
      .map((r) => r.detail);
    assert.deepEqual(details, [
      "N = 29 mutants < 30",
      "M = 34 baselines < 35",
      "category acl: 4 authored < 5",
    ]);
  });

  test("k below 3 and ragged reps are repetition misses", () => {
    const k2 = scoreOutcomeGate({
      policy: DESIGN_GATE_POLICY,
      mutants: mutantsFor(5).map((m) => ({ ...m, caughtPerRep: [true, true] })),
      baselines: baselinesFor(35).map((b) => ({
        ...b,
        vacuousPerRep: [false, false],
      })),
      repetitions: 2,
      generationPinned: true,
    });
    assert.deepEqual(codes(k2), ["repetitions"]);
    const mutants = mutantsFor(5);
    mutants[3] = { ...mutants[3], caughtPerRep: [true, true, true, true] };
    assert.ok(codes(score({ mutants })).includes("repetitions"));
  });

  test("an unpinned generation config is a miss", () => {
    const result = score({ generationPinned: false });
    assert.equal(result.status, "miss");
    assert.deepEqual(codes(result), ["generation-unpinned"]);
  });

  test("a void run is not a fail: descope, no measurement", () => {
    const reason = { code: "substrate-unhealthy", detail: "asleep" };
    const result = score({ voidReasons: [reason] });
    assert.equal(result.status, "void");
    assert.equal(result.decision, "descope");
    assert.deepEqual(result.reasons, [reason]);
    assert.equal("measurement" in result, false);
    // A void outranks a would-be go AND a would-be miss.
    assert.equal(
      score({ voidReasons: [reason], generationPinned: false }).status,
      "void",
    );
  });
});
