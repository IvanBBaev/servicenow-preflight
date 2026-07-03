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

import { request as httpsRequest } from "node:https";
import { createSign } from "node:crypto";

/**
 * How the client authenticates to the instance.
 *
 * `basic`, `oauth` (a pre-issued bearer token) and `apikey` attach a header
 * directly and never touch the network to authenticate. The `oauth-*` grant
 * flows acquire a bearer token from the OAuth token endpoint
 * (`${instanceOrigin}/oauth_token.do` by default) on first use, then cache it
 * until it expires and re-acquire it on a 401. Mutual TLS is orthogonal — it is
 * configured via {@link SnClientConfig.tls} and composes with any of these.
 */
export type SnAuth =
  | { kind: "basic"; user: string; pass: string }
  | { kind: "oauth"; token: string }
  | { kind: "apikey"; apiKey: string }
  | ({
      kind: "oauth-password";
      clientId: string;
      clientSecret: string;
      user: string;
      pass: string;
    } & OAuthGrantCommon)
  | ({
      kind: "oauth-client";
      clientId: string;
      clientSecret: string;
    } & OAuthGrantCommon)
  | ({
      kind: "oauth-refresh";
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    } & OAuthGrantCommon)
  | ({
      kind: "oauth-jwt";
      clientId: string;
      clientSecret?: string;
      /** A pre-signed JWT assertion. When set, no signing is performed. */
      assertion?: string;
      /** PEM private key used to sign the assertion (RS256) when `assertion` is absent. */
      privateKey?: string;
      /** Optional `kid` header on the signed assertion. */
      keyId?: string;
      /** `sub` claim — the user the token acts as. */
      subject?: string;
      /** `aud` claim (default: the token endpoint URL). */
      audience?: string;
      /** `iss` claim (default: `clientId`). */
      issuer?: string;
    } & OAuthGrantCommon);

/** Options shared by every OAuth grant flow. */
export interface OAuthGrantCommon {
  /** Override the token endpoint (default `${instanceOrigin}/oauth_token.do`). */
  tokenUrl?: string;
}

/** Transport-level client certificate for mutual TLS. */
export interface SnTls {
  /** Client certificate (PEM). */
  cert: string;
  /** Client private key (PEM). */
  key: string;
  /** CA bundle to trust for the server certificate (PEM), optional. */
  ca?: string;
  /** Passphrase for an encrypted private key, optional. */
  passphrase?: string;
}

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
  /**
   * How to authenticate. Optional: when omitted the client sends no auth header
   * (valid when {@link tls} alone identifies the caller, or for an unauthenticated
   * probe that expects a 401).
   */
  auth?: SnAuth;
  /** Client certificate for mutual TLS (optional; composes with `auth`). */
  tls?: SnTls;
  /** Request timeout in milliseconds (default 30000). */
  timeoutMs?: number;
  /** Poll interval while waiting for an async CI/CD run (default 2000). */
  cicdPollIntervalMs?: number;
  /** Maximum CI/CD progress polls before giving up as pending (default 60). */
  cicdMaxPolls?: number;
}

/** Minimal response shape the client consumes (a subset of `fetch`'s Response). */
interface TransportResponse {
  status: number;
  statusText: string;
  text(): Promise<string>;
}

/** Options for a transport call (a subset of `RequestInit`). */
interface TransportInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * A single HTTP round-trip. The default transport is the global `fetch`; when a
 * client cert is configured a `node:https` transport is used instead so the
 * client presents the certificate on the TLS socket.
 */
type Transport = (
  url: string,
  init: TransportInit,
) => Promise<TransportResponse>;

/** The default transport — the global `fetch`, resolved at call time. */
const fetchTransport: Transport = (url, init) => globalThis.fetch(url, init);

/**
 * Build a `node:https` transport that presents `tls`'s client certificate. It
 * adapts an `https.request` round-trip to the same {@link TransportResponse}
 * shape the fetch path yields, and mirrors the abort/timeout signalling so the
 * caller's `SnNetworkError` mapping works identically.
 */
function createHttpsTransport(tls: SnTls): Transport {
  return (url, init) =>
    new Promise<TransportResponse>((resolve, reject) => {
      const u = new URL(url);
      const req = httpsRequest(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || 443,
          path: `${u.pathname}${u.search}`,
          method: init.method,
          headers: init.headers,
          cert: tls.cert,
          key: tls.key,
          ca: tls.ca,
          passphrase: tls.passphrase,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? "",
              text: () => Promise.resolve(text),
            });
          });
        },
      );
      const signal = init.signal;
      if (signal) {
        const onAbort = (): void => {
          const reason = signal.reason as { name?: string; message?: string };
          const err = new Error(
            reason?.message ?? "The operation was aborted.",
          );
          err.name = reason?.name ?? "AbortError";
          req.destroy(err);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      req.on("error", (err) => reject(err));
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
}

/** Base64url-encode a string or buffer (no padding). */
function base64url(input: string | Buffer): string {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Auth kinds that acquire a token from the OAuth token endpoint. */
type OAuthGrantAuth = Extract<SnAuth, { kind: `oauth-${string}` }>;

/** The token endpoint URL for a grant flow (config override or the default). */
function tokenEndpoint(auth: OAuthGrantAuth, origin: string): string {
  return auth.tokenUrl ?? `${origin}/oauth_token.do`;
}

/**
 * Build (or pass through) the signed JWT assertion for the `oauth-jwt` grant.
 * Signs with RS256 over `{iss,sub,aud,iat,nbf,exp}` using the configured PEM key.
 */
function jwtAssertion(
  auth: Extract<SnAuth, { kind: "oauth-jwt" }>,
  origin: string,
): string {
  if (auth.assertion) return auth.assertion;
  if (!auth.privateKey) {
    throw new SnAuthError(
      "oauth-jwt requires either a pre-signed assertion or a private key to sign one.",
    );
  }
  const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
  if (auth.keyId) header.kid = auth.keyId;
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {
    iss: auth.issuer ?? auth.clientId,
    aud: auth.audience ?? tokenEndpoint(auth, origin),
    iat: now,
    nbf: now,
    exp: now + 300,
  };
  if (auth.subject) claims.sub = auth.subject;
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(claims),
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(auth.privateKey);
  return `${signingInput}.${base64url(signature)}`;
}

/** Build the `application/x-www-form-urlencoded` body for a grant's token request. */
function tokenRequestBody(auth: OAuthGrantAuth, origin: string): string {
  const params = new URLSearchParams();
  switch (auth.kind) {
    case "oauth-password":
      params.set("grant_type", "password");
      params.set("client_id", auth.clientId);
      params.set("client_secret", auth.clientSecret);
      params.set("username", auth.user);
      params.set("password", auth.pass);
      break;
    case "oauth-client":
      params.set("grant_type", "client_credentials");
      params.set("client_id", auth.clientId);
      params.set("client_secret", auth.clientSecret);
      break;
    case "oauth-refresh":
      params.set("grant_type", "refresh_token");
      params.set("client_id", auth.clientId);
      params.set("client_secret", auth.clientSecret);
      params.set("refresh_token", auth.refreshToken);
      break;
    case "oauth-jwt":
      params.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
      params.set("assertion", jwtAssertion(auth, origin));
      params.set("client_id", auth.clientId);
      if (auth.clientSecret) params.set("client_secret", auth.clientSecret);
      break;
  }
  return params.toString();
}

/** A newly acquired access token and its lifetime (seconds), if reported. */
interface AcquiredToken {
  accessToken: string;
  expiresIn?: number;
}

/**
 * POST a grant's token request to the OAuth token endpoint and parse the access
 * token out of the response. Authenticates via the request body (no bearer
 * header). A 4xx (or a missing token) surfaces as {@link SnAuthError}; secrets
 * are never placed into the error message.
 */
async function acquireToken(
  auth: OAuthGrantAuth,
  transport: Transport,
  origin: string,
  timeoutMs: number,
): Promise<AcquiredToken> {
  const url = tokenEndpoint(auth, origin);
  // Build the body first: JWT signing/config errors are auth problems and must
  // surface as SnAuthError, not be masked by the transport's network catch.
  const requestBody = tokenRequestBody(auth, origin);
  let res: TransportResponse;
  try {
    res = await transport(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    const err = cause instanceof Error ? cause : new Error(String(cause));
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    throw new SnNetworkError(
      timedOut
        ? `OAuth token request to ${new URL(url).origin} timed out after ${timeoutMs}ms.`
        : `Could not reach the OAuth token endpoint at ${new URL(url).origin}: ${err.message}`,
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

  if (res.status < 200 || res.status >= 300) {
    const detail = extractErrorDetail(body) ?? res.statusText;
    throw new SnAuthError(
      `OAuth token request failed (${res.status})${detail ? `: ${detail}` : ""}.`,
      res.status,
    );
  }

  const token =
    body && typeof body === "object"
      ? (body as { access_token?: unknown }).access_token
      : undefined;
  if (typeof token !== "string" || !token) {
    throw new SnAuthError(
      "OAuth token endpoint did not return an access_token.",
    );
  }
  const expiresRaw =
    body && typeof body === "object"
      ? (body as { expires_in?: unknown }).expires_in
      : undefined;
  const expiresIn =
    typeof expiresRaw === "number"
      ? expiresRaw
      : typeof expiresRaw === "string" && expiresRaw.trim()
        ? Number(expiresRaw)
        : undefined;
  return {
    accessToken: token,
    expiresIn: Number.isFinite(expiresIn) ? expiresIn : undefined,
  };
}

/** A request-time credential: the header to attach, plus a re-auth escape hatch. */
interface AuthProvider {
  /**
   * The header to attach to each request (name + value), or `undefined` when the
   * client sends none (no auth configured, or TLS-only identity).
   */
  header(): Promise<{ name: string; value: string } | undefined>;
  /**
   * Discard any cached credential so the next {@link header} re-acquires it.
   * Returns `true` when a retry is worthwhile (grant flows), `false` for static
   * credentials where a 401 is terminal.
   */
  invalidate(): boolean;
}

/** A provider that always returns the same header and cannot be refreshed. */
function staticHeader(name: string, value: string): AuthProvider {
  return {
    header: () => Promise.resolve({ name, value }),
    invalidate: () => false,
  };
}

/**
 * Build the {@link AuthProvider} for the configured auth. Static credentials
 * yield a fixed header; grant flows lazily acquire, cache (until ~30s before
 * expiry) and — on {@link AuthProvider.invalidate} — re-acquire a bearer token.
 */
function buildAuthProvider(
  auth: SnAuth | undefined,
  transport: Transport,
  origin: string,
  timeoutMs: number,
): AuthProvider {
  if (!auth) {
    return {
      header: () => Promise.resolve(undefined),
      invalidate: () => false,
    };
  }
  switch (auth.kind) {
    case "basic": {
      const token = Buffer.from(`${auth.user}:${auth.pass}`).toString("base64");
      return staticHeader("Authorization", `Basic ${token}`);
    }
    case "oauth":
      return staticHeader("Authorization", `Bearer ${auth.token}`);
    case "apikey":
      return staticHeader("x-sn-apikey", auth.apiKey);
    default: {
      const grant = auth;
      let cached: { value: string; expiresAt: number } | undefined;
      return {
        async header() {
          const now = Date.now();
          if (cached && now < cached.expiresAt) {
            return { name: "Authorization", value: cached.value };
          }
          const { accessToken, expiresIn } = await acquireToken(
            grant,
            transport,
            origin,
            timeoutMs,
          );
          const ttlMs = (expiresIn && expiresIn > 0 ? expiresIn : 1800) * 1000;
          cached = {
            value: `Bearer ${accessToken}`,
            // Refresh ~30s early, but always cache for at least a second so a
            // short-lived token can't trigger a re-acquire on every request.
            expiresAt: Math.max(now + ttlMs - 30_000, now + 1_000),
          };
          return { name: "Authorization", value: cached.value };
        },
        invalidate() {
          cached = undefined;
          return true;
        },
      };
    }
  }
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
  // Mutual TLS routes over a `node:https` transport (to present the client
  // cert); every other case uses the global `fetch`.
  const transport: Transport = cfg.tls
    ? createHttpsTransport(cfg.tls)
    : fetchTransport;
  const authProvider = buildAuthProvider(
    cfg.auth,
    transport,
    origin,
    timeoutMs,
  );

  async function request(
    method: string,
    path: string,
    opts: SnRequestOptions = {},
  ): Promise<SnRawResponse> {
    // `allowRefresh` lets a grant flow re-acquire its token once on a 401
    // (expired token) and retry; static credentials cannot be refreshed.
    return sendRequest(method, path, opts, true);
  }

  async function sendRequest(
    method: string,
    path: string,
    opts: SnRequestOptions,
    allowRefresh: boolean,
  ): Promise<SnRawResponse> {
    const url = buildUrl(origin, path, opts.query);
    const headers: Record<string, string> = { Accept: "application/json" };
    const cred = await authProvider.header();
    if (cred) headers[cred.name] = cred.value;
    const init: TransportInit = {
      method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let res: TransportResponse;
    try {
      res = await transport(url, init);
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
      // On a 401, a grant flow may hold a stale (expired) token — drop it,
      // re-acquire once and retry. Any other case (403, static creds, or a
      // second 401) is terminal.
      if (res.status === 401 && allowRefresh && authProvider.invalidate()) {
        return sendRequest(method, path, opts, false);
      }
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
