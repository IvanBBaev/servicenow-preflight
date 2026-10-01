// ARCH-1, discharged: adapters are registered by NAME and the pipeline is
// resolved from a config record. Nothing below is a hand-written
// `RunPipelinePorts` object literal — that was the named Phase-0.5 exception,
// and this module is what replaces it.
//
// What that buys, concretely: swapping the Phase-0.5 ATF runner for the real
// one in a later phase is a change to `SKELETON_PIPELINE` (a string) plus one
// more `register()` call. No caller of `runPipeline` moves.
//
// Two of the eight ports have NO Phase-0.5 implementation: `impactAnalyzer` and
// `generator`. `resolvePipeline` requires all eight, so they are registered as
// explicit `"none"` adapters rather than left out. That is deliberate — the
// alternative was widening `PipelinePorts` in `@tessera/core` to make two ports
// optional, which would push the Phase-0.5 shortcut down into the shared
// contract. A named no-op that the run loop is separately told not to call
// (`stages: {impact: false, generate: false}`) keeps the shortcut where it
// belongs: in the composition, one edit away from being deleted.
//
// The no-ops take no parameters on purpose. They are structurally valid
// implementations of ports whose arguments they must not look at, and a
// declared-but-ignored `ctx` would read like an oversight.

import {
  createGateEvaluator,
  createRegistries,
  resolvePipeline,
} from "@tessera/core";
import type {
  ImpactAnalyzer,
  PipelineConfig,
  PipelinePorts,
  PipelineRegistries,
  Reporter,
  TestGenerator,
} from "@tessera/core";
import {
  createDefaultPreconditions,
  createEnvironmentDoctor,
  createSnInstanceProbe,
} from "@tessera/doctor";
import {
  createAiTestGenerator,
  createGeneratedCodeGate,
  createGenerationQualityBar,
  writeProposedSpecs,
  type LLMProvider,
} from "@tessera/generate";
import {
  createCollectingReporter,
  createS5Provisioner,
  createS5Resolver,
  createS5Runner,
  createS5TestStore,
  type CollectingReporter,
  type S5TestStore,
} from "@tessera/phase05";
import {
  createPreflightProvisioner,
  createSnInstanceWriter,
  type ProvisionMode,
} from "@tessera/provisioner";
import {
  createConsoleReporter,
  createJUnitReporter,
  createJsonReporter,
} from "@tessera/reporter";
import {
  createCompositeResolver,
  createScopeResolver,
  createSnRecordReader,
  createStoryResolver,
  type RecordReader,
} from "@tessera/resolvers";
import {
  createAtfRunner,
  createSnAtfClient,
  type AtfHttpClient,
} from "@tessera/runner-atf";
import {
  createAtfTestStore,
  isAtfScriptPayload,
  createSnTestStoreClient,
  type AtfTestStore,
  type TestStoreHttpClient,
} from "@tessera/teststore-atf";
import type { ImpactGraph, TestKind, TestSpec } from "@tessera/types";

import { createCliImpactAnalyzer } from "./impactComposition.js";
import {
  bindAtfClient,
  bindProbe,
  bindTestStoreClient,
  bindWriter,
} from "./topology.js";

/** The adapter names the Phase-0.5 run composes. Data, not code (ARCH-1). */
export const SKELETON_PIPELINE: PipelineConfig = {
  resolver: "s5",
  impactAnalyzer: "none",
  generator: "none",
  store: "s5",
  runners: ["s5-atf"],
  reporters: ["collecting"],
  provisioner: "s5",
  gate: "default",
};

/**
 * Registered under the name `none` so an operator reading the resolved config
 * sees "impactAnalyzer: none" rather than a silently absent stage.
 */
export function createNoopImpactAnalyzer(): ImpactAnalyzer {
  return {
    analyze: (): Promise<ImpactGraph> =>
      Promise.resolve({
        nodes: [],
        edges: [],
        unanalyzable: [],
        demanded: [],
      }),
  };
}

/** Same reasoning as the no-op analyzer: named absence, not absence. */
export function createNoopTestGenerator(): TestGenerator {
  return {
    generate: (): Promise<TestSpec[]> => Promise.resolve([]),
  };
}

export interface SkeletonRegistryOptions {
  /** Injected clock. Nothing here calls `Date.now()`. */
  readonly now: () => Date;
  /** Only so a test can point the resolver at a differently named copy. */
  readonly targetName?: string;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly pollIntervalMs?: number;
  /** §6a ConfirmToken signing key. Absent → an unsigned token. */
  readonly hmacKey?: string;
  readonly skipRunnerPropertyCheck?: boolean;
  readonly deleteSuiteResults?: boolean;
}

/**
 * The registries a Phase-0.5 run resolves against. Exported separately from
 * `composeSkeletonPipeline` so a later phase can register one more adapter over
 * the same set instead of forking the composition.
 */
export function createSkeletonRegistries(options: SkeletonRegistryOptions): {
  registries: PipelineRegistries;
  store: S5TestStore;
  reporter: CollectingReporter;
} {
  const registries = createRegistries();

  const store = createS5TestStore(
    options.deleteSuiteResults === undefined
      ? {}
      : { deleteSuiteResults: options.deleteSuiteResults },
  );
  const reporter = createCollectingReporter();

  registries.resolvers.register(
    SKELETON_PIPELINE.resolver,
    createS5Resolver(
      options.targetName === undefined
        ? {}
        : { targetName: options.targetName },
    ),
  );
  registries.impactAnalyzers.register(
    SKELETON_PIPELINE.impactAnalyzer,
    createNoopImpactAnalyzer(),
  );
  registries.generators.register(
    SKELETON_PIPELINE.generator,
    createNoopTestGenerator(),
  );
  registries.stores.register(SKELETON_PIPELINE.store, store);
  for (const name of SKELETON_PIPELINE.runners) {
    registries.runners.register(
      name,
      createS5Runner({
        now: () => options.now().getTime(),
        ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
        ...(options.pollIntervalMs === undefined
          ? {}
          : { pollIntervalMs: options.pollIntervalMs }),
      }),
    );
  }
  for (const name of SKELETON_PIPELINE.reporters) {
    registries.reporters.register(name, reporter);
  }
  registries.provisioners.register(
    SKELETON_PIPELINE.provisioner,
    createS5Provisioner(
      options.skipRunnerPropertyCheck === undefined
        ? {}
        : { skipRunnerPropertyCheck: options.skipRunnerPropertyCheck },
    ),
  );
  registries.gates.register(
    SKELETON_PIPELINE.gate,
    createGateEvaluator(
      options.hmacKey === undefined ? {} : { hmacKey: options.hmacKey },
    ),
  );

  return { registries, store, reporter };
}

export interface SkeletonComposition {
  readonly ports: PipelinePorts;
  /**
   * The same object `ports.store` holds, at its concrete type. `TestStore` has
   * no `created()`/`deleted()` — teardown evidence is not part of the port, and
   * inventing a port method to avoid one downcast would be worse.
   */
  readonly store: S5TestStore;
  /** Likewise: `failures()`/`errors()` are not `Reporter` methods. */
  readonly reporter: CollectingReporter;
  readonly config: PipelineConfig;
}

/** The composition root call. Registries in, resolved ports out. */
export function composeSkeletonPipeline(
  options: SkeletonRegistryOptions,
): SkeletonComposition {
  const { registries, store, reporter } = createSkeletonRegistries(options);
  return {
    ports: resolvePipeline(registries, SKELETON_PIPELINE),
    store,
    reporter,
    config: SKELETON_PIPELINE,
  };
}

// ── the real pipeline ───────────────────────────────────────────────────────
//
// Everything above is Phase 0.5 and is frozen. Everything below is the Phases
// 2–8 composition, and it registers the adapters those phases actually built:
// the composite Resolver, the where-used ImpactAnalyzer, the AI TestGenerator,
// the ATF Runner, the three Reporters, the preflight Provisioner and core's
// gate evaluator. Same mechanism as the skeleton — a name, a `register()` call,
// and a `PipelineConfig` record that selects by name (ARCH-1). No caller of
// `runPipeline` distinguishes the two.
//
// All eight ports resolve. The eighth, `TestStore`, was the deliberate hole
// until PLAN Phase 4's write side landed as `@tessera/teststore-atf` (ADR-007:
// the W2 authoring channel — Table API under the `x_tessera.author` ACL on
// `sys_variable_value`). It is registered here as `"atf"` (delegated decision
// 2026-09-23, TODO "run --live"), and the reasons the hole was kept open still
// constrain what may fill it:
//
//   * `@tessera/phase05`'s `createS5TestStore` is still NOT a candidate — it
//     projects one hardcoded spec and refuses any other count.
//   * A no-op store returning an empty `ProjectionMap` is still worse than a
//     throw: `ProjectionMap` is the ARCH-26 result-attribution key.
//   * `store` stays required in `PipelinePorts`; nothing in `@tessera/core`
//     moved to make this composition resolve.
//
// The ATF store is EPHEMERAL-only (it refuses `persistent` with a `lifecycle`
// refusal) and holds a local projection lock between `project()` and
// `teardown()`. The composition root therefore owns two things the adapter
// cannot decide: WHERE the lock lives (`lockPath`, under the §4b ledger root)
// and calling `store.release()` in a `finally` for a run that never reached
// teardown — which is why `composeRealPipeline` hands the store back at its
// concrete type. `test/realPipeline.test.js` pins the registration.

/**
 * The adapter names a real run composes. Data, not code (ARCH-1) — the same
 * shape as `SKELETON_PIPELINE`, so the difference between a skeleton run and a
 * real one is a record, not a code path.
 */
export const REAL_PIPELINE: PipelineConfig = {
  resolver: "composite",
  impactAnalyzer: "where-used",
  generator: "ai",
  /** `@tessera/teststore-atf` — PLAN Phase 4's write side (ADR-007). */
  store: "atf",
  runners: ["atf"],
  reporters: ["console", "json", "junit"],
  provisioner: "preflight",
  gate: "default",
};

export interface RealRegistryOptions {
  /**
   * §2a role profiles, already bound by `topology.ts`. Profiles rather than
   * hosts because ARCH-7/18 puts credentials behind a named profile, and
   * because reads and writes land on DIFFERENT instances (ARCH-19): resolution
   * and impact read the source, provisioning and execution touch the runner.
   */
  readonly sourceProfile: string;
  readonly runnerProfile: string;
  /**
   * Required, because `createImpactAnalyzer` requires it: DESIGN §12.3 row 3
   * confines the MVP to one application scope, and an unbounded where-used
   * search is a different operation, not a default.
   */
  readonly scope: string;
  /** Absolute path of the directory holding the live spec manifest. */
  readonly testsRoot: string;
  /**
   * What answers a generation prompt. The composition root chooses (ARCH-1);
   * `createTemplateProvider()` is the offline default the CLI already uses.
   */
  readonly provider: LLMProvider;
  /** Injected clock. Nothing here calls `Date.now()`. */
  readonly now: () => Date;
  /** One line, no trailing newline — the console reporter's sink. */
  readonly console: (line: string) => void;
  /**
   * The JSON and JUnit reporters each hand over one whole document at `close()`.
   * Where it lands is the caller's decision, not this module's: a composition
   * root that invented an artifact path would be choosing a filesystem layout on
   * behalf of every future caller.
   */
  readonly writeJson: (json: string) => Promise<void> | void;
  readonly writeJUnit: (xml: string) => Promise<void> | void;
  /** Stream a line per event as it arrives, rather than a summary at close. */
  readonly live?: boolean;
  readonly verbose?: boolean;
  readonly artifactTables?: readonly string[];
  /**
   * The reader the SCOPE adapter enumerates through. Absent: the shared
   * source reader. `tess run --live` passes a classifying wrapper bound to
   * the same source profile (`liveArtifactTables.ts`), so a refused artifact
   * table is recorded and a broken read is a fault. Must be bound to
   * `sourceProfile` (ARCH-19) — the composition does not re-bind it.
   */
  readonly scopeReader?: RecordReader;
  /**
   * The reader the impact analysis's Business Rule lookup reads `sys_script`
   * through. Absent: `scopeReader` (then the shared source reader). `tess run
   * --live` passes its classifying reader's `forLookup()` view, so a refused
   * lookup is recorded as a lookup, not as an incomplete enumeration. Must be
   * bound to `sourceProfile` (ARCH-19).
   */
  readonly ruleReader?: RecordReader;
  /**
   * The reader the impact analysis's UI Action lookup reads `sys_ui_action`
   * (and the `sys_script` rules on the actions' tables) through. Absent:
   * `scopeReader` (then the shared source reader). `tess run --live` passes
   * the same `forLookup()` view as `ruleReader`. Must be bound to
   * `sourceProfile` (ARCH-19).
   */
  readonly actionReader?: RecordReader;
  /**
   * The reader the impact analysis's standalone-script lookup reads the
   * scheduled-job / Scripted REST / transform-script tables, the scope's
   * `sys_script_include` and a transform script's `sys_transform_map` and
   * target-table `sys_script` rules through. Absent: `scopeReader` (then the shared
   * source reader). `tess run --live` passes the same `forLookup()` view as
   * `ruleReader`. Must be bound to `sourceProfile` (ARCH-19).
   */
  readonly scriptReader?: RecordReader;
  readonly updateSetStoryField?: string;
  /** Kinds the run will request, so DEV-2 gating applies to the plan too. */
  readonly kinds?: readonly TestKind[];
  /** Default `plan`: a provisioner that cannot write unless asked to. */
  readonly mode?: ProvisionMode;
  /** Seam for tests. Production uses the bound `createSnAtfClient()`. */
  readonly atfClient?: AtfHttpClient;
  readonly generationDeadlineMs?: number;
  /** §6a ConfirmToken signing key. Absent → an unsigned token. */
  readonly hmacKey?: string;
  /**
   * The ATF store's local projection lock file. Required: where run state
   * lives is the composition root's decision (the CLI puts it under the §4b
   * ledger root), never the adapter's.
   */
  readonly lockPath: string;
  /** C4 minor-channel-mismatch sink. Default: `process.emitWarning`. */
  readonly onWarning?: (message: string) => void;
  /** Seam for tests. Production uses the bound `createSnTestStoreClient()`. */
  readonly testStoreClient?: TestStoreHttpClient;
}

/**
 * The registries a real run resolves against — all eight ports.
 *
 * Nothing in here touches the network or reads the environment: every factory
 * below builds an object and closes over its collaborators, so this function is
 * pure composition and a test can call it with profile names that do not exist.
 * The first byte over the wire is sent by a stage port, during a run.
 */
export function createRealRegistries(
  options: RealRegistryOptions,
): PipelineRegistries {
  return buildRealRegistries(options).registries;
}

function buildRealRegistries(options: RealRegistryOptions): {
  registries: PipelineRegistries;
  store: AtfTestStore;
} {
  const registries = createRegistries();

  // GET-only and bound to the source profile at construction (ARCH-19/ARCH-8),
  // shared by the two stages that read: there is no second transport here and
  // no path from either of them to a write.
  const reader = createSnRecordReader(options.sourceProfile);
  // Delegated decision 2026-09-28 (wave 13): a supplied scope reader bound to
  // any other profile would read artifacts off the wrong instance; refuse the
  // composition rather than trust the caller (ARCH-19, fail-closed).
  if (
    options.scopeReader !== undefined &&
    options.scopeReader.profile !== options.sourceProfile
  ) {
    throw new Error(
      `scopeReader is bound to profile "${options.scopeReader.profile}", not the source profile "${options.sourceProfile}" (ARCH-19)`,
    );
  }

  registries.resolvers.register(
    REAL_PIPELINE.resolver,
    // Story leads, exactly as `tess resolve` composes it: the first adapter to
    // claim an artifact owns its `resolvedBy` label, and "this row is in the
    // story's update set" is the more specific statement.
    createCompositeResolver([
      createStoryResolver(
        reader,
        options.updateSetStoryField === undefined
          ? {}
          : { updateSetStoryField: options.updateSetStoryField },
      ),
      createScopeResolver(
        options.scopeReader ?? reader,
        // Only when a list was actually configured. An empty array is a
        // configured "look at no tables at all", which the scope adapter
        // correctly reports as a warning — passing one by accident would turn
        // every run inconclusive.
        options.artifactTables === undefined ||
          options.artifactTables.length === 0
          ? {}
          : { artifactTables: options.artifactTables },
      ),
    ]),
  );

  // Business Rules, UI Actions and standalone scripts are traced too
  // (`impactComposition.ts`). Their lookups read through `ruleReader` /
  // `actionReader` / `scriptReader`, else the scope reader, when one was
  // supplied — the live run passes its classifying reader's lookup view to
  // all three — so a refused `sys_script`, `sys_ui_action`, script-table,
  // `sys_script_include` or `sys_transform_map` lookup is recorded (tagged as a lookup, not an
  // enumeration refusal) and a transport fault is thrown (exit 3).
  const ruleReader = options.ruleReader ?? options.scopeReader;
  const actionReader = options.actionReader ?? options.scopeReader;
  const scriptReader = options.scriptReader ?? options.scopeReader;
  registries.impactAnalyzers.register(
    REAL_PIPELINE.impactAnalyzer,
    createCliImpactAnalyzer(reader, {
      scope: options.scope,
      ...(ruleReader === undefined ? {} : { ruleReader }),
      ...(actionReader === undefined ? {} : { actionReader }),
      ...(scriptReader === undefined ? {} : { scriptReader }),
    }),
  );

  registries.generators.register(
    REAL_PIPELINE.generator,
    createAiTestGenerator({
      provider: options.provider,
      // TM-3 and QA-12: neither is optional and neither is configurable from
      // out here. A composition root that could be asked to omit the code gate
      // is a composition root that will one day be asked to.
      gate: createGeneratedCodeGate(),
      quality: createGenerationQualityBar(),
      writer: { write: writeProposedSpecs },
      testsRoot: options.testsRoot,
      ...(options.generationDeadlineMs === undefined
        ? {}
        : { deadlineMs: options.generationDeadlineMs }),
      now: () => options.now().getTime(),
    }),
  );

  // Bound to the RUNNER, like the ATF client below: projection is a §4b write
  // and ARCH-8 allows exactly one writable instance per run.
  const store = createAtfTestStore({
    client: bindTestStoreClient(
      options.testStoreClient ?? createSnTestStoreClient(),
      options.runnerProfile,
    ),
    lockPath: options.lockPath,
    // Delegated decision 2026-09-28 (wave 13): core's teardown passes the
    // ledger's recorded suite-trigger count (DEV-17), so a teardown context
    // WITHOUT one can only come from a caller that forgot it — refuse it
    // rather than fall back to the gate that misses a queued second
    // execution.
    requireRecordedTriggers: true,
    ...(options.onWarning === undefined
      ? {}
      : { onWarning: options.onWarning }),
  });
  registries.stores.register(REAL_PIPELINE.store, store);

  const runnerProbe = bindProbe(createSnInstanceProbe(), options.runnerProfile);

  for (const name of REAL_PIPELINE.runners) {
    const atfRunner = createAtfRunner({
      // Bound to the RUNNER: ARCH-19 puts execution there, and the raw client
      // is the one collaborator that does not bind itself.
      client: bindAtfClient(
        options.atfClient ?? createSnAtfClient(),
        options.runnerProfile,
      ),
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      now: () => options.now().getTime(),
    });
    registries.runners.register(name, {
      ...atfRunner,
      // Delegated decision 2026-09-23 (TODO "run --live"): the adapter's own
      // `supports()` asks whether a spec TARGETS an existing sys_atf_test — the
      // shape of a spec that points at a hand-authored ATF test. A spec the ATF
      // store projects targets the artifact under test instead (QA-16) and
      // carries its step body as `{ script }`; this store writes exactly that
      // spec onto sys_atf_test and hands the runner the projection map, so in
      // THIS composition an ATF script payload is what makes a spec runnable
      // here. Without the widening every repo spec was refused at plan time as
      // "no registered runner supports" it (§6).
      supports: (spec) =>
        isAtfScriptPayload(spec.payload) || atfRunner.supports(spec),
    });
  }

  // Keyed by name so the config and the registrations cannot drift: a reporter
  // named in `REAL_PIPELINE` with no factory here fails loudly at composition
  // rather than resolving to nothing at `close()` time.
  const reporterFactories: Readonly<Record<string, () => Reporter>> = {
    console: () =>
      createConsoleReporter({
        write: options.console,
        ...(options.live === undefined ? {} : { live: options.live }),
        ...(options.verbose === undefined ? {} : { verbose: options.verbose }),
      }),
    json: () => createJsonReporter({ write: options.writeJson }),
    junit: () => createJUnitReporter({ write: options.writeJUnit }),
  };
  for (const name of REAL_PIPELINE.reporters) {
    const factory = reporterFactories[name];
    if (factory === undefined) {
      throw new Error(
        `REAL_PIPELINE names the reporter "${name}", which this composition root has no factory for`,
      );
    }
    registries.reporters.register(name, factory());
  }

  registries.provisioners.register(
    REAL_PIPELINE.provisioner,
    createPreflightProvisioner({
      doctor: createEnvironmentDoctor(createDefaultPreconditions(runnerProbe)),
      probe: runnerProbe,
      // Constructed unconditionally but only ever consulted in `apply` mode,
      // and bound to the runner — ARCH-8's single-writer rule.
      writer: bindWriter(createSnInstanceWriter(), options.runnerProfile),
      mode: options.mode ?? "plan",
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
    }),
  );

  registries.gates.register(
    REAL_PIPELINE.gate,
    createGateEvaluator(
      options.hmacKey === undefined ? {} : { hmacKey: options.hmacKey },
    ),
  );

  return { registries, store };
}

export interface RealComposition {
  readonly ports: PipelinePorts;
  /**
   * The same object `ports.store` holds, at its concrete type: `release()` is
   * not a `TestStore` method, and the caller must call it in a `finally`.
   */
  readonly store: AtfTestStore;
  readonly config: PipelineConfig;
}

/**
 * The real composition root call.
 *
 * Composition errors still surface here, at startup, rather than mid-run:
 * `resolvePipeline` throws on any name in `REAL_PIPELINE` that has no
 * registration. Kept as a function for the reason the skeleton has
 * `composeSkeletonPipeline`: exactly one place knows how a real pipeline is
 * composed.
 */
export function composeRealPipeline(
  options: RealRegistryOptions,
): RealComposition {
  const { registries, store } = buildRealRegistries(options);
  return {
    ports: resolvePipeline(registries, REAL_PIPELINE),
    store,
    config: REAL_PIPELINE,
  };
}
