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
import { toOutcome } from "../build/runner.js";

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
