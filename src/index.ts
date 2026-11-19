/**
 * Pre-deployment preflight checks for ServiceNow, as a library.
 *
 * The entry point is {@link runPreflight}, which runs a list of {@link Check}s
 * against a target instance ({@link PreflightContext}) and returns an aggregate
 * {@link PreflightReport}. Call it with no explicit list to run
 * {@link defaultChecks}, or pass your own {@link CheckSelection}. Its
 * `report.ok` is the raw check verdict. The gate a CI job acts on (severity
 * policy, baseline, `failOn`) is {@link runGate}, or {@link evaluate} over a
 * report you already have; the bundled CLI (`servicenow-preflight` / `snpf`)
 * decides every run through the same {@link evaluate}.
 *
 * The package root is a curated core: running checks, building a client,
 * loading config and writing a check. Everything else lives on a subpath —
 * `servicenow-preflight/checks`, `/http`, `/report`, `/state`, `/testing`, and
 * `/internal` (no semver promise).
 *
 * @packageDocumentation
 */
import { assertBaselineTarget } from "./baseline.js";
import { defaultChecks } from "./checks/index.js";
import { isMissingTable, missingTableResult } from "./checks/cert-common.js";
import { sanitizeFindings } from "./findings.js";
import { anySignal } from "./http/abort.js";
import {
  MAX_TIMER_MS,
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  withSignal,
} from "./http/client.js";
import { cachedScope, linkRunContext } from "./http/query.js";
import {
  assertFailOn,
  evaluate,
  type EvaluateOptions,
  type Verdict,
} from "./core/evaluate.js";
import { policySkips, validatePolicy } from "./policy.js";
import { MissingTables, missingMessage } from "./runner/missing-tables.js";
import { concurrencyProblem, runPool } from "./runner/pool.js";
import { summarizeResults } from "./summary.js";
import { checkScope, publishCheck, publishRun } from "./trace.js";
import type {
  Check,
  CheckResult,
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
} from "./types.js";
export type { SnClient, SnAuth, SnClientConfig } from "./http/client.js";
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
export { findingId, makeFinding } from "./findings.js";
export {
  loadConfig,
  UsageError,
  type PreflightConfig,
  type LoadedConfig,
  type LoadConfigOptions,
} from "./config.js";
export {
  describeChecks,
  findCheck,
  type CheckDescriptor,
} from "./catalogue.js";
export { defaultChecks } from "./checks/index.js";
export { evaluate, type Verdict } from "./core/evaluate.js";

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
      kind: "runner",
    };
  }
  const candidate = produced as CheckResult;
  // CLI-17: a result without a message string is not a verdict a reader can
  // act on; it fails like any other malformed return.
  if (typeof candidate.message !== "string") {
    return {
      name: check.name,
      status: "fail",
      message: `Check "${check.name}" returned a result without a message string; treated as fail.`,
      kind: "runner",
    };
  }
  // CLI-17: the row is always named after the check that produced it. Policy
  // and baseline match rows by name, so a check must not report (or pass)
  // under another check's name.
  const named: CheckResult = { ...candidate, name: check.name };
  // `kind` marks rows the runner and the baseline synthesise; a check cannot
  // claim it.
  delete named.kind;
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

/**
 * Reject a budget that is not a positive, finite number of milliseconds, or
 * one above {@link MAX_TIMER_MS}: a longer timer fires after 1 ms, so every
 * check would time out at once (RR-52, CLI-9).
 */
function assertBudget(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_TIMER_MS
  ) {
    throw new RangeError(
      `runPreflight: ${name} must be a positive number of milliseconds up to ${MAX_TIMER_MS} (got ${String(value)}).`,
    );
  }
}

/**
 * ACL-1: a scope with no `sys_scope` row makes every scope-bound read match
 * nothing, so those checks report "nothing to check" and pass. After the
 * checks ran, look at the scope resolution they shared (no new read): when it
 * found no row, return the run-level failure message. A lookup that failed or
 * never happened returns `undefined` — the checks already reported that.
 */
async function unresolvedScope(
  ctx: PreflightContext,
): Promise<string | undefined> {
  const scope = ctx.scope?.trim();
  const lookup = scope ? cachedScope(ctx, scope) : undefined;
  if (!lookup) return undefined;
  try {
    if ((await lookup).sysId) return undefined;
  } catch {
    return undefined;
  }
  return `Scope "${String(scope)}" did not resolve to a sys_scope record: no scoped app has that name or sys_id, or the account cannot read sys_scope. Every scope-bound read matched nothing, so a pass from a scope-bound check verified nothing. Fix the scope (--scope, SNPF_SCOPE, the config file or the instance registry).`;
}

/** Why the run stopped: "Run aborted" or the run-timeout wording. */
type RunStop = () => string;

/**
 * Run one check under its own AbortController, linked to the run signal and
 * bounded by `timeoutMs`. Never rejects: a throw, a timeout and a run abort all
 * become `fail` rows with `kind: "runner"`, so no baseline or severity policy
 * can accept them (CLI-2, CLI-3). A table read that found a required table
 * missing makes the row `error` (CLI-1, see {@link MissingTables}). The timer
 * is always cleared, so it never holds the process open past the run — but it
 * does keep a check that hangs on a bare promise from letting the event loop
 * drain before the verdict.
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
  const missing = new MissingTables(check);
  const checkCtx: PreflightContext = {
    ...base,
    signal: anySignal([base.signal, signal]) ?? signal,
    http: missing.watch(withSignal(base.http, signal)),
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
          kind: "runner",
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
          kind: "runner",
        });
        controller.abort(runSignal.reason);
      },
      { once: true, signal: listeners.signal },
    );
  });
  const work = (async (): Promise<CheckResult> => {
    try {
      // F-X-5: the check's requests are traced under its name.
      return missing.enforce(
        coerceResult(
          check,
          await checkScope.run(check.name, () => check.run(checkCtx)),
        ),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // A read that failed (HTTP 4xx/5xx, network, auth) verified nothing:
      // `error`, which fails the run and no baseline or policy can demote.
      const readFailed =
        err instanceof SnAuthError ||
        err instanceof SnHttpError ||
        err instanceof SnNetworkError;
      // CLI-1: a missing table is the skip warn only when the check declared
      // that table optional (a plugin's table) and found no required table
      // missing; any other missing table means the check verified nothing.
      if (isMissingTable(err)) {
        return missing.isOptional(err) && missing.required().length === 0
          ? missingTableResult(check.name, "this check", err)
          : {
              name: check.name,
              status: "error",
              message: `${missingMessage(missing.required())} Check threw an error: ${detail}`,
            };
      }
      if (readFailed) {
        return {
          name: check.name,
          status: "error",
          message: `Check threw an error: ${detail}`,
        };
      }
      return missing.enforce({
        name: check.name,
        status: "fail",
        message: `Check threw an error: ${detail}`,
        kind: "runner",
      });
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
 * if any check returns a `fail` or `error` status.
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
 *
 * When the checks looked `ctx.scope` up and it matched no `sys_scope` row, a
 * `preflight` `fail` row leads the report: the scope-bound checks read nothing.
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
      summary: { pass: 0, warn: 0, fail: 1, error: 0 },
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
      summary: { pass: 0, warn: 0, fail: 1, error: 0 },
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
          kind: "runner",
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

  const scopeProblem = await unresolvedScope(ctx);
  if (scopeProblem !== undefined) {
    results.unshift({
      name: "preflight",
      status: "fail",
      message: scopeProblem,
      kind: "runner",
    });
  }

  // Summarise fail-closed: an unrecognised status counts as a failure.
  const report = summarizeResults(results);

  publishRun({
    phase: "end",
    ms: performance.now() - runStartedAt,
    summary: { ...report.summary },
  });
  return report;
}

/**
 * Run the checks and decide the gate in one call (RR-12):
 * `evaluate(await runPreflight(...))`, with the steps the CLI takes around
 * them. Before anything runs, the policy's names are validated against
 * `checks` (`UsageError` on an unknown name), `failOn` is validated
 * (`RangeError`), and a baseline recorded for another instance is refused
 * (`UsageError`; the target defaults to `ctx.instance` and, outside a replay,
 * `ctx.instanceUrl`). Policy `"off"` entries join `ctx.select.skip`, so those
 * checks do not run. The returned {@link Verdict} carries the same `ok` and
 * report the CLI prints for the same inputs.
 */
export async function runGate(
  ctx: PreflightContext,
  checks: Check[] = defaultChecks,
  opts: RunPreflightOptions & EvaluateOptions = {},
): Promise<Verdict> {
  const policy = opts.policy ?? {};
  validatePolicy(
    policy,
    checks.map((c) => c.name),
  );
  assertFailOn(opts.failOn ?? "fail");
  if (opts.baseline) {
    assertBaselineTarget(
      opts.baseline,
      opts.baselineTarget ?? {
        ...(ctx.instance !== undefined ? { instance: ctx.instance } : {}),
        ...(!ctx.replay && ctx.instanceUrl ? { url: ctx.instanceUrl } : {}),
      },
    );
  }
  const skip = ctx.select?.skip ?? [];
  const off = policySkips(policy).filter((n) => !skip.includes(n));
  const runCtx: PreflightContext =
    off.length > 0
      ? { ...ctx, select: { ...ctx.select, skip: [...skip, ...off] } }
      : ctx;
  const raw = await runPreflight(runCtx, checks, opts);
  // The target was checked up front, before any network call.
  return evaluate(raw, {
    policy,
    baseline: opts.baseline,
    failOn: opts.failOn,
    now: opts.now,
  });
}
