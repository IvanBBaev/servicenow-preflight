import type { CheckResult } from "../types.js";
import type { StateManifest, AtfTestState } from "./manifest.js";

/**
 * Test drift between two instances — the payoff of committing manifests. Two
 * instances are compared by **logical `id`** (stable across instances), so a
 * test green on `staging` but absent on `prod` is caught *before* the promote.
 *
 * Direction matters: `source` is the upstream instance (what has been validated,
 * e.g. `staging`), `target` is where we are about to promote (e.g. `prod`).
 * A test that is **active on the source but missing on the target** blocks the
 * promote. A test present only on the target is surfaced as informational drift.
 */

/** One test involved in a drift, distilled to what a report shows. */
export interface DriftEntry {
  /** Logical `id` (`scope/slug`). */
  id: string;
  /** Human-readable test name. */
  name: string;
}

/** The outcome of comparing two manifests. */
export interface DriftReport {
  /** Source instance name. */
  source: string;
  /** Target instance name. */
  target: string;
  /**
   * Tests active on the source but absent on the target — these **block** a
   * promote (the target is missing validated coverage).
   */
  missingOnTarget: DriftEntry[];
  /**
   * Tests present on the target but absent on the source — informational: the
   * target carries coverage the source does not.
   */
  extraOnTarget: DriftEntry[];
  /** Count of active tests considered on the source. */
  sourceActiveCount: number;
  /** Count of active tests considered on the target. */
  targetCount: number;
  /** `true` when nothing blocks a promote (`missingOnTarget` is empty). */
  ok: boolean;
}

/** Index a manifest's tests by logical `id`. */
function byId(tests: AtfTestState[]): Map<string, AtfTestState> {
  const map = new Map<string, AtfTestState>();
  for (const t of tests) map.set(t.id, t);
  return map;
}

/** A test counts as "present" for drift when it exists and is not inactive. */
function isActive(test: AtfTestState): boolean {
  return test.active !== false;
}

/**
 * Compare two manifests by logical `id` and report the drift. Only **active**
 * source tests can block a promote — an intentionally deactivated test missing
 * downstream is not a regression.
 */
export function computeDrift(
  source: StateManifest,
  target: StateManifest,
): DriftReport {
  const sourceTests = source.tests.filter(isActive);
  // Apply the same active filter to the TARGET (CC-3): a test deactivated on the
  // target is *absent* for drift purposes, so an active source test whose only
  // target counterpart is inactive must be reported as missing — not silently
  // matched against a dead row. The source index stays UNFILTERED so an
  // inactive-on-source test that still exists on the target is not mis-reported
  // as extra (it is present on the source, just not blocking).
  const targetTests = target.tests.filter(isActive);
  const targetIndex = byId(targetTests);
  const sourceIndex = byId(source.tests);

  const missingOnTarget: DriftEntry[] = [];
  for (const t of sourceTests) {
    if (!targetIndex.has(t.id)) {
      missingOnTarget.push({ id: t.id, name: t.name });
    }
  }

  const extraOnTarget: DriftEntry[] = [];
  for (const t of targetTests) {
    if (!sourceIndex.has(t.id)) {
      extraOnTarget.push({ id: t.id, name: t.name });
    }
  }

  const sort = (a: DriftEntry, b: DriftEntry): number =>
    a.id.localeCompare(b.id);
  missingOnTarget.sort(sort);
  extraOnTarget.sort(sort);

  return {
    source: source.instance,
    target: target.instance,
    missingOnTarget,
    extraOnTarget,
    sourceActiveCount: sourceTests.length,
    targetCount: targetTests.length,
    ok: missingOnTarget.length === 0,
  };
}

/** Check name used for the manifest-freshness results a drift run may emit. */
export const FRESHNESS_CHECK = "manifest-freshness";

/** Default age past which a compared manifest is flagged stale (30 days). */
export const DEFAULT_STALE_WARN_MS = 30 * 24 * 60 * 60 * 1000;

/** A compared manifest tagged with its role in the drift (for messages). */
export interface DriftManifestRef {
  /** Which side of the promote this manifest is — `source` or `target`. */
  role: string;
  manifest: StateManifest;
}

/** Thresholds for {@link stalenessResults}. */
export interface StalenessOptions {
  /** Reference time (defaults to `Date.now()`). */
  now?: number;
  /** Age past which a manifest yields a `warn` (default 30 days). */
  warnAfterMs?: number;
  /**
   * Age past which a manifest yields a `fail` (from the CLI's `--max-age`).
   * Unset means no hard age gate — only the soft `warn` applies.
   */
  maxAgeMs?: number;
}

/** Render a millisecond age as a compact human string (e.g. `45d`, `3h`). */
function formatAge(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const units: [number, string][] = [
    [86400, "d"],
    [3600, "h"],
    [60, "m"],
    [1, "s"],
  ];
  for (const [size, label] of units) {
    if (sec >= size) return `${Math.floor(sec / size)}${label}`;
  }
  return "0s";
}

/**
 * Evaluate the freshness of the manifests a drift compares. A manifest older
 * than `warnAfterMs` yields a `warn`; with `maxAgeMs` set (the CLI's
 * `--max-age`), one older than that yields a `fail` (a hard promote block).
 *
 * A manifest with no usable `syncedAt` is only surfaced under `--max-age`, and
 * then fails closed: freshness that cannot be proven must not pass an explicit
 * age gate. Returns one {@link CheckResult} per flagged manifest (empty when all
 * are fresh), for the CLI to fold into the drift report.
 */
export function stalenessResults(
  refs: DriftManifestRef[],
  opts: StalenessOptions = {},
): CheckResult[] {
  const now = opts.now ?? Date.now();
  const warnAfterMs = opts.warnAfterMs ?? DEFAULT_STALE_WARN_MS;
  const { maxAgeMs } = opts;
  const out: CheckResult[] = [];
  for (const { role, manifest } of refs) {
    const label = `${role} "${manifest.instance}"`;
    const synced = manifest.syncedAt ? Date.parse(manifest.syncedAt) : NaN;
    if (Number.isNaN(synced)) {
      if (maxAgeMs !== undefined) {
        out.push({
          name: FRESHNESS_CHECK,
          status: "fail",
          message: `Manifest for ${label} has no recorded syncedAt; cannot verify it is within --max-age. Re-run sync.`,
        });
      }
      continue;
    }
    const ageMs = Math.max(0, now - synced);
    if (maxAgeMs !== undefined && ageMs > maxAgeMs) {
      out.push({
        name: FRESHNESS_CHECK,
        status: "fail",
        message: `Manifest for ${label} was synced ${formatAge(ageMs)} ago, exceeding --max-age (${formatAge(maxAgeMs)}). Re-run sync before promoting.`,
      });
    } else if (ageMs > warnAfterMs) {
      out.push({
        name: FRESHNESS_CHECK,
        status: "warn",
        message: `Manifest for ${label} was synced ${formatAge(ageMs)} ago (older than ${formatAge(warnAfterMs)}); consider re-running sync.`,
      });
    }
  }
  return out;
}
