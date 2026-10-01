// Two error classes, because the caller has to do two different things.
//
// The split is the DEV-1 line drawn one stage earlier: "the instance answered
// and what you named is not there" is a statement the user can act on by
// changing the argument, while "the instance did not answer" is an absence of
// evidence and must never be dressed up as one.

/**
 * The subject named on the command line does not exist on the source instance,
 * or exists more than once. The instance ANSWERED — this is a definite fact
 * about the request, so the fix is a different argument, not a retry.
 */
export class ResolutionInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResolutionInputError";
  }
}

/**
 * The read itself could not be completed — 403, 401, 5xx, transport, timeout,
 * or a field the instance does not recognise. Nothing was learned about the
 * subject, so this is a DEV-1 infrastructure fault: exit 3, never a verdict.
 */
export class ResolutionFaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResolutionFaultError";
  }
}
