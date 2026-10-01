// QA-18 — the CI/CD (ATF) run lifecycle.
//
// Shape provenance, so nothing here is silently invented:
//   * DERIVED from `@tessera/sn-client/src/api/atf.ts`: the two endpoints
//     (`POST /api/sn_cicd/testsuite/run` with `sys_id` **or** `test_sys_id` as
//     a *query* parameter, `GET /api/sn_cicd/progress/<executionId>`) and the
//     payload fields the client actually reads —
//     `result.{status,status_label,status_message,percent_complete}` and
//     `result.links.progress.{id,url}`.
//   * FROM THE PUBLIC CI/CD API DOCS (not verifiable from this repo, marked as
//     such): the numeric `status` codes 0/1/2/3/4 with labels Pending/Running/
//     Successful/Failed/Canceled, and the `links.results` block a completed
//     testsuite run carries. `sn-client` ignores `links.results`, but
//     `@tessera/runner-atf` joins `sys_atf_test_result.test_suite_result` on
//     its id (F1), so `recordTestResult` writes that column and
//     `emitResultsLink`/`withholdResultsLink` model a payload without it.
//   * GUESSED: the `sys_atf_test_suite_result` column set the fake writes
//     (`test_suite`, `test`, `status`, `run_id`, `start_time`, `end_time`).
//     The table and the `test_suite`/`status` columns are real; the exact
//     column names of the rest are a best guess and must be reconciled against
//     a live capture before any assertion depends on them.
//
// The suite-result row exists for DESIGN §4b: the sweep "first queries the
// instance-side suite-run state (the CI/CD execution record for its runId) and
// refuses to delete while that run is non-terminal". Without a queryable row
// that rule is untestable.

import type { FakeClock } from "./clock.js";
import type { IdGenerator } from "./ids.js";
import type { FakeTableStore } from "./tables.js";

export type CicdRunState =
  "pending" | "running" | "successful" | "failed" | "canceled";

/** Terminal states — the sweep may only reclaim a run that reached one. */
export const TERMINAL_CICD_STATES: ReadonlySet<CicdRunState> =
  new Set<CicdRunState>(["successful", "failed", "canceled"]);

/** Public CI/CD status codes and labels (see the provenance note above). */
const STATUS_CODES: Readonly<Record<CicdRunState, string>> = {
  pending: "0",
  running: "1",
  successful: "2",
  failed: "3",
  canceled: "4",
};

const STATUS_LABELS: Readonly<Record<CicdRunState, string>> = {
  pending: "Pending",
  running: "Running",
  successful: "Successful",
  failed: "Failed",
  canceled: "Canceled",
};

export interface CicdRun {
  executionId: string;
  /** `sys_id` query param of `testsuite/run`. */
  suiteSysId?: string;
  /** `test_sys_id` query param of `testsuite/run`. */
  testSysId?: string;
  /** §4a run-id tag, when the caller passed one (see `runIdParam`). */
  runId?: string;
  state: CicdRunState;
  /** Number of progress polls served so far. */
  polls: number;
  percentComplete: number;
  /** `sys_id` of the suite-result row this run maintains. */
  resultSysId: string;
  startedAt: string;
  endedAt?: string;
}

/** The `result` envelope of both CI/CD endpoints. */
export interface CicdProgressPayload {
  status: string;
  status_label: string;
  status_message: string;
  status_detail: string;
  percent_complete: string;
  links: {
    progress: { id: string; url: string };
    results?: { id: string; url: string };
  };
}

export interface CicdOptions {
  /**
   * Progress polls served before the run reaches its terminal state. The
   * lifecycle is therefore fully deterministic: poll count, not elapsed time,
   * drives it. Default 2 (pending -> running -> terminal).
   */
  pollsToComplete?: number;
  /** Terminal state for a suite with no explicit outcome. Default "successful". */
  defaultOutcome?: CicdRunState;
  /** Table the suite-run state is written to. */
  resultTable?: string;
  /** Host used to build `links.*.url`. */
  host?: string;
  /**
   * Query parameter carrying the §4a run id on `testsuite/run`. Not part of the
   * real CI/CD API — the fake accepts it so a Tier-2 scenario can tag its runs
   * without a table write. Default "tessera_run_id".
   */
  runIdParam?: string;
  /**
   * Table `recordTestResult` writes per-test rows to. Default
   * "sys_atf_test_result".
   */
  testResultTable?: string;
  /**
   * Emit `links.results` on a terminal payload. Default true. False models an
   * execution that ends (partial, canceled, or a release that simply omits
   * it) without naming its `sys_atf_test_suite_result` — the case a runner
   * must treat as "missing", never as "join to whatever rows exist".
   */
  emitResultsLink?: boolean;
}

/** One per-test outcome row, as a real instance writes it when a test ends. */
export interface TestResultFields {
  test: string;
  status: string;
  output: string;
  /**
   * The `sys_atf_test_suite_result` row to link to instead of the run's own
   * (root) one — a test that ran inside a nested child suite. It must be the
   * run's root row or a row written by {@link FakeCicd.recordChildSuiteResult}
   * for the same run; anything else throws.
   */
  suiteResultSysId?: string;
}

/** A nested child suite's execution row (see `recordChildSuiteResult`). */
export interface ChildSuiteResultArgs {
  /**
   * The parent `sys_atf_test_suite_result` sys_id. Default: the run's own
   * (root) suite-result row. Must be the root or an earlier child of the
   * same run; anything else throws.
   */
  parent?: string;
  /** `test_suite` of the child row (the child `sys_atf_test_suite`). */
  suiteSysId?: string;
}

/**
 * The column a nested child suite's `sys_atf_test_suite_result` row points at
 * its parent execution with (DERIVED: the ATF data model links a child suite
 * result to its parent via `parent`; not yet reconciled against a live
 * capture).
 */
export const SUITE_RESULT_PARENT_FIELD = "parent";

export interface StartRunArgs {
  suiteSysId?: string;
  testSysId?: string;
  runId?: string;
}

export interface FakeCicd {
  /** `POST /api/sn_cicd/testsuite/run` — starts a run, returns it pending. */
  start(args: StartRunArgs): CicdRun;
  /** `GET /api/sn_cicd/progress/<id>` — advances the lifecycle by one poll. */
  poll(executionId: string): CicdRun | undefined;
  /** Read without advancing (assertions, sweep liveness probes). */
  peek(executionId: string): CicdRun | undefined;
  /** Pin the terminal state of runs for one suite/test sys_id. */
  setOutcome(sysId: string, outcome: CicdRunState): void;
  /**
   * Write one `sys_atf_test_result` row linked (`test_suite_result`) to the
   * run's suite-result row — the join key the terminal payload names as
   * `links.results.id`. Throws for an unknown execution id.
   */
  recordTestResult(
    executionId: string,
    fields: TestResultFields,
  ): Record<string, string>;
  /**
   * Write one nested child suite's `sys_atf_test_suite_result` row for this
   * run, linked to its parent execution row via `parent` — how a real
   * instance records a child suite of the triggered suite. Returns the row;
   * link per-test rows to it with `recordTestResult`'s `suiteResultSysId`.
   * Throws for an unknown execution id or a parent outside this run.
   */
  recordChildSuiteResult(
    executionId: string,
    args?: ChildSuiteResultArgs,
  ): Record<string, string>;
  /**
   * Suppress `links.results` on this run's terminal payload (per-run form of
   * `emitResultsLink: false`). False for an unknown execution id.
   */
  withholdResultsLink(executionId: string): boolean;
  /** Force a run terminal without further polling (models an abort). */
  cancel(executionId: string): boolean;
  /** Every run, in start order. */
  runs(): CicdRun[];
  /** Render the wire payload `sn-client`'s `toRun()` parses. */
  payload(run: CicdRun): CicdProgressPayload;
  clear(): void;
}

export interface CicdDeps {
  tables: FakeTableStore;
  ids: IdGenerator;
  clock: FakeClock;
  options?: CicdOptions;
}

export function createFakeCicd({
  tables,
  ids,
  clock,
  options = {},
}: CicdDeps): FakeCicd {
  const pollsToComplete = Math.max(1, options.pollsToComplete ?? 2);
  const defaultOutcome = options.defaultOutcome ?? "successful";
  const resultTable = options.resultTable ?? "sys_atf_test_suite_result";
  const host = options.host ?? "fake-instance.service-now.com";
  const testResultTable = options.testResultTable ?? "sys_atf_test_result";
  const emitResultsLink = options.emitResultsLink ?? true;

  const runsById = new Map<string, CicdRun>();
  const outcomes = new Map<string, CicdRunState>();
  const linkWithheld = new Set<string>();
  // Delegated decision 2026-09-28 (wave 13): suite-result rows per run (root
  // first), so a child row or a linked test row can only ever point inside
  // its own run — a cross-run link is the very evidence F1 refuses.
  const suiteRowsByRun = new Map<string, string[]>();

  const runWithRows = (executionId: string, what: string): CicdRun => {
    const run = runsById.get(executionId);
    if (!run || run.resultSysId === "") {
      throw new Error(`${what}: no CI/CD run with execution id ${executionId}`);
    }
    return run;
  };

  const assertOwnRow = (
    executionId: string,
    sysId: string,
    what: string,
  ): void => {
    if (!(suiteRowsByRun.get(executionId) ?? []).includes(sysId)) {
      throw new Error(
        `${what}: ${sysId} is not a suite-result row of CI/CD run ${executionId}`,
      );
    }
  };

  const outcomeFor = (run: CicdRun): CicdRunState => {
    const key = run.suiteSysId ?? run.testSysId ?? "";
    return outcomes.get(key) ?? defaultOutcome;
  };

  const syncResultRow = (run: CicdRun): void => {
    tables.update(resultTable, run.resultSysId, {
      status: run.state,
      ...(run.endedAt ? { end_time: run.endedAt } : {}),
    });
  };

  return {
    start({ suiteSysId, testSysId, runId }) {
      const executionId = ids.next("cicd_progress");
      const startedAt = clock.now();
      // The suite-run state row is created up front so a sweep can see a
      // non-terminal instance-side run (§4b) while the run is still going.
      const resultRow = tables.insert(resultTable, {
        test_suite: suiteSysId ?? "",
        test: testSysId ?? "",
        status: "pending",
        run_id: runId ?? "",
        execution_id: executionId,
        start_time: startedAt,
      });
      const run: CicdRun = {
        executionId,
        ...(suiteSysId ? { suiteSysId } : {}),
        ...(testSysId ? { testSysId } : {}),
        ...(runId ? { runId } : {}),
        state: "pending",
        polls: 0,
        percentComplete: 0,
        resultSysId: resultRow["sys_id"] ?? "",
        startedAt,
      };
      runsById.set(executionId, run);
      if (run.resultSysId !== "") {
        suiteRowsByRun.set(executionId, [run.resultSysId]);
      }
      return { ...run };
    },

    poll(executionId) {
      const run = runsById.get(executionId);
      if (!run) return undefined;
      if (TERMINAL_CICD_STATES.has(run.state)) return { ...run };

      run.polls += 1;
      run.percentComplete = Math.min(
        100,
        Math.round((run.polls / pollsToComplete) * 100),
      );
      if (run.polls >= pollsToComplete) {
        run.state = outcomeFor(run);
        run.percentComplete = 100;
        run.endedAt = clock.now();
      } else {
        run.state = "running";
      }
      syncResultRow(run);
      return { ...run };
    },

    peek(executionId) {
      const run = runsById.get(executionId);
      return run ? { ...run } : undefined;
    },

    recordTestResult(executionId, fields) {
      // Delegated decision 2026-09-26: fail closed on an unknown execution —
      // writing an unlinked (or guessed-link) row would be exactly the
      // cross-run evidence the runner's F1 join exists to refuse.
      const run = runWithRows(executionId, "recordTestResult");
      const link = fields.suiteResultSysId ?? run.resultSysId;
      assertOwnRow(executionId, link, "recordTestResult");
      return tables.insert(testResultTable, {
        test: fields.test,
        status: fields.status,
        output: fields.output,
        test_suite_result: link,
      });
    },

    recordChildSuiteResult(executionId, args = {}) {
      const run = runWithRows(executionId, "recordChildSuiteResult");
      const parent = args.parent ?? run.resultSysId;
      assertOwnRow(executionId, parent, "recordChildSuiteResult");
      const row = tables.insert(resultTable, {
        test_suite: args.suiteSysId ?? "",
        test: "",
        status: run.state,
        run_id: run.runId ?? "",
        start_time: clock.now(),
        [SUITE_RESULT_PARENT_FIELD]: parent,
      });
      suiteRowsByRun.get(executionId)?.push(row["sys_id"] ?? "");
      return row;
    },

    withholdResultsLink(executionId) {
      if (!runsById.has(executionId)) return false;
      linkWithheld.add(executionId);
      return true;
    },

    setOutcome(sysId, outcome) {
      outcomes.set(sysId, outcome);
    },

    cancel(executionId) {
      const run = runsById.get(executionId);
      if (!run || TERMINAL_CICD_STATES.has(run.state)) return false;
      run.state = "canceled";
      run.percentComplete = 100;
      run.endedAt = clock.now();
      syncResultRow(run);
      return true;
    },

    runs() {
      return [...runsById.values()].map((run) => ({ ...run }));
    },

    payload(run) {
      const terminal = TERMINAL_CICD_STATES.has(run.state);
      const withResults =
        terminal && emitResultsLink && !linkWithheld.has(run.executionId);
      return {
        status: STATUS_CODES[run.state],
        status_label: STATUS_LABELS[run.state],
        status_message: terminal
          ? `Test suite execution ${run.state}`
          : "Test suite execution in progress",
        status_detail: "",
        percent_complete: String(run.percentComplete),
        links: {
          progress: {
            id: run.executionId,
            url: `https://${host}/api/sn_cicd/progress/${run.executionId}`,
          },
          ...(withResults
            ? {
                results: {
                  id: run.resultSysId,
                  url: `https://${host}/api/sn_cicd/testsuite/results/${run.resultSysId}`,
                },
              }
            : {}),
        },
      };
    },

    clear() {
      runsById.clear();
      outcomes.clear();
      linkWithheld.clear();
      suiteRowsByRun.clear();
    },
  };
}
