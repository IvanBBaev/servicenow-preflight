// The ATF `output` wording — the package's one admittedly GUESSED contract.
//
// THE PROPERTY UNDER TEST, in the module's own words: "an unparsable `output`
// degrades to 'the suite failed' honestly rather than silently reporting zero
// failed assertions", and "Lines the patterns below did not recognise —
// surfaced, never dropped."
//
// Both halves matter, and the second is the one a careless suite loses. A
// parser that silently discards what it cannot read reports the same thing as a
// parser that read a clean pass: zero failures. So every case below asserts
// where an unrecognised line WENT, not merely that it was not scored.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  failedAssertionNames,
  formatAssertionLine,
  formatAtfOutput,
  parseAssertionOutput,
  STEP_ERROR_PREFIX,
} from "../build/atfOutput.js";

describe("formatAssertionLine / parseAssertionOutput round trip", () => {
  it("reads back every assertion the writer wrote, in order", () => {
    const outcomes = [
      { name: "below threshold: 99 units pay full price", passed: true },
      {
        name: "at threshold: exactly 100 units get 10% off",
        passed: false,
        detail: "expected 900, got 1000",
      },
      { name: "zero units yield 0", passed: true },
    ];
    const parsed = parseAssertionOutput(formatAtfOutput(outcomes));
    assert.deepEqual(parsed.assertions, outcomes);
    assert.deepEqual(parsed.unparsed, []);
  });

  it("does not round-trip a name containing the detail separator", () => {
    // KNOWN, PINNED lossiness: the writer emits no separator for a detail-free
    // outcome, but the reader splits on the first " -- " wherever it came from,
    // so such a name comes back shortened with an invented detail. Pinned
    // rather than "fixed" — the wording is a documented guess (module header),
    // and a silent change on either side must reden a test.
    const parsed = parseAssertionOutput(
      formatAssertionLine({ name: "a -- b is not a detail", passed: true }),
    );
    assert.deepEqual(parsed.assertions, [
      { name: "a", passed: true, detail: "b is not a detail" },
    ]);
    assert.deepEqual(parsed.unparsed, []);
  });

  it("an empty detail is omitted rather than written as an empty tail", () => {
    assert.equal(
      formatAssertionLine({ name: "x", passed: true, detail: "" }),
      "Assertion passed: x",
    );
  });
});

describe("parseAssertionOutput", () => {
  it("surfaces an unrecognised line instead of dropping it", () => {
    const parsed = parseAssertionOutput(
      "Assertion passed: one\nsomething the patterns do not know\nAssertion passed: two",
    );
    assert.equal(parsed.assertions.length, 2);
    assert.deepEqual(parsed.unparsed, ["something the patterns do not know"]);
  });

  it("scores an unrecognised line as neither a pass nor a failure", () => {
    // The dangerous collapse: counting an unreadable line as a pass makes a run
    // green that nobody read, and dropping it makes the same run look clean.
    const parsed = parseAssertionOutput("total gibberish");
    assert.deepEqual(parsed.assertions, []);
    assert.deepEqual(failedAssertionNames(parsed), []);
    assert.equal(parsed.unparsed.length, 1);
  });

  it("distinguishes 'nothing was reported' from 'everything passed'", () => {
    // Both produce zero failures. Only the assertion COUNT tells them apart,
    // which is why a caller must never read `failedAssertionNames().length ===
    // 0` as evidence of a green test.
    const nothing = parseAssertionOutput("");
    assert.deepEqual(nothing.assertions, []);
    assert.deepEqual(nothing.unparsed, []);

    const green = parseAssertionOutput("Assertion passed: one");
    assert.equal(green.assertions.length, 1);
    assert.deepEqual(failedAssertionNames(green), []);
  });

  it("keeps a step error out of the assertion list", () => {
    const output = formatAtfOutput(
      [{ name: "one", passed: true }],
      `${STEP_ERROR_PREFIX} TesseraS5Target is not defined`,
    );
    const parsed = parseAssertionOutput(output);
    assert.equal(parsed.assertions.length, 1);
    assert.equal(parsed.assertions[0].passed, true);
    assert.deepEqual(parsed.unparsed, [
      "Step error: TesseraS5Target is not defined",
    ]);
  });

  it("reads the tolerated alternative wordings the module documents", () => {
    const parsed = parseAssertionOutput(
      [
        "[PASS] - alpha",
        "FAILED: beta",
        "ok - gamma",
        "[failure] : delta",
      ].join("\n"),
    );
    assert.deepEqual(
      parsed.assertions.map((a) => [a.name, a.passed]),
      [
        ["alpha", true],
        ["beta", false],
        ["gamma", true],
        ["delta", false],
      ],
    );
    assert.deepEqual(parsed.unparsed, []);
  });

  it("does not turn a blank line into an unparsed finding", () => {
    const parsed = parseAssertionOutput("\n\nAssertion passed: one\n   \n");
    assert.equal(parsed.assertions.length, 1);
    assert.deepEqual(parsed.unparsed, []);
  });

  it("splits the detail off the name at the documented separator", () => {
    const parsed = parseAssertionOutput(
      "Assertion failed: at threshold -- expected 900, got 1000",
    );
    assert.deepEqual(parsed.assertions, [
      {
        name: "at threshold",
        passed: false,
        detail: "expected 900, got 1000",
      },
    ]);
  });
});

describe("failedAssertionNames", () => {
  it("returns only the failures, in report order", () => {
    const parsed = parseAssertionOutput(
      [
        "Assertion passed: a",
        "Assertion failed: b",
        "Assertion passed: c",
        "Assertion failed: d",
      ].join("\n"),
    );
    assert.deepEqual(failedAssertionNames(parsed), ["b", "d"]);
  });
});
