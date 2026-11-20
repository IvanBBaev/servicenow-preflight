import type { Check, CheckResult, CheckStatus, Finding } from "../types.js";
import type { SnClient } from "../http/client.js";
import {
  and,
  chunk,
  eq,
  inClause,
  isSafeIdentifier,
  resolveScope,
  type ResolvedScope,
} from "../http/query.js";
import {
  ACL_SCOPE_FIELDS,
  aclInScope,
  aclOperation,
  errorResult,
  isTruthy,
  rowFinding,
  str,
  subjectFinding,
  triageZeroRead,
  withFindings,
} from "./cert-common.js";

const NAME = "table-crud-acl";

/** The four table-level operations every custom table must gate. */
const CRUD_OPERATIONS = ["create", "read", "write", "delete"] as const;

/** Build a well-formed result for this check. */
function result(status: CheckStatus, message: string): CheckResult {
  return { name: NAME, status, message };
}

/**
 * How deep a parent chain is followed. Real hierarchies are a handful of
 * levels (`cmdb_ci_linux_server` is ~6); a longer one is treated as unreadable.
 */
const MAX_CHAIN_DEPTH = 20;

/** One in-scope custom table, as the gate needs it. */
interface ScopedTable {
  /** Table name (`x_acme_asset`) — also the name of its table-level ACLs. */
  name: string;
  /**
   * The parent table's name when it extends one (`task`), else "" — for
   * messages only; the chain itself is walked by sys_id.
   */
  parent: string;
  /** The parent's `sys_db_object` sys_id, "" for a base table. */
  parentId: string;
  /** Whether it extends another table at all (the parent name may be unread). */
  extended: boolean;
}

/** A table's ancestors, nearest first, and whether the whole chain was read. */
interface ParentChain {
  /** Ancestor table names (lowercased), nearest parent first. */
  names: string[];
  /** True when some link could not be read (trimmed, missing, cyclic, too deep). */
  broken: boolean;
}

/**
 * Walk each extended table's parent chain through `sys_db_object` by sys_id,
 * one batched read per level (ACL-14). A child inherits its ancestors' table
 * ACLs at runtime, so the gate needs to know WHICH ancestors exist before it
 * can call a child's gap "inherited". `known` seeds the walk with the rows
 * already read. A parent that cannot be read — trimmed, absent, an unsafe
 * name, a cycle, or a chain deeper than {@link MAX_CHAIN_DEPTH} — marks the
 * chain broken: inheritance through it is unproven.
 */
async function fetchParentChains(
  http: SnClient,
  tables: readonly ScopedTable[],
  known: Map<string, { name: string; parentId: string }>,
): Promise<Map<string, ParentChain>> {
  const unreadable = new Set<string>();
  let pending = [
    ...new Set(tables.map((t) => t.parentId).filter((id) => id !== "")),
  ];
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && pending.length > 0; depth++) {
    const wanted = pending.filter(
      (id) => !known.has(id) && !unreadable.has(id),
    );
    for (const ids of chunk(wanted.filter((id) => isSafeIdentifier(id)))) {
      // No `sysparm_limit`: the client auto-paginates.
      const { rows } = await http.table("sys_db_object").queryWithMeta({
        sysparm_query: inClause("sys_id", ids),
        sysparm_fields: "sys_id,name,super_class",
      });
      for (const row of rows) {
        const id = str(row, "sys_id");
        if (id) {
          known.set(id, {
            name: str(row, "name"),
            parentId: str(row, "super_class"),
          });
        }
      }
    }
    // Asked for but not returned (trimmed or gone), or not safely queryable.
    for (const id of wanted) if (!known.has(id)) unreadable.add(id);
    pending = [
      ...new Set(
        pending
          .map((id) => known.get(id)?.parentId ?? "")
          .filter((id) => id !== ""),
      ),
    ];
  }

  const chains = new Map<string, ParentChain>();
  for (const table of tables) {
    if (!table.extended) continue;
    const names: string[] = [];
    const seen = new Set<string>();
    let broken = false;
    let id = table.parentId;
    while (id !== "") {
      const parent = known.get(id);
      if (
        !parent ||
        seen.has(id) ||
        seen.size >= MAX_CHAIN_DEPTH ||
        !isSafeIdentifier(parent.name)
      ) {
        broken = true;
        break;
      }
      seen.add(id);
      names.push(parent.name.toLowerCase());
      id = parent.parentId;
    }
    chains.set(table.name.toLowerCase(), { names, broken });
  }
  return chains;
}

/**
 * The table-level `record` ACLs for the given table names, fetched in batches:
 * `shipped` maps each lowercased table name to the operations an ACTIVE ACL in
 * the target scope gates; `foreign` to those an active ACL gates only from
 * another scope (it exists on this instance but does not ship with the app —
 * ACL-2); `inactive` to those only an inactive ACL names (an off gate is no
 * gate). The operation is read by name (ACL-6). `trimmed` is true when any
 * batch was security-trimmed —
 * `sys_security_acl` is admin-read out-of-box, so a partially readable ACL
 * table must never clear the gate. Field-level ACLs (`table.field`,
 * `table.*`) never match: only an exact table name is a table-level ACL.
 */
async function fetchTableAcls(
  http: SnClient,
  tableNames: readonly string[],
  scope: ResolvedScope,
): Promise<{
  shipped: Map<string, Set<string>>;
  foreign: Map<string, Set<string>>;
  inactive: Map<string, Set<string>>;
  trimmed: boolean;
}> {
  const shipped = new Map<string, Set<string>>();
  const foreign = new Map<string, Set<string>>();
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
        sysparm_fields: `sys_id,name,operation,operation.name,active,${ACL_SCOPE_FIELDS}`,
      });
    trimmed = trimmed || securityTrimmed;
    for (const row of rows) {
      const table = str(row, "name").toLowerCase();
      const op = aclOperation(row);
      if (
        table === "" ||
        !(CRUD_OPERATIONS as readonly string[]).includes(op)
      ) {
        continue;
      }
      if (!isTruthy(row, "active")) add(inactive, table, op);
      else add(aclInScope(row, scope) ? shipped : foreign, table, op);
    }
  }
  return { shipped, foreign, inactive, trimmed };
}

/**
 * Describe one table's gap: which CRUD operations have no active ACL that
 * ships, with the ones covered only from another scope, or only by an
 * INACTIVE ACL, called out separately.
 */
function describeGap(
  table: ScopedTable,
  missing: readonly string[],
  foreignOps: ReadonlySet<string> | undefined,
  inactiveOps: ReadonlySet<string> | undefined,
): string {
  const elsewhere = missing.filter((op) => foreignOps?.has(op));
  const off = missing.filter(
    (op) => !foreignOps?.has(op) && inactiveOps?.has(op),
  );
  const none = missing.filter(
    (op) => !foreignOps?.has(op) && !inactiveOps?.has(op),
  );
  const parts: string[] = [];
  if (none.length > 0) parts.push(`no ${none.join("/")} ACL`);
  if (elsewhere.length > 0) {
    parts.push(
      `${elsewhere.join("/")} ACL exists but does not ship (another scope)`,
    );
  }
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
 * This check verifies an **active** table-level `record` ACL that ships in the
 * target scope exists for each of the four operations on every table in that
 * scope (ACL `name` equals the table name, case-insensitive). An ACL for the
 * table that lives only in another scope — e.g. a global ACL made on the dev
 * instance — does not travel with the app and does not count. Whether each ACL
 * is properly
 * role/condition/script-gated is `acl-role-sanity`'s job — an ungated ACL
 * already fails (mutating) or warns (read) there.
 *
 * - **fail** — a base table lacks a shipped active ACL for an operation (none,
 *   only an inactive one, or only one in another scope); an extended table
 *   lacks one and no ancestor's active ACL covers the operation, or its parent
 *   chain could not be read; a table name cannot be safely queried; or a read
 *   was security-trimmed (a partially visible table cannot clear the gate).
 * - **warn** — the scope is unset; a zero-row read could not be distinguished
 *   from missing read access; or only extended tables have gaps that an
 *   ancestor's active ACL covers (inherited at runtime, but certification
 *   expects app-specific ones).
 * - **pass** — every table in scope has all four active ACLs, or the instance
 *   itself reports the scope ships no tables.
 */
export const tableCrudAcl: Check = {
  name: NAME,
  description:
    "Every custom table has active table-level create, read, write and delete ACLs.",
  meta: {
    requires: "scope",
    rule: "1.1",
    severity: "blocker",
    tables: ["sys_db_object", "sys_security_acl"],
    remediation:
      "Create active table-level create, read, write and delete ACLs for every custom table in the app scope and bind each to an app role (not public); an extended table may inherit from its parent, but declare its own ACLs when it needs different access.",
    verdicts: {
      pass: "Every table in scope has all four active ACLs, or the scope ships none.",
      warn: "Only extended tables have gaps an ancestor covers, no scope set, or an ambiguous zero-row read.",
      fail: "A table lacks a shipped CRUD ACL no ancestor covers, or a read was security-trimmed.",
    },
  },
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
      const findings: Finding[] = [];
      // Every table row already read, by sys_id — the parent-chain walk starts
      // from these instead of re-reading in-scope parents.
      const known = new Map<string, { name: string; parentId: string }>();
      for (const row of meta.rows) {
        const id = str(row, "sys_id");
        if (id) {
          known.set(id, {
            name: str(row, "name"),
            parentId: str(row, "super_class"),
          });
        }
      }
      for (const row of meta.rows) {
        const name = str(row, "name");
        if (!isSafeIdentifier(name)) {
          unverifiable.push(name || str(row, "sys_id") || "(unnamed)");
          findings.push(rowFinding(NAME, "sys_db_object", row, "unverifiable"));
          continue;
        }
        const parentId = str(row, "super_class");
        tables.push({
          name,
          parent: str(row, "super_class.name"),
          parentId,
          extended: parentId !== "",
        });
      }

      const chains = await fetchParentChains(ctx.http, tables, known);
      const inScopeNames = new Set(tables.map((t) => t.name.toLowerCase()));
      const ancestorNames = [...chains.values()].flatMap((c) => c.names);
      const acls = await fetchTableAcls(
        ctx.http,
        [
          ...new Set([
            ...tables.map((t) => t.name),
            ...ancestorNames.filter((n) => !inScopeNames.has(n)),
          ]),
        ],
        resolvedScope,
      );

      // Does an ancestor's ACL gate `op`? An in-scope ancestor must ship its
      // ACL like any app table; an ancestor from another scope (`task`) is
      // covered by any active ACL its own owner provides.
      const ancestorCovers = (chain: ParentChain, op: string): string => {
        for (const name of chain.names) {
          if (acls.shipped.get(name)?.has(op)) return name;
          if (!inScopeNames.has(name) && acls.foreign.get(name)?.has(op)) {
            return name;
          }
        }
        return "";
      };

      const baseGaps: string[] = [];
      const inheritedGaps: string[] = [];
      for (const table of tables) {
        const key = table.name.toLowerCase();
        const covered = acls.shipped.get(key);
        const missing = CRUD_OPERATIONS.filter((op) => !covered?.has(op));
        if (missing.length === 0) continue;
        const gap = describeGap(
          table,
          missing,
          acls.foreign.get(key),
          acls.inactive.get(key),
        );
        const chain = chains.get(key);
        const inheritedFrom = new Map<string, string>();
        for (const op of missing) {
          const from = chain ? ancestorCovers(chain, op) : "";
          if (from !== "") inheritedFrom.set(op, from);
          const finding = subjectFinding(
            NAME,
            `table:${table.name}`,
            table.name,
            `acl-missing:${op}`,
          );
          // An op an ancestor's ACL gates is inherited at runtime: advisory
          // even when the row fails on another table.
          if (from !== "") finding.status = "warn";
          findings.push(finding);
        }
        const uncovered = missing.filter((op) => !inheritedFrom.has(op));
        if (!chain) {
          baseGaps.push(gap);
        } else if (uncovered.length === 0) {
          const from = [...new Set(inheritedFrom.values())];
          inheritedGaps.push(
            `${gap} — inherits from ${from.map((n) => `"${n}"`).join(", ")}`,
          );
        } else if (chain.broken) {
          baseGaps.push(
            `${gap} — its parent chain could not be read, so no ancestor is shown to gate ${uncovered.join("/")}`,
          );
        } else {
          baseGaps.push(
            `${gap} — no ancestor (${chain.names.map((n) => `"${n}"`).join(" → ")}) gates ${uncovered.join("/")} either`,
          );
        }
      }

      const done = (status: CheckStatus, message: string): CheckResult =>
        withFindings(result(status, message), findings);
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
        return done("fail", parts.join("; ") + "." + trimmedNote);
      }

      // The tables or ACLs this account cannot see are exactly the ones this
      // gate cannot clear — a partially trimmed read never passes.
      if (meta.securityTrimmed || acls.trimmed) {
        return done(
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
        return done(
          "warn",
          `${inheritedGaps.length} extended table(s) in scope "${scope}" have no app-specific ACL for some CRUD operations and rely on their parent's ACLs at runtime; certification expects app-specific ACLs: ${inheritedGaps.join(", ")}.`,
        );
      }

      return done(
        "pass",
        `All ${tables.length} table(s) in scope "${scope}" have active create, read, write and delete ACLs.`,
      );
    } catch (err) {
      return errorResult(NAME, "table CRUD ACLs", err);
    }
  },
};
