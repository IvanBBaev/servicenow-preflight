import type { Check, CheckResult, CheckStatus } from "../types.js";
import type { SnClient } from "../http/client.js";
import {
  and,
  chunk,
  eq,
  inClause,
  isSysId,
  resolveScope,
} from "../http/query.js";
import { errorResult, str, triageZeroRead } from "./cert-common.js";

const NAME = "ui-action-gating";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * A condition that gates nothing: empty, whitespace, or the literal `true`
 * (which the platform evaluates as "always show").
 */
function isVacuousCondition(condition: string): boolean {
  const c = condition.trim().replace(/;$/, "").trim();
  return c === "" || c.toLowerCase() === "true";
}

/** Display handle for one UI Action: `name (table)`, falling back to sys_id. */
function labelOf(row: Record<string, unknown>): string {
  const name = str(row, "name") || str(row, "sys_id") || "(unnamed)";
  const table = str(row, "table");
  return table ? `${name} (${table})` : name;
}

/**
 * The UI Action sys_ids that carry at least one "Requires role" entry — the
 * `sys_ui_action_role` m2m (`sys_ui_action` → `sys_user_role`), which is how
 * the platform stores a UI Action's roles. `trimmed` is true when any batch
 * was security-trimmed: an invisible role link could be the one gating an
 * action, so a trimmed read cannot prove an action ungated.
 */
async function fetchRoleGated(
  http: SnClient,
  actionIds: readonly string[],
): Promise<{ gated: Set<string>; trimmed: boolean }> {
  const gated = new Set<string>();
  let trimmed = false;
  for (const batch of chunk(actionIds)) {
    // No `sysparm_limit`: the client auto-paginates, so every link is seen.
    const { rows, securityTrimmed } = await http
      .table("sys_ui_action_role")
      .queryWithMeta({
        sysparm_query: inClause("sys_ui_action", batch),
        sysparm_fields: "sys_id,sys_ui_action,sys_user_role",
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      if (str(row, "sys_user_role") === "") continue;
      const id = str(row, "sys_ui_action");
      if (id !== "") gated.add(id);
    }
  }
  return { gated, trimmed };
}

/**
 * Certification rule 2.1 (`ci/certification/CHECKLIST.md`) — raised in 10 of
 * 19 releases: no UI Action may ship with an empty condition AND no Required
 * Roles. Such an action is shown to — and runnable by — every user who can see
 * the form or list it sits on.
 *
 * This check inspects every **active** UI Action in the target scope. One is
 * gated when it has a non-trivial `condition` (empty, whitespace or a bare
 * `true` count as none) or at least one "Requires role" entry in
 * `sys_ui_action_role`. Whether the condition itself is meaningful is left to
 * review — only its presence is checked.
 *
 * - **fail** — an active UI Action has neither a condition nor a role, an
 *   action's sys_id cannot be safely queried, or a read was security-trimmed
 *   (an invisible role link could be the gate, so ungated cannot be proven
 *   either way — the gate stays closed).
 * - **warn** — the scope is unset, or a zero-row read could not be
 *   distinguished from missing read access.
 * - **pass** — every active UI Action in scope is gated by a condition or a
 *   role, or the instance itself reports the scope ships none.
 */
export const uiActionGating: Check = {
  name: NAME,
  description:
    "Every active UI Action is gated by a condition or a Requires-role entry.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the UI Action gating check (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every action in scope.
      const meta = await ctx.http.table("sys_ui_action").queryWithMeta({
        sysparm_query: and(resolvedScope.clause, eq("active", "true")),
        sysparm_fields: "sys_id,name,table,condition",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect UI Actions in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_ui_action; a zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `No active UI Actions in scope "${scope}" — nothing to gate.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No active UI Actions visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_ui_action. Cannot confirm the UI Action gating check.`,
            );
        }
      }

      // Only actions without a condition need the role lookup. A sys_id that
      // is not a well-formed 32-hex id cannot be queried safely, so that
      // action is unverifiable — reported, not skipped.
      const noCondition = meta.rows.filter((row) =>
        isVacuousCondition(str(row, "condition")),
      );
      const unverifiable = noCondition
        .filter((row) => !isSysId(str(row, "sys_id")))
        .map(labelOf);
      const queryable = noCondition.filter((row) =>
        isSysId(str(row, "sys_id")),
      );
      const roles = await fetchRoleGated(
        ctx.http,
        queryable.map((row) => str(row, "sys_id")),
      );
      const ungated = queryable
        .filter((row) => !roles.gated.has(str(row, "sys_id")))
        .map(labelOf);

      if (ungated.length > 0 || unverifiable.length > 0) {
        const parts: string[] = [];
        if (ungated.length > 0) {
          parts.push(
            `${ungated.length} active UI Action(s) have no condition and no required role — every user who can see the form or list can run them: ${ungated.join(", ")}`,
          );
        }
        if (unverifiable.length > 0) {
          parts.push(
            `${unverifiable.length} could not be verified (sys_id is not safely queryable): ${unverifiable.join(", ")}`,
          );
        }
        const note = roles.trimmed
          ? " (Note: the sys_ui_action_role read was security-trimmed, so a role this account cannot see may gate some of these; grant read access to confirm.)"
          : meta.securityTrimmed
            ? " (Note: the sys_ui_action read was security-trimmed, so this list may be incomplete.)"
            : "";
        return result("fail", parts.join("; ") + "." + note);
      }

      // The rows this account cannot see are exactly the ones this gate
      // cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed || roles.trimmed) {
        return result(
          "fail",
          `Cannot fully inspect UI Action gating in scope "${scope}" — the ${
            meta.securityTrimmed ? "sys_ui_action" : "sys_ui_action_role"
          } read was security-trimmed. Grant the account read access; the rows it cannot see are the ones this gate cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${meta.rows.length} active UI Action(s) in scope "${scope}" are gated by a condition or a required role.`,
      );
    } catch (err) {
      return errorResult(NAME, "UI Action gating", err);
    }
  },
};
