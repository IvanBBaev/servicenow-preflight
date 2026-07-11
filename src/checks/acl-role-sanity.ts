import type { Check, CheckResult, CheckStatus } from "../types.js";
import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  type SnClient,
  type TableQueryResult,
} from "../http/client.js";
import { chunk, inClause, resolveScope } from "../http/query.js";

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
 * Query every `sys_security_acl` row for the given scope. `scopeClause` is the
 * single-term filter the shared scope resolver produced (`sys_scope=<sysId>`
 * when the scope resolved, else the fail-closed name/sys_id fallback) — never a
 * value concatenated raw from config, so no encoded-query operator can be
 * smuggled in (SR-1).
 *
 * Uses `queryWithMeta` so the caller can tell genuine "no ACLs shipped" apart
 * from ACL security-trimming: `sys_security_acl` is admin-read out-of-box, so a
 * CI account lacking that grant sees 0 rows while `X-Total-Count` still reports
 * matches (`securityTrimmed`). A zero-row read must never be taken as proof the
 * app is safe.
 */
async function fetchAcls(
  http: SnClient,
  scopeClause: string,
): Promise<TableQueryResult> {
  // No `sysparm_limit`: the client auto-paginates so an app shipping more ACLs
  // than a single page are all inspected (a cap would leave wide-open ACLs
  // beyond the window unchecked). See src/http/client.ts query().
  return http.table("sys_security_acl").queryWithMeta({
    sysparm_query: scopeClause,
    sysparm_fields:
      "sys_id,name,operation,type,active,admin_overrides,script,condition",
  });
}

/**
 * Batch-fetch the ACL→role links (`sys_security_acl_role` m2m) for every ACL in
 * one go, grouped by ACL sys_id. Replaces the per-ACL N+1 read (SN-6): the ids
 * are packed into `sys_security_aclIN…` clauses of at most `IN_CHUNK_SIZE`, so N
 * ACLs cost `⌈N / IN_CHUNK_SIZE⌉` queries instead of N. Every id is charset-
 * validated by {@link inClause}, so the batched query cannot be injected into.
 */
async function fetchAclRolesByAcl(
  http: SnClient,
  aclSysIds: readonly string[],
): Promise<Map<string, Record<string, unknown>[]>> {
  const byAcl = new Map<string, Record<string, unknown>[]>();
  for (const id of aclSysIds) byAcl.set(id, []);
  for (const ids of chunk(aclSysIds)) {
    // No `sysparm_limit`: the client auto-paginates so an ACL gated by more
    // roles than a single page is never seen as ungated through truncation.
    const rows = await http.table("sys_security_acl_role").query({
      sysparm_query: inClause("sys_security_acl", ids),
      sysparm_fields: "sys_security_acl,sys_user_role,sys_user_role.name",
    });
    for (const row of rows) {
      const list = byAcl.get(str(row, "sys_security_acl"));
      if (list) list.push(row);
    }
  }
  return byAcl;
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
      const resolvedScope = await resolveScope(ctx, scope);
      const {
        rows: acls,
        securityTrimmed,
        totalCount,
      } = await fetchAcls(ctx.http, resolvedScope.clause);
      if (acls.length === 0) {
        // A zero-row read is not proof of safety. If the pre-trim count shows
        // ACLs exist but none are visible, the CI account is security-trimmed
        // (sys_security_acl is admin-read out-of-box) — fail, because this gate
        // cannot see what it must inspect. Otherwise it is a plain zero-row
        // read (none shipped, or no read access at all) — warn, not pass.
        if (securityTrimmed) {
          return result(
            "fail",
            `Cannot inspect ACLs in scope "${scope}": ${
              totalCount ?? "some"
            } ACL(s) match but 0 are visible — the account is security-trimmed (sys_security_acl is admin-read out-of-box). Grant the CI account read access; a zero-row read here is not proof of safety.`,
          );
        }
        return result(
          "warn",
          `No ACLs visible in scope "${scope}" — either the app ships none, or the account cannot read sys_security_acl (admin-read out-of-box). Cannot confirm ACL safety.`,
        );
      }

      const knownRoles = await fetchExistingRoles(ctx.http);

      // One batched read of every ACL's role links (SN-6), instead of an N+1
      // per-ACL query. Grouped by ACL sys_id so the loop is a map lookup.
      const aclSysIds = acls.map((acl) => str(acl, "sys_id")).filter(Boolean);
      const linksByAcl = await fetchAclRolesByAcl(ctx.http, aclSysIds);

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

        const roleLinks = linksByAcl.get(str(acl, "sys_id")) ?? [];
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
