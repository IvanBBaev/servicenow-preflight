/**
 * `servicenow-preflight/checks` — the check contract, the bundled checks and
 * their registry, findings helpers, the check catalogue, `doctor` readiness
 * checks, severity policy and change-aware (incremental) selection.
 *
 * @packageDocumentation
 */
export type {
  Check,
  CheckMeta,
  CheckResult,
  CheckResultKind,
  CheckSeverity,
  CheckStatus,
  CheckSelection,
  Finding,
  FindingLocation,
  PreflightAuth,
  PreflightContext,
  PreflightReport,
  ReplayInfo,
} from "../types.js";
export { selectChecks } from "../index.js";
export {
  defaultChecks,
  instanceUrlConfigured,
  connectivityAuth,
  updateSetState,
  defaultSetLeakage,
  remoteSetPreview,
  atfEnablement,
  atfRun,
  scopedAppDeps,
  i18nCompleteness,
  aclRoleSanity,
  clientCallableAcl,
  restEndpointSecurity,
  scriptFieldExposure,
  scheduledJobRunAs,
  mobileMenuHygiene,
  tableCrudAcl,
  uiPageAcl,
  uiActionGating,
  tableNamespace,
  portalRoles,
  aclOutOfScope,
  moduleRoles,
  scriptHygiene,
  hardcodedIdentifiers,
  clientScriptSafety,
  propertyPrivacy,
  inactiveArtifacts,
  notificationConditions,
  logLeftovers,
  deprecatedApis,
  testDrift,
} from "../checks/index.js";
export {
  MAX_FINDINGS,
  capFindings,
  findingId,
  makeFinding,
} from "../findings.js";
export {
  describeChecks,
  findCheck,
  type CheckDescriptor,
} from "../catalogue.js";
export {
  BASIC_AUTH_PROPERTIES,
  BASIC_AUTH_ROLE,
  doctorChecks,
  type DoctorOptions,
  type InstanceSource,
} from "../doctor.js";
export {
  changedTables,
  declaredTables,
  planIncremental,
  selectByTables,
  INCREMENTAL_ROW,
  STATE_TABLES,
  type ChangeSet,
  type ChangeSource,
  type IncrementalPlan,
  type IncrementalSelection,
  type SelectReason,
} from "../incremental.js";
export {
  applyPolicy,
  policySkips,
  validatePolicy,
  type SeverityOverride,
  type SeverityPolicy,
} from "../policy.js";
