// The §4b run state machine and entry lifecycle as pure rules — no I/O, so the
// legality table can be tested on its own and quoted by the run orchestrator.

import { LedgerError } from "./errors.js";
import type { LedgerEntryState, RunState, RunStateRecord } from "./types.js";

/** A terminal state is terminal *for the owning process*; cleanup re-enters. */
export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "done",
  "failed",
  "abandoned",
];

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

/**
 * The §4b "Legal transitions" table, edge for edge:
 *
 * - `planned → done` is the `repo-only` short-circuit (no writes, no entries);
 *   the lifecycle side of that condition is checked by the ledger, which is the
 *   only layer that can read the `RunStateRecord`.
 * - every non-terminal state may be inferred `abandoned` by a stale scan, and
 *   `running` may additionally self-write it on deadline/abort (ARCH-32/DEV-25).
 * - every non-terminal state EXCEPT `running` may go straight to `tearing-down`
 *   on error/abort — no instance run can be in flight before `running`, and
 *   under a non-terminal instance run nothing may be deleted (DEV-17).
 * - `failed`/`abandoned` re-enter `tearing-down` for `tess cleanup` only.
 */
export const RUN_STATE_TRANSITIONS: Readonly<
  Record<RunState, readonly RunState[]>
> = {
  planned: ["provisioning", "done", "tearing-down", "abandoned"],
  provisioning: ["projecting", "tearing-down", "abandoned"],
  projecting: ["running", "tearing-down", "abandoned"],
  running: ["collecting", "abandoned"],
  collecting: ["tearing-down", "abandoned"],
  "tearing-down": ["done", "failed", "abandoned"],
  done: [],
  failed: ["tearing-down"],
  abandoned: ["tearing-down"],
};

export function isLegalRunTransition(from: RunState, to: RunState): boolean {
  return RUN_STATE_TRANSITIONS[from].includes(to);
}

export function assertLegalRunTransition(from: RunState, to: RunState): void {
  if (isLegalRunTransition(from, to)) {
    return;
  }
  const legal = RUN_STATE_TRANSITIONS[from];
  const allowed = legal.length > 0 ? legal.join(", ") : "nothing (terminal)";
  throw new LedgerError(
    "illegal-transition",
    `run state ${from} → ${to} is not a legal transition (§4b); from ${from} the legal targets are ${allowed}`,
  );
}

/**
 * Whether the record PROVES its run never entered `running` — the only state
 * that can trigger an instance-side execution — so a teardown may assert
 * `neverTriggered` past a store's DEV-17 zero-result gate.
 *
 * Delegated decision 2026-09-25: true only for a record kept by a ledger that
 * stamps `runningAt` (`tracksRunning`) and carries no such stamp. A legacy
 * record without the marker proves nothing, so it answers false (fail
 * closed): the gate then stays up and the leftover suite is left for a human.
 */
export function neverReachedRunning(
  record: Pick<RunStateRecord, "runningAt" | "tracksRunning">,
): boolean {
  return record.tracksRunning === true && record.runningAt === undefined;
}

/**
 * Entry lifecycle is strictly `intended → applied → compensated` (§4b), with the
 * one shortcut recovery needs: a W1 orphan whose record the probe proves absent
 * is marked `compensated` directly — the compensation is a no-op, but the entry
 * must still reach a terminal state or the run can never converge.
 */
export const LEDGER_ENTRY_TRANSITIONS: Readonly<
  Record<LedgerEntryState, readonly LedgerEntryState[]>
> = {
  intended: ["applied", "compensated"],
  applied: ["compensated"],
  compensated: [],
};

export function isLegalEntryTransition(
  from: LedgerEntryState,
  to: LedgerEntryState,
): boolean {
  return LEDGER_ENTRY_TRANSITIONS[from].includes(to);
}
