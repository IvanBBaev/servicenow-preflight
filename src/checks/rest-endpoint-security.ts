import type { Check, CheckResult, CheckStatus, Finding } from "../types.js";
import type { SnClient } from "../http/client.js";
import {
  and,
  chunk,
  eq,
  inClause,
  isSafeIdentifier,
  resolveScope,
  type ResolvedScope,
} from "../http/query.js";
import {
  ACL_SCOPE_FIELDS,
  aclInScope,
  conditionGates,
  errorResult,
  fetchAclRolesByAcl,
  isTruthy,
  PUBLIC_ROLE,
  rowFinding,
  scriptGates,
  str,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";

const NAME = "rest-endpoint-security";

/** The sys_ids of a glide_list value (`enforce_acl`), safe to query by. */
function idList(row: Record<string, unknown> | undefined, field: string) {
  if (!row) return [];
  return str(row, field)
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "" && isSafeIdentifier(id));
}

/** Rows of `table` by sys_id, in IN-clause chunks; `trimmed` if any chunk was. */
async function readByIds(
  http: SnClient,
  table: string,
  ids: readonly string[],
  fields: string,
): Promise<{ byId: Map<string, Record<string, unknown>>; trimmed: boolean }> {
  const byId = new Map<string, Record<string, unknown>>();
  let trimmed = false;
  for (const batch of chunk([...new Set(ids)])) {
    // No `sysparm_limit`: the client auto-paginates.
    const { rows, securityTrimmed } = await http.table(table).queryWithMeta({
      sysparm_query: inClause("sys_id", batch),
      sysparm_fields: fields,
    });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      const id = str(row, "sys_id");
      if (id !== "") byId.set(id, row);
    }
  }
  return { byId, trimmed };
}

/**
 * The ACL sys_ids that actually back a resource: an active `REST_Endpoint`
 * ACL that ships in the app scope and gates — a role other than `public`, or
 * a script or condition that decides something (ACL-9). `trimmed` is true when
 * the ACL or role-link read was security-trimmed, so a "not backed" verdict
 * there is unproven.
 */
async function gatingEndpointAcls(
  http: SnClient,
  aclIds: readonly string[],
  scope: ResolvedScope,
): Promise<{ gating: Set<string>; trimmed: boolean }> {
  const acls = await readByIds(
    http,
    "sys_security_acl",
    aclIds,
    `sys_id,name,type,active,script,condition,${ACL_SCOPE_FIELDS}`,
  );
  const candidates = [...acls.byId.values()].filter(
    (acl) =>
      str(acl, "type") === "REST_Endpoint" &&
      isTruthy(acl, "active") &&
      aclInScope(acl, scope),
  );
  const gating = new Set<string>();
  const ungatedIds: string[] = [];
  for (const acl of candidates) {
    const id = str(acl, "sys_id");
    if (
      scriptGates(str(acl, "script")) ||
      conditionGates(str(acl, "condition"))
    ) {
      gating.add(id);
    } else {
      ungatedIds.push(id);
    }
  }
  let rolesTrimmed = false;
  if (ungatedIds.length > 0) {
    const roles = await fetchAclRolesByAcl(http, ungatedIds);
    rolesTrimmed = roles.trimmed;
    for (const [id, links] of roles.byAcl) {
      const gated = links.some((link) => {
        const role = str(link, "sys_user_role.name").toLowerCase();
        return role !== "" && role !== PUBLIC_ROLE;
      });
      if (gated) gating.add(id);
    }
  }
  return { gating, trimmed: acls.trimmed || rolesTrimmed };
}

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
 * The check inspects every active `sys_ws_operation` in the target scope. A
 * resource whose API (`sys_ws_definition`) is explicitly inactive is not
 * exposed and is skipped. The ACLs a resource enforces are its own
 * `enforce_acl` list, else its API's default list (ACL-9):
 *
 * - **fail** — a resource has `requires_authentication=false` (anonymous
 *   endpoint), or a read was security-trimmed (a partially visible table
 *   cannot clear the gate).
 * - **warn** — a resource skips ACL authorization
 *   (`requires_acl_authorization=false`), or none of the ACLs it enforces is
 *   an active, role/script/condition-gated `REST_Endpoint` ACL of the app (the
 *   global Scripted REST External Default ACL does not count); the scope is
 *   unset; or a zero-row read could not be distinguished from missing read
 *   access.
 * - **pass** — every resource requires authentication and enforces ACL
 *   authorization backed by a gated `REST_Endpoint` ACL of the app, or the
 *   instance itself reports the scope ships no resources.
 */
export const restEndpointSecurity: Check = {
  name: NAME,
  description:
    "Scripted REST resources require authentication and ACL authorization.",
  meta: {
    requires: "scope",
    summary:
      "Scripted REST resources require authentication and enforce ACL authorization.",
    rule: "1.3",
    severity: "blocker",
    tables: [
      "sys_ws_operation",
      "sys_ws_definition",
      "sys_security_acl",
      "sys_security_acl_role",
    ],
    remediation:
      "Tick Requires authentication and Requires ACL authorization on every Scripted REST resource, and list in its ACLs (or the API's default ACLs) a REST_Endpoint ACL of the app bound to an app role, instead of relying on the Scripted REST External Default ACL.",
    verdicts: {
      pass: "Every resource authenticates and enforces a gated REST_Endpoint ACL of the app, or the scope ships none.",
      warn: "ACL authorization opted out, no enforced ACL is an active gated REST_Endpoint ACL of the app, or no scope set.",
      fail: "A resource does not require authentication, or a read was security-trimmed.",
    },
  },
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
          "sys_id,name,http_method,requires_authentication,requires_acl_authorization,web_service_definition,enforce_acl",
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

      // The parent APIs: their `active` flag and default ACL list. A missing
      // column or an unreadable parent counts as active (fail closed).
      const definitions = await readByIds(
        ctx.http,
        "sys_ws_definition",
        meta.rows
          .map((row) => str(row, "web_service_definition"))
          .filter((id) => id !== "" && isSafeIdentifier(id)),
        "sys_id,name,active,enforce_acl",
      );
      const definitionOf = (row: Record<string, unknown>) =>
        definitions.byId.get(str(row, "web_service_definition"));
      const exposed = meta.rows.filter(
        (row) =>
          str(definitionOf(row) ?? {}, "active").toLowerCase() !== "false",
      );
      const skipped = meta.rows.length - exposed.length;

      const anonymous: string[] = [];
      const noAclAuth: string[] = [];
      const enforcingRows: Record<string, unknown>[] = [];
      const findings: Finding[] = [];
      for (const row of exposed) {
        if (!isTruthy(row, "requires_authentication")) {
          anonymous.push(opLabel(row));
          findings.push(
            rowFinding(NAME, "sys_ws_operation", row, "anonymous", opLabel),
          );
        } else if (!isTruthy(row, "requires_acl_authorization")) {
          noAclAuth.push(opLabel(row));
          const finding = rowFinding(
            NAME,
            "sys_ws_operation",
            row,
            "no-acl-authorization",
            opLabel,
          );
          // Advisory even when an anonymous resource fails the row.
          finding.status = "warn";
          findings.push(finding);
        } else {
          enforcingRows.push(row);
        }
      }

      // Each resource that relies on ACL authorization must enforce an ACL
      // that actually gates it: its own `enforce_acl` list, else its API's.
      const enforced = new Map<Record<string, unknown>, string[]>();
      for (const row of enforcingRows) {
        const own = idList(row, "enforce_acl");
        enforced.set(
          row,
          own.length > 0 ? own : idList(definitionOf(row), "enforce_acl"),
        );
      }
      const allIds = [...enforced.values()].flat();
      const { gating, trimmed: aclReadTrimmed } =
        allIds.length > 0
          ? await gatingEndpointAcls(ctx.http, allIds, resolvedScope)
          : { gating: new Set<string>(), trimmed: false };
      const unbacked: string[] = [];
      for (const [row, ids] of enforced) {
        if (ids.some((id) => gating.has(id))) continue;
        unbacked.push(opLabel(row));
        const finding = rowFinding(
          NAME,
          "sys_ws_operation",
          row,
          "no-gated-endpoint-acl",
          opLabel,
        );
        finding.status = "warn";
        findings.push(finding);
      }
      const done = (status: CheckStatus, message: string): CheckResult =>
        withFindings(result(status, message), findings);

      // Anonymous endpoints are the hard failure; the message still flags an
      // incomplete (trimmed) view so a clean-looking list is not over-trusted.
      if (anonymous.length > 0) {
        const trimmedNote = meta.securityTrimmed
          ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
          : "";
        return done(
          "fail",
          `${anonymous.length} scripted REST resource(s) do not require authentication — they are anonymously reachable: ${anonymous.join(", ")}.` +
            trimmedNote,
        );
      }

      // The resources this account cannot see are exactly the ones this gate
      // cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed || definitions.trimmed || aclReadTrimmed) {
        return done(
          "fail",
          `Cannot fully inspect scripted REST security in scope "${scope}" — the ${
            meta.securityTrimmed
              ? "sys_ws_operation"
              : definitions.trimmed
                ? "sys_ws_definition"
                : "sys_security_acl"
          } read was security-trimmed. Grant the account read access; the rows it cannot see are the ones this gate cannot clear.`,
        );
      }

      if (noAclAuth.length > 0 || unbacked.length > 0) {
        const parts: string[] = [];
        if (noAclAuth.length > 0) {
          parts.push(
            `${noAclAuth.length} authenticated resource(s) skip ACL authorization: ${noAclAuth.join(", ")}`,
          );
        }
        if (unbacked.length > 0) {
          parts.push(
            `${unbacked.length} resource(s) enforce ACL authorization but no active, gated REST_Endpoint ACL of the app backs them: ${unbacked.join(", ")}`,
          );
        }
        return done("warn", parts.join("; ") + ".");
      }

      const skippedNote =
        skipped > 0
          ? ` ${skipped} resource(s) of an inactive API skipped.`
          : "";
      return done(
        "pass",
        `All ${exposed.length} active scripted REST resource(s) in scope "${scope}" require authentication and enforce ACL authorization.${skippedNote}`,
      );
    } catch (err) {
      return errorResult(NAME, "scripted REST resource security", err);
    }
  },
};
