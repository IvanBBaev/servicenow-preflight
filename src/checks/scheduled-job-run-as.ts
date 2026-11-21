import type { Check, CheckResult, CheckStatus, Finding } from "../types.js";
import type { TableQueryResult } from "../http/client.js";
import { resolveScope } from "../http/query.js";
import {
  errorResult,
  isMissingTable,
  rowFinding,
  str,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";

const NAME = "scheduled-job-run-as";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * The scheduled-job tables that carry a Run as: Scheduled Script Executions,
 * Scheduled Reports and Scheduled Template Generations (ACL-21). The two
 * siblings come with optional plugins, so a missing one is skipped.
 */
const JOB_TABLES = [
  "sysauto_script",
  "sysauto_report",
  "sysauto_template",
] as const;
type JobTable = (typeof JOB_TABLES)[number];

/**
 * Certification rule 6.2 (`ci/certification/CHECKLIST.md`) — Low severity: a
 * Scheduled Job's **Run as** must be empty so the job runs as `system`. A job
 * pinned to a named user references a record that may
 * not exist — or may be deactivated — on the customer instance, and the job
 * silently stops running after install.
 *
 * The check inspects every `sysauto_script`, `sysauto_report` and
 * `sysauto_template` record the app ships in the target scope (active or not —
 * the record ships and gets reviewed either way); a sibling table that is not
 * installed is skipped:
 *
 * - **warn** — a job has a non-empty `run_as`, the scope is unset, a read was
 *   security-trimmed, a table returned no `run_as` column, or a zero-row read
 *   could not be distinguished from missing read access. (The rule is install hygiene, not a security hole, so
 *   findings stay advisory.)
 * - **pass** — every scheduled job in scope has an empty Run as, or the
 *   instance itself reports the scope ships none.
 */
export const scheduledJobRunAs: Check = {
  name: NAME,
  description: "Scheduled Jobs leave 'Run as' empty (run as system).",
  meta: {
    requires: "scope",
    summary:
      "Scheduled Jobs leave 'Run as' empty so they run as system. Advisory — never fails.",
    rule: "6.2",
    severity: "advisory",
    tables: ["sysauto_script", "sysauto_report", "sysauto_template"],
    optionalTables: ["sysauto_report", "sysauto_template"],
    remediation:
      "Clear the Run as field on each Scheduled Script Execution, Scheduled Report and Scheduled Template Generation so it runs as system; a pinned user breaks on install when that user does not exist.",
    verdicts: {
      pass: "Every scheduled job in scope runs as system, or the scope ships none.",
      warn: "A job pins 'Run as' to a named user, no scope set, a trimmed read, or an unreadable Run as.",
      fail: "Never — install hygiene stays advisory.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the Scheduled Job 'Run as' gate (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      const reads: { table: JobTable; meta: TableQueryResult }[] = [];
      for (const table of JOB_TABLES) {
        try {
          // No `sysparm_limit`: auto-pagination inspects every job in scope.
          const meta = await ctx.http.table(table).queryWithMeta({
            sysparm_query: resolvedScope.clause,
            sysparm_fields: "sys_id,name,run_as",
          });
          reads.push({ table, meta });
        } catch (err) {
          // A sibling table its plugin does not provide ships no jobs.
          if (table !== "sysauto_script" && isMissingTable(err)) continue;
          throw err;
        }
      }
      const total = reads.reduce((n, r) => n + r.meta.rows.length, 0);

      if (total === 0) {
        const trimmed = reads.find((r) => triageZeroRead(r.meta) === "trimmed");
        if (trimmed) {
          return result(
            "warn",
            `Cannot inspect Scheduled Jobs in scope "${scope}": ${
              trimmed.meta.totalCount ?? "some"
            } ${trimmed.table} row(s) match but 0 are visible — the account is security-trimmed. Grant it read access to ${trimmed.table} to enable this gate.`,
          );
        }
        if (reads.every((r) => triageZeroRead(r.meta) === "empty")) {
          return result(
            "pass",
            `No Scheduled Jobs in scope "${scope}" — nothing to check.`,
          );
        }
        const unproven = reads
          .filter((r) => triageZeroRead(r.meta) === "ambiguous")
          .map((r) => r.table);
        return result(
          "warn",
          `No Scheduled Jobs visible in scope "${scope}" and no pre-trim count arrived for ${unproven.join(", ")} — either the app ships none, or the account cannot read them. Cannot confirm the 'Run as' gate.`,
        );
      }

      const pinned: string[] = [];
      const findings: Finding[] = [];
      for (const { table, meta } of reads) {
        for (const row of meta.rows) {
          if (str(row, "run_as") === "") continue;
          pinned.push(str(row, "name") || str(row, "sys_id") || "(unnamed)");
          findings.push(rowFinding(NAME, table, row, "runs-as-user"));
        }
      }
      // Rows that came back without a `run_as` key at all: the column is not
      // readable (or not on that table), so an empty Run as is not proven.
      const unread = reads
        .filter(
          (r) =>
            r.meta.rows.length > 0 &&
            r.meta.rows.every((row) => !("run_as" in row)),
        )
        .map((r) => r.table);
      const trimmed = reads
        .filter((r) => r.meta.securityTrimmed)
        .map((r) => r.table);
      // A zero-row read with no pre-trim count proves nothing either way.
      const unproven = reads
        .filter(
          (r) => r.meta.rows.length === 0 && triageZeroRead(r.meta) !== "empty",
        )
        .map((r) => r.table);
      const blind: string[] = [];
      if (unproven.length > 0) {
        blind.push(`no pre-trim count arrived for ${unproven.join(" and ")}`);
      }
      if (trimmed.length > 0) {
        blind.push(`the ${trimmed.join(" and ")} read was security-trimmed`);
      }
      if (unread.length > 0) {
        blind.push(`${unread.join(" and ")} returned no 'Run as' column`);
      }

      if (pinned.length > 0) {
        const note =
          blind.length > 0
            ? ` (Note: ${blind.join("; ")}, so this list may be incomplete.)`
            : "";
        return withFindings(
          result(
            "warn",
            `${pinned.length} Scheduled Job(s) have a non-empty 'Run as' — the pinned user may not exist on the customer instance and the job would silently stop: ${pinned.join(", ")}. Leave 'Run as' empty to run as system.` +
              note,
          ),
          findings,
        );
      }

      if (blind.length > 0) {
        return result(
          "warn",
          `Cannot fully inspect Scheduled Jobs in scope "${scope}" — ${blind.join("; ")}. The jobs this account cannot see are the ones this gate cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${total} Scheduled Job(s) in scope "${scope}" leave 'Run as' empty (run as system).`,
      );
    } catch (err) {
      return errorResult(NAME, "Scheduled Job 'Run as' settings", err);
    }
  },
};
