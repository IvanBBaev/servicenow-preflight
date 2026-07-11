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

/**
 * A Table API query result plus the platform metadata a security-conscious
 * caller needs. `rows` is exactly what {@link SnTable.query} returns.
 *
 * `totalCount` is the value of the `X-Total-Count` response header when the
 * instance sends it — the number of rows matching the query as computed by the
 * platform BEFORE ACL security-trimming.
 *
 * `securityTrimmed` is `true` when `totalCount` exceeds the number of visible
 * `rows`: the account was denied some rows by ACLs, so a short/empty result is
 * a permissions signal, not "no data". A least-privilege CI account reading an
 * admin-scoped table (e.g. `sys_security_acl`) is the canonical case a
 * preflight gate must not misread as "clean".
 */
export interface TableQueryResult {
  /** The visible rows — identical to what {@link SnTable.query} resolves to. */
  rows: Record<string, unknown>[];
  /** Pre-trim match count from `X-Total-Count`, when the instance sent it. */
  totalCount?: number;
  /** `true` when `totalCount > rows.length` (rows were ACL-trimmed away). */
  securityTrimmed: boolean;
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
  /**
   * Like {@link SnTable.query}, but also surfaces the `X-Total-Count` header and
   * a `securityTrimmed` signal (see {@link TableQueryResult}). Same pagination
   * and `sysparm_*` contract as `query`; use it when the caller must tell "no
   * matching rows" apart from "rows hidden by ACLs".
   */
  queryWithMeta(params?: Record<string, string>): Promise<TableQueryResult>;
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

/** A raw REST response: the HTTP status, the parsed JSON body, and headers. */
export interface SnRawResponse {
  status: number;
  body: unknown;
  /**
   * Response headers with lower-cased keys (e.g. `x-total-count`). Present on
   * the real client; a fake may omit it.
   */
  headers?: Record<string, string>;
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

/**
 * A response arrived with a successful (2xx) status but a body that is not the
 * expected JSON — the hallmark of a hibernating PDI's wake-up page or an
 * SSO/proxy interstitial answering `200` with HTML. It is raised instead of
 * letting the body degrade into `{ raw: text }` and then an empty result set: a
 * preflight gate that read "zero rows" from an instance it never actually
 * reached would pass against nothing. Fail closed and say so.
 */
export class SnResponseError extends SnError {
  /** The (successful-looking) HTTP status the non-JSON body arrived with. */
  readonly status: number;
  /** A short, secret-free snippet of the unexpected body, for diagnostics. */
  readonly bodySnippet: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.status = status;
    this.bodySnippet = body.slice(0, 200);
  }
}

/**
 * Auto-pagination reached its safety cap before exhausting the result set. It is
 * raised instead of silently returning a truncated page: a caller acting on a
 * partial result (e.g. a preflight gate comparing state) would draw a wrong
 * conclusion, so the client fails closed and lets the caller narrow the query.
 */
export class SnTruncationError extends SnError {
  /** The row cap that was hit before the result set was exhausted. */
  readonly cap: number;
  constructor(message: string, cap: number) {
    super(message);
    this.cap = cap;
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
  /**
   * Maximum CI/CD progress polls before giving up and reporting the run as
   * still pending (default 450). At the default 2000ms interval that is a
   * ~15-minute budget — chosen to cover a realistic ATF suite rather than the
   * old 2-minute ceiling, which abandoned any suite longer than a smoke test.
   * A longer suite should raise this (e.g. 900 ≈ 30 min); a fast CI lane can
   * lower it. Independent of the per-poll transient-error tolerance.
   */
  cicdMaxPolls?: number;
  /**
   * Maximum rows an auto-paginated `table().query()` will accumulate before it
   * fails closed with an {@link SnTruncationError} rather than silently
   * truncating (default 100000). A caller that genuinely wants more should page
   * explicitly with `sysparm_limit`/`sysparm_offset`.
   */
  maxRows?: number;
}

/** Minimal response shape the client consumes (a subset of `fetch`'s Response). */
interface TransportResponse {
  status: number;
  statusText: string;
  /** Response headers with lower-cased keys (both transports normalise to this). */
  headers: Record<string, string>;
  text(): Promise<string>;
}

/** Options for a transport call (a subset of `RequestInit`). */
interface TransportInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  /** Redirect policy handed to `fetch` (the client always sets `"error"`). */
  redirect?: RequestRedirect;
}

/**
 * The richer response the internal request pipeline threads through
 * ({@link createSnClient}). Adds the response headers and how many 429
 * Retry-After retries preceded this response (0 when none), on top of the
 * public {@link SnRawResponse} fields.
 */
interface RawResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  rateLimitAttempts: number;
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

/**
 * Normalise a set of response headers — a `fetch` `Headers`, a Node headers
 * object, or a plain record from a test fake — into a `Record` with lower-cased
 * keys. Tolerates `undefined` so a transport that reports no headers is fine.
 */
function headersToRecord(source: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!source || typeof source !== "object") return out;
  // A `fetch`/undici `Headers` exposes `forEach((value, key) => …)`.
  const iterable = source as {
    forEach?: (cb: (value: string, key: string) => void) => void;
  };
  if (typeof iterable.forEach === "function") {
    iterable.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }
  // A Node `IncomingHttpHeaders` / plain object: values are strings or string
  // arrays (a set-cookie style multi-value). Anything else is not a header value
  // and is skipped rather than coerced to `[object Object]`.
  for (const [key, value] of Object.entries(
    source as Record<string, unknown>,
  )) {
    if (typeof value === "string") {
      out[key.toLowerCase()] = value;
    } else if (Array.isArray(value)) {
      out[key.toLowerCase()] = value.join(", ");
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key.toLowerCase()] = String(value);
    }
  }
  return out;
}

/** The default transport — the global `fetch`, resolved at call time. */
const fetchTransport: Transport = async (url, init) => {
  const res = await globalThis.fetch(url, init);
  return {
    status: res.status,
    statusText: res.statusText,
    headers: headersToRecord(res.headers),
    text: () => res.text(),
  };
};

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
          const status = res.statusCode ?? 0;
          // CC-31: never follow a redirect on an API call — align with the
          // fetch path's `redirect: "error"`. `node:https` does not auto-follow,
          // so a 3xx would otherwise surface as a puzzling non-JSON body; fail
          // closed the same way instead, so credentials are never re-sent to a
          // redirect target.
          if (status >= 300 && status < 400) {
            res.resume(); // drain the body so the socket can be released
            reject(
              new Error(
                `Refusing to follow a ${status} redirect from ${u.origin} ` +
                  `(API requests must not redirect).`,
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status,
              statusText: res.statusMessage ?? "",
              headers: headersToRecord(res.headers),
              text: () => Promise.resolve(text),
            });
          });
          // CC-8: a mid-body socket failure emits an 'error' on the response
          // stream. Without this listener Node throws it as an unhandled
          // 'error' event and crashes the process; route it to the same reject
          // path the request-level error uses (→ SnNetworkError).
          res.on("error", (err) => reject(err));
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
  let status: number;
  let statusText: string;
  let text: string;
  try {
    const res = await transport(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: requestBody,
      // A token endpoint that redirects is not something to chase — fail closed.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    statusText = res.statusText;
    // CC-7: read the body inside the try — a mid-body ECONNRESET/timeout rejects
    // here and must surface as SnNetworkError, not escape as an unmapped error.
    text = await res.text();
  } catch (cause) {
    const err = cause instanceof Error ? cause : new Error(String(cause));
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    throw new SnNetworkError(
      timedOut
        ? `OAuth token request to ${new URL(url).origin} timed out after ${timeoutMs}ms.`
        : `Could not reach the OAuth token endpoint at ${new URL(url).origin}: ${err.message}`,
    );
  }

  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (status < 200 || status >= 300) {
    const detail = extractErrorDetail(body) ?? statusText;
    throw new SnAuthError(
      `OAuth token request failed (${status})${detail ? `: ${detail}` : ""}.`,
      status,
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
   * Discard the cached credential so the next {@link header} re-acquires it, but
   * only when it still matches `usedValue` — the header value the failing
   * request actually sent. This makes invalidation token-aware: a 401 from a
   * request that carried an already-superseded token must not evict the newer
   * token a concurrent acquisition just cached. Returns `true` when a retry is
   * worthwhile (grant flows), `false` for static credentials where a 401 is
   * terminal.
   */
  invalidate(usedValue?: string): boolean;
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
      // CC-34: a single in-flight acquisition shared by every concurrent
      // caller. Without it, N requests that all miss the cache each POST the
      // token endpoint N times — wasteful, and unsafe when the grant is
      // single-use (a refresh-token rotation would fail on the second POST).
      let inFlight: Promise<string> | undefined;

      async function acquire(): Promise<string> {
        const started = Date.now();
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
          expiresAt: Math.max(started + ttlMs - 30_000, started + 1_000),
        };
        return cached.value;
      }

      return {
        async header() {
          const now = Date.now();
          if (cached && now < cached.expiresAt) {
            return { name: "Authorization", value: cached.value };
          }
          // Coalesce concurrent cache misses onto one acquisition. Assign
          // `inFlight` synchronously (before any await) so a second caller in
          // the same tick sees it and awaits the same promise.
          if (!inFlight) {
            inFlight = acquire().finally(() => {
              inFlight = undefined;
            });
          }
          const value = await inFlight;
          return { name: "Authorization", value };
        },
        invalidate(usedValue) {
          // Only evict when the failing request used the token we still hold.
          // If a concurrent acquisition already replaced it, keep the newer one
          // and let the retry pick it up — never discard a fresher token.
          if (usedValue === undefined || cached?.value === usedValue) {
            cached = undefined;
          }
          return true;
        },
      };
    }
  }
}

/**
 * Extract a human-readable message from an error body. Handles both the
 * ServiceNow REST envelope (`{ error: { message, detail } }`) and the RFC 6749
 * OAuth shape (`{ error: "invalid_grant", error_description: "…" }`), so a
 * failed grant reports the actual reason instead of a bare status.
 */
function extractErrorDetail(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    // RFC 6749: `error` is a short string code, optionally paired with a longer
    // human-readable `error_description`.
    if (typeof err === "string" && err) {
      const desc = (body as { error_description?: unknown }).error_description;
      return typeof desc === "string" && desc ? `${err}: ${desc}` : err;
    }
    if (err && typeof err === "object") {
      const o = err as { message?: unknown; detail?: unknown };
      if (typeof o.message === "string" && o.message) return o.message;
      if (typeof o.detail === "string" && o.detail) return o.detail;
    }
  }
  return undefined;
}

/** A short, whitespace-collapsed preview of an unexpected response body. */
function bodyPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

/** Parse an `X-Total-Count` header (pre-trim match count) if present and valid. */
function parseTotalCount(
  headers: Record<string, string> | undefined,
): number | undefined {
  const raw = headers?.["x-total-count"];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Assemble a {@link TableQueryResult}, deriving the security-trimmed signal. */
function toQueryResult(
  rows: Record<string, unknown>[],
  totalCount: number | undefined,
): TableQueryResult {
  return {
    rows,
    totalCount,
    // A pre-trim count above the visible rows means ACLs hid some rows.
    securityTrimmed: totalCount !== undefined && totalCount > rows.length,
  };
}

/** Coerce a ServiceNow Table API `result` payload into an array of rows. */
function asRows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
}

/**
 * A `sysparm_*` value counts as supplied only when it is a non-empty string.
 * An empty string is treated as absent so `sysparm_limit: ""` behaves exactly
 * like omitting it (auto-paginate), rather than accidentally pinning a page.
 */
function paramPresent(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Auto-pagination walks `sysparm_offset` in fixed windows, so it needs a stable
 * total order or rows can be skipped or repeated across pages. When the caller's
 * `sysparm_query` carries no `ORDERBY` clause of its own, pin one on `sys_id`
 * (unique and always present). A caller-supplied ordering is left untouched.
 */
function withStableOrder(rawQuery: string | undefined): string {
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  // A ServiceNow order clause is `ORDERBY<field>` / `ORDERBYDESC<field>` at the
  // start of the query or after a `^` operator boundary.
  const hasOrderBy = /(?:^|\^)ORDERBY/.test(query);
  if (hasOrderBy) return query;
  return query ? `${query}^ORDERBYsys_id` : "ORDERBYsys_id";
}

/** Sleep for `ms` milliseconds (used to pace CI/CD progress polling). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How many times a 429 (rate-limited) response is retried, honouring its
 * `Retry-After`, before the request gives up and the 429 surfaces as an
 * {@link SnHttpError}. Bounded so a persistently throttling instance cannot
 * hang the run.
 */
const RATE_LIMIT_MAX_RETRIES = 3;

/**
 * Ceiling (ms) on any single `Retry-After` wait, so a hostile or mistaken
 * header (e.g. `Retry-After: 86400`) cannot stall the process for hours.
 */
const RETRY_AFTER_CEILING_MS = 30_000;

/**
 * How many consecutive transient poll failures (a 5xx, or an early 404 while
 * the progress record lags creation, or a network blip) a CI/CD run tolerates
 * before giving up. A suite that keeps running server-side must not be
 * abandoned on one hiccup.
 */
const CICD_POLL_ERROR_TOLERANCE = 5;

/**
 * Parse a `Retry-After` header into a wait in milliseconds, clamped to
 * {@link RETRY_AFTER_CEILING_MS}. Supports both RFC 7231 forms: a delta-seconds
 * integer and an HTTP-date. Falls back to 1s when the header is absent or
 * unparseable.
 */
function retryAfterMs(raw: string | undefined): number {
  const fallback = 1_000;
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1_000, RETRY_AFTER_CEILING_MS);
  }
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) {
    return Math.min(Math.max(when - Date.now(), 0), RETRY_AFTER_CEILING_MS);
  }
  return fallback;
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
  const parsedUrl = new URL(cfg.instanceUrl);
  // CC-11: `URL.origin` silently drops any path/query/fragment. If the
  // configured instance URL carries one (a reverse-proxy prefix like
  // `/servicenow`, say), every request would quietly hit the origin root
  // instead. Fail closed at construction with an actionable message rather than
  // send traffic to the wrong place.
  if (
    (parsedUrl.pathname && parsedUrl.pathname !== "/") ||
    parsedUrl.search ||
    parsedUrl.hash
  ) {
    throw new SnError(
      `instanceUrl "${cfg.instanceUrl}" carries a path/query/fragment ` +
        `("${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}") that ` +
        `URL.origin would silently drop, sending every request to ` +
        `"${parsedUrl.origin}" instead. Configure the bare instance origin ` +
        `(scheme + host [+ port]) only.`,
    );
  }
  const origin = parsedUrl.origin;
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
    const res = await sendRequest(method, path, opts, true);
    return { status: res.status, body: res.body, headers: res.headers };
  }

  async function sendRequest(
    method: string,
    path: string,
    opts: SnRequestOptions,
    allowRefresh: boolean,
  ): Promise<RawResult> {
    const url = buildUrl(origin, path, opts.query);
    const headers: Record<string, string> = { Accept: "application/json" };
    const cred = await authProvider.header();
    if (cred) headers[cred.name] = cred.value;
    const init: TransportInit = {
      method,
      headers,
      // CC-31: never follow redirects on an API call — a 3xx to an SSO/login
      // host would otherwise re-send the Authorization header off-instance.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let rateLimitAttempts = 0;
    for (;;) {
      let status: number;
      let statusText: string;
      let resHeaders: Record<string, string>;
      let text: string;
      try {
        const res = await transport(url, init);
        status = res.status;
        statusText = res.statusText;
        resHeaders = res.headers;
        // CC-7: read the body inside the try — a mid-body ECONNRESET or timeout
        // rejects here, and must surface as SnNetworkError rather than escape.
        text = await res.text();
      } catch (cause) {
        const err = cause instanceof Error ? cause : new Error(String(cause));
        const timedOut =
          err.name === "TimeoutError" || err.name === "AbortError";
        // The URL includes the instance origin only (no query/secret leakage).
        throw new SnNetworkError(
          timedOut
            ? `Request to ${origin} timed out after ${timeoutMs}ms.`
            : `Could not reach ServiceNow at ${origin}: ${err.message}`,
        );
      }

      // SN-6: honour Retry-After on a 429, up to a bounded number of attempts.
      // An exhausted budget falls through and becomes an SnHttpError below.
      if (status === 429 && rateLimitAttempts < RATE_LIMIT_MAX_RETRIES) {
        rateLimitAttempts += 1;
        await sleep(retryAfterMs(resHeaders["retry-after"]));
        continue;
      }

      let body: unknown = undefined;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          // CC-1: a successful (2xx) response whose body is not JSON is the most
          // dangerous corner case — a hibernating PDI's wake page, or an
          // SSO/proxy interstitial answering 200 with HTML. Never let it degrade
          // into `{ raw: text }` → an empty result set (a gate would "pass"
          // against an instance it never reached). Fail closed. A non-2xx body
          // is left raw so the status-based error path can still report it.
          if (status >= 200 && status < 300) {
            throw new SnResponseError(
              `ServiceNow returned a non-JSON ${status} response from ` +
                `${origin}${path} — the instance may be hibernating or an ` +
                `SSO/proxy returned an interstitial page instead of API data. ` +
                `Body began: ${bodyPreview(text)}`,
              status,
              text,
            );
          }
          body = { raw: text };
        }
      }

      if (status === 401 || status === 403) {
        // On a 401, a grant flow may hold a stale (expired) token — drop it,
        // re-acquire once and retry. Any other case (403, static creds, or a
        // second 401) is terminal. `invalidate` is token-aware: it will not
        // evict a token a concurrent acquisition already refreshed.
        if (
          status === 401 &&
          allowRefresh &&
          authProvider.invalidate(cred?.value)
        ) {
          return sendRequest(method, path, opts, false);
        }
        const detail = extractErrorDetail(body) ?? statusText;
        throw new SnAuthError(
          `ServiceNow authentication failed (${status})${detail ? `: ${detail}` : ""}.`,
          status,
        );
      }

      return { status, body, headers: resHeaders, rateLimitAttempts };
    }
  }

  /** Build the {@link SnHttpError} for a non-2xx result, noting 429 retries. */
  function httpErrorFor(res: RawResult): SnHttpError {
    const detail = extractErrorDetail(res.body) ?? `HTTP ${res.status}`;
    // SN-6: an exhausted-budget 429 keeps its retry context so the operator sees
    // the client already backed off and the instance stayed throttled.
    const rateNote =
      res.status === 429 && res.rateLimitAttempts > 0
        ? ` after ${res.rateLimitAttempts} Retry-After retries`
        : "";
    return new SnHttpError(
      res.status,
      `ServiceNow API error (${res.status})${rateNote}: ${detail}`,
      res.body,
    );
  }

  /** Like `request`, but throws {@link SnHttpError} on any non-2xx status. */
  async function requestOk(
    method: string,
    path: string,
    opts: SnRequestOptions = {},
  ): Promise<RawResult> {
    const res = await sendRequest(method, path, opts, true);
    if (res.status < 200 || res.status >= 300) {
      throw httpErrorFor(res);
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
  // CC-32: ~15 min at the default 2s interval — a realistic ATF-suite budget,
  // up from the old 60-poll (~2 min) ceiling that abandoned any real suite.
  const maxPolls = cfg.cicdMaxPolls ?? 450;
  const maxRows = cfg.maxRows ?? 100_000;

  /**
   * Follow a CI/CD run's `links.progress` link until the run settles (or we run
   * out of polls). Returns the last payload seen — terminal when possible, the
   * latest pending snapshot otherwise (the caller maps that to a `warn`).
   */
  async function pollCicdRun(payload: unknown): Promise<unknown> {
    let current = payload;
    let consecutiveErrors = 0;
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      if (CICD_TERMINAL.has(cicdStatus(current))) return current;
      const url = cicdProgressUrl(current);
      if (!url) return current;
      await sleep(pollIntervalMs);
      // CC-13: a suite that is genuinely running can answer a progress poll with
      // a transient 5xx, or an early 404 before its progress record is
      // committed. Tolerate a bounded run of consecutive failures rather than
      // abandon a suite that keeps executing server-side.
      let res: RawResult;
      try {
        res = await requestOk("GET", url);
        consecutiveErrors = 0;
      } catch (err) {
        if (
          (err instanceof SnHttpError || err instanceof SnNetworkError) &&
          (consecutiveErrors += 1) <= CICD_POLL_ERROR_TOLERANCE
        ) {
          continue;
        }
        throw err;
      }
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

      // Shared by `query` and `queryWithMeta`: return the visible rows plus the
      // pre-trim `X-Total-Count` (SN-1), applying the same `sysparm_*` contract.
      async function runQuery(
        params?: Record<string, string>,
      ): Promise<TableQueryResult> {
        // When the caller bounds the result set (`sysparm_limit`), honour it
        // verbatim — a single page, their offset and ordering included. An
        // empty-string limit is treated as absent (auto-paginate).
        if (paramPresent(params?.sysparm_limit)) {
          const res = await requestOk("GET", base, {
            query: { ...params, sysparm_limit: params.sysparm_limit.trim() },
          });
          return toQueryResult(
            asRows(unwrapResult(res.body)),
            parseTotalCount(res.headers),
          );
        }
        // A `sysparm_offset` without a `sysparm_limit` is ambiguous: the
        // auto-paginator walks from offset 0 and would silently ignore the
        // caller's offset. Fail closed rather than return the wrong window.
        if (paramPresent(params?.sysparm_offset)) {
          throw new SnError(
            `Table API query on "${name}" supplied sysparm_offset=` +
              `"${params.sysparm_offset.trim()}" without a sysparm_limit. ` +
              `Pair an offset with an explicit sysparm_limit to page manually, ` +
              `or drop the offset to let the client auto-paginate.`,
          );
        }
        // Auto-paginate. Pin a stable order (CC-33) so no row is skipped or
        // repeated across offset windows.
        const query = withStableOrder(params?.sysparm_query);
        const pageSize = 1000;
        const all: Record<string, unknown>[] = [];
        // X-Total-Count is the pre-trim match count; it rides every page, so
        // capture it from the first response that carries it (SN-1).
        let totalCount: number | undefined;
        for (let offset = 0; ; offset += pageSize) {
          const res = await requestOk("GET", base, {
            query: {
              ...params,
              sysparm_query: query,
              sysparm_limit: String(pageSize),
              sysparm_offset: String(offset),
            },
          });
          if (totalCount === undefined) {
            totalCount = parseTotalCount(res.headers);
          }
          const rows = asRows(unwrapResult(res.body));
          all.push(...rows);
          // A short page means the result set is exhausted.
          if (rows.length < pageSize) break;
          // A full page at the cap means more rows remain: fail closed rather
          // than silently drop them (the old behaviour), so the caller learns
          // to narrow the query instead of trusting a truncated result.
          if (all.length >= maxRows) {
            throw new SnTruncationError(
              `Table API query on "${name}" exceeded the ${maxRows}-row ` +
                `pagination cap without reaching the end of the result set; ` +
                `refusing to return a silently truncated result. Narrow ` +
                `sysparm_query, or page explicitly with sysparm_limit/` +
                `sysparm_offset.`,
              maxRows,
            );
          }
        }
        return toQueryResult(all, totalCount);
      }

      return {
        async get(sysId, params) {
          const res = await sendRequest(
            "GET",
            `${base}/${encodeURIComponent(sysId)}`,
            { query: params },
            true,
          );
          if (res.status === 404) return null;
          if (res.status < 200 || res.status >= 300) {
            throw httpErrorFor(res);
          }
          const result = unwrapResult(res.body);
          if (result && typeof result === "object" && !Array.isArray(result)) {
            return result as Record<string, unknown>;
          }
          return null;
        },
        async query(params) {
          return (await runQuery(params)).rows;
        },
        async queryWithMeta(params) {
          return runQuery(params);
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
