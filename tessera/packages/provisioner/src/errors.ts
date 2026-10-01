/** A write was asked for that this provisioner refuses to perform. */
export class ProvisionRefusedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProvisionRefusedError";
  }
}

/**
 * A planned write failed. Carries how many steps had already succeeded, because
 * after a partial apply the operator's next question is always "what state is
 * the instance in now?" and a bare message cannot answer it.
 */
export class ProvisionApplyError extends Error {
  readonly applied: number;
  readonly total: number;

  constructor(
    message: string,
    detail: { applied: number; total: number; cause?: unknown },
  ) {
    super(message, detail.cause === undefined ? {} : { cause: detail.cause });
    this.name = "ProvisionApplyError";
    this.applied = detail.applied;
    this.total = detail.total;
  }
}

/**
 * Every write reported success and the re-diagnosis did not confirm it. This is
 * the failure that "plan/apply, not blind ensure" (ARCH-2) exists to catch: a
 * 200 on a PATCH is the transport's opinion, not readiness.
 *
 * Two states reach it and the message says which. The re-diagnosis DECIDED and
 * came back not-ready — the instance genuinely disagrees with the write — or it
 * could not decide at all, in which case the write is unconfirmed, not refuted,
 * and there may be nothing on the instance to go looking for. Both throw, which
 * is the fail-closed half; only the first is the instance disagreeing.
 */
export class ProvisionVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProvisionVerificationError";
  }
}
