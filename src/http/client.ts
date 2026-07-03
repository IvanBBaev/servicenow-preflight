/**
 * ServiceNow REST client used by every preflight check.
 *
 * Checks NEVER call `fetch` directly — they call `ctx.http` (an {@link SnClient}).
 * This keeps checks pure and unit-testable: production wires a real client via
 * {@link createSnClient}; tests wire an in-memory one via `createFakeSnClient`
 * (see `./fake.js`). The interface is intentionally small — a Table API surface,
 * a CI/CD helper, and a low-level `request` escape hatch — so a fake can
 * implement it fully.
 */

/** How the client authenticates to the instance. */
export type SnAuth =
  | { kind: "basic"; user: string; pass: string }
  | { kind: "oauth"; token: string };

/** Table API surface scoped to a single table (`ctx.http.table("incident")`). */
export interface SnTable {
  /**
   * Fetch a single record by `sys_id`. Resolves to the record's fields, or
   * `null` when the record does not exist (HTTP 404 / empty result).
   */
  get(
    sysId: string,
    params?: Record<string, string>,
  ): Promise<Record<string, unknown> | null>;
  /**
   * Query records with ServiceNow `sysparm_*` params (e.g.
   * `{ sysparm_query: "active=true", sysparm_limit: "10" }`). Resolves to the
   * matching rows (possibly empty).
   */
  query(params?: Record<string, string>): Promise<Record<string, unknown>[]>;
}

/** Result of kicking off / reading a CI/CD test suite run. */
export interface CicdTestSuiteResult {
  /**
   * Normalised, lower-cased run status: `"success"`, `"failure"`,
   * `"canceled"`, or a pending state (`"pending"` / `"running"`). Derived from
   * the CI/CD numeric `status` / `status_label`.
   */
  status: string;
  /**
   * The `sys_atf_test_result.test_suite_result` id to scope per-test rows by,
   * resolved from the CI/CD `links.results.id`. Absent when the run did not
   * settle or the results link was not exposed — callers must NOT fall back to
   * scanning the whole `sys_atf_test_result` table.
   */
  resultId?: string;
  /** Raw CI/CD payload, retained for diagnostics (opaque). */
  results?: unknown;
}

/** CI/CD (Automated Test Framework) surface. */
export interface SnCicd {
  /** Run an ATF test suite by `sys_id` and resolve to its status/results. */
  runTestSuite(suiteSysId: string): Promise<CicdTestSuiteResult>;
}

/** A raw REST response: the HTTP status and the parsed JSON body. */
export interface SnRawResponse {
  status: number;
  body: unknown;
}

/** Options for a low-level {@link SnClient.request} call. */
export interface SnRequestOptions {
  query?: Record<string, string>;
  body?: unknown;
}

/**
 * The client every check depends on. `table` and `cicd` are convenience
 * wrappers over `request`, which is the low-level escape hatch for any endpoint
 * not covered by a helper.
 */
export interface SnClient {
  /** Table API access scoped to `name` (e.g. `sys_update_set`). */
  table(name: string): SnTable;
  /** CI/CD helpers (ATF test suites). */
  cicd: SnCicd;
  /**
   * Perform a raw authenticated request. `path` is an absolute API path under
   * the instance origin, e.g. `/api/now/table/incident`. Resolves with the
   * status and parsed body for ANY status (it does not throw on 4xx/5xx); use
   * this when a check needs to inspect the status itself. The `table`/`cicd`
   * helpers, by contrast, throw {@link SnHttpError} on non-2xx.
   */
  request(
    method: string,
    path: string,
    opts?: SnRequestOptions,
  ): Promise<SnRawResponse>;
}

/** Base class for every error this client raises. */
export class SnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Authentication failed (HTTP 401/403, or missing credentials). */
export class SnAuthError extends SnError {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** The instance could not be reached (DNS, connection, timeout). */
export class SnNetworkError extends SnError {
  constructor(message: string) {
    super(message);
  }
}

/** The instance returned a non-2xx HTTP status (other than 401/403). */
export class SnHttpError extends SnError {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** Configuration for {@link createSnClient}. */
export interface SnClientConfig {
  /** Base URL of the instance, e.g. `https://dev12345.service-now.com`. */
  instanceUrl: string;
  auth: SnAuth;
  /** Request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Poll interval while waiting for an async CI/CD run (default 2000). */
  cicdPollIntervalMs?: number;
  /** Maximum CI/CD progress polls before giving up as pending (default 60). */
  cicdMaxPolls?: number;
}

/** Build the `Authorization` header value for the configured auth mode. */
function authHeader(auth: SnAuth): string {
  if (auth.kind === "basic") {
    const token = Buffer.from(`${auth.user}:${auth.pass}`).toString("base64");
    return `Basic ${token}`;
  }
  return `Bearer ${auth.token}`;
}

/** Extract a human-readable message from a ServiceNow error body. */
function extractErrorDetail(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const o = err as { message?: unknown; detail?: unknown };
      if (typeof o.message === "string" && o.message) return o.message;
      if (typeof o.detail === "string" && o.detail) return o.detail;
    }
  }
  return undefined;
}

/** Coerce a ServiceNow Table API `result` payload into an array of rows. */
function asRows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

/** Sleep for `ms` milliseconds (used to pace CI/CD progress polling). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * CI/CD progress `status` codes → a normalised, lower-cased status string.
 * ServiceNow reports `0` Pending, `1` Running, `2` Successful, `3` Failed,
 * `4` Canceled either as the numeric code or the matching `status_label`.
 */
const CICD_STATUS_BY_CODE: Record<string, string> = {
  "0": "pending",
  "1": "running",
  "2": "success",
  "3": "failure",
  "4": "canceled",
};

/** Terminal (settled) CI/CD statuses — polling stops once one is reached. */
const CICD_TERMINAL = new Set(["success", "failure", "canceled"]);

/** Normalise a raw CI/CD `status` / `status_label` field to our status string. */
function cicdStatus(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown";
  const p = payload as { status?: unknown; status_label?: unknown };
  if (typeof p.status === "number") {
    return CICD_STATUS_BY_CODE[String(p.status)] ?? "unknown";
  }
  if (typeof p.status === "string" && p.status.trim()) {
    const raw = p.status.trim();
    return CICD_STATUS_BY_CODE[raw] ?? raw.toLowerCase();
  }
  if (typeof p.status_label === "string" && p.status_label.trim()) {
    return p.status_label.trim().toLowerCase();
  }
  return "unknown";
}

/** Pull `links.progress.url` (or `.id`) from a CI/CD payload, when present. */
function cicdProgressUrl(payload: unknown): string | undefined {
  const link = cicdLink(payload, "progress");
  if (link?.url) return link.url;
  if (link?.id) return `/api/sn_cicd/progress/${encodeURIComponent(link.id)}`;
  return undefined;
}

/** The `sys_atf_test_result.test_suite_result` id from `links.results.id`. */
function cicdResultId(payload: unknown): string | undefined {
  return cicdLink(payload, "results")?.id;
}

/** Read one `links.<name>` entry ({ id, url }) from a CI/CD payload. */
function cicdLink(
  payload: unknown,
  name: "progress" | "results",
): { id?: string; url?: string } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const links = (payload as { links?: unknown }).links;
  if (!links || typeof links !== "object") return undefined;
  const entry = (links as Record<string, unknown>)[name];
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as { id?: unknown; url?: unknown };
  return {
    id: typeof e.id === "string" ? e.id : undefined,
    url: typeof e.url === "string" ? e.url : undefined,
  };
}

/** Build a full URL from the instance origin, a path, and optional query. */
function buildUrl(
  origin: string,
  path: string,
  query?: Record<string, string>,
): string {
  const url = new URL(path, origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

/**
 * Create a real {@link SnClient} backed by Node's global `fetch`. Zero runtime
 * dependencies. Secrets are never logged and never placed into error messages.
 *
 * @example
 * ```ts
 * const http = createSnClient({
 *   instanceUrl: "https://dev12345.service-now.com",
 *   auth: { kind: "basic", user: "admin", pass: "***" },
 * });
 * const rec = await http.table("sys_update_set").get(sysId);
 * ```
 */
export function createSnClient(cfg: SnClientConfig): SnClient {
  const origin = new URL(cfg.instanceUrl).origin;
  const timeoutMs = cfg.timeoutMs ?? 30_000;

  async function request(
    method: string,
    path: string,
    opts: SnRequestOptions = {},
  ): Promise<SnRawResponse> {
    const url = buildUrl(origin, path, opts.query);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authHeader(cfg.auth),
    };
    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
      // The URL includes the instance origin only (no query/secret leakage).
      throw new SnNetworkError(
        timedOut
          ? `Request to ${origin} timed out after ${timeoutMs}ms.`
          : `Could not reach ServiceNow at ${origin}: ${err.message}`,
      );
    }

    const text = await res.text();
    let body: unknown = undefined;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }

    if (res.status === 401 || res.status === 403) {
      const detail = extractErrorDetail(body) ?? res.statusText;
      throw new SnAuthError(
        `ServiceNow authentication failed (${res.status})${detail ? `: ${detail}` : ""}.`,
        res.status,
      );
    }

    return { status: res.status, body };
  }

  /** Like `request`, but throws {@link SnHttpError} on any non-2xx status. */
  async function requestOk(
    method: string,
    path: string,
    opts: SnRequestOptions = {},
  ): Promise<SnRawResponse> {
    const res = await request(method, path, opts);
    if (res.status < 200 || res.status >= 300) {
      const detail = extractErrorDetail(res.body) ?? `HTTP ${res.status}`;
      throw new SnHttpError(
        res.status,
        `ServiceNow API error (${res.status}): ${detail}`,
        res.body,
      );
    }
    return res;
  }

  /** Pull the `result` payload out of a ServiceNow Table API response. */
  function unwrapResult(body: unknown): unknown {
    if (body && typeof body === "object" && "result" in body) {
      return body.result;
    }
    return undefined;
  }

  const pollIntervalMs = cfg.cicdPollIntervalMs ?? 2_000;
  const maxPolls = cfg.cicdMaxPolls ?? 60;

  /**
   * Follow a CI/CD run's `links.progress` link until the run settles (or we run
   * out of polls). Returns the last payload seen — terminal when possible, the
   * latest pending snapshot otherwise (the caller maps that to a `warn`).
   */
  async function pollCicdRun(payload: unknown): Promise<unknown> {
    let current = payload;
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      if (CICD_TERMINAL.has(cicdStatus(current))) return current;
      const url = cicdProgressUrl(current);
      if (!url) return current;
      await sleep(pollIntervalMs);
      const res = await requestOk("GET", url);
      current = unwrapResult(res.body) ?? current;
    }
    return current;
  }

  /** Distil a settled CI/CD payload into the {@link CicdTestSuiteResult}. */
  function normalizeCicdRun(payload: unknown): CicdTestSuiteResult {
    return {
      status: cicdStatus(payload),
      resultId: cicdResultId(payload),
      results: payload,
    };
  }

  return {
    table(name: string): SnTable {
      const base = `/api/now/table/${encodeURIComponent(name)}`;
      return {
        async get(sysId, params) {
          const res = await request(
            "GET",
            `${base}/${encodeURIComponent(sysId)}`,
            {
              query: params,
            },
          );
          if (res.status === 404) return null;
          if (res.status < 200 || res.status >= 300) {
            const detail = extractErrorDetail(res.body) ?? `HTTP ${res.status}`;
            throw new SnHttpError(
              res.status,
              `ServiceNow API error (${res.status}): ${detail}`,
              res.body,
            );
          }
          const result = unwrapResult(res.body);
          if (result && typeof result === "object" && !Array.isArray(result)) {
            return result as Record<string, unknown>;
          }
          return null;
        },
        async query(params) {
          // When the caller bounds the result set (`sysparm_limit`), honour it
          // verbatim — a single page. Otherwise auto-paginate so large tables
          // are never silently truncated at ServiceNow's default window.
          if (params?.sysparm_limit) {
            const res = await requestOk("GET", base, { query: params });
            return asRows(unwrapResult(res.body));
          }
          const pageSize = 1000;
          const all: Record<string, unknown>[] = [];
          for (let offset = 0; ; offset += pageSize) {
            const res = await requestOk("GET", base, {
              query: {
                ...params,
                sysparm_limit: String(pageSize),
                sysparm_offset: String(offset),
              },
            });
            const rows = asRows(unwrapResult(res.body));
            all.push(...rows);
            // A short page means we reached the end. The safety cap bounds a
            // pathological table so a check can never loop unbounded.
            if (rows.length < pageSize || all.length >= 100_000) break;
          }
          return all;
        },
      };
    },
    cicd: {
      async runTestSuite(suiteSysId: string): Promise<CicdTestSuiteResult> {
        // Kick off the (asynchronous) suite run, then poll its progress link
        // until the run reaches a terminal state before reading the result.
        const res = await requestOk("POST", `/api/sn_cicd/testsuite/run`, {
          query: { test_suite_sys_id: suiteSysId },
        });
        const settled = await pollCicdRun(unwrapResult(res.body));
        return normalizeCicdRun(settled);
      },
    },
    request,
  };
}
