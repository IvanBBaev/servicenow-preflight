import type { Check, CheckResult, CheckStatus } from "../types.js";
import { and, eq, resolveScope } from "../http/query.js";
import { errorResult, str, triageZeroRead } from "./cert-common.js";

const NAME = "inactive-artifacts";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** One artifact table to sweep, with the column that labels a row. */
interface ArtifactTable {
  table: string;
  label: string;
  /** The column holding a human-readable name (`name` unless noted). */
  nameField: string;
}

/**
 * The artifact tables that carry an `active` flag and ship with the app. Every
 * one is read with `sys_id` plus its name column only — never a script body.
 */
export const INACTIVE_ARTIFACT_TABLES: readonly ArtifactTable[] = [
  { table: "sys_script", label: "Business Rules", nameField: "name" },
  { table: "sys_script_client", label: "Client Scripts", nameField: "name" },
  {
    table: "sys_script_include",
    label: "Script Includes",
    nameField: "name",
  },
  { table: "sys_ui_action", label: "UI Actions", nameField: "name" },
  {
    table: "sys_ui_policy",
    label: "UI Policies",
    nameField: "short_description",
  },
  { table: "sysauto_script", label: "Scheduled Jobs", nameField: "name" },
  {
    table: "sysevent_email_action",
    label: "Notifications",
    nameField: "name",
  },
];

/** How many artifact names to list per table before eliding the rest. */
const MAX_NAMES_PER_TABLE = 5;

/**
 * Install hygiene (certification rule 6.6): an app ships its inactive
 * Business Rules, Client Scripts, Script Includes, UI Actions, UI Policies,
 * Scheduled Jobs and Notifications along with the active ones. Dead code
 * still lands on every customer instance, still shows up in the Store review,
 * and still has to be read by whoever maintains the app next.
 *
 * The check counts the `active = false` rows the app ships in the target scope,
 * one metadata read per table (`sys_id` and the name column only):
 *
 * - **warn** — at least one inactive artifact, with a per-table count and the
 *   first few names; the scope is unset; a table read was security-trimmed; or
 *   a zero-row read could not be distinguished from missing read access.
 *   (Dead code is clutter, not a security hole, so findings stay advisory.)
 * - **pass** — every table reports zero inactive artifacts in scope.
 */
export const inactiveArtifacts: Check = {
  name: NAME,
  description:
    "No inactive Business Rules, Client Scripts, Script Includes, UI Actions, UI Policies, Scheduled Jobs or Notifications ship with the app.",
  meta: {
    requires: "scope",
    rule: "6.6",
    summary:
      "The app ships no inactive script, UI or notification artifacts — dead code that still lands on every install. Advisory — never fails.",
    severity: "advisory",
    tables: INACTIVE_ARTIFACT_TABLES.map((t) => t.table),
    remediation:
      "Delete inactive artifacts the app no longer needs before packaging; if one must stay (e.g. a feature toggle), document why in its description.",
    verdicts: {
      pass: "No inactive artifacts in any of the swept tables in scope.",
      warn: "Inactive artifacts ship with the app, no scope set, or an unreadable table.",
      fail: "Never — install hygiene stays advisory.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the inactive artifact sweep (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      const findings: string[] = [];
      let found = 0;
      const trimmed: string[] = [];
      const ambiguous: string[] = [];

      for (const { table, label, nameField } of INACTIVE_ARTIFACT_TABLES) {
        // No `sysparm_limit`: auto-pagination counts every inactive row.
        const meta = await ctx.http.table(table).queryWithMeta({
          sysparm_query: and(clause, eq("active", "false")),
          sysparm_fields: `sys_id,${nameField}`,
        });
        if (meta.securityTrimmed) trimmed.push(table);
        if (meta.rows.length === 0) {
          if (triageZeroRead(meta) === "ambiguous") ambiguous.push(table);
          continue;
        }
        found += meta.rows.length;
        const names = meta.rows
          .slice(0, MAX_NAMES_PER_TABLE)
          .map(
            (row) => str(row, nameField) || str(row, "sys_id") || "(unnamed)",
          );
        const more =
          meta.rows.length > names.length
            ? `, … ${meta.rows.length - names.length} more`
            : "";
        findings.push(
          `${meta.rows.length} ${label} (${table}): ${names.join(", ")}${more}`,
        );
      }

      const trimmedNote =
        trimmed.length > 0
          ? ` The read of ${trimmed.join(", ")} was security-trimmed, so these counts may be incomplete.`
          : "";

      if (found > 0) {
        return result(
          "warn",
          `${found} inactive artifact(s) ship in scope "${scope}" — dead code that still lands on every install and shows in the Store review: ${findings.join("; ")}. Delete what the app no longer needs.${trimmedNote}`,
        );
      }
      if (trimmed.length > 0) {
        return result(
          "warn",
          `Cannot fully sweep inactive artifacts in scope "${scope}".${trimmedNote}`,
        );
      }
      if (ambiguous.length > 0) {
        return result(
          "warn",
          `No inactive artifacts visible in scope "${scope}", but no pre-trim count arrived for ${ambiguous.join(", ")} — either the app ships none, or the account cannot read those tables. Cannot confirm the sweep.`,
        );
      }
      return result(
        "pass",
        `No inactive artifacts in scope "${scope}" across ${INACTIVE_ARTIFACT_TABLES.length} artifact tables.`,
      );
    } catch (err) {
      return errorResult(NAME, "inactive artifacts", err);
    }
  },
};
