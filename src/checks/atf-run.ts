import { SnAuthError, SnHttpError, SnNetworkError } from "../http/client.js";
import { eq } from "../http/query.js";
import type { CheckResult, PreflightContext } from "../types.js";
import type { Check } from "../types.js";

const NAME = "atf-run";

/** Table that holds one row per ATF test executed within a suite run. */
const TEST_RESULT_TABLE = "sys_atf_test_result";

/**
 * Table that holds one row per *suite* run. A suite that includes nested child
 * suites produces a child `sys_atf_test_suite_result` row per nested suite,
 * linked back through `parent`; each nested suite's test rows hang off its own
 * result id, not the root's.
 */
const SUITE_RESULT_TABLE = "sys_atf_test_suite_result";

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
 * Terminal CI/CD suite statuses that mean the run *passed*. Anything settled
 * that is neither pending, nor a known pass, nor a known failure is treated as
 * unrecognised and fails closed — a suite that reported `unknown` / `not_found`
 * / `skipped` / `timed_out` must never be counted as green.
 */
const SUCCESS_SUITE_STATUSES = new Set([
  "success",
  "successful",
  "passed",
  "pass",
  "ok",
]);

/**
 * Per-test `status` values (on `sys_atf_test_result`) that count as red.
 * ServiceNow reports failed assertions as `failure` and unexpected script
 * errors as `error`.
 */
const RED_TEST_STATUSES = new Set(["failure", "failed", "error", "errored"]);

/**
 * Per-test `status` values that mean the test asserted nothing. A skipped test
 * is neither red nor a real pass — surfacing it as at least a `warn` stops a
 * silently-skipped suite from reading as fully green.
 */
const SKIPPED_TEST_STATUSES = new Set([
  "skipped",
  "skip",
  "not_run",
  "ignored",
]);

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
export function resolveSuiteIds(ctx: PreflightContext): string[] {
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

/**
 * Unwrap a Table API reference value to its `value` string. Reference columns
 * (e.g. `sys_atf_test_result.test`) arrive as `{ link, value }`, never a bare
 * string — reading them naively as text yields `""` and the message falls back
 * to a raw sys_id.
 */
function refValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim();
    if (typeof inner === "number") return String(inner);
  }
  return "";
}

/**
 * A readable name for a test row: prefer the dot-walked `test.name`, then the
 * `test` reference's value, then the row's own sys_id — so CI output shows test
 * names rather than opaque sys_ids.
 */
function testName(row: Record<string, unknown>): string {
  return (
    asText(row["test.name"]) ||
    refValue(row.test) ||
    asText(row.sys_id) ||
    "(unnamed test)"
  );
}

/** A single red test row, distilled to what we surface in the message. */
interface RedTest {
  test: string;
  output: string;
}

/** The per-test outcomes rolled up for one suite run. */
interface SuiteOutcomes {
  red: RedTest[];
  skipped: number;
}

/**
 * Collect this suite-run result id plus every descendant suite-run result id,
 * following `sys_atf_test_suite_result.parent`. A suite with nested child suites
 * records the child tests under the child suites' result ids, so scoping only to
 * the root id would miss (and thus falsely pass) nested red tests.
 */
async function collectSuiteResultIds(
  ctx: PreflightContext,
  rootId: string,
): Promise<string[]> {
  const ids = [rootId];
  const visited = new Set([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const parentId of frontier) {
      const children = await ctx.http.table(SUITE_RESULT_TABLE).query({
        sysparm_query: eq("parent", parentId),
        sysparm_fields: "sys_id,parent",
      });
      for (const child of children) {
        const cid = refValue(child.sys_id);
        if (cid && !visited.has(cid)) {
          visited.add(cid);
          ids.push(cid);
          next.push(cid);
        }
      }
    }
    frontier = next;
  }
  return ids;
}

/**
 * Fetch the per-test rows for one suite run — across the root result id and
 * every nested child suite result id — and classify them. Rows are scoped by
 * each run's `test_suite_result`. When the CI/CD API did not expose a result id
 * we return empty outcomes rather than scanning the whole table (an unscoped
 * scan would attribute unrelated historical runs to this one); the caller still
 * fails the suite on a failed terminal status.
 */
async function collectTestOutcomes(
  ctx: PreflightContext,
  resultId: string | undefined,
): Promise<SuiteOutcomes> {
  if (!resultId || !resultId.trim()) return { red: [], skipped: 0 };

  const resultIds = await collectSuiteResultIds(ctx, resultId.trim());
  const red: RedTest[] = [];
  let skipped = 0;

  for (const rid of resultIds) {
    const rows = await ctx.http.table(TEST_RESULT_TABLE).query({
      sysparm_query: eq("test_suite_result", rid),
      sysparm_fields: "sys_id,status,output,test,test.name,test_suite_result",
    });
    for (const row of rows) {
      const status = asStatus(row.status);
      if (RED_TEST_STATUSES.has(status)) {
        red.push({ test: testName(row), output: asText(row.output) });
      } else if (SKIPPED_TEST_STATUSES.has(status)) {
        skipped += 1;
      }
    }
  }

  return { red, skipped };
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
 * per-test rows from `sys_atf_test_result` (across nested child suites):
 *
 * - `fail`  — any test is red (message carries the failing assertion text), a
 *   suite settled on a failed terminal status, or a suite settled on an
 *   unrecognised status (`unknown` / `not_found` / `timed_out` / …) — a suite
 *   that did not clearly pass is never counted green.
 * - `warn`  — no suite is configured, a run is still pending/running, or the
 *   run(s) settled with no red tests but some tests were skipped.
 * - `pass`  — every configured suite settled green with no red or skipped tests.
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
    const unrecognised: string[] = [];
    let skippedTotal = 0;
    let passedSuites = 0;

    try {
      for (const suiteId of suiteIds) {
        const run = await ctx.http.cicd.runTestSuite(suiteId);
        const status = asStatus(run.status);

        if (PENDING_STATUSES.has(status)) {
          pending.push(suiteId);
          continue;
        }

        const outcomes = await collectTestOutcomes(ctx, run.resultId);
        skippedTotal += outcomes.skipped;
        if (outcomes.red.length > 0) {
          red.push(...outcomes.red);
        }

        if (FAILED_SUITE_STATUSES.has(status)) {
          if (outcomes.red.length === 0) {
            // Settled red but exposed no per-test rows we could scope (e.g. no
            // result id): surface the suite-level failure rather than pass it.
            red.push({
              test: `suite ${suiteId}`,
              output: `suite run reported status "${status}"`,
            });
          }
        } else if (SUCCESS_SUITE_STATUSES.has(status)) {
          if (outcomes.red.length === 0) passedSuites += 1;
        } else {
          // Terminal but unrecognised (unknown / not_found / timed_out / …):
          // fail closed, never count it as a passed suite.
          unrecognised.push(`${suiteId} ("${status || "empty"}")`);
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

    // Build the trailing "(… still pending; … skipped)" note once.
    const extras: string[] = [];
    if (pending.length) extras.push(`${pending.length} suite(s) still pending`);
    if (skippedTotal) extras.push(`${skippedTotal} test(s) skipped`);
    const suffix = extras.length ? ` (${extras.join("; ")})` : "";

    if (red.length > 0 || unrecognised.length > 0) {
      const parts: string[] = [];
      if (red.length > 0) {
        parts.push(
          `${red.length} ATF test(s) failed: ${describeRedTests(red)}`,
        );
      }
      if (unrecognised.length > 0) {
        parts.push(
          `${unrecognised.length} suite(s) returned an unrecognized status: ${unrecognised.join(
            ", ",
          )}`,
        );
      }
      return makeResult("fail", `${parts.join("; ")}${suffix}`);
    }

    if (pending.length > 0) {
      const skipNote = skippedTotal ? ` (${skippedTotal} test(s) skipped)` : "";
      return makeResult(
        "warn",
        `ATF run still pending for ${pending.length} of ${suiteIds.length} suite(s); re-run once it settles.${skipNote}`,
      );
    }

    if (skippedTotal > 0) {
      return makeResult(
        "warn",
        `No ATF tests failed, but ${skippedTotal} test(s) were skipped across ${passedSuites} suite(s) — skipped tests assert nothing; review why they were skipped.`,
      );
    }

    return makeResult(
      "pass",
      `All ATF tests passed across ${passedSuites} suite(s).`,
    );
  },
};
