// Vendored from github.com/IvanBBaev/syncrona @ 73cae76 (packages/core/src/manifestBuilder.ts).
// GPL-3.0 upstream; dual-licensed for this use by the sole author/copyright owner (ADR-002 option 4).
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Adaptations (see VENDORED.md): upstream reaches the Logger and ConfigManager
// module singletons and reads process.env directly; here the three public
// builders live on a `createManifestBuilder(options)` factory with the logger,
// the previous-manifest accessor, and the environment injected (env still
// defaults to process.env, and the switch names are unchanged; the upstream
// `String(...)` coercion around each switch read is gone, which only an untyped
// caller could notice — the injected `env` is typed
// `Record<string, string | undefined>`). The response-row
// *index* lookups upstream already guarded with `?.`; what changed here is the
// three field reads in `listAppsFromTableAPI`, which now coalesce to `""`.
// That is NOT the same observable behavior: upstream returned `r.sys_id`
// unnormalised while `SN.App` declares it `string`, so an absent field yielded
// `undefined` typed as a string — the exact defect `recordSysId`'s comment
// below records as having turned into the literal `"undefined"` and "looked
// like a real record forever after". No production code in this workspace calls
// `listAppsFromTableAPI`; only this package's own tests do (the SN.App-shape,
// network-error and endpoint-unavailable cases in test/manifestBuilder.test.js),
// and each of them either supplies rows carrying all three fields or throws
// before a row is read, so no consumer observes either value today.
// `getScopeId` returns a three-case `ScopeLookup` instead of
// upstream's `string | null`, so a scope lookup that could not run is no longer
// reported to the caller as a scope that is not there. Pure helpers stay
// module-level exports.

import { SN, Sync } from "./types.js";
import {
  isEndpointNotFoundStatus,
  isSafePathComponent,
  SNClient,
  getErrorResponseStatus,
  StoreLogger,
} from "./support.js";
import {
  SN_TYPE_QUERY,
  getDisplayField,
  getFileTypeForInternalType,
} from "./fieldMap.js";

type TableAPIRecord = Record<string, string>;
type TableAPIResponse = { result: TableAPIRecord[] };
const MAX_TABLE_HIERARCHY_DEPTH = 10;
const SYS_ID_CHUNK_SIZE = 200;

// Delegated decision 2026-09-28 (wave 13): a sys_idIN chunk is bounded by the
// length of the encoded query as well as by its id count. 200 ids is ~7 KB once
// every comma is percent-encoded, before the field list and the rest of the URL
// are added — close to the 8 KB request-line limit common in front of an
// instance. The budget below keeps each chunk's encoded `sys_idIN` list under
// 6000 characters; with 32-character sys_ids that is 171 ids per chunk.
// Reversible: raising it only makes chunks larger again.
const SYS_ID_QUERY_MAX_ENCODED_CHARS = 6000;

// Delegated decision 2026-09-28 (wave 13): total-row caps for the reads that
// used to be a single fixed-limit request (sys_db_object / sys_dictionary table
// discovery, the per-table dictionary field reads, and the sys_app listing).
// Each is now paged through tableAPIGetAllRows, and reaching the cap throws
// TableAPIPagingError instead of returning the rows seen so far. The values sit
// well above anything a real scope produces (a scoped dictionary with 100k
// columns, a table hierarchy with 20k dictionary entries, 10k installed apps),
// so hitting one means the query is not the one intended, not a big instance.
// Reversible: each is a constant, and a false alarm fails loudly by design.
export const TABLE_DISCOVERY_MAX_ROWS = 100_000;
export const DICTIONARY_FIELD_MAX_ROWS = 20_000;
export const LIST_APPS_MAX_ROWS = 10_000;

// Delegated decision 2026-09-30 (wave 14): the same total-row cap for the two
// sys_metadata reads (whole-scope table discovery in getTableNamesInScope and
// the per-table sys_id fallback in getScopeMetadataRowsForTable). They were
// paged but bounded only by TABLE_API_MAX_PAGES (1000 pages of 10000 = ten
// million rows). sys_metadata holds every metadata record of the scope, not
// just its tables, so the cap sits above TABLE_DISCOVERY_MAX_ROWS; a scope with
// a quarter of a million metadata records means the scope filter is not the one
// intended. Exceeding it throws TableAPIPagingError ("row cap"), never a
// truncation, and it is not a skippable 403/404, so discovery does not fall
// back to a narrower source. Reversible: a constant, and a false alarm fails
// loudly by design.
export const SCOPE_METADATA_MAX_ROWS = 250_000;

// PERF-7 (REV-100): default cap for how many tables buildManifestFromTableAPI
// enumerates in parallel. Without a cap a wide scope fired one concurrent
// Table-API request chain per table at once, hammering the instance and risking
// EMFILE/socket exhaustion. Clamped to 1–50; an optional `tableConcurrency`
// field on the passed config overrides it.
const DEFAULT_MANIFEST_TABLE_CONCURRENCY = 20;

const resolveManifestTableConcurrency = (config: unknown): number => {
  // `tableConcurrency` is an internal override that the public config param type
  // intentionally does not name, so read it via a loose structural check rather
  // than a strongly-typed field (which would trip TS's weak-type test at the
  // callsite, where a Pick<Config, ...> carries no such property).
  const candidate =
    config && typeof config === "object"
      ? (config as { tableConcurrency?: unknown }).tableConcurrency
      : undefined;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    return DEFAULT_MANIFEST_TABLE_CONCURRENCY;
  }
  return Math.min(Math.max(Math.floor(candidate), 1), 50);
};

// Bounded worker pool (copied from the pull/push seams, where the equivalent
// helper is not exported) so the table enumeration above can run in parallel
// without an unbounded fan-out.
const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }

  const results: R[] = new Array<R>(items.length);
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;
  // Abort on the first failure. Previously a rejecting worker only rejected the
  // Promise.all, while every other runner kept pulling items off the queue: the
  // caller had already unwound while those workers were still querying the
  // instance, and all but the first error were discarded. Collect the errors,
  // stop scheduling new work, and rethrow.
  const errors: unknown[] = [];

  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (nextIndex < items.length && errors.length === 0) {
        const current = nextIndex;
        nextIndex += 1;
        try {
          results[current] = await worker(items[current] as T, current);
        } catch (e) {
          errors.push(e);
        }
      }
    },
  );

  await Promise.all(runners);
  if (errors.length > 0) {
    // Rethrow a lone error unchanged so callers can still classify it
    // (isScopedEndpointUnavailableError, retry predicates, status codes).
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(
          errors,
          `${errors.length} concurrent operations failed.`,
        );
  }
  return results;
};

// 403/404 mean the table is not queryable for this user/instance (ACL,
// missing table) — a legitimate "skip this table" case. Anything else
// (network, 5xx, auth) is a real failure that must NOT be treated as
// "no records", otherwise an outage silently produces a truncated manifest.
//
// Delegated decision 2026-09-26 (W7b L9): 400 is no longer skippable here. A 400
// is the instance rejecting the REQUEST (a malformed encoded query, a bad field
// list, an over-long sys_idIN URL), not refusing the table — skipping it hid our
// own bugs as "no access" and let the carry-forward paper over them. It now
// faults the table (failedTables). isEndpointNotFoundStatus keeps 400 for its
// other caller (scoped-endpoint availability), which is a different question.
const TABLE_SKIPPABLE_STATUSES: readonly number[] = [403, 404];
function isTableSkippableError(e: unknown): boolean {
  const status = getErrorResponseStatus(e);
  return (
    typeof status === "number" && TABLE_SKIPPABLE_STATUSES.includes(status)
  );
}

// Delegated decision 2026-09-26 (W5a #3): the upper bound on pages one paged read
// may request. At the largest call-site page size (10000) that is ten million rows,
// far beyond any scoped app; at 500 it is half a million records of one table.
// Reaching it means the server is not advancing (or the table is absurd), and the
// read throws rather than returning whatever it has so far.
export const TABLE_API_MAX_PAGES = 1000;

/**
 * Thrown when a paged Table API read cannot prove it enumerated every row: the
 * page cap was reached, the server returned the same page again (offset ignored),
 * or the rows received disagree with the client-reported total. Distinct from an
 * HTTP failure so callers with a broad "fall back to another discovery source"
 * catch can let it through instead of silently switching sources.
 */
export class TableAPIPagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableAPIPagingError";
  }
}

const ORDER_BY_SYS_ID = "ORDERBYsys_id";

// A stable identity for a page's first row, for the no-progress check. sys_id is
// always selected (see below), so the JSON fallback only matters for a server that
// omits it — and then two identical first rows still read as "no progress", which
// is the fail-closed direction.
const firstRowKey = (page: TableAPIRecord[]): string | undefined => {
  const first = page[0];
  if (first === undefined) {
    return undefined;
  }
  const id = (first as Record<string, unknown>).sys_id;
  return typeof id === "string" && id !== "" ? id : JSON.stringify(first);
};

// Pages through the Table API so tables with more rows than the page size are
// fully enumerated instead of silently truncated.
//
// Delegated decision 2026-09-26 (W5a #3): the old loop stopped at the first page
// shorter than pageSize and advanced the offset by pageSize. A server that caps a
// response below pageSize (instance row limits) therefore truncated silently after
// one page, and a server that ignored the offset looped forever. Now:
//   - the query is ordered by sys_id and sys_id is always selected, so offsets walk
//     a stable sequence and the no-progress check has a key;
//   - the offset advances by the rows actually received, and the walk ends only on
//     an EMPTY page (one extra request per read — the price of not trusting a short
//     page to mean "the end");
//   - a page whose first row repeats the previous page's first row, or a walk that
//     reaches TABLE_API_MAX_PAGES, throws TableAPIPagingError;
//   - when the client reports a total (X-Total-Count) the final row count must match
//     it, else TableAPIPagingError. A total that is absent or not a finite number is
//     not cross-checked.
//   - Delegated decision 2026-09-30 (wave 15): the total is also checked page to
//     page. Every page of one read must report the same total; a total that
//     changes mid-read means rows were inserted or deleted between pages, and
//     offset paging then skips or repeats rows even when the final count happens
//     to match the latest total (six counted, one deleted, five received, the
//     skipped row never seen). That throws TableAPIPagingError.
//   - Delegated decision 2026-09-30 (wave 15): a read that no total vouches for is
//     never passed off as verified. Under the builder's `requireTotalCount` option
//     a page without a finite total throws TableAPIPagingError; by default the
//     read is recorded on the entry point's TotalCountTracker and the entry point
//     warns once, naming every such read. `total` stays optional on the SNClient
//     contract (support.ts) because no adapter in this workspace supplies it yet —
//     the default is not "require" so existing clients keep working, but they are
//     no longer silent about it.
//   - Delegated decision 2026-09-28 (wave 13): an optional `maxRows` total-row
//     cap. A page that would take the read past it throws TableAPIPagingError
//     ("row cap") — never a silent truncation to the first `maxRows` rows.
// Per-call record of the paged reads that no X-Total-Count vouched for. Keyed by
// the wrapper client an entry point creates (trackTotalCounts), so concurrent
// builds on one builder, or on one underlying client, never share a record.
interface TotalCountTracker {
  readonly require: boolean;
  readonly unverified: Set<string>;
}
const totalCountTrackers = new WeakMap<SNClient, TotalCountTracker>();

function trackTotalCounts(
  client: SNClient,
  require: boolean,
): { client: SNClient; tracker: TotalCountTracker } {
  const tracked: SNClient = {
    tableAPIGet: (...args: Parameters<SNClient["tableAPIGet"]>) =>
      client.tableAPIGet(...args),
  };
  const tracker: TotalCountTracker = { require, unverified: new Set() };
  totalCountTrackers.set(tracked, tracker);
  return { client: tracked, tracker };
}

function describeUnverifiedReads(
  tracker: TotalCountTracker,
): string | undefined {
  if (tracker.unverified.size === 0) return undefined;
  const tables = [...tracker.unverified].sort();
  return (
    `Completeness of ${tables.length} paged Table API read(s) is unverified: the client reported no X-Total-Count for ${tables.join(", ")}, ` +
    "so only the paging checks (no repeated page, no duplicate sys_id, an empty final page) vouch for them. " +
    "Set requireTotalCount to refuse such reads."
  );
}

async function tableAPIGetAllRows(
  client: SNClient,
  table: string,
  query: string,
  fields: string,
  pageSize: number,
  maxRows?: number,
): Promise<TableAPIRecord[]> {
  const orderedQuery = query ? `${query}^${ORDER_BY_SYS_ID}` : ORDER_BY_SYS_ID;
  const fieldList = fields.split(",").map((f) => f.trim());
  const selectedFields = fieldList.includes("sys_id")
    ? fields
    : `${fields},sys_id`;
  const rows: TableAPIRecord[] = [];
  let offset = 0;
  let previousFirst: string | undefined;
  let reportedTotal: number | undefined;
  let pageWithoutTotal = false;
  const tracker = totalCountTrackers.get(client);
  const seenSysIds = new Set<string>();
  for (let pageNo = 0; pageNo < TABLE_API_MAX_PAGES; pageNo += 1) {
    const res = await client.tableAPIGet(
      table,
      orderedQuery,
      selectedFields,
      pageSize,
      offset,
    );
    const pageTotal =
      typeof res.total === "number" && Number.isFinite(res.total)
        ? res.total
        : undefined;
    if (pageTotal === undefined) {
      if (tracker?.require) {
        throw new TableAPIPagingError(
          `Table API read of ${table} at offset ${offset} carried no X-Total-Count and requireTotalCount is set; refusing a result whose completeness cannot be verified.`,
        );
      }
      pageWithoutTotal = true;
    } else {
      if (reportedTotal !== undefined && pageTotal !== reportedTotal) {
        throw new TableAPIPagingError(
          `Table API read of ${table}: X-Total-Count reported ${pageTotal} at offset ${offset} but ${reportedTotal} on an earlier page; the result set changed between pages, so rows may have been skipped; refusing an unreliable result.`,
        );
      }
      reportedTotal = pageTotal;
    }
    const page = extractResult(res.data, table);
    if (page.length === 0) {
      if (reportedTotal !== undefined && reportedTotal !== rows.length) {
        throw new TableAPIPagingError(
          `Table API read of ${table} returned ${rows.length} rows but X-Total-Count reported ${reportedTotal}; refusing a possibly truncated result.`,
        );
      }
      if (pageWithoutTotal) {
        tracker?.unverified.add(table);
      }
      return rows;
    }
    const first = firstRowKey(page);
    if (pageNo > 0 && first === previousFirst) {
      throw new TableAPIPagingError(
        `Table API read of ${table} made no progress at offset ${offset}: the page repeats the previous one (the server may be ignoring sysparm_offset).`,
      );
    }
    previousFirst = first;
    // Delegated decision 2026-09-26 (W7b L9): offset paging over ORDERBYsys_id
    // must never see a sys_id twice. A repeat means the result set shifted under
    // us (inserts/deletes between pages) or the server ignores the ordering, so
    // some other row was skipped by the same shift — fail closed rather than
    // return a set that is both duplicated and short. Checked after the
    // no-progress check so a whole repeated page keeps its clearer message. Rows
    // without a usable sys_id are left to the callers' own sys_id filtering.
    for (const row of page) {
      const sysId = row.sys_id;
      if (typeof sysId !== "string" || sysId === "") continue;
      if (seenSysIds.has(sysId)) {
        throw new TableAPIPagingError(
          `Table API read of ${table} returned duplicate sys_id "${sysId}" at offset ${offset}: the result set shifted between pages, so rows may also have been skipped; refusing an unreliable result.`,
        );
      }
      seenSysIds.add(sysId);
    }
    if (maxRows !== undefined && rows.length + page.length > maxRows) {
      throw new TableAPIPagingError(
        `Table API read of ${table} exceeded the row cap of ${maxRows} rows at offset ${offset}; refusing a truncated result.`,
      );
    }
    rows.push(...page);
    offset += page.length;
  }
  throw new TableAPIPagingError(
    `Table API read of ${table} hit the page cap (${TABLE_API_MAX_PAGES} pages of up to ${pageSize}) without reaching an empty page; refusing a possibly truncated result.`,
  );
}

// Delegated decision 2026-09-26 (W7b L8): only a `result` ARRAY is an answer.
// This used to fold every other body into `[]` — an `{error}` body, an HTML login
// or maintenance page delivered with 200, a `{result:{rows:[]}}` shape — and an
// empty page is how paging ENDS, so a mid-walk bad body silently truncated the
// read; in getScopeId the same fold turned "the lookup broke" into "no such
// scope". A non-array result now throws TableAPIPagingError (it is the same
// "the rows seen so far cannot be trusted" fact the paging checks raise), which
// every caller treats as a real failure. Fail closed: only `{result: []}` is empty.
function extractResult(data: unknown, table: string): TableAPIRecord[] {
  const result: unknown =
    data !== null && typeof data === "object"
      ? (data as TableAPIResponse).result
      : undefined;
  if (Array.isArray(result)) {
    return result as TableAPIRecord[];
  }
  throw new TableAPIPagingError(
    `Table API read of ${table} returned a body without a result array (${describeBody(data)}); refusing to read it as an empty result.`,
  );
}

function describeBody(data: unknown): string {
  if (data === undefined || data === null) return "no body";
  if (typeof data === "string") return "a text body";
  if (typeof data !== "object") return `a ${typeof data} body`;
  const keys = Object.keys(data).slice(0, 5);
  return keys.length > 0 ? `keys: ${keys.join(", ")}` : "an empty object";
}

// Delegated decision 2026-09-26 (W7b L9): a sys_idIN chunk is a closed question
// ("return exactly these ids") asked with limit 500 against a chunk of at most
// SYS_ID_CHUNK_SIZE (200) ids and no paging, so the answer can be checked in full:
//   - a row whose sys_id was not requested, or a requested id twice, or more rows
//     than ids, means the server did not answer the query we sent (an ignored or
//     truncated sysparm_query) — always a failure;
//   - fewer matched ids than requested is explained only by a caller-supplied
//     tableOptions.query filter appended to the chunk. Without one, every id came
//     from sys_metadata for this very table, so a short answer is an unexplained
//     loss (row-level ACL, a record deleted mid-build, a truncated response) and
//     committing it would make the missing records look deleted. Fail closed; the
//     table lands in failedTables. The residual — a record genuinely deleted
//     between the two reads — fails the build and a rerun settles it.
//   - rows without a string sys_id are not counted here; toRecords drops them
//     with its own warning, and they still leave the chunk short.
//
// Delegated decision 2026-09-28 (wave 13): split into an audit that always throws
// on unrequested / duplicate / excess rows and RETURNS the missing ids, so each
// caller decides what a short answer means (the manifest fallback tolerates it
// only under a tableOptions.query; the bulk download never does) and the error
// can name the missing records instead of only counting them.
function auditSysIdChunk(
  rows: TableAPIRecord[],
  requested: string[],
  table: string,
): string[] {
  const wanted = new Set(requested);
  const matched = new Set<string>();
  for (const row of rows) {
    const sysId = row.sys_id;
    if (typeof sysId !== "string" || sysId === "") continue;
    if (!wanted.has(sysId)) {
      throw new TableAPIPagingError(
        `sys_idIN read of ${table} returned sys_id "${sysId}", which was not requested; the server did not answer the query that was sent.`,
      );
    }
    if (matched.has(sysId)) {
      throw new TableAPIPagingError(
        `sys_idIN read of ${table} returned duplicate sys_id "${sysId}"; refusing an unreliable result.`,
      );
    }
    matched.add(sysId);
  }
  if (rows.length > wanted.size) {
    throw new TableAPIPagingError(
      `sys_idIN read of ${table} returned ${rows.length} rows for ${wanted.size} requested ids; refusing an unreliable result.`,
    );
  }
  return [...wanted].filter((id) => !matched.has(id));
}

const MAX_IDS_IN_MESSAGE = 20;

function describeSysIds(ids: readonly string[]): string {
  const shown = ids
    .slice(0, MAX_IDS_IN_MESSAGE)
    .map((id) => `"${id}"`)
    .join(", ");
  const rest = ids.length - MAX_IDS_IN_MESSAGE;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * Thrown when a `sys_idIN` read does not return every requested record. Carries
 * the table and the missing ids so a caller can report or retry them; it is a
 * TableAPIPagingError, so every existing "the rows cannot be trusted" handler
 * treats it the same way.
 */
export class SysIdCompletenessError extends TableAPIPagingError {
  readonly table: string;
  readonly missingSysIds: readonly string[];
  constructor(
    table: string,
    missingSysIds: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = "SysIdCompletenessError";
    this.table = table;
    this.missingSysIds = missingSysIds;
  }
}

/** What an identifier interpolated into an encoded query names. */
export type QueryIdentifierKind = "scope" | "scope sys_id" | "table" | "field";

/**
 * Thrown before any request when a value that must be ONE ServiceNow
 * identifier — a scope code, a scope sys_id, a table name, a field name — would
 * be interpolated into an encoded query while carrying a character no such
 * identifier can contain. Not an HTTP error, so no skippable-error handler
 * mistakes it for a refused table.
 */
export class QueryIdentifierError extends Error {
  readonly kind: QueryIdentifierKind;
  readonly value: string;
  constructor(kind: QueryIdentifierKind, value: string, context?: string) {
    super(
      `Refusing to use ${kind} ${JSON.stringify(value)}${context ? ` (${context})` : ""} in a Table API query: ` +
        "it is not a valid ServiceNow identifier and would be read as encoded-query syntax.",
    );
    this.name = "QueryIdentifierError";
    this.kind = kind;
    this.value = value;
  }
}

// Delegated decision 2026-09-30 (wave 16): identifiers are checked against an
// ALLOWLIST, not a denylist of encoded-query metacharacters (`^`, `=`, `,`,
// `!`, `<`, `>`, whitespace, …). Scope codes and table names are
// `[A-Za-z0-9_]` on the platform; sys_ids are 32 hex characters, but `-` is
// admitted too (not an encoded-query operator, and test doubles use it);
// field names additionally admit `.` for dot-walked paths (`inputs.script`).
// Anything else — including the empty string — is refused before any read,
// where wave 15 escaped `^` to a space and so read a table that could never
// exist as silently empty. Reversible: widen a pattern here.
const QUERY_IDENTIFIER_PATTERNS: Readonly<Record<QueryIdentifierKind, RegExp>> =
  {
    scope: /^[A-Za-z0-9_]+$/,
    "scope sys_id": /^[A-Za-z0-9_-]+$/,
    table: /^[A-Za-z0-9_]+$/,
    field: /^[A-Za-z0-9_.]+$/,
  };

/**
 * Returns `value` unchanged when it is a well-formed identifier of `kind`,
 * and throws QueryIdentifierError otherwise. Every identifier this module
 * interpolates into an encoded query passes through here; free-text values
 * (none today) would go through `escapeQueryValue` instead.
 */
export function queryIdentifier(
  kind: QueryIdentifierKind,
  value: string,
  context?: string,
): string {
  if (
    typeof value !== "string" ||
    !QUERY_IDENTIFIER_PATTERNS[kind].test(value)
  ) {
    throw new QueryIdentifierError(kind, String(value), context);
  }
  return value;
}

// Delegated decision 2026-09-28 (wave 13): a sys_id is interpolated verbatim into
// `sys_idIN<a>,<b>,…`, so an id carrying `,` would split into two requested ids
// and one carrying `^` would append an encoded-query condition. The completeness
// audit would still catch the resulting answer, but only after the altered query
// had been sent; refuse such an id before any request instead.
const SYS_ID_LIST_UNSAFE = /[,^\s]/;

function assertSysIdsListable(ids: readonly string[], table: string): void {
  const bad = ids.filter((id) => id === "" || SYS_ID_LIST_UNSAFE.test(id));
  if (bad.length > 0) {
    throw new Error(
      `Refusing to query ${table} by sys_id: ${bad.length} requested id(s) cannot be listed in a sys_idIN query (empty, or containing ",", "^" or whitespace): ${describeSysIds(bad)}.`,
    );
  }
}

// Splits a sys_id list into sys_idIN chunks bounded by SYS_ID_CHUNK_SIZE ids and
// SYS_ID_QUERY_MAX_ENCODED_CHARS characters of percent-encoded list (see the
// constant). A lone id longer than the budget still gets a chunk of its own.
function chunkSysIds(ids: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const id of ids) {
    const idChars = encodeURIComponent(id).length;
    // Every id after the first is preceded by a comma, encoded as `%2C`.
    if (
      current.length > 0 &&
      (current.length >= SYS_ID_CHUNK_SIZE ||
        currentChars + 3 + idChars > SYS_ID_QUERY_MAX_ENCODED_CHARS)
    ) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    currentChars += (current.length > 0 ? 3 : 0) + idChars;
    current.push(id);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// ─── Record naming (pure helpers) ───────────────────────────────────────────

/**
 * A response field as the text the on-disk name is built from, or "" when it
 * cannot be text.
 *
 * `TableAPIRecord` claims `Record<string, string>`, but that is a claim about a
 * remote JSON response that nothing validates, and it is wrong in a way that is
 * routine rather than adversarial: ServiceNow flattens a reference field to its
 * value only when `sysparm_exclude_reference_link=true`, and snClient.tableAPIGet
 * never sets it, so every reference column arrives as `{ link, value }`. A
 * `tableOptions.displayField` or `differentiatorField` pointing at a reference
 * column — a widget differentiated by its `sp_instance`, a record named after its
 * parent — therefore handed an OBJECT to `String.prototype.replace`, and the
 * TypeError escaped `buildBulkDownloadFromTableAPI`'s per-table catch (it is not a
 * "skippable" HTTP error), aborting the download of EVERY table with
 * "name.replace is not a function" and naming neither the table nor the record.
 * A property test shrank it to the minimum: one requested record, one returned row
 * `{}`, where even `record.sys_id` is absent.
 *
 * `.value` is taken for the reference shape because it is exactly what the
 * flattened response would have carried, so a name derived here stays identical to
 * the one derived from a response that did set the parameter.
 */
export function fieldText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value && typeof value === "object") {
    const referenced = (value as { value?: unknown }).value;
    if (typeof referenced === "string") {
      return referenced;
    }
  }
  return "";
}

/**
 * The record's sys_id, or "" when the response did not return a usable one.
 *
 * Every consumer keys off it — the manifest indexes records by name and stores the
 * sys_id as the push/download target, findMissingFiles probes by sys_id — so a
 * record without one cannot be represented. It used to become the literal string
 * "undefined" in the manifest (and in the download's missing-file map), which then
 * looked like a real record forever after.
 */
function recordSysId(record: TableAPIRecord): string {
  return fieldText(record.sys_id).trim();
}

export function buildRecordName(
  record: TableAPIRecord,
  displayField: string,
  tableOptions: Sync.ITableOptions | undefined,
): string {
  const sysId = recordSysId(record);
  const override = tableOptions?.displayField
    ? fieldText(record[tableOptions.displayField])
    : "";
  let name = override || fieldText(record[displayField]) || sysId;

  if (tableOptions?.differentiatorField) {
    const isStringDiff = typeof tableOptions.differentiatorField === "string";
    const diffFields: string[] = isStringDiff
      ? [tableOptions.differentiatorField as string]
      : [...tableOptions.differentiatorField];
    for (const field of diffFields) {
      const val = fieldText(record[field]);
      if (val) {
        // Match SincUtilsMS behavior: string uses only value, array uses field:value.
        name = isStringDiff ? `${name} (${val})` : `${name} (${field}:${val})`;
        break;
      }
    }
  }

  // Match server-side: replace path separators
  const safe = (name || sysId).replace(/[/\\]/g, "〳");
  // Never let a record materialize as "." / ".." (or any all-dots name): those
  // resolve to the current/parent directory, so the record's field files would
  // land outside its own folder and then get deleted by `repair --apply --prune`.
  if (safe.trim() === "" || /^\.+$/.test(safe.trim())) {
    // The fallback has to clear the same bar as the name it replaces. The guard
    // above rejected "." / ".." in the display value but then returned the sys_id
    // unchecked, so a row whose sys_id was ITSELF ".." (or carried a separator)
    // walked straight through the very check that had just fired — a property test
    // shrank it to `{ sys_id: ".." }`, which materialized the parent directory as
    // a record folder. A real sys_id is 32 hex characters, so this only triggers
    // on a malformed or hostile response; returning "" makes the callers drop the
    // row (see the `unusableRows` filters) rather than inventing a path for it.
    return isSafePathComponent(sysId) ? sysId : "";
  }
  return safe;
}

/**
 * Stores a record under its on-disk name.
 *
 * `records[name] = record` looks total but is not: `records` is an object literal,
 * so assigning the one key `"__proto__"` invokes the inherited setter instead of
 * creating a property. The record then vanished — `Object.keys` did not list it, so
 * the manifest never mentioned it and the downloader never wrote it, while the
 * response had returned it and the run reported success. If it was the table's only
 * record the whole table disappeared from the result. `__proto__` is a perfectly
 * legal ServiceNow display name and a perfectly legal directory name (INJ-1's
 * isSafePathComponent accepts it), and it also arrives as a *supplied* manifest name
 * (JSON.parse makes `"__proto__"` an own property, so buildManifestRecordNames
 * passes it straight through). defineProperty stores it as the own, enumerable,
 * JSON-serializable property every consumer already expects.
 */
function setRecord(
  records: SN.TableConfigRecords,
  name: string,
  record: SN.MetaRecord,
): void {
  Object.defineProperty(records, name, {
    value: record,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

// Builds the Table API `sysparm_fields` list for a record query. buildRecordName
// derives the on-disk name from the default display field, an optional
// tableOptions.displayField override, and an optional differentiator field — so
// every one of those columns MUST be selected. If they are not, the API omits
// them, buildRecordName silently falls back to sys_id (or a different column),
// and the manifest name disagrees with the bulk-download name for the same
// record; `repair --prune` then deletes the "orphan" file. Both the manifest
// path (getRecordsForTable) and the download path (buildBulkDownloadFromTableAPI)
// share this helper so they always request identical columns and stay in parity.
export function buildRecordFieldList(
  defaultDisplayField: string,
  fileFieldNames: string[],
  tableOptions: Sync.ITableOptions | undefined,
): string {
  const fields: string[] = ["sys_id", defaultDisplayField];
  if (tableOptions?.displayField) {
    fields.push(tableOptions.displayField);
  }
  if (tableOptions?.differentiatorField) {
    const diffFields =
      typeof tableOptions.differentiatorField === "string"
        ? [tableOptions.differentiatorField]
        : tableOptions.differentiatorField;
    fields.push(...diffFields);
  }
  fields.push(...fileFieldNames);
  // Dedupe while preserving first-seen order; drop empty names defensively.
  return [...new Set(fields.filter((f) => f))].join(",");
}

// ─── Public: module-level helpers ───────────────────────────────────────────

export function isScopedEndpointUnavailableError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { response?: { status?: number }; status?: number };
  const status = err.response?.status ?? err.status;
  return typeof status === "number" && isEndpointNotFoundStatus(status);
}

export function isNotFoundError(e: unknown): boolean {
  return isScopedEndpointUnavailableError(e);
}

/**
 * Record names exactly as the manifest stores them, keyed by table and then by
 * sys_id. Callers build this from the manifest that produced the missing map
 * (see buildManifestRecordNames in downloadPipeline).
 */
export type ManifestRecordNames = Record<string, Record<string, string>>;

// ─── Factory ────────────────────────────────────────────────────────────────

export interface ManifestBuilderOptions {
  logger: StoreLogger;
  /**
   * Best-effort read of the manifest currently loaded for this scope, used only
   * to preserve entries for tables a rebuild could not read. Return undefined
   * when none is loaded (upstream: ConfigManager.getManifest). A throw is
   * tolerated, but it is reported through `logger.warn` as a carry-forward that
   * could not run — never rendered as an absent previous manifest.
   */
  getPreviousManifest?: (scopeName: string) => SN.AppManifest | undefined;
  /**
   * Environment the data-field materialization switches are read from
   * (upstream: process.env, still the default; the variable names are kept).
   */
  env?: Record<string, string | undefined>;
  /**
   * Refuse every paged Table API read whose pages do not all carry a finite
   * X-Total-Count (`total` on the SNClient answer): such a read throws
   * TableAPIPagingError instead of being trusted on the paging checks alone.
   * Default false — the read is accepted and the entry point warns once through
   * `logger.warn`, naming every read no total vouched for. Set it when the
   * client adapter surfaces X-Total-Count and the instance is not asked for
   * `sysparm_no_count`.
   */
  requireTotalCount?: boolean;
}

export interface ManifestBuilderHandle {
  buildManifestFromTableAPI(
    scopeName: string,
    client: SNClient,
    config: Pick<Sync.Config, "includes" | "excludes" | "tableOptions">,
  ): Promise<SN.AppManifest>;
  buildBulkDownloadFromTableAPI(
    missingFiles: SN.MissingFileTableMap,
    client: SNClient,
    tableOptions: Sync.ITableOptionsMap,
    recordNames?: ManifestRecordNames,
  ): Promise<SN.TableMap>;
  listAppsFromTableAPI(client: SNClient): Promise<SN.App[]>;
}

// Outcome of the `sys_app` scope lookup below. Upstream returned
// `string | null` and folded three different facts into that one `null`: the
// scope is not on the instance, the row came back without a usable `sys_id`,
// and the lookup never completed. Only the first two are evidence about the
// scope, so they are kept apart here.
type ScopeLookup =
  | { readonly kind: "found"; readonly sysId: string }
  | { readonly kind: "absent" }
  | { readonly kind: "failed"; readonly cause: string };

export function createManifestBuilder(
  options: ManifestBuilderOptions,
): ManifestBuilderHandle {
  const { logger, getPreviousManifest } = options;
  const requireTotalCount = options.requireTotalCount === true;
  const env = options.env ?? process.env;

  function getDataMaterializationTableAllowlist(): Set<string> {
    const raw = (env.SYNCRONA_DATA_TABLES || "").trim();
    if (!raw) {
      return new Set();
    }

    return new Set(
      raw
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0),
    );
  }

  function shouldMaterializeDataFields(): boolean {
    const raw = (env.SYNCRONA_INCLUDE_DATA_FIELDS || "").trim().toLowerCase();
    if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
      return false;
    }
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
  }

  function shouldMaterializeDataFieldsForTable(tableName: string): boolean {
    if (shouldMaterializeDataFields()) {
      return true;
    }

    return getDataMaterializationTableAllowlist().has(tableName);
  }

  // ─── Scope sys_id ─────────────────────────────────────────────────────────

  async function getScopeId(
    client: SNClient,
    scopeName: string,
  ): Promise<ScopeLookup> {
    try {
      const res = await client.tableAPIGet(
        "sys_app",
        // The config-supplied scope name is an identifier: one carrying `^`/`=`
        // would inject extra encoded-query conditions (upstream escaped it,
        // matching snClient.getScopeId). The caller has already refused such a
        // name before any read; this is the same check at the point of use.
        `scope=${queryIdentifier("scope", scopeName)}`,
        "sys_id",
        // Delegated decision 2026-09-30 (wave 14): read up to two rows, not one.
        // `limit 1` would silently pick one of two sys_app rows claiming the same
        // scope code (the platform keeps scope codes unique, so a second row means
        // a corrupted or mid-repair instance) and build the manifest against
        // whichever came first. More than one row is refused below and reported
        // as a failed lookup, not a missing scope. Reversible: set the limit back
        // to 1 and drop the check.
        2,
      );
      const rows = extractResult(res.data, "sys_app");
      if (rows.length > 1) {
        throw new TableAPIPagingError(
          `Table API read of sys_app returned ${rows.length} rows for scope "${scopeName}"; the scope code is ambiguous, refusing to pick one.`,
        );
      }
      const sysId = rows[0]?.sys_id;
      // An empty `sys_id` stays folded into "absent" exactly as upstream's
      // `|| null` folded it: a row carrying no usable id is no more a scope
      // than no row at all, and it is still an answer from the instance.
      return sysId ? { kind: "found", sysId } : { kind: "absent" };
    } catch (e) {
      // "There is no such scope" and "the lookup could not run" are different
      // facts, and upstream's bare `catch` returned the same `null` for both —
      // the caller then told the user to check the scope code on the strength
      // of an expired token or a 500. Reported as its own case instead. This
      // is the same call previousManifestFor makes one function away, for the
      // same reason.
      const message = e instanceof Error ? e.message : String(e);
      return { kind: "failed", cause: message };
    }
  }

  // ─── Table names in scope ─────────────────────────────────────────────────
  // Mirrors server-side GlideAggregate on sys_metadata grouped by sys_class_name

  // Every field-level exclude is interpolated as `^element!=<field>` by the
  // dictionary reads; check them all up front (see buildManifestFromTableAPI).
  function assertExcludedFieldsQueryable(excludes: Sync.TablePropMap): void {
    for (const [tableName, fields] of Object.entries(excludes)) {
      if (typeof fields !== "object") continue;
      for (const field of Object.keys(fields)) {
        queryIdentifier("field", field, `excludes.${tableName}`);
      }
    }
  }

  function filterUniqueTableNames(
    rows: TableAPIRecord[],
    includes: Sync.TablePropMap,
    excludes: Sync.TablePropMap,
  ): string[] {
    const seen = new Set<string>();
    const tables: string[] = [];

    for (const row of rows) {
      const tableName = row.name || row.sys_class_name;
      if (!tableName || seen.has(tableName)) continue;
      seen.add(tableName);

      const excluded =
        tableName in excludes &&
        typeof excludes[tableName] !== "object" &&
        excludes[tableName] !== false;
      const included = tableName in includes && includes[tableName] !== false;

      if (!excluded || included) {
        tables.push(tableName);
      }
    }

    return tables;
  }

  async function getTableNamesInScope(
    client: SNClient,
    scopeName: string,
    scopeId: string,
    includes: Sync.TablePropMap,
    excludes: Sync.TablePropMap,
  ): Promise<string[]> {
    try {
      const rows = await tableAPIGetAllRows(
        client,
        "sys_metadata",
        `sys_scope=${queryIdentifier("scope sys_id", scopeId)}`,
        "sys_class_name",
        10000,
        SCOPE_METADATA_MAX_ROWS,
      );
      const tables = filterUniqueTableNames(rows, includes, excludes);

      if (tables.length > 0) {
        return tables;
      }

      const dbObjectTables = await getTableNamesFromDbObject(
        client,
        scopeId,
        includes,
        excludes,
      );
      if (dbObjectTables.length > 0) {
        return dbObjectTables;
      }

      const fallbackTables = await getTableNamesFromDictionary(
        client,
        scopeName,
        scopeId,
        includes,
        excludes,
      );
      return fallbackTables;
    } catch (e) {
      // Delegated decision 2026-09-26 (W5a #3): this broad catch (upstream) turns any
      // discovery failure into the dictionary fallback. A paging-integrity failure is
      // not a "this source is unavailable" answer — it means the rows seen so far
      // cannot be trusted — so it propagates instead of silently switching sources.
      //
      // Delegated decision 2026-09-26 (W7b L9): narrowed further. Only a refused
      // source (403/404, see isTableSkippableError) is a reason to switch to the
      // dictionary. A 5xx, a timeout, an auth failure or a 400 means the instance
      // did not answer the question, and a narrower source queried next would
      // produce a quietly smaller table list. It also covers errors thrown by the
      // db_object/dictionary fallbacks called inside the `try`, which rethrow
      // their own non-skippable failures: re-running the dictionary after one of
      // them would only repeat or mask it.
      if (!isTableSkippableError(e)) {
        throw e;
      }
      return getTableNamesFromDictionary(
        client,
        scopeName,
        scopeId,
        includes,
        excludes,
      );
    }
  }

  async function getTableNamesFromDbObject(
    client: SNClient,
    scopeId: string,
    includes: Sync.TablePropMap,
    excludes: Sync.TablePropMap,
  ): Promise<string[]> {
    try {
      // Delegated decision 2026-09-28 (wave 13): paged, with a total-row cap
      // (TABLE_DISCOVERY_MAX_ROWS); was one fixed-limit request (limit 10000) whose silent truncation
      // dropped tables from discovery.
      const rows = await tableAPIGetAllRows(
        client,
        "sys_db_object",
        `sys_scope=${queryIdentifier("scope sys_id", scopeId)}^nameISNOTEMPTY`,
        "name",
        10000,
        TABLE_DISCOVERY_MAX_ROWS,
      );
      return filterUniqueTableNames(rows, includes, excludes);
    } catch (e) {
      // Delegated decision 2026-09-26 (W7b L9): was `catch { return [] }`, which
      // read an outage as "no tables here" and moved on to the next source. Only a
      // refused sys_db_object (403/404) means "try the dictionary"; anything else
      // propagates and fails discovery.
      if (!isTableSkippableError(e)) {
        throw e;
      }
      return [];
    }
  }

  async function getTableNamesFromDictionary(
    client: SNClient,
    scopeName: string,
    scopeId: string,
    includes: Sync.TablePropMap,
    excludes: Sync.TablePropMap,
  ): Promise<string[]> {
    try {
      // Delegated decision 2026-09-28 (wave 13): paged, with a total-row cap
      // (TABLE_DISCOVERY_MAX_ROWS); was one fixed-limit request (limit 10000) whose silent truncation
      // dropped tables from discovery.
      const rows = await tableAPIGetAllRows(
        client,
        "sys_dictionary",
        `sys_scope=${queryIdentifier("scope sys_id", scopeId)}^nameISNOTEMPTY`,
        "name",
        10000,
        TABLE_DISCOVERY_MAX_ROWS,
      );
      const tables = filterUniqueTableNames(rows, includes, excludes);
      if (tables.length > 0) {
        return tables;
      }
    } catch (e) {
      // Delegated decision 2026-09-26 (W7b L9): only a refused scoped query
      // (403/404) falls through to the name-LIKE fallback below; any other failure
      // propagates (see getTableNamesInScope).
      if (!isTableSkippableError(e)) {
        throw e;
      }
    }

    try {
      // Delegated decision 2026-09-28 (wave 13): paged, with a total-row cap
      // (TABLE_DISCOVERY_MAX_ROWS); was one fixed-limit request (limit 10000) whose silent truncation
      // dropped tables from discovery.
      const rows = await tableAPIGetAllRows(
        client,
        "sys_dictionary",
        `nameLIKE${queryIdentifier("scope", scopeName)}^nameISNOTEMPTY`,
        "name",
        10000,
        TABLE_DISCOVERY_MAX_ROWS,
      );
      return filterUniqueTableNames(rows, includes, excludes);
    } catch (e) {
      // Delegated decision 2026-09-26 (W7b L9): the last source. A refusal
      // (403/404) is "nothing discoverable", which the caller already reports as
      // "No tables discovered"; any other failure propagates with its real cause.
      if (!isTableSkippableError(e)) {
        throw e;
      }
      return [];
    }
  }

  // ─── File fields from sys_dictionary ──────────────────────────────────────
  // Mirrors server-side getFileMap — finds fields by internal_type

  async function getFileFieldsForTable(
    client: SNClient,
    tableName: string,
    includes: Sync.TablePropMap,
    excludes: Sync.TablePropMap,
    onSkip?: () => void,
  ): Promise<SN.File[]> {
    try {
      // ATF step script is stored in inputs.script and is not reliably available via dictionary.
      if (tableName === "sys_atf_step") {
        return [{ name: "inputs.script", type: "js" }];
      }

      const hierarchyTableNames = await getTableHierarchyTableNames(
        client,
        tableName,
      );
      const tableNameQuery = hierarchyTableNames
        .map((name) => `name=${queryIdentifier("table", name)}`)
        .join("^OR");

      // Build field exclusion query
      let query = `${tableNameQuery}^${SN_TYPE_QUERY}^elementISNOTEMPTY`;

      // Apply field-level excludes
      if (tableName in excludes && typeof excludes[tableName] === "object") {
        const exFields = Object.keys(excludes[tableName]);
        for (const exField of exFields) {
          // Skip if also explicitly included at field level
          const tableIncludes = includes[tableName];
          if (
            tableIncludes &&
            typeof tableIncludes === "object" &&
            exField in tableIncludes
          ) {
            continue;
          }
          query += `^element!=${queryIdentifier("field", exField)}`;
        }
      }

      // Delegated decision 2026-09-28 (wave 13): paged, with a total-row cap
      // (DICTIONARY_FIELD_MAX_ROWS); was one fixed-limit request (limit 200) whose silent truncation
      // dropped script fields of wide table hierarchies.
      const rows = await tableAPIGetAllRows(
        client,
        "sys_dictionary",
        query,
        "element,internal_type",
        200,
        DICTIONARY_FIELD_MAX_ROWS,
      );
      const files: SN.File[] = [];
      for (const r of rows) {
        const element = r.element;
        const internalType = r.internal_type;
        if (!element || !internalType) {
          continue;
        }
        files.push({
          name: element,
          type: getFileTypeForInternalType(internalType) as SN.FileType,
        });
      }

      // Apply field-level includes overrides
      if (tableName in includes && typeof includes[tableName] === "object") {
        const tableIncludes = includes[tableName];
        for (const [fieldName, fieldConfig] of Object.entries(tableIncludes)) {
          if (!files.find((f) => f.name === fieldName)) {
            files.push({
              name: fieldName,
              type: fieldConfig.type || "txt",
            });
          }
        }
      }

      if (
        files.length === 0 &&
        shouldMaterializeDataFieldsForTable(tableName)
      ) {
        // Data-only tables may have no script/css/xml/html fields; fall back to text fields
        // so scoped records still materialize locally instead of producing an empty scope.
        return getTextFieldsForTable(
          client,
          tableName,
          includes,
          excludes,
          hierarchyTableNames,
          onSkip,
        );
      }

      return files;
    } catch (e) {
      // Only an inaccessible table may look like "no file fields"; a network
      // failure must propagate so the table lands in failedTables instead of
      // silently vanishing from the manifest.
      if (!isTableSkippableError(e)) {
        throw e;
      }
      // Report the skip: "inaccessible" and "genuinely has no file fields" are
      // indistinguishable in the return value, and the caller must not treat the
      // former as a reason to drop the table from a rebuilt manifest.
      onSkip?.();
      return [];
    }
  }

  async function getTextFieldsForTable(
    client: SNClient,
    tableName: string,
    includes: Sync.TablePropMap,
    excludes: Sync.TablePropMap,
    hierarchyTableNames?: string[],
    onSkip?: () => void,
  ): Promise<SN.File[]> {
    try {
      const hierarchy =
        hierarchyTableNames ||
        (await getTableHierarchyTableNames(client, tableName));
      const tableNameQuery = hierarchy
        .map((name) => `name=${queryIdentifier("table", name)}`)
        .join("^OR");
      let query = `${tableNameQuery}^elementISNOTEMPTY`;

      if (tableName in excludes && typeof excludes[tableName] === "object") {
        const exFields = Object.keys(excludes[tableName]);
        for (const exField of exFields) {
          const tableIncludes = includes[tableName];
          if (
            tableIncludes &&
            typeof tableIncludes === "object" &&
            exField in tableIncludes
          ) {
            continue;
          }
          query += `^element!=${queryIdentifier("field", exField)}`;
        }
      }

      // Delegated decision 2026-09-28 (wave 13): paged, with a total-row cap
      // (DICTIONARY_FIELD_MAX_ROWS); was one fixed-limit request (limit 500) whose silent truncation
      // dropped text fields of wide table hierarchies.
      const rows = await tableAPIGetAllRows(
        client,
        "sys_dictionary",
        query,
        "element",
        500,
        DICTIONARY_FIELD_MAX_ROWS,
      );

      const seen = new Set<string>();
      const files: SN.File[] = [];
      for (const row of rows) {
        const fieldName = row.element;
        if (!fieldName || seen.has(fieldName)) {
          continue;
        }
        seen.add(fieldName);
        files.push({ name: fieldName, type: "txt" });
      }

      if (tableName in includes && typeof includes[tableName] === "object") {
        const tableIncludes = includes[tableName];
        for (const [fieldName, fieldConfig] of Object.entries(tableIncludes)) {
          if (!files.find((f) => f.name === fieldName)) {
            files.push({
              name: fieldName,
              type: fieldConfig.type || "txt",
            });
          }
        }
      }

      return files;
    } catch (e) {
      // Same contract as getFileFieldsForTable: swallow only "table not
      // accessible", let real failures reach the failedTables accounting.
      if (!isTableSkippableError(e)) {
        throw e;
      }
      // This runs inside getFileFieldsForTable's own `try`, so its catch never
      // sees this error — the skip has to be reported from here or the caller
      // reads an empty field list as "this table genuinely has no fields" and
      // drops the table from the rebuilt manifest.
      onSkip?.();
      return [];
    }
  }

  async function getTableHierarchyTableNames(
    client: SNClient,
    tableName: string,
  ): Promise<string[]> {
    const visited = new Set<string>();
    const queue: string[] = [tableName];
    const ordered: string[] = [];
    let depth = 0;

    while (queue.length > 0 && depth < MAX_TABLE_HIERARCHY_DEPTH) {
      const current = queue.shift() as string;
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      ordered.push(current);

      try {
        // Delegated decision 2026-09-30 (wave 15, superseded in wave 16):
        // every value interpolated into an encoded query in this module used to
        // go through escapeQueryValue — table names (discovered, or a parent
        // named by the instance), scope sys_ids, and config-supplied field
        // excludes. A `^` in any of them used to start a new condition (`^OR…`
        // widening the match, `^NQ…` adding a whole new query).
        //
        // Delegated decision 2026-09-30 (wave 16): escaping kept the query
        // narrow but turned the value into a literal that matches nothing, so a
        // table named with `^` read as EMPTY — an answer, not a refusal. All of
        // these values are identifiers, so they now go through queryIdentifier,
        // which throws QueryIdentifierError (never skippable) instead. A parent
        // named by the instance is checked here, before its own read, and fails
        // this table into failedTables. Still deliberately NOT checked:
        // `tableOptions.query`, which is a caller-supplied encoded query by
        // contract (not a value), and the `sys_idIN` lists, which
        // assertSysIdsListable refuses outright when an id carries `^`, `,` or
        // whitespace. escapeQueryValue stays exported for free-text values.
        const res = await client.tableAPIGet(
          "sys_db_object",
          `name=${queryIdentifier("table", current, current === tableName ? undefined : `parent table of ${tableName} named by sys_db_object`)}`,
          "name,super_class.name",
          // Delegated decision 2026-09-30 (wave 14): read up to two rows, not
          // one. sys_db_object names are unique on the platform, so a second row
          // means the query matched more than the named table (a name the query
          // does not read literally) or the instance is corrupted, and `limit 1`
          // would silently follow whichever parent came first. More than one row
          // throws TableAPIPagingError, which is not a skippable 403/404, so the
          // table is counted in failedTables. Reversible: set the limit back to 1
          // and drop the check.
          2,
        );
        const rows = extractResult(res.data, "sys_db_object");
        if (rows.length > 1) {
          throw new TableAPIPagingError(
            `Table API read of sys_db_object returned ${rows.length} rows for table "${current}"; the table hierarchy is ambiguous, refusing to pick a parent.`,
          );
        }
        const parentName = rows[0]?.["super_class.name"];
        if (parentName && !visited.has(parentName)) {
          queue.push(parentName);
        }
      } catch (e) {
        // If hierarchy lookup is refused (403/404), continue with the tables
        // already discovered.
        //
        // Delegated decision 2026-09-26 (W7b L9): was a bare `catch {}`. A 5xx or a
        // malformed body here silently dropped the parent tables from the
        // dictionary query, so inherited script fields vanished from the manifest
        // with no error. A non-skippable failure now propagates to the per-table
        // accounting (failedTables). A refusal keeps the upstream behaviour: the
        // table's own fields are still correct, and sys_db_object being
        // ACL-restricted is a common, stable configuration.
        if (!isTableSkippableError(e)) {
          throw e;
        }
      }

      depth += 1;
    }

    return ordered.length > 0 ? ordered : [tableName];
  }

  // ─── Records for a single table ───────────────────────────────────────────

  async function getRecordsForTable(
    client: SNClient,
    tableName: string,
    scopeId: string,
    files: SN.File[],
    tableOptions: Sync.ITableOptions | undefined,
    onSkip?: () => void,
  ): Promise<SN.TableConfigRecords> {
    const displayField = getDisplayField(tableName);
    const baseQuery = `sys_scope=${queryIdentifier("scope sys_id", scopeId)}^sys_class_name=${queryIdentifier("table", tableName)}`;
    const query = tableOptions?.query
      ? `${baseQuery}^${tableOptions.query}`
      : baseQuery;

    const tableFields = buildRecordFieldList(
      displayField,
      files.map((f) => f.name),
      tableOptions,
    );

    const toRecords = (rows: TableAPIRecord[]): SN.TableConfigRecords => {
      const records: SN.TableConfigRecords = {};
      // Names that collide once written to disk — a case-insensitive volume
      // (macOS/Windows) or Unicode-normalization differences map two distinct
      // records onto one path. Warning alone was not enough: both keys were still
      // written to the manifest, the two records overwrote each other's files on
      // disk, and a push from either one uploaded the other's content. Every
      // member of a colliding group is now suffixed with its sys_id so each record
      // owns a distinct path.
      //
      // The disambiguation must not depend on row order (the Table API gives no
      // stable ordering, and a rebuild that renamed a different member of the pair
      // would orphan the previously downloaded files), so it is decided in a first
      // pass over the whole result set rather than as each row is seen.
      // A row with no usable sys_id cannot be a manifest record (see recordSysId),
      // and buildRecordName has nothing left to name it after, so drop it here
      // rather than writing an entry keyed "undefined" that no push can ever target.
      let unusableRows = 0;
      const entries = rows
        .map((row) => {
          const sysId = recordSysId(row);
          const name = buildRecordName(row, displayField, tableOptions);
          return {
            sysId,
            name,
            normalized: name.normalize("NFC").toLowerCase(),
          };
        })
        .filter((entry) => {
          // Both values are checked as path components, not just for emptiness: the
          // name becomes a directory, and the sys_id is interpolated into that
          // directory name whenever the group below collides
          // (`${name}_${sysId}`), so an unusable sys_id escapes through the name.
          if (
            isSafePathComponent(entry.name) &&
            isSafePathComponent(entry.sysId)
          ) {
            return true;
          }
          unusableRows += 1;
          return false;
        });
      if (unusableRows > 0) {
        logger.warn(
          `Table ${tableName}: skipped ${unusableRows} record(s) the instance returned without a usable sys_id.`,
        );
      }
      const sysIdsByNormalized = new Map<string, Set<string>>();
      for (const entry of entries) {
        let group = sysIdsByNormalized.get(entry.normalized);
        if (!group) {
          group = new Set<string>();
          sysIdsByNormalized.set(entry.normalized, group);
        }
        group.add(entry.sysId);
      }

      for (const entry of entries) {
        const collides =
          (sysIdsByNormalized.get(entry.normalized)?.size ?? 0) > 1;
        const name = collides ? `${entry.name}_${entry.sysId}` : entry.name;
        if (collides) {
          logger.warn(
            `Record name collision in ${tableName}: "${entry.name}" is used by more than one record; storing it as "${name}" so no record is overwritten.`,
          );
        }
        setRecord(records, name, {
          sys_id: entry.sysId,
          name,
          files: files.map((f) => ({ name: f.name, type: f.type })),
        });
      }

      return records;
    };

    let rows: TableAPIRecord[];

    try {
      rows = await tableAPIGetAllRows(
        client,
        tableName,
        query,
        tableFields,
        500,
      );
    } catch (e) {
      if (!isTableSkippableError(e)) {
        throw e;
      }
      // See getFileFieldsForTable: an ACL denial must not read as "this table has
      // no records" to the manifest builder.
      onSkip?.();
      rows = [];
    }

    if (rows.length > 0) {
      return toRecords(rows);
    }

    const metadataRows = await getScopeMetadataRowsForTable(
      client,
      scopeId,
      tableName,
      onSkip,
    );
    if (metadataRows.length === 0) {
      return {};
    }

    const metadataIds = metadataRows
      .map((row) => row.sys_id)
      .filter((id): id is string => !!id);
    // Delegated decision 2026-09-30 (wave 15): these ids come from the
    // instance's sys_metadata rows and are interpolated verbatim into
    // `sys_idIN…`, exactly like the bulk-download ids that were already guarded.
    // An id carrying `^` or `,` would alter the query before the completeness
    // audit could see the answer; refuse it up front. Not a skippable 403/404,
    // so the table lands in failedTables.
    assertSysIdsListable(metadataIds, tableName);
    const chunks = chunkSysIds(metadataIds);
    const fallbackRows: TableAPIRecord[] = [];

    for (const chunk of chunks) {
      const idQueryBase = `sys_idIN${chunk.join(",")}`;
      const idQuery = tableOptions?.query
        ? `${idQueryBase}^${tableOptions.query}`
        : idQueryBase;

      try {
        const res = await client.tableAPIGet(
          tableName,
          idQuery,
          tableFields,
          500,
        );
        const chunkRows = extractResult(res.data, tableName);
        const missing = auditSysIdChunk(chunkRows, chunk, tableName);
        if (!tableOptions?.query && missing.length > 0) {
          throw new SysIdCompletenessError(
            tableName,
            missing,
            `sys_idIN read of ${tableName} returned ${chunk.length - missing.length} of ${chunk.length} requested records and no tableOptions.query explains the difference (missing sys_id(s): ${describeSysIds(missing)}); refusing a possibly truncated result.`,
          );
        }
        fallbackRows.push(...chunkRows);
      } catch (e) {
        if (!isTableSkippableError(e)) {
          throw e;
        }
        // Table not accessible for this chunk — the other chunks may still
        // succeed, so keep going, but the result is now a PARTIAL record set.
        // Without reporting the skip, a manifest missing those records looks
        // authoritative and `repair --prune` deletes their local files.
        onSkip?.();
      }
    }

    return toRecords(fallbackRows);
  }

  async function getScopeMetadataRowsForTable(
    client: SNClient,
    scopeId: string,
    tableName: string,
    onSkip?: () => void,
  ): Promise<TableAPIRecord[]> {
    try {
      return await tableAPIGetAllRows(
        client,
        "sys_metadata",
        `sys_scope=${queryIdentifier("scope sys_id", scopeId)}^sys_class_name=${queryIdentifier("table", tableName)}`,
        "sys_id,sys_class_name",
        10000,
        SCOPE_METADATA_MAX_ROWS,
      );
    } catch (e) {
      if (!isTableSkippableError(e)) {
        throw e;
      }
      // Same reason as the other skips: an empty row set here is returned to a
      // caller that cannot tell "refused" from "empty", and the table would be
      // dropped from the rebuilt manifest.
      onSkip?.();
      return [];
    }
  }

  // ─── Public: buildManifestFromTableAPI ────────────────────────────────────
  // Full equivalent of SincUtilsMS.getManifest() using only Table API

  async function buildManifestFromTableAPI(
    scopeName: string,
    rawClient: SNClient,
    config: Pick<Sync.Config, "includes" | "excludes" | "tableOptions">,
  ): Promise<SN.AppManifest> {
    const { client, tracker } = trackTotalCounts(rawClient, requireTotalCount);
    const includes = config.includes || {};
    const excludes = config.excludes || {};
    const tableOptions = config.tableOptions || {};

    // Wave 16: refuse a malformed scope code or field exclude before the first
    // request. getScopeId folds its own errors into a "failed" lookup, so a
    // refusal raised inside it would surface as a lookup failure instead.
    queryIdentifier("scope", scopeName);
    assertExcludedFieldsQueryable(excludes);

    const scope = await getScopeId(client, scopeName);
    if (scope.kind === "absent") {
      throw new Error(
        `Scope "${scopeName}" not found on this instance. Check the scope code.`,
      );
    }
    if (scope.kind === "failed") {
      // The lookup never answered, so nothing here is evidence about the
      // scope; say what failed and refuse the diagnosis rather than sending
      // the user off to fix a scope code that may well be correct.
      throw new Error(
        `Could not resolve scope "${scopeName}": the sys_app lookup failed (${scope.cause}). ` +
          "This is not evidence that the scope is missing " +
          "(check connectivity, credentials, and ACLs).",
      );
    }
    const scopeId = queryIdentifier(
      "scope sys_id",
      scope.sysId,
      `sys_app answer for scope ${scopeName}`,
    );

    const tableNames = await getTableNamesInScope(
      client,
      scopeName,
      scopeId,
      includes,
      excludes,
    );
    if (tableNames.length === 0) {
      // A populated scope never has zero discoverable tables; an empty result
      // here almost always means connectivity/ACL trouble. Refuse to build an
      // empty manifest that would overwrite a previously good one.
      throw new Error(
        `No tables discovered for scope "${scopeName}". ` +
          "Refusing to build an empty manifest (check connectivity, credentials, and ACLs).",
      );
    }

    // Delegated decision 2026-09-30 (wave 16): a discovered table name that is
    // not an identifier refuses the WHOLE build before any per-table read,
    // rather than failing that one table. The name came from the instance's
    // own sys_metadata / sys_db_object / sys_dictionary answer, which no
    // well-formed instance gives, so the discovery answer itself is suspect.
    for (const tableName of tableNames) {
      queryIdentifier("table", tableName, `discovered in scope ${scopeName}`);
    }

    const manifest: SN.AppManifest = { scope: scopeName, tables: {} };
    const failedTables: string[] = [];
    // Tables whose enumeration was cut short by a skippable 400/403/404. They are
    // NOT "empty" — see the carry-forward below.
    const skippedTables: string[] = [];

    // PERF-7 (REV-100): enumerate tables through a bounded pool instead of a single
    // Promise.all that opened one request chain per table at once.
    const tableConcurrency = resolveManifestTableConcurrency(config);
    await mapWithConcurrency(
      tableNames,
      tableConcurrency,
      async (tableName) => {
        let skipped = false;
        const onSkip = () => {
          skipped = true;
        };
        try {
          const files = await getFileFieldsForTable(
            client,
            tableName,
            includes,
            excludes,
            onSkip,
          );
          if (files.length === 0) {
            if (skipped) skippedTables.push(tableName);
            return;
          }

          const records = await getRecordsForTable(
            client,
            tableName,
            scopeId,
            files,
            tableOptions[tableName],
            onSkip,
          );
          if (Object.keys(records).length === 0) {
            if (skipped) skippedTables.push(tableName);
            return;
          }

          manifest.tables[tableName] = { records };
          // A partially refused read (one `sys_idIN` chunk denied while the others
          // answered) still yields records — but an incomplete set. Committing it as
          // authoritative is the same data loss as dropping the table: the records
          // that fell out stop mapping to their local files, so `push` ignores edits
          // to them and `repair --prune` deletes them. Report the skip so the
          // carry-forward below restores whatever the refused part would have held.
          if (skipped) skippedTables.push(tableName);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logger.warn(`Failed to enumerate table ${tableName}: ${message}`);
          failedTables.push(tableName);
        }
      },
    );

    if (failedTables.length > 0) {
      // Better to fail the whole build than to persist a partial manifest in
      // which the failed tables look like they have no records.
      throw new Error(
        `Manifest build incomplete — failed tables: ${failedTables.sort().join(", ")}`,
      );
    }

    // A table the instance refused (ACL, temporarily unreadable) used to be
    // dropped from the rebuilt manifest exactly like a table with no records. The
    // rebuilt manifest then replaced the good one, so every already-downloaded
    // file of that table stopped mapping to a record: `push` silently ignored
    // edits to them and `repair --prune` classified them as orphans. Carry the
    // previous entries forward instead, and say so.
    if (skippedTables.length > 0) {
      const previous = previousManifestFor(scopeName);
      const carried: string[] = [];
      for (const tableName of skippedTables.sort()) {
        const priorTable = previous?.tables?.[tableName];
        if (!priorTable || Object.keys(priorTable.records || {}).length === 0) {
          continue;
        }
        const current = manifest.tables[tableName]?.records;
        manifest.tables[tableName] =
          current && Object.keys(current).length > 0
            ? // Partial read: keep every record just enumerated (they are the
              // fresher truth) and restore only the ones the refused part of the
              // read would have silently dropped.
              { ...priorTable, records: { ...priorTable.records, ...current } }
            : priorTable;
        carried.push(tableName);
      }
      logger.warn(
        `Could not fully read ${skippedTables.length} table(s) while building the manifest for "${scopeName}" (no access or not queryable): ${skippedTables.join(", ")}.` +
          (carried.length > 0
            ? ` Kept the previously known records for: ${carried.join(", ")}.`
            : ""),
      );
    }

    const unverified = describeUnverifiedReads(tracker);
    if (unverified !== undefined) {
      logger.warn(`Manifest for "${scopeName}": ${unverified}`);
    }

    return manifest;
  }

  // Best-effort read of the manifest currently loaded in memory, used only to
  // preserve entries for tables this run could not read. Returns undefined when
  // no accessor was injected, none is loaded (first-run wizard), it belongs to
  // another scope, or the injected accessor itself threw.
  //
  // The last of those is not the same fact as the other three, and upstream's
  // bare `catch` made it look like one: "there is nothing to carry forward" and
  // "the carry-forward could not run" produce the identical silent return, and
  // the skipped-tables warning below then omits its `Kept the previously known
  // records for:` clause either way. It is reported instead, because a run that
  // could not consult the previous manifest is a run whose skipped tables were
  // dropped for a second, hidden reason.
  function previousManifestFor(scopeName: string): SN.AppManifest | undefined {
    try {
      const existing = getPreviousManifest?.(scopeName);
      return existing && existing.scope === scopeName ? existing : undefined;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        `Could not read the previously known manifest for "${scopeName}", so no records can be carried forward for the tables this run could not read: ${message}`,
      );
      return undefined;
    }
  }

  // ─── Public: buildBulkDownloadFromTableAPI ────────────────────────────────
  // Full equivalent of SincUtilsMS.processMissingFiles() using only Table API

  async function buildBulkDownloadFromTableAPI(
    missingFiles: SN.MissingFileTableMap,
    client: SNClient,
    tableOptions: Sync.ITableOptionsMap,
    recordNames?: ManifestRecordNames,
  ): Promise<SN.TableMap> {
    const result: SN.TableMap = {};

    // Wave 16: every table key is checked before ANY read — the per-table reads
    // below start concurrently, so a check inside them would let the valid
    // tables' requests go out before the malformed one is refused.
    for (const tableName of Object.keys(missingFiles)) {
      queryIdentifier("table", tableName, "bulk download");
    }

    await Promise.all(
      Object.entries(missingFiles).map(async ([tableName, recordMap]) => {
        const sysIds = Object.keys(recordMap);
        if (sysIds.length === 0) return;

        const tableOpts = tableOptions[tableName];
        const defaultDisplayField = getDisplayField(tableName);

        // Collect all unique file fields across missing records
        const allFiles = new Map<string, SN.FileType>();
        for (const files of Object.values(recordMap)) {
          for (const f of files) {
            allFiles.set(f.name, f.type);
          }
        }

        // Same field list as the manifest path so record names stay in parity.
        const tableFields = buildRecordFieldList(
          defaultDisplayField,
          [...allFiles.keys()],
          tableOpts,
        );

        assertSysIdsListable(sysIds, tableName);

        try {
          // Chunk the sys_id list so large record sets cannot overflow the URL
          // length limit (mirrors getRecordsForTable).
          //
          // Delegated decision 2026-09-28 (wave 13): every requested sys_id must
          // come back exactly once. The loop used to push whatever each chunk
          // returned, so a record hidden by a row-level ACL, deleted since the
          // manifest was built, or cut off by a response cap simply vanished:
          // the download reported success and the record stayed "missing" on
          // every later run with nothing said. Unrequested, duplicate and excess
          // rows now fail the chunk (auditSysIdChunk); missing ids are collected
          // across all chunks and fail the table by id (SysIdCompletenessError,
          // not a skippable HTTP error, so it propagates and fails the download).
          // No tableOptions.query is appended here, so nothing can explain a
          // short answer. Residual: a record deleted after the manifest was built
          // fails the download until the manifest is rebuilt.
          const rows: TableAPIRecord[] = [];
          const missing: string[] = [];
          for (const chunk of chunkSysIds(sysIds)) {
            const res = await client.tableAPIGet(
              tableName,
              `sys_idIN${chunk.join(",")}`,
              tableFields,
              500,
            );
            const chunkRows = extractResult(res.data, tableName);
            missing.push(...auditSysIdChunk(chunkRows, chunk, tableName));
            rows.push(...chunkRows);
          }
          if (missing.length > 0) {
            throw new SysIdCompletenessError(
              tableName,
              missing,
              `Bulk download of ${tableName} returned ${sysIds.length - missing.length} of ${sysIds.length} requested records; missing sys_id(s): ${describeSysIds(missing)}. They may be deleted, hidden by an ACL, or cut off by a response limit; refusing to report the download as complete (rebuild the manifest and retry).`,
            );
          }
          const records: SN.TableConfigRecords = {};
          const unreturnedFields = new Set<string>();
          let unusableRows = 0;

          const namesForTable = recordNames?.[tableName];

          for (const row of rows) {
            // Same rule as the manifest path: no sys_id, no record. The download
            // writes at `<table>/<name>` and reports progress per record, so a row
            // that cannot be named or keyed is dropped with a count instead of
            // becoming an "undefined" folder.
            const sysId = recordSysId(row);
            if (!isSafePathComponent(sysId)) {
              unusableRows += 1;
              continue;
            }
            // The MANIFEST decides where a record lives on disk, not this
            // response: getRecordsForTable suffixes a colliding display name with
            // its sys_id, processTablesInManifest writes at `<table>/<rec.name>`
            // and findMissingFiles probes the manifest key. Deriving the name here
            // a second time broke that parity for every disambiguated record — the
            // downloader wrote at a path the manifest did not know, so the record
            // stayed "missing" on every subsequent run and `repair --apply --prune`
            // deleted the freshly written file as an orphan. It cannot be
            // recomputed either: this call sees only the MISSING subset, so one
            // member of a colliding pair looks unique and loses its suffix.
            //
            // buildRecordName remains the fallback for a caller that supplied no
            // map. It must receive the DEFAULT display field — it applies the
            // tableOptions.displayField override itself (override -> default ->
            // sys_id), exactly as getRecordsForTable does, and passing the already
            // resolved override collapses that chain.
            const manifestName = namesForTable?.[sysId];
            const name =
              typeof manifestName === "string" && manifestName.length > 0
                ? manifestName
                : buildRecordName(row, defaultDisplayField, tableOpts);
            // buildRecordName returns "" when neither the display value nor the
            // sys_id can be a path component. A supplied manifest name is NOT
            // filtered here: downloadPipeline default-denies it loudly, which is the
            // right outcome for a manifest that asks for an impossible path —
            // dropping it silently would leave the record "missing" on every run.
            if (!name) {
              unusableRows += 1;
              continue;
            }
            const files: SN.File[] = [];

            for (const [fieldName, fieldType] of allFiles.entries()) {
              // A field the response did not return AT ALL (column-level ACL,
              // dropped from the projection) is "not fetched" — not "empty".
              // `row[fieldName] || ""` erased that distinction, and because
              // downloadAllFiles writes with forceWrite the resulting empty
              // string overwrote the local file: silent data loss on every
              // download of a read-restricted field. Omit the file instead, so
              // the existing content is left untouched.
              if (!(fieldName in row)) {
                unreturnedFields.add(fieldName);
                continue;
              }
              files.push({
                name: fieldName,
                type: fieldType,
                content: row[fieldName] ?? "",
              });
            }

            setRecord(records, name, { sys_id: sysId, name, files });
          }

          if (unusableRows > 0) {
            logger.warn(
              `Table ${tableName}: skipped ${unusableRows} record(s) the instance returned without a usable sys_id.`,
            );
          }

          if (unreturnedFields.size > 0) {
            logger.warn(
              `Table ${tableName}: the instance returned no value for field(s) ${[
                ...unreturnedFields,
              ]
                .sort()
                .join(
                  ", ",
                )} — leaving the local file(s) untouched instead of blanking them.`,
            );
          }

          if (Object.keys(records).length > 0) {
            result[tableName] = { records };
          }
        } catch (e) {
          if (!isTableSkippableError(e)) {
            throw e;
          }
          const message = e instanceof Error ? e.message : String(e);
          logger.warn(`Skipping inaccessible table ${tableName}: ${message}`);
        }
      }),
    );

    return result;
  }

  // ─── Public: listAppsFromTableAPI ─────────────────────────────────────────
  // Equivalent of SincUtilsMS.getAppList() — queries sys_app directly

  async function listAppsFromTableAPI(rawClient: SNClient): Promise<SN.App[]> {
    const { client, tracker } = trackTotalCounts(rawClient, requireTotalCount);
    try {
      // Delegated decision 2026-09-28 (wave 13): paged, with a total-row cap
      // (LIST_APPS_MAX_ROWS); was one fixed-limit request (limit 200) whose silent truncation
      // dropped every app past the 200th.
      const rows = await tableAPIGetAllRows(
        client,
        "sys_app",
        "active=true",
        "sys_id,scope,name",
        200,
        LIST_APPS_MAX_ROWS,
      );
      const unverified = describeUnverifiedReads(tracker);
      if (unverified !== undefined) {
        logger.warn(`sys_app listing: ${unverified}`);
      }
      return rows.map((r) => ({
        sys_id: r.sys_id ?? "",
        scope: r.scope ?? "",
        displayName: r.name ?? "",
      }));
    } catch (e) {
      // "No apps" and "the request failed" are different answers: only report
      // an empty list when the endpoint itself is unavailable (ACL/404).
      if (!isTableSkippableError(e)) {
        throw e;
      }
      const message = e instanceof Error ? e.message : String(e);
      logger.warn(
        `sys_app listing unavailable, returning empty app list: ${message}`,
      );
      return [];
    }
  }

  return {
    buildManifestFromTableAPI,
    buildBulkDownloadFromTableAPI,
    listAppsFromTableAPI,
  };
}
