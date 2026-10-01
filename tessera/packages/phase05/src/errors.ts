// TEMPORARY — PLAN Phase 0.5 walking skeleton. This whole package is the
// named, temporary exception to ARCH-1 ("adapters wired by hand are acceptable
// here as a named, temporary exception to ARCH-1 — deleted when
// `resolvePipeline(config)` lands with Phase 1+"). See README.md.
//
// Error taxonomy. DEV-1 draws one line and only one: a Runner RESOLVES with a
// RunResult for anything that is evidence about a test, and REJECTS only on an
// infrastructure fault where no outcome evidence exists. Every rejection this
// package produces is a `SkeletonInfrastructureError` (or a subclass) so that
// line is visible in the type, not just in prose.

/** Base class for every fault this package raises deliberately. */
export class SkeletonError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * DEV-1 reject side: the instance, the transport or the adapter itself failed
 * in a way that leaves NO evidence about any test. Never used for a red test.
 */
export class SkeletonInfrastructureError extends SkeletonError {}

/** ARCH-28: `ctx.signal` fired. No outcome evidence exists, so this rejects. */
export class SkeletonCancelledError extends SkeletonInfrastructureError {}

/**
 * ARCH-2/ARCH-13 clean refusal: `apply()` was handed an action the Phase-0.5
 * Provisioner deliberately does not perform. Refusing loudly beats a silent
 * no-op that would let a run proceed against unprovisioned infra.
 */
export class SkeletonUnsupportedActionError extends SkeletonError {}
