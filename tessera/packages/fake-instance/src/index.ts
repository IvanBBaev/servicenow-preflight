// @tessera/fake-instance — the stateful in-memory fake ServiceNow instance the
// Tier-2 CI job runs against (QA-18; PLAN Phase 0.5, DESIGN §4b).
//
// Not a response replayer: creates mint sys_ids, updates and deletes mutate the
// model, and every read reflects prior writes — which is what makes §4a's
// write-sequence invariants and §4b's crash windows falsifiable.

export {
  W2_AUTHORING_CHANNEL_ACL_RULES,
  W2_AUTHORING_ROLE,
  createFakeAcl,
  createFakeReadAcl,
} from "./acl.js";
export type {
  FakeAcl,
  FakeAclDenial,
  FakeAclOperation,
  FakeAclOptions,
  FakeAclRule,
  FakeReadAcl,
  FakeReadAclOptions,
  FakeReadAclRule,
} from "./acl.js";
export {
  LOGICAL_EPOCH_MS,
  createLogicalClock,
  formatSnDateTime,
} from "./clock.js";
export type { FakeClock } from "./clock.js";
export {
  SUITE_RESULT_PARENT_FIELD,
  TERMINAL_CICD_STATES,
  createFakeCicd,
} from "./cicd.js";
export type {
  ChildSuiteResultArgs,
  CicdDeps,
  CicdOptions,
  CicdProgressPayload,
  CicdRun,
  CicdRunState,
  FakeCicd,
  StartRunArgs,
  TestResultFields,
} from "./cicd.js";
export {
  FakeAbortError,
  FakeTransportError,
  namespace404Body,
  noRecordFoundBody,
  snErrorBody,
} from "./errors.js";
export type { SnErrorBody } from "./errors.js";
export { createFaultRegistry, stall, transportFailure } from "./faults.js";
export type {
  FaultMatch,
  FaultMode,
  FaultRegistry,
  FaultRule,
  FaultTarget,
  HttpMethod,
  RegisteredFault,
} from "./faults.js";
export {
  fixtureToSeed,
  parseFixtureBundle,
  readFixtureFile,
} from "./fixtures.js";
export type {
  FixtureSeed,
  HttpFixtureBundle,
  HttpFixtureExchange,
  IgnoredExchange,
} from "./fixtures.js";
export { SYS_ID_LENGTH, createIdGenerator, deriveSysId } from "./ids.js";
export type { IdGenerator } from "./ids.js";
export { createFakeInstance } from "./instance.js";
export type {
  FakeInstance,
  FakeInstanceOptions,
  FetchHost,
  FetchLike,
} from "./instance.js";
export {
  DEFAULT_UNKNOWN_QUERY_FIELD,
  applyUnknownFieldPolicy,
  fieldValue,
  matchCondition,
  matchQuery,
  parseQuery,
  sortRecords,
} from "./query.js";
export type {
  MatchSemantics,
  ParsedQuery,
  QueryCondition,
  QueryOperator,
  QuerySemantics,
  QuerySort,
  UnknownQueryFieldMode,
} from "./query.js";
export {
  RESERVED_FIELDS,
  coerceField,
  coerceRecord,
  projectFields,
  setOwn,
} from "./record.js";
export type { SnRecord, StoredRecord } from "./record.js";
export { DEFAULT_CICD_SUITE_PARAMS, createRouter } from "./router.js";
export type {
  FakeRequest,
  FakeResponse,
  FakeRouter,
  FakeStatsCountOptions,
  RecordedRequest,
  RouterDeps,
} from "./router.js";
export { DEFAULT_TABLE_LIMIT, createTableStore } from "./tables.js";
export type {
  FakeTableStore,
  LocatedRecord,
  TableQueryOptions,
  TableQueryResult,
  TableStoreDeps,
} from "./tables.js";
