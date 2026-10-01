// `tess status`, `tess confirm` and `tess cleanup` — the §6b run-state trio
// (`run_status`, `confirm_ready`, `cleanup`) on the CLI side, over what
// `tess run --live` persisted (delegated decision 2026-09-23, TODO "the three
// unbuilt §6b tools").
//
// The three do not move as a unit, and the split is the point:
//
//  * **status** and **confirm** are READ-ONLY over the disk. They open no
//    instance connection, run no guard and never create a `.tessera/`
//    directory: a status query against a ledger root that does not exist is an
//    unknown run, not a reason to make one. `confirm` answers from the
//    persisted result and "Never re-runs anything" (§6b) — a run with no
//    persisted result is inconclusive (QA-9), never re-executed to find out.
//  * **cleanup** is the second teardown driver ARCH-35 allows. It re-enters
//    `tearing-down` from `failed` / `abandoned` (§4b), deletes through the same
//    ATF store the run projected with (the store re-probes instance-side suite
//    results and refuses under a non-terminal one — DEV-17), and settles the
//    ledger entries exactly as `runPipeline`'s own teardown does. `--mode plan`
//    (the default) reads the local ledger only and touches no instance;
//    `--mode apply` is the privileged act and needs a writable runner (§11).
//
// All three take argv only, like `run`: they are addressed by run id, and a run
// id has no business in an env var or a config file.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { createSnInstanceProbe } from "@tessera/doctor";
import { createTargetGuard, type AcknowledgeProd } from "@tessera/guard";
import {
  createIntentLedger,
  createRunEventLog,
  neverReachedRunning,
  validateRunId,
  type RunEvent,
  type RunStateRecord,
} from "@tessera/ledger";
import { createLedgerGuardAuditSink } from "@tessera/phase05";
import {
  ATF_STORE_TABLES,
  countRecordedSuiteTriggers,
  createAtfTestStore,
  DEFAULT_SUITE_TRIGGER_TABLE,
  createSnTestStoreClient,
  deleteLegacyAtfRows,
  discoverLegacyAtfRows,
  LEGACY_ATF_REPORT_KIND,
  LegacyCleanupRefusalError,
  type AtfTeardownContext,
  type LegacyAtfReport,
  type TestStoreHttpClient,
} from "@tessera/teststore-atf";

import type { CliContext } from "../context.js";
import { describe } from "../context.js";
import { EXIT_CODES, type ExitCode } from "../exitCodes.js";
import {
  LIVE_RESULT_KIND,
  PROJECTION_LOCK_FILENAME,
  renderIncompleteness,
  type LiveRunRecord,
} from "../liveRun.js";
import type { RefusedArtifactTable } from "../liveArtifactTables.js";
import { REAL_PIPELINE } from "../registries.js";
import { stage, stageDocsDir, type Harness } from "../stage.js";
import {
  bindProbe,
  bindRole,
  bindTestStoreClient,
  createGuardProbe,
  TopologyError,
} from "../topology.js";

/** The §4b ledger root when `--ledger-root` is not given — `stage()`'s default. */
const DEFAULT_LEDGER_DIR = ".tessera";

/** §4b terminal states: the owning process is done with the run. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "done",
  "failed",
  "abandoned",
]);

type RunStateCommand = "status" | "confirm" | "cleanup";

function usage(
  context: CliContext,
  command: RunStateCommand,
  message: string,
): ExitCode {
  context.stderr(`tess: ${message}`);
  context.stderr("");
  context.stderr(`Run \`tess ${command} --help\` for usage.`);
  return EXIT_CODES.usage;
}

function resolveLedgerRoot(
  context: CliContext,
  raw: string | undefined,
): string {
  return raw === undefined
    ? path.join(context.cwd, DEFAULT_LEDGER_DIR)
    : path.resolve(context.cwd, raw);
}

/**
 * A run id is refused as a USAGE error before anything is read, composed or
 * contacted.
 *
 * Delegated decision 2026-09-25: every run-state command validates `--run-id`
 * against the ledger's own `validateRunId` (never a copy of its pattern)
 * immediately after parsing. Before this, a malformed id reached three
 * different outcomes depending on what happened to exist on disk: `cleanup
 * --mode plan` with no `.tessera/` returned an OK plan whose namespace was the
 * raw id (`x^ORsys_idISNOTEMPTY^name!=:` — an encoded-query fragment), and
 * `status` / `confirm` against an existing ledger root surfaced the ledger's
 * throw as exit 3 with a misleading "not proof nothing was written" banner.
 * An id that could never name a run is the caller's mistake (exit 2), and it is
 * fail-closed: nothing downstream sees it.
 */
function invalidRunId(runId: string): string | undefined {
  try {
    validateRunId(runId);
    return undefined;
  } catch (error) {
    return describe(error);
  }
}

/**
 * The shape of a run id `tess run` mints (`mintRunId` in `commands/run.ts`):
 * `run-<yyyymmdd>t<hhmmss>-<first 8 hex of a UUID>`, lowercased.
 *
 * Delegated decision 2026-09-26 (F2d): a `tess cleanup --mode apply` with NO
 * local run record sweeps a namespace addressed by nothing but the run id, so
 * an operator-chosen id (`smoke`, `login`) could name a customer's own ATF
 * rows. Such a sweep is allowed only for an id of this minted shape — one
 * Tessera plausibly created — or when the operator retypes the id in
 * `--confirm-unrecorded <run-id>`. Anything else is refused (exit 4) before
 * any instance is contacted. The ATF store's per-row ownership check (F2a/b)
 * still runs behind this gate; the gate only stops a mistyped or foreign id
 * from reaching it unconfirmed.
 */
export const MINTED_RUN_ID_PATTERN = /^run-\d{8}t\d{6}-[0-9a-f]{8}$/;

/**
 * DEV-17 (wave 13) — the recorded suite-trigger count cleanup hands the ATF
 * store for a run with NO local record, whose ledger cannot be read.
 *
 * Delegated decision 2026-09-28 (wave 13): an unrecorded sweep is already
 * authorised only as a sweep of a Tessera run (a minted id, or the operator's
 * `--confirm-unrecorded`, F2d), so it takes the most triggers a Tessera run
 * can have made: one per runner group of the real composition (core intends
 * one trigger per group, and the ATF store projects ONE suite per run, so a
 * group's runner triggers once). An upper bound only ever makes the store
 * refuse more, so it fails closed for any run that composition made. The
 * alternative — an unknown (`null`) count — refuses every unrecorded apply
 * before the namespace is even probed, which would retire the F2d sweep
 * outright; that is the call to make if the composition ever grows a second
 * trigger path this bound does not see.
 */
export const UNRECORDED_TRIGGER_BOUND = REAL_PIPELINE.runners.length;

/**
 * The run's recorded suite-trigger count for the store's DEV-17 gate: the
 * ledger's entries on the trigger table `tess run --live` journals to (core's
 * default, which the real composition does not override), in any state. A
 * ledger that cannot be read yields `null` — never an omitted count — which
 * the store refuses (exit 4, nothing deleted).
 */
async function readRecordedTriggers(
  ledgerRoot: string,
  context: CliContext,
  runId: string,
): Promise<number | null> {
  try {
    const entries = await createIntentLedger({
      rootDir: ledgerRoot,
      now: context.now,
    }).entries(runId);
    return countRecordedSuiteTriggers(
      runId,
      entries,
      DEFAULT_SUITE_TRIGGER_TABLE,
    );
  } catch {
    return null;
  }
}

/** How an apply with no local record is authorized; `null` when one exists. */
type UnrecordedSweep = "minted-run-id" | "confirmed" | "refused";

/** `true` for the ledger's "no such run" signal, whichever store raised it. */
function isRunNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "run-not-found";
}

// ── argv ────────────────────────────────────────────────────────────────────

interface CommonArgs {
  runId?: string;
  ledgerRoot?: string;
  json: boolean;
}

/**
 * A tiny shared parser. `spec` names the value flags and boolean flags this
 * command accepts beyond `--run-id`, `--ledger-root` and `--json`; anything
 * else is a usage error that names the flag.
 */
function parseArgs(
  argv: readonly string[],
  spec: {
    readonly values: readonly string[];
    readonly repeatable?: readonly string[];
  },
):
  | { kind: "error"; message: string }
  | {
      kind: "ok";
      common: CommonArgs;
      values: Map<string, string>;
      lists: Map<string, string[]>;
    } {
  const common: CommonArgs = { json: false };
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const takesValue =
      flag === "--run-id" ||
      flag === "--ledger-root" ||
      spec.values.includes(flag) ||
      (spec.repeatable ?? []).includes(flag);
    if (flag === "--json") {
      common.json = true;
      continue;
    }
    if (!takesValue) {
      return { kind: "error", message: `unknown flag ${JSON.stringify(flag)}` };
    }
    const raw = argv[index + 1];
    index += 1;
    if (raw === undefined || raw.trim() === "") {
      return { kind: "error", message: `${flag} expects a value` };
    }
    // A flag the spec names repeatable is collected as a list first, so a
    // command may take `--run-id` more than once (`cleanup --legacy`); every
    // other command keeps the single-valued `common.runId`.
    if ((spec.repeatable ?? []).includes(flag)) {
      lists.set(flag, [...(lists.get(flag) ?? []), raw]);
    } else if (flag === "--run-id") common.runId = raw;
    else if (flag === "--ledger-root") common.ledgerRoot = raw;
    else values.set(flag, raw);
  }
  return { kind: "ok", common, values, lists };
}

// ── status ──────────────────────────────────────────────────────────────────

/**
 * `tess status --run-id <id> [--since <cursor>]` — the persisted §4b run state
 * plus the §6b events committed after `--since`. Read-only; exit 0 for a known
 * run, 2 for an unknown one.
 */
export async function statusCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseArgs(argv, { values: ["--since"] });
  if (parsed.kind === "error") return usage(context, "status", parsed.message);
  const { common } = parsed;
  if (common.runId === undefined) {
    return usage(context, "status", "status needs --run-id <id>");
  }
  const runIdProblem = invalidRunId(common.runId);
  if (runIdProblem !== undefined) {
    return usage(context, "status", runIdProblem);
  }
  const sinceRaw = parsed.values.get("--since") ?? "0";
  const since = Number(sinceRaw);
  if (!Number.isInteger(since) || since < 0) {
    return usage(
      context,
      "status",
      `--since expects a non-negative integer cursor, got ${JSON.stringify(sinceRaw)}`,
    );
  }

  const ledgerRoot = resolveLedgerRoot(context, common.ledgerRoot);
  if (!existsSync(ledgerRoot)) {
    return usage(
      context,
      "status",
      `no run ${JSON.stringify(common.runId)}: there is no ledger root at ${ledgerRoot}`,
    );
  }
  const log = createRunEventLog({ rootDir: ledgerRoot, now: context.now });
  const snapshot = await log.readStatus(common.runId);
  if (snapshot === undefined) {
    return usage(
      context,
      "status",
      `no run ${JSON.stringify(common.runId)} under ${ledgerRoot}`,
    );
  }
  const page = await log.readEvents(common.runId, since);
  const result = liveRecordOf(snapshot.result?.result);

  if (common.json) {
    context.stdout(
      JSON.stringify(
        {
          run: snapshot.run,
          terminal: TERMINAL_STATES.has(snapshot.run.state),
          lastCursor: snapshot.lastCursor,
          events: page.events,
          cursor: page.cursor,
          ...(result === undefined
            ? {}
            : {
                result: {
                  verdict: result.verdict.status,
                  exitCode: result.exitCode,
                  teardown: result.teardown,
                  ...completenessFields(result),
                },
              }),
        },
        null,
        2,
      ),
    );
    return EXIT_CODES.ok;
  }

  renderRun(context, snapshot.run);
  context.stdout(
    `  events:   ${page.events.length} after cursor ${since} (last committed: ${snapshot.lastCursor})`,
  );
  for (const event of page.events) context.stdout(`    ${formatEvent(event)}`);
  if (result !== undefined) {
    context.stdout(
      `  result:   ${result.verdict.status}, exit ${result.exitCode}, teardown ${result.teardown}`,
    );
    const completeness = completenessFields(result);
    if (completeness.verdictReason !== undefined) {
      context.stdout(`  reason:   ${completeness.verdictReason}`);
    }
    renderIncompleteness(context, completeness);
  } else if (TERMINAL_STATES.has(snapshot.run.state)) {
    context.stdout("  result:   none persisted");
  }
  if (snapshot.run.state === "failed" || snapshot.run.state === "abandoned") {
    context.stdout(
      `  next:     tess cleanup --run-id ${snapshot.run.runId} (§4b — ${snapshot.run.state} runs are re-entered by cleanup only)`,
    );
  }
  context.stdout(`  cursor:   ${page.cursor} (pass as --since to resume)`);
  return EXIT_CODES.ok;
}

function renderRun(context: CliContext, run: RunStateRecord): void {
  context.stdout(`run ${run.runId}: ${run.state}`);
  context.stdout(
    `  scope:    ${run.scope}; runner ${run.runner}; lifecycle ${run.lifecycle}`,
  );
  context.stdout(`  started:  ${run.startedAt}; updated ${run.updatedAt}`);
}

function formatEvent(event: RunEvent): string {
  const data = event.data as { kind?: unknown; stage?: unknown } | undefined;
  const detail = typeof data?.stage === "string" ? ` (${data.stage})` : "";
  return `#${event.cursor} ${event.at} ${event.type}${detail}`;
}

/**
 * The completeness fields of a persisted live record, as `status` and
 * `confirm` relay them: `inventoryIncomplete`, `verdictReason` and
 * `artifactTablesRefused`, under the `LiveRunRecord` names (the names
 * `tess run --live --json` prints and the MCP relay passes through).
 *
 * Delegated decision 2026-09-30 (wave 16): the fields are ADDITIVE and a field
 * is emitted only when the persisted record carries it in its written shape,
 * so every existing consumer of the two JSON documents sees the same keys it
 * did before. `inventoryIncomplete` is relayed whenever it is a boolean,
 * `false` included (as `tess run --live --json` prints it); a record written
 * before the field existed yields nothing rather than a synthesized `false`,
 * which would claim a completeness nobody checked. A field of the wrong shape
 * (hand-edited or corrupt `result.json`) is dropped rather than relayed or
 * rendered — the verdict and exit code, which decide, are untouched by it.
 */
function completenessFields(record: LiveRunRecord): {
  inventoryIncomplete?: boolean;
  verdictReason?: string;
  artifactTablesRefused?: readonly RefusedArtifactTable[];
} {
  const raw = record as unknown as Partial<Record<string, unknown>>;
  const refused = raw.artifactTablesRefused;
  const wellFormedRefused =
    Array.isArray(refused) &&
    refused.every(
      (entry: unknown) =>
        entry !== null &&
        typeof entry === "object" &&
        typeof (entry as { table?: unknown }).table === "string" &&
        typeof (entry as { reason?: unknown }).reason === "string",
    );
  return {
    ...(typeof raw.inventoryIncomplete === "boolean"
      ? { inventoryIncomplete: raw.inventoryIncomplete }
      : {}),
    ...(typeof raw.verdictReason === "string"
      ? { verdictReason: raw.verdictReason }
      : {}),
    ...(wellFormedRefused
      ? {
          artifactTablesRefused: refused as readonly RefusedArtifactTable[],
        }
      : {}),
  };
}

/** The persisted result, when it is a live run's; `undefined` otherwise. */
function liveRecordOf(value: unknown): LiveRunRecord | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Partial<LiveRunRecord>;
  if (record.kind !== LIVE_RESULT_KIND) return undefined;
  if (record.verdict === undefined || typeof record.exitCode !== "number") {
    return undefined;
  }
  return record as LiveRunRecord;
}

// ── confirm ─────────────────────────────────────────────────────────────────

const EXIT_CODE_VALUES: ReadonlySet<number> = new Set(
  Object.values(EXIT_CODES),
);

/**
 * `tess confirm --run-id <id>` — the §6a verdict and confirm token of a
 * finished live run, read from `result.json`. Never re-runs anything (§6b).
 *
 * Exit codes: the run's own live exit code (0 GO, 1 NO_GO, 3, 4, 5) when a
 * result is persisted; 2 for an unknown run; 5 for a known run with no result
 * (it is still in flight, or died before persisting — either way nothing here
 * can decide it, QA-9); 3 for a result this command cannot read.
 */
export async function confirmCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  const parsed = parseArgs(argv, { values: [] });
  if (parsed.kind === "error") return usage(context, "confirm", parsed.message);
  const { common } = parsed;
  if (common.runId === undefined) {
    return usage(context, "confirm", "confirm needs --run-id <id>");
  }
  const runIdProblem = invalidRunId(common.runId);
  if (runIdProblem !== undefined) {
    return usage(context, "confirm", runIdProblem);
  }
  const ledgerRoot = resolveLedgerRoot(context, common.ledgerRoot);
  if (!existsSync(ledgerRoot)) {
    return usage(
      context,
      "confirm",
      `no run ${JSON.stringify(common.runId)}: there is no ledger root at ${ledgerRoot}`,
    );
  }
  const log = createRunEventLog({ rootDir: ledgerRoot, now: context.now });
  const snapshot = await log.readStatus(common.runId);
  if (snapshot === undefined) {
    return usage(
      context,
      "confirm",
      `no run ${JSON.stringify(common.runId)} under ${ledgerRoot}`,
    );
  }
  if (snapshot.result === undefined) {
    context.stderr(
      `INCONCLUSIVE: run ${common.runId} is ${snapshot.run.state} and has no persisted result — confirm reads results, it never re-runs anything (§6b, QA-9)`,
    );
    if (common.json) {
      context.stdout(
        JSON.stringify(
          {
            runId: common.runId,
            state: snapshot.run.state,
            exitCode: EXIT_CODES.inconclusive,
          },
          null,
          2,
        ),
      );
    }
    return EXIT_CODES.inconclusive;
  }
  const record = liveRecordOf(snapshot.result.result);
  if (record === undefined || !EXIT_CODE_VALUES.has(record.exitCode)) {
    context.stderr(
      `INFRASTRUCTURE FAULT (DEV-1): the persisted result of run ${common.runId} is not a \`tess run --live\` result (${LIVE_RESULT_KIND}); nothing can be confirmed from it`,
    );
    return EXIT_CODES.fault;
  }

  const { verdict } = record;
  if (common.json) {
    context.stdout(
      JSON.stringify(
        {
          runId: record.runId,
          persistedAt: snapshot.result.at,
          state: snapshot.run.state,
          exitCode: record.exitCode,
          verdict,
          failures: record.failures,
          ...completenessFields(record),
        },
        null,
        2,
      ),
    );
    return record.exitCode;
  }
  context.stdout(`run ${record.runId} (persisted ${snapshot.result.at})`);
  const completeness = completenessFields(record);
  renderIncompleteness(context, completeness);
  context.stdout(`VERDICT: ${verdict.status}`);
  if (completeness.verdictReason !== undefined) {
    context.stdout(`  reason: ${completeness.verdictReason}`);
  }
  context.stdout(
    `  ${verdict.counts.pass} pass, ${verdict.counts.fail} fail (${verdict.counts.missing} missing), ${verdict.counts.inconclusive} inconclusive, ${verdict.counts.blocking} blocking`,
  );
  for (const row of verdict.rows) {
    if (row.status === "pass") continue;
    context.stdout(`  - ${row.status}: ${row.spec.id} (${row.spec.path})`);
  }
  for (const override of verdict.overrides) {
    context.stdout(
      `  override: ${override.flag} by ${override.actor} (${override.affectedRows} row(s))`,
    );
  }
  for (const failure of record.failures) {
    context.stdout(
      `  ${failure.refused ? "REFUSED" : "FAULT"} at ${failure.stage}: ${failure.message}`,
    );
  }
  if (verdict.confirmToken === undefined) {
    context.stdout(
      "  confirm token: none — only a GO verdict carries one (§6a)",
    );
  } else {
    context.stdout(`  confirm token: ${verdict.confirmToken.verdictHash}`);
  }
  context.stdout(`exit: ${record.exitCode}`);
  return record.exitCode;
}

// ── cleanup ─────────────────────────────────────────────────────────────────

export interface CleanupSeams {
  /** Test seam; production uses `createSnTestStoreClient()`, runner-bound. */
  readonly testStoreClient?: TestStoreHttpClient;
}

/** The run-scoped cleanup's flags beyond the shared ones. */
const CLEANUP_ARGS = {
  values: [
    "--runner",
    "--mode",
    "--acknowledge-prod",
    "--actor",
    "--confirm-unrecorded",
  ],
  repeatable: ["--allow", "--prod"],
} as const;

/**
 * Finds `--legacy` in a FLAG position of cleanup's argv, and returns the argv
 * with it removed. A token is in a value position when the token before it (in
 * a flag position) is a value flag of EITHER mode — the union, so the mode a
 * value belongs to never depends on the mode being decided.
 *
 * Delegated decision 2026-09-30 (wave 15): a `--legacy` in a value position is
 * ambiguous — the caller either forgot the flag's value or meant the mode
 * switch — so it is refused as a usage error (exit 2) rather than read as
 * either. This is narrower than refusing every flag-shaped value: the shared
 * parser accepts those (a `--run-id --help` must still reach `validateRunId`,
 * see args.ts `VALIDATED_VALUE_FLAGS`), and only `--legacy` changes which
 * command runs.
 */
function splitLegacyFlag(argv: readonly string[]):
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly legacy: boolean;
      readonly rest: readonly string[];
    } {
  const valueFlags = new Set<string>([
    "--run-id",
    "--ledger-root",
    ...CLEANUP_ARGS.values,
    ...CLEANUP_ARGS.repeatable,
    ...LEGACY_CLEANUP_ARGS.values,
    ...LEGACY_CLEANUP_ARGS.repeatable,
  ]);
  let legacy = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--legacy") {
      legacy = true;
      continue;
    }
    rest.push(token);
    if (!valueFlags.has(token) || index + 1 >= argv.length) continue;
    const value = argv[index + 1] ?? "";
    if (value === "--legacy") {
      return {
        kind: "error",
        message: `${token} expects a value, got the flag "--legacy" — give ${token} its value, and --legacy a flag position of its own`,
      };
    }
    rest.push(value);
    index += 1;
  }
  return { kind: "ok", legacy, rest };
}

/**
 * `tess cleanup --run-id <id> --runner <profile> [--mode plan|apply]` — tear
 * down one run's ATF projection by its run-id namespace and settle its ledger.
 *
 * Exit codes: 0 torn down (or, in plan mode, planned); 2 usage; 3 teardown
 * fault — the run is left `failed`, and a second cleanup re-enters it; 4 §11
 * refusal of the runner, or a DEV-17 refusal (the local run is not terminal,
 * or the instance still runs its suite), an unrecorded sweep of a non-minted
 * id without `--confirm-unrecorded`, or a namespaced row that is not provably
 * this run's (F2) — nothing was deleted.
 */
export async function cleanupCommand(
  argv: readonly string[],
  context: CliContext,
  seams: CleanupSeams = {},
): Promise<number> {
  // Delegated decision 2026-09-30 (wave 14): `--legacy` switches the whole
  // command to the pre-marker sweep (`legacyCleanupCommand`). It is detected
  // before any parsing so neither mode's flags leak into the other: the
  // run-scoped flags are usage errors there, and the legacy ones are unknown
  // flags here. Only a `--legacy` in a flag position counts (`splitLegacyFlag`).
  const split = splitLegacyFlag(argv);
  if (split.kind === "error") return usage(context, "cleanup", split.message);
  if (split.legacy) {
    return await legacyCleanupCommand(split.rest, context, seams);
  }
  const parsed = parseArgs(argv, CLEANUP_ARGS);
  if (parsed.kind === "error") return usage(context, "cleanup", parsed.message);
  const { common, values, lists } = parsed;
  const runId = common.runId;
  if (runId === undefined) {
    return usage(context, "cleanup", "cleanup needs --run-id <id>");
  }
  const runIdProblem = invalidRunId(runId);
  if (runIdProblem !== undefined) {
    return usage(context, "cleanup", runIdProblem);
  }
  const mode = values.get("--mode") ?? "plan";
  if (mode !== "plan" && mode !== "apply") {
    return usage(
      context,
      "cleanup",
      `--mode expects plan or apply, got ${JSON.stringify(mode)}`,
    );
  }
  // Delegated decision 2026-09-26 (F2d): the confirmation is the run id
  // retyped, not a boolean — a value flag the shared parser already supports,
  // and a confirmation that cannot be pasted onto the wrong id. A mismatch is
  // the caller's mistake (exit 2) in either mode.
  const confirmUnrecorded = values.get("--confirm-unrecorded");
  if (confirmUnrecorded !== undefined && confirmUnrecorded !== runId) {
    return usage(
      context,
      "cleanup",
      `--confirm-unrecorded must repeat --run-id exactly (got ${JSON.stringify(confirmUnrecorded)} for ${JSON.stringify(runId)})`,
    );
  }
  let runner;
  try {
    runner = bindRole("runner", values.get("--runner") ?? "default");
  } catch (error) {
    if (error instanceof TopologyError) {
      return usage(context, "cleanup", error.message);
    }
    throw error;
  }
  const actor = values.get("--actor") ?? context.actor;
  const acknowledgeReason = values.get("--acknowledge-prod");

  const ledgerRoot = resolveLedgerRoot(context, common.ledgerRoot);
  const known = existsSync(ledgerRoot)
    ? await createIntentLedger({
        rootDir: ledgerRoot,
        now: context.now,
      }).readRun(runId)
    : undefined;

  // DEV-17 on the LOCAL marker: a non-terminal run may have a live owner, and
  // ARCH-35 gives that owner — not cleanup — the teardown. `failed` and
  // `abandoned` are the states cleanup re-enters; `done` is re-checked by the
  // namespace probe (a second cleanup is a no-op, §4b).
  if (known !== undefined && !TERMINAL_STATES.has(known.state)) {
    context.stderr("");
    context.stderr(
      `REFUSED (DEV-17): run ${runId} is ${known.state} (updated ${known.updatedAt}) — a non-terminal run may still have a live owner, and only that owner tears it down (ARCH-35). Nothing was deleted. If the owner is dead, the §4b startup scan marks it abandoned once it is stale; clean it up then.`,
    );
    context.stderr("");
    return EXIT_CODES.refused;
  }
  if (known !== undefined && known.lifecycle !== "ephemeral") {
    context.stderr("");
    context.stderr(
      `REFUSED (§4a): run ${runId} is ${known.lifecycle}; persistent test definitions are never deleted by cleanup, and the ATF store projects ephemeral runs only (DEV-20). Nothing was deleted.`,
    );
    context.stderr("");
    return EXIT_CODES.refused;
  }

  // Delegated decision 2026-09-25: the ATF store's DEV-17 gate refuses a
  // suite that has no `sys_atf_test_suite_result` row unless the caller
  // asserts no trigger ever happened — a queued execution looks identical.
  // Cleanup has no in-memory `running` flag the way `runPipeline` does, so
  // it asserts that ONLY from the local record's own history: a record kept
  // by a `runningAt`-tracking ledger (`tracksRunning`) that never got a
  // `runningAt` stamp. No local record, or a legacy one without the marker,
  // proves nothing — the gate stays up (fail closed).
  const neverTriggered = known !== undefined && neverReachedRunning(known);

  // F2d — see MINTED_RUN_ID_PATTERN. Only a sweep with no local record needs
  // it: a recorded run was created by this ledger under this id.
  const unrecordedSweep: UnrecordedSweep | null =
    known !== undefined
      ? null
      : MINTED_RUN_ID_PATTERN.test(runId)
        ? "minted-run-id"
        : confirmUnrecorded === runId
          ? "confirmed"
          : "refused";

  // DEV-17 (wave 13): how many suite executions the store must find result
  // rows for — see `readRecordedTriggers` / `UNRECORDED_TRIGGER_BOUND`.
  const recordedTriggers =
    known === undefined
      ? UNRECORDED_TRIGGER_BOUND
      : await readRecordedTriggers(ledgerRoot, context, runId);

  const namespace = `${runId}:`;
  if (mode === "plan") {
    const entries =
      known === undefined
        ? []
        : (
            await createIntentLedger({
              rootDir: ledgerRoot,
              now: context.now,
            }).recover(runId)
          ).teardownOrder;
    const plan = {
      runId,
      mode,
      runner: runner.profile,
      runnerHost: runner.ref.host,
      localState: known?.state ?? null,
      namespace,
      transitions:
        known === undefined || known.state === "done"
          ? []
          : ["tearing-down", "done"],
      ledgerEntriesToSettle: entries.length,
      // Whether apply waives the store's zero-result gate (see above).
      neverTriggered,
      // With no local record: why apply may sweep the namespace, or that it
      // will refuse to (F2d).
      unrecordedSweep,
      // The DEV-17 trigger count apply hands the store (`null`: the ledger
      // could not be read, so apply will be refused), and where it came from.
      recordedTriggers,
      recordedTriggersFrom: known === undefined ? "unrecorded-bound" : "ledger",
    };
    if (common.json) {
      context.stdout(JSON.stringify(plan, null, 2));
      return EXIT_CODES.ok;
    }
    context.stdout(`tess cleanup — plan for run ${runId} (nothing written)`);
    context.stdout(`  runner:   ${runner.profile} (${runner.ref.host})`);
    context.stdout(
      `  local:    ${known === undefined ? `no run record under ${ledgerRoot} — apply sweeps the namespace only` : `${known.state}; ${entries.length} ledger entr${entries.length === 1 ? "y" : "ies"} to settle`}`,
    );
    context.stdout(
      `  deletes:  every ATF suite/test/step/step-input named "${namespace}…" on the runner, in the DEV-13 order; suite RESULTS are kept (QA-17)`,
    );
    context.stdout(
      "  guard:    the store refuses while any suite result of the run is non-terminal (DEV-17)",
    );
    context.stdout(
      neverTriggered
        ? "            a suite with NO result row is torn down: the local record proves the run never reached running"
        : "            a suite with NO result row is refused too: nothing local proves the run was never triggered",
    );
    context.stdout(
      recordedTriggers === null
        ? "            the ledger's suite-trigger count cannot be read: apply will be refused"
        : `            at least ${recordedTriggers} result row(s) are required: ${known === undefined ? "the most suite triggers a Tessera run makes (no local ledger)" : "one per suite trigger the ledger records"}`,
    );
    context.stdout(
      "  owned:    the store refuses the whole teardown if any namespaced row lacks this run's ownership marker, or a foreign suite links one of its tests",
    );
    if (unrecordedSweep === "refused") {
      context.stdout(
        `  REFUSED:  apply with no local record needs a Tessera-minted run id or --confirm-unrecorded ${runId}`,
      );
      return EXIT_CODES.ok;
    }
    context.stdout("Re-run with --mode apply to execute it.");
    return EXIT_CODES.ok;
  }

  if (unrecordedSweep === "refused") {
    context.stderr("");
    context.stderr(
      `REFUSED (unrecorded namespace): there is no local record of run ${runId} under ${ledgerRoot}, and "${runId}" is not a run id Tessera mints — the "${namespace}" namespace may hold ATF records Tessera did not create. Nothing was contacted or deleted. If this namespace is Tessera's, re-run with --confirm-unrecorded ${runId}; the ATF store still refuses any row without this run's ownership marker.`,
    );
    context.stderr("");
    return EXIT_CODES.refused;
  }

  let harness: Harness | undefined;
  let release: (() => void) | undefined;
  try {
    harness = await stage(
      {
        instanceHost: runner.ref.host,
        ledgerRoot,
        fake: false,
        variant: "correct",
        fakeProductionProperty: false,
        keepLedger: false,
        bindAmbientInstance: false,
      },
      context.cwd,
    );
    const ledger = createIntentLedger({
      rootDir: ledgerRoot,
      now: context.now,
    });
    const guard = createTargetGuard(
      {
        nonProdAllowlist: lists.get("--allow") ?? [],
        prodInstances: lists.get("--prod") ?? [],
        ...(acknowledgeReason === undefined
          ? {}
          : {
              acknowledgeProd: {
                reason: acknowledgeReason,
                actor,
                surface: "cli",
              } satisfies AcknowledgeProd,
            }),
      },
      {
        probe: createGuardProbe([
          {
            ref: runner.ref,
            probe: bindProbe(createSnInstanceProbe(), runner.profile),
          },
        ]),
        audit: createLedgerGuardAuditSink(ledger),
        runId,
        now: () => context.now().toISOString(),
      },
    );
    const classification = await guard.classify(runner.ref, "runner");
    // §11.5, then §11.3 for the delete itself — a GuardViolation propagates
    // and `cli.ts` renders it as a refusal (exit 4).
    guard.assertRunnerWritable(classification);
    guard.assertWrite(classification, {
      op: "delete",
      table: ATF_STORE_TABLES.test,
      description: `cleanup of run ${runId} (§4a ephemeral namespace "${namespace}")`,
    });

    const store = createAtfTestStore({
      client: bindTestStoreClient(
        seams.testStoreClient ?? createSnTestStoreClient(),
        runner.profile,
      ),
      lockPath: path.join(ledgerRoot, PROJECTION_LOCK_FILENAME),
      onWarning: (message) => context.stderr(`warning: ${message}`),
      // Delegated decision 2026-09-28 (wave 13): cleanup always passes the
      // DEV-17 trigger count below, so a context without one is a bug here —
      // refused, never silently served by the pre-wave-13 gate.
      requireRecordedTriggers: true,
    });
    release = () => store.release();

    if (known !== undefined && known.state !== "done") {
      await ledger.transition(runId, "tearing-down");
    }
    try {
      const teardownCtx: AtfTeardownContext = {
        runId,
        lifecycle: "ephemeral",
        coverageSource: "ephemeral",
        topology: {
          source: runner.profile,
          runner: runner.profile,
          target: runner.profile,
        },
        signal: new AbortController().signal,
        ...(neverTriggered ? { neverTriggered: true } : {}),
        recordedTriggers,
      };
      await store.teardown(teardownCtx);
    } catch (error) {
      if (known !== undefined && known.state !== "done") {
        await ledger.transition(runId, "failed");
      }
      if ((error as { code?: unknown }).code === "non-terminal-run") {
        context.stderr("");
        context.stderr(`REFUSED (DEV-17): ${describe(error)}`);
        context.stderr("");
        return EXIT_CODES.refused;
      }
      // Delegated decision 2026-09-26 (F2a/b): the store refused before any
      // DELETE because a namespaced row is not provably this run's. That is a
      // refusal (exit 4, nothing deleted), not a teardown fault — but the
      // record stays `failed`, since the run's own rows were not removed.
      if ((error as { code?: unknown }).code === "not-run-owned") {
        context.stderr("");
        context.stderr(`REFUSED (ownership): ${describe(error)}`);
        context.stderr("");
        return EXIT_CODES.refused;
      }
      throw error;
    }
    let settled = 0;
    if (known !== undefined) {
      // As `runPipeline`'s own teardown: the store deleted the whole run-id
      // namespace in the DEV-13 order, so every entry — a W1/W2 orphan
      // included — is settled. Compensating a compensated entry is a no-op.
      const plan = await ledger.recover(runId);
      for (const entry of plan.teardownOrder) {
        await ledger.compensate(runId, entry.seq);
        settled += 1;
      }
      if (known.state !== "done") await ledger.transition(runId, "done");
    }
    await recordCleanupEvent(ledgerRoot, context, runId, known, settled);

    const outcome = {
      runId,
      mode,
      runner: runner.profile,
      runnerHost: runner.ref.host,
      from: known?.state ?? null,
      state: known === undefined ? null : "done",
      ledgerEntriesSettled: settled,
    };
    if (common.json) {
      context.stdout(JSON.stringify(outcome, null, 2));
    } else {
      context.stdout(
        `tess cleanup — run ${runId} torn down on ${runner.ref.host}`,
      );
      context.stdout(
        `  local:    ${known === undefined ? "no run record — namespace sweep only" : `${known.state} → done; ${settled} ledger entr${settled === 1 ? "y" : "ies"} settled`}`,
      );
    }
    return EXIT_CODES.ok;
  } finally {
    release?.();
    harness?.restore();
  }
}

/** Best effort: a cleanup is visible to `tess status` as an event. */
async function recordCleanupEvent(
  ledgerRoot: string,
  context: CliContext,
  runId: string,
  known: RunStateRecord | undefined,
  settled: number,
): Promise<void> {
  if (known === undefined) return;
  try {
    await createRunEventLog({
      rootDir: ledgerRoot,
      now: context.now,
    }).appendEvent(runId, {
      type: "cleanup",
      data: { from: known.state, settled },
    });
  } catch (error) {
    if (isRunNotFound(error)) return;
    context.stderr(
      `warning: the cleanup event was not recorded (${describe(error)})`,
    );
  }
}

// ── cleanup --legacy ────────────────────────────────────────────────────────

/** The flags `cleanup --legacy` refuses outright, and why (all exit 2). */
const LEGACY_REFUSED_FLAGS: ReadonlyArray<readonly [string, string]> = [
  // Delegated decision 2026-09-30 (wave 14): a legacy sweep has no run id to
  // scope an audited override to (§11.4 needs one, plus a ledger sink), so a
  // prod-suspect runner is never lifted here — fail closed.
  [
    "--acknowledge-prod",
    "--acknowledge-prod is not accepted with --legacy: a legacy sweep has no run to scope an audited §11.4 override to",
  ],
  [
    "--confirm-unrecorded",
    "--confirm-unrecorded belongs to a run-scoped cleanup; --legacy is confirmed by sys_id in --confirm",
  ],
  [
    "--actor",
    "--actor is not accepted with --legacy: there is no override to attribute",
  ],
];

/** The legacy sweep's flags beyond the shared ones. */
const LEGACY_CLEANUP_ARGS = {
  values: [
    "--runner",
    "--mode",
    "--report",
    "--confirm",
    ...LEGACY_REFUSED_FLAGS.map(([flag]) => flag),
  ],
  repeatable: ["--allow", "--prod", "--run-id"],
};

/**
 * Parses a report file written by `tess cleanup --legacy --json`. Anything
 * that is not one is the caller's mistake (exit 2) — reported before any
 * instance is contacted. `deleteLegacyAtfRows` re-checks the same shape and
 * then re-reads every confirmed row fresh, so this is a courtesy, not the gate.
 */
function readLegacyReport(
  context: CliContext,
  raw: string,
): { ok: true; report: LegacyAtfReport } | { ok: false; message: string } {
  const file = path.resolve(context.cwd, raw);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return {
      ok: false,
      message: `--report ${JSON.stringify(raw)} cannot be read (${describe(error)})`,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      message: `--report ${JSON.stringify(raw)} is not JSON (${describe(error)})`,
    };
  }
  const record =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const scope =
    typeof record?.["scope"] === "object" && record["scope"] !== null
      ? (record["scope"] as Record<string, unknown>)
      : undefined;
  if (
    record === undefined ||
    record["kind"] !== LEGACY_ATF_REPORT_KIND ||
    !Array.isArray(record["candidates"]) ||
    !Array.isArray(record["conflicts"]) ||
    scope === undefined ||
    !Array.isArray(scope["runIds"]) ||
    !(scope["runIds"] as unknown[]).every((id) => typeof id === "string")
  ) {
    return {
      ok: false,
      message: `--report ${JSON.stringify(raw)} is not a ${LEGACY_ATF_REPORT_KIND} report (write one with \`tess cleanup --legacy --json\`)`,
    };
  }
  return { ok: true, report: value as LegacyAtfReport };
}

function renderLegacyRefusal(
  context: CliContext,
  error: LegacyCleanupRefusalError,
): ExitCode {
  context.stderr("");
  context.stderr(
    `REFUSED (legacy: ${error.reason}): ${describe(error)}. Nothing was deleted.`,
  );
  context.stderr("");
  return EXIT_CODES.refused;
}

function renderLegacyPlan(
  context: CliContext,
  runner: { profile: string; ref: { host: string } },
  report: LegacyAtfReport,
): void {
  const tests = report.candidates.filter(
    (c) => c.table === ATF_STORE_TABLES.test,
  ).length;
  const suites = report.candidates.length - tests;
  context.stdout(
    `tess cleanup --legacy — plan on ${runner.profile} (${runner.ref.host}) (nothing written)`,
  );
  context.stdout(
    `  scope:      minted run ids${report.scope.runIds.length === 0 ? "" : `, plus ${report.scope.runIds.join(", ")}`}`,
  );
  context.stdout(
    `  candidates: ${report.candidates.length} (${tests} test(s), ${suites} suite(s)) — rows named "<run-id>:…" with no Tessera ownership marker`,
  );
  for (const candidate of report.candidates) {
    context.stdout(
      `    ${candidate.table} ${candidate.sysId}  ${JSON.stringify(candidate.name)}`,
    );
    context.stdout(
      `        run ${candidate.runId} (${candidate.matchedBy}); created ${candidate.createdOn} by ${candidate.createdBy}; updated ${candidate.updatedOn}`,
    );
    context.stdout(
      `        ${candidate.steps} step(s), ${candidate.stepInputs} step input(s), ${candidate.links.length} suite link(s), ${candidate.suiteResults.length} suite result(s)`,
    );
    context.stdout(
      `        description: ${JSON.stringify(candidate.description)}`,
    );
    for (const blocker of candidate.blockers) {
      context.stdout(`        BLOCKED: ${blocker}`);
    }
  }
  context.stdout(
    `  conflicts:  ${report.conflicts.length} — rows carrying ANOTHER run's ownership marker; never deleted here`,
  );
  for (const conflict of report.conflicts) {
    context.stdout(
      `    ${conflict.table} ${conflict.sysId}  ${JSON.stringify(conflict.name)} (run ${conflict.runId}): ${JSON.stringify(conflict.description)}`,
    );
  }
  context.stdout(
    "To delete: save this report with --json, review it, and re-run with --mode apply --report <file> --confirm <sys_id,...>.",
  );
}

/**
 * `tess cleanup --legacy [--mode plan|apply]` — the operator-confirmed sweep of
 * ATF rows written before the ownership marker existed (teststore-atf
 * `legacy.ts`). The run-scoped cleanup refuses such rows (F2a/b) and never
 * will delete them; this path deletes them only by explicit sys_id.
 *
 *  * plan (default): GETs only — `discoverLegacyAtfRows`, printed as a table
 *    with each candidate's blockers, or the raw report under `--json`.
 *    `--run-id` (repeatable) adds explicit run ids to the minted-shape scope.
 *  * apply: `--report <file>` (a plan's `--json`) and `--confirm
 *    <sys_id,...>`, behind the §11 guard (a production runner is refused
 *    exactly as a run-scoped cleanup's is); then `deleteLegacyAtfRows`, which
 *    re-reads every confirmed row and refuses (exit 4, nothing deleted) on any
 *    drift.
 */
async function legacyCleanupCommand(
  argv: readonly string[],
  context: CliContext,
  seams: CleanupSeams,
): Promise<number> {
  const parsed = parseArgs(argv, LEGACY_CLEANUP_ARGS);
  if (parsed.kind === "error") return usage(context, "cleanup", parsed.message);
  const { common, values, lists } = parsed;
  for (const [flag, message] of LEGACY_REFUSED_FLAGS) {
    if (values.has(flag)) return usage(context, "cleanup", message);
  }
  if (common.ledgerRoot !== undefined) {
    return usage(
      context,
      "cleanup",
      "--ledger-root is not accepted with --legacy: a legacy sweep reads and writes no ledger",
    );
  }
  const mode = values.get("--mode") ?? "plan";
  if (mode !== "plan" && mode !== "apply") {
    return usage(
      context,
      "cleanup",
      `--mode expects plan or apply, got ${JSON.stringify(mode)}`,
    );
  }
  const runIds = lists.get("--run-id") ?? [];
  for (const runId of runIds) {
    const problem = invalidRunId(runId);
    if (problem !== undefined) return usage(context, "cleanup", problem);
  }
  const reportFlag = values.get("--report");
  const confirmFlag = values.get("--confirm");
  if (mode === "plan") {
    if (reportFlag !== undefined || confirmFlag !== undefined) {
      return usage(
        context,
        "cleanup",
        "--report and --confirm are apply-mode flags (add --mode apply)",
      );
    }
  } else {
    // Delegated decision 2026-09-30 (wave 14): apply's scope is the report's,
    // never re-typed — a `--run-id` beside it could only disagree with it.
    if (runIds.length > 0) {
      return usage(
        context,
        "cleanup",
        "--run-id is a plan-mode flag with --legacy; apply takes its scope from --report",
      );
    }
    if (reportFlag === undefined) {
      return usage(
        context,
        "cleanup",
        "cleanup --legacy --mode apply needs --report <file> (a `tess cleanup --legacy --json` plan)",
      );
    }
    if (confirmFlag === undefined) {
      return usage(
        context,
        "cleanup",
        "cleanup --legacy --mode apply needs --confirm <sys_id,...> — deletion never selects rows by pattern",
      );
    }
  }
  let runner;
  try {
    runner = bindRole("runner", values.get("--runner") ?? "default");
  } catch (error) {
    if (error instanceof TopologyError) {
      return usage(context, "cleanup", error.message);
    }
    throw error;
  }

  let report: LegacyAtfReport | undefined;
  let confirmed: string[] = [];
  if (mode === "apply") {
    const read = readLegacyReport(context, reportFlag ?? "");
    if (!read.ok) return usage(context, "cleanup", read.message);
    report = read.report;
    confirmed = (confirmFlag ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if (confirmed.length === 0) {
      return usage(
        context,
        "cleanup",
        "--confirm names no sys_id — deletion never selects rows by pattern",
      );
    }
  }

  const restoreDocsDir = stageDocsDir({ cwd: context.cwd });
  try {
    const client = bindTestStoreClient(
      seams.testStoreClient ?? createSnTestStoreClient(),
      runner.profile,
    );
    if (mode === "plan" || report === undefined) {
      // Delegated decision 2026-09-30 (wave 14): plan issues GETs only, so it
      // runs no §11 guard — like `doctor`, a read is allowed against any
      // role, and an inventory of a production runner's legacy rows is
      // exactly what an operator needs before deciding anything.
      let discovered: LegacyAtfReport;
      try {
        discovered = await discoverLegacyAtfRows({
          client,
          ...(runIds.length === 0 ? {} : { runIds }),
        });
      } catch (error) {
        if (error instanceof LegacyCleanupRefusalError) {
          return renderLegacyRefusal(context, error);
        }
        throw error;
      }
      if (common.json) context.stdout(JSON.stringify(discovered, null, 2));
      else renderLegacyPlan(context, runner, discovered);
      return EXIT_CODES.ok;
    }

    // §11.5 then §11.3, as a run-scoped cleanup: a GuardViolation propagates
    // and `cli.ts` renders it as a refusal (exit 4) before any row is read.
    const guard = createTargetGuard(
      {
        nonProdAllowlist: lists.get("--allow") ?? [],
        prodInstances: lists.get("--prod") ?? [],
      },
      {
        probe: createGuardProbe([
          {
            ref: runner.ref,
            probe: bindProbe(createSnInstanceProbe(), runner.profile),
          },
        ]),
        now: () => context.now().toISOString(),
      },
    );
    const classification = await guard.classify(runner.ref, "runner");
    guard.assertRunnerWritable(classification);
    guard.assertWrite(classification, {
      op: "delete",
      table: ATF_STORE_TABLES.test,
      description: `legacy ATF cleanup of ${confirmed.length} operator-confirmed row(s)`,
    });

    let result;
    try {
      result = await deleteLegacyAtfRows({
        client,
        report,
        confirmedSysIds: confirmed,
      });
    } catch (error) {
      if (error instanceof LegacyCleanupRefusalError) {
        return renderLegacyRefusal(context, error);
      }
      throw error;
    }
    if (common.json) {
      context.stdout(
        JSON.stringify(
          {
            mode,
            runner: runner.profile,
            runnerHost: runner.ref.host,
            deleted: result.deleted,
          },
          null,
          2,
        ),
      );
    } else {
      context.stdout(
        `tess cleanup --legacy — deleted ${result.deleted.length} row(s) on ${runner.ref.host}`,
      );
      for (const row of result.deleted) {
        context.stdout(`  ${row.table} ${row.sysId}`);
      }
    }
    return EXIT_CODES.ok;
  } finally {
    restoreDocsDir();
  }
}
