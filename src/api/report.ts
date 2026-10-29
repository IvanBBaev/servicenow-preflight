/**
 * `servicenow-preflight/report` — report envelope and output formats (JSON,
 * JUnit, SARIF, Markdown, GitHub annotations), the findings baseline, and run
 * tracing / timings.
 *
 * @packageDocumentation
 */
export {
  REPORT_SCHEMA_VERSION,
  toEnvelope,
  formatJson,
} from "../report/json.js";
export type {
  EnvelopeOptions,
  ReportEnvelope,
  ReportRun,
} from "../report/json.js";
export {
  formatJUnit,
  formatJUnitSuites,
  type NamedReport,
} from "../report/junit.js";
export { formatSarif } from "../report/sarif.js";
export {
  formatMarkdown,
  formatMarkdownAll,
  type MarkdownOptions,
} from "../report/markdown.js";
export {
  formatGitHubAnnotations,
  formatGitHubAnnotationsAll,
} from "../report/github.js";
export {
  applyBaseline,
  baselineFromReport,
  baselinePath,
  readBaseline,
  writeBaseline,
  BASELINE_ROW,
  type Baseline,
  type BaselineEntry,
} from "../baseline.js";
export {
  collectTimings,
  createTracer,
  formatTimings,
  TRACE_CHANNELS,
  type CheckTiming,
  type RunTimings,
  type TimingsCollector,
  type Tracer,
  type TraceRunFields,
} from "../trace.js";
