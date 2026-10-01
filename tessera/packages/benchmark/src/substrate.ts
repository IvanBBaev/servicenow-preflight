// The instance `BenchmarkSubstrate` adapter (DESIGN §13.4 SUB-1..SUB-5).
//
// Mirrors `@tessera/teststore-atf`'s `client.ts` seam: `@tessera/sn-client`
// exposes no client *object*, only the free function `snRequest`, so this
// module declares a narrow port (`BenchmarkHttpClient`) and ships the live
// adapter over `snRequest` next to it. Tests bind the port to
// `@tessera/fake-instance`; production binds it to the real transport. The
// substrate never imports `snRequest` directly, and it never calls
// `assertTableWritable`/`assertTableAllowed` itself — those guards already run
// at the transport (`sn-client/src/core/http.ts`) for every Table API write,
// same reliance `createSnTestStoreClient` takes (delegated decision
// 2026-09-23, #10 below).
//
// SUB-1 health and the platform stamp reuse `@tessera/doctor`'s `InstanceProbe`
// instead of re-deriving a health/property read: the doctor's probe already
// turns transport ambiguity into a closed three-state outcome and is already
// exercised against `@tessera/fake-instance` (see `packages/doctor/test`).

import { randomUUID } from "node:crypto";

import { sha256Hex } from "@tessera/core";

import { SYS_PROPERTIES_TABLE } from "@tessera/doctor";
import type { InstanceProbe } from "@tessera/doctor";
import { scriptsApi, snRequest } from "@tessera/sn-client";
import type { TargetArtifactRef } from "@tessera/types";

import type {
  BenchmarkSubstrate,
  RunnerLease,
  SourceVariant,
  SubstrateCheck,
} from "./harness.js";
import type { BenchmarkCatalog, CatalogBaseline } from "./catalog.js";
import {
  clearRestoreJournalFile,
  type RestoreJournal,
  type RestoreJournalDocument,
  type RestoreJournalEntry,
} from "./journal.js";

// ── the transport port ───────────────────────────────────────────────────

/** One ServiceNow REST call, reduced to what the substrate issues. */
export interface BenchmarkHttpRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Absolute API path under the instance origin, `/api/now/table/<t>[/<id>]`. */
  readonly path: string;
  readonly params?: URLSearchParams;
  readonly body?: Record<string, string>;
}

/** The parsed response envelope. `data` is the RAW body — `{ result: … }`. */
export interface BenchmarkHttpResponse<T> {
  readonly data: T;
  readonly status: number;
}

/** The transport port. Structurally satisfied by `snRequest`. */
export interface BenchmarkHttpClient {
  request<T>(args: BenchmarkHttpRequest): Promise<BenchmarkHttpResponse<T>>;
}

/** Options for {@link BenchmarkSubstrateError}: `cause` plus a status. */
export interface BenchmarkSubstrateFaultOptions extends ErrorOptions {
  readonly status?: number;
}

/**
 * Every transport failure and every unmet precondition inside this adapter is
 * one of these. It is deliberately a single type, not a refusal/fault split
 * like `teststore-atf`'s: every method on `BenchmarkSubstrate` already answers
 * through a closed outcome (`SubstrateCheck`, `null`, `"green" | "red"`) or is
 * meant to reject the whole run (`resetScope`, `platformVersion`,
 * `applySource`) — the harness (decision #9 in `index.ts`) treats any of those
 * rejections as VOID, so a finer-grained error taxonomy would have no
 * consumer.
 */
export class BenchmarkSubstrateError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options: BenchmarkSubstrateFaultOptions = {}) {
    super(message, options);
    this.name = "BenchmarkSubstrateError";
    this.status = options.status;
  }
}

const TABLE_API_PREFIX = "/api/now/table/";

/** C5-style guard: this adapter speaks the Table API and nothing else. */
export function assertBenchmarkTableApiPath(path: string): void {
  if (!path.startsWith(TABLE_API_PREFIX) || path.includes("?")) {
    throw new BenchmarkSubstrateError(
      `refusing ${path}: the benchmark substrate writes only through the ACL-guarded Table API (${TABLE_API_PREFIX})`,
    );
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === ""
      ? error.name
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function statusOf(error: unknown): number | undefined {
  const record = asRecord(error);
  const status = record?.["status"];
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
}

/** Normalise a transport failure; idempotent for this module's own type. */
export function toSubstrateFault(
  context: string,
  error: unknown,
): BenchmarkSubstrateError {
  if (error instanceof BenchmarkSubstrateError) return error;
  const status = statusOf(error);
  const where = status === undefined ? context : `${context} (HTTP ${status})`;
  return new BenchmarkSubstrateError(
    `${where} failed: ${describeError(error)}`,
    {
      cause: error,
      ...(status === undefined ? {} : { status }),
    },
  );
}

/** The one place this module talks to the port. */
async function requestOrFault<T>(
  client: BenchmarkHttpClient,
  args: BenchmarkHttpRequest,
  context: string,
): Promise<BenchmarkHttpResponse<T>> {
  assertBenchmarkTableApiPath(args.path);
  try {
    return await client.request<T>(args);
  } catch (error) {
    throw toSubstrateFault(context, error);
  }
}

/** The live adapter over `@tessera/sn-client`'s canonical transport. */
export function createSnBenchmarkClient(): BenchmarkHttpClient {
  return {
    async request<T>(
      args: BenchmarkHttpRequest,
    ): Promise<BenchmarkHttpResponse<T>> {
      const response = await snRequest<T>({
        method: args.method,
        path: args.path,
        ...(args.params ? { params: args.params } : {}),
        ...(args.body ? { body: args.body } : {}),
      });
      return { data: response.data, status: response.status };
    },
  };
}

/** Narrow an unknown JSON value to a plain object without an `any` cast. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Read one Table-API field as a string; a reference may arrive as
 * `{ value, display_value }` and is unwrapped, anything else degrades to "".
 * Same unwrap `@tessera/teststore-atf`'s `fieldString` does — vendored rather
 * than imported, since depending on a sibling adapter package for four lines
 * would be a heavier coupling than duplicating them (delegated decision
 * 2026-09-23, #11).
 */
function fieldString(row: Record<string, unknown>, name: string): string {
  const value = row[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const inner = asRecord(value)?.["value"];
  return typeof inner === "string" ? inner : "";
}

// ── table helpers (Table API only, C5) ──────────────────────────────────

interface Row {
  readonly sysId: string;
  readonly fields: Record<string, unknown>;
}

async function queryRows(
  client: BenchmarkHttpClient,
  table: string,
  params: URLSearchParams,
  context: string,
): Promise<Row[]> {
  const res = await requestOrFault<{ result?: unknown[] }>(
    client,
    { method: "GET", path: `${TABLE_API_PREFIX}${table}`, params },
    context,
  );
  // Delegated decision 2026-09-26: a list answer with no `result` array
  // (missing, null, an object) is a fault, never an empty table — reading it
  // as `[]` would make an unreadable lease table look free (fail-open). A
  // well-formed `result: []` is still a genuinely empty table.
  const result: unknown = asRecord(res.data)?.["result"];
  if (!Array.isArray(result)) {
    throw new BenchmarkSubstrateError(
      `${context}: list of ${table} answered without a result array`,
    );
  }
  return result.map((raw: unknown) => {
    const record = asRecord(raw) ?? {};
    return { sysId: fieldString(record, "sys_id"), fields: record };
  });
}

async function insertRow(
  client: BenchmarkHttpClient,
  table: string,
  body: Record<string, string>,
  context: string,
): Promise<string> {
  const res = await requestOrFault<{ result?: unknown }>(
    client,
    { method: "POST", path: `${TABLE_API_PREFIX}${table}`, body },
    context,
  );
  const record = asRecord(res.data.result);
  const sysId = record === undefined ? "" : fieldString(record, "sys_id");
  if (sysId === "") {
    throw new BenchmarkSubstrateError(
      `${context}: insert into ${table} returned no sys_id`,
    );
  }
  return sysId;
}

async function deleteRow(
  client: BenchmarkHttpClient,
  table: string,
  sysId: string,
  context: string,
): Promise<void> {
  await requestOrFault<unknown>(
    client,
    { method: "DELETE", path: `${TABLE_API_PREFIX}${table}/${sysId}` },
    context,
  );
}

async function getField(
  client: BenchmarkHttpClient,
  table: string,
  sysId: string,
  field: string,
  context: string,
): Promise<string> {
  const params = new URLSearchParams({ sysparm_fields: field });
  const res = await requestOrFault<{ result?: unknown }>(
    client,
    { method: "GET", path: `${TABLE_API_PREFIX}${table}/${sysId}`, params },
    context,
  );
  // Delegated decision 2026-09-26: a field that is not an own property of
  // the answer, or whose value is neither a string nor an own `{value:
  // string}` reference, is a fault — never "" (`fieldString`'s lenient
  // degrade). An ACL-stripped or malformed field read as "" would be cached
  // as the correct source and PATCHed back over the live script.
  const record = asRecord(asRecord(res.data)?.["result"]);
  if (record === undefined || !Object.hasOwn(record, field)) {
    throw new BenchmarkSubstrateError(
      `${context}: ${table}/${sysId} answered without the "${field}" field`,
    );
  }
  const value = record[field];
  if (typeof value === "string") return value;
  const reference = asRecord(value);
  if (reference !== undefined && Object.hasOwn(reference, "value")) {
    const inner = reference["value"];
    if (typeof inner === "string") return inner;
  }
  throw new BenchmarkSubstrateError(
    `${context}: ${table}/${sysId} field "${field}" is not a string`,
  );
}

/**
 * The strict read of a benchmark artifact's script source. Delegated decision
 * 2026-09-26: an empty or whitespace-only source is refused (throws) — a
 * scoped benchmark artifact with no code is not a valid baseline, and
 * capturing it would let `resetScope` blank the live script.
 */
async function readScriptSource(
  client: BenchmarkHttpClient,
  target: TargetArtifactRef,
  context: string,
): Promise<string> {
  const field = scriptFieldFor(target.table);
  const value = await getField(
    client,
    target.table,
    target.sysId,
    field,
    context,
  );
  if (value.trim() === "") {
    throw new BenchmarkSubstrateError(
      `${context}: ${target.table}/${target.sysId} "${field}" is blank — not a valid benchmark baseline`,
    );
  }
  return value;
}

async function patchField(
  client: BenchmarkHttpClient,
  table: string,
  sysId: string,
  field: string,
  value: string,
  context: string,
): Promise<void> {
  await requestOrFault<unknown>(
    client,
    {
      method: "PATCH",
      path: `${TABLE_API_PREFIX}${table}/${sysId}`,
      body: { [field]: value },
    },
    context,
  );
}

// ── script field resolution (reusing @tessera/sn-client's own index) ──────

/**
 * `table → scriptFields[]`, derived from `@tessera/sn-client`'s
 * `scriptsApi.SCRIPT_TYPES` — the same source `@tessera/parity`'s
 * `fingerprint.ts` builds `SCRIPT_FIELDS_BY_TABLE` from. `@tessera/benchmark`
 * already depends on `@tessera/sn-client`, so this re-derives the same tiny
 * index locally instead of adding a dependency on `@tessera/parity` for it
 * (delegated decision 2026-09-23, #12).
 */
const TABLE_SCRIPT_FIELDS: ReadonlyMap<string, readonly string[]> = (() => {
  const index = new Map<string, string[]>();
  for (const descriptor of Object.values(scriptsApi.SCRIPT_TYPES)) {
    if (!index.has(descriptor.table)) {
      index.set(descriptor.table, [...descriptor.scriptFields]);
    }
  }
  return index;
})();

/**
 * The one script field this adapter writes for a table. Tables with more than
 * one script field (only `sys_ui_policy`'s `script_true`/`script_false`) are
 * narrowed to the first — writing an unrelated second field from the same
 * source text would risk corrupting an artifact the catalog never asked to
 * touch, so this adapter under-supports multi-field artifacts rather than
 * guessing across them (delegated decision 2026-09-23, #13; a catalog
 * targeting `sys_ui_policy` today only exercises `script_true`).
 */
function scriptFieldFor(table: string): string {
  const fields = TABLE_SCRIPT_FIELDS.get(table);
  const first = fields?.[0];
  if (first === undefined) {
    throw new BenchmarkSubstrateError(
      `no known script field for table "${table}" (not one of @tessera/sn-client's scriptsApi.SCRIPT_TYPES tables)`,
    );
  }
  return first;
}

const REPLACE_PREFIX = "replace:";

/**
 * `diff` is, per `catalog.ts`'s own doc comment, "in whatever form the
 * substrate's applier understands" — an explicitly open design slot. This
 * adapter adopts the SAME `"replace:<full source>"` convention the existing
 * test fixture (`test/fixtures/fake-substrate.js`) already uses, rather than
 * implementing real unified-diff application against unknown live-instance
 * text: a catalog author already has to produce the mutated source to author
 * the mutant, so shipping that source whole is no extra burden, and it avoids
 * the correctness risk of applying a line-based patch to text that may not
 * match byte-for-byte (delegated decision 2026-09-23, #14).
 */
function applyReplaceDiff(diff: string): string {
  if (!diff.startsWith(REPLACE_PREFIX)) {
    throw new BenchmarkSubstrateError(
      `unsupported diff form: expected "${REPLACE_PREFIX}<source>", got ${JSON.stringify(diff.slice(0, 40))}`,
    );
  }
  return diff.slice(REPLACE_PREFIX.length);
}

function targetKey(target: TargetArtifactRef): string {
  return `${target.table}\u0000${target.sysId}`;
}

/**
 * Run a best-effort `cleanup` for `error` and hand back the error to throw:
 * `error` itself when the cleanup succeeded, otherwise a fault that names
 * both (the original stays its `cause`), so an operator learns a lease row
 * may still be sitting on the instance.
 */
async function withCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
): Promise<unknown> {
  try {
    await cleanup();
    return error;
  } catch (cleanupError) {
    return new BenchmarkSubstrateError(
      `${describeError(error)}; lease-row cleanup also failed (a lease row may be left behind): ${describeError(cleanupError)}`,
      { cause: error },
    );
  }
}

/** SUB-3's throwaway marker prefix; never a runner lease (see below). */
const JOIN_PROBE_PREFIX = "join-probe:";

/**
 * The lease query: every row EXCEPT SUB-3 join-probe markers. A probe row
 * whose cleanup failed must never read as a held lease — that would lock the
 * runner out permanently, since SUB-2 does no stale eviction (delegated
 * decision 2026-09-24, #25). `^ORholderISEMPTY` keeps a holder-less row
 * counted: on a real instance `NOT LIKE` does not match an empty value, and
 * an unexplained row must stay fail-closed (held), not invisible.
 */
const LEASE_QUERY = `holderNOT LIKE${JOIN_PROBE_PREFIX}^ORholderISEMPTY`;

function isJoinProbe(row: Row): boolean {
  return fieldString(row.fields, "holder").startsWith(JOIN_PROBE_PREFIX);
}

/**
 * Delete every lease row whose holder is exactly `holder`; returns how many.
 * The encoded query narrows the read, and the holder is re-checked
 * client-side so a transport that drops the query can never widen the delete.
 */
async function deleteLeaseRowsHeldBy(
  client: BenchmarkHttpClient,
  leaseTable: string,
  holder: string,
): Promise<number> {
  const rows = await queryRows(
    client,
    leaseTable,
    new URLSearchParams({
      sysparm_query: `holder=${holder}`,
      sysparm_fields: "sys_id,holder",
    }),
    "runner-lease orphan lookup",
  );
  let deleted = 0;
  for (const row of rows) {
    if (row.sysId === "" || fieldString(row.fields, "holder") !== holder) {
      continue;
    }
    await deleteRow(
      client,
      leaseTable,
      row.sysId,
      "runner-lease orphan cleanup",
    );
    deleted += 1;
  }
  return deleted;
}

// ── verified restore (F4/F5) ─────────────────────────────────────────────

/** Default bounded backoff between final-restore attempts (ms). */
const RESTORE_BACKOFF_MS: readonly number[] = [250, 1000];
const DEFAULT_RESTORE_ATTEMPTS = 3;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** An artifact the verified restore could not put back. */
export interface UnrestoredArtifact {
  /** `table/sysId`. */
  readonly artifact: string;
  readonly detail: string;
}

interface VerifiedRestore {
  readonly restored: string[];
  readonly unrestored: UnrestoredArtifact[];
}

const describeEntry = (e: Pick<RestoreJournalEntry, "table" | "sysId">) =>
  `${e.table}/${e.sysId}`;

/**
 * PATCH each entry's source back and VERIFY it by re-reading the field — a
 * 200 that silently wrote nothing (ACL, business rule) is not a restore.
 * Only still-pending artifacts are retried, with bounded backoff (delegated
 * decision 2026-09-26: 3 attempts, 250 ms then 1 s — a transient blip is
 * absorbed, a persistent failure is surfaced within seconds, never hung on).
 */
async function restoreVerified(
  client: BenchmarkHttpClient,
  entries: readonly RestoreJournalEntry[],
  attempts: number,
  sleep: (ms: number) => Promise<void>,
  context: string,
): Promise<VerifiedRestore> {
  const restored: string[] = [];
  let pending = [...entries];
  const lastError = new Map<string, string>();
  for (
    let attempt = 1;
    attempt <= attempts && pending.length > 0;
    attempt += 1
  ) {
    if (attempt > 1) {
      await sleep(
        RESTORE_BACKOFF_MS[attempt - 2] ??
          RESTORE_BACKOFF_MS[RESTORE_BACKOFF_MS.length - 1] ??
          0,
      );
    }
    const still: RestoreJournalEntry[] = [];
    for (const entry of pending) {
      const name = describeEntry(entry);
      try {
        await patchField(
          client,
          entry.table,
          entry.sysId,
          entry.field,
          entry.source,
          `${context} for ${name}`,
        );
        const readBack = await getField(
          client,
          entry.table,
          entry.sysId,
          entry.field,
          `${context} verify for ${name}`,
        );
        if (readBack !== entry.source) {
          throw new BenchmarkSubstrateError(
            `${context} verify for ${name}: the instance still holds a different source (sha256 ${sha256Hex(readBack)}, expected ${entry.sha256})`,
          );
        }
        restored.push(name);
      } catch (error) {
        lastError.set(name, describeError(error));
        still.push(entry);
      }
    }
    pending = still;
  }
  return {
    restored,
    unrestored: pending.map((entry) => ({
      artifact: describeEntry(entry),
      detail: lastError.get(describeEntry(entry)) ?? "not attempted",
    })),
  };
}

export interface RestoreFromJournalOptions {
  readonly client: BenchmarkHttpClient;
  /** The verified journal document (`readRestoreJournal`). */
  readonly document: RestoreJournalDocument;
  /** Its file — removed only after every entry is verified restored. */
  readonly file: string;
  readonly leaseTable?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly attempts?: number;
}

export type RestoreLeaseOutcome =
  | { readonly status: "released"; readonly rows: number }
  | { readonly status: "failed"; readonly detail: string }
  | { readonly status: "kept" };

export interface RestoreFromJournalResult {
  readonly restored: readonly string[];
  readonly unrestored: readonly UnrestoredArtifact[];
  /** The journal file was removed. */
  readonly cleared: boolean;
  readonly lease: RestoreLeaseOutcome;
}

/**
 * Recover a crashed run (`tess benchmark --restore <runId>`): write every
 * journaled correct source back and verify it. Delegated decision
 * 2026-09-26: ONLY when every artifact is verified restored is the journal
 * removed and the crashed run's own lease row(s) (holder === its runId,
 * never anyone else's) released; with anything unrestored both are kept, so
 * no other run can start on a dirty scope.
 */
export async function restoreFromJournal(
  options: RestoreFromJournalOptions,
): Promise<RestoreFromJournalResult> {
  const { client, document, file } = options;
  const { restored, unrestored } = await restoreVerified(
    client,
    document.entries,
    options.attempts ?? DEFAULT_RESTORE_ATTEMPTS,
    options.sleep ?? defaultSleep,
    "journal restore",
  );
  if (unrestored.length > 0) {
    return { restored, unrestored, cleared: false, lease: { status: "kept" } };
  }
  await clearRestoreJournalFile(file);
  let lease: RestoreLeaseOutcome;
  try {
    const rows = await deleteLeaseRowsHeldBy(
      client,
      options.leaseTable ?? DEFAULT_LEASE_TABLE,
      document.runId,
    );
    lease = { status: "released", rows };
  } catch (error) {
    lease = { status: "failed", detail: describeError(error) };
  }
  return { restored, unrestored, cleared: true, lease };
}

/** Every broken text a catalog can put live, keyed by text. */
interface BoundCatalog {
  readonly broken: ReadonlyMap<string, string>;
  readonly correctPins: ReadonlyMap<string, { sha: string; id: string }>;
}

function bindCatalogIndex(
  catalog: Pick<BenchmarkCatalog, "mutants" | "baselines">,
): BoundCatalog {
  const broken = new Map<string, string>();
  const correctPins = new Map<string, { sha: string; id: string }>();
  // Delegated decision 2026-09-26: a diff not in `replace:` form is skipped
  // here — it can never be applied (`applyReplaceDiff` throws), so it can
  // never be left live either.
  const add = (diff: string, label: string): void => {
    if (
      diff.startsWith(REPLACE_PREFIX) &&
      !broken.has(applyReplaceDiff(diff))
    ) {
      broken.set(applyReplaceDiff(diff), label);
    }
  };
  for (const m of catalog.mutants) {
    add(m.diff, `mutant ${JSON.stringify(m.id)}`);
    if (m.correctSha256 !== undefined) {
      correctPins.set(targetKey(m.baseArtifact), {
        sha: m.correctSha256,
        id: m.id,
      });
    }
  }
  for (const b of catalog.baselines) {
    add(b.detonator.diff, `detonator of baseline ${JSON.stringify(b.id)}`);
    if (b.correctSha256 !== undefined) {
      correctPins.set(targetKey(b.artifact), {
        sha: b.correctSha256,
        id: b.id,
      });
    }
  }
  return { broken, correctPins };
}

// ── the substrate ────────────────────────────────────────────────────────

export interface InstanceBenchmarkSubstrateOptions {
  readonly client: BenchmarkHttpClient;
  readonly probe: InstanceProbe;
  /** Table backing SUB-2's exclusive lease. Default `u_benchmark_lease`. */
  readonly leaseTable?: string;
  /**
   * Where each artifact's correct source is made durable BEFORE its first
   * PATCH (F4). Required: there is no journal-less live substrate.
   */
  readonly journal: RestoreJournal;
  /**
   * The catalog whose mutant/detonator texts must never be captured as
   * "correct". `runBenchmark` binds its own catalog via `bindCatalog`; with
   * neither, every capture is refused (fail closed).
   */
  readonly catalog?: Pick<BenchmarkCatalog, "mutants" | "baselines">;
  /** Injected for tests; defaults to a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Final-restore attempts per artifact. Default 3. */
  readonly restoreAttempts?: number;
}

export const DEFAULT_LEASE_TABLE = "u_benchmark_lease";

/**
 * The live `BenchmarkSubstrate` adapter. One instance is scoped to one
 * benchmark run: it caches, per artifact, the "correct" source text it first
 * observes on the instance, and restores every cached artifact from that
 * cache on `resetScope`. Constructing a fresh substrate per `tess benchmark`
 * invocation (the CLI does) keeps that cache from leaking between runs.
 */
export function createInstanceBenchmarkSubstrate(
  options: InstanceBenchmarkSubstrateOptions,
): BenchmarkSubstrate {
  const { client, probe, journal } = options;
  const leaseTable = options.leaseTable ?? DEFAULT_LEASE_TABLE;
  const sleep = options.sleep ?? defaultSleep;
  const restoreAttempts = options.restoreAttempts ?? DEFAULT_RESTORE_ATTEMPTS;
  let bound: BoundCatalog | undefined =
    options.catalog === undefined
      ? undefined
      : bindCatalogIndex(options.catalog);

  // Lazily captured "correct" source per artifact — see applySource's
  // `{kind:"correct"}` handling below (delegated decision 2026-09-23, #15).
  const correctSource = new Map<string, RestoreJournalEntry>();

  const recoveryHint = (): string =>
    journal.runId === undefined
      ? "restore it from the pending restore journal (`tess benchmark --restore <runId>`)"
      : `restore it with \`tess benchmark --restore ${journal.runId}\``;

  async function captureIfAbsent(target: TargetArtifactRef): Promise<string> {
    const key = targetKey(target);
    const cached = correctSource.get(key);
    if (cached !== undefined) return cached.source;
    const name = `${target.table}/${target.sysId}`;
    // Delegated decision 2026-09-26: no catalog bound → no way to tell a
    // leftover mutant from correct source, so capture is refused outright.
    if (bound === undefined) {
      throw new BenchmarkSubstrateError(
        `refusing to capture the correct source of ${name}: no catalog is bound, so a live mutant could not be told apart from correct code`,
      );
    }
    // Delegated decision 2026-09-26: capture only through the strict read —
    // an unreadable or blank field throws before anything is cached, so no
    // later `applySource`/`resetScope` can write an invented "" back.
    const value = await readScriptSource(
      client,
      target,
      `capture correct source for ${name}`,
    );
    // Delegated decision 2026-09-26 (F4): a live text equal to ANY mutant or
    // detonator in the catalog (checked across the whole catalog, not just
    // this artifact's own entries — a crashed run may have left any of them)
    // is a leftover fault, never "correct". Refuse before anything is written.
    const brokenAs = bound.broken.get(value);
    if (brokenAs !== undefined) {
      throw new BenchmarkSubstrateError(
        `refusing to capture the correct source of ${name}: the live text equals ${brokenAs} — a prior run likely crashed with it applied; ${recoveryHint()}`,
      );
    }
    const sha256 = sha256Hex(value);
    // Delegated decision 2026-09-26: an author-pinned correctSha256 is
    // authoritative — any other live text is refused, not adopted.
    const pin = bound.correctPins.get(key);
    if (pin !== undefined && pin.sha !== sha256) {
      throw new BenchmarkSubstrateError(
        `refusing to capture the correct source of ${name}: live sha256 ${sha256} does not match the catalog's correctSha256 ${pin.sha} (entry ${JSON.stringify(pin.id)}); ${recoveryHint()}`,
      );
    }
    const entry: RestoreJournalEntry = {
      table: target.table,
      sysId: target.sysId,
      field: scriptFieldFor(target.table),
      sha256,
      source: value,
    };
    // Delegated decision 2026-09-26 (F4): durable BEFORE cached, and so
    // before the first PATCH — a journal that cannot be written refuses the
    // capture (and with it the write), so no mutant ever goes live without
    // an on-disk way back.
    await journal.record(entry);
    correctSource.set(key, entry);
    return value;
  }

  /** Best-effort: delete every lease row whose holder is exactly `holder`. */
  async function deleteHeldBy(holder: string): Promise<void> {
    await deleteLeaseRowsHeldBy(client, leaseTable, holder);
  }

  return {
    // SUB-1 — reuse the doctor's own readiness read; a cheap, ACL-exercising
    // GET is exactly what "awake, HTTP-clean, not a wake interstitial" needs,
    // and `InstanceProbe` already turns transport ambiguity into a closed
    // three-state outcome instead of this module re-inventing one.
    async checkHealthy(signal: AbortSignal): Promise<SubstrateCheck> {
      const result = await probe.readTable(SYS_PROPERTIES_TABLE, signal);
      return { ok: result.outcome === "readable", detail: result.detail };
    },

    // SUB-3 — a write-then-read round trip against the lease table, using a
    // throwaway marker value nobody else would coincidentally write. This is
    // this adapter's own reading of "the run→result join field is pinned":
    // it proves a value this adapter writes survives being read back
    // unaltered (no ACL/business-rule silently blanking or rewriting it),
    // which is the failure mode an unpinned join would produce (delegated
    // decision 2026-09-23, #16). It runs before SUB-2 acquires the lease
    // (harness ordering), so it shares the lease table's small, accepted
    // race window with SUB-2 rather than adding a second table just for this
    // check.
    async checkAttributionJoinPinned(
      signal: AbortSignal,
    ): Promise<SubstrateCheck> {
      if (signal.aborted) {
        return {
          ok: false,
          detail: "aborted before the join probe reached the instance",
        };
      }
      const nonce = `${JOIN_PROBE_PREFIX}${randomUUID()}`;
      let sysId: string | undefined;
      let verdict: SubstrateCheck;
      try {
        sysId = await insertRow(
          client,
          leaseTable,
          { holder: nonce },
          "attribution-join probe insert",
        );
        const readBack = await getField(
          client,
          leaseTable,
          sysId,
          "holder",
          "attribution-join probe read-back",
        );
        verdict =
          readBack === nonce
            ? {
                ok: true,
                detail: "write-then-read round trip preserved the join field",
              }
            : {
                ok: false,
                detail: `join field not pinned: wrote ${JSON.stringify(nonce)}, read back ${JSON.stringify(readBack)}`,
              };
      } catch (error) {
        verdict = { ok: false, detail: describeError(error) };
      }
      // Delegated decision 2026-09-24 (#25): a probe row that cannot be
      // cleaned up fails SUB-3 (the run voids) instead of being swallowed —
      // the lease queries already ignore `join-probe:` holders, so a stray
      // row can no longer lock SUB-2 out, but an instance where this adapter
      // cannot delete what it just wrote is not a substrate to score on.
      if (sysId !== undefined) {
        try {
          await deleteRow(
            client,
            leaseTable,
            sysId,
            "attribution-join probe cleanup",
          );
        } catch (error) {
          return {
            ok: false,
            detail: `join-probe row ${sysId} could not be cleaned up: ${describeError(error)}${verdict.ok ? "" : ` (probe also failed: ${verdict.detail})`}`,
          };
        }
      }
      return verdict;
    },

    // SUB-2 — fail-closed, no stale eviction (delegated decision 2026-09-23,
    // #17): a plain Table API has no compare-and-swap, so check-then-insert
    // carries a residual, accepted TOCTOU race; this narrows it (not closes
    // it) by re-reading after insert and backing off when a second row
    // appears. This is a single-operator convenience lock, not a
    // distributed-consensus primitive — the design brief explicitly asks for
    // "no stale eviction", so a lease is held until its own `release()` runs,
    // full stop.
    async acquireRunnerLease(runId: string): Promise<RunnerLease | null> {
      // Both reads use LEASE_QUERY and re-filter client-side, so a SUB-3
      // probe row is never a held lease even behind a transport that drops
      // the encoded query. No `sysparm_limit`: with a client-side filter a
      // limit of 1 could return only a probe row and hide a real holder
      // behind it (fail-open); the lease table only ever holds a few rows.
      const leases = async (context: string): Promise<Row[]> =>
        (
          await queryRows(
            client,
            leaseTable,
            new URLSearchParams({
              sysparm_query: LEASE_QUERY,
              sysparm_fields: "sys_id,holder",
            }),
            context,
          )
        ).filter((row) => !isJoinProbe(row));

      const existing = await leases("runner-lease check");
      if (existing.length > 0) return null;

      // Delegated decision 2026-09-24 (#24): nothing after a successful (or
      // possibly-successful) insert may leak the lease row. An insert that
      // failed — including one the server applied but answered without a
      // sys_id — is followed by a best-effort query-and-delete of every row
      // held by THIS runId; a fault after the insert deletes the inserted
      // row. Either way the original fault is rethrown (the harness voids).
      let sysId: string;
      try {
        sysId = await insertRow(
          client,
          leaseTable,
          { holder: runId },
          "runner-lease acquire",
        );
      } catch (error) {
        throw await withCleanup(error, () => deleteHeldBy(runId));
      }
      let afterInsert: Row[];
      try {
        afterInsert = await leases("runner-lease race check");
      } catch (error) {
        throw await withCleanup(error, () =>
          deleteRow(client, leaseTable, sysId, "runner-lease fault back-off"),
        );
      }
      const ours = afterInsert.filter(
        (row) =>
          row.sysId === sysId && fieldString(row.fields, "holder") === runId,
      );
      if (afterInsert.length > 1 && ours.length === 1) {
        // Genuine contention: our row is visible next to another holder's.
        await deleteRow(
          client,
          leaseTable,
          sysId,
          "runner-lease race back-off",
        ).catch(() => {});
        return null;
      }
      if (afterInsert.length !== 1 || ours.length !== 1) {
        // Delegated decision 2026-09-26: a re-read that does not show exactly
        // our row (sys_id AND holder) cannot prove we hold the lease — e.g. an
        // ACL/row filter hides rows, so every runner would see an empty table
        // and "acquire". Fail closed by THROWING (the harness voids with
        // "lease acquisition rejected: …") rather than returning null, which
        // would misreport an unverifiable lease as "held by another run".
        // Our own row is deleted best-effort first.
        const unverified = new BenchmarkSubstrateError(
          `runner-lease race check could not verify the lease: expected exactly our row ${sysId} held by ${JSON.stringify(runId)}, re-read saw ${afterInsert.length} row(s)`,
        );
        throw await withCleanup(unverified, () =>
          deleteRow(
            client,
            leaseTable,
            sysId,
            "runner-lease unverified back-off",
          ),
        );
      }
      return {
        async release(): Promise<void> {
          await deleteRow(client, leaseTable, sysId, "runner-lease release");
        },
      };
    },

    // SUB-5 — restore every artifact this substrate has touched back to its
    // captured "correct" source. Deliberately narrower than the fixture's
    // `instance.reset()` (a full-instance rewind, only affordable because the
    // fake is cheap to reset): a real instance has no equivalent, so "the
    // benchmark scope" is defined here as exactly the artifacts this run has
    // applied a variant to (delegated decision 2026-09-23, #18). The lease
    // row is never touched — it lives in the same table but is never a
    // captured target.
    //
    // Delegated decision 2026-09-26 (F5): every artifact is attempted even
    // after one fails, and the failures are thrown as ONE aggregate error —
    // stopping at the first throw left every later artifact dirty.
    async resetScope(): Promise<void> {
      const failures: string[] = [];
      for (const entry of correctSource.values()) {
        try {
          await patchField(
            client,
            entry.table,
            entry.sysId,
            entry.field,
            entry.source,
            `reset scope for ${describeEntry(entry)}`,
          );
        } catch (error) {
          failures.push(describeError(error));
        }
      }
      if (failures.length > 0) {
        throw new BenchmarkSubstrateError(
          `scope reset failed for ${failures.length} of ${correctSource.size} artifact(s): ${failures.join("; ")}`,
        );
      }
    },

    bindCatalog(catalog: Pick<BenchmarkCatalog, "mutants" | "baselines">) {
      bound = bindCatalogIndex(catalog);
    },

    // The run's LAST restore (F4/F5): patch + verify every captured artifact
    // with bounded retries. Delegated decision 2026-09-26: the journal is
    // cleared only when EVERY artifact is verified restored; otherwise it is
    // pruned to exactly the unrestored artifacts and the error names each of
    // them, the journal and the recovery command, so the next run refuses to
    // start on it.
    async restoreFinal(runId: string): Promise<void> {
      const { unrestored } = await restoreVerified(
        client,
        [...correctSource.values()],
        restoreAttempts,
        sleep,
        "final restore",
      );
      if (unrestored.length > 0) {
        // F5: the journal keeps exactly what is still unrestored, so the
        // operator (and `--restore`) sees the real residue. Delegated
        // decision 2026-09-26: a failed prune is swallowed — the journal then
        // keeps MORE entries than needed, which only re-writes verified
        // sources on `--restore` (the safe direction).
        const pending = new Set(unrestored.map((u) => u.artifact));
        await journal
          .retain?.((entry) => pending.has(describeEntry(entry)))
          .catch(() => undefined);
        const recover = journal.runId ?? runId.replace(/:final$/, "");
        throw new BenchmarkSubstrateError(
          `UNRESTORED after ${restoreAttempts} attempt(s): ${unrestored.map((u) => `${u.artifact} (${u.detail})`).join("; ")} — their correct source is kept in the restore journal ${journal.location}; recover with \`tess benchmark --restore ${recover}\``,
        );
      }
      try {
        await journal.clear();
      } catch (error) {
        throw new BenchmarkSubstrateError(
          `every artifact was restored and verified, but the restore journal ${journal.location} could not be removed (the next run will refuse until it is): ${describeError(error)}`,
        );
      }
    },

    // Missing → refusal, never guessed (task brief, DESIGN §13.4): try
    // `glide.buildname` first, fall back to `glide.war`; neither readable
    // throws rather than returning an empty or synthesised string (delegated
    // decision 2026-09-23, #19).
    async platformVersion(): Promise<string> {
      const buildname = await probe.readProperty("glide.buildname");
      if (buildname.outcome === "found" && (buildname.value ?? "") !== "") {
        return buildname.value as string;
      }
      const war = await probe.readProperty("glide.war");
      if (war.outcome === "found" && (war.value ?? "") !== "") {
        return war.value as string;
      }
      throw new BenchmarkSubstrateError(
        `platform stamp unavailable: glide.buildname (${buildname.detail}) and glide.war (${war.detail}) neither readable`,
      );
    },

    // `{kind:"correct"}` carries no diff payload by design (`SourceVariant`),
    // and `generate()`/`execute()` always call `resetScope` immediately
    // before this — but `resetScope` only restores artifacts it already knows
    // about. So the FIRST time an artifact is touched, there is nothing yet
    // to restore, and this adapter treats "apply the correct variant" as
    // "capture whatever is live right now as correct, then write it back" —
    // i.e. the benchmark scope must already carry the catalog's correct
    // source before a run starts (an out-of-band provisioning step), and this
    // adapter never invents that text itself (delegated decision 2026-09-23,
    // #15, continued: capture-on-first-touch, not trust-reset-alone, so a
    // `resetScope` call is never load-bearing for a target's FIRST rep).
    async applySource(
      target: TargetArtifactRef,
      _behaviour: string,
      variant: SourceVariant,
    ): Promise<void> {
      const field = scriptFieldFor(target.table);
      // Delegated decision 2026-09-26: capture BEFORE any write, whatever the
      // variant — a mutant/detonator applied as an artifact's first touch
      // would otherwise leave `resetScope` unaware of it, so the broken text
      // would survive the final restore.
      const correct = await captureIfAbsent(target);
      const value =
        variant.kind === "correct" ? correct : applyReplaceDiff(variant.diff);
      await patchField(
        client,
        target.table,
        target.sysId,
        field,
        value,
        `apply ${variant.kind} source to ${target.table}/${target.sysId}`,
      );
    },

    // A live instance offers no way to evaluate a server-side script out of
    // band the way the fixture's `node:vm` eval does — that would require
    // driving the full ATF runner, which is a pipeline port, not a substrate
    // one. So this is narrower than "does the baseline still behave as
    // expected": it is a text-identity check for the one drift shape a
    // substrate CAN detect without a runner — an artifact left sitting in its
    // own detonator's broken state between runs (teardown/reset failed, or a
    // prior run's mutation leaked). Live text equal to the detonator's own
    // replacement text is `red`; anything else is `green` (delegated decision
    // 2026-09-23, #20 — a narrower drift check than the fixture's behavioural
    // one, documented as a known limitation, not a silent downgrade).
    async smokeBaseline(baseline: CatalogBaseline): Promise<"green" | "red"> {
      const { artifact, detonator } = baseline;
      // Delegated decision 2026-09-26: the same strict read as capture — an
      // unreadable or blank live source throws (the harness voids the run as
      // drift-smoke-red), never "green".
      const live = await readScriptSource(
        client,
        artifact,
        `drift smoke-test for ${artifact.table}/${artifact.sysId}`,
      );
      const broken = applyReplaceDiff(detonator.diff);
      // Delegated decision 2026-09-26 (F4): ANY catalog mutant/detonator text
      // live on a baseline is drift too, not only its own detonator.
      return live === broken || bound?.broken.has(live) === true
        ? "red"
        : "green";
    },
  };
}
