// The per-instance standing-infra ledger (§6b `preflight_apply`, ARCH-33) —
// delegated decision 2026-09-23.
//
// On-disk layout under the same injected root as the run ledger:
//
//   <root>/infra/<host>/ledger.jsonl   append-only event log for that host
//   <root>/infra/<host>/.lock          cross-process lock (fileLock.ts)
//
// Its records are `LedgerInfraWriteRecord`s: keyed on `planHash`, never on a
// run id, so nothing run-scoped — teardown, `cleanup --run`, the run sweep —
// can reach them. The protocol is §4b's own (intend durably → write →
// confirm/compensate), with ONE difference that is the reason this namespace
// exists: the idempotency dedupe is HOST-scoped. Standing infra outlives any
// run, so a retry of the same apply from a new process, days later, must find
// the entry the first one made rather than intend the same write twice.

import path from "node:path";

import {
  appendLineDurable,
  ensureDir,
  readLogLines,
  repairLogTail,
} from "./durability.js";
import { LedgerError } from "./errors.js";
import { DEFAULT_LOCK_TIMEOUT_MS, withFileLock } from "./fileLock.js";
import {
  assertDecodable,
  optionalSysId,
  requireText,
  validateWriteShape,
} from "./ledger.js";
import {
  decodeInfraLogLine,
  foldInfraLog,
  parseLogRecords,
} from "./records.js";
import type { InfraLogLine, LedgerStateLine } from "./records.js";
import type {
  InfraIntendInput,
  InfraLedger,
  InfraLedgerOptions,
  LedgerInfraWriteRecord,
} from "./types.js";

export const INFRA_DIRNAME = "infra";
export const INFRA_LEDGER_FILENAME = "ledger.jsonl";
const LOCK_FILENAME = ".lock";

/**
 * A host becomes a directory name. DNS names, IPv4 literals and the
 * `localhost`-style names a test instance uses all fit; a port, a scheme or a
 * path does not — pass the hostname, not the URL.
 */
export const INFRA_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/;

/**
 * Delegated decision 2026-09-25: the host is LOWERCASED before it is
 * validated, used as a directory name, stamped on a record or compared. DNS
 * names are case-insensitive, so `DEV1.service-now.com` and
 * `dev1.service-now.com` are one instance: without folding, a case-sensitive
 * filesystem (Linux) gets two namespaces for it — two dedupe scopes, so the
 * same write intended twice — and a case-insensitive one (macOS) shares one
 * directory between two spellings, whose host check then reads the other
 * spelling's entries as `corrupt`. Folding (rather than refusing) is safe
 * here because, unlike a run id, two spellings of a host never name two
 * different things.
 */
export function validateHost(host: string): string {
  const folded = typeof host === "string" ? host.toLowerCase() : host;
  if (
    typeof folded !== "string" ||
    !INFRA_HOST_PATTERN.test(folded) ||
    folded.includes("..")
  ) {
    throw new LedgerError(
      "invalid-host",
      `invalid infra host ${JSON.stringify(host)}: expected a bare hostname matching ${INFRA_HOST_PATTERN.source}`,
    );
  }
  return folded;
}

export function createInfraLedger(options: InfraLedgerOptions): InfraLedger {
  const rootDir = path.resolve(requireText("rootDir", options.rootDir));
  const host = validateHost(options.host);
  const dir = path.join(rootDir, INFRA_DIRNAME, host);
  const logFile = path.join(dir, INFRA_LEDGER_FILENAME);
  const lockFile = path.join(dir, LOCK_FILENAME);
  const clock = options.now ?? ((): Date => new Date());
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

  async function readEntries(): Promise<LedgerInfraWriteRecord[]> {
    return foldInfraLog(
      logFile,
      host,
      parseLogRecords(logFile, await readLogLines(logFile), decodeInfraLogLine),
    );
  }

  /**
   * Every mutation runs read-then-append under the cross-process lock. The
   * tail is repaired on EVERY locked append, not once per process as the run
   * ledger does: another process may have torn it since our last look, and
   * only the lock holder may cut it.
   */
  async function locked<T>(work: () => Promise<T>): Promise<T> {
    await ensureDir(dir);
    return withFileLock(
      lockFile,
      async () => {
        await repairLogTail(logFile);
        return await work();
      },
      lockTimeoutMs,
    );
  }

  async function append(line: InfraLogLine): Promise<void> {
    // Decode-before-append (delegated decision 2026-09-25, see ledger.ts
    // `assertDecodable`). Callers reach this after `repairLogTail`, which
    // only ever cuts crash residue, so a refusal still leaves every committed
    // record untouched.
    assertDecodable(`infra record for ${logFile}`, line, decodeInfraLogLine);
    await appendLineDurable(logFile, JSON.stringify(line));
  }

  function requireEntry(
    entries: readonly LedgerInfraWriteRecord[],
    seq: number,
  ): LedgerInfraWriteRecord {
    const entry = entries.find((candidate) => candidate.seq === seq);
    if (entry === undefined) {
      throw new LedgerError(
        "protocol",
        `infra namespace ${host} has no ledger entry #${seq}`,
      );
    }
    return entry;
  }

  async function flip(line: LedgerStateLine): Promise<LedgerInfraWriteRecord> {
    await append(line);
    return requireEntry(await readEntries(), line.seq);
  }

  return {
    host,

    async intend(input: InfraIntendInput): Promise<LedgerInfraWriteRecord> {
      requireText("planHash", input.planHash);
      validateWriteShape(input);

      return locked(async () => {
        const entries = await readEntries();
        const duplicate = entries.find(
          (candidate) => candidate.idempotencyKey === input.idempotencyKey,
        );
        if (duplicate !== undefined) {
          if (duplicate.planHash !== input.planHash) {
            throw new LedgerError(
              "protocol",
              `idempotency key ${JSON.stringify(input.idempotencyKey)} already names entry #${duplicate.seq} of plan ${duplicate.planHash} on ${host}; one key cannot name a write of plan ${input.planHash} too`,
            );
          }
          // Host-scoped §4b dedupe: the retry re-uses the durable entry.
          return duplicate;
        }
        const seq =
          entries.reduce((max, candidate) => Math.max(max, candidate.seq), 0) +
          1;
        const record: LedgerInfraWriteRecord = {
          kind: "infra-write",
          planHash: input.planHash,
          target: { table: input.target.table, sysId: input.target.sysId },
          compensation: input.compensation,
          state: "intended",
          seq,
          host,
          intent: input.intent,
          idempotencyKey: input.idempotencyKey,
          probe: input.probe,
          intendedAt: clock().toISOString(),
        };
        // §4b step 1: durable before the caller's write leaves the process.
        await append(record);
        // As in the run ledger: hand back what the LOG says, so a retry in a
        // new process compares equal to this return value.
        return requireEntry(await readEntries(), seq);
      });
    },

    async confirm(
      seq: number,
      result?: { sysId?: string },
    ): Promise<LedgerInfraWriteRecord> {
      // Delegated decision 2026-09-25: "" is not a sys_id; refused, not written.
      optionalSysId("result.sysId", result?.sysId);
      return locked(async () => {
        const entry = requireEntry(await readEntries(), seq);
        const sysId = result?.sysId;
        if (entry.state === "applied") {
          if (
            sysId !== undefined &&
            entry.target.sysId !== undefined &&
            entry.target.sysId !== sysId
          ) {
            throw new LedgerError(
              "protocol",
              `infra entry #${seq} on ${host} is already applied as ${entry.target.sysId}; confirming ${sysId} would mean two records were created`,
            );
          }
          return entry;
        }
        if (entry.state === "compensated") {
          throw new LedgerError(
            "protocol",
            `infra entry #${seq} on ${host} is already compensated and cannot be confirmed (§4b)`,
          );
        }
        if (
          entry.compensation.op === "delete" &&
          sysId === undefined &&
          entry.target.sysId === undefined
        ) {
          throw new LedgerError(
            "protocol",
            `infra entry #${seq} on ${host} is a create; confirm must supply its sys_id or the compensation can never delete it (§4b step 3)`,
          );
        }
        return await flip({ kind: "state", seq, state: "applied", sysId });
      });
    },

    async compensate(
      seq: number,
      result?: { sysId?: string },
    ): Promise<LedgerInfraWriteRecord> {
      // Delegated decision 2026-09-25: "" is not a sys_id; refused, not written.
      optionalSysId("result.sysId", result?.sysId);
      return locked(async () => {
        const entry = requireEntry(await readEntries(), seq);
        if (entry.state === "compensated") {
          return entry;
        }
        return await flip({
          kind: "state",
          seq,
          state: "compensated",
          sysId: result?.sysId,
        });
      });
    },

    async entries(filter?: {
      planHash?: string;
    }): Promise<LedgerInfraWriteRecord[]> {
      const all = await readEntries();
      const planHash = filter?.planHash;
      return planHash === undefined
        ? all
        : all.filter((entry) => entry.planHash === planHash);
    },

    async findByIdempotencyKey(
      idempotencyKey: string,
    ): Promise<LedgerInfraWriteRecord | undefined> {
      requireText("idempotencyKey", idempotencyKey);
      return (await readEntries()).find(
        (entry) => entry.idempotencyKey === idempotencyKey,
      );
    },
  };
}
