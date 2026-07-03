import type { CheckResult, PreflightReport } from "../types.js";

// Characters XML 1.0 forbids even when numerically escaped: all C0 controls
// except tab (0x09), LF (0x0A) and CR (0x0D). A raw one — easily present in
// ATF/script output folded into a check message — makes the whole document
// unparseable, so we drop them before escaping the entities.
// eslint-disable-next-line no-control-regex
const XML_INVALID_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * Escape the five XML predefined entities (and strip XML-1.0-illegal control
 * characters) so arbitrary check messages and names are safe inside both
 * element text and double-quoted attribute values.
 */
function escapeXml(value: string): string {
  return value
    .replace(XML_INVALID_CHARS, "")
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
  const results = report.results;
  const tests = results.length;
  const failures = report.summary.fail;

  const testcases = results.map(renderTestcase).join("\n");
  const body = testcases.length > 0 ? `\n${testcases}\n` : "";

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites tests="${tests}" failures="${failures}">\n` +
    `  <testsuite name="servicenow-preflight" tests="${tests}" failures="${failures}">` +
    `${body}` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}
