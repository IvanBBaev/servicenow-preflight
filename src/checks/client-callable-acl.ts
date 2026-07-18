import type { Check, CheckResult, CheckStatus } from "../types.js";
import type { SnClient } from "../http/client.js";
import {
  and,
  chunk,
  eq,
  inClause,
  isSafeIdentifier,
  resolveScope,
} from "../http/query.js";
import { errorResult, isTruthy, str, triageZeroRead } from "./cert-common.js";

const NAME = "client-callable-acl";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** One client-callable Script Include and the names its execute ACL may use. */
interface ClientCallableSi {
  /** Display handle for messages: the SI name, falling back to api_name/sys_id. */
  label: string;
  /**
   * The charset-safe candidate ACL names (`name` and `api_name`, deduped).
   * Empty when neither survives validation — that SI cannot be verified.
   */
  candidates: string[];
}

/**
 * The execute ACLs matching the candidate names, fetched in batches. `names`
 * holds every active execute ACL's lowercased name; `inactiveNames` the ones
 * that exist but are switched off (an off gate is no gate); `trimmed` is true
 * when any batch was security-trimmed (`sys_security_acl` is admin-read
 * out-of-box, so a partially-readable ACL table must never clear the gate).
 */
async function fetchExecuteAcls(
  http: SnClient,
  candidateNames: readonly string[],
): Promise<{
  names: Set<string>;
  inactiveNames: Set<string>;
  trimmed: boolean;
}> {
  const names = new Set<string>();
  const inactiveNames = new Set<string>();
  let trimmed = false;
  for (const batch of chunk(candidateNames)) {
    // No `sysparm_limit`: the client auto-paginates, so every matching ACL in
    // the batch is seen (a cap could hide the one ACL that gates an SI).
    const { rows, securityTrimmed } = await http
      .table("sys_security_acl")
      .queryWithMeta({
        sysparm_query: and(
          eq("type", "client_callable_script_include"),
          inClause("name", batch),
        ),
        sysparm_fields: "sys_id,name,operation,active",
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      const name = str(row, "name").toLowerCase();
      if (name === "" || str(row, "operation").toLowerCase() !== "execute") {
        continue;
      }
      if (isTruthy(row, "active")) names.add(name);
      else inactiveNames.add(name);
    }
  }
  return { names, inactiveNames, trimmed };
}

/**
 * Certification rule 1.2 (`ci/certification/CHECKLIST.md`) — one of the most
 * systemic findings: every Script Include with **Client callable = true** must
 * be gated by an active
 * `client_callable_script_include` ACL (operation `execute`). Client-callable
 * means reachable from the browser via GlideAjax; without the execute ACL any
 * logged-in user can invoke it.
 *
 * This check verifies the ACL **exists and is active** for every active
 * client-callable Script Include in the target scope, matching the ACL `name`
 * against the SI's `name` and `api_name` (case-insensitive). Whether that ACL
 * is properly role/condition/script-gated is `acl-role-sanity`'s job — an
 * ungated execute ACL already warns there.
 *
 * - **fail** — an SI has no matching active execute ACL (or only an inactive
 *   one), an SI's name cannot be safely queried, or either read was
 *   security-trimmed (a partially visible table cannot clear the gate).
 * - **warn** — the scope is unset, or a zero-row read could not be
 *   distinguished from missing read access.
 * - **pass** — every active client-callable SI in scope has an active execute
 *   ACL, or the instance itself reports the scope ships none.
 */
export const clientCallableAcl: Check = {
  name: NAME,
  description:
    "Every client-callable Script Include is gated by an active execute ACL.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the client-callable Script Include ACL gate (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every SI in the scope.
      const meta = await ctx.http.table("sys_script_include").queryWithMeta({
        sysparm_query: and(
          resolvedScope.clause,
          eq("client_callable", "true"),
          eq("active", "true"),
        ),
        sysparm_fields: "sys_id,name,api_name",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect client-callable Script Includes in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_script_include; a zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `No active client-callable Script Includes in scope "${scope}" — nothing to gate.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No client-callable Script Includes visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_script_include. Cannot confirm the execute-ACL gate.`,
            );
        }
      }

      // Collect each SI's queryable ACL-name candidates. A name outside the
      // safe encoded-query charset cannot be looked up (the builder would
      // rightly refuse it), so that SI is unverifiable — reported, not skipped.
      const sis: ClientCallableSi[] = meta.rows.map((row) => {
        const name = str(row, "name");
        const apiName = str(row, "api_name");
        const label = name || apiName || str(row, "sys_id") || "(unnamed)";
        const candidates = [...new Set([name, apiName])].filter((n) =>
          isSafeIdentifier(n),
        );
        return { label, candidates };
      });

      const unverifiable = sis.filter((si) => si.candidates.length === 0);
      const allCandidates = [...new Set(sis.flatMap((si) => si.candidates))];
      const acls = await fetchExecuteAcls(ctx.http, allCandidates);

      const covered = (si: ClientCallableSi): boolean =>
        si.candidates.some((n) => acls.names.has(n.toLowerCase()));
      const inactiveOnly = (si: ClientCallableSi): boolean =>
        si.candidates.some((n) => acls.inactiveNames.has(n.toLowerCase()));

      const missing: string[] = [];
      const inactive: string[] = [];
      for (const si of sis) {
        if (si.candidates.length === 0 || covered(si)) continue;
        if (inactiveOnly(si)) inactive.push(si.label);
        else missing.push(si.label);
      }

      // Concrete findings outrank the trimmed-read verdict: they are already
      // actionable, and the message still flags the incomplete view.
      if (
        missing.length > 0 ||
        inactive.length > 0 ||
        unverifiable.length > 0
      ) {
        const parts: string[] = [];
        if (missing.length > 0) {
          parts.push(
            `${missing.length} client-callable Script Include(s) have no execute ACL — any logged-in user can invoke them via GlideAjax: ${missing.join(", ")}`,
          );
        }
        if (inactive.length > 0) {
          parts.push(
            `${inactive.length} are gated only by an INACTIVE execute ACL (an off gate is no gate): ${inactive.join(", ")}`,
          );
        }
        if (unverifiable.length > 0) {
          parts.push(
            `${unverifiable.length} could not be verified (name is not safely queryable): ${unverifiable
              .map((si) => si.label)
              .join(", ")}`,
          );
        }
        const trimmedNote =
          meta.securityTrimmed || acls.trimmed
            ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
            : "";
        return result("fail", parts.join("; ") + "." + trimmedNote);
      }

      // The SIs this account cannot see are exactly the ones this gate cannot
      // clear — a partially trimmed read never passes (same for the ACL side).
      if (meta.securityTrimmed || acls.trimmed) {
        return result(
          "fail",
          `Cannot fully inspect the client-callable Script Include ACL gate in scope "${scope}" — the ${
            meta.securityTrimmed ? "sys_script_include" : "sys_security_acl"
          } read was security-trimmed. Grant the account read access; the rows it cannot see are the ones this gate cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${sis.length} active client-callable Script Include(s) in scope "${scope}" are gated by an active execute ACL.`,
      );
    } catch (err) {
      return errorResult(NAME, "client-callable Script Include ACLs", err);
    }
  },
};
