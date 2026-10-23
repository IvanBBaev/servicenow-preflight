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
   * Cancels the current check. The runner sets it for every check — it aborts
   * when the check's `timeoutMs` budget runs out or the whole run is aborted —
   * and `http` is already bound to it. Checks doing long CPU work can poll
   * `signal.aborted`.
   */
  signal?: AbortSignal;
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
  /**
   * Per-check options, keyed by check name. {@link runPreflight} shallow-merges
   * the entry for a check over {@link options} and hands that check the merged
   * `options`; every other check sees `options` unchanged.
   */
  checkOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Where a finding lives: a record (table + sys_id + field, optionally a line in
 * a script) or, for subjects that are not a single record, a logical id
 * (`"scope/slug"`, `"instance"`, `"app:<scope>"`).
 */
export interface FindingLocation {
  /** Table of the offending record, e.g. `"sys_script_include"`. */
  table?: string;
  /** `sys_id` of the offending record. */
  sysId?: string;
  /** Display label of the record (`name`, falling back to the sys_id). */
  recordName?: string;
  /** Field holding the offending value, e.g. `"script"`. */
  field?: string;
  /** 1-based line within `field`, for script findings. */
  line?: number;
  /** Identity of a subject that is not one record. */
  logicalId?: string;
}

/** One record-level finding behind a check's verdict. */
export interface Finding {
  /** Stable fingerprint, `"f1:"` plus 16 hex digits (see `findingId`). */
  id: string;
  /** Check-local kind, e.g. `"pattern:gs.log"` or `"acl-missing:create"`. */
  kind: string;
  /** One line; never echoes secrets or matched source text. */
  message: string;
  /** Verdict of this finding; defaults to the row's status. */
  status?: CheckStatus;
  location?: FindingLocation;
}

/**
 * Who produced a result row: a check (`"check"`, the default when absent), the
 * runner itself (`"runner"`: the duplicate-name and empty-selection guards) or
 * the baseline (`"baseline"`: expired-entry notices).
 */
export type CheckResultKind = "check" | "runner" | "baseline";

/** Result produced by running a single check. */
export interface CheckResult {
  name: string;
  status: CheckStatus;
  message: string;
  /** Set on synthetic rows only; absent means `"check"`. */
  kind?: CheckResultKind;
  /**
   * The record-level findings behind the verdict, when the check reports them.
   * Omitted when there are none; capped at 500 by the runner.
   */
  findings?: Finding[];
  /** How many findings were dropped by the cap. */
  findingsTruncated?: number;
}

/**
 * Whether a check is designed to block a release. `"blocker"` checks may
 * return `fail`; `"advisory"` checks return `warn` at most on a finding (by
 * design, not by policy).
 */
export type CheckSeverity = "blocker" | "advisory";

/**
 * Optional, static metadata a check declares about itself. Consumed by the
 * catalogue helpers (`describeChecks`), the SARIF reporter's `rules[]`
 * and the `list` / `explain` CLI subcommands. Every field is optional, so a
 * check without metadata keeps working everywhere.
 */
export interface CheckMeta {
  /** Certification rule id from ci/certification/CHECKLIST.md ("1.1"); absent for operational checks. */
  rule?: string;
  /** "blocker" checks may return fail; "advisory" checks return warn at most (by design, not by policy). */
  severity?: CheckSeverity;
  /** Tables the check reads (used for offline eligibility, docs, SARIF). */
  tables?: readonly string[];
  /** One paragraph, plain text: what to change on the instance to make the check pass. */
  remediation?: string;
  /** Catalogue wording for each verdict. */
  verdicts?: { pass: string; warn: string; fail: string };
  /**
   * The docs-site board tag: the configuration the check requires
   * ("scope", "updateSetId", …), or "ALWAYS" when it runs unconditionally.
   */
  requires?: string;
  /** One-sentence catalogue summary for the docs site; falls back to `description`. */
  summary?: string;
  /** Eligible to run against an offline update-set export. Default false. */
  offline?: boolean;
  /** Must run alone after the parallel batch. Default false. */
  serial?: boolean;
}

/** A named, self-describing preflight check. */
export interface Check {
  name: string;
  description: string;
  /** Optional static metadata (rule id, severity, tables, remediation, verdict wording). */
  meta?: CheckMeta;
  run(ctx: PreflightContext): CheckResult | Promise<CheckResult>;
}

/** Aggregate outcome of a full preflight run. */
export interface PreflightReport {
  /** `true` when no check returned a `fail` status. */
  ok: boolean;
  results: CheckResult[];
  summary: Record<CheckStatus, number>;
}
