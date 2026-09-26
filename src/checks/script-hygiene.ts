import type { Check, CheckResult, CheckStatus } from "../types.js";
import type { SnClient, TableQueryResult } from "../http/client.js";
import {
  chunk,
  inClause,
  isSafeIdentifier,
  resolveScope,
} from "../http/query.js";
import { errorResult, str, triageZeroRead } from "./cert-common.js";

const NAME = "script-hygiene";

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * Whether a script does nothing: empty once comments and whitespace are
 * removed, or only an empty IIFE wrapper. Comment stripping is deliberately
 * naive (it ignores string literals): comment-like text inside a string can
 * only make real code look shorter, never empty, because the surrounding
 * quotes and statement survive — so this cannot misreport working code.
 */
export function isEmptyScript(script: string): boolean {
  const code = script
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");
  return code === "" || /^\(function\(\)\{\}\)\(\);?$/.test(code);
}

/** Label for one Script Include: its api_name, else name, else sys_id. */
function siLabel(row: Record<string, unknown>): string {
  return (
    str(row, "api_name") ||
    str(row, "name") ||
    str(row, "sys_id") ||
    "(unnamed)"
  );
}

/** Note for a zero-row / trimmed read of one table, or undefined when clean. */
function blindSpot(
  table: string,
  scope: string,
  meta: TableQueryResult,
): string | undefined {
  if (meta.rows.length === 0) {
    const triage = triageZeroRead(meta);
    if (triage === "trimmed") {
      return `${table}: ${meta.totalCount ?? "some"} match in scope "${scope}" but 0 are visible (security-trimmed)`;
    }
    if (triage === "ambiguous") {
      return `${table}: none visible in scope "${scope}" and no pre-trim count arrived — the app may ship none, or the account cannot read it`;
    }
    return undefined;
  }
  return meta.securityTrimmed
    ? `${table}: the read was security-trimmed, so some rows were not inspected`
    : undefined;
}

/**
 * Script Includes OUTSIDE the scope that share a name with one of `names`
 * (lowercased name → the other scopes' api_names). `ownIds` are the scope's
 * own Script Include sys_ids, excluded from the result.
 */
async function fetchNameClashes(
  http: SnClient,
  names: readonly string[],
  ownIds: ReadonlySet<string>,
): Promise<{ clashes: Map<string, string[]>; trimmed: boolean }> {
  const clashes = new Map<string, string[]>();
  let trimmed = false;
  for (const batch of chunk(names)) {
    // No `sysparm_limit`: the client auto-paginates, so every clash is seen.
    const { rows, securityTrimmed } = await http
      .table("sys_script_include")
      .queryWithMeta({
        sysparm_query: inClause("name", batch),
        sysparm_fields: "sys_id,name,api_name",
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      if (ownIds.has(str(row, "sys_id"))) continue;
      const key = str(row, "name").toLowerCase();
      if (key === "") continue;
      const list = clashes.get(key) ?? [];
      list.push(siLabel(row));
      clashes.set(key, list);
    }
  }
  return { clashes, trimmed };
}

/**
 * Certification rule 4.10 (`ci/certification/CHECKLIST.md`) — raised in 5–8
 * of 19 releases: delete Fix Scripts that contain only comments, and avoid
 * Script Includes with duplicate names.
 *
 * - **Empty Fix Scripts** — every `sys_script_fix` in scope whose script is
 *   empty, comments only, or an empty IIFE (see {@link isEmptyScript}): dead
 *   metadata that still ships and still gets reviewed.
 * - **Duplicate Script Include names** — two Script Includes in the scope with
 *   the same name (case-insensitive), and scope Script Includes whose name is
 *   also used in another scope, where an unqualified `new Name()` can resolve
 *   to the wrong one. Names outside the safe query charset are not
 *   cross-checked.
 *
 * Best-practice hygiene the rule lets you resolve or justify, so it stays
 * advisory — the check never fails:
 *
 * - **warn** — any finding above, the scope is unset, or a read was trimmed or
 *   ambiguous.
 * - **pass** — no empty Fix Scripts and no duplicate names, with every read
 *   complete (or the instance reports the scope ships neither).
 */
export const scriptHygiene: Check = {
  name: NAME,
  description:
    "No comment-only Fix Scripts and no duplicate-named Script Includes. Advisory.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the Fix Script / Script Include hygiene check (pass a scope to enable it).",
      );
    }

    try {
      const { clause } = await resolveScope(ctx, scope);
      // No `sysparm_limit` on either read: auto-pagination sees every row.
      const fixes = await ctx.http.table("sys_script_fix").queryWithMeta({
        sysparm_query: clause,
        sysparm_fields: "sys_id,name,script",
      });
      const includes = await ctx.http
        .table("sys_script_include")
        .queryWithMeta({
          sysparm_query: clause,
          sysparm_fields: "sys_id,name,api_name",
        });

      const emptyFixes = fixes.rows
        .filter((row) => isEmptyScript(str(row, "script")))
        .map((row) => str(row, "name") || str(row, "sys_id") || "(unnamed)");

      const byName = new Map<string, string[]>();
      for (const row of includes.rows) {
        const key = str(row, "name").toLowerCase();
        if (key === "") continue;
        const list = byName.get(key) ?? [];
        list.push(siLabel(row));
        byName.set(key, list);
      }
      const inScopeDupes = [...byName.values()].filter((l) => l.length > 1);

      const ownIds = new Set(includes.rows.map((row) => str(row, "sys_id")));
      const names = [
        ...new Set(
          includes.rows
            .map((row) => str(row, "name"))
            .filter((n) => isSafeIdentifier(n)),
        ),
      ];
      const { clashes, trimmed: clashTrimmed } = await fetchNameClashes(
        ctx.http,
        names,
        ownIds,
      );
      const crossScope: string[] = [];
      for (const [key, others] of clashes) {
        const mine = byName.get(key) ?? [];
        crossScope.push(`${mine.join("/")} ↔ ${others.join(", ")}`);
      }

      const parts: string[] = [];
      if (emptyFixes.length > 0) {
        parts.push(
          `${emptyFixes.length} Fix Script(s) do nothing (empty or comments only) — delete them: ${emptyFixes.join(", ")}`,
        );
      }
      if (inScopeDupes.length > 0) {
        parts.push(
          `${inScopeDupes.length} Script Include name(s) are used more than once in the scope: ${inScopeDupes
            .map((l) => l.join(" / "))
            .join("; ")}`,
        );
      }
      if (crossScope.length > 0) {
        parts.push(
          `${crossScope.length} Script Include name(s) are also used in another scope, so an unqualified call can resolve to the wrong one: ${crossScope.join("; ")}`,
        );
      }

      const blind = [
        blindSpot("sys_script_fix", scope, fixes),
        blindSpot("sys_script_include", scope, includes),
        clashTrimmed
          ? "sys_script_include (other scopes): the name-clash read was security-trimmed"
          : undefined,
      ].filter((b): b is string => b !== undefined);

      if (parts.length > 0) {
        return result(
          "warn",
          `${parts.join(". ")}.` +
            (blind.length > 0
              ? ` (Not fully inspected: ${blind.join("; ")}.)`
              : ""),
        );
      }
      if (blind.length > 0) {
        return result(
          "warn",
          `Cannot fully confirm Fix Script / Script Include hygiene in scope "${scope}": ${blind.join("; ")}.`,
        );
      }
      if (fixes.rows.length === 0 && includes.rows.length === 0) {
        return result(
          "pass",
          `No Fix Scripts or Script Includes in scope "${scope}" — nothing to check.`,
        );
      }
      return result(
        "pass",
        `All ${fixes.rows.length} Fix Script(s) in scope "${scope}" do work, and its ${includes.rows.length} Script Include(s) have unique names.`,
      );
    } catch (err) {
      return errorResult(NAME, "Fix Script / Script Include hygiene", err);
    }
  },
};
