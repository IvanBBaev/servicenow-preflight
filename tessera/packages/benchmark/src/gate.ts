// The §13.1 OutcomeGate as a pure function: observations in, decision out.
//
// Three outcomes, and the difference between the last two is the point of the
// design, so it is kept structurally visible here:
//
//  * `go`   — both Wilson bounds clear AND every precondition holds.
//  * `miss` — a MEASURED run that missed: a bound, the per-category floor,
//             the composition floors, the repetition count, the determinism
//             variance or the pinned generation config (§13.2 Spike-5 row).
//             Routes to `descope` until an ADR says otherwise.
//  * `void` — the substrate could not be trusted (§13.4 SUB-1..SUB-5, the
//             drift smoke-test, an inconclusive run). NOT a fail and NOT a
//             miss: nothing was measured, the run is re-driven. The decision
//             still reads `descope` — §13.1's fail-closed default, "silence
//             resolves downward, never to GO" — but a void result carries no
//             rates at all, so it can never be mistaken for evidence.
//
// Nothing here tunes a threshold. `assertPolicyAtLeastDesign` refuses any
// policy weaker than the design's frozen floors: moving the bar is an ADR by
// the §13.3 decider, applied to a fresh run (§13.1 renegotiation rule), not a
// parameter.

import { minTrialsForZeroEventUpperBound, wilsonInterval } from "./wilson.js";
import type { WilsonInterval } from "./wilson.js";

/** DESIGN §13.1 — the six mutant categories, in the design's order. */
export const MUTANT_CATEGORIES = [
  "business-rule",
  "acl",
  "client-script-ui-policy",
  "flow-subflow",
  "script-include",
  "data-reference-integrity",
] as const;
export type MutantCategory = (typeof MUTANT_CATEGORIES)[number];

export function isMutantCategory(value: unknown): value is MutantCategory {
  return (
    typeof value === "string" &&
    (MUTANT_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * The frozen gate parameters. Every field is recorded in the result so the
 * §13.3 review reads the bar the run was scored against, not today's default.
 */
export interface OutcomeGatePolicy {
  /** N — seeded mutants, all categories together. */
  readonly minMutants: number;
  /** Composition floor: mutants authored in EVERY category. */
  readonly minPerCategory: number;
  /** Caught per category, out of `minPerCategory` (3 of 5). */
  readonly perCategoryFloor: number;
  /** Threshold on the kill rate's Wilson LOWER bound. */
  readonly minKillRate: number;
  /** M — correct-code baselines, disjoint from the mutants. */
  readonly minBaselines: number;
  /** Threshold on the false-green rate's Wilson UPPER bound. */
  readonly maxFalseGreenRate: number;
  /** k — generations per target, collapsed per target. */
  readonly minRepetitions: number;
  readonly confidence: number;
  /** SUB-4 determinism precondition: caught-set drift across reps. */
  readonly maxCaughtSetDrift: number;
}

/** DESIGN §13.1 exactly as written. */
export const DESIGN_GATE_POLICY: OutcomeGatePolicy = Object.freeze({
  minMutants: 30,
  minPerCategory: 5,
  perCategoryFloor: 3,
  minKillRate: 0.8,
  minBaselines: 35,
  maxFalseGreenRate: 0.1,
  minRepetitions: 3,
  confidence: 0.95,
  maxCaughtSetDrift: 2,
});

export class GatePolicyError extends Error {
  override readonly name = "GatePolicyError";
}

/**
 * Refuse a policy weaker than the design on any axis. A STRICTER policy is
 * accepted (it can only turn a go into a miss). `minBaselines` is also held to
 * the §13.1 formula for the policy's own threshold and confidence, so a
 * tightened false-green threshold cannot keep an M that no longer supports it.
 */
export function assertPolicyAtLeastDesign(policy: OutcomeGatePolicy): void {
  const d = DESIGN_GATE_POLICY;
  const problems: string[] = [];
  const intAtLeast = (key: keyof OutcomeGatePolicy, floor: number): void => {
    const value = policy[key];
    if (!Number.isInteger(value) || value < floor) {
      problems.push(`${key} must be an integer >= ${floor}`);
    }
  };
  intAtLeast("minMutants", d.minMutants);
  intAtLeast("minPerCategory", d.minPerCategory);
  intAtLeast("minRepetitions", d.minRepetitions);
  // The floor is a RATIO of the composition floor (3 of 5); a policy that
  // raises minPerCategory must raise the floor with it.
  if (
    !Number.isInteger(policy.perCategoryFloor) ||
    policy.perCategoryFloor * d.minPerCategory <
      d.perCategoryFloor * policy.minPerCategory ||
    policy.perCategoryFloor > policy.minPerCategory
  ) {
    problems.push(
      `perCategoryFloor must be an integer keeping at least ${d.perCategoryFloor}/${d.minPerCategory} of minPerCategory`,
    );
  }
  if (
    !Number.isInteger(policy.maxCaughtSetDrift) ||
    policy.maxCaughtSetDrift < 0 ||
    policy.maxCaughtSetDrift > d.maxCaughtSetDrift
  ) {
    problems.push(
      `maxCaughtSetDrift must be an integer in [0, ${d.maxCaughtSetDrift}]`,
    );
  }
  if (!(policy.minKillRate >= d.minKillRate) || !(policy.minKillRate < 1)) {
    problems.push(`minKillRate must be in [${d.minKillRate}, 1)`);
  }
  if (
    !(policy.maxFalseGreenRate > 0) ||
    !(policy.maxFalseGreenRate <= d.maxFalseGreenRate)
  ) {
    problems.push(`maxFalseGreenRate must be in (0, ${d.maxFalseGreenRate}]`);
  }
  if (!(policy.confidence >= d.confidence) || !(policy.confidence < 1)) {
    problems.push(`confidence must be in [${d.confidence}, 1)`);
  }
  if (problems.length === 0) {
    const formulaM = minTrialsForZeroEventUpperBound(
      policy.maxFalseGreenRate,
      policy.confidence,
    );
    if (
      !Number.isInteger(policy.minBaselines) ||
      policy.minBaselines < Math.max(d.minBaselines, formulaM)
    ) {
      problems.push(
        `minBaselines must be an integer >= ${Math.max(d.minBaselines, formulaM)} (ceil(z^2 (1 - t) / t) at the policy's threshold and confidence)`,
      );
    }
  }
  if (problems.length > 0) {
    throw new GatePolicyError(
      `gate policy is weaker than DESIGN §13.1 — ${problems.join("; ")}. Moving the bar is an ADR by the §13.3 decider, never a parameter.`,
    );
  }
}

/**
 * The per-category catch floor for `authored` mutants in one category:
 * ceil(authored × perCategoryFloor / minPerCategory). 3 at 5 authored.
 *
 * Delegated decision 2026-09-23: DESIGN gives the floor only at 5 authored
 * ("3 of 5") and calls it the scaling rule for larger N without the formula;
 * the ratio is kept and rounded UP, the fail-closed direction.
 */
export function perCategoryCatchFloor(
  authored: number,
  policy: OutcomeGatePolicy,
): number {
  return Math.ceil(
    (authored * policy.perCategoryFloor) / policy.minPerCategory,
  );
}

/** One scored mutant: caught per rep, in rep order. */
export interface MutantObservation {
  readonly id: string;
  readonly category: MutantCategory;
  readonly caughtPerRep: readonly boolean[];
}

/** One correct-code baseline: vacuous (false-green) per rep, in rep order. */
export interface BaselineObservation {
  readonly id: string;
  readonly vacuousPerRep: readonly boolean[];
}

export type VoidReasonCode =
  | "substrate-unhealthy" // SUB-1
  | "runner-lease-held" // SUB-2
  | "attribution-join-unpinned" // SUB-3
  | "attribution-mismatch" // SUB-3, observed during the run
  | "scope-reset-failed" // SUB-5
  | "drift-smoke-red" // §13.4 substrate drift
  | "inconclusive-run" // SUB-1: an INCONCLUSIVE / infra fault is not a miss
  | "aborted";

export type MissReasonCode =
  | "generation-unpinned"
  | "composition"
  | "repetitions"
  | "determinism-variance"
  | "per-category-floor"
  | "kill-rate-lower-bound"
  | "false-green-upper-bound";

export interface GateReason<C extends string> {
  readonly code: C;
  readonly detail: string;
}

export interface OutcomeGateInput {
  readonly policy: OutcomeGatePolicy;
  readonly mutants: readonly MutantObservation[];
  readonly baselines: readonly BaselineObservation[];
  /** The k the run was frozen at; every target must carry exactly k reps. */
  readonly repetitions: number;
  /** False when the PinnedGenConfig failed validation or was not recorded. */
  readonly generationPinned: boolean;
  /** Anything that voids the run. Non-empty ⇒ `void`, whatever was observed. */
  readonly voidReasons?: readonly GateReason<VoidReasonCode>[];
}

export interface CategoryScore {
  readonly category: MutantCategory;
  readonly authored: number;
  readonly caught: number;
  readonly floor: number;
  readonly met: boolean;
}

export interface DeterminismScore {
  /** Mutants caught in SOME rep but not ALL: |union − intersection|. */
  readonly drift: number;
  /** Size of each rep's caught set, in rep order. */
  readonly caughtPerRep: readonly number[];
  readonly max: number;
}

export interface OutcomeGateMeasurement {
  readonly kill: WilsonInterval;
  readonly falseGreen: WilsonInterval;
  readonly perCategory: readonly CategoryScore[];
  readonly determinism: DeterminismScore;
}

export type OutcomeGateResult =
  | {
      readonly status: "void";
      readonly decision: "descope";
      readonly reasons: readonly GateReason<VoidReasonCode>[];
      readonly policy: OutcomeGatePolicy;
    }
  | {
      readonly status: "go" | "miss";
      readonly decision: "go" | "descope";
      readonly reasons: readonly GateReason<MissReasonCode>[];
      readonly policy: OutcomeGatePolicy;
      readonly measurement: OutcomeGateMeasurement;
    };

/**
 * Collapse a target's reps to one verdict, worst-of-k in the fail-closed
 * direction for the event (§13.1 SUB-4): a GOOD event (caught) needs ALL reps,
 * a BAD event (vacuous) needs ANY rep. An empty rep list is never caught and
 * always vacuous.
 */
export function collapseCaught(reps: readonly boolean[]): boolean {
  return reps.length > 0 && reps.every(Boolean);
}
export function collapseVacuous(reps: readonly boolean[]): boolean {
  return reps.length === 0 || reps.some(Boolean);
}

/**
 * Caught-set drift across reps. Delegated decision 2026-09-23: DESIGN says
 * "the caught-set differs by > 2 mutants across reps" without fixing pairwise
 * vs overall; this counts every mutant whose reps disagree — |union −
 * intersection| — which is never smaller than any pairwise difference.
 */
export function caughtSetDrift(
  mutants: readonly MutantObservation[],
  repetitions: number,
): { drift: number; caughtPerRep: number[] } {
  const caughtPerRep = Array.from({ length: repetitions }, (_, rep) =>
    mutants.reduce((sum, m) => sum + (m.caughtPerRep[rep] === true ? 1 : 0), 0),
  );
  const drift = mutants.filter((m) => {
    const reps = m.caughtPerRep;
    return reps.some(Boolean) && !reps.every(Boolean);
  }).length;
  return { drift, caughtPerRep };
}

/** Score the §13.1 OutcomeGate. Pure; the fail-closed default is `descope`. */
export function scoreOutcomeGate(input: OutcomeGateInput): OutcomeGateResult {
  const { policy } = input;
  assertPolicyAtLeastDesign(policy);

  const voidReasons = input.voidReasons ?? [];
  if (voidReasons.length > 0) {
    return {
      status: "void",
      decision: "descope",
      reasons: voidReasons,
      policy,
    };
  }

  const reasons: GateReason<MissReasonCode>[] = [];
  const k = input.repetitions;

  if (!input.generationPinned) {
    reasons.push({
      code: "generation-unpinned",
      detail: "the PinnedGenConfig was not frozen and recorded before the run",
    });
  }

  // ── composition (N, per category, M) ────────────────────────────────────
  const n = input.mutants.length;
  const m = input.baselines.length;
  if (n < policy.minMutants) {
    reasons.push({
      code: "composition",
      detail: `N = ${n} mutants < ${policy.minMutants}`,
    });
  }
  if (m < policy.minBaselines) {
    reasons.push({
      code: "composition",
      detail: `M = ${m} baselines < ${policy.minBaselines}`,
    });
  }
  const perCategory: CategoryScore[] = MUTANT_CATEGORIES.map((category) => {
    const inCategory = input.mutants.filter((x) => x.category === category);
    const authored = inCategory.length;
    const caught = inCategory.filter((x) =>
      collapseCaught(x.caughtPerRep),
    ).length;
    const floor = Math.max(
      policy.perCategoryFloor,
      perCategoryCatchFloor(authored, policy),
    );
    return { category, authored, caught, floor, met: caught >= floor };
  });
  for (const score of perCategory) {
    if (score.authored < policy.minPerCategory) {
      reasons.push({
        code: "composition",
        detail: `category ${score.category}: ${score.authored} authored < ${policy.minPerCategory}`,
      });
    }
  }

  // ── repetitions ─────────────────────────────────────────────────────────
  if (!Number.isInteger(k) || k < policy.minRepetitions) {
    reasons.push({
      code: "repetitions",
      detail: `k = ${String(k)} < ${policy.minRepetitions}`,
    });
  }
  const ragged = [
    ...input.mutants
      .filter((x) => x.caughtPerRep.length !== k)
      .map((x) => x.id),
    ...input.baselines
      .filter((x) => x.vacuousPerRep.length !== k)
      .map((x) => x.id),
  ];
  if (ragged.length > 0) {
    reasons.push({
      code: "repetitions",
      detail: `${ragged.length} target(s) do not carry exactly k = ${String(k)} reps: ${ragged.slice(0, 5).join(", ")}`,
    });
  }

  // ── determinism (SUB-4) ─────────────────────────────────────────────────
  const drift = caughtSetDrift(input.mutants, Math.max(0, k));
  const determinism: DeterminismScore = {
    drift: drift.drift,
    caughtPerRep: drift.caughtPerRep,
    max: policy.maxCaughtSetDrift,
  };
  if (drift.drift > policy.maxCaughtSetDrift) {
    reasons.push({
      code: "determinism-variance",
      detail: `caught-set drift ${drift.drift} > ${policy.maxCaughtSetDrift} mutants across reps — determinism is broken`,
    });
  }

  // ── the two rates, two denominators ─────────────────────────────────────
  const caught = input.mutants.filter((x) =>
    collapseCaught(x.caughtPerRep),
  ).length;
  const vacuous = input.baselines.filter((x) =>
    collapseVacuous(x.vacuousPerRep),
  ).length;
  const kill = wilsonInterval(caught, n, policy.confidence);
  const falseGreen = wilsonInterval(vacuous, m, policy.confidence);

  for (const score of perCategory) {
    if (score.authored > 0 && !score.met) {
      reasons.push({
        code: "per-category-floor",
        detail: `category ${score.category}: ${score.caught} of ${score.authored} caught < floor ${score.floor}`,
      });
    }
  }
  if (!(kill.lower >= policy.minKillRate)) {
    reasons.push({
      code: "kill-rate-lower-bound",
      detail: `kill-rate Wilson lower bound ${kill.lower.toFixed(4)} < ${policy.minKillRate} (${caught}/${n})`,
    });
  }
  if (!(falseGreen.upper <= policy.maxFalseGreenRate)) {
    reasons.push({
      code: "false-green-upper-bound",
      detail: `false-green Wilson upper bound ${falseGreen.upper.toFixed(4)} > ${policy.maxFalseGreenRate} (${vacuous}/${m})`,
    });
  }

  const measurement: OutcomeGateMeasurement = {
    kill,
    falseGreen,
    perCategory,
    determinism,
  };
  if (reasons.length === 0) {
    return { status: "go", decision: "go", reasons, policy, measurement };
  }
  return { status: "miss", decision: "descope", reasons, policy, measurement };
}
