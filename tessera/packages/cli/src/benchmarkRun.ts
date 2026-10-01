// `tess benchmark` — the S5 OutcomeGate harness (DESIGN §13), composed.
//
// Delegated decision 2026-09-24 (TODO "S5 benchmark follow-ups"): the harness
// (`@tessera/benchmark`) and its instance adapter existed with no operator
// surface. This is that surface, and it is deliberately thin — every scoring
// rule lives in the package, and this module only decides WHICH instance, WHICH
// catalog and WHICH generation config a run is bound to.
//
// What it composes, in order, and why the order is load-bearing:
//
//  1. **Inputs before instances.** The pinned generation config (§12.3) and
//     the catalog are read and validated before any profile is bound. A
//     catalog the loader refuses (no sign-off, a category under the floor, a
//     fixture label on a "real" set) is a refusal with exit 4 and nothing
//     staged: there is no default catalog, and there never will be one — the
//     real set is hand-authored by the QA owner (§13.4).
//  2. **§11 classification of the runner** on a probe bound to the runner
//     PROFILE, then `assertRunnerWritable` — the §11.5 composition-time gate,
//     before any adapter is constructed. A benchmark rewrites the source of
//     every target in its scope (that is what a mutant IS), so a runner that is
//     not an allowlisted sub-prod instance never gets that far; the
//     GuardViolation propagates and `cli.ts` maps it to exit 4.
//  3. **The same ports `tess run --live` uses** (`composeRealPipeline`), with
//     the provider built from the pinned config so the ResultKey records the
//     generator that actually ran — a template provider with its default
//     (unpinned) config would fail the key check, and it should.
//  4. **The instance substrate** — a Table-API-only adapter whose client is
//     bound to the runner profile here, because `createSnBenchmarkClient()`
//     speaks through the ambient `snRequest` and knows no profiles.
//
// Exit codes (documented in `tess benchmark --help`):
//   0 GO on a real (non-fixture) catalog
//   1 MISS — measured and below the §13.1 bar
//   2 usage
//   3 infrastructure fault (thrown, mapped by `cli.ts`)
//   4 refused — §11, a catalog the loader will not score, or a pinned
//     promptHash that is not this build's instructionHash (wave 14)
//   5 VOID (a substrate control went red: SUB-1..5 — never a miss), or a GO on
//     a FIXTURE catalog: a fixture can exercise the harness, but a finding
//     built from it is forced to `open`, so it has no standing to exit 0.
//
// Restore journal (F4/F5, 2026-09-26). A benchmark PATCHes the correct source
// of every artifact in scope; a crash between a PATCH and the final restore
// used to leave a mutant live with the correct text only in memory. Now:
//
//   * the production composition hands the substrate a durable file journal
//     at `<ledger-root>/benchmark/<run-id>/restore-journal.json`, written
//     before the first PATCH and removed only after a verified final restore;
//   * a run refuses to start (exit 4) while an unrestored journal exists for
//     the same run id or for any artifact its catalog touches — the scan is
//     read-only and happens before composition;
//   * SIGINT/SIGTERM abort the run through an AbortController, so the
//     harness's final restore still runs. A second signal does NOT skip it:
//     it is acknowledged on stderr and ignored. Only SIGKILL (or a power
//     cut) can skip the restore, and then the journal is left on disk for
//     `tess benchmark --restore <run-id>`;
//   * anything the final restore could not put back is named on stderr and
//     in the `--json` document (`unrestored`), and its journal is kept;
//   * `tess benchmark --restore <run-id>` writes every journaled source back,
//     verifies it, removes the journal and releases the crashed run's own
//     lease row. Exit 0 restored, 2 usage (no such journal), 3 something
//     still unrestored or the lease could not be released (the manual step
//     is printed), 4 refused (corrupt journal, a writer that may still be
//     alive, or a runner that is not the journal's instance).

import {
  access,
  constants,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  CatalogError,
  DESIGN_GATE_POLICY,
  createInstanceBenchmarkSubstrate,
  createSnBenchmarkClient,
  formatS5Record,
  pinnedGenConfigProblems,
  readCatalogFile,
  runBenchmark,
  toS5Record,
  type BenchmarkCatalog,
  type BenchmarkHttpClient,
  type BenchmarkPipeline,
  type BenchmarkRunRecord,
  type BenchmarkSubstrate,
  type JournalWriterLiveness,
  type PinnedGenConfig,
  type RestoreFromJournalResult,
  type RestoreJournal,
  type RestoreJournalDocument,
  RestoreJournalError,
  createFileRestoreJournal,
  findRestoreJournals,
  journalWriterLiveness,
  readRestoreJournal,
  restoreFromJournal,
  restoreJournalPath,
} from "@tessera/benchmark";
import type { Runner, TestStore } from "@tessera/core";
import { createSnInstanceProbe } from "@tessera/doctor";
import {
  GenerateInputError,
  createAnthropicProvider,
  createTemplateProvider,
  instructionHashFor,
  type LLMProvider,
} from "@tessera/generate";
import { createTargetGuard, type AcknowledgeProd } from "@tessera/guard";
import { RUN_ID_PATTERN, createIntentLedger } from "@tessera/ledger";
import { createLedgerGuardAuditSink } from "@tessera/phase05";
import { runWithProfile } from "@tessera/sn-client";
import type { AtfTeardownContext } from "@tessera/teststore-atf";
import type { TestKind } from "@tessera/types";

import { nodeFetch } from "./commands/generate.js";
import type { CliContext } from "./context.js";
import { EXIT_CODES, type ExitCode } from "./exitCodes.js";
import { PROJECTION_LOCK_FILENAME } from "./liveRun.js";
import { composeRealPipeline } from "./registries.js";
import { stage, type Harness } from "./stage.js";
import {
  bindProbe,
  bindRole,
  createGuardProbe,
  TopologyError,
  type RoleBinding,
} from "./topology.js";

/** The `--json` document's discriminator. */
export const BENCHMARK_RESULT_KIND = "tessera.benchmark-run";

export type BenchmarkProviderName = "template" | "anthropic";

export interface BenchmarkCommandOptions {
  /** Path to the hand-authored catalog. Required — there is no default. */
  readonly catalogPath: string;
  /** Path to the pinned generation config JSON (DESIGN §12.3). */
  readonly genConfigPath: string;
  readonly provider: BenchmarkProviderName;
  /** k. Omitted: the policy's minimum. */
  readonly repetitions?: number;
  readonly runner: string;
  readonly source: string;
  readonly scope: string;
  /** Where generated specs land. Default: under the ledger root, per run. */
  readonly testsRoot?: string;
  readonly nonProdAllowlist: readonly string[];
  readonly prodInstances: readonly string[];
  readonly acknowledgeProd?: AcknowledgeProd;
  readonly actor: string;
  readonly runId: string;
  readonly ledgerRoot?: string;
  readonly docsDir?: string;
  /** Where the S5 record is written as JSON. Omitted: stdout only. */
  readonly out?: string;
  readonly json: boolean;
}

/** `tess benchmark --restore <run-id>` — recover a crashed run's scope. */
export interface BenchmarkRestoreOptions {
  readonly runId: string;
  /** Omitted: the profile recorded in the journal. */
  readonly runner?: string;
  readonly nonProdAllowlist: readonly string[];
  readonly prodInstances: readonly string[];
  readonly acknowledgeProd?: AcknowledgeProd;
  readonly actor: string;
  readonly ledgerRoot?: string;
  readonly docsDir?: string;
  /** Restore even when the journal's writer may still be running. */
  readonly ignoreLivePid: boolean;
  readonly json: boolean;
}

export type BenchmarkParse =
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "benchmark"; readonly options: BenchmarkCommandOptions }
  | { readonly kind: "restore"; readonly options: BenchmarkRestoreOptions };

/** The `--json` document's discriminator for `--restore`. */
export const BENCHMARK_RESTORE_RESULT_KIND = "tessera.benchmark-restore";

/** What the composition step hands the harness. */
export interface BenchmarkComposition {
  readonly substrate: BenchmarkSubstrate;
  readonly pipeline: BenchmarkPipeline;
  readonly topology?: {
    readonly source: string;
    readonly runner: string;
    readonly target: string;
  };
  /** Lines rendered under the header (topology, ledger, acknowledgements). */
  readonly notes: readonly string[];
  /**
   * The restore journal the substrate records into. After the run, any entry
   * still in it is an artifact the final restore could not put back.
   */
  readonly journal?: RestoreJournal;
  /** Runs in a `finally`, whatever the run did. */
  release(): void;
}

/** What `--restore` needs: a client bound to the §11-checked runner. */
export interface BenchmarkRestoreComposition {
  readonly client: BenchmarkHttpClient;
  /** The runner's instance host — must equal the journal's. */
  readonly instance: string;
  readonly runnerProfile: string;
  readonly notes: readonly string[];
  release(): void;
}

export interface BenchmarkRestoreComposeInput {
  readonly options: BenchmarkRestoreOptions;
  readonly context: CliContext;
}

export type BenchmarkSignal = "SIGINT" | "SIGTERM";

/** Where termination signals come from. Production: `process`. */
export interface BenchmarkSignalSource {
  on(signal: BenchmarkSignal, handler: () => void): void;
  off(signal: BenchmarkSignal, handler: () => void): void;
}

const PROCESS_SIGNALS: BenchmarkSignalSource = {
  on: (signal, handler) => {
    process.on(signal, handler);
  },
  off: (signal, handler) => {
    process.off(signal, handler);
  },
};

export interface BenchmarkComposeInput {
  readonly options: BenchmarkCommandOptions;
  readonly provider: LLMProvider;
  readonly context: CliContext;
}

/**
 * Seams for tests. Production composes against the runner profile; a test
 * injects a substrate + pipeline over `@tessera/fake-instance`.
 */
export interface BenchmarkSeams {
  compose?(input: BenchmarkComposeInput): Promise<BenchmarkComposition>;
  composeRestore?(
    input: BenchmarkRestoreComposeInput,
  ): Promise<BenchmarkRestoreComposition>;
  /** Default: `process`. */
  signals?: BenchmarkSignalSource;
  /** Default: `journalWriterLiveness` (signal 0 on this host). */
  readonly liveness?: (
    document: RestoreJournalDocument,
  ) => JournalWriterLiveness;
  /** Backoff between restore attempts. Default: a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

function positiveInteger(
  raw: string | undefined,
  flag: string,
): number | string {
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value <= 0) {
    return `${flag} expects a positive integer (got ${JSON.stringify(raw ?? "")})`;
  }
  return value;
}

/** Hand-rolled like `run`'s parser: argv only, no env or config-file layer. */
export function parseBenchmarkArgs(
  argv: readonly string[],
  context: CliContext,
): BenchmarkParse {
  let catalogPath: string | undefined;
  let genConfigPath: string | undefined;
  let provider: BenchmarkProviderName = "template";
  let repetitions: number | undefined;
  let runnerProfile: string | undefined;
  let sourceProfile: string | undefined;
  let scope: string | undefined;
  let testsRoot: string | undefined;
  const nonProdAllowlist: string[] = [];
  const prodInstances: string[] = [];
  let acknowledgeReason: string | undefined;
  let actor = context.actor;
  let runId: string | undefined;
  let ledgerRoot: string | undefined;
  let docsDir: string | undefined;
  let out: string | undefined;
  let json = false;
  let restoreRunId: string | undefined;
  let ignoreLivePid = false;
  // Flags that only mean something for a measured run; `--restore` refuses
  // them rather than silently ignoring them.
  const runOnly: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    const value = (): string | undefined => argv[++index];
    switch (flag) {
      case "--catalog":
      case "--gen-config":
      case "--runner":
      case "--source":
      case "--scope":
      case "--tests-root":
      case "--allow":
      case "--prod":
      case "--actor":
      case "--run-id":
      case "--ledger-root":
      case "--docs-dir":
      case "--out":
      case "--restore": {
        const raw = value();
        if (raw === undefined || raw.trim() === "")
          return { kind: "error", message: `${flag} expects a value` };
        if (
          flag === "--catalog" ||
          flag === "--gen-config" ||
          flag === "--source" ||
          flag === "--scope" ||
          flag === "--tests-root" ||
          flag === "--run-id" ||
          flag === "--out"
        ) {
          runOnly.push(flag);
        }
        if (flag === "--restore") restoreRunId = raw;
        else if (flag === "--catalog") catalogPath = raw;
        else if (flag === "--gen-config") genConfigPath = raw;
        else if (flag === "--runner") runnerProfile = raw;
        else if (flag === "--source") sourceProfile = raw;
        else if (flag === "--scope") scope = raw;
        else if (flag === "--tests-root") testsRoot = raw;
        else if (flag === "--allow") nonProdAllowlist.push(raw);
        else if (flag === "--prod") prodInstances.push(raw);
        else if (flag === "--actor") actor = raw;
        else if (flag === "--run-id") runId = raw;
        else if (flag === "--ledger-root") ledgerRoot = raw;
        else if (flag === "--docs-dir") docsDir = raw;
        else out = raw;
        break;
      }
      case "--ignore-live-pid":
        ignoreLivePid = true;
        break;
      case "--provider": {
        runOnly.push(flag);
        const raw = value();
        if (raw !== "template" && raw !== "anthropic") {
          return {
            kind: "error",
            message: `--provider expects "template" or "anthropic" (got ${JSON.stringify(raw ?? "")})`,
          };
        }
        provider = raw;
        break;
      }
      case "--repetitions": {
        runOnly.push(flag);
        const parsed = positiveInteger(value(), flag);
        if (typeof parsed === "string")
          return { kind: "error", message: parsed };
        repetitions = parsed;
        break;
      }
      case "--acknowledge-prod":
        acknowledgeReason = value();
        if (
          acknowledgeReason === undefined ||
          acknowledgeReason.trim() === ""
        ) {
          return {
            kind: "error",
            message:
              "--acknowledge-prod expects a mandatory, non-empty reason (§11.4)",
          };
        }
        break;
      case "--json":
        json = true;
        break;
      default:
        return { kind: "error", message: `unknown option ${flag}` };
    }
  }

  const acknowledgeProd: AcknowledgeProd | undefined =
    acknowledgeReason === undefined
      ? undefined
      : { reason: acknowledgeReason, actor, surface: "cli" };

  if (restoreRunId !== undefined) {
    // Delegated decision 2026-09-26: `--restore` is a separate mode, not a
    // modifier. A run-only flag next to it is a usage error (2) — silently
    // dropping `--catalog` would let an operator believe a run happened.
    if (runOnly.length > 0) {
      return {
        kind: "error",
        message: `--restore cannot be combined with ${[...new Set(runOnly)].join(", ")}: it only writes a crashed run's journaled sources back`,
      };
    }
    if (!RUN_ID_PATTERN.test(restoreRunId)) {
      return {
        kind: "error",
        message: `--restore ${JSON.stringify(restoreRunId)} is not a valid run id: expected 1-128 chars matching ${RUN_ID_PATTERN.source}`,
      };
    }
    return {
      kind: "restore",
      options: {
        runId: restoreRunId,
        ...(runnerProfile === undefined ? {} : { runner: runnerProfile }),
        nonProdAllowlist,
        prodInstances,
        ...(acknowledgeProd === undefined ? {} : { acknowledgeProd }),
        actor,
        ...(ledgerRoot === undefined ? {} : { ledgerRoot }),
        ...(docsDir === undefined ? {} : { docsDir }),
        ignoreLivePid,
        json,
      },
    };
  }
  if (ignoreLivePid) {
    return {
      kind: "error",
      message: "--ignore-live-pid only applies to --restore <run-id>",
    };
  }

  if (catalogPath === undefined) {
    return {
      kind: "error",
      message:
        "--catalog <path> is required: there is no default catalog — the benchmark set is hand-authored by the QA owner (DESIGN §13.4)",
    };
  }
  if (genConfigPath === undefined) {
    return {
      kind: "error",
      message:
        "--gen-config <path> is required: a result is keyed to the exact generation config that produced it (DESIGN §12.3, SUB-4)",
    };
  }
  if (scope === undefined) {
    return {
      kind: "error",
      message:
        "--scope <app scope> is required: impact analysis traces one scope, and there is no honest default",
    };
  }
  if (runId === undefined) {
    return {
      kind: "error",
      message:
        "--run-id <id> is required: the benchmark namespaces every staged spec and every lease by it",
    };
  }
  // The run id becomes a directory name under the ledger root
  // (`<ledger-root>/benchmark/<run-id>/tests`), so it is held to the ledger's
  // own run-id rule (ARCH-16): no separators, no traversal, no leading dot.
  if (!RUN_ID_PATTERN.test(runId)) {
    return {
      kind: "error",
      message: `--run-id ${JSON.stringify(runId)} is not a valid run id: expected 1-128 chars matching ${RUN_ID_PATTERN.source}`,
    };
  }
  const runnerName = runnerProfile ?? "default";
  return {
    kind: "benchmark",
    options: {
      catalogPath: path.resolve(context.cwd, catalogPath),
      genConfigPath: path.resolve(context.cwd, genConfigPath),
      provider,
      ...(repetitions === undefined ? {} : { repetitions }),
      runner: runnerName,
      source: sourceProfile ?? runnerName,
      scope,
      ...(testsRoot === undefined
        ? {}
        : { testsRoot: path.resolve(context.cwd, testsRoot) }),
      nonProdAllowlist,
      prodInstances,
      ...(acknowledgeProd === undefined ? {} : { acknowledgeProd }),
      actor,
      runId,
      ...(ledgerRoot === undefined ? {} : { ledgerRoot }),
      ...(docsDir === undefined ? {} : { docsDir }),
      ...(out === undefined ? {} : { out: path.resolve(context.cwd, out) }),
      json,
    },
  };
}

/** The exit code for a finished benchmark run — see the header. */
export function benchmarkExitCode(record: BenchmarkRunRecord): ExitCode {
  switch (record.result.status) {
    case "void":
      return EXIT_CODES.inconclusive;
    case "miss":
      return EXIT_CODES.noGo;
    case "go":
      return record.catalog.fixture ? EXIT_CODES.inconclusive : EXIT_CODES.ok;
  }
}

/** Read and validate the pinned generation config, or say why not. */
export async function readGenConfigFile(
  file: string,
): Promise<{ config: PinnedGenConfig } | { problems: string[] }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    return {
      problems: [
        `cannot read the generation config ${file}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
  const problems = pinnedGenConfigProblems(raw);
  if (problems.length > 0) return { problems };
  const c = raw as Record<string, unknown>;
  // Copied field by field: extra keys in the file must not ride into the
  // ResultKey, where they would change its hash without changing the run.
  return {
    config: {
      modelId: c["modelId"] as string,
      temperature: c["temperature"] as number,
      maxTokens: c["maxTokens"] as number,
      promptHash: c["promptHash"] as string,
      promptVersion: c["promptVersion"] as string,
    },
  };
}

/** The one kind a benchmark generates and runs — the composition is unit-only. */
const BENCHMARK_KIND: TestKind = "unit";

/**
 * The `instructionHash` this build's generator renders for `kind` — the value
 * a `PinnedGenConfig.promptHash` pins (DESIGN §12.3). It hashes the
 * instruction channel alone; `@tessera/generate`'s `instructionHashFor` owns
 * the computation, so this check and the generator cannot disagree about it.
 */
export function currentInstructionHash(
  kind: TestKind = BENCHMARK_KIND,
): string {
  return instructionHashFor(kind);
}

/**
 * Why a pinned `promptHash` cannot be honoured by this build, or `undefined`.
 * A blank hash is "not pinned" and is not this check's business (the pin
 * validator decides whether a blank is acceptable where it is read).
 *
 * Delegated decision 2026-09-30 (wave 14): a pinned hash that differs from the
 * generator's current `instructionHash` is REFUSED (exit 4) before anything is
 * staged, for every provider — the template provider included. The hash is
 * part of the S5 result key, so running anyway would record a key naming a
 * prompt this build does not send; a warning would let that record through.
 * Re-pinning is the remedy, and the message names the value to pin.
 */
export function promptHashDrift(
  config: Pick<PinnedGenConfig, "promptHash">,
  kind: TestKind = BENCHMARK_KIND,
): string | undefined {
  if (config.promptHash === "") return undefined;
  const current = currentInstructionHash(kind);
  if (config.promptHash === current) return undefined;
  return `the pinned promptHash ${config.promptHash} is not this build's ${kind} generation instructionHash ${current}; the frozen generation prompt changed since the config was pinned, so a result keyed on the pin would name a prompt that is no longer sent — re-pin promptHash to ${current} (and bump promptVersion) deliberately, or run the build that matches the pin`;
}

function usage(context: CliContext, message: string): ExitCode {
  context.stderr(`tess: ${message}`);
  context.stderr("");
  context.stderr("Run `tess benchmark --help` for usage.");
  return EXIT_CODES.usage;
}

/** A benchmark client whose every request runs under the runner profile. */
export function bindBenchmarkClient(
  client: BenchmarkHttpClient,
  profile: string,
): BenchmarkHttpClient {
  return {
    request: (args) => runWithProfile(profile, () => client.request(args)),
  };
}

/**
 * The production composition: §11 on the runner, then the real ports and the
 * instance substrate, all bound to the runner profile.
 */
export async function composeInstanceBenchmark(
  input: BenchmarkComposeInput,
): Promise<BenchmarkComposition> {
  const { options, provider, context } = input;
  const runner: RoleBinding = bindRole("runner", options.runner);
  const source: RoleBinding = bindRole("source", options.source);

  let harness: Harness | undefined;
  let releaseStore: (() => void) | undefined;
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
        bindAmbientInstance: false,
      },
      context.cwd,
    );
    const ledgerRoot = harness.ledgerRoot;

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
    // §11.5: before any adapter exists. Throws GuardViolation → exit 4.
    guard.assertRunnerWritable(classification);

    const testsRoot =
      options.testsRoot ??
      path.join(ledgerRoot, "benchmark", options.runId, "tests");
    await mkdir(testsRoot, { recursive: true });

    const discard = (): void => undefined;
    const { ports, store } = composeRealPipeline({
      sourceProfile: source.profile,
      runnerProfile: runner.profile,
      scope: options.scope,
      testsRoot,
      provider,
      now: context.now,
      console: discard,
      writeJson: discard,
      writeJUnit: discard,
      lockPath: path.join(ledgerRoot, PROJECTION_LOCK_FILENAME),
      onWarning: (message) => context.stderr(`warning: ${message}`),
      kinds: ["unit"],
    });
    releaseStore = () => store.release();

    const unitRunner = ports.runners.find((r) => r.kinds.includes("unit"));
    if (unitRunner === undefined) {
      throw new Error(
        "the real pipeline resolved no runner for kind unit; the benchmark has nothing to execute generated specs with",
      );
    }
    const counted = countSuiteTriggers(ports.store, unitRunner);

    // Delegated decision 2026-09-26 (F4): the live substrate records every
    // artifact's correct source here BEFORE its first PATCH. The first write
    // is an exclusive create, so a journal left by a crashed run with the
    // same id refuses this run instead of being overwritten.
    const journal = createFileRestoreJournal({
      file: restoreJournalPath(ledgerRoot, options.runId),
      runId: options.runId,
      runnerProfile: runner.profile,
      instance: runner.ref.host,
      now: context.now,
    });
    const substrate = createInstanceBenchmarkSubstrate({
      client: bindBenchmarkClient(createSnBenchmarkClient(), runner.profile),
      probe: runnerProbe,
      journal,
    });

    const acknowledgements = audit
      .records()
      .map(
        (entry) =>
          `acknowledged (§11.4): ${entry.role} ${entry.cls}: ${entry.reason} (${entry.actor})`,
      );
    const staged = harness;
    const storeRelease = releaseStore;
    harness = undefined;
    releaseStore = undefined;
    return {
      substrate,
      journal,
      pipeline: {
        impact: ports.impactAnalyzer,
        generator: ports.generator,
        store: counted.store,
        runner: counted.runner,
        kind: "unit",
      },
      topology: {
        source: source.profile,
        runner: runner.profile,
        target: runner.profile,
      },
      notes: [
        `topology: source=${source.profile} runner=${runner.profile} (${runner.ref.host})`,
        `ledger:   ${ledgerRoot}`,
        `journal:  ${journal.location}`,
        ...acknowledgements,
      ],
      release() {
        try {
          storeRelease();
        } finally {
          staged.restore();
        }
      },
    };
  } finally {
    // Only reached with values still set when composition threw part-way.
    releaseStore?.();
    harness?.restore();
  }
}

/**
 * DEV-17 (wave 13) — the real composition's ATF store requires the recorded
 * suite-trigger count on every teardown (`requireRecordedTriggers`). The
 * benchmark harness drives `project → run → teardown` itself, with no intent
 * ledger, so this wrapper is its record: every `runner.run()` call adds, for
 * its run id and BEFORE the runner is entered, the number of distinct suites
 * in the projection it was handed (at least one) — each is triggered at most
 * once by that call. `teardown` then passes the tally as `recordedTriggers`.
 *
 * Delegated decision 2026-09-28 (wave 13): counted before delegating, so a
 * run() that rejects still counts — whether its trigger landed is unknown,
 * and an upper bound only makes teardown refuse (fail closed). The harness
 * records a refused teardown as a warning, as before.
 */
export function countSuiteTriggers(
  store: TestStore,
  runner: Runner,
): { store: TestStore; runner: Runner } {
  const triggers = new Map<string, number>();
  return {
    runner: {
      kinds: runner.kinds,
      supports: (spec) => runner.supports(spec),
      run: (ctx, specs, emit) => {
        const suites = new Set(
          Object.values(ctx.projection ?? {}).map(
            (record) => record.suiteSysId,
          ),
        );
        triggers.set(
          ctx.runId,
          (triggers.get(ctx.runId) ?? 0) + Math.max(1, suites.size),
        );
        return runner.run(ctx, specs, emit);
      },
    },
    store: {
      project: (ctx, specs) => store.project(ctx, specs),
      teardown: (ctx) => {
        const counted: AtfTeardownContext = {
          ...ctx,
          recordedTriggers: triggers.get(ctx.runId) ?? 0,
        };
        return store.teardown(counted);
      },
    },
  };
}

/** The ledger root a command resolves to — `stage()`'s own default. */
function resolveLedgerRoot(
  ledgerRoot: string | undefined,
  context: CliContext,
): string {
  return path.resolve(context.cwd, ledgerRoot ?? ".tessera");
}

const artifactKey = (ref: { table: string; sysId: string }): string =>
  `${ref.table}/${ref.sysId}`;

/**
 * Every unrestored journal that must stop this run, as refusal lines; the
 * rest are returned as warnings. Read-only: nothing is created or removed.
 */
async function pendingJournalProblems(
  ledgerRoot: string,
  runId: string,
  catalog: BenchmarkCatalog,
): Promise<{ refusals: string[]; warnings: string[] }> {
  const touched = new Set<string>([
    ...catalog.mutants.map((m) => artifactKey(m.baseArtifact)),
    ...catalog.baselines.map((b) => artifactKey(b.artifact)),
  ]);
  const refusals: string[] = [];
  const warnings: string[] = [];
  for (const found of await findRestoreJournals(ledgerRoot)) {
    const recover = `recover with \`tess benchmark --restore ${found.runId}\``;
    if (found.document === undefined) {
      // Delegated decision 2026-09-26: fail closed. A journal that cannot be
      // read may cover any artifact, so it blocks every run until a human
      // has inspected it.
      refusals.push(
        `${found.error?.message ?? `restore journal ${found.file} is unreadable`}`,
      );
      continue;
    }
    const shared = found.document.entries
      .map(artifactKey)
      .filter((key) => touched.has(key));
    if (found.runId === runId || found.document.runId === runId) {
      refusals.push(
        `run ${runId} already has an unrestored restore journal at ${found.file}; ${recover}`,
      );
    } else if (shared.length > 0) {
      refusals.push(
        `run ${found.document.runId} left ${shared.join(", ")} unrestored (journal ${found.file}) — this catalog touches the same artifact(s); ${recover}`,
      );
    } else {
      // Delegated decision 2026-09-26: a journal for disjoint artifacts
      // cannot corrupt this run's correct-source capture, so it only warns.
      warnings.push(
        `run ${found.document.runId} has an unrestored restore journal at ${found.file} (no artifact shared with this catalog); ${recover}`,
      );
    }
  }
  return { refusals, warnings };
}

/**
 * The production composition for `--restore`: §11 on the runner (it will be
 * written to), then a Table-API client bound to its profile.
 */
export async function composeInstanceRestore(
  input: BenchmarkRestoreComposeInput,
): Promise<BenchmarkRestoreComposition> {
  const { options, context } = input;
  const runner: RoleBinding = bindRole("runner", options.runner ?? "default");
  let harness: Harness | undefined = await stage(
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
      bindAmbientInstance: false,
    },
    context.cwd,
  );
  try {
    const ledger = createIntentLedger({
      rootDir: harness.ledgerRoot,
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
    // Delegated decision 2026-09-26: a restore WRITES the runner, so it is
    // held to the same §11.5 gate as a run — no bypass for "just restoring".
    guard.assertRunnerWritable(await guard.classify(runner.ref, "runner"));
    const staged = harness;
    harness = undefined;
    return {
      client: bindBenchmarkClient(createSnBenchmarkClient(), runner.profile),
      instance: runner.ref.host,
      runnerProfile: runner.profile,
      notes: [
        `runner:   ${runner.profile} (${runner.ref.host})`,
        ...audit
          .records()
          .map(
            (entry) =>
              `acknowledged (§11.4): ${entry.role} ${entry.cls}: ${entry.reason} (${entry.actor})`,
          ),
      ],
      release() {
        staged.restore();
      },
    };
  } finally {
    harness?.restore();
  }
}

function refuse(context: CliContext, lines: readonly string[]): ExitCode {
  context.stderr("");
  for (const line of lines) context.stderr(line);
  context.stderr("");
  return EXIT_CODES.refused;
}

/** `tess benchmark --restore <run-id>`. */
async function benchmarkRestoreCommand(
  options: BenchmarkRestoreOptions,
  context: CliContext,
  seams: BenchmarkSeams,
): Promise<number> {
  const ledgerRoot = resolveLedgerRoot(options.ledgerRoot, context);
  const file = restoreJournalPath(ledgerRoot, options.runId);
  let document: RestoreJournalDocument | null;
  try {
    document = await readRestoreJournal(file);
  } catch (error) {
    if (!(error instanceof RestoreJournalError)) throw error;
    return refuse(context, [
      `REFUSED: ${error.message}`,
      "  The journal was left untouched. Restore the listed sources by hand, then delete it.",
    ]);
  }
  if (document === null) {
    return usage(
      context,
      `--restore ${options.runId}: no restore journal at ${file} — nothing to restore (was --ledger-root the one the run used?)`,
    );
  }
  if (document.runId !== options.runId) {
    return refuse(context, [
      `REFUSED: the journal at ${file} belongs to run ${document.runId}, not ${options.runId}; it was left untouched`,
    ]);
  }
  const liveness = (seams.liveness ?? journalWriterLiveness)(document);
  if (liveness !== "dead") {
    const why =
      liveness === "alive"
        ? `its writer (pid ${document.pid} on ${document.hostname}) is still running`
        : `it was written on ${document.hostname}, so its writer (pid ${document.pid}) cannot be checked from here`;
    // Delegated decision 2026-09-26: fail closed. Restoring under a live run
    // would race its own PATCHes and final restore; the operator has to say
    // explicitly that the writer is gone.
    if (!options.ignoreLivePid) {
      return refuse(context, [
        `REFUSED: ${why}. Stop that run first (it restores on SIGINT/SIGTERM), or pass --ignore-live-pid once you know it is gone.`,
      ]);
    }
    context.stderr(`warning: --ignore-live-pid: restoring although ${why}`);
  }

  const runnerProfile = options.runner ?? document.runnerProfile;
  let composition: BenchmarkRestoreComposition;
  try {
    composition = await (seams.composeRestore ?? composeInstanceRestore)({
      options: { ...options, runner: runnerProfile },
      context,
    });
  } catch (error) {
    if (error instanceof TopologyError) return usage(context, error.message);
    throw error;
  }

  let result: RestoreFromJournalResult;
  try {
    // Delegated decision 2026-09-26: the journal's sources are written only
    // to the instance they were read from. Hosts compare case-insensitively;
    // a journal without a recorded instance falls back to the profile name.
    const mismatch =
      document.instance !== null
        ? composition.instance.toLowerCase() !== document.instance.toLowerCase()
          ? `runner ${composition.runnerProfile} is ${composition.instance}, but the journal was written against ${document.instance}`
          : undefined
        : composition.runnerProfile !== document.runnerProfile
          ? `runner profile ${composition.runnerProfile} is not the journal's ${document.runnerProfile} (the journal records no instance)`
          : undefined;
    if (mismatch !== undefined) {
      return refuse(context, [
        `REFUSED: ${mismatch}; nothing was written and the journal was left untouched`,
      ]);
    }
    result = await restoreFromJournal({
      client: composition.client,
      document,
      file,
      ...(seams.sleep === undefined ? {} : { sleep: seams.sleep }),
    });
  } finally {
    composition.release();
  }

  const leaseProblem =
    result.lease.status === "failed"
      ? `the journal is cleared, but run ${document.runId}'s lease row could not be released (${result.lease.detail}). Manual step: delete the u_benchmark_lease row(s) whose holder is ${document.runId} on ${composition.instance}.`
      : undefined;
  const exitCode: ExitCode =
    result.unrestored.length > 0 || leaseProblem !== undefined
      ? EXIT_CODES.fault
      : EXIT_CODES.ok;
  if (options.json) {
    context.stdout(
      JSON.stringify(
        {
          kind: BENCHMARK_RESTORE_RESULT_KIND,
          exitCode,
          runId: document.runId,
          journal: file,
          instance: composition.instance,
          restored: result.restored,
          unrestored: result.unrestored,
          cleared: result.cleared,
          lease: result.lease,
        },
        null,
        2,
      ),
    );
  } else {
    context.stdout("");
    context.stdout(`tess benchmark --restore ${document.runId}`);
    for (const note of composition.notes) context.stdout(`  ${note}`);
    context.stdout(`  journal:  ${file}`);
    context.stdout("");
    for (const artifact of result.restored) {
      context.stdout(`  restored   ${artifact}`);
    }
    if (result.lease.status === "released") {
      context.stdout(`  lease rows released: ${result.lease.rows}`);
    }
    context.stdout(`exit: ${exitCode}`);
  }
  if (result.unrestored.length > 0) {
    context.stderr(
      `UNRESTORED: ${result.unrestored.length} artifact(s) could not be verified restored; the journal ${file} and the lease were kept — re-run \`tess benchmark --restore ${document.runId}\` or restore them by hand:`,
    );
    for (const u of result.unrestored) {
      context.stderr(`  - ${u.artifact}: ${u.detail}`);
    }
  }
  if (leaseProblem !== undefined) context.stderr(`tess: ${leaseProblem}`);
  return exitCode;
}

/**
 * Parse, validate inputs, compose, run, print. Throws only what `cli.ts`
 * classifies: a `GuardViolation` (exit 4) or anything else (exit 3).
 */
export async function benchmarkCommand(
  argv: readonly string[],
  context: CliContext,
  seams: BenchmarkSeams = {},
): Promise<number> {
  const parsed = parseBenchmarkArgs(argv, context);
  if (parsed.kind === "error") return usage(context, parsed.message);
  if (parsed.kind === "restore") {
    return benchmarkRestoreCommand(parsed.options, context, seams);
  }
  const { options } = parsed;

  // (1) Inputs before instances.
  const gen = await readGenConfigFile(options.genConfigPath);
  if ("problems" in gen) {
    return usage(
      context,
      `--gen-config is not a pin (DESIGN §12.3): ${gen.problems.join("; ")}`,
    );
  }
  const drift = promptHashDrift(gen.config);
  if (drift !== undefined) {
    return refuse(context, [
      `REFUSED (§12.3): --gen-config ${options.genConfigPath} pins a prompt this build does not send; nothing was staged and nothing was written`,
      `  - ${drift}`,
    ]);
  }
  const policy = DESIGN_GATE_POLICY;
  const repetitions = options.repetitions ?? policy.minRepetitions;
  if (repetitions < policy.minRepetitions) {
    return usage(
      context,
      `--repetitions ${repetitions} is below the §13.1 minimum of ${policy.minRepetitions}; a determinism check needs at least that many reps`,
    );
  }

  let catalog: BenchmarkCatalog;
  try {
    catalog = await readCatalogFile(options.catalogPath, policy);
  } catch (error) {
    if (!(error instanceof CatalogError)) throw error;
    context.stderr("");
    context.stderr(
      `REFUSED (§13.4): the catalog at ${options.catalogPath} will not be scored; nothing was staged and nothing was written`,
    );
    for (const problem of error.problems) context.stderr(`  - ${problem}`);
    context.stderr("");
    return EXIT_CODES.refused;
  }

  let provider: LLMProvider;
  if (options.provider === "anthropic") {
    // A blank variable counts as UNSET and falls through, exactly like
    // `@tessera/config`'s env layer: `TESSERA_ANTHROPIC_API_KEY=""` must not
    // hide a real `ANTHROPIC_API_KEY`.
    const apiKey = [
      context.env["TESSERA_ANTHROPIC_API_KEY"],
      context.env["ANTHROPIC_API_KEY"],
    ].find((value) => value !== undefined && value.trim() !== "");
    if (apiKey === undefined) {
      return usage(
        context,
        "--provider anthropic needs a key in TESSERA_ANTHROPIC_API_KEY (or ANTHROPIC_API_KEY); it is env-only on purpose",
      );
    }
    try {
      provider = createAnthropicProvider({
        fetch: nodeFetch,
        apiKey,
        config: gen.config,
      });
    } catch (error) {
      if (error instanceof GenerateInputError)
        return usage(context, error.message);
      throw error;
    }
  } else {
    provider = createTemplateProvider({ config: gen.config });
  }

  // Still inputs before instances: an --out that cannot be written is found
  // now, not after a full measured run whose record it would then lose.
  if (options.out !== undefined) {
    const problem = await outProblem(options.out);
    if (problem !== undefined) return usage(context, problem);
  }

  // Still before any instance: an unrestored journal from a crashed run means
  // a mutant may be live on an artifact this catalog would capture as
  // "correct". The scan is read-only.
  const pending = await pendingJournalProblems(
    resolveLedgerRoot(options.ledgerRoot, context),
    options.runId,
    catalog,
  );
  for (const warning of pending.warnings) {
    context.stderr(`warning: ${warning}`);
  }
  if (pending.refusals.length > 0) {
    return refuse(context, [
      "REFUSED (F4): an unrestored benchmark restore journal is pending; nothing was staged and nothing was written",
      ...pending.refusals.map((line) => `  - ${line}`),
    ]);
  }

  // (2)–(4)
  let composition: BenchmarkComposition;
  try {
    composition = await (seams.compose ?? composeInstanceBenchmark)({
      options,
      provider,
      context,
    });
  } catch (error) {
    if (error instanceof TopologyError) return usage(context, error.message);
    throw error;
  }

  // Delegated decision 2026-09-26 (F4): SIGINT/SIGTERM abort the run through
  // the harness's signal instead of killing the process, so its final scope
  // restore (which is deliberately not bound to that signal) still runs. A
  // SECOND signal does not skip the restore: it is acknowledged loudly and
  // ignored. Only SIGKILL can cut the restore short, and then the journal
  // stays on disk for `--restore`. Handlers are removed after the run.
  const controller = new AbortController();
  const signals = seams.signals ?? PROCESS_SIGNALS;
  const journalHint =
    composition.journal === undefined
      ? "the substrate keeps no journal"
      : `the journal ${composition.journal.location} stays for \`tess benchmark --restore ${options.runId}\``;
  let received = 0;
  const installed: [BenchmarkSignal, () => void][] = [];
  let record: BenchmarkRunRecord;
  try {
    for (const name of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        received += 1;
        if (received === 1) {
          context.stderr(
            `tess: ${name} received — aborting the benchmark; the final scope restore runs before exit (a second signal will not skip it)`,
          );
          controller.abort(new Error(`${name} received`));
        } else {
          context.stderr(
            `tess: ${name} received again — ignored while the final scope restore runs. Only SIGKILL skips it; then ${journalHint}.`,
          );
        }
      };
      signals.on(name, handler);
      installed.push([name, handler]);
    }
    record = await runBenchmark({
      runId: options.runId,
      catalog,
      genConfig: gen.config,
      policy,
      repetitions,
      substrate: composition.substrate,
      pipeline: composition.pipeline,
      signal: controller.signal,
      ...(composition.topology === undefined
        ? {}
        : { topology: composition.topology }),
    });
  } finally {
    for (const [name, handler] of installed) signals.off(name, handler);
    composition.release();
  }

  // F5: whatever the final restore could not put back is still journaled.
  const unrestored = composition.journal?.entries() ?? [];
  // Delegated decision 2026-09-26: a run that leaves an artifact unrestored
  // exits 3 (fault) whatever its verdict, like an unwritable --out: CI must
  // see that the instance was left dirty. The verdict stays in the document.
  const exitCode: ExitCode =
    unrestored.length > 0 ? EXIT_CODES.fault : benchmarkExitCode(record);
  const s5 = toS5Record(record);
  const document = {
    kind: BENCHMARK_RESULT_KIND,
    exitCode,
    s5,
    ...(unrestored.length === 0 || composition.journal === undefined
      ? {}
      : {
          unrestored: {
            journal: composition.journal.location,
            recover: `tess benchmark --restore ${options.runId}`,
            artifacts: unrestored.map((e) => ({
              table: e.table,
              sysId: e.sysId,
              field: e.field,
              sha256: e.sha256,
            })),
          },
        }),
  };
  if (unrestored.length > 0) {
    context.stderr("");
    context.stderr(
      `UNRESTORED: the final scope restore could not put back ${unrestored.length} artifact(s) — a mutant or detonator may be LIVE on ${composition.topology?.runner ?? "the runner"}:`,
    );
    for (const e of unrestored) {
      context.stderr(`  - ${e.table}/${e.sysId} (${e.field})`);
    }
    context.stderr(
      `  The journal ${composition.journal?.location ?? "(none)"} was kept; recover with \`tess benchmark --restore ${options.runId}\`.`,
    );
    context.stderr("");
  }
  // The measured record reaches stdout FIRST: whatever happens to --out, the
  // run's result is never lost.
  if (options.json) {
    context.stdout(JSON.stringify(document, null, 2));
  } else {
    context.stdout("");
    context.stdout(`tess benchmark — run ${record.runId}`);
    for (const note of composition.notes) context.stdout(`  ${note}`);
    context.stdout("");
    context.stdout(formatS5Record(record));
    if (record.catalog.fixture && record.result.status === "go") {
      context.stdout(
        "  FIXTURE catalog: the finding is forced to open — a fixture GO exits 5, never 0",
      );
    }
    context.stdout(`exit: ${exitCode}`);
  }
  if (options.out !== undefined) {
    try {
      await mkdir(path.dirname(options.out), { recursive: true });
      await writeFile(
        options.out,
        `${JSON.stringify(document, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      // Delegated decision 2026-09-24: fail closed. The operator asked for the
      // --out artifact; if it cannot be written the command must not report
      // success, so this is an infrastructure fault (exit 3) whatever the
      // verdict was — even a MISS/VOID, so CI sees one unambiguous "the
      // requested artifact is missing" code. The verdict itself is already on
      // stdout above (and `exitCode` inside the --json document), so nothing
      // measured is lost.
      context.stderr(
        `tess: the benchmark finished (verdict exit ${exitCode}) but --out ${options.out} could not be written: ${error instanceof Error ? error.message : String(error)}`,
      );
      return EXIT_CODES.fault;
    }
  }
  return exitCode;
}

/**
 * Why --out cannot be written, or `undefined`. Creates its parent directory
 * (as the final write would) and checks it is writable; refuses an --out that
 * is itself an existing directory.
 */
async function outProblem(out: string): Promise<string | undefined> {
  const dir = path.dirname(out);
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch (error) {
    return `--out ${out} cannot be written: its directory ${dir} is not a writable directory (${error instanceof Error ? error.message : String(error)})`;
  }
  try {
    const target = await stat(out);
    if (target.isDirectory()) {
      return `--out ${out} is a directory; it expects a file path`;
    }
  } catch {
    // Absent is the normal case: the run will create it.
  }
  return undefined;
}
