import type { Check, CheckResult, CheckStatus } from "../types.js";
import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  type SnClient,
} from "../http/client.js";

const NAME = "acl-role-sanity";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Read a string-ish field from an arbitrary record, trimmed; "" when absent. */
function str(row: Record<string, unknown>, field: string): string {
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
function isTruthy(row: Record<string, unknown>, field: string): boolean {
  const value = row[field];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

/** An operation ACL — write/create/delete — with no gate is the dangerous case. */
const MUTATING_OPERATIONS = new Set(["write", "create", "delete"]);

/**
 * Query every `sys_security_acl` row for the given scope. The scope filter uses
 * `sys_scope` (the app sys_id / scope name); ServiceNow accepts either via an
 * OR-encoded query so both a sys_id and a scope name resolve.
 */
async function fetchAcls(
  http: SnClient,
  scope: string,
): Promise<Record<string, unknown>[]> {
  return http.table("sys_security_acl").query({
    sysparm_query: `sys_scope=${scope}^ORsys_scope.scope=${scope}`,
    sysparm_fields:
      "sys_id,name,operation,type,active,admin_overrides,script,condition",
    sysparm_limit: "1000",
  });
}

/** Query the ACL→role links for a single ACL (`sys_security_acl_role` m2m). */
async function fetchAclRoles(
  http: SnClient,
  aclSysId: string,
): Promise<Record<string, unknown>[]> {
  return http.table("sys_security_acl_role").query({
    sysparm_query: `sys_security_acl=${aclSysId}`,
    sysparm_fields: "sys_user_role,sys_user_role.name",
    sysparm_limit: "1000",
  });
}

/** All roles that exist on the instance, indexed by both sys_id and name. */
async function fetchExistingRoles(http: SnClient): Promise<Set<string>> {
  // No `sysparm_limit`: the client auto-paginates so instances with more roles
  // than a single page are not truncated (which would flag valid roles as
  // "missing"). See src/http/client.ts query().
  const rows = await http.table("sys_user_role").query({
    sysparm_fields: "sys_id,name",
  });
  const known = new Set<string>();
  for (const row of rows) {
    const id = str(row, "sys_id");
    const name = str(row, "name");
    if (id) known.add(id);
    if (name) known.add(name.toLowerCase());
  }
  return known;
}

/** Extract the role reference (id or dotted name) an ACL→role link points at. */
function roleRef(link: Record<string, unknown>): {
  id: string;
  name: string;
} {
  const id = str(link, "sys_user_role");
  // Dot-walked display of the referenced role's name, when requested.
  const name = str(link, "sys_user_role.name");
  return { id, name };
}

/**
 * Sanity-check the ACLs a scoped app ships. Fails on a mutating (write / create
 * / delete) ACL that is wide open — no role, no condition, and no script — since
 * that grants public write. Fails when an ACL references a role that does not
 * exist on the instance (a broken grant). Warns on suspicious-but-not-fatal
 * patterns (a wide-open read ACL, or inactive ACLs). Passes when every ACL is
 * gated and every referenced role resolves. Warns (rather than fails) when the
 * scope is unset, since there is nothing scoped to inspect.
 */
export const aclRoleSanity: Check = {
  name: NAME,
  description: "Shipped ACLs and roles pass basic security sanity checks.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping ACL/role sanity (pass a scope to enable it).",
      );
    }

    try {
      const acls = await fetchAcls(ctx.http, scope);
      if (acls.length === 0) {
        return result(
          "pass",
          `No ACLs shipped in scope "${scope}" — nothing to sanity-check.`,
        );
      }

      const knownRoles = await fetchExistingRoles(ctx.http);

      const openMutating: string[] = [];
      const openRead: string[] = [];
      const missingRoles: string[] = [];
      const inactive: string[] = [];

      for (const acl of acls) {
        const aclName = str(acl, "name") || str(acl, "sys_id") || "(unnamed)";
        const operation = str(acl, "operation").toLowerCase();
        const hasScript = str(acl, "script") !== "";
        const hasCondition = str(acl, "condition") !== "";

        if (!isTruthy(acl, "active")) {
          inactive.push(`${aclName} (${operation || "?"})`);
        }

        const roleLinks = await fetchAclRoles(ctx.http, str(acl, "sys_id"));
        const hasRole = roleLinks.length > 0;

        // A referenced role that does not exist is a broken/dangling grant.
        for (const link of roleLinks) {
          const { id, name } = roleRef(link);
          const knownById = id !== "" && knownRoles.has(id);
          const knownByName = name !== "" && knownRoles.has(name.toLowerCase());
          if (!knownById && !knownByName) {
            const label = name || id || "(unknown)";
            missingRoles.push(`${aclName} → ${label}`);
          }
        }

        // Wide open: no role AND no condition AND no script gating access.
        const wideOpen = !hasRole && !hasCondition && !hasScript;
        if (wideOpen) {
          if (MUTATING_OPERATIONS.has(operation)) {
            openMutating.push(`${aclName} (${operation})`);
          } else {
            openRead.push(`${aclName} (${operation || "read"})`);
          }
        }
      }

      // Hard failures: open write access or dangling role references.
      if (openMutating.length > 0 || missingRoles.length > 0) {
        const parts: string[] = [];
        if (openMutating.length > 0) {
          parts.push(
            `${openMutating.length} mutating ACL(s) grant public access with no role/condition/script: ${openMutating.join(", ")}`,
          );
        }
        if (missingRoles.length > 0) {
          parts.push(
            `${missingRoles.length} ACL(s) reference a role that does not exist on the instance: ${missingRoles.join(", ")}`,
          );
        }
        return result("fail", parts.join("; ") + ".");
      }

      // Advisory issues: open reads or inactive ACLs — degraded, not fatal.
      if (openRead.length > 0 || inactive.length > 0) {
        const parts: string[] = [];
        if (openRead.length > 0) {
          parts.push(
            `${openRead.length} read ACL(s) are ungated (public read): ${openRead.join(", ")}`,
          );
        }
        if (inactive.length > 0) {
          parts.push(
            `${inactive.length} shipped ACL(s) are inactive: ${inactive.join(", ")}`,
          );
        }
        return result("warn", parts.join("; ") + ".");
      }

      return result(
        "pass",
        `All ${acls.length} ACL(s) in scope "${scope}" are gated and reference existing roles.`,
      );
    } catch (err) {
      if (err instanceof SnAuthError) {
        return result(
          "fail",
          `Authentication failed while reading ACLs${err.status ? ` (${err.status})` : ""}: ${err.message}`,
        );
      }
      if (err instanceof SnNetworkError) {
        return result(
          "warn",
          `Could not reach the instance to check ACLs: ${err.message}`,
        );
      }
      if (err instanceof SnHttpError) {
        // Missing table / insufficient rights to read ACLs — degraded, warn.
        return result(
          "warn",
          `Could not read ACL/role tables (HTTP ${err.status}): ${err.message}`,
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      return result(
        "fail",
        `Unexpected error during ACL sanity check: ${message}`,
      );
    }
  },
};
