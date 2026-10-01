// The plan hash — the identity `preflight_apply` applies BY (DESIGN §6b).
//
// Pure by the same contract as `canonical.ts`: no I/O, no clock, no
// randomness. It reuses `canonicalJson` + `sha256Hex` rather than introducing a
// second canonicaliser or a second digest.
//
// ---------------------------------------------------------------------------
// WHAT THE CORPUS SPECIFIES, AND WHAT IT DOES NOT
// ---------------------------------------------------------------------------
//
// §6b says the mechanism exists and says what it must refuse:
//
//   "`preflight_plan` … Returns a `ProvisionPlan` + its content hash."
//   "`preflight_apply` … Applies a previously returned `ProvisionPlan` **by
//    hash**; a stale/unknown hash is refused, never re-planned silently."
//
// USER-JOURNEY §4 repeats it ("applies a plan **by hash**; a stale or unknown
// hash is refused, never silently re-planned") and §4b/ARCH-33 names the
// consumer: a `kind: "infra-write"` ledger record "keyed on the plan hash".
//
// NOTHING specifies what the hash covers. Searched 2026-09-02 across
// `docs/ai/**` for `planHash`, "plan hash", "content hash", "by hash", "stale
// hash", "idempotenc" and "§6b": DESIGN, PLAN, GAP-ANALYSIS, USER-JOURNEY,
// REVIEW, ROADMAP, DECISION-LEDGER and the ADRs describe the mechanism and
// never its input set. The definition below is therefore a CHOICE, not an
// implementation of a written rule, and it is **owed owner ratification**. It
// is recorded here rather than left implicit because it is a contract: every
// hash any operator or ledger record is holding is invalidated by changing it.
//
// ---------------------------------------------------------------------------
// DECISION: the hash covers exactly what `apply()` consumes, in order
// ---------------------------------------------------------------------------
//
// The property that makes the hash useful — and the property the tests pin —
// is: two plans that would execute the same writes hash the SAME, and two
// plans that would execute different writes hash DIFFERENTLY. Over-hashing
// kills the mechanism quietly (every retry reads as "stale", so operators
// learn to bypass the refusal); under-hashing kills it dangerously (a changed
// plan replays as if it were the reviewed one). The set below is the smallest
// one that closes the dangerous direction.
//
// HASHED, per step, in array order:
//   • `write.kind`, `write.table`, `write.sysId`, `write.fields` — this IS the
//     mutation. `provisioner.apply()` calls
//     `writer.updateRecord(step.write.table, step.write.sysId,
//     step.write.fields)` and reads nothing else off the write.
//   • `step.precondition` — the one non-write field that changes what `apply()`
//     DOES: it builds `remedied = new Set(plan.steps.map(s =>
//     s.precondition))` and asserts every remedied precondition re-diagnoses
//     `ready`, throwing `ProvisionVerificationError` otherwise. (It reads two
//     other non-write fields — `plan.actions.length` to word a refusal and
//     `step.action.description` to word a `ProvisionApplyError` — but only into
//     prose, never into a decision or a byte written; that is precisely why
//     they are excluded below.) Two plans with
//     identical writes but different preconditions verify differently, so they
//     are not the same apply. It is a stable identifier (`PRECONDITION_IDS.*`),
//     not prose, so including it introduces no false staleness.
//   • ORDER. Array position is hashed (`canonicalJson` sorts keys, never array
//     elements) because `apply()` writes steps sequentially and reports
//     progress as "N of M"; a partial failure lands in a different place for a
//     different order, so a reordered plan is a different execution.
//
// NOT HASHED, and why each exclusion is safe:
//   • `actions` — a pure projection: `plan()` builds it as
//     `steps.map(step => step.action)`. Hashing it would hash the same facts
//     twice and would drag `description` (below) in with it.
//   • `action.description` and `step.observed` — human prose. `observed` is
//     the probe's `detail` string and `description` is assembled from the
//     table + sys_id already hashed above. Rewording either would invalidate
//     every outstanding plan without changing a single byte written. This is
//     the one place where "what a human reviewed" and "what gets applied" come
//     apart, and it is deliberate: the hash is an execution identity, not a
//     signature over the dry-run report.
//   • `blockers`, `readiness`, `hardFailure` — reported, never executed, and
//     `apply()` says so in its own words: "Blockers do NOT cancel the
//     applicable steps. They were reported at plan time and they stay the
//     operator's problem." A blocker appearing or clearing between plan and
//     apply changes the operator's picture of the instance; it does not change
//     which rows get PATCHed. Hashing them would make the plan stale on
//     instance churn that the plan is indifferent to — the exact failure that
//     makes an apply-by-hash gate dead on arrival.
//
// AMBIGUITIES, flagged rather than decided quietly:
//   1. `precondition` is included on the reading that "the same writes" means
//      "the same `apply()` execution". Under a strictly narrower reading —
//      only the bytes that reach the instance — it is over-hashing. It cannot
//      cause a spurious refusal in practice (a step's precondition is fixed by
//      the recipe that produced it), so the safer reading was taken.
//   2. Excluding `blockers`/`readiness` means an operator can be shown two
//      materially different dry-runs that share a hash. That is correct for a
//      write-identity hash and wrong for a "was this exact report approved"
//      hash. If the owner wants the latter, this is the line to move.
//   3. RESOLVED — delegated decision 2026-09-23: the version tag
//      `tessera-plan/v1` IS embedded, as the first line of the digest's
//      preimage (`planHashPreimage`). Taken now because no persisted hash
//      exists yet, so the change invalidates nothing anyone is holding. A
//      future change to the hashed input set bumps the tag, and that makes an
//      old hash diagnosable as "hashed under another definition" instead of
//      reading as "the instance changed".
//
//      The tag is in the PREIMAGE, not a visible prefix on the output: the
//      digest stays 64 lowercase hex characters, because callers outside this
//      package (the provisioner and CLI suites, and anything printing or
//      comparing the hash) pin exactly that format. What the version
//      therefore does NOT give is reading the version off a hash; to tell
//      which definition produced a hash, recompute it under each.
//
// ---------------------------------------------------------------------------
// WHY THE INPUT IS STRUCTURAL AND NOT `PreflightProvisionPlan`
// ---------------------------------------------------------------------------
//
// The concrete plan type lives in `@tessera/provisioner`, and
// `packages/provisioner/package.json` depends on `@tessera/core`. Naming it
// here would close a cycle, and the type also references `DoctorStatus` from
// `@tessera/doctor`, which core does not depend on either. So the input is
// declared structurally: `PreflightProvisionPlan` satisfies it as-is, with no
// dependency edge added and no layering inversion. No edge was added to make
// the concrete type importable.
//
// The structural shape carries ONLY the hashed fields on purpose. A caller
// passing a richer object (the real plan does carry `action`, `observed`,
// `blockers`) is fine — the projection below is explicit, so extra runtime
// properties cannot leak into the digest.

import { canonicalJson, sha256Hex } from "./canonical.js";

/**
 * The plan-hash definition's version (ambiguity #3 above). Bump it whenever
 * the hashed input set or its projection changes.
 */
export const PLAN_HASH_VERSION = "tessera-plan/v1";

/** The executable half of one planned write — the part that reaches the instance. */
export interface HashableProvisionWrite {
  readonly kind: string;
  readonly table: string;
  readonly sysId: string;
  readonly fields: Readonly<Record<string, string>>;
}

/** One planned step, reduced to what `apply()` consumes. */
export interface HashableProvisionStep {
  readonly precondition: string;
  readonly write: HashableProvisionWrite;
}

/**
 * Structural stand-in for `PreflightProvisionPlan` (see the header for why the
 * concrete type is not imported). An inspectable-only `ProvisionPlan` has no
 * `steps` and is not hashable — it is a description of writes, not a plan.
 */
export interface HashableProvisionPlan {
  readonly steps: readonly HashableProvisionStep[];
}

/**
 * The `planHash` of DESIGN §6b: lowercase hex SHA-256 over the canonical form
 * of the plan's write set. Deterministic — same writes in, same digest out,
 * in any process, with no clock or randomness involved.
 *
 * A plan with no steps is a legal plan (applying it is a no-op) and gets a real
 * digest; it is not a special case and does not return the empty string.
 */
export function computePlanHash(plan: HashableProvisionPlan): string {
  return sha256Hex(planHashPreimage(plan));
}

/**
 * The exact string `computePlanHash` digests: `PLAN_HASH_VERSION`, a newline,
 * then the canonical JSON of the projected steps. Exported so the version tag
 * can be pinned by a test and a hash can be re-derived by hand.
 */
export function planHashPreimage(plan: HashableProvisionPlan): string {
  // Explicit projection, not `canonicalJson(plan.steps)`. The real plan objects
  // carry `action` and `observed` alongside these fields, and passing them
  // through wholesale would silently widen the contract this file exists to
  // pin down.
  const hashed = plan.steps.map((step) => ({
    precondition: step.precondition,
    write: {
      kind: step.write.kind,
      table: step.write.table,
      sysId: step.write.sysId,
      fields: step.write.fields,
    },
  }));
  return `${PLAN_HASH_VERSION}\n${canonicalJson(hashed)}`;
}
