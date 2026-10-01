// Vendored from github.com/IvanBBaev/servicenow-mcp @ 5acdcc7 (src/api/table.ts).
// MIT upstream; vendored by the sole author/copyright owner (ADR-002).

import { ServiceNowError } from "../core/errors.js";
import { snRequest } from "../core/http.js";
import { assertTableAllowed, assertWriteAllowed } from "../core/policy.js";
import {
  getMaxRecords,
  includeReferenceLinks,
  MAX_PAGE_SIZE,
} from "../core/settings.js";
import { logger } from "../core/logging.js";
import { countRows } from "./aggregate.js";
import { expectResult, expectResultArray } from "./shared.js";

// Re-exported so existing imports and host/SSRF unit tests keep working.
export { ServiceNowError } from "../core/errors.js";
export { _buildBaseUrl } from "../core/host.js";

export interface QueryOptions {
  table: string;
  query?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
  displayValue?: "true" | "false" | "all";
  /** Page through all matching records (up to SN_MAX_RECORDS) instead of one page. */
  fetchAll?: boolean;
  /**
   * Wave 16 — opt-in, `fetchAll` only, and only when the instance sends no
   * X-Total-Count: once paging has finished WITHOUT another truncation
   * reason, ask the Aggregate (Stats) API how many rows match (`countRows`,
   * one extra request) and compare. A count other than the rows read marks
   * the read `count-mismatch`; a count that cannot be obtained marks it
   * `count-unavailable`. This is what catches a window read ACLs trimmed to
   * ZERO rows, or a trimmed LAST window, which the no-count probe cannot see.
   *
   * UNVERIFIED: whether the real Stats API count honours row-level read
   * ACLs. If it does, the count equals the rows the caller can see and the
   * check detects nothing — but it can never turn a partial read into a
   * complete one (it only ever adds a truncation flag). Live verification
   * is owed.
   */
  crossCheckCount?: boolean;
}

export type SnRecord = Record<string, unknown>;

/**
 * Why a `fetchAll` read is partial.
 *
 * - `cap` — the read stopped at the SN_MAX_RECORDS cap and X-Total-Count
 *   reports more matching rows.
 * - `short-page` — the instance returned a page shorter than requested (the
 *   usual end-of-results signal) while X-Total-Count still reports more
 *   matching rows: rows were removed by read ACLs after counting, or the
 *   count is inconsistent. Raising SN_MAX_RECORDS does not help here.
 * - `no-total` — the read stopped at the SN_MAX_RECORDS cap and the instance
 *   sent no X-Total-Count, so whether more rows exist is unknown.
 * - `short-page-no-total` — no X-Total-Count, and a page came back shorter
 *   than requested while a later offset still held rows: read ACLs removed
 *   rows (the Table API applies them after the LIMIT). Paging continued past
 *   it, but the hidden rows are not in the result. Raising SN_MAX_RECORDS
 *   does not help here.
 * - `probe-failed` — no X-Total-Count, a page came back short, and the
 *   follow-up request that would tell the end of results from an
 *   ACL-trimmed page failed, so more rows may exist.
 * - `count-mismatch` — no X-Total-Count and nothing else flagged the read,
 *   but the opt-in `crossCheckCount` Stats API count (`count`) disagrees
 *   with the rows read: typically a window read ACLs trimmed to zero rows,
 *   or a trimmed last window. A count below the rows read (inconsistent
 *   paging, concurrent writes) is flagged too.
 * - `count-unavailable` — as above, but the cross-check count request
 *   failed or its count was unreadable, so the end of results is unproven.
 */
export type TruncationReason =
  | "cap"
  | "short-page"
  | "no-total"
  | "short-page-no-total"
  | "probe-failed"
  | "count-mismatch"
  | "count-unavailable";

export interface QueryResult {
  records: SnRecord[];
  total?: number;
  /**
   * True when a `fetchAll` read is known or suspected to be partial — it
   * stopped at the SN_MAX_RECORDS cap, stopped on a short page while
   * X-Total-Count reports more rows, or (with no X-Total-Count) saw an
   * ACL-trimmed page or could not confirm a short page was the end, or the
   * opt-in `crossCheckCount` disagreed / was unavailable (see
   * `truncationReason`). Consumers that
   * imply completeness (snapshot, compare) must surface this so they never
   * present a truncated read as the whole picture.
   */
  truncated?: boolean;
  /** Set exactly when `truncated` is: which of the partial cases this is. */
  truncationReason?: TruncationReason;
  /**
   * Wave 16 — the Stats API row count, set only when `crossCheckCount` ran
   * and returned a readable count (whether or not it matched).
   */
  count?: number;
}

/**
 * One clause naming why a partial read is partial, for a warning that starts
 * with what was read (e.g. `` `sys_dictionary ${describeTruncation(r)}` ``).
 *
 * Delegated decision 2026-09-26: a result flagged `truncated` without a
 * reason (built by an older caller or a test double) is worded as partial
 * without guessing a cause — fail-closed, never "complete".
 */
export function describeTruncation(
  result: Pick<QueryResult, "records" | "total" | "truncationReason" | "count">,
): string {
  const returned = result.records.length;
  switch (result.truncationReason) {
    case "cap":
      return `hit the SN_MAX_RECORDS cap (${returned} of ${result.total ?? "?"} matching rows read; raise SN_MAX_RECORDS for a complete read)`;
    case "short-page":
      return `came back short: X-Total-Count reports ${result.total ?? "?"} matching rows but only ${returned} were returned (rows removed by read ACLs, or an inconsistent count; raising SN_MAX_RECORDS will not help)`;
    case "no-total":
      return `stopped at the SN_MAX_RECORDS cap after ${returned} rows and the instance sent no X-Total-Count, so more rows may exist (raise SN_MAX_RECORDS for a complete read)`;
    case "short-page-no-total":
      return `had a page come back short with no X-Total-Count while later rows still followed: rows were removed by read ACLs and are missing from the ${returned} returned (raising SN_MAX_RECORDS will not help)`;
    case "probe-failed":
      return `stopped after ${returned} rows on a short page with no X-Total-Count, and the follow-up request that would confirm the end of results failed, so more rows may exist`;
    case "count-mismatch":
      return `came back inconsistent: no X-Total-Count, and the Stats API counts ${result.count ?? "?"} matching rows but only ${returned} were returned (rows removed by read ACLs, or rows changed during the read; raising SN_MAX_RECORDS will not help)`;
    case "count-unavailable":
      return `returned ${returned} rows with no X-Total-Count, and the Stats API count that would confirm the end of results could not be obtained, so more rows may exist`;
    default:
      return `stopped before the full result set (${returned} rows read)`;
  }
}

/**
 * Delegated decision 2026-09-25: a table name or sys_id that is empty, `.` or
 * `..` is refused before a path is built. `encodeURIComponent` leaves dots
 * alone, so `updateRecord(".", "sys_user_has_role", …)` produced
 * `/api/now/table/./sys_user_has_role`, which `fetch` resolves to a write on
 * `sys_user_has_role` after the policy checked the table `"."`. The transport
 * refuses such paths too (http.ts); this names the bad argument at the call.
 */
function pathSegment(kind: "table" | "sys_id", value: string): string {
  if (typeof value !== "string" || /^\.{0,2}$/.test(value.trim())) {
    throw new ServiceNowError(
      `Invalid ${kind} ${JSON.stringify(value)}: it must be a non-empty name other than "." or "..".`,
    );
  }
  return encodeURIComponent(value);
}

function tablePath(table: string): string {
  return `/api/now/table/${pathSegment("table", table)}`;
}

function recordPath(table: string, sysId: string): string {
  return `/api/now/table/${pathSegment("table", table)}/${pathSegment("sys_id", sysId)}`;
}

/** Fetch a single page of records (and the X-Total-Count when present). */
async function queryPage(
  opts: QueryOptions,
  limit: number,
  offset: number,
): Promise<QueryResult> {
  const params = new URLSearchParams();
  if (opts.query) params.set("sysparm_query", opts.query);
  if (opts.fields?.length) params.set("sysparm_fields", opts.fields.join(","));
  params.set("sysparm_limit", String(limit));
  if (offset) params.set("sysparm_offset", String(offset));
  params.set("sysparm_display_value", opts.displayValue ?? "false");
  if (!includeReferenceLinks()) {
    params.set("sysparm_exclude_reference_link", "true");
  }

  const { data, total } = await snRequest<{ result: SnRecord[] }>({
    method: "GET",
    path: tablePath(opts.table),
    params,
  });
  return { records: expectResultArray(data, "Table API"), total };
}

/**
 * Read records from a table. By default returns a single page of up to `limit`
 * records (default 10). When `fetchAll` is set, pages through every matching
 * record in batches, up to the SN_MAX_RECORDS safety cap. `total` reflects the
 * server's X-Total-Count (all matching rows), when provided.
 */
export async function queryTable(opts: QueryOptions): Promise<QueryResult> {
  assertTableAllowed(opts.table);
  if (!opts.fetchAll) {
    return queryPage(opts, opts.limit ?? 10, opts.offset ?? 0);
  }

  // Delegated decision 2026-09-30 (wave 16): the cross-check counts the
  // caller's own filter, without the ORDERBYsys_id appended below for
  // stable paging — ordering is meaningless to a count, and the Stats API
  // (GlideAggregate) is not promised to accept an ORDERBY on a field it
  // does not group by. A caller-supplied ORDERBY is passed through as sent.
  const countQuery = opts.query;

  // Offset paging without ORDERBY is unstable: ServiceNow gives no ordering
  // guarantee, so concurrent writes can skip/duplicate rows across pages.
  if (!opts.query?.includes("ORDERBY")) {
    opts = {
      ...opts,
      query: opts.query ? `${opts.query}^ORDERBYsys_id` : "ORDERBYsys_id",
    };
  }

  const pageSize = Math.min(opts.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE);
  const cap = getMaxRecords();
  const records: SnRecord[] = [];
  let total: number | undefined;
  let offset = opts.offset ?? 0;
  let hitCap = false;
  let shortPage = false;
  // No-count mode only: a non-empty short page was followed by more rows
  // (ACL trimming seen), or the request probing past a short page failed.
  let trimmedNoTotal = false;
  let probeError: unknown;
  let lastPageShort = false;

  for (;;) {
    const want = Math.min(pageSize, cap - records.length);
    if (want <= 0) {
      hitCap = true; // stopped on the cap, not on an exhausted result set
      break;
    }
    let page: QueryResult;
    if (lastPageShort) {
      // Delegated decision 2026-09-30 (wave 15): the request after a short
      // page with no X-Total-Count is a probe. If it fails, the rows read so
      // far come back flagged `probe-failed` rather than thrown: before this
      // probe existed the same read returned them as complete, so throwing
      // would turn a working read into an error, while returning them
      // unflagged would claim an end nothing proved. A failure after a FULL
      // page still throws, as before.
      try {
        page = await queryPage(opts, want, offset);
      } catch (error) {
        probeError = error;
        break;
      }
    } else {
      page = await queryPage(opts, want, offset);
    }
    if (total === undefined) total = page.total;
    if (lastPageShort && page.records.length > 0) trimmedNoTotal = true;
    records.push(...page.records);
    if (page.records.length < want) {
      if (total !== undefined || page.records.length === 0) {
        // With X-Total-Count the count decides below whether this is really
        // the end (unchanged: no probe). Without it, an empty page is the
        // only end signal we accept.
        shortPage = true;
        break;
      }
      // Delegated decision 2026-09-30 (wave 15): without X-Total-Count a
      // short page is indistinguishable from an ACL-trimmed one (the Table
      // API applies read ACLs after the LIMIT), so keep paging until a page
      // comes back empty. That costs one request past the data for a read
      // whose last page is short; every other request returns rows. A page
      // the ACLs trim to ZERO rows still reads as the end — probing past an
      // empty page would be unbounded (known residual).
      lastPageShort = true;
    } else {
      lastPageShort = false;
    }
    // Advance by the raw window, not by the rows returned: an ACL-trimmed
    // page consumed `want` rows server-side, and stepping by fewer would
    // re-read (and duplicate) rows. For a full page the two are equal.
    offset += want;
  }

  // Prefer X-Total-Count (exact: a cap equal to the row count is NOT a
  // truncation); fall back to "we broke on the cap" when the header is absent.
  let truncated =
    total !== undefined
      ? records.length < total
      : hitCap || trimmedNoTotal || probeError !== undefined || undefined;

  // Wave 16 — opt-in Stats API cross-check (see `QueryOptions.crossCheckCount`).
  //
  // Delegated decision 2026-09-30 (wave 16): precedence. The count is
  // requested only when there is no X-Total-Count (the header already
  // decides exactly) AND no other reason has flagged the read: `probe-failed`,
  // `no-total` and `short-page-no-total` are more specific (and the cap one
  // more actionable), and the verdict is already partial, so an extra
  // request could only change the wording. The new reasons therefore apply
  // only to a read that would otherwise have come back complete.
  //
  // Delegated decision 2026-09-30 (wave 16): ANY disagreement is a
  // mismatch, not only a count above the rows read. A count below them
  // means rows moved during offset paging (duplicates/skips possible) or
  // the two APIs disagree — nothing then proves the read is the whole set.
  // With a starting `offset`, the rows expected are `count - offset`
  // (the offset skips raw rows server-side, as the count does when it is
  // not ACL-filtered); if the count IS ACL-filtered that can mis-state the
  // expectation, which errs toward flagging, never toward complete.
  //
  // UNVERIFIED LIVE: if the real Stats API count honours row-level read
  // ACLs, it equals the rows the caller can see and this check detects
  // nothing (a trimmed last window stays invisible). It cannot produce a
  // false GO either way: it only ever ADDS a truncation flag.
  let count: number | undefined;
  let countError: string | undefined;
  if (opts.crossCheckCount === true && total === undefined && !truncated) {
    const counted = await countRows({
      table: opts.table,
      ...(countQuery ? { query: countQuery } : {}),
    });
    if (counted.ok) {
      count = counted.count;
      const expected = Math.max(0, count - (opts.offset ?? 0));
      if (records.length !== expected) truncated = true;
    } else {
      countError = counted.message;
      truncated = true;
    }
  }
  if (!truncated) {
    return {
      records,
      total,
      truncated: undefined,
      ...(count !== undefined ? { count } : {}),
    };
  }

  // Delegated decision 2026-09-26: the partial verdict is unchanged
  // (fail-closed); only its reason is named. A short page under a larger
  // X-Total-Count is what read-ACL row trimming renders (the count is taken
  // before the ACL filter) — reporting it as "the cap" sent people to raise
  // SN_MAX_RECORDS, which cannot fix it. Without the header, a short page
  // is the end of results only once an empty probe confirms it (see below).
  //
  // Delegated decision 2026-09-30 (wave 15): without the header, precedence
  // is probe failure, then the cap, then observed trimming. A failed probe
  // means the read did not finish; at the cap, raising SN_MAX_RECORDS is the
  // one actionable remedy even if trimming was also seen. Every one of these
  // is partial — only the wording differs.
  const truncationReason: TruncationReason =
    total === undefined
      ? countError !== undefined
        ? "count-unavailable"
        : count !== undefined
          ? "count-mismatch"
          : probeError !== undefined
            ? "probe-failed"
            : hitCap
              ? "no-total"
              : "short-page-no-total"
      : shortPage && !hitCap
        ? "short-page"
        : "cap";
  const messages: Record<TruncationReason, string> = {
    "short-page":
      "fetchAll stopped on a short page while X-Total-Count reports more rows (rows removed by read ACLs, or an inconsistent count; partial result)",
    "no-total":
      "fetchAll stopped at the SN_MAX_RECORDS cap and the instance sent no X-Total-Count (more rows may exist; partial result)",
    cap: "fetchAll stopped at the SN_MAX_RECORDS cap (partial result)",
    "short-page-no-total":
      "fetchAll saw a short page with no X-Total-Count followed by more rows (rows removed by read ACLs; partial result)",
    "probe-failed":
      "fetchAll could not confirm a short page was the end: no X-Total-Count and the follow-up request failed (more rows may exist; partial result)",
    "count-mismatch":
      "fetchAll read disagrees with the Stats API count: no X-Total-Count and the count differs from the rows read (rows removed by read ACLs, or changed during the read; partial result)",
    "count-unavailable":
      "fetchAll could not cross-check its read: no X-Total-Count and the Stats API count failed or was unreadable (more rows may exist; partial result)",
  };
  logger.warn(messages[truncationReason], {
    table: opts.table,
    reason: truncationReason,
    returned: records.length,
    cap,
    total,
    ...(count !== undefined ? { count } : {}),
    ...(countError !== undefined ? { error: countError } : {}),
    ...(probeError !== undefined
      ? {
          error:
            probeError instanceof Error
              ? probeError.message
              : "non-Error thrown",
        }
      : {}),
  });

  return {
    records,
    total,
    truncated: true,
    truncationReason,
    ...(count !== undefined ? { count } : {}),
  };
}

/** Read a single record by sys_id. */
export async function getRecord(
  table: string,
  sysId: string,
  fields?: string[],
): Promise<SnRecord> {
  assertTableAllowed(table);
  const params = new URLSearchParams();
  if (fields?.length) params.set("sysparm_fields", fields.join(","));
  if (!includeReferenceLinks()) {
    params.set("sysparm_exclude_reference_link", "true");
  }

  const { data } = await snRequest<{ result: SnRecord }>({
    method: "GET",
    path: recordPath(table, sysId),
    params,
  });
  return expectResult(data, "Table API");
}

/** Create a new record. */
export async function createRecord(
  table: string,
  fields: SnRecord,
): Promise<SnRecord> {
  assertTableAllowed(table);
  assertWriteAllowed("create");
  const { data } = await snRequest<{ result: SnRecord }>({
    method: "POST",
    path: tablePath(table),
    body: fields,
  });
  return expectResult(data, "Table API");
}

/** Update an existing record by sys_id. */
export async function updateRecord(
  table: string,
  sysId: string,
  fields: SnRecord,
): Promise<SnRecord> {
  assertTableAllowed(table);
  assertWriteAllowed("update");
  const { data } = await snRequest<{ result: SnRecord }>({
    method: "PATCH",
    path: recordPath(table, sysId),
    body: fields,
  });
  return expectResult(data, "Table API");
}

/** Delete a record by sys_id. */
export async function deleteRecord(
  table: string,
  sysId: string,
): Promise<{ deleted: true; table: string; sys_id: string }> {
  assertTableAllowed(table);
  assertWriteAllowed("delete");
  await snRequest<unknown>({
    method: "DELETE",
    path: recordPath(table, sysId),
  });
  return { deleted: true, table, sys_id: sysId };
}
