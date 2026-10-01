// `tess impact` — ARCH-15's "what does it touch?" made inspectable, and PLAN's
// v0.2 increment (DESIGN §12.3 row 3, USER-JOURNEY §6).
//
// `tess resolve` answers what changed. This answers what that change REACHES:
// it resolves the same change set through the same ARCH-5 composite, hands the
// artifacts to the ImpactAnalyzer, and prints the graph — nodes, the
// confidence-carrying edges, the `unanalyzable` list, and the notes that
// explain both. Nothing is gated on it, which is the point at this phase: the
// blast radius has to be lookable-at before a checklist is built on top of it.
//
// Four structural facts shape everything below.
//
//  * **It binds one role and it is a read.** Stories, artifacts and script
//    bodies all live on the ARCH-19 source, and `createSnRecordReader` is
//    GET-only and bound to a single profile at construction. There is no
//    writer, no ledger and no guard here, so ARCH-8's single-writer rule has
//    nothing to protect — pointing this at production is safe by construction.
//
//  * **`--scope` is required.** DESIGN §12.3 row 3 confines the MVP to one
//    scope and `ImpactAnalyzerOptions.scope` is not optional. The flag is doing
//    two jobs at once: it is an ARCH-5 resolver input (so naming it widens the
//    change set to the scope's contents — the "test everything in scope X"
//    reading of the vision, unchanged from `tess resolve`), and it is the wall
//    the where-used search runs inside.
//
//  * **It never returns 1.** `noGo` is a verdict about a change, and impact
//    analysis renders no verdict — it answers "what does this reach", or it
//    fails to. `exitCodeFor` below is the whole mapping, and the absence of the
//    fifth code is deliberate: a 1 out of this command is a bug.
//
//  * **TM-1 holds at the print boundary.** The analyzer reads script bodies,
//    which the threat model classifies as attacker-authored; it hands back only
//    names, tables, sys_ids, line-free enum values and its own notes, and NOT
//    ONE excerpt of a body. That is what makes it safe to print its notes
//    verbatim, and it is a property to preserve rather than a coincidence: no
//    line below may grow into one that renders a script, an excerpt of one, or
//    a message assembled out of either.

import {
  ConfigError,
  formatResolvedConfig,
  resolveConfig,
} from "@tessera/config";
import {
  isIncomplete as impactIsIncomplete,
  type ImpactNote,
  type ImpactReport,
} from "@tessera/impact";
import {
  artifactKey,
  createCompositeResolver,
  createScopeResolver,
  createSnRecordReader,
  createStoryResolver,
  isIncomplete as resolutionIsIncomplete,
  ResolutionInputError,
  type ResolutionReport,
} from "@tessera/resolvers";
import type {
  PipelineContext,
  ResolverSource,
  TargetArtifactRef,
  TargetInput,
} from "@tessera/types";

import type { CliContext } from "../context.js";
import { EXIT_CODES, type ExitCode } from "../exitCodes.js";
import { IMPACT_OPTIONS } from "../options.js";
import { createCliImpactAnalyzer } from "../impactComposition.js";
import { bindRole, TopologyError } from "../topology.js";

/**
 * The exit-code contract, in one place because it IS the command.
 *
 *   0  the graph is a clean answer and can be acted on (it may be empty — a
 *      scope whose scripts genuinely mention nothing is a real answer)
 *   2  the request was wrong: no source, no scope, a story or scope the
 *      instance says does not exist. The user edits the command line.
 *   3  the instance never answered (`ResolutionFaultError` → `cli.ts`). DEV-1:
 *      absence of evidence is a fault, never a finding. NOT handled here.
 *   5  something could not be answered in full — an `unanalyzable` artifact, a
 *      consumer table that refused the read, a resolution that came back
 *      partial. QA-9: an absent edge under a hole in the analysis is not
 *      evidence that nothing uses the artifact, so it may not exit 0.
 *
 * Both halves count. A graph analysed cleanly over an artifact list that was
 * itself incomplete is a complete answer to the wrong question, and the exit
 * code is the only channel a CI job reads.
 */
function exitCodeFor(
  resolution: ResolutionReport,
  impact: ImpactReport,
): ExitCode {
  return resolutionIsIncomplete(resolution) || impactIsIncomplete(impact)
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
 * The node label column: which ARCH-5 source resolved this artifact, or
 * `consumer` for a row the graph reached through an edge rather than through
 * the change set.
 *
 * The distinction is worth a column because the two are acted on differently —
 * a resolved artifact is something somebody changed, a consumer is something
 * that change might break — and `ImpactGraph.nodes` deliberately does not carry
 * it (the pipeline joins on identity, not on provenance).
 */
const CONSUMER_LABEL = "consumer";

export async function impactCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const usage = (message: string): ExitCode => {
    context.stderr(`tess impact: ${message}`);
    return EXIT_CODES.usage;
  };

  let resolved;
  try {
    resolved = resolveConfig({
      argv,
      env: context.env,
      cwd: context.cwd,
      options: IMPACT_OPTIONS,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      context.stderr(`tess impact: ${error.message}`);
      context.stderr("");
      context.stderr("Run `tess impact --help` for usage.");
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
      "no source instance — pass --source <profile> (or --instance <profile>, the ARCH-29 alias); impact READS the source role (ARCH-19)",
    );
  }

  // Refused before the source is even bound, so the operator who forgot it pays
  // no round trip for the reminder. `resolve` can answer a bare `--story`;
  // this command cannot, because the analyzer has no unbounded mode to fall
  // back to and inventing one here would be a different, far more expensive
  // operation wearing the same name.
  const scopeValue = values.scope;
  if (typeof scopeValue !== "string" || scopeValue.trim() === "") {
    return usage(
      "no scope — pass --scope <name|sys_id>; the MVP impact analysis is confined to a single application scope (DESIGN §12.3 row 3), so there is no instance-wide where-used search to fall back on",
    );
  }

  let binding;
  try {
    binding = bindRole("source", sourceValue);
  } catch (error) {
    if (error instanceof TopologyError) return usage(error.message);
    throw error;
  }

  // The wiring from here to `resolveWithReport` is `tess resolve`'s, duplicated
  // rather than extracted into a shared helper. What the two commands share is
  // one profile binding and one composite; what differs is the strings inside
  // it — the usage prefix, the run id, the coverage source — so the helper
  // would be these same lines with the differences hoisted into parameters, and
  // it would put `tess resolve`'s exit-code contract behind an indirection on
  // the day its second caller appeared. The reuse that matters is of the
  // adapters below, which are the same objects reading the same instance: there
  // is no second path to ServiceNow here, only a second caller of the first.
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
    runId: `impact-${context.now().toISOString()}`,
    // Nothing is projected onto the instance, so nothing survives the command.
    lifecycle: "ephemeral",
    // Names the stage that produced this artifact list. Labelling it
    // "preflight" would attribute the graph to a gate that never ran.
    coverageSource: "impact",
    // One profile in all three slots because that is literally true: the
    // command binds the source and contacts nothing else.
    topology: {
      source: binding.profile,
      runner: binding.profile,
      target: binding.profile,
    },
    signal: new AbortController().signal,
  };

  // `updateSet` is absent from the table, so it cannot be absent-but-blank
  // here; `scope` is guaranteed non-blank by the refusal above. Only `story`
  // has to be omitted rather than emptied — `story: ""` is a request that names
  // nothing while looking to the composite like a request that names something.
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
    // The request is wrong — a story or a scope the instance says is absent.
    // Caught here rather than left to `cli.ts`, which would render it as an
    // infrastructure fault and exit 3.
    if (error instanceof ResolutionInputError) return usage(error.message);
    // ResolutionFaultError is deliberately NOT caught: `cli.ts` already renders
    // INFRASTRUCTURE FAULT (DEV-1), no evidence produced, exit 3. Catching it
    // here would cost the one distinction the code carries — between a question
    // answered badly and one not answered at all.
    throw error;
  }

  // Business Rules are traced too — see `../impactComposition.ts`.
  const analyzer = createCliImpactAnalyzer(reader, { scope: scopeValue });

  let report: ImpactReport;
  try {
    // Copied out of the readonly report: the port takes a mutable array, and
    // handing it the resolution's own would let a later stage sort the list the
    // notes above already describe.
    report = await analyzer.analyzeWithReport(ctx, [...resolution.artifacts]);
  } catch (error) {
    // `findScopeIdentity` is the analyzer's one direct read, and it raises the
    // same two errors for the same two reasons. Same split, same rationale.
    if (error instanceof ResolutionInputError) return usage(error.message);
    throw error;
  }

  const graph = report.graph;
  const incomplete =
    resolutionIsIncomplete(resolution) || impactIsIncomplete(report);

  // Attributed nodes: which source resolved each one, `consumer` for the rest.
  const resolvedBy = new Map<string, ResolverSource>();
  for (const artifact of resolution.artifacts) {
    resolvedBy.set(artifactKey(artifact.ref), artifact.resolvedBy);
  }
  const originOf = (ref: TargetArtifactRef): ResolverSource | undefined =>
    resolvedBy.get(artifactKey(ref));

  // One stream, two speakers. The resolution's notes are attributed to the
  // ARCH-5 adapter that wrote them and the analysis's to `impact`, because
  // "the scope could not be enumerated" and "a consumer table refused the read"
  // send an operator to two different places.
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
  ];

  if (json) {
    // One document, one write. A consumer piping stdout into a parser must not
    // have to reassemble it, and a second `stdout` call is how that breaks.
    context.stdout(
      JSON.stringify(
        {
          source: { profile: binding.profile, host: binding.ref.host },
          input,
          nodes: graph.nodes.map((ref) => ({
            ...refJson(ref),
            // `null`, not an absent key: a consumer testing `resolvedBy ===
            // null` is asking a question with an answer, and a missing key
            // reads the same as a field this version forgot to emit.
            resolvedBy: originOf(ref) ?? null,
          })),
          edges: graph.edges.map((edge) => ({
            from: refJson(edge.from),
            to: refJson(edge.to),
            via: edge.via,
            confidence: edge.confidence,
          })),
          unanalyzable: graph.unanalyzable.map((entry) => ({
            artifact: refJson(entry.artifact),
            reason: entry.reason,
          })),
          demanded: graph.demanded.map((planned) => ({
            id: planned.spec.id,
            path: planned.spec.path,
            kind: planned.kind,
            target: refJson(planned.target),
          })),
          notes,
          incomplete,
          counts: {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            unanalyzable: graph.unanalyzable.length,
            demanded: graph.demanded.length,
          },
        },
        null,
        2,
      ),
    );
    return exitCodeFor(resolution, report);
  }

  context.stdout(`source: ${binding.profile} <${binding.ref.host}>`);
  context.stdout("");

  if (graph.nodes.length === 0) {
    // Said in words. "No artifact" and "the list is further up your screen"
    // look identical when the answer is an empty section over a silent 0.
    context.stdout("nodes: none — this analysis named no artifact");
  } else {
    const labels = graph.nodes.map((ref) => originOf(ref) ?? CONSUMER_LABEL);
    const width = Math.max(...labels.map((label) => label.length));
    context.stdout(`nodes (${graph.nodes.length}):`);
    graph.nodes.forEach((ref, index) => {
      context.stdout(
        `  ${pad(labels[index] ?? CONSUMER_LABEL, width)}  ${address(ref)}  ${ref.name}`,
      );
    });
  }

  context.stdout("");
  if (graph.edges.length === 0) {
    // Stated as what was searched rather than as what is true: whether "no
    // script mentions it" means "nothing uses it" is exactly what the
    // `unanalyzable` list below and the exit code decide.
    context.stdout(
      `edges: none — no script searched in scope ${scopeValue} mentioned a resolved artifact`,
    );
  } else {
    const width = Math.max(
      ...graph.edges.map((edge) => edge.confidence.length),
    );
    context.stdout(`edges (${graph.edges.length}):`);
    for (const edge of graph.edges) {
      // Confidence leads because it is the qualifier the whole edge hangs on: a
      // `low` edge is a name found in a comment, and reading it as a call is
      // the misreading this column exists to prevent.
      context.stdout(
        `  ${pad(edge.confidence, width)}  ${edge.from.name} -> ${address(edge.to)}  ${edge.to.name}  (via ${edge.via})`,
      );
    }
  }

  if (graph.unanalyzable.length > 0) {
    context.stdout("");
    context.stdout(`unanalyzable (${graph.unanalyzable.length}):`);
    for (const entry of graph.unanalyzable) {
      context.stdout(`  ${address(entry.artifact)}  ${entry.artifact.name}`);
      // The reason on its own line: it is a sentence, and folding it onto the
      // identity line would push the identity off the left of a CI log.
      context.stdout(`    ${entry.reason}`);
    }
  }

  if (graph.demanded.length > 0) {
    context.stdout("");
    const width = Math.max(
      ...graph.demanded.map((planned) => planned.kind.length),
    );
    context.stdout(`specs demanded (${graph.demanded.length}):`);
    for (const planned of graph.demanded) {
      context.stdout(`  ${pad(planned.kind, width)}  ${planned.spec.path}`);
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
      ? `INCOMPLETE — ${graph.edges.length} edge(s) over ${graph.nodes.length} artifact(s), but at least one stage could not answer in full; an absent edge is not evidence that nothing uses an artifact, so this graph is not the answer (QA-9)`
      : `analyzed ${graph.nodes.length} artifact(s) in scope ${scopeValue} on ${binding.profile}: ${graph.edges.length} where-used edge(s)`,
  );

  return exitCodeFor(resolution, report);
}
