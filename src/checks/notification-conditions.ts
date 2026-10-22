import type { Check, CheckResult, CheckStatus } from "../types.js";
import { and, eq, resolveScope } from "../http/query.js";
import { errorResult, isTruthy, str, triageZeroRead } from "./cert-common.js";

const NAME = "notification-conditions";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Install hygiene (no certification rule number): an active Notification
 * (`sysevent_email_action`) that is sent **on update** of its table, is not
 * tied to an event, and carries neither a condition nor an advanced
 * (scripted) condition fires on **every** update of every record in that
 * table. On a busy table that is a mail storm and an outbound-queue load, not
 * a feature.
 *
 * The check reads every active Notification the app ships in the target scope
 * (metadata only — the `advanced_condition` script is read solely to test
 * whether it is empty and is never echoed):
 *
 * - **warn** — a Notification fires unconditionally on update, naming it and
 *   its table; the scope is unset; the read was security-trimmed; or a
 *   zero-row read could not be distinguished from missing read access. (A
 *   runaway notification is a performance and spam risk, not a security
 *   rule, so findings stay advisory.)
 * - **pass** — every active Notification in scope is event-driven or
 *   conditioned, or the instance itself reports the scope ships none.
 */
export const notificationConditions: Check = {
  name: NAME,
  description:
    "No active Notification fires on every update of its table (no event, no condition).",
  meta: {
    requires: "scope",
    summary:
      "Every active 'send on update' Notification in scope is tied to an event or carries a condition, so none fires on every record update. Advisory — never fails.",
    severity: "advisory",
    tables: ["sysevent_email_action"],
    remediation:
      "Give the Notification a condition (or an advanced condition script), or trigger it from a specific event instead of 'Updated' on the whole table.",
    verdicts: {
      pass: "Every active Notification in scope is event-driven or conditioned, or the scope ships none.",
      warn: "A Notification fires on every update of its table, no scope set, or an unreadable table.",
      fail: "Never — install hygiene stays advisory.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the Notification condition check (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every active Notification.
      const meta = await ctx.http.table("sysevent_email_action").queryWithMeta({
        sysparm_query: and(resolvedScope.clause, eq("active", "true")),
        sysparm_fields:
          "sys_id,name,collection,event_name,condition,advanced_condition,action_insert,action_update",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "warn",
              `Cannot inspect Notifications in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sysevent_email_action to enable this check.`,
            );
          case "empty":
            return result(
              "pass",
              `No active Notifications in scope "${scope}" — nothing to check.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No Notifications visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sysevent_email_action. Cannot confirm the Notification condition check.`,
            );
        }
      }

      const unconditional = meta.rows
        .filter(
          (row) =>
            isTruthy(row, "action_update") &&
            str(row, "event_name") === "" &&
            str(row, "condition") === "" &&
            str(row, "advanced_condition") === "",
        )
        .map((row) => {
          const name = str(row, "name") || str(row, "sys_id") || "(unnamed)";
          const table = str(row, "collection");
          return table ? `${name} (${table})` : name;
        });

      if (unconditional.length > 0) {
        const trimmedNote = meta.securityTrimmed
          ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
          : "";
        return result(
          "warn",
          `${unconditional.length} Notification(s) fire on every update of their table — no event, no condition and no advanced condition: ${unconditional.join(", ")}. Add a condition or trigger them from a specific event.` +
            trimmedNote,
        );
      }

      if (meta.securityTrimmed) {
        return result(
          "warn",
          `Cannot fully inspect Notifications in scope "${scope}" — the sysevent_email_action read was security-trimmed. The Notifications this account cannot see are the ones this check cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${meta.rows.length} active Notification(s) in scope "${scope}" are event-driven or carry a condition.`,
      );
    } catch (err) {
      return errorResult(NAME, "Notification conditions", err);
    }
  },
};
