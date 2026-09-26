import type { Check, CheckResult, CheckStatus } from "../types.js";
import type { SnClient } from "../http/client.js";
import {
  and,
  chunk,
  eq,
  inClause,
  isSysId,
  resolveScope,
} from "../http/query.js";
import { errorResult, isTruthy, str, triageZeroRead } from "./cert-common.js";

const NAME = "module-roles";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** A `roles` glide_list holds comma-separated role names; blank entries don't count. */
function hasRoles(row: Record<string, unknown>): boolean {
  return str(row, "roles")
    .split(",")
    .some((role) => role.trim() !== "");
}

/** Display handle for one module. */
function labelOf(row: Record<string, unknown>): string {
  return str(row, "title") || str(row, "sys_id") || "(untitled)";
}

/**
 * The application menus (`sys_app_application`) with the given sys_ids,
 * mapped to whether each carries roles. Menus are looked up by id rather than
 * by scope: a module can sit under another app's menu. `trimmed` is true when
 * any batch was security-trimmed.
 */
async function fetchMenus(
  http: SnClient,
  ids: readonly string[],
): Promise<{
  menus: Map<string, { title: string; gated: boolean }>;
  trimmed: boolean;
}> {
  const menus = new Map<string, { title: string; gated: boolean }>();
  let trimmed = false;
  for (const batch of chunk(ids)) {
    // No `sysparm_limit`: the client auto-paginates, so every menu is seen.
    const { rows, securityTrimmed } = await http
      .table("sys_app_application")
      .queryWithMeta({
        sysparm_query: inClause("sys_id", batch),
        sysparm_fields: "sys_id,title,roles",
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      menus.set(str(row, "sys_id"), {
        title: str(row, "title") || str(row, "sys_id"),
        gated: hasRoles(row),
      });
    }
  }
  return { menus, trimmed };
}

/**
 * Certification rule 5.5 (`ci/certification/CHECKLIST.md`) — raised in 6 of
 * 19 releases: navigator modules carry roles so they do not show for everyone.
 *
 * Mirrors how the platform decides visibility. A module is shown only to users
 * who pass its application menu's roles AND its own roles — unless
 * `override_menu_roles` is set, when its own roles alone decide. So an active,
 * role-less module is exposed when its menu also has no roles, when it
 * overrides the menu's roles, or when it has no menu; one under a role-gated
 * menu is already gated. Separators (`link_type` `SEPARATOR`) are skipped.
 *
 * A usability finding the rule lets you resolve or justify, so it stays
 * advisory — the check never fails:
 *
 * - **warn** — an exposed module (grouped by cause), a module whose menu
 *   could not be read, the scope is unset, or a read was trimmed or ambiguous.
 * - **pass** — every active module in scope is gated by its own or its menu's
 *   roles, or the instance itself reports the scope ships none.
 */
export const moduleRoles: Check = {
  name: NAME,
  description:
    "Navigator modules are gated by their own or their menu's roles. Advisory.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the navigator module roles check (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every module in scope.
      const meta = await ctx.http.table("sys_app_module").queryWithMeta({
        sysparm_query: and(resolvedScope.clause, eq("active", "true")),
        sysparm_fields:
          "sys_id,title,link_type,roles,application,override_menu_roles",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "warn",
              `Cannot inspect navigator modules in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_app_module to enable this check.`,
            );
          case "empty":
            return result(
              "pass",
              `No active navigator modules in scope "${scope}" — nothing to check.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No active navigator modules visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_app_module. Cannot confirm module roles.`,
            );
        }
      }

      const overrides: string[] = [];
      const noMenu: string[] = [];
      const unreadableMenu: string[] = [];
      const pending: { label: string; menuId: string }[] = [];
      let inspected = 0;
      for (const row of meta.rows) {
        if (str(row, "link_type").toUpperCase() === "SEPARATOR") continue;
        inspected += 1;
        if (hasRoles(row)) continue;
        const label = labelOf(row);
        if (isTruthy(row, "override_menu_roles")) {
          overrides.push(label);
          continue;
        }
        const menuId = str(row, "application");
        if (menuId === "") noMenu.push(label);
        else if (!isSysId(menuId)) unreadableMenu.push(label);
        else pending.push({ label, menuId });
      }

      const { menus, trimmed: menusTrimmed } = await fetchMenus(ctx.http, [
        ...new Set(pending.map((p) => p.menuId)),
      ]);
      // Group role-less modules under role-less menus by menu, for a
      // message that points at the one place a single fix would cover.
      const byOpenMenu = new Map<string, string[]>();
      for (const { label, menuId } of pending) {
        const menu = menus.get(menuId);
        if (!menu) {
          unreadableMenu.push(label);
          continue;
        }
        if (menu.gated) continue;
        const list = byOpenMenu.get(menu.title) ?? [];
        list.push(label);
        byOpenMenu.set(menu.title, list);
      }

      const parts: string[] = [];
      for (const [menu, labels] of byOpenMenu) {
        parts.push(
          `${labels.length} module(s) under menu "${menu}", which has no roles either — shown to every user: ${labels.join(", ")}`,
        );
      }
      if (overrides.length > 0) {
        parts.push(
          `${overrides.length} module(s) override the menu's roles but have none of their own: ${overrides.join(", ")}`,
        );
      }
      if (noMenu.length > 0) {
        parts.push(
          `${noMenu.length} module(s) have no roles and no application menu: ${noMenu.join(", ")}`,
        );
      }
      if (unreadableMenu.length > 0) {
        parts.push(
          `${unreadableMenu.length} role-less module(s) could not be verified (application menu not readable): ${unreadableMenu.join(", ")}`,
        );
      }

      const blind: string[] = [];
      if (meta.securityTrimmed) blind.push("sys_app_module");
      if (menusTrimmed) blind.push("sys_app_application");
      const blindNote =
        blind.length > 0
          ? ` (Note: the ${blind.join(" and ")} read was security-trimmed, so this may be incomplete.)`
          : "";

      if (parts.length > 0) {
        return result(
          "warn",
          `${parts.join("; ")}. Add roles to the modules or their menu.` +
            blindNote,
        );
      }
      if (blind.length > 0) {
        return result(
          "warn",
          `Cannot fully confirm navigator module roles in scope "${scope}" — the ${blind.join(" and ")} read was security-trimmed. Grant the account read access to enable this check.`,
        );
      }
      return result(
        "pass",
        `All ${inspected} active navigator module(s) in scope "${scope}" are gated by their own or their menu's roles.`,
      );
    } catch (err) {
      return errorResult(NAME, "navigator module roles", err);
    }
  },
};
