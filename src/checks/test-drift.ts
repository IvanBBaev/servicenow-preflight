import type { Check, CheckResult } from "../types.js";
import { computeDrift, type DriftEntry } from "../state/drift.js";

const NAME = "test-drift";

function makeResult(
  status: CheckResult["status"],
  message: string,
): CheckResult {
  return { name: NAME, status, message };
}

/** Render up to three drift entries, with a "+N more" tail. */
function describe(entries: DriftEntry[]): string {
  const shown = entries.slice(0, 3).map((e) => e.name || e.id);
  const more =
    entries.length > shown.length
      ? ` (+${entries.length - shown.length} more)`
      : "";
  return `${shown.join("; ")}${more}`;
}

/**
 * Promote-gate check: compares the current instance's manifest (`ctx.manifest`,
 * the source of truth for what should exist) against the promote **target**
 * (`ctx.driftTarget`) by logical `id`.
 *
 * - `fail` — a test active on the source is absent on the target (a promote
 *   would ship without validated coverage).
 * - `warn` — no manifests to compare (single-instance run), or the target only
 *   carries extra tests the source lacks (informational, not a regression).
 * - `pass` — every active source test exists on the target.
 *
 * Never throws — it is a pure comparison of two already-loaded manifests.
 */
export const testDrift: Check = {
  name: NAME,
  description:
    "Every test on the current instance also exists on the promote target.",
  run(ctx): CheckResult {
    const source = ctx.manifest;
    const target = ctx.driftTarget;
    if (!source || !target) {
      return makeResult(
        "warn",
        "No source/target manifest to compare (set ctx.manifest and ctx.driftTarget, or use `snpf drift`); skipping.",
      );
    }

    const drift = computeDrift(source, target);

    if (drift.missingOnTarget.length > 0) {
      return makeResult(
        "fail",
        `${drift.missingOnTarget.length} test(s) present on "${drift.source}" are missing on "${drift.target}": ${describe(
          drift.missingOnTarget,
        )}.`,
      );
    }

    if (drift.extraOnTarget.length > 0) {
      return makeResult(
        "warn",
        `"${drift.target}" carries ${drift.extraOnTarget.length} test(s) not on "${drift.source}": ${describe(
          drift.extraOnTarget,
        )}.`,
      );
    }

    return makeResult(
      "pass",
      `No test drift: all ${drift.sourceActiveCount} active test(s) on "${drift.source}" exist on "${drift.target}".`,
    );
  },
};
