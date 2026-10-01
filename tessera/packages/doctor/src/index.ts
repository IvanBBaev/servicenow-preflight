// @tessera/doctor — EnvironmentDoctor (PLAN Phase 1, DESIGN §12.3).
//
// Deterministic three-state readiness over a declared precondition catalogue.
// Read-only by construction, so it is the one stage that may probe any role in
// the topology, `target` included (ARCH-8). `unknown` is fail-closed and never
// coerced to `ready`; a precondition this phase cannot probe is declared and
// marked `deferredTo`, never omitted.

export { DOCTOR_STATUSES } from "./types.js";
export type {
  Applicability,
  DoctorFinding,
  DoctorReport,
  DoctorRequest,
  DoctorStatus,
  Precondition,
  ProvisionPlanRef,
} from "./types.js";
export { DoctorContractError } from "./errors.js";
export {
  PRODUCTION_PROPERTY,
  PROPERTY_READ_LIMIT,
  PROPERTY_ROW_LIMIT,
  SYS_PROPERTIES_TABLE,
  createSnInstanceProbe,
} from "./probe.js";
export type {
  AccessProbe,
  ApiProbe,
  InstanceProbe,
  PropertyProbe,
  PropertyRow,
} from "./probe.js";
export {
  ATF_AUTHORING_TABLES,
  ATF_RUNNER_ENABLED_PROPERTY,
  AUTHORING_CHANNEL_C3_PROMOTED,
  AUTHORING_CHANNEL_C3_REQUIRED_KINDS,
  AUTHORING_CHANNEL_REQUIRED_MAJOR,
  AUTHORING_CHANNEL_VERSION_PROPERTY,
  CICD_PROBE_PATH,
  PRECONDITION_IDS,
  atfRunnerEnabledPrecondition,
  atfTablesPrecondition,
  authoringChannelPrecondition,
  browserTestRunnerPrecondition,
  cicdApiPrecondition,
  createDefaultPreconditions,
  harnessScopedAppPrecondition,
} from "./preconditions.js";
export type { AuthoringChannelOptions } from "./preconditions.js";
export {
  DEFAULT_PROBE_TIMEOUT_MS,
  createEnvironmentDoctor,
  formatDoctorReport,
  rollUp,
} from "./doctor.js";
export type { EnvironmentDoctor, EnvironmentDoctorOptions } from "./doctor.js";
