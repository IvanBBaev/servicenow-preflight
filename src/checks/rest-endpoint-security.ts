import type { Check, CheckResult, CheckStatus } from "../types.js";
import { and, eq, resolveScope } from "../http/query.js";
import { errorResult, isTruthy, str, triageZeroRead } from "./cert-common.js";

const NAME = "rest-endpoint-security";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Display handle for a scripted REST resource in messages. */
function opLabel(row: Record<string, unknown>): string {
  const name = str(row, "name") || str(row, "sys_id") || "(unnamed)";
  const method = str(row, "http_method").toUpperCase();
  return method ? `${name} [${method}]` : name;
}

/**
 * Certification rule 1.3 (`ci/certification/CHECKLIST.md`) — one of the
 * highest-volume security findings: every scripted REST resource must require
 * **Authentication**, and should enforce **ACL authorization** backed by a
 * `REST_Endpoint` ACL. An unauthenticated resource is externally reachable data
 * access.
 *
 * The check inspects every active `sys_ws_operation` in the target scope:
 *
 * - **fail** — a resource has `requires_authentication=false` (anonymous
 *   endpoint), or the read was security-trimmed (a partially visible table
 *   cannot clear the gate).
 * - **warn** — a resource skips ACL authorization
 *   (`requires_acl_authorization=false`), ACL authorization is on but the scope
 *   ships no active `REST_Endpoint` ACL to back it, the scope is unset, or a
 *   zero-row read could not be distinguished from missing read access.
 * - **pass** — every resource requires authentication and enforces ACL
 *   authorization backed by at least one active `REST_Endpoint` ACL in scope,
 *   or the instance itself reports the scope ships no resources.
 *
 * Whether the backing ACL is properly role-gated is `acl-role-sanity`'s job.
 */
export const restEndpointSecurity: Check = {
  name: NAME,
  description:
    "Scripted REST resources require authentication and ACL authorization.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the scripted REST security gate (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every resource in scope.
      const meta = await ctx.http.table("sys_ws_operation").queryWithMeta({
        sysparm_query: and(resolvedScope.clause, eq("active", "true")),
        sysparm_fields:
          "sys_id,name,http_method,requires_authentication,requires_acl_authorization",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect scripted REST resources in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_ws_operation; a zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `No active scripted REST resources in scope "${scope}" — nothing to secure.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No scripted REST resources visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_ws_operation. Cannot confirm REST security.`,
            );
        }
      }

      const anonymous: string[] = [];
      const noAclAuth: string[] = [];
      for (const row of meta.rows) {
        if (!isTruthy(row, "requires_authentication")) {
          anonymous.push(opLabel(row));
        } else if (!isTruthy(row, "requires_acl_authorization")) {
          noAclAuth.push(opLabel(row));
        }
      }

      // When at least one resource relies on ACL authorization, the scope must
      // actually ship an active REST_Endpoint ACL to back it. This is a
      // scope-level existence probe (resource→ACL name matching is not
      // reliable), so a missing one is advisory, not fatal.
      let missingEndpointAcl = false;
      let aclReadTrimmed = false;
      const enforcing = meta.rows.length - anonymous.length - noAclAuth.length;
      if (enforcing > 0) {
        const aclMeta = await ctx.http.table("sys_security_acl").queryWithMeta({
          sysparm_query: and(
            resolvedScope.clause,
            eq("type", "REST_Endpoint"),
            eq("active", "true"),
          ),
          sysparm_fields: "sys_id,name",
        });
        aclReadTrimmed = aclMeta.securityTrimmed;
        missingEndpointAcl = !aclReadTrimmed && aclMeta.rows.length === 0;
      }

      // Anonymous endpoints are the hard failure; the message still flags an
      // incomplete (trimmed) view so a clean-looking list is not over-trusted.
      if (anonymous.length > 0) {
        const trimmedNote = meta.securityTrimmed
          ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
          : "";
        return result(
          "fail",
          `${anonymous.length} scripted REST resource(s) do not require authentication — they are anonymously reachable: ${anonymous.join(", ")}.` +
            trimmedNote,
        );
      }

      // The resources this account cannot see are exactly the ones this gate
      // cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed || aclReadTrimmed) {
        return result(
          "fail",
          `Cannot fully inspect scripted REST security in scope "${scope}" — the ${
            meta.securityTrimmed ? "sys_ws_operation" : "sys_security_acl"
          } read was security-trimmed. Grant the account read access; the rows it cannot see are the ones this gate cannot clear.`,
        );
      }

      if (noAclAuth.length > 0 || missingEndpointAcl) {
        const parts: string[] = [];
        if (noAclAuth.length > 0) {
          parts.push(
            `${noAclAuth.length} authenticated resource(s) skip ACL authorization: ${noAclAuth.join(", ")}`,
          );
        }
        if (missingEndpointAcl) {
          parts.push(
            `${enforcing} resource(s) enforce ACL authorization but the scope ships no active REST_Endpoint ACL to back them`,
          );
        }
        return result("warn", parts.join("; ") + ".");
      }

      return result(
        "pass",
        `All ${meta.rows.length} active scripted REST resource(s) in scope "${scope}" require authentication and enforce ACL authorization.`,
      );
    } catch (err) {
      return errorResult(NAME, "scripted REST resource security", err);
    }
  },
};
