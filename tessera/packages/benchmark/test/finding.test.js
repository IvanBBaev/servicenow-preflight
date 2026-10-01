// The S5 output: a five-field SpikeFinding plus the keyed record. A FIXTURE
// catalog can never resolve S5; a void is "open", never a descope finding.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DESIGN_GATE_POLICY,
  S5_QUESTION,
  formatS5Record,
  scoreOutcomeGate,
  toS5Record,
  toSpikeFinding,
} from "../build/index.js";
import { FIXTURE_GEN_CONFIG } from "./fixtures/fixture-catalog.js";

const CATEGORIES = [
  "business-rule",
  "acl",
  "client-script-ui-policy",
  "flow-subflow",
  "script-include",
  "data-reference-integrity",
];

function observations({ missed = 0, vacuous = 0 } = {}) {
  const mutants = [];
  let n = 0;
  for (const category of CATEGORIES) {
    for (let i = 0; i < 5; i += 1) {
      const caught = n >= missed;
      mutants.push({
        id: `m-${n}`,
        category,
        caughtPerRep: [caught, caught, caught],
      });
      n += 1;
    }
  }
  const baselines = [];
  for (let i = 0; i < 35; i += 1) {
    const v = i < vacuous;
    baselines.push({ id: `b-${i}`, vacuousPerRep: [v, v, v] });
  }
  return { mutants, baselines };
}

/** A hand-built record over a NON-fixture catalog (no catalog content). */
function record(result, fixture = false) {
  return {
    runId: "run-1",
    catalog: {
      catalogVersion: fixture ? "FIXTURE v1" : "reviewed v1",
      mutantSetHash: "e".repeat(64),
      fixture,
    },
    key: {
      platformVersion: "build-x",
      mutantSetHash: "e".repeat(64),
      genConfig: FIXTURE_GEN_CONFIG,
    },
    repetitions: 3,
    result,
    mutants: [],
    baselines: [],
    warnings: [],
  };
}

const score = (extra) =>
  scoreOutcomeGate({
    policy: DESIGN_GATE_POLICY,
    repetitions: 3,
    generationPinned: true,
    ...extra,
  });

describe("toSpikeFinding", () => {
  test("go / miss / void map to go / descope / open", () => {
    const go = toSpikeFinding(record(score(observations())));
    assert.equal(go.outcome, "go");
    const miss = toSpikeFinding(record(score(observations({ vacuous: 1 }))));
    assert.equal(miss.outcome, "descope");
    assert.ok(
      miss.evidence.some((line) => line.startsWith("miss reason false-green")),
    );
    const voided = toSpikeFinding(
      record(
        score({
          ...observations(),
          voidReasons: [{ code: "drift-smoke-red", detail: "baseline red" }],
        }),
      ),
    );
    assert.equal(voided.outcome, "open");
    assert.match(voided.decision, /^VOID — .*not a miss/);
  });

  test("a fixture catalog forces open whatever it scored", () => {
    for (const result of [
      score(observations()),
      score(observations({ missed: 10 })),
    ]) {
      const finding = toSpikeFinding(record(result, true));
      assert.equal(finding.outcome, "open");
      assert.match(finding.decision, /^FIXTURE run \(scored (go|miss)\)/);
      assert.match(
        finding.evidence[0],
        /^FIXTURE catalog — not the benchmark set/,
      );
    }
  });

  test("evidence states the confidence the intervals were computed at", () => {
    const at95 = toSpikeFinding(record(score(observations())));
    assert.equal(
      at95.evidence.filter((l) => /, 95% Wilson \[/.test(l)).length,
      2,
    );
    // A stricter policy (delegated decision #26): the label follows it.
    const strict = {
      ...DESIGN_GATE_POLICY,
      confidence: 0.99,
      minBaselines: 60,
    };
    const obs = observations();
    for (let i = 35; i < 60; i += 1) {
      obs.baselines.push({
        id: `b-${i}`,
        vacuousPerRep: [false, false, false],
      });
    }
    const at99 = toSpikeFinding(
      record(
        scoreOutcomeGate({
          policy: strict,
          repetitions: 3,
          generationPinned: true,
          ...obs,
        }),
      ),
    );
    const lines = at99.evidence.filter((l) => / Wilson \[/.test(l));
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(line, /, 99% Wilson \[/);
      assert.doesNotMatch(line, /95%/);
    }
  });

  test("exactly the five SpikeFinding fields, S5 question verbatim", () => {
    const finding = toSpikeFinding(record(score(observations())));
    assert.deepEqual(Object.keys(finding).sort(), [
      "decision",
      "evidence",
      "outcome",
      "question",
      "spike",
    ]);
    assert.equal(finding.spike, "S5");
    assert.equal(finding.question, S5_QUESTION);
  });
});

describe("toS5Record / formatS5Record", () => {
  test("a measured record carries the key, its hash and the rates", () => {
    const run = record(score(observations()));
    const json = JSON.parse(formatS5Record(run));
    assert.equal(json.status, "go");
    assert.equal(json.fixture, false);
    assert.match(json.keyHash, /^[0-9a-f]{64}$/);
    assert.equal(json.measurement.kill.successes, 30);
    assert.equal(json.measurement.falseGreen.trials, 35);
    assert.deepEqual(json.policy, { ...DESIGN_GATE_POLICY });
    assert.ok(formatS5Record(run).endsWith("}\n"));
  });

  test("a void record has no measurement", () => {
    const run = record(
      score({
        ...observations(),
        voidReasons: [{ code: "substrate-unhealthy", detail: "asleep" }],
      }),
    );
    run.key = null;
    const s5 = toS5Record(run);
    assert.equal(s5.measurement, null);
    assert.equal(s5.keyHash, null);
    assert.deepEqual(s5.reasons, [
      { code: "substrate-unhealthy", detail: "asleep" },
    ]);
  });
});
