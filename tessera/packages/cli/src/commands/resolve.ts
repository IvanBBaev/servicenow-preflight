// `tess resolve` — ARCH-5's "what changed?" made inspectable (PLAN Phase 2).
//
// The composite resolver already exists as a pipeline stage; this command is
// the operator's window onto it. Its whole value is that the answer can be
// looked at BEFORE a gate is built on top of it: a checklist assembled from the
// wrong scope produces a perfectly green run over artifacts nobody meant to
// test, and that failure is invisible unless somebody can print the list.
//
// Two structural facts follow from that and shape everything below.
//
//  * **It binds one role and it is a read.** ARCH-19 puts stories and artifacts
//    on the source, and `createSnRecordReader` is GET-only and bound to a
//    single profile at construction, so there is no writer, no ledger and no
//    guard here — ARCH-8's single-writer rule has nothing to protect when
//    nothing in reach can write. That is also why pointing this at production
//    is safe by construction rather than by promise.
//
//  * **It never returns 1.** `noGo` is a verdict about a change, and resolution
//    renders no verdict — it answers "which artifacts", or it fails to. The
//    four codes it does use are the mapping in `exitCodeFor` below, and the
//    absence of the fifth is the point: a caller that sees 1 out of `tess
//    resolve` has found a bug, not a rejection.

import {
  ConfigError,
  formatResolvedConfig,
  resolveConfig,
} from "@tessera/config";
import {
  createCompositeResolver,
  createScopeResolver,
  createSnRecordReader,
  createStoryResolver,
  isIncomplete,
  ResolutionInputError,
  type ResolutionReport,
} from "@tessera/resolvers";
import type { PipelineContext, TargetInput } from "@tessera/types";

import type { CliContext } from "../context.js";
import { EXIT_CODES, type ExitCode } from "../exitCodes.js";
import { RESOLVE_OPTIONS } from "../options.js";
import { bindRole, TopologyError } from "../topology.js";

/**
 * The exit-code contract, in one place because it IS the command.
 *
 *   0  the resolution is complete and can be acted on (the list may be empty —
 *      an empty list that every source agreed on is a real answer)
 *   2  the request was wrong: no source named, an unsupported input, a story or
 *      scope the instance says does not exist. The user edits the command line.
 *   3  the instance never answered (`ResolutionFaultError` → `cli.ts`). DEV-1:
 *      absence of evidence is a fault, never a finding. NOT handled here — see
 *      the comment at the call site.
 *   5  the resolution came back INCOMPLETE — at least one `warning` note. QA-9:
 *      a partial list presented as a list is the silent green the design
 *      forbids, and it stays inconclusive even when artifacts were found, so a
 *      CI job cannot key off "the array is non-empty".
 *
 * 1 (`noGo`) is deliberately unreachable; see the module header.
 */
function exitCodeFor(report: ResolutionReport): ExitCode {
  return isIncomplete(report) ? EXIT_CODES.inconclusive : EXIT_CODES.ok;
}

/** Aligns the `resolvedBy` column so the sources are scannable down the page. */
function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

export async function resolveCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const usage = (message: string): ExitCode => {
    context.stderr(`tess resolve: ${message}`);
    return EXIT_CODES.usage;
  };

  let resolved;
  try {
    resolved = resolveConfig({
      argv,
      env: context.env,
      cwd: context.cwd,
      options: RESOLVE_OPTIONS,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      context.stderr(`tess resolve: ${error.message}`);
      context.stderr("");
      context.stderr("Run `tess resolve --help` for usage.");
      return EXIT_CODES.usage;
    }
    throw error;
  }

  const values = resolved.values;
  const json = values.json === true;

  // Before any read, like the doctor's: when the resolution names a surprising
  // instance the operator's first question is which layer chose it, and an
  // answer printed after the read has already happened is an answer about a
  // read that already went to the wrong place.
  if (!json) {
    context.stdout(formatResolvedConfig(resolved));
    context.stdout("");
  }

  // `collapseInstanceAlias` has already folded `--instance` onto `source` by
  // now — this table declares the alias, so the two arrive as one value. Both
  // spellings are named in the refusal anyway: the operator who forgot the flag
  // does not know which of them this command prefers.
  const sourceValue = values.source;
  if (typeof sourceValue !== "string" || sourceValue.trim() === "") {
    return usage(
      "no source instance — pass --source <profile> (or --instance <profile>, the ARCH-29 alias); resolution READS the source role (ARCH-19)",
    );
  }

  let binding;
  try {
    binding = bindRole("source", sourceValue);
  } catch (error) {
    if (error instanceof TopologyError) return usage(error.message);
    throw error;
  }

  const reader = createSnRecordReader(binding.profile);
  const artifactTables = values.artifactTables ?? [];
  const updateSetStoryField = values.updateSetStoryField;

  // ARCH-5 order, and it is not cosmetic: the composite unions everything but
  // the FIRST adapter to claim an artifact owns its `resolvedBy` label. Story
  // leads because "this row is in the story's update set" is the more specific
  // statement — an artifact that is both in the story and in the scope was
  // deliberately changed, and reporting it as a scope member would hide that.
  const resolver = createCompositeResolver([
    createStoryResolver(reader, {
      ...(updateSetStoryField === undefined ? {} : { updateSetStoryField }),
    }),
    createScopeResolver(reader, {
      // Only when the flag (or its env/file layer) actually produced a list.
      // An empty array is a configured "look at no tables at all", which the
      // scope adapter correctly reports as a warning — passing one by accident
      // would turn every run inconclusive.
      ...(artifactTables.length === 0 ? {} : { artifactTables }),
    }),
  ]);

  const ctx: PipelineContext = {
    // Stamped once from the injected clock, so the whole command belongs to one
    // run even though nothing here persists it yet.
    runId: `resolve-${context.now().toISOString()}`,
    // Nothing is projected onto the instance, so nothing survives the command;
    // `ephemeral` is the honest half of §4a rather than a placeholder.
    lifecycle: "ephemeral",
    // `coverageSource` is still a bare string (the closed union lands with the
    // Phase-6 coverage joiner). "resolve" names the stage that produced the
    // artifact list — labelling it "preflight" would attribute this list to a
    // gate that never ran.
    coverageSource: "resolve",
    // One profile in all three slots because that is literally true here: the
    // command binds the source and contacts nothing else, so naming a different
    // runner or target would describe a topology this run does not have.
    topology: {
      source: binding.profile,
      runner: binding.profile,
      target: binding.profile,
    },
    // No cancellation surface yet; the field is required, and a never-aborted
    // signal is the accurate value rather than a cast.
    signal: new AbortController().signal,
  };

  // Optional keys are OMITTED, never set to "". The composite decides what to
  // refuse by asking whether the input NAMES a story or a scope, and `story:
  // ""` is a request that names nothing while looking like a request that does.
  const input: TargetInput = {
    ...(typeof values.story === "string" && values.story.trim() !== ""
      ? { story: values.story }
      : {}),
    ...(typeof values.scope === "string" && values.scope.trim() !== ""
      ? { scope: values.scope }
      : {}),
    ...(typeof values.updateSet === "string" && values.updateSet.trim() !== ""
      ? { updateSet: values.updateSet }
      : {}),
  };

  let report: ResolutionReport;
  try {
    report = await resolver.resolveWithReport(ctx, input);
  } catch (error) {
    // ResolutionInputError is the instance or the composite saying the REQUEST
    // is wrong — an unsupported `--update-set`, neither input given, a scope no
    // row matches. That is usage (2), and it is caught here rather than left to
    // `cli.ts`, which would render it as an infrastructure fault and exit 3.
    if (error instanceof ResolutionInputError) return usage(error.message);
    // ResolutionFaultError is deliberately NOT caught. It means the instance
    // never answered, and `cli.ts` already renders exactly that: INFRASTRUCTURE
    // FAULT (DEV-1), no evidence produced, exit 3. Catching it here to print
    // something friendlier would cost the one distinction the code carries —
    // between a question that was answered badly and one that was not answered.
    throw error;
  }

  const artifacts = report.artifacts;
  const incomplete = isIncomplete(report);

  if (json) {
    // One document, one write. A consumer piping stdout into a parser must not
    // have to reassemble it, and a second `stdout` call is how that breaks.
    context.stdout(
      JSON.stringify(
        {
          source: { profile: binding.profile, host: binding.ref.host },
          input,
          artifacts: artifacts.map((artifact) => ({
            table: artifact.ref.table,
            sysId: artifact.ref.sysId,
            name: artifact.ref.name,
            resolvedBy: artifact.resolvedBy,
          })),
          notes: report.notes,
          incomplete,
          count: artifacts.length,
        },
        null,
        2,
      ),
    );
    return exitCodeFor(report);
  }

  context.stdout(`source: ${binding.profile} <${binding.ref.host}>`);
  context.stdout("");

  if (artifacts.length === 0) {
    // Said in words, never as an empty section above a silent 0. "no artifacts"
    // and "the list is somewhere else on your screen" look identical otherwise,
    // and the notes below carry the reason either way.
    context.stdout("artifacts: none — this resolution named no artifact");
  } else {
    const width = Math.max(
      ...artifacts.map((artifact) => artifact.resolvedBy.length),
    );
    context.stdout(`artifacts (${artifacts.length}):`);
    for (const artifact of artifacts) {
      context.stdout(
        `  ${pad(artifact.resolvedBy, width)}  ${artifact.ref.table}/${artifact.ref.sysId}  ${artifact.ref.name}`,
      );
    }
  }

  if (report.notes.length > 0) {
    context.stdout("");
    context.stdout("notes:");
    for (const note of report.notes) {
      // Warnings are marked in the line itself, not by position or colour: this
      // text ends up in a CI log where the only thing a reader can grep for is
      // the word.
      const mark = note.level === "warning" ? "WARNING" : "info";
      context.stdout(`  [${mark}] ${note.source}: ${note.message}`);
    }
  }

  context.stdout("");
  context.stdout(
    incomplete
      ? `INCOMPLETE — ${artifacts.length} artifact(s) named, but at least one source could not answer in full; this list is not the answer (QA-9)`
      : `resolved ${artifacts.length} artifact(s) from ${binding.profile}`,
  );

  return exitCodeFor(report);
}
