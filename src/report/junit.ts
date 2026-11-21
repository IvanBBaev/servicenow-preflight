import type { FailOn } from "../config.js";
import type { CheckResult, PreflightReport } from "../types.js";
import {
  messageOf,
  renderedStatus,
  type ReportFormatOptions,
} from "./verdict.js";

// Characters XML 1.0 forbids even when numerically escaped: all C0 controls
// except tab (0x09), LF (0x0A) and CR (0x0D). A raw one — easily present in
// ATF/script output folded into a check message — makes the whole document
// unparseable, so we drop them before escaping the entities.
// eslint-disable-next-line no-control-regex
const XML_INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

// The rest of what XML 1.0's Char production excludes, and for the same reason:
// the two BMP noncharacters, plus any unpaired surrogate. A surrogate encodes a
// character only as a high+low pair, so a lone one cannot be serialised as UTF-8
// at all — truncating a message mid-astral-character is the usual way one shows
// up. Valid pairs match neither alternative and survive: they are legal XML.
const XML_INVALID_UNICODE =
  /[\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Escape the five XML predefined entities (and strip the characters XML 1.0
 * does not permit at all) so arbitrary check messages and names are safe inside
 * both element text and double-quoted attribute values.
 */
function escapeXml(value: string): string {
  return value
    .replace(XML_INVALID_CHARS, "")
    .replace(XML_INVALID_UNICODE, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Render a single {@link CheckResult} as a `<testcase>` element. The element
 * follows {@link renderedStatus}: an unknown status and a warn that gated the
 * run under `failOn: "warn"` carry a `<failure>`, like a fail (RR-70).
 */
function renderTestcase(
  result: CheckResult,
  opts: ReportFormatOptions | undefined,
): string {
  const name = escapeXml(result.name);
  const message = escapeXml(messageOf(result));

  switch (renderedStatus(result, opts)) {
    case "fail":
      return (
        `    <testcase name="${name}" classname="servicenow-preflight">\n` +
        `      <failure message="${message}">${message}</failure>\n` +
        `    </testcase>`
      );
    case "error":
      // A read that failed verified nothing: JUnit's `<error>` (the test could
      // not run), kept apart from a `<failure>` (the test ran and found a gap).
      return (
        `    <testcase name="${name}" classname="servicenow-preflight">\n` +
        `      <error message="${message}">${message}</error>\n` +
        `    </testcase>`
      );
    case "warn":
      // A warning is a pass-with-note: the testcase is not a failure, but the
      // note is surfaced on stdout so CI shows it.
      return (
        `    <testcase name="${name}" classname="servicenow-preflight">\n` +
        `      <system-out>${message}</system-out>\n` +
        `    </testcase>`
      );
    case "pass":
      return `    <testcase name="${name}" classname="servicenow-preflight" />`;
  }
}

/**
 * Number of failing testcases in a report. Derived from `results` (the source
 * of truth the testcases themselves are rendered from), not `summary.fail`, so
 * the `failures=` attribute can never disagree with the `<failure>` elements
 * actually emitted even if a caller hands in a report whose summary is stale.
 */
function countFailures(
  report: PreflightReport,
  opts: ReportFormatOptions | undefined,
): number {
  return report.results.filter((r) => renderedStatus(r, opts) === "fail")
    .length;
}

/** Number of `error` testcases, derived from `results` like {@link countFailures}. */
function countErrors(report: PreflightReport): number {
  return report.results.filter((r) => r.status === "error").length;
}

/** Render one `<testsuite>` (name + testcases) for a report. */
function renderSuite(
  name: string,
  report: PreflightReport,
  opts: ReportFormatOptions | undefined,
): string {
  const results = report.results;
  const tests = results.length;
  const failures = countFailures(report, opts);
  const errors = countErrors(report);
  const testcases = results.map((r) => renderTestcase(r, opts)).join("\n");
  const body = testcases.length > 0 ? `\n${testcases}\n` : "";
  return (
    `  <testsuite name="${escapeXml(name)}" tests="${tests}" failures="${failures}" errors="${errors}">` +
    `${body}` +
    `  </testsuite>`
  );
}

/** Wrap one or more rendered `<testsuite>` blocks in a `<testsuites>` document. */
function wrapSuites(
  suites: string,
  tests: number,
  failures: number,
  errors: number,
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites tests="${tests}" failures="${failures}" errors="${errors}">\n` +
    `${suites}\n` +
    `</testsuites>\n`
  );
}

/**
 * Format a {@link PreflightReport} as a JUnit XML string (for CI test-report
 * ingestion).
 *
 * Each {@link CheckResult} becomes one `<testcase>`. Status mapping:
 * - `fail` and an unknown status -> `<testcase>` carrying a `<failure>`
 *   (counts toward `failures`).
 * - `error` -> `<testcase>` carrying an `<error>` (counts toward `errors`).
 * - `warn` -> passing `<testcase>` with the note in `<system-out>`; with
 *   `opts.failOn: "warn"` a warn no baseline accepted carries a `<failure>`
 *   instead, so the document agrees with the exit code.
 * - `pass` -> plain, empty `<testcase>`.
 *
 * The single `<testsuite>` reports `tests` (total), `failures` and `errors`.
 */
export function formatJUnit(
  report: PreflightReport,
  opts?: ReportFormatOptions,
): string {
  const tests = report.results.length;
  return wrapSuites(
    renderSuite("servicenow-preflight", report, opts),
    tests,
    countFailures(report, opts),
    countErrors(report),
  );
}

/** One instance's report, tagged with the instance name (for `--all`). */
export interface NamedReport {
  name: string;
  report: PreflightReport;
  /**
   * This instance's `--fail-on` threshold, when it differs per instance;
   * overrides the reporter's `opts.failOn` for this report (RR-70).
   */
  failOn?: FailOn;
}

/** The reporter options for one named report: its own `failOn` wins. */
export function optionsFor(
  named: NamedReport,
  opts: ReportFormatOptions | undefined,
): ReportFormatOptions | undefined {
  return named.failOn !== undefined ? { ...opts, failOn: named.failOn } : opts;
}

/**
 * Format several instance reports as ONE JUnit document: a single
 * `<testsuites>` with one `<testsuite>` per instance (named after it). The
 * document-level `tests` / `failures` / `errors` are the sums across every suite. Used by
 * the CLI's `--all --format junit`, so CI ingesters see a single well-formed
 * report rather than concatenated documents.
 */
export function formatJUnitSuites(
  reports: NamedReport[],
  opts?: ReportFormatOptions,
): string {
  const suites = reports
    .map((r) => renderSuite(r.name, r.report, optionsFor(r, opts)))
    .join("\n");
  const tests = reports.reduce((n, r) => n + r.report.results.length, 0);
  const failures = reports.reduce(
    (n, r) => n + countFailures(r.report, optionsFor(r, opts)),
    0,
  );
  const errors = reports.reduce((n, r) => n + countErrors(r.report), 0);
  return wrapSuites(suites, tests, failures, errors);
}
