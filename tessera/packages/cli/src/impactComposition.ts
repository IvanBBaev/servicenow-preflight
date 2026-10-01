// How every CLI entry point composes the impact analyzer — one place, so
// `tess run --live`, `tess impact`, `tess coverage` and `tess generate` cannot
// disagree about which artifact tables the analysis traces.
//
// Delegated decision 2026-09-30 (wave 14): Business Rule (`sys_script`)
// tracing is ON by default in the CLI. `@tessera/impact` keeps it opt-in so
// its own default stays the DESIGN §12.3 row 3 MVP surface; the CLI opts in
// because the analysis is fail-closed end to end, so turning it on can only
// move a verdict in two directions:
//
//   * from INCONCLUSIVE ("the MVP analysis cannot trace this rule") to a
//     traced rule that DEMANDS a unit spec — GO only when that spec exists and
//     passes, NO_GO/missing when it does not;
//   * or leave it INCONCLUSIVE, now with a sharper reason (a `global` rule, a
//     rule outside the scope, a refused or truncated `sys_script` read).
//
// It never turns an untraced rule into a silent GO. No stated contract pins
// the old behaviour: the live run's docs promise "never GO over an incomplete
// analysis", which still holds, and the only pins on "a Business Rule is
// always unanalyzable" were tests of the MVP limitation itself. Reversible:
// pass `DEFAULT_CLI_SUBJECT_TABLES = ["sys_script_include"]` below.
//
// The rule lookup reads through a CLASSIFYING reader (`liveArtifactTables.ts`)
// so it keeps the live run's fault/refusal split: a refused `sys_script` read
// (403, a namespace 404, ACL-trimmed sys_ids, a truncated read) comes back to
// the lookup as undecidable and every rule subject is reported unanalyzable
// naming the table — INCONCLUSIVE, exit 5 — while a transport fault (no HTTP
// answer, 401, 429, 5xx, 400) is thrown as a `ResolutionFaultError` and the
// command exits 3. The live run passes its enumeration reader's lookup view
// (`forLookup()`), so a refusal is also recorded in `artifactTablesRefused`,
// tagged `read: "lookup"` so it is not reported as an incomplete enumeration.
//
// Delegated decision 2026-09-30 (wave 15): server-side UI Action
// (`sys_ui_action`) tracing is ON by default in the CLI too, for the same
// reason and in the same two directions as Business Rules above. `@tessera/
// impact` keeps it opt-in (its `DEFAULT_SUBJECT_TABLES` is unchanged); the CLI
// names it explicitly in `DEFAULT_CLI_SUBJECT_TABLES` rather than inheriting
// whatever `SUBJECT_TABLES` grows to, so the next table impact learns to trace
// is a deliberate CLI decision, not a silent one. The action lookup reads
// `sys_ui_action` AND the `sys_script` rules on the actions' tables, so its
// default classifying reader watches both, and the live run hands it the same
// `forLookup()` view as the rule lookup. Reversible: drop `UI_ACTION_TABLE`
// from `DEFAULT_CLI_SUBJECT_TABLES`.
//
// Delegated decision 2026-09-30 (wave 16): the standalone script tables —
// Scheduled Script Executions (`sysauto_script`), Scripted REST operations
// (`sys_ws_operation`) and transform scripts (`sys_transform_script`) — are
// traced by default in the CLI too, for the same reason and in the same two
// directions as Business Rules and UI Actions above: a script subject that
// was INCONCLUSIVE ("this analysis traces … only") now either DEMANDS its own
// unit spec (GO only when it exists and passes) or stays INCONCLUSIVE with a
// sharper reason. `@tessera/impact` keeps them opt-in (they are in its
// `SUBJECT_TABLES`, not its `DEFAULT_SUBJECT_TABLES`). Every read failure on
// this path fails closed: a refused, truncated or ACL-trimmed read of the
// subject's table or of the scope's `sys_script_include` makes the script
// unanalyzable (INCONCLUSIVE, exit 5, recorded as a `read: "lookup"`
// refusal), a script body that names a call target at runtime is
// unanalyzable, and a transport fault on any lookup read is thrown as a
// `ResolutionFaultError` (exit 3). The live run hands the script lookup the
// same `forLookup()` view as the rule and action lookups. Reversible: drop
// `...STANDALONE_SCRIPT_TABLES` from `DEFAULT_CLI_SUBJECT_TABLES`.
//
// Delegated decision 2026-10-01 (wave 17): since `@tessera/impact` traces a
// transform script to the Business Rules on its map's target table, the
// script lookup reads the subject's own table, `sys_script_include`, AND —
// for a transform script — `sys_transform_map` and `sys_script`. Its default
// classifying reader watches exactly `STANDALONE_SCRIPT_LOOKUP_TABLES`, the
// list `@tessera/impact` exports as the one source of what the lookup reads,
// so a table it learns to read next is classified without an edit here (a
// hand-kept list here missed the two transform hops). The same fail-closed
// rules apply to the new reads: a refused, truncated or ACL-trimmed map or
// rule read makes the transform script unanalyzable, a transport fault on
// either is exit 3.

import {
  BUSINESS_RULE_TABLE,
  STANDALONE_SCRIPT_LOOKUP_TABLES,
  STANDALONE_SCRIPT_TABLES,
  UI_ACTION_TABLE,
  createBusinessRuleLookup,
  createImpactAnalyzer,
  createStandaloneScriptLookup,
  createUiActionLookup,
  type ExplainingImpactAnalyzer,
} from "@tessera/impact";
import type { RecordReader } from "@tessera/resolvers";

import { createClassifyingReader } from "./liveArtifactTables.js";

/** The include table the standalone-script lookup reads names from. */
const SCRIPT_INCLUDE_TABLE = "sys_script_include";

/**
 * The subject tables every CLI impact analysis traces: Script Includes (the
 * MVP surface), Business Rules (wave 14), server-side UI Actions (wave 15) and
 * the standalone scripts — scheduled jobs, Scripted REST operations and
 * transform scripts (wave 16). Listed explicitly — see the header.
 */
export const DEFAULT_CLI_SUBJECT_TABLES: readonly string[] = Object.freeze([
  SCRIPT_INCLUDE_TABLE,
  BUSINESS_RULE_TABLE,
  UI_ACTION_TABLE,
  ...STANDALONE_SCRIPT_TABLES,
]);

export interface CliImpactAnalyzerOptions {
  /** Scope name or sys_id — required by `createImpactAnalyzer`. */
  readonly scope: string;
  /**
   * The classifying reader the Business Rule lookup reads `sys_script`
   * through. Must be bound to the same profile as `reader` (ARCH-19). Absent:
   * a classifying wrapper over `reader` watching `sys_script` alone.
   */
  readonly ruleReader?: RecordReader;
  /**
   * The classifying reader the UI Action lookup reads `sys_ui_action` (and the
   * `sys_script` rules on the actions' tables) through. Must be bound to the
   * same profile as `reader` (ARCH-19). Absent: a classifying wrapper over
   * `reader` watching `sys_ui_action` and `sys_script`.
   */
  readonly actionReader?: RecordReader;
  /**
   * The classifying reader the standalone-script lookup reads the subjects'
   * own tables (`sysauto_script`, `sys_ws_operation`, `sys_transform_script`),
   * the scope's `sys_script_include` and — for a transform script's target
   * table — `sys_transform_map` and `sys_script` through. Must be bound to the
   * same profile as `reader` (ARCH-19). Absent: a classifying wrapper over
   * `reader` watching `STANDALONE_SCRIPT_LOOKUP_TABLES` (those six tables).
   */
  readonly scriptReader?: RecordReader;
  /** Default `DEFAULT_CLI_SUBJECT_TABLES`. */
  readonly subjectTables?: readonly string[];
}

/**
 * The impact analyzer as the CLI composes it. `reader` is the GET-only source
 * reader the where-used search and the scope-identity lookup use, exactly as
 * before; only the Business Rule lookup goes through `ruleReader`, the UI
 * Action lookup through `actionReader` and the standalone-script lookup
 * through `scriptReader`.
 */
export function createCliImpactAnalyzer(
  reader: RecordReader,
  options: CliImpactAnalyzerOptions,
): ExplainingImpactAnalyzer {
  const subjectTables = options.subjectTables ?? DEFAULT_CLI_SUBJECT_TABLES;
  const tracesRules = subjectTables.includes(BUSINESS_RULE_TABLE);
  const tracesActions = subjectTables.includes(UI_ACTION_TABLE);
  const tracesScripts = STANDALONE_SCRIPT_TABLES.some((table) =>
    subjectTables.includes(table),
  );
  // Delegated decision 2026-09-30 (wave 15): the default classifying wrappers
  // hand out their LOOKUP view, so a transport fault on a lookup read is
  // worded "could not be read by the impact lookup" rather than "could not be
  // enumerated" — the classification (refusal vs fault) is identical.
  if (!tracesRules && !tracesActions && !tracesScripts) {
    return createImpactAnalyzer(reader, {
      scope: options.scope,
      subjectTables,
    });
  }
  const businessRules = tracesRules
    ? createBusinessRuleLookup(
        sameProfile(
          reader,
          options.ruleReader ??
            createClassifyingReader(reader, [BUSINESS_RULE_TABLE]).forLookup(),
          "business rule",
        ),
      )
    : undefined;
  const uiActions = tracesActions
    ? createUiActionLookup(
        sameProfile(
          reader,
          options.actionReader ??
            createClassifyingReader(reader, [
              UI_ACTION_TABLE,
              BUSINESS_RULE_TABLE,
            ]).forLookup(),
          "UI action",
        ),
      )
    : undefined;
  const standaloneScripts = tracesScripts
    ? createStandaloneScriptLookup(
        sameProfile(
          reader,
          options.scriptReader ??
            createClassifyingReader(reader, [
              ...STANDALONE_SCRIPT_LOOKUP_TABLES,
            ]).forLookup(),
          "standalone script",
        ),
      )
    : undefined;
  return createImpactAnalyzer(reader, {
    scope: options.scope,
    subjectTables,
    ...(businessRules === undefined ? {} : { businessRules }),
    ...(uiActions === undefined ? {} : { uiActions }),
    ...(standaloneScripts === undefined ? {} : { standaloneScripts }),
  });
}

/**
 * Fail closed: a lookup on another instance would bind this scope's rules,
 * actions or scripts to someone else's tables (ARCH-19).
 */
function sameProfile(
  reader: RecordReader,
  lookupReader: RecordReader,
  what: string,
): RecordReader {
  if (lookupReader.profile !== reader.profile) {
    throw new Error(
      `the ${what} reader is bound to profile "${lookupReader.profile}", not the source profile "${reader.profile}" (ARCH-19)`,
    );
  }
  return lookupReader;
}
