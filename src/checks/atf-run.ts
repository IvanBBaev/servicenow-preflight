import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";
import type { CheckResult, PreflightContext } from "../types.js";
import type { Check } from "../types.js";

const NAME = "atf-run";

/** Table that holds one row per ATF test executed within a suite run. */
const TEST_RESULT_TABLE = "sys_atf_test_result";

/**
 * CI/CD suite `status` values that mean "still going" — the run has not settled
 * yet, so we cannot assert pass/fail. Advisory → `warn`.
 */
const PENDING_STATUSES = new Set([
  "pending",
  "running",
  "in_progress",
  "in progress",
  "queued",
  "waiting",
]);

/**
 * Per-test `status` values (on `sys_atf_test_result`) that count as red.
 * ServiceNow reports failed assertions as `failure` and unexpected script
 * errors as `error`.
 */
const RED_TEST_STATUSES = new Set(["failure", "failed", "error", "errored"]);

/**
 * Terminal CI/CD suite statuses that mean the run itself did not pass. A suite
 * in one of these states is red even if we cannot enumerate its per-test rows.
 */
const FAILED_SUITE_STATUSES = new Set([
  "failure",
  "failed",
  "error",
  "errored",
  "canceled",
  "cancelled",
]);

function makeResult(
  status: CheckResult["status"],
  message: string,
): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Resolve the suite `sys_id`s to run. Explicit config wins: `options.atfSuites`
 * / `atfSuiteId` are used verbatim. When neither is set and a resolved instance
 * manifest is present (`ctx.manifest`), the suites come from it — using *that
 * instance's* `sys_id`s — optionally narrowed by `options.atfSuiteNames`
 * (logical `id`s or names). This is what lets the same logical suite run against
 * dev / staging / test / prod with each instance's own ids.
 */
function resolveSuiteIds(ctx: PreflightContext): string[] {
  const opts = ctx.options ?? {};
  const ids: string[] = [];

  const many = opts.atfSuites;
  if (Array.isArray(many)) {
    for (const entry of many) {
      if (typeof entry === "string" && entry.trim()) ids.push(entry.trim());
    }
  }

  const one = opts.atfSuiteId;
  if (typeof one === "string" && one.trim()) ids.push(one.trim());

  if (ids.length === 0 && ctx.manifest) {
    const names = opts.atfSuiteNames;
    const wanted = Array.isArray(names)
      ? new Set(names.filter((n): n is string => typeof n === "string"))
      : undefined;
    for (const suite of ctx.manifest.suites) {
      if (!suite.sysId) continue;
      if (wanted && !wanted.has(suite.id) && !wanted.has(suite.name)) continue;
      ids.push(suite.sysId);
    }
  }

  // De-duplicate while preserving order.
  return [...new Set(ids)];
}

/** Coerce an unknown field to a trimmed lowercase string ("" when absent). */
function asStatus(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Coerce an unknown field to a trimmed string ("" when absent). */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** A single red test row, distilled to what we surface in the message. */
interface RedTest {
  test: string;
  output: string;
}

/**
 * Fetch the per-test rows for one suite run and pick out the red ones. Rows are
 * scoped by the run's `resultId` (`sys_atf_test_result.test_suite_result`). When
 * the CI/CD API did not expose a result id we return `[]` rather than scanning
 * the whole table — an unscoped scan would attribute unrelated historical runs
 * to this one. The caller still fails the suite on a failed terminal status.
 */
async function collectRedTests(
  ctx: PreflightContext,
  resultId: string | undefined,
): Promise<RedTest[]> {
  if (!resultId || !resultId.trim()) return [];

  const rows = await ctx.http.table(TEST_RESULT_TABLE).query({
    sysparm_query: `test_suite_result=${resultId.trim()}`,
  });

  const red: RedTest[] = [];
  for (const row of rows) {
    if (RED_TEST_STATUSES.has(asStatus(row.status))) {
      red.push({
        test: asText(row.test) || asText(row.sys_id) || "(unnamed test)",
        output: asText(row.output),
      });
    }
  }
  return red;
}

/** Build the failing-assertion detail carried in a `fail` message. */
function describeRedTests(red: RedTest[]): string {
  const shown = red.slice(0, 3).map((t) => {
    const detail = t.output ? `: ${t.output}` : "";
    return `${t.test}${detail}`;
  });
  const more =
    red.length > shown.length ? ` (+${red.length - shown.length} more)` : "";
  return `${shown.join("; ")}${more}`;
}

/**
 * Runs the configured ATF test suite(s) via the CI/CD API, then reads the
 * per-test rows from `sys_atf_test_result`:
 *
 * - `fail`  — any test is red; the message carries the failing assertion text.
 * - `warn`  — no suite is configured, or a run is still pending/running.
 * - `pass`  — every configured suite settled green with no red tests.
 *
 * A check must never throw: `SnAuthError`/`SnHttpError` map to `fail`, and a
 * transient `SnNetworkError` maps to `warn` (advisory/degraded).
 */
export const atfRun: Check = {
  name: NAME,
  description: "The configured ATF test suite passes.",
  async run(ctx): Promise<CheckResult> {
    const suiteIds = resolveSuiteIds(ctx);
    if (suiteIds.length === 0) {
      return makeResult(
        "warn",
        "No ATF suite configured (set options.atfSuites or options.atfSuiteId); skipping.",
      );
    }

    const pending: string[] = [];
    const red: RedTest[] = [];
    let passedSuites = 0;

    try {
      for (const suiteId of suiteIds) {
        const run = await ctx.http.cicd.runTestSuite(suiteId);
        const status = asStatus(run.status);

        if (PENDING_STATUSES.has(status)) {
          pending.push(suiteId);
          continue;
        }

        const suiteRed = await collectRedTests(ctx, run.resultId);
        if (suiteRed.length > 0) {
          red.push(...suiteRed);
        } else if (FAILED_SUITE_STATUSES.has(status)) {
          // The suite settled red but exposed no per-test rows we could scope
          // (e.g. no result id): surface the suite-level failure rather than
          // silently passing it.
          red.push({
            test: `suite ${suiteId}`,
            output: `suite run reported status "${status}"`,
          });
        } else {
          passedSuites += 1;
        }
      }
    } catch (err) {
      if (err instanceof SnAuthError) {
        return makeResult(
          "fail",
          `Authentication failed while running the ATF suite: ${err.message}`,
        );
      }
      if (err instanceof SnNetworkError) {
        return makeResult(
          "warn",
          `Could not reach the instance to run the ATF suite: ${err.message}`,
        );
      }
      if (err instanceof SnHttpError) {
        return makeResult(
          "fail",
          `The ATF run API returned an error (HTTP ${err.status}): ${err.message}`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return makeResult("fail", `ATF check failed unexpectedly: ${message}`);
    }

    if (red.length > 0) {
      const suffix = pending.length
        ? ` (${pending.length} suite(s) still pending)`
        : "";
      return makeResult(
        "fail",
        `${red.length} ATF test(s) failed: ${describeRedTests(red)}${suffix}`,
      );
    }

    if (pending.length > 0) {
      return makeResult(
        "warn",
        `ATF run still pending for ${pending.length} of ${suiteIds.length} suite(s); re-run once it settles.`,
      );
    }

    return makeResult(
      "pass",
      `All ATF tests passed across ${passedSuites} suite(s).`,
    );
  },
};
