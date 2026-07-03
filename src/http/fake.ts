/**
 * In-memory {@link SnClient} for tests. Every downstream check test uses this
 * instead of hitting a real instance — seed table rows and CI/CD responses,
 * then assert on what the check does. No network, no secrets, deterministic.
 *
 * @example
 * ```js
 * import { createFakeSnClient } from "../../build/http/fake.js";
 *
 * const http = createFakeSnClient({
 *   tables: {
 *     sys_update_set: [{ sys_id: "abc", name: "My set", state: "complete" }],
 *   },
 *   cicd: { runTestSuite: { status: "success", resultId: "run-1" } },
 * });
 *
 * const ctx = { instanceUrl: "https://x.service-now.com", http };
 * const result = await updateSetState.run(ctx);
 * ```
 *
 * Forcing errors — seed a `fail` for a specific table/cicd op or globally:
 * ```js
 * const http = createFakeSnClient({
 *   tables: { sys_update_set: [] },
 *   fail: { auth: true }, // every call throws SnAuthError
 * });
 * // or per-op: fail: { table: { sys_update_set: { network: true } } }
 * ```
 */

import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  type CicdTestSuiteResult,
  type SnClient,
  type SnRawResponse,
  type SnTable,
} from "./client.js";

/** A forced failure — exactly one kind should be set. */
export interface ForcedFailure {
  /** Throw {@link SnAuthError}. */
  auth?: boolean;
  /** Throw {@link SnNetworkError}. */
  network?: boolean;
  /** Throw {@link SnHttpError} with this status (defaults to 500). */
  http?: number | boolean;
  /** Message override for the thrown error. */
  message?: string;
}

/** Fixtures accepted by {@link createFakeSnClient}. */
export interface FakeFixtures {
  /**
   * Seed rows per table name. Each row SHOULD carry a `sys_id`; `table().get`
   * matches on it, `table().query` returns rows (optionally filtered — see
   * `queryFilter`).
   */
  tables?: Record<string, Record<string, unknown>[]>;
  /** Canned CI/CD responses. */
  cicd?: {
    /** Returned by `cicd.runTestSuite` (for any suite id, unless a map). */
    runTestSuite?: CicdTestSuiteResult | Record<string, CicdTestSuiteResult>;
  };
  /**
   * Canned raw responses for `request(method, path)`, keyed by `"METHOD path"`
   * (e.g. `"GET /api/now/table/x"`). Used when a check calls `request` directly.
   */
  requests?: Record<string, SnRawResponse>;
  /**
   * Optional per-table query filter. Given the `sysparm_*` params, return the
   * rows to yield. Defaults to returning all seeded rows for the table.
   */
  queryFilter?: (
    table: string,
    rows: Record<string, unknown>[],
    params?: Record<string, string>,
  ) => Record<string, unknown>[];
  /** Force failures — globally or scoped to a table / cicd op. */
  fail?: ForcedFailure & {
    table?: Record<string, ForcedFailure>;
    cicd?: ForcedFailure;
  };
}

/**
 * Distinguish a single canned result (a `CicdTestSuiteResult`, identified by a
 * string `status`) from a map of results keyed by suite id.
 */
function isSingleTestSuiteResult(
  value: CicdTestSuiteResult | Record<string, CicdTestSuiteResult>,
): value is CicdTestSuiteResult {
  return typeof (value as { status?: unknown }).status === "string";
}

/** Throw the error described by `f`, or return without throwing if `f` is falsy. */
function maybeThrow(f: ForcedFailure | undefined, where: string): void {
  if (!f) return;
  const msg = f.message ?? `Forced failure (${where})`;
  if (f.auth) throw new SnAuthError(msg, 401);
  if (f.network) throw new SnNetworkError(msg);
  if (f.http !== undefined && f.http !== false) {
    const status = typeof f.http === "number" ? f.http : 500;
    throw new SnHttpError(status, msg);
  }
}

/**
 * Build an in-memory {@link SnClient} from `fixtures`. See the file header for a
 * usage example. The returned client performs no I/O.
 */
export function createFakeSnClient(fixtures: FakeFixtures = {}): SnClient {
  const tables = fixtures.tables ?? {};
  const globalFail = fixtures.fail;

  function tableRows(name: string): Record<string, unknown>[] {
    return tables[name] ?? [];
  }

  function tableFail(name: string): ForcedFailure | undefined {
    return globalFail?.table?.[name] ?? globalFail;
  }

  return {
    table(name: string): SnTable {
      return {
        get(sysId) {
          maybeThrow(tableFail(name), `table ${name}`);
          const row = tableRows(name).find((r) => r.sys_id === sysId) ?? null;
          return Promise.resolve(row);
        },
        query(params) {
          maybeThrow(tableFail(name), `table ${name}`);
          const rows = tableRows(name);
          const filtered = fixtures.queryFilter
            ? fixtures.queryFilter(name, rows, params)
            : rows;
          return Promise.resolve(filtered);
        },
      };
    },
    cicd: {
      runTestSuite(suiteSysId): Promise<CicdTestSuiteResult> {
        maybeThrow(globalFail?.cicd ?? globalFail, "cicd.runTestSuite");
        const canned = fixtures.cicd?.runTestSuite;
        if (!canned) {
          return Promise.resolve({ status: "success" });
        }
        // A single response for any id, or a map keyed by suite id.
        if (isSingleTestSuiteResult(canned)) {
          return Promise.resolve(canned);
        }
        return Promise.resolve(canned[suiteSysId] ?? { status: "not_found" });
      },
    },
    request(method: string, path: string): Promise<SnRawResponse> {
      maybeThrow(globalFail, `request ${method} ${path}`);
      const key = `${method} ${path}`;
      const canned = fixtures.requests?.[key];
      return Promise.resolve(canned ?? { status: 404, body: null });
    },
  };
}
