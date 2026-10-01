// EnvironmentDoctor vocabulary (PLAN Phase 1, DESIGN §12.3).
//
// The doctor answers ONE question per precondition, in exactly three states.
// It never writes — so unlike every other Phase-1 stage it may probe any role,
// including `target` (ARCH-8).

import type { ProvisionAction, TestKind } from "@tessera/types";

/**
 * `unknown` is NOT a soft "probably fine": it means the probe could not decide
 * (timeout, insufficient ACL, malformed value) and it is **fail-closed** at the
 * gate — never coerced to `ready`. This mirrors the fail-closed
 * verdict-resolution rule (DESIGN §6a): an absent answer is never a green one.
 */
export const DOCTOR_STATUSES = ["ready", "not-ready", "unknown"] as const;
export type DoctorStatus = (typeof DOCTOR_STATUSES)[number];

/**
 * Whether a precondition participates in the roll-up for THIS request.
 *
 * `deferred` exists so that post-MVP preconditions (browser Test Runner and
 * harness scoped app — DESIGN §12.3 row 1, Phase 8; the authoring channel —
 * WP-D, Phase 4) stay **visible and owned** rather than silently absent, which
 * is what PLAN Phase 0.5 asked for when it refused to leave §10's controls
 * unowned. A deferred finding is reported with the phase that will implement
 * it and is excluded from the roll-up — otherwise every MVP run would report
 * `unknown` forever and the state would carry no information.
 */
export type Applicability = "required" | "deferred";

/** A remedy pointer: the ProvisionPlan action that would fix this finding. */
export interface ProvisionPlanRef {
  /**
   * The action `Provisioner.plan()` would emit. Carried as data, not executed
   * here — remediation only ever runs through plan/apply on the single
   * mutation channel (ARCH-2/ARCH-3). The doctor is read-only, always.
   */
  readonly action: ProvisionAction;
}

export interface DoctorFinding {
  /** Stable id, e.g. "sn_atf.runner.enabled" (DR-3). */
  readonly precondition: string;
  readonly status: DoctorStatus;
  readonly applicability: Applicability;
  /** What the probe observed, or why it could not decide. Never empty. */
  readonly evidence: string;
  /**
   * What this finding needs, when the doctor can name it. ADVISORY: it is a
   * description of the change, NOT a promise that a plan exists for it.
   * `@tessera/provisioner` derives every write from a row it reads for itself
   * at plan time and answers `blocked` when it cannot address one, so a remedy
   * here and a blocker there is a normal outcome rather than a contradiction —
   * `DEFAULT_RECIPES` in `recipes.ts` states the same rule from its side.
   */
  readonly remedy?: ProvisionPlanRef;
}

export interface DoctorReport {
  /** Fail-closed roll-up over the `required` findings only. */
  readonly status: DoctorStatus;
  readonly findings: readonly DoctorFinding[];
  /**
   * True when a `ui` kind was requested against a Test Runner this phase
   * cannot probe. DEV-2 makes that a HARD preflight failure rather than a
   * later hang, so callers must refuse the run outright — a `not-ready`
   * roll-up alone would let a caller decide to proceed.
   */
  readonly hardFailure?: string;
}

export interface DoctorRequest {
  /**
   * Which kinds the run intends to execute. Empty means "readiness only"
   * (`tess doctor` with no run behind it) and asks for the MVP baseline.
   */
  readonly kinds?: readonly TestKind[];
  /**
   * Cancellation. An abort does NOT reject `diagnose` — the outstanding probes
   * resolve `unknown` and the report rolls up fail-closed (ARCH-28/DEV-17: an
   * interrupted answer is never a green one).
   */
  readonly signal?: AbortSignal;
}

/**
 * One probe. Returns everything but `applicability`, which the doctor decides
 * from the request — the same precondition is deferred for a `unit` run and
 * required for a `ui` one (DEV-2).
 */
export interface Precondition {
  readonly id: string;
  /**
   * Kinds that make this precondition required. `undefined` means "always
   * required" (the MVP baseline); an empty array means "never required by kind"
   * — deferred until the phase that implements it.
   */
  readonly requiredForKinds?: readonly TestKind[];
  /** The phase that implements this probe, named when it is deferred. */
  readonly deferredTo?: string;
  probe(signal?: AbortSignal): Promise<Omit<DoctorFinding, "applicability">>;
}
