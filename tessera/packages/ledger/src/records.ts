// On-disk encoding and validation for the append-only run ledger (§4b).
//
// The log is an append-only EVENT log: a `write` line opens an entry in state
// `intended`, and every later `state` line flips that entry. Folding the lines
// yields the §4b `LedgerWriteRecord` values. Recording flips as new lines rather
// than rewriting the entry is what keeps the log append-only — the property both
// crash windows depend on, since a rewrite has a window in which the entry is
// neither the old record nor the new one.
//
// Everything read off disk is untrusted input: a decoder returns `null` for a
// record it cannot vouch for, and the caller decides whether that is a tolerable
// uncommitted tail or real corruption.

import { LedgerError } from "./errors.js";
import { isLegalEntryTransition } from "./stateMachine.js";
import type { LogLines } from "./durability.js";
import type {
  AuditEvidenceSignal,
  AuditInstanceRef,
  AuditSpecRef,
  CompensationOp,
  LedgerAuditRecord,
  LedgerEntryState,
  LedgerInfraWriteRecord,
  LedgerWriteRecord,
  PersistedRunResult,
  ProbeDescriptor,
  RunEvent,
  RunLifecycle,
  RunStateRecord,
} from "./types.js";
import { AUDIT_KINDS, RUN_STATES } from "./types.js";

/** A `state` flip line — the append-only form of "entry N is now applied". */
export interface LedgerStateLine {
  kind: "state";
  seq: number;
  state: "applied" | "compensated";
  /** Confirmed sys_id for a create (§4b step 3), or one the W2 probe recovered. */
  sysId?: string;
}

export type LedgerLogLine = LedgerWriteRecord | LedgerStateLine;

/** The infra namespace's event log: the same `state` flips over `infra-write`. */
export type InfraLogLine = LedgerInfraWriteRecord | LedgerStateLine;

const ENTRY_STATES: readonly LedgerEntryState[] = [
  "intended",
  "applied",
  "compensated",
];

const FLIP_STATES: readonly LedgerStateLine["state"][] = [
  "applied",
  "compensated",
];

const LIFECYCLES: readonly RunLifecycle[] = [
  "ephemeral",
  "persistent",
  "repo-only",
];

export const PROBE_KEYS: readonly ProbeDescriptor["key"][] = [
  "run-id-prefix",
  "parent-keyed",
  "natural-key",
];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty string, or `undefined` — an empty identifier is never meaningful here. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Distinguishes "absent" (fine) from "present but not a usable string" (invalid). */
function optionalText(value: unknown): { ok: boolean; value?: string } {
  if (value === undefined) {
    return { ok: true };
  }
  const parsed = text(value);
  return parsed === undefined ? { ok: false } : { ok: true, value: parsed };
}

function oneOf<T extends string>(
  allowed: readonly T[],
  value: unknown,
): T | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const candidate = value;
  return allowed.find((member) => member === candidate);
}

function isSeq(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Narrows to a readonly array so elements arrive as `unknown`, never `any`. */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function decodeInstanceRef(value: unknown): AuditInstanceRef | null {
  if (!isObject(value)) {
    return null;
  }
  const name = text(value.name);
  const host = text(value.host);
  return name === undefined || host === undefined ? null : { name, host };
}

/**
 * §11.4 evidence. The reader's half of `requireEvidence` (ledger.ts) and it
 * has to agree with it: an empty array is legal, a malformed element is not.
 */
function decodeEvidence(value: unknown): AuditEvidenceSignal[] | null {
  if (!isArray(value)) {
    return null;
  }
  const signals: AuditEvidenceSignal[] = [];
  for (const element of value) {
    if (!isObject(element)) {
      return null;
    }
    const kind = text(element.kind);
    const effect = text(element.effect);
    const detail = text(element.detail);
    if (kind === undefined || effect === undefined || detail === undefined) {
      return null;
    }
    signals.push({ kind, effect, detail });
  }
  return signals;
}

/** The reader's half of `requireSpecRefs` (ledger.ts). */
function decodeSpecRefs(value: unknown): AuditSpecRef[] | null {
  if (!isArray(value)) {
    return null;
  }
  const specs: AuditSpecRef[] = [];
  for (const element of value) {
    if (!isObject(element)) {
      return null;
    }
    const id = text(element.id);
    const path = text(element.path);
    if (id === undefined || path === undefined) {
      return null;
    }
    specs.push({ id, path });
  }
  return specs;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function decodeTarget(
  value: unknown,
): { table: string; sysId?: string } | null {
  if (!isObject(value)) {
    return null;
  }
  const table = text(value.table);
  const sysId = optionalText(value.sysId);
  if (table === undefined || !sysId.ok) {
    return null;
  }
  return { table, sysId: sysId.value };
}

function decodeCompensation(value: unknown): CompensationOp | null {
  if (!isObject(value)) {
    return null;
  }
  const op = oneOf(["delete", "restore", "none"] as const, value.op);
  if (op === "delete") {
    const table = text(value.table);
    const sysId = optionalText(value.sysId);
    return table !== undefined && sysId.ok
      ? { op: "delete", table, sysId: sysId.value }
      : null;
  }
  if (op === "restore") {
    const table = text(value.table);
    const sysId = text(value.sysId);
    if (table === undefined || sysId === undefined || !isObject(value.fields)) {
      return null;
    }
    return { op: "restore", table, sysId, fields: value.fields };
  }
  if (op === "none") {
    const reason = text(value.reason);
    return reason === undefined ? null : { op: "none", reason };
  }
  return null;
}

function decodeProbe(value: unknown): ProbeDescriptor | null {
  if (!isObject(value)) {
    return null;
  }
  const table = text(value.table);
  const query = text(value.query);
  const key = oneOf(PROBE_KEYS, value.key);
  if (table === undefined || query === undefined || key === undefined) {
    return null;
  }
  return { table, query, key };
}

export function decodeLogLine(value: unknown): LedgerLogLine | null {
  if (!isObject(value)) {
    return null;
  }

  const kind = oneOf(["write", "state"] as const, value.kind);

  if (kind === "state") {
    const state = oneOf(FLIP_STATES, value.state);
    const sysId = optionalText(value.sysId);
    if (!isSeq(value.seq) || state === undefined || !sysId.ok) {
      return null;
    }
    return { kind: "state", seq: value.seq, state, sysId: sysId.value };
  }

  if (kind !== "write") {
    return null;
  }
  const runId = text(value.runId);
  const instance = text(value.instance);
  const intent = text(value.intent);
  const idempotencyKey = text(value.idempotencyKey);
  const target = decodeTarget(value.target);
  const compensation = decodeCompensation(value.compensation);
  const state = oneOf(ENTRY_STATES, value.state);
  const probe =
    value.probe === undefined ? undefined : decodeProbe(value.probe);
  if (
    !isSeq(value.seq) ||
    runId === undefined ||
    instance === undefined ||
    intent === undefined ||
    idempotencyKey === undefined ||
    target === null ||
    compensation === null ||
    state === undefined ||
    probe === null
  ) {
    return null;
  }
  return {
    kind: "write",
    seq: value.seq,
    runId,
    instance,
    intent,
    target,
    compensation,
    state,
    idempotencyKey,
    probe,
  };
}

export function decodeAuditRecord(value: unknown): LedgerAuditRecord | null {
  if (!isObject(value)) {
    return null;
  }
  // The accept-list is `AUDIT_KINDS` (types.ts), NOT a literal repeated here.
  // This list and the `LedgerAuditRecord`/`LedgerAuditInput` unions are one
  // fact, and both are generated from one const; while the fact was stored
  // twice they could drift into a writer that accepts a kind this reader then
  // rejects as `corrupt`. Do not inline it back.
  //
  // Closed on purpose — see `LedgerAuditRecord`. Anything else, including a
  // record written by a foreign or older writer, decodes to null and is treated
  // as corruption everywhere but the final line.
  const kind = oneOf(AUDIT_KINDS, value.kind);
  const runId = text(value.runId);
  const at = text(value.at);
  if (kind === undefined || runId === undefined || at === undefined) {
    return null;
  }
  if (kind === "token-consumed") {
    const verdictHash = text(value.verdictHash);
    return verdictHash === undefined ? null : { kind, runId, verdictHash, at };
  }
  if (kind === "allow-skipped") {
    // §6a override fact (delegated decision 2026-09-23). Same rule as the
    // writer: every field required, and `affectedRows` must agree with the
    // spec list — a record whose count and list disagree cannot say which
    // of the two is the fact.
    const actor = text(value.actor);
    const surface = text(value.surface);
    const specs = decodeSpecRefs(value.specs);
    const verdictStatus = text(value.verdictStatus);
    if (
      actor === undefined ||
      surface === undefined ||
      specs === null ||
      verdictStatus === undefined ||
      !isCount(value.affectedRows) ||
      value.affectedRows !== specs.length
    ) {
      return null;
    }
    return {
      kind,
      runId,
      actor,
      surface,
      affectedRows: value.affectedRows,
      specs,
      verdictStatus,
      at,
    };
  }
  // `acknowledge-prod` carries the WHOLE §11.4 fact (types.ts `AuditPayloads`),
  // so every field below is required here too. A record carrying only
  // `{ reason, actor }` is not a thinner audit record — it is the old split,
  // where the rest of the event lived in a second file — and it decodes to
  // null rather than being handed to a reader as a complete one.
  const reason = text(value.reason);
  const actor = text(value.actor);
  const instance = decodeInstanceRef(value.instance);
  const role = text(value.role);
  const cls = text(value.cls);
  const evidence = decodeEvidence(value.evidence);
  const surface = text(value.surface);
  if (
    reason === undefined ||
    actor === undefined ||
    instance === null ||
    role === undefined ||
    cls === undefined ||
    evidence === null ||
    surface === undefined
  ) {
    return null;
  }
  return {
    kind,
    runId,
    reason,
    actor,
    instance,
    role,
    cls,
    evidence,
    surface,
    at,
  };
}

/**
 * One line of an infra namespace log (`<root>/infra/<host>/ledger.jsonl`):
 * an `infra-write` opening an entry, or the shared `state` flip.
 */
export function decodeInfraLogLine(value: unknown): InfraLogLine | null {
  if (!isObject(value)) {
    return null;
  }
  if (value.kind === "state") {
    const flip = decodeLogLine(value);
    return flip !== null && flip.kind === "state" ? flip : null;
  }
  if (value.kind !== "infra-write") {
    return null;
  }
  const planHash = text(value.planHash);
  const host = text(value.host);
  const intent = text(value.intent);
  const idempotencyKey = text(value.idempotencyKey);
  const intendedAt = text(value.intendedAt);
  const target = decodeTarget(value.target);
  const compensation = decodeCompensation(value.compensation);
  const state = oneOf(ENTRY_STATES, value.state);
  const probe =
    value.probe === undefined ? undefined : decodeProbe(value.probe);
  if (
    !isSeq(value.seq) ||
    planHash === undefined ||
    host === undefined ||
    intent === undefined ||
    idempotencyKey === undefined ||
    intendedAt === undefined ||
    target === null ||
    compensation === null ||
    state === undefined ||
    probe === null
  ) {
    return null;
  }
  return {
    kind: "infra-write",
    planHash,
    target,
    compensation,
    state,
    seq: value.seq,
    host,
    intent,
    idempotencyKey,
    probe,
    intendedAt,
  };
}

/** One `events.jsonl` line (§6b / QA-29). */
export function decodeRunEvent(value: unknown): RunEvent | null {
  if (!isObject(value)) {
    return null;
  }
  const runId = text(value.runId);
  const type = text(value.type);
  const at = text(value.at);
  if (
    !isSeq(value.cursor) ||
    runId === undefined ||
    type === undefined ||
    at === undefined
  ) {
    return null;
  }
  const event: RunEvent = { cursor: value.cursor, runId, type, at };
  if (value.data !== undefined) {
    event.data = value.data;
  }
  return event;
}

export function decodePersistedRunResult(
  value: unknown,
): PersistedRunResult | null {
  if (!isObject(value) || !("result" in value)) {
    return null;
  }
  const runId = text(value.runId);
  const at = text(value.at);
  if (runId === undefined || at === undefined) {
    return null;
  }
  return { runId, at, result: value.result };
}

export function decodeRunStateRecord(value: unknown): RunStateRecord | null {
  if (!isObject(value)) {
    return null;
  }
  const runId = text(value.runId);
  const scope = text(value.scope);
  const runner = text(value.runner);
  const startedAt = text(value.startedAt);
  const updatedAt = text(value.updatedAt);
  const state = oneOf(RUN_STATES, value.state);
  const lifecycle = oneOf(LIFECYCLES, value.lifecycle);
  const pid = typeof value.pid === "number" ? value.pid : undefined;
  const pidOk = value.pid === undefined || Number.isInteger(pid);
  // Delegated decision 2026-09-25: both fields are optional so a run.json
  // written before they existed still decodes; when present, `runningAt`
  // must be a real timestamp and `tracksRunning` the literal `true` — the
  // pair is what licenses a "never triggered" claim, so neither may be junk.
  const runningAt = text(value.runningAt);
  const runningAtOk =
    value.runningAt === undefined ||
    (runningAt !== undefined && !Number.isNaN(Date.parse(runningAt)));
  const tracksRunningOk =
    value.tracksRunning === undefined || value.tracksRunning === true;
  // Delegated decision 2026-09-26 (N1): a tracking record with no `runningAt`
  // claims "never reached running", and `running`/`collecting` are the only
  // states that PROVE the opposite (collecting is entered only from running,
  // §4b). Such a record is self-contradictory and is refused as corrupt, so a
  // later transition to abandoned/failed cannot launder it into a
  // "never triggered" claim that lets cleanup delete a suite with no result.
  // `tearing-down`, `failed`, `abandoned` and `done` are all reachable without
  // passing `running`, so their absence of `runningAt` proves nothing and they
  // are left alone.
  const provesRunningReached = state === "running" || state === "collecting";
  const runningClaimOk = !(
    value.tracksRunning === true &&
    runningAt === undefined &&
    provesRunningReached
  );
  if (
    !runningClaimOk ||
    !runningAtOk ||
    !tracksRunningOk ||
    runId === undefined ||
    scope === undefined ||
    runner === undefined ||
    startedAt === undefined ||
    updatedAt === undefined ||
    state === undefined ||
    lifecycle === undefined ||
    !pidOk
  ) {
    return null;
  }
  return {
    runId,
    state,
    scope,
    runner,
    lifecycle,
    startedAt,
    updatedAt,
    pid,
    ...(runningAt === undefined ? {} : { runningAt }),
    ...(value.tracksRunning === true ? { tracksRunning: true as const } : {}),
  };
}

/**
 * Decode every committed line, tolerating exactly one thing: an unreadable
 * record at the very END of the log. Anything unreadable before it means the
 * log was damaged by something other than a crash, and silently skipping it
 * would drop an intent — precisely the failure the ledger exists to prevent.
 *
 * The tolerated case is USUALLY the crash residue `repairLogTail` removes on
 * the next append, and the part that is not is worth being exact about.
 * `repairLogTail` cuts a tail that is unterminated or is not parsable JSON —
 * all a `kill -9` can leave. A final line that IS parsable JSON but is not a
 * valid record (a foreign or older writer, a hand edit) survives that repair,
 * and this `break` then returns a list one record short with nothing saying
 * so. It stops being silent on the next append, when the line is no longer
 * last and throws `corrupt`; until then a log whose only line is such a
 * record reads as an EMPTY LOG. That is the `readAudit()` failure mode the
 * `ClosedVocabulary` constraint in types.ts exists to keep out of reach of
 * our own writers.
 */
export function parseLogRecords<T>(
  file: string,
  read: LogLines,
  decode: (value: unknown) => T | null,
): T[] {
  const out: T[] = [];
  const lastIndex = read.lines.length - 1;
  for (let i = 0; i < read.lines.length; i += 1) {
    const line = read.lines[i] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = undefined;
    }
    const decoded = parsed === undefined ? null : decode(parsed);
    if (decoded === null) {
      if (i === lastIndex) {
        break;
      }
      throw new LedgerError(
        "corrupt",
        `${file}: record ${i + 1} of ${read.lines.length} is not a valid ledger record`,
      );
    }
    out.push(decoded);
  }
  return out;
}

function withSysId(
  op: CompensationOp,
  sysId: string | undefined,
): CompensationOp {
  if (sysId === undefined || op.op !== "delete") {
    return op;
  }
  return { op: "delete", table: op.table, sysId };
}

/** Replay the event log into the current `LedgerWriteRecord` per `seq`. */
export function foldRunLog(
  file: string,
  runId: string,
  lines: readonly LedgerLogLine[],
): LedgerWriteRecord[] {
  const bySeq = new Map<number, LedgerWriteRecord>();
  for (const line of lines) {
    if (line.kind === "write") {
      if (line.runId !== runId) {
        throw new LedgerError(
          "corrupt",
          `${file}: entry #${line.seq} belongs to run ${line.runId}, not ${runId}`,
        );
      }
      if (bySeq.has(line.seq)) {
        throw new LedgerError(
          "corrupt",
          `${file}: duplicate ledger entry #${line.seq}`,
        );
      }
      if (line.state !== "intended") {
        throw new LedgerError(
          "corrupt",
          `${file}: entry #${line.seq} was appended in state ${line.state}; every entry opens as intended (§4b)`,
        );
      }
      bySeq.set(line.seq, line);
      continue;
    }

    const current = bySeq.get(line.seq);
    if (current === undefined) {
      throw new LedgerError(
        "corrupt",
        `${file}: state line for unknown ledger entry #${line.seq}`,
      );
    }
    if (!isLegalEntryTransition(current.state, line.state)) {
      throw new LedgerError(
        "corrupt",
        `${file}: entry #${line.seq} cannot go ${current.state} → ${line.state} (§4b)`,
      );
    }
    bySeq.set(line.seq, {
      kind: "write",
      seq: current.seq,
      runId: current.runId,
      instance: current.instance,
      intent: current.intent,
      target:
        line.sysId === undefined
          ? current.target
          : { ...current.target, sysId: line.sysId },
      compensation: withSysId(current.compensation, line.sysId),
      state: line.state,
      idempotencyKey: current.idempotencyKey,
      probe: current.probe,
    });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/**
 * Replay an infra namespace log into its current entries per `seq` — the
 * infra twin of `foldRunLog`, with the same corruption rules plus one: every
 * entry must belong to the namespace's host, and no idempotency key may open
 * two entries (the host-scoped dedupe is a property of the LOG, so a log that
 * breaks it is damaged, not merely surprising).
 */
export function foldInfraLog(
  file: string,
  host: string,
  lines: readonly InfraLogLine[],
): LedgerInfraWriteRecord[] {
  const bySeq = new Map<number, LedgerInfraWriteRecord>();
  const keys = new Set<string>();
  for (const line of lines) {
    if (line.kind === "infra-write") {
      // Case-folded on both sides (delegated decision 2026-09-25, infra.ts
      // `validateHost`): DNS names are case-insensitive.
      if (line.host.toLowerCase() !== host.toLowerCase()) {
        throw new LedgerError(
          "corrupt",
          `${file}: entry #${line.seq} belongs to host ${line.host}, not ${host}`,
        );
      }
      if (bySeq.has(line.seq)) {
        throw new LedgerError(
          "corrupt",
          `${file}: duplicate infra entry #${line.seq}`,
        );
      }
      if (keys.has(line.idempotencyKey)) {
        throw new LedgerError(
          "corrupt",
          `${file}: idempotency key ${JSON.stringify(line.idempotencyKey)} opens two entries`,
        );
      }
      if (line.state !== "intended") {
        throw new LedgerError(
          "corrupt",
          `${file}: entry #${line.seq} was appended in state ${line.state}; every entry opens as intended (§4b)`,
        );
      }
      keys.add(line.idempotencyKey);
      bySeq.set(line.seq, line);
      continue;
    }

    const current = bySeq.get(line.seq);
    if (current === undefined) {
      throw new LedgerError(
        "corrupt",
        `${file}: state line for unknown infra entry #${line.seq}`,
      );
    }
    if (!isLegalEntryTransition(current.state, line.state)) {
      throw new LedgerError(
        "corrupt",
        `${file}: entry #${line.seq} cannot go ${current.state} → ${line.state} (§4b)`,
      );
    }
    bySeq.set(line.seq, {
      ...current,
      target:
        line.sysId === undefined
          ? current.target
          : { ...current.target, sysId: line.sysId },
      compensation: withSysId(current.compensation, line.sysId),
      state: line.state,
    });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
