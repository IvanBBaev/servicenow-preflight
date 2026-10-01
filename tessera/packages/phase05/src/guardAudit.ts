// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// The §11.4 `GuardAuditSink`: it translates the guard's acknowledge-prod record
// into the write-ahead intent ledger's audit log, synchronously, and that log
// is the only place the record is written.
//
// Until 2026-08-31 this file was a WRITER of its own. `GuardAuditSink.record()`
// is synchronous by contract (guard §11.6: `assertWrite` is sync, so the entry
// must be durable by the time it returns, and a throwing sink refuses the
// write) while `IntentLedger.appendAudit()` was async-only — so the full §11.4
// record went to a sibling `guard-audit.jsonl` here, and the composition root
// separately appended a `{reason, actor}` stub of the SAME event to the
// ledger's audit log. One fact in two files, and the ledger's copy was the one
// that looked complete: `kind`, `runId`, `at`, a reason and an actor is a
// plausible whole audit record, so nothing told a reader that instance, role,
// class, evidence and surface were somewhere else — or that the two files could
// disagree. `IntentLedger.appendAuditSync` (ledger types.ts) closed that seam.
//
// This sink therefore opens no file handle and owns no format. If you find
// yourself adding one back, the record has split again.

import type { AcknowledgeProdRecord, GuardAuditSink } from "@tessera/guard";
import type { IntentLedger, LedgerAuditInput } from "@tessera/ledger";

/** The ledger's spelling of the same §11.4 fact. */
type LedgerAcknowledgeProdInput = Extract<
  LedgerAuditInput,
  { kind: "acknowledge-prod" }
>;

type AssertNever<T extends never> = T;

type FieldsOnlyInGuardRecord = Exclude<
  keyof AcknowledgeProdRecord,
  keyof LedgerAcknowledgeProdInput
>;

type FieldsOnlyInLedgerInput = Exclude<
  keyof LedgerAcknowledgeProdInput,
  keyof AcknowledgeProdRecord
>;

/**
 * COMPILE-TIME CONFORMANCE — the check the ledger's `AuditPayloads` docstring
 * points at. Two packages describe one §11.4 record and neither can import the
 * other's shape as its own definition; this file is the one place both are
 * visible, so this is where they are held to the same FIELD SET.
 *
 * A field added to the guard's record and not to the ledger payload (or the
 * reverse) fails the build here, naming the field, instead of quietly
 * reappearing as a fact the audit log does not carry. The field TYPES are
 * checked a few lines below, by the `appendAuditSync` call itself.
 */
export type AcknowledgeProdFieldParity = [
  AssertNever<FieldsOnlyInGuardRecord>,
  AssertNever<FieldsOnlyInLedgerInput>,
];

export interface LedgerGuardAuditSink extends GuardAuditSink {
  /** Records this sink journalled, in order — for assertions and the CLI. */
  records(): readonly AcknowledgeProdRecord[];
}

/**
 * @param ledger the run's write-ahead ledger. Injected — this package reads no
 * `process.env` and computes no file location; the ledger owns its own layout.
 */
export function createLedgerGuardAuditSink(
  ledger: IntentLedger,
): LedgerGuardAuditSink {
  const journalled: AcknowledgeProdRecord[] = [];

  return {
    record(entry: AcknowledgeProdRecord): void {
      // Durable before returning — `appendAuditSync` fsyncs on this tick — and
      // durable as ONE record. A throw propagates, which is the intended
      // failure mode: an override that could not be journalled is not an
      // audited override, and the guard turns the throw into a violation.
      //
      // Every field is passed explicitly rather than by spread: the ledger
      // input's fields are all required, so dropping one is a compile error
      // here rather than a silently thinner record on disk.
      ledger.appendAuditSync({
        kind: "acknowledge-prod",
        runId: entry.runId,
        at: entry.at,
        instance: { name: entry.instance.name, host: entry.instance.host },
        role: entry.role,
        cls: entry.cls,
        evidence: entry.evidence.map((signal) => ({
          kind: signal.kind,
          effect: signal.effect,
          detail: signal.detail,
        })),
        reason: entry.reason,
        actor: entry.actor,
        surface: entry.surface,
      });
      // Only after the append. An in-memory echo of a record that was never
      // journalled is a second account of the event that can disagree with the
      // durable one — the exact shape of the defect this file used to be.
      journalled.push(entry);
    },

    records() {
      return journalled;
    },
  };
}
