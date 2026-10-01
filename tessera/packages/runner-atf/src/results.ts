// PLAN Phase 5 — the per-spec result parser (DEV-6 / DR-4 / ARCH-9 / QA-6).
//
// DR-4 killed the idea that a suite-level verdict is enough: a suite that says
// "Failed" tells you nothing about WHICH spec failed, and a checklist row per
// spec is the whole product (§6a). So attribution happens here, per test, and
// it happens through the projection rather than through names: ARCH-26/DEV-16
// make `ProjectionMap` the ephemeral attribution key, and this module inverts
// it into `sys_atf_test.sys_id → TestSpecRef` (QA-13). Matching on test *names*
// would be the classic silent-mis-attribution bug — two runs of the same suite,
// or a hand-edited test on the instance, and results land on the wrong row.
//
// QA-9 / QA-6: a spec with no result row is "missing", never a quiet pass.
// "missing" is documented in `@tessera/types` as reducer-synthesized, and the
// reducer does synthesize it for a spec with no outcome at all — but reporting
// it explicitly is strictly more informative (the runner KNOWS it triggered the
// suite and got nothing back, which "no outcome" cannot express), and §6a
// resolves it identically: status `fail`, blocking. Fail-closed either way.
//
// TM-1 — instance-authored text is untrusted input. A ServiceNow test step can
// contain an arbitrary script body, and that body must never reach a
// `TestEvent`, a report, or (downstream) a model prompt. Two defences, in
// order of strength:
//   1. Structural: every read below sends an explicit `sysparm_fields`
//      allowlist, so a script column is never fetched in the first place. The
//      allowlists are module constants, NOT options — widening one is a code
//      change that has to pass a TM-1 review.
//   2. Textual: whatever does arrive is control-character-scrubbed and length
//      capped ({@link MAX_ASSERTION_CHARS}) before it enters an event.
// A whole serialised row is never used as a message, for the same reason.

import { aggregateApi } from "@tessera/sn-client";
import type {
  ArtifactRef,
  EvidenceRef,
  RawOutcome,
  TestSpecRef,
} from "@tessera/types";
import {
  AtfInfrastructureError,
  asRecord,
  fieldString,
  requestOrFault,
  unwrapResult,
  type AtfHttpClient,
} from "./client.js";

export const TABLE_API_PREFIX = "/api/now/table/";

/** The Aggregate (Stats) API — used only for the wave-16 row count. */
export const STATS_API_PREFIX = "/api/now/stats/";

/** Per-test ATF results — `sys_atf_test_result.test` points at a test. */
export const ATF_TEST_RESULT_TABLE = "sys_atf_test_result";

/**
 * Per-step detail. [OPEN] The table name is real; the column names below are a
 * best guess aligned with `@tessera/phase05`'s provenance notes and are NOT
 * verified against a live instance — which is why step detail is opt-in
 * ({@link ResultOptions.includeStepDetail}, default off).
 */
export const ATF_TEST_RESULT_ITEM_TABLE = "sys_atf_test_result_item";

/** TM-1 allowlist for the result read. Not an option — see the header. */
export const RESULT_FIELDS: readonly string[] = [
  "sys_id",
  "test",
  "status",
  "output",
  "sys_created_on",
  // F1: the reference to the `sys_atf_test_suite_result` (one suite
  // execution) that produced the row — read back so the client can refuse a
  // row the server-side filter should have excluded.
  "test_suite_result",
];

/** TM-1 allowlist for the step-detail read. Not an option — see the header. */
export const RESULT_ITEM_FIELDS: readonly string[] = [
  "sys_id",
  "test_result",
  "status",
  "output",
  "order",
];

/**
 * Cap for any instance-authored string copied into a `TestEvent`. 2000 chars
 * is roughly a screenful of stack-ish output: enough to identify the failing
 * assertion, small enough that a runaway `gs.print` loop cannot bloat a report
 * or dominate a downstream prompt window (TM-1).
 */
export const MAX_ASSERTION_CHARS = 2_000;

/** Test sys_ids per `IN` query — keeps the encoded query well under any URL cap. */
export const RESULT_QUERY_BATCH = 50;

/** Rows fetched per test in a batch read; only the newest is ever used. */
export const MAX_RESULT_ROWS_PER_TEST = 4;

/** Failing step outputs appended to one assertion message. */
export const MAX_STEP_ITEMS = 5;

/**
 * Step rows read per result row. The batch read below asks for this many times
 * the batch size; when the instance has more than that, the page is re-read one
 * result at a time so a shared page cannot cut a result's step list short (see
 * {@link fetchResultItems}). A single result with more than this many steps is
 * still capped — the read then covers the first {@link MAX_RESULT_ITEMS_PER_RESULT}
 * by `order`, which is a bound on the read, not a claim that there were no more.
 */
export const MAX_RESULT_ITEMS_PER_RESULT = 50;

/**
 * One suite execution per row; a nested child suite's row points at its
 * parent execution via `parent`. The triggered suite's row is the root, named
 * by the terminal CI/CD payload's `links.results.id`.
 */
export const ATF_SUITE_RESULT_TABLE = "sys_atf_test_suite_result";

/** TM-1 allowlist for the suite-result tree read. Not an option — see the header. */
export const SUITE_RESULT_FIELDS: readonly string[] = ["sys_id", "parent"];

/**
 * Default depth cap of the child-suite traversal: levels BELOW the root.
 *
 * Delegated decision 2026-09-28 (wave 13): 8. ATF nesting in practice is one
 * or two levels; 8 is generous for a hand-built hierarchy and still bounds the
 * number of sequential reads a hostile or corrupted `parent` chain can cost.
 * Deeper evidence is a fault, never a silently shallower tree.
 */
export const MAX_SUITE_DEPTH = 8;

/**
 * Default cap on suite-result rows in one execution tree, root included.
 *
 * Delegated decision 2026-09-28 (wave 13): 100 — two `IN` batches of
 * {@link RESULT_QUERY_BATCH} links per test batch in the result read. An
 * execution tree with more rows is a fault, never a partial read.
 */
export const MAX_SUITE_RESULTS = 100;

/** ARCH-26/DEV-16 reverse index: `sys_atf_test.sys_id` → the spec it came from. */
export type TestIndex = ReadonlyMap<string, TestSpecRef>;

export interface AtfResultRow {
  readonly sysId: string;
  readonly testSysId: string;
  readonly status: string;
  readonly output: string;
  readonly createdOn: string;
  /** `test_suite_result` — the suite execution this row belongs to. */
  readonly suiteResultSysId: string;
}

export interface AtfResultItemRow {
  readonly sysId: string;
  readonly testResultSysId: string;
  readonly status: string;
  readonly output: string;
  readonly order: string;
}

/** One attributed spec result, ready to become an event plus a `SpecOutcome`. */
export interface SpecResult {
  readonly spec: TestSpecRef;
  readonly raw: RawOutcome;
  readonly evidence?: EvidenceRef;
  /** Sanitized failure text — set only when `raw === "fail"`. */
  readonly assertion?: string;
  /** Sanitized explanation — set for every outcome that is neither pass nor fail. */
  readonly cause?: string;
  readonly artifacts?: readonly ArtifactRef[];
}

export interface ResultOptions {
  readonly resultTable?: string;
  readonly resultItemTable?: string;
  /** Read `sys_atf_test_result_item` for failing tests. Default `false`. */
  readonly includeStepDetail?: boolean;
  /** Override {@link MAX_ASSERTION_CHARS} (tests, narrow report targets). */
  readonly maxAssertionChars?: number;
  /**
   * Override {@link MAX_SUITE_DEPTH}. A positive integer, else `TypeError`
   * (at `createAtfRunner`, or at {@link fetchSuiteResultTree}).
   */
  readonly maxSuiteDepth?: number;
  /**
   * Override {@link MAX_SUITE_RESULTS} (root included). A positive integer,
   * else `TypeError` (at `createAtfRunner`, or at {@link fetchSuiteResultTree}).
   */
  readonly maxSuiteResults?: number;
}

/** One execution's `sys_atf_test_suite_result` rows: the root and every nested child. */
export interface SuiteResultTree {
  /** The triggered suite's execution row (`links.results.id`). */
  readonly root: string;
  /** Every row of the tree, root first, then level by level. */
  readonly ids: readonly string[];
  /** Levels below the root that carried at least one row (0: no child suite). */
  readonly depth: number;
}

const CODE_TAB = 9;
const CODE_LF = 10;
const CODE_CR = 13;
const CODE_SPACE = 32;
const CODE_DEL = 127;
const CODE_C1_LAST = 159;
const CODE_LINE_SEP = 0x2028;
const CODE_PARA_SEP = 0x2029;

const NEWLINE = String.fromCharCode(CODE_LF);

/**
 * TAB and LF survive as whitespace; every other C0/C1 control character, DEL,
 * and the two Unicode line separators are replaced. Code points, not a regex
 * literal, so the intent is readable and the source carries no raw control
 * bytes of its own.
 */
function isTextSafe(code: number): boolean {
  if (code === CODE_TAB || code === CODE_LF) return true;
  if (code < CODE_SPACE) return false;
  if (code === CODE_DEL) return false;
  if (code > CODE_DEL && code <= CODE_C1_LAST) return false;
  return code !== CODE_LINE_SEP && code !== CODE_PARA_SEP;
}

/**
 * The control half of {@link sanitizeMessage}, without the length cap:
 * normalise newlines, scrub control characters, trim. Split out so a message
 * assembled from several instance-authored parts can be capped ONCE, at the
 * end — see {@link failureMessage}.
 */
function scrub(raw: string): string {
  let scrubbed = "";
  let afterCr = false;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === CODE_CR) {
      scrubbed += NEWLINE;
      afterCr = true;
      continue;
    }
    if (code === CODE_LF) {
      // CRLF already contributed its newline.
      if (!afterCr) scrubbed += NEWLINE;
      afterCr = false;
      continue;
    }
    afterCr = false;
    scrubbed += isTextSafe(code) ? ch : " ";
  }
  return scrubbed.trim();
}

/**
 * TM-1 — make one instance-authored string safe to put in a `TestEvent`:
 * normalise newlines, scrub control characters, trim, and cap the length with
 * a visible truncation marker (silent truncation would hide the fact that
 * evidence was cut). The cap counts SCRUBBED characters, so control bytes buy
 * no extra room.
 */
export function sanitizeMessage(
  raw: string,
  max: number = MAX_ASSERTION_CHARS,
): string {
  const normalised = scrub(raw);
  const limit = Math.max(1, max);
  if (normalised.length <= limit) return normalised;
  const dropped = normalised.length - limit;
  return `${normalised.slice(0, limit)} …[truncated ${dropped} chars]`;
}

/**
 * ATF result status → `RawOutcome`. The `success`/`failure` spellings are the
 * ones `@tessera/phase05` recorded from Spike-2b; the rest are tolerated
 * synonyms. Anything unrecognised becomes "error" rather than a guess —
 * fail-closed, with the raw value surfaced in the cause.
 */
export function mapResultStatus(status: string): RawOutcome {
  switch (status.trim().toLowerCase()) {
    case "success":
    case "successful":
    case "pass":
    case "passed":
      return "pass";
    case "failure":
    case "failed":
    case "fail":
      return "fail";
    case "skipped":
    case "skip":
      return "skipped";
    default:
      return "error";
  }
}

/** sys_ids are hex; anything else would corrupt an encoded query (`^`, `,`). */
const SYS_ID_RE = /^[A-Za-z0-9_-]+$/;

function assertQueryable(sysIds: readonly string[], what: string): void {
  for (const sysId of sysIds) {
    if (!SYS_ID_RE.test(sysId)) {
      throw new AtfInfrastructureError(
        `refusing to build an encoded query: ${what} ${JSON.stringify(sysId)} is not a sys_id`,
      );
    }
  }
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

interface TableReadArgs {
  readonly table: string;
  readonly query: string;
  readonly fields: readonly string[];
  readonly limit: number;
}

/**
 * Why a page read WITHOUT `X-Total-Count` is judged partial although it came
 * back shorter than requested (see {@link readTable}):
 *
 * - `short-page-no-total` — the probe one window past the page returned rows,
 *   so the short page was not the end: read ACLs removed rows from it (the
 *   Table API applies them after the LIMIT) and more rows follow.
 * - `probe-failed` — the probe that would tell the end of results from an
 *   ACL-trimmed page failed, so more rows may exist.
 * - `count-mismatch` (wave 16) — the Aggregate (Stats) API counted a
 *   different number of rows for the same filter than the page returned: a
 *   window trimmed to zero rows, a trimmed last window, or rows that moved.
 * - `count-unavailable` (wave 16) — the Stats count that would confirm the
 *   read failed or was unreadable, so the read cannot be proven complete.
 */
type NoTotalIncompleteReason =
  | "short-page-no-total"
  | "probe-failed"
  | "count-mismatch"
  | "count-unavailable";

interface TableReadResult {
  readonly rows: readonly Record<string, unknown>[];
  /**
   * True when the instance had (or may have had) more rows than this page
   * returned: a full page, an `X-Total-Count` above the rows returned, or —
   * with no count — a short page the probe could not confirm as the end.
   */
  readonly truncated: boolean;
  /** `X-Total-Count`, when the transport reported one. */
  readonly total?: number;
  /** Set exactly when a no-count short page was judged partial. */
  readonly incomplete?: NoTotalIncompleteReason;
  /** The probe's fault, when `incomplete` is `probe-failed`. */
  readonly probeError?: AtfInfrastructureError;
  /** The Stats API count, when one was read (`count-mismatch` or complete). */
  readonly count?: number;
  /** Why no count could be read, when `incomplete` is `count-unavailable`. */
  readonly countError?: AtfInfrastructureError;
}

/**
 * Append a stable order when the query has none. Offset paging without
 * ORDERBY is unstable (ServiceNow guarantees no order), and the probe below
 * reads the NEXT window of the same query — which only means something if
 * both requests see the rows in the same order. Same rule as
 * `@tessera/sn-client`'s `fetchAll`.
 */
function ordered(query: string): string {
  return query.includes("ORDERBY") ? query : `${query}^ORDERBYsys_id`;
}

/**
 * The filter of an encoded query without its ORDERBY terms — what the Stats
 * count is asked for. A count has no order, and the decision recorded in
 * `@tessera/sn-client`'s `queryTable({ crossCheckCount })` is to count the
 * caller's filter without the appended ORDERBY. The queries here are built
 * from validated sys_ids and module constants, so no `^` occurs inside a term.
 */
function countFilter(query: string): string {
  return query
    .split("^")
    .filter((term) => term !== "" && !term.startsWith("ORDERBY"))
    .join("^");
}

/**
 * Wave 16 — ask the Aggregate (Stats) API how many rows match `filter`,
 * through the injected port (never sn-client's ambient `countRows`). The body
 * is read with sn-client's own fail-closed parser, so the two packages agree
 * on what a count is. A failed request or an unreadable count is an
 * {@link AtfInfrastructureError}, returned rather than thrown.
 */
async function statsCount(
  client: AtfHttpClient,
  table: string,
  filter: string,
): Promise<{ count: number } | { error: AtfInfrastructureError }> {
  const path = `${STATS_API_PREFIX}${encodeURIComponent(table)}`;
  const params = new URLSearchParams({ sysparm_count: "true" });
  if (filter !== "") params.set("sysparm_query", filter);
  const context = `GET ${path} (row count of ${table})`;
  try {
    const response = await requestOrFault<unknown>(
      client,
      { method: "GET", path, params },
      context,
    );
    const count = aggregateApi.parseStatsCount(response.data);
    if (count === undefined) {
      return {
        error: new AtfInfrastructureError(
          `${context} answered HTTP ${response.status} but result.stats.count is missing or not a non-negative integer`,
        ),
      };
    }
    return { count };
  } catch (error) {
    if (!(error instanceof AtfInfrastructureError)) throw error;
    return { error };
  }
}

async function readTable(
  client: AtfHttpClient,
  args: TableReadArgs,
): Promise<TableReadResult> {
  const query = ordered(args.query);
  const params = new URLSearchParams({
    sysparm_query: query,
    // TM-1 defence #1 — the projection happens server-side.
    sysparm_fields: args.fields.join(","),
    sysparm_limit: String(args.limit),
    sysparm_display_value: "false",
    sysparm_exclude_reference_link: "true",
  });
  const path = `${TABLE_API_PREFIX}${encodeURIComponent(args.table)}`;
  // The context names the table but never the encoded query: the query is
  // built from validated sys_ids and module constants today, and keeping
  // caller-influenced text out of a fault message keeps it that way (TM-1).
  const context = `GET ${path} (read of ${args.table})`;
  const response = await requestOrFault<unknown>(
    client,
    { method: "GET", path, params },
    context,
  );
  const rows = rowsOf(response.data, args.table, response.status);
  const total = response.total;
  const base = total === undefined ? {} : { total };
  if (rows.length >= args.limit) return { rows, truncated: true, ...base };
  if (total !== undefined) {
    // Unchanged: the count (taken before read ACLs) decides. No probe.
    return { rows, truncated: total > rows.length, ...base };
  }
  if (rows.length === 0) {
    // Delegated decision 2026-09-30 (wave 15): an EMPTY page without a count
    // is not probed — probing would add a request to every read that
    // legitimately finds nothing (every leaf level of the suite tree). Wave 16:
    // the Stats count below closes the "window trimmed to zero rows" hole the
    // probe left open.
    return crossCheck(client, args, rows);
  }

  // Delegated decision 2026-09-30 (wave 15): without X-Total-Count a short,
  // non-empty page is indistinguishable from an ACL-trimmed one, so it is
  // confirmed as the end by ONE probe of the next window: same query, same
  // limit, offset = the requested window (not the rows returned — a trimmed
  // page consumed the whole window server-side). Rows there mean the page was
  // trimmed and more rows follow; a probe that fails proves nothing either
  // way. Both are partial — never a complete read. A trimmed LAST window (no
  // rows past it) is left to the Stats count below (wave 16). Mirrored rather than routed through `fetchAll`: that reads
  // ambient credentials via `snRequest`, and this package only talks to the
  // injected `AtfHttpClient` port (see client.ts).
  const probeParams = new URLSearchParams(params);
  probeParams.set("sysparm_offset", String(args.limit));
  try {
    const probe = await requestOrFault<unknown>(
      client,
      { method: "GET", path, params: probeParams },
      `${context} probe past a short page`,
    );
    const more = rowsOf(probe.data, args.table, probe.status);
    if (more.length > 0) {
      return { rows, truncated: true, incomplete: "short-page-no-total" };
    }
  } catch (error) {
    if (!(error instanceof AtfInfrastructureError)) throw error;
    return {
      rows,
      truncated: true,
      incomplete: "probe-failed",
      probeError: error,
    };
  }
  return crossCheck(client, args, rows);
}

/**
 * Wave 16 — the last word on a read without `X-Total-Count` that is otherwise
 * complete (an empty page, or a short page whose probe came back empty): ONE
 * Stats count of the same filter, without ORDERBY. Only a count equal to the
 * rows read confirms the read; any other count is `count-mismatch`, and a
 * count that cannot be read is `count-unavailable` — both partial.
 *
 * Delegated decision 2026-09-30 (wave 16): ALWAYS ON whenever the Table API
 * sent no `X-Total-Count`, not an option. These reads decide which specs a
 * run reports (the suite tree, the result join) and a read the probe cannot
 * vouch for fails OPEN otherwise; the cost is one request on a path the live
 * adapter only reaches when the instance withholds the header. An instance
 * without the Stats API (404, 403) therefore reads as partial, never as
 * complete — fail closed.
 *
 * Delegated decision 2026-09-30 (wave 16): a count BELOW the rows read is a
 * mismatch too (rows moved between the requests, or the two APIs disagree)
 * — the same rule as sn-client's `crossCheckCount`. The read always starts at
 * offset 0, so the expectation is the count itself.
 *
 * UNVERIFIED LIVE (as in sn-client): if the real Stats count honours
 * row-level read ACLs it equals the rows the Table API let through, and a
 * trimmed LAST window stays invisible (the fake's `statsCount.aclFiltered`
 * pins that residual). A window trimmed to zero rows with visible rows past
 * it is still caught. The check only ever ADDS a partial verdict.
 */
async function crossCheck(
  client: AtfHttpClient,
  args: TableReadArgs,
  rows: readonly Record<string, unknown>[],
): Promise<TableReadResult> {
  const counted = await statsCount(client, args.table, countFilter(args.query));
  if ("error" in counted) {
    return {
      rows,
      truncated: true,
      incomplete: "count-unavailable",
      countError: counted.error,
    };
  }
  return counted.count === rows.length
    ? { rows, truncated: false, count: counted.count }
    : {
        rows,
        truncated: true,
        incomplete: "count-mismatch",
        count: counted.count,
      };
}

/** The `{ result: [...] }` rows of a Table API list read, or a DEV-1 fault. */
function rowsOf(
  body: unknown,
  table: string,
  status: number,
): Record<string, unknown>[] {
  const result = unwrapResult(body);
  if (!Array.isArray(result)) {
    throw new AtfInfrastructureError(
      `Table API read of ${table} returned no 'result' array (HTTP ${status})`,
    );
  }
  const rows: Record<string, unknown>[] = [];
  for (const entry of result as unknown[]) {
    const row = asRecord(entry);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

function toResultRow(row: Record<string, unknown>): AtfResultRow {
  return {
    sysId: fieldString(row, "sys_id"),
    testSysId: fieldString(row, "test"),
    status: fieldString(row, "status"),
    output: fieldString(row, "output"),
    createdOn: fieldString(row, "sys_created_on"),
    suiteResultSysId: fieldString(row, "test_suite_result"),
  };
}

/**
 * Validate the execution link before it goes into an encoded query.
 *
 * Delegated decision 2026-09-26: the suite result id is REQUIRED and checked at
 * runtime, not only by the type. A JavaScript caller of the old signature
 * passes its options object in this slot, and a missing/blank id must never
 * degrade into the unscoped "newest row for this test" read that F1 is about —
 * so anything but a sys_id-shaped string rejects as a DEV-1 fault before a
 * request leaves the adapter.
 */
function assertSuiteResultId(suiteResultSysId: unknown): string {
  if (
    typeof suiteResultSysId !== "string" ||
    !SYS_ID_RE.test(suiteResultSysId)
  ) {
    throw new AtfInfrastructureError(
      `refusing to read ATF results without an execution link: the suite result id ${
        typeof suiteResultSysId === "string"
          ? JSON.stringify(suiteResultSysId)
          : `(${typeof suiteResultSysId})`
      } is not a sys_id`,
    );
  }
  return suiteResultSysId;
}

/**
 * Validate the execution link(s) a result read is scoped by: one suite result
 * id (a single execution, the historical form) or the ids of one execution's
 * suite-result tree (see {@link fetchSuiteResultTree}). An empty list, or any
 * element that is not a sys_id, rejects exactly like a bad single id — never
 * an unscoped read.
 */
function assertSuiteResultLinks(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [assertSuiteResultId(value)];
  const list = value as readonly unknown[];
  if (list.length === 0) {
    throw new AtfInfrastructureError(
      "refusing to read ATF results without an execution link: the suite result id list is empty",
    );
  }
  return [...new Set(list.map((entry) => assertSuiteResultId(entry)))];
}

/**
 * Newest LINKED row per (test, suite result) — order-independent, so paging
 * cannot skew it.
 *
 * Delegated decision 2026-09-26: a row whose `test_suite_result` is not one of
 * the executions being read is discarded here even though the encoded query
 * already filters on it. The query is the primary defence; this is the second
 * one, for a transport, proxy or ACL-rewritten query that returns more than
 * was asked for. A discarded row leaves the spec `missing` (§6a: blocking),
 * never pass.
 */
function keepNewest(
  into: Map<string, Map<string, AtfResultRow>>,
  row: AtfResultRow,
  links: ReadonlySet<string>,
): void {
  if (row.testSysId === "" || row.sysId === "") return;
  if (!links.has(row.suiteResultSysId)) return;
  let perLink = into.get(row.testSysId);
  if (perLink === undefined) {
    perLink = new Map<string, AtfResultRow>();
    into.set(row.testSysId, perLink);
  }
  const current = perLink.get(row.suiteResultSysId);
  if (current === undefined || row.createdOn > current.createdOn) {
    perLink.set(row.suiteResultSysId, row);
  }
}

/** How bad an outcome is, for the worst-of join across suite results. */
function severity(row: AtfResultRow): number {
  switch (mapResultStatus(row.status)) {
    case "fail":
      return 3;
    case "error":
      return 2;
    case "skipped":
      return 1;
    default:
      return 0;
  }
}

/**
 * Join one test's rows across the suite results of an execution tree.
 *
 * Delegated decision 2026-09-28 (wave 13): WORST-of, not newest-of. A test that
 * a suite and one of its child suites both run has one row per execution row,
 * and "newest wins" would let a later green run in one child mask a red run in
 * a sibling — a partial GO. Ranking fail > error > skipped > pass keeps every
 * non-pass visible; a tie keeps the newest. With a single suite result (a flat
 * suite, the pre-wave-13 case) this is exactly the old newest-row rule.
 */
function worstOf(perLink: ReadonlyMap<string, AtfResultRow>): AtfResultRow {
  let worst: AtfResultRow | undefined;
  for (const row of perLink.values()) {
    if (
      worst === undefined ||
      severity(row) > severity(worst) ||
      (severity(row) === severity(worst) && row.createdOn > worst.createdOn)
    ) {
      worst = row;
    }
  }
  // keepNewest never creates an empty bucket.
  if (worst === undefined) {
    throw new AtfInfrastructureError("internal: empty result bucket");
  }
  return worst;
}

/**
 * Read, for each test sys_id, the `sys_atf_test_result` row that stands for it
 * in ONE suite execution — the execution's own row and, when given a tree, the
 * rows of its nested child suites.
 *
 * F1 (fix 2026-09-26): the read used to take "the newest row for this test",
 * with no execution filter. `sys_atf_test_result` is a history table, so a
 * stale row written before the trigger, or a concurrent run's row, was
 * attributed to this run — a suite Canceled at 0% could report a pass. The
 * read is now scoped by `test_suite_result`: the reference from
 * `sys_atf_test_result` to `sys_atf_test_suite_result`, whose sys_id the
 * terminal CI/CD progress payload names as `links.results.id` (the join the
 * parent repo's `src/checks/atf-run.ts` already uses). Within one suite
 * result a test normally has one row; "newest wins" only breaks a tie among
 * rows that are all linked to it.
 *
 * Wave 13 (2026-09-28): nested child suites. `suiteResultSysIds` may be the
 * ids of one execution's suite-result tree ({@link fetchSuiteResultTree}),
 * root first; rows linked to ANY of them are admissible (they are all this
 * run's), and a test with rows under several of them is joined worst-of (see
 * {@link worstOf}). A single id keeps the exact pre-wave-13 read. Attribution
 * stays run-scoped (DEV-6/DR-4): the tree is discovered from this execution's
 * root downwards, never from a test or suite name.
 */
export async function fetchTestResults(
  client: AtfHttpClient,
  testSysIds: readonly string[],
  suiteResultSysIds: string | readonly string[],
  options: ResultOptions = {},
): Promise<Map<string, AtfResultRow>> {
  const links = assertSuiteResultLinks(suiteResultSysIds);
  const linkSet = new Set(links);
  const table = options.resultTable ?? ATF_TEST_RESULT_TABLE;
  const unique = [...new Set(testSysIds)].filter((id) => id !== "");
  assertQueryable(unique, "test sys_id");
  const byPair = new Map<string, Map<string, AtfResultRow>>();
  const collect = (rows: readonly Record<string, unknown>[]): void => {
    for (const row of rows) keepNewest(byPair, toResultRow(row), linkSet);
  };

  for (const linkBatch of chunk(links, RESULT_QUERY_BATCH)) {
    const scope =
      linkBatch.length === 1
        ? `test_suite_result=${linkBatch.join("")}`
        : `test_suite_resultIN${linkBatch.join(",")}`;
    for (const batch of chunk(unique, RESULT_QUERY_BATCH)) {
      const first = batch[0];
      if (first === undefined) continue;
      const tests =
        batch.length === 1 ? `test=${first}` : `testIN${batch.join(",")}`;
      const page = await readTable(client, {
        table,
        query: `${scope}^${tests}^ORDERBYDESCsys_created_on`,
        fields: RESULT_FIELDS,
        limit: batch.length * linkBatch.length * MAX_RESULT_ROWS_PER_TEST,
      });
      collect(page.rows);

      // A batch page can starve a (test, suite result) pair whose peers have
      // a long result history. Only then is a fallback worth a round-trip;
      // without truncation, "no row in the page" already means "no row at
      // all". The pages are newest-first, so a pair that DID appear on one
      // already has its newest row.
      if (!page.truncated) continue;
      for (const testSysId of batch) {
        if (linkBatch.length > 1) {
          // Wave 13: a test present under one suite result may still be
          // starved under a sibling, so every test of the batch is re-read.
          const perTest = await readTable(client, {
            table,
            query: `${scope}^test=${testSysId}^ORDERBYDESCsys_created_on`,
            fields: RESULT_FIELDS,
            limit: linkBatch.length * MAX_RESULT_ROWS_PER_TEST,
          });
          collect(perTest.rows);
          if (!perTest.truncated) continue;
        }
        for (const link of linkBatch) {
          if (byPair.get(testSysId)?.has(link) === true) continue;
          const fallback = await readTable(client, {
            table,
            query: `test_suite_result=${link}^test=${testSysId}^ORDERBYDESCsys_created_on`,
            fields: RESULT_FIELDS,
            limit: 1,
          });
          collect(fallback.rows);
        }
      }
    }
  }

  const joined = new Map<string, AtfResultRow>();
  for (const [testSysId, perLink] of byPair) {
    joined.set(testSysId, worstOf(perLink));
  }
  return joined;
}

/**
 * Resolve the child-suite traversal caps, validated.
 *
 * Delegated decision 2026-09-28 (wave 13): a bad cap throws `TypeError` (a
 * programming error, like the DEV-2 bounds), never falls back to a default:
 * `NaN`, `Infinity` or 0 would silently disable or zero the bound.
 * `createAtfRunner` calls this at construction, so a runner's `run()` still
 * rejects only with `AtfInfrastructureError` (DEV-1).
 */
export function resolveSuiteTreeCaps(
  options: ResultOptions = {},
  where = "",
): { readonly maxDepth: number; readonly maxResults: number } {
  const cap = (
    value: number | undefined,
    fallback: number,
    name: string,
  ): number => {
    if (value === undefined) return fallback;
    if (!(Number.isInteger(value) && value > 0)) {
      throw new TypeError(
        `${where}${name} must be a positive integer, got ${String(value)}`,
      );
    }
    return value;
  };
  return {
    maxDepth: cap(options.maxSuiteDepth, MAX_SUITE_DEPTH, "maxSuiteDepth"),
    maxResults: cap(
      options.maxSuiteResults,
      MAX_SUITE_RESULTS,
      "maxSuiteResults",
    ),
  };
}

/** Instance-authored text in a fault message: scrubbed and short (TM-1). */
function quoted(value: string): string {
  return JSON.stringify(sanitizeMessage(value, 64));
}

/**
 * Discover one execution's `sys_atf_test_suite_result` tree: the root (the
 * triggered suite's row, `links.results.id`) and every nested child suite's
 * row, found level by level through `parent`.
 *
 * Wave 13 (2026-09-28). Before it, a test that ran inside a child suite of the
 * triggered suite read as `missing` — fail-closed, but wrong. The traversal is
 * bounded three ways, and every overflow is a DEV-1 fault
 * (`AtfInfrastructureError`), never a partial tree — a spec is then neither
 * pass nor `missing`-by-accident, the run is unreadable and says so:
 *   - depth: a child row more than `maxSuiteDepth` levels below the root;
 *   - size: more than `maxSuiteResults` rows, root included (each read asks
 *     for one row past the budget, so an overflow is observed, not assumed);
 *   - cycles: a row the traversal already holds, the root included.
 * Delegated decision 2026-09-28 (wave 13): also a fault, for the same reason —
 *   - an incomplete page: the instance counted more rows (`X-Total-Count`)
 *     than it returned — an ACL-trimmed child (OPP-1b) or a short page. A
 *     child this session may not read would otherwise drop its tests to
 *     `missing` at best, and hide a sibling's failure from the worst-of join
 *     at worst;
 *   - a row whose `parent` is not one of the rows the read asked about (a
 *     dropped query condition, or a column the ACL blanked): its place in the
 *     tree cannot be proven, and a guess could adopt another run's rows;
 *   - a row whose sys_id is not sys_id-shaped (it would corrupt the result
 *     query).
 * Wave 15 (2026-09-30): without `X-Total-Count`, a short non-empty page is
 * confirmed as the end by one probe of the next window ({@link readTable}); a
 * probe that returns rows (an ACL-trimmed child with more rows past it) or
 * fails is a fault, never a partial tree.
 * Wave 16 (2026-09-30): an otherwise complete read without `X-Total-Count`
 * is cross-checked with one Stats API count of the same filter
 * ({@link readTable}); a count that disagrees with the rows returned
 * (a window trimmed to zero rows, a trimmed last window) or that cannot be
 * read (no Stats API, 403, unreadable body) is a fault, never a partial tree.
 * Residual (UNVERIFIED LIVE): if the real Stats count honours read ACLs, a
 * child hidden in the LAST window (no visible rows after it) still agrees with
 * the count and stays invisible. Its tests then read `missing` (§6a: blocking)
 * — but a test that ALSO ran in a visible suite is judged on the visible rows
 * alone, so a failure under the hidden child cannot reach the worst-of join.
 * The live adapter forwards `X-Total-Count`, which closes this whenever the
 * instance sends it.
 */
export async function fetchSuiteResultTree(
  client: AtfHttpClient,
  rootSysId: string,
  options: ResultOptions = {},
): Promise<SuiteResultTree> {
  const root = assertSuiteResultId(rootSysId);
  const { maxDepth, maxResults } = resolveSuiteTreeCaps(options);
  const ids: string[] = [root];
  const seen = new Set<string>(ids);
  let frontier: readonly string[] = ids;
  let depth = 0;

  while (frontier.length > 0) {
    const level = depth + 1;
    const next: string[] = [];
    for (const batch of chunk(frontier, RESULT_QUERY_BATCH)) {
      const parents = new Set(batch);
      const remaining = maxResults - ids.length;
      const page = await readTable(client, {
        table: ATF_SUITE_RESULT_TABLE,
        query:
          batch.length === 1
            ? `parent=${batch.join("")}`
            : `parentIN${batch.join(",")}`,
        fields: SUITE_RESULT_FIELDS,
        limit: remaining + 1,
      });
      const counted = Math.max(page.rows.length, page.total ?? 0);
      if (counted > remaining) {
        throw new AtfInfrastructureError(
          `the ${ATF_SUITE_RESULT_TABLE} tree of execution ${root} has more than ${maxResults} rows (maxSuiteResults); refusing to read a partial tree of nested child suites`,
        );
      }
      if (counted > page.rows.length) {
        throw new AtfInfrastructureError(
          `the Table API counted ${counted} child ${ATF_SUITE_RESULT_TABLE} row(s) under execution ${root} at depth ${level} but returned ${page.rows.length}: a child suite result this session may not read (OPP-1b), or a short page; refusing to read a partial tree`,
        );
      }
      if (page.incomplete === "short-page-no-total") {
        throw new AtfInfrastructureError(
          `the Table API read of child ${ATF_SUITE_RESULT_TABLE} rows under execution ${root} at depth ${level} returned ${page.rows.length} of a ${remaining + 1}-row window with no X-Total-Count while a later offset still held rows: a child suite result this session may not read (OPP-1b), and possibly more than ${maxResults} rows (maxSuiteResults); refusing to read a partial tree`,
        );
      }
      if (page.incomplete === "count-mismatch") {
        throw new AtfInfrastructureError(
          `the Stats API counted ${page.count ?? "?"} child ${ATF_SUITE_RESULT_TABLE} row(s) under execution ${root} at depth ${level} but the Table API returned ${page.rows.length} with no X-Total-Count: a child suite result this session may not read (OPP-1b), or rows that changed during the read; refusing to read a partial tree`,
        );
      }
      if (page.incomplete === "count-unavailable") {
        throw new AtfInfrastructureError(
          `the Table API read of child ${ATF_SUITE_RESULT_TABLE} rows under execution ${root} at depth ${level} came back with no X-Total-Count and the Stats API count that would confirm the end of the page is unavailable (${page.countError?.message ?? "unknown error"}); refusing to read a possibly partial tree`,
          { cause: page.countError },
        );
      }
      if (page.incomplete === "probe-failed") {
        throw new AtfInfrastructureError(
          `the Table API read of child ${ATF_SUITE_RESULT_TABLE} rows under execution ${root} at depth ${level} came back short with no X-Total-Count and could not confirm the end of the page: the follow-up request failed (${page.probeError?.message ?? "unknown error"}); refusing to read a possibly partial tree`,
          { cause: page.probeError },
        );
      }
      for (const row of page.rows) {
        const sysId = fieldString(row, "sys_id");
        const parent = fieldString(row, "parent");
        if (!SYS_ID_RE.test(sysId)) {
          throw new AtfInfrastructureError(
            `a child ${ATF_SUITE_RESULT_TABLE} row under execution ${root} has sys_id ${quoted(sysId)}, which is not a sys_id`,
          );
        }
        if (!parents.has(parent)) {
          throw new AtfInfrastructureError(
            `child ${ATF_SUITE_RESULT_TABLE} row ${sysId} came back with parent ${quoted(parent)}, which is not a row this read asked about (a dropped query condition, or a column this session may not read); refusing to guess its place in execution ${root}'s tree`,
          );
        }
        if (seen.has(sysId)) {
          throw new AtfInfrastructureError(
            `${ATF_SUITE_RESULT_TABLE} row ${sysId} appears twice in execution ${root}'s tree (a parent cycle); refusing to read a tree that does not end`,
          );
        }
        if (level > maxDepth) {
          throw new AtfInfrastructureError(
            `the ${ATF_SUITE_RESULT_TABLE} tree of execution ${root} nests deeper than ${maxDepth} level(s) (maxSuiteDepth); refusing to read a partial tree of nested child suites`,
          );
        }
        seen.add(sysId);
        ids.push(sysId);
        next.push(sysId);
      }
    }
    if (next.length === 0) break;
    depth = level;
    frontier = next;
  }

  return { root, ids, depth };
}

/** Read step detail for the given result rows. See the [OPEN] note on the item table. */
export async function fetchResultItems(
  client: AtfHttpClient,
  resultSysIds: readonly string[],
  options: ResultOptions = {},
): Promise<Map<string, AtfResultItemRow[]>> {
  const table = options.resultItemTable ?? ATF_TEST_RESULT_ITEM_TABLE;
  const unique = [...new Set(resultSysIds)].filter((id) => id !== "");
  assertQueryable(unique, "test result sys_id");
  const byResult = new Map<string, AtfResultItemRow[]>();
  if (unique.length === 0) return byResult;

  const collect = (rows: readonly Record<string, unknown>[]): void => {
    for (const row of rows) {
      const item: AtfResultItemRow = {
        sysId: fieldString(row, "sys_id"),
        testResultSysId: fieldString(row, "test_result"),
        status: fieldString(row, "status"),
        output: fieldString(row, "output"),
        order: fieldString(row, "order"),
      };
      if (item.testResultSysId === "") continue;
      const bucket = byResult.get(item.testResultSysId);
      if (bucket) bucket.push(item);
      else byResult.set(item.testResultSysId, [item]);
    }
  };

  for (const batch of chunk(unique, RESULT_QUERY_BATCH)) {
    const first = batch[0];
    if (first === undefined) continue;
    const query =
      batch.length === 1
        ? `test_result=${first}^ORDERBYorder`
        : `test_resultIN${batch.join(",")}^ORDERBYorder`;
    const page = await readTable(client, {
      table,
      query,
      fields: RESULT_ITEM_FIELDS,
      limit: batch.length * MAX_RESULT_ITEMS_PER_RESULT,
    });
    if (!page.truncated) {
      collect(page.rows);
      continue;
    }
    // The batch page is ordered by `order` ACROSS the results it covers, so a
    // truncated one does not starve a single result the way `fetchTestResults`
    // is starved — it can cut every result in the batch short at once. A short
    // bucket is indistinguishable downstream from a result that genuinely had
    // no further steps, and `failureMessage` would then present a partial list
    // as the whole failing set. Discard the partial page and re-read each
    // result on its own rather than reporting an unfinished read as a finished
    // one; the per-result reads are still bounded, which the constant's own
    // doc-comment states rather than hides.
    for (const resultSysId of batch) {
      const fallback = await readTable(client, {
        table,
        query: `test_result=${resultSysId}^ORDERBYorder`,
        fields: RESULT_ITEM_FIELDS,
        limit: MAX_RESULT_ITEMS_PER_RESULT,
      });
      collect(fallback.rows);
    }
  }

  return byResult;
}

function failureMessage(
  row: AtfResultRow,
  items: readonly AtfResultItemRow[],
  max: number,
): string {
  // TM-1: only the result row's own output column, plus failing step outputs.
  // Never a script body, never a serialised row.
  //
  // The parts are scrubbed but NOT capped here: the join below is capped once,
  // and that single cap bounds the whole message. Capping a part and then
  // capping the join again would cut the first cap's own marker in half and
  // report a dropped count for the marker instead of for the evidence.
  const parts: string[] = [];
  const output = scrub(row.output);
  if (output !== "") parts.push(output);
  const notPassing = items.filter(
    (item) => mapResultStatus(item.status) !== "pass",
  );
  const failing = notPassing.slice(0, MAX_STEP_ITEMS);
  for (const item of failing) {
    const detail = scrub(item.output);
    if (detail === "") continue;
    const label = item.order === "" ? item.sysId : `step ${item.order}`;
    parts.push(`${label}: ${detail}`);
  }
  // The same rule `sanitizeMessage` applies to the character cap: a cut that
  // leaves no mark turns "five failing steps" into "five failing steps" when
  // there were fifty. The count is deliberately scoped to THIS READ — it says
  // how many of the rows handed to this function were dropped, and claims
  // nothing about steps the read itself did not cover (see
  // {@link MAX_RESULT_ITEMS_PER_RESULT}).
  const dropped = notPassing.length - failing.length;
  if (dropped > 0) {
    parts.push(`…[${dropped} more failing step(s) read but not shown]`);
  }
  if (parts.length === 0) {
    return `ATF test result ${row.sysId} reports status ${JSON.stringify(row.status)} with no output`;
  }
  return sanitizeMessage(parts.join(NEWLINE), max);
}

/**
 * Turn the reverse index into one {@link SpecResult} per spec. Every spec in
 * the index gets exactly one entry, in index insertion order — a spec whose
 * test produced no row is reported "missing" (QA-9), never dropped.
 */
export async function parseSpecResults(
  client: AtfHttpClient,
  index: TestIndex,
  suiteResultSysIds: string | readonly string[],
  options: ResultOptions = {},
): Promise<SpecResult[]> {
  const links = assertSuiteResultLinks(suiteResultSysIds);
  const [link = ""] = links;
  const scope =
    links.length === 1
      ? `under test_suite_result ${link}`
      : `under test_suite_result ${link} or any of the ${links.length - 1} other suite result(s) read with it (nested child suites)`;
  const max = options.maxAssertionChars ?? MAX_ASSERTION_CHARS;
  const rows = await fetchTestResults(
    client,
    [...index.keys()],
    links,
    options,
  );

  let items = new Map<string, AtfResultItemRow[]>();
  if (options.includeStepDetail === true) {
    const failing = [...rows.values()]
      .filter((row) => mapResultStatus(row.status) === "fail")
      .map((row) => row.sysId);
    if (failing.length > 0) {
      items = await fetchResultItems(client, failing, options);
    }
  }

  const out: SpecResult[] = [];
  for (const [testSysId, spec] of index) {
    const row = rows.get(testSysId);
    if (row === undefined) {
      out.push({
        spec,
        raw: "missing",
        // Two claims used to live on this line and neither was observed here.
        // "No row EXISTS" is a claim about the instance; what happened is that
        // a read came back without one, and OPP-1b says the Table API renders
        // an absent row and an ACL-trimmed row identically. "The suite ran" is
        // a claim about an execution this function never watched — it is
        // handed an index and a client, nothing else, and `parseSpecResults`
        // is exported for callers that never triggered anything. Both are
        // replaced by the fact this code has: the read produced no row for
        // this test. §6a resolves `missing` to a blocking failure either way,
        // so nothing is lost by saying only what was seen.
        cause: `no ${options.resultTable ?? ATF_TEST_RESULT_TABLE} row came back for sys_atf_test ${testSysId} ${scope} (rows linked to another execution, or to none, are refused); the read cannot tell an absent row from one this session may not see (OPP-1b), nor from a result the instance has not written yet`,
      });
      continue;
    }
    const evidence: EvidenceRef = { kind: "atf-result", ref: row.sysId };
    const artifacts: readonly ArtifactRef[] = [
      { kind: "atf-result", ref: row.sysId },
    ];
    const raw = mapResultStatus(row.status);
    if (raw === "pass") {
      out.push({ spec, raw, evidence });
      continue;
    }
    if (raw === "fail") {
      out.push({
        spec,
        raw,
        evidence,
        artifacts,
        assertion: failureMessage(row, items.get(row.sysId) ?? [], max),
      });
      continue;
    }
    out.push({
      spec,
      raw,
      evidence,
      artifacts,
      cause:
        `ATF test result ${row.sysId} carries status ${JSON.stringify(row.status)}` +
        (row.output === "" ? "" : `: ${sanitizeMessage(row.output, max)}`),
    });
  }
  return out;
}
