import type { Check, CheckResult, CheckStatus, Finding } from "../types.js";
import { and, eq, resolveScope } from "../http/query.js";
import {
  errorResult,
  rowFinding,
  str,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";

const NAME = "cors-rules";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** Display handle for a CORS rule in messages — never the domain value. */
function ruleLabel(row: Record<string, unknown>): string {
  return str(row, "name") || str(row, "sys_id") || "(unnamed)";
}

/** How permissive one CORS rule's origin is. */
export type CorsOriginVerdict = "wildcard" | "wildcard-subdomain" | "exact";

/**
 * Classify a `sys_cors_rule.domain` value. An optional scheme (`https://`) and
 * trailing slashes are ignored, so `https://*` is judged like `*`.
 *
 * - `"wildcard"` — empty, `*`, or a wildcard over a bare top-level label
 *   (`*.com`, `*com`): any site can call the app's REST APIs.
 * - `"wildcard-subdomain"` — a `*` anywhere else (`*.example.com`): every
 *   sub-domain of one owner is trusted.
 * - `"exact"` — a fully named origin.
 */
export function classifyCorsDomain(domain: string): CorsOriginVerdict {
  const origin = domain
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "");
  if (origin === "" || /^\*\.?[^.]*$/.test(origin)) return "wildcard";
  if (origin.includes("*")) return "wildcard-subdomain";
  return "exact";
}

/**
 * Certification rule 2.7 (`ci/certification/CHECKLIST.md`) — High: a CORS rule
 * must name an exact origin. A wildcard origin lets any web site call the app's
 * REST APIs from a signed-in user's browser.
 *
 * The check inspects every active `sys_cors_rule` in the target scope:
 *
 * - **fail** — a rule's domain is empty, `*`, or a wildcard over a bare
 *   top-level label (`*.com`); or the read was security-trimmed (a partially
 *   visible table cannot clear the gate).
 * - **warn** — a rule uses a wildcard sub-domain (`*.example.com`), the scope
 *   is unset, or a zero-row read could not be distinguished from missing read
 *   access.
 * - **pass** — every active rule names an exact origin, or the instance itself
 *   reports the scope ships none.
 *
 * Messages name rules only: the domain value is never echoed (TM-1).
 */
export const corsRules: Check = {
  name: NAME,
  description: "CORS rules name an exact origin (no wildcard).",
  meta: {
    requires: "scope",
    summary:
      "Active CORS rules in scope name an exact origin — never `*` or a bare-TLD wildcard.",
    rule: "2.7",
    severity: "blocker",
    tables: ["sys_cors_rule"],
    remediation:
      "Set each CORS rule's Domain to the fully-qualified origin that calls the API (e.g. https://app.customer.example.com) instead of * or a wildcard; ship one rule per trusted origin.",
    verdicts: {
      pass: "Every active CORS rule names an exact origin, or the scope ships none.",
      warn: "A rule uses a wildcard sub-domain, no scope set, or an ambiguous read.",
      fail: "A rule allows any origin (*, empty or *.tld), or the read was security-trimmed.",
    },
  },
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the CORS origin gate (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every rule in the scope.
      const meta = await ctx.http.table("sys_cors_rule").queryWithMeta({
        sysparm_query: and(resolvedScope.clause, eq("active", "true")),
        sysparm_fields:
          "sys_id,name,domain,rest_api,http_method,max_age,active",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect CORS rules in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_cors_rule; a zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `The app ships no CORS rules in scope "${scope}" — nothing to check.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No CORS rules visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_cors_rule. Cannot confirm the CORS origin gate.`,
            );
        }
      }

      const wildcard: string[] = [];
      const subdomain: string[] = [];
      const findings: Finding[] = [];
      for (const row of meta.rows) {
        const verdict = classifyCorsDomain(str(row, "domain"));
        if (verdict === "wildcard") {
          wildcard.push(ruleLabel(row));
          findings.push(
            rowFinding(NAME, "sys_cors_rule", row, "wildcard-origin"),
          );
        } else if (verdict === "wildcard-subdomain") {
          subdomain.push(ruleLabel(row));
          const finding = rowFinding(
            NAME,
            "sys_cors_rule",
            row,
            "wildcard-subdomain",
          );
          // Advisory even when a wildcard origin fails the row.
          finding.status = "warn";
          findings.push(finding);
        }
      }
      const done = (status: CheckStatus, message: string): CheckResult =>
        withFindings(result(status, message), findings);

      const trimmedNote = meta.securityTrimmed
        ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
        : "";
      if (wildcard.length > 0) {
        return done(
          "fail",
          `${wildcard.length} CORS rule(s) allow a wildcard origin: ${wildcard.join(", ")}. Name the exact origin that calls the API.` +
            trimmedNote,
        );
      }

      // The rules this account cannot see are exactly the ones this gate
      // cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed) {
        return done(
          "fail",
          `Cannot fully inspect CORS rules in scope "${scope}" — the sys_cors_rule read was security-trimmed. Grant the account read access; the rules it cannot see are the ones this gate cannot clear.`,
        );
      }

      if (subdomain.length > 0) {
        return done(
          "warn",
          `${subdomain.length} CORS rule(s) use a wildcard sub-domain: ${subdomain.join(", ")}. Prefer one rule per exact origin.`,
        );
      }

      return result(
        "pass",
        `Every in-scope CORS rule names an exact origin (${meta.rows.length} rule(s)).`,
      );
    } catch (err) {
      return errorResult(NAME, "CORS rules", err);
    }
  },
};
