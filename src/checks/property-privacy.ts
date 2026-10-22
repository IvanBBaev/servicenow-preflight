import type { Check, CheckResult, CheckStatus } from "../types.js";
import { and, eq, resolveScope } from "../http/query.js";
import { errorResult, isTruthy, str, triageZeroRead } from "./cert-common.js";

const NAME = "property-privacy";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** The `sys_properties.type` choices whose value is stored as a password. */
const PASSWORD_TYPES = new Set(["password", "password2"]);

/**
 * A property NAME that looks like it holds a secret. Only the name is tested —
 * property values are never read, so a match can never leak one.
 */
const SECRET_LIKE_NAME = /secret|token|password|passwd|api[_-]?key|credential/i;

/**
 * Adjacent to certification rule 1.7 (`ci/certification/CHECKLIST.md`) — no
 * hard-coded secrets in artifacts. A system property is the place an app is
 * *meant* to keep a secret, but only when it is both **password-typed** (the
 * value is encrypted at rest) and **private** (`is_private = true`, so the
 * value is left out of update sets and blanked on clone). A password-typed
 * property that is not private exports its value in every update set and
 * carries it onto every clone target.
 *
 * The check inspects every active `sys_properties` row the app ships in the
 * target scope (names and types only — values are never requested):
 *
 * - **fail** — a password-typed property is not private, the read was
 *   security-trimmed to zero rows, or a zero-row read could not be
 *   distinguished from missing read access.
 * - **warn** — a property whose name looks like a secret is not stored as a
 *   password type (the value is plain text in the export), or the scope is
 *   unset.
 * - **pass** — every property in scope is correctly typed and private, or the
 *   instance itself reports the scope ships none.
 */
export const propertyPrivacy: Check = {
  name: NAME,
  description:
    "Password-typed system properties are private; secret-like names use a password type.",
  meta: {
    requires: "scope",
    summary:
      "Every password-typed system property in scope is private (kept out of update sets and clones); a secret-like name with a plain type is flagged.",
    rule: "1.7",
    severity: "blocker",
    tables: ["sys_properties"],
    remediation:
      "Tick 'Private' on every password-typed property so its value stays out of update sets and is blanked on clone; change properties that hold secrets to the 'password2' type.",
    verdicts: {
      pass: "Every property in scope is private when password-typed, or the scope ships none.",
      warn: "A secret-like property name uses a non-password type, or no scope set.",
      fail: "A password-typed property is not private, or the read was security-trimmed to nothing.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the system property privacy check (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every property in the
      // scope. Only metadata columns are requested — never `value`.
      const meta = await ctx.http.table("sys_properties").queryWithMeta({
        sysparm_query: and(resolvedScope.clause, eq("active", "true")),
        sysparm_fields: "sys_id,name,type,is_private",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect system properties in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_properties to enable this gate.`,
            );
          case "empty":
            return result(
              "pass",
              `No active system properties in scope "${scope}" — nothing to check.`,
            );
          case "ambiguous":
            return result(
              "fail",
              `No system properties visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_properties. Cannot confirm the property privacy gate.`,
            );
        }
      }

      const exposed: string[] = [];
      const plainSecrets: string[] = [];
      for (const row of meta.rows) {
        const name = str(row, "name") || str(row, "sys_id") || "(unnamed)";
        const type = str(row, "type").toLowerCase();
        if (PASSWORD_TYPES.has(type)) {
          if (!isTruthy(row, "is_private")) exposed.push(name);
        } else if (SECRET_LIKE_NAME.test(name)) {
          plainSecrets.push(name);
        }
      }

      const trimmedNote = meta.securityTrimmed
        ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
        : "";

      if (exposed.length > 0) {
        const also =
          plainSecrets.length > 0
            ? ` Also ${plainSecrets.length} secret-like propert${
                plainSecrets.length === 1 ? "y" : "ies"
              } use a non-password type: ${plainSecrets.join(", ")}.`
            : "";
        return result(
          "fail",
          `${exposed.length} password-typed system propert${
            exposed.length === 1 ? "y is" : "ies are"
          } not private — the value is exported in update sets and copied on clone: ${exposed.join(", ")}. Tick 'Private' on each.` +
            also +
            trimmedNote,
        );
      }

      if (plainSecrets.length > 0) {
        return result(
          "warn",
          `${plainSecrets.length} system propert${
            plainSecrets.length === 1 ? "y has" : "ies have"
          } a secret-like name but a non-password type, so the value ships in plain text: ${plainSecrets.join(", ")}. Change the type to 'password2' and tick 'Private'.` +
            trimmedNote,
        );
      }

      if (meta.securityTrimmed) {
        return result(
          "fail",
          `Cannot fully inspect system properties in scope "${scope}" — the sys_properties read was security-trimmed. The properties this account cannot see are the ones this gate cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${meta.rows.length} active system propert${
          meta.rows.length === 1 ? "y" : "ies"
        } in scope "${scope}" are private when password-typed, and no secret-like name uses a plain type.`,
      );
    } catch (err) {
      return errorResult(NAME, "system property privacy", err);
    }
  },
};
