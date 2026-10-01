// The S5 output: a `SpikeFinding` (docs SPIKE-FINDINGS.md shape, exactly its
// five fields) plus the keyed result record §13.4 asks for —
// `{platformVersion, mutantSetHash, genConfig} -> {killWilson, falseGreenWilson}`.
//
// Mapping (DESIGN §13.1–§13.3):
//   go   → outcome "go"
//   miss → outcome "descope" (§13.2: a miss descopes; only an ADR on a fresh
//          run changes that)
//   void → outcome "open" — nothing was measured, so S5 is still unresolved
//          and the §13.3 "unmeasured ⇒ STOP" default keeps applying.
// A FIXTURE catalog forces "open" whatever it scored: a fixture is not the
// benchmark set and can never resolve S5.

import type { OutcomeGateMeasurement, OutcomeGatePolicy } from "./gate.js";
import type { BenchmarkRunRecord } from "./harness.js";
import type { ResultKey } from "./key.js";
import { resultKeyHash } from "./key.js";

export type SpikeOutcome = "go" | "descope" | "kill" | "open";

export interface SpikeFinding {
  readonly spike: "S0" | "S2b" | "S5" | "SDIST";
  readonly question: string;
  readonly outcome: SpikeOutcome;
  readonly evidence: readonly string[];
  readonly decision: string;
}

/** The S5 question verbatim from SPIKE-FINDINGS.md. */
export const S5_QUESTION =
  "Do generated tests actually catch a seeded bug (mutation-kill 95% Wilson lower bound >= 0.80, false-green 95% Wilson upper bound <= 0.10)?";

export interface S5Record {
  readonly finding: SpikeFinding;
  readonly runId: string;
  readonly status: "go" | "miss" | "void";
  readonly fixture: boolean;
  readonly catalogVersion: string;
  /** `null` when the run voided before the platform stamp was read. */
  readonly key: ResultKey | null;
  readonly keyHash: string | null;
  readonly repetitions: number;
  readonly policy: OutcomeGatePolicy;
  /** `null` for a void run: a void carries no rates. */
  readonly measurement: OutcomeGateMeasurement | null;
  readonly reasons: readonly {
    readonly code: string;
    readonly detail: string;
  }[];
  readonly warnings: readonly string[];
}

function bound(value: number): string {
  return value.toFixed(4);
}

/**
 * The interval's own confidence as a percentage label (`0.95` → `"95%"`,
 * `0.975` → `"97.5%"`). Delegated decision 2026-09-24 (#26): the evidence
 * line states the confidence the interval was ACTUALLY computed at (a policy
 * may raise it above DESIGN's 0.95), not a hardcoded "95%". `S5_QUESTION`
 * keeps its "95%" — it quotes SPIKE-FINDINGS.md verbatim.
 */
function percent(confidence: number): string {
  return `${String(Number((confidence * 100).toFixed(6)))}%`;
}

/** The five-field SpikeFinding for one benchmark run. */
export function toSpikeFinding(run: BenchmarkRunRecord): SpikeFinding {
  const { result } = run;
  const evidence: string[] = [];
  if (run.catalog.fixture) {
    evidence.push(
      "FIXTURE catalog — not the benchmark set; this record cannot resolve S5",
    );
  }
  evidence.push(
    `run ${run.runId}: catalog ${run.catalog.catalogVersion} (mutantSetHash ${run.catalog.mutantSetHash}), k = ${run.repetitions}`,
  );
  if (run.key !== null) {
    evidence.push(
      `key: platformVersion ${run.key.platformVersion}, model ${run.key.genConfig.modelId}, promptVersion ${run.key.genConfig.promptVersion} (keyHash ${resultKeyHash(run.key)})`,
    );
  }
  if (result.status !== "void") {
    const { kill, falseGreen, determinism } = result.measurement;
    evidence.push(
      `kill: ${kill.successes}/${kill.trials} caught (worst-of-k), ${percent(kill.confidence)} Wilson [${bound(kill.lower)}, ${bound(kill.upper)}], threshold lower >= ${result.policy.minKillRate}`,
      `false-green: ${falseGreen.successes}/${falseGreen.trials} vacuous (worst-of-k), ${percent(falseGreen.confidence)} Wilson [${bound(falseGreen.lower)}, ${bound(falseGreen.upper)}], threshold upper <= ${result.policy.maxFalseGreenRate}`,
      `per-category caught: ${result.measurement.perCategory.map((c) => `${c.category} ${c.caught}/${c.authored} (floor ${c.floor})`).join(", ")}`,
      `determinism: caught-set drift ${determinism.drift} (max ${determinism.max}), caught per rep [${determinism.caughtPerRep.join(", ")}]`,
    );
  }
  for (const reason of result.reasons) {
    evidence.push(`${result.status} reason ${reason.code}: ${reason.detail}`);
  }
  for (const warning of run.warnings) evidence.push(`warning: ${warning}`);

  let outcome: SpikeOutcome;
  let decision: string;
  if (result.status === "void") {
    outcome = "open";
    decision =
      "VOID — the substrate could not be trusted, nothing was measured; not a miss and not a finding. Re-drive on a healthy substrate; until a measured result exists the §13.3 default (STOP) applies.";
  } else if (result.status === "miss") {
    outcome = "descope";
    decision =
      "MISS — per §13.2 the generation feature descopes to verdict-only; only an ADR by the §13.3 decider, applied to a fresh run, can change the bar.";
  } else {
    outcome = "go";
    decision =
      "GO — both Wilson bounds clear and every precondition held; valid only for the recorded {platformVersion, mutantSetHash, genConfig} key.";
  }
  if (run.catalog.fixture) {
    outcome = "open";
    decision = `FIXTURE run (scored ${result.status}) — not evidence for S5. ${decision}`;
  }
  return { spike: "S5", question: S5_QUESTION, outcome, evidence, decision };
}

/** The full S5 record; `JSON.stringify`-safe (a NaN point becomes `null`). */
export function toS5Record(run: BenchmarkRunRecord): S5Record {
  const { result } = run;
  return {
    finding: toSpikeFinding(run),
    runId: run.runId,
    status: result.status,
    fixture: run.catalog.fixture,
    catalogVersion: run.catalog.catalogVersion,
    key: run.key,
    keyHash: run.key === null ? null : resultKeyHash(run.key),
    repetitions: run.repetitions,
    policy: result.policy,
    measurement: result.status === "void" ? null : result.measurement,
    reasons: result.reasons,
    warnings: run.warnings,
  };
}

/** Pretty JSON for the record file. */
export function formatS5Record(run: BenchmarkRunRecord): string {
  return `${JSON.stringify(toS5Record(run), null, 2)}\n`;
}
