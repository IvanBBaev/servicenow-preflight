// `tess run --skeleton` — the PLAN Phase 0.5 walking skeleton, unchanged in
// behaviour and moved up into the composition root.
//
// This function used to live in the Phase-0.5 skeleton barrel and hand-wired
// its own `RunPipelinePorts` literal, which was the named ARCH-1 exception PLAN
// Phase 0.5 granted. The exception is DISCHARGED here: the ports now come from
// `composeSkeletonPipeline()`, i.e. from `createRegistries()` +
// `resolvePipeline()` in `@tessera/core`. The adapters themselves are still the
// hardcoded Phase-0.5 ones (`@tessera/phase05`) and are replaced one package at
// a time in Phases 2–8; what changed is WHO decides which adapter implements
// which port, and the answer is now "the composition root, from a config
// record" rather than "whichever module happened to import it".
//
// Observable behaviour is frozen. Same order, same errors, same result shape —
// the Phase-0.5 test suite runs against this file unmodified.
//
// NOTE on credentials: `@tessera/sn-client` is vendored and reads its instance
// and auth from the environment (ARCH-7/18). This module reads no `process.env`
// itself — `stage.ts` sets it up before calling in.

import { runPipeline } from "@tessera/core";
import type { PipelineRunReport } from "@tessera/core";
import {
  createTargetGuard,
  type AcknowledgeProd,
  type Classification,
  type InstanceRef,
  type TargetGuard,
} from "@tessera/guard";
import { createIntentLedger, type IntentLedger } from "@tessera/ledger";
import {
  createInstanceProbe,
  createLedgerGuardAuditSink,
  createS5Spec,
  S5_TARGET_NAME,
  SkeletonInfrastructureError,
  type FailedAssertion,
  type LedgerGuardAuditSink,
} from "@tessera/phase05";
import type { Lifecycle, RunId } from "@tessera/types";

import { composeSkeletonPipeline } from "./registries.js";

export interface SkeletonRunOptions {
  /** §4a run id — tags every projected record. Minted by the caller (CLI). */
  readonly runId: RunId;
  /**
   * The ONE instance this run binds to all three §2a roles. Phase 0.5 runs
   * source = runner = target; the split topology belongs to `tess preflight`.
   */
  readonly instance: InstanceRef;
  /** Injected clock — this module calls no `Date.now()` and reads no env. */
  readonly now: () => Date;
  /**
   * Absolute ledger root (§4b). Injected: there is no default location.
   *
   * There is no companion `guardAuditPath`. Until 2026-08-31 this interface
   * offered one, defaulting to `<ledgerRoot>/guard-audit.jsonl`, because the
   * §11.4 record was split across two files; the record is now written once,
   * into the ledger's own audit log, and the ledger owns that layout. An
   * option naming a file nothing writes tells an operator a log exists.
   */
  readonly ledgerRoot: string;
  /** §11.2 — the ONLY source of writability. */
  readonly nonProdAllowlist?: readonly string[];
  /** §11.1 explicit prod declarations; no override reaches these. */
  readonly prodInstances?: readonly string[];
  /** §11.4 run-scoped override; only ever covers a `prod-suspect` RUNNER. */
  readonly acknowledgeProd?: AcknowledgeProd;
  /** §6a ConfirmToken signing key. Absent → an unsigned token. */
  readonly hmacKey?: string;
  /** §4a. `ephemeral` (the gate default) tears the projection down. */
  readonly lifecycle?: Lifecycle;
  /** Overridable only so a test can point at a differently named copy. */
  readonly targetName?: string;
  /** ARCH-28 cancellation. */
  readonly signal?: AbortSignal;
  /** DEV-2 bounded polling — the canonical bound. */
  readonly runTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Skip the DR-3 property probe in the provisioner. */
  readonly skipRunnerPropertyCheck?: boolean;
  /** §4b: refuse a second run on the same scope+runner. Default true. */
  readonly refuseConcurrentRuns?: boolean;
  /** Delete the suite-result rows during teardown. Default false — evidence. */
  readonly deleteSuiteResults?: boolean;
}

export interface SkeletonRunResult {
  readonly report: PipelineRunReport;
  /** Named red assertions, from the event stream — the point of the red run. */
  readonly failures: readonly FailedAssertion[];
  /** Infra faults reported as `error` events (DEV-1). */
  readonly errors: readonly string[];
  /** §11.1 pinned classification of the runner role. */
  readonly runner: Classification;
  /** §11.4 records the guard journalled this run. */
  readonly acknowledgements: readonly string[];
  /** Records the store created and then deleted — teardown evidence. */
  readonly created: readonly { table: string; sysId: string }[];
  readonly deleted: readonly { table: string; sysId: string }[];
}

/**
 * Order below is load-bearing and mirrors §11/§4b: mint the ledger → build the
 * guard on a sink that writes into it → classify the runner → resolve the
 * ports → hand everything to `runPipeline`, which re-asserts
 * `assertRunnerWritable` before it touches a single adapter.
 *
 * The ledger is minted FIRST only because the audit sink needs it; nothing is
 * read or written at construction (`createIntentLedger` is pure), so this
 * still classifies before anything capable of writing has been used.
 */
export async function runSkeleton(
  options: SkeletonRunOptions,
): Promise<SkeletonRunResult> {
  const lifecycle: Lifecycle = options.lifecycle ?? "ephemeral";

  const ledger: IntentLedger = createIntentLedger({
    rootDir: options.ledgerRoot,
    now: options.now,
  });

  // §11.4/§4b: the guard journals the acknowledgement itself, synchronously,
  // from inside `assertRunnerWritable` — so it is durable before the write is
  // permitted, and a sink that throws turns into a refusal rather than an
  // unaudited write. This composition root appends NOTHING of its own: it did
  // until 2026-08-31, and a second append of the same event is a second
  // account of it that can disagree with the first.
  const audit: LedgerGuardAuditSink = createLedgerGuardAuditSink(ledger);
  const guard: TargetGuard = createTargetGuard(
    {
      ...(options.nonProdAllowlist === undefined
        ? {}
        : { nonProdAllowlist: options.nonProdAllowlist }),
      ...(options.prodInstances === undefined
        ? {}
        : { prodInstances: options.prodInstances }),
      ...(options.acknowledgeProd === undefined
        ? {}
        : { acknowledgeProd: options.acknowledgeProd }),
    },
    {
      probe: createInstanceProbe(),
      audit,
      runId: options.runId,
      now: () => options.now().toISOString(),
    },
  );

  // §11.1 step zero: classify BEFORE anything is constructed that could write.
  // Phase 0.5 binds one instance to all three roles, but the RUNNER
  // classification is the one that gates writes (§11.5), so it is what the
  // pipeline is given.
  const runner = await guard.classify(options.instance, "runner");

  const { ports, store, reporter } = composeSkeletonPipeline({
    now: options.now,
    ...(options.targetName === undefined
      ? {}
      : { targetName: options.targetName }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.hmacKey === undefined ? {} : { hmacKey: options.hmacKey }),
    ...(options.skipRunnerPropertyCheck === undefined
      ? {}
      : { skipRunnerPropertyCheck: options.skipRunnerPropertyCheck }),
    ...(options.deleteSuiteResults === undefined
      ? {}
      : { deleteSuiteResults: options.deleteSuiteResults }),
  });

  // The resolver must run before the spec can name its target, and the spec
  // must exist before the pipeline plans it — so resolution happens twice:
  // once here to build the hardcoded spec, and once inside the loop as the
  // real `resolve` stage. SEAM (Phase 2): the generator produces the spec from
  // the impact graph inside the loop and this pre-read disappears.
  const affected = await ports.resolver.resolve(
    {
      runId: options.runId,
      lifecycle,
      coverageSource: lifecycle,
      topology: {
        source: options.instance.name,
        runner: options.instance.name,
        target: options.instance.name,
      },
      signal: options.signal ?? new AbortController().signal,
    },
    {},
  );
  const target = affected[0]?.ref;
  if (target === undefined) {
    throw new SkeletonInfrastructureError(
      `resolve found no artifact for "${options.targetName ?? S5_TARGET_NAME}"`,
    );
  }

  const report = await runPipeline(
    { ports, guard, runner, ledger, now: options.now },
    {
      runId: options.runId,
      scope: "global",
      topology: {
        source: options.instance.name,
        runner: options.instance.name,
        target: options.instance.name,
      },
      lifecycle,
      input: {},
      specs: [createS5Spec(target)],
      // The change AND its test are hardcoded by the Phase-0.5 adapters, so
      // neither optional stage runs. The registered `none` adapters make that
      // visible in the composition; these two flags make it true at run time.
      stages: { impact: false, generate: false },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.runTimeoutMs === undefined
        ? {}
        : { runTimeoutMs: options.runTimeoutMs }),
      ...(options.refuseConcurrentRuns === undefined
        ? {}
        : { refuseConcurrentRuns: options.refuseConcurrentRuns }),
    },
  );

  return {
    report,
    failures: reporter.failures(),
    errors: reporter.errors(),
    runner,
    acknowledgements: audit
      .records()
      .map(
        (entry) =>
          `${entry.role} ${entry.cls}: ${entry.reason} (${entry.actor})`,
      ),
    created: store.created().map(({ table, sysId }) => ({ table, sysId })),
    deleted: store.deleted().map(({ table, sysId }) => ({ table, sysId })),
  };
}
