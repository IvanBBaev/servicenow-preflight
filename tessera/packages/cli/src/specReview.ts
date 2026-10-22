// The reviewed-body binding in front of `tess run --live` (PA-10 fix 3).
//
// The TM-3 gate (layers 1 and 2) proves a body stays inside an allowlist; it
// cannot prove a human READ that body. DEV-4 makes promotion a human act — an
// entry moves from `.manifest.proposed.json` into `.manifest.json` — but a
// manifest entry names a path, not content, so a later commit could swap the
// file under a promoted entry and the live run would project the new body with
// the runner's authority. The review record closes that gap: `tess review`
// records the SHA-256 of the exact body the named reviewer approved, and the
// live loader refuses any unit spec whose current body does not hash to it.
//
// CANONICAL FORM (one rule, used by both the writer and the checker): the
// lowercase hex SHA-256 of the spec file's text as `readFile(file, "utf8")`
// decodes it, re-encoded as UTF-8 — `sha256Hex` from `@tessera/core`. There is
// deliberately NO normalisation: no newline folding (CRLF stays CRLF), no BOM
// stripping, no trimming, no Unicode normalisation. The string hashed is the
// string the gate inspects and the ATF step executes, so the digest covers
// exactly what runs; any normalisation would make two different executable
// bodies share one review, which is the gap this closes. The cost is that a
// checkout that rewrites line endings invalidates the review — that fails
// closed, and the remedy (re-review) is the safe one.

import { sha256Hex } from "@tessera/core";
import type { SpecReviewRead } from "@tessera/specs";

/** The canonical review digest of a spec body (see the header). */
export function specBodySha256(body: string): string {
  return sha256Hex(body);
}

/** Why a unit spec has no usable review for its current body. */
export type UnreviewedReason = "missing" | "malformed" | "changed";

/** One unit spec `run --live` refuses for want of a matching review. */
export interface UnreviewedSpec {
  readonly id: string;
  /** The inventory path (relative to the tests root). */
  readonly path: string;
  readonly reason: UnreviewedReason;
  /** The current body's digest. */
  readonly currentSha256: string;
  /** For `changed`: what was reviewed, and by whom. */
  readonly recordedSha256?: string;
  readonly reviewer?: string;
  /** For `malformed`: the inventory's description of the record. */
  readonly problem?: string;
}

/**
 * Hold one body to its review record. `undefined` means the record matches;
 * anything else is the refusal reason. A missing and a malformed record are
 * both refusals — a record the reader does not understand is not a review.
 */
export function verifySpecReview(
  spec: { readonly id: string; readonly path: string },
  review: SpecReviewRead | undefined,
  body: string,
): UnreviewedSpec | undefined {
  const currentSha256 = specBodySha256(body);
  const base = { id: spec.id, path: spec.path, currentSha256 };
  if (review === undefined) return { ...base, reason: "missing" };
  if (!review.ok) {
    return { ...base, reason: "malformed", problem: review.problem };
  }
  if (review.record.bodySha256 !== currentSha256) {
    return {
      ...base,
      reason: "changed",
      recordedSha256: review.record.bodySha256,
      reviewer: review.record.reviewer,
    };
  }
  return undefined;
}

/**
 * Operator-facing lines for an unreviewed refusal. Ids, paths and digests
 * only — never the body. Every line ends in the remedy, and the remedy always
 * names `--reviewer` explicitly: the identity is the operator's to state.
 */
export function formatUnreviewedSpecs(
  unreviewed: readonly UnreviewedSpec[],
  testsRoot: string,
): string[] {
  const lines: string[] = [];
  for (const entry of unreviewed) {
    switch (entry.reason) {
      case "missing":
        lines.push(
          `  ${entry.id} (${entry.path}): no review record — read the body, then run \`tess review --tests-root ${testsRoot} --spec ${entry.id} --reviewer <id>\``,
        );
        break;
      case "malformed":
        lines.push(
          `  ${entry.id} (${entry.path}): the review record is not readable (${entry.problem ?? "unknown problem"}) — re-review the body and record it again with \`tess review ... --reviewer <id>\``,
        );
        break;
      case "changed":
        lines.push(
          `  ${entry.id} (${entry.path}): the body changed since it was reviewed by ${entry.reviewer ?? "?"} (reviewed sha256 ${entry.recordedSha256 ?? "?"}, current sha256 ${entry.currentSha256}) — re-review the CURRENT body before recording it again with \`tess review ... --reviewer <id>\``,
        );
        break;
    }
  }
  return lines;
}
