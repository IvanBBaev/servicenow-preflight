// TEMPORARY — PLAN Phase 0.5 walking skeleton (named ARCH-1 exception; README).
//
// The hardcoded TestStore: it authors ONE ATF test through `@tessera/sn-client`
// and tears it down again. Every ordering decision below is a design rule, not
// a preference:
//
//  * DR-1 / Spike 0 — the script body does not live on `sys_atf_test`. A test
//    is `sys_atf_test` + a `sys_atf_step` of the "Run Server Side Script" type
//    + the step's `sys_variable_value` input row that actually holds the
//    script. Three writes, not one.
//  * DEV-8 / DEV-19 — the CI/CD API can only run a SUITE, so a single-test run
//    needs a throwaway `sys_atf_test_suite` plus a `sys_atf_test_suite_test`
//    link. The suite is projected state like everything else and is torn down
//    with the rest.
//  * §4a / ARCH-26 — projected records are EPHEMERAL and namespaced by run id
//    (the `name` prefix), which is both the attribution key and what the
//    W1/W2 orphan probe (`nameSTARTSWITH<runId>`) searches on. Core builds that
//    probe query itself, so the run-id prefix on `sys_atf_test.name` is a
//    contract, not decoration.
//  * DEV-13 — teardown deletes in a pinned order, and only AFTER results were
//    read and flushed. Core guarantees the "after" (it calls `teardown` past
//    the ARCH-24 flush boundary); this file owns the order.
//  * DEV-17 / ARCH-28 — never delete under a non-terminal instance run. The
//    store re-probes `sys_atf_test_suite_result` itself and refuses rather
//    than trusting that core got there legitimately.
//
// SEAM (ARCH-3, Phase 1): every write below goes through `tableApi`, which
// journals (DEV-15) but does not `intend`. Core issues one coarse per-spec
// ledger entry on this store's behalf. When the journalled mutation channel
// lands, each of these calls carries its own intent and the coarse entry goes.

import { specKey, type TestStore } from "@tessera/core";
import type {
  PipelineContext,
  ProjectedRecord,
  ProjectionMap,
  TestSpec,
} from "@tessera/types";
import { tableApi } from "@tessera/sn-client";

import {
  ATF_TABLES,
  RUN_SERVER_SIDE_SCRIPT_STEP_CONFIG,
  STEP_INPUT_DOCUMENT,
  TERMINAL_SUITE_RESULT_STATUSES,
  TEST_SCRIPT_INPUT_VARIABLE,
} from "./atf.js";
import { SkeletonError, SkeletonInfrastructureError } from "./errors.js";
import { isS5AtfPayload } from "./spec.js";
import { readField, requireSysId } from "./snRecords.js";

/** One record the store created, in creation order. */
export interface CreatedRecord {
  readonly table: string;
  readonly sysId: string;
  readonly what: string;
}

export interface S5TestStore extends TestStore {
  /** Creation-order log — the reverse of it is the DEV-13 delete order. */
  created(): readonly CreatedRecord[];
  /** Records this store deleted, in delete order. */
  deleted(): readonly CreatedRecord[];
}

/**
 * DEV-17: the store refused to delete because the instance-side run is not
 * provably terminal. Distinct from an infrastructure fault — nothing is broken,
 * the records are simply left for `cleanup --run` / the orphan sweep.
 */
export class SkeletonNonTerminalRunError extends SkeletonError {}

export interface S5TestStoreOptions {
  /**
   * Descriptive tail of the projected `sys_atf_test.name`. The `<runId>:`
   * namespace prefix is prepended unconditionally — see the ARCH-26 note above.
   */
  readonly testLabel?: string;
  /**
   * Delete the throwaway suite's `sys_atf_test_suite_result` rows too.
   * Default FALSE: those rows are the run's evidence (QA-17/DEV-21), and a
   * teardown that erases its own evidence is not a teardown.
   */
  readonly deleteSuiteResults?: boolean;
}

const DEFAULT_TEST_LABEL = "TesseraS5Target volume discount";

/**
 * Characters that make a run id unsafe to splice into an encoded query.
 *
 * Delegated decision 2026-09-25: mirrors `@tessera/teststore-atf`'s guard —
 * the store does not trust its caller's run-id pattern. `^` joins/ORs terms,
 * `=` and `@` are operator/value syntax, and CR/LF can smuggle a second line
 * past log- and header-oriented tooling. A run id carrying any of them — or an
 * empty one, whose `:` prefix would match foreign rows — is refused before any
 * request (fail closed). Stricter than teststore-atf by one character: a `:`
 * inside the run id is refused too, because run "a" would otherwise own every
 * row of run "a:b" (`a:` prefixes `a:b:`). The ledger's run-id pattern already
 * excludes `:`, so no legitimate run is refused.
 */
const UNSAFE_RUN_ID = /[\^=@:\r\n]/;

function assertSafeRunId(runId: unknown): string {
  if (typeof runId !== "string" || runId === "" || UNSAFE_RUN_ID.test(runId)) {
    throw new SkeletonInfrastructureError(
      `run id ${JSON.stringify(runId)} is not safe to splice into a ServiceNow encoded query (empty, or carries one of ^ = @ : CR LF) — refusing before any request`,
    );
  }
  return runId;
}

/**
 * The run's `name` namespace: `<runId>:`.
 *
 * Delegated decision 2026-09-25: the SAME delimited convention as the
 * canonical `@tessera/teststore-atf` (`${runId}:`). A bare `<runId>` prefix
 * made run "run-1" own "run-10 …" and a user's "run-1-regression …", and the
 * sweep deleted them. A run id never contains `:` (refused above), so
 * `run-1:` never prefixes `run-10:` or `run-1-regression`. Core's W1/W2 probe
 * (`nameSTARTSWITH<runId>`) still matches, since `<runId>:` starts with it.
 */
function runPrefix(runId: string): string {
  return `${runId}:`;
}

export function createS5TestStore(
  options: S5TestStoreOptions = {},
): S5TestStore {
  const testLabel = options.testLabel ?? DEFAULT_TEST_LABEL;
  const created: CreatedRecord[] = [];
  const deleted: CreatedRecord[] = [];
  let suiteSysId: string | undefined;

  const track = (table: string, sysId: string, what: string): string => {
    created.push({ table, sysId, what });
    return sysId;
  };

  /**
   * Spike 0: on a live instance the platform auto-creates the step's input row
   * when the step is inserted, and on some instances that row is NOT writable
   * through the Table API (the S5 probe had to go through a Scripted REST
   * channel). Update-then-create covers both worlds; a failure names the
   * finding instead of surfacing as an opaque 403.
   */
  const installScript = async (
    stepSysId: string,
    script: string,
  ): Promise<void> => {
    const { records } = await tableApi.queryTable({
      table: ATF_TABLES.stepInput,
      query:
        `document=${STEP_INPUT_DOCUMENT}` +
        `^document_key=${stepSysId}` +
        `^variable=${TEST_SCRIPT_INPUT_VARIABLE}`,
      fields: ["sys_id", "value"],
      limit: 2,
    });
    const existing = records[0];
    try {
      if (existing === undefined) {
        const row = await tableApi.createRecord(ATF_TABLES.stepInput, {
          document: STEP_INPUT_DOCUMENT,
          document_key: stepSysId,
          variable: TEST_SCRIPT_INPUT_VARIABLE,
          value: script,
        });
        track(
          ATF_TABLES.stepInput,
          requireSysId(row, "create step input"),
          "step input (test script)",
        );
        return;
      }
      const sysId = requireSysId(existing, "locate step input");
      await tableApi.updateRecord(ATF_TABLES.stepInput, sysId, {
        value: script,
      });
      // Platform-owned row: updated, never created, so it is NOT tracked for
      // deletion — it dies with its step.
    } catch (error) {
      throw new SkeletonInfrastructureError(
        `could not write the ATF step script to ${ATF_TABLES.stepInput} ` +
          `(Spike 0: this row is not Table-API-writable on every instance — ` +
          `a Scripted REST authoring channel is the known workaround)`,
        { cause: error },
      );
    }
  };

  /** DEV-17 probe: is the instance-side suite run provably terminal? */
  const assertSuiteRunTerminal = async (suite: string): Promise<void> => {
    const { records } = await tableApi.queryTable({
      table: ATF_TABLES.suiteResult,
      query: `test_suite=${suite}`,
      fields: ["sys_id", "status"],
      limit: 50,
    });
    for (const row of records) {
      const status = (readField(row, "status") ?? "").toLowerCase();
      // Fail closed: an unrecognised status counts as still running.
      if (!TERMINAL_SUITE_RESULT_STATUSES.has(status)) {
        throw new SkeletonNonTerminalRunError(
          `refusing to tear down: ${ATF_TABLES.suiteResult} ${requireSysId(
            row,
            "suite-result probe",
          )} reads status "${status}", which is not provably terminal ` +
            `(DEV-17 — records are left for the orphan sweep)`,
        );
      }
    }
  };

  const remove = async (record: CreatedRecord): Promise<void> => {
    await tableApi.deleteRecord(record.table, record.sysId);
    deleted.push(record);
  };

  /**
   * §4a/ARCH-37 namespace sweep: anything left in the run's `name` namespace
   * that this process does not remember creating is a W1/W2 orphan (the
   * process died between `intend` and `confirm`). Removing it here is what
   * lets core settle every ledger entry, orphans included.
   */
  const sweepNamespace = async (
    runId: string,
    table: string,
  ): Promise<void> => {
    const prefix = runPrefix(runId);
    const { records } = await tableApi.queryTable({
      table,
      query: `nameSTARTSWITH${prefix}`,
      fields: ["sys_id", "name"],
      limit: 100,
    });
    const known = new Set(
      created.filter((rec) => rec.table === table).map((rec) => rec.sysId),
    );
    for (const row of records) {
      // Delegated decision 2026-09-25: `STARTSWITH` is case-INSENSITIVE on
      // ServiceNow, so the server-side query is only a pre-filter. The
      // case-sensitive `startsWith` here is what attributes a row to this run;
      // a row whose `name` is missing or does not carry the exact prefix is
      // never deleted (fail closed).
      const name = readField(row, "name");
      if (name === undefined || !name.startsWith(prefix)) continue;
      const sysId = requireSysId(row, `namespace sweep of ${table}`);
      if (known.has(sysId)) continue;
      await remove({
        table,
        sysId,
        what: `orphan in run namespace (${name})`,
      });
    }
  };

  return {
    created: () => [...created],
    deleted: () => [...deleted],

    async project(
      ctx: PipelineContext,
      specs: readonly TestSpec[],
    ): Promise<ProjectionMap> {
      if (ctx.lifecycle !== "ephemeral") {
        // §4a: persistent mode needs the manifest + natural-key upsert (DEV-20,
        // QA-25 adoption). Phase 0.5 has neither, and pretending otherwise
        // would leave undeletable records behind under a persistent flag.
        throw new SkeletonInfrastructureError(
          `the Phase 0.5 TestStore only implements the §4a ephemeral lifecycle (got "${ctx.lifecycle}")`,
        );
      }
      const spec = specs[0];
      if (spec === undefined || specs.length !== 1) {
        throw new SkeletonInfrastructureError(
          `the Phase 0.5 TestStore projects exactly one hardcoded spec (got ${specs.length})`,
        );
      }
      if (!isS5AtfPayload(spec.payload)) {
        throw new SkeletonInfrastructureError(
          `spec ${spec.ref.id} carries no ATF payload — the store has no script to author`,
        );
      }

      const runId = assertSafeRunId(ctx.runId);
      const prefix = runPrefix(runId);
      // Creation order IS the reverse of the DEV-13 delete order.
      const suite = await tableApi.createRecord(ATF_TABLES.suite, {
        name: `${prefix} throwaway suite`,
        active: "true",
        description: `Tessera run ${runId} — DEV-8/DEV-19 throwaway suite (the CI/CD API runs suites only)`,
      });
      suiteSysId = track(
        ATF_TABLES.suite,
        requireSysId(suite, "create suite"),
        "throwaway suite",
      );

      const test = await tableApi.createRecord(ATF_TABLES.test, {
        // ARCH-26: the run-id prefix is the attribution + orphan-probe key.
        name: `${prefix} ${testLabel}`,
        active: "true",
        description: `Tessera run ${runId} — projected from spec ${spec.ref.id} (${spec.ref.path})`,
      });
      const testSysId = track(
        ATF_TABLES.test,
        requireSysId(test, "create test"),
        "test definition",
      );

      const link = await tableApi.createRecord(ATF_TABLES.suiteTest, {
        test_suite: suiteSysId,
        test: testSysId,
        order: "1",
      });
      track(
        ATF_TABLES.suiteTest,
        requireSysId(link, "create suite-test link"),
        "suite→test link",
      );

      const step = await tableApi.createRecord(ATF_TABLES.step, {
        test: testSysId,
        step_config: RUN_SERVER_SIDE_SCRIPT_STEP_CONFIG,
        order: "1",
        active: "true",
        description: `Run Server Side Script — ${spec.ref.id}`,
      });
      const stepSysId = track(
        ATF_TABLES.step,
        requireSysId(step, "create step"),
        "Run Server Side Script step",
      );

      await installScript(stepSysId, spec.payload.script);

      const record: ProjectedRecord = { testSysId, suiteSysId, runId };
      return { [specKey(spec.ref)]: record };
    },

    async teardown(ctx: PipelineContext): Promise<void> {
      const runId = assertSafeRunId(ctx.runId);
      if (created.length === 0) return;
      if (suiteSysId !== undefined) await assertSuiteRunTerminal(suiteSysId);

      // DEV-13 pinned order. Expressed as table groups rather than plain
      // reverse-creation order so the rule is readable: links first (they
      // reference both sides), then the step's inputs, then steps, then the
      // test, then the throwaway suite. Fabricated data/users would come last;
      // Phase 0.5 fabricates none.
      const order: readonly string[] = [
        ATF_TABLES.suiteTest,
        ATF_TABLES.stepInput,
        ATF_TABLES.step,
        ATF_TABLES.test,
        ATF_TABLES.suite,
      ];
      for (const table of order) {
        for (const record of [...created].reverse()) {
          if (record.table !== table) continue;
          if (deleted.some((done) => done.sysId === record.sysId)) continue;
          await remove(record);
        }
      }

      if (options.deleteSuiteResults === true && suiteSysId !== undefined) {
        const { records } = await tableApi.queryTable({
          table: ATF_TABLES.suiteResult,
          query: `test_suite=${suiteSysId}`,
          fields: ["sys_id"],
          limit: 100,
        });
        for (const row of records) {
          await remove({
            table: ATF_TABLES.suiteResult,
            sysId: requireSysId(row, "delete suite result"),
            what: "suite run state",
          });
        }
      }

      await sweepNamespace(runId, ATF_TABLES.test);
      await sweepNamespace(runId, ATF_TABLES.suite);
    },
  };
}
