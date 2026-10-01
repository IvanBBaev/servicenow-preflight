// The code-version parity vocabulary (ARCH-20, PLAN Phase 1).
//
// Everything here is DATA, exactly like the doctor's report. This stage answers
// one question — "is the code the RUNNER will execute the code the SOURCE
// resolved?" — and hands the answer back for somebody else to act on. It never
// decides to deploy, because ARCH-20 says Tessera never moves source→runner
// itself.

import type { TargetArtifactRef } from "@tessera/types";

/**
 * The per-artifact outcome, as a CLOSED union rather than a thrown error.
 *
 * `undecidable` is the load-bearing member: it means the read gave no usable
 * answer (403, 401, 5xx, transport, timeout, abort, a table this stage cannot
 * fingerprint). Keeping "the instance said no" apart from "the instance did not
 * say" is the same three-state discipline the doctor runs on — collapse them
 * and a blind read starts reading as a green one.
 */
export type ParityOutcome =
  | "match"
  | "differs"
  | "missing-on-runner"
  | "missing-on-source"
  | "undecidable";

/** One artifact, compared. */
export interface ParityRow {
  /** The artifact as the resolver named it — table, sys_id and label. */
  readonly artifact: TargetArtifactRef;
  readonly outcome: ParityOutcome;
  /**
   * Never empty. A row whose outcome cannot be traced back to something an
   * instance actually said is a verdict nobody can check (QA-9).
   */
  readonly evidence: string;
  /**
   * The executable fields a digest for this row WOULD cover — the concrete
   * definition of "same version" for this table. It is the scope of the
   * comparison, not evidence that one happened: a row decided before that
   * scope existed (an unfingerprintable table, an artifact with no
   * table/sys_id, an abort) carries an empty list, but a row whose reads
   * failed carries the full list and no digest at all. Whether a comparison
   * happened is what `sourceFingerprint`/`runnerFingerprint` say.
   */
  readonly fields: readonly string[];
  /** SHA-256 over the source side's executable fields, when it was read. */
  readonly sourceFingerprint?: string;
  /** SHA-256 over the runner side's executable fields, when it was read. */
  readonly runnerFingerprint?: string;
}

/**
 * The roll-up.
 *
 * `not-applicable` is reported explicitly and never by omission: a collapsed
 * topology (source === runner) and an empty artifact set both mean "nothing was
 * compared", and that must not render as a green line (QA-9).
 */
export type ParityStatus =
  "match" | "mismatch" | "undecidable" | "not-applicable";

/**
 * The two roles this stage compares. A full `PipelineTopology` is structurally
 * assignable, so callers pass what they already hold. `target` is deliberately
 * absent: parity is about the instance the code was resolved on and the
 * instance that will execute it, and reading a third one would only invite
 * pointing this check somewhere it does not belong.
 */
export interface ParityTopology {
  /** Connection profile the artifacts were resolved on. */
  readonly source: string;
  /** Connection profile the suite will execute on (ARCH-8). */
  readonly runner: string;
}

export interface ParityRequest {
  /** The resolved artifact set — what changed, as the source sees it. */
  readonly artifacts: readonly TargetArtifactRef[];
  readonly topology: ParityTopology;
  /** Cancellation. An already-aborted signal resolves rows, it does not throw. */
  readonly signal?: AbortSignal;
}

/**
 * The inspectable answer.
 *
 * `preflightFailure` and `inconclusive` exist because PLAN Phase 1 maps the two
 * failing statuses to two DIFFERENT consequences — a mismatch is a hard
 * preflight failure, an undecidable parity is an `inconclusive` verdict
 * (ARCH-28/DEV-17). A caller must be able to tell them apart without
 * re-deriving the roll-up it was just handed.
 */
export interface ParityReport {
  readonly status: ParityStatus;
  readonly source: string;
  readonly runner: string;
  /** Normalized instance host behind `source`, when it could be resolved (M5). */
  readonly sourceHost?: string;
  /** Normalized instance host behind `runner`, when it could be resolved (M5). */
  readonly runnerHost?: string;
  readonly rows: readonly ParityRow[];
  /** One line a human can read without expanding the rows. */
  readonly summary: string;
  /** Set exactly when `status === "mismatch"`. */
  readonly preflightFailure?: string;
  /** Set exactly when `status === "undecidable"`. */
  readonly inconclusive?: string;
}

export interface ParityCheck {
  check(request: ParityRequest): Promise<ParityReport>;
}
