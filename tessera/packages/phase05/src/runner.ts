// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// The ATF Runner: trigger the throwaway suite through the CI/CD API, poll to a
// terminal state under a bounded deadline (DEV-2), then attribute the result to
// the ONE spec that was projected (Spike 2b) and, inside it, to the individual
// assertions the step reported.
//
// DEV-1 is the rule that shapes this file. `run()` RESOLVES with a `RunResult`
// for anything that is evidence about a test — a red assertion, a step that
// threw, an ATF status the skeleton cannot classify — and REJECTS only when
// there is no outcome evidence at all: the trigger never landed, the poll never
// reached a terminal state, cancellation. Every rejection below is a
// `SkeletonInfrastructureError`; nothing else throws.

import { specKey } from "@tessera/core";
import type { Runner } from "@tessera/core";
import type {
  PipelineContext,
  RunResult,
  SpecOutcome,
  TestEvent,
  TestKind,
  TestSpec,
} from "@tessera/types";
import { atfApi, snRequest, tableApi } from "@tessera/sn-client";

import {
  ATF_TABLES,
  CICD_TESTSUITE_RUN_PATH,
  SUITE_TRIGGER_PARAM_NAMES,
  TERMINAL_CICD_STATUS_CODES,
  TERMINAL_CICD_STATUS_LABEL,
  TEST_RESULT_STATUS_FAIL,
  TEST_RESULT_STATUS_PASS,
} from "./atf.js";
import {
  failedAssertionNames,
  parseAssertionOutput,
  type ParsedAtfOutput,
} from "./atfOutput.js";
import {
  SkeletonCancelledError,
  SkeletonInfrastructureError,
} from "./errors.js";
import { S5_SPEC_ID } from "./fixtures.js";
import { readField } from "./snRecords.js";

/** What the Runner learned about one projected test, before it becomes rows. */
export interface AtfAttribution {
  readonly testSysId: string;
  readonly resultSysId?: string;
  readonly status: string;
  readonly parsed: ParsedAtfOutput;
}

export interface S5RunnerOptions {
  /**
   * Injected clock in epoch milliseconds. Required — there is no `Date.now()`
   * in this package's library code, so a test can drive the deadline.
   */
  readonly now: () => number;
  /** Injected delay. Defaults to a `setTimeout` sleep (a timer, not a clock). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Gap between progress polls. Default 250ms. */
  readonly pollIntervalMs?: number;
  /**
   * Safety net around the poll loop. The CANONICAL DEV-2 bound is core's
   * `runTimeoutMs`, which aborts `ctx.signal`; this one only stops a runner
   * composed without it from spinning forever. Default 120_000ms.
   */
  readonly pollTimeoutMs?: number;
  /**
   * Query parameter carrying the §4a run id on the trigger call. Not part of
   * the real CI/CD API — `@tessera/fake-instance` accepts it so instance-side
   * run state is findable by run id (§4b sweep liveness probe), and a real
   * instance ignores an unknown parameter. `null` omits it.
   */
  readonly runIdParam?: string | null;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_POLL_TIMEOUT_MS = 120_000;
const DEFAULT_RUN_ID_PARAM = "tessera_run_id";
const KINDS: readonly TestKind[] = ["unit"];

/**
 * The gap between polls is a REF'D timer on purpose. An unref'd one lets the
 * event loop drain while a run is still in flight, at which point the run
 * promise never settles and the process exits (or, under `node --test`, every
 * test is cancelled with "the event loop has already resolved"). What bounds a
 * stalled run is the DEV-2 deadline below and core's `runTimeoutMs`, not the
 * process running out of other work to do.
 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTerminal(status?: string, label?: string): boolean {
  if (status !== undefined && TERMINAL_CICD_STATUS_CODES.has(status)) {
    return true;
  }
  return label !== undefined && TERMINAL_CICD_STATUS_LABEL.test(label);
}

export function createS5Runner(options: S5RunnerOptions): Runner {
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const runIdParam =
    options.runIdParam === null
      ? undefined
      : (options.runIdParam ?? DEFAULT_RUN_ID_PARAM);

  /**
   * DEV-14 divergence, worked around here rather than in `@tessera/sn-client`:
   * the documented CI/CD trigger parameter is `test_suite_sys_id`, but the
   * vendored `atfApi.runAtfSuite` sends only the undocumented `sys_id` (which
   * is also what `@tessera/fake-instance` keys on). Sending BOTH names with the
   * same value satisfies a live instance and the Tier-2 fake at once; the
   * unused alias is an unknown query parameter, which both ignore. That is why
   * this call bypasses `atfApi` and goes straight to the transport seam.
   */
  const triggerSuite = async (
    suiteSysId: string,
    runId: string,
  ): Promise<string> => {
    const params = new URLSearchParams();
    for (const name of SUITE_TRIGGER_PARAM_NAMES) params.set(name, suiteSysId);
    if (runIdParam !== undefined) params.set(runIdParam, runId);

    let data: { result?: { links?: { progress?: { id?: string } } } };
    try {
      ({ data } = await snRequest<{
        result?: { links?: { progress?: { id?: string } } };
      }>({
        method: "POST",
        path: CICD_TESTSUITE_RUN_PATH,
        params,
      }));
    } catch (error) {
      throw new SkeletonInfrastructureError(
        `could not trigger suite ${suiteSysId} via ${CICD_TESTSUITE_RUN_PATH}`,
        { cause: error },
      );
    }
    const executionId = data.result?.links?.progress?.id;
    if (typeof executionId !== "string" || executionId === "") {
      throw new SkeletonInfrastructureError(
        `${CICD_TESTSUITE_RUN_PATH} returned no progress id — nothing to poll`,
      );
    }
    return executionId;
  };

  const pollToTerminal = async (
    ctx: PipelineContext,
    executionId: string,
    emit: (event: TestEvent) => void,
  ): Promise<void> => {
    const deadline = options.now() + pollTimeoutMs;
    for (;;) {
      if (ctx.signal.aborted) {
        throw new SkeletonCancelledError(
          `run ${ctx.runId} was cancelled while polling execution ${executionId} (ARCH-28)`,
        );
      }
      const progress = await atfApi.getAtfResult(executionId);
      if (isTerminal(progress.status, progress.statusLabel)) {
        emit({
          kind: "log",
          runId: ctx.runId,
          message: `execution ${executionId} reached terminal state "${progress.statusLabel ?? progress.status ?? "?"}"`,
        });
        return;
      }
      if (options.now() >= deadline) {
        throw new SkeletonInfrastructureError(
          `execution ${executionId} did not reach a terminal state within ${pollTimeoutMs}ms ` +
            `(runner-side safety net; core's runTimeoutMs is the canonical DEV-2 bound)`,
        );
      }
      await sleep(pollIntervalMs);
    }
  };

  /**
   * Spike 2b attribution read, verbatim in shape: newest `sys_atf_test_result`
   * for THIS test sys_id. The suite outcome is deliberately not used — "the
   * suite failed" is not attribution.
   */
  const readAttribution = async (
    testSysId: string,
  ): Promise<AtfAttribution | undefined> => {
    const { records } = await tableApi.queryTable({
      table: ATF_TABLES.testResult,
      query: `test=${testSysId}^ORDERBYDESCsys_created_on`,
      fields: ["sys_id", "status", "output"],
      limit: 1,
    });
    const row = records[0];
    if (row === undefined) return undefined;
    const resultSysId = readField(row, "sys_id");
    return {
      testSysId,
      ...(resultSysId === undefined ? {} : { resultSysId }),
      status: readField(row, "status") ?? "",
      parsed: parseAssertionOutput(readField(row, "output") ?? ""),
    };
  };

  return {
    kinds: KINDS,

    supports(spec: TestSpec): boolean {
      // Hardcoded on purpose: this adapter knows one spec. A second spec must
      // fail `groupByRunner` loudly rather than be run by an adapter that
      // cannot attribute it.
      return spec.kind === "unit" && spec.ref.id === S5_SPEC_ID;
    },

    async run(
      ctx: PipelineContext,
      specs: readonly TestSpec[],
      emit: (event: TestEvent) => void,
    ): Promise<RunResult> {
      const spec = specs[0];
      if (spec === undefined || specs.length !== 1) {
        throw new SkeletonInfrastructureError(
          `the Phase 0.5 runner executes exactly one spec (got ${specs.length})`,
        );
      }
      const projection = ctx.projection;
      if (projection === undefined) {
        throw new SkeletonInfrastructureError(
          "no ProjectionMap on the context — the runner has no attribution key (ARCH-26)",
        );
      }
      const projected = projection[specKey(spec.ref)];
      if (projected === undefined) {
        throw new SkeletonInfrastructureError(
          `spec ${spec.ref.id} was not projected — nothing to run`,
        );
      }

      emit({ kind: "start", runId: ctx.runId, spec: spec.ref });

      const executionId = await triggerSuite(projected.suiteSysId, ctx.runId);
      await pollToTerminal(ctx, executionId, emit);

      // Everything from here on is EVIDENCE about the test, so nothing below
      // rejects: DEV-1 turns it into rows.
      const attribution = await readAttribution(projected.testSysId);
      const outcome = toOutcome(ctx, spec, attribution, emit);
      return { runId: ctx.runId, outcomes: [outcome] };
    },
  };
}

/**
 * Fold one attribution read into a `SpecOutcome`, emitting the event stream.
 * Exported for the suite only (not re-exported from the barrel).
 */
export function toOutcome(
  ctx: PipelineContext,
  spec: TestSpec,
  attribution: AtfAttribution | undefined,
  emit: (event: TestEvent) => void,
): SpecOutcome {
  if (attribution === undefined) {
    // The suite finished but ATF wrote no per-test row. That is evidence about
    // the RUN, not about the test — an `error` row, never a rejection (DEV-1),
    // and never a silent pass.
    const cause = `no ${ATF_TABLES.testResult} row for the projected test — the run finished without per-test evidence`;
    emit({ kind: "error", runId: ctx.runId, spec: spec.ref, cause });
    return {
      spec: spec.ref,
      raw: "error",
      evidence: { kind: "log", ref: cause },
    };
  }

  const evidence =
    attribution.resultSysId === undefined
      ? ({ kind: "log", ref: `${ATF_TABLES.testResult} (no sys_id)` } as const)
      : ({ kind: "atf-result", ref: attribution.resultSysId } as const);

  for (const line of attribution.parsed.unparsed) {
    emit({
      kind: "log",
      runId: ctx.runId,
      message: `unparsed ATF output line: ${line}`,
    });
  }

  const failed = failedAssertionNames(attribution.parsed);
  const status = attribution.status.toLowerCase();

  if (failed.length > 0) {
    for (const name of failed) {
      // Spike 2b: the finding is the NAMED assertion, not "the suite failed".
      emit({ kind: "fail", runId: ctx.runId, spec: spec.ref, assertion: name });
    }
    return { spec: spec.ref, raw: "fail", evidence };
  }

  if (status === TEST_RESULT_STATUS_FAIL) {
    // Failed, but the output did not name an assertion — report the honest
    // fallback rather than inventing one.
    const assertion =
      attribution.parsed.unparsed.length > 0
        ? `unattributed failure: ${attribution.parsed.unparsed.join(" / ")}`
        : "unattributed failure (ATF reported no assertion detail)";
    emit({ kind: "fail", runId: ctx.runId, spec: spec.ref, assertion });
    return { spec: spec.ref, raw: "fail", evidence };
  }

  if (status === TEST_RESULT_STATUS_PASS) {
    if (attribution.parsed.assertions.length === 0) {
      // QA-9 one level down (delegated decision 2026-09-23, option (a)): a
      // green row that reported NO assertions is not evidence that anything
      // was checked — `every()` over an empty outcome set is vacuously true,
      // and a real instance happily marks an assertion-free test "success".
      // A pass has to carry at least one parsed passing assertion; otherwise
      // the row is an `error`, the same non-pass as the other "finished
      // without evidence" branches above.
      const cause = `${ATF_TABLES.testResult}.status is "${attribution.status}" but the output reported no assertions — a test that asserted nothing is not a pass (QA-9)`;
      emit({ kind: "error", runId: ctx.runId, spec: spec.ref, cause });
      return { spec: spec.ref, raw: "error", evidence };
    }
    emit({ kind: "pass", runId: ctx.runId, spec: spec.ref });
    return { spec: spec.ref, raw: "pass", evidence };
  }

  const cause = `unclassifiable ${ATF_TABLES.testResult}.status "${attribution.status}"`;
  emit({ kind: "error", runId: ctx.runId, spec: spec.ref, cause });
  return { spec: spec.ref, raw: "error", evidence };
}
