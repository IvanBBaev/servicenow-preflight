import type { Check, CheckResult, CheckStatus } from "../types.js";
import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  type SnClient,
  type TableQueryResult,
} from "../http/client.js";
import {
  and,
  chunk,
  eq,
  inClause,
  isSafeIdentifier,
  isSysId,
  resolveScope,
  type ResolvedScope,
} from "../http/query.js";

const NAME = "default-set-leakage";

/** Upper bound on the sample names quoted in a fail message (OPP-3). */
const MAX_SAMPLES = 5;

/** Upper bound on the Default-set names quoted in a fail message (OPP-3). */
const MAX_SET_LABELS = 3;

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Read a string-ish field from a row, unwrapping a `{ value }` reference; "" when absent. */
function str(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // ServiceNow reference fields arrive as { link, value, display_value }.
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim();
  }
  return "";
}

/**
 * The single-term application filter for the update-set tables. The shared
 * resolver's generic clause targets a `sys_scope` column, but `sys_update_set`
 * and `sys_update_xml` link a record to its owning app through the
 * `application` reference instead — so the resolved sys_id filters by
 * `application=<sysId>`, a sys_id input falls back to the same form, and an
 * unresolved scope NAME dot-walks by `application.scope=<name>` (OPP-3). Every
 * branch goes through the validated builder, so an operator-bearing value fails
 * closed instead of widening the query (SR-1).
 */
function applicationClause(resolved: ResolvedScope): string {
  if (resolved.sysId) return eq("application", resolved.sysId);
  const input = resolved.input;
  return isSysId(input)
    ? eq("application", input)
    : eq("application.scope", input);
}

/**
 * Fetch EVERY Default update set on the instance (`is_default=true`), not just
 * the target scope's own — a change attributed to the target scope can also be
 * stranded in another scope's (or the global) "Default" set, and only the full
 * list catches that (OPP-3). Uses `queryWithMeta` so the caller can tell a
 * genuine zero-row read apart from ACL security-trimming (SN-1). No
 * `sysparm_limit`: the client auto-paginates, so an instance with more scopes
 * (one Default set each) than a single page is never truncated.
 */
async function fetchDefaultSets(http: SnClient): Promise<TableQueryResult> {
  return http.table("sys_update_set").queryWithMeta({
    sysparm_query: eq("is_default", "true"),
    sysparm_fields: "sys_id,name",
  });
}

/**
 * Fetch the customer updates (`sys_update_xml`) that belong to the target
 * application but were recorded in one of the given Default sets. The set ids
 * are packed into `update_setIN…` membership clauses of at most one chunk each
 * (SN-6), ANDed with the application filter, so N Default sets cost
 * `⌈N / IN_CHUNK_SIZE⌉` queries. Every id and the application clause go through
 * the validated builder (SR-1). Uses `queryWithMeta` per chunk and folds the
 * security-trimmed signals together, so a leak the account cannot SEE still
 * blocks a green verdict (SN-1).
 */
async function fetchLeakage(
  http: SnClient,
  defaultSetIds: readonly string[],
  appClause: string,
): Promise<{ rows: Record<string, unknown>[]; securityTrimmed: boolean }> {
  const rows: Record<string, unknown>[] = [];
  let securityTrimmed = false;
  for (const ids of chunk(defaultSetIds)) {
    const page = await http.table("sys_update_xml").queryWithMeta({
      sysparm_query: and(inClause("update_set", ids), appClause),
      sysparm_fields: "sys_id,name,target_name,update_set",
    });
    rows.push(...page.rows);
    securityTrimmed ||= page.securityTrimmed;
  }
  return { rows, securityTrimmed };
}

/** A human-friendly label for one leaked update row. */
function updateLabel(row: Record<string, unknown>): string {
  return (
    str(row, "target_name") || str(row, "name") || str(row, "sys_id") || "?"
  );
}

/**
 * Render up to `cap` labels as a quoted, DETERMINISTICALLY ordered list —
 * plain code-unit sort, independent of the instance's row order — with a
 * `(+N more)` tail when truncated (OPP-3).
 */
function sampleList(labels: readonly string[], cap: number): string {
  const sorted = [...labels].sort();
  const shown = sorted
    .slice(0, cap)
    .map((label) => `"${label}"`)
    .join(", ");
  const more = sorted.length - cap;
  return more > 0 ? `${shown} (+${more} more)` : shown;
}

/**
 * Detects work silently stranded in a "Default" update set: customer updates
 * (`sys_update_xml`) that belong to the target application scope but were
 * recorded in an `is_default=true` update set. Such changes will NOT ship with
 * the named update set — a classic silent deployment gap (OPP-3).
 *
 * The target scope is resolved once per run via the shared resolver (a scope
 * name or a scoped-app sys_id behave identically). The lookup is two-step:
 * every Default set's sys_id first, then the target scope's updates filtered by
 * `update_setIN…` — batched (SN-6) and fully charset-validated (SR-1).
 *
 * - **fail** — one or more updates in the target scope sit in a Default update
 *   set (count plus a bounded, deterministic sample of update names), or the
 *   read failed for auth/network reasons.
 * - **warn** — no scope is configured (nothing to verify); no Default set is
 *   visible at all (cannot verify); zero rows are visible but the
 *   security-trimming signal fired (unverified — never a false pass, SN-1); or
 *   an unexpected/HTTP error left the leakage unverified.
 * - **pass** — Default sets were read cleanly and none holds a change in the
 *   target scope.
 *
 * Never throws: `SnAuthError` / `SnNetworkError` map to `fail`, other transport
 * errors map to `warn`.
 */
export const defaultSetLeakage: Check = {
  name: NAME,
  description:
    "No work in the target scope is stranded in a Default update set.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No target scope set (PreflightContext.scope); nothing to verify — skipping the Default-set leakage check.",
      );
    }

    try {
      // Resolve the scope once per run (cached on ctx, shared across checks)
      // so a scope name and its sys_id filter identically (SN-4).
      const resolved = await resolveScope(ctx, scope);
      const appClause = applicationClause(resolved);

      const defaults = await fetchDefaultSets(ctx.http);
      const defaultIds: string[] = [];
      const nameById = new Map<string, string>();
      // A Default-set row whose sys_id is unusable in a query cannot be
      // inspected — counted and surfaced as unverified, never silently
      // dropped (OPP-3).
      let unusableIds = 0;
      for (const row of defaults.rows) {
        const id = str(row, "sys_id");
        if (isSafeIdentifier(id)) {
          defaultIds.push(id);
          nameById.set(id, str(row, "name"));
        } else {
          unusableIds++;
        }
      }

      if (defaultIds.length === 0) {
        // Every instance carries at least the global "Default" set, so an
        // empty read means the gate cannot see what it must inspect —
        // trimmed or not, this is never a pass (SN-1).
        if (defaults.securityTrimmed) {
          return result(
            "warn",
            `Cannot verify Default-set leakage for scope "${scope}": ${
              defaults.totalCount ?? "some"
            } Default update set(s) exist but none are visible — the account's sys_update_set reads are security-trimmed. Grant read access; leakage is unverified.`,
          );
        }
        return result(
          "warn",
          `Cannot verify Default-set leakage for scope "${scope}": no Default update sets are visible (every instance carries at least the global "Default" set) — the account may lack read access to sys_update_set; leakage is unverified.`,
        );
      }

      const leaks = await fetchLeakage(ctx.http, defaultIds, appClause);

      if (leaks.rows.length > 0) {
        const labels = leaks.rows.map(updateLabel);
        const setLabels = new Set<string>();
        for (const row of leaks.rows) {
          const setId = str(row, "update_set");
          setLabels.add(nameById.get(setId) || setId || "(unnamed)");
        }
        // Visible rows already prove the gap; trimming only means the true
        // count is even higher (SN-1).
        const count = leaks.securityTrimmed
          ? `at least ${leaks.rows.length}`
          : `${leaks.rows.length}`;
        return result(
          "fail",
          `${count} change(s) in scope "${scope}" are recorded in a Default update set (${sampleList(
            [...setLabels],
            MAX_SET_LABELS,
          )}) and will NOT ship with the named update set: ${sampleList(
            labels,
            MAX_SAMPLES,
          )}. Move them into a deployable update set before promoting.`,
        );
      }

      // Zero visible leaks is only proof when nothing was hidden from the
      // read — a trimmed read (or an uninspectable Default set) must never
      // turn into a green verdict (SN-1).
      const unverified: string[] = [];
      if (defaults.securityTrimmed) {
        unverified.push(
          `only ${defaults.rows.length} of ${
            defaults.totalCount ?? "?"
          } Default update set(s) are visible (sys_update_set is security-trimmed)`,
        );
      }
      if (unusableIds > 0) {
        unverified.push(
          `${unusableIds} Default update set row(s) carried an unusable sys_id and could not be inspected`,
        );
      }
      if (leaks.securityTrimmed) {
        unverified.push(
          "matching sys_update_xml rows exist that the account cannot see (security-trimmed)",
        );
      }
      if (unverified.length > 0) {
        return result(
          "warn",
          `No Default-set leakage visible in scope "${scope}", but the result is unverified: ${unverified.join(
            "; ",
          )}. A zero-row read here is not proof — grant the account full read on sys_update_set / sys_update_xml.`,
        );
      }

      return result(
        "pass",
        `No changes in scope "${scope}" are sitting in a Default update set (${defaultIds.length} Default set(s) checked).`,
      );
    } catch (err) {
      if (err instanceof SnAuthError) {
        return result(
          "fail",
          "Authentication failed while reading sys_update_set / sys_update_xml; cannot verify Default-set leakage.",
        );
      }
      if (err instanceof SnNetworkError) {
        return result(
          "fail",
          `Could not reach the instance to verify Default-set leakage: ${err.message}`,
        );
      }
      if (err instanceof SnHttpError) {
        // The tables may be unavailable to this account — advisory.
        return result(
          "warn",
          `Could not read the update-set tables (HTTP ${err.status}); Default-set leakage is unverified.`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return result(
        "warn",
        `Unexpected error while checking Default-set leakage: ${message}; leakage is unverified.`,
      );
    }
  },
};
