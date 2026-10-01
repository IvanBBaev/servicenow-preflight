// PLAN Phase 5 — the ATF Runner adapter (`Runner` port from @tessera/core).
//
// This is an adapter OF the port, not a variant of it: `core` owns the
// interface, the `end` event (ARCH-24), the ledger and the orphan sweep. This
// module triggers suites, waits with a bound, parses per-spec results, and
// returns. It deletes nothing and it never emits `end`.
//
// DEV-1 is the load-bearing rule here, so it is spelled out rather than
// implied. `run()` RESOLVES a `RunResult` for anything that is evidence about
// a test — a pass, a failure, a result row that never appeared ("missing"), a
// suite that was still running when the budget ran out ("waiting-timeout").
// "We stopped waiting" is evidence; §6a turns it into INCONCLUSIVE/blocking,
// which is the honest verdict. `run()` REJECTS only for an adapter/infra fault,
// where the adapter has no evidence about any test and must not pretend
// otherwise:
//   * a transport failure or HTTP error on trigger, poll or result read;
//   * a CI/CD response with no progress id, or an unparseable progress/result
//     body;
//   * `ctx.projection` absent, or a spec with no projection entry (ARCH-26 /
//     DEV-16 — without the attribution key a result cannot be attributed, and
//     guessing is exactly the silent mis-attribution DR-4 exists to prevent);
//   * two specs projected onto the same `sys_atf_test` row, which would make
//     one spec's outcome overwrite the other's.
// `core`'s run loop treats a rejection as an infra fault and the pipeline goes
// INCONCLUSIVE — the fail-closed direction.
//
// Every one of those rejections is an `AtfInfrastructureError`, including the
// transport ones: the port normalises rather than leaking the bound client's
// error type, so a consumer of the `Runner` port never has to import a
// ServiceNow client to classify a fault. The original error survives as `cause`
// and its HTTP status is lifted onto `.status`. The reasoning is at the site of
// the choice, in `client.ts` above `toInfrastructureError`.
//
// ARCH-28 / DEV-17 cancellation: an abort stops the loop between round-trips
// and records the affected specs as "waiting-timeout". It does NOT cancel the
// instance-side execution and does NOT delete the projected records —
// reclaiming an abandoned run is the orphan sweep's job, and a runner that
// deleted on its way out would race the sweep and destroy the evidence.

import { specKey } from "@tessera/core";
import type { Runner } from "@tessera/core";
import type {
  PipelineContext,
  SpecOutcome,
  RunResult,
  TestEvent,
  TestKind,
  TestSpec,
  TestSpecRef,
} from "@tessera/types";
import { AtfInfrastructureError, type AtfHttpClient } from "./client.js";
import {
  DEFAULT_INITIAL_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_MAX_POLLS,
  pollUntilTerminal,
} from "./poll.js";
import {
  fetchSuiteResultTree,
  parseSpecResults,
  resolveSuiteTreeCaps,
  type ResultOptions,
  type SpecResult,
} from "./results.js";
import { triggerSuite, type TriggerOptions } from "./trigger.js";

/** The table an ATF spec is projected onto; `supports()` keys on it. */
export const ATF_TARGET_TABLE = "sys_atf_test";

/** Kinds this adapter claims by default. ATF covers server-side unit tests. */
export const DEFAULT_ATF_KINDS: readonly TestKind[] = ["unit"];

/**
 * DEV-2 default budget for one `run()` call, across every suite it triggers.
 * Fifteen minutes is long enough for a realistic suite and short enough that a
 * wedged instance cannot hold a pipeline hostage.
 */
export const DEFAULT_RUN_DEADLINE_MS = 15 * 60 * 1_000;

export interface AtfRunnerOptions {
  /** Transport port; use `createSnAtfClient()` against a real instance. */
  readonly client: AtfHttpClient;
  /** Kinds to claim. Default {@link DEFAULT_ATF_KINDS}. */
  readonly kinds?: readonly TestKind[];
  /** Target table `supports()` looks for. Default {@link ATF_TARGET_TABLE}. */
  readonly targetTable?: string;
  /**
   * DEV-2 wall budget for the whole call. Default {@link DEFAULT_RUN_DEADLINE_MS}.
   * Must be finite and > 0, else `createAtfRunner` throws `TypeError`.
   */
  readonly deadlineMs?: number;
  /** Must be finite, else `TypeError`. */
  readonly initialIntervalMs?: number;
  /** Must be finite, else `TypeError`. */
  readonly maxIntervalMs?: number;
  /** Must be a positive integer, else `TypeError`. */
  readonly maxPolls?: number;
  /** Injected for determinism in tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected for determinism in tests. Default `Date.now`. */
  readonly now?: () => number;
  readonly trigger?: TriggerOptions;
  readonly results?: ResultOptions;
}

interface SpecEntry {
  readonly spec: TestSpec;
  readonly testSysId: string;
  readonly suiteSysId: string;
}

interface SuiteGroup {
  readonly suiteSysId: string;
  readonly entries: SpecEntry[];
}

function describe(ref: TestSpecRef): string {
  return `${ref.id} (${ref.path})`;
}

/**
 * Group the specs by the suite their projection put them in, and prove the
 * attribution key is total before a single request is made. Every failure
 * below is a DEV-1 infra fault: the run has no evidence to report.
 */
function planGroups(
  ctx: PipelineContext,
  specs: readonly TestSpec[],
): { groups: SuiteGroup[]; entries: SpecEntry[] } {
  const projection = ctx.projection;
  if (projection === undefined) {
    throw new AtfInfrastructureError(
      `run ${ctx.runId}: ctx.projection is absent, so ATF results cannot be ` +
        `attributed to specs (ARCH-26/DEV-16)`,
    );
  }

  const groups = new Map<string, SuiteGroup>();
  const entries: SpecEntry[] = [];
  const seenTests = new Map<string, TestSpecRef>();

  for (const spec of specs) {
    const record = projection[specKey(spec.ref)];
    if (record === undefined) {
      throw new AtfInfrastructureError(
        `run ${ctx.runId}: spec ${describe(spec.ref)} has no projection entry; ` +
          `its ATF result could not be attributed`,
      );
    }
    if (record.testSysId === "" || record.suiteSysId === "") {
      throw new AtfInfrastructureError(
        `run ${ctx.runId}: projection entry for spec ${describe(spec.ref)} is ` +
          `incomplete (testSysId=${JSON.stringify(record.testSysId)}, ` +
          `suiteSysId=${JSON.stringify(record.suiteSysId)})`,
      );
    }
    const clash = seenTests.get(record.testSysId);
    if (clash !== undefined) {
      throw new AtfInfrastructureError(
        `run ${ctx.runId}: specs ${describe(clash)} and ${describe(spec.ref)} ` +
          `are both projected onto sys_atf_test ${record.testSysId}; results ` +
          `cannot be attributed unambiguously`,
      );
    }
    seenTests.set(record.testSysId, spec.ref);

    const entry: SpecEntry = {
      spec,
      testSysId: record.testSysId,
      suiteSysId: record.suiteSysId,
    };
    entries.push(entry);
    const group = groups.get(record.suiteSysId);
    if (group) group.entries.push(entry);
    else
      groups.set(record.suiteSysId, {
        suiteSysId: record.suiteSysId,
        entries: [entry],
      });
  }

  return { groups: [...groups.values()], entries };
}

/** Build the ATF runner adapter. */
export function createAtfRunner(options: AtfRunnerOptions): Runner {
  const client = options.client;
  const kinds = options.kinds ?? DEFAULT_ATF_KINDS;
  const targetTable = options.targetTable ?? ATF_TARGET_TABLE;
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS;
  // Delegated decision 2026-09-25: the DEV-2 bounds are validated once, at
  // construction, and a bad value throws `TypeError` rather than falling back
  // to a default. `NaN` disabled both bounds (an infinite poll loop), and a
  // non-positive run budget would make every `run()` a silent no-op.
  if (!(Number.isFinite(deadlineMs) && deadlineMs > 0)) {
    throw new TypeError(
      `createAtfRunner: deadlineMs must be a finite number > 0, got ${String(deadlineMs)}`,
    );
  }
  if (
    options.maxPolls !== undefined &&
    !(Number.isInteger(options.maxPolls) && options.maxPolls > 0)
  ) {
    throw new TypeError(
      `createAtfRunner: maxPolls must be a positive integer, got ${String(options.maxPolls)}`,
    );
  }
  // Wave 13: the child-suite traversal caps are validated here too, so a bad
  // cap is a construction-time `TypeError`, never a `run()` rejection that
  // DEV-1 does not allow.
  resolveSuiteTreeCaps(options.results ?? {}, "createAtfRunner: results.");
  for (const key of ["initialIntervalMs", "maxIntervalMs"] as const) {
    const value = options[key];
    if (value !== undefined && !Number.isFinite(value)) {
      throw new TypeError(
        `createAtfRunner: ${key} must be a finite number, got ${String(value)}`,
      );
    }
  }

  return {
    kinds,

    supports(spec: TestSpec): boolean {
      // Kind membership is checked by core's dispatcher; this answers the one
      // question only the adapter can: is the spec addressed at an ATF test?
      return spec.targets.some((target) => target.table === targetTable);
    },

    async run(
      ctx: PipelineContext,
      specs: readonly TestSpec[],
      emit: (event: TestEvent) => void,
    ): Promise<RunResult> {
      const outcomes: SpecOutcome[] = [];
      if (specs.length === 0) return { runId: ctx.runId, outcomes };

      const { groups, entries } = planGroups(ctx, specs);
      const recorded = new Set<string>();
      const record = (outcome: SpecOutcome): void => {
        recorded.add(specKey(outcome.spec));
        outcomes.push(outcome);
      };

      const deadlineAt = now() + deadlineMs;
      let halted: string | undefined;

      for (const group of groups) {
        if (halted !== undefined) break;
        if (ctx.signal.aborted) {
          halted = `run ${ctx.runId} was aborted before ATF suite ${group.suiteSysId} was triggered`;
          break;
        }
        const budget = deadlineAt - now();
        if (budget <= 0) {
          halted = `run ${ctx.runId} exhausted its ${deadlineMs}ms ATF budget before suite ${group.suiteSysId} was triggered`;
          break;
        }

        for (const entry of group.entries) {
          emit({ kind: "start", runId: ctx.runId, spec: entry.spec.ref });
        }

        // Rejections from here on are DEV-1 infra faults — see the header.
        const handle = await triggerSuite(
          client,
          group.suiteSysId,
          options.trigger ?? {},
        );
        emit({
          kind: "log",
          runId: ctx.runId,
          message: `ATF suite ${group.suiteSysId} started as execution ${handle.executionId}`,
        });

        const progress = await pollUntilTerminal(client, handle.executionId, {
          deadlineMs: deadlineAt - now(),
          initialIntervalMs:
            options.initialIntervalMs ?? DEFAULT_INITIAL_INTERVAL_MS,
          maxIntervalMs: options.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS,
          maxPolls: options.maxPolls ?? DEFAULT_MAX_POLLS,
          signal: ctx.signal,
          ...(options.sleep ? { sleep: options.sleep } : {}),
          now,
        });

        if (progress.outcome !== "terminal") {
          // DEV-2 / ARCH-28. Evidence about the WAIT, not about the tests:
          // resolve, never reject. Nothing instance-side is cancelled or
          // deleted — the orphan sweep reclaims execution
          // `handle.executionId` (DEV-17).
          const last = progress.lastRun;
          const state = last === undefined ? "unobserved" : last.state;
          const cause =
            progress.outcome === "aborted"
              ? `ATF suite ${group.suiteSysId} (execution ${handle.executionId}) was abandoned on abort after ${progress.polls} poll(s); last observed state ${state}`
              : `ATF suite ${group.suiteSysId} (execution ${handle.executionId}) did not reach a terminal state within the run budget (${progress.reason === "max-polls" ? `${progress.polls} polls` : `${progress.elapsedMs}ms`}); last observed state ${state}`;
          emit({ kind: "error", runId: ctx.runId, cause });
          for (const entry of group.entries) {
            record({
              spec: entry.spec.ref,
              raw: "waiting-timeout",
              evidence: { kind: "log", ref: handle.executionId },
            });
          }
          halted = cause;
          break;
        }

        emit({
          kind: "log",
          runId: ctx.runId,
          message: `ATF suite ${group.suiteSysId} (execution ${handle.executionId}) finished: ${progress.run.statusLabel === "" ? progress.run.state : progress.run.statusLabel}`,
        });

        const index = new Map<string, TestSpecRef>(
          group.entries.map((entry) => [entry.testSysId, entry.spec.ref]),
        );
        // F1 (fix 2026-09-26): per-test rows are admissible only when linked
        // to THIS execution's `sys_atf_test_suite_result`, named by the
        // terminal payload's `links.results.id`. Without it there is no way to
        // tell this run's rows from a stale or concurrent run's.
        //
        // Delegated decision 2026-09-26: no link → every spec in the group is
        // `missing` (§6a: blocking), and NO result read is issued. The rejected
        // alternative, a `sys_created_on >= trigger` window, is not justified:
        // the CI/CD envelope carries no instance-side trigger timestamp, a
        // local clock is not comparable with the instance's, and a time window
        // still admits a concurrent run's rows. `missing` (evidence: the run
        // finished and linked nothing) rather than a rejection, because the
        // suite DID reach a terminal state — this is DEV-1 evidence, e.g. a
        // suite Canceled before any test ran.
        //
        // Delegated decision 2026-09-26: a pass that IS linked is kept even
        // when the suite as a whole ended Canceled or Failed — a test that
        // finished before the cancel wrote a row for this execution, and that
        // row is evidence about this run. Only unprovable passes are refused.
        // A non-empty but malformed link rejects inside `fetchSuiteResultTree`
        // (DEV-1 fault: an unparseable payload), never an unscoped read.
        //
        // Wave 13 (2026-09-28): the link names the ROOT of this execution's
        // `sys_atf_test_suite_result` tree. Nested child suites of the
        // triggered suite have their own rows (linked via `parent`), and a
        // test that ran inside one is linked to the child's row — so the tree
        // is discovered first (bounded: depth, size, cycles; any overflow or
        // unreadable child is a DEV-1 fault, never a partial GO) and results
        // are read across all of it, joined worst-of. Still run-scoped
        // (DEV-6/DR-4): the tree grows only downwards from this run's root.
        const resultsId = progress.run.resultsId;
        let results: readonly SpecResult[];
        if (resultsId === "") {
          results = [...index.values()].map((spec) => ({
            spec,
            raw: "missing" as const,
            evidence: { kind: "log" as const, ref: handle.executionId },
            cause: `ATF suite ${group.suiteSysId} (execution ${handle.executionId}) ended ${progress.run.statusLabel === "" ? progress.run.state : progress.run.statusLabel} at ${progress.run.percentComplete}% without a links.results id, so no sys_atf_test_result row can be linked to this execution; results of other runs are not evidence`,
          }));
        } else {
          const tree = await fetchSuiteResultTree(
            client,
            resultsId,
            options.results ?? {},
          );
          results = await parseSpecResults(
            client,
            index,
            tree.ids,
            options.results ?? {},
          );
        }

        for (const result of results) {
          if (result.raw === "pass") {
            emit({ kind: "pass", runId: ctx.runId, spec: result.spec });
          } else if (result.raw === "fail") {
            emit({
              kind: "fail",
              runId: ctx.runId,
              spec: result.spec,
              assertion: result.assertion ?? "ATF reported a failure",
              ...(result.artifacts ? { artifacts: [...result.artifacts] } : {}),
            });
          } else {
            emit({
              kind: "error",
              runId: ctx.runId,
              spec: result.spec,
              cause: result.cause ?? `ATF outcome ${result.raw}`,
              ...(result.artifacts ? { artifacts: [...result.artifacts] } : {}),
            });
          }
          record({
            spec: result.spec,
            raw: result.raw,
            ...(result.evidence ? { evidence: result.evidence } : {}),
          });
        }
      }

      if (halted !== undefined) {
        const pending = entries.filter(
          (entry) => !recorded.has(specKey(entry.spec.ref)),
        );
        if (pending.length > 0) {
          emit({
            kind: "error",
            runId: ctx.runId,
            cause: `${pending.length} ATF spec(s) were never executed: ${halted}`,
          });
          for (const entry of pending) {
            record({
              spec: entry.spec.ref,
              raw: "waiting-timeout",
              evidence: {
                kind: "log",
                ref: `sys_atf_test_suite:${entry.suiteSysId}`,
              },
            });
          }
        }
      }

      // No `end` event: core owns the run boundary (ARCH-24).
      return { runId: ctx.runId, outcomes };
    },
  };
}
