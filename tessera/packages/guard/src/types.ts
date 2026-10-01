// TargetGuard data shapes (DESIGN §11). Pure data — nothing here performs I/O.
// The guard NEVER gates reads (§11.3): compare/snapshot/capabilities against a
// prod target is the point of the product, so no read type exists in this file.

import type { RunId } from "@tessera/types";

/** §2a topology roles; a classification is pinned per `instance + role` (§11.1). */
export const INSTANCE_ROLES = ["source", "runner", "target"] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

/**
 * §11.1 classification lattice. Runtime source of truth for the closed union —
 * the fail-closed default clause needs the known set at runtime.
 */
export const INSTANCE_CLASSES = [
  "sub-prod", // on the explicit non-prod allowlist → writable
  "prod", // declared prod in config → read-only, no override reaches it
  "prod-suspect", // allowlisted, but a heuristic disagrees → read-only unless acknowledged
  "unknown", // absent from config classification → read-only, fail closed
] as const;
export type InstanceClass = (typeof INSTANCE_CLASSES)[number];

/**
 * Identity of a configured instance. `host` — not `name` — is what the guard
 * matches on: an alias is a config label, the host is the machine that would
 * receive the write (§11.2 "only an explicit human declaration clears an
 * instance"). Aliases are deliberately NOT matched against the allowlist.
 */
export interface InstanceRef {
  /** Config alias, for messages and evidence only. */
  readonly name: string;
  /** Base URL or hostname; normalized before any comparison. */
  readonly host: string;
}

/** What produced a piece of classification evidence (§11.1/§11.2). */
export const GUARD_SIGNAL_KINDS = [
  "allowlist-entry", // explicit non-prod declaration — the ONLY source of writability
  "prod-declaration", // explicit prod declaration in config
  "not-classified", // absent from config classification → unknown, fail closed
  "production-property", // glide.installation.production reads true
  "name-pattern", // no dev/test/uat marker, and/or vanity/customer URL
  "atf-runner-disabled", // sn_atf.runner.enabled reads false (DR-3)
  // A value the probe READ but could not interpret. Downgrade, like the kind
  // it sits beside — never weaker — but it does not claim the row "reads
  // true/false", which is not what the row holds. The instance value is never
  // quoted (see `probeSignals`).
  "production-property-uninterpretable",
  "atf-runner-uninterpretable",
  // Warning only — never clears, never downgrades alone. The name describes
  // the effect, not the transport: it also carries a probe that answered with
  // a value the guard cannot use. The DETAIL says which of the two happened.
  "probe-unreachable",
  "role-policy", // §11.5 role note (e.g. prod source: allowed, discouraged)
] as const;
export type GuardSignalKind = (typeof GUARD_SIGNAL_KINDS)[number];

/**
 * §11.2 downgrade-only: `source-of-truth` assigns the class, `downgrade` can
 * only move an allowlisted instance to `prod-suspect`, `warning` changes
 * nothing. There is deliberately no `upgrade` effect — heuristics never
 * upgrade.
 */
export type GuardSignalEffect = "source-of-truth" | "downgrade" | "warning";

export interface GuardSignal {
  readonly kind: GuardSignalKind;
  readonly effect: GuardSignalEffect;
  /** Human-readable statement of what was observed. */
  readonly detail: string;
}

/** The pinned §11.1 verdict for one `instance + role` pair. */
export interface Classification {
  readonly cls: InstanceClass;
  readonly role: InstanceRole;
  readonly instance: InstanceRef;
  /** Normalized host the class was decided on; `undefined` if unparseable. */
  readonly host: string | undefined;
  /** Allowlist entry + heuristic hits + probe warnings, in that order. */
  readonly evidence: readonly GuardSignal[];
}

/**
 * §11.2 read-only probe output. Every field is optional because "the guard got
 * no usable answer" must be representable: that is a warning, never a
 * clearance and never (alone) a downgrade.
 *
 * An omitted field is deliberately NOT a diagnosis. It tells the guard exactly
 * one thing — no boolean arrived — and nothing about why: a refused read and a
 * property nobody ever set arrive here identically (OPP-1b). Only the probe
 * knows which, and it says so through `unreachable`. So the guard reports the
 * absence and quotes the probe's reason beside it rather than naming a cause
 * it never observed (DEV-1).
 *
 * What a probe does with a value it DID read but cannot interpret is the
 * probe's call, not this contract's: omitting the field is permitted, and so
 * is failing closed to the reading that downgrades. `@tessera/cli` does the
 * latter and explains itself through `unreachable` — an uninterpretable value
 * must not license a write. A probe that knows the value was uninterpretable
 * can also SAY so through the `*Uninterpretable` flags, which downgrade under
 * a kind of their own instead of one naming a boolean the row does not hold.
 * Without a flag the guard is told a boolean or told nothing, and it still
 * cannot tell a cause it did not observe.
 */
export interface InstanceProbe {
  /** `glide.installation.production`; absent = no boolean arrived. */
  readonly productionProperty?: boolean;
  /** `sn_atf.runner.enabled` (DR-3); absent = no boolean arrived. */
  readonly atfRunnerEnabled?: boolean;
  /**
   * The probe read `glide.installation.production` and could not interpret
   * the value. Set, it downgrades under `production-property-uninterpretable`
   * whatever `productionProperty` holds — the fail-closed boolean beside it,
   * the licensing one, or none — and replaces the signal that boolean would
   * raise, so the guard never reports a reading the row does not hold.
   * Absent or `false` = not flagged; any other value is flagged (fail closed).
   */
  readonly productionPropertyUninterpretable?: boolean;
  /**
   * The same, for `sn_atf.runner.enabled` (DR-3): downgrades under
   * `atf-runner-uninterpretable` whatever `atfRunnerEnabled` holds.
   */
  readonly atfRunnerEnabledUninterpretable?: boolean;
  /**
   * The probe's own account of anything the two booleans above cannot carry —
   * a refused read, an absent row, or a value it read and could not interpret.
   * Each becomes a warning signal verbatim, so what gets printed is the
   * probe's account and not a guess made here. A note can therefore sit beside
   * a field that IS set: that is a probe saying its boolean is a fail-closed
   * reading rather than what the row says.
   */
  readonly unreachable?: readonly string[];
}

/**
 * Injected read-only probe (§5 reuse — `sys_properties`/capability reads).
 * The guard owns no transport; the composition root supplies this.
 */
export type ProbeFn = (ref: InstanceRef) => Promise<InstanceProbe>;

/** What the journalled client (ARCH-3) is about to do. */
export interface WriteIntent {
  readonly op: "create" | "update" | "delete" | "execute";
  readonly table: string;
  readonly sysId?: string;
  /** Free-form description carried into the violation detail. */
  readonly description?: string;
}

/** Where an `acknowledge-prod` came from — decides the §9.5 confirmation rule. */
export type OverrideSurface = "cli" | "config" | "mcp";

/**
 * §11.4 audited override. Scope is the current run only; it never rewrites the
 * config classification, and it can only ever cover a `prod-suspect` runner.
 */
export interface AcknowledgeProd {
  /** Mandatory, non-empty — an override without a stated reason is refused. */
  readonly reason: string;
  /** CLI user / MCP client id. */
  readonly actor: string;
  readonly surface: OverrideSurface;
  /**
   * §9.5 out-of-band human confirmation. Required on the MCP surface: a reason
   * field is itself LLM-suppliable and cannot gate an autonomous host alone.
   */
  readonly humanConfirmed?: boolean;
}

/**
 * §4b `kind: "acknowledge-prod"` audit record — the opening entry of the
 * write-ahead intent ledger, flushed BEFORE the first write. §11.4 requires
 * instance, role, class, evidence, reason, actor.
 */
export interface AcknowledgeProdRecord {
  readonly kind: "acknowledge-prod";
  readonly runId: RunId;
  readonly instance: InstanceRef;
  readonly role: InstanceRole;
  readonly cls: InstanceClass;
  readonly evidence: readonly GuardSignal[];
  readonly reason: string;
  readonly actor: string;
  readonly surface: OverrideSurface;
  /** ISO-8601, from the injected clock. */
  readonly at: string;
}

/**
 * Write-ahead audit sink (§4b flush-before-effect). Synchronous on purpose:
 * `assertWrite` is synchronous (§11.6), so the entry must be durable by the
 * time it returns. A throwing sink refuses the write — an override that could
 * not be journalled is not an audited override.
 */
export interface GuardAuditSink {
  record(entry: AcknowledgeProdRecord): void;
}

/**
 * Guard input, built from core config (ARCH-12 pattern — config, not an env
 * flag). Entries are hosts; they are normalized before comparison and matched
 * exactly. Wildcards are deliberately unsupported: a pattern entry could clear
 * a prod instance nobody declared.
 */
export interface GuardConfig {
  /** §11.2 the ONLY source of writability. */
  readonly nonProdAllowlist?: readonly string[];
  /** §11.1 explicit prod declarations — no override reaches these. */
  readonly prodInstances?: readonly string[];
  /** §11.4 override for this run, if the operator passed one. */
  readonly acknowledgeProd?: AcknowledgeProd;
}

export interface TargetGuardOptions {
  /** §11.2 read-only probe. Absent → a warning signal; the allowlist stands. */
  readonly probe?: ProbeFn;
  /** §4b ledger sink. Absent → an override cannot be honoured (fail closed). */
  readonly audit?: GuardAuditSink;
  /**
   * Run the override is scoped to (§11.4 "the current run only"). Absent → an
   * override cannot be honoured: an acknowledgement with no run identity has
   * unbounded scope.
   */
  readonly runId?: RunId;
  /** Injected clock for the ledger entry — keeps the guard deterministic. */
  readonly now?: () => string;
}

/** The §2a instances one pipeline binds; `target` is optional (ARCH-8). */
export interface TopologyRefs {
  readonly source: InstanceRef;
  readonly runner: InstanceRef;
  readonly target?: InstanceRef;
}

/** Pinned classifications for the whole topology (§11.1 step zero). */
export interface ClassifiedTopology {
  readonly source: Classification;
  readonly runner: Classification;
  readonly target?: Classification;
}
