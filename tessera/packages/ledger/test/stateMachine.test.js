// The §4b legality tables as pure rules. Asserted edge for edge so a later
// refactor cannot quietly widen the machine — an extra edge here is an extra
// way for a run to skip teardown.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LEDGER_ENTRY_TRANSITIONS,
  LedgerError,
  RUN_STATES,
  RUN_STATE_TRANSITIONS,
  TERMINAL_RUN_STATES,
  assertLegalRunTransition,
  isLegalEntryTransition,
  isLegalRunTransition,
  isTerminalRunState,
} from "../build/index.js";

describe("run state machine (§4b)", () => {
  it("enumerates exactly the nine §4b states", () => {
    assert.deepEqual(RUN_STATES, [
      "planned",
      "provisioning",
      "projecting",
      "running",
      "collecting",
      "tearing-down",
      "done",
      "failed",
      "abandoned",
    ]);
  });

  it("has a transition list for every state and only known targets", () => {
    for (const state of RUN_STATES) {
      const targets = RUN_STATE_TRANSITIONS[state];
      assert.ok(Array.isArray(targets), `${state} has no transition list`);
      for (const target of targets) {
        assert.ok(
          RUN_STATES.includes(target),
          `${state} → ${target} names an unknown state`,
        );
        assert.notEqual(target, state, `${state} lists itself as a target`);
      }
    }
  });

  it("matches the §4b table edge for edge", () => {
    assert.deepEqual(RUN_STATE_TRANSITIONS, {
      planned: ["provisioning", "done", "tearing-down", "abandoned"],
      provisioning: ["projecting", "tearing-down", "abandoned"],
      projecting: ["running", "tearing-down", "abandoned"],
      running: ["collecting", "abandoned"],
      collecting: ["tearing-down", "abandoned"],
      "tearing-down": ["done", "failed", "abandoned"],
      done: [],
      failed: ["tearing-down"],
      abandoned: ["tearing-down"],
    });
  });

  it("treats done/failed/abandoned as terminal, and only those", () => {
    assert.deepEqual(TERMINAL_RUN_STATES, ["done", "failed", "abandoned"]);
    for (const state of RUN_STATES) {
      assert.equal(
        isTerminalRunState(state),
        ["done", "failed", "abandoned"].includes(state),
        `${state} terminality is wrong`,
      );
    }
  });

  it("lets every non-terminal state be inferred abandoned (ARCH-32/DEV-25)", () => {
    for (const state of RUN_STATES) {
      if (isTerminalRunState(state)) {
        continue;
      }
      assert.ok(
        isLegalRunTransition(state, "abandoned"),
        `${state} cannot be abandoned`,
      );
    }
  });

  it("refuses tearing-down from running — a live instance run may delete nothing (DEV-17)", () => {
    assert.equal(isLegalRunTransition("running", "tearing-down"), false);
    assert.equal(isLegalRunTransition("collecting", "tearing-down"), true);
  });

  it("re-enters tearing-down from failed and abandoned, for cleanup only", () => {
    assert.equal(isLegalRunTransition("failed", "tearing-down"), true);
    assert.equal(isLegalRunTransition("abandoned", "tearing-down"), true);
    assert.equal(isLegalRunTransition("done", "tearing-down"), false);
  });

  it("throws a LedgerError naming the legal targets", () => {
    assert.throws(
      () => assertLegalRunTransition("running", "done"),
      (error) => {
        assert.ok(error instanceof LedgerError);
        assert.equal(error.code, "illegal-transition");
        assert.match(error.message, /collecting, abandoned/);
        return true;
      },
    );
  });

  it("reports a terminal state as having no legal targets", () => {
    assert.throws(
      () => assertLegalRunTransition("done", "running"),
      (error) => {
        assert.equal(error.code, "illegal-transition");
        assert.match(error.message, /nothing \(terminal\)/);
        return true;
      },
    );
  });
});

describe("ledger entry lifecycle (§4b)", () => {
  it("is intended → applied → compensated, with the W1 shortcut", () => {
    assert.deepEqual(LEDGER_ENTRY_TRANSITIONS, {
      intended: ["applied", "compensated"],
      applied: ["compensated"],
      compensated: [],
    });
  });

  it("never walks backwards", () => {
    assert.equal(isLegalEntryTransition("applied", "intended"), false);
    assert.equal(isLegalEntryTransition("compensated", "applied"), false);
    assert.equal(isLegalEntryTransition("compensated", "compensated"), false);
  });
});
