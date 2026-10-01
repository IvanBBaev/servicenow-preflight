// QA-18 — the request-level surface.
//
// Everything below is the shape `@tessera/sn-client` actually speaks:
//   * `api/table.ts` builds `/api/now/table/<table>[/<sysId>]` with
//     `sysparm_query`, `sysparm_fields`, `sysparm_limit`, `sysparm_offset`,
//     `sysparm_display_value` and `sysparm_exclude_reference_link`, and unwraps
//     `{ result }` via `api/shared.ts`; `fetchAll` paging stops when a page
//     returns fewer rows than requested and reads `X-Total-Count` for `total`.
//   * `core/http.ts` treats any non-2xx as a `ServiceNowError`, reading the
//     message out of `body.error.message | body.error.detail`.
//   * `api/atf.ts` posts to `/api/sn_cicd/testsuite/run` and polls
//     `/api/sn_cicd/progress/<id>`.
//
// Anything not derived from those files is called out in a comment here or in
// `cicd.ts`'s provenance block.

import {
  FakeAbortError,
  namespace404Body,
  noRecordFoundBody,
  snErrorBody,
} from "./errors.js";
import { stall, transportFailure, type FaultRegistry } from "./faults.js";
import type { HttpMethod } from "./faults.js";
import { projectFields, type SnRecord } from "./record.js";
import type { FakeTableStore } from "./tables.js";
import type { FakeCicd } from "./cicd.js";
import type { FakeAcl, FakeAclOperation, FakeReadAcl } from "./acl.js";

export interface FakeRequest {
  method: HttpMethod;
  /** Path only; a query string here is split off and merged into `params`. */
  path: string;
  params?: URLSearchParams | Record<string, string>;
  /** Parsed JSON request body. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Honoured by the `hang` fault, exactly as a real `fetch` would. */
  signal?: AbortSignal;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  headers: Record<string, string>;
}

/** Every request the fake served — an assertion aid for write-order tests. */
export interface RecordedRequest {
  method: HttpMethod;
  path: string;
  params: Record<string, string>;
  body?: unknown;
  /** Absent when the request failed at the transport level. */
  status?: number;
  /** Id of the fault rule that fired, when one did. */
  fault?: string;
}

// Anchored at both ends, unlike `sn-client`'s copy (core/http.ts): a path
// with anything beyond `<table>[/<sys_id>]` must NOT be routed as a table but
// fall through to `dispatch`'s record-level 404 for unmodelled `/api/now/`
// sub-resources. Pinned by `packages/cli/test/tablePathAgreement.test.js`.
const TABLE_PATH_RE = /^\/api\/now\/(?:table|import)\/([^/?]+)(?:\/([^/?]+))?$/;
// The real REST API serves every `/api/now/` resource under an optional
// version segment too (`/api/now/v2/table/incident` is the Table API, as is
// `/api/now/v1/import/<table>`), and `@tessera/sn-client`'s write gate accepts
// that shape. The fake routes it the same way by dropping the segment before
// classification, so the unversioned `TABLE_PATH_RE` above stays byte-identical
// to its sibling copies; the request log and fault matching keep the path as
// sent. Pinned by `packages/cli/test/tablePathAgreement.test.js`.
const API_VERSION_RE = /^\/api\/now\/v\d+\//;
// Wave 16 — the Aggregate (Stats) API, `/api/now/stats/<table>` (versioned
// form via `API_VERSION_RE`). Only the count is modelled; see `statsRoute`.
const STATS_PATH_RE = /^\/api\/now\/stats\/([^/?]+)$/;
// Stats parameters the fake does NOT model. A request carrying any of them
// keeps the record-level 404 for unmodelled `/api/now/` resources rather than
// being answered with a count it did not ask for.
const UNMODELLED_STATS_PARAMS: readonly string[] = [
  "sysparm_avg_fields",
  "sysparm_min_fields",
  "sysparm_max_fields",
  "sysparm_sum_fields",
  "sysparm_group_by",
  "sysparm_having",
  "sysparm_order_by",
];
const CICD_PROGRESS_RE = /^\/api\/sn_cicd\/progress\/([^/?]+)$/;
const CICD_RUN_PATH = "/api/sn_cicd/testsuite/run";

/**
 * DEV-14 — the query parameters the fake reads a suite sys_id from on
 * `testsuite/run`, in precedence order. The default is the vendored client's
 * `sys_id` only (api/atf.ts), and it stays the default: `@tessera/runner-atf`
 * pins that a canonical-only request is refused here (trigger.test.js,
 * `aliasParam: null`), which is the evidence that its `sys_id` alias is
 * load-bearing. The CI/CD endpoint's documented name is `test_suite_sys_id`;
 * a scenario that wants the fake to accept it opts in via
 * `FakeInstanceOptions.cicdSuiteParams` (delegated decision 2026-09-23).
 */
export const DEFAULT_CICD_SUITE_PARAMS: readonly string[] = ["sys_id"];

const JSON_HEADERS: Readonly<Record<string, string>> = {
  "content-type": "application/json",
};

function toSearchParams(
  params: URLSearchParams | Record<string, string> | undefined,
): URLSearchParams {
  if (params instanceof URLSearchParams) return new URLSearchParams(params);
  return new URLSearchParams(params ?? {});
}

function ok(body: unknown, extra?: Record<string, string>): FakeResponse {
  return { status: 200, body, headers: { ...JSON_HEADERS, ...extra } };
}

function fail(status: number, message: string, detail?: string): FakeResponse {
  return {
    status,
    body: snErrorBody(message, detail ?? message),
    headers: { ...JSON_HEADERS },
  };
}

/**
 * `decodeURIComponent` that answers `undefined` instead of throwing a
 * URIError on malformed percent-encoding (`%E0%A4%A`, `%ZZ`).
 */
function decodeSegment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * Delegated decision 2026-09-26 (W6a L2): a path segment that is not valid
 * percent-encoding answers 400 in the ServiceNow error shape. A real
 * instance's container rejects such a URL before the REST layer sees it;
 * what matters here is that `handle` never throws a URIError at the caller
 * and that `sn-client`'s transport gets a body it can read.
 */
function malformedPath(path: string): FakeResponse {
  return fail(
    400,
    "Invalid request URI",
    `malformed percent-encoding in path: ${path}`,
  );
}

/** `sysparm_fields` is a comma-separated list; empty entries are dropped. */
function fieldList(params: URLSearchParams): string[] | undefined {
  const raw = params.get("sysparm_fields");
  if (!raw) return undefined;
  const fields = raw
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

/**
 * `sysparm_no_count=true` tells the Table API to skip the `select count(*)`,
 * and the response then carries **no** `X-Total-Count` header. The fake only
 * drops the header — it pages and applies read ACLs exactly as it does with
 * the header present, so a denied row still shortens its page.
 *
 * What the consumers do with a header-less page (wave 15): `sn-client`'s
 * `fetchAll` (api/table.ts) no longer treats a short, non-empty page as the
 * end of results. It probes one requested window further (same query and
 * limit, `sysparm_offset` advanced by the window, not by the rows returned);
 * rows there mark the read `truncationReason: "short-page-no-total"`, a failed
 * probe marks it `"probe-failed"`, and stopping on the SN_MAX_RECORDS cap is
 * `"no-total"`. `@tessera/runner-atf`'s `readTable` sends the same one-window
 * probe on its own port. Only a page trimmed to ZERO rows still reads as the
 * end — the accepted residual. A fake that always emitted the header would
 * leave all of that unreachable, every `truncated` assertion measuring only
 * the header-present path.
 *
 * Delegated decision 2026-09-30 (wave 15): comment only — the fake's
 * behaviour is unchanged; the wording now matches the transport's five
 * truncation reasons ("cap" | "short-page" | "no-total" |
 * "short-page-no-total" | "probe-failed").
 */
function noCountRequested(params: URLSearchParams): boolean {
  return (params.get("sysparm_no_count") ?? "").trim().toLowerCase() === "true";
}

function intParam(params: URLSearchParams, name: string): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** A JSON object body; anything else is a caller error the fake rejects. */
function objectBody(body: unknown): SnRecord | undefined {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return body as SnRecord;
  }
  return undefined;
}

/**
 * Wave 16 — knobs for the modelled Stats API count. Both opt-in.
 */
export interface FakeStatsCountOptions {
  /**
   * When true, the count excludes rows the read-ACL model hides (as the
   * Table API page does). Default false: the count covers EVERY matching
   * row, like `X-Total-Count`.
   *
   * Delegated decision 2026-09-30 (wave 16): default "not ACL-filtered" is
   * an ASSUMPTION — no live capture in this repo shows whether
   * `/api/now/stats/<table>?sysparm_count=true` honours row-level read ACLs.
   * It mirrors the fake's `X-Total-Count` (counted before the ACL filter).
   * Turn this on to model the other possibility, under which a count
   * cross-check sees exactly the rows the Table API returned and detects
   * nothing.
   */
  aclFiltered?: boolean;
  /**
   * Corrupt the count in an otherwise 200 response, for fail-closed parser
   * tests: `"non-numeric-count"` answers `count: "many"`,
   * `"missing-count"` answers `stats: {}`, `"numeric-count"` answers the
   * count as a JSON number instead of the real string. HTTP / transport
   * failures of the stats path go through the fault registry instead
   * (`match: { path: "/api/now/stats/" }`).
   */
  fault?: "non-numeric-count" | "missing-count" | "numeric-count";
}

export interface RouterDeps {
  tables: FakeTableStore;
  cicd: FakeCicd;
  faults: FaultRegistry;
  /** Query parameter carrying the §4a run id on `testsuite/run`. */
  runIdParam?: string;
  /** Suite sys_id parameter names; see {@link DEFAULT_CICD_SUITE_PARAMS}. */
  cicdSuiteParams?: readonly string[];
  /** W2 ACL model; absent = every table write is allowed (the default). */
  acl?: FakeAcl;
  /** W6a L3 read-ACL model; absent = every row and field is readable. */
  readAcl?: FakeReadAcl;
  /**
   * Wave 14 — list reads never carry `X-Total-Count`, as if every request had
   * sent `sysparm_no_count=true`. Default false (the header is emitted).
   */
  omitTotalCount?: boolean;
  /** Wave 16 — Stats API count knobs; absent = count every row, no fault. */
  statsCount?: FakeStatsCountOptions;
  /** Appends to the shared request log. */
  onRequest?: (entry: RecordedRequest) => void;
}

export interface FakeRouter {
  handle(request: FakeRequest): Promise<FakeResponse>;
}

export function createRouter({
  tables,
  cicd,
  faults,
  runIdParam = "tessera_run_id",
  cicdSuiteParams = DEFAULT_CICD_SUITE_PARAMS,
  acl,
  readAcl,
  omitTotalCount = false,
  statsCount = {},
  onRequest,
}: RouterDeps): FakeRouter {
  // A 403 in the shape a real instance answers a failed table ACL with. The
  // gate runs BEFORE the mutation, so a denied write changes nothing.
  const denied = (
    table: string,
    operation: FakeAclOperation,
    row: SnRecord,
  ): FakeResponse | undefined => {
    const denial = acl?.check(table, operation, row);
    if (!denial) return undefined;
    return fail(
      403,
      "Operation Failed",
      `ACL Exception ${operation} of ${table} failed due to security constraints (requires role ${denial.role})`,
    );
  };

  const tableRoute = (
    method: HttpMethod,
    table: string,
    sysId: string | undefined,
    params: URLSearchParams,
    body: unknown,
  ): FakeResponse => {
    const fields = fieldList(params);

    if (method === "GET" && sysId === undefined) {
      const { records, total } = tables.query(table, {
        ...(params.get("sysparm_query")
          ? { query: params.get("sysparm_query") ?? "" }
          : {}),
        ...(fields ? { fields } : {}),
        ...(intParam(params, "sysparm_limit") !== undefined
          ? { limit: intParam(params, "sysparm_limit") }
          : {}),
        ...(intParam(params, "sysparm_offset") !== undefined
          ? { offset: intParam(params, "sysparm_offset") }
          : {}),
        ...(readAcl ? { readAcl } : {}),
      });
      return omitTotalCount || noCountRequested(params)
        ? ok({ result: records })
        : ok({ result: records }, { "x-total-count": String(total) });
    }

    if (method === "GET") {
      const stored = sysId === undefined ? undefined : tables.get(table, sysId);
      // Delegated decision 2026-09-26 (W6a L3): a read-ACL-hidden row answers
      // the same 404 as an absent one — the real body's detail already reads
      // "Record doesn't exist or ACL restricts the record retrieval".
      const record =
        stored && readAcl
          ? readAcl.hides(table, stored)
            ? undefined
            : readAcl.redact(table, stored)
          : stored;
      if (!record) {
        return {
          status: 404,
          body: noRecordFoundBody(),
          headers: { ...JSON_HEADERS },
        };
      }
      return ok({ result: projectFields(record, fields) });
    }

    if (method === "POST") {
      if (sysId !== undefined) {
        return fail(
          405,
          "Method Not Allowed",
          "POST targets the table, not a record",
        );
      }
      const fieldsIn = objectBody(body);
      if (!fieldsIn) {
        return fail(400, "Invalid request body", "expected a JSON object");
      }
      const refused = denied(table, "create", fieldsIn);
      if (refused) return refused;
      const created = tables.insert(table, fieldsIn);
      // A real instance answers 201 with the full stored record.
      return {
        status: 201,
        body: { result: projectFields(created, fields) },
        headers: { ...JSON_HEADERS },
      };
    }

    if (method === "PATCH" || method === "PUT") {
      if (sysId === undefined) {
        return fail(405, "Method Not Allowed", `${method} requires a sys_id`);
      }
      const fieldsIn = objectBody(body);
      if (!fieldsIn) {
        return fail(400, "Invalid request body", "expected a JSON object");
      }
      const current = tables.get(table, sysId);
      if (current) {
        const refused = denied(table, "write", { ...current, ...fieldsIn });
        if (refused) return refused;
      }
      const updated = tables.update(table, sysId, fieldsIn);
      if (!updated) {
        return {
          status: 404,
          body: noRecordFoundBody(),
          headers: { ...JSON_HEADERS },
        };
      }
      return ok({ result: projectFields(updated, fields) });
    }

    // DELETE
    if (sysId === undefined) {
      return fail(405, "Method Not Allowed", "DELETE requires a sys_id");
    }
    const existing = tables.get(table, sysId);
    if (existing) {
      const refused = denied(table, "delete", existing);
      if (refused) return refused;
    }
    if (!tables.remove(table, sysId)) {
      return {
        status: 404,
        body: noRecordFoundBody(),
        headers: { ...JSON_HEADERS },
      };
    }
    // A real Table API DELETE answers 204 with an empty body.
    return { status: 204, headers: {} };
  };

  const recordNotFound = (): FakeResponse => ({
    status: 404,
    body: noRecordFoundBody(),
    headers: { ...JSON_HEADERS },
  });

  /**
   * Wave 16 — `GET /api/now/stats/<table>?sysparm_count=true[&sysparm_query=]`
   * answers `{ result: { stats: { count: "<n>" } } }`: the count is a STRING,
   * as a real instance sends it. The query runs through the same engine as
   * the Table API (ORDERBY terms are ignored for a count).
   *
   * Delegated decision 2026-09-30 (wave 16): only the plain count is
   * modelled. A request without `sysparm_count=true`, or with any
   * aggregate/grouping parameter the fake does not implement, keeps the
   * record-level 404 every unmodelled `/api/now/` resource gets — never a
   * fabricated number. A non-GET answers 405.
   */
  const statsRoute = (
    method: HttpMethod,
    table: string,
    params: URLSearchParams,
  ): FakeResponse => {
    if (method !== "GET") {
      return fail(405, "Method Not Allowed", `${method} on the Stats API`);
    }
    const countRequested =
      (params.get("sysparm_count") ?? "").trim().toLowerCase() === "true";
    if (
      !countRequested ||
      UNMODELLED_STATS_PARAMS.some((name) => params.has(name))
    ) {
      return recordNotFound();
    }
    const query = params.get("sysparm_query");
    const aclFiltered = statsCount.aclFiltered === true && readAcl;
    const { records, total } = tables.query(table, {
      ...(query ? { query } : {}),
      // A count needs no rows back unless the ACL filter must see them.
      limit: aclFiltered ? Number.MAX_SAFE_INTEGER : 0,
      ...(aclFiltered ? { readAcl } : {}),
    });
    const count = aclFiltered ? records.length : total;
    switch (statsCount.fault) {
      case "non-numeric-count":
        return ok({ result: { stats: { count: "many" } } });
      case "missing-count":
        return ok({ result: { stats: {} } });
      case "numeric-count":
        return ok({ result: { stats: { count } } });
      default:
        return ok({ result: { stats: { count: String(count) } } });
    }
  };

  const cicdRoute = (
    method: HttpMethod,
    path: string,
    params: URLSearchParams,
  ): FakeResponse => {
    if (path === CICD_RUN_PATH) {
      if (method !== "POST") {
        return fail(405, "Method Not Allowed", `${method} ${path}`);
      }
      // api/atf.ts sends `sys_id` for a suite and `test_sys_id` for a test;
      // which names count as "a suite sys_id" is `cicdSuiteParams` (DEV-14).
      const suiteSysId =
        cicdSuiteParams
          .map((name) => params.get(name))
          .find((value): value is string => !!value) ?? undefined;
      const testSysId = params.get("test_sys_id") ?? undefined;
      if (!suiteSysId && !testSysId) {
        return fail(
          400,
          "Invalid request",
          `one of ${[...cicdSuiteParams, "test_sys_id"].join(" or ")} is required`,
        );
      }
      const run = cicd.start({
        ...(suiteSysId ? { suiteSysId } : {}),
        ...(testSysId ? { testSysId } : {}),
        ...(params.get(runIdParam)
          ? { runId: params.get(runIdParam) ?? "" }
          : {}),
      });
      return ok({ result: cicd.payload(run) });
    }

    const executionId = CICD_PROGRESS_RE.exec(path)?.[1];
    if (executionId !== undefined) {
      if (method !== "GET") {
        return fail(405, "Method Not Allowed", `${method} ${path}`);
      }
      const decodedId = decodeSegment(executionId);
      if (decodedId === undefined) return malformedPath(path);
      const run = cicd.poll(decodedId);
      if (!run) {
        return {
          status: 404,
          body: noRecordFoundBody(),
          headers: { ...JSON_HEADERS },
        };
      }
      return ok({ result: cicd.payload(run) });
    }

    // A record-level 404 inside a live namespace — deliberately NOT the
    // namespace 404 body, which would make api/plugin.ts cache "CI/CD is
    // unavailable" for five minutes and poison the rest of a suite.
    return {
      status: 404,
      body: noRecordFoundBody(),
      headers: { ...JSON_HEADERS },
    };
  };

  const dispatch = (
    method: HttpMethod,
    path: string,
    params: URLSearchParams,
    body: unknown,
    // Decoded once by `handle` (which answers 400 when decoding fails), so
    // the table route never re-decodes — and never re-throws — here.
    tableTarget: { table: string; sysId: string | undefined } | undefined,
    statsTable: string | undefined,
  ): FakeResponse => {
    if (tableTarget) {
      return tableRoute(
        method,
        tableTarget.table,
        tableTarget.sysId,
        params,
        body,
      );
    }
    if (statsTable !== undefined) return statsRoute(method, statsTable, params);
    if (path.startsWith("/api/sn_cicd/"))
      return cicdRoute(method, path, params);
    // `/api/now/` is core REST — present on every instance, plugin or not. A
    // sub-resource the fake does not model must therefore NOT answer the
    // namespace-404 wording: that body asserts the namespace is absent, which
    // api/plugin.ts caches as "the backing plugin is inactive" for five
    // minutes and doctor's probe reads as proof the API is missing. No real
    // instance can say that about /api/now, so neither may the fake — an
    // unmodelled path there gets the record-level 404 instead. Since wave 16
    // the Aggregate API count (`GET /api/now/stats/<table>?sysparm_count=true`,
    // sn-client's `countRows`) is modelled by `statsRoute` above; every other
    // Stats request (no `sysparm_count=true`, avg/min/max/sum/group_by/having,
    // a nested sub-path) still lands here.
    if (path.startsWith("/api/now/")) {
      return {
        status: 404,
        body: noRecordFoundBody(),
        headers: { ...JSON_HEADERS },
      };
    }
    // Unknown REST namespace: the wording api/plugin.ts keys "plugin inactive" on.
    return {
      status: 404,
      body: namespace404Body(path),
      headers: { ...JSON_HEADERS },
    };
  };

  return {
    async handle(request) {
      const [path = "", inlineQuery] = request.path.split("?", 2);
      const params = toSearchParams(request.params);
      if (inlineQuery) {
        for (const [key, value] of new URLSearchParams(inlineQuery)) {
          params.set(key, value);
        }
      }
      const routed = path.replace(API_VERSION_RE, "/api/now/");
      const tableMatch = TABLE_PATH_RE.exec(routed);
      const statsMatch = STATS_PATH_RE.exec(routed);
      const log: RecordedRequest = {
        method: request.method,
        path,
        params: Object.fromEntries(params),
        ...(request.body === undefined ? {} : { body: request.body }),
      };

      if (request.signal?.aborted) {
        onRequest?.(log);
        throw request.signal.reason instanceof Error
          ? request.signal.reason
          : new FakeAbortError();
      }

      const decodedTable =
        tableMatch?.[1] === undefined
          ? undefined
          : decodeSegment(tableMatch[1]);
      const decodedSysId =
        tableMatch?.[2] === undefined
          ? undefined
          : decodeSegment(tableMatch[2]);
      const decodedStatsTable =
        statsMatch?.[1] === undefined
          ? undefined
          : decodeSegment(statsMatch[1]);
      if (
        (tableMatch?.[1] !== undefined && decodedTable === undefined) ||
        (tableMatch?.[2] !== undefined && decodedSysId === undefined) ||
        (statsMatch?.[1] !== undefined && decodedStatsTable === undefined)
      ) {
        // Delegated decision 2026-09-26 (W6a L2): rejected before fault
        // matching — a URL the server cannot decode never reaches the REST
        // layer a fault rule stands in for.
        const response = malformedPath(path);
        log.status = response.status;
        onRequest?.(log);
        return response;
      }

      const fault = faults.take({
        method: request.method,
        path,
        ...(decodedTable !== undefined ? { table: decodedTable } : {}),
        ...(decodedSysId !== undefined ? { sysId: decodedSysId } : {}),
      });
      if (fault) {
        const history = faults.history();
        log.fault = history[history.length - 1] ?? "";
      }

      if (fault?.kind === "hang") {
        // Resolves after `ms` (slow instance) or rejects on abort (DEV-2).
        await stall(fault.ms, request.signal);
      }

      if (fault?.kind === "transport-error") {
        onRequest?.(log);
        throw transportFailure(fault.message);
      }

      if (fault?.kind === "http-error") {
        // §4b W1 — the mutation never happens.
        const response: FakeResponse = {
          status: fault.status,
          body:
            fault.body ??
            snErrorBody(fault.message ?? "fake instance: injected failure"),
          headers: { ...JSON_HEADERS },
        };
        log.status = response.status;
        onRequest?.(log);
        return response;
      }

      const response = dispatch(
        request.method,
        routed,
        params,
        request.body,
        decodedTable === undefined
          ? undefined
          : { table: decodedTable, sysId: decodedSysId },
        decodedStatsTable,
      );

      if (fault?.kind === "crash-after-write") {
        // §4b W2 — state changed above; the caller never learns the outcome.
        if (fault.status === undefined) {
          onRequest?.(log);
          throw transportFailure(
            fault.message ??
              "fake instance: connection lost after the write landed",
          );
        }
        const crashed: FakeResponse = {
          status: fault.status,
          body: snErrorBody(
            fault.message ?? "fake instance: failed after the write landed",
          ),
          headers: { ...JSON_HEADERS },
        };
        log.status = crashed.status;
        onRequest?.(log);
        return crashed;
      }

      log.status = response.status;
      onRequest?.(log);
      return response;
    },
  };
}
