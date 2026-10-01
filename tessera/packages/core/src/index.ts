// @tessera/core — public surface: stage ports, composition root, canonical
// serialization, the §6b plan hash, the pure verdict reducer, the gate
// evaluator over it, and the §4b run loop (DESIGN §4b/§6/§6a/§6b).

export type {
  ImpactAnalysisNote,
  ImpactAnalysisReport,
  ImpactAnalyzer,
  Provisioner,
  Reporter,
  Resolver,
  ResolverNote,
  ResolverReport,
  Runner,
  TestGenerator,
  TestStore,
} from "./ports.js";
export {
  isImpactGraphIncomplete,
  isImpactReportIncomplete,
  isResolverReportIncomplete,
} from "./ports.js";
export {
  canonicalJson,
  hmacSha256Hex,
  sha256Hex,
  specKey,
} from "./canonical.js";
export {
  PLAN_HASH_VERSION,
  computePlanHash,
  planHashPreimage,
} from "./planHash.js";
export type {
  HashableProvisionPlan,
  HashableProvisionStep,
  HashableProvisionWrite,
} from "./planHash.js";
export {
  allowSkippedAuditInput,
  recordAllowSkipped,
} from "./allowSkippedAudit.js";
export type { AllowSkippedAuditMeta } from "./allowSkippedAudit.js";
export { aggregateVerdict } from "./aggregateVerdict.js";
export type { VerdictInput } from "./aggregateVerdict.js";
export { createGateEvaluator } from "./gateEvaluator.js";
export type {
  GateEvaluator,
  GateEvaluatorOptions,
  GateInput,
  GatePolicy,
  Verdict,
} from "./gateEvaluator.js";
export { Registry, createRegistries, resolvePipeline } from "./pipeline.js";
export type {
  PipelineConfig,
  PipelinePorts,
  PipelineRegistries,
} from "./pipeline.js";
export {
  computeRunCoverage,
  IMPACT_INCOMPLETE_WARNING,
  INVENTORY_INCOMPLETE_WARNING,
  RESOLUTION_INCOMPLETE_WARNING,
  runPipeline,
  RunConcurrencyRefusedError,
  RunResumeRefusedError,
} from "./runPipeline.js";
export type {
  PipelineRunReport,
  ReporterEventFault,
  RunConcurrencyConflict,
  RunCoverageInput,
  RunPipelineDeps,
  RunPipelineFailure,
  RunPipelineOptions,
  RunPipelinePorts,
  RunPipelineStages,
  RunStage,
  TeardownDisposition,
  VerdictDowngrade,
} from "./runPipeline.js";
