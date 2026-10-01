// The graph builder — the last of the three files behind PLAN Phase 3's
// ImpactAnalyzer port (ARCH-15).
//
// `scan` decides what a single script body says; `whereUsed` decides which
// bodies are read at all; this file decides what the RUN is allowed to conclude
// from the answer. That is a different job from either of the other two, and
// most of it consists of refusing to overstate the result.
//
// DESIGN §12.3 row 3 fixes the MVP surface: Script-Include where-used edges
// inside ONE scope, with confidence levels and `unanalyzable` warnings, and no
// flow tracing. Three consequences run through every branch below.
//
// First, an artifact this analyzer cannot trace is still an artifact of the
// run. A Business Rule handed over by the resolver is not a Script Include, so
// nothing here can say what it touches — but it stays a node AND it becomes an
// `UnanalyzableArtifact`, because QA-15's coverage floor is confirmed artifacts
// divided by ALL impacted ones *including* the unanalyzable. A node list that
// quietly dropped them would inflate every future coverage figure by exactly
// the artifacts the floor exists to catch.
//
// Second, "I looked and could not see all of it" is a different claim from
// "nothing uses this". `WhereUsedResult.incomplete` states that a consumer
// table went unread; only here is it known WHICH subjects that hole applies to,
// so this is where the boolean turns into one honest entry per subject rather
// than into a shorter edge list. Collapsing the two claims is the silent green
// QA-9 exists to forbid.
//
// Third, the two failure modes of the scope lookup travel out untouched.
// `ResolutionInputError` and `ResolutionFaultError` already mean "your argument
// is wrong" and "the read did not complete", the CLI already maps them to exit
// 2 and exit 3 (DEV-1), and re-wrapping them here would blur a distinction the
// operator acts on — a retry fixes one of them and never the other.

import type {
  AffectedArtifact,
  ImpactConfidence,
  ImpactEdge,
  ImpactGraph,
  PipelineContext,
  PlannedSpec,
  TargetArtifactRef,
  UnanalyzableArtifact,
} from "@tessera/types";
import {
  ResolutionInputError,
  artifactKey,
  findScopeIdentity,
} from "@tessera/resolvers";
import type { RecordReader } from "@tessera/resolvers";

import { CONFIDENCE_BY_MATCH_KIND } from "./types.js";
import type {
  BusinessRuleLookup,
  BusinessRuleLookupResult,
  BusinessRuleRow,
  ExplainingImpactAnalyzer,
  ImpactAnalyzerOptions,
  ImpactNote,
  ImpactNoteLevel,
  ImpactReport,
  StandaloneScriptLookup,
  StandaloneScriptLookupResult,
  StandaloneScriptRow,
  UiActionLookup,
  UiActionLookupResult,
  UiActionRow,
  WhereUsedResult,
  WhereUsedSearch,
} from "./types.js";
import { BUSINESS_RULE_TABLE, createBusinessRuleLookup } from "./tableLogic.js";
import { UI_ACTION_TABLE, createUiActionLookup } from "./uiActionLogic.js";
import {
  STANDALONE_SCRIPT_TABLES,
  TRANSFORM_SCRIPT_TABLE,
  createStandaloneScriptLookup,
} from "./standaloneScriptLogic.js";
import { createWhereUsedSearch } from "./whereUsed.js";

/**
 * The table the MVP traces, per DESIGN §12.3 row 3, and still the default.
 * Widening the surface is not a matter of searching for one more name — every
 * other table needs its own notion of what "uses" means — so each table in
 * `SUBJECT_TABLES` below has its own producer, and a table without one is not
 * accepted as a subject at all.
 */
const SUBJECT_TABLE = "sys_script_include";

/**
 * Every table `ImpactAnalyzerOptions.subjectTables` may name. `sys_script`
 * (Business Rules) is traced by `table_logic` (see `tableLogic.ts`);
 * `sys_ui_action` (server-side UI Actions) by `uiActionLogic.ts`;
 * `sysauto_script`, `sys_ws_operation` and `sys_transform_script` (server-side
 * standalone scripts) by `standaloneScriptLogic.ts`.
 *
 * Delegated decision 2026-09-30 (wave 16): client scripts
 * (`sys_script_client`), UI policies (`sys_ui_policy`) and ACLs
 * (`sys_security_acl`) are deliberately NOT subject tables. The first two run
 * in the browser, where a textual Script Include search cannot follow the
 * GlideAjax / form-submit hop to the server; an ACL carries security
 * semantics that no "which include does it call" edge describes. Each stays
 * unanalyzable (INCONCLUSIVE, never GO) until it has a producer of its own —
 * see the header of `standaloneScriptLogic.ts`.
 */
export const SUBJECT_TABLES: readonly string[] = Object.freeze([
  SUBJECT_TABLE,
  BUSINESS_RULE_TABLE,
  UI_ACTION_TABLE,
  ...STANDALONE_SCRIPT_TABLES,
]);

/**
 * Delegated decision 2026-09-30 (wave 14): Business Rule tracing is OPT-IN.
 * The default stays the MVP surface, so every existing caller (the CLI's live
 * run and its commands) keeps reporting a Business Rule as unanalyzable —
 * INCONCLUSIVE, never a silent GO — until it passes `subjectTables` on
 * purpose. Reversible by changing this default.
 *
 * Delegated decision 2026-09-30 (wave 15): UI Action tracing is opt-in on the
 * same terms — `sys_ui_action` is accepted by `subjectTables`, never enabled
 * by this default.
 *
 * Delegated decision 2026-09-30 (wave 16): the standalone script tables
 * (`sysauto_script`, `sys_ws_operation`, `sys_transform_script`) are opt-in on
 * the same terms — accepted by `subjectTables`, never enabled by this default.
 */
const DEFAULT_SUBJECT_TABLES: readonly string[] = [SUBJECT_TABLE];

/** Named only in the scope-identity note; the search does the scope filtering. */
const SCOPE_TABLE = "sys_scope";

/**
 * `ImpactEdge.via` is an open string because PLAN's full Phase-3 vision has
 * three producers (`where_used`, `table_logic`, `trace_table_event`) and this
 * MVP ships the first. Every edge below therefore carries the producer that
 * actually made it, so a later phase adding a second one does not retroactively
 * change what an existing edge claims.
 */
const VIA_WHERE_USED = "where_used";

/** The producer of every Business Rule edge (PLAN Phase 3's second one). */
const VIA_TABLE_LOGIC = "table_logic";

/**
 * Delegated decision 2026-09-30 (wave 14): an edge between two rules on one
 * table is `medium`. They provably run in the same transaction on the same
 * `current` — stronger than a mention — but whether one's writes reach what
 * the other reads is not something a lookup of `collection` can prove, so it
 * is not the `high` of a proven call. Confidence does not gate a verdict.
 */
const SIBLING_CONFIDENCE: ImpactConfidence = "medium";

/**
 * Delegated decision 2026-09-30 (wave 15): an edge from a server-side UI
 * Action to a Business Rule on its table is `medium`, for the reason sibling
 * rules are — the action's write provably fires the rule in the same
 * transaction on the same `current`, but whether the action writes at all
 * (and what the rule then reads) is not something the lookup can prove.
 */
const ACTION_RULE_CONFIDENCE: ImpactConfidence = "medium";

/** What the graph looks like when no UI Action was looked up. */
const NO_ACTIONS: UiActionLookupResult = {
  actions: [],
  rules: [],
  unanalyzable: [],
  notes: [],
};

/** What the graph looks like when no standalone script was looked up. */
const NO_SCRIPTS: StandaloneScriptLookupResult = {
  scripts: [],
  rules: [],
  unanalyzable: [],
  notes: [],
};

/** What the graph looks like when no Business Rule was looked up. */
const NO_RULES: BusinessRuleLookupResult = {
  rules: [],
  siblings: [],
  unanalyzable: [],
  notes: [],
};

/**
 * The strength order of `ImpactConfidence`, written out rather than derived.
 * String comparison would order these alphabetically — `high` < `low` <
 * `medium` — which is not merely a different order but an inverted one, and the
 * bug would surface as a `call` edge quietly demoted to the confidence of a
 * comment that happened to mention the same name.
 */
const CONFIDENCE_RANK: Readonly<Record<ImpactConfidence, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * What the graph looks like when no search was run. A literal rather than a
 * branch around every consumer of the result: the empty case has to travel the
 * same code path as the populated one, otherwise "nothing was searched" and
 * "the search found nothing" get to diverge in their reporting, which is the
 * pair QA-9 is most insistent about keeping honest.
 */
const NOTHING_SEARCHED: WhereUsedResult = {
  references: [],
  unanalyzable: [],
  notes: [],
  incomplete: false,
};

/**
 * Characters a repo path may carry. Everything else is replaced, because a
 * display name is free text a user typed into a form and a path is not: a name
 * containing `/`, `..` or a NUL would otherwise decide where a generated file
 * lands, which is a path-traversal primitive handed to whoever can rename a
 * Script Include (TM-1 treats that name as untrusted input).
 */
const PATH_UNSAFE = /[^A-Za-z0-9._-]/g;

function note(level: ImpactNoteLevel, message: string): ImpactNote {
  return { level, message };
}

/**
 * Deterministic, locale-independent string order. `localeCompare` would sort
 * differently depending on the machine's ICU data, and a CI log that cannot be
 * diffed between two runners is a log nobody trusts.
 */
function compare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The name the where-used search can actually look for, or `undefined`.
 *
 * Two values fail to be a name. Blank is obvious. The other is
 * `` `${table}/${sysId}` `` — the placeholder `@tessera/resolvers` substitutes
 * when a row's `name` column was unreadable, precisely so that a checklist row
 * is never printed as `[ ]` with nothing after it. It is a good label and a
 * useless search term: matching consumer scripts against it would find nothing
 * and report that nothing as "this Script Include is unused", which is the
 * strongest possible claim built on the weakest possible evidence.
 */
function usableName(ref: TargetArtifactRef): string | undefined {
  const name = typeof ref.name === "string" ? ref.name.trim() : "";
  if (name === "" || name === `${ref.table}/${ref.sysId}`) return undefined;
  return name;
}

/**
 * One path segment out of a display name.
 *
 * The mapping is deliberately many-to-one: `Amount Calculator` and
 * `Amount/Calculator` both become `Amount_Calculator`, so two Script Includes
 * really can collide onto one path. That is tolerable only because `spec.id`
 * below is the sys_id and never the name — identity stays correct through a
 * rename and through a collision, and the worst a collision costs is two
 * demanded specs pointing at one file, which ARCH-30's parity check can see.
 * Deriving identity from the path instead would make the same collision merge
 * two artifacts into one checklist row, silently.
 */
function pathSegment(value: string): string {
  return value.replace(PATH_UNSAFE, "_");
}

function compareRefs(
  left: TargetArtifactRef,
  right: TargetArtifactRef,
): number {
  return (
    compare(left.table, right.table) ||
    compare(left.name, right.name) ||
    compare(left.sysId, right.sysId)
  );
}

/**
 * Edges read best grouped by what changed, so the subject's name leads; the
 * consumer's table, name and sys_id follow to make the order total. sys_id is
 * the tiebreaker of last resort rather than the primary key, because a report
 * ordered by sys_id is a report ordered by nothing a human recognises.
 *
 * `from.sysId` is compared too, immediately after the subject's name. It only
 * ever decides anything when two subjects share a name — which a scope should
 * make impossible and which this file warns about when it happens anyway — but
 * without it those two subjects' edges would be ordered by nothing except the
 * order they arrived in. That is stable rather than deterministic: the same
 * graph read twice, from two artifact lists that differ only in order, would
 * diff as changed. Comparing it second keeps each subject's edges in one block
 * instead of interleaving the twins.
 */
function compareEdges(left: ImpactEdge, right: ImpactEdge): number {
  return (
    compare(left.from.name, right.from.name) ||
    compare(left.from.sysId, right.from.sysId) ||
    compare(left.to.table, right.to.table) ||
    compare(left.to.name, right.to.name) ||
    compare(left.to.sysId, right.to.sysId)
  );
}

function compareUnanalyzable(
  left: UnanalyzableArtifact,
  right: UnanalyzableArtifact,
): number {
  return (
    compareRefs(left.artifact, right.artifact) ||
    compare(left.reason, right.reason)
  );
}

/**
 * One entry per (artifact, reason). The same artifact may legitimately be
 * unanalyzable twice for two different reasons — a consumer with dynamic
 * dispatch that is ALSO a subject whose search was truncated — and both belong
 * in the report; what does not belong is the same sentence about the same row
 * printed twice because two producers reached the same conclusion.
 *
 * The key is (sys_id, reason) rather than `artifactKey`'s (table, sys_id): a
 * sys_id is unique across tables in practice, and every reason below names the
 * table it is talking about anyway, so a cross-table collision could only
 * suppress a line that says the same thing.
 */
function dedupeUnanalyzable(
  entries: readonly UnanalyzableArtifact[],
): UnanalyzableArtifact[] {
  const seen = new Set<string>();
  const out: UnanalyzableArtifact[] = [];
  for (const entry of entries) {
    // NUL cannot occur in either half, so the join is collision-free — the same
    // trick `specKey` uses in @tessera/core.
    const key = `${entry.artifact.sysId}\u0000${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

/**
 * The enabled subject tables, validated once at construction. An unknown
 * table is an argument error (DEV-1 exit 2), not a table quietly left
 * untraced: a caller who asked for it believes it is being analysed.
 */
function normalizeSubjectTables(
  tables: readonly string[] | undefined,
): ReadonlySet<string> {
  if (tables === undefined) return new Set(DEFAULT_SUBJECT_TABLES);
  if (!Array.isArray(tables)) {
    throw new ResolutionInputError(
      `subjectTables must be a list of table names; supported: ${SUBJECT_TABLES.join(", ")}`,
    );
  }
  const out = new Set<string>();
  for (const table of tables) {
    if (typeof table !== "string" || !SUBJECT_TABLES.includes(table)) {
      throw new ResolutionInputError(
        `the impact analysis cannot trace ${typeof table === "string" ? `\`${table}\`` : "a non-string table"} as a subject; supported subject tables: ${SUBJECT_TABLES.join(", ")}`,
      );
    }
    out.add(table);
  }
  return out;
}

/** The enabled tables in a fixed order, for a reason string. */
function describeTables(tables: ReadonlySet<string>): string {
  const list = SUBJECT_TABLES.filter((table) => tables.has(table));
  return list.length === 0 ? "no table" : list.join(" and ");
}

/**
 * The ImpactAnalyzer over one application scope.
 *
 * `reader` is the same GET-only, source-bound `RecordReader` the resolvers use
 * (ARCH-19/ARCH-8) and is needed for exactly one read — turning `--scope` into
 * a row identity through `findScopeIdentity`, the shared lookup that keeps this
 * stage and `ScopeResolver` from disagreeing about what a scope name means.
 * Everything else this stage reads goes through the injected `search`.
 */
export function createImpactAnalyzer(
  reader: RecordReader,
  options: ImpactAnalyzerOptions,
): ExplainingImpactAnalyzer {
  // Resolved once, at construction, and not per call. `??` short-circuits, so
  // a test that injects a search never constructs the live one — which is the
  // point of the seam (DESIGN §12.3 row 3 ships one edge producer; the option
  // is how the other two arrive without rewriting the graph builder).
  const search: WhereUsedSearch =
    options.search ??
    createWhereUsedSearch(reader, { consumerTables: options.consumerTables });

  const enabled = normalizeSubjectTables(options.subjectTables);
  const tracesRules = enabled.has(BUSINESS_RULE_TABLE);
  const businessRules: BusinessRuleLookup | undefined = tracesRules
    ? (options.businessRules ?? createBusinessRuleLookup(reader))
    : undefined;
  const tracesActions = enabled.has(UI_ACTION_TABLE);
  const uiActions: UiActionLookup | undefined = tracesActions
    ? (options.uiActions ?? createUiActionLookup(reader))
    : undefined;
  const tracesScripts = STANDALONE_SCRIPT_TABLES.some((table) =>
    enabled.has(table),
  );
  const standaloneScripts: StandaloneScriptLookup | undefined = tracesScripts
    ? (options.standaloneScripts ?? createStandaloneScriptLookup(reader))
    : undefined;
  const isDefaultSurface = enabled.size === 1 && enabled.has(SUBJECT_TABLE);

  async function analyzeWithReport(
    ctx: PipelineContext,
    artifacts: AffectedArtifact[],
  ): Promise<ImpactReport> {
    const notes: ImpactNote[] = [];

    // ── 1. identity ─────────────────────────────────────────────────────────
    // Deliberately un-caught. See the file header: the two resolver errors
    // already carry the DEV-1 distinction the CLI's exit codes are built on.
    const { sysId: scopeSysId, label: scopeLabel } = await findScopeIdentity(
      reader,
      ctx,
      options.scope,
    );
    notes.push(
      note("info", `scope \`${scopeLabel}\` is ${SCOPE_TABLE}/${scopeSysId}`),
    );

    // ── 2. partition the input ──────────────────────────────────────────────
    // Every input ends up in exactly one of two places: a subject the search
    // can look for, or an `UnanalyzableArtifact` that says why it could not be.
    // There is no third bucket and nothing is dropped, because a resolved
    // artifact that simply vanished between stages is invisible to the reader
    // of the verdict — the failure mode this whole partition exists to prevent.
    const inputs: TargetArtifactRef[] = [];
    const subjects: TargetArtifactRef[] = [];
    const subjectsByName = new Map<string, TargetArtifactRef[]>();
    const skipped: UnanalyzableArtifact[] = [];
    const ruleSubjects: TargetArtifactRef[] = [];
    const ruleSeen = new Set<string>();
    const actionSubjects: TargetArtifactRef[] = [];
    const actionSeen = new Set<string>();
    const scriptSubjects: TargetArtifactRef[] = [];
    const scriptSeen = new Set<string>();

    for (const artifact of artifacts) {
      const ref = artifact.ref;
      inputs.push(ref);

      if (!enabled.has(ref.table)) {
        skipped.push({
          artifact: ref,
          // The default wording is kept byte-for-byte: it is what every
          // existing report and test says about a row outside the MVP.
          reason: isDefaultSurface
            ? `the MVP impact analysis traces ${SUBJECT_TABLE} usage only (DESIGN §12.3 row 3), so nothing was traced for this ${ref.table} row`
            : `this impact analysis traces ${describeTables(enabled)} only, so nothing was traced for this ${ref.table} row`,
        });
        continue;
      }

      if (ref.table === BUSINESS_RULE_TABLE) {
        // A Business Rule is found by its sys_id and its trigger table, not by
        // its name — nothing calls a rule by name — so a nameless rule is
        // still traceable here. Its NAME matters only for the demanded path.
        if (!ruleSeen.has(ref.sysId)) {
          ruleSeen.add(ref.sysId);
          ruleSubjects.push(ref);
        }
        continue;
      }

      if (ref.table === UI_ACTION_TABLE) {
        // Found by its sys_id and bound through the lookup; like a rule, its
        // display NAME matters only for the demanded path.
        if (!actionSeen.has(ref.sysId)) {
          actionSeen.add(ref.sysId);
          actionSubjects.push(ref);
        }
        continue;
      }

      if (STANDALONE_SCRIPT_TABLES.includes(ref.table)) {
        // Nothing calls a scheduled job, a REST operation or a transform
        // script by NAME; it is bound by sys_id and its own body is read.
        if (!scriptSeen.has(ref.sysId)) {
          scriptSeen.add(ref.sysId);
          scriptSubjects.push(ref);
        }
        continue;
      }

      const name = usableName(ref);
      if (name === undefined) {
        skipped.push({
          artifact: ref,
          reason: `this ${SUBJECT_TABLE} row has no readable name, and the where-used search matches consumer scripts on the name, so its usage could not be searched for at all`,
        });
        continue;
      }

      subjects.push(ref);
      const sameName = subjectsByName.get(name);
      if (sameName === undefined) {
        subjectsByName.set(name, [ref]);
        continue;
      }
      // Two Script Includes with one name cannot coexist inside a scope, so
      // reaching this line says something is wrong upstream — which is why the
      // note is the interesting part. The handling is the conservative one:
      // every reference to the name is attributed to BOTH rows, because
      // choosing between them would silently drop an edge and the wrong choice
      // is unrecoverable from the report.
      sameName.push(ref);
      notes.push(
        note(
          "warning",
          `${sameName.length} ${SUBJECT_TABLE} rows in scope \`${scopeLabel}\` are named \`${name}\`; every reference to that name is attributed to all of them, because picking one would drop an edge silently`,
        ),
      );
    }

    // ── 3. search ───────────────────────────────────────────────────────────
    // Business Rules first: the lookup turns each rule into its trigger table,
    // and that table's NAME is what the one where-used search below looks for
    // on the rule's behalf.
    let rules = NO_RULES;
    if (businessRules !== undefined && ruleSubjects.length > 0) {
      notes.push(
        note(
          "info",
          `tracing ${ruleSubjects.length} ${BUSINESS_RULE_TABLE} artifact(s) through their trigger tables inside scope \`${scopeLabel}\``,
        ),
      );
      rules = await businessRules({
        ctx,
        scopeSysId,
        scopeLabel,
        subjects: ruleSubjects,
      });
      notes.push(...rules.notes);
    }

    // Which rule each subject resolved to, and the defensive half of the
    // lookup's contract: a rule subject the lookup neither bound nor refused is
    // refused here. An injected lookup that forgot one must not turn that rule
    // into a traced rule with no edges (fail closed, QA-9).
    const boundRules: BusinessRuleRow[] = [];
    const rulesByCollection = new Map<string, TargetArtifactRef[]>();
    {
      const bound = new Map<string, BusinessRuleRow>();
      for (const row of rules.rules) {
        if (ruleSeen.has(row.rule.sysId) && !bound.has(row.rule.sysId)) {
          bound.set(row.rule.sysId, row);
        }
      }
      const refused = new Set(
        rules.unanalyzable.map((entry) => entry.artifact.sysId),
      );
      for (const subject of ruleSubjects) {
        const row = bound.get(subject.sysId);
        if (row === undefined || refused.has(subject.sysId)) {
          if (!refused.has(subject.sysId)) {
            skipped.push({
              artifact: subject,
              reason: `the business rule lookup returned nothing for this ${BUSINESS_RULE_TABLE} row, so its trigger table is unknown and nothing was traced`,
            });
          }
          continue;
        }
        const entry: BusinessRuleRow = {
          rule: subject,
          collection: row.collection,
        };
        boundRules.push(entry);
        const same = rulesByCollection.get(row.collection);
        if (same === undefined)
          rulesByCollection.set(row.collection, [subject]);
        else same.push(subject);
      }
    }

    // The pseudo-subjects handed to the where-used search: one per bound rule,
    // named after its table. Keyed on the rule's own sys_id, so the search's
    // own-name exclusion drops the rule's mentions of its own table.
    const rulePseudoSubjects: TargetArtifactRef[] = boundRules.map((entry) => ({
      table: BUSINESS_RULE_TABLE,
      sysId: entry.rule.sysId,
      name: entry.collection,
    }));

    // UI Actions next, with the same defensive binding: an action subject the
    // lookup neither bound nor refused is refused here (fail closed, QA-9).
    let actions = NO_ACTIONS;
    if (uiActions !== undefined && actionSubjects.length > 0) {
      notes.push(
        note(
          "info",
          `tracing ${actionSubjects.length} ${UI_ACTION_TABLE} artifact(s) through their action names and tables inside scope \`${scopeLabel}\``,
        ),
      );
      actions = await uiActions({
        ctx,
        scopeSysId,
        scopeLabel,
        subjects: actionSubjects,
      });
      notes.push(...actions.notes);
    }

    const boundActions: UiActionRow[] = [];
    const actionsByName = new Map<string, TargetArtifactRef[]>();
    const actionPseudoSubjects: TargetArtifactRef[] = [];
    {
      const bound = new Map<string, UiActionRow>();
      for (const row of actions.actions) {
        if (actionSeen.has(row.action.sysId) && !bound.has(row.action.sysId)) {
          bound.set(row.action.sysId, row);
        }
      }
      const refused = new Set(
        actions.unanalyzable.map((entry) => entry.artifact.sysId),
      );
      const addName = (name: string, subject: TargetArtifactRef): void => {
        actionPseudoSubjects.push({
          table: UI_ACTION_TABLE,
          sysId: subject.sysId,
          name,
        });
        const same = actionsByName.get(name);
        if (same === undefined) actionsByName.set(name, [subject]);
        else same.push(subject);
      };
      for (const subject of actionSubjects) {
        const row = bound.get(subject.sysId);
        if (row === undefined || refused.has(subject.sysId)) {
          if (!refused.has(subject.sysId)) {
            skipped.push({
              artifact: subject,
              reason: `the UI action lookup returned nothing for this ${UI_ACTION_TABLE} row, so whether it runs on the server, and on which table, is unknown and nothing was traced`,
            });
          }
          continue;
        }
        const entry: UiActionRow =
          row.actionName === undefined
            ? { action: subject, table: row.table }
            : { action: subject, table: row.table, actionName: row.actionName };
        boundActions.push(entry);
        if (entry.actionName !== undefined) addName(entry.actionName, subject);
        // Delegated decision 2026-09-30 (wave 15): the action's sys_id is
        // searched for as well as its `action_name`. Scripts and UI policies
        // reach an action by sys_id too (`gsftSubmit(null, form, sysId)`, a
        // `sys_ui_action` GlideRecord `get`), and a missed caller is a silently
        // absent edge; a spurious sys_id match is a cheap `low` edge.
        addName(subject.sysId, subject);
      }
    }

    // Standalone scripts last, with the same defensive binding: a script
    // subject the lookup neither bound nor refused is refused here.
    let scripts = NO_SCRIPTS;
    if (standaloneScripts !== undefined && scriptSubjects.length > 0) {
      notes.push(
        note(
          "info",
          `tracing ${scriptSubjects.length} standalone script artifact(s) through the Script Includes their bodies call inside scope \`${scopeLabel}\``,
        ),
      );
      scripts = await standaloneScripts({
        ctx,
        scopeSysId,
        scopeLabel,
        subjects: scriptSubjects,
      });
      notes.push(...scripts.notes);
    }

    const boundScripts: StandaloneScriptRow[] = [];
    const scriptsBySysId = new Map<string, TargetArtifactRef>();
    const scriptPseudoSubjects: TargetArtifactRef[] = [];
    {
      const bound = new Map<string, StandaloneScriptRow>();
      for (const row of scripts.scripts) {
        if (scriptSeen.has(row.script.sysId) && !bound.has(row.script.sysId)) {
          bound.set(row.script.sysId, row);
        }
      }
      const refused = new Set(
        scripts.unanalyzable.map((entry) => entry.artifact.sysId),
      );
      for (const subject of scriptSubjects) {
        const row = bound.get(subject.sysId);
        if (row === undefined || refused.has(subject.sysId)) {
          if (!refused.has(subject.sysId)) {
            skipped.push({
              artifact: subject,
              reason: `the standalone script lookup returned nothing for this ${subject.table} row, so the Script Includes it calls are unknown and nothing was traced`,
            });
          }
          continue;
        }
        if (subject.table === TRANSFORM_SCRIPT_TABLE) {
          // Delegated decision 2026-10-01 (wave 17): a transform script bound
          // WITHOUT a target table (an injected lookup that predates the hop,
          // or one that skipped it) or without a rules list is refused, never
          // traced as "an import that fires nothing" — its target table's
          // business rules would be silently absent edges.
          if (
            typeof row.targetTable !== "string" ||
            row.targetTable === "" ||
            !Array.isArray(scripts.rules)
          ) {
            skipped.push({
              artifact: subject,
              reason: `the standalone script lookup did not establish the target table of this ${subject.table} row's transform map, so the business rules its import fires are unknown and nothing was traced`,
            });
            continue;
          }
          // The subject's OWN ref, not the row's (an injected lookup's copy).
          boundScripts.push({
            script: subject,
            calls: row.calls,
            targetTable: row.targetTable,
          });
        } else {
          boundScripts.push({ script: subject, calls: row.calls });
        }
        // Delegated decision 2026-09-30 (wave 16): the script's sys_id is
        // searched for, as a UI Action's is. A scheduled job is started from a
        // script by fetching its row (`sysauto_script` GlideRecord `get`, then
        // `SncTriggerSynchronizer.executeNow`), a REST operation or transform
        // script is addressed the same way; a missed caller is a silently
        // absent edge, a spurious sys_id match a cheap `low` one.
        scriptsBySysId.set(subject.sysId, subject);
        scriptPseudoSubjects.push({
          table: subject.table,
          sysId: subject.sysId,
          name: subject.sysId,
        });
      }
    }

    let found = NOTHING_SEARCHED;
    if (
      subjects.length === 0 &&
      rulePseudoSubjects.length === 0 &&
      actionPseudoSubjects.length === 0 &&
      scriptPseudoSubjects.length === 0
    ) {
      // `info`, not `warning`: nothing traceable was asked about, so nothing
      // about the answer is missing. Whatever made the input untraceable has
      // already written its own `unanalyzable` entry above, and a second
      // warning here would only teach the reader to skim the level that counts.
      notes.push(
        note(
          "info",
          `no ${SUBJECT_TABLE} artifact with a readable name was given, so no where-used search was run against scope \`${scopeLabel}\``,
        ),
      );
    } else {
      if (subjects.length > 0) {
        notes.push(
          note(
            "info",
            `tracing usage of ${subjects.length} ${SUBJECT_TABLE} artifact(s) inside scope \`${scopeLabel}\``,
          ),
        );
      }
      // ONE search for both kinds of subject: the consumer tables are read
      // once, whatever the mix.
      found = await search({
        ctx,
        scopeSysId,
        scopeLabel,
        subjects:
          rulePseudoSubjects.length === 0 &&
          actionPseudoSubjects.length === 0 &&
          scriptPseudoSubjects.length === 0
            ? subjects
            : [
                ...subjects,
                ...rulePseudoSubjects,
                ...actionPseudoSubjects,
                ...scriptPseudoSubjects,
              ],
      });
    }
    // Carried through whole and in order: the search's notes are the only
    // record of which consumer tables answered and which did not, and this
    // stage has nothing to add to them.
    notes.push(...found.notes);

    // ── 4. edges ────────────────────────────────────────────────────────────
    const edgesByPair = new Map<string, ImpactEdge>();
    const unknownNames = new Set<string>();

    const addEdge = (
      subject: TargetArtifactRef,
      consumer: TargetArtifactRef,
      via: string,
      confidence: ImpactConfidence,
    ): void => {
      const pair = `${subject.sysId}\u0000${consumer.sysId}`;
      const existing = edgesByPair.get(pair);
      if (existing === undefined) {
        edgesByPair.set(pair, { from: subject, to: consumer, via, confidence });
        return;
      }
      if (CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK[existing.confidence]) {
        edgesByPair.set(pair, { ...existing, confidence });
      }
    };

    for (const reference of found.references) {
      const matched = subjectsByName.get(reference.match.name);
      const ruleMatched = rulesByCollection.get(reference.match.name);
      if (ruleMatched !== undefined) {
        // A script naming the table a rule runs on: the way a script reaches
        // that rule. Attributed to every rule on the table — they all fire.
        for (const rule of ruleMatched) {
          if (rule.sysId === reference.consumer.sysId) continue;
          addEdge(
            rule,
            reference.consumer,
            VIA_TABLE_LOGIC,
            CONFIDENCE_BY_MATCH_KIND[reference.match.kind],
          );
        }
      }
      const actionMatched = actionsByName.get(reference.match.name);
      if (actionMatched !== undefined) {
        // A script naming the action (by `action_name` or sys_id): how a
        // script invokes it. Confidence by the kind of mention, as for a
        // Script Include; an action never edges itself.
        for (const action of actionMatched) {
          if (action.sysId === reference.consumer.sysId) continue;
          addEdge(
            action,
            reference.consumer,
            VIA_WHERE_USED,
            CONFIDENCE_BY_MATCH_KIND[reference.match.kind],
          );
        }
      }
      const scriptMatched = scriptsBySysId.get(reference.match.name);
      if (
        scriptMatched !== undefined &&
        scriptMatched.sysId !== reference.consumer.sysId
      ) {
        // A script naming the standalone script's sys_id: how a script
        // reaches the job, the operation or the transform script.
        addEdge(
          scriptMatched,
          reference.consumer,
          VIA_WHERE_USED,
          CONFIDENCE_BY_MATCH_KIND[reference.match.kind],
        );
      }
      if (matched === undefined) {
        if (
          ruleMatched !== undefined ||
          actionMatched !== undefined ||
          scriptMatched !== undefined
        ) {
          continue;
        }
        // The search contracts to match only the names it was handed, so this
        // is a broken producer rather than an instance fact. It is still
        // reported — a reference nobody can attribute is an edge missing from
        // the graph — but the warning below is the whole of that report, and a
        // warning reaches `isIncomplete(report)` only, never the bare
        // `ImpactGraph` the port hands the pipeline. So on the graph channel
        // this hole is currently invisible; marking it there would mean
        // naming an artifact it belongs to, and neither the consumer (which
        // may have nothing to do with any subject) nor the subjects (none of
        // which this name was matched against) is one the run observed. That
        // choice is recorded rather than guessed at here.
        unknownNames.add(reference.match.name);
        continue;
      }
      for (const subject of matched) {
        // The search already excludes the subjects' own rows — every `Foo`
        // Script Include contains the word `Foo` — but a self-loop that reached
        // a report would read as "this artifact uses itself", and a duplicated
        // guard is far cheaper than the conversation that would follow.
        if (subject.sysId === reference.consumer.sysId) continue;
        // One consumer that both calls `Foo(` and names `Foo` in a comment is
        // one relationship, and it is a high-confidence one: the strongest
        // evidence found is what the pair is worth, and averaging or
        // last-wins would let a trailing comment demote a proven call
        // (`addEdge` keeps the strongest).
        addEdge(
          subject,
          reference.consumer,
          VIA_WHERE_USED,
          CONFIDENCE_BY_MATCH_KIND[reference.match.kind],
        );
      }
    }

    // Rules that share a table run in the same transaction on the same
    // record: each is an edge from the subject rule to the other rule. Both
    // subject rules and non-subject siblings count; a rule never edges itself.
    const rulesOnTable = new Map<string, TargetArtifactRef[]>();
    for (const entry of [...boundRules, ...rules.siblings]) {
      const list = rulesOnTable.get(entry.collection);
      if (list === undefined) rulesOnTable.set(entry.collection, [entry.rule]);
      else if (!list.some((ref) => ref.sysId === entry.rule.sysId)) {
        list.push(entry.rule);
      }
    }
    for (const entry of boundRules) {
      for (const other of rulesOnTable.get(entry.collection) ?? []) {
        if (other.sysId === entry.rule.sysId) continue;
        addEdge(entry.rule, other, VIA_TABLE_LOGIC, SIBLING_CONFIDENCE);
      }
    }

    // A server-side UI Action's write fires the Business Rules on its table:
    // each is an edge from the action to the rule.
    for (const entry of boundActions) {
      for (const row of actions.rules) {
        if (row.collection !== entry.table) continue;
        addEdge(
          entry.action,
          row.rule,
          VIA_TABLE_LOGIC,
          ACTION_RULE_CONFIDENCE,
        );
      }
    }

    // A standalone script's body calls the Script Includes the lookup found:
    // each is a `where_used` edge FROM the include TO the script — the
    // direction every where-used edge has ("the include is used by the
    // script"), with confidence by the kind of mention.
    //
    // A transform script's import writes its map's TARGET table, which fires
    // the Business Rules on it: each is a `table_logic` edge from the script
    // to the rule, as a UI Action's is to the rules on its table.
    //
    // Delegated decision 2026-10-01 (wave 17): the wave-16 decision to leave
    // the target table untraced is reversed (wave-16 residual), and the edge
    // takes the UI Action confidence (`medium`) rather than a new one. As
    // with a UI Action, whether a given `onBefore` / `onAfter` script's row
    // is actually written (a script can `ignore = true`) is not provable from
    // a lookup, so the edge is plausible, not certain — the same claim the
    // UI Action edge makes about its table's rules.
    for (const entry of boundScripts) {
      if (entry.targetTable === undefined) continue;
      for (const row of scripts.rules) {
        if (row.collection !== entry.targetTable) continue;
        addEdge(
          entry.script,
          row.rule,
          VIA_TABLE_LOGIC,
          ACTION_RULE_CONFIDENCE,
        );
      }
    }

    for (const entry of boundScripts) {
      for (const call of entry.calls) {
        if (call.include.sysId === entry.script.sysId) continue;
        addEdge(
          call.include,
          entry.script,
          VIA_WHERE_USED,
          CONFIDENCE_BY_MATCH_KIND[call.match.kind],
        );
      }
    }

    if (unknownNames.size > 0) {
      notes.push(
        note(
          "warning",
          `the where-used search returned reference(s) to name(s) that were never searched for (${[...unknownNames].sort(compare).join(", ")}); they could not be attributed to a subject and are missing from the graph`,
        ),
      );
    }

    const edges = [...edgesByPair.values()].sort(compareEdges);

    // ── 5. nodes ────────────────────────────────────────────────────────────
    // Every input ref — subjects AND the ones that turned out unanalyzable —
    // plus every consumer that earned an edge. Keeping the unanalyzable inputs
    // is not tidiness: QA-15's coverage floor divides confirmed artifacts by
    // ALL impacted artifacts *including* `unanalyzable`, so a node list that
    // dropped them would raise every coverage figure by exactly the artifacts
    // the floor was written to catch, and the run would look better the less it
    // managed to analyse.
    const nodesByKey = new Map<string, TargetArtifactRef>();
    const addNode = (ref: TargetArtifactRef): void => {
      const key = artifactKey(ref);
      if (!nodesByKey.has(key)) nodesByKey.set(key, ref);
    };
    for (const ref of inputs) addNode(ref);
    // Delegated decision 2026-09-30 (wave 16): `edge.from` is a node too. It
    // always was for every earlier producer (the subject is an input); a
    // Script Include a standalone script calls is not, and an edge whose
    // source is missing from `nodes` is a graph a consumer cannot walk. As a
    // node on an enabled table it also demands a unit spec — stricter, so
    // fail-closed.
    for (const edge of edges) {
      addNode(edge.from);
      addNode(edge.to);
    }
    const nodes = [...nodesByKey.values()].sort(compareRefs);

    notes.push(
      note(
        "info",
        tracesRules || tracesActions || tracesScripts
          ? `${edges.length} edge(s) over ${nodes.length} artifact(s)`
          : `${edges.length} where-used edge(s) over ${nodes.length} artifact(s)`,
      ),
    );

    // ── 6. unanalyzable ─────────────────────────────────────────────────────
    // Three sources, one list. The partition's entries say "this input was
    // never traceable"; the search's say "this consumer hides its call target
    // at runtime"; the block below says "this subject was traced against an
    // incomplete set of consumers".
    const traced: UnanalyzableArtifact[] = [];
    if (found.incomplete) {
      // The evidence is whatever the search warned about — an unread table, a
      // truncated page, a row nothing could address. Quoting it keeps the entry
      // actionable: "could not be fully traced" without a cause is
      // indistinguishable from a shrug.
      const detail = found.notes
        .filter((entry) => entry.level === "warning")
        .map((entry) => entry.message)
        .join("; ");
      // No warning came with the flag. `createWhereUsedSearch` always sends one,
      // but `WhereUsedSearch` is an injected port and this is the honest thing
      // to say about an implementation that does not: the search reported a
      // hole and named nothing. Guessing a cause here — an unread table, a
      // truncated page — would be a diagnosis nothing in this run observed.
      const evidence =
        detail === ""
          ? "the search reported that part of the scope went unsearched, without saying which part"
          : detail;
      for (const subject of subjects) {
        traced.push({
          artifact: subject,
          reason: `usage of \`${subject.name}\` could not be fully traced inside scope \`${scopeLabel}\`, so an absent edge is not evidence that nothing uses it: ${evidence}`,
        });
      }
      for (const entry of boundRules) {
        traced.push({
          artifact: entry.rule,
          reason: `the scripts reaching business rule \`${entry.rule.name}\` through table \`${entry.collection}\` could not be fully traced inside scope \`${scopeLabel}\`, so an absent edge is not evidence that nothing triggers it: ${evidence}`,
        });
      }
      for (const entry of boundActions) {
        traced.push({
          artifact: entry.action,
          reason: `the scripts invoking UI action \`${entry.action.name}\` could not be fully traced inside scope \`${scopeLabel}\`, so an absent edge is not evidence that nothing invokes it: ${evidence}`,
        });
      }
      for (const entry of boundScripts) {
        traced.push({
          artifact: entry.script,
          reason: `the scripts reaching ${entry.script.table} script \`${entry.script.name}\` by sys_id could not be fully traced inside scope \`${scopeLabel}\`, so an absent edge is not evidence that nothing reaches it: ${evidence}`,
        });
      }
    }

    const unanalyzable = dedupeUnanalyzable([
      ...skipped,
      ...rules.unanalyzable.filter((entry) =>
        ruleSeen.has(entry.artifact.sysId),
      ),
      ...actions.unanalyzable.filter((entry) =>
        actionSeen.has(entry.artifact.sysId),
      ),
      ...scripts.unanalyzable.filter((entry) =>
        scriptSeen.has(entry.artifact.sysId),
      ),
      ...found.unanalyzable,
      ...traced,
    ]).sort(compareUnanalyzable);

    // ── 7. demanded ─────────────────────────────────────────────────────────
    // The checklist this analysis insists on, which ARCH-30 later parity-checks
    // against what was actually planned. Every Script Include node earns one —
    // the subjects because they changed, and any Script Include that turned up
    // as a CONSUMER because a change to the thing it calls is a reason to test
    // it. `kind` is always `unit`: DESIGN §12.3 row 6 ships a unit generator
    // only, and demanding an e2e spec nothing can generate would open a
    // checklist row that is permanently `missing`.
    //
    // Delegated decision 2026-09-30 (wave 14): with more than one subject
    // table enabled, EVERY node on an enabled table demands one — a Business
    // Rule that turned up as a consumer as much as one that changed — the
    // same rule Script Includes already follow. Stricter, so fail-closed: an
    // unwritten spec is a `missing` checklist row, never a silent GO.
    const demanded: PlannedSpec[] = [];
    for (const ref of nodes) {
      if (!enabled.has(ref.table)) continue;
      const name = usableName(ref);
      if (name === undefined) {
        // No name, no path — DESIGN §4's layout is built entirely out of the
        // artifact's name, so there is nowhere on disk for this spec to live.
        // Said out loud rather than skipped, because a demanded row missing
        // from the checklist is a test nobody will notice was never written.
        notes.push(
          note(
            "warning",
            `no unit spec is demanded for ${ref.table}/${ref.sysId}: without a readable name there is no path under tests/${pathSegment(scopeLabel)}/ to write one to`,
          ),
        );
        continue;
      }
      const segment = pathSegment(name);
      demanded.push({
        spec: {
          // The sys_id, never the name: this is the identity a manifest, a
          // projection map and the parity check all join on, and a rename
          // would otherwise orphan the spec from the artifact it tests.
          id: `${ref.table}/${ref.sysId}`,
          // DESIGN §4's repo layout, verbatim.
          path: `tests/${pathSegment(scopeLabel)}/${ref.table}/${segment}/${segment}.unit.ts`,
        },
        kind: "unit",
        target: ref,
      });
    }
    demanded.sort((left, right) => compare(left.spec.path, right.spec.path));

    // ── 8. the honest summary ───────────────────────────────────────────────
    if (unanalyzable.length > 0) {
      notes.push(
        note(
          "warning",
          `this impact graph is incomplete: ${unanalyzable.length} artifact(s) could not be traced, so the absence of an edge for them is not evidence that nothing uses them (QA-9)`,
        ),
      );
    }

    const graph: ImpactGraph = { nodes, edges, unanalyzable, demanded };
    return { graph, notes };
  }

  return {
    analyzeWithReport,
    // The port's `analyze` drops the notes because the pipeline has no channel
    // for them yet — exactly the split `createScopeResolver` draws between
    // `resolve` and `resolveWithReport`. The arrays are copied rather than
    // aliased so that a caller who sorts or pushes onto the graph it received
    // cannot reach into the report the CLI is about to print.
    async analyze(ctx: PipelineContext, artifacts: AffectedArtifact[]) {
      const report = await analyzeWithReport(ctx, artifacts);
      return {
        nodes: [...report.graph.nodes],
        edges: [...report.graph.edges],
        unanalyzable: [...report.graph.unanalyzable],
        demanded: [...report.graph.demanded],
      };
    },
  };
}
