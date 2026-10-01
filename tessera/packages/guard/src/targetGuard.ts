// TargetGuard (DESIGN §11) — the contract that no mutating call reaches an
// instance that has not been explicitly cleared for writes.
//
// §11.1 classify every `instance + role` BEFORE the first write and pin it.
// §11.2 the config allowlist is the only source of writability; heuristics
//       downgrade, never upgrade.
// §11.3 enforcement lives on the single mutation channel (ARCH-3) — the
//       journalled client calls `assertWrite` on EVERY mutation. Reads are
//       exempt: there is no read entry point in this file at all.
// §11.4 `acknowledge-prod` is audited, run-scoped, and can only ever cover a
//       `prod-suspect` runner.
// §11.5 per-role behaviour; a prod/unknown runner fails composition.

import {
  guardViolation,
  type GuardViolation,
  type GuardViolationReason,
} from "./errors.js";
import {
  nameHeuristicReasons,
  normalizeInstanceHost,
  probeFailureSignals,
  probeSignals,
} from "./heuristics.js";
import {
  INSTANCE_CLASSES,
  INSTANCE_ROLES,
  type AcknowledgeProd,
  type AcknowledgeProdRecord,
  type Classification,
  type ClassifiedTopology,
  type GuardConfig,
  type GuardSignal,
  type InstanceClass,
  type InstanceRef,
  type InstanceRole,
  type TargetGuardOptions,
  type TopologyRefs,
  type WriteIntent,
} from "./types.js";

export interface TargetGuard {
  /**
   * Step zero (§11.1): resolvePipeline calls this for every configured
   * instance+role before any mutating call. The result is pinned — a second
   * call for the same pair returns the same frozen object, so a class cannot
   * drift mid-run.
   */
  classify(ref: InstanceRef, role: InstanceRole): Promise<Classification>;
  /** Classify a whole §2a topology in one step; `target` is optional (ARCH-8). */
  classifyTopology(refs: TopologyRefs): Promise<ClassifiedTopology>;
  /**
   * Called by the write-journalled client (ARCH-3) on EVERY mutation. Throws
   * GuardViolation unless the classification is a `sub-prod` runner, or a
   * journalled acknowledge-prod (§11.4) covers a `prod-suspect` runner. Never
   * gates reads.
   */
  assertWrite(c: Classification, intent: WriteIntent): void;
  /**
   * §11.5 composition-time gate: the runner classification must be writable
   * before any adapter is constructed — not at the first write.
   */
  assertRunnerWritable(c: Classification): void;
  /** Pinned classifications so far — part of the run record (§11.6). */
  pinned(): readonly Classification[];
  /** Journalled §11.4 overrides — the verdict must surface these (ARCH-17). */
  acknowledgements(): readonly AcknowledgeProdRecord[];
}

const REMEDY: Readonly<Record<GuardViolationReason, string>> = {
  "unknown-instance":
    "add the instance to the non-prod allowlist in config — no runtime option upgrades `unknown` (§11.1)",
  "declared-prod":
    "none: a declared-prod instance is never writable; move the write to an allowlisted sub-prod runner (§11.4 hard floor)",
  "role-forbids-write":
    "bind pipeline writes to the runner role — source is read-only and target gets a read-only readiness probe (§11.5/ARCH-8)",
  "runner-not-writable":
    "point `runner` at an allowlisted sub-prod instance — no override lifts a prod/unknown runner (§11.5)",
  "unacknowledged-suspect":
    "investigate the heuristic and re-confirm the allowlist entry, or pass --acknowledge-prod <reason> for this run (§11.4)",
  "override-invalid":
    "supply a non-empty reason and actor; an MCP-sourced override also needs the §9.5 out-of-band human confirmation",
  "override-not-journalled":
    "give the guard a runId and a write-ahead intent-ledger sink — an override that cannot be journalled is not an audited override (§11.4/§4b)",
  "malformed-classification":
    "pass the Classification returned by this guard's classify() — a hand-built or foreign classification is refused (§11.1)",
};

function isKnownClass(value: unknown): value is InstanceClass {
  return INSTANCE_CLASSES.includes(value as InstanceClass);
}

function isKnownRole(value: unknown): value is InstanceRole {
  return INSTANCE_ROLES.includes(value as InstanceRole);
}

function freezeClassification(c: Classification): Classification {
  Object.freeze(c.evidence);
  return Object.freeze(c);
}

/** §11.4 — what makes an override usable at all. Undefined means "valid". */
function overrideProblem(ack: AcknowledgeProd): string | undefined {
  if (typeof ack !== "object") {
    return "override is not a valid acknowledge-prod record";
  }
  if (typeof ack.reason !== "string" || ack.reason.trim() === "") {
    return "acknowledge-prod requires a mandatory non-empty reason";
  }
  if (typeof ack.actor !== "string" || ack.actor.trim() === "") {
    return "acknowledge-prod must name the actor that passed it";
  }
  if (
    ack.surface !== "cli" &&
    ack.surface !== "config" &&
    ack.surface !== "mcp"
  ) {
    // Fail closed: an unrecognised surface cannot be held to a known rule.
    return `unrecognised override surface "${String(ack.surface)}"`;
  }
  if (ack.surface === "mcp" && ack.humanConfirmed !== true) {
    return "an MCP-sourced override needs the §9.5 out-of-band human confirmation — a reason field is LLM-suppliable";
  }
  return undefined;
}

export function createTargetGuard(
  config: GuardConfig = {},
  options: TargetGuardOptions = {},
): TargetGuard {
  const allowlist = new Set(
    (config.nonProdAllowlist ?? [])
      .map(normalizeInstanceHost)
      .filter((host): host is string => host !== undefined),
  );
  // Delegated decision 2026-09-26: normalizeInstanceHost now refuses a trailing
  // dot (resolveHost parity), which is fail-closed for a ref and an allowlist
  // entry but would be fail-OPEN for a prod-list entry — dropping
  // "prod.service-now.com." would let that host classify sub-prod when it is
  // allowlisted. Membership in the prod list can only make a host stricter, so
  // an entry the strict reader refuses is retried once with the DNS-root dot
  // (before an optional port and bare "/") removed.
  const prodList = new Set(
    (config.prodInstances ?? [])
      .map(
        (entry) =>
          normalizeInstanceHost(entry) ??
          (typeof entry === "string"
            ? normalizeInstanceHost(
                entry.trim().replace(/\.(?=(?::\d{1,5})?\/?$)/, ""),
              )
            : undefined),
      )
      .filter((host): host is string => host !== undefined),
  );
  const clock = options.now ?? (() => new Date().toISOString());

  // "Pinned for the run" (§11.1): the promise is memoized, so concurrent
  // callers share one probe and one immutable result per instance+role.
  const inFlight = new Map<string, Promise<Classification>>();
  const resolved = new Map<string, Classification>();
  // Only classifications this guard issued may authorize a write — a caller
  // cannot hand-build `{ cls: "sub-prod" }` and bypass the check.
  const issued = new WeakSet<Classification>();
  const journalled = new Set<string>();
  const ackRecords: AcknowledgeProdRecord[] = [];

  const key = (
    host: string | undefined,
    ref: InstanceRef,
    role: InstanceRole,
  ) => `${host ?? `raw:${ref.host}`}|${role}`;

  function violation(
    c: Classification,
    reason: GuardViolationReason,
    message: string,
    design: readonly string[],
    intent?: WriteIntent,
  ): GuardViolation {
    return guardViolation(
      c,
      { reason, remedy: REMEDY[reason], design, ...(intent ? { intent } : {}) },
      message,
    );
  }

  /** §11.2 heuristics — allowlisted instances only. */
  async function heuristicSignals(ref: InstanceRef): Promise<GuardSignal[]> {
    const host = normalizeInstanceHost(ref.host);
    const signals: GuardSignal[] = [];
    if (host !== undefined) {
      const reasons = nameHeuristicReasons(host);
      if (reasons.length > 0) {
        signals.push({
          kind: "name-pattern",
          effect: "downgrade",
          detail: reasons.join("; "),
        });
      }
    }
    if (options.probe === undefined) {
      return [
        ...signals,
        ...probeFailureSignals(
          "no read-only probe configured — instance properties were not checked",
        ),
      ];
    }
    try {
      return [...signals, ...probeSignals(await options.probe(ref))];
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return [
        ...signals,
        ...probeFailureSignals(`read-only probe failed: ${cause}`),
      ];
    }
  }

  function rolePolicySignals(
    role: InstanceRole,
    cls: InstanceClass,
  ): GuardSignal[] {
    if (role === "target") {
      return [
        {
          kind: "role-policy",
          effect: "warning",
          detail:
            "target is read-only: compare/snapshot readiness probe only (§11.5/ARCH-8)",
        },
      ];
    }
    if (role === "source" && (cls === "prod" || cls === "prod-suspect")) {
      return [
        {
          kind: "role-policy",
          effect: "warning",
          detail:
            "prod source is allowed but discouraged — the pipeline only reads from source (§11.5)",
        },
      ];
    }
    if (role === "runner" && (cls === "prod" || cls === "unknown")) {
      return [
        {
          kind: "role-policy",
          effect: "warning",
          detail:
            "runner can never be prod/unknown — hard config error, no override lifts it (§11.5)",
        },
      ];
    }
    return [];
  }

  async function computeClassification(
    ref: InstanceRef,
    role: InstanceRole,
  ): Promise<Classification> {
    const host = normalizeInstanceHost(ref.host);
    const evidence: GuardSignal[] = [];
    let cls: InstanceClass;

    if (host === undefined) {
      // Fail closed: an identity we cannot read is never matched to config.
      cls = "unknown";
      evidence.push({
        kind: "not-classified",
        effect: "source-of-truth",
        detail: `instance host ${JSON.stringify(ref.host)} is empty or unparseable — it cannot be matched against the classification config`,
      });
    } else if (prodList.has(host)) {
      cls = "prod";
      evidence.push({
        kind: "prod-declaration",
        effect: "source-of-truth",
        detail: `"${host}" is declared prod in config`,
      });
      if (allowlist.has(host)) {
        // Ambiguous config: the fail-closed reading is that prod wins.
        evidence.push({
          kind: "allowlist-entry",
          effect: "warning",
          detail: `"${host}" is also on the non-prod allowlist — the prod declaration wins (fail closed)`,
        });
      }
    } else if (allowlist.has(host)) {
      evidence.push({
        kind: "allowlist-entry",
        effect: "source-of-truth",
        detail: `"${host}" is on the explicit non-prod allowlist`,
      });
      evidence.push(...(await heuristicSignals(ref)));
      // §11.2 downgrade-only: any downgrade signal moves an allowlisted
      // instance to prod-suspect; nothing here can move it the other way.
      cls = evidence.some((signal) => signal.effect === "downgrade")
        ? "prod-suspect"
        : "sub-prod";
    } else {
      cls = "unknown";
      evidence.push({
        kind: "not-classified",
        effect: "source-of-truth",
        detail: `"${host}" is absent from the config classification — the fix is configuration, not a flag (§11.1)`,
      });
    }

    evidence.push(...rolePolicySignals(role, cls));
    return freezeClassification({
      cls,
      role,
      instance: Object.freeze({ ...ref }),
      host,
      evidence,
    });
  }

  function classify(
    ref: InstanceRef,
    role: InstanceRole,
  ): Promise<Classification> {
    const k = key(normalizeInstanceHost(ref.host), ref, role);
    const pending = inFlight.get(k);
    if (pending !== undefined) {
      return pending;
    }
    const promise = computeClassification(ref, role).then((c) => {
      issued.add(c);
      resolved.set(k, c);
      return c;
    });
    inFlight.set(k, promise);
    return promise;
  }

  /** Reject anything that is not a classification this guard pinned. */
  function assertPinned(c: Classification, intent?: WriteIntent): void {
    // Widened, not asserted: JS callers can hand us anything, and a violation
    // must still be renderable rather than turning into a TypeError.
    const candidate: Partial<Classification> | null | undefined = c;
    const shaped =
      candidate !== null &&
      candidate !== undefined &&
      typeof candidate === "object" &&
      isKnownClass(candidate.cls) &&
      isKnownRole(candidate.role) &&
      Array.isArray(candidate.evidence);
    // Nothing readable came off the input, so `instance` says `<unclassified>`
    // out loud. `role` cannot: `InstanceRole` is a closed three-value union, so
    // the placeholder below is a value the renderer prints exactly like an
    // observed role. Rather than let one fabricated field sit unmarked beside
    // two marked ones, the substitution is recorded as evidence — a reader of
    // `formatGuardViolation` can then see which of these fields were read off
    // the classification and which were invented to keep it renderable.
    const roleWasRead = isKnownRole(candidate?.role);
    const safe: Classification = shaped
      ? c
      : {
          cls: "unknown", // fail closed: an unreadable classification is not safe
          role: roleWasRead ? candidate.role : "target",
          instance: { name: "<unclassified>", host: "<unclassified>" },
          host: undefined,
          evidence: roleWasRead
            ? []
            : [
                {
                  kind: "not-classified",
                  effect: "warning",
                  detail:
                    'no role could be read off this classification; the reported role "target" is a placeholder, not an observation',
                },
              ],
        };
    if (!shaped || !issued.has(c)) {
      throw violation(
        safe,
        "malformed-classification",
        "write refused: the classification was not issued by this guard (§11.1 pinned classification)",
        ["§11.1"],
        intent,
      );
    }
  }

  /** §11.4 — honour the override, or explain why it cannot be honoured. */
  function authorizeSuspect(
    c: Classification,
    design: readonly string[],
    intent?: WriteIntent,
  ): void {
    const ack = config.acknowledgeProd;
    if (ack === undefined) {
      throw violation(
        c,
        "unacknowledged-suspect",
        `write refused: "${c.instance.host}" is allowlisted but a heuristic disagrees (prod-suspect) and no acknowledge-prod covers this run`,
        design,
        intent,
      );
    }
    const problem = overrideProblem(ack);
    if (problem !== undefined) {
      throw violation(
        c,
        "override-invalid",
        `write refused: acknowledge-prod is not usable — ${problem}`,
        [...design, "§9.5"],
        intent,
      );
    }
    journalOverride(c, ack, design, intent);
  }

  /**
   * §11.4/§4b: the override is journalled BEFORE the first write, as the
   * opening entry of the write-ahead intent ledger. Once per instance+role.
   */
  function journalOverride(
    c: Classification,
    ack: AcknowledgeProd,
    design: readonly string[],
    intent?: WriteIntent,
  ): void {
    const k = key(c.host, c.instance, c.role);
    if (journalled.has(k)) {
      return;
    }
    const runId = options.runId;
    if (runId === undefined || runId === "" || options.audit === undefined) {
      throw violation(
        c,
        "override-not-journalled",
        "write refused: acknowledge-prod cannot be journalled — the override is run-scoped and must reach the write-ahead intent ledger before the first write",
        [...design, "§4b"],
        intent,
      );
    }
    const record: AcknowledgeProdRecord = {
      kind: "acknowledge-prod",
      runId,
      instance: c.instance,
      role: c.role,
      cls: c.cls,
      evidence: c.evidence,
      reason: ack.reason,
      actor: ack.actor,
      surface: ack.surface,
      at: clock(),
    };
    try {
      options.audit.record(record);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw violation(
        c,
        "override-not-journalled",
        `write refused: the acknowledge-prod ledger entry could not be flushed — ${cause}`,
        [...design, "§4b"],
        intent,
      );
    }
    journalled.add(k);
    ackRecords.push(record);
  }

  function assertWrite(c: Classification, intent: WriteIntent): void {
    assertPinned(c, intent);
    // ARCH-8: pipeline writes bind to the runner. Checked first, so a
    // sub-prod target still refuses — a hard floor no override lifts.
    if (c.role !== "runner") {
      throw violation(
        c,
        "role-forbids-write",
        `write refused: the ${c.role} role never receives pipeline writes (ARCH-8)`,
        ["§11.5", "ARCH-8"],
        intent,
      );
    }
    switch (c.cls) {
      case "sub-prod":
        return; // the only clean write path (§11.1)
      case "unknown":
        throw violation(
          c,
          "unknown-instance",
          `write refused: "${c.instance.host}" is not classified in config — unknown is read-only and no flag upgrades it (§11.1)`,
          ["§11.1"],
          intent,
        );
      case "prod":
        throw violation(
          c,
          "declared-prod",
          `write refused: "${c.instance.host}" is declared prod — no override reaches it (§11.4)`,
          ["§11.1", "§11.4"],
          intent,
        );
      case "prod-suspect":
        authorizeSuspect(c, ["§11.2", "§11.4"], intent);
        return;
      default:
        // Fail closed on a class this build does not know.
        throw violation(
          c,
          "unknown-instance",
          `write refused: unrecognised instance class ${JSON.stringify(c.cls)} — fail closed (§11.1)`,
          ["§11.1"],
          intent,
        );
    }
  }

  function assertRunnerWritable(c: Classification): void {
    assertPinned(c);
    if (c.role !== "runner") {
      throw violation(
        c,
        "role-forbids-write",
        `composition refused: assertRunnerWritable expects the runner classification, got "${c.role}"`,
        ["§11.5"],
      );
    }
    if (c.cls === "prod" || c.cls === "unknown") {
      throw violation(
        c,
        "runner-not-writable",
        `composition refused: the runner classifies "${c.cls}" — a runner can never be prod/unknown and no override lifts it (§11.5)`,
        ["§11.5"],
      );
    }
    if (c.cls === "prod-suspect") {
      authorizeSuspect(c, ["§11.4", "§11.5"]);
    }
    // sub-prod: nothing to do — the composition root may build the adapters.
  }

  return {
    classify,
    async classifyTopology(refs) {
      const [source, runner, target] = await Promise.all([
        classify(refs.source, "source"),
        classify(refs.runner, "runner"),
        refs.target === undefined
          ? Promise.resolve(undefined)
          : classify(refs.target, "target"),
      ]);
      return target === undefined
        ? { source, runner }
        : { source, runner, target };
    },
    assertWrite,
    assertRunnerWritable,
    pinned: () => [...resolved.values()],
    acknowledgements: () => [...ackRecords],
  };
}
