// The run loop (DESIGN §4b + §6/§6a) — the orchestration Phase 0 deferred.
//
// Everything this module does is a consequence of four pinned rules:
//
//  * ARCH-19 stage ordering — resolve → impact → generate are READS on the
//    source; provision → project → run are WRITES on the runner. Nothing here
//    ever writes to source or target.
//  * §4b run state machine — `planned → provisioning → projecting → running →
//    collecting → tearing-down → done`, with `failed`/`abandoned` terminals.
//    Every edge is persisted through the ledger, which refuses any edge the
//    §4b table does not list; the TRIGGERS are proven here.
//  * §4b write-ahead protocol — guard first, then a durable `intend`, then the
//    write, then `confirm`. Nothing is written before its intent is on disk.
//  * ARCH-24 flush boundary — core (never the runner) emits the terminal `end`
//    event and then closes every reporter. DEV-13 pins that this happens
//    BEFORE a single record is deleted.
//
// No module-level singletons and no `process.env`: the ledger, the guard and
// every port are injected. The clock is injectable but not injected — it
// defaults to `new Date()`, the one wall-clock read in this file.

import type {
  AffectedArtifact,
  CoverageReport,
  ImpactGraph,
  Lifecycle,
  OverrideRecord,
  PipelineContext,
  PipelineTopology,
  PlannedSpec,
  PreflightVerdict,
  ProjectionMap,
  RawOutcome,
  RunId,
  RunResult,
  SpecOutcome,
  TargetArtifactRef,
  TargetInput,
  TestEvent,
  TestKind,
  TestSpec,
} from "@tessera/types";
import type { Classification, TargetGuard, WriteIntent } from "@tessera/guard";
import type {
  CompensationOp,
  IntendInput,
  IntentLedger,
  LedgerWriteRecord,
  ProbeDescriptor,
  RunState,
} from "@tessera/ledger";
import { specKey } from "./canonical.js";
import type { GateEvaluator } from "./gateEvaluator.js";
import type {
  ImpactAnalyzer,
  Provisioner,
  Reporter,
  Resolver,
  Runner,
  TestGenerator,
  TestStore,
} from "./ports.js";
import {
  isImpactGraphIncomplete,
  isImpactReportIncomplete,
  isResolverReportIncomplete,
} from "./ports.js";

/** §6a default ConfirmToken lifetime (~60 min). */
const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * Record shapes core has to NAME in order to journal a write an adapter
 * performs on its behalf.
 *
 * SEAM (Phase 1, ARCH-3): once the journalled sn-client exists, the mutation
 * channel intends per HTTP write and knows the real tables; core stops
 * guessing. Until then they are options with ATF defaults.
 */
const DEFAULT_PROJECTION_TABLE = "sys_atf_test";
const DEFAULT_RUN_TRIGGER_TABLE = "sys_atf_test_suite_run";

const DEFAULT_KINDS: readonly TestKind[] = ["unit"];

/**
 * Which part of the loop produced a failure — carried on the report.
 *
 * `compose` doubles as the fallback for a throw raised BETWEEN stages that no
 * other member names — a ledger or guard fault around a §4b transition on the
 * read half, before `provision`. Such a failure is reported as `compose`
 * without the composition root having been involved. A REFUSED terminal edge
 * is NOT one of those: it is driven from a known position and carries it —
 * `run` for the `abandoned` edge, `teardown` for every edge around the
 * teardown pass.
 */
export type RunStage =
  | "compose"
  | "resolve"
  | "impact"
  | "generate"
  | "plan"
  | "provision"
  | "project"
  | "run"
  | "collect"
  | "teardown";

/**
 * Ports the run loop drives. Structurally a superset-compatible relaxation of
 * `PipelinePorts`: `impactAnalyzer`/`generator` are OPTIONAL here because
 * PLAN Phase 0.5 skips those two stages (see `RunPipelineStages`), so a
 * `PipelinePorts` value can be passed straight in.
 */
export interface RunPipelinePorts {
  resolver: Resolver;
  impactAnalyzer?: ImpactAnalyzer;
  generator?: TestGenerator;
  store: TestStore;
  runners: readonly Runner[];
  reporters: readonly Reporter[];
  provisioner: Provisioner;
  gate: GateEvaluator;
}

export interface RunPipelineDeps {
  ports: RunPipelinePorts;
  /** §11 write-side control. */
  guard: TargetGuard;
  /**
   * The PINNED §11.1 classification of the RUNNER role — i.e. the object
   * `guard.classify(runnerRef, "runner")` returned. A hand-built one is
   * refused by the guard (`malformed-classification`), which is the point.
   */
  runner: Classification;
  /** §4b write-ahead intent ledger + run-state store. */
  ledger: IntentLedger;
  /**
   * Clock. Optional, and when it is omitted the loop reads the wall clock
   * (`new Date()`) — the ONE such read below, taken once, to stamp `now` on the
   * gate evaluation. Determinism is therefore a property of the caller, not of
   * this module.
   */
  now?: () => Date;
}

/**
 * SEAM (PLAN Phase 0.5 → Phase 1) — impact and generate are OPTIONAL stages,
 * not absent ones. The walking skeleton hardcodes both the change and its test,
 * so it composes `stages: { impact: false, generate: false }` and supplies
 * `specs` directly. Phase 1 flips them on and NOTHING else in this loop moves:
 * the ARCH-19 read half already calls both ports in order, and the reducer
 * already parity-checks `impact.demanded` against `planned` (ARCH-30).
 */
export interface RunPipelineStages {
  /** Default: run iff an `impactAnalyzer` port was composed. */
  impact?: boolean;
  /** Default: run iff a `generator` port was composed. */
  generate?: boolean;
}

export interface RunPipelineOptions {
  runId: RunId;
  /** §4b concurrency key, together with `topology.runner`. */
  scope: string;
  topology: PipelineTopology;
  /** §4a. `repo-only` never reaches the pipeline, so it is not accepted here. */
  lifecycle: Lifecycle;
  /** QA-8/QA-20 provenance label; defaults to the lifecycle mode. */
  coverageSource?: string;
  input: TargetInput;
  /** Authored/hardcoded specs. Generated specs are appended to these. */
  specs?: readonly TestSpec[];
  /** Kinds the generator is asked for when the generate stage runs. */
  kinds?: readonly TestKind[];
  stages?: RunPipelineStages;
  /** Used when the impact stage is skipped; otherwise the analyzer's graph wins. */
  impact?: ImpactGraph;
  /** Overrides the QA-8 minimal computation in `computeRunCoverage`. */
  coverage?: CoverageReport;
  /** QA-15 floor; 0 (default) disables it. */
  coverageFloor?: number;
  overrides?: readonly OverrideRecord[];
  tokenTtlMs?: number;
  /** ARCH-28 cancellation. */
  signal?: AbortSignal;
  /**
   * DEV-2 bounded polling. When the runner has not resolved by then the loop
   * stops waiting, self-writes `abandoned` and skips teardown (DEV-17).
   */
  runTimeoutMs?: number;
  /** §4b: refuse a second run on the same scope+runner. Default true. */
  refuseConcurrentRuns?: boolean;
  /** Diagnosis aid on the run record — not a liveness proof (§4b). */
  pid?: number;
  /** See `DEFAULT_PROJECTION_TABLE` / `DEFAULT_RUN_TRIGGER_TABLE`. */
  tables?: { projection?: string; runTrigger?: string };
  /**
   * The caller's spec inventory could not be fully read or projected (a
   * dropped manifest entry, an unprojected spec). `specs` then covers only
   * part of what the repo declares, and the reducer cannot see the rest: its
   * `missing` rows come from `impact.demanded`, so a dropped spec nothing
   * demanded leaves no trace. When true the verdict is never GO — see
   * `INVENTORY_INCOMPLETE_WARNING`. Default false.
   */
  inventoryIncomplete?: boolean;
}

/**
 * The verdict warning `runPipeline` adds when `inventoryIncomplete` is set.
 * Exported so a front-end can name the reason without re-wording it.
 */
export const INVENTORY_INCOMPLETE_WARNING =
  "spec inventory is incomplete: some declared specs were not read or not projected, so this verdict covers only the specs that were";

/** Suffix on the warning when it moved the status (GO → INCONCLUSIVE). */
const INVENTORY_DOWNGRADE_SUFFIX =
  " — a GO over a partial inventory is downgraded to INCONCLUSIVE";

/**
 * The verdict warning `runPipeline` adds when the resolver's own report
 * (`Resolver.resolveWithReport`) admits a partial answer — any `warning`
 * note. Distinct from `INVENTORY_INCOMPLETE_WARNING`: that one is about the
 * specs, this one about which artifacts changed. Exported for front-ends.
 */
export const RESOLUTION_INCOMPLETE_WARNING =
  "artifact resolution is incomplete: at least one source could not be fully read, so this verdict covers only the artifacts that were resolved";

/** Suffix on the resolution warning when it moved the status. */
const RESOLUTION_DOWNGRADE_SUFFIX =
  " — a GO over a partial resolution is downgraded to INCONCLUSIVE";

/** Prefix on each resolver warning note copied onto the verdict. */
const RESOLUTION_NOTE_PREFIX = "resolution: ";

/**
 * The verdict warning `runPipeline` adds when the impact graph is known to be
 * partial: it carries an unanalyzable artifact (the structured flag,
 * `ImpactGraph.unanalyzable`), or the analyzer's own report
 * (`ImpactAnalyzer.analyzeWithReport`) has a `warning` note. Distinct from the
 * resolution reason: that one is about which artifacts changed, this one
 * about what they touch. Exported for front-ends.
 */
export const IMPACT_INCOMPLETE_WARNING =
  "impact analysis is incomplete: at least one artifact could not be fully traced, so the selected tests may miss something the change affects";

/** Suffix on the impact warning when it moved the status. */
const IMPACT_DOWNGRADE_SUFFIX =
  " — a GO over a partial impact analysis is downgraded to INCONCLUSIVE";

/** Prefix on each impact-analyzer warning note copied onto the verdict. */
const IMPACT_NOTE_PREFIX = "impact: ";

/**
 * A verdict status the loop changed AFTER the gate evaluated it, and why.
 * Only one direction exists: GO → INCONCLUSIVE, over an incomplete inventory,
 * an incomplete artifact resolution and/or an incomplete impact analysis.
 */
export interface VerdictDowngrade {
  from: "GO";
  to: "INCONCLUSIVE";
  reason: string;
}

/** One reason the evidence behind a verdict is partial. */
interface EvidenceGap {
  /** Stated on every verdict the gap touches. */
  warning: string;
  /** Appended to `warning` when the gap moved a GO. */
  downgradeSuffix: string;
  /** Specific lines stated before `warning` (e.g. the resolver's notes). */
  details: readonly string[];
}

/**
 * Apply every evidence gap (incomplete inventory, incomplete resolution) to
 * the gate's verdict.
 *
 * Delegated decision 2026-09-26: a post-gate adjustment, not a reducer input.
 * The reducer is pure and golden-pinned, and the ladder it evaluates has no
 * rung for "the plan itself is partial" — adding one would move every golden
 * digest for a fact only the loop's caller knows. So the gate runs unchanged
 * and this function narrows its result, in one direction only.
 */
function applyEvidenceGaps(
  verdict: PreflightVerdict,
  gaps: readonly EvidenceGap[],
): { verdict: PreflightVerdict; downgrade?: VerdictDowngrade } {
  if (gaps.length === 0) return { verdict };
  // Delegated decision 2026-09-26: only GO moves. NO_GO outranks it (a
  // failing assertion is evidence; a partial inventory does not weaken it),
  // and INCONCLUSIVE already says "no green". A refusal is never a verdict
  // status here — a §11 refusal throws or rides on `failure`, and the CLI's
  // exit mapping ranks it above INCONCLUSIVE exactly as it ranked it above GO.
  if (verdict.status !== "GO") {
    // Delegated decision 2026-09-26: the reason is still stated on a
    // non-GO verdict — it is true of every verdict over this evidence.
    return {
      verdict: {
        ...verdict,
        warnings: [
          ...verdict.warnings,
          ...gaps.flatMap((gap) => [...gap.details, gap.warning]),
        ],
      },
    };
  }
  const suffixed = gaps.map((gap) => ({
    details: gap.details,
    reason: `${gap.warning}${gap.downgradeSuffix}`,
  }));
  const reasons = suffixed.map((gap) => gap.reason);
  // Delegated decision 2026-09-26: with two gaps the single `reason` names
  // both (joined with "; "); each suffixed warning is still its own entry of
  // `verdict.warnings`, the last gap's warning last.
  const reason = reasons.join("; ");
  // Delegated decision 2026-09-26: the ConfirmToken is dropped with the GO —
  // it exists iff status === "GO" (A-1), and a token minted over partial
  // evidence would let `tess confirm` promote what was never checked. Built
  // field by field so the token cannot ride along (PreflightVerdict forbids
  // it on INCONCLUSIVE) and key order stays the reducer's.
  const downgraded: PreflightVerdict = {
    status: "INCONCLUSIVE",
    runId: verdict.runId,
    topology: verdict.topology,
    rows: verdict.rows,
    counts: verdict.counts,
    overrides: verdict.overrides,
    warnings: [
      ...verdict.warnings,
      ...suffixed.flatMap((gap) => [...gap.details, gap.reason]),
    ],
  };
  return {
    verdict: downgraded,
    downgrade: { from: "GO", to: "INCONCLUSIVE", reason },
  };
}

export type TeardownDisposition =
  /** §4a ephemeral: the store deleted and every due compensation is confirmed. */
  | "completed"
  /** §4a persistent: test definitions survive, so nothing was due (DEV-20). */
  | "skipped-persistent"
  /** DEV-17/ARCH-28/ARCH-32: the instance run was not provably terminal. */
  | "skipped-non-terminal"
  /** The teardown pass itself failed; non-compensated entries remain. */
  | "failed"
  /**
   * `tearing-down` was never reached — either nothing was ever projected, so
   * nothing was due, or the §4b edge into it was refused. `failure` carries
   * the refusal and is what separates the two, unless an earlier, more
   * specific fault already claimed that slot — in which case `state` is the
   * non-terminal one the record was left in and says so on its own.
   */
  | "not-reached";

export interface RunPipelineFailure {
  stage: RunStage;
  message: string;
  cause: unknown;
}

/**
 * One event one reporter refused. A reporter fault never moves the verdict —
 * an output channel does not get to veto a verdict the gate legitimately
 * reached — but the row it dropped is missing from that reporter's artifact,
 * and a missing row is exactly what its consumer cannot notice.
 */
export interface ReporterEventFault {
  /**
   * Which reporter threw. The `Reporter` port carries no name, so this is its
   * position in `ports.reporters` — `reporters[1]` — widened with the
   * constructor name when a reporter is a class instance rather than the
   * object literal every shipped adapter returns. Weak, but positional
   * identity is checkable against the composition root; a guessed name is not.
   */
  reporter: string;
  /** The `kind` of the `TestEvent` that never landed. */
  event: string;
  /** The reporter's own message, as `describeError` renders it. */
  message: string;
}

export interface PipelineRunReport {
  runId: RunId;
  /**
   * The §4b state the run record was in when the loop let go of it. Terminal
   * unless an edge was refused; the report then carries a `failure` — the
   * refusal itself, unless an earlier fault already claimed that slot.
   */
  state: RunState;
  /**
   * Every state this loop observed on the record, in order, starting with the
   * one `openRun` resolved to — `planned` for a fresh run, a later state for a
   * retry that resolved to a run already in flight.
   */
  transitions: readonly RunState[];
  verdict: PreflightVerdict;
  /** The folded outcomes, identical to the payload of the `end` event. */
  result: RunResult;
  planned: readonly PlannedSpec[];
  impact: ImpactGraph;
  coverage: CoverageReport;
  projection?: ProjectionMap;
  teardown: TeardownDisposition;
  /** Present when a stage failed; the verdict is fail-closed either way. */
  failure?: RunPipelineFailure;
  /**
   * Events a reporter threw on, one entry per (reporter, event) pair, in the
   * order they were refused. Present only when there were any.
   *
   * Its OWN field rather than a candidate for `failure`: `failure` holds at
   * most one fault and every writer guards it with `failure === undefined`,
   * so a run that had both a real stage failure and a throwing reporter used
   * to report the reporter nowhere at all — a dropped diagnostic about a
   * dropped event. The two are independent facts and are carried
   * independently.
   */
  reporterEventFaults?: readonly ReporterEventFault[];
  /**
   * EVERY stage fault the loop recorded, in the order it recorded them.
   * Present only when there were any — so exactly when `failure` is.
   *
   * Delegated decision 2026-09-23, additive: `failure` keeps its one-slot
   * semantics (the earliest guarded fault, except that a run-stage infra
   * fault and a thrown stage claim it outright) and is always an element of
   * this list. What the one slot used to drop — a refused terminal edge
   * behind a throwing close(), a teardown fault behind a run fault — is no
   * longer dropped: it is carried here.
   */
  failures?: readonly RunPipelineFailure[];
  /**
   * Present iff the loop moved the gate's status afterwards — a GO over an
   * incomplete inventory (`RunPipelineOptions.inventoryIncomplete`), an
   * incomplete artifact resolution (a `Resolver.resolveWithReport` report
   * with a `warning` note) and/or an incomplete impact analysis (an
   * unanalyzable artifact in the graph, or an
   * `ImpactAnalyzer.analyzeWithReport` report with a `warning` note). With
   * one gap `reason` is also the last entry of `verdict.warnings`; with
   * several it joins the suffixed warnings in stage order.
   */
  verdictDowngrade?: VerdictDowngrade;
}

export interface RunCoverageInput {
  planned: readonly PlannedSpec[];
  results: readonly RunResult[];
  impact: ImpactGraph;
}

/**
 * §4b / DEV-17 / ARCH-35: the run id handed to `runPipeline` names a run that
 * already exists and is not fresh, so the loop refused to start it. Thrown
 * after `openRun` resolved to that record and before anything else happened:
 * no stage ran, no edge was driven, and the ledger was not written.
 *
 * Structural consumers match on `name` (the error may cross a package
 * boundary); the CLI maps it to exit 4, a refusal.
 */
export class RunResumeRefusedError extends Error {
  readonly runId: RunId;
  readonly state: RunState;

  constructor(runId: RunId, state: RunState, message: string) {
    super(message);
    this.name = "RunResumeRefusedError";
    this.runId = runId;
    this.state = state;
  }
}

/** One run holding the §4b concurrency key — see `RunConcurrencyRefusedError`. */
export interface RunConcurrencyConflict {
  readonly runId: RunId;
  readonly state: RunState;
  readonly updatedAt: string;
  readonly pendingCount: number;
}

/**
 * §4b Concurrency ("rejection, not queueing"): another non-terminal run
 * already holds this run's scope+runner key, so the loop refused to start.
 * Thrown before `openRun`: no run record was created, no stage ran, and the
 * ledger was not written.
 *
 * Delegated decision 2026-09-26: a named refusal rather than a plain Error,
 * which the CLI rendered as a DEV-1 INFRASTRUCTURE FAULT (exit 3). Structural
 * consumers match on `name`; the CLI maps it to exit 4 under its own
 * `REFUSED (§4b concurrency)` prefix, distinct from the §4b resume refusal and
 * from the §11 guard. `runId` is the REFUSED run; `conflicts` the holders.
 */
export class RunConcurrencyRefusedError extends Error {
  readonly runId: RunId;
  readonly scope: string;
  readonly runner: string;
  readonly conflicts: readonly RunConcurrencyConflict[];

  constructor(
    runId: RunId,
    scope: string,
    runner: string,
    conflicts: readonly RunConcurrencyConflict[],
  ) {
    const holders = conflicts
      .map(
        (c) =>
          `run "${c.runId}" is already in flight (state ${c.state}, ${c.pendingCount} pending write(s), updated ${c.updatedAt})`,
      )
      .join("; ");
    const [only] = conflicts;
    const cleanupId =
      conflicts.length === 1 && only !== undefined ? only.runId : "<id>";
    const pointers = conflicts
      .map((c) => `\`tess status --run-id ${c.runId}\``)
      .join(", ");
    super(
      `${holders} on scope "${scope}" / runner "${runner}", so run "${runId}" was not started. ` +
        `Nothing was run and the ledger was not touched — a second run on one scope+runner is ` +
        `rejected, never queued (§4b). Inspect it with ${pointers}; let its owner finish, ` +
        `or, once it is failed or abandoned, clear it with \`tess cleanup --run-id ${cleanupId}\``,
    );
    this.name = "RunConcurrencyRefusedError";
    this.runId = runId;
    this.scope = scope;
    this.runner = runner;
    this.conflicts = conflicts;
  }
}

class StageError extends Error {
  readonly stage: RunStage;

  constructor(stage: RunStage, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StageError";
    this.stage = stage;
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message === ""
      ? error.name
      : `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * A stable-enough identity for a reporter that faulted.
 *
 * The `Reporter` port declares `onEvent` and `close` and nothing else, and
 * every shipped adapter is a factory returning an object literal — so there is
 * no name to read, and adding a required `name` to a public port to get one
 * would be a breaking change made for a diagnostic. The position in
 * `ports.reporters` is what the composition root can be checked against; the
 * constructor name is appended only when it says something (a class instance),
 * never for the `Object` an object literal reports.
 */
function describeReporter(reporter: Reporter, index: number): string {
  const ctor: unknown = (reporter as { constructor?: unknown }).constructor;
  const name = typeof ctor === "function" ? ctor.name : "";
  return name === "" || name === "Object"
    ? `reporters[${index}]`
    : `reporters[${index}] (${name})`;
}

function artifactKey(ref: TargetArtifactRef): string {
  return `${ref.table}\u0000${ref.sysId}`;
}

/**
 * QA-8/QA-15 minimal coverage: an artifact counts as confirmed only when a
 * spec that DECLARES it as a target (QA-16) passed in THIS run; the
 * denominator includes `unanalyzable` artifacts, because excluding them would
 * drop exactly the artifacts the floor exists for.
 *
 * SEAM (Phase 6): QA-20's persistent-suite "stale pass" rule needs the
 * persistent manifest and a coverage joiner; until then persistent mode
 * measures the same way ephemeral does, which is the conservative direction.
 */
export function computeRunCoverage(input: RunCoverageInput): CoverageReport {
  const impacted = new Set<string>();
  for (const node of input.impact.nodes) {
    impacted.add(artifactKey(node));
  }
  for (const entry of input.impact.unanalyzable) {
    impacted.add(artifactKey(entry.artifact));
  }
  for (const entry of input.planned) {
    impacted.add(artifactKey(entry.target));
  }

  const observed = new Map<string, RawOutcome[]>();
  for (const result of input.results) {
    for (const outcome of result.outcomes) {
      const key = specKey(outcome.spec);
      const bucket = observed.get(key);
      if (bucket === undefined) observed.set(key, [outcome.raw]);
      else bucket.push(outcome.raw);
    }
  }

  const confirmed = new Set<string>();
  for (const entry of input.planned) {
    const raws = observed.get(specKey(entry.spec));
    if (raws === undefined || raws.length === 0) continue;
    if (raws.every((raw) => raw === "pass")) {
      confirmed.add(artifactKey(entry.target));
    }
  }

  return {
    confirmedArtifacts: confirmed.size,
    impactedArtifacts: impacted.size,
  };
}

/**
 * §6a rows are one-per-spec, so a spec must declare at least one target
 * (QA-16) — the first declared target is the row identity. A spec without one
 * cannot be coverage-joined and is a preflight failure, not a silent skip.
 */
function buildPlanned(
  specs: readonly TestSpec[],
  impact: ImpactGraph,
): PlannedSpec[] {
  const planned: PlannedSpec[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const target = spec.targets[0];
    if (target === undefined) {
      throw new StageError(
        "plan",
        `spec ${spec.ref.id} (${spec.ref.path}) declares no target artifact — QA-16 requires the spec↔artifact link coverage joins on`,
      );
    }
    const key = specKey(spec.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    planned.push({ spec: spec.ref, kind: spec.kind, target });
  }
  // ARCH-30: a spec the impact analysis DEMANDED but nothing produced still
  // belongs on the checklist — that is how it becomes a `missing` row (the
  // reducer synthesizes it; there is deliberately no second path here).
  for (const entry of impact.demanded) {
    const key = specKey(entry.spec);
    if (seen.has(key)) continue;
    seen.add(key);
    planned.push(entry);
  }
  return planned;
}

interface RunnerGroup {
  runner: Runner;
  specs: TestSpec[];
  index: number;
}

function groupByRunner(
  specs: readonly TestSpec[],
  runners: readonly Runner[],
): RunnerGroup[] {
  const groups: RunnerGroup[] = [];
  const byRunner = new Map<Runner, RunnerGroup>();
  for (const spec of specs) {
    const capable = runners.find(
      (candidate) =>
        candidate.kinds.includes(spec.kind) && candidate.supports(spec),
    );
    if (capable === undefined) {
      throw new StageError(
        "plan",
        `no registered runner supports spec ${spec.ref.id} of kind "${spec.kind}" — §6: a spec with no capable runner is a preflight failure, not a silent skip`,
      );
    }
    let group = byRunner.get(capable);
    if (group === undefined) {
      group = { runner: capable, specs: [], index: groups.length };
      byRunner.set(capable, group);
      groups.push(group);
    }
    group.specs.push(spec);
  }
  return groups;
}

/** Mirror an external signal onto the loop's own controller. */
function linkAbort(
  controller: AbortController,
  signal: AbortSignal | undefined,
): () => void {
  if (signal === undefined) {
    return () => undefined;
  }
  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => undefined;
  }
  const onAbort = (): void => {
    controller.abort(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

const INTERRUPTED = Symbol("tessera.run.interrupted");

/**
 * DEV-17 (wave 13) — how many suite executions the run's ledger records as
 * possibly triggered: its entries on `runTriggerTable`, in ANY state (an
 * `intended` entry is written before the trigger, so its execution may have
 * landed). The store's DEV-17 gate requires at least that many result rows.
 *
 * Delegated decision 2026-09-28 (wave 13): core counts these itself instead
 * of importing `countRecordedSuiteTriggers` from `@tessera/teststore-atf` —
 * core owns the ports and depends on no adapter, and the rule is the same
 * (every entry of this run on the configured trigger table). A ledger read
 * that fails, or returns an entry of another run (a ledger bug), yields
 * `null`, which a counting store refuses: never omitted, because an omitted
 * count silently falls back to the pre-wave-13 gate.
 */
async function recordedTriggerCount(
  ledger: IntentLedger,
  runId: RunId,
  runTriggerTable: string,
): Promise<number | null> {
  let entries: readonly LedgerWriteRecord[];
  try {
    entries = await ledger.entries(runId);
  } catch {
    return null;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.runId !== runId) return null;
    if (entry.target.table === runTriggerTable) count += 1;
  }
  return count;
}

/** See the F1 gate in `runPipeline`. Reads only; throws the refusal. */
async function assertFreshRun(
  ledger: IntentLedger,
  runId: RunId,
  state: RunState,
): Promise<void> {
  if (state === "planned") return;
  if (state === "provisioning") {
    if ((await ledger.entries(runId)).length === 0) return;
  }
  throw new RunResumeRefusedError(
    runId,
    state,
    `run "${runId}" already exists in state ${state}; a run id is started only ` +
      `while its record is fresh (planned, or provisioning with nothing journalled). ` +
      `Nothing was run and the ledger was not touched. A used run is re-entered only ` +
      `by \`tess cleanup --run-id ${runId}\` (DEV-17/ARCH-35) — inspect it first with ` +
      `\`tess status --run-id ${runId}\`, or start a new run under a new id (§4b)`,
  );
}

/**
 * The writes a `done` settle would silently abandon: every `intended` orphan,
 * and every `applied` write nothing compensated — except a persistent run's
 * non-compensations (`op: "none"`), which §4a/DEV-20 keeps on purpose.
 *
 * Delegated decision 2026-09-26 (F1 defence in depth): the persistent
 * exemption covers `intended` as well as `applied` `op: "none"` entries. No
 * teardown and no `tess cleanup` can settle such an entry any differently
 * (there is nothing to delete; adoption is the DEV-12 manifest's job), so
 * settling `failed` over one would prescribe a cleanup that can do nothing.
 * It also keeps the pinned DEV-20 behaviour: a persistent projection the
 * store refused before writing still lands on `done` (skeleton suite). The
 * gate exists for delete/restore-compensated work, and that is never exempt.
 */
function unsettledForDone(
  lifecycle: Lifecycle,
  teardownOrder: readonly LedgerWriteRecord[],
): LedgerWriteRecord[] {
  return teardownOrder.filter(
    (entry) =>
      !(lifecycle === "persistent" && entry.compensation.op === "none"),
  );
}

/**
 * Run one preflight pipeline end to end.
 *
 * Refusals that happen BEFORE the run record exists (a non-writable runner,
 * a conflicting in-flight run) throw: there is no run to reconcile and no
 * verdict to render. Every STAGE failure after `openRun` is folded into the
 * returned report instead of thrown, and the state machine is always driven to
 * a terminal state first.
 *
 * Not "nothing after `openRun` can throw": the two calls that RENDER the report
 * — the coverage fold and `gate.evaluate` — run after the state machine is done
 * with it, outside that guard, so a throwing gate port still rejects this
 * promise with a run record already terminal on disk.
 */
export async function runPipeline(
  deps: RunPipelineDeps,
  options: RunPipelineOptions,
): Promise<PipelineRunReport> {
  const { guard, ledger, ports } = deps;
  const clock = deps.now ?? ((): Date => new Date());
  const runId = options.runId;
  const lifecycle = options.lifecycle;
  const projectionTable =
    options.tables?.projection ?? DEFAULT_PROJECTION_TABLE;
  const runTriggerTable =
    options.tables?.runTrigger ?? DEFAULT_RUN_TRIGGER_TABLE;

  // §11.5 — the composition-time gate, evaluated BEFORE a single adapter is
  // touched and before the run record is opened. A prod/unknown/unacknowledged
  // runner therefore never produces a ledger entry, a projected record, or a
  // half-open run: GuardViolation simply propagates.
  guard.assertRunnerWritable(deps.runner);

  // §4b concurrency: a second run on the same scope+runner is refused until
  // the stale one is cleaned or abandoned. Checked before `openRun` so our own
  // fresh record cannot become the thing that blocks the next attempt.
  //
  // Delegated decision 2026-09-26: the conflict is a named refusal
  // (`RunConcurrencyRefusedError`, exit 4 in the CLI) that lists EVERY holder
  // with its state and points at `tess status`. A corrupt record anywhere
  // under the root makes `scan()` throw `LedgerError corrupt` naming every
  // offender; that stays a hard stop here (a fault, not a refusal) and is
  // deliberately not caught — nothing is quarantined or renamed.
  if (options.refuseConcurrentRuns !== false) {
    const conflicts = (await ledger.scan()).filter(
      (entry) =>
        entry.run.runId !== runId &&
        entry.run.scope === options.scope &&
        entry.run.runner === options.topology.runner,
    );
    if (conflicts.length > 0) {
      throw new RunConcurrencyRefusedError(
        runId,
        options.scope,
        options.topology.runner,
        conflicts.map((entry) => ({
          runId: entry.run.runId,
          state: entry.run.state,
          updatedAt: entry.run.updatedAt,
          pendingCount: entry.pendingCount,
        })),
      );
    }
  }

  // §4b: `openRun` is idempotent — an MCP host retry RESOLVES TO THE EXISTING
  // run record rather than creating a second one, and that record may already
  // be past `planned`. The returned record is therefore the only observation of
  // where this run starts; the loop reports it instead of assuming.
  const opened = await ledger.openRun({
    runId,
    scope: options.scope,
    runner: options.topology.runner,
    lifecycle,
    ...(options.pid === undefined ? {} : { pid: options.pid }),
  });

  // Delegated decision 2026-09-26 (F1, fail closed): only a FRESH record may
  // be driven. Before this gate a reused run id resolved to its old record,
  // the `provisioning` edge was refused as illegal, and the outer catch then
  // settled the run `done` with no teardown — leaving applied/intended writes
  // unsettled, hiding the run from `scan()`, and never probing an instance
  // run that may still be live. That bypassed DEV-17/ARCH-35: a failed or
  // abandoned run is re-entered only by cleanup, and a non-terminal one only
  // by its owner. Fresh means `planned`, or `provisioning` with NOTHING
  // journalled: the §13 retry test pins that resume, the provisioning stage
  // only verifies standing infra (ARCH-33) and writes nothing, and every
  // later intent is idempotency-keyed — so re-driving it cannot double a
  // write. A provisioning record that did journal a write is refused too.
  // The refusal is thrown like the concurrency conflict above and mutates
  // nothing; `openRun` itself does not write an existing record.
  await assertFreshRun(ledger, opened.runId, opened.state);

  const controller = new AbortController();
  const detach = linkAbort(controller, options.signal);
  let deadlineReached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options.runTimeoutMs !== undefined) {
    timer = setTimeout(() => {
      deadlineReached = true;
      controller.abort(
        new Error(
          `runner did not reach a terminal state within ${options.runTimeoutMs}ms (DEV-2 bounded polling)`,
        ),
      );
    }, options.runTimeoutMs);
    // A pending deadline must never hold the process open.
    timer.unref?.();
  }
  const interrupted: Promise<typeof INTERRUPTED> = new Promise((resolve) => {
    if (controller.signal.aborted) {
      resolve(INTERRUPTED);
      return;
    }
    controller.signal.addEventListener("abort", () => resolve(INTERRUPTED), {
      once: true,
    });
  });

  let ctx: PipelineContext = {
    runId,
    lifecycle,
    coverageSource: options.coverageSource ?? lifecycle,
    topology: options.topology,
    signal: controller.signal,
  };

  // Seeded from the record `openRun` returned, never from the literal
  // `"planned"`: a resumed run is already elsewhere, and a `transitions` list
  // that opens with `planned` would report an edge nothing observed. Annotated
  // `RunState` because `state` is reassigned inside `transition()`.
  let state: RunState = opened.state;
  const transitions: RunState[] = [opened.state];
  let ended = false;
  let reportersClosed = false;
  let planned: PlannedSpec[] = [];
  let impact: ImpactGraph = {
    nodes: [],
    edges: [],
    unanalyzable: [],
    demanded: [],
  };
  let projection: ProjectionMap | undefined;
  let projectionAttempted = false;
  /**
   * Set at the `running` transition — the only stage that can trigger an
   * instance-side run. While false, teardown may assert `neverTriggered`.
   *
   * Delegated decision 2026-09-25: the ledger now also persists this fact
   * (`RunStateRecord.runningAt`, write-once) for `tess cleanup`, which has no
   * in-memory flag. This loop can keep a plain `false` seed: it reaches
   * `store.teardown` only after projecting ITSELF, and projection is only
   * reachable when `openRun` resolved to a pre-`running` record — any later
   * resumed state is refused at the `provisioning`/`projecting` edge first.
   */
  let runStageEntered = false;
  const outcomes: SpecOutcome[] = [];
  let result: RunResult = { runId, outcomes: [] };
  let teardown: TeardownDisposition = "not-reached";
  let failure: RunPipelineFailure | undefined;
  /** Every fault, in order — `failures` on the report (see its field doc). */
  const failures: RunPipelineFailure[] = [];

  /**
   * The ONE way a fault is recorded. It always lands in `failures`; it claims
   * the `failure` slot only when the slot is free, unless `claim` says this
   * fault outranks whatever got there first (the run-stage infra fault and
   * the outer catch, which always did).
   */
  function recordFailure(fault: RunPipelineFailure, claim = false): void {
    failures.push(fault);
    if (claim || failure === undefined) failure = fault;
  }
  /**
   * Events `emit` could not hand to a reporter. Carried to the report on its
   * own field (`reporterEventFaults`), never through `failure` — see the field
   * doc on `PipelineRunReport`.
   */
  const eventFaults: ReporterEventFault[] = [];

  function emit(event: TestEvent): void {
    if (reportersClosed) {
      // ARCH-24: `end` is terminal and close() is the flush boundary. Nothing
      // may be emitted past it — a late event would silently miss the file
      // reporters that already flushed.
      return;
    }
    for (const [at, reporter] of ports.reporters.entries()) {
      try {
        reporter.onEvent(event);
      } catch (error) {
        // A reporter fault is never allowed to change the verdict — but it is
        // not nothing either. The event did not land, so that reporter's
        // output is missing a row, and a missing row is exactly the thing its
        // consumer cannot notice: an artifact with no `end` in it reads like a
        // run that was cut short, not like a reporter that threw. WHICH
        // reporter is half the diagnostic — with console, json and junit all
        // wired, "an event was refused" cannot answer which artifact is short
        // a row — so the identity is recorded with it.
        eventFaults.push({
          reporter: describeReporter(reporter, at),
          event: event.kind,
          message: describeError(error),
        });
      }
    }
  }

  function emitEnd(payload: RunResult): void {
    if (ended) return;
    ended = true;
    // ARCH-24: the terminal event is CORE's, not the runner's.
    emit({ kind: "end", runId, result: payload });
  }

  async function closeReporters(): Promise<void> {
    if (reportersClosed) return;
    const faults: string[] = [];
    for (const reporter of ports.reporters) {
      try {
        await reporter.close(runId);
      } catch (error) {
        faults.push(describeError(error));
      }
    }
    reportersClosed = true;
    if (faults.length > 0) {
      recordFailure({
        stage: "collect",
        message: `reporter close failed: ${faults.join("; ")}`,
        cause: faults,
      });
    }
    // Event faults are NOT drained into `failure`. It holds one fault, every
    // writer guards it with `failure === undefined`, and this was the last
    // guard to run — so on a run that had a real stage failure as well, the
    // reporter fault was reported nowhere at all. They ride their own field.
  }

  async function transition(to: RunState): Promise<void> {
    const record = await ledger.transition(runId, to);
    state = record.state;
    if (transitions[transitions.length - 1] !== state) {
      transitions.push(state);
    }
  }

  /**
   * Terminal-drive variant: a refused edge is never thrown again, because the
   * loop still owes the caller a report.
   *
   * It RETURNS the refusal as well as emitting it. Every terminal edge is
   * driven after `closeReporters()` (ARCH-24), and `emit` is a no-op past that
   * boundary — so for exactly the edges this variant exists to drive, the log
   * below reaches nobody. A caller that can put the refusal on the report has
   * to be handed it.
   *
   * Resolves with the refusal, or `undefined` when the edge landed.
   */
  async function tryTransition(to: RunState): Promise<unknown> {
    try {
      await transition(to);
      return undefined;
    } catch (error) {
      emit({
        kind: "log",
        runId,
        message: `state transition ${state} → ${to} refused: ${describeError(error)}`,
      });
      return error;
    }
  }

  /**
   * Drive a TERMINAL §4b edge and, when it is refused, say so on the report.
   *
   * Every call site sits past `closeReporters()`, so `tryTransition`'s log
   * event reaches nobody (ARCH-24) and `failure` is the last channel left. A
   * refusal that is neither logged nor reported would leave the report
   * carrying a disposition the loop DID reach — `teardown: "completed"`, say —
   * beside a `state` field a reader has no reason to read as a fault, which is
   * byte-identical to a run that legitimately ended there. `failure` is only
   * claimed when it is free: an earlier, more specific cause always wins.
   */
  async function settle(to: RunState, stage: RunStage): Promise<void> {
    const refused = await tryTransition(to);
    if (refused === undefined) return;
    recordFailure({
      stage,
      message:
        `the run record was left in ${state}: the §4b ${state} → ${to} edge ` +
        `was refused (${describeError(refused)})`,
      cause: refused,
    });
  }

  /**
   * Delegated decision 2026-09-26 (F1 defence in depth, fail closed): the
   * ONLY way `collectAndTearDown` reaches `done`. It re-reads the ledger and
   * refuses to call a run `done` while a write is still unsettled — `done`
   * hides the run from `scan()` and tells cleanup there is nothing left —
   * and settles `failed` instead, which cleanup re-enters. A ledger that
   * cannot be read back proves nothing, so it also lands on `failed`.
   */
  async function settleDone(): Promise<void> {
    let open: LedgerWriteRecord[];
    try {
      open = unsettledForDone(
        lifecycle,
        (await ledger.recover(runId)).teardownOrder,
      );
    } catch (error) {
      recordFailure({
        stage: "teardown",
        message:
          `the run was NOT settled done: the ledger could not be read back ` +
          `to prove every write settled (${describeError(error)})`,
        cause: error,
      });
      await settle("failed", "teardown");
      return;
    }
    if (open.length === 0) {
      await settle("done", "teardown");
      return;
    }
    recordFailure({
      stage: "teardown",
      message:
        `the run was NOT settled done: ${open.length} ledger ` +
        `entr${open.length === 1 ? "y is" : "ies are"} still unsettled ` +
        `(${open.map((entry) => `#${entry.seq} ${entry.state}`).join(", ")}); ` +
        `it is settled failed so \`tess status\` / \`tess cleanup --run-id ${runId}\` ` +
        `can see and re-enter it (DEV-17/ARCH-35)`,
      cause: undefined,
    });
    await settle("failed", "teardown");
  }

  /**
   * §11.3 then §4b step 1, in that exact order: the guard authorizes the
   * mutation (a refused write never gets a ledger entry) and only then does
   * the intent become durable. The caller may write only after this resolves.
   */
  async function intendWrite(
    write: WriteIntent,
    entry: Omit<IntendInput, "runId" | "instance">,
  ): Promise<number> {
    guard.assertWrite(deps.runner, write);
    const record = await ledger.intend({
      runId,
      instance: options.topology.runner,
      ...entry,
    });
    return record.seq;
  }

  function assertNotAborted(stage: RunStage): void {
    if (!controller.signal.aborted) return;
    throw new StageError(
      stage,
      deadlineReached
        ? `run deadline reached during ${stage} (DEV-2)`
        : `run aborted during ${stage} (ARCH-28)`,
      controller.signal.reason,
    );
  }

  async function stage<T>(name: RunStage, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof StageError) throw error;
      throw new StageError(
        name,
        `${name} stage failed: ${describeError(error)}`,
        error,
      );
    }
  }

  /**
   * DEV-1 style row synthesis: outcomes we could not observe become explicit
   * rows rather than absences, so the reducer never has to guess. `missing`
   * stays the reducer's own synthesis — this only fills what the loop KNOWS
   * went wrong (`error` for an infra fault, `waiting-timeout` for DEV-2).
   */
  function synthesize(raw: RawOutcome, cause: string): RunResult {
    const known = new Set(outcomes.map((outcome) => specKey(outcome.spec)));
    const rows: SpecOutcome[] = [...outcomes];
    for (const entry of planned) {
      const key = specKey(entry.spec);
      if (known.has(key)) continue;
      known.add(key);
      rows.push({
        spec: entry.spec,
        raw,
        // SEAM (QA-11): Phase 1 points this at the run-id-keyed artifact
        // directory; the skeleton has only the cause string.
        evidence: { kind: "log", ref: cause },
      });
    }
    return { runId, outcomes: rows };
  }

  /**
   * ARCH-32 / DEV-17 / ARCH-28: the instance run is NOT provably terminal, so
   * teardown is skipped entirely — deleting under a live run is the one thing
   * the design forbids outright. Reclamation belongs to `cleanup --run` and
   * the orphan sweep, which probe instance-side state first.
   */
  async function abandon(payload: RunResult): Promise<void> {
    result = payload;
    emitEnd(result);
    await closeReporters();
    // The `run` stage owns this one: `abandoned` is the edge DEV-17/ARCH-28
    // take when the runner never proved terminal, and no teardown pass is
    // involved.
    await settle("abandoned", "run");
    teardown = "skipped-non-terminal";
  }

  /**
   * DEV-13 + ARCH-24 + §6a: results are read, emitted and FLUSHED by every
   * reporter before a single record is deleted.
   */
  async function collectAndTearDown(payload: RunResult): Promise<void> {
    result = payload;
    if (state === "running") {
      // §4b trigger: `running → collecting` on RUNNER TERMINAL ONLY (QA-23).
      await tryTransition("collecting");
    }
    emitEnd(result);
    await closeReporters();
    const refused = await tryTransition("tearing-down");
    if (state !== "tearing-down") {
      // No teardown pass ran, so nothing was compensated. The reporters are
      // already closed, which makes `failure` the only channel a consumer can
      // still read this on: without it the report carries `teardown:
      // "not-reached"` and no reason, which is byte-identical to a run that
      // never projected anything.
      recordFailure({
        stage: "teardown",
        message:
          `teardown never started: the §4b ${state} → tearing-down edge ` +
          `was refused (${describeError(refused)})`,
        cause: refused,
      });
      return;
    }

    if (!projectionAttempted) {
      // Nothing ever reached the instance; `tearing-down` is still the only
      // legal road to `done` for a non-`repo-only` run (§4b).
      teardown = "not-reached";
      await settleDone();
      return;
    }
    if (lifecycle === "persistent") {
      // §4a/DEV-20: persistent test definitions are kept, so no compensation
      // is DUE. Phase 0.5 fabricates no run-state, which is the only thing a
      // persistent run would still have to tear down.
      teardown = "skipped-persistent";
      await settleDone();
      return;
    }
    try {
      guard.assertWrite(deps.runner, {
        op: "delete",
        table: projectionTable,
        description: `teardown of run ${runId} (§4a ephemeral)`,
      });
      // Delegated decision 2026-09-25: a store's DEV-17 gate refuses a suite
      // that has no result row yet (a queued execution looks identical), so
      // core tells it — structurally, without widening PipelineContext — when
      // no trigger can have happened: the fault came before `running`.
      //
      // DEV-17 (wave 13): the ledger's recorded trigger count rides along too,
      // so a store can refuse while a second execution is still queued behind
      // a first one that already reads terminal. `null` = unknown (refused).
      const recordedTriggers = await recordedTriggerCount(
        ledger,
        runId,
        runTriggerTable,
      );
      const teardownCtx: PipelineContext & {
        readonly neverTriggered?: true;
        readonly recordedTriggers: number | null;
      } = runStageEntered
        ? { ...ctx, recordedTriggers }
        : { ...ctx, neverTriggered: true, recordedTriggers };
      await ports.store.teardown(teardownCtx);
      // DEV-13/ARCH-37: `teardownOrder` is `orphans ∪ applied` in reverse
      // `seq`, which IS the pinned delete order. The store deleted the whole
      // run-id namespace in that order, so every entry — including a W1/W2
      // orphan the store's namespace sweep also removed — is now settled.
      const plan = await ledger.recover(runId);
      for (const entry of plan.teardownOrder) {
        await ledger.compensate(runId, entry.seq);
      }
      teardown = "completed";
      await settleDone();
    } catch (error) {
      teardown = "failed";
      recordFailure({
        stage: "teardown",
        message: `teardown failed: ${describeError(error)}`,
        cause: error,
      });
      await settle("failed", "teardown");
    }
  }

  // Set iff the resolver's report admitted a partial answer (H1): its
  // warning notes, prefixed, to be stated on the verdict.
  let resolutionWarnings: string[] | undefined;
  // Set iff the impact analyzer's report admitted a partial graph: its
  // warning notes, prefixed, to be stated on the verdict.
  let impactWarnings: string[] | undefined;

  try {
    // ── planned ──────────────────────────────────────────────────────────
    // ARCH-19 read half. Everything below this comment reads the SOURCE; not
    // one byte is written until the `provisioning` transition.
    assertNotAborted("resolve");
    const affected: AffectedArtifact[] = await stage("resolve", async () => {
      const resolver = ports.resolver;
      // Delegated decision 2026-09-26 (H1): prefer the reporting call when
      // the resolver offers one. The bare `resolve()` list cannot say "this
      // is partial", so a 403 on one table used to vanish and the run could
      // still reach GO. The report's warnings are carried to the verdict.
      if (resolver.resolveWithReport === undefined) {
        return resolver.resolve(ctx, options.input);
      }
      const resolution = await resolver.resolveWithReport(ctx, options.input);
      if (isResolverReportIncomplete(resolution)) {
        resolutionWarnings = resolution.notes
          .filter((note) => note.level === "warning")
          .map((note) => `${RESOLUTION_NOTE_PREFIX}${note.message}`);
      }
      return [...resolution.artifacts];
    });

    const runImpact =
      options.stages?.impact ?? ports.impactAnalyzer !== undefined;
    const runGenerate =
      options.stages?.generate ?? ports.generator !== undefined;
    let impactSynthesized = false;
    if (runImpact) {
      const analyzer = ports.impactAnalyzer;
      if (analyzer === undefined) {
        throw new StageError(
          "impact",
          "the impact stage is enabled but no ImpactAnalyzer port was composed",
        );
      }
      impact = await stage("impact", async () => {
        // Delegated decision 2026-09-26: prefer the reporting call when the
        // analyzer offers one, exactly as the resolve stage does — its
        // warning notes (duplicate names, never-searched references, a
        // truncated where-used read) say "this graph is partial" even where
        // no single artifact is marked unanalyzable.
        if (analyzer.analyzeWithReport === undefined) {
          return analyzer.analyze(ctx, affected);
        }
        const analysis = await analyzer.analyzeWithReport(ctx, affected);
        if (isImpactReportIncomplete(analysis)) {
          impactWarnings = analysis.notes
            .filter((note) => note.level === "warning")
            .map((note) => `${IMPACT_NOTE_PREFIX}${note.message}`);
        }
        return analysis.graph;
      });
    } else if (options.impact !== undefined) {
      impact = options.impact;
    } else {
      // Skeleton path: the change is hardcoded, so the "graph" is exactly the
      // resolved artifacts and `demanded` is filled from the plan below —
      // parity (ARCH-30) then holds by construction instead of by accident.
      impactSynthesized = true;
      impact = {
        nodes: affected.map((entry) => entry.ref),
        edges: [],
        unanalyzable: [],
        demanded: [],
      };
      emit({
        kind: "log",
        runId,
        message:
          "impact stage skipped (PLAN Phase 0.5) — the impact graph is the resolved artifact set",
      });
    }

    const specs: TestSpec[] = [...(options.specs ?? [])];
    if (runGenerate) {
      const generator = ports.generator;
      if (generator === undefined) {
        throw new StageError(
          "generate",
          "the generate stage is enabled but no TestGenerator port was composed",
        );
      }
      for (const kind of options.kinds ?? DEFAULT_KINDS) {
        const generated = await stage("generate", () =>
          generator.generate(ctx, impact, kind),
        );
        specs.push(...generated);
      }
    } else {
      emit({
        kind: "log",
        runId,
        message:
          "generate stage skipped (PLAN Phase 0.5) — specs come from the caller",
      });
    }

    planned = buildPlanned(specs, impact);
    if (impactSynthesized) {
      impact = { ...impact, demanded: planned };
    }
    // §6: a spec no runner supports is a preflight failure, resolved here in
    // the read half so it costs nothing on the instance.
    const groups = groupByRunner(specs, ports.runners);

    // ── provisioning ─────────────────────────────────────────────────────
    assertNotAborted("provision");
    await transition("provisioning");
    const plan = await stage("provision", () => ports.provisioner.plan(ctx));
    if (plan.actions.length > 0) {
      // §4b trigger + ARCH-33: standing infra is VERIFIED here, never created.
      // A non-empty plan means the runner is not prepared, and preparing it is
      // `preflight_plan` / `preflight_apply`'s job on its own ledger namespace.
      throw new StageError(
        "provision",
        `runner "${options.topology.runner}" is missing standing infrastructure (${plan.actions.length} action(s): ${plan.actions
          .map((action) => `${action.kind} ${action.table}`)
          .join(
            ", ",
          )}) — run preflight_plan/preflight_apply; the run loop never writes standing infra (ARCH-33)`,
      );
    }
    // SEAM (Phase 1): run-scoped fabricated state (temp users, seed data — §4a,
    // always ephemeral) is applied HERE, each record intend → assertWrite →
    // apply → confirm. Phase 0.5 fabricates none, so the §4b trigger's "or
    // none needed" branch is the whole stage.

    // ── projecting ───────────────────────────────────────────────────────
    assertNotAborted("project");
    await transition("projecting");
    projectionAttempted = true;
    const projectionSeq = new Map<string, number>();
    for (const spec of specs) {
      const key = specKey(spec.ref);
      if (projectionSeq.has(key)) continue;
      // §4a: an ephemeral projection is delete-compensated and probed by the
      // run-id prefix; a persistent one is never deleted (DEV-20) and probes
      // its natural key so W2 recovery can ADOPT it instead (QA-25).
      const compensation: CompensationOp =
        lifecycle === "persistent"
          ? {
              op: "none",
              reason:
                "persistent-mode test definitions are never deleted (§4a/DEV-20); the manifest owns them",
            }
          : { op: "delete", table: projectionTable };
      const probe: ProbeDescriptor =
        lifecycle === "persistent"
          ? {
              table: projectionTable,
              query: `name=${spec.ref.id}`,
              key: "natural-key",
            }
          : {
              table: projectionTable,
              // Delegated decision 2026-09-25: the probe prefix carries the
              // `:` delimiter both TestStores name with (`<runId>:…`), so a
              // recovery probe for `run-1` never matches `run-10:…` rows.
              query: `nameSTARTSWITH${runId}:`,
              key: "run-id-prefix",
            };
      const seq = await intendWrite(
        {
          op: "create",
          table: projectionTable,
          description: `project ${spec.kind} spec ${spec.ref.id}`,
        },
        {
          intent: `project ${spec.kind} spec ${spec.ref.id}`,
          target: { table: projectionTable },
          compensation,
          idempotencyKey: `${runId}:project:${key}`,
          probe,
        },
      );
      projectionSeq.set(key, seq);
    }
    // Every intent above is durable BEFORE the store issues its first write.
    // SEAM (ARCH-3): the journalled sn-client intends per HTTP write (suite,
    // steps, m2m links). Core's per-spec entry is the coarsest grouping that
    // still makes reverse-`seq` the real DEV-13 delete order.
    projection = await stage("project", () => ports.store.project(ctx, specs));
    for (const [key, seq] of projectionSeq) {
      const record = projection[key];
      if (record === undefined) {
        throw new StageError(
          "project",
          `TestStore.project returned no ProjectionMap entry for spec key ${JSON.stringify(key)} — projection is the ephemeral result-attribution key (ARCH-26), so an unmapped spec cannot be attributed`,
        );
      }
      await ledger.confirm(runId, seq, { sysId: record.testSysId });
    }
    ctx = { ...ctx, projection };

    // ── running ──────────────────────────────────────────────────────────
    assertNotAborted("run");
    runStageEntered = true;
    await transition("running");
    let interruption: "abort" | "deadline" | undefined;
    let infraFault: string | undefined;

    for (const group of groups) {
      if (controller.signal.aborted) {
        interruption = deadlineReached ? "deadline" : "abort";
        break;
      }
      const seq = await intendWrite(
        {
          op: "execute",
          table: runTriggerTable,
          description: `trigger ${group.specs.length} spec(s) on runner adapter #${group.index}`,
        },
        {
          intent: `run ${group.specs.length} spec(s) via runner adapter #${group.index}`,
          target: { table: runTriggerTable },
          compensation: {
            op: "none",
            reason:
              "a triggered suite run cannot be un-triggered — there is no cancel endpoint (DEV-17); the run row is reclaimed by the orphan sweep",
          },
          idempotencyKey: `${runId}:run:${group.index}`,
        },
      );

      let groupResult: RunResult | typeof INTERRUPTED;
      try {
        groupResult = await Promise.race([
          group.runner.run(ctx, group.specs, emit),
          interrupted,
        ]);
      } catch (error) {
        if (controller.signal.aborted) {
          interruption = deadlineReached ? "deadline" : "abort";
          break;
        }
        // DEV-1: a rejection is an INFRASTRUCTURE fault with no outcome
        // evidence. It becomes rows, never a crashed loop. The intent stays
        // `intended` on purpose — we cannot prove the trigger did not land.
        infraFault = describeError(error);
        // The rejection is swallowed here so the loop can render a verdict, so
        // it has to survive on the report — an infra fault that leaves
        // `failure` undefined is indistinguishable from a clean run.
        recordFailure(
          {
            stage: "run",
            message: `run stage failed: ${infraFault}`,
            cause: error,
          },
          true,
        );
        emit({ kind: "error", runId, cause: infraFault });
        break;
      }
      if (groupResult === INTERRUPTED) {
        interruption = deadlineReached ? "deadline" : "abort";
        break;
      }
      await ledger.confirm(runId, seq);
      outcomes.push(...groupResult.outcomes);
    }

    if (interruption !== undefined) {
      const cause =
        interruption === "deadline"
          ? `runner did not reach a terminal state within ${options.runTimeoutMs ?? 0}ms (DEV-2)`
          : "run aborted before the runner reached a terminal state (ARCH-28)";
      emit({ kind: "error", runId, cause });
      // A DEV-2 deadline is the same hole as a rejection — the runner owed
      // evidence and delivered none — so it carries a `failure` for the same
      // reason. An abort does NOT: cancellation is the caller's own decision,
      // and reporting their choice back as a stage failure would be a lie.
      if (interruption === "deadline") {
        recordFailure({ stage: "run", message: cause, cause: undefined });
      }
      // DEV-2's distinct cause is preserved as `waiting-timeout` so the row
      // does not read as a generic adapter fault (§6a).
      await abandon(
        synthesize(
          interruption === "deadline" ? "waiting-timeout" : "error",
          cause,
        ),
      );
    } else if (infraFault !== undefined) {
      // §4b leaves `abandoned` as the only edge out of `running` that is not
      // "runner terminal" — and a rejection proves nothing about the instance
      // run, so fail closed: no teardown (ARCH-32).
      await abandon(synthesize("error", infraFault));
    } else {
      await collectAndTearDown({ runId, outcomes });
    }
  } catch (error) {
    const stageError =
      error instanceof StageError
        ? error
        : new StageError("compose", describeError(error), error);
    recordFailure(
      {
        stage: stageError.stage,
        message: stageError.message,
        cause: stageError.cause ?? error,
      },
      true,
    );
    emit({ kind: "error", runId, cause: stageError.message });
    const payload = synthesize("error", stageError.message);
    if (state === "running") {
      await abandon(payload);
    } else {
      // §4b: any non-terminal state EXCEPT `running` may go to `tearing-down`
      // — no instance run can be in flight before `running`.
      await collectAndTearDown(payload);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    detach();
    // Belt and braces: a path that produced no evidence still owes the caller
    // the ARCH-24 boundary.
    emitEnd(result);
    await closeReporters();
  }

  const coverage =
    options.coverage ??
    computeRunCoverage({ planned, results: [result], impact });
  // The ONE verdict path (ARCH-17): the existing GateEvaluator over the pure
  // reducer. `missing` rows and ARCH-30 parity are the reducer's job.
  const gated = ports.gate.evaluate(
    { results: [result], impact, coverage },
    {
      planned,
      coverageFloor: options.coverageFloor ?? 0,
      runId,
      topology: options.topology,
      overrides: options.overrides ?? [],
      now: clock().toISOString(),
      tokenTtlMs: options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS,
    },
  );
  // Delegated decision 2026-09-26: applied after the gate and after every
  // §4b edge and ledger write above — the run's fate (state, teardown,
  // settle) is independent of the inventory; only the verdict is narrowed.
  // Delegated decision 2026-09-26 (H1): the gaps are listed in stage order —
  // resolution, then impact, then the inventory last.
  const gaps: EvidenceGap[] = [];
  if (resolutionWarnings !== undefined) {
    gaps.push({
      warning: RESOLUTION_INCOMPLETE_WARNING,
      downgradeSuffix: RESOLUTION_DOWNGRADE_SUFFIX,
      details: resolutionWarnings,
    });
  }
  // Delegated decision 2026-09-26: fail-closed on the structured flag of the
  // FINAL graph (`unanalyzable`), whatever produced it — a reporting
  // analyzer, a bare `analyze()`, or a caller-supplied `options.impact` — and
  // never by matching warning text. An artifact nobody could trace means the
  // selected tests may miss what the change touches, so a GO over it cannot
  // stand. The reducer already states one "unanalyzable impact: …" warning
  // per entry, so the gap adds no per-entry details of its own; only the
  // analyzer's warning notes (if any) ride along as details.
  if (impactWarnings !== undefined || isImpactGraphIncomplete(impact)) {
    gaps.push({
      warning: IMPACT_INCOMPLETE_WARNING,
      downgradeSuffix: IMPACT_DOWNGRADE_SUFFIX,
      details: impactWarnings ?? [],
    });
  }
  if (options.inventoryIncomplete === true) {
    gaps.push({
      warning: INVENTORY_INCOMPLETE_WARNING,
      downgradeSuffix: INVENTORY_DOWNGRADE_SUFFIX,
      details: [],
    });
  }
  const { verdict, downgrade } = applyEvidenceGaps(gated, gaps);

  const report: PipelineRunReport = {
    runId,
    state,
    transitions,
    verdict,
    result,
    planned,
    impact,
    coverage,
    teardown,
  };
  if (projection !== undefined) report.projection = projection;
  if (failure !== undefined) report.failure = failure;
  if (failures.length > 0) report.failures = [...failures];
  // Independent of `failure`, deliberately: a run can have both.
  if (eventFaults.length > 0) report.reporterEventFaults = [...eventFaults];
  if (downgrade !== undefined) report.verdictDowngrade = downgrade;
  return report;
}
