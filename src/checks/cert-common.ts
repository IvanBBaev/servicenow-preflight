/**
 * Helpers shared by the ServiceNow Store **certification checks** — the checks
 * derived from the recurring ServiceNow scoped-app certification findings, gated
 * by `ci/certification/CHECKLIST.md`. Each check queries live instance metadata
 * (the rules the text scanner `ci/certification/scan.sh` explicitly cannot
 * cover), so they all share the same read-triage and error-mapping semantics
 * rather than re-deriving them per file.
 */

import type { CheckResult, CheckStatus } from "../types.js";
import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  type SnClient,
  type TableQueryResult,
} from "../http/client.js";
import { and, chunk, eq, inClause } from "../http/query.js";

/** Read a string-ish field from an arbitrary record, trimmed; "" when absent. */
export function str(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // ServiceNow reference fields may arrive as { value, link, display_value }.
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim();
  }
  return "";
}

/** ServiceNow encodes booleans as "true"/"false" strings or real booleans. */
export function isTruthy(row: Record<string, unknown>, field: string): boolean {
  const value = row[field];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

/**
 * What a **zero-row** metadata read actually proved. A zero-row read is not
 * proof of a clean app (SN-1): the account may simply be unable to see the
 * rows. `queryWithMeta`'s pre-trim `X-Total-Count` disambiguates:
 *
 * - `"trimmed"` — rows match but none are visible: the account is
 *   security-trimmed and the gate cannot see what it must inspect.
 * - `"empty"` — the instance itself reports 0 matching rows: genuinely none.
 * - `"ambiguous"` — no pre-trim count arrived, so "none shipped" and "no read
 *   access" are indistinguishable; the verdict must not be a plain pass.
 */
export type ZeroReadTriage = "trimmed" | "empty" | "ambiguous";

/** Triage a zero-row {@link TableQueryResult} — see {@link ZeroReadTriage}. */
export function triageZeroRead(meta: TableQueryResult): ZeroReadTriage {
  if (meta.securityTrimmed) return "trimmed";
  if (meta.totalCount === 0) return "empty";
  return "ambiguous";
}

/**
 * Map a thrown error to the shared certification-check verdict: auth failures
 * fail (the gate could not prove anything and the run itself is broken),
 * network / HTTP errors warn (degraded — the instance or table was not
 * reachable), and anything else — including an {@link EncodedQueryError} from
 * the injection-safe query builders — fails closed. `subject` names what was
 * being inspected so the message stays actionable per check.
 */
export function errorResult(
  name: string,
  subject: string,
  err: unknown,
): CheckResult {
  const result = (status: CheckStatus, message: string): CheckResult => ({
    name,
    status,
    message,
  });
  if (err instanceof SnAuthError) {
    return result(
      "fail",
      `Authentication failed while checking ${subject}${err.status ? ` (${err.status})` : ""}: ${err.message}`,
    );
  }
  if (err instanceof SnNetworkError) {
    return result(
      "warn",
      `Could not reach the instance to check ${subject}: ${err.message}`,
    );
  }
  if (err instanceof SnHttpError) {
    return result(
      "warn",
      `Could not read the tables behind ${subject} (HTTP ${err.status}): ${err.message}`,
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return result(
    "fail",
    `Unexpected error while checking ${subject}: ${message}`,
  );
}

/**
 * The ACLs of one `type` gating one `operation` whose `name` is among
 * `candidateNames`, fetched in batches. `names` holds every matching ACTIVE
 * ACL's lowercased name; `inactiveNames` the ones that exist but are switched
 * off (an off gate is no gate); `trimmed` is true when any batch was
 * security-trimmed (`sys_security_acl` is admin-read out-of-box, so a
 * partially readable ACL table must never clear a gate). Names are matched
 * exactly (case-insensitive); every one is charset-validated by `inClause`.
 */
export async function fetchNamedAcls(
  http: SnClient,
  type: string,
  operation: string,
  candidateNames: readonly string[],
): Promise<{
  names: Set<string>;
  inactiveNames: Set<string>;
  trimmed: boolean;
}> {
  const names = new Set<string>();
  const inactiveNames = new Set<string>();
  let trimmed = false;
  for (const batch of chunk(candidateNames)) {
    // No `sysparm_limit`: the client auto-paginates, so every matching ACL in
    // the batch is seen (a cap could hide the one ACL that gates an artifact).
    const { rows, securityTrimmed } = await http
      .table("sys_security_acl")
      .queryWithMeta({
        sysparm_query: and(eq("type", type), inClause("name", batch)),
        sysparm_fields: "sys_id,name,operation,active",
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      const name = str(row, "name").toLowerCase();
      if (name === "" || str(row, "operation").toLowerCase() !== operation) {
        continue;
      }
      if (isTruthy(row, "active")) names.add(name);
      else inactiveNames.add(name);
    }
  }
  return { names, inactiveNames, trimmed };
}
