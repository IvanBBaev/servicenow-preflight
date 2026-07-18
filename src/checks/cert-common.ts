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
  type TableQueryResult,
} from "../http/client.js";

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
