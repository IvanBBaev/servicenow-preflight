// The write-ahead intent ledger (DESIGN §4b) — Phase 0.5's minimal form.
//
// On-disk layout under the injected root:
//
//   <root>/runs/<runId>/run.json      the RunStateRecord (atomic replace)
//   <root>/runs/<runId>/ledger.jsonl  append-only event log for that run
//   <root>/audit.jsonl                ARCH-43 retention-independent audit log
//
// Run-keyed directories (ARCH-16) give three properties for free: two runs can
// never interleave in one log, `cleanup --run` is a subtree, and the audit log
// sits OUTSIDE every run directory so neither teardown nor the sweep can remove
// it. The per-run log is an event log, not a mutable table — see records.ts.

import path from "node:path";

import {
  appendLineDurable,
  appendLineDurableSync,
  ensureDir,
  ensureDirSync,
  listDirectories,
  readLogLines,
  readTextFile,
  repairLogTail,
  repairLogTailSync,
  writeJsonAtomic,
  writeJsonExclusive,
} from "./durability.js";
import { LedgerError } from "./errors.js";
import type { CorruptRecordReport } from "./errors.js";
import {
  PROBE_KEYS,
  decodeAuditRecord,
  decodeLogLine,
  decodeRunStateRecord,
  foldRunLog,
  parseLogRecords,
} from "./records.js";
import type { LedgerLogLine, LedgerStateLine } from "./records.js";
import {
  assertLegalRunTransition,
  isTerminalRunState,
} from "./stateMachine.js";
import { AUDIT_KINDS } from "./types.js";
import type {
  AuditEvidenceSignal,
  AuditInstanceRef,
  AuditSpecRef,
  CompensationOp,
  IntendInput,
  IntentLedger,
  IntentLedgerOptions,
  LedgerAuditInput,
  LedgerAuditRecord,
  LedgerWriteRecord,
  OpenRunInput,
  ProbeDescriptor,
  RecoveryPlan,
  RunId,
  RunScanEntry,
  RunState,
  RunStateRecord,
} from "./types.js";

export const RUNS_DIRNAME = "runs";
export const RUN_STATE_FILENAME = "run.json";
export const RUN_LEDGER_FILENAME = "ledger.jsonl";
export const AUDIT_LOG_FILENAME = "audit.jsonl";

/**
 * A run id becomes a directory name, so it is validated as one: no separators,
 * no traversal, no leading dot, no empty string (ARCH-16).
 *
 * Delegated decision 2026-09-25: LOWERCASE ONLY. On a case-insensitive
 * filesystem (macOS/APFS, Windows/NTFS defaults) `Run1` and `run1` resolve to
 * one directory, so two distinct run ids would share one run.json and one
 * ledger.jsonl; and the ATF namespace sweep (`nameSTARTSWITH`) is
 * case-insensitive on the instance too, so mixed-case ids collide there as
 * well. Rather than fold case (which would silently merge two callers' runs),
 * an uppercase id is refused outright — fail closed. Generators must emit
 * lowercase (e.g. lowercase an ISO stamp's `T`/`Z`).
 */
/** How many corrupt records a `scan()` refusal lists before it summarises. */
const CORRUPT_REPORT_LIMIT = 20;

export const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export function validateRunId(runId: RunId): string {
  if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
    throw new LedgerError(
      "invalid-run-id",
      `invalid run id ${JSON.stringify(runId)}: expected 1-128 chars matching ${RUN_ID_PATTERN.source}`,
    );
  }
  return runId;
}

export function requireText(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new LedgerError(
      "protocol",
      `${field} is required and must be a non-empty string`,
    );
  }
  return value;
}

/**
 * An optional sys_id: absent is fine, present must be a non-empty string —
 * the same rule `decodeTarget`/`decodeLogLine` apply on the way back in.
 */
export function optionalSysId(field: string, value: unknown): void {
  if (value !== undefined) {
    requireText(field, value);
  }
}

/**
 * Delegated decision 2026-09-25: decode-before-write. Every record is run
 * through the SAME decoder the reader uses — on its JSON round-trip, i.e. the
 * exact bytes that would land on disk — before anything is written. A record
 * the reader would reject is refused here with `protocol` and NOTHING is
 * written (no tail repair, no directory, no append): otherwise the write
 * "succeeds" and every later read of that log or run throws `corrupt`
 * permanently. The targeted field checks elsewhere give better messages; this
 * gate is what keeps writer and reader from ever drifting apart again.
 */
export function assertDecodable<T>(
  what: string,
  record: unknown,
  decode: (value: unknown) => T | null,
): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(record);
  } catch (error) {
    throw new LedgerError(
      "protocol",
      `${what} cannot be encoded as JSON (${error instanceof Error ? error.message : String(error)}); nothing was written`,
    );
  }
  let parsed: unknown;
  try {
    parsed = encoded === undefined ? undefined : JSON.parse(encoded);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || decode(parsed) === null) {
    throw new LedgerError(
      "protocol",
      `${what} would not decode when read back, so it was refused before anything was written`,
    );
  }
}

function requireInstanceRef(value: AuditInstanceRef): AuditInstanceRef {
  return {
    name: requireText("instance.name", value?.name),
    host: requireText("instance.host", value?.host),
  };
}

/**
 * §11.4 evidence, validated element by element. An empty array is legal — an
 * instance can classify on a single source-of-truth signal that the guard did
 * not record as evidence — but a malformed element is not: a signal that
 * decodes to nothing tells a later reader less than no signal at all, while
 * looking like one.
 */
function requireEvidence(
  value: readonly AuditEvidenceSignal[],
): AuditEvidenceSignal[] {
  if (!Array.isArray(value)) {
    throw new LedgerError(
      "protocol",
      "evidence is required and must be an array of classification signals (§11.4)",
    );
  }
  // `Array.isArray` is typed as a guard to `any[]`, so it does not REFINE a
  // `readonly T[]` parameter — it replaces it, and every field read below
  // would be an unchecked `any` (three `no-unsafe-member-access` errors).
  // Re-binding restores the declared element type without a cast; the optional
  // chaining stays because the guard proves the array, never its elements.
  const signals: readonly AuditEvidenceSignal[] = value;
  return signals.map((signal, index) => ({
    kind: requireText(`evidence[${index}].kind`, signal?.kind),
    effect: requireText(`evidence[${index}].effect`, signal?.effect),
    detail: requireText(`evidence[${index}].detail`, signal?.detail),
  }));
}

/**
 * The specs an `allow-skipped` override flipped. Unlike evidence, the list has
 * to agree with a count (`affectedRows`), so it is checked against it by the
 * caller; here every element must be a whole spec identity.
 */
function requireSpecRefs(value: readonly AuditSpecRef[]): AuditSpecRef[] {
  if (!Array.isArray(value)) {
    throw new LedgerError(
      "protocol",
      "specs is required and must be an array of { id, path } spec refs (§6a)",
    );
  }
  // Re-bound for the same reason as in `requireEvidence`.
  const specs: readonly AuditSpecRef[] = value;
  return specs.map((spec, index) => ({
    id: requireText(`specs[${index}].id`, spec?.id),
    path: requireText(`specs[${index}].path`, spec?.path),
  }));
}

/**
 * Validate an audit input into the exact record that will be written. Pure —
 * no I/O, no clock — and shared by both append entry points, because the one
 * thing that must never be spelled twice is WHICH FIELDS make up the fact.
 */
function buildAuditRecord(
  input: LedgerAuditInput,
  at: string,
): LedgerAuditRecord {
  const runId = validateRunId(input.runId);
  switch (input.kind) {
    case "token-consumed": {
      return {
        kind: "token-consumed",
        runId,
        verdictHash: requireText("verdictHash", input.verdictHash),
        at,
      };
    }
    case "acknowledge-prod": {
      // Every field of the §11.4 fact, every one of them required — see
      // `AuditPayloads` in types.ts. This append IS the audit record now, so a
      // field missing here does not produce a thinner record; it produces a
      // record that reads complete and is not.
      return {
        kind: "acknowledge-prod",
        runId,
        reason: requireText("reason", input.reason),
        actor: requireText("actor", input.actor),
        instance: requireInstanceRef(input.instance),
        role: requireText("role", input.role),
        cls: requireText("cls", input.cls),
        evidence: requireEvidence(input.evidence),
        surface: requireText("surface", input.surface),
        at,
      };
    }
    case "allow-skipped": {
      // §6a override fact (delegated decision 2026-09-23, TODO~175). The count
      // is the reducer's recomputed one and must match the list it came from:
      // a record where they disagree cannot tell a reader which is the fact.
      const specs = requireSpecRefs(input.specs);
      const affectedRows: unknown = input.affectedRows;
      if (
        typeof affectedRows !== "number" ||
        !Number.isInteger(affectedRows) ||
        affectedRows < 0
      ) {
        throw new LedgerError(
          "protocol",
          "affectedRows is required and must be a non-negative integer",
        );
      }
      if (affectedRows !== specs.length) {
        throw new LedgerError(
          "protocol",
          `affectedRows (${affectedRows}) must equal the number of flipped specs (${specs.length})`,
        );
      }
      return {
        kind: "allow-skipped",
        runId,
        actor: requireText("actor", input.actor),
        surface: requireText("surface", input.surface),
        affectedRows,
        specs,
        verdictStatus: requireText("verdictStatus", input.verdictStatus),
        at,
      };
    }
    default: {
      // Unreachable through the typed surface, reachable from JavaScript. The
      // writer refuses a kind that `decodeAuditRecord` would later reject
      // rather than committing a line that makes the log read as `corrupt`
      // from that point on.
      throw new LedgerError(
        "protocol",
        `unknown audit kind ${JSON.stringify(
          (input as { kind: unknown }).kind,
        )}; the audit vocabulary is ${AUDIT_KINDS.join(", ")}`,
      );
    }
  }
}

/**
 * QA-25 + §4b: an intent that cannot describe its own undo is refused BEFORE
 * anything is written, because after the write it is too late to invent one.
 */
function validateIntendInput(input: IntendInput): void {
  requireText("instance", input.instance);
  validateWriteShape(input);
}

/**
 * The part of intend-time validation every write-ahead namespace shares — the
 * run ledger and the per-host infra ledger (infra.ts) refuse exactly the same
 * uncompensatable or unprobeable intents.
 */
export function validateWriteShape(input: {
  intent: string;
  idempotencyKey: string;
  target: { table: string; sysId?: string };
  compensation: CompensationOp;
  probe?: ProbeDescriptor;
}): void {
  requireText("intent", input.intent);
  requireText("idempotencyKey", input.idempotencyKey);
  if (typeof input.target !== "object" || input.target === null) {
    throw new LedgerError(
      "protocol",
      "target is required and must be an object",
    );
  }
  requireText("target.table", input.target.table);
  // Delegated decision 2026-09-25: an empty sys_id is refused, never written —
  // the decoder reads "" as damage, not as "unknown".
  optionalSysId("target.sysId", input.target.sysId);

  const compensation: unknown = input.compensation;
  if (typeof compensation !== "object" || compensation === null) {
    throw new LedgerError(
      "protocol",
      "compensation is required and must be an object (§4b)",
    );
  }
  const op = input.compensation;
  switch (op.op) {
    case "delete": {
      requireText("compensation.table", op.table);
      optionalSysId("compensation.sysId", op.sysId);
      if (
        op.sysId === undefined &&
        input.target.sysId === undefined &&
        input.probe === undefined
      ) {
        // QA-25: a create whose probe descriptor cannot be expressed is refused
        // at intend time, never written blind — otherwise a W2 crash leaves a
        // record that nothing can ever find, let alone delete.
        throw new LedgerError(
          "protocol",
          "a create with no sys_id must carry a probe descriptor (QA-25); it is refused at intend time rather than written blind",
        );
      }
      break;
    }
    case "restore": {
      requireText("compensation.table", op.table);
      requireText("compensation.sysId", op.sysId);
      // Delegated decision 2026-09-25: a restore without its snapshot cannot
      // restore anything, and the decoder rejects it — refuse at intend time.
      const fields: unknown = op.fields;
      if (
        typeof fields !== "object" ||
        fields === null ||
        Array.isArray(fields)
      ) {
        throw new LedgerError(
          "protocol",
          "a restore compensation must carry its fields snapshot as an object (§4b)",
        );
      }
      break;
    }
    case "none": {
      // §4b: an uncompensatable write is a decision, never an omission.
      requireText("compensation.reason", op.reason);
      break;
    }
    default: {
      // Unreachable through the typed surface, reachable from JavaScript.
      throw new LedgerError(
        "protocol",
        `unknown compensation op ${JSON.stringify(
          (op as { op: unknown }).op,
        )}; expected delete, restore or none (§4b)`,
      );
    }
  }

  if (input.probe !== undefined) {
    requireText("probe.table", input.probe.table);
    requireText("probe.query", input.probe.query);
    // Delegated decision 2026-09-25: the probe key is a closed vocabulary; one
    // the decoder does not know is refused rather than written.
    const key: unknown = input.probe.key;
    if (!PROBE_KEYS.some((known) => known === key)) {
      throw new LedgerError(
        "protocol",
        `probe.key ${JSON.stringify(key)} is not one of ${PROBE_KEYS.join(", ")} (QA-25)`,
      );
    }
  }
}

function isCreate(entry: LedgerWriteRecord): boolean {
  return entry.compensation.op === "delete";
}

export function createIntentLedger(options: IntentLedgerOptions): IntentLedger {
  const rootDir = path.resolve(requireText("rootDir", options.rootDir));
  const runsDir = path.join(rootDir, RUNS_DIRNAME);
  const auditFile = path.join(rootDir, AUDIT_LOG_FILENAME);
  const clock = options.now ?? ((): Date => new Date());

  /**
   * Each log's uncommitted tail is repaired once per process, before this
   * instance's first append to it. Doing it lazily (rather than in a factory
   * `init`) keeps the factory synchronous and means a read-only consumer never
   * writes to the ledger at all.
   */
  const repairedLogs = new Set<string>();

  /**
   * In-process serialization per run (and for the audit log). `seq` allocation
   * is read-then-append, so two concurrent `intend()` calls in one process would
   * otherwise race for the same number.
   *
   * SEAM (Phase 4): this does NOT serialize across processes. §4b assigns one
   * run to one owning process and the sweep re-reads instance-side state before
   * acting; a cross-process lock (and the ARCH-8 multi-instance ledger-store
   * ownership question) is Phase 4's.
   */
  const locks = new Map<string, Promise<unknown>>();

  function withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  function timestamp(): string {
    return clock().toISOString();
  }

  function runDir(runId: string): string {
    return path.join(runsDir, runId);
  }

  function runStateFile(runId: string): string {
    return path.join(runDir(runId), RUN_STATE_FILENAME);
  }

  function runLogFile(runId: string): string {
    return path.join(runDir(runId), RUN_LEDGER_FILENAME);
  }

  async function appendRecord(
    file: string,
    record: LedgerLogLine,
  ): Promise<void> {
    // Before the tail repair too: a refused record must leave the log
    // byte-for-byte as it was.
    assertDecodable(`ledger record for ${file}`, record, decodeLogLine);
    if (!repairedLogs.has(file)) {
      // Must precede the first append: writing after a torn tail would splice
      // the new record onto the partial one and move corruption mid-log.
      await repairLogTail(file);
      repairedLogs.add(file);
    }
    await appendLineDurable(file, JSON.stringify(record));
  }

  async function readRunRecord(
    runId: string,
  ): Promise<RunStateRecord | undefined> {
    const file = runStateFile(runId);
    const raw = await readTextFile(file);
    if (raw === undefined) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // run.json is only ever replaced atomically, so a partial one is
      // impossible — anything unreadable here is real damage, not a crash tail.
      // The parser's own words ride along so the operator knows WHY
      // (delegated decision 2026-09-26: make the corrupt stop actionable).
      const why = error instanceof Error ? error.message : String(error);
      throw new LedgerError(
        "corrupt",
        `${file} is not a valid run record: not valid JSON (${why})`,
      );
    }
    const record = decodeRunStateRecord(parsed);
    if (record === null) {
      throw new LedgerError(
        "corrupt",
        `${file} is not a valid run record: valid JSON, but not the RunStateRecord shape`,
      );
    }
    if (record.runId !== runId) {
      // Delegated decision 2026-09-25: the directory name and the record must
      // agree. A mismatch means two ids resolved to one directory (a
      // case-insensitive filesystem) or the file was moved/edited — either
      // way this record does not belong to the run asked for.
      throw new LedgerError(
        "corrupt",
        `${file} belongs to run ${JSON.stringify(record.runId)}, not ${JSON.stringify(runId)}`,
      );
    }
    return record;
  }

  async function requireRunRecord(runId: string): Promise<RunStateRecord> {
    const record = await readRunRecord(runId);
    if (record === undefined) {
      throw new LedgerError(
        "run-not-found",
        `run ${runId} has no state record under ${runsDir}; open it before writing`,
      );
    }
    return record;
  }

  async function saveRunRecord(
    record: RunStateRecord,
  ): Promise<RunStateRecord> {
    const next: RunStateRecord = { ...record, updatedAt: timestamp() };
    assertDecodable(`run record ${next.runId}`, next, decodeRunStateRecord);
    await writeJsonAtomic(runStateFile(next.runId), next);
    return next;
  }

  async function readEntries(runId: string): Promise<LedgerWriteRecord[]> {
    const file = runLogFile(runId);
    const lines = parseLogRecords(
      file,
      await readLogLines(file),
      decodeLogLine,
    );
    return foldRunLog(file, runId, lines);
  }

  function requireEntry(
    runId: string,
    entries: readonly LedgerWriteRecord[],
    seq: number,
  ): LedgerWriteRecord {
    const entry = entries.find((candidate) => candidate.seq === seq);
    if (entry === undefined) {
      throw new LedgerError(
        "protocol",
        `run ${runId} has no ledger entry #${seq}`,
      );
    }
    return entry;
  }

  /** Append a state flip, refresh run freshness, and return the folded entry. */
  async function flipEntry(
    runId: string,
    run: RunStateRecord,
    line: LedgerStateLine,
  ): Promise<LedgerWriteRecord> {
    await appendRecord(runLogFile(runId), line);
    await saveRunRecord(run);
    return requireEntry(runId, await readEntries(runId), line.seq);
  }

  /**
   * The ONE audit write path. Synchronous end to end, and that is what makes
   * it one: with no `await` between the tail repair and the append, no second
   * caller can interleave, so there is nothing here to serialize. The
   * `withLock` that used to wrap this — keyed on a string no run id could
   * equal — went away with the yield points it existed to order.
   */
  function appendAuditImpl(input: LedgerAuditInput): LedgerAuditRecord {
    // Delegated decision 2026-09-25: a caller-supplied `at` must be a
    // non-empty string that parses as a date. `""` (or a non-string) decodes
    // to null, which hides the record while it is last and turns the log
    // `corrupt` on the very next append.
    const at: unknown = input.at === undefined ? timestamp() : input.at;
    if (
      typeof at !== "string" ||
      at.length === 0 ||
      Number.isNaN(Date.parse(at))
    ) {
      throw new LedgerError(
        "protocol",
        `at must be a non-empty date-time string (got ${JSON.stringify(at)})`,
      );
    }
    const record = buildAuditRecord(input, at);
    assertDecodable("audit record", record, decodeAuditRecord);
    // Deliberately not gated on an existing run record: an audit fact is
    // retention-independent (ARCH-43) and must survive even if the run
    // directory is later swept.
    ensureDirSync(rootDir);
    if (!repairedLogs.has(auditFile)) {
      // Must precede the first append: writing after a torn tail would splice
      // the new record onto the partial one and move corruption mid-log.
      repairLogTailSync(auditFile);
      repairedLogs.add(auditFile);
    }
    appendLineDurableSync(auditFile, JSON.stringify(record));
    return record;
  }

  return {
    async openRun(input: OpenRunInput): Promise<RunStateRecord> {
      const runId = validateRunId(input.runId);
      requireText("scope", input.scope);
      requireText("runner", input.runner);
      requireText("lifecycle", input.lifecycle);
      const pid: unknown = input.pid;
      if (
        pid !== undefined &&
        (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0)
      ) {
        // Delegated decision 2026-09-25: `decodeRunStateRecord` rejects a
        // non-integer pid, so writing one would poison run.json for good.
        throw new LedgerError(
          "protocol",
          `pid must be a non-negative integer when given (got ${JSON.stringify(pid)})`,
        );
      }

      /** §4b concurrency: an MCP host retry resolves to the existing run. */
      function resolveExisting(existing: RunStateRecord): RunStateRecord {
        if (
          existing.scope !== input.scope ||
          existing.runner !== input.runner ||
          existing.lifecycle !== input.lifecycle
        ) {
          throw new LedgerError(
            "run-exists",
            `run ${runId} is already open as scope=${existing.scope} runner=${existing.runner} lifecycle=${existing.lifecycle}; a retry must repeat the original parameters`,
          );
        }
        return existing;
      }

      return withLock(runId, async () => {
        const existing = await readRunRecord(runId);
        if (existing !== undefined) {
          return resolveExisting(existing);
        }

        const at = timestamp();
        const record: RunStateRecord = {
          runId,
          state: "planned",
          scope: input.scope,
          runner: input.runner,
          lifecycle: input.lifecycle,
          startedAt: at,
          updatedAt: at,
          pid: input.pid,
          // Delegated decision 2026-09-25: marks this record as kept by a
          // ledger that stamps `runningAt`, so its absence is evidence.
          tracksRunning: true,
        };
        assertDecodable(`run record ${runId}`, record, decodeRunStateRecord);
        await ensureDir(runDir(runId));
        // Delegated decision 2026-09-25: the FIRST run.json is created
        // exclusively. `withLock` only serializes this process; a second
        // ledger instance (another process) may have passed the read above
        // too. Whoever loses the create re-reads the winner's record and
        // goes through the same retry/`run-exists` comparison, so two
        // different opens of one id can never both succeed.
        if (await writeJsonExclusive(runStateFile(runId), record)) {
          return record;
        }
        const winner = await readRunRecord(runId);
        if (winner === undefined) {
          throw new LedgerError(
            "corrupt",
            `${runStateFile(runId)} existed at create time and is gone now`,
          );
        }
        return resolveExisting(winner);
      });
    },

    async readRun(runId: RunId): Promise<RunStateRecord | undefined> {
      return await readRunRecord(validateRunId(runId));
    },

    async listRuns(): Promise<RunStateRecord[]> {
      const ids = (await listDirectories(runsDir)).sort();
      const runs: RunStateRecord[] = [];
      for (const id of ids) {
        if (!RUN_ID_PATTERN.test(id)) {
          continue;
        }
        const record = await readRunRecord(id);
        if (record !== undefined) {
          runs.push(record);
        }
      }
      return runs;
    },

    async transition(runId: RunId, to: RunState): Promise<RunStateRecord> {
      const id = validateRunId(runId);
      return withLock(id, async () => {
        const run = await requireRunRecord(id);
        if (run.state === to) {
          // Re-asserting the current state is a no-op so a replayed cleanup
          // converges instead of failing on its second pass.
          return run;
        }
        assertLegalRunTransition(run.state, to);
        if (
          run.state === "planned" &&
          to === "done" &&
          run.lifecycle !== "repo-only"
        ) {
          // The only `planned → done` edge is the §4a repo-only short-circuit.
          throw new LedgerError(
            "illegal-transition",
            `run ${id}: planned → done is the repo-only short-circuit (§4a); a ${run.lifecycle} run must reach done through tearing-down`,
          );
        }
        // Delegated decision 2026-09-25: `runningAt` is write-once. The
        // spread carries an earlier stamp through every later edge; only the
        // FIRST entry into `running` sets it, and nothing ever clears it.
        return await saveRunRecord({
          ...run,
          state: to,
          ...(to === "running" && run.runningAt === undefined
            ? { runningAt: timestamp() }
            : {}),
        });
      });
    },

    async touch(runId: RunId): Promise<RunStateRecord> {
      const id = validateRunId(runId);
      return withLock(
        id,
        async () => await saveRunRecord(await requireRunRecord(id)),
      );
    },

    async intend(input: IntendInput): Promise<LedgerWriteRecord> {
      const runId = validateRunId(input.runId);
      validateIntendInput(input);

      return withLock(runId, async () => {
        const run = await requireRunRecord(runId);
        if (isTerminalRunState(run.state)) {
          throw new LedgerError(
            "protocol",
            `run ${runId} is ${run.state} (terminal); no further writes may be intended (§4b)`,
          );
        }
        if (run.state === "planned") {
          throw new LedgerError(
            "protocol",
            `run ${runId} is still planned, which does reads only (§4b); transition to provisioning before the first write`,
          );
        }

        const entries = await readEntries(runId);
        const duplicate = entries.find(
          (candidate) => candidate.idempotencyKey === input.idempotencyKey,
        );
        if (duplicate !== undefined) {
          // §4b concurrency: a retried call re-uses the entry it already made
          // durable rather than intending the same write twice.
          return duplicate;
        }

        const seq =
          entries.reduce((max, candidate) => Math.max(max, candidate.seq), 0) +
          1;
        const record: LedgerWriteRecord = {
          kind: "write",
          seq,
          runId,
          instance: input.instance,
          intent: input.intent,
          target: { table: input.target.table, sysId: input.target.sysId },
          compensation: input.compensation,
          state: "intended",
          idempotencyKey: input.idempotencyKey,
          probe: input.probe,
        };
        // §4b step 1: durable BEFORE the caller's HTTP request leaves the
        // process. appendRecord only resolves after fsync, so the awaiting
        // caller cannot issue the write until the intent survives a crash.
        await appendRecord(runLogFile(runId), record);
        await saveRunRecord(run);
        // Return what the LOG now says, not the in-memory draft: a caller must
        // never see a field that a restarted process would not (a retry gets
        // the re-read entry, and the two have to compare equal).
        return requireEntry(runId, await readEntries(runId), seq);
      });
    },

    async confirm(
      runId: RunId,
      seq: number,
      result?: { sysId?: string },
    ): Promise<LedgerWriteRecord> {
      const id = validateRunId(runId);
      // Delegated decision 2026-09-25: "" is not a sys_id; refused, not written.
      optionalSysId("result.sysId", result?.sysId);
      return withLock(id, async () => {
        const run = await requireRunRecord(id);
        const entry = requireEntry(id, await readEntries(id), seq);
        const sysId = result?.sysId;

        if (entry.state === "applied") {
          if (
            sysId !== undefined &&
            entry.target.sysId !== undefined &&
            entry.target.sysId !== sysId
          ) {
            throw new LedgerError(
              "protocol",
              `entry #${seq} of run ${id} is already applied as ${entry.target.sysId}; confirming ${sysId} would mean two records were created`,
            );
          }
          return entry;
        }
        if (entry.state === "compensated") {
          throw new LedgerError(
            "protocol",
            `entry #${seq} of run ${id} is already compensated and cannot be confirmed (§4b)`,
          );
        }
        if (
          isCreate(entry) &&
          sysId === undefined &&
          entry.target.sysId === undefined
        ) {
          throw new LedgerError(
            "protocol",
            `entry #${seq} of run ${id} is a create; confirm must supply its sys_id or the compensation can never delete it (§4b step 3)`,
          );
        }

        return await flipEntry(id, run, {
          kind: "state",
          seq,
          state: "applied",
          sysId,
        });
      });
    },

    async compensate(
      runId: RunId,
      seq: number,
      result?: { sysId?: string },
    ): Promise<LedgerWriteRecord> {
      const id = validateRunId(runId);
      // Delegated decision 2026-09-25: "" is not a sys_id; refused, not written.
      optionalSysId("result.sysId", result?.sysId);
      return withLock(id, async () => {
        const run = await requireRunRecord(id);
        const entry = requireEntry(id, await readEntries(id), seq);
        if (entry.state === "compensated") {
          // Idempotent by design: `tess cleanup --run` twice is a no-op (§4b).
          return entry;
        }
        return await flipEntry(id, run, {
          kind: "state",
          seq,
          state: "compensated",
          sysId: result?.sysId,
        });
      });
    },

    async entries(runId: RunId): Promise<LedgerWriteRecord[]> {
      const id = validateRunId(runId);
      await requireRunRecord(id);
      return await readEntries(id);
    },

    async recover(runId: RunId): Promise<RecoveryPlan> {
      const id = validateRunId(runId);
      const run = await requireRunRecord(id);
      const entries = await readEntries(id);
      const orphans = entries.filter((entry) => entry.state === "intended");
      const applied = entries.filter((entry) => entry.state === "applied");
      // DEV-13/ARCH-37: reverse `seq` IS the pinned teardown order — links
      // before steps before test before suite before data/users — because the
      // projector's write order is constrained to make that true.
      const teardownOrder = [...orphans, ...applied].sort(
        (a, b) => b.seq - a.seq,
      );
      return {
        run,
        orphans,
        applied,
        teardownOrder,
        orphanDisposition:
          run.lifecycle === "persistent" ? "adopt" : "compensate",
      };
    },

    async scan(options?: { ttlMs?: number }): Promise<RunScanEntry[]> {
      const ttlMs = options?.ttlMs;
      const nowMs = clock().getTime();
      const ids = (await listDirectories(runsDir)).sort();
      const rows: RunScanEntry[] = [];
      // Delegated decision 2026-09-26: a record that will not decode stays a
      // HARD STOP for the scan — the §4b concurrency check cannot vouch for a
      // scope+runner it could not read — and nothing is auto-quarantined or
      // renamed, because that would mutate evidence. The stop is made
      // actionable instead: the scan keeps going past the first corrupt
      // record so the refusal names every offender (id, file, why), bounded
      // at CORRUPT_REPORT_LIMIT, in one go. Only `corrupt` is collected; any
      // other error (EACCES, EIO, ...) still propagates at once (DEV-1).
      const corrupt: CorruptRecordReport[] = [];
      let corruptTotal = 0;
      const noteCorrupt = (
        runId: string,
        file: string,
        error: unknown,
      ): void => {
        if (!(error instanceof LedgerError) || error.code !== "corrupt") {
          throw error;
        }
        corruptTotal += 1;
        if (corrupt.length < CORRUPT_REPORT_LIMIT) {
          // The reader's messages lead with the file; it has its own field.
          const reason = error.message.startsWith(file)
            ? error.message.slice(file.length).replace(/^:?\s+/, "")
            : error.message;
          corrupt.push({ runId, path: file, reason });
        }
      };
      for (const id of ids) {
        if (!RUN_ID_PATTERN.test(id)) {
          continue;
        }
        let run: RunStateRecord | undefined;
        try {
          run = await readRunRecord(id);
        } catch (error) {
          noteCorrupt(id, runStateFile(id), error);
          continue;
        }
        // Skipped — but note exactly what was OBSERVED. `readRunRecord`
        // returns undefined only for ENOENT (`readTextFile` rethrows every
        // other errno) and throws `corrupt` for a run.json that will not
        // decode, so the observation is "there is no run.json here" and
        // nothing more. The expected cause is a crash between mkdir and the
        // first atomic write, and in that case nothing was ever intended
        // under the directory — but this loop never opens `ledger.jsonl`, so
        // a directory that HAS intents and lost its state record reads
        // identically here and is skipped just the same. The expected cause
        // is not a finding; do not write it down as one.
        if (run === undefined || isTerminalRunState(run.state)) {
          continue;
        }
        let entries: LedgerWriteRecord[];
        try {
          entries = await readEntries(id);
        } catch (error) {
          noteCorrupt(id, runLogFile(id), error);
          continue;
        }
        const updatedAtMs = Date.parse(run.updatedAt);
        const ageMs = Number.isNaN(updatedAtMs)
          ? 0
          : Math.max(0, nowMs - updatedAtMs);
        rows.push({
          run,
          ageMs,
          stale: ttlMs !== undefined && ageMs > ttlMs,
          orphanCount: entries.filter((entry) => entry.state === "intended")
            .length,
          pendingCount: entries.filter((entry) => entry.state !== "compensated")
            .length,
        });
      }
      if (corruptTotal > 0) {
        const more = corruptTotal - corrupt.length;
        throw new LedgerError(
          "corrupt",
          `${corruptTotal} corrupt run record(s) under ${runsDir}; the §4b scan ` +
            `(and the concurrency check that relies on it) refuses to guess past them:\n` +
            corrupt
              .map(
                (record) =>
                  `  - run ${JSON.stringify(record.runId)}: ${record.path} — ${record.reason}`,
              )
              .join("\n") +
            (more > 0 ? `\n  - ... and ${more} more not listed` : ""),
          { records: corrupt, total: corruptTotal },
        );
      }
      return rows;
    },

    appendAuditSync(input: LedgerAuditInput): LedgerAuditRecord {
      return appendAuditImpl(input);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async appendAudit(input: LedgerAuditInput): Promise<LedgerAuditRecord> {
      // `async` with a wholly synchronous body, deliberately, and the lint is
      // silenced rather than satisfied. The body has to run to completion on
      // the CALLER's tick — so the record is on disk before the promise is
      // even handed back — while the published contract is that a refusal
      // arrives as a rejection, not as a synchronous throw. Only an `async`
      // function containing no `await` has both. Introducing one would give
      // this method a write path of its own, which is the split this file
      // exists to have closed.
      return appendAuditImpl(input);
    },

    async readAudit(): Promise<LedgerAuditRecord[]> {
      return parseLogRecords(
        auditFile,
        await readLogLines(auditFile),
        decodeAuditRecord,
      );
    },
  };
}
