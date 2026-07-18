import type { Check, CheckResult, CheckStatus } from "../types.js";
import { resolveScope } from "../http/query.js";
import { errorResult, str, triageZeroRead } from "./cert-common.js";

const NAME = "scheduled-job-run-as";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Certification rule 6.2 (`ci/certification/CHECKLIST.md`) — Low severity: a
 * Scheduled Job's **Run as** must be empty so the job runs as `system`. A job
 * pinned to a named user references a record that may
 * not exist — or may be deactivated — on the customer instance, and the job
 * silently stops running after install.
 *
 * The check inspects every `sysauto_script` record the app ships in the target
 * scope (active or not — the record ships and gets reviewed either way):
 *
 * - **warn** — a job has a non-empty `run_as`, the scope is unset, the read was
 *   security-trimmed, or a zero-row read could not be distinguished from
 *   missing read access. (The rule is install hygiene, not a security hole, so
 *   findings stay advisory.)
 * - **pass** — every scheduled job in scope has an empty Run as, or the
 *   instance itself reports the scope ships none.
 */
export const scheduledJobRunAs: Check = {
  name: NAME,
  description: "Scheduled Jobs leave 'Run as' empty (run as system).",
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
      // No `sysparm_limit`: auto-pagination inspects every job in the scope.
      const meta = await ctx.http.table("sysauto_script").queryWithMeta({
        sysparm_query: resolvedScope.clause,
        sysparm_fields: "sys_id,name,run_as",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "warn",
              `Cannot inspect Scheduled Jobs in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sysauto_script to enable this gate.`,
            );
          case "empty":
            return result(
              "pass",
              `No Scheduled Jobs in scope "${scope}" — nothing to check.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No Scheduled Jobs visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sysauto_script. Cannot confirm the 'Run as' gate.`,
            );
        }
      }

      const pinned = meta.rows
        .filter((row) => str(row, "run_as") !== "")
        .map((row) => str(row, "name") || str(row, "sys_id") || "(unnamed)");

      if (pinned.length > 0) {
        const trimmedNote = meta.securityTrimmed
          ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
          : "";
        return result(
          "warn",
          `${pinned.length} Scheduled Job(s) have a non-empty 'Run as' — the pinned user may not exist on the customer instance and the job would silently stop: ${pinned.join(", ")}. Leave 'Run as' empty to run as system.` +
            trimmedNote,
        );
      }

      if (meta.securityTrimmed) {
        return result(
          "warn",
          `Cannot fully inspect Scheduled Jobs in scope "${scope}" — the sysauto_script read was security-trimmed. The jobs this account cannot see are the ones this gate cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${meta.rows.length} Scheduled Job(s) in scope "${scope}" leave 'Run as' empty (run as system).`,
      );
    } catch (err) {
      return errorResult(NAME, "Scheduled Job 'Run as' settings", err);
    }
  },
};
