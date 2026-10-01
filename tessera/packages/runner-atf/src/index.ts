// @tessera/runner-atf — PLAN Phase 5, the ATF Runner adapter.
//
// The package surface is deliberately wider than `createAtfRunner`: the
// trigger, the poll loop and the result parser are each independently useful
// (and independently testable), and DR-2 is the standing reminder that an
// adapter only reachable through its port is an adapter whose parts never get
// pinned down. `core` still sees nothing but the `Runner` interface.

export {
  AtfInfrastructureError,
  asRecord,
  createSnAtfClient,
  fieldString,
  requestOrFault,
  toInfrastructureError,
  unwrapResult,
  type AtfFaultOptions,
  type AtfHttpClient,
  type AtfRequest,
  type AtfResponse,
} from "./client.js";

export {
  CICD_TESTSUITE_RUN_PATH,
  SUITE_TRIGGER_ALIAS_PARAM,
  SUITE_TRIGGER_PARAM,
  parseRunHandle,
  triggerSuite,
  type AtfRunHandle,
  type TriggerOptions,
} from "./trigger.js";

export {
  CICD_PROGRESS_PATH_PREFIX,
  DEFAULT_INITIAL_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  DEFAULT_MAX_POLLS,
  TERMINAL_STATUS_CODES,
  TERMINAL_STATUS_LABEL,
  fetchProgress,
  parseProgress,
  pollUntilTerminal,
  type AtfProgress,
  type AtfRunState,
  type PollOptions,
  type PollResult,
  type PollStopReason,
} from "./poll.js";

export {
  ATF_SUITE_RESULT_TABLE,
  ATF_TEST_RESULT_ITEM_TABLE,
  ATF_TEST_RESULT_TABLE,
  MAX_ASSERTION_CHARS,
  MAX_RESULT_ITEMS_PER_RESULT,
  MAX_RESULT_ROWS_PER_TEST,
  MAX_STEP_ITEMS,
  MAX_SUITE_DEPTH,
  MAX_SUITE_RESULTS,
  RESULT_FIELDS,
  RESULT_ITEM_FIELDS,
  RESULT_QUERY_BATCH,
  SUITE_RESULT_FIELDS,
  TABLE_API_PREFIX,
  fetchResultItems,
  fetchSuiteResultTree,
  fetchTestResults,
  mapResultStatus,
  parseSpecResults,
  resolveSuiteTreeCaps,
  sanitizeMessage,
  type AtfResultItemRow,
  type AtfResultRow,
  type ResultOptions,
  type SpecResult,
  type SuiteResultTree,
  type TestIndex,
} from "./results.js";

export {
  ATF_TARGET_TABLE,
  DEFAULT_ATF_KINDS,
  DEFAULT_RUN_DEADLINE_MS,
  createAtfRunner,
  type AtfRunnerOptions,
} from "./atfRunner.js";
