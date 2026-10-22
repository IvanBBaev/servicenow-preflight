import type { CheckResult, PreflightReport } from "../types.js";
import type { NamedReport } from "./junit.js";

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
): string | undefined {
  if (result.status === "pass") return undefined;
  // An unknown status is annotated as an error: the runner counts it as a fail.
  const command = result.status === "warn" ? "warning" : "error";
  const title = instance ? `${result.name} (${instance})` : result.name;
  return `::${command} title=${escapeProperty(title)}::${escapeData(result.message)}`;
}

function annotations(report: PreflightReport, instance?: string): string[] {
  return report.results
    .map((r) => annotation(r, instance))
    .filter((line): line is string => line !== undefined);
}

function summaryLine(report: PreflightReport): string {
  const { pass, warn, fail } = report.summary;
  return `${pass} passed, ${warn} warnings, ${fail} failed`;
}

/**
 * Format a report as GitHub Actions workflow commands: one `::error` (fail) or
 * `::warning` (warn) line per non-pass result, titled with the check name (and
 * the instance, when given), then the plain summary line so the job log still
 * shows the totals. Only meaningful inside a GitHub job; elsewhere the command
 * lines print verbatim.
 */
export function formatGitHubAnnotations(
  report: PreflightReport,
  instance?: string,
): string {
  return `${[...annotations(report, instance), summaryLine(report)].join("\n")}\n`;
}

/**
 * Format several instance reports as workflow commands: every instance's
 * annotations (titles carry the instance name), then one `<name>: <summary>`
 * line per instance.
 */
export function formatGitHubAnnotationsAll(
  named: readonly NamedReport[],
): string {
  const lines = named.flatMap((n) => annotations(n.report, n.name));
  for (const n of named) lines.push(`${n.name}: ${summaryLine(n.report)}`);
  return `${lines.join("\n")}\n`;
}
