// The Runner's last step: folding one `sys_atf_test_result` read into a row.
//
// THE PROPERTY UNDER TEST is QA-9 one level down (delegated decision
// 2026-09-23, option (a)): a result row whose status is green but whose
// output reported NO assertions is not a pass. `every()` over an empty
// outcome set is vacuously true, and both a real instance and the Tier-2
// substrate write "success" for a test that asserted nothing — so the Runner
// is the one place that can refuse to call it green.
//
// Each case asserts the row AND the event stream, because a row that says
// `error` while the stream said `pass` would still show a green step to
// anyone watching the run live.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TEST_RESULT_STATUS_FAIL,
  TEST_RESULT_STATUS_PASS,
} from "../build/atf.js";
import { parseAssertionOutput } from "../build/atfOutput.js";
import { SkeletonInfrastructureError } from "../build/errors.js";
import { createS5Runner, toOutcome } from "../build/runner.js";

const CTX = { runId: "run-1" };
const SPEC = { ref: { id: "s5", path: "specs/s5.json" }, kind: "unit" };

function fold(status, output) {
  const events = [];
  const outcome = toOutcome(
    CTX,
    SPEC,
    {
      testSysId: "t1",
      resultSysId: "r1",
      status,
      parsed: parseAssertionOutput(output),
    },
    (event) => events.push(event),
  );
  return { outcome, kinds: events.map((event) => event.kind), events };
}

describe("toOutcome — an empty outcome set is never a pass (QA-9)", () => {
  it("reports error, not pass, for a green row with empty output", () => {
    const { outcome, kinds, events } = fold(TEST_RESULT_STATUS_PASS, "");
    assert.equal(outcome.raw, "error");
    assert.deepEqual(kinds, ["error"]);
    assert.match(events[0].cause, /reported no assertions/);
    // The evidence still points at the row the verdict came from.
    assert.deepEqual(outcome.evidence, { kind: "atf-result", ref: "r1" });
  });

  it("reports error for a green row whose output parsed to no assertions", () => {
    // Unrecognised lines are surfaced as log events, but they are not
    // assertions, so they cannot earn the pass either.
    const { outcome, kinds } = fold(
      TEST_RESULT_STATUS_PASS,
      "some banner\nanother line",
    );
    assert.equal(outcome.raw, "error");
    assert.deepEqual(kinds, ["log", "log", "error"]);
  });

  it("still reports pass for a green row with at least one passing assertion", () => {
    const { outcome, kinds } = fold(
      TEST_RESULT_STATUS_PASS,
      "Assertion passed: zero units yield 0",
    );
    assert.equal(outcome.raw, "pass");
    assert.deepEqual(kinds, ["pass"]);
  });

  it("leaves a red row with no assertion detail a fail, unchanged", () => {
    const { outcome, kinds } = fold(TEST_RESULT_STATUS_FAIL, "");
    assert.equal(outcome.raw, "fail");
    assert.deepEqual(kinds, ["fail"]);
  });
});

// The remaining "finished without evidence" branches: each is an `error` row,
// never a pass and never a rejection (DEV-1).
describe("toOutcome — runs without usable evidence are errors", () => {
  it("reports error with log evidence when ATF wrote no result row", () => {
    const events = [];
    const outcome = toOutcome(CTX, SPEC, undefined, (event) =>
      events.push(event),
    );
    assert.equal(outcome.raw, "error");
    assert.equal(outcome.evidence.kind, "log");
    assert.deepEqual(
      events.map((event) => event.kind),
      ["error"],
    );
    assert.match(events[0].cause, /without per-test evidence/);
  });

  it("reports error for a status it cannot classify, even with passing assertions", () => {
    const { outcome, kinds, events } = fold(
      "skipped",
      "Assertion passed: zero units yield 0",
    );
    assert.equal(outcome.raw, "error");
    assert.deepEqual(kinds, ["error"]);
    assert.match(events[0].cause, /unclassifiable .*"skipped"/);
  });

  it("falls back to log evidence when the result row has no sys_id", () => {
    const outcome = toOutcome(
      CTX,
      SPEC,
      {
        testSysId: "t1",
        status: TEST_RESULT_STATUS_FAIL,
        parsed: parseAssertionOutput(""),
      },
      () => {},
    );
    assert.equal(outcome.raw, "fail");
    assert.equal(outcome.evidence.kind, "log");
    assert.match(outcome.evidence.ref, /no sys_id/);
  });
});

// `run()` refuses before touching the wire when it has nothing it could
// attribute a result to (ARCH-26): no projection map, or no entry for the spec.
describe("createS5Runner().run — attribution preconditions", () => {
  const runner = createS5Runner({ now: () => 0 });

  for (const [name, ctx, pattern] of [
    ["no ProjectionMap", { runId: "run-1" }, /no ProjectionMap/],
    [
      "an unprojected spec",
      { runId: "run-1", projection: {} },
      /was not projected/,
    ],
  ]) {
    it(`throws SkeletonInfrastructureError for ${name}, emitting nothing`, async () => {
      const events = [];
      await assert.rejects(
        runner.run(ctx, [SPEC], (event) => events.push(event)),
        (error) =>
          error instanceof SkeletonInfrastructureError &&
          pattern.test(error.message),
      );
      assert.deepEqual(events, []);
    });
  }
});
