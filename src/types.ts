import type { SnClient } from "./http/client.js";

/** Outcome of a single preflight check. */
export type CheckStatus = "pass" | "warn" | "fail";

/** How a preflight run authenticates to the target instance. */
export type PreflightAuth =
  | { kind: "basic"; user: string; pass: string }
  | { kind: "oauth"; token: string };

/** Check selection: run `only` these, or run all except `skip` (by name). */
export interface CheckSelection {
  only?: string[];
  skip?: string[];
}

/** Context handed to every check when a preflight run executes. */
export interface PreflightContext {
  /**
   * Base URL of the target ServiceNow instance,
   * e.g. `https://dev12345.service-now.com`.
   */
  instanceUrl?: string;
  /** How the run authenticates (resolved from env / config; never logged). */
  auth?: PreflightAuth;
  /**
   * The injected ServiceNow REST client. Checks call `ctx.http` — they must
   * NEVER use `fetch` directly. Always present at run time (the CLI and
   * `runPreflight` supply a real client; tests supply a fake).
   */
  http: SnClient;
  /** Target scope (scoped-app sys_id or scope name), when relevant. */
  scope?: string;
  /** Target update set sys_id, when relevant. */
  updateSetId?: string;
  /** Check selection filter (only / skip by check name). */
  select?: CheckSelection;
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
