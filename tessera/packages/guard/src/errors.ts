// GuardViolation (DESIGN §11.3): a refused write is an error surfaced as a
// preflight/verdict failure (GateEvaluator, ARCH-17) — never a silent skip.

import type {
  Classification,
  GuardSignal,
  InstanceClass,
  InstanceRef,
  InstanceRole,
  WriteIntent,
} from "./types.js";

/**
 * Why the guard refused. The first four are hard floors no override can lift
 * (§11.4); `unacknowledged-suspect` is the only refusal `--acknowledge-prod`
 * can clear.
 */
export const GUARD_VIOLATION_REASONS = [
  "unknown-instance", // §11.1 fail-closed default — the fix is config, not a flag
  "declared-prod", // §11.1 declared prod — no override reaches it
  "role-forbids-write", // §11.5/ARCH-8 — only the runner receives pipeline writes
  "runner-not-writable", // §11.5 — a runner classifying prod/unknown is a config error
  "unacknowledged-suspect", // §11.2/§11.4 — needs --acknowledge-prod <reason>
  "override-invalid", // §11.4 — missing reason/actor, or unconfirmed MCP override
  "override-not-journalled", // §11.4 — the ledger entry could not be flushed
  "malformed-classification", // fail closed: the pinned classification is not ours
] as const;
export type GuardViolationReason = (typeof GUARD_VIOLATION_REASONS)[number];

/** Everything a caller needs to render why the write was refused. */
export interface GuardViolationDetail {
  readonly reason: GuardViolationReason;
  readonly instance: InstanceRef;
  readonly role: InstanceRole;
  readonly cls: InstanceClass;
  /** The classification evidence — allowlist entry, heuristic hits, warnings. */
  readonly evidence: readonly GuardSignal[];
  /** The write that was refused; absent for the §11.5 composition-time check. */
  readonly intent?: WriteIntent;
  /** The legitimate human fix — never "pass a flag" for a hard floor. */
  readonly remedy: string;
  /** DESIGN subsections this refusal enforces, for the verdict surface. */
  readonly design: readonly string[];
}

/**
 * Thrown by `assertWrite` / `assertRunnerWritable`. Carries structured detail
 * so the CLI, the MCP surface and the ARCH-17 verdict can all render the same
 * refusal without re-deriving it.
 */
export class GuardViolation extends Error {
  constructor(
    message: string,
    public readonly detail: GuardViolationDetail,
  ) {
    super(message);
    this.name = "GuardViolation";
  }
}

/** Build a violation from a pinned classification (§11.1). */
export function guardViolation(
  c: Classification,
  detail: Omit<GuardViolationDetail, "instance" | "role" | "cls" | "evidence">,
  message: string,
): GuardViolation {
  return new GuardViolation(message, {
    ...detail,
    instance: c.instance,
    role: c.role,
    cls: c.cls,
    evidence: c.evidence,
  });
}

function describeIntent(intent: WriteIntent | undefined): string {
  if (intent === undefined) {
    return "composition-time write authorization";
  }
  const target = intent.sysId
    ? `${intent.table}/${intent.sysId}`
    : intent.table;
  const suffix = intent.description ? ` — ${intent.description}` : "";
  return `${intent.op} ${target}${suffix}`;
}

/**
 * Human-readable refusal report for the CLI / verdict surface. Reads the
 * structured detail only — it derives nothing the error does not already
 * carry.
 */
export function formatGuardViolation(error: GuardViolation): string {
  const d = error.detail;
  const lines = [
    `GuardViolation [${d.reason}]: ${error.message}`,
    `  instance: ${d.instance.name} <${d.instance.host}>`,
    `  role:     ${d.role}`,
    `  class:    ${d.cls}`,
    `  refused:  ${describeIntent(d.intent)}`,
    `  design:   ${d.design.join(", ")}`,
    "  evidence:",
  ];
  for (const signal of d.evidence) {
    lines.push(`    - [${signal.effect}] ${signal.kind}: ${signal.detail}`);
  }
  if (d.evidence.length === 0) {
    lines.push("    - (none recorded)");
  }
  lines.push(`  remedy:   ${d.remedy}`);
  return lines.join("\n");
}
