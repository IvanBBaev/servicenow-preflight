import type { Check, CheckResult, CheckStatus, Finding } from "../types.js";
import { isSafeIdentifier, resolveScope } from "../http/query.js";
import {
  errorResult,
  fetchNamedAcls,
  isTruthy,
  rowFinding,
  str,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";

const NAME = "table-access-settings";

/** The `sys_db_object` Application Access fields this check reads. */
const FIELDS = [
  "sys_id",
  "name",
  "access",
  "read_access",
  "create_access",
  "update_access",
  "delete_access",
  "alter_access",
  "actions_access",
  "ws_access",
].join(",");

/**
 * The grants a public table may give other scopes that change it: create,
 * update and delete its records, alter its configuration ("Allow
 * configuration": other scopes add business rules, fields, client scripts …
 * to it — ACL-11), and run actions on it ("Allow UI actions"). Each is the
 * `<op>_access` column of `sys_db_object`.
 */
const WRITE_OPS = ["create", "update", "delete", "alter", "actions"] as const;

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** The table label the messages list: its name, else its sys_id. */
function label(row: Record<string, unknown>): string {
  return str(row, "name") || str(row, "sys_id") || "(unnamed)";
}

/**
 * Application Access settings of every table in the app scope. They are a
 * second gate next to ACLs: "Accessible from: All application scopes"
 * (`access = public`) plus a "Can create / update / delete", "Allow
 * configuration" or "Allow UI actions" grant lets any other scope change the
 * table. Web-service access (`ws_access`, on by default) leaves the REST/SOAP
 * surface gated by ACLs alone, so a web-service table needs a table-level
 * `read` ACL that ships with the app. (`user_role` is only the role the
 * auto-generated ACLs use — not a web-service gate, so it is not read, ACL-10.)
 *
 * - **fail** — a public table grants another scope create, update, delete,
 *   configuration or UI actions, or a table or ACL read was security-trimmed.
 * - **warn** — a public table grants read only; a web-service accessible
 *   table has no active table-level read ACL in the app scope; no scope; or an
 *   ambiguous zero-row read.
 * - **pass** — every in-scope table restricts application access, or the
 *   instance reports the scope ships no tables.
 *
 * Messages carry table names and counts only.
 */
export const tableAccessSettings: Check = {
  name: NAME,
  description:
    "App tables do not let other scopes change them, and web-service tables ship a read ACL.",
  meta: {
    requires: "scope",
    summary:
      "App tables keep Application Access restricted: no cross-scope writes or configuration, and no web-service table without a read ACL that ships.",
    severity: "blocker",
    tables: ["sys_db_object", "sys_security_acl"],
    remediation:
      "On each listed table's Application Access tab, set Accessible from to This application scope only, or clear Can create / Can update / Can delete / Allow configuration / Allow UI actions for other scopes; for a web-service table, ship a role-gated table-level read ACL in the app or clear Allow access to this table via web services.",
    verdicts: {
      pass: "Every in-scope table restricts application access, or the scope ships none.",
      warn: "A public read-only table, a web-service table with no read ACL in scope, no scope, or an ambiguous zero-row read.",
      fail: "A public table lets other scopes create, update, delete, configure or run actions on it, or a read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the table access settings check (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every table in the scope.
      const meta = await ctx.http.table("sys_db_object").queryWithMeta({
        sysparm_query: resolvedScope.clause,
        sysparm_fields: FIELDS,
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
              `No tables visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_db_object. Cannot confirm the table access settings.`,
            );
        }
      }

      const writable: string[] = [];
      const readable: string[] = [];
      const wsTables: Record<string, unknown>[] = [];
      const findings: Finding[] = [];
      for (const row of meta.rows) {
        const name = label(row);
        if (str(row, "access").toLowerCase() === "public") {
          const ops = WRITE_OPS.filter((op) => isTruthy(row, `${op}_access`));
          if (ops.length > 0) {
            writable.push(`${name} (${ops.join("/")})`);
            findings.push(
              rowFinding(
                NAME,
                "sys_db_object",
                row,
                `public-write:${ops.join("/")}`,
                label,
              ),
            );
          } else if (isTruthy(row, "read_access")) {
            readable.push(name);
            const finding = rowFinding(
              NAME,
              "sys_db_object",
              row,
              "public-read",
              label,
            );
            finding.status = "warn";
            findings.push(finding);
          }
        }
        if (isTruthy(row, "ws_access")) wsTables.push(row);
      }

      // A web-service table is reachable over REST/SOAP by any authenticated
      // user its ACLs admit, so it needs an active table-level read ACL that
      // ships in the app scope (ACL-10).
      const wsNoReadAcl: string[] = [];
      let aclTrimmed = false;
      const wsNames = wsTables
        .map((row) => str(row, "name"))
        .filter((n) => n !== "" && isSafeIdentifier(n));
      const acls =
        wsNames.length > 0
          ? await fetchNamedAcls(
              ctx.http,
              "record",
              "read",
              wsNames,
              resolvedScope,
            )
          : undefined;
      if (acls) aclTrimmed = acls.trimmed;
      for (const row of wsTables) {
        const name = str(row, "name").toLowerCase();
        if (name !== "" && acls?.names.has(name)) continue;
        wsNoReadAcl.push(label(row));
        const finding = rowFinding(
          NAME,
          "sys_db_object",
          row,
          "ws-no-read-acl",
          label,
        );
        finding.status = "warn";
        findings.push(finding);
      }

      const advisories: string[] = [];
      if (readable.length > 0) {
        advisories.push(
          `${readable.length} table(s) are readable from every application scope: ${readable.join(", ")}.`,
        );
      }
      if (wsNoReadAcl.length > 0) {
        advisories.push(
          `${wsNoReadAcl.length} table(s) are web-service accessible with no active read ACL in the app scope: ${wsNoReadAcl.join(", ")}.`,
        );
      }
      const trimNote = meta.securityTrimmed
        ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
        : "";
      const done = (status: CheckStatus, message: string): CheckResult =>
        withFindings(result(status, message), findings);

      if (writable.length > 0) {
        return done(
          "fail",
          [
            `${writable.length} table(s) in scope "${scope}" allow other scopes to change them: ${writable.join(", ")}.${trimNote}`,
            ...advisories,
          ].join(" "),
        );
      }

      // The tables this account cannot see are exactly the ones this gate
      // cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed || aclTrimmed) {
        const which = meta.securityTrimmed
          ? "sys_db_object"
          : "sys_security_acl";
        return done(
          "fail",
          [
            `Cannot fully inspect the table access settings in scope "${scope}" — the ${which} read was security-trimmed. Grant the account read access; the rows it cannot see are the ones this gate cannot clear.`,
            ...advisories,
          ].join(" "),
        );
      }

      if (advisories.length > 0) {
        return done("warn", `In scope "${scope}": ${advisories.join(" ")}`);
      }

      return result(
        "pass",
        `Every in-scope table restricts application access (${meta.rows.length} tables).`,
      );
    } catch (err) {
      return errorResult(NAME, "table access settings", err);
    }
  },
};
