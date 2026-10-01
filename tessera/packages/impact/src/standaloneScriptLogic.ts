// The standalone-script lookup — wave 16's extension of the subject surface to
// the SERVER-side script tables that have no table-trigger semantics:
//
//   * `sysauto_script`       — Scheduled Script Executions, run by the
//                              scheduler;
//   * `sys_ws_operation`     — Scripted REST operations, run by an inbound
//                              HTTP request;
//   * `sys_transform_script` — transform map scripts, run by an import.
//
// None of them is bound to a `current` the way a Business Rule or a UI Action
// is, and none is called by name from another script. What a change to one of
// them is statically tied to is the Script Includes its body calls, so the
// question this file answers is "which in-scope Script Includes does this
// script call?" — read here as:
//
//   1. the subject's own row, from its table in the scope, with its script
//      column;
//   2. every Script Include of the scope, by `name`;
//   3. `scanScript` over the subject's body, for those names.
//
// The analyzer turns each call into a `where_used` edge FROM the Script
// Include TO the script — the direction every existing where-used edge
// already has ("this include is used by that script"), so a reader of the
// graph never has to learn a second meaning for one edge kind.
//
// Delegated decision 2026-09-30 (wave 16): unlike `tableLogic.ts` and
// `uiActionLogic.ts`, this lookup DOES scan a script body. The alternative —
// handing every Script Include name of the scope to the where-used search as
// a pseudo-subject — would scan every consumer table for every include to
// keep the handful of references that land on the subjects, and would depend
// on the search's configured consumer tables including the subject's table;
// a search configured without it would scan nothing and report nothing,
// which reads as "calls no include" (fail-open). The one place deciding what a
// script says is still `scanScript`, with its lexer and its dynamic-dispatch
// detection — only the choice of body differs.
//
// Delegated decision 2026-09-30 (wave 16): client scripts
// (`sys_script_client`), ACLs (`sys_security_acl`) and UI policies
// (`sys_ui_policy`) are NOT traced here and stay unanalyzable. A client script
// and a UI policy run in the BROWSER — they reach the server only through
// GlideAjax / a form submit, a path a textual search of Script Include names
// cannot follow, and their impact is on a form, which needs its own design.
// An ACL is SECURITY semantics: a change to one changes who can read or write
// what, which no "which include does it call" edge describes, and a graph
// that looked complete for one would invite a GO on an access-control change.
// Both stay fail-closed (INCONCLUSIVE) until they have a producer of their own.
//
// A transform script is also tied to the table its import WRITES: its
// transform map's `target_table`. Every row the import inserts or updates
// there fires that table's Business Rules in the same transaction, which is
// the `table_logic` hop UI Actions already make for their table
// (`uiActionLogic.ts`). So for a bound `sys_transform_script` this lookup
// also reads:
//
//   4. the scope's `sys_transform_map` rows, for the script's `map`
//      reference's `target_table`;
//   5. the scope's `sys_script` rows, for the Business Rules on those target
//      tables — with the verdicts the UI Action lookup applies.
//
// Fail-closed throughout (QA-9). A subject whose row the scope read did not
// return, whose script column could not be read, or whose body names a call
// target at runtime; a read that was refused or truncated; a Script Include
// row nothing can address — each makes the affected scripts UNANALYZABLE,
// never a script with fewer edges. For a transform script the same holds for
// its map: an unreadable `map` reference, a map the scope read did not
// return, an unreadable, non-table or `global` `target_table`, and a refused,
// truncated or opaque map or rule read each refuse the script.

import { untrusted } from "@tessera/types";
import type {
  TargetArtifactRef,
  UnanalyzableArtifact,
  Untrusted,
} from "@tessera/types";
import { describeReadTruncation } from "@tessera/resolvers";
import type { RecordReader } from "@tessera/resolvers";

import { scanScript } from "./scan.js";
import {
  BUSINESS_RULE_TABLE,
  compareRows,
  readCollection,
  text,
} from "./tableLogic.js";
import type { CollectionVerdict } from "./tableLogic.js";
import type {
  BusinessRuleRow,
  ImpactNote,
  ImpactNoteLevel,
  ScriptIncludeCall,
  StandaloneScriptLookup,
  StandaloneScriptLookupRequest,
  StandaloneScriptLookupResult,
  StandaloneScriptRow,
} from "./types.js";

/** Scheduled Script Executions (scheduled jobs). */
export const SCHEDULED_SCRIPT_TABLE = "sysauto_script";

/** Scripted REST API operations. */
export const REST_OPERATION_TABLE = "sys_ws_operation";

/** Transform map scripts (`onBefore`, `onAfter`, …). */
export const TRANSFORM_SCRIPT_TABLE = "sys_transform_script";

/** The subject tables this lookup serves, in `SUBJECT_TABLES` order. */
export const STANDALONE_SCRIPT_TABLES: readonly string[] = Object.freeze([
  SCHEDULED_SCRIPT_TABLE,
  REST_OPERATION_TABLE,
  TRANSFORM_SCRIPT_TABLE,
]);

/**
 * The script column(s) of each table — the same columns `CONSUMER_TABLES`
 * (derived from `scriptsApi.SCRIPT_TYPES`) searches; a test pins the two
 * against each other so they cannot drift.
 */
const SCRIPT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [SCHEDULED_SCRIPT_TABLE]: ["script"],
  [REST_OPERATION_TABLE]: ["operation_script"],
  [TRANSFORM_SCRIPT_TABLE]: ["script"],
};

/** The table whose names are searched for in a subject's body. */
const SCRIPT_INCLUDE_TABLE = "sys_script_include";

/** Transform maps — where a transform script's target table is read from. */
export const TRANSFORM_MAP_TABLE = "sys_transform_map";

/**
 * EVERY table this lookup reads, in read order: the subject tables, the
 * transform maps and Business Rules of the target-table hop, and the Script
 * Includes. Exported so a caller that wraps the lookup's reader (the CLI's
 * classifying reader) watches exactly these tables from one source; a test
 * pins every request the lookup makes against it.
 */
export const STANDALONE_SCRIPT_LOOKUP_TABLES: readonly string[] = Object.freeze(
  [
    ...STANDALONE_SCRIPT_TABLES,
    TRANSFORM_MAP_TABLE,
    BUSINESS_RULE_TABLE,
    SCRIPT_INCLUDE_TABLE,
  ],
);

/**
 * Columns read from a subject row beyond identity and script: a transform
 * script's `map` reference, for the target-table hop.
 */
const EXTRA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [TRANSFORM_SCRIPT_TABLE]: ["map"],
};

/** Identity plus the table the map's import writes. */
const MAP_FIELDS: readonly string[] = ["sys_id", "target_table"];

/** The same identity-plus-trigger-table read the UI Action lookup makes. */
const RULE_FIELDS: readonly string[] = ["sys_id", "sys_name", "collection"];

/** Identity plus the name a script calls the include by (the resolver's). */
const INCLUDE_FIELDS: readonly string[] = ["sys_id", "sys_name", "name"];

function note(level: ImpactNoteLevel, message: string): ImpactNote {
  return { level, message };
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareScripts(
  left: StandaloneScriptRow,
  right: StandaloneScriptRow,
): number {
  return (
    compare(left.script.table, right.script.table) ||
    compare(left.script.name, right.script.name) ||
    compare(left.script.sysId, right.script.sysId)
  );
}

function compareCalls(
  left: ScriptIncludeCall,
  right: ScriptIncludeCall,
): number {
  return (
    compare(left.include.name, right.include.name) ||
    compare(left.include.sysId, right.include.sysId) ||
    compare(left.field, right.field) ||
    left.match.line - right.match.line
  );
}

/** One subject whose body was read, waiting for the include names. */
interface PendingScript {
  readonly subject: TargetArtifactRef;
  readonly bodies: readonly {
    readonly field: string;
    readonly body: Untrusted<string>;
  }[];
  /** A transform script's `map` reference (sys_id), else `undefined`. */
  readonly mapId?: string;
  /** Set once the map's `target_table` has been established. */
  targetTable?: string;
}

/** Why a map's `target_table` does not name one traceable table. */
function targetReason(verdict: CollectionVerdict): string {
  switch (verdict.kind) {
    case "unreadable":
      return "its transform map's `target_table` (the table its import writes) could not be read";
    case "invalid":
      return "its transform map's `target_table` is not a table name (lowercase letters, digits, underscores)";
    case "everywhere":
      return `its transform map targets \`${verdict.collection}\` — every table — so no finite set of business rules is fired by its import`;
    case "table":
      return "";
  }
}

/**
 * The live `StandaloneScriptLookup`: one `fetchAll` read per subject table
 * present in the request and, only when a script was bound, one of
 * `sys_script_include`. Injected into the analyzer the same way
 * `createUiActionLookup` is.
 */
export function createStandaloneScriptLookup(
  reader: RecordReader,
): StandaloneScriptLookup {
  return async function lookup(
    request: StandaloneScriptLookupRequest,
  ): Promise<StandaloneScriptLookupResult> {
    const label = text(request.scopeLabel) ?? request.scopeSysId;
    const notes: ImpactNote[] = [];
    const unanalyzable: UnanalyzableArtifact[] = [];

    const refuseOne = (subject: TargetArtifactRef, reason: string): void => {
      unanalyzable.push({
        artifact: subject,
        reason: `the Script Includes this ${subject.table} script calls could not be established in scope \`${label}\`: ${reason}`,
      });
    };
    const refuseTarget = (entry: PendingScript, reason: string): void => {
      unanalyzable.push({
        artifact: entry.subject,
        reason: `the target table of this transform script's map, and the business rules its import fires, could not be established in scope \`${label}\`: ${reason}`,
      });
    };

    // Subjects grouped by table, addressed by sys_id; a duplicate is one
    // subject. A subject on a table this lookup does not serve is refused —
    // an injected caller's slip must not become a traced script.
    const byTable = new Map<string, Map<string, TargetArtifactRef>>();
    const seenIds = new Set<string>();
    for (const subject of request.subjects) {
      if (seenIds.has(subject.sysId)) continue;
      seenIds.add(subject.sysId);
      if (!STANDALONE_SCRIPT_TABLES.includes(subject.table)) {
        refuseOne(
          subject,
          `${subject.table} is not a standalone script table this lookup reads`,
        );
        continue;
      }
      let group = byTable.get(subject.table);
      if (group === undefined) {
        group = new Map();
        byTable.set(subject.table, group);
      }
      group.set(subject.sysId, subject);
    }
    if (seenIds.size === 0) {
      return { scripts: [], rules: [], unanalyzable: [], notes: [] };
    }

    // ── 1. the subjects' own rows ───────────────────────────────────────────
    let pending: PendingScript[] = [];
    // Sequential and in a fixed table order, for a diffable log.
    for (const table of STANDALONE_SCRIPT_TABLES) {
      const group = byTable.get(table);
      if (group === undefined) continue;
      const scriptFields = SCRIPT_FIELDS[table] ?? [];
      const extraFields = EXTRA_FIELDS[table] ?? [];
      const read = await reader.queryRecords({
        table,
        // Scope and nothing else, for the reason `createWhereUsedSearch` gives.
        query: `sys_scope=${request.scopeSysId}`,
        fields: ["sys_id", "sys_name", ...scriptFields, ...extraFields],
        fetchAll: true,
        // Delegated decision 2026-10-01 (wave 17): all four reads of this
        // lookup (subjects, maps, rules, includes) are enumerations that
        // decide what is traced, so each takes the Stats API count
        // cross-check, for the reason `tableLogic.ts` gives.
        crossCheckCount: true,
        signal: request.ctx.signal,
      });
      if (read.outcome === "undecidable") {
        const detail = `${table} could not be read: ${read.detail}`;
        notes.push(note("warning", `standalone script lookup: ${detail}`));
        for (const subject of group.values()) refuseOne(subject, detail);
        continue;
      }
      if (read.truncated) {
        // A partial read may be missing a subject's own row — refused whole,
        // as the UI Action lookup refuses a truncated read.
        const detail = `${table} read ${describeReadTruncation(read)}`;
        notes.push(note("warning", `standalone script lookup: ${detail}`));
        for (const subject of group.values()) refuseOne(subject, detail);
        continue;
      }

      const seen = new Set<string>();
      for (const row of read.records) {
        const sysId = text(row["sys_id"]);
        if (sysId === undefined) continue;
        const subject = group.get(sysId);
        if (subject === undefined || seen.has(sysId)) continue;
        seen.add(sysId);
        const bodies: { field: string; body: Untrusted<string> }[] = [];
        let unreadable = false;
        for (const field of scriptFields) {
          const value = row[field];
          if (typeof value !== "string") {
            unreadable = true;
            break;
          }
          // TM-1: branded at the boundary; only the scanner opens it.
          bodies.push({ field, body: untrusted(value) });
        }
        if (unreadable) {
          // An ACL-trimmed column is an absence of evidence, never an empty
          // script that calls nothing.
          unanalyzable.push({
            artifact: subject,
            reason: `this ${table} script cannot be traced: its script column(s) (${scriptFields.join(", ")}) could not be read, so the Script Includes it calls are unknown`,
          });
          continue;
        }
        if (extraFields.includes("map")) {
          const mapId = text(row["map"]);
          if (mapId === undefined) {
            // Delegated decision 2026-10-01 (wave 17): an absent, ACL-trimmed
            // or blank `map` is refused, never "a script whose import writes
            // nothing" — the table its import writes is then unknown, and a
            // script traced without it would silently lose that table's
            // business rules.
            unanalyzable.push({
              artifact: subject,
              reason: `this ${table} script cannot be traced: its \`map\` (the transform map whose import runs it) could not be read, so the table its import writes is unknown`,
            });
            continue;
          }
          pending.push({ subject, bodies, mapId });
          continue;
        }
        pending.push({ subject, bodies });
      }
      for (const subject of group.values()) {
        if (seen.has(subject.sysId)) continue;
        // Fail closed, as for UI Actions: a script the scope read did not
        // return is not traced from the resolver's label alone.
        unanalyzable.push({
          artifact: subject,
          reason: `this script was not among the ${table} rows of scope \`${label}\`, so its body could not be read`,
        });
      }
    }

    // ── 1b. the transform scripts' target tables ────────────────────────────
    const rules: BusinessRuleRow[] = [];
    const transforms = pending.filter((entry) => entry.mapId !== undefined);
    if (transforms.length > 0) {
      const refused = new Set<PendingScript>();
      const refuseAll = (entries: Iterable<PendingScript>, reason: string) => {
        for (const entry of entries) {
          refused.add(entry);
          refuseTarget(entry, reason);
        }
      };

      // Delegated decision 2026-10-01 (wave 17): the maps are read by SCOPE,
      // as every other lookup read is, not by `sys_idIN<map ids>`. A scoped
      // transform script's map is in its own scope (the script is a child
      // record of the map), so a map the scope read does not return is
      // refused below as "not among the rows" — fail closed — and no value
      // read off the instance is ever interpolated into a query.
      const mapRead = await reader.queryRecords({
        table: TRANSFORM_MAP_TABLE,
        query: `sys_scope=${request.scopeSysId}`,
        fields: [...MAP_FIELDS],
        fetchAll: true,
        crossCheckCount: true,
        signal: request.ctx.signal,
      });
      if (mapRead.outcome === "undecidable") {
        const detail = `${TRANSFORM_MAP_TABLE} could not be read: ${mapRead.detail}`;
        notes.push(note("warning", `standalone script lookup: ${detail}`));
        refuseAll(transforms, detail);
      } else if (mapRead.truncated) {
        // A partial read may be missing a script's own map.
        const detail = `${TRANSFORM_MAP_TABLE} read ${describeReadTruncation(mapRead)}`;
        notes.push(note("warning", `standalone script lookup: ${detail}`));
        refuseAll(transforms, detail);
      } else {
        // An anonymous map row can only hide a script's own map, and that
        // script is refused below as "not among the rows" — the UI Action
        // lookup's reasoning for an anonymous action row.
        const targets = new Map<string, unknown>();
        for (const row of mapRead.records) {
          const sysId = text(row["sys_id"]);
          if (sysId === undefined || targets.has(sysId)) continue;
          targets.set(sysId, row["target_table"]);
        }
        for (const entry of transforms) {
          const mapId = entry.mapId ?? "";
          if (!targets.has(mapId)) {
            refused.add(entry);
            refuseTarget(
              entry,
              `its map ${mapId} was not among the ${TRANSFORM_MAP_TABLE} rows of the scope, so the table its import writes could not be read`,
            );
            continue;
          }
          const verdict = readCollection(targets.get(mapId));
          if (verdict.kind !== "table") {
            refused.add(entry);
            refuseTarget(entry, targetReason(verdict));
            continue;
          }
          entry.targetTable = verdict.collection;
        }
      }

      // ── 1c. the business rules on the target tables ─────────────────────
      const targeted = transforms.filter((entry) => !refused.has(entry));
      if (targeted.length > 0) {
        const ruleRead = await reader.queryRecords({
          table: BUSINESS_RULE_TABLE,
          query: `sys_scope=${request.scopeSysId}`,
          fields: [...RULE_FIELDS],
          fetchAll: true,
          crossCheckCount: true,
          signal: request.ctx.signal,
        });
        const ruleRows: {
          ref: TargetArtifactRef;
          verdict: CollectionVerdict;
        }[] = [];
        let ruleDetail: string | undefined;
        if (ruleRead.outcome === "undecidable") {
          ruleDetail = `${BUSINESS_RULE_TABLE} could not be read: ${ruleRead.detail}`;
        } else if (ruleRead.truncated) {
          ruleDetail = `${BUSINESS_RULE_TABLE} read ${describeReadTruncation(ruleRead)}, so business rules on the transform scripts' target tables in scope \`${label}\` may be missing`;
        } else {
          let opaque = 0;
          for (const row of ruleRead.records) {
            const sysId = text(row["sys_id"]);
            const verdict = readCollection(row["collection"]);
            if (
              sysId === undefined ||
              verdict.kind === "unreadable" ||
              verdict.kind === "invalid"
            ) {
              opaque += 1;
              continue;
            }
            ruleRows.push({
              ref: {
                table: BUSINESS_RULE_TABLE,
                sysId,
                name:
                  text(row["sys_name"]) ?? `${BUSINESS_RULE_TABLE}/${sysId}`,
              },
              verdict,
            });
          }
          if (opaque > 0) {
            // Any of them may run on a target table; nothing can say which.
            ruleDetail = `${opaque} ${BUSINESS_RULE_TABLE} row(s) in the scope came back without a readable sys_id or trigger table, so any of them may run on a transform script's target table`;
          }
        }
        if (ruleDetail !== undefined) {
          notes.push(
            note("warning", `standalone script lookup: ${ruleDetail}`),
          );
          refuseAll(targeted, ruleDetail);
        } else {
          const tables = new Set<string>();
          for (const entry of targeted) {
            if (entry.targetTable !== undefined) tables.add(entry.targetTable);
          }
          for (const entry of ruleRows) {
            if (entry.verdict.kind === "table") {
              if (tables.has(entry.verdict.collection)) {
                rules.push({
                  rule: entry.ref,
                  collection: entry.verdict.collection,
                });
              }
              continue;
            }
            // A `global` rule runs on every target table too — the wave-15
            // UI Action decision, applied unchanged.
            for (const table of tables) {
              rules.push({ rule: entry.ref, collection: table });
            }
          }
        }
      }
      pending = pending.filter((entry) => !refused.has(entry));
    }

    if (pending.length === 0) {
      notes.push(
        note(
          "info",
          `standalone script lookup: no script bound in scope \`${label}\`, so ${SCRIPT_INCLUDE_TABLE} was not read`,
        ),
      );
      return { scripts: [], rules: [], unanalyzable, notes };
    }

    // ── 2. the scope's Script Includes ──────────────────────────────────────
    const bound = pending.map((entry) => entry.subject);
    const includeRead = await reader.queryRecords({
      table: SCRIPT_INCLUDE_TABLE,
      query: `sys_scope=${request.scopeSysId}`,
      fields: [...INCLUDE_FIELDS],
      fetchAll: true,
      crossCheckCount: true,
      signal: request.ctx.signal,
    });
    if (includeRead.outcome === "undecidable") {
      const detail = `${SCRIPT_INCLUDE_TABLE} could not be read: ${includeRead.detail}`;
      notes.push(note("warning", `standalone script lookup: ${detail}`));
      for (const subject of bound) refuseOne(subject, detail);
      return { scripts: [], rules: [], unanalyzable, notes };
    }
    if (includeRead.truncated) {
      const detail = `${SCRIPT_INCLUDE_TABLE} read ${describeReadTruncation(includeRead)}`;
      notes.push(
        note(
          "warning",
          `standalone script lookup: ${detail}, so Script Includes the scripts call in scope \`${label}\` may be missing`,
        ),
      );
      for (const subject of bound) refuseOne(subject, detail);
      return { scripts: [], rules: [], unanalyzable, notes };
    }

    const includesByName = new Map<string, TargetArtifactRef[]>();
    let opaque = 0;
    for (const row of includeRead.records) {
      const sysId = text(row["sys_id"]);
      const name = text(row["name"]);
      if (sysId === undefined || name === undefined) {
        opaque += 1;
        continue;
      }
      const ref: TargetArtifactRef = {
        table: SCRIPT_INCLUDE_TABLE,
        sysId,
        name,
      };
      const same = includesByName.get(name);
      if (same === undefined) includesByName.set(name, [ref]);
      else if (!same.some((other) => other.sysId === sysId)) same.push(ref);
    }
    if (opaque > 0) {
      // Any of them may be what a script calls; nothing can say which.
      const detail = `${opaque} ${SCRIPT_INCLUDE_TABLE} row(s) in the scope came back without a readable sys_id or name, so a call to any of them could not be recognised`;
      notes.push(note("warning", `standalone script lookup: ${detail}`));
      for (const subject of bound) refuseOne(subject, detail);
      return { scripts: [], rules: [], unanalyzable, notes };
    }
    for (const [name, refs] of includesByName) {
      if (refs.length < 2) continue;
      // Every call is attributed to all of them (as the analyzer does for two
      // subjects sharing a name) — and the graph is then not a clean answer.
      notes.push(
        note(
          "warning",
          `standalone script lookup: ${refs.length} ${SCRIPT_INCLUDE_TABLE} rows in scope \`${label}\` are named \`${name}\`; every call to that name is attributed to all of them`,
        ),
      );
    }

    // ── 3. scan ─────────────────────────────────────────────────────────────
    const names = [...includesByName.keys()].sort(compare);
    const scripts: StandaloneScriptRow[] = [];
    let callCount = 0;
    for (const entry of pending) {
      const calls: ScriptIncludeCall[] = [];
      let marker: { marker: string; line: number } | undefined;
      for (const { field, body } of entry.bodies) {
        const result = scanScript(body, names);
        for (const match of result.matches) {
          for (const include of includesByName.get(match.name) ?? []) {
            calls.push({ include, field, match });
          }
        }
        marker ??= result.dynamic[0];
      }
      if (marker !== undefined) {
        // The script names a call target at runtime: the calls found do not
        // make the rest of its dispatch visible (QA-9).
        unanalyzable.push({
          artifact: entry.subject,
          reason: `this ${entry.subject.table} script cannot be fully traced: it names a call target at runtime (\`${marker.marker}\` on line ${marker.line}), so a textual search cannot see every Script Include it calls`,
        });
        continue;
      }
      callCount += calls.length;
      // The subject's OWN ref, not the row's — see `tableLogic.ts`.
      scripts.push(
        entry.targetTable === undefined
          ? { script: entry.subject, calls: calls.sort(compareCalls) }
          : {
              script: entry.subject,
              calls: calls.sort(compareCalls),
              targetTable: entry.targetTable,
            },
      );
    }

    notes.push(
      note(
        "info",
        `standalone script lookup: ${scripts.length} script(s) bound in scope \`${label}\`, ${callCount} call(s) to ${includeRead.records.length} ${SCRIPT_INCLUDE_TABLE} row(s)`,
      ),
    );

    // Only the rules on a target table some SCANNED transform script still
    // has: a script refused afterwards (dynamic dispatch) takes its table's
    // rules with it unless another bound script shares the table.
    const boundTables = new Set(
      scripts.flatMap((entry) =>
        entry.targetTable === undefined ? [] : [entry.targetTable],
      ),
    );
    return {
      scripts: scripts.sort(compareScripts),
      rules: rules
        .filter((entry) => boundTables.has(entry.collection))
        .sort(compareRows),
      unanalyzable,
      notes,
    };
  };
}
