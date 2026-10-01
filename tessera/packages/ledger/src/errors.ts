// @tessera/ledger — the ledger's OWN error type (DESIGN §4b). Callers
// discriminate on `code`, never on message text.
//
// It is not the only thing a ledger call can throw, and the codes below are
// therefore not an exhaustive `catch`. Filesystem failures propagate as the
// Node system errors they are: `mkdir`, `open`, `write`, `fsync`, `rename`
// and `readFile` are nowhere wrapped, and ENOENT is the only errno ever
// turned into an absence (`readTextFile`, `listDirectories`, `pathExists`).
// A caller that switches on `LedgerErrorCode` and lets the default case fall
// through is reading EACCES or ENOSPC as a non-event — the DEV-1 fault this
// package exists to make loud.

export type LedgerErrorCode =
  /** A run id that is not usable as a namespace key / directory name (ARCH-16). */
  | "invalid-run-id"
  /** No `RunStateRecord` exists for the run — nothing to write or reconcile against. */
  | "run-not-found"
  /** A run id is already open under different scope/runner/lifecycle parameters. */
  | "run-exists"
  /** Not a legal edge of the §4b run state machine (or an entry-state flip that is not). */
  | "illegal-transition"
  /** The §4b write protocol was used out of order, or an intent is not compensatable. */
  | "protocol"
  /** On-disk records are unreadable somewhere other than an uncommitted tail. */
  | "corrupt"
  /**
   * An instance host that is not usable as an infra-namespace directory name
   * (`<root>/infra/<host>/`, delegated decision 2026-09-23).
   */
  | "invalid-host"
  /**
   * The cross-process lock file of a namespace stayed held past the caller's
   * timeout. Nothing was written: the call is safe to retry as-is.
   */
  | "lock-timeout";

/** One record `scan()` could not decode — see `LedgerError.corruptRecords`. */
export interface CorruptRecordReport {
  /** The run directory's name under `<root>/runs/`. */
  readonly runId: string;
  /** The file that would not decode (`run.json` or `ledger.jsonl`). */
  readonly path: string;
  /** Why it would not decode, in the reader's words. */
  readonly reason: string;
}

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  /**
   * Set only by a `corrupt` refusal from `scan()`: the offending records, in
   * run-id order, bounded (`corruptTotal` is the unbounded count). Absent on
   * every other error, including a `corrupt` from a single-run read.
   */
  readonly corruptRecords?: readonly CorruptRecordReport[];
  /** How many records were corrupt in total; set with `corruptRecords`. */
  readonly corruptTotal?: number;

  constructor(
    code: LedgerErrorCode,
    message: string,
    corrupt?: {
      readonly records: readonly CorruptRecordReport[];
      readonly total: number;
    },
  ) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
    if (corrupt !== undefined) {
      this.corruptRecords = corrupt.records;
      this.corruptTotal = corrupt.total;
    }
  }
}
