/**
 * The versioned JSON envelope `--format json` prints: one self-describing
 * shape for single-instance and `--all` runs. Its JSON Schema
 * (`schemas/report.v1.json`) is generated from these declarations by
 * `scripts/gen-schema.mjs`.
 */
import type { RunTimings } from "../trace.js";
import type { PreflightReport } from "../types.js";

/** The envelope's format version; bumped only on a breaking shape change. */
export const REPORT_SCHEMA_VERSION = 1;

/** One instance's run inside the envelope. */
export interface ReportRun {
  /** Registry instance name (`dev`…); absent for an ad-hoc `--instance` run. */
  instance?: string;
  /** The instance origin (`https://host`), without credentials or a path. */
  url?: string;
  report: PreflightReport;
  /** Per-check request and timing counts; present only under `--timings`. */
  timings?: RunTimings;
}

/** The top-level JSON report document. */
export interface ReportEnvelope {
  schemaVersion: 1;
  tool: {
    name: "servicenow-preflight";
    version: string;
  };
  /** ISO 8601 timestamp of when the envelope was built. */
  generatedAt: string;
  /** `true` when every run's report is ok. */
  ok: boolean;
  runs: ReportRun[];
}

/** Options for {@link toEnvelope}. */
export interface EnvelopeOptions {
  /** The tool version recorded in `tool.version`. */
  version: string;
  /** Clock override (tests); defaults to now. */
  now?: Date;
}

/**
 * The origin of `url`, or `undefined` when it does not parse. Only the origin
 * is kept, so userinfo, a path or a query never reach the report.
 */
export function reportUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Wrap one or more instance reports in the versioned envelope. */
export function toEnvelope(
  runs: readonly ReportRun[],
  opts: EnvelopeOptions,
): ReportEnvelope {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "servicenow-preflight", version: opts.version },
    generatedAt: (opts.now ?? new Date()).toISOString(),
    ok: runs.every((r) => r.report.ok),
    runs: runs.map((r) => {
      const url = reportUrl(r.url);
      return {
        ...(r.instance !== undefined ? { instance: r.instance } : {}),
        ...(url !== undefined ? { url } : {}),
        report: r.report,
        ...(r.timings !== undefined ? { timings: r.timings } : {}),
      };
    }),
  };
}

/** Serialise an envelope as pretty JSON plus a trailing newline. */
export function formatJson(envelope: ReportEnvelope): string {
  return `${JSON.stringify(envelope, null, 2)}\n`;
}
