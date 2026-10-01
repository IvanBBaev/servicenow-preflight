// Vendored from github.com/IvanBBaev/servicenow-mcp @ 5acdcc7 (src/core/http.ts).
// MIT upstream; vendored by the sole author/copyright owner (ADR-002).
// Adaptations (Tessera):
//   DEV-24 — the env read-only gate is enforced here, at the transport
//            boundary, not only in the api layer (defense in depth).
//   DEV-15 — every applied mutation is journalled here (DF-2). Upstream
//            journalled at the MCP tools layer, which is not vendored.

import { ServiceNowError, isRedirect, redirectError } from "./errors.js";
import { getCredentials } from "./config.js";
import { resolveHost } from "./host.js";
import { getAuthProvider, getAuthMode, invalidateToken } from "./auth.js";
import { getTlsDispatcher } from "./mtls.js";
import { logger } from "./logging.js";
import {
  assertTableAllowed,
  assertTableWritable,
  assertUnclassifiedWriteAllowed,
  assertWriteAllowed,
} from "./policy.js";
import {
  appendWriteJournal,
  type JournalEntry,
  type WriteAction,
} from "./write-journal.js";
import { getMaxRetries, getTimeoutMs } from "./settings.js";
import {
  backoffMs,
  countError,
  delay,
  isIdempotent,
  retryAfterMs,
  shouldRetryStatus,
  telemetryFor,
  withSlot,
} from "./http-util.js";

// Telemetry is owned by http-util.ts (shared upstream with the Jira client,
// which was not vendored) but kept
// importable here for the status payload and the existing tests.
export {
  getTelemetry,
  _resetTelemetry,
  type Telemetry,
  type TelemetrySnapshot,
} from "./http-util.js";

/** Arguments for a single ServiceNow REST request. */
export interface SnRequestArgs {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Absolute API path under the instance origin, e.g. "/api/now/table/incident". */
  path: string;
  params?: URLSearchParams;
  /** JSON request body. Mutually exclusive with `rawBody`. */
  body?: unknown;
  /** Pre-encoded request body (e.g. binary upload). Sets `contentType`. */
  rawBody?: string | Uint8Array;
  /** Content-Type for `rawBody`. Ignored when `body` is used (always JSON). */
  contentType?: string;
  /** Accept header; defaults to application/json. */
  accept?: string;
  /** "json" (default) parses the body; "binary" returns base64 in `data`. */
  responseType?: "json" | "binary";
}

export interface SnResponse<T> {
  data: T;
  /** X-Total-Count (all matching rows) when the API provides it. */
  total?: number;
  status: number;
  /** Content-Type of the response, useful for binary downloads. */
  contentType?: string;
}

/** Parse the X-Total-Count header (total matching rows) when present. */
function parseTotalCount(res: Response): number | undefined {
  const raw = res.headers.get("x-total-count");
  return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** Extract a human-readable message from a ServiceNow error body. */
function extractErrorDetail(json: unknown): string | undefined {
  if (json && typeof json === "object" && "error" in json) {
    const err = (json as { error?: unknown }).error;
    if (err && typeof err === "object") {
      const o = err as { message?: unknown; detail?: unknown };
      if (typeof o.message === "string" && o.message) return o.message;
      if (typeof o.detail === "string" && o.detail) return o.detail;
    }
  }
  return undefined;
}

/** Table and Import Set API paths: /api/now/{table,import}/<table>[/<sys_id>]. */
const TABLE_PATH_RE = /\/api\/now\/(?:table|import)\/([^/?]+)(?:\/([^/?]+))?/;

/**
 * The ONLY Table/Import API shapes a write may take, anchored at both ends:
 * `/api/now[/v<N>]/{table,import}/<table>[/<sys_id>]`, optionally followed
 * by a query or fragment. No trailing `/` (delegated decision 2026-09-25, see
 * {@link assertCanonicalWritePath}). Unlike {@link TABLE_PATH_RE} (unanchored, and pinned
 * to the fake instance's copies by cli/test/tablePathAgreement.test.js), this
 * one cannot be satisfied by a path that merely *contains* the prefix, so a
 * write's policy target is the table the instance will actually route to.
 */
const WRITE_TABLE_PATH_RE =
  /^\/api\/now\/(?:v\d+\/)?(?:table|import)\/([^/?#]+)(?:\/([^/?#]+))?(?:[?#].*)?$/;

/**
 * Any path in the Table/Import API family, however it is spelt: a `table` or
 * `import` segment anywhere under `/api/now/`, matched case-insensitively
 * against the percent-DECODED path. A write matching this but not
 * {@link WRITE_TABLE_PATH_RE} is refused rather than treated as unclassified.
 */
const TABLE_FAMILY_RE = /\/api\/now\/(?:[^/]*\/)*(?:table|import)(?:\/|$)/i;

const JOURNAL_ACTIONS: Record<string, WriteAction> = {
  POST: "create",
  PATCH: "update",
  PUT: "update",
  DELETE: "delete",
};

/** A percent-decoded path segment; an undecodable segment is kept verbatim. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The table (and record) a path names, or `undefined` when the path is not a
 * Table/Import API path. Unanchored, and kept byte-identical to the fake
 * instance's copies (cli/test/tablePathAgreement.test.js), so it is a READ-side
 * classifier only: since delegated decision 2026-09-25 writes are gated and
 * journalled through the anchored `writeTableTargetFor` instead, one function
 * for both so the journal and the table policy can never disagree.
 */
export function tableTargetFor(
  path: string,
): { table: string; sysId?: string } | undefined {
  const match = TABLE_PATH_RE.exec(path);
  const table = match?.[1];
  if (table === undefined) return undefined;
  const sysId = match?.[2];
  return {
    table: decodeSegment(table),
    ...(sysId ? { sysId: decodeSegment(sysId) } : {}),
  };
}

/**
 * Delegated decision 2026-09-25: a write whose path is not in canonical form is
 * REFUSED (fail closed) before any policy check, rather than normalised.
 *
 * `fetch` (WHATWG URL) resolves dot segments — raw `.`/`..` and their
 * percent-encoded spellings `%2e`/`%2E` — and treats a backslash as `/` AFTER the
 * policy has looked at the path, so `/api/now/table/incident/../sys_user_has_role`
 * was checked as `incident` and delivered to `sys_user_has_role`, bypassing the
 * never-write list, SN_TABLES_ALLOW/DENY and the write journal's table. A server
 * may further decode `%2f`/`%5c` into separators, and treat `;` as a matrix
 * parameter delimiter or `//` as a single separator. Normalising here would
 * mean guessing the server's rules; refusing leaves nothing to guess.
 *
 * Refused: a path the URL parser would rewrite; an empty segment, including a
 * trailing `/`; a segment that is — raw or once-decoded — `.`/`..`;
 * a segment containing a backslash or `;`, or (once decoded) `/`, a
 * backslash, `;` or a
 * still-encoded `%2e`/`%2f`/`%5c` (double encoding); an undecodable segment.
 */
function assertCanonicalWritePath(method: string, path: string): void {
  const pathPart = path.split(/[?#]/, 1)[0] ?? "";
  const refuse = (why: string): never => {
    throw new ServiceNowError(
      `Refusing "${method} ${pathPart}": ${why}. Writes must use a canonical path.${WRITE_PATH_HINT}`,
      403,
    );
  };
  if (!pathPart.startsWith("/")) refuse("the path is not absolute");
  let parsed: string;
  try {
    parsed = new URL(pathPart, "https://x").pathname;
  } catch {
    return refuse("the path cannot be parsed");
  }
  if (parsed !== pathPart) refuse("the URL parser would rewrite the path");
  const segments = pathPart.slice(1).split("/");
  segments.forEach((segment, index) => {
    if (segment === "") {
      // Delegated decision 2026-09-25: a trailing `/` is refused like every
      // other non-canonical shape. The fake instance's anchored router sends
      // `/api/now/table/incident/` to its record-level 404, and how a real
      // instance routes it is unknown — so admitting it would let the table
      // policy and journal classify a write whose destination nobody can
      // state. Fail closed: no trailing-slash write leaves this client.
      if (index === segments.length - 1 && index > 0) {
        refuse("the path has a trailing '/'");
      }
      refuse("the path has an empty segment");
    }
    if (/[;\\]/.test(segment)) refuse("a segment contains ';' or '\\'");
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return refuse("a segment cannot be percent-decoded");
    }
    if (decoded === "." || decoded === "..") {
      refuse("the path has a dot segment");
    }
    if (/[/\\;]/.test(decoded) || /%(?:2e|2f|5c)/i.test(decoded)) {
      refuse("a segment encodes a separator, a dot or a second encoding");
    }
  });
}

const WRITE_PATH_HINT =
  " (delegated decision 2026-09-25: non-canonical write paths are refused, not normalised)";

/**
 * The table (and record) a WRITE targets, from the anchored
 * {@link WRITE_TABLE_PATH_RE}; `undefined` when the path is not a Table/Import
 * API path at all. A path in the table family that does not take one of the
 * accepted shapes (`/api/now/table/a/b/c`, `/x/api/now/table/a`,
 * `/api/now/T%61ble/a`, …) throws: it names a table the policy cannot pin down.
 * Call only after {@link assertCanonicalWritePath}.
 *
 * Delegated decision 2026-09-25: such a write is refused (fail closed), not
 * downgraded to an unclassified write — an unclassified write passes with no
 * table policy set, and that is exactly the bypass this closes.
 */
function writeTableTargetFor(
  method: string,
  path: string,
): { table: string; sysId?: string } | undefined {
  const match = WRITE_TABLE_PATH_RE.exec(path);
  const table = match?.[1];
  if (table !== undefined) {
    const sysId = match?.[2];
    return {
      table: decodeSegment(table),
      ...(sysId ? { sysId: decodeSegment(sysId) } : {}),
    };
  }
  const pathPart = path.split(/[?#]/, 1)[0] ?? "";
  const decoded = pathPart.split("/").map(decodeSegment).join("/");
  if (TABLE_FAMILY_RE.test(pathPart) || TABLE_FAMILY_RE.test(decoded)) {
    throw new ServiceNowError(
      `Refusing "${method} ${pathPart}": it reaches the Table/Import API in a shape the table policy cannot classify.${WRITE_PATH_HINT}`,
      403,
    );
  }
  return undefined;
}

/**
 * The table (and record) a WRITE to `path` targets, exactly as the transport's
 * write gate classifies it: {@link assertCanonicalWritePath} first, then
 * {@link writeTableTargetFor}. Throws a 403 {@link ServiceNowError} for a path
 * the gate refuses; `undefined` for a canonical path outside the Table/Import
 * API. Exported so the write classifier can be pinned against the fake
 * instance's router (cli/test/tablePathAgreement.test.js), the same way
 * {@link tableTargetFor} pins the read side.
 */
export function writeTargetFor(
  method: string,
  path: string,
): { table: string; sysId?: string } | undefined {
  assertCanonicalWritePath(method, path);
  return writeTableTargetFor(method, path);
}

/** Query arguments as named values, repeated keys collected into arrays. */
function journalParams(
  params: URLSearchParams | undefined,
): Record<string, string | string[]> | undefined {
  if (!params) return undefined;
  const out: Record<string, string | string[]> = {};
  let any = false;
  for (const [key, value] of params) {
    any = true;
    const seen = out[key];
    if (seen === undefined) out[key] = value;
    else if (Array.isArray(seen)) seen.push(value);
    else out[key] = [seen, value];
  }
  return any ? out : undefined;
}

/**
 * DEV-15 — describe an applied mutation for the write journal (DF-2).
 *
 * Table/Import API paths map to create/update/delete on `<table>[/<sys_id>]`;
 * every other mutating endpoint (script execution, CI/CD, attachments) is
 * journalled as "execute" against its path. Over-journalling is deliberate:
 * an entry too many is a lesser failure than an applied write with no trace.
 *
 * The journal exists to answer "what did this write apply?", so it records the
 * payload for *every* write, not only the Table API ones: a JSON object body as
 * `fields`, the query arguments as `params`. That is not a nicety on the
 * non-table paths, it is the whole content — the CI/CD endpoints carry their
 * entire payload in the query string, so an entry without `params` names the
 * endpoint and nothing about what it acted on. Where a payload cannot be
 * decomposed into named values (a pre-encoded `rawBody`, a non-object JSON
 * body) the entry says so with `payload_unknown` rather than looking complete;
 * an unrecorded payload is a fact the audit trail has to state, not omit.
 *
 * The journal is a local file under the operator's docs dir, not the log
 * stream, so unlike `logger` fields it may carry the query arguments: recording
 * them is the point of the artefact.
 */
function journalEntryFor(
  method: SnRequestArgs["method"],
  path: string,
  body: unknown,
  rawBody: SnRequestArgs["rawBody"],
  params: URLSearchParams | undefined,
): Omit<JournalEntry, "ts" | "profile"> | undefined {
  if (method === "GET") return undefined;
  // The same anchored classifier the write gate used, so the journal names the
  // table the policy checked (and the instance routed to).
  const target = writeTableTargetFor(method, path);
  const action: WriteAction =
    target === undefined ? "execute" : (JOURNAL_ACTIONS[method] ?? "execute");
  const fields =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  // A body we could not enumerate, or one sent pre-encoded, is a payload this
  // entry does not carry — flag it so a consumer can tell an incomplete record
  // from a write that genuinely sent nothing.
  const payloadUnknown =
    rawBody !== undefined || (body !== undefined && fields === undefined);
  const journalledParams = journalParams(params);
  return {
    action,
    table: target?.table ?? path,
    ...(target?.sysId ? { sys_id: target.sysId } : {}),
    ...(fields ? { fields } : {}),
    ...(journalledParams ? { params: journalledParams } : {}),
    ...(payloadUnknown ? { payload_unknown: true as const } : {}),
  };
}

/**
 * Perform an authenticated request against the configured ServiceNow instance.
 *
 * The host is resolved and SSRF-checked before any network call, and the query
 * string is omitted from error messages (encoded queries can contain personal
 * data). Transient failures are retried with exponential backoff; non-idempotent
 * methods are retried only on connection errors, never on a received response.
 */
/** The methods {@link snRequest} accepts, in their canonical (upper) case. */
const SN_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PATCH",
  "PUT",
  "DELETE",
]);

function isSnMethod(method: string): method is SnRequestArgs["method"] {
  return SN_METHODS.has(method);
}

/**
 * Delegated decision 2026-09-26: canonicalise the method BEFORE any gate. A
 * plain-JS or loosely-typed caller passing `"delete"` used to reach the
 * transport as-is: the write gates ran (anything but `"GET"` is gated), but
 * the journal's action lookup is keyed by the upper-case name, so the entry
 * said `execute` instead of `delete`, and `fetch` sent a non-standard
 * lower-case `patch` verbatim. The value is upper-cased once here and that
 * value is what every gate sees, the journal records and the wire carries.
 * Anything outside the typed union (HEAD, TRACE, a padded or non-string value)
 * is refused before any gate or request — fail closed, nothing to guess.
 */
function canonicalMethod(raw: unknown): SnRequestArgs["method"] {
  const upper = typeof raw === "string" ? raw.toUpperCase() : "";
  if (!isSnMethod(upper)) {
    throw new ServiceNowError(
      `Unsupported HTTP method ${JSON.stringify(raw)}; expected one of GET, POST, PATCH, PUT, DELETE.`,
    );
  }
  return upper;
}

export async function snRequest<T>({
  method: rawMethod,
  path,
  params,
  body,
  rawBody,
  contentType,
  accept,
  responseType = "json",
}: SnRequestArgs): Promise<SnResponse<T>> {
  const method = canonicalMethod(rawMethod);
  // DEV-24 — enforce the environment write gate before anything else, so a
  // caller reaching this transport directly cannot bypass the policy the api
  // layer applies. A denial is an explicit 403 error, never a silent skip.
  if (method !== "GET") {
    assertWriteAllowed(`${method} ${path}`);
    // The operator's table policy is applied to writes here for the same
    // reason: it is enforced at the api layer, and a caller reaching this
    // transport directly would otherwise escape it entirely. Reads are
    // deliberately NOT gated here — doctor and parity read through this
    // transport precisely so that a client-fabricated 403 can never be
    // reported as the instance's own refusal (DEV-1), and moving the read
    // gate down here would take that distinction away from them.
    // The built-in never-write list (ADR-007 C6) runs first, so no operator
    // allowlist can re-admit a role-grant write.
    //
    // The path is first proven canonical and classified with the ANCHORED
    // write classifier; see assertCanonicalWritePath / writeTableTargetFor.
    const target = writeTargetFor(method, path);
    if (target) {
      assertTableWritable(target.table, `${method} ${path}`);
      assertTableAllowed(target.table);
    } else assertUnclassifiedWriteAllowed(`${method} ${path}`);
  }

  const { instance } = getCredentials();
  if (!instance) {
    throw new ServiceNowError(
      "ServiceNow instance is not configured. Use the servicenow_set_credentials tool first.",
    );
  }

  const host = resolveHost(instance);
  const base = `https://${host}`;
  const qs = params?.toString();
  // The path already carrying a query string is a caller mistake, but join with
  // the right separator so we never emit a malformed double-"?" URL.
  const sep = path.includes("?") ? "&" : "?";
  const url = `${base}${path}${qs ? `${sep}${qs}` : ""}`;
  const safeUrl = `${base}${path}`;
  const timeoutMs = getTimeoutMs();
  const maxRetries = getMaxRetries();

  const headers: Record<string, string> = {
    Accept: accept ?? "application/json",
  };
  let payload: string | Uint8Array | undefined;
  if (rawBody !== undefined) {
    payload = rawBody;
    if (contentType) headers["Content-Type"] = contentType;
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  const started = Date.now();
  const telemetry = telemetryFor(host);
  telemetry.requests += 1;
  // A server-side token revocation surfaces as 401 before the cached token's
  // TTL runs out; one forced re-auth attempt recovers, a second 401 is real.
  // Optional client certificate (mutual TLS), built once per request.
  const dispatcher = await getTlsDispatcher();
  let retried401 = false;
  for (let attempt = 0; ; attempt++) {
    // Authorize per attempt: with long backoffs an OAuth token can expire
    // between tries (Basic is just a cheap base64; OAuth reads its cache).
    Object.assign(headers, await getAuthProvider().headers(host));
    let res: Response;
    try {
      // Node's fetch accepts Uint8Array bodies and a `dispatcher` (undici) at
      // runtime; the loose record bridges gaps in the DOM RequestInit typing.
      // The timeout signal is created inside the slot, so time spent queued on
      // the per-host semaphore does not consume the request's timeout budget.
      res = await withSlot(host, () => {
        const init: Record<string, unknown> = {
          method,
          headers,
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
          // Delegated decision 2026-09-25: never follow a redirect. A followed
          // 3xx replays the auth headers (x-sn-apikey survives cross-origin
          // redirects) and, on 307/308, the write body to a host that never
          // passed resolveHost's SSRF/allowlist check. See isRedirect (errors.ts).
          redirect: "manual",
        };
        if (dispatcher) init.dispatcher = dispatcher;
        return fetch(url, init);
      });
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
      // Only retry transport errors for idempotent requests, to avoid
      // duplicating non-idempotent writes whose outcome is unknown.
      if (isIdempotent(method) && attempt < maxRetries) {
        telemetry.retries += 1;
        await delay(backoffMs(attempt + 1));
        continue;
      }
      logger.warn("ServiceNow request failed (transport)", {
        method,
        path,
        timedOut,
        ms: Date.now() - started,
      });
      countError(telemetry, "transport");
      telemetry.totalMs += Date.now() - started;
      if (timedOut) {
        throw new ServiceNowError(
          `Request to ServiceNow timed out after ${timeoutMs}ms.`,
        );
      }
      throw new ServiceNowError(
        `Could not reach ServiceNow at ${safeUrl}: ${err.message}`,
      );
    }

    if (isRedirect(res)) {
      await res.text().catch(() => undefined); // release the socket
      logger.warn("ServiceNow answered with a redirect; not following it", {
        method,
        path,
        status: res.status,
        ms: Date.now() - started,
      });
      countError(telemetry, res.status);
      telemetry.totalMs += Date.now() - started;
      throw redirectError(`ServiceNow request to ${safeUrl}`, res);
    }

    if (res.status === 401 && !retried401 && getAuthMode() === "oauth") {
      retried401 = true;
      telemetry.retries += 1;
      // Delegated decision 2026-09-26: compare-and-invalidate. Drop the cached
      // token only if it is still the one THIS attempt sent; if a concurrent
      // request already refreshed it, the retry below picks up the fresh one
      // instead of forcing yet another token request.
      const sent = headers.Authorization;
      invalidateToken(
        host,
        sent?.startsWith("Bearer ") ? sent.slice("Bearer ".length) : sent,
      );
      await res.text().catch(() => undefined); // release the socket
      logger.debug("401 with cached OAuth token — re-authenticating once", {
        method,
        path,
      });
      continue;
    }

    if (
      !res.ok &&
      shouldRetryStatus(res.status, method) &&
      attempt < maxRetries
    ) {
      telemetry.retries += 1;
      const wait = retryAfterMs(res) ?? backoffMs(attempt + 1);
      await res.text().catch(() => undefined); // release the socket
      logger.debug("Retrying ServiceNow request", {
        method,
        path,
        status: res.status,
        attempt: attempt + 1,
        waitMs: wait,
      });
      await delay(wait);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      let json: unknown = {};
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          json = { raw: text };
        }
      }
      const detail =
        extractErrorDetail(json) || res.statusText || text || "(no detail)";
      logger.warn("ServiceNow API error", {
        method,
        path,
        status: res.status,
        ms: Date.now() - started,
      });
      countError(telemetry, res.status);
      telemetry.totalMs += Date.now() - started;
      throw new ServiceNowError(
        `ServiceNow API error (${res.status}): ${detail}`,
        res.status,
        json,
      );
    }

    const total = parseTotalCount(res);
    const responseContentType = res.headers.get("content-type") ?? undefined;
    telemetry.totalMs += Date.now() - started;
    logger.debug("ServiceNow request ok", {
      method,
      path,
      status: res.status,
      ms: Date.now() - started,
    });

    // DEV-15 — the mutation is now applied on the instance; journal it before
    // returning. appendWriteJournal never throws, so a file-system failure
    // cannot turn a successful write into an error.
    //
    // Journalled exactly once per call because this point sits past every
    // `continue` in the retry loop, on the loop's sole success path — NOT
    // because writes are never retried. Non-GET requests are in fact retried
    // after a received response: a 429 is retryable for any method
    // (http-util.ts `RETRYABLE_ANY_METHOD`), and the one-shot 401 OAuth
    // re-auth above re-issues the request regardless of method. Moving this
    // call earlier — above either `continue` — would double-journal.
    const journalEntry = journalEntryFor(method, path, body, rawBody, params);
    if (journalEntry) appendWriteJournal(journalEntry);

    if (responseType === "binary") {
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        data: buf.toString("base64") as unknown as T,
        total,
        status: res.status,
        contentType: responseContentType,
      };
    }

    const text = await res.text();
    let json: unknown = {};
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text };
      }
    }
    return {
      data: json as T,
      total,
      status: res.status,
      contentType: responseContentType,
    };
  }
}
