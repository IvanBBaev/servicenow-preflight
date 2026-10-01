/**
 * @tessera/impact — ARCH-15's answer to "what does it touch?" (PLAN Phase 3).
 *
 * Three files behind one port. `scan` is pure text analysis over a single
 * script body; `whereUsed` drives that scanner across every script-bearing
 * table of ONE application scope; `analyze` composes the result into the
 * `ImpactGraph` the verdict consumes — nodes, confidence-carrying edges, the
 * `unanalyzable` list QA-9 insists on, and the `demanded` checklist ARCH-30
 * parity-checks against what was actually planned. `intent` then joins that
 * graph against the repo's specs to produce DESIGN §4a's pre-run gap signal —
 * declared intent, never confirmed coverage (QA-8), and pure.
 *
 * DESIGN §12.3 row 3 draws the MVP line: Script-Include where-used edges,
 * inside the single scope, with confidence levels and unanalyzable warnings —
 * and no flow tracing. So the graph answers "which scripts mention this Script
 * Include", not "which of them will execute the changed branch". The distance
 * between those two questions is exactly what `ImpactConfidence` and
 * `unanalyzable` are for: the analyzer states the weaker claim honestly instead
 * of dressing it up as the stronger one.
 *
 * Everything here READS, through the same GET-only `RecordReader` bound to the
 * ARCH-19 source profile that `@tessera/resolvers` uses — injected, not
 * constructed, so there is no second transport and no path to a write.
 *
 * TM-1: this is the first stage in the workspace that reads free text off an
 * instance, so it is where `Untrusted<T>` starts being enforced rather than
 * merely intended. Script bodies enter branded and reach exactly one
 * `unwrapUntrusted` call — inside the scanner, whose whole job is to regex a
 * hostile string and return numbers and enum values, never the string.
 */

export { SUBJECT_TABLES, createImpactAnalyzer } from "./analyze.js";
export { BUSINESS_RULE_TABLE, createBusinessRuleLookup } from "./tableLogic.js";
export { UI_ACTION_TABLE, createUiActionLookup } from "./uiActionLogic.js";
export {
  REST_OPERATION_TABLE,
  SCHEDULED_SCRIPT_TABLE,
  STANDALONE_SCRIPT_LOOKUP_TABLES,
  STANDALONE_SCRIPT_TABLES,
  TRANSFORM_MAP_TABLE,
  TRANSFORM_SCRIPT_TABLE,
  createStandaloneScriptLookup,
} from "./standaloneScriptLogic.js";
export { computeIntent } from "./intent.js";
export type { IntentOptions } from "./intent.js";
export { scanScript } from "./scan.js";
export {
  CONFIDENCE_BY_MATCH_KIND,
  DYNAMIC_DISPATCH_MARKERS,
  intentGaps,
  isIncomplete,
} from "./types.js";
export type {
  BusinessRuleLookup,
  BusinessRuleLookupRequest,
  BusinessRuleLookupResult,
  BusinessRuleRow,
  ConsumerTable,
  DynamicDispatchMarker,
  DynamicDispatchMarkerName,
  ExplainingImpactAnalyzer,
  ImpactAnalyzerOptions,
  ImpactNote,
  ImpactNoteLevel,
  ImpactReport,
  IntentEntry,
  IntentReport,
  MatchKind,
  ScanMatch,
  ScanResult,
  ScriptIncludeCall,
  StandaloneScriptLookup,
  StandaloneScriptLookupRequest,
  StandaloneScriptLookupResult,
  StandaloneScriptRow,
  UiActionLookup,
  UiActionLookupRequest,
  UiActionLookupResult,
  UiActionRow,
  UsageReference,
  WhereUsedRequest,
  WhereUsedResult,
  WhereUsedSearch,
} from "./types.js";
export { CONSUMER_TABLES, createWhereUsedSearch } from "./whereUsed.js";
export type { WhereUsedOptions } from "./whereUsed.js";
export {
  LEX_CODE,
  LEX_COMMENT,
  LEX_REGEX,
  LEX_STRING,
  firstLexDoubt,
  lexScript,
} from "./lex.js";
export type {
  ScriptLexOptions,
  ScriptLexResult,
  ScriptLexState,
} from "./lex.js";
