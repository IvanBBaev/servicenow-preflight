// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// THE TIER-2 ATF EXECUTION SUBSTRATE.
//
// WHY THIS FILE EXISTS AT ALL (cross-package gap, reported not fixed):
// `@tessera/fake-instance` models the CI/CD lifecycle but EXECUTES NOTHING — it
// advances a poll counter to a pinned outcome and writes a `sys_atf_test_result`
// row only when a test calls `cicd.recordTestResult` (linked to the run's suite
// result, 2026-09-26). A green/red pair driven by that fake would prove
// only that the pipeline can carry a preconfigured answer; the red run would be
// red because a test told it to be, not because the source under test is wrong.
//
// So this module supplies the missing half: it wraps the fake's `fetch`, and on
// `POST /api/sn_cicd/testsuite/run` it walks the projected records the way a
// real instance would (suite → suite-test links → tests → steps → the step's
// script input), evaluates the ATF step script against the CURRENT
// `sys_script_include.script` bytes in `node:vm`, writes a real
// `sys_atf_test_result` row linked to this execution's suite result
// (`test_suite_result`, as runner-atf requires), and pins the suite outcome from what it observed.
// Green vs red is therefore genuinely derived from the target source: swap
// `>=` for `>` in the seeded Script Include and the threshold assertion goes
// red on its own.
//
// WHERE IT BELONGS: in `@tessera/fake-instance`, next to `cicd.ts`. It lives
// here only because this task may not modify that package. Moving it is a file
// move plus re-export — nothing in the skeleton's production path imports it
// (the CLI reaches it through a dynamic import behind `--fake`).
//
// It is dev/test scaffolding, never shipped behaviour: `substrate` is a
// structural interface so this file has no static dependency on the dev-only
// `@tessera/fake-instance` package.

import { createContext, runInContext } from "node:vm";

import { PRODUCTION_PROPERTY } from "@tessera/types";

import {
  ATF_TABLES,
  ATF_RUNNER_ENABLED_PROPERTY,
  SCRIPT_INCLUDE_TABLE,
  STEP_INPUT_DOCUMENT,
  SYS_PROPERTIES_TABLE,
  TEST_RESULT_STATUS_FAIL,
  TEST_RESULT_STATUS_PASS,
  TEST_SCRIPT_INPUT_VARIABLE,
} from "./atf.js";
import {
  formatAtfOutput,
  STEP_ERROR_PREFIX,
  type AssertionOutcome,
} from "./atfOutput.js";
import {
  S5_TARGET_API_NAME,
  S5_TARGET_CORRECT_SOURCE,
  S5_TARGET_MUTANT_SOURCE,
  S5_TARGET_NAME,
} from "./fixtures.js";

// ── substrate seam ──────────────────────────────────────────────────────────

/** Rows as the fake stores them: the Table API stringifies every field. */
type StoredRow = Record<string, string>;

export interface Tier2Tables {
  insert(
    table: string,
    fields: Record<string, unknown>,
    sysId?: string,
  ): StoredRow;
  get(table: string, sysId: string): StoredRow | undefined;
  all(table: string): StoredRow[];
}

export interface Tier2Cicd {
  setOutcome(sysId: string, outcome: "successful" | "failed"): void;
  /**
   * Read a run without advancing it. `resultSysId` is the run's
   * `sys_atf_test_suite_result` sys_id — the `links.results.id` its terminal
   * payload names, and the `test_suite_result` every per-test row of THIS
   * execution must carry (runner-atf F1 joins on it).
   */
  peek(executionId: string): { resultSysId: string } | undefined;
}

/**
 * The slice of `FakeInstance` this engine needs. Methods use method syntax on
 * purpose — bivariant parameters keep the real `FakeInstance` assignable
 * without importing its types.
 */
export interface Tier2Substrate {
  readonly tables: Tier2Tables;
  readonly cicd: Tier2Cicd;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

// ── seed ────────────────────────────────────────────────────────────────────

/**
 * Host the `--fake` harness binds to: allowlistable and heuristic-clean.
 *
 * It lives beside the substrate rather than in the CLI because it is a property
 * of the fake, not of the command that starts it — the guard heuristics must
 * keep reading it as non-prod, and that constraint belongs next to the thing it
 * constrains.
 */
export const FAKE_HOST = "dev-skeleton.service-now.com";

/** Which half of the reviewed seeded-bug pair to seed. */
export type S5Variant = "correct" | "mutant";

export interface S5SeedOptions {
  readonly variant?: S5Variant;
  /** Seed `sn_atf.runner.enabled` false to exercise the DR-3 refusal. */
  readonly atfRunnerEnabled?: boolean;
  /** Seed `glide.installation.production` true to exercise §11.2 downgrade. */
  readonly productionProperty?: boolean;
}

/**
 * The starting state of the instance under test: one Script Include (the
 * artifact the resolver finds) plus the two `sys_properties` rows the
 * provisioner and the guard probe read. No ATF records — those are what the
 * run projects.
 */
export function seedS5Instance(
  options: S5SeedOptions = {},
): Record<string, Record<string, unknown>[]> {
  const variant = options.variant ?? "correct";
  return {
    [SCRIPT_INCLUDE_TABLE]: [
      {
        name: S5_TARGET_NAME,
        api_name: S5_TARGET_API_NAME,
        sys_scope: "global",
        active: "true",
        script:
          variant === "mutant"
            ? S5_TARGET_MUTANT_SOURCE
            : S5_TARGET_CORRECT_SOURCE,
      },
    ],
    [SYS_PROPERTIES_TABLE]: [
      {
        name: ATF_RUNNER_ENABLED_PROPERTY,
        value: String(options.atfRunnerEnabled ?? true),
      },
      {
        name: PRODUCTION_PROPERTY,
        value: String(options.productionProperty ?? false),
      },
    ],
  };
}

// ── execution engine ────────────────────────────────────────────────────────

export interface AtfExecutionEngineOptions {
  /**
   * Fail every step with this message instead of executing it — models an ATF
   * runtime fault (used to prove the DEV-1 error path).
   */
  readonly forceStepError?: string;
}

interface RequestShape {
  method: string;
  url: URL;
}

function describeRequest(
  input: string | URL | Request,
  init?: RequestInit,
): RequestShape {
  if (typeof input === "string") {
    return {
      method: (init?.method ?? "GET").toUpperCase(),
      url: new URL(input),
    };
  }
  if (input instanceof URL) {
    return { method: (init?.method ?? "GET").toUpperCase(), url: input };
  }
  return {
    method: (init?.method ?? input.method).toUpperCase(),
    url: new URL(input.url),
  };
}

/**
 * Wrap a fake instance's `fetch` so a suite trigger actually executes its
 * tests. Returns a `fetch` with the same signature; everything except the
 * trigger endpoint is delegated untouched.
 */
export function createAtfExecutionEngine(
  substrate: Tier2Substrate,
  options: AtfExecutionEngineOptions = {},
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  const tables = substrate.tables;

  const rowsWhere = (
    table: string,
    field: string,
    value: string,
  ): StoredRow[] => tables.all(table).filter((row) => row[field] === value);

  /** The `sys_variable_value` row holding a step's script (Spike 0/DR-1). */
  const scriptForStep = (stepSysId: string): string | undefined => {
    const row = tables
      .all(ATF_TABLES.stepInput)
      .find(
        (candidate) =>
          candidate["document_key"] === stepSysId &&
          candidate["variable"] === TEST_SCRIPT_INPUT_VARIABLE &&
          (candidate["document"] ?? STEP_INPUT_DOCUMENT) ===
            STEP_INPUT_DOCUMENT,
      );
    return row?.["value"];
  };

  /** Every Script Include on the instance, in scope for a server-side step. */
  const scriptIncludeSources = (): string[] =>
    tables
      .all(SCRIPT_INCLUDE_TABLE)
      .map((row) => row["script"] ?? "")
      .filter((source) => source !== "");

  const executeSuite = (suiteSysId: string, resultSysId: string): void => {
    const testSysIds = rowsWhere(ATF_TABLES.suiteTest, "test_suite", suiteSysId)
      .map((link) => link["test"] ?? "")
      .filter((sysId) => sysId !== "");

    let suitePassed = true;

    for (const testSysId of testSysIds) {
      const steps = rowsWhere(ATF_TABLES.step, "test", testSysId).sort(
        (a, b) => Number(a["order"] ?? "0") - Number(b["order"] ?? "0"),
      );

      const outcomes: AssertionOutcome[] = [];
      let stepError: string | undefined;

      for (const step of steps) {
        const stepSysId = step["sys_id"] ?? "";
        const script = scriptForStep(stepSysId);
        if (script === undefined) {
          stepError = `${STEP_ERROR_PREFIX} step ${stepSysId} has no script input`;
          break;
        }
        const run = runStepScript(
          script,
          scriptIncludeSources(),
          options.forceStepError,
        );
        outcomes.push(...run.assertions);
        if (run.error !== undefined) {
          stepError = `${STEP_ERROR_PREFIX} ${run.error}`;
          break;
        }
      }

      // `every()` is vacuously true for a test that asserted nothing, and
      // that is deliberate here: this substrate mimics a real instance, which
      // marks such a test "success" too. The Runner is where an empty
      // outcome set is refused as a pass (runner.ts `toOutcome`, QA-9).
      const passed =
        stepError === undefined && outcomes.every((outcome) => outcome.passed);
      if (!passed) suitePassed = false;

      // A real instance writes this row when the test finishes; the fake's
      // poll counter is what makes the run "finish", so the row is written at
      // trigger time. The Runner only ever reads it after a terminal poll, so
      // the ordering is unobservable to the code under test.
      tables.insert(ATF_TABLES.testResult, {
        test: testSysId,
        // Linked to THIS execution's suite-result row, as a real instance
        // does; runner-atf refuses unlinked or foreign-linked rows (F1).
        test_suite_result: resultSysId,
        status: passed ? TEST_RESULT_STATUS_PASS : TEST_RESULT_STATUS_FAIL,
        output: formatAtfOutput(outcomes, stepError),
      });
    }

    substrate.cicd.setOutcome(
      suiteSysId,
      suitePassed ? "successful" : "failed",
    );
  };

  /**
   * The suite-result sys_id of the execution a trigger response started.
   * Reads a clone so the caller still gets an unconsumed body.
   *
   * Delegated decision 2026-09-26: fail closed — a trigger whose execution id
   * or suite-result row cannot be established throws rather than executing
   * the suite, so no `sys_atf_test_result` row is ever written unlinked.
   */
  const resultSysIdOf = async (response: Response): Promise<string> => {
    let executionId: unknown;
    try {
      const body = (await response.clone().json()) as {
        result?: { links?: { progress?: { id?: unknown } } };
      };
      executionId = body.result?.links?.progress?.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `tier-2 ATF engine: trigger response is not a CI/CD payload (${message}); refusing to write unlinked sys_atf_test_result rows`,
        { cause: error },
      );
    }
    if (typeof executionId !== "string" || executionId === "") {
      throw new Error(
        "tier-2 ATF engine: trigger response carries no result.links.progress.id; refusing to write unlinked sys_atf_test_result rows",
      );
    }
    const resultSysId = substrate.cicd.peek(executionId)?.resultSysId;
    if (typeof resultSysId !== "string" || resultSysId === "") {
      throw new Error(
        `tier-2 ATF engine: no suite-result row for execution ${executionId}; refusing to write unlinked sys_atf_test_result rows`,
      );
    }
    return resultSysId;
  };

  return async (input, init) => {
    const { method, url } = describeRequest(input, init);
    const isTrigger =
      method === "POST" && url.pathname.endsWith("/api/sn_cicd/testsuite/run");

    // Delegate first: the fake mints the execution id and the suite-result row.
    const response = await substrate.fetch(input, init);
    if (isTrigger && response.ok) {
      const suiteSysId =
        url.searchParams.get("sys_id") ??
        url.searchParams.get("test_suite_sys_id");
      if (suiteSysId !== null && suiteSysId !== "") {
        executeSuite(suiteSysId, await resultSysIdOf(response));
      }
    }
    return response;
  };
}

/** Anything holding a swappable `fetch` — `globalThis` by default. */
export interface FetchHost {
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/**
 * Swap the execution-wrapped `fetch` into `host`; returns the restorer. Use
 * this INSTEAD of `FakeInstance.install()`, which would install the bare fake
 * and therefore execute nothing.
 */
export function installAtfExecutionEngine(
  substrate: Tier2Substrate,
  options: AtfExecutionEngineOptions = {},
  host?: FetchHost,
): () => void {
  const holder: FetchHost = host ?? globalThis;
  const previous = holder.fetch;
  holder.fetch = createAtfExecutionEngine(substrate, options);
  return () => {
    holder.fetch = previous;
  };
}

// ── the sandbox ─────────────────────────────────────────────────────────────

interface StepScriptRun {
  assertions: AssertionOutcome[];
  error?: string;
}

/**
 * Evaluate one "Run Server Side Script" step body. The sandbox provides the
 * ATF step signature (`outputs, steps, params, stepResult, assertEqual`), a
 * `Class.create()` shim, and a `gs` stub — the small slice of the ServiceNow
 * server API the s5-probe fixture touches. Anything else the script reaches
 * for is an honest ReferenceError, surfaced as a step error.
 */
function runStepScript(
  stepScript: string,
  scriptIncludeSources: readonly string[],
  forceStepError?: string,
): StepScriptRun {
  if (forceStepError !== undefined) {
    return { assertions: [], error: forceStepError };
  }

  const assertions: AssertionOutcome[] = [];

  const assertEqual = (spec: {
    name?: unknown;
    shouldbe?: unknown;
    value?: unknown;
  }): boolean => {
    const name =
      typeof spec.name === "string" && spec.name !== ""
        ? spec.name
        : "(unnamed assertion)";
    const expected = spec.shouldbe;
    const actual = spec.value;
    // ATF compares the rendered values; strict equality first so identical
    // primitives short-circuit, string form second so 900 and "900" agree.
    const passed = expected === actual || String(expected) === String(actual);
    assertions.push({
      name,
      passed,
      ...(passed
        ? {}
        : { detail: `expected ${String(expected)}, got ${String(actual)}` }),
    });
    return passed;
  };

  const sandbox: Record<string, unknown> = {
    Class: {
      create() {
        function Instance(this: Record<string, unknown>): void {
          const initialize = (this as { initialize?: unknown }).initialize;
          if (typeof initialize === "function") {
            (initialize as (...args: unknown[]) => unknown).apply(
              this,
              [] as unknown[],
            );
          }
        }
        return Instance;
      },
    },
    gs: {
      log: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      addInfoMessage: () => undefined,
      addErrorMessage: () => undefined,
      nil: (value: unknown) =>
        value === null || value === undefined || value === "",
    },
    outputs: {},
    steps: () => ({}),
    params: {},
    stepResult: {
      setOutputMessage: () => undefined,
      setFailed: () => undefined,
      setSuccess: () => undefined,
    },
    assertEqual,
  };

  const context = createContext(sandbox);
  try {
    for (const source of scriptIncludeSources) {
      runInContext(source, context, { timeout: 5000 });
    }
    runInContext(stepScript, context, { timeout: 5000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { assertions, error: message };
  }
  return { assertions };
}
