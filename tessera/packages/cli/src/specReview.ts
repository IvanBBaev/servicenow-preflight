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
// CANONICAL FORM (one rule, used by the reviewer, the checker and the
// projection alike): `canonicalSpecBody` folds every CRLF line ending to LF —
// precisely, every run of CRs that ends in an LF becomes one LF, which makes
// the fold idempotent (a single-pass CRLF→LF would turn `\r\r\n` into `\r\n`
// and a second pass into `\n`, so the digest would stop covering the text
// that runs) — and changes nothing else; the review digest is the lowercase hex SHA-256 of that
// canonical text re-encoded as UTF-8 — `sha256Hex` from `@tessera/core`. There
// is NO other normalisation: a lone CR, a BOM, trailing whitespace and the
// Unicode form all stay as they are and all change the digest.
// A lone CR is a line terminator in ES5, so folding a CR run into the LF that
// ends it changes no token outside a string literal, and either way the gate
// parses, and the step runs, the folded text — never the raw file.
//
// Why CRLF and only CRLF: a checkout with `core.autocrlf` (or an editor) that
// rewrites line endings must not void every review, and the tests root lives
// in the operator's repo, where a `.gitattributes` rule shipped by Tessera
// cannot reach. Folding stays safe because the canonical text is ALSO what
// runs: `loadLiveSpecs` reads the body through `canonicalSpecBody`, gates that
// text and projects that text as the ATF step script, and `tess review` gates
// and hashes the same text. Two files that differ only in CRLF-vs-LF therefore
// execute the identical script, so the digest still covers exactly what runs.

import { sha256Hex } from "@tessera/core";
import type { SpecReviewRead } from "@tessera/specs";

/**
 * The canonical text of a spec body (see the header): every run of CRs that
 * ends in an LF folded to one LF, nothing else touched. Idempotent. The text the gate inspects, the
 * digest covers and the ATF step executes.
 */
export function canonicalSpecBody(body: string): string {
  return body.replace(/\r+\n/g, "\n");
}

/** The canonical review digest of a spec body (see the header). */
export function specBodySha256(body: string): string {
  return sha256Hex(canonicalSpecBody(body));
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
