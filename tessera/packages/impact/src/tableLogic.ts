// The `table_logic` lookup — the second of PLAN Phase 3's edge producers,
// narrowed to Business Rules (`sys_script`).
//
// A Business Rule is not called by name. It runs because a record on its
// `collection` table is inserted, updated, deleted or queried, so "what does a
// change to this rule affect?" is answered by two facts this file reads and one
// the where-used search already knows how to find:
//
//   1. the rule's `collection` — the table whose writes trigger it;
//   2. the other in-scope rules on that same table — they run in the same
//      transaction, in `order`, on the same `current`, so a change to one can
//      change what the next one sees;
//   3. every in-scope script that names the table (a `GlideRecord("incident")`
//      is how a script reaches the rule) — found by handing the collection to
//      the ordinary where-used search as if it were a subject's name.
//
// This file does (1) and (2) in ONE read and nothing else. It never scans a
// script body: that stays the where-used search's job, with its lexer and its
// dynamic-dispatch detection, so there is exactly one place deciding what a
// script says.
//
// Fail-closed throughout (QA-9). A rule whose table cannot be established, a
// rule that is not in the scope, or a read that did not return the whole scope
// makes the affected rules UNANALYZABLE — never a rule with fewer edges.

import type { TargetArtifactRef, UnanalyzableArtifact } from "@tessera/types";
import { describeReadTruncation, isTableName } from "@tessera/resolvers";
import type { RecordReader } from "@tessera/resolvers";

import type {
  BusinessRuleLookup,
  BusinessRuleLookupRequest,
  BusinessRuleLookupResult,
  BusinessRuleRow,
  ImpactNote,
  ImpactNoteLevel,
} from "./types.js";

/** The one table this lookup reads, and the subject table it serves. */
export const BUSINESS_RULE_TABLE = "sys_script";

/**
 * Identity plus the trigger table. No script column: this lookup decides which
 * table a rule is bound to, not what its body says (see the file header).
 */
const LOOKUP_FIELDS: readonly string[] = ["sys_id", "sys_name", "collection"];

/**
 * Delegated decision 2026-09-30 (wave 14): a rule on `global` is refused as
 * untraceable rather than traced. It runs on EVERY table, so "the scripts that
 * name its table" is not a set a textual search can enumerate, and reporting
 * the handful that happen to contain the word `global` would be a complete-
 * looking graph built on a meaningless match. Reversible: drop the entry here
 * once a producer exists that can say what a global rule touches.
 */
const UNTRACEABLE_COLLECTIONS: ReadonlySet<string> = new Set(["global"]);

function note(level: ImpactNoteLevel, message: string): ImpactNote {
  return { level, message };
}

/**
 * Trimmed text, or `undefined` for anything that is not a non-blank string.
 * Exported (package-internal, not re-exported by the index) for the UI Action
 * lookup, which reads the same `sys_script` columns the same way.
 */
export function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function compareRows(
  left: BusinessRuleRow,
  right: BusinessRuleRow,
): number {
  return (
    compare(left.collection, right.collection) ||
    compare(left.rule.name, right.rule.name) ||
    compare(left.rule.sysId, right.rule.sysId)
  );
}

/**
 * What a raw `collection` value says about the table a rule runs on.
 *
 * `unreadable` and `invalid` are absences of evidence; `everywhere` is the
 * `global` case (see `UNTRACEABLE_COLLECTIONS`). The shape check is the one
 * `@tessera/resolvers` applies to a table name before it is interpolated into a
 * query: the value is later a search TERM, and a value that is not a table name
 * is not a table this rule runs on.
 */
export type CollectionVerdict =
  | { readonly kind: "table"; readonly collection: string }
  | { readonly kind: "unreadable" }
  | { readonly kind: "invalid" }
  | { readonly kind: "everywhere"; readonly collection: string };

export function readCollection(raw: unknown): CollectionVerdict {
  const collection = text(raw);
  if (collection === undefined) return { kind: "unreadable" };
  if (!isTableName(collection)) return { kind: "invalid" };
  if (UNTRACEABLE_COLLECTIONS.has(collection)) {
    return { kind: "everywhere", collection };
  }
  return { kind: "table", collection };
}

function untraceableReason(verdict: CollectionVerdict): string {
  switch (verdict.kind) {
    case "unreadable":
      return "its `collection` (the table whose writes trigger it) could not be read";
    case "invalid":
      return "its `collection` is not a table name (lowercase letters, digits, underscores)";
    case "everywhere":
      return `it runs on \`${verdict.collection}\` — every table — so no finite set of scripts names the table that triggers it`;
    case "table":
      return "";
  }
}

/**
 * The live `BusinessRuleLookup`: one `fetchAll` read of `sys_script` in the
 * scope. Injected into the analyzer the same way `createWhereUsedSearch` is.
 */
export function createBusinessRuleLookup(
  reader: RecordReader,
): BusinessRuleLookup {
  return async function lookup(
    request: BusinessRuleLookupRequest,
  ): Promise<BusinessRuleLookupResult> {
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
      return { rules: [], siblings: [], unanalyzable: [], notes: [] };
    }

    /** Every subject, with one reason — the whole-read failure modes. */
    const refuseAll = (reason: string): BusinessRuleLookupResult => {
      for (const subject of subjectsById.values()) {
        unanalyzable.push({
          artifact: subject,
          reason: `the business rule's trigger table and its sibling rules could not be established in scope \`${label}\`: ${reason}`,
        });
      }
      return { rules: [], siblings: [], unanalyzable, notes };
    };

    const read = await reader.queryRecords({
      table: BUSINESS_RULE_TABLE,
      // Scope and nothing else, for the reason `createWhereUsedSearch` gives:
      // an ORDERBY on a column the table may not expose is a 400, and the
      // transport already appends a stable `ORDERBYsys_id` for paging.
      query: `sys_scope=${request.scopeSysId}`,
      fields: [...LOOKUP_FIELDS],
      fetchAll: true,
      // Delegated decision 2026-10-01 (wave 17): this enumeration decides
      // which rules are traced, so it confirms its end with one Stats API
      // count when the instance sends no X-Total-Count — a trimmed last
      // window must read as partial, never as "no more rules". Impact makes
      // no single-page identity read of its own (the scope lookup lives in
      // `@tessera/resolvers`), so every read here takes the cross-check.
      crossCheckCount: true,
      signal: request.ctx.signal,
    });

    if (read.outcome === "undecidable") {
      const detail = `${BUSINESS_RULE_TABLE} could not be read: ${read.detail}`;
      notes.push(note("warning", `business rule lookup: ${detail}`));
      return refuseAll(detail);
    }

    if (read.truncated) {
      // A partial read may be missing a subject's own row (reported as "not in
      // the scope" when it is) or a sibling on its table (an edge silently
      // absent). Either is the silent green QA-9 forbids, so the whole lookup
      // is refused rather than the part that arrived being trusted.
      const detail = `${BUSINESS_RULE_TABLE} read ${describeReadTruncation(read)}`;
      notes.push(
        note(
          "warning",
          `business rule lookup: ${detail}, so sibling rules in scope \`${label}\` may be missing`,
        ),
      );
      return refuseAll(detail);
    }

    // First pass: every addressable row, with its collection verdict.
    const rows: { ref: TargetArtifactRef; verdict: CollectionVerdict }[] = [];
    let anonymous = 0;
    for (const row of read.records) {
      const sysId = text(row["sys_id"]);
      if (sysId === undefined) {
        anonymous += 1;
        continue;
      }
      rows.push({
        ref: {
          table: BUSINESS_RULE_TABLE,
          sysId,
          // Same label rule as the where-used search's `consumerRef`, so one
          // rule reached both ways is printed the same way.
          name: text(row["sys_name"]) ?? `${BUSINESS_RULE_TABLE}/${sysId}`,
        },
        verdict: readCollection(row["collection"]),
      });
    }

    // A row with no sys_id, or a NON-subject row whose table is unknown, might
    // be a sibling of any subject. Nothing can say which, so every subject is
    // refused rather than any of them being reported complete.
    const opaqueOthers = rows.filter(
      (entry) =>
        !subjectsById.has(entry.ref.sysId) &&
        (entry.verdict.kind === "unreadable" ||
          entry.verdict.kind === "invalid"),
    ).length;
    if (anonymous > 0 || opaqueOthers > 0) {
      const detail = `${anonymous + opaqueOthers} ${BUSINESS_RULE_TABLE} row(s) in the scope came back without a readable sys_id or trigger table, so any of them may be a sibling rule`;
      notes.push(note("warning", `business rule lookup: ${detail}`));
      return refuseAll(detail);
    }

    const rules: BusinessRuleRow[] = [];
    const seen = new Set<string>();
    for (const entry of rows) {
      const subject = subjectsById.get(entry.ref.sysId);
      if (subject === undefined) continue;
      seen.add(entry.ref.sysId);
      if (entry.verdict.kind !== "table") {
        unanalyzable.push({
          artifact: subject,
          reason: `this business rule cannot be traced: ${untraceableReason(entry.verdict)}`,
        });
        continue;
      }
      // The subject's OWN ref, not the row's: the node list is keyed on what
      // the resolver handed over, and a second label for one row would print
      // one artifact under two names.
      rules.push({ rule: subject, collection: entry.verdict.collection });
    }

    for (const subject of subjectsById.values()) {
      if (seen.has(subject.sysId)) continue;
      // Delegated decision 2026-09-30 (wave 14): a rule the scope read did not
      // return is unanalyzable, not traced from the resolver's label alone.
      // It is either outside scope `label` (a story can name one) or not a
      // readable `sys_script` row at all, and in both cases its siblings are
      // not rows this read could see — fail closed.
      unanalyzable.push({
        artifact: subject,
        reason: `this business rule was not among the ${BUSINESS_RULE_TABLE} rows of scope \`${label}\`, so its trigger table and sibling rules could not be read`,
      });
    }

    const collections = new Set(rules.map((entry) => entry.collection));
    const siblings: BusinessRuleRow[] = [];
    for (const entry of rows) {
      if (subjectsById.has(entry.ref.sysId)) continue;
      if (entry.verdict.kind === "table") {
        if (collections.has(entry.verdict.collection)) {
          siblings.push({
            rule: entry.ref,
            collection: entry.verdict.collection,
          });
        }
        continue;
      }
      // Delegated decision 2026-09-30 (wave 14): a `global` rule in the scope
      // runs on every subject's table too, in the same transaction, so it is a
      // sibling of each of them. Over-reporting an edge costs a test; under-
      // reporting it costs the one interaction nobody looked at.
      for (const collection of collections) {
        siblings.push({ rule: entry.ref, collection });
      }
    }

    notes.push(
      note(
        "info",
        `business rule lookup: ${read.records.length} ${BUSINESS_RULE_TABLE} row(s) read in scope \`${label}\`; ${rules.length} rule(s) bound to ${collections.size} table(s), ${siblings.length} sibling rule(s)`,
      ),
    );

    return {
      rules: rules.sort(compareRows),
      siblings: siblings.sort(compareRows),
      unanalyzable,
      notes,
    };
  };
}
