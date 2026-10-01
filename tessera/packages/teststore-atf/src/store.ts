// PLAN Phase 4 write side — the ATF TestStore adapter (core's `TestStore`
// port; ADR-007, delegated decision 2026-09-23).
//
// Generalises `@tessera/phase05`'s one-spec walking-skeleton store to N specs
// over an injectable transport. The design rules it inherits are unchanged:
//
//  * DR-1 / Spike 0 — a projected test is `sys_atf_test` + one
//    `sys_atf_step` of the "Run Server Side Script" type + the step's
//    `sys_variable_value` input row that actually holds the script. That last
//    row is the one the W2 ACL guards (role `x_tessera.author`).
//  * DEV-8 / DEV-19 — the CI/CD API runs suites only, so the run gets ONE
//    throwaway `sys_atf_test_suite` and every projected test is linked into
//    it. Every `ProjectedRecord` carries that suite's sys_id; the runner
//    groups by it and triggers it once.
//  * §4a / ARCH-26 — ephemeral records are namespaced by run id: every
//    `name` starts with `<runId>:`. Core's W1/W2 probe is
//    `nameSTARTSWITH<runId>` on `sys_atf_test`, so that prefix is a contract.
//    The `:` delimiter keeps run `r-1`'s sweep out of run `r-10`'s records.
//  * DEV-13 — teardown deletes suite→test links, then step inputs, then
//    steps, then tests, then the suite (creation order reversed).
//  * F2 (2026-09-26) — the namespace is a probe, not proof of ownership:
//    teardown deletes a namespaced test/suite only when its description
//    carries `runOwnershipMarker(runId)`, and a link only when its suite is
//    run-owned; anything else refuses the whole teardown before any DELETE.
//  * DEV-17 / ARCH-28 — teardown re-probes `sys_atf_test_suite_result` itself
//    and refuses (deleting nothing) unless every row is provably terminal.
//    A suite with NO result row is refused too, unless the caller asserts
//    `neverTriggered` (see `AtfTeardownContext`). With the ledger's
//    `recordedTriggers` count it also refuses while fewer result rows exist
//    than recorded triggers — a second execution still queued (wave 13).
//
// Teardown is DISCOVERY-based, not memory-based: it finds the run's records
// through the namespace (plus the links/steps/inputs hanging off them), so it
// removes W1/W2 orphans a crashed projection left behind, works from a fresh
// process, and is idempotent — a second call finds nothing and writes nothing.
//
// SEAM (ARCH-3): writes go through `snRequest`, which journals (DEV-15) but
// does not `intend`; core's per-spec ledger entry covers them coarsely.

import { specKey, type TestStore } from "@tessera/core";
import type {
  PipelineContext,
  ProjectedRecord,
  ProjectionMap,
  TestSpec,
} from "@tessera/types";

import {
  checkAuthoringChannel,
  AUTHORING_CHANNEL_VERSION,
  type ChannelVersionVerdict,
} from "./channel.js";
import {
  asRecord,
  crossCheckRowCount,
  fieldString,
  requestOrFault,
  TestStoreInfrastructureError,
  TestStoreRefusalError,
  type TestStoreHttpClient,
} from "./client.js";
import { acquireProjectionLock, type ProjectionLock } from "./lock.js";

/** The ATF tables the store touches ([S0], mirrored from phase05/atf.ts). */
export const ATF_STORE_TABLES = {
  test: "sys_atf_test",
  step: "sys_atf_step",
  stepInput: "sys_variable_value",
  suite: "sys_atf_test_suite",
  suiteTest: "sys_atf_test_suite_test",
  suiteResult: "sys_atf_test_suite_result",
} as const;

/** [S0] `sys_atf_step_config` of "Run Server Side Script". */
export const RUN_SERVER_SIDE_SCRIPT_STEP_CONFIG =
  "41de4a935332120028bc29cac2dc349a";
/** [S0] `atf_input_variable` holding that step's script. */
export const TEST_SCRIPT_INPUT_VARIABLE = "989d9e235324220002c6435723dc3484";
/** `sys_variable_value.document` of an ATF step input. */
export const STEP_INPUT_DOCUMENT = "sys_atf_step";

/**
 * DEV-17 — suite-result statuses that are provably terminal. Re-declared from
 * phase05/atf.ts (no dependency on the skeleton); anything else, unknown
 * values included, counts as still running (fail closed).
 */
export const TERMINAL_SUITE_RESULT_STATUSES: ReadonlySet<string> = new Set([
  "successful",
  "failed",
  "canceled",
  "cancelled",
  "success",
  "failure",
  "complete",
  "completed",
  "2",
  "3",
  "4",
]);

/**
 * The spec payload this store projects: the server-side script the ATF step
 * runs. `assertions` (phase05's S5 shape) are accepted and ignored — they are
 * already compiled into `script` by whoever produced the spec.
 */
export interface AtfScriptPayload {
  readonly script: string;
  readonly assertions?: readonly string[];
}

export function isAtfScriptPayload(value: unknown): value is AtfScriptPayload {
  const record = asRecord(value);
  return (
    record !== undefined &&
    typeof record["script"] === "string" &&
    record["script"].trim() !== ""
  );
}

export interface AtfTestStoreOptions {
  /** The transport; `createSnTestStoreClient()` in production. */
  readonly client: TestStoreHttpClient;
  /**
   * Path of the local projection lock file (created with `wx`). Required —
   * the composition root decides where run state lives (e.g. under the §4b
   * ledger root), not this adapter.
   */
  readonly lockPath: string;
  /**
   * C5 — the only accepted authoring channel. Present so that a caller asking
   * for anything else (an ACL-free Scripted REST endpoint) is refused at
   * construction, not silently ignored.
   */
  readonly authoringChannel?: "table-api";
  /** Channel version to require; default {@link AUTHORING_CHANNEL_VERSION}. */
  readonly expectedChannelVersion?: string;
  /** C4 minor-mismatch sink. Default: `process.emitWarning`. */
  readonly onWarning?: (message: string) => void;
  /** Rows per Table-API page when discovering records. Default 200. */
  readonly pageSize?: number;
  /**
   * Hard ceiling on pages per discovery query. Default
   * {@link DEFAULT_MAX_QUERY_PAGES}. Reaching it THROWS — a discovery that
   * silently truncated would leave the unread rows behind as orphans.
   */
  readonly maxQueryPages?: number;
  /**
   * When true, a teardown whose context carries no
   * {@link AtfTeardownContext.recordedTriggers} is refused before any request.
   *
   * Delegated decision 2026-09-28 (wave 13): default false, because today's
   * callers (core's teardown, `tess cleanup`) do not pass the count yet and a
   * default of true would refuse every teardown they make. A composition root
   * that wires the count sets this so a caller that forgets it fails closed.
   */
  readonly requireRecordedTriggers?: boolean;
}

/** Default {@link AtfTestStoreOptions.maxQueryPages}: 500 pages (100k rows at 200). */
export const DEFAULT_MAX_QUERY_PAGES = 500;

/**
 * The context `teardown()` reads. `neverTriggered` is the caller's explicit
 * assertion that no CI/CD run of this run's suite was ever requested — e.g.
 * core's teardown after a fault in a stage BEFORE `running`. It is the ONLY
 * way past the DEV-17 gate when the run's suite exists but has no
 * `sys_atf_test_suite_result` row yet.
 *
 * Structural on purpose: `PipelineContext` (in `@tessera/types`) does not
 * declare the field, so a caller sets it on a context typed as
 * `PipelineContext & { neverTriggered?: boolean }` and the port stays
 * `teardown(ctx: PipelineContext)`.
 */
export interface AtfTeardownContext extends PipelineContext {
  readonly neverTriggered?: boolean;
  /**
   * DEV-17 (wave 13) — how many suite executions the run's intent ledger
   * records as possibly triggered: its trigger entries in ANY state
   * (`intended` included — the entry is written BEFORE the CI/CD POST, so a
   * crash or a lost response leaves an `intended` entry whose execution may
   * have landed). Derive it with {@link countRecordedSuiteTriggers}. It is an
   * UPPER bound on executions, which is the safe direction: an overcount only
   * makes teardown refuse.
   *
   * Every CI/CD execution of a suite writes exactly one
   * `sys_atf_test_suite_result` row, so with `n` recorded triggers teardown
   * requires at least `n` result rows across the run's suites, all terminal.
   * Fewer rows means an execution may still be queued (no row yet) and
   * teardown refuses. This is what catches a SECOND execution queued behind a
   * first one that already reads terminal.
   *
   * `undefined` — the caller predates the field; the pre-wave-13 gate applies
   * (see {@link AtfTestStoreOptions.requireRecordedTriggers}). `null`, or
   * anything that is not a non-negative safe integer, means "unknown" and is
   * refused before any request.
   */
  readonly recordedTriggers?: number | null;
}

/**
 * {@link AtfTeardownContext.recordedTriggers} — the core loop's default
 * trigger-entry table (`DEFAULT_RUN_TRIGGER_TABLE` in `@tessera/core`).
 */
export const DEFAULT_SUITE_TRIGGER_TABLE = "sys_atf_test_suite_run";

/**
 * The part of a `@tessera/ledger` `LedgerEntry` the trigger count reads —
 * structural, so this adapter keeps zero runtime dependencies on the ledger.
 */
export interface RecordedLedgerEntry {
  readonly runId: string;
  readonly target: { readonly table: string };
}

/**
 * Count the run's recorded suite-trigger entries in the entries
 * `IntentLedger.entries(runId)` returns — every state counts (see
 * {@link AtfTeardownContext.recordedTriggers}). An entry of another run is a
 * caller bug and throws rather than being silently skipped or counted.
 *
 * Delegated decision 2026-09-28 (wave 13): the count keys on the trigger
 * table alone. Core intends exactly one entry per runner group on that table
 * before the group's runner triggers, and nothing else in the run targets
 * it, so the count is an upper bound on the run's suite executions. A caller
 * that routes non-ATF runners through the same table overcounts, which only
 * makes teardown refuse (fail closed).
 */
export function countRecordedSuiteTriggers(
  runId: string,
  entries: readonly RecordedLedgerEntry[],
  triggerTable: string = DEFAULT_SUITE_TRIGGER_TABLE,
): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.runId !== runId) {
      throw new TypeError(
        `countRecordedSuiteTriggers: ledger entry of run ${JSON.stringify(entry.runId)} passed for run ${JSON.stringify(runId)}`,
      );
    }
    if (entry.target.table === triggerTable) count += 1;
  }
  return count;
}

/**
 * Characters that make a run id unsafe to splice into an encoded query.
 *
 * Delegated decision 2026-09-25: the store does not trust its caller's run-id
 * pattern (the ledger's may change). `^` joins/ORs terms (`^OR`, `^NQ`), `=`
 * and `@` are operator/value syntax (`@` separates BETWEEN/relative-date
 * operands), and CR/LF can smuggle a second line past log- and
 * header-oriented tooling. A run id carrying any of them — or an empty one,
 * whose `:` prefix would match foreign rows — is refused before any I/O.
 */
const UNSAFE_RUN_ID = /[\^=@\r\n]/;

function assertSafeRunId(runId: unknown): string {
  if (typeof runId !== "string" || runId === "" || UNSAFE_RUN_ID.test(runId)) {
    throw new TestStoreRefusalError(
      "unsafe-run-id",
      `run id ${JSON.stringify(runId)} is not safe to splice into a ServiceNow encoded query (empty, or carries one of ^ = @ CR LF) — refusing before any request`,
    );
  }
  return runId;
}

/**
 * The per-row ownership marker: the exact `description` prefix `project()`
 * writes on every `sys_atf_test` and `sys_atf_test_suite` it creates.
 *
 * Delegated decision 2026-09-26 (F2): the `<runId>:` name prefix is a probe
 * key, not proof of ownership — a customer test named `smoke:login` sits in
 * run `smoke`'s namespace. Teardown deletes a namespaced test or suite only
 * when its description starts with this marker (case-sensitive), and refuses
 * the whole teardown otherwise. The ` — ` terminator keeps run `r-1`'s marker
 * from matching run `r-10`'s rows, as the `:` does for names.
 */
export function runOwnershipMarker(runId: string): string {
  return `Tessera run ${runId} — `;
}

/** Render an untrusted count for a refusal message without ever throwing. */
function describeCount(count: unknown): string {
  if (count === null) return "null";
  if (typeof count === "string") return JSON.stringify(count);
  if (
    typeof count === "number" ||
    typeof count === "bigint" ||
    typeof count === "boolean"
  ) {
    return String(count);
  }
  return `a ${typeof count}`;
}

/**
 * Validate {@link AtfTeardownContext.recordedTriggers} before any request.
 * Returns the count, or `undefined` for a legacy caller that is allowed to
 * omit it. Refuses an unknown count, a missing count the store was told to
 * require, and a count that contradicts `neverTriggered`.
 */
function assertRecordedTriggers(
  runId: string,
  ctx: AtfTeardownContext,
  required: boolean,
): number | undefined {
  const count: unknown = ctx.recordedTriggers;
  if (count === undefined) {
    if (!required) return undefined;
    throw new TestStoreRefusalError(
      "non-terminal-run",
      `refusing to tear down run ${runId}: the store requires the ledger's recorded suite-trigger count and the caller supplied none, so a queued execution cannot be ruled out (DEV-17 — nothing was deleted)`,
    );
  }
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new TestStoreRefusalError(
      "non-terminal-run",
      `refusing to tear down run ${runId}: the recorded suite-trigger count is unknown (${describeCount(count)}), so a queued execution cannot be ruled out (DEV-17 — nothing was deleted)`,
    );
  }
  if (count > 0 && ctx.neverTriggered === true) {
    throw new TestStoreRefusalError(
      "non-terminal-run",
      `refusing to tear down run ${runId}: the caller asserts neverTriggered but its ledger records ${count} suite trigger(s) — contradictory context (DEV-17 — nothing was deleted)`,
    );
  }
  return count;
}

/** How many offending rows a `not-run-owned` refusal names before eliding. */
const MAX_REPORTED_ROWS = 20;

export interface AtfTestStore extends TestStore {
  /**
   * Release the projection lock without tearing anything down — for the
   * composition root's `finally` after a run that never reached teardown
   * (persistent, abandoned, failed). Idempotent.
   */
  release(): void;
  /** The C4 verdict of the last successful `project()`, if any. */
  lastChannelCheck(): ChannelVersionVerdict | undefined;
}

/** One row as the Table API returns it. */
type Row = Record<string, unknown>;

export function createAtfTestStore(options: AtfTestStoreOptions): AtfTestStore {
  const channel: unknown = options.authoringChannel ?? "table-api";
  if (channel !== "table-api") {
    throw new TestStoreRefusalError(
      "acl-free-endpoint",
      `authoring channel ${JSON.stringify(channel)} is not supported: the ATF TestStore authors only through the Table API under the W2 ACL — an ACL-free Scripted REST endpoint is rejected by design (C5, ADR-007)`,
    );
  }
  const { client, lockPath } = options;
  const expected = options.expectedChannelVersion ?? AUTHORING_CHANNEL_VERSION;
  const warn =
    options.onWarning ??
    ((message: string) =>
      process.emitWarning(message, { code: "TESSERA_W2_CHANNEL_MINOR" }));
  const pageSize = options.pageSize ?? 200;
  const maxQueryPages = options.maxQueryPages ?? DEFAULT_MAX_QUERY_PAGES;
  // Delegated decision 2026-09-25: a non-positive / non-integer page size or
  // page cap is a caller bug that would otherwise loop forever (offset never
  // advancing) or never read at all — fail closed at construction.
  for (const [name, value] of [
    ["pageSize", pageSize],
    ["maxQueryPages", maxQueryPages],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new TypeError(
        `createAtfTestStore: ${name} must be a positive integer (got ${String(value)})`,
      );
    }
  }
  let lock: ProjectionLock | undefined;
  let channelCheck: ChannelVersionVerdict | undefined;

  const tablePath = (table: string, sysId?: string): string =>
    sysId === undefined
      ? `/api/now/table/${table}`
      : `/api/now/table/${table}/${encodeURIComponent(sysId)}`;

  const resultOf = (data: unknown, context: string): unknown => {
    const result = asRecord(data)?.["result"];
    if (result === undefined) {
      throw new TestStoreInfrastructureError(
        `${context}: response carried no { result } envelope`,
      );
    }
    return result;
  };

  const sysIdOf = (row: unknown, context: string): string => {
    const record = asRecord(row);
    const sysId = record === undefined ? "" : fieldString(record, "sys_id");
    if (sysId === "") {
      throw new TestStoreInfrastructureError(
        `${context}: the instance answered without a sys_id`,
      );
    }
    return sysId;
  };

  /**
   * Every row matching `query`.
   *
   * Delegated decision 2026-09-25: a SHORT page is not the end. ServiceNow
   * drops rows the session cannot read AFTER applying limit/offset, so a page
   * can come back short (or empty) while later pages still hold rows —
   * stopping there left those rows behind as orphans. The loop therefore
   * continues while `offset + pageSize < total` when the transport reports
   * `X-Total-Count` (`total`, counted before ACL trimming), and otherwise
   * until an EMPTY page. Either way it throws once `maxQueryPages` pages were
   * read without reaching the end — never a silent truncation. Results are
   * ordered by sys_id so offset paging is stable.
   */
  const queryAll = async (
    table: string,
    query: string,
    fields: readonly string[],
  ): Promise<Row[]> => {
    const rows: Row[] = [];
    for (let page = 0, offset = 0; ; page += 1, offset += pageSize) {
      if (page >= maxQueryPages) {
        throw new TestStoreInfrastructureError(
          `GET ${table} (${query}): still not exhausted after ${maxQueryPages} page(s) of ${pageSize} — refusing to continue on a truncated result`,
        );
      }
      const params = new URLSearchParams({
        sysparm_query: `${query}^ORDERBYsys_id`,
        sysparm_fields: fields.join(","),
        sysparm_limit: String(pageSize),
        sysparm_offset: String(offset),
        sysparm_exclude_reference_link: "true",
      });
      const response = await requestOrFault<unknown>(
        client,
        { method: "GET", path: tablePath(table), params },
        `GET ${table} (${query})`,
      );
      const result = resultOf(response.data, `GET ${table}`);
      if (!Array.isArray(result)) {
        throw new TestStoreInfrastructureError(
          `GET ${table}: { result } is not a list`,
        );
      }
      for (const entry of result) {
        const row = asRecord(entry);
        if (row !== undefined) rows.push(row);
      }
      const total = response.total;
      if (typeof total === "number" && Number.isFinite(total)) {
        if (offset + pageSize >= total) return rows;
      } else if (result.length === 0) {
        // Wave 16: with no total, an empty page is not proof of the end — a
        // window the read ACLs trimmed to zero rows looks the same, and so
        // do rows trimmed out of the last window. One Stats count of the
        // same filter confirms it; anything but an exact match refuses,
        // as a truncated read does (see `crossCheckRowCount`).
        const checked = await crossCheckRowCount(
          client,
          table,
          query,
          rows.length,
        );
        if (checked.kind === "complete") return rows;
        if (checked.kind === "count-mismatch") {
          throw new TestStoreInfrastructureError(
            `GET ${table} (${query}): the Stats API counted ${checked.count} row(s) but the Table API returned ${rows.length} with no X-Total-Count (count-mismatch) — refusing to continue on a possibly truncated result`,
          );
        }
        throw new TestStoreInfrastructureError(
          `GET ${table} (${query}): no X-Total-Count and the Stats API count that would confirm the end of the read is unavailable (count-unavailable: ${checked.error.message}) — refusing to continue on a possibly truncated result`,
          {
            cause: checked.error,
            ...(checked.error.status === undefined
              ? {}
              : { status: checked.error.status }),
          },
        );
      }
    }
  };

  /**
   * The run's own rows in `table` (`name` starts with `prefix`).
   *
   * Delegated decision 2026-09-25: `STARTSWITH` is case-INSENSITIVE on
   * ServiceNow (and in the fake), so `nameSTARTSWITHnightly-1:` also returns
   * `Nightly-1:` rows — another run's records. The query is only a coarse
   * pre-filter; the case-sensitive `startsWith` below is what attributes a
   * row to this run. Every derived lookup (links, steps, inputs) is keyed
   * off these filtered sys_ids.
   */
  const namespaceRows = async (table: string, prefix: string): Promise<Row[]> =>
    (
      await queryAll(table, `nameSTARTSWITH${prefix}`, [
        "sys_id",
        "name",
        "description",
      ])
    ).filter((row) => fieldString(row, "name").startsWith(prefix));

  const create = async (
    table: string,
    body: Record<string, string>,
    what: string,
  ): Promise<string> => {
    const response = await requestOrFault<unknown>(
      client,
      { method: "POST", path: tablePath(table), body },
      `POST ${table} (${what})`,
    );
    return sysIdOf(resultOf(response.data, `POST ${table}`), `create ${what}`);
  };

  const update = async (
    table: string,
    sysId: string,
    body: Record<string, string>,
    what: string,
  ): Promise<void> => {
    await requestOrFault<unknown>(
      client,
      { method: "PATCH", path: tablePath(table, sysId), body },
      `PATCH ${table}/${sysId} (${what})`,
    );
  };

  /** DELETE; a 404 means "already gone", which is what idempotence needs. */
  const remove = async (table: string, sysId: string): Promise<void> => {
    try {
      await requestOrFault<unknown>(
        client,
        { method: "DELETE", path: tablePath(table, sysId) },
        `DELETE ${table}/${sysId}`,
      );
    } catch (error) {
      if (
        error instanceof TestStoreInfrastructureError &&
        error.status === 404
      ) {
        return;
      }
      throw error;
    }
  };

  const idsOf = (rows: readonly Row[]): string[] =>
    rows.map((row) => fieldString(row, "sys_id")).filter((id) => id !== "");

  const inList = (ids: readonly string[]): string => ids.join(",");

  const checkAborted = (ctx: PipelineContext): void => {
    ctx.signal.throwIfAborted();
  };

  /**
   * Spike 0: on a live instance the platform may auto-create the step's input
   * row when the step is inserted. Update-then-create covers both worlds.
   */
  const installScript = async (
    stepSysId: string,
    script: string,
  ): Promise<void> => {
    const existing = await queryAll(
      ATF_STORE_TABLES.stepInput,
      `document=${STEP_INPUT_DOCUMENT}` +
        `^document_key=${stepSysId}` +
        `^variable=${TEST_SCRIPT_INPUT_VARIABLE}`,
      ["sys_id"],
    );
    const first = existing[0];
    if (first !== undefined) {
      await update(
        ATF_STORE_TABLES.stepInput,
        sysIdOf(first, "locate step input"),
        { value: script },
        "step input (test script)",
      );
      return;
    }
    await create(
      ATF_STORE_TABLES.stepInput,
      {
        document: STEP_INPUT_DOCUMENT,
        document_key: stepSysId,
        variable: TEST_SCRIPT_INPUT_VARIABLE,
        value: script,
      },
      "step input (test script)",
    );
  };

  const validateSpecs = (
    specs: readonly TestSpec[],
  ): Array<{ spec: TestSpec; key: string; payload: AtfScriptPayload }> => {
    const seen = new Set<string>();
    return specs.map((spec) => {
      const key = specKey(spec.ref);
      if (seen.has(key)) {
        throw new TestStoreRefusalError(
          "payload",
          `spec ${spec.ref.id} (${spec.ref.path}) appears twice — a ProjectionMap holds one record per spec key`,
        );
      }
      seen.add(key);
      if (!isAtfScriptPayload(spec.payload)) {
        throw new TestStoreRefusalError(
          "payload",
          `spec ${spec.ref.id} (${spec.ref.path}) carries no { script } payload — the ATF TestStore has nothing to author`,
        );
      }
      return { spec, key, payload: spec.payload };
    });
  };

  const releaseLock = (): void => {
    lock?.release();
    lock = undefined;
  };

  return {
    release: releaseLock,

    lastChannelCheck: () => channelCheck,

    async project(
      ctx: PipelineContext,
      specs: readonly TestSpec[],
    ): Promise<ProjectionMap> {
      if (ctx.lifecycle !== "ephemeral") {
        // §4a/DEV-12: persistent mode needs the manifest + natural-key upsert,
        // and projecting "persistent" records this store can never find again
        // would leave undeletable state behind.
        throw new TestStoreRefusalError(
          "lifecycle",
          `the ATF TestStore implements only the §4a ephemeral lifecycle (got "${String(ctx.lifecycle)}"); persistent projection needs the DEV-12 manifest`,
        );
      }
      // Everything that needs no I/O is refused before the lock is taken.
      const planned = validateSpecs(specs);
      if (lock !== undefined) {
        throw new TestStoreRefusalError(
          "lock-held",
          `this store already holds the projection lock ${lock.path}; tear down or release() before projecting again`,
        );
      }
      const runId = assertSafeRunId(ctx.runId);
      lock = acquireProjectionLock(lockPath, { runId });
      try {
        checkAborted(ctx);
        const verdict = await checkAuthoringChannel(client, expected);
        if (verdict.outcome === "minor-mismatch") warn(verdict.warning);

        const prefix = `${runId}:`;
        checkAborted(ctx);
        const occupied = await namespaceRows(ATF_STORE_TABLES.test, prefix);
        if (occupied.length > 0) {
          throw new TestStoreRefusalError(
            "namespace-occupied",
            `run ${runId} already has ${occupied.length} projected sys_atf_test record(s); projecting again would duplicate them — tear the run down first`,
          );
        }

        const map: Record<string, ProjectedRecord> = {};
        if (planned.length === 0) {
          channelCheck = verdict;
          return map;
        }

        // Creation order IS the reverse of the DEV-13 delete order.
        checkAborted(ctx);
        const suiteSysId = await create(
          ATF_STORE_TABLES.suite,
          {
            name: `${prefix}suite`,
            active: "true",
            description: `${runOwnershipMarker(runId)}DEV-8/DEV-19 throwaway suite (the CI/CD API runs suites only)`,
          },
          "throwaway suite",
        );
        for (const [index, { spec, key, payload }] of planned.entries()) {
          checkAborted(ctx);
          const order = String(index + 1);
          const testSysId = await create(
            ATF_STORE_TABLES.test,
            {
              // ARCH-26: the run-id prefix is the attribution + probe key.
              name: `${prefix}${spec.ref.id}`,
              active: "true",
              description: `${runOwnershipMarker(runId)}projected from spec ${spec.ref.id} (${spec.ref.path})`,
            },
            `test for spec ${spec.ref.id}`,
          );
          await create(
            ATF_STORE_TABLES.suiteTest,
            { test_suite: suiteSysId, test: testSysId, order },
            `suite→test link for spec ${spec.ref.id}`,
          );
          const stepSysId = await create(
            ATF_STORE_TABLES.step,
            {
              test: testSysId,
              step_config: RUN_SERVER_SIDE_SCRIPT_STEP_CONFIG,
              order: "1",
              active: "true",
              description: `${runOwnershipMarker(runId)}server-side script for spec ${spec.ref.id}`,
            },
            `step for spec ${spec.ref.id}`,
          );
          await installScript(stepSysId, payload.script);
          map[key] = { testSysId, suiteSysId, runId };
        }
        channelCheck = verdict;
        return map;
      } catch (error) {
        // The lock guards a LIVE projection. A projection that failed is not
        // live — core will not call teardown, and records it left are W1/W2
        // orphans for `cleanup --run` / the next teardown's namespace sweep.
        releaseLock();
        throw error;
      }
    },

    async teardown(ctx: AtfTeardownContext): Promise<void> {
      const runId = assertSafeRunId(ctx.runId);
      const recordedTriggers = assertRecordedTriggers(
        runId,
        ctx,
        options.requireRecordedTriggers === true,
      );
      const prefix = `${runId}:`;
      const marker = runOwnershipMarker(runId);
      const testRows = await namespaceRows(ATF_STORE_TABLES.test, prefix);
      const suiteRows = await namespaceRows(ATF_STORE_TABLES.suite, prefix);
      const tests = idsOf(testRows);
      const suites = idsOf(suiteRows);
      const ownedSuites = new Set(suites);

      // Every refusal below is decided BEFORE the first DELETE, so a refused
      // teardown deletes nothing.
      const notOwned: string[] = [];

      // Delegated decision 2026-09-26 (F2a): a namespaced test or suite is
      // deleted only when it carries this run's ownership marker. A row that
      // does not (a customer's `smoke:login`, another tool's row, a row whose
      // description the session cannot read) refuses the WHOLE teardown
      // rather than being skipped: deleting the run's own test would still
      // cascade into whatever references it, and a partial sweep hides the
      // collision from the operator. Fail closed.
      for (const [table, rows] of [
        [ATF_STORE_TABLES.test, testRows],
        [ATF_STORE_TABLES.suite, suiteRows],
      ] as const) {
        for (const row of rows) {
          if (!fieldString(row, "description").startsWith(marker)) {
            notOwned.push(
              `${table} ${fieldString(row, "sys_id")} ("${fieldString(row, "name")}") lacks the "${marker}" description marker`,
            );
          }
        }
      }

      // DEV-13 order. Links are found from both ends so an orphan link whose
      // test was already removed is still reclaimed.
      const links = new Map<string, Row>();
      const linkFields = ["sys_id", "test_suite", "test"] as const;
      if (tests.length > 0) {
        for (const row of await queryAll(
          ATF_STORE_TABLES.suiteTest,
          `testIN${inList(tests)}`,
          linkFields,
        )) {
          links.set(fieldString(row, "sys_id"), row);
        }
      }
      if (suites.length > 0) {
        for (const row of await queryAll(
          ATF_STORE_TABLES.suiteTest,
          `test_suiteIN${inList(suites)}`,
          linkFields,
        )) {
          links.set(fieldString(row, "sys_id"), row);
        }
      }
      links.delete("");
      // Delegated decision 2026-09-26 (F2b): a link is deleted only when its
      // SUITE is run-owned. A run-owned test linked from a foreign suite (or
      // from a suite that no longer exists, whose ownership cannot be shown)
      // means someone else references our test: unlinking it would edit their
      // suite, and deleting the test would cascade into it. Refuse and report.
      // A link from a run-owned suite to a foreign test is ours to remove —
      // the foreign test itself is never touched.
      for (const [id, row] of links) {
        const suite = fieldString(row, "test_suite");
        if (!ownedSuites.has(suite)) {
          notOwned.push(
            `${ATF_STORE_TABLES.suiteTest} ${id} links test ${fieldString(row, "test")} into suite ${suite === "" ? "(none)" : suite}, which is not a run-owned suite`,
          );
        }
      }

      if (notOwned.length > 0) {
        const shown = notOwned.slice(0, MAX_REPORTED_ROWS);
        const more = notOwned.length - shown.length;
        throw new TestStoreRefusalError(
          "not-run-owned",
          `refusing to tear down run ${runId}: ${notOwned.length} row(s) in or linked to its namespace are not provably run-owned — ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""} (nothing was deleted; remove or rename the foreign rows, or clean up by hand)`,
        );
      }

      // DEV-17: never delete under a run that is not provably terminal. Every
      // link about to be deleted hangs off a suite in `suites` (checked
      // above), so gating `suites` gates the suite of every deleted link.
      if (suites.length > 0) {
        const results = await queryAll(
          ATF_STORE_TABLES.suiteResult,
          `test_suiteIN${inList(suites)}`,
          ["sys_id", "status"],
        );
        // Delegated decision 2026-09-25: NO result row is not "nothing is
        // running". On a real instance the CI/CD trigger answers before the
        // sys_atf_test_suite_result row exists, so a queued execution looks
        // exactly like a never-triggered suite. Fail closed: refuse unless
        // the caller explicitly asserts no trigger ever happened.
        //
        // Delegated decision 2026-09-28 (wave 13): one terminal row used to
        // pass the gate even if a SECOND execution of the same suite (e.g. a
        // second runner group over the run's one suite) was queued with no
        // row yet — the instance offers no sound signal for "a trigger with
        // no row". The caller's ledger does: each recorded trigger owes one
        // result row, so fewer rows than recorded triggers refuses. Without
        // a count (legacy caller) the gate below is the pre-wave-13 one.
        if (
          recordedTriggers !== undefined &&
          results.length < recordedTriggers
        ) {
          throw new TestStoreRefusalError(
            "non-terminal-run",
            `refusing to tear down run ${runId}: its ledger records ${recordedTriggers} suite trigger(s) but suite(s) ${inList(suites)} have only ${results.length} ${ATF_STORE_TABLES.suiteResult} row(s) — a triggered execution may still be queued (DEV-17 — nothing was deleted; the records are left for cleanup --run / the orphan sweep)`,
          );
        }
        if (results.length === 0 && ctx.neverTriggered !== true) {
          throw new TestStoreRefusalError(
            "non-terminal-run",
            `refusing to tear down run ${runId}: suite(s) ${inList(suites)} exist but have no ${ATF_STORE_TABLES.suiteResult} row — a triggered execution may still be queued, and nothing asserted the suite was never triggered (DEV-17 — nothing was deleted; the records are left for cleanup --run / the orphan sweep)`,
          );
        }
        for (const row of results) {
          const status = fieldString(row, "status").toLowerCase();
          if (!TERMINAL_SUITE_RESULT_STATUSES.has(status)) {
            throw new TestStoreRefusalError(
              "non-terminal-run",
              `refusing to tear down run ${runId}: ${ATF_STORE_TABLES.suiteResult} ${fieldString(row, "sys_id")} reads status "${status}", which is not provably terminal (DEV-17 — nothing was deleted; the records are left for cleanup --run / the orphan sweep)`,
            );
          }
        }
      } else if (tests.length > 0 && ctx.neverTriggered !== true) {
        // Delegated decision 2026-09-26 (F2c): run-owned tests with NO
        // run-owned suite used to skip the gate entirely. projection creates
        // the suite first and teardown deletes it last, so this state means
        // the suite was removed out of band — its results (which outlive it)
        // can no longer be found by suite id, and a live execution cannot be
        // ruled out. Same rule as the zero-result case: refuse unless the
        // caller asserts the run was never triggered.
        throw new TestStoreRefusalError(
          "non-terminal-run",
          `refusing to tear down run ${runId}: ${tests.length} run-owned ${ATF_STORE_TABLES.test} row(s) exist but no run-owned ${ATF_STORE_TABLES.suite} does, so no ${ATF_STORE_TABLES.suiteResult} can prove the run terminal, and nothing asserted it was never triggered (DEV-17 — nothing was deleted)`,
        );
      }

      for (const id of links.keys()) {
        await remove(ATF_STORE_TABLES.suiteTest, id);
      }

      // Delegated decision 2026-09-26 (F2a): steps and step inputs carry no
      // marker check of their own — they are owned BY DERIVATION, reached
      // only through a run-owned test's sys_id (`testIN`, then the owned
      // steps' `document_key`). A step's `description` is not a reliable
      // marker: the platform may regenerate it from the step config, and the
      // platform cascades a test's steps on delete anyway.
      const steps =
        tests.length === 0
          ? []
          : idsOf(
              await queryAll(ATF_STORE_TABLES.step, `testIN${inList(tests)}`, [
                "sys_id",
              ]),
            );
      if (steps.length > 0) {
        const inputs = idsOf(
          await queryAll(
            ATF_STORE_TABLES.stepInput,
            `document=${STEP_INPUT_DOCUMENT}^document_keyIN${inList(steps)}`,
            ["sys_id"],
          ),
        );
        for (const id of inputs) await remove(ATF_STORE_TABLES.stepInput, id);
      }
      for (const id of steps) await remove(ATF_STORE_TABLES.step, id);
      for (const id of tests) await remove(ATF_STORE_TABLES.test, id);
      // Suite results are the run's evidence (QA-17/DEV-21) and stay.
      for (const id of suites) await remove(ATF_STORE_TABLES.suite, id);

      releaseLock();
    },
  };
}
