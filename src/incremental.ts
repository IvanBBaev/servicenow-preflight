/**
 * Incremental runs (F-X-14): `--changed-since <duration|ISO date>` limits a run
 * to the checks whose `meta.tables` intersect the tables that changed since a
 * point in time. Selection is fail-safe: a check that declares no tables, runs
 * unconditionally (`requires: "ALWAYS"`) or reads instance state ({@link STATE_TABLES}) is
 * always selected, and a change read that hits the row cap selects everything.
 */
import { SnTruncationError } from "./http/client.js";
import {
  and,
  assertIdentifier,
  chunk,
  inClause,
  resolveScope,
} from "./http/query.js";
import type { Check, CheckResult, PreflightContext } from "./types.js";

/**
 * Tables that hold instance or run state rather than application files: the
 * change journal (update sets and their changes), retrieved sets and their
 * preview problems, and ATF results. They never appear as a changed app file,
 * yet a check reading them judges the change as a whole (the set's state, its
 * leaks, the tests that exercise it), so an incremental run always keeps it.
 */
export const STATE_TABLES: readonly string[] = [
  "sys_update_set",
  "sys_update_xml",
  "sys_remote_update_set",
  "sys_update_preview_problem",
  "sys_atf_test_suite_result",
  "sys_atf_test_result",
];

const SYS_ID_SUFFIX = /_[0-9a-f]{32}$/;

/** Where the changed tables were read from. */
export type ChangeSource = "update set" | "scope";

/** The tables changed since a point in time, and how they were found. */
export interface ChangeSet {
  /** Record tables (classes) with at least one change, sorted. */
  tables: string[];
  source: ChangeSource;
  /**
   * Set when the change read hit the client's row cap: the set is incomplete,
   * so selection must run every check.
   */
  truncated?: boolean;
}

/** Why a check was selected for an incremental run. */
export type SelectReason = "always" | "no-tables" | "state" | "changed";

/** The outcome of {@link selectByTables}. */
export interface IncrementalSelection {
  selected: Check[];
  /** Reason per selected check name. */
  reasons: Map<string, SelectReason>;
}

/**
 * The table a `sys_update_xml.name` belongs to. The name is
 * `<table>_<sys_id>` for most records but composite for some
 * (`sys_dictionary_<table>_<column>`, `sys_documentation_<table>_<column>_<lang>`),
 * so the longest table in `known` that prefixes the name wins
 * (`sys_security_acl_role_…` is `sys_security_acl_role`, not `sys_security_acl`).
 * An unknown name falls back to the name minus a trailing `_<sys_id>`, else the
 * name itself; such a table matches no check, so it never narrows selection.
 */
export function tableOfUpdateName(
  name: string,
  known: readonly string[],
): string {
  let best = "";
  for (const table of known) {
    if (table.length > best.length && name.startsWith(`${table}_`)) {
      best = table;
    }
  }
  if (best) return best;
  return name.replace(SYS_ID_SUFFIX, "");
}

/** Every table some check declares in `meta.tables`, deduplicated. */
export function declaredTables(checks: readonly Check[]): string[] {
  const out = new Set<string>();
  for (const check of checks) {
    for (const table of check.meta?.tables ?? []) out.add(table);
  }
  return [...out];
}

/**
 * The encoded-query clause "updated at or after `since`". It is relative
 * (`RELATIVEGE@minute@ago@N`) so it does not depend on the user's time zone;
 * the minute count is rounded up, which can only widen the window.
 */
export function updatedSinceClause(since: Date, now: Date): string {
  const minutes = Math.max(
    1,
    Math.ceil((now.getTime() - since.getTime()) / 60_000),
  );
  return `sys_updated_onRELATIVEGE@minute@ago@${String(minutes)}`;
}

function cell(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value?: unknown }).value;
    if (typeof inner === "string") return inner.trim();
  }
  return "";
}

/** The update set plus every child set batched under it (via `parent`). */
async function batchIds(
  ctx: PreflightContext,
  rootId: string,
): Promise<string[]> {
  const seen = new Set([rootId]);
  let frontier = [rootId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const ids of chunk(frontier)) {
      const rows = await ctx.http.table("sys_update_set").query({
        sysparm_query: inClause("parent", ids),
        sysparm_fields: "sys_id",
      });
      for (const row of rows) {
        const id = cell(row, "sys_id");
        if (id && !seen.has(id)) {
          seen.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

/**
 * Read the tables changed since `since`. With `ctx.updateSetId` the source is
 * the set's (and its batched children's) `sys_update_xml` rows, mapped to a
 * table by name ({@link tableOfUpdateName}); otherwise `sys_metadata` rows of
 * `ctx.scope`, whose `sys_class_name` is the table. Neither configured throws.
 * Read errors propagate (the caller treats them as a runtime error).
 */
export async function changedTables(
  ctx: PreflightContext,
  since: Date,
  options: { known: readonly string[]; now?: Date },
): Promise<ChangeSet> {
  const now = options.now ?? new Date();
  const window = updatedSinceClause(since, now);
  const updateSetId = ctx.updateSetId?.trim();
  const scope = ctx.scope?.trim();
  const tables = new Set<string>();
  try {
    if (updateSetId) {
      const sets = await batchIds(
        ctx,
        assertIdentifier(updateSetId, "updateSetId"),
      );
      for (const ids of chunk(sets)) {
        const rows = await ctx.http.table("sys_update_xml").query({
          sysparm_query: and(inClause("update_set", ids), window),
          sysparm_fields: "name",
        });
        for (const row of rows) {
          const name = cell(row, "name");
          if (name) tables.add(tableOfUpdateName(name, options.known));
        }
      }
      return { tables: [...tables].sort(), source: "update set" };
    }
    if (scope) {
      const resolved = await resolveScope(ctx, scope);
      const rows = await ctx.http.table("sys_metadata").query({
        sysparm_query: and(resolved.clause, window),
        sysparm_fields: "sys_class_name",
      });
      for (const row of rows) {
        const table = cell(row, "sys_class_name");
        if (table) tables.add(table);
      }
      return { tables: [...tables].sort(), source: "scope" };
    }
  } catch (err) {
    if (err instanceof SnTruncationError) {
      return {
        tables: [...tables].sort(),
        source: updateSetId ? "update set" : "scope",
        truncated: true,
      };
    }
    throw err;
  }
  throw new Error(
    "--changed-since needs an update set (updateSetId / SNPF_UPDATE_SET) or a scope (the config file's scope) to read changes from.",
  );
}

/**
 * Select the checks an incremental run keeps, in registry order: every check
 * with `requires: "ALWAYS"`, no declared tables, or a state table
 * ({@link STATE_TABLES}), plus every check whose tables intersect `changed`.
 * Unknown means run, so a check is never dropped for lack of metadata.
 */
export function selectByTables(
  checks: readonly Check[],
  changed: Iterable<string>,
): IncrementalSelection {
  const changedSet = new Set(changed);
  const selected: Check[] = [];
  const reasons = new Map<string, SelectReason>();
  for (const check of checks) {
    const tables = check.meta?.tables ?? [];
    let reason: SelectReason | undefined;
    if (check.meta?.requires === "ALWAYS") reason = "always";
    else if (tables.length === 0) reason = "no-tables";
    else if (tables.some((t) => STATE_TABLES.includes(t))) reason = "state";
    else if (tables.some((t) => changedSet.has(t))) reason = "changed";
    if (reason) {
      selected.push(check);
      reasons.set(check.name, reason);
    }
  }
  return { selected, reasons };
}

/** The name of the runner row an incremental run adds. */
export const INCREMENTAL_ROW = "preflight:incremental";

/** What an incremental run does, decided before any check runs. */
export interface IncrementalPlan {
  /** Check names to add to the selection's `skip` list. */
  skip: string[];
  /** One line for stderr: how many checks were kept, and why. */
  preamble: string;
  /** A `warn` runner row to add to the report (no changes, or none matched). */
  row?: CheckResult;
  /**
   * True when the selection had checks but none is left to run; the report is
   * the row alone. An already-empty selection stays with the runner's own
   * fail-closed row.
   */
  empty: boolean;
}

/**
 * Plan an incremental run over `checks` (already narrowed by `--only` /
 * `--skip` / policy): read the changed tables, keep the checks
 * {@link selectByTables} selects and skip the rest. Skipped checks do not
 * appear as rows, the same as `--skip`.
 */
export async function planIncremental(
  ctx: PreflightContext,
  checks: readonly Check[],
  since: Date,
  options: { known: readonly string[]; now?: Date; label?: string },
): Promise<IncrementalPlan> {
  const head = `Incremental${options.label ? ` (${options.label})` : ""}`;
  const iso = since.toISOString();
  const change = await changedTables(ctx, since, options);
  if (change.truncated) {
    return {
      skip: [],
      empty: false,
      preamble: `${head}: the change read hit the row cap; running all ${String(checks.length)} checks.`,
    };
  }
  const { selected } = selectByTables(checks, change.tables);
  const kept = new Set(selected.map((c) => c.name));
  const skip = checks.filter((c) => !kept.has(c.name)).map((c) => c.name);
  const reason =
    change.tables.length > 0
      ? `changed tables: ${change.tables.join(", ")}`
      : `no changes since ${iso} in the ${change.source}`;
  const plan: IncrementalPlan = {
    skip,
    empty: checks.length > 0 && selected.length === 0,
    preamble: `${head}: ${String(selected.length)} of ${String(checks.length)} checks selected (${reason}).`,
  };
  if (change.tables.length === 0) {
    plan.row = {
      name: INCREMENTAL_ROW,
      status: "warn",
      kind: "runner",
      message: `No changes since ${iso} in the ${change.source}; ${
        selected.length > 0
          ? "only the checks that always run were selected"
          : "nothing ran"
      }.`,
    };
  } else if (plan.empty) {
    plan.row = {
      name: INCREMENTAL_ROW,
      status: "warn",
      kind: "runner",
      message: `No selected check reads the tables changed since ${iso} (${change.tables.join(", ")}); nothing ran.`,
    };
  }
  return plan;
}
