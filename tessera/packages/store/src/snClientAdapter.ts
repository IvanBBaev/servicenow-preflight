// Wave 16 — new code written for this package (not vendored).
//
// The production SNClient adapter: the vendored manifest builder talks to the
// structural `SNClient` interface (support.ts), and nothing connected it to
// `@tessera/sn-client`, so the X-Total-Count page-to-page cross-check and
// `ManifestBuilderOptions.requireTotalCount` were dormant outside tests.
//
// Delegated decision 2026-09-30 (wave 16): the adapter takes sn-client's
// single-page `queryTable` as an INJECTED function (`SnClientQueryTable`)
// instead of importing `@tessera/sn-client`. There is no dependency cycle, but
// the dependency would still be wrong: the store keeps zero runtime
// dependencies by design (VENDORED.md), and the workspace `build:all` order
// compiles store before sn-client, so an import would break a clean build. The
// composition — `createSnClientAdapter({ queryTable: tableApi.queryTable })` —
// belongs in the consumer that wires the store to an instance (DEV-3 / QA-10);
// no such consumer exists yet. This package's contract test performs exactly
// that composition against the fake instance.

import {
  createManifestBuilder,
  type ManifestBuilderHandle,
  type ManifestBuilderOptions,
} from "./manifestBuilder.js";
import type { SNClient } from "./support.js";

/** The subset of sn-client's `QueryOptions` the adapter sends. */
export interface SnClientQueryOptions {
  table: string;
  query?: string;
  fields?: string[];
  limit?: number;
  offset?: number;
}

/**
 * sn-client's `tableApi.queryTable`, structurally. Called WITHOUT `fetchAll`,
 * it reads exactly one page and reports `total` from X-Total-Count when the
 * instance sent one.
 */
export type SnClientQueryTable = (opts: SnClientQueryOptions) => Promise<{
  records: readonly Record<string, unknown>[];
  total?: number;
}>;

export interface SnClientAdapterOptions {
  queryTable: SnClientQueryTable;
}

/**
 * The instance answered the request with an HTTP error status. Carries the
 * `isAxiosError` / `response.status` shape `getErrorResponseStatus` reads, so a
 * 403/404 from the instance keeps its "table not accessible" meaning.
 */
export class SnClientHttpError extends Error {
  readonly isAxiosError = true;
  readonly response: { readonly status: number };
  constructor(status: number, cause: Error) {
    super(cause.message, { cause });
    this.name = "SnClientHttpError";
    this.response = { status };
  }
}

/**
 * The read failed without an answer from the instance: sn-client's own table
 * policy refused it (`SN_TABLES_ALLOW` / `SN_TABLES_DENY`), a redirect was
 * refused, the transport failed or timed out, or anything else went wrong.
 * Deliberately carries NO status, so neither `isTableSkippableError` nor
 * `isScopedEndpointUnavailableError` can read it as a refused table.
 */
export class SnClientReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SnClientReadError";
  }
}

/**
 * The fixed tables the store reads, for an `SN_TABLES_ALLOW` allowlist. It is
 * not the whole list: a manifest build also reads every table discovered in
 * the scope, and a bulk download every table it is asked for — those must be
 * allowed too, or the read fails (SnClientReadError, never an empty table).
 */
export const STORE_FIXED_TABLES: readonly string[] = Object.freeze([
  "sys_app",
  "sys_metadata",
  "sys_db_object",
  "sys_dictionary",
]);

// Delegated decision 2026-09-30 (wave 16): only an error that is structurally
// sn-client's ServiceNowError AND carries both a numeric `status` and a
// `detail` is the instance's own HTTP answer — sn-client sets `detail` (at
// least `{}`) on every instance error response and never on the 403 its table
// policy fabricates locally (DEV-1: a client-fabricated 403 must never be
// reported as the instance's refusal). Everything else is wrapped as a
// status-less SnClientReadError: fail closed, a local refusal or a transport
// failure is not evidence that the table is inaccessible.
function toStoreError(e: unknown): Error {
  if (e instanceof Error && e.name === "ServiceNowError") {
    const { status, detail } = e as Error & {
      status?: unknown;
      detail?: unknown;
    };
    if (typeof status === "number" && detail !== undefined) {
      return new SnClientHttpError(status, e);
    }
  }
  return new SnClientReadError(e);
}

/** An `SNClient` over sn-client's single-page `queryTable`. */
export function createSnClientAdapter(
  options: SnClientAdapterOptions,
): SNClient {
  const { queryTable } = options;
  return {
    async tableAPIGet(table, query, fields, limit, offset) {
      // Delegated decision 2026-09-30 (wave 16): the store always names its
      // page size; a read without one is refused rather than inheriting
      // sn-client's default of 10, which the store's paging would not expect.
      if (limit === undefined) {
        throw new Error(
          `Refusing an unbounded Table API read of ${table}: the SNClient adapter requires an explicit limit.`,
        );
      }
      let page: Awaited<ReturnType<SnClientQueryTable>>;
      try {
        page = await queryTable({
          table,
          query,
          fields: fields
            .split(",")
            .map((f) => f.trim())
            .filter((f) => f.length > 0),
          limit,
          offset: offset ?? 0,
        });
      } catch (e) {
        throw toStoreError(e);
      }
      const result = { data: { result: page.records } };
      return typeof page.total === "number" && Number.isFinite(page.total)
        ? { ...result, total: page.total }
        : result;
    },
  };
}

/**
 * `createManifestBuilder` for an sn-client-backed SNClient. Defaults
 * `requireTotalCount` to TRUE: sn-client surfaces X-Total-Count and never sends
 * `sysparm_no_count`, so a page without a total is an anomaly, and a paged read
 * no total vouches for is refused (TableAPIPagingError). An explicit
 * `requireTotalCount: false` is kept. Callers wiring `createManifestBuilder`
 * directly to the adapter must set `requireTotalCount: true` themselves.
 */
export function createSnClientManifestBuilder(
  options: ManifestBuilderOptions,
): ManifestBuilderHandle {
  return createManifestBuilder({
    ...options,
    requireTotalCount: options.requireTotalCount ?? true,
  });
}
