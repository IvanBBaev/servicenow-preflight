// The Provisioner — plan/apply, never blind ensure (ARCH-2, PLAN Phase 1).
//
// Three properties this file is built to keep:
//
//  1. **Default is dry-run.** A provisioner constructed without `mode: "apply"`
//     cannot write, whatever it is wired into. That is what makes it safe to
//     hand to the run loop, which must never raise standing infrastructure
//     (ARCH-33) — raising it is `tess preflight --mode apply`'s job and nothing
//     else's.
//  2. **Apply executes the plan, not an intention.** `apply()` runs the
//     executable half of the plan object it was handed. A plan that arrived
//     without one (an inspectable `ProvisionPlan` from a report, say) is
//     refused, because "ensure this description is true" is exactly the blind
//     ensure ARCH-2 rules out.
//  3. **A write is not believed until the instance agrees.** After the last
//     step, the doctor is re-run and every remedied precondition must come back
//     `ready`. A 200 on a PATCH is the transport's opinion about a request; the
//     re-diagnosis is the instance's opinion about itself.

import { computePlanHash, type Provisioner } from "@tessera/core";
import type {
  DoctorFinding,
  DoctorReport,
  EnvironmentDoctor,
  InstanceProbe,
} from "@tessera/doctor";
import type { PipelineContext, ProvisionPlan, TestKind } from "@tessera/types";

import {
  ProvisionApplyError,
  ProvisionRefusedError,
  ProvisionVerificationError,
} from "./errors.js";
import { DEFAULT_RECIPES, type Recipe } from "./recipes.js";
import type {
  HashedProvisionPlan,
  PreflightProvisionPlan,
  ProvisionBlocker,
  ProvisionMode,
  ProvisionStep,
} from "./types.js";
import type { InstanceWriter } from "./writer.js";

export interface PreflightProvisionerOptions {
  readonly doctor: EnvironmentDoctor;
  /** Read side — used to bind each planned write to a row it has observed. */
  readonly probe: InstanceProbe;
  /** Write side. Only ever consulted in `mode: "apply"`. */
  readonly writer: InstanceWriter;
  /** Default `plan`: a provisioner that cannot write unless asked to. */
  readonly mode?: ProvisionMode;
  /** Kinds the run will request, so DEV-2 gating applies to the plan too. */
  readonly kinds?: readonly TestKind[];
  /** Override for tests; production uses `DEFAULT_RECIPES`. */
  readonly recipes?: Readonly<Record<string, Recipe>>;
}

export interface PreflightProvisioner extends Provisioner {
  readonly mode: ProvisionMode;
  plan(ctx: PipelineContext): Promise<HashedProvisionPlan>;
  apply(ctx: PipelineContext, plan: ProvisionPlan): Promise<void>;
}

export function createPreflightProvisioner(
  options: PreflightProvisionerOptions,
): PreflightProvisioner {
  const mode: ProvisionMode = options.mode ?? "plan";
  const recipes = options.recipes ?? DEFAULT_RECIPES;

  async function diagnose(ctx: PipelineContext): Promise<DoctorReport> {
    return options.doctor.diagnose({
      ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
      signal: ctx.signal,
    });
  }

  return {
    mode,

    async plan(ctx: PipelineContext): Promise<HashedProvisionPlan> {
      const report = await diagnose(ctx);
      const steps: ProvisionStep[] = [];
      const blockers: ProvisionBlocker[] = [];

      // Only `required` findings drive a plan. A `deferred` one is a control
      // this phase has declared but cannot probe; planning a write for a
      // precondition nobody can evaluate would be writing on a guess.
      for (const finding of report.findings) {
        if (finding.applicability !== "required") continue;
        if (finding.status === "ready") continue;

        const recipe = recipes[finding.precondition];
        if (recipe === undefined) {
          blockers.push({
            precondition: finding.precondition,
            status: finding.status,
            evidence: finding.evidence,
            why: blockerWhy(finding),
          });
          continue;
        }

        const result = await recipe(options.probe, ctx.signal);
        if (result.outcome === "step") steps.push(result.step);
        else {
          blockers.push({
            precondition: finding.precondition,
            status: finding.status,
            evidence: finding.evidence,
            why: result.why,
          });
        }
      }

      return {
        actions: steps.map((step) => step.action),
        steps,
        blockers,
        readiness: report.status,
        // DESIGN §6b: the plan and its content hash come back together, so
        // the identity an operator is shown is the identity of the object they
        // were handed. Taken from the local `steps` array rather than from the
        // plan literal it is being placed on, because `computePlanHash` is only
        // defined for a plan that HAS an executable half: hashing here makes it
        // impossible to reach with a step-less `ProvisionPlan` that crossed a
        // package boundary. An empty `steps` is not a special case — it is a
        // legal plan and gets a real digest.
        planHash: computePlanHash({ steps }),
        ...(report.hardFailure === undefined
          ? {}
          : { hardFailure: report.hardFailure }),
      };
    },

    async apply(ctx: PipelineContext, plan: ProvisionPlan): Promise<void> {
      if (mode !== "apply") {
        throw new ProvisionRefusedError(
          `run ${ctx.runId}: this provisioner is in mode "${mode}" — ` +
            `${plan.actions.length} action(s) were planned and none will be written ` +
            "(re-run with --mode apply)",
        );
      }
      // Delegated decision 2026-09-26: snapshot the plan ONCE, before any
      // check, and from here on validate, hash and write ONLY the snapshot.
      // The caller's object may carry accessors: a `write.table` getter that
      // answered the allowed table to the gate and to the hash and a role
      // table to `updateRecord` walked straight through a gate that read the
      // live object three times. A JSON round trip reads every field exactly
      // once and keeps plain data only (functions and accessors cannot
      // survive it). A plan that cannot be snapshotted — a cycle, a BigInt, a
      // getter that throws — is refused with zero writes: fail closed.
      let snapshot: ProvisionPlan;
      try {
        snapshot = snapshotPlan(plan);
      } catch (error) {
        throw new ProvisionRefusedError(
          `run ${ctx.runId}: the plan could not be copied as plain data ` +
            `(${describeError(error)}); nothing was written (ARCH-2)`,
        );
      }
      if (!isExecutable(snapshot)) {
        throw new ProvisionRefusedError(
          `run ${ctx.runId}: the plan carries no executable steps — it is a ` +
            "description of writes, not a plan bound to rows (ARCH-2)",
        );
      }
      const trusted: PreflightProvisionPlan = snapshot;
      // Delegated decision 2026-09-25: structure alone is not authority to
      // write. Before ANY write, the plan must carry the hash of its own steps
      // and every step must be exactly what a recipe this provisioner holds
      // declares it may write (table allowlist + exact field payload). A
      // hand-built or tampered plan is refused here, with zero writes, instead
      // of being PATCHed and then caught (maybe) by the re-diagnosis below.
      const untrusted = whyPlanIsUntrusted(trusted, recipes);
      if (untrusted !== undefined) {
        throw new ProvisionRefusedError(
          `run ${ctx.runId}: the plan was not produced by this provisioner's ` +
            `recipes — ${untrusted}; nothing was written (ARCH-2)`,
        );
      }
      if (ctx.signal.aborted) {
        throw new ProvisionRefusedError(
          `run ${ctx.runId}: aborted before the first write`,
        );
      }

      // Blockers do NOT cancel the applicable steps. They were reported at plan
      // time and they stay the operator's problem; refusing to fix what CAN be
      // fixed because something else cannot is not fail-closed, it is just
      // unhelpful. Verification below still holds the line: only the remedied
      // preconditions are asserted ready, so a blocker cannot be mistaken for
      // fixed.
      const total = trusted.steps.length;
      let applied = 0;
      for (const step of trusted.steps) {
        if (ctx.signal.aborted) {
          throw new ProvisionApplyError(
            `run ${ctx.runId}: aborted after ${applied} of ${total} step(s)`,
            { applied, total },
          );
        }
        try {
          await options.writer.updateRecord(
            step.write.table,
            step.write.sysId,
            step.write.fields,
          );
        } catch (error) {
          throw new ProvisionApplyError(
            `run ${ctx.runId}: ${step.action.description} failed after ` +
              `${applied} of ${total} step(s) succeeded`,
            { applied, total, cause: error },
          );
        }
        applied += 1;
      }

      if (applied === 0) return;

      const after = await diagnose(ctx);
      // Iterate the REMEDIED set, not the returned findings. Filtering
      // `after.findings` answers "which of the findings we got back are not
      // ready", and a precondition the second diagnosis simply did not report
      // on is absent from that list — so an unverified write came back as a
      // verified one. `EnvironmentDoctor` is an injected interface: the
      // reference implementation emits one finding per catalogue entry, but
      // the pre-write gate checks steps against the RECIPE map, not against
      // the doctor's catalogue, so `apply()` still accepts a plan whose
      // preconditions this doctor does not report on (a recipe map and a
      // doctor built from different catalogues). A missing finding is
      // therefore reachable, and it is the one shape where
      // silence used to read as agreement. DEV-1/DEV-2: absence of evidence is
      // not a pass.
      const byPrecondition = new Map(
        after.findings.map((finding) => [finding.precondition, finding]),
      );
      const remedied = [
        ...new Set(trusted.steps.map((step) => step.precondition)),
      ];
      const detail: string[] = [];
      let unreadable = false;
      let contradicted = false;
      for (const precondition of remedied) {
        const finding = byPrecondition.get(precondition);
        if (finding === undefined) {
          unreadable = true;
          detail.push(
            `${precondition} was not re-diagnosed at all (the doctor returned no finding for it)`,
          );
          continue;
        }
        if (finding.status === "ready") continue;
        // "is still X" claims the status did not move, and nothing here has
        // read the plan-time status to know that. `plan()` admits every
        // non-`ready` finding, so a step can descend from an `unknown` one:
        // the recipe re-reads the row itself and answers `step` on what IT
        // saw, never on the finding's status. "Still unknown" is therefore
        // sometimes true and sometimes a fabricated comparison, and the line
        // cannot tell which. "Came back X" is the fact this code actually has.
        if (finding.status === "unknown") unreadable = true;
        else contradicted = true;
        detail.push(
          `${precondition} came back ${finding.status} (${finding.evidence})`,
        );
      }
      if (detail.length > 0) {
        // "the instance disagrees" is a claim about an answer, so it is only
        // made when there was one. A finding that came back `unknown` did not
        // contradict the write — nothing was read back at all — and a
        // precondition with no finding at all was not even asked about. Both
        // leave the write UNCONFIRMED rather than refuted. Either way this
        // throws (fail-closed: a write is not believed until the instance
        // agrees), but an operator told the instance disagreed will go looking
        // for what overwrote their change, and on those paths there may be
        // nothing to find. Hedged and the exception named, the way
        // `DOCTOR_TOOL` in `@tessera/mcp` hedges its own "usually".
        const outcome = unreadable
          ? "the instance did not confirm them — at least one precondition " +
            "was not read back as ready, so these writes are unconfirmed " +
            (contradicted ? "or refuted" : "rather than refuted")
          : "the instance disagrees";
        throw new ProvisionVerificationError(
          `run ${ctx.runId}: ${applied} write(s) reported success but ${outcome} — ${detail.join("; ")}`,
        );
      }
    },
  };
}

/**
 * A plain-data copy of the fields `apply()` consumes: every property is read
 * exactly once, accessors become values, and anything that is not JSON data
 * (a function, a symbol key, a prototype) does not survive the trip.
 *
 * @throws whatever `JSON.stringify` throws — a cycle, a BigInt, an accessor
 * that throws. `apply()` turns that into a refusal.
 */
function snapshotPlan(plan: ProvisionPlan): ProvisionPlan {
  const candidate = plan as Partial<PreflightProvisionPlan>;
  const text = JSON.stringify({
    actions: [],
    steps: candidate.steps,
    planHash: candidate.planHash,
  });
  return JSON.parse(text) as ProvisionPlan;
}

function describeError(error: unknown): string {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return "<unprintable error>";
  }
}

/** ServiceNow sys_ids are 32 lowercase hex characters. */
const SYS_ID = /^[0-9a-f]{32}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameFields(
  actual: Record<string, unknown>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every(
    (key, index) =>
      actualKeys[index] === key &&
      Object.hasOwn(actual, key) &&
      actual[key] === expected[key],
  );
}

/**
 * The pre-write gate `apply()` runs on a structurally executable plan. Returns
 * the first reason the plan may not be written, or `undefined` when every step
 * is one this provisioner's recipes could have produced.
 *
 * Delegated decision 2026-09-25 (fail closed), in order:
 *  - every step must be well-formed (`update-record`, non-empty string table
 *    and sys_id, a plain `fields` object) — checked first so the hash below
 *    is only ever computed over a shape it is defined for;
 *  - `step.precondition` must be an OWN key of the recipe map (`Object.hasOwn`,
 *    so `constructor`/`__proto__` cannot pose as recipes);
 *  - the step's table must be the table that recipe declares, its action must
 *    name the same table, and its fields must equal the recipe's declared
 *    payload exactly (same keys, same values) — the allowlist is derived from
 *    the recipes, never configured beside them;
 *  - no two steps may write the same row (table + sys_id): a recipe plans at
 *    most one write per row, so a repeat is not a plan this provisioner made;
 *  - `planHash` must be present and equal `computePlanHash({ steps })`.
 *
 * Delegated decision 2026-09-26, the honest threat model of that last check:
 * it DETECTS accidental or stale divergence — a plan edited, truncated or
 * re-serialised after it was shown, or a hash copied from another dry-run. It
 * does NOT authenticate the plan. `computePlanHash` is unkeyed, so anyone who
 * can edit the steps can recompute a matching hash, and a hand-built plan that
 * addresses a different row of an allowed table with the allowed payload
 * passes. What bounds such a plan is the recipe allowlist (table and exact
 * field payload) and the well-formed sys_id check above, not the hash. The
 * caller of `apply()` is trusted to hand in a plan this process planned.
 *
 * The plan handed in here is `apply()`'s plain-data SNAPSHOT, so every field
 * read below is a value, not an accessor that can answer differently later.
 */
function whyPlanIsUntrusted(
  plan: PreflightProvisionPlan,
  recipes: Readonly<Record<string, Recipe>>,
): string | undefined {
  const steps: readonly unknown[] = plan.steps;
  const seenRows = new Set<string>();
  for (const [index, candidate] of steps.entries()) {
    const at = `step ${index + 1}`;
    if (!isPlainRecord(candidate)) return `${at} is not an object`;
    const { precondition, write, action } = candidate;
    if (typeof precondition !== "string" || precondition === "") {
      return `${at} names no precondition`;
    }
    if (!Object.hasOwn(recipes, precondition)) {
      return `${at} names precondition "${precondition}", which no recipe remedies`;
    }
    if (!isPlainRecord(write) || write.kind !== "update-record") {
      return `${at} carries no update-record write`;
    }
    const { table, sysId, fields } = write;
    if (typeof table !== "string" || table === "") {
      return `${at} names no table`;
    }
    if (typeof sysId !== "string" || sysId === "") {
      return `${at} names no sys_id`;
    }
    // Delegated decision 2026-09-26: a sys_id is 32 lowercase hex characters
    // or it is not one — anything else is refused rather than put in a URL.
    if (!SYS_ID.test(sysId)) {
      return `${at} names a sys_id that is not 32 lowercase hex characters`;
    }
    // Delegated decision 2026-09-26: the same row twice is refused, not
    // de-duplicated. A plan this provisioner produced never repeats a row, so
    // a repeat is evidence the plan was built or edited elsewhere.
    const row = `${table}/${sysId}`;
    if (seenRows.has(row)) {
      return `${at} writes ${row} more than once`;
    }
    seenRows.add(row);
    if (!isPlainRecord(fields)) return `${at} carries no field payload`;
    const recipe = recipes[precondition];
    const scope: unknown = recipe?.writes;
    if (!isPlainRecord(scope)) {
      return `${at}: the recipe for "${precondition}" declares no writes`;
    }
    if (scope.kind !== write.kind || scope.table !== table) {
      return `${at} writes to table "${table}", which the recipe for "${precondition}" does not allow`;
    }
    if (!isPlainRecord(action) || action.table !== table) {
      return `${at}: its action does not describe the table it writes`;
    }
    if (
      !isPlainRecord(scope.fields) ||
      !sameFields(fields, scope.fields as Readonly<Record<string, string>>)
    ) {
      return `${at} writes fields the recipe for "${precondition}" does not produce`;
    }
  }
  const { planHash } = plan;
  if (typeof planHash !== "string" || planHash === "") {
    return "it carries no plan hash";
  }
  if (planHash !== computePlanHash({ steps: plan.steps })) {
    return "its plan hash does not match its steps";
  }
  return undefined;
}

/**
 * Why a finding with no recipe could not become a step.
 *
 * The STATUS is read first, because the three-state contract makes these two
 * different claims and this line used to collapse them. A `not-ready` finding
 * DECIDED: something was observed, and no write this phase owns changes it —
 * "it needs an instance change outside the Table API" is then a diagnosis with
 * a reading behind it. An `unknown` finding decided nothing. The instance never
 * answered, or this phase has no probe for it yet (a `deferred` precondition
 * promoted to required by `--kind`), and the same sentence would hand the
 * operator a diagnosis of an instance nobody read — pointing at plugins, roles
 * and admins on the strength of a timeout.
 *
 * Both remain blockers: a state this run could not decide is not a state it may
 * write against, which is the same fail-closed rule everywhere else. Only the
 * explanation differs, and the `not-ready` wording is left exactly as it was —
 * it was never the false half.
 */
function blockerWhy(finding: DoctorFinding): string {
  if (finding.status === "unknown") {
    return (
      "nothing can be planned for a precondition this run did not decide — " +
      "the evidence above says why it is undecided, and until that is " +
      "settled there is no observed state for a write to change"
    );
  }
  return finding.remedy === undefined
    ? "no write can fix this — it needs an instance change outside the Table API (plugin activation, roles, or a human)"
    : "the doctor points at a remedy this phase has no recipe for; a plan may not be invented from a description";
}

/**
 * Structural, not nominal: the plan may have crossed a package boundary, and an
 * `instanceof` check would fail on an object that is perfectly executable.
 *
 * An EMPTY step list still counts as executable — "nothing to do" is a valid
 * plan and applying it is a no-op, which is a different thing from a plan whose
 * executable half was never there.
 */
export function isExecutable(
  plan: ProvisionPlan,
): plan is PreflightProvisionPlan {
  const candidate = plan as Partial<PreflightProvisionPlan>;
  return Array.isArray(candidate.steps);
}

/** Human-readable dry-run output. Derives nothing the plan does not already say. */
export function formatProvisionPlan(plan: PreflightProvisionPlan): string {
  const lines = [
    `readiness: ${plan.readiness} — ${plan.steps.length} step(s), ${plan.blockers.length} blocker(s)`,
  ];
  // The §6b identity of the plan, printed where an operator can copy it out of
  // the dry-run they are reading. Qualified rather than bare: `computePlanHash`
  // covers the steps and excludes the blockers and the readiness on the line
  // directly above, so a digest sitting under that roll-up would otherwise read
  // as an identity of it — and two materially different dry-runs can share one.
  //
  // Conditional because the field is optional on `PreflightProvisionPlan` (see
  // `types.ts`): every plan `plan()` returns carries a hash, and a hand-built
  // plan that does not gets no line rather than a printed `undefined`.
  if (plan.planHash !== undefined) {
    lines.push(
      `plan hash: ${plan.planHash} (planned writes only — not blockers or readiness)`,
    );
  }
  for (const step of plan.steps) {
    lines.push(`  + ${step.action.description}`);
    lines.push(`      observed: ${step.observed}`);
    lines.push(
      `      write: ${step.write.kind} ${step.write.table}/${step.write.sysId} ${JSON.stringify(step.write.fields)}`,
    );
  }
  for (const blocker of plan.blockers) {
    lines.push(`  ! [${blocker.status}] ${blocker.precondition}`);
    lines.push(`      ${blocker.evidence}`);
    lines.push(`      cannot be planned: ${blocker.why}`);
  }
  if (plan.steps.length === 0 && plan.blockers.length === 0) {
    lines.push("  (nothing to do — every required precondition is ready)");
  }
  if (plan.hardFailure !== undefined) {
    lines.push(`  HARD FAILURE: ${plan.hardFailure}`);
  }
  return lines.join("\n");
}
