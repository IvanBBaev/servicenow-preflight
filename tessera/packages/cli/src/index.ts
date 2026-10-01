// @tessera/cli — THE composition root (ARCH-1).
//
// Exactly one place in the workspace wires concrete adapters into ports, reads
// argv and the environment, and owns the process's exit code. Every other
// package is a library that takes its collaborators as arguments; this one is
// allowed to name them.
//
// That is why the Phase-0.5 hand-wiring that used to live in
// `@tessera/skeleton` is here now, alongside the Phase-1 `preflight` and
// `doctor` commands: the ARCH-1 exception the skeleton held is discharged, and
// no second composition root survives it.
//
// The public surface is exported for tests and for the future MCP server, which
// must reach the same wired pipeline rather than assemble a parallel one.

export { COMMANDS, splitArgv } from "./args.js";
export type { ArgvSplit, CommandName } from "./args.js";
export { guardReasoning, main, provisionAftermath, run } from "./cli.js";
export { coverageCommand } from "./commands/coverage.js";
export {
  doctorCommand,
  doctorHardFailure,
  exitCodeForDoctor,
} from "./commands/doctor.js";
export { generateCommand } from "./commands/generate.js";
export { impactCommand } from "./commands/impact.js";
export {
  decideVerdict,
  parseArtifact,
  planIdentity,
  preflightCommand,
  verdictLabel,
} from "./commands/preflight.js";
export type { PlanIdentity, PreflightVerdict } from "./commands/preflight.js";
export { resolveCommand } from "./commands/resolve.js";
export { parseRunArgs, runCommand } from "./commands/run.js";
export type { RunOptions, RunParse } from "./commands/run.js";
export {
  cleanupCommand,
  confirmCommand,
  statusCommand,
} from "./commands/runState.js";
export type { CleanupSeams } from "./commands/runState.js";
export {
  createRunEventRecorder,
  LIVE_RESULT_KIND,
  liveExitCode,
  liveRunRecord,
  PROJECTION_LOCK_FILENAME,
  runLive,
} from "./liveRun.js";
export type { LiveRunOptions, LiveRunRecord } from "./liveRun.js";
// Delegated decision 2026-09-28 (wave 13): the `--restore` path's composition
// and result kind are public alongside the run path's, and so are the types
// `BenchmarkSeams` already names (`composeRestore`, `signals`) — a seam whose
// argument types cannot be named from the barrel cannot be implemented
// against it without a deep import into `build/`.
export {
  BENCHMARK_RESTORE_RESULT_KIND,
  BENCHMARK_RESULT_KIND,
  benchmarkCommand,
  benchmarkExitCode,
  bindBenchmarkClient,
  composeInstanceBenchmark,
  composeInstanceRestore,
  parseBenchmarkArgs,
  readGenConfigFile,
} from "./benchmarkRun.js";
export type {
  BenchmarkCommandOptions,
  BenchmarkComposeInput,
  BenchmarkComposition,
  BenchmarkParse,
  BenchmarkProviderName,
  BenchmarkRestoreComposeInput,
  BenchmarkRestoreComposition,
  BenchmarkRestoreOptions,
  BenchmarkSeams,
  BenchmarkSignal,
  BenchmarkSignalSource,
} from "./benchmarkRun.js";
export { formatRejectedSpecs, loadLiveSpecs } from "./liveSpecs.js";
export type { LiveSpecLoad, RejectedSpec } from "./liveSpecs.js";
export { defaultContext, describe, instanceFromEnv } from "./context.js";
export type { CliContext } from "./context.js";
export { EXIT_CODES, runExitDisposition } from "./exitCodes.js";
export type { ExitCode, RunExitDisposition } from "./exitCodes.js";
export { TOP_LEVEL_HELP, commandHelp } from "./help.js";
export {
  ARTIFACT_LABEL_SEPARATOR,
  COVERAGE_OPTIONS,
  DEFAULT_TESTS_ROOT,
  DOCTOR_OPTIONS,
  GENERATE_OPTIONS,
  GENERATE_PROVIDERS,
  IMPACT_OPTIONS,
  PREFLIGHT_CLI_OPTIONS,
  RESOLVE_OPTIONS,
} from "./options.js";
export {
  REAL_PIPELINE,
  SKELETON_PIPELINE,
  composeRealPipeline,
  composeSkeletonPipeline,
  createNoopImpactAnalyzer,
  createNoopTestGenerator,
  createRealRegistries,
  createSkeletonRegistries,
} from "./registries.js";
export type {
  RealComposition,
  RealRegistryOptions,
  SkeletonComposition,
  SkeletonRegistryOptions,
} from "./registries.js";
export { formatRunReport, jsonRunReport } from "./render.js";
export type { RunDisplay } from "./render.js";
export { runSkeleton } from "./skeletonRun.js";
export type { SkeletonRunOptions, SkeletonRunResult } from "./skeletonRun.js";
export { DOCS_DIR_NAME, stage, stageDocsDir } from "./stage.js";
export type { DocsDirOptions, Harness, StageOptions } from "./stage.js";
export {
  ATF_RUNNER_PROPERTY,
  PRODUCTION_PROPERTY,
  TopologyError,
  bindAtfClient,
  bindProbe,
  bindRole,
  bindTestStoreClient,
  bindWriter,
  createGuardProbe,
} from "./topology.js";
export type { ProbeTarget, RoleBinding } from "./topology.js";
