// QA-18 — the in-memory table model. This is the part that makes the Tier-2
// job a *stateful fake* rather than response replay: creates mint a sys_id and
// store the row, updates mutate it, deletes remove it, and every subsequent
// read reflects those writes. §4a's write-sequence invariants (delete
// ordering, fresh-create identity, sweep scoping) are only falsifiable against
// a store like this one.

import type { RunId } from "@tessera/types";
import type { FakeClock } from "./clock.js";
import type { IdGenerator } from "./ids.js";
import {
  RESERVED_FIELDS,
  coerceRecord,
  projectFields,
  setOwn,
  type SnRecord,
  type StoredRecord,
} from "./record.js";
import {
  DEFAULT_UNKNOWN_QUERY_FIELD,
  applyUnknownFieldPolicy,
  matchQuery,
  parseQuery,
  sortRecords,
  type QuerySemantics,
} from "./query.js";
import type { FakeReadAcl } from "./acl.js";

export interface TableQueryOptions {
  /** Encoded `sysparm_query` (see `query.ts` for the supported subset). */
  query?: string;
  /** `sysparm_fields` projection. */
  fields?: readonly string[];
  /** `sysparm_limit`; absent means "no limit" (the router applies the default). */
  limit?: number;
  /** `sysparm_offset`. */
  offset?: number;
  /**
   * W6a L3 read ACL: applied to the fetched page only — hidden rows drop out
   * of `records` but still count toward `total`, denied fields read "".
   */
  readAcl?: FakeReadAcl;
}

export interface TableQueryResult {
  /** The page of rows, already projected onto `fields`. */
  records: StoredRecord[];
  /** All matching rows before limit/offset — the `X-Total-Count` value. */
  total: number;
}

/** A row plus the table it lives in — what the sweep assertions inspect. */
export interface LocatedRecord {
  table: string;
  record: StoredRecord;
}

export interface FakeTableStore {
  /** Create a row; returns the stored row including its minted `sys_id`. */
  insert(table: string, fields: SnRecord, sysId?: string): StoredRecord;
  /** Read one row by `sys_id`, or `undefined` when absent (a real 404). */
  get(table: string, sysId: string): StoredRecord | undefined;
  /** Merge `fields` into an existing row; `undefined` when the row is gone. */
  update(
    table: string,
    sysId: string,
    fields: SnRecord,
  ): StoredRecord | undefined;
  /** Remove a row; `false` when it was already absent (delete is idempotent). */
  remove(table: string, sysId: string): boolean;
  /** Filter + sort + page. */
  query(table: string, options?: TableQueryOptions): TableQueryResult;
  /** Every row of a table in insertion order. */
  all(table: string): StoredRecord[];
  /** Row count of a table. */
  count(table: string): number;
  /** Names of every table that currently holds at least one row. */
  tables(): string[];
  /** Bulk-load rows without minting ids for rows that already carry one. */
  seed(tables: Readonly<Record<string, readonly SnRecord[]>>): void;
  /** Deep copy of the whole state — safe to assert on or serialize. */
  snapshot(): Record<string, StoredRecord[]>;
  /** Every row (across tables) whose fields satisfy `predicate`. */
  find(
    predicate: (record: StoredRecord, table: string) => boolean,
  ): LocatedRecord[];
  /**
   * §4b Tier-2 pass criterion — "zero records matching the dead run-id".
   * A row matches when any field value equals `runId` or contains it as a
   * substring (§4a tags rows either by a `runId` field or by a name prefix).
   *
   * Throws on a blank run id rather than answering `[]`: an empty id matches
   * every row, so "no matches" would be a false green for the one assertion
   * the sweep depends on.
   */
  recordsForRun(runId: RunId): LocatedRecord[];
  /** Drop all rows (used by `FakeInstance.reset`). */
  clear(): void;
}

/** Default page size of the Table API when `sysparm_limit` is absent. */
export const DEFAULT_TABLE_LIMIT = 10000;

export interface TableStoreDeps {
  ids: IdGenerator;
  clock: FakeClock;
  /** W6a M1/L3 query semantics; every absent knob keeps its default. */
  semantics?: QuerySemantics;
  /**
   * Declared fields per table (W6a M1). The fake is schemaless, so a field
   * is "known" to the unknown-field policy when any stored row of the table
   * has it as an own key OR it is declared here — which lets a suite seed
   * sparse rows and still have `field=value` filter rather than be ignored.
   */
  tableSchema?: Readonly<Record<string, readonly string[]>>;
}

export function createTableStore({
  ids,
  clock,
  semantics = {},
  tableSchema = {},
}: TableStoreDeps): FakeTableStore {
  const unknownQueryField =
    semantics.unknownQueryField ?? DEFAULT_UNKNOWN_QUERY_FIELD;

  // Delegated decision 2026-09-26: "unknown field" = no stored row of the
  // table carries it as an own key and `tableSchema` does not declare it.
  // The fake has no dictionary, so observed keys are the only schema it has.
  const knownFields = (
    table: string,
    rows: readonly StoredRecord[],
  ): Set<string> => {
    const known = new Set<string>(
      Object.hasOwn(tableSchema, table) ? (tableSchema[table] ?? []) : [],
    );
    for (const row of rows) for (const key of Object.keys(row)) known.add(key);
    return known;
  };

  // Map preserves insertion order, which is the fake's stable default ordering.
  const tables = new Map<string, Map<string, StoredRecord>>();

  const tableOf = (table: string): Map<string, StoredRecord> => {
    let rows = tables.get(table);
    if (!rows) {
      rows = new Map<string, StoredRecord>();
      tables.set(table, rows);
    }
    return rows;
  };

  const write = (
    table: string,
    fields: SnRecord,
    explicitSysId: string | undefined,
  ): StoredRecord => {
    const rows = tableOf(table);
    const coerced = coerceRecord(fields);
    // A caller-supplied sys_id wins (fixtures replay real ids); otherwise the
    // seeded generator mints one — never Math.random().
    const sysId = explicitSysId ?? coerced["sys_id"] ?? "";
    const id = sysId === "" ? ids.next(table) : sysId;
    const now = clock.now();
    const stored: StoredRecord = {
      ...coerced,
      sys_id: id,
      sys_created_on: coerced["sys_created_on"] ?? now,
      sys_updated_on: now,
      sys_mod_count: coerced["sys_mod_count"] ?? "0",
    };
    rows.set(id, stored);
    return { ...stored };
  };

  const find = (
    predicate: (record: StoredRecord, table: string) => boolean,
  ): LocatedRecord[] => {
    const hits: LocatedRecord[] = [];
    for (const [table, rows] of tables) {
      for (const row of rows.values()) {
        if (predicate(row, table)) hits.push({ table, record: { ...row } });
      }
    }
    return hits;
  };

  return {
    insert(table, fields, sysId) {
      return write(table, fields, sysId);
    },

    get(table, sysId) {
      const row = tables.get(table)?.get(sysId);
      return row ? { ...row } : undefined;
    },

    update(table, sysId, fields) {
      const rows = tables.get(table);
      const existing = rows?.get(sysId);
      if (!rows || !existing) return undefined;
      const patch = coerceRecord(fields);
      // Every RESERVED_FIELD is store-maintained, never caller-supplied: the
      // Table API drops sys_id / sys_created_on / sys_updated_on /
      // sys_mod_count out of an update body and echoes the stored values back.
      // Dropping only sys_id used to leave sys_created_on writable, so the fake
      // accepted — and reported 200 for — a rewrite of a row's creation stamp
      // that no real instance performs.
      for (const reserved of RESERVED_FIELDS) delete patch[reserved];
      const modCount = Number(existing["sys_mod_count"] ?? "0");
      const updated: StoredRecord = {
        ...existing,
        ...patch,
        sys_id: sysId,
        sys_updated_on: clock.now(),
        sys_mod_count: String((isFinite(modCount) ? modCount : 0) + 1),
      };
      rows.set(sysId, updated);
      return { ...updated };
    },

    remove(table, sysId) {
      return tables.get(table)?.delete(sysId) ?? false;
    },

    query(table, options = {}) {
      const rows = [...(tables.get(table)?.values() ?? [])];
      const parsed = applyUnknownFieldPolicy(
        parseQuery(options.query),
        knownFields(table, rows),
        unknownQueryField,
      );
      const matched =
        parsed === null
          ? []
          : sortRecords(
              rows.filter((row) => matchQuery(row, parsed, semantics)),
              parsed.sort,
            );
      const offset = Math.max(0, options.offset ?? 0);
      const limit = Math.max(0, options.limit ?? DEFAULT_TABLE_LIMIT);
      let page = matched.slice(offset, offset + limit);
      const readAcl = options.readAcl;
      if (readAcl) {
        page = page
          .filter((row) => !readAcl.hides(table, row))
          .map((row) => readAcl.redact(table, row));
      }
      return {
        records: page.map((row) => projectFields(row, options.fields)),
        total: matched.length,
      };
    },

    all(table) {
      return [...(tables.get(table)?.values() ?? [])].map((row) => ({
        ...row,
      }));
    },

    count(table) {
      return tables.get(table)?.size ?? 0;
    },

    tables() {
      return [...tables.entries()]
        .filter(([, rows]) => rows.size > 0)
        .map(([name]) => name)
        .sort();
    },

    seed(seedTables) {
      for (const [table, rows] of Object.entries(seedTables)) {
        for (const row of rows) write(table, row, undefined);
      }
    },

    snapshot() {
      const out: Record<string, StoredRecord[]> = {};
      for (const [table, rows] of tables) {
        // Delegated decision 2026-09-26: `setOwn` so a `__proto__` table is
        // in the snapshot instead of being swallowed by the prototype setter.
        setOwn(
          out,
          table,
          [...rows.values()].map((row) => ({ ...row })),
        );
      }
      return out;
    },

    find,

    recordsForRun(runId) {
      // A blank run id is not a run id. Answering [] would let the §4b pass
      // criterion ("zero records matching the dead run-id") succeed vacuously
      // whenever the caller's run id never got set — the precise false green
      // the criterion exists to catch. Refuse the question instead of
      // answering a question nobody asked.
      if (typeof runId !== "string" || runId.trim() === "") {
        throw new TypeError(
          "fake instance: recordsForRun needs a non-empty run id " +
            "(a blank id would report every run as fully swept)",
        );
      }
      return find((record) =>
        Object.values(record).some((value) => value.includes(runId)),
      );
    },

    clear() {
      tables.clear();
    },
  };
}
