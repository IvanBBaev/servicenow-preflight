import { defaultChecks } from "./checks/index.js";
import type {
  Check,
  CheckResult,
  CheckStatus,
  PreflightContext,
  PreflightReport,
} from "./types.js";

export type {
  Check,
  CheckResult,
  CheckStatus,
  PreflightContext,
  PreflightReport,
} from "./types.js";
export { defaultChecks, instanceUrlConfigured } from "./checks/index.js";

/**
 * Run a set of preflight checks against a target ServiceNow instance and
 * return an aggregate report. The run is considered failing (`ok: false`)
 * if any check returns a `fail` status.
 */
export async function runPreflight(
  ctx: PreflightContext,
  checks: Check[] = defaultChecks,
): Promise<PreflightReport> {
  const results: CheckResult[] = [];
  for (const check of checks) {
    results.push(await check.run(ctx));
  }

  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const result of results) {
    summary[result.status] += 1;
  }

  return { ok: summary.fail === 0, results, summary };
}
