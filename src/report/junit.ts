import type { CheckResult, PreflightReport } from "../types.js";

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

/** Render a single {@link CheckResult} as a `<testcase>` element. */
function renderTestcase(result: CheckResult): string {
  const name = escapeXml(result.name);
  const message = escapeXml(result.message);

  switch (result.status) {
    case "fail":
      return (
        `    <testcase name="${name}" classname="servicenow-preflight">\n` +
        `      <failure message="${message}">${message}</failure>\n` +
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
    default:
      return `    <testcase name="${name}" classname="servicenow-preflight" />`;
  }
}

/**
 * Number of failing testcases in a report. Derived from `results` (the source
 * of truth the testcases themselves are rendered from), not `summary.fail`, so
 * the `failures=` attribute can never disagree with the `<failure>` elements
 * actually emitted even if a caller hands in a report whose summary is stale.
 */
function countFailures(report: PreflightReport): number {
  return report.results.filter((r) => r.status === "fail").length;
}

/** Render one `<testsuite>` (name + testcases) for a report. */
function renderSuite(name: string, report: PreflightReport): string {
  const results = report.results;
  const tests = results.length;
  const failures = countFailures(report);
  const testcases = results.map(renderTestcase).join("\n");
  const body = testcases.length > 0 ? `\n${testcases}\n` : "";
  return (
    `  <testsuite name="${escapeXml(name)}" tests="${tests}" failures="${failures}">` +
    `${body}` +
    `  </testsuite>`
  );
}

/** Wrap one or more rendered `<testsuite>` blocks in a `<testsuites>` document. */
function wrapSuites(suites: string, tests: number, failures: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites tests="${tests}" failures="${failures}">\n` +
    `${suites}\n` +
    `</testsuites>\n`
  );
}

/**
 * Format a {@link PreflightReport} as a JUnit XML string (for CI test-report
 * ingestion).
 *
 * Each {@link CheckResult} becomes one `<testcase>`. Status mapping:
 * - `fail` -> `<testcase>` carrying a `<failure>` (counts toward `failures`).
 * - `warn` -> passing `<testcase>` with the note in `<system-out>`.
 * - `pass` -> plain, empty `<testcase>`.
 *
 * The single `<testsuite>` reports `tests` (total) and `failures` counts.
 */
export function formatJUnit(report: PreflightReport): string {
  const tests = report.results.length;
  const failures = countFailures(report);
  return wrapSuites(
    renderSuite("servicenow-preflight", report),
    tests,
    failures,
  );
}

/** One instance's report, tagged with the instance name (for `--all`). */
export interface NamedReport {
  name: string;
  report: PreflightReport;
}

/**
 * Format several instance reports as ONE JUnit document: a single
 * `<testsuites>` with one `<testsuite>` per instance (named after it). The
 * document-level `tests` / `failures` are the sums across every suite. Used by
 * the CLI's `--all --format junit`, so CI ingesters see a single well-formed
 * report rather than concatenated documents.
 */
export function formatJUnitSuites(reports: NamedReport[]): string {
  const suites = reports.map((r) => renderSuite(r.name, r.report)).join("\n");
  const tests = reports.reduce((n, r) => n + r.report.results.length, 0);
  const failures = reports.reduce((n, r) => n + countFailures(r.report), 0);
  return wrapSuites(suites, tests, failures);
}
