// The seven CLI-local option tables, and why they are not one.
//
// `@tessera/config` owns the canonical `PREFLIGHT_OPTIONS` table and is generic
// over "any table of this shape" (see its header). This module exercises that
// extension point rather than editing the library:
//
//  * PREFLIGHT_CLI_OPTIONS = PREFLIGHT_OPTIONS + the rows only the CLI needs
//    (`--artifact`, `--allow`, `--prod`).
//
//    `--artifact` exists because preflight has no other way to learn what to
//    compare. Without it the ARCH-20 parity stage would have nothing to compare
//    and would report `not-applicable` forever — a permanently unearned green
//    dressed up as a check (QA-9). Phase 2 built the ARCH-5 composite that will
//    eventually supersede it (see RESOLVE_OPTIONS below and `tess resolve`),
//    but preflight does not consume it yet, so naming artifacts by hand remains
//    the honest state of this command.
//
//  * DOCTOR_OPTIONS is a SEPARATE table, and the reason is mechanical rather
//    than stylistic. `tess doctor --instance A --target B` must probe two
//    different instances, but in the canonical table `--instance` is the
//    ARCH-29 alias, and `collapseInstanceAlias` throws when the alias and an
//    explicitly-set role disagree — by design, because for a PIPELINE the alias
//    means "all three roles are this one instance". The doctor is not a
//    pipeline: it writes nothing, so ARCH-8's single-writer rule has nothing to
//    protect and two independent read targets are meaningful. Binding
//    `--instance` to key `runner` (NOT to `INSTANCE_ALIAS_KEY`) makes
//    `findByKey(options, "instance")` miss, the collapse step early-returns,
//    and the two flags coexist.
//
//    KNOWN LIMITATION: a discovered `tessera.config.json` holding preflight-only
//    keys (`source`, `scope`, …) is rejected by this narrower table, with the
//    resolver's own "unknown key" message. Phase 1 accepts that over a doctor
//    `--help` advertising flags the doctor ignores.
//
//  * RESOLVE_OPTIONS is a third table for the same class of reason. `tess
//    resolve` binds ONE role — the ARCH-19 source — and writes nothing, so
//    every write-side row of the canonical table would be a flag the command
//    silently ignores: `--runner` and `--target` name instances it never
//    contacts, `--mode` offers an apply that does not exist here, and
//    `--allow`/`--prod` configure a §11.2 writability decision this command
//    never makes. An advertised flag that changes nothing is worse than a
//    missing one — it reads as a knob and behaves as a comment. What is left
//    after that subtraction is the source, the ARCH-5 resolver inputs, and two
//    knobs the resolvers themselves expose; that is small enough to state
//    outright rather than assemble by exclusion. The same KNOWN LIMITATION as
//    the doctor's applies: a discovered config file carrying preflight-only
//    keys is rejected by this narrower table.
//
//  * IMPACT_OPTIONS is RESOLVE_OPTIONS with two edits, because `tess impact`
//    resolves the same change set through the same composite before it analyses
//    it — and inherits the same subtraction, for the same reasons.
//
//    `--scope` becomes REQUIRED, enforced in the command because this table has
//    no way to say so. DESIGN §12.3 row 3 confines the MVP to a single scope and
//    `ImpactAnalyzerOptions.scope` is not optional, so a run without one has no
//    boundary to search inside; an unbounded where-used search across every
//    script on an instance is a different operation with a different cost, not
//    the default spelling of this one.
//
//    `--update-set` is DROPPED rather than declared-and-refused. `resolve`
//    declares it so the operator who asks "what is my change set" reads DESIGN
//    §12.3's deferral instead of an unknown-flag error, and `resolve` is the
//    command that question is asked on. Here the flag could only ever produce
//    exit 2 before one edge was traced, so carrying it would advertise an input
//    on the command that has least use for it, twice over.
//
//  * COVERAGE_OPTIONS is IMPACT_OPTIONS plus exactly one row, `--tests-root`,
//    because `tess coverage` runs the same analysis and then joins it against
//    the repo. Every impact flag still means what it meant — the impacted set is
//    this report's denominator (QA-15), so narrowing it narrows the question —
//    and the added row is the only input the analysis itself has no opinion on.
//
//    It carries a DEFAULT (`tests`, the DESIGN §4 layout) rather than being
//    required, and that is a deliberate line: a default is safe here only
//    because a missing root is REFUSED (exit 2) rather than read as an empty
//    one. The dangerous default would be an empty string, which
//    `@tessera/specs` rejects outright — a root that was never read and a repo
//    with no specs must never produce the same zero (OPP-1b).
//
//  * GENERATE_OPTIONS is COVERAGE_OPTIONS plus the generation knobs, spread for
//    the same reason. It is the only table carrying a `secret` row, and the
//    block comment above it is where that decision is argued.

import { INSTANCE_ALIAS_KEY, PREFLIGHT_OPTIONS } from "@tessera/config";
import type { OptionSpec } from "@tessera/config";
import {
  ANTHROPIC_DEFAULT_BASE_URL,
  ANTHROPIC_DEFAULT_MODEL_ID,
  DEFAULT_GENERATION_DEADLINE_MS,
} from "@tessera/generate";
import {
  DEFAULT_ARTIFACT_TABLES,
  DEFAULT_UPDATE_SET_STORY_FIELD,
} from "@tessera/resolvers";
import { TEST_KINDS } from "@tessera/types";

/** Separates `<table>/<sysId>` from the optional trailing `:<label>`. */
export const ARTIFACT_LABEL_SEPARATOR = ":";

/**
 * The DESIGN §4 repo layout's tests root, relative to the working directory.
 *
 * A CLI-level default, deliberately not a `@tessera/specs` one: the library
 * takes an absolute path and has no notion of a working directory to resolve
 * against, and giving it a default would let a caller that forgot the flag read
 * a directory it never named.
 */
export const DEFAULT_TESTS_ROOT = "tests";

export const PREFLIGHT_CLI_OPTIONS = [
  ...PREFLIGHT_OPTIONS,
  {
    key: "artifacts",
    flag: "--artifact",
    env: "TESSERA_ARTIFACTS",
    type: "list",
    repeatable: true,
    describe:
      "artifact to parity-check: table/sys_id[:label] — repeatable (ARCH-20)",
  },
  {
    key: "allow",
    flag: "--allow",
    env: "TESSERA_ALLOW",
    type: "list",
    repeatable: true,
    describe:
      "§11.2 non-prod allowlist entry — the ONLY source of writability (--mode apply)",
  },
  {
    key: "prod",
    flag: "--prod",
    env: "TESSERA_PROD",
    type: "list",
    repeatable: true,
    describe: "§11.1 prod declaration — no flag lifts one (repeatable)",
  },
  // The four `--mode apply` hardening rows (delegated decision 2026-09-23,
  // TODO "preflight apply"). All four are ARGV-ONLY — no `env`, and
  // `sources: ["flag"]` so a config file or an ambient variable naming one is
  // REFUSED rather than read. Each is a per-invocation statement by the person
  // at the keyboard: an acknowledgement committed to a repo, or a plan hash
  // left in a shell profile, would be an override nobody made for THIS run.
  {
    key: "acknowledgeProd",
    flag: "--acknowledge-prod",
    type: "string",
    sources: ["flag"],
    describe:
      "§11.4 audited override (apply only): covers ONLY an allowlisted runner a heuristic downgraded to prod-suspect; the reason is journalled before any write",
  },
  {
    key: "ledgerRoot",
    flag: "--ledger-root",
    type: "string",
    sources: ["flag"],
    describe:
      "§4b ledger root for the §11.4 audit and the ARCH-33 standing-infra ledger (apply only). Default: <cwd>/.tessera",
  },
  {
    key: "planHash",
    flag: "--plan-hash",
    type: "string",
    sources: ["flag"],
    describe:
      "§6b digest from a reviewed `--mode plan` run (apply only): the plan is recomputed and a mismatch is REFUSED (exit 4), never silently re-planned",
  },
  {
    key: "idempotencyKey",
    flag: "--idempotency-key",
    type: "string",
    sources: ["flag"],
    describe:
      "ARCH-33 key for this apply (apply only): a retry with the same key and plan skips writes already confirmed. Default: the run id",
  },
] as const satisfies readonly OptionSpec[];

export const DOCTOR_OPTIONS = [
  {
    // Key `runner`, flag `--instance`: see the header. This must NOT be
    // INSTANCE_ALIAS_KEY or the two-instance form below stops parsing.
    key: "runner",
    flag: "--instance",
    env: "TESSERA_INSTANCE",
    type: "string",
    describe: "instance to diagnose (read-only — the doctor never writes)",
  },
  {
    key: "target",
    flag: "--target",
    env: "TESSERA_TARGET",
    type: "string",
    describe:
      "second instance to diagnose read-only; ARCH-8 permits probing any role",
  },
  {
    key: "kinds",
    flag: "--kind",
    env: "TESSERA_KINDS",
    type: "list",
    repeatable: true,
    choices: TEST_KINDS,
    describe: `test kinds whose preconditions must hold — repeatable (${TEST_KINDS.join("|")})`,
  },
  {
    key: "json",
    flag: "--json",
    env: "TESSERA_JSON",
    type: "boolean",
    default: false,
    describe: "emit the machine-readable report instead of the human one",
  },
  {
    key: "config",
    flag: "--config",
    env: "TESSERA_CONFIG",
    type: "string",
    sources: ["flag", "env", "default"],
    describe:
      "explicit config file; without it tessera.config.json is discovered upwards",
  },
] as const satisfies readonly OptionSpec[];

export const RESOLVE_OPTIONS = [
  {
    key: "source",
    flag: "--source",
    env: "TESSERA_SOURCE",
    type: "string",
    describe:
      "§2a source role — artifacts and stories are READ from here (ARCH-19)",
  },
  {
    // The genuine ARCH-29 alias this time, unlike the doctor's `--instance`.
    // A one-role command is exactly the case the alias was written for: "all
    // three roles are this one instance" collapses onto `source` with nothing
    // to contradict it, so `tess resolve --instance dev` is unambiguous.
    key: INSTANCE_ALIAS_KEY,
    flag: "--instance",
    env: "TESSERA_INSTANCE",
    type: "string",
    describe:
      "ARCH-29 alias — collapses onto the source role, which is all resolve binds",
  },
  {
    key: "story",
    flag: "--story",
    env: "TESSERA_STORY",
    type: "string",
    describe: "resolver input — story number or sys_id (ARCH-5)",
  },
  {
    key: "scope",
    flag: "--scope",
    env: "TESSERA_SCOPE",
    type: "string",
    describe: "resolver input — application scope name or sys_id (ARCH-5)",
  },
  {
    // Declared even though it is unsupported, and that is the point. Left out
    // of the table, `--update-set X` dies in the parser as an unknown flag,
    // which tells an operator that Tessera has never heard of update sets. In
    // it, the value reaches the composite and comes back with DESIGN §12.3's
    // actual reason for the refusal. A deferral the user can read beats a
    // typo-shaped error message about a real feature.
    key: "updateSet",
    flag: "--update-set",
    env: "TESSERA_UPDATE_SET",
    type: "string",
    describe:
      "resolver input — REFUSED with exit 2; UpdateSetResolver is deferred (DESIGN §12.3)",
  },
  {
    key: "artifactTables",
    flag: "--artifact-table",
    env: "TESSERA_ARTIFACT_TABLES",
    type: "list",
    repeatable: true,
    default: DEFAULT_ARTIFACT_TABLES,
    describe: `tables the scope adapter enumerates — repeatable (default ${DEFAULT_ARTIFACT_TABLES.join(",")})`,
  },
  {
    // A flag rather than a constant because it is the one piece of ServiceNow
    // schema in @tessera/resolvers that was NOT verified against a live
    // instance: the column linking `sys_update_set` back to `rm_story` is
    // plugin- and version-dependent, and OPP-1b is the standing reminder that
    // a wrong field name reads back exactly like an empty result set. An
    // operator whose instance names it differently fixes it here, at the cost
    // of one flag, instead of filing a bug against a hard-coded guess.
    key: "updateSetStoryField",
    flag: "--update-set-story-field",
    env: "TESSERA_UPDATE_SET_STORY_FIELD",
    type: "string",
    default: DEFAULT_UPDATE_SET_STORY_FIELD,
    describe: `sys_update_set column linking to rm_story (default \`${DEFAULT_UPDATE_SET_STORY_FIELD}\`; unverified live)`,
  },
  {
    key: "json",
    flag: "--json",
    env: "TESSERA_JSON",
    type: "boolean",
    default: false,
    describe: "emit the machine-readable report instead of the human one",
  },
  {
    key: "config",
    flag: "--config",
    env: "TESSERA_CONFIG",
    type: "string",
    sources: ["flag", "env", "default"],
    describe:
      "explicit config file; without it tessera.config.json is discovered upwards",
  },
] as const satisfies readonly OptionSpec[];

export const IMPACT_OPTIONS = [
  {
    key: "source",
    flag: "--source",
    env: "TESSERA_SOURCE",
    type: "string",
    describe:
      "§2a source role — artifacts, stories and scripts are READ from here (ARCH-19)",
  },
  {
    key: INSTANCE_ALIAS_KEY,
    flag: "--instance",
    env: "TESSERA_INSTANCE",
    type: "string",
    describe:
      "ARCH-29 alias — collapses onto the source role, which is all impact binds",
  },
  {
    key: "story",
    flag: "--story",
    env: "TESSERA_STORY",
    type: "string",
    describe: "resolver input — story number or sys_id (ARCH-5)",
  },
  {
    // REQUIRED here, unlike `resolve`, and enforced in the command because this
    // table has no way to say so. It does double duty: the ARCH-5 scope adapter
    // takes it as a resolver input, and the analyzer takes it as the boundary
    // the where-used search runs inside.
    key: "scope",
    flag: "--scope",
    env: "TESSERA_SCOPE",
    type: "string",
    describe:
      "REQUIRED — the single application scope the analysis is confined to (DESIGN §12.3)",
  },
  {
    key: "artifactTables",
    flag: "--artifact-table",
    env: "TESSERA_ARTIFACT_TABLES",
    type: "list",
    repeatable: true,
    default: DEFAULT_ARTIFACT_TABLES,
    describe: `tables the scope adapter enumerates — repeatable (default ${DEFAULT_ARTIFACT_TABLES.join(",")})`,
  },
  {
    // Same flag, same reason as `resolve`'s: OPP-1b, where a wrong column name
    // reads back exactly like a story that changed nothing.
    key: "updateSetStoryField",
    flag: "--update-set-story-field",
    env: "TESSERA_UPDATE_SET_STORY_FIELD",
    type: "string",
    default: DEFAULT_UPDATE_SET_STORY_FIELD,
    describe: `sys_update_set column linking to rm_story (default \`${DEFAULT_UPDATE_SET_STORY_FIELD}\`; unverified live)`,
  },
  {
    key: "json",
    flag: "--json",
    env: "TESSERA_JSON",
    type: "boolean",
    default: false,
    describe: "emit the machine-readable report instead of the human one",
  },
  {
    key: "config",
    flag: "--config",
    env: "TESSERA_CONFIG",
    type: "string",
    sources: ["flag", "env", "default"],
    describe:
      "explicit config file; without it tessera.config.json is discovered upwards",
  },
] as const satisfies readonly OptionSpec[];

// Spread rather than copied, unlike every table above it, because coverage
// differs from impact by ADDITION only — nothing is dropped and no row changes
// meaning. The copies exist where a table differs by SUBTRACTION or by a shifted
// `describe`, which a spread cannot express without a second mechanism to undo
// part of what it just included. Here the spread makes the header's claim ("the
// impact table plus one row") true by construction, and keeps `--tests-root`
// from silently drifting away from the analysis flags it is joined against.
//
// The cost is print order: `--tests-root` lands after `--config` in `--help`
// instead of next to `--scope`. That is the cheaper of the two defects.
export const COVERAGE_OPTIONS = [
  ...IMPACT_OPTIONS,
  {
    key: "testsRoot",
    flag: "--tests-root",
    env: "TESSERA_TESTS_ROOT",
    type: "string",
    default: DEFAULT_TESTS_ROOT,
    describe: `tests-as-code root read for .manifest.json — DESIGN §4 layout (default \`${DEFAULT_TESTS_ROOT}\`, resolved against the cwd)`,
  },
] as const satisfies readonly OptionSpec[];

/**
 * The two `LLMProvider` adapters `@tessera/generate` ships. `template` is the
 * default on purpose: it is offline, deterministic and reaches no third party,
 * so the spelling of the command that costs money is the one an operator has to
 * type out.
 */
export const GENERATE_PROVIDERS = ["template", "anthropic"] as const;

// GENERATE_OPTIONS is COVERAGE_OPTIONS plus the generation knobs, spread for the
// same reason coverage spreads impact: `tess generate` runs the identical
// analysis and then hands the graph to a TestGenerator, so every flag above
// still means exactly what it meant, and --tests-root is doing MORE work here
// than it does on coverage — there it was read, here it is also the root the
// proposed/ tree is written under (DEV-4).
//
// `--kind` is a STRING here, not the repeatable list `tess doctor` declares.
// `TestGenerator.generate(ctx, graph, kind)` takes one kind, and a list would
// have to be either silently truncated or silently looped; both are a flag that
// does not mean what it says.
//
// THE API KEY IS ENV-ONLY AND MARKED SECRET, and it is the first row in the
// shipped surface to use that mechanism — @tessera/config's own header records
// that Phase 1 had no genuine candidate for it and exercised it from a test
// table instead. This is the candidate. `sources: ["env"]` is stated as well as
// implied: a config file is committable and a command line is readable through
// `ps(1)`, so neither layer may carry this value, and `formatResolvedConfig`
// renders it `<redacted>` wherever the resolved table is printed.
export const GENERATE_OPTIONS = [
  ...COVERAGE_OPTIONS,
  {
    key: "kind",
    flag: "--kind",
    env: "TESSERA_KIND",
    type: "string",
    choices: TEST_KINDS,
    default: "unit",
    describe: `the single test kind to generate (${TEST_KINDS.join("|")})`,
  },
  {
    key: "provider",
    flag: "--provider",
    env: "TESSERA_PROVIDER",
    type: "string",
    choices: GENERATE_PROVIDERS,
    default: "template",
    describe: `generation backend (${GENERATE_PROVIDERS.join("|")}); \`template\` is offline and deterministic`,
  },
  {
    key: "model",
    flag: "--model",
    env: "TESSERA_MODEL",
    type: "string",
    default: ANTHROPIC_DEFAULT_MODEL_ID,
    describe: `model id for --provider anthropic (default \`${ANTHROPIC_DEFAULT_MODEL_ID}\`); recorded as provenance on every proposed spec`,
  },
  {
    key: "apiKey",
    // The flag is DECLARED but not accepted: `sources: ["env"]` keeps the flag
    // layer from supplying it, so `--api-key sk-...` is refused with exit 2
    // rather than dying as an unknown flag. An operator who reaches for the
    // obvious spelling should be told why it does not exist, and be told it
    // before the key is already in their shell history.
    flag: "--api-key",
    env: "TESSERA_ANTHROPIC_API_KEY",
    legacyEnv: "ANTHROPIC_API_KEY",
    type: "string",
    secret: true,
    sources: ["env"],
    describe:
      "API key for --provider anthropic — ENV ONLY, never a flag or a config file",
  },
  {
    key: "baseUrl",
    flag: "--base-url",
    env: "TESSERA_ANTHROPIC_BASE_URL",
    type: "string",
    default: ANTHROPIC_DEFAULT_BASE_URL,
    describe: `API base URL for --provider anthropic (default \`${ANTHROPIC_DEFAULT_BASE_URL}\`)`,
  },
  // THERE IS NO `--instruction` ROW, and that is a decision rather than an
  // omission. `AiTestGeneratorOptions.instruction` exists and is reachable from
  // the library, but it REPLACES the frozen instruction channel outright —
  // `buildGenerationPrompt`'s third parameter defaults to
  // `GENERATION_INSTRUCTION` rather than being concatenated with it — and its
  // own docstring reserves it for reproducing a past run, "not for per-run
  // prompt tuning, which would make `PinnedGenConfig.promptHash` describe a
  // prompt nobody can reconstruct". A flag taking an inline string is exactly
  // per-run prompt tuning: it would drop every safety clause in the frozen
  // instruction while the provenance written beside the specs still named the
  // pinned prompt version. An operator override belongs behind a spelling that
  // says "replace the prompt", and this surface has no such spelling yet.
  {
    key: "deadlineMs",
    flag: "--deadline-ms",
    env: "TESSERA_DEADLINE_MS",
    type: "number",
    min: 1_000,
    default: DEFAULT_GENERATION_DEADLINE_MS,
    describe: `wall-clock budget for one generation (default ${DEFAULT_GENERATION_DEADLINE_MS} ms); exceeding it is a fault, never an empty batch`,
  },
] as const satisfies readonly OptionSpec[];
