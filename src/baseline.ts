import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { UsageError, type FailOn } from "./config.js";
import { PREFLIGHT_DIR } from "./registry.js";
import type { CheckResult, CheckStatus, PreflightReport } from "./types.js";
import { summarizeResults } from "./summary.js";

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
 * message differs from the recorded one, the finding moved (for example a new
 * table joined the list), so the row keeps its status and its message says
 * `Baseline does not match (changed since …)`. A baselined check therefore
 * still gates every regression in it until the baseline is re-recorded.
 *
 * An `error` row (a read failed, so the check verified nothing) is never
 * recorded and never demoted: accepting a finding must not also accept a
 * revoked credential or an unreachable table. The same holds for a row the
 * runner produced (`kind: "runner"`: no check matched, a check timed out,
 * was aborted, threw or returned something malformed) and for a row under a
 * reserved name (`preflight`, `preflight:*`, `baseline`): none is a finding
 * (CLI-2).
 */

/** One accepted finding. */
export interface BaselineEntry {
  /** The check name the entry applies to. */
  check: string;
  /** The status the finding was recorded with. */
  status: Exclude<CheckStatus, "pass" | "error">;
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
  /**
   * The instance origin (`https://dev12345.service-now.com`) the baseline was
   * recorded against, if known. A baseline applied to another instance or
   * origin is refused (RR-50), so a dev baseline cannot waive prod findings.
   */
  url?: string;
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

/**
 * Whether a row is a check's own finding a baseline may record or accept:
 * not a runner or baseline row and not under a reserved name.
 */
function isAcceptable(r: CheckResult): boolean {
  if (r.kind === "runner" || r.kind === "baseline") return false;
  return !(
    r.name === "preflight" ||
    r.name.startsWith("preflight:") ||
    r.name === BASELINE_ROW
  );
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
  if (parsed.url !== undefined && typeof parsed.url !== "string") {
    throw new UsageError(`Baseline ${path} has a non-string "url".`);
  }
  if (!Array.isArray(parsed.entries)) {
    throw new UsageError(`Baseline ${path} needs an "entries" array.`);
  }
  const entries = parsed.entries.map((e: unknown, i) => validEntry(e, i, path));
  return {
    version: 1,
    generatedAt: parsed.generatedAt,
    ...(parsed.instance !== undefined ? { instance: parsed.instance } : {}),
    ...(parsed.url !== undefined ? { url: parsed.url } : {}),
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

/** The comparable form of an instance URL: its lower-case origin, else the trimmed input. */
function originOf(url: string): string {
  const trimmed = url.trim();
  try {
    const origin = new URL(trimmed).origin;
    if (origin && origin !== "null") return origin.toLowerCase();
  } catch {
    // Not a URL: compare the raw text.
  }
  return trimmed.toLowerCase();
}

/** The instance a baseline is applied to (see {@link assertBaselineTarget}). */
export interface BaselineTarget {
  /** The registry instance name, if any. */
  instance?: string;
  /** The instance URL, if known. */
  url?: string;
}

/**
 * Refuse a baseline recorded against another instance (RR-50, CLI-6): when
 * both sides name a registry instance and the names differ, or both carry a
 * URL and the origins differ, throw {@link UsageError}. A side without the
 * field (an older baseline, an unnamed target) is not compared.
 */
export function assertBaselineTarget(
  b: Baseline,
  target: BaselineTarget,
  path?: string,
): void {
  const where = path ? `Baseline ${path}` : "The baseline";
  const fix =
    "Use the baseline recorded for this instance, or re-record one with --write-baseline.";
  const name = target.instance?.trim();
  if (b.instance !== undefined && name && b.instance.trim() !== name) {
    throw new UsageError(
      `${where} was recorded for instance "${b.instance}", not "${name}". ${fix}`,
    );
  }
  if (b.url !== undefined && target.url?.trim()) {
    const recorded = originOf(b.url);
    const current = originOf(target.url);
    if (recorded !== current) {
      throw new UsageError(
        `${where} was recorded against ${recorded}, not ${current}. ${fix}`,
      );
    }
  }
}

/**
 * Build a baseline from every `fail` / `warn` result of a report. `error`
 * rows are left out: a failed read is not a finding a team can accept. Runner
 * rows and reserved names are left out too (CLI-2). `url` records the target
 * instance's origin, so the baseline is refused elsewhere (RR-50).
 */
export function baselineFromReport(
  report: PreflightReport,
  instance: string | undefined,
  now: Date,
  url?: string,
): Baseline {
  const entries: BaselineEntry[] = [];
  for (const r of report.results) {
    if (r.status === "pass" || r.status === "error") continue;
    if (!isAcceptable(r)) continue;
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
    ...(url?.trim() ? { url: originOf(url) } : {}),
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

/**
 * Apply a baseline to a report (pure). A result matched by an unexpired entry
 * (same check, same status, same message) becomes `warn` with a
 * `Baselined (…)` prefix and `kind: "baseline"`. When only the message differs
 * the finding changed: the row keeps its status and gets a
 * `Baseline does not match (changed since …)` prefix. An expired entry is ignored and adds a `warn` row named
 * {@link BASELINE_ROW}. Entries matching no result are ignored (the check may
 * be skipped this run). `pass` and `error` rows, runner rows and rows under a
 * reserved name are never touched (CLI-2). Summary and `ok` are recomputed.
 * With `target`, a baseline recorded against another instance throws
 * {@link UsageError} first ({@link assertBaselineTarget}, RR-50).
 */
export function applyBaseline(
  report: PreflightReport,
  b: Baseline,
  now: Date,
  target?: BaselineTarget,
): PreflightReport {
  if (target) assertBaselineTarget(b, target);
  const live = b.entries.filter((e) => !isExpired(e, now));
  const results: CheckResult[] = report.results.map((r) => {
    if (r.status === "pass" || r.status === "error") return r;
    if (!isAcceptable(r)) return r;
    const entry = live.find((e) => e.check === r.name && e.status === r.status);
    if (!entry) return r;
    if (entry.message !== r.message) {
      return {
        ...r,
        message: `Baseline does not match (changed since ${b.generatedAt}): ${r.message}`,
      };
    }
    const prefix = `Baselined (${entry.reason || "accepted"} until ${
      entry.expires ?? "revoked"
    })`;
    return {
      ...r,
      status: "warn",
      kind: "baseline",
      message: `${prefix}: ${r.message}`,
    };
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
  return summarizeResults(results);
}

/** Whether a row came from {@link applyBaseline}: an accepted finding or an expiry note. */
function isBaselined(r: CheckResult): boolean {
  return r.kind === "baseline";
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
