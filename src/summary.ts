import type { CheckResult, CheckStatus, PreflightReport } from "./types.js";

const VALID_STATUSES: readonly string[] = ["pass", "warn", "fail"];

/**
 * Summarise check results fail-closed into a `PreflightReport`. An
 * unrecognised status is untrustworthy for a gate, so it is counted (and
 * surfaced) as a failure rather than silently passing or producing a NaN
 * bucket and a vacuous `ok: true`. Shared by `runPreflight` and the CLI's
 * result merging so both verdict paths apply the same rule.
 */
export function summarizeResults(
  results: readonly CheckResult[],
): PreflightReport {
  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  const normalized: CheckResult[] = results.map((result) => {
    if (VALID_STATUSES.includes(result.status)) {
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
  return { ok: summary.fail === 0, results: normalized, summary };
}
