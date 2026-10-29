import type { Check, CheckResult, Finding } from "../types.js";
import {
  computeDrift,
  type DriftEntry,
  type DriftReport,
} from "../state/drift.js";
import { capFindings, makeFinding } from "../findings.js";

const NAME = "test-drift";

function makeResult(
  status: CheckResult["status"],
  message: string,
  findings: Finding[] = [],
): CheckResult {
  const result: CheckResult = { name: NAME, status, message };
  const capped = capFindings(findings);
  if (capped.findings.length > 0) result.findings = capped.findings;
  if (capped.truncated > 0) result.findingsTruncated = capped.truncated;
  return result;
}

/**
 * One finding per drifted test, keyed on its logical `id` (`scope/slug`):
 * missing on the target (`fail`, blocks the promote) first, then extra on
 * the target (`warn`, informational). Both lists are sorted by id, so the
 * order and the ids are independent of manifest ordering.
 */
function driftFindings(drift: DriftReport): Finding[] {
  const label = (e: DriftEntry): string => e.name || e.id;
  return [
    ...drift.missingOnTarget.map((e) =>
      makeFinding(
        NAME,
        "missing-on-target",
        `Test "${label(e)}" is active on "${drift.source}" but missing on "${drift.target}".`,
        { logicalId: e.id },
        "fail",
      ),
    ),
    ...drift.extraOnTarget.map((e) =>
      makeFinding(
        NAME,
        "extra-on-target",
        `Test "${label(e)}" exists on "${drift.target}" but not on "${drift.source}".`,
        { logicalId: e.id },
        "warn",
      ),
    ),
  ];
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
  meta: {
    severity: "blocker",
    tables: [],
    remediation:
      "Promote the missing ATF tests to the target instance (or deactivate them on the source), then run sync on both instances so the state manifests are current.",
    verdicts: {
      pass: "Every active source test exists on the promote target.",
      warn: "No source/target manifest to compare, or the target only carries extra tests.",
      fail: "A test active on the source is absent on the promote target.",
    },
  },
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
    const findings = driftFindings(drift);

    if (drift.missingOnTarget.length > 0) {
      return makeResult(
        "fail",
        `${drift.missingOnTarget.length} test(s) present on "${drift.source}" are missing on "${drift.target}": ${describe(
          drift.missingOnTarget,
        )}.`,
        findings,
      );
    }

    if (drift.extraOnTarget.length > 0) {
      return makeResult(
        "warn",
        `"${drift.target}" carries ${drift.extraOnTarget.length} test(s) not on "${drift.source}": ${describe(
          drift.extraOnTarget,
        )}.`,
        findings,
      );
    }

    return makeResult(
      "pass",
      `No test drift: all ${drift.sourceActiveCount} active test(s) on "${drift.source}" exist on "${drift.target}".`,
    );
  },
};
