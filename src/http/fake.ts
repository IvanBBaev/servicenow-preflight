/**
 * In-memory {@link SnClient} for tests. Every downstream check test uses this
 * instead of hitting a real instance — seed table rows and CI/CD responses,
 * then assert on what the check does. No network, no secrets, deterministic.
 *
 * The fake deliberately mirrors the **shapes** a real ServiceNow Table API
 * returns, so a check that only works against a simplified fixture is caught
 * here rather than in production:
 *
 * - **Reference fields** come back as `{ link, value }` objects, never plain
 *   strings (an empty/unset reference is `""`). Declare which columns are
 *   references per table in {@link REFERENCE_FIELDS}.
 * - **Empty columns** come back as `""`, never a missing key.
 * - **Dot-walked fields** (`ref.field`) appear ONLY when explicitly requested
 *   via `sysparm_fields`, and only when the fixture seeded that exact key.
 * - **Unknown `sysparm_fields` names are dropped** (ServiceNow silently
 *   ignores column names it does not recognise).
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
  SnResponseError,
  type CicdTestSuiteResult,
  type SnClient,
  type SnRawResponse,
  type SnTable,
  type TableQueryResult,
} from "./client.js";

/** A forced failure — exactly one kind should be set. */
export interface ForcedFailure {
  /** Throw {@link SnAuthError}. */
  auth?: boolean;
  /** Throw {@link SnNetworkError}. */
  network?: boolean;
  /** Throw {@link SnHttpError} with this status (defaults to 500). */
  http?: number | boolean;
  /**
   * Throw {@link SnResponseError} — the "2xx with a non-JSON body" case a
   * hibernating PDI or an SSO/proxy interstitial produces (status is reported
   * as 200). Lets a check test assert it fails closed rather than reads zero
   * rows from an instance it never truly reached.
   */
  response?: boolean;
  /** Message override for the thrown error. */
  message?: string;
}

/** Fixtures accepted by {@link createFakeSnClient}. */
export interface FakeFixtures {
  /**
   * Seed rows per table name. Each row SHOULD carry a `sys_id`; `table().get`
   * matches on it, `table().query` returns rows (optionally filtered — see
   * `queryFilter`). Values are seeded in their "plain" form; the fake applies
   * the Table API shape (reference wrapping, `""` empties, field projection)
   * on the way out — see the file header.
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
   * rows to yield. It runs on the **raw** seeded rows (before the Table API
   * shape is applied), so it can match on plain string fields. Defaults to
   * returning all seeded rows for the table.
   */
  queryFilter?: (
    table: string,
    rows: Record<string, unknown>[],
    params?: Record<string, string>,
  ) => Record<string, unknown>[];
  /**
   * Per-table pre-trim match count, surfaced by `table().queryWithMeta` as
   * `TableQueryResult.totalCount` (the real client reads this from the
   * `X-Total-Count` header). Set it above the number of visible rows to simulate
   * ACL security-trimming, so a test can assert a check reacts to the
   * `securityTrimmed` signal. Ignored by the array-returning `query`.
   */
  totalCounts?: Record<string, number>;
  /**
   * Extra reference columns per table, merged over the built-in
   * {@link REFERENCE_FIELDS}. Lets a test opt a column into the `{ link, value }`
   * shape without editing the fake.
   */
  referenceFields?: Record<string, string[]>;
  /** Force failures — globally or scoped to a table / cicd op. */
  fail?: ForcedFailure & {
    table?: Record<string, ForcedFailure>;
    cicd?: ForcedFailure;
  };
}

/**
 * Columns the real Table API returns as `{ link, value }` reference objects
 * (rather than plain strings) for the tables the checks read. Keeping this
 * explicit is what forces a check to unwrap references the way it must against
 * a live instance. Tests can extend it via `fixtures.referenceFields`.
 */
const REFERENCE_FIELDS: Record<string, ReadonlySet<string>> = {
  sys_update_set: new Set(["parent", "base_update_set", "sys_scope"]),
  sys_update_xml: new Set(["update_set"]),
  sys_atf_test_result: new Set(["test", "test_suite_result"]),
  sys_atf_test_suite_result: new Set(["parent", "test_suite"]),
  sys_security_acl_role: new Set(["sys_user_role", "sys_security_acl"]),
};

/** Origin used to synthesise reference `link` URLs — never contacted. */
const FAKE_ORIGIN = "https://fake.service-now.com";

/** Build the per-table set of reference columns, folding in any test overrides. */
function referenceFieldsFor(
  table: string,
  overrides?: Record<string, string[]>,
): ReadonlySet<string> {
  const base = REFERENCE_FIELDS[table];
  const extra = overrides?.[table];
  if (!extra || extra.length === 0) return base ?? new Set<string>();
  const merged = new Set<string>(base);
  for (const field of extra) merged.add(field);
  return merged;
}

/** Synthesise the API `link` a real reference object carries. */
function refLink(table: string, value: string): string {
  return `${FAKE_ORIGIN}/api/now/table/${table}/${value}`;
}

/**
 * Render a seeded primitive (`string` / `number` / `boolean`) as a string; a
 * `null`/`undefined` or a non-primitive becomes `""`. Avoids calling `String()`
 * on an `unknown` that could stringify to `"[object Object]"`.
 */
function primitiveToString(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

/**
 * Wrap a raw seeded value as the Table API reference shape (`{ link, value }`),
 * or `""` when the reference is empty/unset — exactly what the real API returns
 * for a reference column (never a bare string).
 */
function wrapReference(table: string, raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as {
      value?: unknown;
      link?: unknown;
      display_value?: unknown;
    };
    const value = primitiveToString(o.value);
    if (value === "") return "";
    const ref: { link: string; value: string; display_value?: string } = {
      link:
        typeof o.link === "string" && o.link.trim() !== ""
          ? o.link
          : refLink(table, value),
      value,
    };
    if (typeof o.display_value === "string")
      ref.display_value = o.display_value;
    return ref;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    return { link: refLink(table, raw), value: raw };
  }
  return "";
}

/** Coerce a non-reference seeded scalar; an absent/empty value becomes `""`. */
function coerceScalar(raw: unknown): unknown {
  if (raw === undefined || raw === null) return "";
  return raw;
}

/**
 * The known (non-dot-walked) columns of a table: the union of keys across every
 * seeded row, plus the declared reference columns. Used to tell an empty-but-
 * real column (returned as `""`) apart from an unknown `sysparm_fields` name
 * (dropped).
 */
function knownColumns(
  rows: Record<string, unknown>[],
  refs: ReadonlySet<string>,
): Set<string> {
  const cols = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!key.includes(".")) cols.add(key);
    }
  }
  for (const ref of refs) cols.add(ref);
  return cols;
}

/** Split a `sysparm_fields` value into field names, or `undefined` when unset. */
function parseFields(params?: Record<string, string>): string[] | undefined {
  const raw = params?.sysparm_fields;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return raw.split(",");
}

/**
 * Project one raw seeded row into the shape the real Table API returns:
 *  - reference columns become `{ link, value }` (or `""` when empty);
 *  - non-reference columns are returned as-is (`""` when empty);
 *  - dot-walked keys appear ONLY when requested via `sysparm_fields`;
 *  - with `sysparm_fields`, unknown column names are dropped;
 *  - without `sysparm_fields`, every known column is present (empties as `""`).
 */
function projectRow(
  table: string,
  row: Record<string, unknown>,
  cols: Set<string>,
  refs: ReadonlySet<string>,
  fields: string[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (fields === undefined) {
    for (const col of cols) {
      out[col] = refs.has(col)
        ? wrapReference(table, row[col])
        : coerceScalar(row[col]);
    }
    return out;
  }
  for (const rawField of fields) {
    const field = rawField.trim();
    if (field === "") continue;
    if (field.includes(".")) {
      // Dot-walked field: surfaced only when the fixture seeded that exact key.
      if (Object.prototype.hasOwnProperty.call(row, field)) {
        out[field] = coerceScalar(row[field]);
      }
      continue;
    }
    if (refs.has(field)) {
      out[field] = wrapReference(table, row[field]);
      continue;
    }
    if (cols.has(field)) {
      out[field] = coerceScalar(row[field]);
    }
    // else: unknown column name → dropped (SN ignores unknown sysparm_fields).
  }
  return out;
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
  if (f.response) throw new SnResponseError(msg, 200, "");
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
      const refs = referenceFieldsFor(name, fixtures.referenceFields);
      // Raw seeded rows for this query — narrowed by `queryFilter` when one is
      // supplied. The filter sees the un-shaped rows so it can match plain
      // string fields (e.g. `sys_scope`), the way a real query encodes them.
      const rawRows = (
        params?: Record<string, string>,
      ): Record<string, unknown>[] => {
        const rows = tableRows(name);
        return fixtures.queryFilter
          ? fixtures.queryFilter(name, rows, params)
          : rows;
      };
      // The visible, Table-API-shaped rows for a query. `cols` is derived from
      // ALL seeded rows (the table's schema), not just the filtered subset.
      const shapedRows = (
        params?: Record<string, string>,
      ): Record<string, unknown>[] => {
        const cols = knownColumns(tableRows(name), refs);
        const fields = parseFields(params);
        return rawRows(params).map((r) =>
          projectRow(name, r, cols, refs, fields),
        );
      };
      return {
        get(sysId, params) {
          maybeThrow(tableFail(name), `table ${name}`);
          const all = tableRows(name);
          const raw = all.find((r) => r.sys_id === sysId) ?? null;
          if (!raw) return Promise.resolve(null);
          const cols = knownColumns(all, refs);
          return Promise.resolve(
            projectRow(name, raw, cols, refs, parseFields(params)),
          );
        },
        query(params) {
          maybeThrow(tableFail(name), `table ${name}`);
          return Promise.resolve(shapedRows(params));
        },
        queryWithMeta(params): Promise<TableQueryResult> {
          maybeThrow(tableFail(name), `table ${name}`);
          const rows = shapedRows(params);
          const totalCount = fixtures.totalCounts?.[name];
          return Promise.resolve({
            rows,
            totalCount,
            securityTrimmed:
              totalCount !== undefined && totalCount > rows.length,
          });
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
