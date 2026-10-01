// The one read this stage is allowed to perform.
//
// A single method, GET only, one record at a time. Parity is a preflight gate:
// it must be safe to point at both instances in a pipeline, and the way to
// guarantee that is to give it nothing that can write (ARCH-8/ARCH-33).
//
// The port exists so the decision logic is testable without a network, and the
// live adapter goes through `snRequest` — the ARCH-7 canonical transport, with
// its auth, host policy, retry and journal — rather than a second HTTP client
// smuggled in behind it.
//
// ── The DEV-1 error boundary: why `ServiceNowError` is read here ────────────
//
// The 2026-08-26 ruling in `runner-atf/src/client.ts` normalised that package's
// transport faults into one owned type. It does not extend to here, and the
// difference is not tidiness. The runner REJECTS: a `ServiceNowError` escaping
// `Runner.run` reached `@tessera/core` and would have coupled every future
// caller of a `Runner` to a ServiceNow client. This adapter never rejects — it
// converts every fault into a member of the closed `ArtifactRead` union below,
// so no consumer of `ArtifactReader` can meet a transport type at all. That is
// the outcome the ruling was after, reached one layer lower down; the ruling
// says as much in its own carve-out, where `createSnAtfClient` "stays a
// pass-through: it is the far side of the port". An adapter is allowed to know
// its transport; that is what makes it an adapter. `instanceof ServiceNowError`
// becomes a defect here only if it ever moves INWARD, past `ArtifactReader`.
//
// What that costs, and what pins it: the 403 detail below says the read was
// "refused for the connected user", which claims the INSTANCE answered. That
// claim rests on this adapter calling `snRequest` DIRECTLY. `@tessera/sn-client`
// also fabricates a 403 `ServiceNowError`, before any request is sent, when
// `SN_TABLES_ALLOW`/`SN_TABLES_DENY` refuses a table — but that guard
// (`assertTableAllowed`) sits in the `tableApi` layer, which nothing here
// calls. Move this read onto `tableApi` and parity would blame the instance
// for the operator's own environment. The verdict would survive (`undecidable`
// under both readings), the evidence line would not, and the evidence line is
// the entire product of an undecidable row. `@tessera/resolvers` IS on that
// path and words its 403 under both readings for exactly this reason. Pinned by
// "never blames the instance for a denial the client itself fabricated" in
// `test/parity.test.js`.
//
// The same type has a second way of not meaning "the instance answered", and
// it is quieter: a `ServiceNowError` with NO `status` never carried an HTTP
// response at all. `ArtifactRead.status` means "what the instance answered
// with", so neither the field nor the detail line may be filled in from one
// that does not exist. Pinned by "never attributes a status to a read the
// instance never answered" in `test/parity.test.js`; see `NO_STATUS` below.

import {
  ServiceNowError,
  getCredentials,
  resolveHost,
  runWithProfile,
  snRequest,
} from "@tessera/sn-client";

/**
 * `absent` = the instance answered about the row and the row is not there.
 * `undecidable` = it did not answer about the row (403, 401, 5xx, transport,
 * timeout, or an answer about something other than the row).
 */
export interface ArtifactRead {
  readonly outcome: "found" | "absent" | "undecidable";
  /** The requested fields as the instance returned them. */
  readonly record?: Readonly<Record<string, unknown>>;
  readonly status?: number;
  readonly detail: string;
}

/**
 * The normalized instance host behind a profile (lowercase, no scheme, path
 * or port), or why it cannot be named.
 */
export type InstanceHost =
  | { readonly ok: true; readonly host: string }
  | { readonly ok: false; readonly reason: string };

/**
 * The rows of `table` whose `parentField` references `parentSysId` — the
 * related-rows read (delegated decision 2026-09-30, wave 14). `fields` are
 * the child fields to return; `sys_id` and `parentField` always come back too.
 */
export interface RelatedRowsRequest {
  readonly table: string;
  readonly parentField: string;
  readonly parentSysId: string;
  readonly fields: readonly string[];
}

/**
 * `complete` = the instance answered with EVERY matching row, and the reader
 * can show it (a total that equals the rows returned, every row naming the
 * parent). Anything short of that — a page cut by the limit, rows hidden by a
 * row-level ACL, no total to check against, an error — is `undecidable`:
 * a partial set compared as a whole set is a green nobody earned.
 */
export interface RelatedRowsRead {
  readonly outcome: "complete" | "undecidable";
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  readonly status?: number;
  readonly detail: string;
}

export interface ArtifactReader {
  /**
   * Delegated decision 2026-09-26 (review W6a M5): the reader names the
   * instance host behind a profile, so parity compares INSTANCES, not profile
   * names. Must not throw and must not touch the network.
   */
  instanceHost(profile: string): InstanceHost;
  readArtifact(
    profile: string,
    table: string,
    sysId: string,
    fields: readonly string[],
    signal?: AbortSignal,
  ): Promise<ArtifactRead>;
  /**
   * Optional (additive): a reader without it leaves related behaviour
   * uncompared, which keeps such rows `undecidable` exactly as before. Must
   * not throw; GET only.
   */
  readRelated?(
    profile: string,
    request: RelatedRowsRequest,
    signal?: AbortSignal,
  ): Promise<RelatedRowsRead>;
}

/**
 * The page size of a related-rows read. One page, never paginated: a set
 * larger than this is reported `undecidable` rather than stitched together
 * from pages that could shift between requests. An ACL requires a handful of
 * roles; 100 is far above any real one.
 */
export const RELATED_ROW_LIMIT = 100;

/** A table or field name as it may appear in a query this reader builds. */
const NAME_RE = /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

/**
 * A *namespace* 404 ("the URI is not a resource") says the table is not exposed
 * on this instance; a *record* 404 ("No Record found") says the table answered
 * and the row is not there. Same status code, and only the wording separates
 * them — `api/plugin.ts` in `@tessera/sn-client` and the doctor's probe key on
 * the same phrases. The distinction matters here: "there is no such table" is
 * not a statement about the row, so it cannot decide the row.
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

 * Here it read as `absent`: the row is gone, claimed on the strength of an
 * answer that never mentioned the row.
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

/** Set when the caller cancelled before the read reached the instance. */
export const ABORTED_BEFORE_READ =
  "aborted before the read reached the instance";

/**
 * A `ServiceNowError` carrying no `status` never carried an HTTP response
 * either: the transport failed or timed out, or the request never left this
 * client at all (unconfigured instance, missing credentials, host policy).
 * Which of those it was is not knowable from here, so the evidence states the
 * one thing that is — nothing came back — and names both readings rather than
 * picking the one it cannot prove, exactly as the reader's other lines do.
 *
 * What it must never do is render the absent status as a value. An undecidable
 * row's evidence line is the entire product of that row; a status that does not
 * exist, printed in the grammar of one the instance sent, is that product
 * lying. Word-for-word the same line in `@tessera/resolvers` and the doctor's
 * probe — three spellings of one question, and they agree.
 */
const NO_STATUS =
  "no answer was received and there is no HTTP status to report — the " +
  "request either never left this client, or left it and never got a response";

/**
 * A ServiceNow sys_id: 32 lowercase hex characters.
 *
 * Delegated decision 2026-09-25: the sys_id is a PATH SEGMENT of the read, and
 * `encodeURIComponent` leaves `.` and `..` alone, so the WHATWG URL parser
 * normalises `/api/now/table/<t>/..` to `/api/now/table` and `/<t>/.` to
 * `/<t>/` — the LIST endpoint. Its array of rows then came back as a "found"
 * record and two blind reads fingerprinted as a match. Anything that is not
 * shaped like a sys_id is refused before any request is built, and the row is
 * `undecidable`: the read would not have been a statement about that row.
 * Mirrors `isSysId` in `@tessera/resolvers` (`keys.ts`); parity does not
 * depend on that package, so the one-line pattern is repeated, not imported.
 */
const SYS_ID_RE = /^[0-9a-f]{32}$/;

export function isSysId(value: string): boolean {
  return SYS_ID_RE.test(value);
}

/**
 * True for the one shape a single-record read may answer with: a plain JSON
 * object (never an array — the list endpoint's shape) carrying the requested
 * `sys_id`.
 */
function isRecordFor(
  value: unknown,
  sysId: string,
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).sys_id === sysId
  );
}

function shapeOf(value: unknown): string {
  if (Array.isArray(value)) return `an array of ${value.length} item(s)`;
  if (value === null || typeof value !== "object") return typeof value;
  const id = (value as Record<string, unknown>).sys_id;
  return id === undefined
    ? "a record with no sys_id"
    : `a record whose sys_id is ${JSON.stringify(id)}`;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The live adapter: every read goes through the canonical transport (ARCH-7). */
export function createSnArtifactReader(): ArtifactReader {
  return {
    instanceHost(profile) {
      try {
        const instance = getCredentials(profile).instance.trim();
        if (instance === "") {
          return {
            ok: false,
            reason: `profile ${profile} has no instance configured`,
          };
        }
        // The same host normalization every request of this profile goes
        // through, so the compared host is the host that would be read.
        return { ok: true, host: resolveHost(instance).toLowerCase() };
      } catch (error) {
        return {
          ok: false,
          reason: `profile ${profile}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
    async readArtifact(profile, table, sysId, fields, signal) {
      if (aborted(signal)) {
        return { outcome: "undecidable", detail: ABORTED_BEFORE_READ };
      }
      if (!isSysId(sysId)) {
        return {
          outcome: "undecidable",
          detail: `${table}/${JSON.stringify(sysId)} on ${profile}: not a sys_id (32 lowercase hex characters), so no single-record read was sent — the path would not have named one row`,
        };
      }
      // Only the executable fields plus the identity that proves which row
      // answered. Pulling the whole record would drag script bodies of
      // unrelated fields across the wire for no gain.
      const params = new URLSearchParams({
        sysparm_fields: ["sys_id", ...fields].join(","),
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      });
      const path = `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sysId)}`;
      try {
        // Each side reads inside its own profile context, so the transport
        // resolves that instance's credentials, host and policy — the same
        // mechanism `compareApi` uses to diff two instances.
        const res = await runWithProfile(profile, () =>
          snRequest<{ result?: Record<string, unknown> }>({
            method: "GET",
            path,
            params,
          }),
        );
        const record = res.data.result;
        if (record === undefined || record === null) {
          // A 200 with no result: the API answered, the row is not visible.
          // Deleted or ACL-trimmed reads identically here, so the detail says
          // "no readable row" rather than claiming the row is gone.
          return {
            outcome: "absent",
            status: res.status,
            detail: `${table}/${sysId}: no readable row on ${profile}`,
          };
        }
        if (!isRecordFor(record, sysId)) {
          // Delegated decision 2026-09-25: `found` means the instance answered
          // WITH THIS ROW. An array (the list endpoint's shape), a scalar, or a
          // record carrying another sys_id — or none — is an answer about
          // something else, so it decides nothing (fail closed).
          return {
            outcome: "undecidable",
            status: res.status,
            detail: `${table}/${sysId} on ${profile}: the instance answered with ${shapeOf(record)} instead of the requested row`,
          };
        }
        return {
          outcome: "found",
          record,
          status: res.status,
          detail: `${table}/${sysId} read on ${profile}`,
        };
      } catch (error) {
        return classify(profile, table, sysId, error);
      }
    },
    async readRelated(profile, request, signal) {
      const { table, parentField, parentSysId, fields } = request;
      const where = `${table} rows of ${parentField}=${parentSysId} on ${profile}`;
      if (aborted(signal)) {
        return { outcome: "undecidable", detail: ABORTED_BEFORE_READ };
      }
      if (
        !isSysId(parentSysId) ||
        ![table, parentField, ...fields].every((name) => NAME_RE.test(name))
      ) {
        // The query is built by string concatenation; anything that is not a
        // plain name or a sys_id could rewrite it, so nothing is sent.
        return {
          outcome: "undecidable",
          detail: `${where}: the request does not name a table, field and sys_id this reader can put in a query, so no read was sent`,
        };
      }
      const params = new URLSearchParams({
        sysparm_query: `${parentField}=${parentSysId}^ORDERBYsys_id`,
        sysparm_fields: [...new Set(["sys_id", parentField, ...fields])].join(
          ",",
        ),
        sysparm_limit: String(RELATED_ROW_LIMIT),
        sysparm_display_value: "false",
        sysparm_exclude_reference_link: "true",
      });
      try {
        const res = await runWithProfile(profile, () =>
          snRequest<{ result?: unknown }>({
            method: "GET",
            path: `/api/now/table/${encodeURIComponent(table)}`,
            params,
          }),
        );
        return completeRows(where, parentField, parentSysId, res);
      } catch (error) {
        return classifyRelated(where, error);
      }
    },
  };
}

/**
 * A reference as the list endpoint returns it with
 * `sysparm_exclude_reference_link=true`: a plain sys_id string (a `{ value }`
 * wrapper is accepted too, as the single-record read accepts it).
 */
function referenceValue(value: unknown): unknown {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.hasOwn(value, "value")
    ? (value as { value: unknown }).value
    : value;
}

/**
 * Completeness, proven or refused. Delegated decision 2026-09-30 (wave 14):
 * the set is complete only when `X-Total-Count` is present and equals the
 * rows returned (a short page — cut by the limit, or thinned by a row-level
 * read ACL after the database page was fetched — shows as a total larger
 * than the page), and every row names the requested parent (an instance
 * that dropped the query term would otherwise hand back unrelated rows).
 * Residual, named: an instance whose total is itself computed AFTER row-level
 * ACLs would hide a trimmed row from this check.
 */
function completeRows(
  where: string,
  parentField: string,
  parentSysId: string,
  res: { data: { result?: unknown }; total?: number; status: number },
): RelatedRowsRead {
  const { status } = res;
  const rows = res.data.result;
  if (!Array.isArray(rows)) {
    return {
      outcome: "undecidable",
      status,
      detail: `${where}: the instance answered with ${shapeOf(rows)} instead of a list of rows`,
    };
  }
  if (res.total === undefined) {
    return {
      outcome: "undecidable",
      status,
      detail: `${where}: ${rows.length} row(s) came back with no X-Total-Count, so nothing shows the set is complete`,
    };
  }
  if (res.total !== rows.length) {
    return {
      outcome: "undecidable",
      status,
      detail: `${where}: ${rows.length} row(s) returned of ${res.total} matching — the set is truncated (limit ${RELATED_ROW_LIMIT}) or thinned by a read ACL, and a partial set is not the set`,
    };
  }
  const foreign = rows.filter(
    (row: unknown) =>
      row === null ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      referenceValue((row as Record<string, unknown>)[parentField]) !==
        parentSysId,
  );
  if (foreign.length > 0) {
    return {
      outcome: "undecidable",
      status,
      detail: `${where}: ${foreign.length} of ${rows.length} row(s) do not reference the requested parent — the query was not applied as sent`,
    };
  }
  return {
    outcome: "complete",
    rows: rows as Record<string, unknown>[],
    status,
    detail: `${where}: ${rows.length} row(s), complete`,
  };
}

/** Every failed related read is `undecidable`, a 404 included. */
function classifyRelated(where: string, error: unknown): RelatedRowsRead {
  if (error instanceof ServiceNowError) {
    const { status } = error;
    if (status === undefined) {
      return {
        outcome: "undecidable",
        detail: `${where}: ${NO_STATUS} (${error.message})`,
      };
    }
    // A 404 on a list read is either the table not being a resource for this
    // caller or an older release answering "No Record found" for an empty
    // set; the two cannot be told apart safely, so neither reads as "none".
    return {
      outcome: "undecidable",
      status,
      detail:
        status === 403
          ? `${where}: read refused (403) for the connected user`
          : `${where}: ${error.message} (${status})`,
    };
  }
  return { outcome: "undecidable", detail: `${where}: ${describe(error)}` };
}

function classify(
  profile: string,
  table: string,
  sysId: string,
  error: unknown,
): ArtifactRead {
  const where = `${table}/${sysId} on ${profile}`;
  if (error instanceof ServiceNowError) {
    // Destructured once and the status-less case returned immediately, so
    // TypeScript types `status` as `number` below: `status: error.status` can
    // no longer put an absent status on an `ArtifactRead` whose `status` means
    // "what the instance answered with".
    const { status } = error;
    if (status === undefined) {
      // No `status` key at all rather than `status: undefined` — the key's
      // presence is itself a claim that a status was observed, and the object
      // must not make one the detail line refuses to make.
      return {
        outcome: "undecidable",
        detail: `${where}: ${NO_STATUS} (${error.message})`,
      };
    }
    if (status === 404) {
      // The namespace reading is a fact about what THIS session could resolve,
      // not about what the instance holds: a table outside the caller's scope,
      // or one whose plugin is inactive for them, answers exactly like a table
      // that was never installed. The doctor's `classifyTable` words the same
      // status the same way, and for the same reason.
      return NAMESPACE_404.test(namespaceHaystack(error))
        ? {
            outcome: "undecidable",
            status: 404,
            detail:
              `${where}: ${table} is not a resource on this instance for ` +
              `the connected user — either the table is not there at all, ` +
              `or this caller's scope and roles cannot resolve it, and ` +
              `either way nothing was said about the row`,
          }
        : {
            outcome: "absent",
            status: 404,
            detail: `${where}: no readable row`,
          };
    }
    if (status === 403) {
      return {
        outcome: "undecidable",
        status: 403,
        detail: `${where}: read refused (403) for the connected user`,
      };
    }
    return {
      outcome: "undecidable",
      status,
      detail: `${where}: ${error.message}`,
    };
  }
  return { outcome: "undecidable", detail: `${where}: ${describe(error)}` };
}
