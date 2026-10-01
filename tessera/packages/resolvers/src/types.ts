// The resolution vocabulary (ARCH-5, PLAN Phase 2).
//
// `Resolver.resolve` returns an array and nothing else, which is fine for the
// pipeline — the next stage only needs the artifacts — but it cannot carry the
// one thing QA-9 insists on: the difference between "this scope contains no
// script includes" and "I could not see whether it does". Collapse those and an
// empty array reads as a clean answer, which is exactly the silent green the
// design forbids.
//
// So every adapter here implements the port AND a wider method that returns the
// artifacts together with the notes that explain them. `resolve()` is the thin
// one: it delegates and drops the notes, because the pipeline has no channel
// for them yet. `tess resolve` calls the wider one and prints both.

import type {
  AffectedArtifact,
  PipelineContext,
  ResolverSource,
  TargetInput,
} from "@tessera/types";

import { ResolutionFaultError } from "./errors.js";
import type { Resolver } from "@tessera/core";

/**
 * `warning` means the resolution is INCOMPLETE — something was asked about and
 * did not answer, so the artifact list may be missing rows nobody can name.
 * `info` is a fact about a complete resolution (how many rows a source
 * contributed, which ones lost a de-duplication tie).
 */
export type ResolutionLevel = "info" | "warning";

export interface ResolutionNote {
  /** Which adapter is speaking — the composite keeps this when it merges. */
  readonly source: ResolverSource;
  readonly level: ResolutionLevel;
  /** Written for a human reading a CI log, not a log line for a machine. */
  readonly message: string;
}

export interface ResolutionReport {
  readonly artifacts: readonly AffectedArtifact[];
  /**
   * Never dropped, never summarised away. A report with at least one `warning`
   * is not a green answer even when `artifacts` is non-empty.
   */
  readonly notes: readonly ResolutionNote[];
}

/** A `Resolver` that can also say why its answer looks the way it does. */
export interface ExplainingResolver extends Resolver {
  resolveWithReport(
    ctx: PipelineContext,
    input: TargetInput,
  ): Promise<ResolutionReport>;
}

/**
 * One of ARCH-5's three named sources. The composite is deliberately NOT one:
 * it has no `resolvedBy` label of its own, because every artifact it returns
 * keeps the label of the adapter that found it.
 */
export interface SourceResolver extends ExplainingResolver {
  /** The `resolvedBy` label every artifact from this adapter carries. */
  readonly source: ResolverSource;
}

/** True iff the report contains something that makes it incomplete. */
export function isIncomplete(report: ResolutionReport): boolean {
  return report.notes.some((note) => note.level === "warning");
}

/**
 * What the narrow `Resolver.resolve` port hands back: the report's artifacts as
 * a fresh mutable array — or a throw when the report is incomplete.
 *
 * Delegated decision 2026-09-26 (H1, defence in depth): the port has no notes
 * channel, so returning the artifacts of an incomplete report would drop the
 * one fact that makes them untrustworthy and let a caller treat a partial
 * list as the whole answer. It throws ResolutionFaultError (DEV-1: an absence
 * of evidence) naming the warnings instead. A caller that can carry notes
 * uses `resolveWithReport`, which the core pipeline now prefers.
 */
export function completeArtifacts(
  report: ResolutionReport,
  what: string,
): AffectedArtifact[] {
  if (isIncomplete(report)) {
    const warnings = report.notes
      .filter((note) => note.level === "warning")
      .map((note) => `[${note.source}] ${note.message}`)
      .join("; ");
    throw new ResolutionFaultError(
      `${what} resolution is incomplete, and resolve() has no channel to say ` +
        `so — call resolveWithReport() to receive the partial list with its ` +
        `notes: ${warnings}`,
    );
  }
  return [...report.artifacts];
}
