// @tessera/types — exported wire shape of confirm_ready and `--json` CLI
// output (DESIGN §6a). Pure data; nothing in this file performs I/O.

import type { TestKind, TestSpecRef } from "./run.js";

/**
 * Runtime source of truth for the closed RawOutcome union — the reducer's
 * unknown-outcome default clause needs the known set at runtime.
 */
export const RAW_OUTCOMES = [
  "pass", // runner reported pass
  "fail", // assertion failure (TestEvent "fail")
  "error", // adapter/infra fault: an "error" TestEvent, or the orchestrator
  //         mapping a DEV-1 runner rejection to rows
  "skipped", // planned, deliberately not executed
  "waiting-timeout", // run stayed `waiting` past the DEV-2 grace window; the
  //         stream shows this as an "error" event (Phase 5) — the RunResult
  //         preserves the distinct cause for this row
  "flaky", // re-run disagreement (QA-7) — REACHABLE TODAY: the reducer
  //         synthesizes it whenever two outcomes for one spec key disagree
  //         (aggregateVerdict.ts:136), which needs no re-run policy — two
  //         disagreeing rows are enough, and the golden fixture
  //         flaky-disagreement.json is a verdict carrying one. What §8.8
  //         leaves open is the re-run POLICY, not this outcome
  "missing", // planned, but NO result row found — synthesized by the reducer,
  //         never emitted by a runner
] as const;
export type RawOutcome = (typeof RAW_OUTCOMES)[number];

export type RowStatus = "pass" | "fail" | "inconclusive";

export interface EvidenceRef {
  kind: "atf-result" | "artifact" | "log";
  /** sys_atf_test_result sys_id (DR-4) or run-id-keyed artifact path (QA-11). */
  ref: string;
}

/**
 * Identity of the artifact under test (the ImpactGraph node). Deliberately
 * NOT §6's `ArtifactRef`, which points at captured failure artifacts (QA-11).
 */
export interface TargetArtifactRef {
  table: string;
  sysId: string;
  name: string;
}

export interface ChecklistRow {
  /** Repo path + manifest identity — what was planned. */
  spec: TestSpecRef;
  kind: TestKind;
  /** Artifact under test. */
  target: TargetArtifactRef;
  /** What actually came back, unmodified. */
  raw: RawOutcome;
  /** Resolved via the fail-closed table in @tessera/core's reducer. */
  status: RowStatus;
  /** Whether this row holds the gate closed. */
  blocking: boolean;
  /**
   * True iff an override changed this row's `blocking`. Per-row, and NOT the
   * same predicate as ConfirmToken.overridden — see that field.
   */
  overridden: boolean;
  /**
   * Present iff the SpecOutcome this row folded already carried one: the
   * reducer copies it and never synthesizes one (aggregateVerdict.ts:137
   * and :160), and `SpecOutcome.evidence` is optional for EVERY raw. So an
   * absent `evidence` is NOT a diagnosis, and in particular does not mean
   * `raw === "missing"` — @tessera/reporter's collector emits `{ spec, raw }`
   * with no evidence for any raw at all, `pass` included, whenever the
   * stream's EvidenceRef.kind falls outside the union (collect.ts:170).
   *
   * A property of today's producers rather than a guarantee of this type:
   * every waiting-timeout row this tree can build carries at least a log ref
   * (atfRunner.ts:262 and :326, runPipeline.ts `synthesize`).
   */
  evidence?: EvidenceRef;
}

export type VerdictStatus = "GO" | "NO_GO" | "INCONCLUSIVE";

export interface OverrideRecord {
  /** Closed union; grows deliberately, never free-form. */
  flag: "allow-skipped";
  affectedRows: number;
  /** Who passed the flag (CLI user / MCP client id). */
  actor: string;
}

/**
 * THE ConfirmToken — single canonical shape; §6b's confirm semantics reference
 * this type verbatim, no second declaration exists (ARCH-31/DEV-26/QA-21).
 */
export interface ConfirmToken {
  /** Token is void for any other run. */
  runId: string;
  /**
   * SHA-256 over canonical JSON of (rows, runId, topology, overrides) —
   * stable key order, deterministic row order; a re-run/changed verdict
   * invalidates the token.
   */
  verdictHash: string;
  /**
   * The reducer is authoritative for this field; read it there before you
   * trust any prose about it here. True iff an accepted OverrideRecord
   * affected at least one row — `overrides.some(o => o.affectedRows > 0)`
   * (aggregateVerdict.ts:320), inside the `if (status === "GO")` branch
   * (aggregateVerdict.ts:298) that is the only minting site in the tree.
   *
   * It is NOT `overrides.length > 0`. An override the actor passed that
   * flipped no row (`affectedRows: 0`) stays recorded in `overrides` and in
   * verdictHash — the audit keeps what was asked for — and leaves this flag
   * false. What was asked for and what was done are separate facts here, on
   * purpose.
   *
   * Because a token exists only on GO, and no other rung of the §6a ladder
   * is override-sensitive, on a token this is equivalent to "an override
   * lifted this run from INCONCLUSIVE to GO". Note the scope: the
   * equivalence is a property of the GO branch, not of the predicate — on a
   * non-GO verdict rows can be affected with nothing promoted.
   *
   * The mechanism, stated separately because it is a claim about the ladder
   * and not about this field: an accepted `allow-skipped` override promotes
   * INCONCLUSIVE → GO; nothing promotes NO_GO → GO, since `allow-skipped`
   * clears `blocking` only on `raw: "skipped"` rows
   * (aggregateVerdict.ts:193-199) while the NO_GO rung tests
   * `blocking && status === "fail"` (aggregateVerdict.ts:270); and nothing
   * promotes implicitly — an INCONCLUSIVE reaches GO only through an
   * override the caller passed. The wording this comment replaces, "true
   * only via a journalled NO_GO override", named the single promotion the
   * ladder makes unreachable.
   *
   * Contrast ChecklistRow.overridden, a different predicate: per-row, and
   * true only for a row that was itself flipped.
   */
  overridden: boolean;
  /** ISO-8601, from the injected clock — the reducer stays pure. */
  issuedAt: string;
  /** issuedAt + injected TTL (config; default ~60 min). */
  expiresAt: string;
  /**
   * HMAC over the fields above; single-use — promotion consumes it (§6b).
   * Minted OUTSIDE the pure reducer: aggregateVerdict computes verdictHash;
   * the GateEvaluator shell adds sig with the injected key.
   */
  sig: string;
}

interface PreflightVerdictBase {
  /** Same id that tags TestEvents (ARCH-16) and projected records (§4a). */
  runId: string;
  /**
   * §2a roles this verdict binds — a verdict for one source→target pair is
   * not transferable to another.
   */
  topology: {
    source: string;
    runner: string;
    target: string;
  };
  /** Deterministic order (see the reducer's sort contract). */
  rows: readonly ChecklistRow[];
  counts: {
    /** By resolved `status`. */
    pass: number;
    fail: number;
    inconclusive: number;
    /** Rows still holding the gate closed. */
    blocking: number;
    /** raw === "missing" (a subset of fail), always visible. */
    missing: number;
  };
  /**
   * Every override the reducer ACCEPTED and baked into this verdict —
   * records rejected for an unknown or duplicate flag are dropped with a
   * warning and never appear here, and `affectedRows` is recomputed rather
   * than taken from the caller. Exhaustive as an audit trail: a record with
   * `affectedRows: 0` is kept, so membership here records what the actor
   * asked for, not what changed. The digest covers this array as it stands;
   * ConfirmToken.overridden reads `affectedRows`, not membership.
   */
  overrides: readonly OverrideRecord[];
  /**
   * e.g. QA-9 `unanalyzable` impact edges — surfaced here, never silently
   * green.
   */
  warnings: readonly string[];
}

/**
 * The §6a verdict. Discriminated on `status`: a GO carries its ConfirmToken,
 * a NO_GO or INCONCLUSIVE never does (A-1; minted only at
 * aggregateVerdict.ts's GO branch).
 *
 * Delegated decision 2026-09-26: a union rather than an optional field, so
 * "GO without a token" and "NO_GO with a token" stop compiling. Checked
 * against every workspace package before landing — only @tessera/core
 * constructed verdicts in a way the union rejects, and it was adapted. A
 * reader that only reads `verdict.confirmToken` still sees
 * `ConfirmToken | undefined`, exactly as before.
 */
export type PreflightVerdict =
  | (PreflightVerdictBase & { status: "GO"; confirmToken: ConfirmToken })
  | (PreflightVerdictBase & {
      status: "NO_GO" | "INCONCLUSIVE";
      confirmToken?: never;
    });
