import type { Check, CheckResult, CheckStatus, Finding } from "../types.js";
import { and, eq, resolveScope } from "../http/query.js";
import {
  errorResult,
  rowFinding,
  str,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";

const NAME = "cross-scope-privileges";
const TABLE = "sys_scope_privilege";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** `<target_name> (<operation>)` — a record name, never matched text. */
function label(row: Record<string, unknown>): string {
  const target = str(row, "target_name") || str(row, "sys_id") || "(unnamed)";
  const operation = str(row, "operation");
  return operation ? `${target} (${operation})` : target;
}

/** `N cross-scope privilege(s) are <state>: a (read), b (execute)`. */
function listed(labels: readonly string[], state: string): string {
  return `${labels.length} cross-scope privilege${
    labels.length === 1 ? " is" : "s are"
  } ${state}: ${labels.join(", ")}.`;
}

/**
 * Cross-scope access the app depends on. A scoped app that calls into another
 * scope needs a `sys_scope_privilege` row on the target instance; at runtime a
 * **denied** privilege blocks the call and a **requested** one blocks it until
 * an admin approves it — both are a runtime failure waiting to happen.
 *
 * Privileges are keyed by the *source* scope, so the read filters on
 * `source_scope=<scope sys_id>` rather than the generic `sys_scope` clause:
 *
 * - **fail** — a privilege is denied, or the read was security-trimmed.
 * - **warn** — a privilege is only requested or carries an unknown status, the
 *   scope is unset or did not resolve to a `sys_scope` record, or a zero-row
 *   read could not be told apart from missing read access.
 * - **pass** — every privilege is allowed, or the instance reports none.
 */
export const crossScopePrivileges: Check = {
  name: NAME,
  description:
    "No cross-scope privilege the app relies on is denied or still only requested.",
  meta: {
    requires: "scope",
    summary:
      "Every cross-scope privilege the scope holds as a source is allowed on the target instance; denied ones fail, requested ones warn.",
    severity: "blocker",
    tables: [TABLE],
    remediation:
      "Approve requested privileges in the target instance or remove the cross-scope call",
    verdicts: {
      pass: "Every cross-scope privilege is allowed, or the scope holds none.",
      warn: "A privilege is only requested or has an unknown status, the scope is unset or did not resolve, or a zero-row read was ambiguous.",
      fail: "A cross-scope privilege is denied, or the read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the cross-scope privilege check (pass a scope to enable it).",
      );
    }

    try {
      const resolved = await resolveScope(ctx, scope);
      if (!resolved.sysId) {
        return result(
          "warn",
          `Cannot check cross-scope privileges for "${scope}": the scope name did not resolve to a sys_scope record.`,
        );
      }

      // No `sysparm_limit`: auto-pagination inspects every privilege.
      const meta = await ctx.http.table(TABLE).queryWithMeta({
        sysparm_query: and(eq("source_scope", resolved.sysId)),
        sysparm_fields:
          "sys_id,source_scope,target_scope,target_name,target_type,operation,status",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect cross-scope privileges in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the read was security-trimmed. Grant the account read access to ${TABLE} to enable this gate.`,
            );
          case "empty":
            return result(
              "pass",
              `No cross-scope privileges in scope "${scope}" — nothing to check.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No cross-scope privileges visible in scope "${scope}" and no pre-trim count arrived — either the app holds none, or the account cannot read ${TABLE}.`,
            );
        }
      }

      const denied: string[] = [];
      const requested: string[] = [];
      let unknown = 0;
      const findings: Finding[] = [];
      for (const row of meta.rows) {
        const status = str(row, "status").toLowerCase();
        if (status === "allowed") continue;
        if (status === "denied") {
          denied.push(label(row));
          findings.push(rowFinding(NAME, TABLE, row, "denied", label));
          continue;
        }
        const kind = status === "requested" ? "requested" : "unknown-status";
        if (status === "requested") requested.push(label(row));
        else unknown += 1;
        const finding = rowFinding(NAME, TABLE, row, kind, label);
        finding.status = "warn";
        findings.push(finding);
      }

      const done = (status: CheckStatus, message: string): CheckResult =>
        withFindings(result(status, message), findings);
      const unknownNote =
        unknown > 0
          ? ` ${unknown} cross-scope privilege${
              unknown === 1 ? " has" : "s have"
            } an unknown status.`
          : "";
      const trimmedNote = meta.securityTrimmed
        ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
        : "";

      if (denied.length > 0) {
        const also =
          requested.length > 0
            ? ` Also ${listed(requested, "only requested")}`
            : "";
        return done(
          "fail",
          listed(denied, "denied") + also + unknownNote + trimmedNote,
        );
      }

      if (meta.securityTrimmed) {
        return done(
          "fail",
          `Cannot fully inspect cross-scope privileges in scope "${scope}" — the ${TABLE} read was security-trimmed. The privileges this account cannot see are the ones this gate cannot clear.`,
        );
      }

      if (requested.length > 0) {
        return done("warn", listed(requested, "only requested") + unknownNote);
      }

      if (unknown > 0) return done("warn", unknownNote.trim());

      return done(
        "pass",
        `All ${meta.rows.length} cross-scope privilege${
          meta.rows.length === 1 ? " is" : "s are"
        } allowed.`,
      );
    } catch (err) {
      return errorResult(NAME, "cross-scope privileges", err);
    }
  },
};
