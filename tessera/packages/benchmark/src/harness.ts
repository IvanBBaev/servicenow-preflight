// The §13.4 substrate harness: drive a loaded catalog through the pipeline
// ports and turn what comes back into §13.1 observations.
//
// Everything that touches an instance is an INJECTED port, and every port
// fails closed: a precondition that cannot be proved is a void, a rejected
// run is a void, an outcome that cannot be attributed is a void. Nothing
// here talks to ServiceNow — a live substrate adapter plugs into
// `BenchmarkSubstrate`; tests plug in `@tessera/fake-instance`.
//
// Order of a run (each step a hard gate on the next):
//   1. PinnedGenConfig validated — unpinned ⇒ miss, nothing is driven.
//   2. SUB-1 "substrate healthy" — distinct from "Tessera healthy".
//   3. SUB-3 attribution join pinned — unpinned ⇒ no scoring.
//   4. SUB-2 exclusive runner lease — held ⇒ refuse to start.
//   5. platform version stamped (the result key).
//   6. drift smoke-test: every baseline green on unchanged source, else void.
//   7. per mutant × rep, then per baseline × rep: SUB-5 fresh scope,
//      generate → stage → run → collect, every run run-id scoped.
//   8. once any source was applied, a best-effort final SUB-5 restore
//      (`<runId>:final`) so no mutant or detonator is left live — BEFORE
//      the lease is released, so the next holder never sees a dirty scope.
//   9. lease released in `finally`, whatever happened.

import { specKey } from "@tessera/core";
import type {
  ImpactAnalyzer,
  Runner,
  TestGenerator,
  TestStore,
} from "@tessera/core";
import type {
  AffectedArtifact,
  PipelineContext,
  PipelineTopology,
  RunResult,
  TargetArtifactRef,
  TestEvent,
  TestKind,
  TestSpec,
} from "@tessera/types";

import type {
  BenchmarkCatalog,
  CatalogBaseline,
  CatalogMutant,
} from "./catalog.js";
import { assertPolicyAtLeastDesign, scoreOutcomeGate } from "./gate.js";
import type {
  BaselineObservation,
  GateReason,
  MutantObservation,
  OutcomeGatePolicy,
  OutcomeGateResult,
  VoidReasonCode,
} from "./gate.js";
import { pinnedGenConfigProblems } from "./key.js";
import type { PinnedGenConfig, ResultKey } from "./key.js";

/** Which source a target carries for one run. */
export type SourceVariant =
  | { readonly kind: "correct" }
  | { readonly kind: "mutant"; readonly id: string; readonly diff: string }
  | { readonly kind: "detonator"; readonly id: string; readonly diff: string };

export interface SubstrateCheck {
  readonly ok: boolean;
  readonly detail: string;
}

export interface RunnerLease {
  release(): Promise<void>;
}

/**
 * Everything the harness needs from the benchmark instance. A live adapter
 * implements this against a PDI; a method that cannot answer must reject or
 * report `ok: false` — never guess.
 */
export interface BenchmarkSubstrate {
  /** SUB-1: awake, HTTP-clean, not a wake interstitial. */
  checkHealthy(signal: AbortSignal): Promise<SubstrateCheck>;
  /** SUB-3: the run→result join field is pinned. */
  checkAttributionJoinPinned(signal: AbortSignal): Promise<SubstrateCheck>;
  /** SUB-2: take the exclusive runner lease, or `null` when it is held. */
  acquireRunnerLease(runId: string): Promise<RunnerLease | null>;
  /** SUB-5: reset the benchmark scope; reject when it could not be reset. */
  resetScope(runId: string): Promise<void>;
  /** The platform stamp for the result key. */
  platformVersion(): Promise<string>;
  /** Put `variant` of the target's source in place. */
  applySource(
    target: TargetArtifactRef,
    behaviour: string,
    variant: SourceVariant,
  ): Promise<void>;
  /** Drift smoke-test for one baseline on unchanged source. */
  smokeBaseline(
    baseline: CatalogBaseline,
    runId: string,
  ): Promise<"green" | "red">;
  /**
   * Optional: hand the run's catalog to the substrate before anything is
   * read or written, so it can refuse to adopt a live mutant/detonator text
   * as "correct" (F4).
   */
  bindCatalog?(catalog: Pick<BenchmarkCatalog, "mutants" | "baselines">): void;
  /**
   * Optional: the run's LAST restore — stronger than `resetScope` (verified,
   * retried, durable-journal aware). When absent the harness falls back to
   * `resetScope("<runId>:final")`.
   */
  restoreFinal?(runId: string): Promise<void>;
}

/** The pipeline stages the benchmark drives — the same ports `tess` runs. */
export interface BenchmarkPipeline {
  readonly impact: ImpactAnalyzer;
  readonly generator: TestGenerator;
  readonly store: TestStore;
  readonly runner: Runner;
  readonly kind: TestKind;
}

export interface BenchmarkRunOptions {
  readonly runId: string;
  readonly catalog: BenchmarkCatalog;
  readonly genConfig: PinnedGenConfig;
  readonly policy: OutcomeGatePolicy;
  /** k — at least `policy.minRepetitions`. */
  readonly repetitions: number;
  readonly substrate: BenchmarkSubstrate;
  readonly pipeline: BenchmarkPipeline;
  readonly topology?: PipelineTopology;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: TestEvent) => void;
}

export interface BenchmarkRunRecord {
  readonly runId: string;
  readonly catalog: {
    readonly catalogVersion: string;
    readonly mutantSetHash: string;
    readonly fixture: boolean;
  };
  /** `null` when the run voided before the platform version was read. */
  readonly key: ResultKey | null;
  readonly repetitions: number;
  readonly result: OutcomeGateResult;
  readonly mutants: readonly MutantObservation[];
  readonly baselines: readonly BaselineObservation[];
  /** Non-scoring notes, e.g. a lease that failed to release. */
  readonly warnings: readonly string[];
}

/** One run's colour, or the reason it has none. */
type RunColour =
  | { readonly colour: "green" | "red" }
  | { readonly void: GateReason<VoidReasonCode> };

class VoidRun extends Error {
  override readonly name = "VoidRun";
  constructor(readonly reason: GateReason<VoidReasonCode>) {
    super(`${reason.code}: ${reason.detail}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Collapse one attributed RunResult to green / red, or void it.
 *
 * Delegated decision 2026-09-23: green = every outcome `pass` (an EMPTY suite
 * is green — an empty suite is the most vacuous one there is); red = at least
 * one `fail` and nothing inconclusive; any `error` / `skipped` /
 * `waiting-timeout` / `flaky` / `missing` row is inconclusive (the core
 * reducer's table) and voids the run — SUB-1 says an INCONCLUSIVE is never a
 * missed mutant.
 */
export function colourOf(
  result: RunResult,
  runId: string,
  specs: readonly TestSpec[],
): RunColour {
  if (result.runId !== runId) {
    return {
      void: {
        code: "attribution-mismatch",
        detail: `run ${runId} returned rows for run ${result.runId}`,
      },
    };
  }
  const planned = new Set(specs.map((s) => specKey(s.ref)));
  const seen = new Set<string>();
  let failed = false;
  for (const outcome of result.outcomes) {
    const key = specKey(outcome.spec);
    if (!planned.has(key)) {
      return {
        void: {
          code: "attribution-mismatch",
          detail: `run ${runId} returned a row for unplanned spec ${outcome.spec.id}`,
        },
      };
    }
    seen.add(key);
    if (outcome.raw === "fail") failed = true;
    else if (outcome.raw !== "pass") {
      return {
        void: {
          code: "inconclusive-run",
          detail: `run ${runId}: spec ${outcome.spec.id} is ${outcome.raw}`,
        },
      };
    }
  }
  if (seen.size !== planned.size) {
    return {
      void: {
        code: "inconclusive-run",
        detail: `run ${runId}: ${planned.size - seen.size} planned spec(s) have no result row (missing)`,
      },
    };
  }
  return { colour: failed ? "red" : "green" };
}

/**
 * Drive the catalog and score it. Resolves with a record for every outcome —
 * go, miss or void; rejects only on a policy weaker than DESIGN (a programmer
 * error, `GatePolicyError`) or a bad `repetitions` argument.
 */
export async function runBenchmark(
  options: BenchmarkRunOptions,
): Promise<BenchmarkRunRecord> {
  const { runId, catalog, genConfig, policy, repetitions, substrate } = options;
  assertPolicyAtLeastDesign(policy);
  if (!Number.isInteger(repetitions) || repetitions < policy.minRepetitions) {
    throw new RangeError(
      `repetitions must be an integer >= ${policy.minRepetitions}, got ${String(repetitions)}`,
    );
  }
  const signal = options.signal ?? new AbortController().signal;
  const topology: PipelineTopology = options.topology ?? {
    source: "benchmark",
    runner: "benchmark",
    target: "benchmark",
  };
  const warnings: string[] = [];
  const mutants: MutantObservation[] = [];
  const baselines: BaselineObservation[] = [];
  let key: ResultKey | null = null;

  const record = (result: OutcomeGateResult): BenchmarkRunRecord => ({
    runId,
    catalog: {
      catalogVersion: catalog.catalogVersion,
      mutantSetHash: catalog.mutantSetHash,
      fixture: catalog.fixture,
    },
    key,
    repetitions,
    result,
    mutants,
    baselines,
    warnings,
  });
  const voided = (reason: GateReason<VoidReasonCode>): BenchmarkRunRecord =>
    record(
      scoreOutcomeGate({
        policy,
        mutants,
        baselines,
        repetitions,
        generationPinned: true,
        voidReasons: [reason],
      }),
    );

  // 1. Pinned generation — a miss, not a void: the run is the generator's own
  // configuration failing §13.2's "pinned generation config" precondition.
  const genProblems = pinnedGenConfigProblems(genConfig);
  if (genProblems.length > 0) {
    warnings.push(`genConfig not pinned: ${genProblems.join("; ")}`);
    return record(
      scoreOutcomeGate({
        policy,
        mutants,
        baselines,
        repetitions,
        generationPinned: false,
      }),
    );
  }

  // Delegated decision 2026-09-26 (F4): the substrate learns the run's own
  // catalog before anything is read or written — the authoritative source of
  // "texts that must never be captured as correct". A bind that throws voids
  // the run before any write (fail closed).
  try {
    substrate.bindCatalog?.(catalog);
  } catch (error) {
    return voided({
      code: "substrate-unhealthy",
      detail: `the substrate refused the catalog: ${describe(error)}`,
    });
  }

  // 2–3. SUB-1 then SUB-3, both before anything is written.
  const precondition = async (
    code: VoidReasonCode,
    check: () => Promise<SubstrateCheck>,
  ): Promise<GateReason<VoidReasonCode> | null> => {
    try {
      const result = await check();
      return result.ok === true ? null : { code, detail: result.detail };
    } catch (error) {
      return { code, detail: `check rejected: ${describe(error)}` };
    }
  };
  const unhealthy = await precondition("substrate-unhealthy", () =>
    substrate.checkHealthy(signal),
  );
  if (unhealthy !== null) return voided(unhealthy);
  const unpinned = await precondition("attribution-join-unpinned", () =>
    substrate.checkAttributionJoinPinned(signal),
  );
  if (unpinned !== null) return voided(unpinned);

  // 4. SUB-2 — refuse to start while another holder owns the runner.
  let lease: RunnerLease | null;
  try {
    lease = await substrate.acquireRunnerLease(runId);
  } catch (error) {
    return voided({
      code: "runner-lease-held",
      detail: `lease acquisition rejected: ${describe(error)}`,
    });
  }
  if (lease === null) {
    return voided({
      code: "runner-lease-held",
      detail:
        "the exclusive runner lease is held by another run — refusing to start",
    });
  }

  const drive = new Driver(options, signal, topology, warnings);
  const driveAndScore = async (): Promise<BenchmarkRunRecord> => {
    try {
      // 5. Platform stamp.
      let platformVersion: string;
      try {
        platformVersion = await substrate.platformVersion();
      } catch (error) {
        return voided({
          code: "substrate-unhealthy",
          detail: `platform version unreadable: ${describe(error)}`,
        });
      }
      if (
        typeof platformVersion !== "string" ||
        platformVersion.trim() === ""
      ) {
        return voided({
          code: "substrate-unhealthy",
          detail: "platform version is empty",
        });
      }
      key = {
        platformVersion,
        mutantSetHash: catalog.mutantSetHash,
        genConfig,
      };

      // 6. Drift smoke-test.
      for (const baseline of catalog.baselines) {
        throwIfAborted(signal);
        let smoke: "green" | "red";
        try {
          smoke = await substrate.smokeBaseline(
            baseline,
            `${runId}:smoke:${baseline.id}`,
          );
        } catch (error) {
          throw new VoidRun({
            code: "drift-smoke-red",
            detail: `smoke-test for baseline ${baseline.id} rejected: ${describe(error)}`,
          });
        }
        if (smoke !== "green") {
          throw new VoidRun({
            code: "drift-smoke-red",
            detail: `baseline ${baseline.id} is red on unchanged source — the substrate drifted`,
          });
        }
      }

      // 7. The scored runs.
      for (const mutant of catalog.mutants) {
        const reps: boolean[] = [];
        for (let rep = 0; rep < repetitions; rep += 1) {
          reps.push(await drive.mutantRep(mutant, rep));
        }
        mutants.push({
          id: mutant.id,
          category: mutant.category,
          caughtPerRep: reps,
        });
      }
      for (const baseline of catalog.baselines) {
        const reps: boolean[] = [];
        for (let rep = 0; rep < repetitions; rep += 1) {
          reps.push(await drive.baselineRep(baseline, rep));
        }
        baselines.push({ id: baseline.id, vacuousPerRep: reps });
      }

      return record(
        scoreOutcomeGate({
          policy,
          mutants,
          baselines,
          repetitions,
          generationPinned: true,
        }),
      );
    } catch (error) {
      if (error instanceof VoidRun) return voided(error.reason);
      if (signal.aborted) {
        return voided({
          code: "aborted",
          detail: describe(signal.reason ?? error),
        });
      }
      // Delegated decision 2026-09-23: any other fault while driving (a stage
      // port rejecting, source that cannot be applied) is infrastructure, not
      // evidence — void, never a miss.
      return voided({
        code: "inconclusive-run",
        detail: `infrastructure fault: ${describe(error)}`,
      });
    }
  };

  // Delegated decision 2026-09-24 (#21, #22): every scored run leaves its
  // LAST variant (a baseline's detonator, or — on a mid-run void/abort — a
  // mutant) live, and nothing else restores it. Once any source was applied,
  // restore the scope one last time BEFORE the lease is released, so the next
  // holder never inherits a dirty scope. A failed final restore is always a
  // warning; on a GO it also voids the run (fail-closed — a GO whose
  // substrate was left dirty is not a clean result), while a miss or a void
  // keeps its status (neither is made more permissive by the warning).
  const restoreFinal = async (
    outcome: BenchmarkRunRecord,
  ): Promise<BenchmarkRunRecord> => {
    if (!drive.touched) return outcome;
    try {
      // Delegated decision 2026-09-26 (F4/F5): a substrate that offers a
      // verified, retried final restore is given the job; the plain reset is
      // only the fallback for substrates without one. This runs on the abort
      // path too — the signal is deliberately NOT passed, so an abort can
      // never skip putting the correct source back.
      if (substrate.restoreFinal !== undefined) {
        await substrate.restoreFinal(`${runId}:final`);
      } else {
        await substrate.resetScope(`${runId}:final`);
      }
      return outcome;
    } catch (error) {
      const detail = `final scope restore (${runId}:final) failed — a mutant or detonator may be left live: ${describe(error)}`;
      warnings.push(detail);
      return outcome.result.status === "go"
        ? voided({ code: "scope-reset-failed", detail })
        : outcome;
    }
  };

  try {
    return await restoreFinal(await driveAndScore());
  } finally {
    try {
      await lease.release();
    } catch (error) {
      warnings.push(`runner lease release failed: ${describe(error)}`);
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VoidRun({
      code: "aborted",
      detail: describe(signal.reason ?? "aborted"),
    });
  }
}

/**
 * One target × rep. Delegated decision 2026-09-23: DESIGN does not say
 * whether the suite is generated before or after the fault goes in; it is
 * generated ONCE per rep from the CORRECT source, then that same suite runs
 * against correct and faulty source — the generator never sees the fault,
 * and "caught" compares one suite against two sources.
 */
class Driver {
  /** Set BEFORE the first `applySource` call — a partial apply counts. */
  touched = false;

  constructor(
    private readonly options: BenchmarkRunOptions,
    private readonly signal: AbortSignal,
    private readonly topology: PipelineTopology,
    private readonly warnings: string[],
  ) {}

  private async apply(
    target: TargetArtifactRef,
    behaviour: string,
    variant: SourceVariant,
  ): Promise<void> {
    this.touched = true;
    await this.options.substrate.applySource(target, behaviour, variant);
  }

  /** Caught ⇔ green on correct AND red on the mutant (same suite). */
  async mutantRep(mutant: CatalogMutant, rep: number): Promise<boolean> {
    const base = `${this.options.runId}:m:${mutant.id}:r${rep}`;
    const specs = await this.generate(
      base,
      mutant.baseArtifact,
      mutant.behaviour,
    );
    const correct = await this.execute(
      `${base}:correct`,
      mutant.baseArtifact,
      mutant.behaviour,
      { kind: "correct" },
      specs,
    );
    const faulty = await this.execute(
      `${base}:mutant`,
      mutant.baseArtifact,
      mutant.behaviour,
      { kind: "mutant", id: mutant.id, diff: mutant.diff },
      specs,
    );
    return correct === "green" && faulty === "red";
  }

  /** Vacuous ⇔ green on correct AND green on the detonator (§13.1). */
  async baselineRep(baseline: CatalogBaseline, rep: number): Promise<boolean> {
    const base = `${this.options.runId}:b:${baseline.id}:r${rep}`;
    const specs = await this.generate(
      base,
      baseline.artifact,
      baseline.behaviour,
    );
    const correct = await this.execute(
      `${base}:correct`,
      baseline.artifact,
      baseline.behaviour,
      { kind: "correct" },
      specs,
    );
    const detonated = await this.execute(
      `${base}:detonator`,
      baseline.artifact,
      baseline.behaviour,
      { kind: "detonator", id: baseline.id, diff: baseline.detonator.diff },
      specs,
    );
    return correct === "green" && detonated === "green";
  }

  private context(runId: string): PipelineContext {
    return {
      runId,
      lifecycle: "ephemeral",
      coverageSource: "benchmark",
      topology: this.topology,
      signal: this.signal,
    };
  }

  /** SUB-5 reset, correct source, then impact → generate. */
  private async generate(
    runId: string,
    target: TargetArtifactRef,
    behaviour: string,
  ): Promise<TestSpec[]> {
    throwIfAborted(this.signal);
    await this.reset(`${runId}:generate`);
    await this.apply(target, behaviour, { kind: "correct" });
    const ctx = this.context(`${runId}:generate`);
    const affected: AffectedArtifact[] = [{ ref: target, resolvedBy: "scope" }];
    const graph = await this.options.pipeline.impact.analyze(ctx, affected);
    return this.options.pipeline.generator.generate(
      ctx,
      graph,
      this.options.pipeline.kind,
    );
  }

  /** SUB-5 reset, apply the variant, stage → run → collect → teardown. */
  private async execute(
    runId: string,
    target: TargetArtifactRef,
    behaviour: string,
    variant: SourceVariant,
    specs: readonly TestSpec[],
  ): Promise<"green" | "red"> {
    throwIfAborted(this.signal);
    await this.reset(runId);
    await this.apply(target, behaviour, variant);
    const { store, runner } = this.options.pipeline;
    const ctx = this.context(runId);
    let result: RunResult;
    try {
      const projection = await store.project(ctx, specs);
      const staged: PipelineContext = { ...ctx, projection };
      try {
        result = await runner.run(staged, specs, (event) => {
          this.options.onEvent?.(event);
        });
      } catch (error) {
        // DEV-1: a runner rejection is an infrastructure fault — no evidence.
        throw new VoidRun({
          code: "inconclusive-run",
          detail: `run ${runId}: runner rejected: ${describe(error)}`,
        });
      }
    } catch (error) {
      // Delegated decision 2026-09-24 (#23): a teardown rejection must not
      // replace the fault already propagating (it would erase e.g. a
      // VoidRun's reason); it is recorded as a warning instead. With no fault
      // in flight a teardown rejection still propagates as before.
      try {
        await store.teardown(ctx);
      } catch (teardownError) {
        this.warnings.push(
          `run ${runId}: store teardown failed while another fault was propagating: ${describe(teardownError)}`,
        );
      }
      throw error;
    }
    await store.teardown(ctx);
    const colour = colourOf(result, runId, specs);
    if ("void" in colour) throw new VoidRun(colour.void);
    return colour.colour;
  }

  private async reset(runId: string): Promise<void> {
    try {
      await this.options.substrate.resetScope(runId);
    } catch (error) {
      throw new VoidRun({
        code: "scope-reset-failed",
        detail: `run ${runId}: ${describe(error)}`,
      });
    }
  }
}
