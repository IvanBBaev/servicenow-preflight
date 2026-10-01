// @tessera/types — shared run/pipeline data shapes (DESIGN §6).
// Pure data; nothing in this package performs I/O.

import type { EvidenceRef, RawOutcome, TargetArtifactRef } from "./verdict.js";

/**
 * Correlates every event, projected record, and verdict of one run (ARCH-16).
 * Concurrent runs on a shared reporter must be distinguishable.
 */
export type RunId = string;

export const TEST_KINDS = ["unit", "e2e", "ui"] as const;
export type TestKind = (typeof TEST_KINDS)[number];

/** Repo path + manifest identity — what was planned (§6a). */
export interface TestSpecRef {
  /** Stable manifest identity of the spec. */
  id: string;
  /** Repo-relative path of the spec file. */
  path: string;
}

/**
 * Captured failure artifact (QA-11): screenshots, traces, ATF result links,
 * logs in the run-id-keyed artifact directory. Deliberately NOT the artifact
 * under test — that is `TargetArtifactRef` (§6a).
 */
export interface ArtifactRef {
  kind: "screenshot" | "trace" | "log" | "atf-result" | "file";
  ref: string;
}

/**
 * A generated/authored test. QA-16: carries `targets` — the declared
 * spec↔artifact link that coverage joins on (never file paths).
 * `payload` is the runner-specific spec body; its concrete shape is each
 * runner adapter's contract (Phase 1+).
 */
export interface TestSpec {
  ref: TestSpecRef;
  kind: TestKind;
  targets: readonly TargetArtifactRef[];
  payload?: unknown;
}

/**
 * A planned checklist entry: the spec plus the row identity the verdict
 * checklist requires. §6a writes `planned: readonly TestSpecRef[]`; Phase 0
 * widens each entry with `kind`/`target` because a `ChecklistRow` must render
 * even for `raw: "missing"`, where no result exists to supply them.
 */
export interface PlannedSpec {
  spec: TestSpecRef;
  kind: TestKind;
  target: TargetArtifactRef;
}

/** One attributed outcome for one spec, produced by a runner adapter (DEV-6). */
export interface SpecOutcome {
  spec: TestSpecRef;
  raw: RawOutcome;
  evidence?: EvidenceRef;
}

/** Parsed runner outcomes for one run, attribution done. */
export interface RunResult {
  runId: RunId;
  outcomes: readonly SpecOutcome[];
}

// ARCH-16: every event carries runId — concurrent runs on a shared reporter
// must be distinguishable. QA-11: failures reference captured artifacts.
// ARCH-24: core emits a terminal `end` after run() resolves — file reporters
// (JUnit/JSON) and artifact finalization need a run boundary.
export type TestEvent =
  | { kind: "start"; runId: RunId; spec: TestSpecRef }
  | { kind: "pass"; runId: RunId; spec: TestSpecRef }
  | {
      kind: "fail";
      runId: RunId;
      spec: TestSpecRef;
      assertion: string;
      artifacts?: ArtifactRef[];
    }
  | {
      // Infra/adapter fault — not evidence about the test itself (DEV-1).
      kind: "error";
      runId: RunId;
      spec?: TestSpecRef;
      cause: string;
      artifacts?: ArtifactRef[];
    }
  | { kind: "log"; runId: RunId; message: string }
  | { kind: "end"; runId: RunId; result: RunResult }; // emitted by core, not the runner (ARCH-24)

/** §2a roles a run (and its verdict) binds — not transferable to another pair. */
export interface PipelineTopology {
  source: string;
  runner: string;
  target: string;
}

/** §4a: whether projected ATF records are torn down after results are read. */
export type Lifecycle = "ephemeral" | "persistent";

/**
 * §4a in full — the three modes the `--lifecycle` flag accepts. `repo-only` is
 * deliberately NOT part of `Lifecycle`: that union answers "are the projected
 * records torn down?", and a `repo-only` run projects nothing to have an answer
 * about. It short-circuits `planned → done` without a single ledger entry (§4b),
 * so only the run RECORD ever carries it — never a `PipelineContext`.
 */
export type RunLifecycle = Lifecycle | "repo-only";

/**
 * ARCH-26: projection result — the EPHEMERAL result-attribution key
 * (ARCH-27/DEV-16/QA-13); the manifest serves persistent mode only.
 * Keyed by the canonical spec key (`specKey` in @tessera/core).
 */
export interface ProjectedRecord {
  testSysId: string;
  suiteSysId: string;
  runId: RunId;
}
export type ProjectionMap = Readonly<Record<string, ProjectedRecord>>;

/**
 * ARCH-23: the cycle-2 context fields must actually FLOW — every stage port
 * takes ctx first; without it a runner cannot even construct a valid
 * TestEvent. `signal` carries cancellation (ARCH-28).
 */
export interface PipelineContext {
  runId: RunId;
  lifecycle: Lifecycle;
  /**
   * Where confirmed-coverage evidence comes from (QA-8/QA-20). Phase-0
   * placeholder — the closed union is fixed when the coverage joiner lands
   * (Phase 6).
   */
  coverageSource: string;
  topology: PipelineTopology;
  signal: AbortSignal;
  /** Present from the projection stage onward (ARCH-26). */
  projection?: ProjectionMap;
}

/** Resolver input: story / linked update sets / scope, tried in order (ARCH-5). */
export interface TargetInput {
  story?: string;
  updateSet?: string;
  scope?: string;
}

export type ResolverSource = "story" | "update-set" | "scope";

/**
 * ARCH-5: composite resolution unions results de-duplicated by sys_id; order
 * sets reporting precedence, not first-wins — `resolvedBy` keeps the winning
 * source visible.
 */
export interface AffectedArtifact {
  ref: TargetArtifactRef;
  resolvedBy: ResolverSource;
}

export type ImpactConfidence = "high" | "medium" | "low";

export interface ImpactEdge {
  from: TargetArtifactRef;
  to: TargetArtifactRef;
  /** What produced the edge: where_used, table_logic, trace_table_event, … */
  via: string;
  confidence: ImpactConfidence;
}

/** QA-9 honesty: an artifact static analysis could not trace. */
export interface UnanalyzableArtifact {
  artifact: TargetArtifactRef;
  reason: string;
}

export interface ImpactGraph {
  nodes: readonly TargetArtifactRef[];
  edges: readonly ImpactEdge[];
  /** Surfaced as explicit verdict warnings — never silent green (QA-9). */
  unanalyzable: readonly UnanalyzableArtifact[];
  /** The checklist the analysis demands; parity-checked against `planned` (ARCH-30). */
  demanded: readonly PlannedSpec[];
}

/**
 * QA-15 floor arithmetic: confirmed ÷ all impacted artifacts INCLUDING
 * `unanalyzable` ones (excluding them would drop exactly the artifacts the
 * floor exists for).
 */
export interface CoverageReport {
  confirmedArtifacts: number;
  impactedArtifacts: number;
}

/** ARCH-2/ARCH-13: what the Provisioner would write — a plan is inspectable data. */
export interface ProvisionAction {
  kind: "create" | "update";
  table: string;
  description: string;
}
export interface ProvisionPlan {
  actions: readonly ProvisionAction[];
}
