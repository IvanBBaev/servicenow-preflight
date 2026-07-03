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
  /** Count of tests on the target. */
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
  const targetIndex = byId(target.tests);
  const sourceIndex = byId(source.tests);

  const missingOnTarget: DriftEntry[] = [];
  for (const t of sourceTests) {
    if (!targetIndex.has(t.id)) {
      missingOnTarget.push({ id: t.id, name: t.name });
    }
  }

  const extraOnTarget: DriftEntry[] = [];
  for (const t of target.tests) {
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
    targetCount: target.tests.length,
    ok: missingOnTarget.length === 0,
  };
}
