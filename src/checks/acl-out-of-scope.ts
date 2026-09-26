import type { Check, CheckResult, CheckStatus } from "../types.js";
import { and, eq, isSysId, resolveScope } from "../http/query.js";
import { errorResult, isTruthy, str, triageZeroRead } from "./cert-common.js";

const NAME = "acl-out-of-scope";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Split a `record` ACL name into its table and (optional) field part. */
function splitAclName(name: string): { table: string; field: string } {
  const dot = name.indexOf(".");
  return dot === -1
    ? { table: name, field: "" }
    : { table: name.slice(0, dot), field: name.slice(dot + 1) };
}

/**
 * Certification rule 1.6 (`ci/certification/CHECKLIST.md`) — High, raised in
 * 7 of 19 releases: a scoped app must not ship ACLs onto tables outside its
 * own scope. An app ACL on a shared or out-of-box table (or on `*`) is
 * evaluated for every user of that table on the customer instance and can
 * silently widen access there.
 *
 * Inspects every `record`-type ACL the target scope ships. An ACL's table is
 * the part of its name before the first `.` (`incident`, `incident.field`,
 * `incident.*`). A table is the app's own when it is in the scope's
 * `sys_db_object` rows or carries the scope namespace prefix (`<scope>_`), so
 * a trimmed table read cannot turn an app table into a false finding.
 *
 * - **fail** — a table-level or wildcard ACL (`table`, `table.*`, `*`)
 *   targets a table outside the scope, a field ACL does so for a field that is
 *   not the app's own, or the ACL read was security-trimmed.
 * - **warn** — the only findings are field ACLs for the app's own namespaced
 *   field on an out-of-scope table (narrow, but adding fields to out-of-box
 *   tables is itself a finding — rule 4.9); the scope is unset or `global`; or
 *   a zero-row ACL read could not be distinguished from missing read access.
 * - **pass** — every ACL in scope targets the app's own tables, or the
 *   instance itself reports the scope ships no record ACLs.
 */
export const aclOutOfScope: Check = {
  name: NAME,
  description: "The app ships no ACLs onto tables outside its own scope.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the out-of-scope ACL check (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      const namespace = (
        resolvedScope.name ?? (isSysId(scope) ? "" : scope)
      ).toLowerCase();
      if (namespace === "global") {
        return result(
          "warn",
          `Scope "${scope}" is the global scope, where ACLs on shared tables are normal — the out-of-scope ACL check applies to scoped apps.`,
        );
      }

      // No `sysparm_limit`: auto-pagination inspects every ACL in the scope.
      const acls = await ctx.http.table("sys_security_acl").queryWithMeta({
        sysparm_query: and(resolvedScope.clause, eq("type", "record")),
        sysparm_fields: "sys_id,name,operation,active",
      });

      if (acls.rows.length === 0) {
        switch (triageZeroRead(acls)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect the ACLs in scope "${scope}": ${
                acls.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed (sys_security_acl is admin-read out-of-box). A zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `No record ACLs in scope "${scope}" — nothing ships onto other tables.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No record ACLs visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_security_acl. Cannot confirm the out-of-scope ACL check.`,
            );
        }
      }

      const tables = await ctx.http.table("sys_db_object").queryWithMeta({
        sysparm_query: resolvedScope.clause,
        sysparm_fields: "sys_id,name",
      });
      const own = new Set(
        tables.rows.map((row) => str(row, "name").toLowerCase()),
      );
      const prefix = namespace === "" ? "" : `${namespace}_`;
      const isOwn = (name: string): boolean =>
        name !== "" &&
        (own.has(name) || (prefix !== "" && name.startsWith(prefix)));

      const blocking: string[] = [];
      const ownFieldOnForeign: string[] = [];
      for (const row of acls.rows) {
        const name = str(row, "name");
        const { table, field } = splitAclName(name.toLowerCase());
        if (isOwn(table)) continue;
        const op = str(row, "operation") || "?";
        const label = `${name || str(row, "sys_id") || "(unnamed)"} (${op}${
          isTruthy(row, "active") ? "" : ", inactive"
        })`;
        // `*` and "" can never start with the namespace prefix.
        const ownField = prefix !== "" && field.startsWith(prefix);
        (ownField ? ownFieldOnForeign : blocking).push(label);
      }

      const note =
        tables.securityTrimmed || acls.securityTrimmed
          ? ` (Note: a read was security-trimmed, so this list may be incomplete.)`
          : "";

      if (blocking.length > 0) {
        return result(
          "fail",
          `${blocking.length} ACL(s) in scope "${scope}" target tables outside the app — they apply to every user of those tables on the customer instance and can widen access there: ${blocking.join(", ")}.` +
            (ownFieldOnForeign.length > 0
              ? ` Also ${ownFieldOnForeign.length} field ACL(s) for the app's own fields on out-of-scope tables: ${ownFieldOnForeign.join(", ")}.`
              : "") +
            note,
        );
      }

      // The ACLs this account cannot see are exactly the ones this gate cannot
      // clear — a partially trimmed ACL read never passes.
      if (acls.securityTrimmed) {
        return result(
          "fail",
          `Cannot fully inspect the ACLs in scope "${scope}" — the sys_security_acl read was security-trimmed. Grant the account read access; the ACLs it cannot see are the ones this gate cannot clear.`,
        );
      }

      if (ownFieldOnForeign.length > 0) {
        return result(
          "warn",
          `${ownFieldOnForeign.length} field ACL(s) in scope "${scope}" guard the app's own fields on tables outside the app — narrow, but adding fields to out-of-box tables is itself a certification finding: ${ownFieldOnForeign.join(", ")}.` +
            note,
        );
      }

      return result(
        "pass",
        `All ${acls.rows.length} record ACL(s) in scope "${scope}" target the app's own tables.`,
      );
    } catch (err) {
      return errorResult(NAME, "out-of-scope ACLs", err);
    }
  },
};
