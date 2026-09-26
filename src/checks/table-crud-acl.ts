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

const NAME = "table-crud-acl";

/** The four table-level operations every custom table must gate. */
const CRUD_OPERATIONS = ["create", "read", "write", "delete"] as const;

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/** One in-scope custom table, as the gate needs it. */
interface ScopedTable {
  /** Table name (`x_acme_asset`) — also the name of its table-level ACLs. */
  name: string;
  /**
   * The parent table's name when it extends one (`task`), else "". A child
   * table inherits its parent's table ACLs at runtime, so a gap there is
   * advisory rather than an open door.
   */
  parent: string;
  /** Whether it extends another table at all (the parent name may be unread). */
  extended: boolean;
}

/**
 * The table-level `record` ACLs for the given table names, fetched in batches:
 * `active` maps each lowercased table name to the operations an ACTIVE ACL
 * gates, `inactive` to those only an inactive ACL names (an off gate is no
 * gate). `trimmed` is true when any batch was security-trimmed —
 * `sys_security_acl` is admin-read out-of-box, so a partially readable ACL
 * table must never clear the gate. Field-level ACLs (`table.field`,
 * `table.*`) never match: only an exact table name is a table-level ACL.
 */
async function fetchTableAcls(
  http: SnClient,
  tableNames: readonly string[],
): Promise<{
  active: Map<string, Set<string>>;
  inactive: Map<string, Set<string>>;
  trimmed: boolean;
}> {
  const active = new Map<string, Set<string>>();
  const inactive = new Map<string, Set<string>>();
  let trimmed = false;
  const add = (map: Map<string, Set<string>>, table: string, op: string) => {
    let ops = map.get(table);
    if (!ops) {
      ops = new Set<string>();
      map.set(table, ops);
    }
    ops.add(op);
  };
  for (const batch of chunk(tableNames)) {
    // No `sysparm_limit`: the client auto-paginates, so every table-level ACL
    // in the batch is seen (a cap could hide the one ACL that gates a table).
    const { rows, securityTrimmed } = await http
      .table("sys_security_acl")
      .queryWithMeta({
        sysparm_query: and(eq("type", "record"), inClause("name", batch)),
        sysparm_fields: "sys_id,name,operation,active",
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      const table = str(row, "name").toLowerCase();
      const op = str(row, "operation").toLowerCase();
      if (
        table === "" ||
        !(CRUD_OPERATIONS as readonly string[]).includes(op)
      ) {
        continue;
      }
      add(isTruthy(row, "active") ? active : inactive, table, op);
    }
  }
  return { active, inactive, trimmed };
}

/**
 * Describe one table's gap: which CRUD operations have no active ACL, with the
 * ones covered only by an INACTIVE ACL called out separately.
 */
function describeGap(
  table: ScopedTable,
  missing: readonly string[],
  inactiveOps: ReadonlySet<string> | undefined,
): string {
  const off = missing.filter((op) => inactiveOps?.has(op));
  const none = missing.filter((op) => !inactiveOps?.has(op));
  const parts: string[] = [];
  if (none.length > 0) parts.push(`no ${none.join("/")} ACL`);
  if (off.length > 0) parts.push(`${off.join("/")} ACL inactive`);
  return `${table.name} (${parts.join("; ")})`;
}

/**
 * Certification rule 1.1 (`ci/certification/CHECKLIST.md`) — raised in 16 of
 * 19 releases: every custom table the app ships must carry table-level
 * Create / Read / Write / Delete ACLs. A table with no ACL for an operation
 * falls through to whatever the instance's defaults allow, which is exactly
 * the finding certification raises.
 *
 * This check verifies an **active** table-level `record` ACL exists for each
 * of the four operations on every table in the target scope (ACL `name` equals
 * the table name, case-insensitive). Whether each ACL is properly
 * role/condition/script-gated is `acl-role-sanity`'s job — an ungated ACL
 * already fails (mutating) or warns (read) there.
 *
 * - **fail** — a base table lacks an active ACL for an operation (or has only
 *   an inactive one), a table name cannot be safely queried, or either read
 *   was security-trimmed (a partially visible table cannot clear the gate).
 * - **warn** — the scope is unset; a zero-row read could not be distinguished
 *   from missing read access; or only tables that extend another table have
 *   gaps (they inherit the parent's ACLs at runtime, but certification expects
 *   app-specific ones).
 * - **pass** — every table in scope has all four active ACLs, or the instance
 *   itself reports the scope ships no tables.
 */
export const tableCrudAcl: Check = {
  name: NAME,
  description:
    "Every custom table has active table-level create, read, write and delete ACLs.",
  async run(ctx): Promise<CheckResult> {
    const scope = ctx.scope?.trim();
    if (!scope) {
      return result(
        "warn",
        "No scope set — skipping the table CRUD ACL gate (pass a scope to enable it).",
      );
    }

    try {
      const resolvedScope = await resolveScope(ctx, scope);
      // No `sysparm_limit`: auto-pagination inspects every table in the scope.
      const meta = await ctx.http.table("sys_db_object").queryWithMeta({
        sysparm_query: resolvedScope.clause,
        sysparm_fields: "sys_id,name,super_class,super_class.name",
      });

      if (meta.rows.length === 0) {
        switch (triageZeroRead(meta)) {
          case "trimmed":
            return result(
              "fail",
              `Cannot inspect the tables in scope "${scope}": ${
                meta.totalCount ?? "some"
              } match but 0 are visible — the account is security-trimmed. Grant it read access to sys_db_object; a zero-row read is not proof of safety.`,
            );
          case "empty":
            return result(
              "pass",
              `No tables in scope "${scope}" — nothing to gate.`,
            );
          case "ambiguous":
            return result(
              "warn",
              `No tables visible in scope "${scope}" and no pre-trim count arrived — either the app ships none, or the account cannot read sys_db_object. Cannot confirm the table CRUD ACL gate.`,
            );
        }
      }

      // A table name outside the safe encoded-query charset cannot be looked
      // up (the builder would rightly refuse it), so that table is
      // unverifiable — reported, not skipped.
      const tables: ScopedTable[] = [];
      const unverifiable: string[] = [];
      for (const row of meta.rows) {
        const name = str(row, "name");
        if (!isSafeIdentifier(name)) {
          unverifiable.push(name || str(row, "sys_id") || "(unnamed)");
          continue;
        }
        tables.push({
          name,
          parent: str(row, "super_class.name"),
          extended: str(row, "super_class") !== "",
        });
      }

      const acls = await fetchTableAcls(ctx.http, [
        ...new Set(tables.map((t) => t.name)),
      ]);

      const baseGaps: string[] = [];
      const inheritedGaps: string[] = [];
      for (const table of tables) {
        const key = table.name.toLowerCase();
        const covered = acls.active.get(key);
        const missing = CRUD_OPERATIONS.filter((op) => !covered?.has(op));
        if (missing.length === 0) continue;
        const gap = describeGap(table, missing, acls.inactive.get(key));
        if (table.extended) {
          inheritedGaps.push(
            `${gap} — inherits from ${table.parent ? `"${table.parent}"` : "its parent table"}`,
          );
        } else {
          baseGaps.push(gap);
        }
      }

      const trimmedNote =
        meta.securityTrimmed || acls.trimmed
          ? " (Note: the read was security-trimmed, so this list may be incomplete.)"
          : "";

      // Concrete findings outrank the trimmed-read verdict: they are already
      // actionable, and the message still flags the incomplete view.
      if (baseGaps.length > 0 || unverifiable.length > 0) {
        const parts: string[] = [];
        if (baseGaps.length > 0) {
          parts.push(
            `${baseGaps.length} table(s) lack an active table-level ACL for every CRUD operation: ${baseGaps.join(", ")}`,
          );
        }
        if (unverifiable.length > 0) {
          parts.push(
            `${unverifiable.length} table(s) could not be verified (name is not safely queryable): ${unverifiable.join(", ")}`,
          );
        }
        if (inheritedGaps.length > 0) {
          parts.push(
            `${inheritedGaps.length} extended table(s) also rely on inherited ACLs: ${inheritedGaps.join(", ")}`,
          );
        }
        return result("fail", parts.join("; ") + "." + trimmedNote);
      }

      // The tables or ACLs this account cannot see are exactly the ones this
      // gate cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed || acls.trimmed) {
        return result(
          "fail",
          `Cannot fully inspect the table CRUD ACL gate in scope "${scope}" — the ${
            meta.securityTrimmed ? "sys_db_object" : "sys_security_acl"
          } read was security-trimmed. Grant the account read access; the rows it cannot see are the ones this gate cannot clear.` +
            (inheritedGaps.length > 0
              ? ` Of those visible, ${inheritedGaps.length} extended table(s) rely on inherited ACLs: ${inheritedGaps.join(", ")}.`
              : ""),
        );
      }

      if (inheritedGaps.length > 0) {
        return result(
          "warn",
          `${inheritedGaps.length} extended table(s) in scope "${scope}" have no app-specific ACL for some CRUD operations and rely on their parent's ACLs at runtime; certification expects app-specific ACLs: ${inheritedGaps.join(", ")}.`,
        );
      }

      return result(
        "pass",
        `All ${tables.length} table(s) in scope "${scope}" have active create, read, write and delete ACLs.`,
      );
    } catch (err) {
      return errorResult(NAME, "table CRUD ACLs", err);
    }
  },
};
