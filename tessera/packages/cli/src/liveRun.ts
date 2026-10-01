// `tess run --live` — the real pipeline, end to end, against a runner profile.
//
// Delegated decision 2026-09-23 (TODO "run --live"): the refusal that kept
// `run` skeleton-only was conditioned on a missing `TestStore` adapter. The
// ATF store (`@tessera/teststore-atf`) now exists, so the refusal is lifted for
// `--live` and ONLY for it — `--skeleton` keeps every frozen property it had,
// including its two-outcome exit mapping.
//
// What this module composes, in order, and why the order is load-bearing:
//
//  1. **The TM-3 projection gate** (`loadLiveSpecs`) — before anything touches
//     the filesystem or an instance. A hostile repo spec refuses the whole run
//     with exit 4 and nothing written, not even a `.tessera/` directory.
//  2. **§11 classification of the runner** — the guard on a probe bound to the
//     runner PROFILE (ARCH-7/18), journalling into the same §4b ledger the run
//     writes. `runPipeline` re-asserts writability at its first statement; a
//     GuardViolation propagates and `cli.ts` maps it to exit 4.
//  3. **`composeRealPipeline`** — all eight ports, the ATF store among them.
//     The store holds a projection lock under the ledger root, and `release()`
//     runs in a `finally`: a run that died before teardown must not leave the
//     next run refusing on a lock nobody holds.
//  4. **`runPipeline`** with impact analysis ON and generation OFF. A live run
//     executes what the repo DECLARES (the manifest); generation writes only to
//     `proposed/` and nothing it produces runs until a human promotes it
//     (DEV-4), so generating inside a gating run would be work thrown away.
//  5. **Persistence** — every `TestEvent` is appended to the §6b run event log
//     and the sanitised report is written as the run's result, so
//     `tess status` / `tess confirm` answer from disk without re-running.
//
// Exit codes are the full Phase-1 set here (the skeleton's freeze is about
// CI jobs pinned to `--skeleton`, and no job can be pinned to a flag that did
// not exist): 0 GO, 1 NO_GO, 3 a stage fault with no NO_GO evidence,
// 4 a §11 or TM-3 refusal, 5 INCONCLUSIVE.

import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  recordAllowSkipped,
  runPipeline,
  type PipelineRunReport,
  type Reporter,
} from "@tessera/core";
import { createSnInstanceProbe } from "@tessera/doctor";
import { createTemplateProvider } from "@tessera/generate";
import { createTargetGuard, type AcknowledgeProd } from "@tessera/guard";
import {
  createIntentLedger,
  createRunEventLog,
  type RunEventLog,
} from "@tessera/ledger";
import { createLedgerGuardAuditSink } from "@tessera/phase05";
import { createSnRecordReader } from "@tessera/resolvers";
import type { OverrideRecord, TestEvent } from "@tessera/types";

import type { CliContext } from "./context.js";
import { describe } from "./context.js";
import { EXIT_CODES, type ExitCode } from "./exitCodes.js";
import {
  createClassifyingReader,
  formatRefusedLookups,
  formatRefusedTables,
  isEnumerationRefusal,
  LIVE_ARTIFACT_TABLES,
  LIVE_LOOKUP_TABLES,
  type RefusedArtifactTable,
} from "./liveArtifactTables.js";
import { formatRejectedSpecs, loadLiveSpecs } from "./liveSpecs.js";
import { composeRealPipeline } from "./registries.js";
import { stage, type Harness } from "./stage.js";
import {
  bindProbe,
  bindRole,
  createGuardProbe,
  TopologyError,
  type RoleBinding,
} from "./topology.js";

/** The projection lock's file name under the §4b ledger root. */
export const PROJECTION_LOCK_FILENAME = "projection.lock";

/** The persisted result's discriminator, so `confirm` can refuse a stranger. */
export const LIVE_RESULT_KIND = "tessera.live-run";

export interface LiveRunOptions {
  /** Runner profile — the ONLY instance a pipeline write may touch (ARCH-8). */
  readonly runner: string;
  /** Source profile — where artifacts are resolved and analysed (ARCH-19). */
  readonly source: string;
  readonly scope: string;
  readonly story?: string;
  /** Absolute tests root: the directory holding `.manifest.json`. */
  readonly testsRoot: string;
  readonly nonProdAllowlist: readonly string[];
  readonly prodInstances: readonly string[];
  readonly acknowledgeProd?: AcknowledgeProd;
  readonly actor: string;
  readonly runId: string;
  readonly ledgerRoot?: string;
  readonly docsDir?: string;
  readonly runTimeoutMs?: number;
  readonly json: boolean;
  /** §6a `allow-skipped` override, audited to the ledger when accepted. */
  readonly allowSkipped: boolean;
  /** Where the JSON reporter's document goes. Omitted: discarded. */
  readonly jsonOut?: string;
  /** Where the JUnit reporter's XML goes. Omitted: discarded. */
  readonly junitOut?: string;
}

/**
 * The persisted shape of a live run's result — what `result.json` holds.
 * Sanitised on purpose: `failure.cause` is `unknown` and may be an Error or a
 * response body, neither of which belongs on disk or survives JSON.
 */
export interface LiveRunRecord {
  readonly kind: typeof LIVE_RESULT_KIND;
  readonly runId: string;
  readonly exitCode: ExitCode;
  readonly state: PipelineRunReport["state"];
  readonly teardown: PipelineRunReport["teardown"];
  readonly verdict: PipelineRunReport["verdict"];
  readonly result: PipelineRunReport["result"];
  readonly planned: number;
  /**
   * The spec inventory could not be fully read or projected (a dropped
   * manifest entry, an unprojected non-unit spec): the verdict covers only
   * what was read. Delegated decision 2026-09-26 (review W5b, C): persisted
   * and in `--json` so a GO over a partial inventory can be told apart.
   */
  readonly inventoryIncomplete: boolean;
  /**
   * Why the verdict is not the gate's own: present iff `runPipeline` moved
   * it (`PipelineRunReport.verdictDowngrade`) — today only a GO over an
   * incomplete inventory, downgraded to INCONCLUSIVE. Delegated decision
   * 2026-09-26: a top-level field in the record (so in `--json` and
   * `result.json`), not only a line in `verdict.warnings`, so a consumer
   * reading the exit code 5 can find its cause without parsing warnings.
   */
  readonly verdictReason?: string;
  /**
   * Artifact tables the live run could not read in full (refused,
   * ACL-trimmed or truncated), with the reason. Present iff non-empty. An
   * entry tagged `read: "lookup"` was refused by the impact analysis's lookup
   * read only, not by the enumeration (`RefusedArtifactTable`).
   * Delegated decision 2026-09-28 (wave 13): a top-level field for the same
   * reason as `verdictReason` — a consumer of exit 5 finds which tables
   * without parsing warnings.
   */
  readonly artifactTablesRefused?: readonly RefusedArtifactTable[];
  readonly failures: readonly {
    readonly stage: string;
    readonly message: string;
    readonly refused: boolean;
  }[];
}

/** Structural, not `instanceof`: the error may have crossed a package boundary. */
function isGuardViolation(error: unknown): boolean {
  return error instanceof Error && error.name === "GuardViolation";
}

/**
 * The live exit code for a verdict and whether a stage failed.
 *
 * NO_GO outranks a fault: a failing assertion is evidence, and a later fault
 * (say, teardown) does not unmake it. A fault outranks GO/INCONCLUSIVE: the
 * verdict is fail-closed on a fault, and "we could not tell because something
 * broke" is DEV-1's 3 — unless the fault was a §11 refusal, which is 4.
 */
export function liveExitCode(
  status: PipelineRunReport["verdict"]["status"],
  failure: { readonly refused: boolean } | undefined,
): ExitCode {
  if (status === "NO_GO") return EXIT_CODES.noGo;
  if (failure !== undefined)
    return failure.refused ? EXIT_CODES.refused : EXIT_CODES.fault;
  return status === "GO" ? EXIT_CODES.ok : EXIT_CODES.inconclusive;
}

/** JSON round-trip: drops `undefined`, flattens class instances to data. */
function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function liveRunRecord(
  report: PipelineRunReport,
  inventory: { readonly inventoryIncomplete: boolean },
  enumeration: {
    readonly refused: readonly RefusedArtifactTable[];
  } = { refused: [] },
): LiveRunRecord {
  const failures = (
    report.failures ?? (report.failure === undefined ? [] : [report.failure])
  ).map((failure) => ({
    stage: failure.stage,
    message: failure.message,
    refused: isGuardViolation(failure.cause),
  }));
  const first = report.failure;
  return {
    kind: LIVE_RESULT_KIND,
    runId: report.runId,
    exitCode: liveExitCode(
      report.verdict.status,
      first === undefined
        ? undefined
        : { refused: isGuardViolation(first.cause) },
    ),
    state: report.state,
    teardown: report.teardown,
    verdict: jsonSafe(report.verdict),
    result: jsonSafe(report.result),
    planned: report.planned.length,
    inventoryIncomplete: inventory.inventoryIncomplete,
    ...(report.verdictDowngrade === undefined
      ? {}
      : { verdictReason: report.verdictDowngrade.reason }),
    ...(enumeration.refused.length === 0
      ? {}
      : { artifactTablesRefused: jsonSafe(enumeration.refused) }),
    failures,
  };
}

/**
 * A reporter that appends every `TestEvent` to the §6b run event log.
 *
 * `Reporter.onEvent` is synchronous and the log is not, so events are queued
 * and appended in order by one chain. An append that fails because the run
 * record does not exist yet (`run-not-found`) keeps the event queued for the
 * next flush; any other failure is reported once through `onWarning` and the
 * event is dropped — an output channel never vetoes a verdict, and the
 * verdict itself is persisted separately by `writeResult`.
 */
export function createRunEventRecorder(
  log: RunEventLog,
  runId: string,
  onWarning: (message: string) => void,
): Reporter & { flush(): Promise<void> } {
  const queue: TestEvent[] = [];
  let chain: Promise<void> = Promise.resolve();

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const event = queue[0] as TestEvent;
      try {
        await log.appendEvent(runId, { type: event.kind, data: event });
        queue.shift();
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === "run-not-found") return;
        queue.shift();
        onWarning(
          `run event log: the ${event.kind} event was not recorded (${describe(error)})`,
        );
      }
    }
  };
  const flush = (): Promise<void> => {
    chain = chain.then(drain);
    return chain;
  };

  return {
    onEvent(event: TestEvent): void {
      queue.push(jsonSafe(event));
      void flush();
    },
    close: async (): Promise<void> => {
      await flush();
    },
    flush,
  };
}

function usage(context: CliContext, message: string): ExitCode {
  context.stderr(`tess: ${message}`);
  context.stderr("");
  context.stderr("Run `tess run --help` for usage.");
  return EXIT_CODES.usage;
}

/**
 * The human lines that say why a live run's verdict could not be GO: an
 * incomplete spec inventory, artifact tables the enumeration refused, and
 * tables that refused an impact lookup read. Prints nothing for a complete
 * run. Shared by `tess run --live` and the `tess status` / `tess confirm`
 * readers of the persisted record, so all three word it the same way.
 */
export function renderIncompleteness(
  context: Pick<CliContext, "stdout">,
  record: {
    readonly inventoryIncomplete?: boolean;
    readonly artifactTablesRefused?: readonly RefusedArtifactTable[];
  },
): void {
  if (record.inventoryIncomplete) {
    context.stdout(
      `  inventory: INCOMPLETE — some specs were not read or not projected; the verdict cannot be GO`,
    );
  }
  const refusedTables = record.artifactTablesRefused ?? [];
  const enumerationRefusals = refusedTables.filter(isEnumerationRefusal);
  const lookupRefusals = refusedTables.filter(
    (entry) => !isEnumerationRefusal(entry),
  );
  if (enumerationRefusals.length > 0) {
    context.stdout(
      `  artifacts: INCOMPLETE — ${enumerationRefusals.length} artifact table(s) not read in full; the verdict cannot be GO`,
    );
    for (const entry of enumerationRefusals) {
      context.stdout(`    - ${entry.table}: ${entry.reason}`);
    }
  }
  if (lookupRefusals.length > 0) {
    context.stdout(
      `  lookups: INCOMPLETE — ${lookupRefusals.length} artifact table(s) refused an impact lookup read (the enumeration was not refused); the verdict cannot be GO`,
    );
    for (const entry of lookupRefusals) {
      context.stdout(`    - ${entry.table}: ${entry.reason}`);
    }
  }
}

function renderHuman(
  context: CliContext,
  record: LiveRunRecord,
  display: {
    readonly runner: RoleBinding;
    readonly source: RoleBinding;
    readonly ledgerRoot: string;
    readonly acknowledgements: readonly string[];
    readonly allowSkipped: string | undefined;
  },
): void {
  const { verdict } = record;
  context.stdout("");
  context.stdout(`tess run --live — run ${record.runId}`);
  context.stdout(
    `  topology: source=${display.source.profile} runner=${display.runner.profile} (${display.runner.ref.host})`,
  );
  context.stdout(`  ledger:   ${display.ledgerRoot}`);
  context.stdout(
    `  specs:    ${record.planned} planned; state ${record.state}; teardown ${record.teardown}`,
  );
  renderIncompleteness(context, record);
  for (const line of display.acknowledgements) {
    context.stdout(`acknowledged (§11.4): ${line}`);
  }
  if (display.allowSkipped !== undefined) {
    context.stdout(`override (§6a): ${display.allowSkipped}`);
  }
  context.stdout("");
  context.stdout(`VERDICT: ${verdict.status}`);
  if (record.verdictReason !== undefined) {
    context.stdout(`  reason: ${record.verdictReason}`);
  }
  context.stdout(
    `  ${verdict.counts.pass} pass, ${verdict.counts.fail} fail (${verdict.counts.missing} missing), ${verdict.counts.inconclusive} inconclusive, ${verdict.counts.blocking} blocking`,
  );
  for (const row of verdict.rows) {
    if (row.status === "pass") continue;
    context.stdout(`  - ${row.status}: ${row.spec.id} (${row.spec.path})`);
  }
  for (const warning of verdict.warnings) {
    context.stdout(`  warning: ${warning}`);
  }
  // Every stage fault, not just the first: `failures` exists because the one
  // slot used to drop the second (a teardown fault behind a run fault).
  for (const failure of record.failures) {
    context.stdout(
      `  ${failure.refused ? "REFUSED" : "FAULT"} at ${failure.stage}: ${failure.message}`,
    );
  }
  if (verdict.confirmToken !== undefined) {
    context.stdout(`  confirm token: ${verdict.confirmToken.verdictHash}`);
  }
  context.stdout(`exit: ${record.exitCode}`);
}

/**
 * Compose and run the live pipeline. Throws only what `cli.ts` classifies: a
 * `GuardViolation` (exit 4) or anything else (exit 3).
 */
export async function runLive(
  options: LiveRunOptions,
  context: CliContext,
): Promise<number> {
  let runner: RoleBinding;
  let source: RoleBinding;
  try {
    runner = bindRole("runner", options.runner);
    source = bindRole("source", options.source);
  } catch (error) {
    if (error instanceof TopologyError) return usage(context, error.message);
    throw error;
  }

  // (1) TM-3 before anything else exists — see the header.
  const load = await loadLiveSpecs(options.testsRoot);
  if (load.kind === "rejected") {
    context.stderr("");
    context.stderr(
      `REFUSED (TM-3): ${load.rejected.length} spec(s) under ${options.testsRoot} failed the generated-code gate; nothing was projected and nothing was written`,
    );
    for (const line of formatRejectedSpecs(load.rejected)) context.stderr(line);
    context.stderr("");
    return EXIT_CODES.refused;
  }
  for (const note of load.notes) {
    context.stderr(`${note.level}: ${note.message}`);
  }
  if (load.specs.length === 0) {
    return usage(
      context,
      `no projectable unit spec under ${options.testsRoot} — a live run over nothing would be a green over nothing (QA-9)`,
    );
  }

  let harness: Harness | undefined;
  let release: (() => void) | undefined;
  try {
    harness = await stage(
      {
        instanceHost: runner.ref.host,
        ...(options.ledgerRoot === undefined
          ? {}
          : { ledgerRoot: path.resolve(context.cwd, options.ledgerRoot) }),
        ...(options.docsDir === undefined ? {} : { docsDir: options.docsDir }),
        fake: false,
        variant: "correct",
        fakeProductionProperty: false,
        keepLedger: false,
        // Credentials come from the runner PROFILE; the ambient SN_INSTANCE
        // is not rewritten to the runner's host (ARCH-7/18).
        bindAmbientInstance: false,
      },
      context.cwd,
    );
    const ledgerRoot = harness.ledgerRoot;

    // (2) §11 — the same composition `tess preflight --mode apply` uses.
    const ledger = createIntentLedger({
      rootDir: ledgerRoot,
      now: context.now,
    });
    const audit = createLedgerGuardAuditSink(ledger);
    const runnerProbe = bindProbe(createSnInstanceProbe(), runner.profile);
    const guard = createTargetGuard(
      {
        nonProdAllowlist: options.nonProdAllowlist,
        prodInstances: options.prodInstances,
        ...(options.acknowledgeProd === undefined
          ? {}
          : { acknowledgeProd: options.acknowledgeProd }),
      },
      {
        probe: createGuardProbe([{ ref: runner.ref, probe: runnerProbe }]),
        audit,
        runId: options.runId,
        now: () => context.now().toISOString(),
      },
    );
    const classification = await guard.classify(runner.ref, "runner");

    // (3) All eight ports.
    const discard = (): void => undefined;
    // Delegated decision 2026-09-28 (wave 13): every script-bearing table,
    // read through a classifying reader — see `liveArtifactTables.ts`.
    // Wave 17: it watches `LIVE_LOOKUP_TABLES` — the enumerated tables plus
    // the lookup-only `sys_transform_map` — see `liveArtifactTables.ts`.
    const scopeReader = createClassifyingReader(
      createSnRecordReader(source.profile),
      LIVE_LOOKUP_TABLES,
    );
    const { ports, store } = composeRealPipeline({
      sourceProfile: source.profile,
      runnerProfile: runner.profile,
      scope: options.scope,
      testsRoot: options.testsRoot,
      provider: createTemplateProvider(),
      now: context.now,
      console: options.json ? discard : context.stdout,
      writeJson:
        options.jsonOut === undefined
          ? discard
          : (json) => writeFile(options.jsonOut as string, json, "utf8"),
      writeJUnit:
        options.junitOut === undefined
          ? discard
          : (xml) => writeFile(options.junitOut as string, xml, "utf8"),
      lockPath: path.join(ledgerRoot, PROJECTION_LOCK_FILENAME),
      onWarning: (message) => context.stderr(`warning: ${message}`),
      kinds: ["unit"],
      artifactTables: LIVE_ARTIFACT_TABLES,
      scopeReader,
      ruleReader: scopeReader.forLookup(),
      // `sys_ui_action` is in `LIVE_ARTIFACT_TABLES`, so the same lookup view
      // classifies the UI Action lookup's reads and tags its refusals.
      actionReader: scopeReader.forLookup(),
      // The three standalone script tables, `sys_script_include` and — for a
      // transform script's target table — `sys_transform_map` and
      // `sys_script` are all in `LIVE_LOOKUP_TABLES`, so the same lookup view
      // classifies every standalone-script lookup read (waves 16–17).
      scriptReader: scopeReader.forLookup(),
    });
    release = () => store.release();

    const events = createRunEventLog({ rootDir: ledgerRoot, now: context.now });
    const recorder = createRunEventRecorder(events, options.runId, (message) =>
      context.stderr(`warning: ${message}`),
    );

    const overrides: OverrideRecord[] = options.allowSkipped
      ? [{ flag: "allow-skipped", affectedRows: 0, actor: options.actor }]
      : [];

    // (4)
    const report = await runPipeline(
      {
        ports: { ...ports, reporters: [...ports.reporters, recorder] },
        guard,
        runner: classification,
        ledger,
        now: context.now,
      },
      {
        runId: options.runId,
        scope: options.scope,
        topology: {
          source: source.profile,
          runner: runner.profile,
          target: runner.profile,
        },
        lifecycle: "ephemeral",
        input: {
          scope: options.scope,
          ...(options.story === undefined ? {} : { story: options.story }),
        },
        specs: load.specs,
        // Delegated decision 2026-09-26: the inventory's `incomplete` flag
        // reaches the verdict, as coverage passes it to `computeIntent`. A
        // spec the inventory dropped and nothing demanded leaves no `missing`
        // row, so without this a partial inventory could still gate GO.
        inventoryIncomplete: load.incomplete,
        kinds: ["unit"],
        stages: { impact: true, generate: false },
        ...(overrides.length === 0 ? {} : { overrides }),
        ...(options.runTimeoutMs === undefined
          ? {}
          : { runTimeoutMs: options.runTimeoutMs }),
      },
    );

    // (5) Persist. The run record exists by now unless the run was refused
    // before `openRun`, in which case there is nothing to attach events to.
    // Delegated decision 2026-09-26 (review W5b, C): the CLI also carries the
    // flag into the persisted record, `--json` and the human report, and
    // warns — `runPipeline` (given `inventoryIncomplete` above) has already
    // made sure the verdict is not GO.
    const record = liveRunRecord(
      report,
      { inventoryIncomplete: load.incomplete },
      { refused: scopeReader.refused() },
    );
    for (const line of [
      formatRefusedTables(record.artifactTablesRefused ?? []),
      formatRefusedLookups(record.artifactTablesRefused ?? []),
    ]) {
      if (line !== undefined) context.stderr(`warning: ${line}`);
    }
    if (record.inventoryIncomplete) {
      context.stderr(
        `warning: the spec inventory under ${options.testsRoot} is incomplete — the verdict (${record.verdict.status}) covers only the specs that were read and projected, so it cannot be GO`,
      );
    }
    await recorder.flush();
    try {
      await events.writeResult(options.runId, record);
    } catch (error) {
      context.stderr(
        `warning: the run result was not persisted — \`tess confirm\` cannot answer for this run (${describe(error)})`,
      );
    }
    // Throws when the audit cannot be written: an override that cannot be
    // audited must not be silently accepted (§9.5).
    const audited = await recordAllowSkipped(ledger, report.verdict, {
      surface: "cli",
    });

    const acknowledgements = audit
      .records()
      .map(
        (entry) =>
          `${entry.role} ${entry.cls}: ${entry.reason} (${entry.actor})`,
      );
    // Read off the VERDICT, not the flag: the reducer recomputed
    // `affectedRows` from the rows it actually flipped.
    const accepted = report.verdict.overrides.find(
      (override) => override.flag === "allow-skipped",
    );
    const allowSkipped =
      audited === undefined || accepted === undefined
        ? undefined
        : `allow-skipped by ${accepted.actor} flipped ${accepted.affectedRows} row(s); audited to the ledger`;

    if (options.json) {
      context.stdout(
        JSON.stringify(
          {
            ...record,
            topology: {
              source: source.profile,
              runner: runner.profile,
              runnerHost: runner.ref.host,
            },
            ledgerRoot,
            acknowledgements,
            ...(allowSkipped === undefined ? {} : { allowSkipped }),
          },
          null,
          2,
        ),
      );
    } else {
      renderHuman(context, record, {
        runner,
        source,
        ledgerRoot,
        acknowledgements,
        allowSkipped,
      });
    }
    return record.exitCode;
  } finally {
    release?.();
    harness?.restore();
  }
}
