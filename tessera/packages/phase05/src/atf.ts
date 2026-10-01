// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// ATF record shapes. PROVENANCE MATTERS HERE: every constant below is tagged
// with where it came from, so a later phase can tell proven ground from a
// placeholder. Nothing in this file was invented silently.
//
// [S0]  = SPIKE-FINDINGS.md, Spike 0 "programmatic ATF authoring" (2026-07-02),
//         including the DR-1 correction (the step table is `sys_atf_step`, NOT
//         `sys_atf_test_step_config`) and the two hardcoded catalog sys_ids.
// [S2b] = SPIKE-FINDINGS.md, Spike 2b "per-test result attribution".
// [DEV] = a numbered design decision in DESIGN.md / PLAN.md.
// [SNC] = derived from @tessera/sn-client (the canonical transport, ARCH-7/18).
// [OPEN]= NOT established by the spikes or by sn-client. Flagged, never relied
//         on for correctness without a fallback.

/** Tables the projection/attribution path touches. */
export const ATF_TABLES = {
  /** [S0] the test definition. */
  test: "sys_atf_test",
  /** [S0/DR-1] the step. `sys_atf_test_step_config` in DESIGN was wrong. */
  step: "sys_atf_step",
  /** [S0] read-only step-type catalog. */
  stepConfig: "sys_atf_step_config",
  /** [S0] a step's input values. Table-API-writable only on some instances. */
  stepInput: "sys_variable_value",
  /** [S0] input-variable definitions of a step type. */
  inputVariable: "atf_input_variable",
  /** [S0] the suite. */
  suite: "sys_atf_test_suite",
  /** [S0/DEV-19] the ONLY way a suite contains a test. */
  suiteTest: "sys_atf_test_suite_test",
  /** [S2b] per-test results — the attribution source. */
  testResult: "sys_atf_test_result",
  /** [S2b/§4b] per-suite run state — the ARCH-28 terminal-state probe. */
  suiteResult: "sys_atf_test_suite_result",
} as const;

/** [S0] "Run Server Side Script" step config, global scope. */
export const RUN_SERVER_SIDE_SCRIPT_STEP_CONFIG =
  "41de4a935332120028bc29cac2dc349a";

/** [S0] the "Test script" input-variable definition of that step type. */
export const TEST_SCRIPT_INPUT_VARIABLE = "989d9e235324220002c6435723dc3484";

/** [S0] `sys_variable_value.document` value for an ATF step's inputs. */
export const STEP_INPUT_DOCUMENT = ATF_TABLES.step;

/**
 * [DR-3] must be `true` before any ATF run.
 *
 * Delegated decision 2026-10-01 (wave 17): declared once in `@tessera/types`
 * (beside `SYS_PROPERTIES_TABLE`) and re-exported here under its old name, so
 * this skeleton and `@tessera/doctor` cannot read the runner under two names.
 */
export { ATF_RUNNER_ENABLED_PROPERTY } from "@tessera/types";

// Delegated decision 2026-09-30 (wave 16): declared once in `@tessera/types`
// (with the property read limits) and re-exported here under its old name.
export { SYS_PROPERTIES_TABLE } from "@tessera/types";
export const SCRIPT_INCLUDE_TABLE = "sys_script_include";

/** [S0/DEV-8/DR-2] the only run endpoint — suites only, no single-test run. */
export const CICD_TESTSUITE_RUN_PATH = "/api/sn_cicd/testsuite/run";

/**
 * [S0/DEV-14] the trigger parameter the real CI/CD API honours is
 * `test_suite_sys_id` — NOT the undocumented `sys_id` that
 * `@tessera/sn-client`'s `atfApi.runAtfSuite` sends and that
 * `@tessera/fake-instance`'s router keys on. Until those two agree with
 * DEV-14, the Runner sends BOTH names carrying the same value: the canonical
 * one so a live instance is driven correctly, the alias so the vendored client
 * and the Tier-2 fake see a request they understand. A real instance ignores
 * an unknown query parameter, so the alias is inert there.
 */
export const SUITE_TRIGGER_PARAM_NAMES: readonly string[] = [
  "test_suite_sys_id",
  "sys_id",
];

/**
 * [S2b] `sys_atf_test_result.status`. The spike established the two values a
 * finished per-test row carries; anything else is treated as an adapter-level
 * error rather than silently scored.
 */
export const TEST_RESULT_STATUS_PASS = "success";
export const TEST_RESULT_STATUS_FAIL = "failure";

/**
 * [SNC + public CI/CD docs] terminal progress states. `status` is the numeric
 * code, `status_label` the human label; the skeleton accepts either, exactly
 * as the S5 probe loop did (`status === "2" || "3" || /Successful|Failed|
 * Cancel/i.test(status_label)`), plus "4"/Canceled for completeness.
 */
export const TERMINAL_CICD_STATUS_CODES: ReadonlySet<string> = new Set([
  "2",
  "3",
  "4",
]);
export const TERMINAL_CICD_STATUS_LABEL = /successful|failed|cancel/i;

/**
 * [OPEN] `sys_atf_test_suite_result.status` vocabulary on a LIVE instance is
 * unconfirmed — `@tessera/fake-instance` writes its own `CicdRunState` names
 * and its provenance block marks every column past `test_suite`/`status` as
 * GUESSED. The set below is therefore read FAIL-CLOSED: teardown deletes only
 * when a status is explicitly recognised as terminal; anything unknown is
 * treated as "still running" and the records are left for the orphan sweep
 * (§4a/DEV-17 — never delete under a non-terminal run).
 */
export const TERMINAL_SUITE_RESULT_STATUSES: ReadonlySet<string> = new Set([
  // @tessera/fake-instance vocabulary
  "successful",
  "failed",
  "canceled",
  // plausible live vocabularies, accepted so a live run is not stranded
  "cancelled",
  "success",
  "failure",
  "complete",
  "completed",
  // numeric CI/CD codes
  "2",
  "3",
  "4",
]);
