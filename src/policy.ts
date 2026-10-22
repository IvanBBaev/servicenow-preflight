import { UsageError } from "./config.js";
import { summarize } from "./baseline.js";
import type { CheckResult, PreflightReport } from "./types.js";

/**
 * Severity policy: per-check overrides of how a non-pass result is reported.
 *
 * - `"fail"` — a non-pass result of that check is reported as `fail`
 *   (e.g. a Store-bound app promotes the advisory `scheduled-job-run-as`).
 * - `"warn"` — a non-pass result is reported as `warn` (demotion).
 * - `"off"` — the check is not run (folded into `select.skip`, so the
 *   "nothing was verified" guard still applies).
 *
 * A rewritten row's message gets a ` [severity: <level> by policy]` suffix so
 * a reader knows why it differs from the catalogue. `pass` rows are never
 * touched and a row's `name` never changes.
 */

/** One check's override. */
export type SeverityOverride = "fail" | "warn" | "off";

/** Overrides keyed by check name. */
export type SeverityPolicy = Record<string, SeverityOverride>;

const LEVELS: readonly SeverityOverride[] = ["fail", "warn", "off"];

/** Whether `value` is one of the three override literals. */
export function isSeverityOverride(value: unknown): value is SeverityOverride {
  return (LEVELS as readonly unknown[]).includes(value);
}

/**
 * Parse a `--severity <check>=<fail|warn|off>` value into a tuple. Throws
 * {@link UsageError} on a missing name, a missing level or an unknown level.
 */
export function parseSeverityFlag(value: string): [string, SeverityOverride] {
  const at = value.indexOf("=");
  const name = at < 0 ? "" : value.slice(0, at).trim();
  const level = at < 0 ? "" : value.slice(at + 1).trim();
  if (name.length === 0 || level.length === 0) {
    throw new UsageError(
      `Invalid --severity "${value}". Use <check>=<fail|warn|off> (e.g. scheduled-job-run-as=fail).`,
    );
  }
  if (!isSeverityOverride(level)) {
    throw new UsageError(
      `Invalid --severity level "${level}" for ${name}. Valid levels: ${LEVELS.join(", ")}.`,
    );
  }
  return [name, level];
}

/**
 * Refuse a policy naming checks that are not in the loaded set (typo
 * protection): {@link UsageError} listing every unknown name. A check excluded
 * by `--only` still exists, so naming it is not an error.
 */
export function validatePolicy(
  policy: SeverityPolicy,
  knownNames: readonly string[],
): void {
  const known = new Set(knownNames);
  const unknown = Object.keys(policy).filter((n) => !known.has(n));
  if (unknown.length > 0) {
    throw new UsageError(
      `Severity policy names unknown check(s): ${unknown.join(", ")}. Known checks: ${knownNames.join(", ")}.`,
    );
  }
}

/** The check names a policy turns `"off"` (to fold into `select.skip`). */
export function policySkips(policy: SeverityPolicy): string[] {
  return Object.keys(policy).filter((n) => policy[n] === "off");
}

/**
 * Apply a severity policy to a report (pure). Non-pass rows of a check mapped
 * to `"fail"` or `"warn"` take that status; a row whose status changes gets the
 * ` [severity: <level> by policy]` suffix. Summary and `ok` are recomputed.
 */
export function applyPolicy(
  report: PreflightReport,
  policy: SeverityPolicy,
): PreflightReport {
  const results = report.results.map((r): CheckResult => {
    if (r.status === "pass") return r;
    const level = Object.prototype.hasOwnProperty.call(policy, r.name)
      ? policy[r.name]
      : undefined;
    if (level !== "fail" && level !== "warn") return r;
    if (level === r.status) return r;
    return {
      ...r,
      status: level,
      message: `${r.message} [severity: ${level} by policy]`,
    };
  });
  return summarize(results);
}
