// The only read this stage is allowed to perform.
//
// One method, GET only, bound to ONE credential profile at construction time.
// That is ARCH-19 made structural rather than documented: resolve/impact read
// the SOURCE, and an adapter that cannot name a second profile cannot drift
// onto the runner by accident. It is also ARCH-8's other half — nothing
// reachable from here can write, so pointing `tess resolve` at a production
// instance is a read and stays a read.
//
// The port exists so the decision logic is testable without a network, and the
// live adapter goes through `@tessera/sn-client` — the ARCH-7 canonical
// transport with its auth, host policy, retry and journal — rather than a
// second HTTP client smuggled in behind it.
//
// ── The DEV-1 error boundary: why `ServiceNowError` is read here ────────────
//
// The 2026-08-26 ruling in `runner-atf/src/client.ts` normalised that package's
// transport faults into one owned type. It does not extend to here, and the
// difference is not tidiness. The runner REJECTS: a `ServiceNowError` escaping
// `Runner.run` reached `@tessera/core` and would have coupled every future
// caller of a `Runner` to a ServiceNow client. This adapter never rejects — it
// converts every fault into a member of the closed `TableRead` union below, so
// no consumer of `RecordReader` can meet a transport type at all. That is the
// outcome the ruling was after, reached one layer lower down. The ruling says
// as much in its own carve-out: `createSnAtfClient` "stays a pass-through: it
// is the far side of the port". An adapter is allowed to know its transport;
// that is what makes it an adapter. `instanceof ServiceNowError` becomes a
// defect here only if it ever moves INWARD, past `RecordReader`.
//
// What that costs, and what pins it: a `ServiceNowError` does NOT mean "the
// instance answered". `@tessera/sn-client` raises the same type, with the same
// 403 status, from `assertTableAllowed` — before a request is sent — when
// `SN_TABLES_ALLOW`/`SN_TABLES_DENY` refuses the table. `tableApi.queryTable`
// is on that path, so this adapter genuinely cannot tell an ACL refusal from
// the operator's own policy config, and must not word the evidence as if it
// could. The outcome is `undecidable` under both readings, which is why this
// was never a wrong verdict — only a wrong reason, aimed at the instance's ACLs
// when the refusal was local. Pinned by "reports a client-side table-policy
// denial without claiming the instance refused" in `test/read.test.js`.
//
// The same type has a second way of not meaning "the instance answered", and
// it is quieter: a `ServiceNowError` with NO `status` never carried an HTTP
// response at all. Every branch keyed on a status has to be unreachable for
// it, or the evidence starts quoting a status the instance never sent. Pinned
// by "never dresses a read that got no answer as a query the instance
// rejected" in `test/read.test.js`; see `NO_STATUS` below.

import { ServiceNowError, runWithProfile, tableApi } from "@tessera/sn-client";

/** A row exactly as the Table API rendered it — every field a string. */
export type SnRecord = Record<string, unknown>;

export interface TableQueryRequest {
  readonly table: string;
  /** Encoded query. Empty string means "every row", and is deliberate. */
  readonly query: string;
  readonly fields: readonly string[];
  /** Omitted with `fetchAll` set; otherwise a single page of this size. */
  readonly limit?: number;
  readonly fetchAll?: boolean;
  /**
   * Wave 17 — `fetchAll` only: when the instance sends no X-Total-Count and
   * the paging otherwise looks complete, confirm the row count with one
   * Stats API request (`tableApi.QueryOptions.crossCheckCount`). A count
   * that disagrees marks the read `count-mismatch`; one that cannot be
   * obtained marks it `count-unavailable`. Both are partial. It only ever
   * ADDS a truncation flag, so it cannot turn a partial read complete.
   */
  readonly crossCheckCount?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * `answered` = the instance returned a result set for this query, even an empty
 * one. `undecidable` = it did not (403, 401, 5xx, transport, timeout, abort, or
 * a field it does not recognise), so the empty `records` below means nothing.
 *
 * This is the OPP-1b lesson applied to a query rather than a property: the
 * Table API renders "no such row" and "trimmed away from you" identically, so
 * a read that did not complete must never collapse into a clean empty answer.
 */
export interface TableRead {
  readonly outcome: "answered" | "undecidable";
  readonly records: readonly SnRecord[];
  /**
   * True when a `fetchAll` read is known or suspected to be partial — the set
   * is partial, and any caller that implies completeness has to say so (QA-9).
   * `truncationReason` says which partial case it is; the cap is only one of
   * them.
   */
  readonly truncated: boolean;
  /**
   * Set exactly when `truncated` is, carried through from the transport:
   * `cap` (stopped at SN_MAX_RECORDS, X-Total-Count reports more), `short-page`
   * (a short page while X-Total-Count reports more — read ACLs, or an
   * inconsistent count; raising the cap will not help), `no-total` (stopped
   * at the cap with no X-Total-Count, so more rows MAY exist),
   * `short-page-no-total` / `probe-failed` (no X-Total-Count, a short page
   * that was, or could not be proven not to be, ACL trimming), and — only for
   * a `crossCheckCount` read — `count-mismatch` / `count-unavailable` (the
   * Stats API count disagreed / could not be obtained).
   *
   * Delegated decision 2026-09-26: optional rather than required, because a
   * truncated read without a reason (a stub, an older adapter) must still be
   * reportable — `describeTruncation` words that case as partial without
   * guessing a cause. Required would push every test double to invent one.
   */
  readonly truncationReason?: tableApi.TruncationReason;
  /**
   * The instance's X-Total-Count for this query, when it sent one. Carried
   * only so a truncated read can say "N of M" (`describeTruncation`).
   */
  readonly total?: number;
  /**
   * Wave 17 — the Stats API count, when a `crossCheckCount` read obtained one
   * (whether or not it matched). Carried only so a `count-mismatch` read can
   * say "counts N but only M were returned" (`describeTruncation`).
   */
  readonly count?: number;
  /** Never empty; it is the evidence line a note quotes. */
  readonly detail: string;
}

export interface RecordReader {
  /** The profile every read runs under — reported, never chosen per call. */
  readonly profile: string;
  queryRecords(request: TableQueryRequest): Promise<TableRead>;
}

/**
 * Every `TableRead.truncationReason` whose `describeTruncation` wording this
 * package has reviewed as honest for its callers.
 *
 * Delegated decision 2026-10-01 (wave 17): the rendering is exhaustive in
 * both directions. At compile time `Record<TruncationReason, true>` fails the
 * build the day `@tessera/sn-client` adds a reason nobody here has looked
 * at. At run time a reason NOT listed here (a stub, an adapter from another
 * version, a key like `toString` inherited from `Object.prototype`) is
 * handed on as "no reason", which `describeTruncation` words as partial
 * without a guessed cause — fail closed, never a borrowed wording and never
 * "complete". The partial VERDICT never depended on this: it is `truncated`.
 */
const REVIEWED_TRUNCATION_REASONS: Readonly<
  Record<tableApi.TruncationReason, true>
> = {
  cap: true,
  "short-page": true,
  "no-total": true,
  "short-page-no-total": true,
  "probe-failed": true,
  "count-mismatch": true,
  "count-unavailable": true,
};

function reviewedReason(
  reason: unknown,
): tableApi.TruncationReason | undefined {
  return typeof reason === "string" &&
    Object.hasOwn(REVIEWED_TRUNCATION_REASONS, reason)
    ? (reason as tableApi.TruncationReason)
    : undefined;
}

/**
 * One clause naming why a truncated read is partial — `describeTruncation`
 * from `@tessera/sn-client`, applied to a `TableRead`, so every consumer of
 * the port words every case (and the reason-less one) identically.
 * Starts lowercase and follows what was read: `` `${table} ${clause}` ``.
 */
export function describeReadTruncation(
  read: Pick<TableRead, "records" | "total" | "truncationReason" | "count">,
): string {
  // `describeTruncation` only reads `records.length`; the cast drops
  // `readonly` for its mutable parameter type and nothing more.
  return tableApi.describeTruncation({
    records: read.records as SnRecord[],
    total: read.total,
    truncationReason: reviewedReason(read.truncationReason),
    count: read.count,
  });
}

export const ABORTED_BEFORE_READ =
  "aborted before the read reached the instance";

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A *namespace* 404 ("the URI is not a resource") says the table is not exposed
 * on this instance; that is not an answer about the rows, so it is undecidable
 * rather than "no matches". Same reasoning — and the same regex — as the parity
 * reader and the doctor's probe.
 */
const NAMESPACE_404 = /does not represent any resource|invalid uri/i;

/**
 * What that regex is matched against: the message AND the body, composed
 * exactly the way the canonical transport does it. `api/plugin.ts` in
 * `@tessera/sn-client` builds message + `JSON.stringify(detail ?? "")` and
 * tests that; this is the same string, and the two must not drift into
 * answering one question differently.
 *
 * Why the message alone is not enough: `extractErrorDetail` (`core/http.ts`)
 * PREFERS `error.message` and only falls back to `error.detail`, so a 404
 * body that carries the namespace wording in `detail` alone arrives here with
 * a message that says nothing about a namespace. The transport caught those
 * bodies; this file did not.

 * Here the verdict was `undecidable` either way, but the evidence named the
 * wrong reason — and the evidence line is the entire product of an
 * undecidable read.
 *
 * `detail` is the whole parsed error body — `core/http.ts` passes the parsed
 * `json` — so it is always `JSON.parse` output or `undefined`.
 * `JSON.stringify` can therefore meet neither a cycle nor a BigInt here, and
 * this adapter keeps its promise never to throw.
 *
 * It is not free, and the cost runs the other way: the haystack is now the
 * WHOLE body, so a 404 whose body says "invalid URI" for some unrelated
 * reason (a proxy's own error page, a scripted REST resource validating its
 * own path parameters) is read as a namespace 404. That trade is deliberate
 * — the old failure was a false green, the new one is fail-closed — but it is
 * a trade, not a freebie.
 */
function namespaceHaystack(error: ServiceNowError): string {
  return `${error.message} ${JSON.stringify(error.detail ?? "")}`;
}

/**
 * A `ServiceNowError` carrying no `status` never carried an HTTP response
 * either: the transport failed or timed out, or the request never left this
 * client at all (unconfigured instance, missing credentials, host policy).
 * Which of those it was is not knowable from here, so the evidence states the
 * one thing that is — nothing came back — and names both readings rather than
 * picking the one it cannot prove, exactly as the 403 line above does.
 *
 * What it must never do is render the absent status as a value. `rejected
 * (undefined)` is a status that does not exist, presented in the grammar of one
 * the instance sent; an operator reading it cannot tell a real refusal from a
 * read that never arrived. Word-for-word the same line in the doctor's probe
 * and the parity reader — three spellings of one question, and they agree.
 */
const NO_STATUS =
  "no answer was received and there is no HTTP status to report — the " +
  "request either never left this client, or left it and never got a response";

/** The live adapter: every read goes through the canonical transport (ARCH-7). */
export function createSnRecordReader(profile: string): RecordReader {
  return {
    profile,
    async queryRecords(request) {
      const where = `${request.table} on ${profile}`;
      if (request.signal?.aborted === true) {
        return {
          outcome: "undecidable",
          records: [],
          truncated: false,
          detail: `${where}: ${ABORTED_BEFORE_READ}`,
        };
      }
      try {
        const result = await runWithProfile(profile, () =>
          tableApi.queryTable({
            table: request.table,
            query: request.query === "" ? undefined : request.query,
            fields: [...request.fields],
            limit: request.limit,
            fetchAll: request.fetchAll,
            ...(request.crossCheckCount === true
              ? { crossCheckCount: true }
              : {}),
            displayValue: "false",
          }),
        );
        const truncated = result.truncated === true;
        // Delegated decision 2026-09-26: the reason (and the count it is
        // measured against) is passed through untouched and only when the
        // read IS truncated, so `truncationReason` is set exactly when
        // `truncated` is — the transport's own invariant. The partial verdict
        // itself is unchanged. `detail` deliberately stays the plain row
        // count: callers word the truncation with `describeReadTruncation`,
        // and some of them also quote `detail`, which would say it twice.
        return {
          outcome: "answered",
          records: result.records,
          truncated,
          ...(truncated && result.truncationReason !== undefined
            ? { truncationReason: result.truncationReason }
            : {}),
          ...(result.total !== undefined ? { total: result.total } : {}),
          // Wave 17: the Stats count is a fact the instance stated, carried
          // whenever it was obtained — `count-mismatch` quotes it.
          ...(result.count !== undefined ? { count: result.count } : {}),
          detail:
            `${where}: ${result.records.length} row(s)` +
            (request.query === "" ? "" : ` for \`${request.query}\``),
        };
      } catch (error) {
        return undecidable(where, request, error);
      }
    },
  };
}

function undecidable(
  where: string,
  request: TableQueryRequest,
  error: unknown,
): TableRead {
  const base = {
    outcome: "undecidable",
    records: [],
    truncated: false,
  } as const;
  if (error instanceof ServiceNowError) {
    // Destructured once and the status-less case returned immediately, so
    // TypeScript types `status` as `number` in every branch below and no
    // template here CAN interpolate an absent status. The previous spelling
    // put `&& error.status !== undefined` on the outer test, which left
    // `rejected (${error.status})` one deleted conjunct away from printing
    // `rejected (undefined)` — and folded the status-less case into the same
    // fall-through as a throwable of unknown provenance, which it is not.
    const { status } = error;
    if (status === undefined) {
      return { ...base, detail: `${where}: ${NO_STATUS} (${error.message})` };
    }
    if (status === 404 && NAMESPACE_404.test(namespaceHaystack(error))) {
      // Both readings again, for the same reason the 403 below gives them: a
      // table outside this caller's scope, or one whose plugin is inactive for
      // them, answers exactly like a table that was never installed. The
      // doctor's `classifyTable` and `@tessera/parity`'s reader word the same
      // status the same way.
      return {
        ...base,
        detail:
          `${where}: the table is not a resource on this instance for the ` +
          `connected user — either the table is not there at all, or this ` +
          `caller's scope and roles cannot resolve it, and either way ` +
          `nothing was said about its rows`,
      };
    }
    if (status === 403) {
      // Both readings, because this adapter cannot separate them: the
      // instance's ACLs refused the connected user, or SN_TABLES_ALLOW/
      // SN_TABLES_DENY refused the table locally and nothing was ever sent.
      // Naming only the first sends the operator to the wrong instance. The
      // leading clause is deliberately unchanged — `cli/test/resolve.test.js`
      // matches it, and it is true under both readings anyway.
      return {
        ...base,
        detail: `${where}: read refused (403) for the connected user — by the instance's ACLs, or by this client's own SN_TABLES_ALLOW/SN_TABLES_DENY before a request was sent`,
      };
    }
    // A 400 is almost always an unknown field in `sysparm_query` — the
    // instance rejected the QUESTION, which is not an answer about the rows
    // but IS a fact about the query, and quoting the query back is what tells
    // the operator which field to fix.
    if (status === 400) {
      return {
        ...base,
        detail: `${where}: query \`${request.query}\` rejected (${status}) — ${error.message}`,
      };
    }
    // Everything else reaching here — 401, 429, 5xx — never got as far as
    // evaluating the query. Saying "your query was rejected" would send the
    // operator hunting a field name that was never the problem, so the line
    // states the status and stops where the evidence does.
    return {
      ...base,
      detail: `${where}: the read failed with status ${status} and nothing was said about the rows — ${error.message}`,
    };
  }
  return { ...base, detail: `${where}: ${describe(error)}` };
}
