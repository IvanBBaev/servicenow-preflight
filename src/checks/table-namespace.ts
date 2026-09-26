import type { Check, CheckResult, CheckStatus } from "../types.js";
import { isSysId, resolveScope } from "../http/query.js";
import { errorResult, str, triageZeroRead } from "./cert-common.js";

const NAME = "table-namespace";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Certification rule 6.1 (`ci/certification/CHECKLIST.md`) — raised in 8 of
 * 19 releases: every custom table is prefixed with the app namespace
 * (`x_acme_app_asset` in scope `x_acme_app`). A table outside the namespace is
 * not cleanly owned by the app, so uninstall and upgrade break on it.
 *
 * The namespace is the scope NAME, taken from the resolved `sys_scope` row (so
 * a scope configured by sys_id works too), else the configured name itself.
 * Every table in the scope must start with `<namespace>_` (case-insensitive).
 *
 * - **fail** — a table in scope is not namespaced, or the table read was
 *   security-trimmed (a partially visible table cannot clear the gate).
 * - **warn** — the scope is unset, is `global` (no namespace to enforce), was
 *   given as a sys_id that did not resolve to a name, or a zero-row read could
 *   not be distinguished from missing read access.
 * - **pass** — every table in scope carries the namespace prefix, or the
 *   instance itself reports the scope ships none.
 */
export const tableNamespace: Check = {
  name: NAME,
  description: "Every custom table is prefixed with the app's scope namespace.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the table namespace check (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      const namespace = resolvedScope.name ?? (isSysId(scope) ? "" : scope);
      if (namespace === "") {
        return result(
          "warn",
          `Scope "${scope}" did not resolve to a scope name, so the app namespace is unknown — cannot check table prefixes. Grant the account read access to sys_scope, or configure the scope by name.`,
        );
      }
      if (namespace.toLowerCase() === "global") {
        return result(
          "warn",
          `Scope "${scope}" is the global scope, which has no app namespace to enforce — the table namespace check applies to scoped apps.`,
        );
      }

      // No `sysparm_limit`: auto-pagination inspects every table in the scope.
      const meta = await ctx.http.table("sys_db_object").queryWithMeta({
        sysparm_query: resolvedScope.clause,
        sysparm_fields: "sys_id,name",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect the tables in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_db_object; a zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `No tables in scope "${scope}" — nothing to check.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No tables visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_db_object. Cannot confirm the table namespace check.`,
            );
        }
      }

      const prefix = `${namespace.toLowerCase()}_`;
      const offending = meta.rows
        .filter((row) => !str(row, "name").toLowerCase().startsWith(prefix))
        .map((row) => str(row, "name") || `(unnamed ${str(row, "sys_id")})`);

      if (offending.length > 0) {
        const note = meta.securityTrimmed
          ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
          : "";
        return result(
          "fail",
          `${offending.length} table(s) in scope "${scope}" are not prefixed with the app namespace "${prefix}" — uninstall and upgrade can break on them: ${offending.join(", ")}.${note}`,
        );
      }

      // The tables this account cannot see are exactly the ones this gate
      // cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed) {
        return result(
          "fail",
          `Cannot fully inspect the table namespace in scope "${scope}" — the sys_db_object read was security-trimmed. Grant the account read access; the tables it cannot see are the ones this gate cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${meta.rows.length} table(s) in scope "${scope}" are prefixed with the app namespace "${prefix}".`,
      );
    } catch (err) {
      return errorResult(NAME, "table namespaces", err);
    }
  },
};
