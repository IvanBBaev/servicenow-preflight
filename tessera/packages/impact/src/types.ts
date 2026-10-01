// The impact vocabulary (ARCH-15, PLAN Phase 3, DESIGN §12.3 row 3).
//
// `@tessera/types` already owns the OUTPUT shapes — `ImpactGraph`, `ImpactEdge`,
// `UnanalyzableArtifact` — because the verdict and the reporters consume them.
// What lives here is everything the analysis needs on the way there and nothing
// downstream should see: how a script was matched, which consumer tables get
// searched, and the notes that explain a graph to the human who asked for it.
//
// Two ideas run through all of it.
//
// First, the analysis is TEXTUAL and says so. There is no ServiceNow API that
// answers "who calls this Script Include" — the platform's own Where-Used runs
// a search across script columns, and so does this. A textual search cannot
// distinguish `new Validator()` from the word "validator" in a comment, so
// instead of pretending to a precision it does not have, every match carries the
// evidence class that produced it and `ImpactConfidence` is derived from that.
// A `low` edge is not a defect in the analyzer; it is the analyzer refusing to
// round a guess up to a fact.
//
// Second, QA-9: the things this stage CANNOT see have to leave a mark. A script
// that builds its call target at runtime (`GlideEvaluator`, `eval`) is opaque to
// any static reader, and a consumer table that refused the read said nothing
// about its rows (the OPP-1b lesson — an unreadable table and an empty one
// render identically). Both become `UnanalyzableArtifact` entries that ride
// through to the verdict, never a shorter edge list.

import type {
  ImpactConfidence,
  PipelineContext,
  TargetArtifactRef,
  TestSpecRef,
  UnanalyzableArtifact,
} from "@tessera/types";
import type { ImpactGraph } from "@tessera/types";
import type { ImpactAnalyzer } from "@tessera/core";

/**
 * How a name was found in a script body, in descending order of what it proves.
 *
 *  * `call` — the name appears in call position: `new Name(`, `Name.method(`,
 *    `Name(`. This is a use of the artifact, not a mention of it.
 *  * `identifier` — the name appears as a whole word in code, but not in call
 *    position: an assignment, an argument, a property access with no call. It
 *    is very likely a reference and cannot be shown to be one.
 *  * `text` — the name appears inside a comment or a string literal. That is a
 *    mention. It is reported because a string is exactly how dynamic dispatch
 *    names its target, and dropping it would hide the most interesting case.
 */
export type MatchKind = "call" | "identifier" | "text";

/**
 * The fixed mapping from evidence class to `ImpactConfidence`. Exported so a
 * test can assert the mapping rather than re-encode it, and so nothing invents
 * a second scale: confidence in this package means "how the name was found",
 * never "how important the analyzer feels the edge is".
 */
export const CONFIDENCE_BY_MATCH_KIND: Readonly<
  Record<MatchKind, ImpactConfidence>
> = {
  call: "high",
  identifier: "medium",
  text: "low",
};

/**
 * One occurrence of one searched name in one script body.
 *
 * Deliberately carries NO excerpt of the surrounding source. TM-1 classifies a
 * script body as untrusted input, and a report that quotes it would print
 * attacker-authored text into a CI log and — worse — hand a later stage a
 * plausible-looking reason to concatenate it into a prompt. The line number is
 * enough for a human to go and look at the instance, which is where the
 * authoritative copy is anyway.
 */
export interface ScanMatch {
  /** The searched name that matched — always one of the names passed in. */
  readonly name: string;
  readonly kind: MatchKind;
  /** 1-based, counted in the body as the instance returned it. */
  readonly line: number;
}

/**
 * The constructs that make the rest of a body unanalyzable, wherever they sit.
 *
 * These are the ways a ServiceNow script names a call target at runtime. Once
 * one is present, the absence of a textual match proves nothing at all about
 * this script: the call may be assembled from a field value, a property, or a
 * concatenation, and no static reader will ever see it (DESIGN §12.3 row 3's
 * "no flow tracing" is the same admission, stated as scope).
 *
 * `gs.include` is here alongside the evaluators because it loads a Script
 * Include by NAME — usually a literal, and then the literal is found as a
 * `text` match, but nothing stops the argument being a variable.
 *
 * `as const` rather than `readonly string[]`, so that the vocabulary declared
 * here and the patterns that implement it in `scan.ts` cannot drift apart: the
 * scanner keys its pattern table by this union, and a marker added below
 * without a pattern is a compile error instead of a marker that is advertised
 * as searched for and quietly falls back to a coarser search.
 */
export const DYNAMIC_DISPATCH_MARKERS = [
  "GlideEvaluator",
  "GlideScopedEvaluator",
  "gs.include",
  "eval",
  "new Function",
] as const;

export type DynamicDispatchMarkerName =
  (typeof DYNAMIC_DISPATCH_MARKERS)[number];

export interface DynamicDispatchMarker {
  /** The construct as it is searched for, e.g. `GlideEvaluator`. */
  readonly marker: DynamicDispatchMarkerName;
  /** 1-based line of the occurrence that was reported. */
  readonly line: number;
}

export interface ScanResult {
  /** Every occurrence found, in body order. Never de-duplicated here. */
  readonly matches: readonly ScanMatch[];
  /** Non-empty ⇒ this script's negative result means nothing (QA-9). */
  readonly dynamic: readonly DynamicDispatchMarker[];
}

/** A table whose rows carry script bodies worth searching. */
export interface ConsumerTable {
  readonly table: string;
  /** The columns on that table that hold script text. */
  readonly scriptFields: readonly string[];
}

/**
 * `info` states a fact about an analysis that answered cleanly (how many rows a
 * table contributed). `warning` means the graph IS NOT A CLEAN ANSWER and must
 * not be consumed as one — the same distinction `@tessera/resolvers` draws, and
 * for the same reason: a reader who sees every line at the same level stops
 * reading the level that matters.
 *
 * "Not a clean answer" is wider than "incomplete", deliberately. A table that
 * refused the read leaves edges MISSING; two Script Includes sharing one name
 * leave edges WRONG, because every consumer that mentions the name is attributed
 * to both and at least one of those attributions is false. Neither graph may be
 * treated as the answer, so both raise the same level and both reach the CLI as
 * `inconclusive` rather than as a verdict.
 */
export type ImpactNoteLevel = "info" | "warning";

export interface ImpactNote {
  readonly level: ImpactNoteLevel;
  /** Written for a human reading a CI log. */
  readonly message: string;
}

/** One consumer script that mentions one of the searched names. */
export interface UsageReference {
  /** The row holding the script — the `to` end of an edge. */
  readonly consumer: TargetArtifactRef;
  /** Which script column matched; a UI Policy has two, and they differ. */
  readonly field: string;
  readonly match: ScanMatch;
}

export interface WhereUsedRequest {
  readonly ctx: PipelineContext;
  /** sys_id of the single scope the search is confined to (DESIGN §12.3). */
  readonly scopeSysId: string;
  /** Human label for that scope, for messages only. */
  readonly scopeLabel: string;
  /**
   * The artifacts whose usage is being traced. Refs rather than bare names,
   * because the search needs both: the NAME is what a consumer script mentions,
   * and the SYS_ID is what keeps a Script Include's own definition out of its
   * own result set — every `Foo` script include contains the word `Foo`.
   */
  readonly subjects: readonly TargetArtifactRef[];
}

export interface WhereUsedResult {
  readonly references: readonly UsageReference[];
  /**
   * Scripts whose negative result proves nothing — dynamic dispatch inside the
   * consumer. Table-level read failures are NOT here: they are reported through
   * `notes` and attributed to the searched artifact by the analyzer, because an
   * unreadable table is not an artifact anyone can name.
   */
  readonly unanalyzable: readonly UnanalyzableArtifact[];
  readonly notes: readonly ImpactNote[];
  /**
   * True when some part of the scope went unsearched: a consumer table that did
   * not answer, a read that stopped at the record cap, a row nothing could
   * address because its `sys_id` was unreadable, or no consumer tables at all.
   *
   * The rule is the channel, not the cause — anything that shortens
   * `references` without being representable in `unanalyzable` has to raise
   * this, or a consumer holding only an `ImpactGraph` (which carries no
   * `notes`) reads the shorter list as a complete answer.
   *
   * The analyzer turns it into an `unanalyzable` entry per searched artifact —
   * "I looked and could not see all of it" is not the same claim as "nothing
   * uses this", and only the analyzer knows which artifacts the hole applies to.
   */
  readonly incomplete: boolean;
}

/** What `whereUsed` needs to reach an instance. Injected, never constructed. */
export interface WhereUsedSearch {
  (request: WhereUsedRequest): Promise<WhereUsedResult>;
}

export interface ImpactAnalyzerOptions {
  /**
   * Scope name or sys_id. REQUIRED: DESIGN §12.3 row 3 confines the MVP to a
   * single scope, and an unbounded where-used search over every script on an
   * instance is a different operation with a different cost, not a default.
   */
  readonly scope: string;
  /** Defaults to `CONSUMER_TABLES`; widened by a later phase, not by an edit. */
  readonly consumerTables?: readonly ConsumerTable[];
  /**
   * The edge producer, injected. Defaults to `createWhereUsedSearch(reader)`.
   *
   * It is a seam rather than a hard-wired call because PLAN's full Phase-3
   * vision has three producers — `where_used`, `table_logic`,
   * `trace_table_event` — and DESIGN §12.3 row 3 ships only the first. Adding
   * the other two should compose here, not rewrite the graph builder. It also
   * lets the graph logic be tested without scripting a table-by-table read.
   */
  readonly search?: WhereUsedSearch;
  /**
   * The artifact tables this analyzer traces as SUBJECTS. Defaults to
   * `["sys_script_include"]` — the DESIGN §12.3 row 3 MVP surface — so an
   * analyzer constructed without it behaves exactly as before. Every entry
   * must be one of `SUBJECT_TABLES`; anything else is refused at construction
   * (`ResolutionInputError`) rather than silently not traced. An input row on
   * a table left out of this list is still a node and is reported
   * unanalyzable, so a table nothing traces stays fail-closed.
   *
   * Adding `"sys_script"` turns on Business Rule tracing (`table_logic`
   * edges: the scripts that name the rule's trigger table, and the other
   * in-scope rules on it) and demands a unit spec for every Business Rule
   * node, exactly as every Script Include node already demands one.
   *
   * Adding `"sys_ui_action"` turns on UI Action tracing for SERVER-side
   * actions (`client` = false): `where_used` edges to the scripts that name
   * the action's `action_name` or sys_id, `table_logic` edges to the in-scope
   * Business Rules on the action's table, and a unit spec for every UI Action
   * node. Client-side and `global`-table actions stay unanalyzable.
   *
   * Adding `"sysauto_script"` (scheduled jobs), `"sys_ws_operation"`
   * (Scripted REST operations) or `"sys_transform_script"` (transform map
   * scripts) turns on tracing for that SERVER-side standalone script table:
   * a `where_used` edge from every in-scope Script Include the script's body
   * calls TO the script, `where_used` edges from the script to any consumer
   * that names its sys_id, and a unit spec for every such script node.
   * Client scripts, ACLs and UI policies are not subject tables at all.
   */
  readonly subjectTables?: readonly string[];
  /**
   * The Business Rule lookup, injected. Defaults to
   * `createBusinessRuleLookup(reader)`, and is only constructed when
   * `subjectTables` includes `"sys_script"`.
   */
  readonly businessRules?: BusinessRuleLookup;
  /**
   * The UI Action lookup, injected. Defaults to `createUiActionLookup(reader)`,
   * and is only constructed when `subjectTables` includes `"sys_ui_action"`.
   */
  readonly uiActions?: UiActionLookup;
  /**
   * The standalone-script lookup, injected. Defaults to
   * `createStandaloneScriptLookup(reader)`, and is only constructed when
   * `subjectTables` includes `"sysauto_script"`, `"sys_ws_operation"` or
   * `"sys_transform_script"`.
   */
  readonly standaloneScripts?: StandaloneScriptLookup;
}

/** One `sys_script` row and the table whose writes trigger it. */
export interface BusinessRuleRow {
  readonly rule: TargetArtifactRef;
  readonly collection: string;
}

export interface BusinessRuleLookupRequest {
  readonly ctx: PipelineContext;
  readonly scopeSysId: string;
  readonly scopeLabel: string;
  /** The `sys_script` subjects whose trigger tables are wanted. */
  readonly subjects: readonly TargetArtifactRef[];
}

/**
 * Every subject lands in exactly one of `rules` (its trigger table is known)
 * or `unanalyzable` (it is not). `siblings` are the OTHER in-scope rules that
 * run on one of the subjects' tables.
 */
export interface BusinessRuleLookupResult {
  readonly rules: readonly BusinessRuleRow[];
  readonly siblings: readonly BusinessRuleRow[];
  readonly unanalyzable: readonly UnanalyzableArtifact[];
  readonly notes: readonly ImpactNote[];
}

export interface BusinessRuleLookup {
  (request: BusinessRuleLookupRequest): Promise<BusinessRuleLookupResult>;
}

/**
 * One server-side `sys_ui_action` row: the table it runs on, and the
 * `action_name` scripts invoke it by (absent when the row has none).
 */
export interface UiActionRow {
  readonly action: TargetArtifactRef;
  readonly table: string;
  readonly actionName?: string;
}

export interface UiActionLookupRequest {
  readonly ctx: PipelineContext;
  readonly scopeSysId: string;
  readonly scopeLabel: string;
  /** The `sys_ui_action` subjects to bind. */
  readonly subjects: readonly TargetArtifactRef[];
}

/**
 * Every subject lands in exactly one of `actions` (a server-side action bound
 * to a table) or `unanalyzable` (it is not). `rules` are the in-scope Business
 * Rules that run on one of the bound actions' tables — a `global` rule is
 * listed once per bound table.
 */
export interface UiActionLookupResult {
  readonly actions: readonly UiActionRow[];
  readonly rules: readonly BusinessRuleRow[];
  readonly unanalyzable: readonly UnanalyzableArtifact[];
  readonly notes: readonly ImpactNote[];
}

export interface UiActionLookup {
  (request: UiActionLookupRequest): Promise<UiActionLookupResult>;
}

/** One Script Include a standalone script's body calls, and where. */
export interface ScriptIncludeCall {
  readonly include: TargetArtifactRef;
  /** The script column the call was found in. */
  readonly field: string;
  readonly match: ScanMatch;
}

/** One bound standalone script and every in-scope Script Include it calls. */
export interface StandaloneScriptRow {
  readonly script: TargetArtifactRef;
  readonly calls: readonly ScriptIncludeCall[];
  /**
   * `sys_transform_script` only: the `target_table` of the script's transform
   * map — the table the import writes, whose Business Rules the write fires.
   * Always present on a bound transform script (the analyzer refuses one
   * without it); absent on every other table.
   */
  readonly targetTable?: string;
}

export interface StandaloneScriptLookupRequest {
  readonly ctx: PipelineContext;
  readonly scopeSysId: string;
  readonly scopeLabel: string;
  /**
   * The `sysauto_script` / `sys_ws_operation` / `sys_transform_script`
   * subjects to bind.
   */
  readonly subjects: readonly TargetArtifactRef[];
}

/**
 * Every subject lands in exactly one of `scripts` (its body was read and
 * scanned against every in-scope Script Include name) or `unanalyzable`
 * (it was not, or its body names a call target at runtime, or — for a
 * transform script — its map's target table could not be established).
 * `rules` are the in-scope Business Rules that run on one of the bound
 * transform scripts' target tables — a `global` rule is listed once per
 * target table, as `UiActionLookupResult.rules` lists it per action table.
 */
export interface StandaloneScriptLookupResult {
  readonly scripts: readonly StandaloneScriptRow[];
  readonly rules: readonly BusinessRuleRow[];
  readonly unanalyzable: readonly UnanalyzableArtifact[];
  readonly notes: readonly ImpactNote[];
}

export interface StandaloneScriptLookup {
  (
    request: StandaloneScriptLookupRequest,
  ): Promise<StandaloneScriptLookupResult>;
}

/**
 * The analyzer's wider return. `ImpactGraph` is what the pipeline consumes, but
 * it has no channel for the reasoning — same shape of problem `ResolutionReport`
 * solves in `@tessera/resolvers`, and solved the same way so the two commands
 * print alike.
 */
export interface ImpactReport {
  readonly graph: ImpactGraph;
  readonly notes: readonly ImpactNote[];
}

/** An `ImpactAnalyzer` that can also explain the graph it just produced. */
export interface ExplainingImpactAnalyzer extends ImpactAnalyzer {
  analyzeWithReport(
    ctx: PipelineContext,
    artifacts: Parameters<ImpactAnalyzer["analyze"]>[1],
  ): Promise<ImpactReport>;
}

/**
 * True iff something in the report means the graph is not a clean answer — an
 * `unanalyzable` entry, or any `warning` note.
 *
 * Named for the `@tessera/resolvers` predicate it mirrors, and kept that way on
 * purpose: the CLI keys its `inconclusive` exit off both, and one name for one
 * decision is worth more than a name that reads a shade more precisely. See
 * `ImpactNoteLevel` for why a `warning` is not always a missing edge.
 */
export function isIncomplete(report: ImpactReport): boolean {
  return (
    report.graph.unanalyzable.length > 0 ||
    report.notes.some((note) => note.level === "warning")
  );
}

// ---------------------------------------------------------------------------
// Intent (PLAN Phase 4 read side / v0.3; DESIGN §4a, ARCH-15, ARCH-25)
// ---------------------------------------------------------------------------
//
// DESIGN §4a splits one word in two, and the split is the whole point:
//
//  * INTENT — a spec in the repo declares this artifact as a target. Knowable
//    before anything runs, from files alone. This is what lives here.
//  * CONFIRMED COVERAGE (QA-8) — a non-vacuous spec targeting the artifact
//    PASSED in the current run (or, in persistent mode, its last pass postdates
//    the artifact's `sys_updated_on`, QA-20). Knowable only after a run, and
//    computed post-run by `computeCoverage` in `@tessera/core`.
//
// Nothing in this file can produce the second one, and nothing here may be
// rendered as though it had. A spec that exists is a statement about somebody's
// plan; only a run is a statement about the code.
//
// It lives in `@tessera/impact` rather than in a CoverageChecker of its own
// because DESIGN §4a puts the pre-run gap signal in the ImpactAnalyzer
// explicitly — the gap set is what drives generation, and generation is driven
// off the graph. The function is pure: it takes the graph and the inventory and
// touches neither disk nor instance, so `@tessera/specs` is NOT a dependency of
// this package — both sides speak `@tessera/types`.

/**
 * One impacted artifact and the specs that declare it as a target.
 *
 * The link is joined on `targets` (table + sysId), never on the spec's file
 * path — QA-16. A path encodes at most one table and one name, and breaks
 * outright for a `ui`/`e2e` spec covering several artifacts, so the declaration
 * is the only join key that stays true as specs get wider.
 */
export interface IntentEntry {
  readonly artifact: TargetArtifactRef;
  /** Empty means a GAP: nothing in the repo claims to test this artifact. */
  readonly specs: readonly TestSpecRef[];
  /**
   * False when the artifact came from `graph.unanalyzable` — the analysis could
   * not trace it. Such an artifact still gets an entry, and its specs still
   * count as intent: what the analyzer failed to see is which OTHER artifacts
   * the change touches, not whether this one has a spec. The flag rides along so
   * a reader is never told a traced artifact and an untraced one are the same
   * kind of fact.
   */
  readonly analyzable: boolean;
}

/**
 * The pre-run gap report. `entries` covers EVERY impacted artifact — those with
 * specs and those without — so a gap is `specs.length === 0` and never a
 * separate list that can drift out of step with this one.
 *
 * QA-15 arithmetic is structural here rather than remembered: the entry set is
 * built from `graph.nodes ∪ graph.unanalyzable`, so `entries.length` IS the
 * denominator the coverage floor must divide by. Building it from `nodes` alone
 * would drop exactly the artifacts the floor exists to catch — the ones nobody
 * could analyse — and would make the ratio climb every time the analysis got
 * WORSE. (Phase 3 recorded this as a trap for whoever wrote the floor; the
 * shape above is how it stops being one.)
 */
export interface IntentReport {
  readonly entries: readonly IntentEntry[];
  readonly notes: readonly ImpactNote[];
  /**
   * True when this report is not a clean answer: the graph it joined against was
   * incomplete, or the spec inventory was. Either way the gap set may be wrong
   * in BOTH directions — an unread spec file understates intent, an untraced
   * artifact understates the impacted set — so the CLI reports `inconclusive`
   * rather than printing a number that looks like a measurement.
   */
  readonly incomplete: boolean;
}

/** Impacted artifacts no repo spec targets — what generation would have to fill. */
export function intentGaps(report: IntentReport): readonly TargetArtifactRef[] {
  return report.entries
    .filter((entry) => entry.specs.length === 0)
    .map((entry) => entry.artifact);
}
