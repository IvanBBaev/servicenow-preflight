// `tess preflight` — the PLAN Phase 1 deliverable.
//
// Answers two questions before a single test is projected:
//
//   1. Can this runner run the kinds we intend to run?      (EnvironmentDoctor)
//   2. Is the code it will execute the code we resolved?    (ARCH-20 parity)
//
// and then, for the part of (1) that a write can fix, produces an inspectable
// plan (ARCH-2/ARCH-13) which `--mode apply` — and nothing else — executes.
//
// Three ordering decisions in here are load-bearing:
//
//  * **The doctor runs exactly once per pass.** The provisioner re-diagnoses
//    internally, so wiring it the real doctor would probe every precondition
//    twice on a plan-only run. It gets a one-shot wrapper instead: the first
//    `diagnose()` replays the report we already have, later ones go through to
//    the instance. That is not merely an optimisation — `apply()`'s verification
//    step is the instance's opinion about itself, and replaying a cached
//    pre-apply report there would turn every successful apply into a
//    `ProvisionVerificationError`.
//
//  * **`--mode apply` classifies the runner BEFORE constructing the writer.**
//    §11 is a precondition of the write, not a wrapper around it, and the guard
//    is the only thing that decides. A refusal leaves the process with nothing
//    written and exit 4.
//
//  * **In apply mode the verdict comes from the POST-apply diagnosis.** What a
//    caller wants to know is whether the instance is ready now, not whether the
//    plan we just executed hoped to make it so.
//
// The verdict is fail-closed throughout: nothing undecided is ever rounded up to
// ready (QA-9, ARCH-28/DEV-17). Undecided is USUALLY `inconclusive` (5) — the
// exception is a DEV-2 hard failure, which `decideVerdict` tests FIRST and maps
// to `noGo` (1) even though the finding under it is `unknown` rather than
// not-ready. Fail-closed is the invariant; 5 is the code for every undecided
// state that no stronger fact outranked.

import path from "node:path";

import {
  ConfigError,
  formatResolvedConfig,
  resolveConfig,
  type ResolvedConfig,
  type ResolvedValues,
} from "@tessera/config";
import {
  createDefaultPreconditions,
  createEnvironmentDoctor,
  createSnInstanceProbe,
  formatDoctorReport,
  type DoctorReport,
  type EnvironmentDoctor,
} from "@tessera/doctor";
import {
  createTargetGuard,
  normalizeInstanceHost,
  type Classification,
} from "@tessera/guard";
import {
  createInfraLedger,
  createIntentLedger,
  type LedgerInfraWriteRecord,
} from "@tessera/ledger";
import {
  createParityCheck,
  createSnArtifactReader,
  formatParityReport,
  type ParityReport,
} from "@tessera/parity";
import { createLedgerGuardAuditSink } from "@tessera/phase05";
import {
  createPreflightProvisioner,
  createSnInstanceWriter,
  formatProvisionPlan,
  type InstanceWriter,
  type PreflightProvisionPlan,
  type ProvisionMode,
} from "@tessera/provisioner";
import type {
  PipelineContext,
  TargetArtifactRef,
  TestKind,
} from "@tessera/types";

import type { CliContext } from "../context.js";
import { EXIT_CODES, type ExitCode } from "../exitCodes.js";
import { checkIdempotency, createLedgeredWriter } from "../infraApply.js";
import { ARTIFACT_LABEL_SEPARATOR, PREFLIGHT_CLI_OPTIONS } from "../options.js";
import { stageDocsDir } from "../stage.js";
import {
  bindProbe,
  bindRole,
  bindWriter,
  createGuardProbe,
  TopologyError,
  type RoleBinding,
} from "../topology.js";

/**
 * The §4b ledger directory under the working directory — the same default
 * `tess run` stages (`stage.ts`), so both commands journal to one root.
 */
const DEFAULT_LEDGER_DIR = ".tessera";

/** What the command decided, and the one line that says why. */
export interface PreflightVerdict {
  readonly exitCode: ExitCode;
  readonly reason: string;
}

/**
 * Three words, because there are three answers. "INCONCLUSIVE" is not a softer
 * "NOT READY": it says nobody decided, which is the state a retry can change.
 */
export function verdictLabel(verdict: PreflightVerdict): string {
  switch (verdict.exitCode) {
    case EXIT_CODES.ok:
      return "READY";
    case EXIT_CODES.inconclusive:
      return "INCONCLUSIVE";
    default:
      return "NOT READY";
  }
}

/**
 * `<table>/<sysId>[:<label>]`.
 *
 * The label is optional and cosmetic — it only ever reaches report prose. The
 * table and sys_id are not: parity reads a specific row on two instances, and a
 * half-named artifact would silently become an `undecidable` row that reads
 * like an instance problem when it is a typo.
 */
export function parseArtifact(raw: string): TargetArtifactRef | string {
  const separator = raw.indexOf(ARTIFACT_LABEL_SEPARATOR);
  const ref = separator === -1 ? raw : raw.slice(0, separator);
  const label = separator === -1 ? "" : raw.slice(separator + 1).trim();

  const slash = ref.indexOf("/");
  if (slash === -1) {
    return `--artifact expects <table>/<sys_id>[:<label>] (got ${JSON.stringify(raw)})`;
  }
  const table = ref.slice(0, slash).trim();
  const sysId = ref.slice(slash + 1).trim();
  if (table === "" || sysId === "") {
    return `--artifact expects a non-empty table and sys_id (got ${JSON.stringify(raw)})`;
  }
  return { table, sysId, name: label === "" ? `${table}/${sysId}` : label };
}

/**
 * Replays a report we already have for the first `diagnose()`, then gets out of
 * the way. See the header for why the second call must reach the instance.
 */
function oneShotDoctor(
  first: DoctorReport,
  real: EnvironmentDoctor,
): {
  doctor: EnvironmentDoctor;
  latest: () => DoctorReport;
} {
  let replayed = false;
  let latest = first;
  return {
    doctor: {
      async diagnose(request = {}) {
        if (!replayed) {
          replayed = true;
          return first;
        }
        latest = await real.diagnose(request);
        return latest;
      },
    },
    latest: () => latest,
  };
}

/**
 * The §6b plan identity as the machine document publishes it.
 *
 * Two states, because there are two facts and a consumer must not be able to
 * confuse them. `planHash` is OPTIONAL on `PreflightProvisionPlan` — see its
 * declaration in `@tessera/provisioner`: `isExecutable` narrows on `steps`
 * alone, so a plan that never got a digest is a legal value of that type — and
 * every obvious way of rendering that absence is a lie a reader cannot detect:
 *
 *   * `""` is a hash. A consumer comparing digests sees a plan whose identity
 *     is the empty string, which is a claim, and a false one.
 *   * `null` is a value most JSON readers coerce to falsy alongside "" and
 *     then substitute a default for, which is the same lie one step later.
 *   * an absent key is indistinguishable from a CLI too old to publish one.
 *
 * A tagged object cannot be misread by accident: reaching the hash means
 * reading `state` first, and `state: "not-computed"` has no `value` to take.
 * The human line (`formatProvisionPlan`) prints the same digest and omits the
 * line entirely when there is none — which is the right answer for prose a
 * person reads and the wrong one for a document a machine parses, since a
 * machine is the only consumer that would ever hand a hash back to an apply.
 */
export type PlanIdentity =
  | { readonly state: "computed"; readonly value: string }
  | { readonly state: "not-computed"; readonly why: string };

export function planIdentity(plan: PreflightProvisionPlan): PlanIdentity {
  const value = plan.planHash;
  return value === undefined
    ? {
        state: "not-computed",
        why: "this plan carries no DESIGN §6b digest — it did not come from a `plan()` that held its own write set, so there is no identity to publish (an empty hash is NOT what this means)",
      }
    : { state: "computed", value };
}

/**
 * The roll-up, most specific fact first.
 *
 * A parity mismatch outranks an unready environment: both are exit 1, but the
 * reason an operator is handed should be the one that is provably wrong rather
 * than the one that merely needs provisioning. Undecided states lose to proven
 * failures and beat everything else.
 */
export function decideVerdict(
  doctor: DoctorReport,
  parity: ParityReport,
  plan: PreflightProvisionPlan | undefined,
  mode: ProvisionMode,
): PreflightVerdict {
  if (doctor.hardFailure !== undefined) {
    return { exitCode: EXIT_CODES.noGo, reason: doctor.hardFailure };
  }
  if (parity.status === "mismatch") {
    return {
      exitCode: EXIT_CODES.noGo,
      reason: parity.preflightFailure ?? parity.summary,
    };
  }
  if (doctor.status === "not-ready") {
    // A bare step count reads as "apply these and you are ready", and on the
    // one line most operators act on. It is only that when the plan has nothing
    // it could NOT plan: a blocker is a not-ready precondition no step clears,
    // so applying every step would leave this verdict exactly where it is. The
    // suggestion still stands — the steps are real writes worth making — so the
    // count is named rather than the advice withdrawn.
    const blocked =
      plan === undefined || plan.blockers.length === 0
        ? ""
        : ` (${plan.blockers.length} blocker(s) no step can clear — see the plan above)`;
    const pending =
      mode === "plan" && plan !== undefined && plan.steps.length > 0
        ? ` — ${plan.steps.length} step(s) planned; re-run with --mode apply to perform them${blocked}`
        : "";
    return {
      exitCode: EXIT_CODES.noGo,
      reason: `the runner is not ready${pending}`,
    };
  }
  if (parity.status === "undecidable") {
    return {
      exitCode: EXIT_CODES.inconclusive,
      reason: parity.inconclusive ?? parity.summary,
    };
  }
  if (doctor.status === "unknown") {
    return {
      exitCode: EXIT_CODES.inconclusive,
      reason:
        "at least one precondition could not be decided — an undecided check is not a green one (QA-9)",
    };
  }
  if (parity.status === "not-applicable") {
    // Not a failure, but not a pass either: say what was NOT verified rather
    // than letting a green line imply parity held.
    return {
      exitCode: EXIT_CODES.ok,
      reason: `the runner is ready; parity was not applicable — ${parity.summary}`,
    };
  }
  return {
    exitCode: EXIT_CODES.ok,
    reason: "the runner is ready and in parity",
  };
}

/** What `resolveConfig` hands back for this command's option table. */
type ResolvedPreflight = ResolvedConfig<
  ResolvedValues<typeof PREFLIGHT_CLI_OPTIONS>
>;

export async function preflightCommand(
  argv: readonly string[],
  context: CliContext,
): Promise<number> {
  let resolved;
  try {
    resolved = resolveConfig({
      argv,
      env: context.env,
      cwd: context.cwd,
      options: PREFLIGHT_CLI_OPTIONS,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      context.stderr(`tess preflight: ${error.message}`);
      context.stderr("");
      context.stderr("Run `tess preflight --help` for usage.");
      return EXIT_CODES.usage;
    }
    throw error;
  }

  // The DEV-15 write journal's directory, staged for the whole command and
  // restored however it ends. `--mode apply` mutates a real instance and the
  // vendored transport journals each mutation under whatever `SN_DOCS_DIR`
  // says at that moment; this command staged nothing, so those entries went to
  // the transport's cwd-relative default — a second journal of the same project
  // that no reader of the first one can know exists.
  //
  // `docsDir` is `--docs-dir` / `TESSERA_DOCS_DIR` / the config file, already
  // resolved and already printed back to the operator by `formatResolvedConfig`
  // above; until this call nothing read it, so naming an audit directory
  // changed the echo and not the destination.
  //
  // Staged HERE, before anything reaches the instance, rather than around the
  // writer alone: the §11 guard's refusal contract (see the header) depends on
  // no write happening before the classification, and a staging that started
  // later would have to be moved every time that boundary does.
  //
  // `stageDocsDir` lives in `stage.ts` because that module is the only one
  // allowed to write `process.env`; see its doc-comment for why calling
  // `stage()` itself would be wrong here.
  const requested = resolved.values.docsDir;
  const restoreDocsDir = stageDocsDir({
    cwd: context.cwd,
    ...(typeof requested === "string" && requested.trim() !== ""
      ? { docsDir: requested }
      : {}),
  });
  try {
    return await runResolvedPreflight(resolved, context);
  } finally {
    restoreDocsDir();
  }
}

/**
 * The command proper, once configuration is resolved and the journal has a
 * home. Split from `preflightCommand` only so the staging above can own a
 * `finally` without wrapping two hundred lines in one; conceptually the two are
 * a single function and every decision described in the header lives here.
 */
async function runResolvedPreflight(
  resolved: ResolvedPreflight,
  context: CliContext,
): Promise<number> {
  const values = resolved.values;
  const json = values.json === true;
  const kinds = (values.kinds ?? []) as readonly TestKind[];
  const mode: ProvisionMode = values.mode === "apply" ? "apply" : "plan";

  if (!json) {
    context.stdout(formatResolvedConfig(resolved));
    context.stdout("");
  }

  const usage = (message: string): number => {
    context.stderr(`tess preflight: ${message}`);
    return EXIT_CODES.usage;
  };

  if (typeof values.runner !== "string" || values.runner.trim() === "") {
    return usage(
      "no runner — pass --runner <profile> (or --instance <profile> to collapse the topology)",
    );
  }

  const artifacts: TargetArtifactRef[] = [];
  for (const raw of values.artifacts ?? []) {
    const parsed = parseArtifact(raw);
    if (typeof parsed === "string") return usage(parsed);
    artifacts.push(parsed);
  }

  // The four apply-hardening flags (delegated decision 2026-09-23, TODO
  // "preflight apply"). Each one is a statement about a WRITE; on a plan-only
  // run nothing is written, so accepting one there would let an operator
  // believe it had been honoured. Refused, never ignored.
  const applyOnly = [
    ["--acknowledge-prod", values.acknowledgeProd],
    ["--ledger-root", values.ledgerRoot],
    ["--plan-hash", values.planHash],
    ["--idempotency-key", values.idempotencyKey],
  ] as const;
  for (const [flag, value] of applyOnly) {
    if (value === undefined) continue;
    if (mode !== "apply") {
      return usage(
        `${flag} only means something with --mode apply — a plan-only run writes nothing for it to govern`,
      );
    }
    if (value.trim() === "") {
      return usage(
        flag === "--acknowledge-prod"
          ? "--acknowledge-prod needs a non-empty reason — it is journalled before any write (§11.4)"
          : `${flag} needs a non-empty value`,
      );
    }
  }

  let runner: RoleBinding;
  let source: RoleBinding;
  let target: RoleBinding | undefined;
  try {
    runner = bindRole("runner", values.runner);
    // A topology with no declared source is collapsed, not broken: parity then
    // reports `not-applicable` and says so out loud.
    source = bindRole(
      "source",
      typeof values.source === "string" && values.source.trim() !== ""
        ? values.source
        : values.runner,
    );
    target =
      typeof values.target === "string" && values.target.trim() !== ""
        ? bindRole("target", values.target)
        : undefined;
  } catch (error) {
    if (error instanceof TopologyError) return usage(error.message);
    throw error;
  }

  // Stamped once. The guard's audit trail and the pipeline context must agree on
  // which run they belong to, and two calls to the clock would not. The colons
  // of the ISO stamp are dropped: the §4b ledger keys its audit records by run
  // id and accepts only `[A-Za-z0-9._-]`, so the raw stamp made every
  // `--acknowledge-prod` refuse as unjournallable. Lowercased for the same
  // reason: the ledger accepts lowercase run ids only (delegated decision
  // 2026-09-25), and the stamp carries an uppercase `T` and `Z`.
  const runId = `preflight-${context
    .now()
    .toISOString()
    .replace(/:/g, "")
    .toLowerCase()}`;

  const runnerProbe = bindProbe(createSnInstanceProbe(), runner.profile);
  const realDoctor = createEnvironmentDoctor(
    createDefaultPreconditions(runnerProbe),
  );

  // §11 is a precondition of writing, not a wrapper around it. Classified here,
  // before the writer exists, so a refusal cannot race a write. A GuardViolation
  // propagates out of the command — `cli.ts` maps it to exit 4.
  //
  // The §4b ledger root is resolved only in apply mode: a plan-only run
  // journals nothing, so it must not create a `.tessera/` it never uses.
  // Default `<cwd>/.tessera`, the same root `tess run` defaults to, so the
  // §11.4 audit of both commands lands in ONE log (delegated decision
  // 2026-09-23).
  let classification: Classification | undefined;
  let ledgerRoot: string | undefined;
  const acknowledgements: string[] = [];
  if (mode === "apply") {
    ledgerRoot = path.resolve(
      context.cwd,
      values.ledgerRoot ?? DEFAULT_LEDGER_DIR,
    );
    // The guard journals an honoured override itself, synchronously, from
    // inside `assertRunnerWritable` — durable before the write is permitted.
    // Without a sink AND a runId it refuses every acknowledgement outright,
    // which is why this command, which offered none, could never lift a
    // prod-suspect runner (TODO option (a)).
    const audit = createLedgerGuardAuditSink(
      createIntentLedger({ rootDir: ledgerRoot, now: context.now }),
    );
    const guard = createTargetGuard(
      {
        nonProdAllowlist: values.allow ?? [],
        prodInstances: values.prod ?? [],
        ...(values.acknowledgeProd === undefined
          ? {}
          : {
              acknowledgeProd: {
                reason: values.acknowledgeProd,
                actor: context.actor,
                surface: "cli" as const,
              },
            }),
      },
      {
        probe: createGuardProbe([{ ref: runner.ref, probe: runnerProbe }]),
        audit,
        runId,
        // The guard stamps its audit entries with an ISO string, not a Date —
        // adapt the context clock rather than widening the guard's contract.
        now: () => context.now().toISOString(),
      },
    );
    classification = await guard.classify(runner.ref, "runner");
    guard.assertRunnerWritable(classification);
    for (const entry of audit.records()) {
      acknowledgements.push(
        `${entry.role} ${entry.cls}: ${entry.reason} (${entry.actor})`,
      );
    }
  }

  const doctorReport = await realDoctor.diagnose({ kinds });
  const shot = oneShotDoctor(doctorReport, realDoctor);

  const parityReport = await createParityCheck(createSnArtifactReader()).check({
    artifacts,
    topology: { source: source.profile, runner: runner.profile },
  });

  // The provisioner is built before the plan exists, and the ledgered writer
  // needs the plan (its hash and steps) — so the provisioner gets a forwarding
  // writer whose target is set once the plan is known. Until then it forwards
  // to nothing: `plan()` never writes, and a write before the slot is filled
  // is a bug that must fail loudly rather than go unjournalled.
  const rawWriter = bindWriter(createSnInstanceWriter(), runner.profile);
  let applyWriter: InstanceWriter | undefined;
  const provisioner = createPreflightProvisioner({
    doctor: shot.doctor,
    probe: runnerProbe,
    writer: {
      updateRecord(table, sysId, fields) {
        if (applyWriter === undefined) {
          return Promise.reject(
            new Error(
              "preflight: a write was attempted before the ARCH-33 ledger was bound — refusing an unjournalled write",
            ),
          );
        }
        return applyWriter.updateRecord(table, sysId, fields);
      },
    },
    mode,
    kinds,
  });

  const ctx: PipelineContext = {
    runId,
    lifecycle: "ephemeral",
    coverageSource: "preflight",
    topology: {
      source: source.profile,
      runner: runner.profile,
      target: (target ?? runner).profile,
    },
    signal: new AbortController().signal,
  };

  const plan = await provisioner.plan(ctx);

  // §6b stale-plan refusal. The plan is ALWAYS recomputed; `--plan-hash` is
  // the digest the operator reviewed, and a different one means the instance
  // moved between review and apply. Refused with nothing written — silently
  // applying the new plan would execute writes nobody reviewed.
  const expectedHash = values.planHash?.trim();
  if (mode === "apply" && expectedHash !== undefined) {
    if (plan.planHash !== expectedHash) {
      context.stderr(
        `REFUSED (§6b): stale plan hash — --plan-hash ${expectedHash} was reviewed, but the recomputed plan is ${plan.planHash ?? "(no digest)"}; nothing was written. Re-run --mode plan, review, and pass the new hash.`,
      );
      return EXIT_CODES.refused;
    }
  }

  let applied = false;
  let infraEntries: readonly LedgerInfraWriteRecord[] = [];
  let skippedSteps: readonly number[] = [];
  let idempotencyKey: string | undefined;
  if (mode === "apply" && plan.steps.length > 0) {
    if (plan.planHash === undefined || ledgerRoot === undefined) {
      // `plan()` always hashes what it holds; a plan without a digest cannot
      // be journalled (every infra entry carries one), so it is not applied.
      context.stderr(
        "REFUSED (§6b): the plan carries no digest, so its writes cannot be journalled (ARCH-33); nothing was written.",
      );
      return EXIT_CODES.refused;
    }
    const host = normalizeInstanceHost(runner.ref.host) ?? runner.ref.host;
    const infra = createInfraLedger({
      rootDir: ledgerRoot,
      host,
      now: context.now,
    });
    idempotencyKey = values.idempotencyKey?.trim() ?? runId;
    const conflict = await checkIdempotency(
      infra,
      plan.planHash,
      idempotencyKey,
      plan.steps,
    );
    if (conflict !== undefined) {
      context.stderr(`REFUSED (ARCH-33): ${conflict}; nothing was written.`);
      return EXIT_CODES.refused;
    }
    const ledgered = createLedgeredWriter(rawWriter, {
      ledger: infra,
      planHash: plan.planHash,
      idempotencyKey,
      steps: plan.steps,
    });
    applyWriter = ledgered.writer;
    try {
      await provisioner.apply(ctx, plan);
    } finally {
      infraEntries = ledgered.entries();
      skippedSteps = ledgered.skipped();
    }
    applied = true;
  }

  // Post-apply: `shot.latest()` is the re-diagnosis `apply()` performed for its
  // own verification. Reusing it costs nothing and keeps the verdict describing
  // the instance as it is now.
  const finalDoctor = applied ? shot.latest() : doctorReport;
  const verdict = decideVerdict(finalDoctor, parityReport, plan, mode);

  if (json) {
    context.stdout(
      JSON.stringify(
        {
          // The handle, and the only one. It was minted above, handed to the
          // guard's §11.4 audit sink and to the `PipelineContext`, and then
          // dropped from both output branches — which left the journal on disk
          // holding entries about a run no caller could name. A machine
          // consumer has no other way back: `now()` is not reproducible from
          // the outside, so the id had to be published or lost.
          runId,
          mode,
          kinds,
          topology: {
            source: { profile: source.profile, host: source.ref.host },
            runner: { profile: runner.profile, host: runner.ref.host },
            ...(target === undefined
              ? {}
              : { target: { profile: target.profile, host: target.ref.host } }),
          },
          ...(classification === undefined
            ? {}
            : {
                runnerClassification: {
                  cls: classification.cls,
                  evidence: classification.evidence,
                },
              }),
          doctor: finalDoctor,
          parity: parityReport,
          plan: {
            readiness: plan.readiness,
            actions: plan.actions,
            steps: plan.steps,
            blockers: plan.blockers,
            applied,
            // The identity of the plan, in the document that has the only
            // consumer for it. The human branch has printed `plan hash: …`
            // since the digest existed; this branch published everything about
            // the plan EXCEPT the one field a machine would hand back to an
            // apply, which is backwards — the operator reading prose is the one
            // who cannot use it. Same field, same name, same value; the state
            // tag is why an absent digest cannot be read as an empty one.
            planHash: planIdentity(plan),
            ...(plan.hardFailure === undefined
              ? {}
              : { hardFailure: plan.hardFailure }),
          },
          // Apply only: where the §11.4 audit and the ARCH-33 standing-infra
          // entries went, and what they say. A plan-only run journals nothing
          // and so publishes none of this.
          ...(ledgerRoot === undefined
            ? {}
            : {
                ledger: {
                  root: ledgerRoot,
                  acknowledgements,
                  ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
                  infra: infraEntries,
                  skippedSteps,
                },
              }),
          verdict: {
            exitCode: verdict.exitCode,
            reason: verdict.reason,
            // The tri-state the human branch prints as `VERDICT: <status> —
            // <reason>`, which the machine branch left the caller to
            // reconstruct from the exit code. `verdictLabel` is the only thing
            // that knows 5 is not a softer 1, so a caller deriving the word
            // itself has to re-implement that distinction to get it right.
            // Rendered through the same function the human line uses, so the
            // two words cannot diverge.
            //
            // What this does NOT do, stated because the opposite is the
            // plausible reading: it does not make the MCP collapsed-verdict
            // banner reachable here. That banner fires on the exit-1 branch
            // when the document says `INCONCLUSIVE` anyway — a decision the
            // exit code claims and the verdict denies. For this command the two
            // cannot disagree: the label is derived from `verdict.exitCode` and
            // `preflightCommand` returns that same value, so the combination the
            // banner exists to catch is unconstructible. It is reachable from
            // `tess run`, whose frozen Phase-0.5 mapping collapses NO_GO and
            // INCONCLUSIVE onto exit 1 — which is where the name comes from.
            status: verdictLabel(verdict),
          },
        },
        null,
        2,
      ),
    );
    return verdict.exitCode;
  }

  context.stdout(`runner: ${runner.profile} <${runner.ref.host}>`);
  context.stdout(`source: ${source.profile} <${source.ref.host}>`);
  if (target !== undefined) {
    context.stdout(`target: ${target.profile} <${target.ref.host}>`);
  }
  if (classification !== undefined) {
    // Every signal, not just the deciding one: an operator who disagrees with a
    // classification needs to see what the guard weighed, not only its answer.
    context.stdout(`guard:  ${classification.cls}`);
    for (const signal of classification.evidence) {
      context.stdout(`  - ${signal.kind} (${signal.effect}): ${signal.detail}`);
    }
  }
  context.stdout("");
  context.stdout(formatDoctorReport(finalDoctor));
  context.stdout("");
  context.stdout(formatParityReport(parityReport));
  context.stdout("");
  for (const line of acknowledgements) {
    context.stdout(`acknowledged (§11.4): ${line}`);
  }
  context.stdout(
    applied
      ? `provision plan (applied — ${plan.steps.length - skippedSteps.length} write(s)` +
          (skippedSteps.length === 0
            ? ""
            : `, ${skippedSteps.length} already confirmed under ${idempotencyKey}`) +
          ")"
      : `provision plan (mode ${mode} — nothing was written)`,
  );
  if (applied && ledgerRoot !== undefined) {
    context.stdout(
      `ledger (ARCH-33): ${infraEntries.length} standing-infra entr${infraEntries.length === 1 ? "y" : "ies"} under ${ledgerRoot}`,
    );
  }
  context.stdout(formatProvisionPlan(plan));
  context.stdout("");
  context.stdout(`VERDICT: ${verdictLabel(verdict)} — ${verdict.reason}`);
  context.stdout("");

  return verdict.exitCode;
}
