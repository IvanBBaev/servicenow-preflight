// ═══════════════════════════════════════════════════════════════════════════
// @tessera/phase05 — the PLAN Phase 0.5 walking-skeleton ADAPTERS.
//
// WHAT THIS PACKAGE IS NOW: a bag of deliberately hardcoded adapters — a
// resolver, a test store, an ATF runner, a provisioner, a reporter and a probe
// — that each know exactly one Script Include, one spec and one assertion set.
// Nothing here is general, and nothing here is meant to be extended.
//
// WHAT IT IS NO LONGER: a composition root. The ARCH-1 exception PLAN Phase 0.5
// granted this package — "`runSkeleton` may hand-wire its four adapters,
// because the skeleton must prove the SEAMS before anything general is built on
// them" — IS DISCHARGED. Phase 1 landed `@tessera/cli`, the one place in the
// workspace that wires adapters into ports, and `runSkeleton`, the `tess` CLI
// and every hand-wiring line moved there. This package now exports adapters and
// nothing else; it registers them nowhere and knows about no pipeline.
//
// It still exists rather than being deleted for one reason: `tess run
// --skeleton` is frozen, not retired. The Phase-0.5 end-to-end proof — guard →
// ledger → resolve → project → run → read → verdict → teardown against a real
// instance — stays runnable while Phases 2–8 build the general adapters that
// will eventually replace these. When the last of them lands, this package goes
// with it.
//
// ARCH-3 (single mutation channel) was never excepted: every write below goes
// through `@tessera/sn-client`, whose transport calls the DEV-24 write gate and
// the DEV-15 journal.
//
// A DOCUMENTED FORK (delegated decision 2026-09-23: it stays a fork until it
// is retired, it does not fold into its siblings before v1.0). Eight
// capabilities here are re-implementations; the canonical, better-tested
// version of each lives elsewhere, and a fix on one side does NOT propagate
// to the other — the capped-read "N matches" defect fixed here on 2026-09-08
// had already been solved honestly in `@tessera/resolvers`. Before changing
// any of these, check whether the canonical sibling already has the fix:
//   1. tier2.ts (ATF execution substrate)  → @tessera/fake-instance
//   2. testStore.ts (spec projection)      → @tessera/teststore-atf
//   3. runner.ts (ATF trigger/poll/read)    → @tessera/runner-atf
//   4. fixtures.ts + spec.ts (the spec)     → @tessera/specs
//   5. guardAudit.ts + probe.ts (guard)     → @tessera/guard
//   6. resolver.ts (target resolution)      → @tessera/resolvers
//   7. provisioner.ts (instance prep)       → @tessera/provisioner
//   8. snRecords.ts (record field reads)    → @tessera/sn-client
// ═══════════════════════════════════════════════════════════════════════════

export {
  ATF_RUNNER_ENABLED_PROPERTY,
  ATF_TABLES,
  CICD_TESTSUITE_RUN_PATH,
  RUN_SERVER_SIDE_SCRIPT_STEP_CONFIG,
  SCRIPT_INCLUDE_TABLE,
  STEP_INPUT_DOCUMENT,
  SUITE_TRIGGER_PARAM_NAMES,
  SYS_PROPERTIES_TABLE,
  TERMINAL_CICD_STATUS_CODES,
  TERMINAL_CICD_STATUS_LABEL,
  TERMINAL_SUITE_RESULT_STATUSES,
  TEST_RESULT_STATUS_FAIL,
  TEST_RESULT_STATUS_PASS,
  TEST_SCRIPT_INPUT_VARIABLE,
} from "./atf.js";
export {
  STEP_ERROR_PREFIX,
  failedAssertionNames,
  formatAssertionLine,
  formatAtfOutput,
  parseAssertionOutput,
} from "./atfOutput.js";
export type { AssertionOutcome, ParsedAtfOutput } from "./atfOutput.js";
export {
  SkeletonCancelledError,
  SkeletonError,
  SkeletonInfrastructureError,
  SkeletonUnsupportedActionError,
} from "./errors.js";
export {
  S5_ASSERTION_COUNT,
  S5_GENERATED_TEST_SCRIPT,
  S5_SPEC_ID,
  S5_SPEC_PATH,
  S5_TARGET_API_NAME,
  S5_TARGET_CORRECT_SOURCE,
  S5_TARGET_MUTANT_SOURCE,
  S5_TARGET_NAME,
  S5_THRESHOLD_ASSERTION,
} from "./fixtures.js";
export { createLedgerGuardAuditSink } from "./guardAudit.js";
export type {
  AcknowledgeProdFieldParity,
  LedgerGuardAuditSink,
} from "./guardAudit.js";
export { PRODUCTION_PROPERTY, createInstanceProbe } from "./probe.js";
export { createS5Provisioner } from "./provisioner.js";
export type { S5ProvisionerOptions } from "./provisioner.js";
export { createCollectingReporter } from "./reporter.js";
export type { CollectingReporter, FailedAssertion } from "./reporter.js";
export { createS5Resolver } from "./resolver.js";
export type { S5ResolverOptions } from "./resolver.js";
export { createS5Runner } from "./runner.js";
export type { AtfAttribution, S5RunnerOptions } from "./runner.js";
export { readField, requireField, requireSysId } from "./snRecords.js";
export type { SnRecordLike } from "./snRecords.js";
export { S5_ASSERTION_NAMES, createS5Spec, isS5AtfPayload } from "./spec.js";
export type { S5AtfPayload } from "./spec.js";
export { SkeletonNonTerminalRunError, createS5TestStore } from "./testStore.js";
export type {
  CreatedRecord,
  S5TestStore,
  S5TestStoreOptions,
} from "./testStore.js";
export {
  FAKE_HOST,
  createAtfExecutionEngine,
  installAtfExecutionEngine,
  seedS5Instance,
} from "./tier2.js";
export type {
  AtfExecutionEngineOptions,
  FetchHost,
  S5SeedOptions,
  S5Variant,
  Tier2Cicd,
  Tier2Substrate,
  Tier2Tables,
} from "./tier2.js";
