// PLAN Phase 4 write side — the transport seam of the ATF TestStore adapter.
//
// Same shape and same reasoning as `@tessera/runner-atf`'s `client.ts`:
// `@tessera/sn-client` exposes no client *object*, only the free function
// `snRequest` (ambient credentials, the DEV-24 write gate, the DEV-15 write
// journal). A free function is not injectable, so this module declares the
// narrow port the store needs and ships the live adapter over `snRequest` next
// to it. Tests bind the port to `@tessera/fake-instance`; production binds it
// to the real transport. The store never imports `snRequest` directly.
//
// The port is Table-API-only BY CONSTRUCTION (C5, ADR-007; delegated decision
// 2026-09-23). W2 authors step inputs through the ordinary Table API under a
// shipped ACL; the rejected alternative was an ACL-free Scripted REST
// endpoint that writes `sys_variable_value` on the caller's behalf. The store
// therefore refuses to issue any request outside `/api/now/table/` — see
// `assertTableApiPath` — so an ACL-free channel cannot be reintroduced by
// binding a different path, only by editing this file.

import { aggregateApi, snRequest } from "@tessera/sn-client";

/** One ServiceNow REST call, reduced to what the store issues. */
export interface TestStoreRequest {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Absolute API path under the instance origin, `/api/now/table/<t>[/<id>]`. */
  readonly path: string;
  readonly params?: URLSearchParams;
  /** JSON body for POST/PATCH. */
  readonly body?: Record<string, string>;
}

/** The parsed response envelope. `data` is the RAW body — `{ result: … }`. */
export interface TestStoreResponse<T> {
  readonly data: T;
  readonly status: number;
  readonly total?: number;
}

/** The transport port. Structurally satisfied by `snRequest`. */
export interface TestStoreHttpClient {
  request<T>(args: TestStoreRequest): Promise<TestStoreResponse<T>>;
}

/** Options for {@link TestStoreInfrastructureError}: `cause` plus a status. */
export interface TestStoreFaultOptions extends ErrorOptions {
  readonly status?: number;
}

/**
 * DEV-1 — the adapter-fault marker. Every transport failure out of this
 * package is one of these, with the HTTP status lifted onto `status` so a
 * caller can answer "was this the W2 ACL's 403?" without importing a
 * ServiceNow client. The original error stays reachable as `cause`.
 */
export class TestStoreInfrastructureError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options: TestStoreFaultOptions = {}) {
    super(message, options);
    this.name = "TestStoreInfrastructureError";
    this.status = options.status;
  }
}

/** Why the store refused — stable, greppable codes (not transport faults). */
export type TestStoreRefusalCode =
  /** C5: a channel other than the ACL-guarded Table API was requested. */
  | "acl-free-endpoint"
  /** §4a: only the ephemeral lifecycle is implemented (DEV-12). */
  | "lifecycle"
  /** A spec carries no `{ script }` payload, or two specs share a key. */
  | "payload"
  /** The local projection lock is held by another projection. */
  | "lock-held"
  /** C3: the W2 channel's version property is absent — not installed. */
  | "channel-absent"
  /** C4: the installed channel's MAJOR differs, or its version is unreadable. */
  | "channel-incompatible"
  /** The run's namespace already holds records — projecting would duplicate. */
  | "namespace-occupied"
  /** DEV-17: a suite result is not provably terminal; nothing was deleted. */
  | "non-terminal-run"
  /**
   * F2 (2026-09-26): a namespaced row lacks the run's ownership marker, or a
   * link to a run-owned test hangs off a suite the run does not own; nothing
   * was deleted.
   */
  | "not-run-owned"
  /**
   * The run id carries an encoded-query metacharacter (`^`, `=`, `@`, CR/LF)
   * or is empty — it cannot be spliced into a `sysparm_query` safely.
   */
  | "unsafe-run-id"
  /**
   * Wave 14: the legacy-row cleanup path (`discoverLegacyAtfRows` /
   * `deleteLegacyAtfRows`) declined; `LegacyCleanupRefusalError.reason`
   * says why. Nothing was deleted.
   */
  | "legacy-cleanup-refused";

/**
 * A deliberate refusal: nothing is broken, the store declined to act. Distinct
 * from {@link TestStoreInfrastructureError} so a caller can tell "fix the
 * instance / the setup" from "the network failed".
 */
export class TestStoreRefusalError extends Error {
  readonly code: TestStoreRefusalCode;

  constructor(code: TestStoreRefusalCode, message: string) {
    super(message);
    this.name = "TestStoreRefusalError";
    this.code = code;
  }
}

const TABLE_API_PREFIX = "/api/now/table/";

/** C5 guard: the store speaks the Table API and nothing else. */
export function assertTableApiPath(path: string): void {
  if (!path.startsWith(TABLE_API_PREFIX) || path.includes("?")) {
    throw new TestStoreRefusalError(
      "acl-free-endpoint",
      `refusing ${path}: the ATF TestStore writes only through the ACL-guarded Table API (${TABLE_API_PREFIX}); an ACL-free authoring endpoint is rejected by design (C5, ADR-007)`,
    );
  }
}

export const STATS_API_PREFIX = "/api/now/stats/";

// A table name as the Stats path carries it: one segment, no query string.
const STATS_TABLE_SEGMENT = /^[A-Za-z0-9_]+$/;

/**
 * C5 guard for one port request: the Table API for everything, plus exactly
 * one read-only exception — `GET /api/now/stats/<table>`, the Stats count the
 * no-`X-Total-Count` cross-check needs.
 *
 * Delegated decision 2026-09-30 (wave 16): C5/ADR-007 rejects an ACL-free
 * AUTHORING channel (a write path that bypasses the Table API ACLs). A GET
 * count on the Aggregate API writes nothing and returns no row data, so it
 * is admitted — but only as a GET on a single table segment; any other
 * method, a nested path or an inline query string on the Stats API is still
 * refused as `acl-free-endpoint`.
 */
export function assertPortRequest(
  args: Pick<TestStoreRequest, "method" | "path">,
): void {
  if (
    args.method === "GET" &&
    args.path.startsWith(STATS_API_PREFIX) &&
    STATS_TABLE_SEGMENT.test(args.path.slice(STATS_API_PREFIX.length))
  ) {
    return;
  }
  assertTableApiPath(args.path);
}

function describeCause(error: unknown): string {
  if (error instanceof Error) {
    return error.message === ""
      ? error.name
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

function statusOf(error: unknown): number | undefined {
  const status = asRecord(error)?.["status"];
  return typeof status === "number" && Number.isFinite(status)
    ? status
    : undefined;
}

/** Normalise a transport failure; idempotent for this package's own types. */
export function toInfrastructureError(context: string, error: unknown): Error {
  if (
    error instanceof TestStoreInfrastructureError ||
    error instanceof TestStoreRefusalError
  ) {
    return error;
  }
  const status = statusOf(error);
  const where = status === undefined ? context : `${context} (HTTP ${status})`;
  return new TestStoreInfrastructureError(
    `${where} failed: ${describeCause(error)}`,
    { cause: error, ...(status === undefined ? {} : { status }) },
  );
}

/** The one place the store talks to the port. `return await` is load-bearing. */
export async function requestOrFault<T>(
  client: TestStoreHttpClient,
  args: TestStoreRequest,
  context: string,
): Promise<TestStoreResponse<T>> {
  assertPortRequest(args);
  try {
    return await client.request<T>(args);
  } catch (error) {
    throw toInfrastructureError(context, error);
  }
}

/** Outcome of a Stats-API cross-check of a read that had no `X-Total-Count`. */
export type StatsCrossCheck =
  | { readonly kind: "complete"; readonly count: number }
  | { readonly kind: "count-mismatch"; readonly count: number }
  | {
      readonly kind: "count-unavailable";
      readonly error: TestStoreInfrastructureError;
    };

/**
 * Wave 16: confirm the end of a paged read that had no `X-Total-Count` with
 * ONE Aggregate (Stats) API count of the same filter (`query`, which carries
 * no ORDERBY — callers append theirs only to the Table API page request),
 * through the same port and C5 guard as every other request. The count is
 * parsed by sn-client's fail-closed `aggregateApi.parseStatsCount`.
 *
 * Delegated decision 2026-09-30 (wave 16): the check is ALWAYS on when the
 * transport reports no total — there is no opt-out — and a count that
 * cannot be obtained (transport fault, 404 because the instance exposes no
 * Stats API, unreadable body) is `count-unavailable`, which every caller
 * treats as an incomplete read. A count BELOW the rows read is a mismatch
 * too: the two answers disagree, so neither is trusted.
 *
 * Residual (UNVERIFIED LIVE): if the real Stats API count honours the
 * session's read ACLs, rows hidden by an ACL are excluded from both the
 * count and the pages, and the cross-check cannot see them.
 */
export async function crossCheckRowCount(
  client: TestStoreHttpClient,
  table: string,
  query: string,
  rowsRead: number,
): Promise<StatsCrossCheck> {
  const params = new URLSearchParams({ sysparm_count: "true" });
  if (query !== "") params.set("sysparm_query", query);
  const context = `GET stats ${table} (${query})`;
  let data: unknown;
  let status: number;
  try {
    const response = await requestOrFault<unknown>(
      client,
      {
        method: "GET",
        path: `${STATS_API_PREFIX}${encodeURIComponent(table)}`,
        params,
      },
      context,
    );
    data = response.data;
    status = response.status;
  } catch (error) {
    // A C5 refusal is a programming error, not an unavailable count.
    if (error instanceof TestStoreRefusalError) throw error;
    return {
      kind: "count-unavailable",
      error:
        error instanceof TestStoreInfrastructureError
          ? error
          : new TestStoreInfrastructureError(
              `${context} failed: ${describeCause(error)}`,
              { cause: error },
            ),
    };
  }
  const count = aggregateApi.parseStatsCount(data);
  if (count === undefined) {
    return {
      kind: "count-unavailable",
      error: new TestStoreInfrastructureError(
        `${context} answered HTTP ${status} but result.stats.count is missing or not a non-negative integer`,
        { status },
      ),
    };
  }
  return count === rowsRead
    ? { kind: "complete", count }
    : { kind: "count-mismatch", count };
}

/** The live adapter over `@tessera/sn-client`'s canonical transport. */
export function createSnTestStoreClient(): TestStoreHttpClient {
  return {
    async request<T>(args: TestStoreRequest): Promise<TestStoreResponse<T>> {
      const response = await snRequest<T>({
        method: args.method,
        path: args.path,
        ...(args.params ? { params: args.params } : {}),
        ...(args.body ? { body: args.body } : {}),
      });
      return {
        data: response.data,
        status: response.status,
        ...(response.total === undefined ? {} : { total: response.total }),
      };
    },
  };
}

/** Narrow an unknown JSON value to a plain object without an `any` cast. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Read one Table-API field as a string; a reference may arrive as
 * `{ value, display_value }` and is unwrapped, anything else degrades to "".
 */
export function fieldString(
  row: Record<string, unknown>,
  name: string,
): string {
  const value = row[name];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const inner = asRecord(value)?.["value"];
  return typeof inner === "string" ? inner : "";
}
