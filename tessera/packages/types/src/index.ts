// @tessera/types — public surface. Pure data; no I/O anywhere in the package.

export {
  ATF_RUNNER_SAFE_DIRECTION,
  decidePropertyRows,
  normalisePropertyValue,
  PRODUCTION_SAFE_DIRECTION,
  readsSafeDirection,
} from "./propertyRows.js";
export type {
  PropertyRowsDecision,
  PropertySafeDirection,
} from "./propertyRows.js";
export {
  ATF_RUNNER_ENABLED_PROPERTY,
  incompletePropertyRead,
  incompleteRead,
  PRODUCTION_PROPERTY,
  PROPERTY_READ_LIMIT,
  PROPERTY_ROW_LIMIT,
  SYS_PROPERTIES_TABLE,
} from "./readCompleteness.js";
export type { CountedRead } from "./readCompleteness.js";
export { TEST_KINDS } from "./run.js";
export type {
  AffectedArtifact,
  ArtifactRef,
  CoverageReport,
  ImpactConfidence,
  ImpactEdge,
  ImpactGraph,
  Lifecycle,
  PipelineContext,
  PipelineTopology,
  PlannedSpec,
  ProjectedRecord,
  ProjectionMap,
  ProvisionAction,
  ProvisionPlan,
  ResolverSource,
  RunId,
  RunLifecycle,
  RunResult,
  SpecOutcome,
  TargetInput,
  TestEvent,
  TestKind,
  TestSpec,
  TestSpecRef,
  UnanalyzableArtifact,
} from "./run.js";
export {
  isUntrusted,
  mapUntrusted,
  untrusted,
  unwrapUntrusted,
} from "./untrusted.js";
export type { Untrusted } from "./untrusted.js";
export { RAW_OUTCOMES } from "./verdict.js";
export type {
  ChecklistRow,
  ConfirmToken,
  EvidenceRef,
  OverrideRecord,
  PreflightVerdict,
  RawOutcome,
  RowStatus,
  TargetArtifactRef,
  VerdictStatus,
} from "./verdict.js";
