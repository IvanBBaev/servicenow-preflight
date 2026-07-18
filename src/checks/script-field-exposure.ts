import type { Check, CheckResult, CheckStatus } from "../types.js";
import { and, eq, inClause, resolveScope } from "../http/query.js";
import { errorResult, isTruthy, str, triageZeroRead } from "./cert-common.js";

const NAME = "script-field-exposure";

/** The `sys_dictionary.internal_type` values that hold executable server code. */
const SCRIPT_TYPES = ["script", "script_plain", "script_server"] as const;

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Certification rule 1.4 (`ci/certification/CHECKLIST.md`) — Critical severity:
 * no `script`-type column may be writable by non-admins. A script field stores
 * server-side code, so an unprotected one is a privilege
 * escalation: whoever can edit the field executes arbitrary code as the
 * platform.
 *
 * The check lists every script-typed column the app ships (`sys_dictionary`
 * in scope with `internal_type` in {@link SCRIPT_TYPES}) and requires each to
 * be covered by an **active field write ACL** in the same scope — either the
 * exact `table.element` ACL or the table's `table.*` wildcard. A table-level
 * (row) write ACL does not count: certification wants the field itself locked.
 * Whether the ACL is properly role-gated is `acl-role-sanity`'s job.
 *
 * - **fail** — a script column has no matching active field write ACL (or only
 *   an inactive one), or either read was security-trimmed (a partially visible
 *   table cannot clear the gate).
 * - **warn** — the scope is unset, or a zero-row read could not be
 *   distinguished from missing read access.
 * - **pass** — every script column in scope is covered by an active field
 *   write ACL, or the instance itself reports the scope ships none.
 */
export const scriptFieldExposure: Check = {
  name: NAME,
  description:
    "Every script-typed column ships with an active field write ACL.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the script-field write ACL gate (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every column in scope.
      const meta = await ctx.http.table("sys_dictionary").queryWithMeta({
        sysparm_query: and(
          resolvedScope.clause,
          inClause("internal_type", SCRIPT_TYPES),
        ),
        sysparm_fields: "sys_id,name,element,internal_type",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect script-typed columns in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_dictionary; a zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `No script-typed columns in scope "${scope}" — nothing to lock down.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No script-typed columns visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_dictionary. Cannot confirm the field write ACL gate.`,
            );
        }
      }

      // Fetch the scope's field write ACLs once and match client-side — the
      // wildcard name `table.*` cannot travel through the injection-safe query
      // builders (its charset is rightly refused), and an app's own ACL list is
      // small enough to read whole.
      const aclMeta = await ctx.http.table("sys_security_acl").queryWithMeta({
        sysparm_query: and(
          resolvedScope.clause,
          eq("type", "record"),
          eq("operation", "write"),
        ),
        sysparm_fields: "sys_id,name,active",
      });

      const activeAcls = new Set<string>();
      const inactiveAcls = new Set<string>();
      for (const row of aclMeta.rows) {
        const name = str(row, "name").toLowerCase();
        if (name === "") continue;
        if (isTruthy(row, "active")) activeAcls.add(name);
        else inactiveAcls.add(name);
      }

      const aclNamesFor = (row: Record<string, unknown>): string[] => {
        const table = str(row, "name").toLowerCase();
        const element = str(row, "element").toLowerCase();
        if (table === "" || element === "") return [];
        return [`${table}.${element}`, `${table}.*`];
      };

      const missing: string[] = [];
      const inactiveOnly: string[] = [];
      const unverifiable: string[] = [];
      for (const row of meta.rows) {
        const label =
          `${str(row, "name")}.${str(row, "element")}`.replace(
            /^\.|\.$/g,
            "",
          ) ||
          str(row, "sys_id") ||
          "(unnamed)";
        const candidates = aclNamesFor(row);
        if (candidates.length === 0) {
          unverifiable.push(label);
        } else if (candidates.some((n) => activeAcls.has(n))) {
          continue;
        } else if (candidates.some((n) => inactiveAcls.has(n))) {
          inactiveOnly.push(label);
        } else {
          missing.push(label);
        }
      }

      // Concrete findings outrank the trimmed-read verdict: they are already
      // actionable, and the message still flags the incomplete view.
      if (
        missing.length > 0 ||
        inactiveOnly.length > 0 ||
        unverifiable.length > 0
      ) {
        const parts: string[] = [];
        if (missing.length > 0) {
          parts.push(
            `${missing.length} script column(s) have no field write ACL — whoever can write them executes server-side code: ${missing.join(", ")}`,
          );
        }
        if (inactiveOnly.length > 0) {
          parts.push(
            `${inactiveOnly.length} are covered only by an INACTIVE write ACL (an off gate is no gate): ${inactiveOnly.join(", ")}`,
          );
        }
        if (unverifiable.length > 0) {
          parts.push(
            `${unverifiable.length} dictionary row(s) could not be verified (table or element name missing): ${unverifiable.join(", ")}`,
          );
        }
        const trimmedNote =
          meta.securityTrimmed || aclMeta.securityTrimmed
            ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
            : "";
        return result("fail", parts.join("; ") + "." + trimmedNote);
      }

      // The columns this account cannot see are exactly the ones this gate
      // cannot clear — a partially trimmed read never passes (either side).
      if (meta.securityTrimmed || aclMeta.securityTrimmed) {
        return result(
          "fail",
          `Cannot fully inspect the script-field write ACL gate in scope "${scope}" — the ${
            meta.securityTrimmed ? "sys_dictionary" : "sys_security_acl"
          } read was security-trimmed. Grant the account read access; the rows it cannot see are the ones this gate cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${meta.rows.length} script-typed column(s) in scope "${scope}" are covered by an active field write ACL.`,
      );
    } catch (err) {
      return errorResult(NAME, "script-field write ACLs", err);
    }
  },
};
