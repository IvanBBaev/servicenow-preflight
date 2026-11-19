import {
  applyBaseline,
  applyFailOn,
  BASELINE_ROW,
  type Baseline,
  type BaselineTarget,
} from "../baseline.js";
import type { FailOn } from "../config.js";
import { applyPolicy, type SeverityPolicy } from "../policy.js";
import type { PreflightReport } from "../types.js";

/**
 * The gate verdict pipeline (RR-12, ARC-1): the one place that turns a raw
 * {@link PreflightReport} into the decision a CI job acts on. The CLI and the
 * library's `runGate` both go through {@link evaluate}, so every integration
 * surface gets the same verdict. Pure: no file system, network or `process`
 * access; the baseline is a loaded object, not a path.
 */

/** Inputs of {@link evaluate}; every field is optional. */
export interface EvaluateOptions {
  /**
   * Per-check severity overrides, applied first. `"off"` entries are not
   * applied here: they decide which checks run (`runGate` folds them into
   * `ctx.select.skip`). Names are not validated here, because a raw report
   * does not list the checks a selection left out; `runGate` validates them
   * against its check set.
   */
  policy?: SeverityPolicy;
  /** Accepted findings, applied after the policy (e.g. from `readBaseline`). */
  baseline?: Baseline;
  /**
   * The instance the run targeted. With a baseline, one recorded for another
   * instance throws `UsageError` instead of being applied.
   */
  baselineTarget?: BaselineTarget;
  /** `"fail"` (default): only fail / error rows fail the gate; `"warn"`: an unbaselined warn does too. */
  failOn?: FailOn;
  /** The clock for baseline expiry. Default: now. */
  now?: Date;
}

/** The gate decision for one run. */
export interface Verdict {
  /**
   * The report after policy and baseline. Its `ok` is the gate decision
   * (equal to {@link Verdict.ok}), so under `failOn: "warn"` it can be false
   * with no `fail` row.
   */
  report: PreflightReport;
  /** Whether the gate passes. */
  ok: boolean;
  /** The threshold the decision used. */
  failOn: FailOn;
  /** Rows the baseline accepted (now `warn` with `kind: "baseline"`). */
  baselined: number;
  /** Expired baseline entries (one `baseline` warn row each). */
  expired: number;
}

/** Throw a `RangeError` unless `value` is a {@link FailOn} literal. */
export function assertFailOn(value: unknown): asserts value is FailOn {
  if (value !== "fail" && value !== "warn") {
    throw new RangeError(
      `failOn must be "fail" or "warn" (got ${JSON.stringify(value)}).`,
    );
  }
}

/**
 * Decide a run: severity policy, then baseline, then the `failOn` threshold.
 * The order is part of the contract: the baseline applies after the policy,
 * so a row the policy demoted is never baselined as `fail`, and the threshold
 * comes last, so a baselined warn does not fail a `failOn: "warn"` run. The
 * summary is recomputed fail-closed (an unknown status counts as a failure).
 * An invalid `failOn` throws `RangeError`; a baseline recorded for another
 * `baselineTarget` throws `UsageError`.
 */
export function evaluate(
  raw: PreflightReport,
  opts: EvaluateOptions = {},
): Verdict {
  const failOn = opts.failOn ?? "fail";
  assertFailOn(failOn);
  const policed = applyPolicy(raw, opts.policy ?? {});
  const accepted = opts.baseline
    ? applyBaseline(
        policed,
        opts.baseline,
        opts.now ?? new Date(),
        opts.baselineTarget,
      )
    : policed;
  const report = applyFailOn(accepted, failOn);
  let baselined = 0;
  let expired = 0;
  for (const r of report.results) {
    if (r.kind !== "baseline") continue;
    if (r.name === BASELINE_ROW) expired += 1;
    else baselined += 1;
  }
  return { report, ok: report.ok, failOn, baselined, expired };
}
