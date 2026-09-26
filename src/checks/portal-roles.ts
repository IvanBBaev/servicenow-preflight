import type {
  Check,
  CheckResult,
  CheckStatus,
  PreflightContext,
} from "../types.js";
import type { TableQueryResult } from "../http/client.js";
import { resolveScope } from "../http/query.js";
import { errorResult, isTruthy, str, triageZeroRead } from "./cert-common.js";

const NAME = "portal-roles";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** One of the two Service Portal tables this check inspects. */
interface PortalKind {
  table: "sp_widget" | "sp_page";
  /** Plural noun for messages. */
  noun: string;
  fields: string;
  /** Display handle for one row. */
  label(row: Record<string, unknown>): string;
}

const KINDS: readonly PortalKind[] = [
  {
    table: "sp_widget",
    noun: "widget(s)",
    fields: "sys_id,name,id,roles,public",
    label: (row) =>
      str(row, "name") || str(row, "id") || str(row, "sys_id") || "(unnamed)",
  },
  {
    table: "sp_page",
    noun: "page(s)",
    fields: "sys_id,id,title,roles,public",
    label: (row) =>
      str(row, "id") || str(row, "title") || str(row, "sys_id") || "(unnamed)",
  },
];

/** A `roles` glide_list holds comma-separated role names; blank entries don't count. */
function hasRoles(row: Record<string, unknown>): boolean {
  return str(row, "roles")
    .split(",")
    .some((role) => role.trim() !== "");
}

/** What one table's read turned up. */
interface KindFindings {
  kind: PortalKind;
  /** Rows with no role and `public` unset — open to every logged-in user. */
  noRole: string[];
  /** Rows with no role and `public` set — open without logging in. */
  publicNoRole: string[];
  /** A note when the read could not see everything (trimmed / ambiguous). */
  blindSpot?: string;
  /** Rows inspected. */
  count: number;
}

/** Read one portal table in scope and classify its rows. */
async function inspect(
  ctx: PreflightContext,
  clause: string,
  scope: string,
  kind: PortalKind,
): Promise<KindFindings> {
  // No `sysparm_limit`: auto-pagination inspects every row in the scope.
  const meta: TableQueryResult = await ctx.http
    .table(kind.table)
    .queryWithMeta({ sysparm_query: clause, sysparm_fields: kind.fields });
  const findings: KindFindings = {
    kind,
    noRole: [],
    publicNoRole: [],
    count: meta.rows.length,
  };
  if (meta.rows.length === 0) {
    const triage = triageZeroRead(meta);
    if (triage === "trimmed") {
      findings.blindSpot = `${kind.table}: ${
        meta.totalCount ?? "some"
      } match in scope "${scope}" but 0 are visible (security-trimmed)`;
    } else if (triage === "ambiguous") {
      findings.blindSpot = `${kind.table}: none visible in scope "${scope}" and no pre-trim count arrived — the app may ship none, or the account cannot read it`;
    }
    return findings;
  }
  for (const row of meta.rows) {
    if (hasRoles(row)) continue;
    (isTruthy(row, "public") ? findings.publicNoRole : findings.noRole).push(
      kind.label(row),
    );
  }
  if (meta.securityTrimmed) {
    findings.blindSpot = `${kind.table}: the read was security-trimmed, so some rows were not inspected`;
  }
  return findings;
}

/**
 * Certification rule 2.6 (`ci/certification/CHECKLIST.md`) — raised in 7 of
 * 19 releases: Service Portal widgets and pages carry roles unless they are
 * deliberately public. A widget or page with an empty `roles` list is open to
 * every logged-in user; with `public` set as well, to anyone without logging
 * in.
 *
 * Inspects every `sp_widget` and `sp_page` in the target scope. The rule
 * allows deliberate exceptions ("unless deliberately public"), which only a
 * reviewer can judge, so findings stay advisory — the check never fails:
 *
 * - **warn** — a widget or page has no roles (public ones listed separately),
 *   the scope is unset, or a read was security-trimmed or ambiguous.
 * - **pass** — every widget and page in scope carries at least one role, or
 *   the instance itself reports the scope ships none.
 */
export const portalRoles: Check = {
  name: NAME,
  description:
    "Service Portal widgets and pages carry roles unless deliberately public. Advisory.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the Service Portal widget/page roles check (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      const all: KindFindings[] = [];
      for (const kind of KINDS)
        all.push(await inspect(ctx, clause, scope, kind));

      const parts: string[] = [];
      for (const f of all) {
        if (f.publicNoRole.length > 0) {
          parts.push(
            `${f.publicNoRole.length} public ${f.kind.noun} with no roles — reachable without logging in: ${f.publicNoRole.join(", ")}`,
          );
        }
        if (f.noRole.length > 0) {
          parts.push(
            `${f.noRole.length} ${f.kind.noun} with no roles — open to every logged-in user: ${f.noRole.join(", ")}`,
          );
        }
      }
      const blind = all.flatMap((f) => (f.blindSpot ? [f.blindSpot] : []));

      if (parts.length > 0) {
        return result(
          "warn",
          `${parts.join("; ")}. Add roles, or record why each is deliberately open.` +
            (blind.length > 0
              ? ` (Not fully inspected: ${blind.join("; ")}.)`
              : ""),
        );
      }
      if (blind.length > 0) {
        return result(
          "warn",
          `Cannot fully confirm Service Portal roles in scope "${scope}": ${blind.join("; ")}. Grant the account read access to sp_widget and sp_page.`,
        );
      }

      const total = all.reduce((n, f) => n + f.count, 0);
      if (total === 0) {
        return result(
          "pass",
          `No Service Portal widgets or pages in scope "${scope}" — nothing to check.`,
        );
      }
      const [widgets, pages] = all;
      return result(
        "pass",
        `All ${widgets?.count ?? 0} widget(s) and ${pages?.count ?? 0} page(s) in scope "${scope}" carry at least one role.`,
      );
    } catch (err) {
      return errorResult(NAME, "Service Portal widget/page roles", err);
    }
  },
};
