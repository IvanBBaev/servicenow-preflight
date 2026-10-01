// ARCH-5's composite — the adapter whose only job is to run the others.
//
// One sentence decides everything in this file: "composite resolution unions
// results de-duplicated by sys_id; order sets reporting precedence, not
// first-wins — `resolvedBy` keeps the winning source visible." First-wins would
// mean the first adapter to answer ends the resolution; precedence means every
// adapter runs, every artifact any of them found is in the union, and order
// decides one thing only — which `resolvedBy` label a duplicated row carries
// into the report. Read it the other way and `--story S --scope A` silently
// tests three files out of the scope's forty, which is a green gate over
// artifacts nobody looked at.
//
// The composite is deliberately not a `SourceResolver`: it has no `resolvedBy`
// label of its own to hand out, because inventing one ("composite") would erase
// the only thing the de-duplication tie has to report.

import type {
  AffectedArtifact,
  PipelineContext,
  TargetInput,
} from "@tessera/types";

import { ResolutionInputError } from "./errors.js";
import { artifactKey } from "./keys.js";
import { completeArtifacts } from "./types.js";
import type {
  ExplainingResolver,
  ResolutionNote,
  ResolutionReport,
  SourceResolver,
} from "./types.js";

/** Named in every refusal, so the fix is in the message and not in the docs. */
const SUPPORTED_INPUTS = "--story <number|sys_id> and/or --scope <scope>";

/**
 * A flag the shell expanded to nothing (`--scope "$EMPTY"`) named nothing, and
 * treating it as a subject would send an adapter looking for the empty string.
 */
function names(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "";
}

function label(artifact: AffectedArtifact): string {
  return `${artifact.ref.table}/${artifact.ref.sysId} (${artifact.ref.name})`;
}

/**
 * Both refusals happen before a single adapter runs — a read that cannot
 * produce the answer the user asked for is not worth performing, and a partial
 * report printed under a rejected input is the failure mode this guards.
 */
function assertResolvableInput(input: TargetInput): void {
  if (names(input.updateSet)) {
    throw new ResolutionInputError(
      `--update-set is not supported: DESIGN §12.3 defers UpdateSetResolver past the MVP, and resolving the rest of the input while ignoring the update set would report a resolution the user never asked for. Supported inputs: ${SUPPORTED_INPUTS}.`,
    );
  }
  if (!names(input.story) && !names(input.scope)) {
    throw new ResolutionInputError(
      `nothing to resolve: the input names neither a story nor a scope, so an empty artifact list would be an artefact of the request, not a fact about the instance. Supported inputs: ${SUPPORTED_INPUTS}.`,
    );
  }
}

export function createCompositeResolver(
  resolvers: readonly SourceResolver[],
): ExplainingResolver {
  // The lead adapter doubles as the empty-list guard: a composite over no
  // adapters answers "no artifacts" to every question, in the same shape a
  // genuine empty resolution has, so the wiring mistake would surface as a
  // green gate several stages later. It also owns the voice of the composite's
  // own notes below — `ResolutionNote.source` is a closed union of the three
  // ARCH-5 sources, and the highest-precedence adapter is the one whose answer
  // the report leads with.
  const lead = resolvers[0];
  if (lead === undefined) {
    throw new ResolutionInputError(
      "a composite resolver needs at least one source adapter; over an empty list it would answer 'no artifacts' to every input and look like a clean resolution",
    );
  }

  const resolveWithReport = async (
    ctx: PipelineContext,
    input: TargetInput,
  ): Promise<ResolutionReport> => {
    assertResolvableInput(input);

    const adapterNotes: ResolutionNote[] = [];
    const precedenceNotes: ResolutionNote[] = [];
    const merged: AffectedArtifact[] = [];
    const winners = new Map<string, AffectedArtifact>();

    // Sequential, in the given order, and not `Promise.all`. Nothing about the
    // merge requires it — the adapters share no state and MVP resolution is at
    // most two reads — but a serial walk makes the note list byte-identical
    // between runs, which is what lets a CI log be diffed. A cheap trade for
    // determinism, not a correctness requirement: if resolution ever fans out
    // over enough sources for the latency to matter, run them in parallel and
    // re-order the notes by adapter index on the way out.
    for (const resolver of resolvers) {
      // No try/catch anywhere in this loop, deliberately. The CLI routes
      // ResolutionInputError (the argument is wrong), ResolutionFaultError (the
      // instance never answered — DEV-1, never a verdict) and an ordinary bug
      // to three different exits; a composite that caught one and folded it
      // into a warning note would hand back something that reads as a
      // resolution when it is an absence of evidence, and would also let the
      // remaining adapters run against a subject nobody could read.
      const report = await resolver.resolveWithReport(ctx, input);
      // Kept whole and kept attributed: each note still names the adapter that
      // wrote it, because "scope could not read sys_script" and "story could
      // not read sys_script" send the operator to two different places.
      adapterNotes.push(...report.notes);

      for (const artifact of report.artifacts) {
        const key = artifactKey(artifact.ref);
        const winner = winners.get(key);
        if (winner === undefined) {
          winners.set(key, artifact);
          merged.push(artifact);
          continue;
        }
        // The duplicate loses the row but does not vanish. Whoever reads the
        // report has to be able to see that two sources agreed on this
        // artifact, otherwise the single `resolvedBy` label reads as the only
        // source that ever mentioned it.
        precedenceNotes.push({
          source: resolver.source,
          level: "info",
          message: `${label(winner)} was also resolved by ${resolver.source}; reported as ${winner.resolvedBy} (ARCH-5 precedence)`,
        });
      }
    }

    const notes = [...adapterNotes, ...precedenceNotes];

    // QA-9: an empty list with nothing said about it is the silent green the
    // design forbids — it looks the same whether the scope is genuinely clean
    // or every read came back unusable. A report that already carries a
    // warning has explained itself (`isIncomplete` is true and the warning says
    // why), so the note goes on the quiet case only.
    // Delegated decision 2026-09-26 (M3): that note is a WARNING, not info. An
    // empty answer from the Table API cannot be told apart from rows an ACL
    // hid (OPP-1b), so an empty union is never a complete answer a run can
    // pass on. Reachable only through an adapter that returns empty without
    // warning — the story and scope adapters now warn on every empty result.
    if (
      merged.length === 0 &&
      !notes.some((note) => note.level === "warning")
    ) {
      notes.push({
        source: lead.source,
        level: "warning",
        message:
          "resolution completed and matched no artifacts — every source answered, and none of them named one",
      });
    }

    return { artifacts: merged, notes };
  };

  return {
    resolveWithReport,
    async resolve(ctx: PipelineContext, input: TargetInput) {
      const report = await resolveWithReport(ctx, input);
      // The `Resolver` port hands back a mutable array; copying keeps a caller
      // that sorts it in place out of the report it came from. An incomplete
      // report throws instead: the port has no notes channel (H1, see
      // `completeArtifacts`).
      return completeArtifacts(report, "composite");
    },
  };
}
