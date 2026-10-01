// The ARCH-33 standing-infra ledger around `tess preflight --mode apply`.
//
// A provisioning remedy is STANDING infrastructure: it outlives the run that
// made it (the runner stays enabled after preflight exits), so it is not a §4b
// run-scoped write and has no teardown. It is still a write to a real instance,
// though, and every such write is journalled write-ahead — intend, write,
// confirm — in the per-host namespace `createInfraLedger` owns (delegated
// decision 2026-09-23, TODO "preflight apply").
//
// Two properties this module exists for:
//
//  * **Idempotent retry.** Each step is keyed `<idempotencyKey>#<index>`. A
//    retry under the same key and the SAME plan skips every step the ledger
//    already holds as `applied`; a step left `intended` (crash between the
//    write and its confirm) is written again, which is safe because every
//    provisioning write is an `update-record` of fixed field values.
//
//  * **One key, one plan.** The same key under a different §6b plan hash is a
//    caller bug the ledger refuses (`protocol`). `checkIdempotency` reads that
//    BEFORE the first write, so the refusal lands with nothing written instead
//    of halfway through a plan.
//
// The wrapper is a drop-in `InstanceWriter`: the provisioner's `apply()` stays
// the only thing that decides the order and meaning of writes, and its
// post-apply verification still asks the instance, so a skipped step is
// verified exactly like a written one.

import type { InfraLedger, LedgerInfraWriteRecord } from "@tessera/ledger";
import type {
  InstanceWriter,
  ProvisionStep,
  WriteOutcome,
} from "@tessera/provisioner";

/** The ledger key of step `index` under `idempotencyKey`. */
export function stepIdempotencyKey(
  idempotencyKey: string,
  index: number,
): string {
  return `${idempotencyKey}#${index}`;
}

/**
 * A refusal message when `idempotencyKey` already names writes of a DIFFERENT
 * plan on this host, `undefined` when the key is fresh or belongs to this plan.
 * Read-only: nothing is appended.
 */
export async function checkIdempotency(
  ledger: InfraLedger,
  planHash: string,
  idempotencyKey: string,
  steps: readonly ProvisionStep[],
): Promise<string | undefined> {
  for (let index = 0; index < steps.length; index += 1) {
    const key = stepIdempotencyKey(idempotencyKey, index);
    const existing = await ledger.findByIdempotencyKey(key);
    if (existing !== undefined && existing.planHash !== planHash) {
      return (
        `idempotency key ${JSON.stringify(key)} already names a write of plan ` +
        `${existing.planHash} on ${ledger.host}, not of this plan ${planHash} — ` +
        "one key names one plan's writes; pass a fresh --idempotency-key (ARCH-33)"
      );
    }
  }
  return undefined;
}

export interface LedgeredWriter {
  readonly writer: InstanceWriter;
  /** Entries this apply wrote or confirmed, in step order. */
  entries(): readonly LedgerInfraWriteRecord[];
  /** Step indexes skipped because the ledger already held them `applied`. */
  skipped(): readonly number[];
}

/**
 * Wrap `inner` so every `updateRecord` is journalled write-ahead against the
 * matching plan step. `apply()` walks `plan.steps` in order, so the n-th call
 * IS step n; a call that does not match its step's write is refused rather
 * than journalled under the wrong intent.
 */
export function createLedgeredWriter(
  inner: InstanceWriter,
  options: {
    readonly ledger: InfraLedger;
    readonly planHash: string;
    readonly idempotencyKey: string;
    readonly steps: readonly ProvisionStep[];
  },
): LedgeredWriter {
  const { ledger, planHash, idempotencyKey, steps } = options;
  const recorded: LedgerInfraWriteRecord[] = [];
  const skipped: number[] = [];
  let next = 0;

  return {
    writer: {
      async updateRecord(table, sysId, fields): Promise<WriteOutcome> {
        const index = next;
        next += 1;
        const step = steps[index];
        if (
          step === undefined ||
          step.write.table !== table ||
          step.write.sysId !== sysId
        ) {
          throw new Error(
            `ledgered writer: write #${index} (${table}/${sysId}) is not the planned step — refusing to journal it under another step's intent (ARCH-33)`,
          );
        }
        const key = stepIdempotencyKey(idempotencyKey, index);
        const existing = await ledger.findByIdempotencyKey(key);
        if (existing !== undefined && existing.state === "applied") {
          recorded.push(existing);
          skipped.push(index);
          // Nothing echoed: the write happened in an earlier process. The
          // provisioner's verification re-reads the instance either way.
          return { table, sysId, record: {} };
        }
        const intended = await ledger.intend({
          planHash,
          intent: step.action.description,
          target: { table, sysId },
          compensation: {
            op: "none",
            reason: `standing infrastructure (ARCH-33): a provisioning remedy for ${step.precondition} is kept, not torn down; observed before the write: ${step.observed}`,
          },
          idempotencyKey: key,
        });
        const outcome = await inner.updateRecord(table, sysId, fields);
        recorded.push(await ledger.confirm(intended.seq, { sysId }));
        return outcome;
      },
    },
    entries: () => recorded,
    skipped: () => skipped,
  };
}
