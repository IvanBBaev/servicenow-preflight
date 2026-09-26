import type { Check, CheckResult, CheckStatus } from "../types.js";
import { isSafeIdentifier, resolveScope } from "../http/query.js";
import {
  errorResult,
  fetchNamedAcls,
  str,
  triageZeroRead,
} from "./cert-common.js";

const NAME = "ui-page-acl";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** One UI Page and the ACL name that must gate it. */
interface UiPage {
  /** Display handle for messages: the page name, falling back to sys_id. */
  label: string;
  /**
   * The name its `ui_page` read ACL carries: the endpoint without `.do`
   * (`x_acme_app_dashboard` for a scoped page), falling back to the page name
   * only when no endpoint was read. `undefined` when that name is not safely
   * queryable — the page cannot be verified.
   */
  aclName: string | undefined;
}

/**
 * The name a UI Page's read ACL must carry. A scoped page's endpoint is
 * `<scope>_<name>.do`, and the ACL is named for the endpoint, so the bare page
 * name is only a fallback: matching it for a scoped page would let an
 * unrelated global page's ACL of the same short name clear the gate.
 */
function aclNameFor(row: Record<string, unknown>): string {
  const endpoint = str(row, "endpoint");
  if (endpoint !== "") return endpoint.replace(/\.do$/i, "");
  return str(row, "name");
}

/**
 * Certification rule 2.2 (`ci/certification/CHECKLIST.md`) — raised in 13 of
 * 19 releases: every custom UI Page must be protected by a `ui_page` ACL for
 * the `read` operation, named for the page's endpoint (the URI without `.do`).
 * Without it, any logged-in user who knows the URL can open the page.
 *
 * This check verifies an **active** read ACL exists for every UI Page in the
 * target scope (case-insensitive name match). Whether that ACL is properly
 * role/condition/script-gated is `acl-role-sanity`'s job — an ungated read ACL
 * already warns there.
 *
 * - **fail** — a page has no matching active read ACL (or only an inactive
 *   one), a page's ACL name cannot be safely queried, or either read was
 *   security-trimmed (a partially visible table cannot clear the gate).
 * - **warn** — the scope is unset, or a zero-row read could not be
 *   distinguished from missing read access.
 * - **pass** — every UI Page in scope has an active read ACL, or the instance
 *   itself reports the scope ships none.
 */
export const uiPageAcl: Check = {
  name: NAME,
  description: "Every custom UI Page is protected by an active read ACL.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the UI Page read ACL gate (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every page in the scope.
      const meta = await ctx.http.table("sys_ui_page").queryWithMeta({
        sysparm_query: resolvedScope.clause,
        sysparm_fields: "sys_id,name,endpoint",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect UI Pages in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_ui_page; a zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `No UI Pages in scope "${scope}" — nothing to gate.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No UI Pages visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_ui_page. Cannot confirm the UI Page read ACL gate.`,
            );
        }
      }

      // A name outside the safe encoded-query charset cannot be looked up (the
      // builder would rightly refuse it), so that page is unverifiable —
      // reported, not skipped.
      const pages: UiPage[] = meta.rows.map((row) => {
        const aclName = aclNameFor(row);
        return {
          label: str(row, "name") || str(row, "sys_id") || "(unnamed)",
          aclName: isSafeIdentifier(aclName) ? aclName : undefined,
        };
      });

      const unverifiable = pages.filter((p) => p.aclName === undefined);
      const candidates = [
        ...new Set(
          pages.flatMap((p) => (p.aclName === undefined ? [] : [p.aclName])),
        ),
      ];
      const acls = await fetchNamedAcls(
        ctx.http,
        "ui_page",
        "read",
        candidates,
      );

      const missing: string[] = [];
      const inactive: string[] = [];
      for (const page of pages) {
        if (page.aclName === undefined) continue;
        const key = page.aclName.toLowerCase();
        if (acls.names.has(key)) continue;
        const label =
          page.label.toLowerCase() === key
            ? page.label
            : `${page.label} (${page.aclName})`;
        if (acls.inactiveNames.has(key)) inactive.push(label);
        else missing.push(label);
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
            `${missing.length} UI Page(s) have no read ACL — any logged-in user who knows the URL can open them: ${missing.join(", ")}`,
          );
        }
        if (inactive.length > 0) {
          parts.push(
            `${inactive.length} are protected only by an INACTIVE read ACL (an off gate is no gate): ${inactive.join(", ")}`,
          );
        }
        if (unverifiable.length > 0) {
          parts.push(
            `${unverifiable.length} could not be verified (endpoint is not safely queryable): ${unverifiable
              .map((p) => p.label)
              .join(", ")}`,
          );
        }
        const trimmedNote =
          meta.securityTrimmed || acls.trimmed
            ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
            : "";
        return result("fail", parts.join("; ") + "." + trimmedNote);
      }

      // The pages or ACLs this account cannot see are exactly the ones this
      // gate cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed || acls.trimmed) {
        return result(
          "fail",
          `Cannot fully inspect the UI Page read ACL gate in scope "${scope}" — the ${
            meta.securityTrimmed ? "sys_ui_page" : "sys_security_acl"
          } read was security-trimmed. Grant the account read access; the rows it cannot see are the ones this gate cannot clear.`,
        );
      }

      return result(
        "pass",
        `All ${pages.length} UI Page(s) in scope "${scope}" are protected by an active read ACL.`,
      );
    } catch (err) {
      return errorResult(NAME, "UI Page read ACLs", err);
    }
  },
};
