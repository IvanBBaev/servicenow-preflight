import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { UsageError, type FailOn } from "./config.js";
import { PREFLIGHT_DIR } from "./registry.js";
import type { CheckResult, CheckStatus, PreflightReport } from "./types.js";

/**
 * Baseline (accepted findings).
 *
 * A baseline file records the non-pass results a team has accepted — typically
 * the pre-existing findings of a brownfield app on the day the gate is adopted.
 * {@link applyBaseline} turns a matching `fail` into a `warn` so the run passes,
 * while any finding that is not in the baseline (a new regression) still fails.
 *
 * Results carry no per-finding identity, so an entry matches a result by check
 * name and status. The stored message is the change detector: when the result's
 * message differs from the recorded one, the row is still demoted but its
 * message says `Baselined but CHANGED since …`, so a reviewer sees that the
 * finding moved (for example a new table joined the list). That is the only
 * defence against a baseline silently hiding new findings.
 */

/** One accepted finding. */
export interface BaselineEntry {
  /** The check name the entry applies to. */
  check: string;
  /** The status the finding was recorded with. */
  status: Exclude<CheckStatus, "pass">;
  /** The result message at the time the finding was accepted. */
  message: string;
  /** Why the finding is accepted (a ticket, a justification). */
  reason?: string;
  /**
   * ISO date (`2027-01-31`) or timestamp after which the entry no longer
   * applies. A date-only value is valid through the end of that day (UTC).
   */
  expires?: string;
}

/** The baseline file (`.preflight/baseline.json`). */
export interface Baseline {
  version: 1;
  /** When the baseline was written (ISO timestamp). */
  generatedAt: string;
  /** The registry instance the baseline was recorded against, if any. */
  instance?: string;
  entries: BaselineEntry[];
}

/** Name of the synthetic row appended for an expired baseline entry. */
export const BASELINE_ROW = "baseline";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/;
const DAY_MS = 86_400_000;

/**
 * Default baseline location under `cwd`: `.preflight/baseline.json`, or
 * `.preflight/baseline.<instance>.json` for a registry instance.
 */
export function baselinePath(cwd: string, instance?: string): string {
  const file = instance ? `baseline.${instance}.json` : "baseline.json";
  return resolve(cwd, PREFLIGHT_DIR, file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validEntry(raw: unknown, index: number, path: string): BaselineEntry {
  const fail = (what: string): never => {
    throw new UsageError(`Baseline ${path}: entries[${index}] ${what}.`);
  };
  if (!isRecord(raw)) return fail("must be an object");
  const { check, status, message, reason, expires } = raw;
  if (typeof check !== "string" || check.length === 0) {
    fail('needs a non-empty "check" string');
  }
  if (status !== "fail" && status !== "warn") {
    fail('needs "status" "fail" or "warn"');
  }
  if (typeof message !== "string") fail('needs a "message" string');
  if (reason !== undefined && typeof reason !== "string") {
    fail('has a non-string "reason"');
  }
  if (
    expires !== undefined &&
    (typeof expires !== "string" ||
      !ISO_DATE.test(expires) ||
      Number.isNaN(Date.parse(expires)))
  ) {
    fail('has an "expires" that is not an ISO date (e.g. 2027-01-31)');
  }
  return {
    check: check as string,
    status: status as BaselineEntry["status"],
    message: message as string,
    ...(reason !== undefined ? { reason: reason as string } : {}),
    ...(expires !== undefined ? { expires: expires as string } : {}),
  };
}

/**
 * Read and validate a baseline file. A missing file, invalid JSON or a shape
 * error throws {@link UsageError} (CLI exit 2) naming the path and, for an
 * entry, its index.
 */
export function readBaseline(path: string): Baseline {
  if (!existsSync(path)) {
    throw new UsageError(`Baseline file not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new UsageError(`Baseline ${path} is not valid JSON: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new UsageError(`Baseline ${path} must be a JSON object.`);
  }
  if (parsed.version !== 1) {
    throw new UsageError(`Baseline ${path} needs "version": 1.`);
  }
  if (typeof parsed.generatedAt !== "string") {
    throw new UsageError(`Baseline ${path} needs a "generatedAt" string.`);
  }
  if (parsed.instance !== undefined && typeof parsed.instance !== "string") {
    throw new UsageError(`Baseline ${path} has a non-string "instance".`);
  }
  if (!Array.isArray(parsed.entries)) {
    throw new UsageError(`Baseline ${path} needs an "entries" array.`);
  }
  const entries = parsed.entries.map((e: unknown, i) => validEntry(e, i, path));
  return {
    version: 1,
    generatedAt: parsed.generatedAt,
    ...(parsed.instance !== undefined ? { instance: parsed.instance } : {}),
    entries,
  };
}

/**
 * Write a baseline file (pretty JSON), creating its directory. Refuses to
 * overwrite an existing file unless `force` is set.
 */
export function writeBaseline(
  path: string,
  b: Baseline,
  opts: { force?: boolean } = {},
): void {
  if (existsSync(path) && !opts.force) {
    throw new UsageError(
      `Baseline file ${path} already exists; pass --force to overwrite it.`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(b, null, 2)}\n`, "utf8");
}

/** Build a baseline from every non-pass result of a report. */
export function baselineFromReport(
  report: PreflightReport,
  instance: string | undefined,
  now: Date,
): Baseline {
  const entries: BaselineEntry[] = [];
  for (const r of report.results) {
    if (r.status === "pass") continue;
    entries.push({
      check: r.name,
      status: r.status,
      message: r.message,
      reason: "",
    });
  }
  return {
    version: 1,
    generatedAt: now.toISOString(),
    ...(instance !== undefined ? { instance } : {}),
    entries,
  };
}

/** Whether an entry's `expires` lies in the past at `now`. */
function isExpired(entry: BaselineEntry, now: Date): boolean {
  if (entry.expires === undefined) return false;
  let end = Date.parse(entry.expires);
  if (DATE_ONLY.test(entry.expires)) end += DAY_MS;
  return now.getTime() >= end;
}

/** Recompute a report's summary and `ok` from its results. */
export function summarize(results: CheckResult[]): PreflightReport {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const r of results) summary[r.status] += 1;
  return { ok: summary.fail === 0, results, summary };
}

/** The message prefix {@link applyBaseline} gives a row a baseline accepted. */
const BASELINED = "Baselined";

/**
 * Apply a baseline to a report (pure). A result matched by an unexpired entry
 * (same check, same status) becomes `warn` with a `Baselined (…)` prefix, or a
 * `Baselined but CHANGED since …` prefix when its message differs from the
 * recorded one. An expired entry is ignored and adds a `warn` row named
 * {@link BASELINE_ROW}. Entries matching no result are ignored (the check may
 * be skipped this run). Summary and `ok` are recomputed.
 */
export function applyBaseline(
  report: PreflightReport,
  b: Baseline,
  now: Date,
): PreflightReport {
  const live = b.entries.filter((e) => !isExpired(e, now));
  const results: CheckResult[] = report.results.map((r) => {
    if (r.status === "pass") return r;
    const entry = live.find((e) => e.check === r.name && e.status === r.status);
    if (!entry) return r;
    const prefix =
      entry.message === r.message
        ? `${BASELINED} (${entry.reason || "accepted"} until ${
            entry.expires ?? "revoked"
          })`
        : `${BASELINED} but CHANGED since ${b.generatedAt}`;
    return { ...r, status: "warn", message: `${prefix}: ${r.message}` };
  });
  for (const e of b.entries) {
    if (!isExpired(e, now)) continue;
    results.push({
      name: BASELINE_ROW,
      status: "warn",
      kind: "baseline",
      message: `Baseline entry for ${e.check} expired on ${String(
        e.expires,
      )}; the finding fails again next run if still present.`,
    });
  }
  return summarize(results);
}

/** Whether a row came from {@link applyBaseline}: an accepted finding or an expiry note. */
function isBaselined(r: CheckResult): boolean {
  return (
    r.kind === "baseline" ||
    (r.status === "warn" && r.message.startsWith(`${BASELINED} `))
  );
}

/**
 * Apply the run-level `--fail-on` threshold (F-X-17, pure). With `"warn"`, a
 * `warn` row that no baseline accepted makes the report not ok; rows and the
 * summary are unchanged, so the report stays truthful. `"fail"` is a no-op.
 */
export function applyFailOn(
  report: PreflightReport,
  failOn: FailOn,
): PreflightReport {
  if (failOn !== "warn" || !report.ok) return report;
  const warned = report.results.some(
    (r) => r.status === "warn" && !isBaselined(r),
  );
  return warned ? { ...report, ok: false } : report;
}
