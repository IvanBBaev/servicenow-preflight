// `tess coverage` — DESIGN §4a's pre-run gap report, and PLAN's v0.3 increment
// (the Phase 4 READ side; the ATF projection writer is the other half and is
// blocked on an owner decision this command has no business pre-empting).
//
// `tess impact` answers what a change reaches. This answers the next question:
// of everything it reaches, what does the repo claim to test? It runs the same
// ARCH-5 composite and the same ImpactAnalyzer, reads the tests-as-code registry
// off disk, and joins the two.
//
// Five structural facts shape everything below.
//
//  * **It reports INTENT, and says so in every sentence it prints.** DESIGN §4a
//    splits the word: a spec that declares an artifact is somebody's plan, and
//    only a run is a statement about the code (QA-8). Confirmed coverage is
//    computed post-run by `computeCoverage` in `@tessera/core`, from a run this
//    command never performs. Nothing here may be worded — or counted — as though
//    it had. That is also why the command NEVER RETURNS 1: a gap in a plan is
//    not a verdict about the code, and turning one into a red CI job would put
//    exactly the misreading QA-8 forbids behind an exit code.
//
//  * **The join is DECLARED (QA-16).** `computeIntent` matches on the spec's
//    `targets` — table + sys_id — and never on its file path. This command adds
//    nothing to that: it hands over the inventory and prints the result.
//
//  * **The denominator is the impacted set INCLUDING what nobody could analyse
//    (QA-15).** `IntentReport.entries` is built from `graph.nodes ∪
//    graph.unanalyzable`, so the ratio printed below cannot improve by the
//    analysis getting worse. The `[unanalyzable]` mark keeps the two kinds of
//    row visibly different all the same — a spec'd artifact nobody could trace
//    and a spec'd artifact that was traced are not the same fact.
//
//  * **Two readers, two failure vocabularies, and both fail loudly.** The
//    instance can refuse (`ResolutionFaultError` → exit 3, DEV-1) and so can the
//    disk (`SpecStoreFaultError` → exit 3). A tests root that is not a directory
//    is the operator's mistake and exits 2. What neither may ever do is answer
//    "no specs": an unread registry and a repo with no tests are the pair that
//    must never render alike (OPP-1b/QA-9), which is why the disk read happens
//    BEFORE the first HTTP round trip — a wrong `--tests-root` is refused
//    without charging the operator for an impact analysis.
//
//  * **TM-1 holds, with less surface than `tess impact` had.** The analyzer
//    reads script bodies and hands back only identities, enum values and its own
//    notes; the inventory reader does not open a spec file at all. Not one line
//    below may grow into one that renders a script or an excerpt of one.

import path from "node:path";

import {
  ConfigError,
  formatResolvedConfig,
  resolveConfig,
} from "@tessera/config";
import {
  computeIntent,
  intentGaps,
  type ImpactNote,
  type ImpactReport,
  type IntentReport,
} from "@tessera/impact";
import {
  createCompositeResolver,
  createScopeResolver,
  createSnRecordReader,
  createStoryResolver,
  isIncomplete as resolutionIsIncomplete,
  ResolutionInputError,
  type ResolutionReport,
} from "@tessera/resolvers";
import {
  readSpecInventory,
  SpecInputError,
  type SpecInventory,
} from "@tessera/specs";
import type {
  PipelineContext,
  TargetArtifactRef,
  TargetInput,
  TestSpecRef,
} from "@tessera/types";

import type { CliContext } from "../context.js";
import { EXIT_CODES, type ExitCode } from "../exitCodes.js";
import { COVERAGE_OPTIONS } from "../options.js";
import { createCliImpactAnalyzer } from "../impactComposition.js";
import { bindRole, TopologyError } from "../topology.js";

/**
 * The exit-code contract, in one place because it IS the command.
 *
 *   0  the join is a clean answer and can be acted on. It may report gaps — a
 *      gap is information, not a failure, and never a 1 (see the header).
 *   2  the request was wrong: no source, no scope, a tests root that is not a
 *      readable directory, a story or scope the instance says does not exist.
 *   3  the instance never answered (`ResolutionFaultError`), or the spec
 *      registry exists and could not be read (`SpecStoreFaultError`). Both reach
 *      `cli.ts`. DEV-1: absence of evidence is a fault, never a finding.
 *   5  something could not be answered in full. `IntentReport.incomplete`
 *      already carries BOTH downstream halves — an incomplete graph and an
 *      incomplete inventory — so only the resolution's own has to be added.
 *
 * Every one of them counts, and they fail in opposite directions: an untraced
 * artifact understates the impacted set, an unread spec file understates intent.
 * A number produced over either is not a measurement, and the exit code is the
 * only channel a CI job reads.
 */
function exitCodeFor(
  resolution: ResolutionReport,
  intent: IntentReport,
): ExitCode {
  return resolutionIsIncomplete(resolution) || intent.incomplete
    ? EXIT_CODES.inconclusive
    : EXIT_CODES.ok;
}

/** Aligns the leading column so the labels are scannable down the page. */
function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

/** `<table>/<sys_id>` — the label is what a human recognises, this is what they can open. */
function address(ref: TargetArtifactRef): string {
  return `${ref.table}/${ref.sysId}`;
}

/** The three identity fields, and never a fourth: see the TM-1 note above. */
function refJson(ref: TargetArtifactRef): Record<string, string> {
  return { table: ref.table, sysId: ref.sysId, name: ref.name };
}

/**
 * The row marker. Uppercase for the gap on purpose: in a CI log the only thing a
 * reader can grep for is the word, and the gap set is what the whole report is
 * for — it is the work-list generation would have to fill.
 */
const GAP_LABEL = "GAP";
const SPEC_LABEL = "spec";
const MARK_WIDTH = Math.max(GAP_LABEL.length, SPEC_LABEL.length);

/** Printed against an artifact the analyzer could not trace — QA-15's other half. */
const UNANALYZABLE_MARK = "  [unanalyzable]";

/**
 * `TestSpecRef` carries identity only — id and repo path (§6a) — so the kind
 * comes back from the inventory the ref was read out of. It is worth the lookup:
 * "this artifact has a `unit` spec" and "this artifact has a `ui` spec" are
 * different claims about what would actually be exercised.
 */
const UNKNOWN_KIND = "unknown";

export async function coverageCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const usage = (message: string): ExitCode => {
    context.stderr(`tess coverage: ${message}`);
    return EXIT_CODES.usage;
  };

  let resolved;
  try {
    resolved = resolveConfig({
      argv,
      env: context.env,
      cwd: context.cwd,
      options: COVERAGE_OPTIONS,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      context.stderr(`tess coverage: ${error.message}`);
      context.stderr("");
      context.stderr("Run `tess coverage --help` for usage.");
      return EXIT_CODES.usage;
    }
    throw error;
  }

  const values = resolved.values;
  const json = values.json === true;

  // Before any read: an answer about which layer chose the instance is worth
  // nothing once the read has already gone to the wrong one.
  if (!json) {
    context.stdout(formatResolvedConfig(resolved));
    context.stdout("");
  }

  const sourceValue = values.source;
  if (typeof sourceValue !== "string" || sourceValue.trim() === "") {
    return usage(
      "no source instance — pass --source <profile> (or --instance <profile>, the ARCH-29 alias); coverage READS the source role (ARCH-19)",
    );
  }

  const scopeValue = values.scope;
  if (typeof scopeValue !== "string" || scopeValue.trim() === "") {
    return usage(
      "no scope — pass --scope <name|sys_id>; the impacted set this report divides by comes from the same single-scope analysis as `tess impact` (DESIGN §12.3 row 3)",
    );
  }

  const testsRootValue = values.testsRoot;
  if (typeof testsRootValue !== "string" || testsRootValue.trim() === "") {
    return usage(
      "no tests root — pass --tests-root <dir>; there is no honest empty default, because a root that was never read and a repo with no specs would report the same zero (OPP-1b)",
    );
  }
  // Against the INJECTED cwd, not `process.cwd()`. `@tessera/specs` resolves a
  // relative root against the process's own directory, which is the one thing
  // this composition root knows better: `context.cwd` is what the config layers
  // were discovered from, so a relative `--tests-root` has to mean the same
  // place `tessera.config.json` did.
  const testsRoot = path.resolve(context.cwd, testsRootValue);

  // Read the disk first. It is the cheap half, and refusing a wrong path here
  // costs the operator nothing; discovering it after a full where-used search
  // would cost them the whole analysis.
  let inventory: SpecInventory;
  try {
    inventory = await readSpecInventory({ root: testsRoot });
  } catch (error) {
    // The path is wrong, absent, or not a directory — the operator edits the
    // command line. A registry that IS there and would not be read is a
    // `SpecStoreFaultError` and is deliberately NOT caught: `cli.ts` renders it
    // as INFRASTRUCTURE FAULT (DEV-1) and exits 3, which is the one distinction
    // that keeps an unread manifest from being reported as an empty repo.
    if (error instanceof SpecInputError) {
      return usage(`${error.message} (--tests-root ${testsRootValue})`);
    }
    throw error;
  }

  let binding;
  try {
    binding = bindRole("source", sourceValue);
  } catch (error) {
    if (error instanceof TopologyError) return usage(error.message);
    throw error;
  }

  // The wiring from here to `analyzeWithReport` is `tess impact`'s, duplicated
  // for the reason that file gives: what the two share is one profile binding
  // and one composite, what differs is the strings inside it, and a helper would
  // be these lines with the differences hoisted into parameters.
  const reader = createSnRecordReader(binding.profile);
  const artifactTables = values.artifactTables ?? [];
  const updateSetStoryField = values.updateSetStoryField;

  const resolver = createCompositeResolver([
    createStoryResolver(reader, {
      ...(updateSetStoryField === undefined ? {} : { updateSetStoryField }),
    }),
    createScopeResolver(reader, {
      ...(artifactTables.length === 0 ? {} : { artifactTables }),
    }),
  ]);

  const ctx: PipelineContext = {
    runId: `coverage-${context.now().toISOString()}`,
    // Nothing is projected onto the instance, so nothing survives the command.
    lifecycle: "ephemeral",
    // "intent", not "coverage". §4a reserves the second word for a fact a run
    // produced, and this context never reaches one; labelling it "coverage"
    // would put the misreading into the pipeline's own vocabulary.
    coverageSource: "intent",
    topology: {
      source: binding.profile,
      runner: binding.profile,
      target: binding.profile,
    },
    signal: new AbortController().signal,
  };

  const input: TargetInput = {
    ...(typeof values.story === "string" && values.story.trim() !== ""
      ? { story: values.story }
      : {}),
    scope: scopeValue,
  };

  let resolution: ResolutionReport;
  try {
    resolution = await resolver.resolveWithReport(ctx, input);
  } catch (error) {
    if (error instanceof ResolutionInputError) return usage(error.message);
    throw error;
  }

  // Business Rules are traced too — see `../impactComposition.ts`.
  const analyzer = createCliImpactAnalyzer(reader, { scope: scopeValue });

  let report: ImpactReport;
  try {
    report = await analyzer.analyzeWithReport(ctx, [...resolution.artifacts]);
  } catch (error) {
    if (error instanceof ResolutionInputError) return usage(error.message);
    throw error;
  }

  // The join itself: one pure function, no clock, no disk, no instance. Passing
  // `inventoryIncomplete` is not optional bookkeeping — an inventory that read
  // nothing and a repo with no specs both arrive here as an empty array, and
  // this flag is the only thing that tells them apart.
  const intent = computeIntent(report, inventory.specs, {
    inventoryIncomplete: inventory.incomplete,
  });
  const gaps = intentGaps(intent);
  const untraced = intent.entries.filter((entry) => !entry.analyzable).length;

  const kindOf = new Map(
    inventory.specs.map((spec) => [spec.ref.id, spec.kind]),
  );
  const kindLabel = (ref: TestSpecRef): string =>
    kindOf.get(ref.id) ?? UNKNOWN_KIND;

  // Four speakers, one stream. "The scope could not be enumerated", "a consumer
  // table refused the read", "a spec file is registered but missing" and "3 of 4
  // artifacts have no spec" send an operator to four different places, so each
  // line says which one wrote it.
  //
  // `IntentReport.notes` is the graph's notes verbatim followed by the join's
  // own (its contract), so the prefix length is where one ends and the other
  // begins — the graph's are attributed here from `report` directly.
  const intentNotes = intent.notes.slice(report.notes.length);
  const notes: readonly {
    readonly level: string;
    readonly source: string;
    readonly message: string;
  }[] = [
    ...resolution.notes.map((note) => ({
      level: note.level,
      source: note.source,
      message: note.message,
    })),
    ...report.notes.map((note: ImpactNote) => ({
      level: note.level,
      source: "impact",
      message: note.message,
    })),
    ...inventory.notes.map((note) => ({
      level: note.level,
      source: "specs",
      message: note.message,
    })),
    ...intentNotes.map((note: ImpactNote) => ({
      level: note.level,
      source: "intent",
      message: note.message,
    })),
  ];

  const incomplete = resolutionIsIncomplete(resolution) || intent.incomplete;

  if (json) {
    // One document, one write. A consumer piping stdout into a parser must not
    // have to reassemble it, and a second `stdout` call is how that breaks.
    context.stdout(
      JSON.stringify(
        {
          source: { profile: binding.profile, host: binding.ref.host },
          input,
          testsRoot,
          entries: intent.entries.map((entry) => ({
            artifact: refJson(entry.artifact),
            analyzable: entry.analyzable,
            specs: entry.specs.map((ref) => ({
              id: ref.id,
              path: ref.path,
              kind: kindLabel(ref),
            })),
          })),
          // Redundant with `entries` on purpose, and it is the field with the
          // most callers ahead of it: this is the generation work-list, and a
          // consumer should not have to re-derive it by filtering on an empty
          // array to get it right.
          gaps: gaps.map(refJson),
          notes,
          incomplete,
          // QA-8, carried into the machine document. The header above sets the
          // rule for this whole file — "Nothing here may be worded **or
          // counted** as though it had [performed a run]" — and the human
          // branch keeps it in its closing line ("DECLARED INTENT only; a spec
          // that exists is not a spec that passed"). Without this field the
          // `--json` branch broke that rule at exactly the boundary where it
          // matters most: a consumer parsing `counts.withSpec` and `gaps` has
          // no prose to read and would take them for measured coverage.
          //
          // A field rather than a `notes` entry, because `notes` are per-run
          // events a consumer may reasonably drop, and this is a property of
          // EVERY document this command can emit. A constant rather than a
          // computed value, because the command performs no run and has no
          // branch that could make it anything else — if a future edit gives
          // it one, this must become computed, and that edit is a QA-8 change
          // that needs review rather than a mechanical follow-on.
          basis: "declared-intent",
          counts: {
            impacted: intent.entries.length,
            withSpec: intent.entries.length - gaps.length,
            gaps: gaps.length,
            unanalyzable: untraced,
            // Every spec the tests root registered, whether or not this change
            // touches what it targets — the denominator for "is the repo's
            // suite tiny, or is this change simply narrow?"
            specsInRoot: inventory.specs.length,
          },
        },
        null,
        2,
      ),
    );
    return exitCodeFor(resolution, intent);
  }

  context.stdout(`source: ${binding.profile} <${binding.ref.host}>`);
  context.stdout(
    `tests root: ${testsRoot} (${inventory.specs.length} spec(s) registered)`,
  );
  context.stdout("");

  if (intent.entries.length === 0) {
    // Said in words. "No artifact" and "the list is further up your screen" look
    // identical when the answer is an empty section over a silent 0.
    context.stdout(
      "impacted artifacts: none — this analysis named no artifact, so there is nothing here for a spec to declare",
    );
  } else {
    const kindWidth = Math.max(
      0,
      ...intent.entries.flatMap((entry) =>
        entry.specs.map((ref) => kindLabel(ref).length),
      ),
    );
    context.stdout(
      `impacted artifacts (${intent.entries.length}, ${gaps.length} with no spec):`,
    );
    for (const entry of intent.entries) {
      const mark = entry.specs.length === 0 ? GAP_LABEL : SPEC_LABEL;
      context.stdout(
        `  ${pad(mark, MARK_WIDTH)}  ${address(entry.artifact)}  ${entry.artifact.name}${entry.analyzable ? "" : UNANALYZABLE_MARK}`,
      );
      // Indented under the artifact they declare, because the row above is the
      // subject: the question is "what does this artifact have", not "where do
      // the specs point".
      for (const ref of entry.specs) {
        context.stdout(
          `      ${pad(kindLabel(ref), kindWidth)}  ${ref.id}  ${ref.path}`,
        );
      }
    }
  }

  if (notes.length > 0) {
    context.stdout("");
    context.stdout("notes:");
    for (const note of notes) {
      // Warnings are marked in the line itself, not by position or colour: in a
      // CI log the only thing a reader can grep for is the word.
      const mark = note.level === "warning" ? "WARNING" : "info";
      context.stdout(`  [${mark}] ${note.source}: ${note.message}`);
    }
  }

  context.stdout("");
  context.stdout(
    incomplete
      ? `INCOMPLETE — ${gaps.length} of ${intent.entries.length} impacted artifact(s) have no spec declaring them, but at least one stage could not answer in full; an unread spec overstates the gaps and an untraced artifact understates the set, so this ratio is not a measurement (QA-9)`
      : `${gaps.length} of ${intent.entries.length} impacted artifact(s) in scope ${scopeValue} on ${binding.profile} have no spec declaring them — DECLARED INTENT only; a spec that exists is not a spec that passed, and confirmed coverage is computed after a run (QA-8)`,
  );

  return exitCodeFor(resolution, intent);
}
