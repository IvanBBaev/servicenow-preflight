import type { Check, CheckResult, CheckStatus } from "../types.js";
import { and, eq, resolveScope } from "../http/query.js";
import type { TableQueryResult } from "../http/client.js";
import { errorResult, str, triageZeroRead } from "./cert-common.js";

const NAME = "mobile-menu-hygiene";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Display handle for a menu/module row in messages. */
function label(row: Record<string, unknown>): string {
  return (
    str(row, "title") || str(row, "name") || str(row, "sys_id") || "(unnamed)"
  );
}

/**
 * Certification rule 5.1 (`ci/certification/CHECKLIST.md`) — a Low-severity but
 * very common usability finding: a non-mobile app must not ship mobile
 * Application Menus or Modules. The
 * mobile scaffolding is auto-created alongside the desktop records and gets
 * packaged unnoticed; reviewers flag every one.
 *
 * The check queries the app's `sys_app_application` (menus) and
 * `sys_app_module` (modules) records with `device_type=mobile` — the table
 * names verified against a live instance (the platform stores both browser and
 * mobile menus there, discriminated by `device_type`).
 *
 * - **warn** — mobile menus/modules exist in scope (remove them unless the app
 *   intentionally targets mobile), a read was security-trimmed, the scope is
 *   unset, or a zero-row read could not be distinguished from missing read
 *   access. (Packaging hygiene, not a security hole — findings stay advisory.)
 * - **pass** — the instance itself reports the scope ships no mobile menus or
 *   modules.
 */
export const mobileMenuHygiene: Check = {
  name: NAME,
  description: "No mobile Application Menus/Modules ship in a non-mobile app.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the mobile menu/module gate (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      const query = and(resolvedScope.clause, eq("device_type", "mobile"));
      // No `sysparm_limit`: auto-pagination inspects every record in scope.
      const [menus, modules] = await Promise.all([
        ctx.http.table("sys_app_application").queryWithMeta({
          sysparm_query: query,
          sysparm_fields: "sys_id,title,name",
        }),
        ctx.http.table("sys_app_module").queryWithMeta({
          sysparm_query: query,
          sysparm_fields: "sys_id,title,name",
        }),
      ]);

      const offenders: string[] = [];
      for (const row of menus.rows) offenders.push(`menu "${label(row)}"`);
      for (const row of modules.rows) offenders.push(`module "${label(row)}"`);

      if (offenders.length > 0) {
        const trimmedNote =
          menus.securityTrimmed || modules.securityTrimmed
            ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
            : "";
        return result(
          "warn",
          `${offenders.length} mobile Application Menu/Module record(s) ship in scope "${scope}" — remove or deactivate them unless the app intentionally targets mobile: ${offenders.join(", ")}.` +
            trimmedNote,
        );
      }

      // Zero offenders only counts when both zero-row reads are proven empty;
      // a trimmed or count-less read cannot confirm the scaffolding is gone.
      const unproven = (meta: TableQueryResult): boolean =>
        triageZeroRead(meta) !== "empty";
      if (unproven(menus) || unproven(modules)) {
        const table = unproven(menus)
          ? "sys_app_application"
          : "sys_app_module";
        return result(
          "warn",
          `No mobile menus/modules visible in scope "${scope}", but the ${table} read could not prove the scope ships none (security-trimmed or no pre-trim count). Cannot confirm the mobile hygiene gate.`,
        );
      }

      return result(
        "pass",
        `No mobile Application Menus or Modules in scope "${scope}".`,
      );
    } catch (err) {
      return errorResult(NAME, "mobile Application Menus/Modules", err);
    }
  },
};
