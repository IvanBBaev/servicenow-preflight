// The UI Action (`sys_ui_action`) lookup — the `table_logic` pattern Business
// Rules introduced (see `tableLogic.ts`), extended to the next server-side
// script table.
//
// A server-side UI Action is a button, link or context-menu entry on ONE
// table's form or list. Its script runs on the server with `current` bound to a
// record of that table, and almost always ends in `current.update()` /
// `insert()` / `deleteRecord()` — so the table's Business Rules run in the same
// transaction. "What does a change to this action affect?" is answered by:
//
//   1. the action's `table`, `client` flag and `action_name` — read here;
//   2. the in-scope Business Rules on that table — read here, from
//      `sys_script`, with the same verdicts the Business Rule lookup applies;
//   3. every in-scope script that names the action — by `action_name` (the
//      `gsftSubmit(..., 'action_name')` idiom, `g_form.submit('action_name')`)
//      or by sys_id — found by handing both to the ordinary where-used search
//      as if they were a subject's name.
//
// As with Business Rules, this file never scans a script body: that stays the
// where-used search's job, so there is exactly one place deciding what a script
// says.
//
// Fail-closed throughout (QA-9). A client-side action, an action whose table
// cannot be established or is `global`, an action outside the scope, or a read
// that did not return the whole scope makes the affected actions UNANALYZABLE —
// never an action with fewer edges.

import type { TargetArtifactRef, UnanalyzableArtifact } from "@tessera/types";
import { describeReadTruncation, isTableName } from "@tessera/resolvers";
import type { RecordReader } from "@tessera/resolvers";

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
  UiActionLookup,
  UiActionLookupRequest,
  UiActionLookupResult,
  UiActionRow,
} from "./types.js";

/** The table this lookup binds, and the subject table it serves. */
export const UI_ACTION_TABLE = "sys_ui_action";

/**
 * Identity, the table the action runs on, where it runs, and the name scripts
 * invoke it by. No script column: this lookup decides what an action is bound
 * to, not what its body says (see the file header).
 */
const ACTION_FIELDS: readonly string[] = [
  "sys_id",
  "sys_name",
  "table",
  "client",
  "action_name",
];

/** The same identity-plus-trigger-table read the Business Rule lookup makes. */
const RULE_FIELDS: readonly string[] = ["sys_id", "sys_name", "collection"];

/**
 * Delegated decision 2026-09-30 (wave 15): an action on `global` is refused,
 * for the reason `tableLogic.ts` refuses a `global` Business Rule — it appears
 * on EVERY table, so neither its triggering Business Rules nor the set of
 * records it can touch is finite. Reversible once a producer can say what a
 * global action touches.
 */
const UNTRACEABLE_TABLES: ReadonlySet<string> = new Set(["global"]);

function note(level: ImpactNoteLevel, message: string): ImpactNote {
  return { level, message };
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareActions(left: UiActionRow, right: UiActionRow): number {
  return (
    compare(left.table, right.table) ||
    compare(left.action.name, right.action.name) ||
    compare(left.action.sysId, right.action.sysId)
  );
}

type ActionVerdict =
  | {
      readonly kind: "server";
      readonly table: string;
      readonly actionName: string | undefined;
    }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * What one `sys_ui_action` row says about how it can be traced. Checked in a
 * fixed order — where it runs, then its table, then its name — so a row with
 * several problems is refused for the first, and the reason is deterministic.
 */
function readAction(row: Readonly<Record<string, unknown>>): ActionVerdict {
  const client = row["client"];
  // Delegated decision 2026-09-30 (wave 15): only the exact Table API value
  // `"false"` makes an action server-side. `"true"` is a client-side action —
  // its script runs in the browser (possibly re-entering the server through
  // `gsftSubmit`, a path no textual search can follow), so it is refused. Any
  // other value (absent, ACL-trimmed, a display value, a boolean) is an
  // absence of evidence and is refused too, never assumed to be server-side.
  if (client === "true") {
    return {
      kind: "refused",
      reason:
        "it is a client-side UI action (`client` = true): its script runs in the browser, which this analysis cannot trace",
    };
  }
  if (client !== "false") {
    return {
      kind: "refused",
      reason:
        "its `client` flag could not be read, so whether its script runs on the server is unknown",
    };
  }

  const table = text(row["table"]);
  if (table === undefined) {
    return {
      kind: "refused",
      reason:
        "its `table` (the table whose records it acts on) could not be read",
    };
  }
  if (!isTableName(table)) {
    return {
      kind: "refused",
      reason:
        "its `table` is not a table name (lowercase letters, digits, underscores)",
    };
  }
  if (UNTRACEABLE_TABLES.has(table)) {
    return {
      kind: "refused",
      reason: `it is on \`${table}\` — every table — so no finite set of records or business rules is reached by it`,
    };
  }

  const rawName = row["action_name"];
  if (typeof rawName !== "string") {
    // An ACL-trimmed or absent column is not "no action name": the action
    // might be invoked by a name this read could not see, so every such
    // caller would be a silently missing edge.
    return {
      kind: "refused",
      reason:
        "its `action_name` (the name scripts invoke it by) could not be read, so its callers cannot be searched for",
    };
  }
  // Delegated decision 2026-09-30 (wave 15): a readable but BLANK
  // `action_name` is an answer — the action has no name to be invoked by —
  // and the action stays traceable by its sys_id alone. Refusing it would
  // make most form buttons untraceable for no evidence-backed reason.
  return { kind: "server", table, actionName: text(rawName) };
}

/**
 * The live `UiActionLookup`: one `fetchAll` read of `sys_ui_action` in the
 * scope and, only when an action was bound, one of `sys_script`. Injected into
 * the analyzer the same way `createBusinessRuleLookup` is.
 */
export function createUiActionLookup(reader: RecordReader): UiActionLookup {
  return async function lookup(
    request: UiActionLookupRequest,
  ): Promise<UiActionLookupResult> {
    const label = text(request.scopeLabel) ?? request.scopeSysId;
    const notes: ImpactNote[] = [];
    const unanalyzable: UnanalyzableArtifact[] = [];

    // Subjects addressed by sys_id; a duplicate is one subject.
    const subjectsById = new Map<string, TargetArtifactRef>();
    for (const subject of request.subjects) {
      if (!subjectsById.has(subject.sysId)) {
        subjectsById.set(subject.sysId, subject);
      }
    }
    if (subjectsById.size === 0) {
      return { actions: [], rules: [], unanalyzable: [], notes: [] };
    }

    /** Every listed subject, with one reason — the whole-read failure modes. */
    const refuse = (
      subjects: Iterable<TargetArtifactRef>,
      reason: string,
    ): UiActionLookupResult => {
      for (const subject of subjects) {
        unanalyzable.push({
          artifact: subject,
          reason: `the UI action's table and the business rules it triggers could not be established in scope \`${label}\`: ${reason}`,
        });
      }
      return { actions: [], rules: [], unanalyzable, notes };
    };

    const read = await reader.queryRecords({
      table: UI_ACTION_TABLE,
      // Scope and nothing else, for the reason `createWhereUsedSearch` gives.
      query: `sys_scope=${request.scopeSysId}`,
      fields: [...ACTION_FIELDS],
      fetchAll: true,
      // Delegated decision 2026-10-01 (wave 17): the Stats API count
      // cross-check, for the reason `tableLogic.ts` gives — both reads here
      // decide what is traced, and neither is a single-page identity read.
      crossCheckCount: true,
      signal: request.ctx.signal,
    });

    if (read.outcome === "undecidable") {
      const detail = `${UI_ACTION_TABLE} could not be read: ${read.detail}`;
      notes.push(note("warning", `ui action lookup: ${detail}`));
      return refuse(subjectsById.values(), detail);
    }
    if (read.truncated) {
      // A partial read may be missing a subject's own row, which would then be
      // reported as "not in the scope" when it is. Refused whole, as the
      // Business Rule lookup refuses a truncated read.
      const detail = `${UI_ACTION_TABLE} read ${describeReadTruncation(read)}`;
      notes.push(note("warning", `ui action lookup: ${detail}`));
      return refuse(subjectsById.values(), detail);
    }

    // Delegated decision 2026-09-30 (wave 15): unlike a Business Rule read, an
    // anonymous `sys_ui_action` row does NOT refuse every subject. A UI Action
    // has no siblings — no other action runs because this one did — so an
    // unaddressable row can only hide a SUBJECT's own row, and a subject whose
    // row did not arrive is refused below as "not among the rows".
    const actions: UiActionRow[] = [];
    const seen = new Set<string>();
    for (const row of read.records) {
      const sysId = text(row["sys_id"]);
      if (sysId === undefined) continue;
      const subject = subjectsById.get(sysId);
      if (subject === undefined || seen.has(sysId)) continue;
      seen.add(sysId);
      const verdict = readAction(row);
      if (verdict.kind === "refused") {
        unanalyzable.push({
          artifact: subject,
          reason: `this UI action cannot be traced: ${verdict.reason}`,
        });
        continue;
      }
      // The subject's OWN ref, not the row's — see `tableLogic.ts`.
      actions.push(
        verdict.actionName === undefined
          ? { action: subject, table: verdict.table }
          : {
              action: subject,
              table: verdict.table,
              actionName: verdict.actionName,
            },
      );
    }

    for (const subject of subjectsById.values()) {
      if (seen.has(subject.sysId)) continue;
      // Delegated decision 2026-09-30 (wave 15): as for Business Rules, an
      // action the scope read did not return is unanalyzable, not traced from
      // the resolver's label alone — fail closed.
      unanalyzable.push({
        artifact: subject,
        reason: `this UI action was not among the ${UI_ACTION_TABLE} rows of scope \`${label}\`, so its table and client flag could not be read`,
      });
    }

    if (actions.length === 0) {
      notes.push(
        note(
          "info",
          `ui action lookup: ${read.records.length} ${UI_ACTION_TABLE} row(s) read in scope \`${label}\`; no server-side action bound, so ${BUSINESS_RULE_TABLE} was not read`,
        ),
      );
      return { actions: [], rules: [], unanalyzable, notes };
    }

    // ── the business rules on the bound tables ──────────────────────────────
    const bound = actions.map((entry) => entry.action);
    const ruleRead = await reader.queryRecords({
      table: BUSINESS_RULE_TABLE,
      query: `sys_scope=${request.scopeSysId}`,
      fields: [...RULE_FIELDS],
      fetchAll: true,
      crossCheckCount: true,
      signal: request.ctx.signal,
    });

    if (ruleRead.outcome === "undecidable") {
      const detail = `${BUSINESS_RULE_TABLE} could not be read: ${ruleRead.detail}`;
      notes.push(note("warning", `ui action lookup: ${detail}`));
      return refuse(bound, detail);
    }
    if (ruleRead.truncated) {
      const detail = `${BUSINESS_RULE_TABLE} read ${describeReadTruncation(ruleRead)}`;
      notes.push(
        note(
          "warning",
          `ui action lookup: ${detail}, so business rules on the actions' tables in scope \`${label}\` may be missing`,
        ),
      );
      return refuse(bound, detail);
    }

    const rows: { ref: TargetArtifactRef; verdict: CollectionVerdict }[] = [];
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
      rows.push({
        ref: {
          table: BUSINESS_RULE_TABLE,
          sysId,
          name: text(row["sys_name"]) ?? `${BUSINESS_RULE_TABLE}/${sysId}`,
        },
        verdict,
      });
    }
    if (opaque > 0) {
      // Any of them may run on a bound action's table; nothing can say which.
      const detail = `${opaque} ${BUSINESS_RULE_TABLE} row(s) in the scope came back without a readable sys_id or trigger table, so any of them may run on an action's table`;
      notes.push(note("warning", `ui action lookup: ${detail}`));
      return refuse(bound, detail);
    }

    const tables = new Set(actions.map((entry) => entry.table));
    const rules: BusinessRuleRow[] = [];
    for (const entry of rows) {
      if (entry.verdict.kind === "table") {
        if (tables.has(entry.verdict.collection)) {
          rules.push({ rule: entry.ref, collection: entry.verdict.collection });
        }
        continue;
      }
      // A `global` rule runs on every bound table too, in the same
      // transaction — the wave-14 sibling decision, applied unchanged.
      for (const table of tables) {
        rules.push({ rule: entry.ref, collection: table });
      }
    }

    notes.push(
      note(
        "info",
        `ui action lookup: ${read.records.length} ${UI_ACTION_TABLE} row(s) read in scope \`${label}\`; ${actions.length} server-side action(s) bound to ${tables.size} table(s), ${rules.length} business rule(s) on them`,
      ),
    );

    return {
      actions: actions.sort(compareActions),
      rules: rules.sort(compareRows),
      unanalyzable,
      notes,
    };
  };
}
