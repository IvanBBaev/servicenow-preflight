// Pipeline stage ports (DESIGN §6). Core owns these interfaces plus the
// composition root; adapters implement them. ctx (PipelineContext) flows FIRST
// through every stage port (ARCH-23).

import type {
  AffectedArtifact,
  ImpactGraph,
  PipelineContext,
  ProjectionMap,
  ProvisionPlan,
  RunResult,
  RunId,
  TargetInput,
  TestEvent,
  TestKind,
  TestSpec,
} from "@tessera/types";

/** One line a resolver says about how complete its answer is. */
export interface ResolverNote {
  /** `warning` = the answer is known to be partial (QA-9); `info` = context. */
  level: "info" | "warning";
  message: string;
}

/**
 * A resolution together with what the resolver knows about its completeness.
 *
 * Delegated decision 2026-09-26: declared structurally here rather than
 * imported, because core cannot depend on @tessera/resolvers (the arrow runs
 * the other way). Its `ResolutionReport` is assignable to this shape, and the
 * completeness rule is the same one: ANY `warning` note means incomplete.
 */
export interface ResolverReport {
  artifacts: readonly AffectedArtifact[];
  notes: readonly ResolverNote[];
}

/** True iff the report admits it is partial — any `warning` note (QA-9). */
export function isResolverReportIncomplete(report: ResolverReport): boolean {
  return report.notes.some((note) => note.level === "warning");
}

/** What changed? story / update set / scope → affected artifacts (ARCH-5). */
export interface Resolver {
  resolve(
    ctx: PipelineContext,
    input: TargetInput,
  ): Promise<AffectedArtifact[]>;
  /**
   * Optional: the same resolution with its completeness notes. When present,
   * `runPipeline` calls this INSTEAD of `resolve()`, so a partial resolution
   * can narrow the verdict (a GO over it becomes INCONCLUSIVE) rather than be
   * lost in a bare artifact list.
   *
   * Delegated decision 2026-09-26: optional, so every existing Resolver (the
   * phase-0.5 stubs, test doubles) still satisfies the port unchanged.
   */
  resolveWithReport?(
    ctx: PipelineContext,
    input: TargetInput,
  ): Promise<ResolverReport>;
}

/** What does it touch? Static analysis over artifact relationships (QA-9). */
export interface ImpactAnalyzer {
  analyze(
    ctx: PipelineContext,
    artifacts: AffectedArtifact[],
  ): Promise<ImpactGraph>;
  /**
   * Optional: the same graph with the analyzer's completeness notes. When
   * present, `runPipeline` calls this INSTEAD of `analyze()`, so an impact
   * graph that could not be fully traced narrows the verdict (a GO over it
   * becomes INCONCLUSIVE) and its warnings reach the verdict.
   *
   * Delegated decision 2026-09-26: optional, so every existing analyzer (the
   * no-op skeleton analyzer, phase-0.5 stubs, test doubles) still satisfies
   * the port unchanged.
   */
  analyzeWithReport?(
    ctx: PipelineContext,
    artifacts: AffectedArtifact[],
  ): Promise<ImpactAnalysisReport>;
}

/** One line an impact analyzer says about how complete its graph is. */
export interface ImpactAnalysisNote {
  /** `warning` = the graph is known to be partial (QA-9); `info` = context. */
  level: "info" | "warning";
  message: string;
}

/**
 * An impact graph together with what the analyzer knows about its
 * completeness.
 *
 * Delegated decision 2026-09-26: declared structurally here rather than
 * imported, because core cannot depend on @tessera/impact (the arrow runs the
 * other way). Its `ImpactReport` is assignable to this shape.
 */
export interface ImpactAnalysisReport {
  graph: ImpactGraph;
  notes: readonly ImpactAnalysisNote[];
}

/**
 * True iff the graph is known to be partial: it carries at least one
 * unanalyzable artifact (the structured flag, QA-9).
 *
 * Delegated decision 2026-09-26: fail-closed on the graph itself, not only
 * on a report — a graph supplied by the caller or returned by a bare
 * `analyze()` carries the same `unanalyzable` list, so it gates the same way.
 */
export function isImpactGraphIncomplete(graph: ImpactGraph): boolean {
  return graph.unanalyzable.length > 0;
}

/**
 * True iff the report admits it is partial: an unanalyzable artifact in its
 * graph, or any `warning` note (the same completeness rule as
 * `isResolverReportIncomplete`).
 */
export function isImpactReportIncomplete(
  report: ImpactAnalysisReport,
): boolean {
  return (
    isImpactGraphIncomplete(report.graph) ||
    report.notes.some((note) => note.level === "warning")
  );
}

/** What should be tested? Impact graph → test specs of one kind. */
export interface TestGenerator {
  generate(
    ctx: PipelineContext,
    graph: ImpactGraph,
    kind: TestKind,
  ): Promise<TestSpec[]>;
}

/**
 * Where do specs live on-instance? Projection is the EPHEMERAL
 * result-attribution key (ARCH-26); teardown per §4a lifecycle. ARCH-28:
 * teardown never deletes records before their run reaches a terminal state —
 * an aborted run marks records `abandoned` instead.
 */
export interface TestStore {
  project(
    ctx: PipelineContext,
    specs: readonly TestSpec[],
  ): Promise<ProjectionMap>;
  teardown(ctx: PipelineContext): Promise<void>;
}

/**
 * Executes specs it supports. DEV-1: run() RESOLVES with a RunResult for test
 * outcomes (fail/error rows are data, not exceptions) and REJECTS only on
 * infrastructure faults where no outcome evidence exists. Cancellation flows
 * via ctx.signal (ARCH-28).
 */
export interface Runner {
  readonly kinds: readonly TestKind[];
  supports(spec: TestSpec): boolean;
  run(
    ctx: PipelineContext,
    specs: readonly TestSpec[],
    emit: (event: TestEvent) => void,
  ): Promise<RunResult>;
}

/**
 * Consumes the event stream. close() is the ARCH-24 flush boundary — core
 * emits the terminal "end" event, then closes every reporter.
 */
export interface Reporter {
  onEvent(event: TestEvent): void;
  close(runId: RunId): Promise<void>;
}

/**
 * Prepares the runner instance. Plan/apply split (ARCH-2/ARCH-13): plan() is
 * read-only and inspectable; apply() is the ONLY writing stage and takes ctx
 * (ARCH-40) so writes journal and honour cancellation.
 */
export interface Provisioner {
  plan(ctx: PipelineContext): Promise<ProvisionPlan>;
  apply(ctx: PipelineContext, plan: ProvisionPlan): Promise<void>;
}
