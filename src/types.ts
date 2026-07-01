/** Outcome of a single preflight check. */
export type CheckStatus = "pass" | "warn" | "fail";

/** Context handed to every check when a preflight run executes. */
export interface PreflightContext {
  /**
   * Base URL of the target ServiceNow instance,
   * e.g. `https://dev12345.service-now.com`.
   */
  instanceUrl?: string;
  /** Arbitrary options forwarded from the CLI or a programmatic caller. */
  options?: Record<string, unknown>;
}

/** Result produced by running a single check. */
export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
}

/** A named, self-describing preflight check. */
export interface Check {
  name: string;
  description: string;
  run(ctx: PreflightContext): CheckResult | Promise<CheckResult>;
}

/** Aggregate outcome of a full preflight run. */
export interface PreflightReport {
  /** `true` when no check returned a `fail` status. */
  ok: boolean;
  results: CheckResult[];
  summary: Record<CheckStatus, number>;
}
