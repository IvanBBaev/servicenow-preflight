// Two error classes, mirroring `@tessera/resolvers` for the same reason: the
// caller has to do two different things, and the DEV-1 line runs between them.
//
// The read here is a filesystem read rather than an instance read, but the
// distinction survives the change of medium intact — "you pointed me at
// something that is not a tests tree" is a fact about the request, while "the
// registry is there and I could not make sense of it" is an absence of
// evidence about what the repo intends to test.

/**
 * The path named as the tests root is not a directory (or is not readable as
 * one). The fix is a different argument, not a retry.
 */
export class SpecInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SpecInputError";
  }
}

/**
 * The manifest exists but could not be turned into an inventory — unreadable,
 * not JSON, or JSON of the wrong shape.
 *
 * This is deliberately a THROW and not a warning-plus-empty-inventory. An
 * empty inventory is a claim ("the repo intends to test nothing"), and it is
 * the single most dangerous wrong answer this package can give: it turns every
 * impacted artifact into a gap and would read as a coverage catastrophe, or —
 * worse, downstream — as a clean slate. The OPP-1b lesson applies to files as
 * much as to the Table API: a registry that could not be read must not
 * collapse into a registry that says nothing.
 */
export class SpecStoreFaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SpecStoreFaultError";
  }
}
