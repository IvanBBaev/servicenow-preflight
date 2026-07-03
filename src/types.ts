import type { SnAuth, SnClient, SnTls } from "./http/client.js";
import type { StateManifest } from "./state/manifest.js";

/** Outcome of a single preflight check. */
export type CheckStatus = "pass" | "warn" | "fail";

/**
 * How a preflight run authenticates to the target instance. Aliased to the
 * client's {@link SnAuth} union (defined once in the transport layer) so the
 * two never drift: Basic, a static OAuth bearer, an API key, or one of the
 * acquired OAuth grant flows.
 */
export type PreflightAuth = SnAuth;

// Re-export the transport-level client-certificate type so callers configuring
// mutual TLS only need to import from `./types.js`.
export type { SnTls };

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
   * Transport-level client certificate for mutual TLS (resolved from env /
   * config; never logged). Composes with `auth` — or identifies the caller on
   * its own when no header credential is set.
   */
  tls?: SnTls;
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
  /** Resolved registry instance name (`dev`, `staging`, …), when multi-instance. */
  instance?: string;
  /**
   * The committed state manifest for the target instance. When present,
   * `atf-run` derives suite `sys_id`s from it, and `test-drift` uses it as the
   * source of truth for what should exist on this instance.
   */
  manifest?: StateManifest;
  /**
   * A second instance's manifest to compare against (the promote **target**).
   * Consumed by the `test-drift` check; absent for a plain single-instance run.
   */
  driftTarget?: StateManifest;
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
