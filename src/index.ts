/**
 * Pre-deployment preflight checks for ServiceNow, as a library.
 *
 * The entry point is {@link runPreflight}, which runs a list of {@link Check}s
 * against a target instance ({@link PreflightContext}) and returns an aggregate
 * {@link PreflightReport}. Call it with no explicit list to run
 * {@link defaultChecks}, or pass your own {@link CheckSelection}. The bundled
 * CLI (`servicenow-preflight` / `snpf`) is a thin wrapper over this same
 * function. Every symbol needed to build and run checks, or to drive a
 * {@link SnClient} directly, is re-exported here.
 *
 * @packageDocumentation
 */
import { defaultChecks } from "./checks/index.js";
import { sanitizeFindings } from "./findings.js";
import { anySignal } from "./http/abort.js";
import { withSignal } from "./http/client.js";
import { linkRunContext } from "./http/query.js";
import { concurrencyProblem, runPool } from "./runner/pool.js";
import { checkScope, publishCheck, publishRun } from "./trace.js";
import type {
  Check,
  CheckResult,
  CheckStatus,
  CheckSelection,
  PreflightContext,
  PreflightReport,
} from "./types.js";

export type {
  Check,
  CheckMeta,
  CheckResult,
  CheckResultKind,
  CheckSeverity,
  CheckStatus,
  CheckSelection,
  Finding,
  FindingLocation,
  PreflightAuth,
  PreflightContext,
  PreflightReport,
  ReplayInfo,
} from "./types.js";
export type {
  SnClient,
  SnTable,
  SnCicd,
  SnAuth,
  SnTls,
  SnRawResponse,
  SnRequestOptions,
  SnCallOptions,
  SnClientConfig,
  CicdTestSuiteResult,
  TableQueryResult,
} from "./http/client.js";
export {
  createSnClient,
  withSignal,
  SnError,
  SnAuthError,
  SnNetworkError,
  SnHttpError,
  SnTruncationError,
  SnResponseError,
} from "./http/client.js";
export {
  MAX_FINDINGS,
  capFindings,
  findingId,
  makeFinding,
} from "./findings.js";
export { createFakeSnClient } from "./http/fake.js";
export type { FakeFixtures, ForcedFailure } from "./http/fake.js";
export {
  EncodedQueryError,
  IN_CHUNK_SIZE,
  isSafeIdentifier,
  isSysId,
  assertIdentifier,
  assertSysId,
  eq,
  inClause,
  and,
  or,
  chunk,
  scopeFilterClause,
  resolveScope,
} from "./http/query.js";
export type { ResolvedScope } from "./http/query.js";
export {
  loadConfig,
  resolveAuthFromEnv,
  resolveTlsFromEnv,
  namespacedEnv,
  UsageError,
  type PreflightConfig,
  type LoadedConfig,
  type LoadConfigOptions,
} from "./config.js";
export {
  loadRegistry,
  resolveInstance,
  instanceNames,
  registryPath,
  promotionChain,
  RegistryNotFoundError,
  PREFLIGHT_DIR,
  REGISTRY_BASENAME,
  type InstanceDef,
  type InstanceRegistry,
  type ResolvedInstance,
} from "./registry.js";
export {
  loadManifest,
  writeManifest,
  mergeManifest,
  emptyManifest,
  manifestPath,
  logicalId,
  slugify,
  STATE_DIR,
  MANIFEST_VERSION,
  type StateManifest,
  type AtfTestState,
  type AtfSuiteState,
  type AtfCoverage,
  type AtfRunRef,
  type InstanceIdentity,
  type InstalledAppState,
} from "./state/manifest.js";
export {
  pullManifest,
  syncManifest,
  EmptySnapshotError,
  type SyncOptions,
} from "./state/sync.js";
export {
  computeDrift,
  stalenessResults,
  versionParityResults,
  promotionOrderResult,
  FRESHNESS_CHECK,
  INSTANCE_VERSION_CHECK,
  APP_VERSION_CHECK,
  PROMOTION_ORDER_CHECK,
  DEFAULT_STALE_WARN_MS,
  type DriftReport,
  type DriftEntry,
  type DriftManifestRef,
  type StalenessOptions,
  type PromotionOrderOptions,
} from "./state/drift.js";
export {
  formatJUnit,
  formatJUnitSuites,
  type NamedReport,
} from "./report/junit.js";
export { formatSarif } from "./report/sarif.js";
export {
  createReplayClient,
  type ReplayClientOptions,
} from "./fixtures/replay.js";
export {
  readRecording,
  RecordingError,
  type RecordingIndex,
} from "./fixtures/recording.js";
export {
  collectTimings,
  createTracer,
  formatTimings,
  TRACE_CHANNELS,
  type CheckTiming,
  type RunTimings,
  type TimingsCollector,
  type Tracer,
  type TraceRunFields,
} from "./trace.js";
export {
  REPORT_SCHEMA_VERSION,
  toEnvelope,
  formatJson,
} from "./report/json.js";
export type {
  EnvelopeOptions,
  ReportEnvelope,
  ReportRun,
} from "./report/json.js";
export {
  formatMarkdown,
  formatMarkdownAll,
  type MarkdownOptions,
} from "./report/markdown.js";
export {
  formatGitHubAnnotations,
  formatGitHubAnnotationsAll,
} from "./report/github.js";
export {
  closestNames,
  describeChecks,
  findCheck,
  RULE_TITLES,
  type CheckDescriptor,
} from "./catalogue.js";
export {
  applyBaseline,
  baselineFromReport,
  baselinePath,
  readBaseline,
  writeBaseline,
  BASELINE_ROW,
  type Baseline,
  type BaselineEntry,
} from "./baseline.js";
export {
  applyPolicy,
  parseSeverityFlag,
  policySkips,
  validatePolicy,
  type SeverityOverride,
  type SeverityPolicy,
} from "./policy.js";
export {
  defaultChecks,
  instanceUrlConfigured,
  connectivityAuth,
  updateSetState,
  defaultSetLeakage,
  remoteSetPreview,
  atfEnablement,
  atfRun,
  scopedAppDeps,
  i18nCompleteness,
  aclRoleSanity,
  clientCallableAcl,
  restEndpointSecurity,
  scriptFieldExposure,
  scheduledJobRunAs,
  mobileMenuHygiene,
  tableCrudAcl,
  uiPageAcl,
  uiActionGating,
  tableNamespace,
  portalRoles,
  aclOutOfScope,
  moduleRoles,
  scriptHygiene,
  hardcodedIdentifiers,
  clientScriptSafety,
  propertyPrivacy,
  inactiveArtifacts,
  notificationConditions,
  logLeftovers,
  deprecatedApis,
  testDrift,
} from "./checks/index.js";

/**
 * Apply a {@link CheckSelection} to a list of checks: keep only those named in
 * `only` (when present), then drop any named in `skip`. Matching is by the
 * check's `name`. Unknown names are silently ignored.
 */
export function selectChecks(
  checks: Check[],
  select?: CheckSelection,
): Check[] {
  if (!select) return checks;
  let out = checks;
  if (select.only && select.only.length > 0) {
    const only = new Set(select.only);
    out = out.filter((c) => only.has(c.name));
  }
  if (select.skip && select.skip.length > 0) {
    const skip = new Set(select.skip);
    out = out.filter((c) => !skip.has(c.name));
  }
  return out;
}

/**
 * A check's return value, forced into something the report can render. Checks
 * are supplied by the caller, so a bad return is third-party input: it must
 * fail that one check — exactly as a throw already does — rather than reject
 * the whole run with a TypeError raised deep inside the summariser, which would
 * take every other check's result down with it.
 */
function coerceResult(check: Check, produced: unknown): CheckResult {
  if (typeof produced !== "object" || produced === null) {
    return {
      name: check.name,
      status: "fail",
      message: `Check "${check.name}" returned ${
        produced === null || produced === undefined
          ? String(produced)
          : `a ${typeof produced}`
      } instead of a CheckResult object; treated as fail.`,
    };
  }
  // An object of the wrong shape still gets rendered: a bad `status` is caught
  // by the summariser below, but `name` is what identifies the row, so a
  // missing one falls back to the check that produced it.
  const candidate = produced as CheckResult;
  let named =
    typeof candidate.name === "string"
      ? candidate
      : { ...candidate, name: check.name };
  // `kind` marks rows the runner and the baseline synthesise; a check cannot
  // claim it.
  if (Object.hasOwn(named, "kind")) {
    named = { ...named };
    delete named.kind;
  }
  if (
    !Object.hasOwn(named, "findings") &&
    !Object.hasOwn(named, "findingsTruncated")
  ) {
    return named;
  }
  const { findings: raw, findingsTruncated: prior, ...rest } = named;
  const { findings, truncated } = sanitizeFindings(check.name, raw, prior);
  const result: CheckResult = { ...rest };
  if (findings.length > 0) result.findings = findings;
  if (truncated > 0) result.findingsTruncated = truncated;
  return result;
}

/**
 * Whether `name` is kept for synthetic rows: `"preflight"` (runner guards),
 * `"baseline"` (expired-entry notices) or any `"preflight:"` prefix.
 */
function isReservedCheckName(name: string): boolean {
  return (
    name === "preflight" || name === "baseline" || name.startsWith("preflight:")
  );
}

/**
 * The context one check runs with: `ctx` itself, or — when
 * `ctx.checkOptions` has an entry for the check — a copy whose `options` are
 * `ctx.options` with that entry shallow-merged over them. Own properties only,
 * so a check named like an `Object.prototype` member never picks up a
 * prototype value.
 */
function contextFor(ctx: PreflightContext, check: Check): PreflightContext {
  const own = ctx.checkOptions;
  if (!own || !Object.hasOwn(own, check.name)) return ctx;
  return { ...ctx, options: { ...ctx.options, ...own[check.name] } };
}

/** Cancellation and time budgets for one {@link runPreflight} call. */
export interface RunPreflightOptions {
  /** Aborts the run: the running check is cut short, the rest do not start. */
  signal?: AbortSignal;
  /** Per-check budget in milliseconds; a check over it becomes a `fail` row. */
  timeoutMs?: number;
  /** Budget for the whole run in milliseconds; behaves like `signal` aborting. */
  runTimeoutMs?: number;
  /**
   * Most checks running at once (1–32, default 1). Checks with `meta.serial`
   * always run one at a time, after the others, in registry order. The report
   * keeps registry order either way.
   */
  concurrency?: number;
}

/** Reject a budget that is not a positive, finite number of milliseconds. */
function assertBudget(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `runPreflight: ${name} must be a positive number of milliseconds (got ${String(value)}).`,
    );
  }
}

/** Why the run stopped: "Run aborted" or the run-timeout wording. */
type RunStop = () => string;

/**
 * Run one check under its own AbortController, linked to the run signal and
 * bounded by `timeoutMs`. Never rejects: a throw, a timeout and a run abort all
 * become `fail` rows. The timer is always cleared, so it never holds the
 * process open past the run — but it does keep a check that hangs on a bare
 * promise from letting the event loop drain before the verdict.
 */
async function runCheck(
  ctx: PreflightContext,
  check: Check,
  runSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  stopReason: RunStop,
): Promise<CheckResult> {
  const controller = new AbortController();
  const signal = controller.signal;
  const base = contextFor(ctx, check);
  const checkCtx: PreflightContext = {
    ...base,
    signal: anySignal([base.signal, signal]) ?? signal,
    http: withSignal(base.http, signal),
  };
  linkRunContext(checkCtx, ctx);

  let timer: ReturnType<typeof setTimeout> | undefined;
  // Removes the run-abort listener once this check is over.
  const listeners = new AbortController();
  const cut = new Promise<CheckResult>((resolve) => {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        resolve({
          name: check.name,
          status: "fail",
          message: `Check timed out after ${timeoutMs} ms (--timeout).`,
        });
        controller.abort(
          new DOMException(
            `Check timed out after ${timeoutMs} ms.`,
            "TimeoutError",
          ),
        );
      }, timeoutMs);
    }
    runSignal?.addEventListener(
      "abort",
      () => {
        resolve({
          name: check.name,
          status: "fail",
          message: `${stopReason()} while this check was running.`,
        });
        controller.abort(runSignal.reason);
      },
      { once: true, signal: listeners.signal },
    );
  });
  const work = (async (): Promise<CheckResult> => {
    try {
      // F-X-5: the check's requests are traced under its name.
      return coerceResult(
        check,
        await checkScope.run(check.name, () => check.run(checkCtx)),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        name: check.name,
        status: "fail",
        message: `Check threw an error: ${detail}`,
      };
    }
  })();
  const startedAt = performance.now();
  publishCheck({ phase: "start", check: check.name });
  try {
    const result = await Promise.race([work, cut]);
    publishCheck({
      phase: "end",
      check: check.name,
      status: result.status,
      ms: performance.now() - startedAt,
    });
    return result;
  } finally {
    clearTimeout(timer);
    // A check that finished on its own keeps its signal un-aborted: aborting it
    // now would reject any request it left floating.
    listeners.abort();
  }
}

/**
 * Run a set of preflight checks against a target ServiceNow instance and
 * return an aggregate report. The run is considered failing (`ok: false`)
 * if any check returns a `fail` status.
 *
 * `ctx.select` (only / skip by check name) filters the supplied `checks`
 * before they run.
 *
 * `opts` adds cancellation and time budgets (see {@link RunPreflightOptions}).
 * Each check gets `ctx.signal` and a `ctx.http` bound to it; a check over
 * `timeoutMs` fails with "Check timed out after … ms", and an aborted or
 * timed-out run fails the checks it did not finish. The report is always
 * produced. `opts.concurrency` runs up to that many checks at once; the report
 * keeps registry order. Invalid budgets or concurrency throw a `RangeError`.
 */
export async function runPreflight(
  ctx: PreflightContext,
  checks: Check[] = defaultChecks,
  opts: RunPreflightOptions = {},
): Promise<PreflightReport> {
  assertBudget("timeoutMs", opts.timeoutMs);
  assertBudget("runTimeoutMs", opts.runTimeoutMs);
  const concurrency = opts.concurrency ?? 1;
  const badConcurrency = concurrencyProblem(concurrency);
  if (badConcurrency !== undefined) {
    throw new RangeError(
      `runPreflight: concurrency ${badConcurrency} (got ${String(opts.concurrency)}).`,
    );
  }

  // Reject an ambiguous check set: two checks sharing a `name` make selection
  // (only/skip), result mapping, and reporting ambiguous. Fail closed rather
  // than run a set we cannot reason about.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const reserved = new Set<string>();
  for (const check of checks) {
    if (seen.has(check.name)) duplicates.add(check.name);
    seen.add(check.name);
    if (isReservedCheckName(check.name)) reserved.add(check.name);
  }
  if (duplicates.size > 0 || reserved.size > 0) {
    const problems: string[] = [];
    if (duplicates.size > 0) {
      const names = [...duplicates].sort().join(", ");
      problems.push(
        `Duplicate check name(s): ${names}. Check names must be unique.`,
      );
    }
    if (reserved.size > 0) {
      const names = [...reserved].sort().join(", ");
      problems.push(
        `Reserved check name(s): ${names}. "preflight", "baseline" and names starting with "preflight:" are kept for rows the runner and the baseline produce.`,
      );
    }
    return {
      ok: false,
      results: [
        {
          name: "preflight",
          status: "fail",
          message: problems.join(" "),
          kind: "runner",
        },
      ],
      summary: { pass: 0, warn: 0, fail: 1 },
    };
  }

  const selected = selectChecks(checks, ctx.select);

  // Nothing to run means nothing was verified. A pre-deployment gate must never
  // report a vacuous pass (exit 0 having checked nothing), so surface it as a
  // failure — whether the supplied set was empty or a selection narrowed it to
  // zero.
  if (selected.length === 0) {
    const message =
      checks.length === 0
        ? "No checks were supplied to runPreflight; nothing was verified."
        : "No checks matched the selection (ctx.select.only/skip); nothing was verified.";
    return {
      ok: false,
      results: [{ name: "preflight", status: "fail", message, kind: "runner" }],
      summary: { pass: 0, warn: 0, fail: 1 },
    };
  }

  // Run each check in isolation: a check that throws or rejects must not abort
  // the whole run. Convert the throw into a `fail` result and keep going so the
  // report still renders and every other check still reports.
  //
  // A run budget or a caller abort stops the run fail-closed: every running check
  // is cut short and every check that has not started yet becomes a `fail` row,
  // so the report still lists the whole selection.
  let runTimedOut = false;
  let runTimer: ReturnType<typeof setTimeout> | undefined;
  let runController: AbortController | undefined;
  if (opts.runTimeoutMs !== undefined) {
    const controller = new AbortController();
    const budget = opts.runTimeoutMs;
    runTimer = setTimeout(() => {
      runTimedOut = true;
      controller.abort(
        new DOMException(`Run timed out after ${budget} ms.`, "TimeoutError"),
      );
    }, budget);
    runController = controller;
  }
  const runSignal = anySignal([opts.signal, runController?.signal]);
  const stopReason: RunStop = () =>
    runTimedOut
      ? `Run timed out after ${String(opts.runTimeoutMs)} ms (--run-timeout)`
      : "Run aborted";

  const runOne = (check: Check): Promise<CheckResult> =>
    runSignal?.aborted
      ? Promise.resolve({
          name: check.name,
          status: "fail",
          message: `${stopReason()} before this check started.`,
        })
      : runCheck(ctx, check, runSignal, opts.timeoutMs, stopReason);

  // Parallel checks go through the bounded pool first; `serial` checks then run
  // alone, one after another. Each result lands at its check's registry index.
  const results = new Array<CheckResult>(selected.length);
  const parallel: number[] = [];
  const serial: number[] = [];
  selected.forEach((check, index) =>
    (check.meta?.serial === true ? serial : parallel).push(index),
  );
  const runStartedAt = performance.now();
  publishRun({ phase: "start", checks: selected.length, concurrency });
  try {
    await runPool(parallel, concurrency, async (index) => {
      results[index] = await runOne(selected[index] as Check);
    });
    for (const index of serial) {
      results[index] = await runOne(selected[index] as Check);
    }
  } finally {
    clearTimeout(runTimer);
  }

  // Summarise fail-closed: an unrecognised status is untrustworthy for a gate,
  // so it is counted (and surfaced) as a failure rather than silently producing
  // a NaN bucket and a vacuous `ok: true`.
  const validStatuses: readonly CheckStatus[] = ["pass", "warn", "fail"];
  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  const normalized: CheckResult[] = results.map((result) => {
    if ((validStatuses as readonly string[]).includes(result.status)) {
      summary[result.status] += 1;
      return result;
    }
    summary.fail += 1;
    return {
      name: result.name,
      status: "fail",
      message: `Check "${result.name}" returned an unrecognised status "${String(
        result.status,
      )}"; treated as fail. Original message: ${result.message}`,
    };
  });

  publishRun({
    phase: "end",
    ms: performance.now() - runStartedAt,
    summary: { ...summary },
  });
  return { ok: summary.fail === 0, results: normalized, summary };
}

// Re-exported for consumers that only need the auth type name.
export type { PreflightAuth as Auth } from "./types.js";
