import type { FailOn } from "../config.js";
import type { CheckResult, CheckStatus } from "../types.js";

/** Options every row-level reporter (JUnit, SARIF, GitHub annotations) takes. */
export interface ReportFormatOptions {
  /**
   * The run's `--fail-on` threshold. With `"warn"`, a `warn` row that no
   * baseline accepted decided the exit code, so it renders as a failure
   * (JUnit `<failure>`, SARIF level `error`, `::error`) rather than as a note.
   * Defaults to `"fail"`.
   */
  failOn?: FailOn;
}

/**
 * How a reporter renders one row: `pass`, `warn` or `error` as they are, and
 * `fail` for a fail, for an unknown status (the summary counts one as a
 * failure, RR-70) and for a warn that gated the run under `failOn: "warn"`.
 * The warn test mirrors `applyFailOn`: a baseline row never gates.
 */
export function renderedStatus(
  result: Pick<CheckResult, "status" | "kind">,
  opts?: ReportFormatOptions,
): CheckStatus {
  return statusOf(result.status, result.kind === "baseline", opts);
}

/** {@link renderedStatus} for a bare status (a finding's own verdict). */
export function statusOf(
  status: unknown,
  baselined: boolean,
  opts?: ReportFormatOptions,
): CheckStatus {
  if (status === "pass" || status === "error") return status;
  if (status === "warn") {
    return opts?.failOn === "warn" && !baselined ? "fail" : "warn";
  }
  return "fail";
}

/**
 * A row's message as text. The runner already fails a result without a
 * message string, but a report a library caller builds by hand may lack one;
 * a reporter must still render it rather than throw (RR-70, REL-8).
 */
export function messageOf(value: { message?: unknown }): string {
  const message = value.message;
  if (typeof message === "string") return message;
  if (
    typeof message === "number" ||
    typeof message === "boolean" ||
    typeof message === "bigint"
  ) {
    return String(message);
  }
  if (message === undefined || message === null) return "";
  try {
    return JSON.stringify(message) ?? "";
  } catch {
    return "";
  }
}
