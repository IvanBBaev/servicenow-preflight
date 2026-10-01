// @tessera/guard — TargetGuard, the fail-closed write-side control (DESIGN
// §11). Zero runtime dependencies; the read-only probe and the write-ahead
// ledger sink are injected by the composition root (ARCH-1).

export {
  GUARD_SIGNAL_KINDS,
  INSTANCE_CLASSES,
  INSTANCE_ROLES,
} from "./types.js";
export type {
  AcknowledgeProd,
  AcknowledgeProdRecord,
  Classification,
  ClassifiedTopology,
  GuardAuditSink,
  GuardConfig,
  GuardSignal,
  GuardSignalEffect,
  GuardSignalKind,
  InstanceClass,
  InstanceProbe,
  InstanceRef,
  InstanceRole,
  OverrideSurface,
  ProbeFn,
  TargetGuardOptions,
  TopologyRefs,
  WriteIntent,
} from "./types.js";
export {
  GUARD_VIOLATION_REASONS,
  GuardViolation,
  formatGuardViolation,
  guardViolation,
} from "./errors.js";
export type { GuardViolationDetail, GuardViolationReason } from "./errors.js";
export {
  nameHeuristicReasons,
  normalizeInstanceHost,
  probeFailureSignals,
  probeSignals,
} from "./heuristics.js";
export { createTargetGuard } from "./targetGuard.js";
export type { TargetGuard } from "./targetGuard.js";
