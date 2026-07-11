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
  /**
   * Target scope, when relevant. Accepts EITHER a scoped-app `sys_scope` sys_id
   * (32 lowercase hex) OR a scope name (e.g. `x_acme_app`) — the two are
   * resolved to one canonical `sys_scope` filter once per run (cached and shared
   * across checks), so a name and its sys_id behave identically everywhere.
   *
   * Because the value is interpolated into a ServiceNow encoded query
   * (`sysparm_query`), it must be a plain identifier drawn only from
   * `[A-Za-z0-9_.-]`. Operator characters (`^`, `^OR`, `^NQ`, or the
   * percent-encoded `%5E`) are rejected — fail-closed — to prevent
   * encoded-query injection (SR-1). Values from config / the registry are
   * validated at load time; the query builder re-validates at the edge.
   */
  scope?: string;
  /**
   * Target update set sys_id, when relevant. Interpolated into an encoded query
   * by the `update-set-state` check, so — like {@link scope} — it must be a
   * plain identifier (`[A-Za-z0-9_.-]`); operator characters are rejected at
   * config-load time and re-validated by the query builder (SR-1).
   */
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
