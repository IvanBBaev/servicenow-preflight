// Exit codes. Distinct on purpose — CI must not conflate them.
//
// `noGo` and `inconclusive` are SEPARATE because PLAN Phase 1 gives them
// different meanings and different remedies (QA-9): `noGo` is "something was
// checked and it is wrong", `inconclusive` is "something could not be checked
// at all, so no green may be claimed". A pipeline that retries on 5 and pages a
// human on 1 is the whole point of keeping them apart.
//
// `tess run --skeleton` deliberately keeps the Phase-0.5 mapping (GO → 0,
// anything else → 1): its observable behaviour is frozen while Phases 2–8
// replace the adapters underneath it. That mapping is `runExitDisposition`
// below, together with the distinction it cannot express.

import type { VerdictStatus } from "@tessera/types";

export const EXIT_CODES = {
  /** The gate opened. */
  ok: 0,
  /** The gate stayed shut on evidence: NO_GO, or a hard preflight failure. */
  noGo: 1,
  /** The invocation was wrong. Nothing ran. */
  usage: 2,
  /** DEV-1 infrastructure fault — no evidence about any test. */
  fault: 3,
  /** §11.3 GuardViolation — the write was refused, nothing was written. */
  refused: 4,
  /**
   * QA-9: something was skipped, deferred or undecidable, so the run has no
   * standing to say "ready". Never collapse this into 0.
   */
  inconclusive: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * What the frozen `tess run --skeleton` mapping did to a verdict.
 *
 * `code` is the number the process exits with. `collapsed` is the fact that
 * number cannot carry: the mapping has three statuses to say and two codes to
 * say them in, so one of the codes is answering two different questions.
 */
export interface RunExitDisposition {
  /** The process exit code. Frozen: GO → 0, anything else → 1. */
  readonly code: ExitCode;
  /**
   * True when `code` is standing in for a status that is not NO_GO — today
   * only INCONCLUSIVE. A caller that reads the exit code alone and sees this
   * is false may treat 1 as "the target failed"; when it is true, 1 means
   * "either the target failed or we could not tell, and this number does not
   * say which".
   */
  readonly collapsed: boolean;
}

/**
 * The frozen Phase-0.5 exit mapping for `tess run --skeleton`, and the one
 * place it exists.
 *
 * FROZEN — do not widen. CI jobs were written against `0` or `1` from this
 * command and must not start seeing a `5` because Phase 1 gained one. The
 * six-code set above belongs to the `--live` path; `--skeleton` keeps its two
 * outcomes for as long as it exists.
 *
 * The cost of that freeze is QA-9's whole distinction: INCONCLUSIVE ("nothing
 * could be checked, so no green may be claimed") and NO_GO ("something was
 * checked and it is wrong") arrive at the caller as the same number. That was
 * true before this function existed and is still true; what changed is that it
 * is no longer only true in a comment. `collapsed` is the same fact as a value,
 * so the renderers, the `--json` document and the returned code are all reading
 * one answer rather than three re-derivations of it that can drift apart.
 *
 * Derived from `code`, not from a list of statuses: a fourth VerdictStatus
 * added upstream would be collapsed by this mapping too, and would be reported
 * as collapsed without an edit here.
 */
export function runExitDisposition(status: VerdictStatus): RunExitDisposition {
  const code: ExitCode = status === "GO" ? EXIT_CODES.ok : EXIT_CODES.noGo;
  return { code, collapsed: code === EXIT_CODES.noGo && status !== "NO_GO" };
}
