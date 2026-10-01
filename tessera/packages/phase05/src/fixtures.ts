/**
 * The Phase 0.5 hardcoded change, copied into the package so the skeleton is
 * self-contained.
 *
 * PROVENANCE — every string below is a verbatim copy of a reviewed file in
 * `docs/ai/tessera/s5-probe/` (the S5 seeded-bug probe):
 *   - `S5_TARGET_CORRECT_SOURCE` ← `s5-probe/target-correct.js`
 *   - `S5_TARGET_MUTANT_SOURCE`  ← `s5-probe/target-mutant.js`
 *   - `S5_GENERATED_TEST_SCRIPT` ← `s5-probe/generated-test.js`
 * The probe's README carries the generation-order attestation: the test was
 * generated from the CORRECT source only, before the mutant existed. That is
 * what makes the red half of the pair evidence rather than decoration.
 *
 * Why string constants and not `fixtures/*.js` files: `tsc` with
 * `rootDir: src` emits only compiled `.ts`, so a sibling `.js` would never
 * reach `build/` and the library would have to read it off disk by relative
 * path; and Prettier (semi, double quotes) would silently rewrite a file that
 * is only valuable byte-for-byte. Template-literal contents are exempt from
 * both. The single mutation applied to the copies is the outer wrapping.
 */

/** `sys_script_include.name` of the one artifact Phase 0.5 knows about. */
export const S5_TARGET_NAME = "TesseraS5Target";

/** `sys_script_include.api_name` in global scope. */
export const S5_TARGET_API_NAME = "global.TesseraS5Target";

/**
 * The assertion the mutant breaks. Held as a constant because the red run has
 * to be attributed to THIS named assertion — "the suite failed" is not a
 * finding (Spike 2b).
 */
export const S5_THRESHOLD_ASSERTION =
  "at threshold: exactly 100 units get 10% off";

/** Verbatim `s5-probe/target-correct.js`. */
export const S5_TARGET_CORRECT_SOURCE = `// S5 probe — CORRECT source (the "known-good" half of the seeded-bug pair).
// Global-scope Script Include body for sys_script_include "TesseraS5Target".
// The generated test (generated-test.js) was produced from THIS file only —
// see README.md for the generation-order attestation.
var TesseraS5Target = Class.create();
TesseraS5Target.prototype = {
  initialize: function () {},

  /**
   * Applies the volume discount to an order.
   * Contract: orders of 100 units or more get 10% off the line total
   * (units * unitPrice). Orders below 100 units pay full price.
   * The result is rounded to 2 decimal places (banker-free, half-up via
   * Math.round on cents). Non-positive units or unitPrice yield 0.
   *
   * @param {number} units - number of units ordered
   * @param {number} unitPrice - price per unit
   * @returns {number} the payable line total after any discount
   */
  applyVolumeDiscount: function (units, unitPrice) {
    if (!(units > 0) || !(unitPrice > 0)) return 0;
    var total = units * unitPrice;
    if (units >= 100) total = total * 0.9;
    return Math.round(total * 100) / 100;
  },

  type: 'TesseraS5Target',
};
`;

/** Verbatim `s5-probe/target-mutant.js`. */
export const S5_TARGET_MUTANT_SOURCE = `// S5 probe — MUTANT twin (the seeded bug). Single reviewed fault injection:
// boundary mutation \`units >= 100\` -> \`units > 100\` (an off-by-one that
// silently denies the discount to exactly-100-unit orders). Category:
// Script Include / boundary condition. Everything else is byte-identical
// to target-correct.js.
var TesseraS5Target = Class.create();
TesseraS5Target.prototype = {
  initialize: function () {},

  /**
   * Applies the volume discount to an order.
   * Contract: orders of 100 units or more get 10% off the line total
   * (units * unitPrice). Orders below 100 units pay full price.
   * The result is rounded to 2 decimal places (banker-free, half-up via
   * Math.round on cents). Non-positive units or unitPrice yield 0.
   *
   * @param {number} units - number of units ordered
   * @param {number} unitPrice - price per unit
   * @returns {number} the payable line total after any discount
   */
  applyVolumeDiscount: function (units, unitPrice) {
    if (!(units > 0) || !(unitPrice > 0)) return 0;
    var total = units * unitPrice;
    if (units > 100) total = total * 0.9;
    return Math.round(total * 100) / 100;
  },

  type: 'TesseraS5Target',
};
`;

/**
 * Verbatim `s5-probe/generated-test.js` — the body of the ATF
 * "Run Server Side Script" step (DR-1 / Spike 0: the script lives on the
 * step's input variable, not on `sys_atf_test`).
 */
export const S5_GENERATED_TEST_SCRIPT = `// S5 probe — LLM-GENERATED test (ATF "Run Server Side Script" step body).
// Generated 2026-07-31 by Claude (Fable 5) from target-correct.js ONLY — the
// mutant was not consulted (README.md: generation-order attestation). The
// generator's brief: "write the ATF server-side test a competent QA would
// generate for this Script Include's documented contract."
(function (outputs, steps, params, stepResult, assertEqual) {
  var t = new TesseraS5Target();

  // Full price below the volume threshold.
  assertEqual({
    name: 'below threshold: 99 units pay full price',
    shouldbe: 990,
    value: t.applyVolumeDiscount(99, 10),
  });

  // Contract says "100 units or more" — the threshold itself must discount.
  assertEqual({
    name: 'at threshold: exactly 100 units get 10% off',
    shouldbe: 900,
    value: t.applyVolumeDiscount(100, 10),
  });

  // Comfortably above the threshold.
  assertEqual({
    name: 'above threshold: 150 units get 10% off',
    shouldbe: 270,
    value: t.applyVolumeDiscount(150, 2),
  });

  // Rounding to 2 decimals.
  assertEqual({
    name: 'result is rounded to 2 decimals',
    shouldbe: 10,
    value: t.applyVolumeDiscount(3, 3.333),
  });

  // Guard clauses.
  assertEqual({
    name: 'zero units yield 0',
    shouldbe: 0,
    value: t.applyVolumeDiscount(0, 10),
  });
  assertEqual({
    name: 'negative unit price yields 0',
    shouldbe: 0,
    value: t.applyVolumeDiscount(10, -1),
  });
})(outputs, steps, params, stepResult, assertEqual);
`;

/** How many `assertEqual` calls the generated test makes. */
export const S5_ASSERTION_COUNT = 6;

/**
 * The single spec Phase 0.5 plans. `path` is the repo path the generated test
 * WOULD occupy once the generator lands (Phase 3) — Phase 0.5 never writes it,
 * the script is carried in `S5_GENERATED_TEST_SCRIPT`.
 */
export const S5_SPEC_ID = "tessera-s5-volume-discount";
export const S5_SPEC_PATH = "tests/generated/TesseraS5Target.volumeDiscount.js";
