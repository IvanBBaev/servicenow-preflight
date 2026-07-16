import type { PreflightContext } from "../types.js";
import type { SnClient } from "./client.js";

/**
 * A validated builder for ServiceNow **encoded queries** (`sysparm_query`).
 *
 * The encoded-query grammar sits ABOVE URL encoding: `^` (AND), `^OR`, `^NQ`,
 * `IN`, `ORDERBY…` are operators the instance parses AFTER it percent-decodes the
 * value. So percent-encoding a value (what `URLSearchParams` does in the client)
 * is NOT a defense — a config value like `x^ORsys_id=…` (or its percent-encoded
 * twin `x%5EORsys_id=…`) survives the transport and re-parses as extra query
 * clauses on the instance (SR-1: encoded-query operator injection).
 *
 * The only robust fix is to reject, at build time, any part that is not a plain
 * ServiceNow identifier / value. Every field and value that flows into a query
 * clause here is charset-validated: identifiers/values must match
 * `[A-Za-z0-9_.-]+` (which admits scope names, 32-hex sys_ids, dot-walked fields
 * and language codes, but rejects both `^` AND `%`). A violation throws an
 * {@link EncodedQueryError} — the caller fails **closed**, never emitting a query
 * built from attacker-influenced operators.
 */

/** Charset of a ServiceNow identifier / plain value that is safe un-escaped. */
const IDENTIFIER = /^[A-Za-z0-9_.-]+$/;

/** A ServiceNow sys_id is exactly 32 lowercase hex characters. */
const SYS_ID = /^[0-9a-f]{32}$/;

/**
 * Default number of ids packed into one `IN (…)` clause when batching an m2m /
 * membership lookup. Keeps each encoded query well within ServiceNow's URL
 * length limit while collapsing an N+1 read pattern to `⌈N / IN_CHUNK_SIZE⌉`
 * queries (SN-6).
 */
export const IN_CHUNK_SIZE = 100;

/**
 * Thrown when a value destined for an encoded query contains characters outside
 * the safe identifier charset — most importantly the query operators `^` / `%`.
 * Signals an injection attempt (or a genuinely malformed input); either way the
 * builder refuses to emit the clause.
 */
export class EncodedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncodedQueryError";
  }
}

/** True when `value` is a plain, un-escaped-safe ServiceNow identifier/value. */
export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value.trim());
}

/** True when `value` is a 32-hex ServiceNow sys_id. */
export function isSysId(value: unknown): value is string {
  return typeof value === "string" && SYS_ID.test(value.trim());
}

/**
 * Validate `value` as a plain identifier/value (trimmed), returning it. Throws
 * an {@link EncodedQueryError} naming `label` when it carries operator or other
 * unsafe characters — the single choke point that stops query injection.
 */
export function assertIdentifier(value: unknown, label = "value"): string {
  if (typeof value !== "string") {
    throw new EncodedQueryError(
      `${label} must be a string, got ${value === null ? "null" : typeof value}.`,
    );
  }
  const trimmed = value.trim();
  if (!IDENTIFIER.test(trimmed)) {
    throw new EncodedQueryError(
      `${label} "${value}" is not a valid ServiceNow identifier/value: only ` +
        `[A-Za-z0-9_.-] are allowed. Encoded-query operators (e.g. "^", "^OR", ` +
        `"%5E") are rejected to prevent query injection.`,
    );
  }
  return trimmed;
}

/**
 * Validate `value` as a 32-hex sys_id (trimmed), returning it. Throws an
 * {@link EncodedQueryError} naming `label` otherwise.
 */
export function assertSysId(value: unknown, label = "sys_id"): string {
  if (typeof value === "string" && SYS_ID.test(value.trim())) {
    return value.trim();
  }
  throw new EncodedQueryError(
    `${label} "${String(value)}" is not a valid 32-hex ServiceNow sys_id.`,
  );
}

/**
 * A single `field=value` equality clause. Both sides are charset-validated, so
 * neither a dot-walked field (`sys_scope.scope`) nor a scope name / sys_id value
 * can smuggle an operator. Fails closed via {@link EncodedQueryError}.
 */
export function eq(field: string, value: string): string {
  return `${assertIdentifier(field, "field")}=${assertIdentifier(value, "value")}`;
}

/**
 * An `IN` membership clause — `field IN v1,v2,…` — for batching a per-id lookup
 * into one query (SN-6). The field and every value are charset-validated; an
 * empty list yields the empty string (the caller should skip the read).
 */
export function inClause(field: string, values: readonly string[]): string {
  const safeField = assertIdentifier(field, "field");
  const safeValues = values.map((v, i) =>
    assertIdentifier(v, `${field}[${i}]`),
  );
  if (safeValues.length === 0) return "";
  return `${safeField}IN${safeValues.join(",")}`;
}

/** Join pre-built clauses with `^` (AND), dropping empties. */
export function and(...clauses: string[]): string {
  return clauses.filter((c) => c !== "").join("^");
}

/** Join pre-built clauses with `^OR` (OR), dropping empties. */
export function or(...clauses: string[]): string {
  return clauses.filter((c) => c !== "").join("^OR");
}

/** Split `items` into consecutive chunks of at most `size` (default IN_CHUNK_SIZE). */
export function chunk<T>(
  items: readonly T[],
  size: number = IN_CHUNK_SIZE,
): T[][] {
  // Guard against a non-finite `size` (NaN/Infinity): `i += step` would never
  // advance past the first iteration's non-finite value, silently returning an
  // empty result and dropping every item. Fall back to the default in that case.
  const step = Number.isFinite(size)
    ? Math.max(1, Math.floor(size))
    : IN_CHUNK_SIZE;
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

/**
 * The single-term scope filter for a target scope, WITHOUT a lookup: a 32-hex
 * sys_id filters directly by `sys_scope=<sysId>`; any other (name) value
 * dot-walks by `sys_scope.scope=<name>`. Because it is one term (not an OR pair)
 * it composes safely under `^` (AND) with other clauses — an OR-form scope would
 * only bind the last AND branch and silently widen the result set. Charset-
 * validated, so it fails closed on operator characters (SR-1).
 */
export function scopeFilterClause(scope: string): string {
  const s = String(scope).trim();
  return isSysId(s) ? eq("sys_scope", s) : eq("sys_scope.scope", s);
}

/**
 * A scope resolved to its canonical query form. `sysId` is set when the
 * `sys_scope` row was found (by name or by sys_id); `clause` is the single-term
 * encoded-query fragment to AND into any table read.
 */
export interface ResolvedScope {
  /** The validated, trimmed scope input (a name or a sys_id). */
  input: string;
  /** The resolved scoped-app sys_id, when the `sys_scope` lookup found a row. */
  sysId?: string;
  /**
   * The single-term scope filter clause. `sys_scope=<sysId>` when resolved (the
   * canonical form that filters identically on every table); otherwise the
   * fail-closed fallback from {@link scopeFilterClause} (`sys_scope=<sysId>` for a
   * sys_id input, else `sys_scope.scope=<name>`). A genuinely-wrong scope simply
   * matches no rows — never a vacuous match — so the caller's own zero-row /
   * security-trimming logic decides the verdict (SN-4).
   */
  clause: string;
}

/** Read a string cell, unwrapping a `{ value }` reference object; "" when absent. */
function cell(row: Record<string, unknown>, name: string): string {
  const v = row[name];
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object" && "value" in v) {
    const inner = (v as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim();
  }
  return "";
}

/**
 * Per-run cache of scope resolutions, keyed on the {@link PreflightContext} the
 * checks share (so a scope is resolved ONCE per run, even across checks — the
 * ACL check and the i18n check that name the same scope trigger a single
 * `sys_scope` read). The value is the in-flight Promise, so concurrent callers
 * dedupe rather than racing two identical reads.
 */
const scopeCache = new WeakMap<
  PreflightContext,
  Map<string, Promise<ResolvedScope>>
>();

/** Look the scope up in `sys_scope` (by sys_id OR scope name) and build its clause. */
async function lookupScope(
  http: SnClient,
  input: string,
): Promise<ResolvedScope> {
  // Validate the input up front (also builds the fail-closed fallback clause);
  // an operator-bearing scope rejects here before any query is issued.
  const fallback = scopeFilterClause(input);
  const rows = await http.table("sys_scope").query({
    sysparm_query: or(eq("sys_id", input), eq("scope", input)),
    sysparm_fields: "sys_id,scope",
  });
  const sysId = rows.map((r) => cell(r, "sys_id")).find((id) => isSysId(id));
  if (sysId) {
    return { input, sysId, clause: eq("sys_scope", sysId) };
  }
  return { input, clause: fallback };
}

/**
 * Resolve a target scope (a scope NAME or a scoped-app SYS_ID) to its canonical
 * query form ONCE per run, caching on `ctx`. The returned {@link ResolvedScope}
 * carries a single-term `clause` that every check ANDs into its table reads, so
 * the same scope — however it was expressed — filters identically everywhere
 * (SN-4). Resolution reads `sys_scope`; a read failure propagates so the calling
 * check maps it to its usual auth/network/HTTP verdict.
 *
 * Fail-closed: an operator-bearing scope throws {@link EncodedQueryError} (never
 * a query); a scope that resolves to no `sys_scope` row still yields a valid,
 * charset-safe fallback clause that simply matches nothing rather than widening.
 */
export function resolveScope(
  ctx: PreflightContext,
  scope: string,
): Promise<ResolvedScope> {
  const input = String(scope).trim();
  let perCtx = scopeCache.get(ctx);
  if (!perCtx) {
    perCtx = new Map();
    scopeCache.set(ctx, perCtx);
  }
  let inflight = perCtx.get(input);
  if (!inflight) {
    inflight = lookupScope(ctx.http, input);
    perCtx.set(input, inflight);
  }
  return inflight;
}
