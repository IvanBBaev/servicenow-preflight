// Where-used: which scripts inside ONE application mention these artifacts
// (ARCH-15, PLAN Phase 3, DESIGN §12.3 row 3).
//
// ServiceNow ships no API that answers "what calls this Script Include". The
// platform's own Where-Used runs a text search across script columns, and so
// does this: one read per script-bearing table in the scope, then `scanScript`
// over every script column of every row that comes back. The precision that
// buys is stated rather than papered over — each `ScanMatch` carries the
// evidence class that produced it, and the analyzer one file over turns that
// into `ImpactConfidence`. A `low` edge here is the analyzer declining to round
// a guess up to a fact, not a defect in the search.
//
// Almost every branch below exists to keep two outcomes apart that render
// identically in an empty result array (QA-9, and the OPP-1b lesson learned one
// product over): a table that answered with no matching rows, and a table that
// never answered at all. So a refused read becomes a warning plus `incomplete`
// and never a shorter list; a read that stopped short (the SN_MAX_RECORDS cap,
// or a read-ACL short page) says which part of the scope it actually saw; and
// a scope where NOT ONE table answered throws `ResolutionFaultError`, because
// "I could not look" printed as "nothing uses this" is the exact silent green
// this stage exists to prevent (DEV-1: exit 3, an infrastructure fault, never
// a verdict).
//
// TM-1 lands here for real. This is the first place in the workspace that reads
// free text off an instance, and every value taken out of a script column is
// branded with `untrusted()` at the moment it leaves the record — before it is
// measured, logged, or passed anywhere. Nothing in this file ever opens the
// box, so there is no path from an instance-authored comment into a message, a
// query, or a later generation prompt.

import { untrusted } from "@tessera/types";
import type { TargetArtifactRef, UnanalyzableArtifact } from "@tessera/types";
import {
  ResolutionFaultError,
  ResolutionInputError,
  describeReadTruncation,
} from "@tessera/resolvers";
import type { RecordReader, SnRecord } from "@tessera/resolvers";
import { scriptsApi } from "@tessera/sn-client";

import { scanScript } from "./scan.js";
import type {
  ConsumerTable,
  DynamicDispatchMarker,
  ImpactNote,
  ImpactNoteLevel,
  UsageReference,
  WhereUsedRequest,
  WhereUsedResult,
  WhereUsedSearch,
} from "./types.js";

/**
 * Every table whose rows carry script text, with the columns that carry it.
 *
 * Derived from `scriptsApi.SCRIPT_TYPES` rather than re-typed here, for the
 * same reason `@tessera/parity`'s fingerprint index is: one source of truth for
 * "where does ServiceNow keep code". A script type added to `@tessera/sn-client`
 * becomes searchable without a second edit, and — more to the point — the two
 * modules can never drift into disagreeing about which column holds the body,
 * which would show up not as an error but as an edge that quietly stopped being
 * found. Fields are unioned when two script types share a table.
 *
 * Sorted by table name so the reads, and therefore the notes, come out in the
 * same order on every run: a CI log that cannot be diffed against yesterday's
 * is a log nobody reads twice.
 *
 * Today this is nine tables — `sys_script`, `sys_script_client`,
 * `sys_script_include`, `sys_security_acl`, `sys_transform_script`,
 * `sys_ui_action`, `sys_ui_policy` (two columns), `sys_ws_operation` and
 * `sysauto_script` — but nothing here depends on that count.
 */
export const CONSUMER_TABLES: readonly ConsumerTable[] = buildConsumerTables();

function buildConsumerTables(): readonly ConsumerTable[] {
  const byTable = new Map<string, string[]>();
  for (const descriptor of Object.values(scriptsApi.SCRIPT_TYPES)) {
    const fields = byTable.get(descriptor.table) ?? [];
    for (const field of descriptor.scriptFields) {
      if (!fields.includes(field)) fields.push(field);
    }
    byTable.set(descriptor.table, fields);
  }
  return [...byTable.entries()]
    .map(([table, scriptFields]): ConsumerTable => ({ table, scriptFields }))
    .sort((a, b) => compare(a.table, b.table));
}

export interface WhereUsedOptions {
  /**
   * Replaces `CONSUMER_TABLES` wholesale. The seam exists so a later phase
   * widens the search by passing a longer list rather than by editing this
   * file — the same door `ScopeResolverOptions.artifactTables` opens one stage
   * up, and the same door a test uses to drive two tables instead of nine.
   */
  readonly consumerTables?: readonly ConsumerTable[];
}

/**
 * The identity column, plus the display column. `sys_name` is the derived name
 * every `sys_metadata` descendant carries, and all nine tables above are
 * descendants — asking for a per-table `name` instead would mean guessing a
 * different column per table (`sys_transform_script` has no `name` at all, it
 * has `map`), and a guess that is wrong is an unknown-field rejection rather
 * than a missing label. A caller who widens `consumerTables` to something that
 * is NOT a `sys_metadata` descendant inherits that risk, and will see the table
 * report as undecidable rather than silently mislabelled.
 */
const IDENTITY_FIELDS: readonly string[] = ["sys_id", "sys_name"];

/**
 * The Table API renders every field as a string, so a non-string here is a
 * value this stage cannot use — treated exactly like an absent one. Trimming
 * matters because a column returned as whitespace is not a name.
 *
 * Deliberately NOT used on script bodies: an empty script is a readable answer
 * (see below), and collapsing it into `undefined` would turn "this script says
 * nothing" into "this script could not be read".
 */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function note(level: ImpactNoteLevel, message: string): ImpactNote {
  return { level, message };
}

/**
 * Plain code-unit ordering rather than `localeCompare`. Everything compared
 * here is an ASCII identifier — a table name, a column name, a sys_id — and a
 * locale-sensitive comparison would make the output order depend on the machine
 * the run happened on, which is precisely what a diffable log cannot afford.
 */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The output order, fixed in the contract rather than left to arrival order:
 * table, then consumer name, then sys_id (two rows may share a display name),
 * then column, then line. `Array.prototype.sort` is stable, so two matches on
 * the same line stay in the body order the scanner found them in — which is the
 * only tie-break a reader would expect anyway.
 */
function compareReferences(a: UsageReference, b: UsageReference): number {
  return (
    compare(a.consumer.table, b.consumer.table) ||
    compare(a.consumer.name, b.consumer.name) ||
    compare(a.consumer.sysId, b.consumer.sysId) ||
    compare(a.field, b.field) ||
    a.match.line - b.match.line
  );
}

/**
 * Blank tables, duplicate tables and duplicate columns are dropped once, at
 * construction. A repeated table would otherwise cost a second identical read
 * and report every reference in it twice, which reads exactly like two genuine
 * consumers.
 *
 * A table left with no script columns is dropped rather than read: every row it
 * returned would come back with nothing readable to scan and would be reported
 * as an unanalyzable artifact, so a configuration slip would print as a scope
 * full of opaque scripts. If that empties the list entirely, the empty-list
 * warning below is what the caller sees — one honest complaint instead of
 * hundreds of misattributed ones.
 */
function normalizeTables(
  tables: readonly ConsumerTable[],
): readonly ConsumerTable[] {
  const byTable = new Map<string, string[]>();
  const order: string[] = [];
  for (const entry of tables) {
    const table = text(entry.table);
    if (table === undefined) continue;
    let fields = byTable.get(table);
    if (fields === undefined) {
      fields = [];
      byTable.set(table, fields);
      order.push(table);
    }
    for (const raw of entry.scriptFields) {
      const field = text(raw);
      if (field === undefined || fields.includes(field)) continue;
      fields.push(field);
    }
  }
  const out: ConsumerTable[] = [];
  for (const table of order) {
    const scriptFields = byTable.get(table) ?? [];
    if (scriptFields.length === 0) continue;
    out.push({ table, scriptFields });
  }
  return out;
}

/**
 * The names actually searched for, computed once per request rather than per
 * row: the list is the same for every one of potentially thousands of scripts,
 * and de-duplicating it here also keeps a subject listed twice from producing
 * two identical references to the same line.
 *
 * Blanks are dropped because a search for the empty string matches everything,
 * and an artifact whose display name did not survive the read is a subject this
 * search cannot look for by name at all.
 */
function searchedNames(subjects: readonly TargetArtifactRef[]): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const subject of subjects) {
    const name = text(subject.name);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** How a consumer row identifies itself once it is known to be addressable. */
function consumerRef(
  table: string,
  sysId: string,
  row: SnRecord,
): TargetArtifactRef {
  return {
    table,
    sysId,
    // Never an empty label: a reference printed with a blank name tells a
    // reviewer nothing, and `table/sys_id` is at least something they can paste
    // into a URL.
    name: text(row["sys_name"]) ?? `${table}/${sysId}`,
  };
}

export function createWhereUsedSearch(
  reader: RecordReader,
  options: WhereUsedOptions = {},
): WhereUsedSearch {
  const tables = normalizeTables(options.consumerTables ?? CONSUMER_TABLES);

  return async function whereUsed(
    request: WhereUsedRequest,
  ): Promise<WhereUsedResult> {
    const scopeSysId = request.scopeSysId.trim();
    if (scopeSysId === "") {
      // A definite fact about the request rather than about the instance: the
      // MVP search is confined to one scope (DESIGN §12.3 row 3), and
      // `sys_scope=` is not that scope — it is a query for rows belonging to no
      // application, which would answer cleanly and mean nothing.
      throw new ResolutionInputError(
        "whereUsed was given an empty scope sys_id; the where-used search is confined to one application scope and cannot run without it",
      );
    }
    const label = text(request.scopeLabel) ?? scopeSysId;
    const names = searchedNames(request.subjects);

    // Refs, not names, exactly so this map can exist: every `Foo` Script
    // Include contains the word `Foo` in its own definition, and without this
    // the graph would be a list of self-loops with the real consumers buried
    // somewhere underneath them.
    //
    // Keyed by sys_id and holding NAMES, because the exclusion is per (row,
    // name), not per row. A subject row still gets scanned: when the change set
    // is a whole scope every Script Include in it is a subject, so skipping
    // subject rows outright would make include→include edges — the very edges
    // DESIGN §12.3 row 3 exists to report — structurally unreportable. Only a
    // subject's mention of its OWN name is dropped.
    const subjectNamesBySysId = new Map<string, Set<string>>();
    for (const subject of request.subjects) {
      const sysId = text(subject.sysId);
      const name = text(subject.name);
      if (sysId === undefined || name === undefined) continue;
      const own = subjectNamesBySysId.get(sysId);
      if (own === undefined) subjectNamesBySysId.set(sysId, new Set([name]));
      else own.add(name);
    }

    const references: UsageReference[] = [];
    const unanalyzable: UnanalyzableArtifact[] = [];
    const notes: ImpactNote[] = [];
    const undecided: string[] = [];
    let incomplete = false;

    // At most one entry per consumer row. A script that dispatches dynamically
    // is opaque once, not once per column and not once per marker: repeating it
    // would inflate the QA-15 denominator with copies of a single fact.
    const opaque = new Set<string>();
    function markUnanalyzable(
      artifact: TargetArtifactRef,
      reason: string,
    ): void {
      if (opaque.has(artifact.sysId)) return;
      opaque.add(artifact.sysId);
      unanalyzable.push({ artifact, reason });
    }

    // Sequential, not `Promise.all`. The note order has to be reproducible for
    // a CI log to be diffable, and this search is very likely pointed at a
    // production instance — nine parallel `fetchAll` sweeps over its script
    // tables is a different thing to do to it than nine consecutive ones.
    for (const table of tables) {
      const read = await reader.queryRecords({
        table: table.table,
        // Scope and nothing else. No `ORDERBY` on purpose: these tables do not
        // agree on a display column (`sys_transform_script` has no `name`), and
        // an ORDERBY naming a column the table lacks is an unknown-field
        // rejection — a 400 that `RecordReader` correctly reports as
        // undecidable, turning a perfectly readable table into a hole in the
        // graph for no reason at all. That is the OPP-1b failure mode exactly.
        // The transport already appends a stable `ORDERBYsys_id` when no order
        // is given, so paging inside `fetchAll` stays stable; the OUTPUT is
        // sorted in memory instead, where no instance can reject it.
        query: `sys_scope=${scopeSysId}`,
        fields: [...IDENTITY_FIELDS, ...table.scriptFields],
        fetchAll: true,
        // Delegated decision 2026-10-01 (wave 17): every sweep asks for the
        // Stats API count cross-check. A read ACL that trims a sweep's LAST
        // window reads, without X-Total-Count, exactly like the end of
        // results — a consumer silently missing from the graph. The cost is up
        // to one extra Stats GET per swept table (nine at most), and only on
        // an instance that sends no X-Total-Count; with the header nothing
        // extra is sent. A count that disagrees or cannot be obtained marks
        // the sweep truncated, which the branch below already reports.
        crossCheckCount: true,
        signal: request.ctx.signal,
      });

      if (read.outcome === "undecidable") {
        // One table that refused does not invalidate the rows another returned:
        // those consumers really do mention the searched names. Recorded, so
        // the caller sees both the references and the hole in them.
        undecided.push(read.detail);
        incomplete = true;
        notes.push(
          note(
            "warning",
            `${table.table} could not be searched for usage in scope \`${label}\`: ${read.detail}`,
          ),
        );
        continue;
      }

      if (read.truncated) {
        // The read stopped before the full result set, so what follows is part
        // of the scope, not the scope. The rows that did arrive are still
        // processed — a partial answer is worth more than none, as long as it
        // is labelled as partial (QA-9).
        //
        // Delegated decision 2026-09-28 (wave 13): the clause naming WHY comes
        // from sn-client's own `describeTruncation`, fed the `truncationReason`
        // and `total` the `RecordReader` port now carries through — `cap`,
        // `short-page` (read ACLs or an inconsistent X-Total-Count; raising
        // SN_MAX_RECORDS cannot help) and `no-total` each get the transport's
        // wording, and a reason-less truncated read (a stub, an older adapter)
        // is worded as partial without a guessed cause. Wording only: every
        // truncated read still sets `incomplete` and pushes this warning, so
        // `analyzeWithReport` still turns GO into INCONCLUSIVE (fail-closed).
        incomplete = true;
        notes.push(
          note(
            "warning",
            `${table.table} search ${describeReadTruncation(read)}, so only part of scope \`${label}\` was searched — consumers are missing from this result`,
          ),
        );
      }

      let found = 0;
      for (const row of read.records) {
        const sysId = text(row["sys_id"]);
        if (sysId === undefined) {
          // Field-level ACL trimming renders as a row with the field simply
          // absent. An edge has to point AT something, and nothing here can
          // address this row, so it is dropped — out loud, because a consumer
          // that was never examined is not a consumer that was cleared.
          //
          // `incomplete` as well as the note, because the note alone is not a
          // channel every consumer has. `unanalyzable` cannot carry this — an
          // entry there needs a sys_id, which is precisely what is missing —
          // and `ImpactAnalyzer.analyze` hands back an `ImpactGraph` with no
          // notes on it at all. Without the flag, a dropped row leaves that
          // graph looking like a complete trace with one fewer edge, which is
          // the same silent green a refused table read gets flagged for two
          // branches up (QA-9, DEV-1).
          incomplete = true;
          notes.push(
            note(
              "warning",
              `${table.table}: skipped a row with no readable sys_id, so whatever it uses is missing from this result`,
            ),
          );
          continue;
        }
        // Empty for every row that is not itself a subject, which is nearly all
        // of them. Two subjects sharing one name make every mention of it
        // ambiguous, so a shared name is dropped here as well — the analyzer
        // already refuses to call such a graph a clean answer, and inventing a
        // self-loop to represent the ambiguity would not add anything true.
        const ownNames = subjectNamesBySysId.get(sysId);

        const consumer = consumerRef(table.table, sysId, row);
        let readable = 0;
        let marker: DynamicDispatchMarker | undefined;

        for (const field of table.scriptFields) {
          const value = row[field];
          if (typeof value !== "string") {
            // Absent or some other shape: the column was trimmed away, not
            // returned empty. Nothing can be said about what it contains.
            continue;
          }
          readable += 1;
          // TM-1: branded here, at the boundary, before anything else touches
          // it. The scanner is the only consumer and it hands back numbers and
          // enum values, never the text.
          const result = scanScript(untrusted(value), names);
          for (const match of result.matches) {
            if (ownNames?.has(match.name) === true) continue;
            references.push({ consumer, field, match });
            found += 1;
          }
          marker ??= result.dynamic[0];
        }

        if (readable === 0) {
          // Every script column of this row was unreadable. Unlike an empty
          // script — which is an answer — this is an absence of evidence, and
          // it belongs in the same list as dynamic dispatch for the same
          // reason: the analyzer must not count it as examined and clean.
          markUnanalyzable(
            consumer,
            `its script column(s) (${table.scriptFields.join(", ")}) could not be read, so nothing can be said about what it uses`,
          );
        } else if (marker !== undefined) {
          // Deliberately broad, and deliberately independent of whether this
          // row also matched. The script names a call target at runtime, so the
          // absence of a textual match proves nothing about it, and the matches
          // that WERE found do not make the rest of its dispatch visible. The
          // consequence is that a scope containing a single `gs.include(` call
          // reports an unanalyzable artifact; that noise is honest, and it is
          // the whole point of QA-9 — the alternative is a green nobody earned.
          markUnanalyzable(
            consumer,
            `it names a call target at runtime (\`${marker.marker}\` on line ${marker.line}), so a textual search cannot see everything it uses`,
          );
        }
      }

      notes.push(
        note(
          "info",
          `${table.table}: ${read.records.length} row(s) read, ${found} reference(s) in scope \`${label}\``,
        ),
      );
    }

    if (tables.length === 0) {
      // Configured with nothing to look at. Not a fault — no read went wrong —
      // but returning a clean empty answer would be the same lie a failed read
      // would have told, so it is a warning and the result is incomplete.
      notes.push(
        note(
          "warning",
          `no consumer tables are configured, so nothing in scope \`${label}\` was searched for usage`,
        ),
      );
      incomplete = true;
    } else if (undecided.length === tables.length) {
      // Not one table answered. There is no partial result here to label: what
      // uses these artifacts is simply unknown, and an empty reference list
      // would be indistinguishable from "nothing uses this" (QA-9, DEV-1).
      throw new ResolutionFaultError(
        `nothing could be read about what uses the searched artifacts in scope \`${label}\`: ${undecided.join("; ")}`,
      );
    }

    references.sort(compareReferences);
    return { references, unanalyzable, notes, incomplete };
  };
}
