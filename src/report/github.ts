import type { CheckResult, PreflightReport } from "../types.js";
import { errorTail } from "../summary.js";
import { optionsFor, type NamedReport } from "./junit.js";
import {
  messageOf,
  renderedStatus,
  type ReportFormatOptions,
} from "./verdict.js";

/**
 * Escape a workflow-command message (the text after `::`). Mirrors
 * `escapeData` in `@actions/core`: `%` first, so the encodings it introduces
 * are not themselves re-encoded.
 */
function escapeData(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Escape a workflow-command property value (`title=…`). Mirrors
 * `escapeProperty` in `@actions/core`: the message escapes plus `:` and `,`,
 * which would otherwise end the value or start the next property.
 */
function escapeProperty(value: string): string {
  return escapeData(value).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** One annotation line, or `undefined` for a pass (passes are not annotated). */
function annotation(
  result: CheckResult,
  instance: string | undefined,
  opts: ReportFormatOptions | undefined,
): string | undefined {
  const status = renderedStatus(result, opts);
  if (status === "pass") return undefined;
  // `fail`, `error`, an unknown status (the runner counts it as a fail) and a
  // warn that gated the run under `failOn: "warn"` are all annotated as errors.
  const command = status === "warn" ? "warning" : "error";
  const title = instance ? `${result.name} (${instance})` : result.name;
  return `::${command} title=${escapeProperty(title)}::${escapeData(messageOf(result))}`;
}

function annotations(
  report: PreflightReport,
  instance: string | undefined,
  opts: ReportFormatOptions | undefined,
): string[] {
  return report.results
    .map((r) => annotation(r, instance, opts))
    .filter((line): line is string => line !== undefined);
}

/**
 * The totals line. The counts stay the row counts; when the report failed on
 * warnings alone (`failOn: "warn"`), a tail says so, so "0 failed" never
 * reads as a pass next to an exit code of 1 (RR-70, REL-2).
 */
function summaryLine(
  report: PreflightReport,
  opts: ReportFormatOptions | undefined,
): string {
  const { pass, warn, fail } = report.summary;
  const gated =
    opts?.failOn === "warn" &&
    !report.ok &&
    report.results.some(
      (r) => r.status === "warn" && renderedStatus(r, opts) === "fail",
    );
  const tail = gated ? " — failing: --fail-on warn" : "";
  return `${pass} passed, ${warn} warnings, ${fail} failed${errorTail(report.summary)}${tail}`;
}

/**
 * Format a report as GitHub Actions workflow commands: one `::error` (fail,
 * error, unknown status) or `::warning` (warn) line per non-pass result,
 * titled with the check name (and the instance, when given), then the plain
 * summary line so the job log still shows the totals. With
 * `opts.failOn: "warn"` a warn no baseline accepted is an `::error` and the
 * summary line says the run fails on warnings. Only meaningful inside a GitHub
 * job; elsewhere the command lines print verbatim.
 */
export function formatGitHubAnnotations(
  report: PreflightReport,
  instance?: string,
  opts?: ReportFormatOptions,
): string {
  return `${[...annotations(report, instance, opts), summaryLine(report, opts)].join("\n")}\n`;
}

/**
 * Format several instance reports as workflow commands: every instance's
 * annotations (titles carry the instance name), then one `<name>: <summary>`
 * line per instance.
 */
export function formatGitHubAnnotationsAll(
  named: readonly NamedReport[],
  opts?: ReportFormatOptions,
): string {
  const lines = named.flatMap((n) =>
    annotations(n.report, n.name, optionsFor(n, opts)),
  );
  for (const n of named) {
    lines.push(`${n.name}: ${summaryLine(n.report, optionsFor(n, opts))}`);
  }
  return `${lines.join("\n")}\n`;
}
