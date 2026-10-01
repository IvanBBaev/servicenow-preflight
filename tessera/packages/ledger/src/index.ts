// @tessera/ledger — the write-ahead intent ledger (DESIGN §4b), Phase 0.5's
// minimal form: the durable intend → write → confirm protocol that closes crash
// windows W1/W2, the run-lifecycle state machine it joins (ARCH-16), the
// reconciliation reads teardown replays, and the ARCH-43 audit log — plus
// (delegated decision 2026-09-23) the per-host standing-infra namespace and the
// per-run event log `run_status` reads from a new process (§6b / QA-29).
//
// `durability.ts` and `records.ts` are deliberately NOT exported: the on-disk
// encoding is an implementation detail, and every guarantee the ledger makes
// depends on nothing else appending to those files.

export { LedgerError } from "./errors.js";
export type { CorruptRecordReport, LedgerErrorCode } from "./errors.js";
export {
  LEDGER_ENTRY_TRANSITIONS,
  RUN_STATE_TRANSITIONS,
  TERMINAL_RUN_STATES,
  assertLegalRunTransition,
  isLegalEntryTransition,
  isLegalRunTransition,
  isTerminalRunState,
  neverReachedRunning,
} from "./stateMachine.js";
export { AUDIT_KINDS, RUN_STATES } from "./types.js";
export type {
  AuditEvidenceSignal,
  AuditInstanceRef,
  AuditSpecRef,
  CompensationOp,
  InfraIntendInput,
  InfraLedger,
  InfraLedgerOptions,
  IntendInput,
  IntentLedger,
  IntentLedgerOptions,
  LedgerAuditInput,
  LedgerAuditKind,
  LedgerAuditRecord,
  LedgerEntry,
  LedgerEntryState,
  LedgerInfraWriteRecord,
  LedgerRecord,
  LedgerWriteRecord,
  OpenRunInput,
  PersistedRunResult,
  ProbeDescriptor,
  RecoveryPlan,
  RunEvent,
  RunEventInput,
  RunEventLog,
  RunEventLogOptions,
  RunEventPage,
  RunId,
  RunLifecycle,
  RunScanEntry,
  RunState,
  RunStateRecord,
  RunStatusSnapshot,
} from "./types.js";
export {
  AUDIT_LOG_FILENAME,
  RUNS_DIRNAME,
  RUN_LEDGER_FILENAME,
  RUN_ID_PATTERN,
  RUN_STATE_FILENAME,
  createIntentLedger,
  validateRunId,
} from "./ledger.js";
export {
  INFRA_DIRNAME,
  INFRA_HOST_PATTERN,
  INFRA_LEDGER_FILENAME,
  createInfraLedger,
} from "./infra.js";
export {
  RUN_EVENTS_FILENAME,
  RUN_RESULT_FILENAME,
  createRunEventLog,
} from "./runEvents.js";
