// decidePropertyRows — the one rule for several sys_properties rows answering
// for one name, shared by @tessera/doctor and @tessera/phase05 (wave 16).
//
// The two probes used to carry diverging copies: the doctor read "production"
// from any seen row that was not `false`, phase05 only from a seen `true`, so
// `false` + `garbage` was production to one and unknown to the other. The
// cases below are exactly those that diverged.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ATF_RUNNER_SAFE_DIRECTION,
  decidePropertyRows,
  normalisePropertyValue,
  PRODUCTION_SAFE_DIRECTION,
  readsSafeDirection,
} from "../build/index.js";

const n = (values) => values.map(normalisePropertyValue);

describe("normalisePropertyValue", () => {
  it("trims and case-folds, nothing else", () => {
    assert.equal(normalisePropertyValue(" TRUE\n"), "true");
    assert.equal(normalisePropertyValue("False"), "false");
    assert.equal(normalisePropertyValue(""), "");
    assert.equal(normalisePropertyValue("  "), "");
    assert.equal(normalisePropertyValue("Yes"), "yes");
  });
});

describe("the declared safe directions", () => {
  it("production: only an exact `false` licenses non-production", () => {
    assert.deepEqual(PRODUCTION_SAFE_DIRECTION, {
      licensing: "false",
      canonical: "true",
    });
    for (const value of ["true", "garbage", "", "yes", "1", "no"]) {
      assert.equal(readsSafeDirection(value, PRODUCTION_SAFE_DIRECTION), true);
    }
    assert.equal(readsSafeDirection("false", PRODUCTION_SAFE_DIRECTION), false);
  });

  it("ATF runner: only an exact `true` licenses an enabled runner", () => {
    assert.deepEqual(ATF_RUNNER_SAFE_DIRECTION, {
      licensing: "true",
      canonical: "false",
    });
    for (const value of ["false", "garbage", "", "yes", "1"]) {
      assert.equal(readsSafeDirection(value, ATF_RUNNER_SAFE_DIRECTION), true);
    }
    assert.equal(readsSafeDirection("true", ATF_RUNNER_SAFE_DIRECTION), false);
  });

  it("is frozen, so no consumer can widen a direction at runtime", () => {
    assert.ok(Object.isFrozen(PRODUCTION_SAFE_DIRECTION));
    assert.ok(Object.isFrozen(ATF_RUNNER_SAFE_DIRECTION));
  });
});

describe("decidePropertyRows — production flag", () => {
  const P = PRODUCTION_SAFE_DIRECTION;

  it("a single row is agreed, whatever it reads", () => {
    for (const value of ["true", "false", "garbage", ""]) {
      assert.deepEqual(decidePropertyRows([value], true, P), {
        kind: "agreed",
        index: 0,
      });
    }
  });

  it("agreeing duplicates are one observation (`TRUE` and `true` agree)", () => {
    assert.deepEqual(decidePropertyRows(n(["TRUE", " true"]), true, P), {
      kind: "agreed",
      index: 0,
    });
    assert.deepEqual(decidePropertyRows(n(["false", " FALSE"]), true, P), {
      kind: "agreed",
      index: 0,
    });
  });

  for (const [values, index] of [
    [["true", "false"], 0],
    [["false", "true"], 1],
    // The previously divergent cases: phase05 read these as unknown.
    [["false", "garbage"], 1],
    [["false", ""], 1],
    [["false", "yes"], 1],
    // A canonical `true` is preferred over an earlier odd value.
    [["garbage", "false", "true"], 2],
    [["", "TRUE"], 1],
  ]) {
    it(`differing ${JSON.stringify(values)} resolve to production (row ${index})`, () => {
      assert.deepEqual(decidePropertyRows(n(values), true, P), {
        kind: "safe",
        index,
      });
    });
  }

  it("an incomplete read with a seen non-false row resolves to production", () => {
    assert.deepEqual(
      decidePropertyRows(n(["false", "false", "garbage"]), false, P),
      { kind: "safe", index: 2 },
    );
    assert.deepEqual(decidePropertyRows(n(["false", ""]), false, P), {
      kind: "safe",
      index: 1,
    });
    assert.deepEqual(decidePropertyRows(n(["false", "TRUE"]), false, P), {
      kind: "safe",
      index: 1,
    });
    // Agreeing rows in the safe direction resolve too: no unseen row can make
    // them less production.
    assert.deepEqual(decidePropertyRows(n(["true", "true"]), false, P), {
      kind: "safe",
      index: 0,
    });
  });

  it("an incomplete read with only `false` rows stays undecidable", () => {
    assert.deepEqual(
      decidePropertyRows(n(["false", " FALSE", "false"]), false, P),
      { kind: "undecidable", reason: "incomplete" },
    );
  });

  it("no rows: absent on a complete read, undecidable on an incomplete one", () => {
    assert.deepEqual(decidePropertyRows([], true, P), { kind: "absent" });
    assert.deepEqual(decidePropertyRows([], false, P), {
      kind: "undecidable",
      reason: "incomplete",
    });
  });
});

describe("decidePropertyRows — ATF runner (safe direction: not enabled)", () => {
  const R = ATF_RUNNER_SAFE_DIRECTION;

  for (const [values, index] of [
    [["true", "false"], 1],
    [["false", "true"], 0],
    [["true", "garbage"], 1],
    [["true", ""], 1],
    [["", "true", "false"], 2],
  ]) {
    it(`differing ${JSON.stringify(values)} resolve to not enabled (row ${index})`, () => {
      assert.deepEqual(decidePropertyRows(n(values), true, R), {
        kind: "safe",
        index,
      });
    });
  }

  it("an incomplete read with only `true` rows stays undecidable", () => {
    assert.deepEqual(decidePropertyRows(n(["true", "TRUE"]), false, R), {
      kind: "undecidable",
      reason: "incomplete",
    });
  });

  it("an incomplete read with a seen `false` resolves to not enabled", () => {
    assert.deepEqual(decidePropertyRows(n(["true", "false"]), false, R), {
      kind: "safe",
      index: 1,
    });
  });
});

describe("decidePropertyRows — no declared safe direction", () => {
  it("differing rows are undecidable, never resolved by order", () => {
    assert.deepEqual(decidePropertyRows(n(["1.0.0", "2.0.0"]), true), {
      kind: "undecidable",
      reason: "differing",
    });
    assert.deepEqual(
      decidePropertyRows(n(["true", "false"]), true, undefined),
      { kind: "undecidable", reason: "differing" },
    );
  });

  it("agreeing rows are agreed; an incomplete read is undecidable even so", () => {
    assert.deepEqual(decidePropertyRows(n(["1.0.0", "1.0.0"]), true), {
      kind: "agreed",
      index: 0,
    });
    assert.deepEqual(decidePropertyRows(n(["true"]), false), {
      kind: "undecidable",
      reason: "incomplete",
    });
  });
});
