// The Provisioner vocabulary (ARCH-2/ARCH-13, PLAN Phase 1).
//
// `ProvisionPlan` in `@tessera/types` is the INSPECTABLE half of a plan: a list
// of `ProvisionAction`s a human can read in a dry-run. It carries no payload, so
// it cannot be executed — and that is correct for a wire/report type. The
// executable half lives here, attached to the same plan object, so that
// `plan()` and `apply()` are talking about the same plan and not about two
// descriptions that happen to look alike.

import type { ProvisionAction, ProvisionPlan } from "@tessera/types";

import type { DoctorStatus } from "@tessera/doctor";

/**
 * Default is `plan`. A provisioner constructed without an explicit mode can be
 * wired anywhere — including into the run loop — and still cannot write
 * (ARCH-33). Writing is an opt-in the operator makes with `--mode apply`.
 */
export type ProvisionMode = "plan" | "apply";

/**
 * The one write shape this phase can plan.
 *
 * There is no `create` variant on purpose. Every MVP remedy addresses a row the
 * probe has already seen, and the one case that would need a create — a
 * `sys_properties` row that reads as absent — is exactly the case where absent
 * is ambiguous (genuinely unset vs ACL-trimmed). Creating a second row for a
 * property name that may already exist unseen is a blind write, so it becomes a
 * blocker rather than a step.
 */
export interface UpdateRecordWrite {
  readonly kind: "update-record";
  readonly table: string;
  readonly sysId: string;
  readonly fields: Readonly<Record<string, string>>;
}

export type ProvisionWrite = UpdateRecordWrite;

/** One planned change: what a reader sees, what the instance will receive. */
export interface ProvisionStep {
  /** The precondition this step exists to satisfy. */
  readonly precondition: string;
  /** The inspectable half — what `ProvisionPlan.actions` reports. */
  readonly action: ProvisionAction;
  /** The executable half — bound to a row the probe actually observed. */
  readonly write: ProvisionWrite;
  /** What the probe saw that made this step necessary. */
  readonly observed: string;
}

/**
 * A precondition that is not `ready` and that this phase cannot fix by writing.
 * Blockers are reported, never silently dropped: a plan that lists two steps and
 * says nothing about the plugin that is missing would read as "apply this and
 * you are done" (QA-9).
 */
export interface ProvisionBlocker {
  readonly precondition: string;
  readonly status: DoctorStatus;
  readonly evidence: string;
  /** Why no step could be planned for it. */
  readonly why: string;
}

/**
 * A `ProvisionPlan` that also carries its executable half. Structurally still a
 * `ProvisionPlan`, so it satisfies the core port; `apply()` refuses anything
 * that arrives without `steps`, because an inspectable-only plan is a
 * description of a write, not a write.
 */
export interface PreflightProvisionPlan extends ProvisionPlan {
  readonly actions: readonly ProvisionAction[];
  readonly steps: readonly ProvisionStep[];
  readonly blockers: readonly ProvisionBlocker[];
  /** The readiness roll-up the plan was derived from. */
  readonly readiness: DoctorStatus;
  /**
   * DEV-2, carried through from the doctor: a requested kind that cannot run at
   * all. Applying every step in the plan will not make it go away, and the plan
   * says so rather than letting `--mode apply` imply otherwise.
   */
  readonly hardFailure?: string;
  /**
   * The DESIGN §6b content hash of the plan's write set — lowercase hex
   * SHA-256, from `computePlanHash` in `@tessera/core`. Read that function's
   * header for what it covers and what it deliberately leaves out; nothing
   * here re-states it, because a second description of a contract is a second
   * contract.
   *
   * OPTIONAL on this type, and required on `HashedProvisionPlan` below, for one
   * reason: `isExecutable` narrows a bare `ProvisionPlan` to THIS type on the
   * presence of `steps` alone. A required field would make that predicate
   * promise every caller a string it never looked for.
   */
  readonly planHash?: string;
}

/**
 * A plan as `plan()` returns it: hashed, because it was assembled with its own
 * steps in hand.
 *
 * An inspectable-only `ProvisionPlan` is never one of these. It carries no
 * `steps`, so there is no write set to take an identity of — `computePlanHash`
 * says as much in its own doc comment, and the way this file keeps that true is
 * that the digest is taken from the step array `plan()` just built, never from
 * a plan object that reached us from somewhere else.
 */
export interface HashedProvisionPlan extends PreflightProvisionPlan {
  readonly planHash: string;
}
