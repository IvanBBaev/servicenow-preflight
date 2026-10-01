// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// The one `TestSpec` Phase 0.5 plans. In Phase 3 the generator produces this
// object from the impact graph; here it is a constructor over the reviewed
// s5-probe fixture, so the pipeline still receives a spec of exactly the shape
// a generator will emit — `targets` declares the spec↔artifact link coverage
// joins on (QA-16), and `payload` carries the runner-specific body (§6).

import type { TargetArtifactRef, TestSpec } from "@tessera/types";

import {
  S5_GENERATED_TEST_SCRIPT,
  S5_SPEC_ID,
  S5_SPEC_PATH,
  S5_THRESHOLD_ASSERTION,
} from "./fixtures.js";

/**
 * The ATF-runner payload contract for Phase 0.5. `Runner.run` never reads it —
 * the TestStore does, when it authors the step — but it belongs on the spec
 * rather than in the store so the store stays a projector of whatever it is
 * handed rather than a second copy of the fixture.
 */
export interface S5AtfPayload {
  /** Body of the "Run Server Side Script" step (DR-1). */
  readonly script: string;
  /**
   * Assertion names the script is expected to report, in order. Today this
   * is read only by `isS5AtfPayload`'s shape check: nothing compares the
   * reported assertion count against it (option (b) of the 2026-09-23 QA-9
   * ruling was NOT taken). What IS enforced is weaker and cheaper — the
   * Runner refuses to report `pass` for a result row that carried no
   * assertions at all (`runner.ts` `toOutcome`, option (a)).
   */
  readonly assertions: readonly string[];
}

export function isS5AtfPayload(value: unknown): value is S5AtfPayload {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { script?: unknown; assertions?: unknown };
  return (
    typeof candidate.script === "string" && Array.isArray(candidate.assertions)
  );
}

/** Assertion names of the fixture, in source order (see `fixtures.ts`). */
export const S5_ASSERTION_NAMES: readonly string[] = [
  "below threshold: 99 units pay full price",
  S5_THRESHOLD_ASSERTION,
  "above threshold: 150 units get 10% off",
  "result is rounded to 2 decimals",
  "zero units yield 0",
  "negative unit price yields 0",
];

/** Build the single hardcoded spec against the artifact the resolver found. */
export function createS5Spec(target: TargetArtifactRef): TestSpec {
  const payload: S5AtfPayload = {
    script: S5_GENERATED_TEST_SCRIPT,
    assertions: S5_ASSERTION_NAMES,
  };
  return {
    ref: { id: S5_SPEC_ID, path: S5_SPEC_PATH },
    kind: "unit",
    targets: [target],
    payload,
  };
}
