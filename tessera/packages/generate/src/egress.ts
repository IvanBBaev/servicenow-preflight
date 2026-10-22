// DESIGN §10.2/§10.3 — classification before egress, fail-closed.
//
// The `generate` stage is the one place instance data leaves the machine: the
// impact graph is rendered into a prompt and a hosted provider POSTs it to a
// third party (§10.1). This file decides what of that graph may go, BEFORE the
// prompt is assembled, and marks the result so a hosted adapter can refuse
// anything that did not come through here.
//
// The policy model, stated once:
//
//   * TABLES decide whether an artifact may be sent at all. Deny wins over
//     allow; a table no allow rule names is denied (fail-closed). A denied
//     artifact is never dropped quietly from the prompt — the WHOLE generation
//     is refused with an `EgressRefusedError` that counts what was withheld
//     (QA-9: never a silent skip). The caller may fall back to the template
//     provider, which sends nothing.
//   * FIELD CLASSES decide what of an allowed artifact's text may be sent. The
//     identity (`table`, `sys_id`) always goes — it is the join key and nothing
//     can be generated without it — and is held to an identity shape, so it
//     cannot carry prose. Every other field belongs to a closed class; a class
//     the policy does not allow, or explicitly denies, is replaced by a stable
//     per-run placeholder (`«REDACTED:name:1»`). Placeholders are never
//     re-hydrated: what was withheld does not round-trip.
//   * Allowed free text still passes a built-in pattern redaction (credential
//     assignments, bearer/basic/JWT tokens, API-key shapes, private-key blocks,
//     email addresses). Honesty per §10.3: pattern redaction is best-effort;
//     classification is the primary control and the patterns are the backstop.
//   * CONSENT is explicit (§10.4): a policy without `consent: true` refuses.
//
// The output is a `RenderedPrompt` that is frozen and recorded in a
// module-private WeakSet — the same provenance idea as `@tessera/types`'
// `untrusted()`. `isEgressCleared` answers "did this exact object come out of
// the classifier?", and a copy, a spread or a hand-built prompt answers no.
// `createAnthropicProvider` refuses any prompt that answers no, so a caller that
// skips this file sends nothing. The mark is a runtime check, not a type: a
// cast cannot defeat it, and a mutation cannot change a frozen prompt after it
// was cleared.
//
// No instance-derived byte reaches a message thrown from here. Errors carry
// counts and the names of the policy's own sections; the withheld identities
// travel as a structured property, never in `message` (`./errors.ts`).

import type { ImpactGraph, TargetArtifactRef, TestKind } from "@tessera/types";

import { GenerateInputError } from "./errors.js";
import { buildGenerationPrompt, renderPrompt } from "./prompt.js";
import type { RenderedPrompt } from "./prompt.js";

/**
 * The classes of non-identity text a generation prompt carries.
 *
 * - `name`     — an artifact's display name: prose somebody typed on the instance.
 * - `reason`   — why static analysis could not trace an artifact (QA-9); the
 *                analyzer quotes instance names and scope labels into it.
 * - `relation` — an edge's `via` and `confidence`: analyzer vocabulary.
 * - `plan`     — a demanded spec's id and kind, from the repository manifest.
 */
export const EGRESS_FIELD_CLASSES = [
  "name",
  "reason",
  "relation",
  "plan",
] as const;
export type EgressFieldClass = (typeof EGRESS_FIELD_CLASSES)[number];

/** The built-in pattern categories (§10.3). Counted, never quoted. */
export const EGRESS_PATTERN_CATEGORIES = [
  "private-key",
  "credential",
  "token",
  "email",
] as const;
export type EgressPatternCategory = (typeof EGRESS_PATTERN_CATEGORIES)[number];

export type EgressRedactionCategory = EgressFieldClass | EgressPatternCategory;

/**
 * The §2 code tables — the "sane default allow set" §10.2 names, and nothing
 * else. A table outside it (a transform map, a custom `u_` table) has to be
 * allowed by name in the operator's policy.
 */
export const DEFAULT_EGRESS_TABLES: readonly string[] = [
  "sys_script",
  "sys_script_include",
  "sys_script_client",
  "sys_ui_action",
  "sys_ui_policy",
  "sys_security_acl",
  "sysauto_script",
  "sys_ws_operation",
  "sys_transform_script",
];

export interface EgressRuleSet {
  readonly tables?: readonly string[];
  readonly fields?: readonly EgressFieldClass[];
}

/**
 * The egress policy — the §10.2 `EgressPolicy` slice this package enforces.
 * `scopes`, `provider`, `zeroDataRetention` and `redactPatterns` are not here
 * yet: an artifact reference carries no scope, and the other three belong to
 * the instance-profile wiring that has not landed.
 */
export interface EgressPolicy {
  /** §10.4: explicit opt-in. Anything but `true` refuses. */
  readonly consent: boolean;
  /** Unmatched ⇒ denied. */
  readonly allow: EgressRuleSet;
  /** Wins over `allow`. */
  readonly deny?: EgressRuleSet;
}

/**
 * Fail-closed defaults: no consent, the §2 code tables, and only the two field
 * classes this repository authors (`relation`, `plan`). Names and reasons —
 * instance prose — are redacted unless the operator allows them.
 */
export const DEFAULT_EGRESS_POLICY: EgressPolicy = Object.freeze({
  consent: false,
  allow: Object.freeze({
    tables: DEFAULT_EGRESS_TABLES,
    fields: Object.freeze(["relation", "plan"] as const),
  }),
});

/** Counts only — the report must not become a second copy of the data (§10.4). */
export interface EgressReport {
  /** Distinct artifacts classified and allowed. */
  readonly artifacts: number;
  readonly redactions: Readonly<Record<EgressRedactionCategory, number>>;
}

export interface EgressClearance {
  /** Frozen, and recognised by `isEgressCleared`. */
  readonly prompt: RenderedPrompt;
  readonly report: EgressReport;
}

/**
 * An artifact the policy withheld, by identity only. A `malformed-identity`
 * entry carries empty strings: an identity that is not one may be prose.
 */
export interface WithheldArtifact {
  readonly table: string;
  readonly sysId: string;
  readonly rule: "denied" | "unmatched" | "malformed-identity";
}

/**
 * The policy refused this egress. A `GenerateInputError`: the fix is a
 * different policy or the template provider, not a retry.
 */
export class EgressRefusedError extends GenerateInputError {
  readonly withheld: readonly WithheldArtifact[];

  constructor(message: string, withheld: readonly WithheldArtifact[] = []) {
    super(message);
    this.name = "EgressRefusedError";
    this.withheld = withheld;
  }
}

const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;
const TABLE_PATTERN = /^[a-z0-9_]{1,80}$/i;

function normalizeTable(table: string): string {
  return table.trim().toLowerCase();
}

function tableList(
  value: unknown,
  section: string,
): ReadonlySet<string> | undefined {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) return undefined;
  const tables = new Set<string>();
  value.forEach((entry: unknown, index) => {
    if (typeof entry !== "string" || !TABLE_PATTERN.test(entry.trim())) {
      throw new GenerateInputError(
        `entry #${index + 1} in the egress policy's ${section}.tables is not a table name ([a-z0-9_], at most 80 characters)`,
      );
    }
    tables.add(normalizeTable(entry));
  });
  return tables;
}

function fieldList(
  value: unknown,
  section: string,
): ReadonlySet<EgressFieldClass> | undefined {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) return undefined;
  const fields = new Set<EgressFieldClass>();
  value.forEach((entry: unknown, index) => {
    const known = EGRESS_FIELD_CLASSES.find((field) => field === entry);
    if (known === undefined) {
      // Refused rather than ignored: a typo in `deny` that was skipped would
      // send exactly the class the operator meant to withhold.
      throw new GenerateInputError(
        `entry #${index + 1} in the egress policy's ${section}.fields is not a known field class (known: ${EGRESS_FIELD_CLASSES.join(", ")})`,
      );
    }
    fields.add(known);
  });
  return fields;
}

interface CompiledPolicy {
  readonly allowTables: ReadonlySet<string>;
  readonly denyTables: ReadonlySet<string>;
  readonly sentFields: ReadonlySet<EgressFieldClass>;
}

function sectionOf(
  policy: Record<string, unknown>,
  section: "allow" | "deny",
): { tables: ReadonlySet<string>; fields: ReadonlySet<EgressFieldClass> } {
  const raw = policy[section];
  if (raw === undefined && section === "deny") {
    return { tables: new Set(), fields: new Set() };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new GenerateInputError(
      `the egress policy's \`${section}\` is not an object of { tables, fields }`,
    );
  }
  const rules = raw as Record<string, unknown>;
  const tables = tableList(rules.tables, section);
  const fields = fieldList(rules.fields, section);
  if (tables === undefined || fields === undefined) {
    throw new GenerateInputError(
      `the egress policy's \`${section}\` has a \`tables\` or \`fields\` that is not a list`,
    );
  }
  return { tables, fields };
}

/**
 * Validate a policy's shape. Run by `createAiTestGenerator` at construction so
 * a malformed policy fails while it is being wired. Consent is NOT checked here
 * — it is checked on every clearance, because a policy can be well-formed and
 * still withhold consent.
 *
 * @throws GenerateInputError on a malformed policy.
 */
export function validateEgressPolicy(policy: EgressPolicy): void {
  compilePolicy(policy);
}

function compilePolicy(policy: EgressPolicy): CompiledPolicy {
  if (typeof policy !== "object" || policy === null) {
    throw new GenerateInputError(
      "the egress policy is missing; classification before egress has nothing to classify against (DESIGN §10.2)",
    );
  }
  const record = policy as unknown as Record<string, unknown>;
  const allow = sectionOf(record, "allow");
  const deny = sectionOf(record, "deny");
  const sentFields = new Set<EgressFieldClass>();
  for (const field of allow.fields) {
    if (!deny.fields.has(field)) sentFields.add(field);
  }
  return {
    allowTables: allow.tables,
    denyTables: deny.tables,
    sentFields,
  };
}

/**
 * The built-in pattern set, applied in order. Each pattern is created fresh per
 * call: a `/g` regex carries `lastIndex` between uses.
 */
function builtInPatterns(): readonly {
  readonly category: EgressPatternCategory;
  readonly pattern: RegExp;
}[] {
  return [
    {
      category: "private-key",
      pattern:
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    },
    {
      category: "credential",
      pattern:
        /\b(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    },
    {
      category: "token",
      pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    },
    {
      category: "token",
      pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
    },
    {
      category: "token",
      pattern:
        /\b(?:sk|pk|rk|xox[abpr])-[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b/g,
    },
    {
      category: "email",
      pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    },
  ];
}

function emptyCounts(): Record<EgressRedactionCategory, number> {
  const counts = {} as Record<EgressRedactionCategory, number>;
  for (const field of EGRESS_FIELD_CLASSES) counts[field] = 0;
  for (const category of EGRESS_PATTERN_CATEGORIES) counts[category] = 0;
  return counts;
}

/** One clearance's redaction state: stable placeholders, counts. */
class Redaction {
  readonly counts = emptyCounts();
  private readonly placeholders = new Map<string, string>();
  private readonly next = emptyCounts();

  constructor(private readonly sent: ReadonlySet<EgressFieldClass>) {}

  private placeholder(
    category: EgressRedactionCategory,
    value: string,
  ): string {
    const key = `${category}\u0000${value}`;
    let token = this.placeholders.get(key);
    if (token === undefined) {
      this.next[category] += 1;
      token = `«REDACTED:${category}:${this.next[category]}»`;
      this.placeholders.set(key, token);
    }
    this.counts[category] += 1;
    return token;
  }

  /** A field of class `field`: withheld whole, or pattern-scrubbed. */
  field(field: EgressFieldClass, value: string): string {
    if (!this.sent.has(field)) return this.placeholder(field, value);
    let text = value;
    for (const { category, pattern } of builtInPatterns()) {
      text = text.replace(pattern, (match) =>
        this.placeholder(category, match),
      );
    }
    return text;
  }
}

/**
 * Classify a graph and render the prompt from what may leave.
 *
 * @throws EgressRefusedError if the policy withholds consent, or names any
 * artifact in the graph on a denied or unmatched table, or with an identity
 * that is not a table name and a 32-hex sys_id. Nothing is rendered then.
 * @throws GenerateInputError on a malformed policy or kind.
 */
export function clearForEgress(
  kind: TestKind,
  graph: ImpactGraph,
  policy: EgressPolicy,
  instruction?: string,
): EgressClearance {
  const compiled = compilePolicy(policy);
  if (policy.consent !== true) {
    throw new EgressRefusedError(
      "the egress policy does not record consent (`consent: true`); instance data is not sent to an LLM provider without an explicit opt-in — template-only generation remains available (DESIGN §10.4)",
    );
  }

  const withheld: WithheldArtifact[] = [];
  const seen = new Set<string>();
  const redaction = new Redaction(compiled.sentFields);

  const ref = (target: TargetArtifactRef): TargetArtifactRef => {
    const table = typeof target.table === "string" ? target.table : "";
    const sysId = typeof target.sysId === "string" ? target.sysId : "";
    const key = `${normalizeTable(table)}\u0000${sysId.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      const normalized = normalizeTable(table);
      const rule: WithheldArtifact["rule"] | undefined =
        !TABLE_PATTERN.test(normalized) || !SYS_ID_PATTERN.test(sysId)
          ? "malformed-identity"
          : compiled.denyTables.has(normalized)
            ? "denied"
            : compiled.allowTables.has(normalized)
              ? undefined
              : "unmatched";
      if (rule !== undefined) {
        // A malformed identity may be prose, so it is not echoed even here:
        // `withheld` reaches `inspect` and therefore logs.
        withheld.push(
          rule === "malformed-identity"
            ? { table: "", sysId: "", rule }
            : { table, sysId, rule },
        );
      }
    }
    return {
      table,
      sysId,
      name: redaction.field(
        "name",
        typeof target.name === "string" ? target.name : "",
      ),
    };
  };

  const cleared: ImpactGraph = {
    nodes: graph.nodes.map(ref),
    edges: graph.edges.map((edge) => ({
      from: ref(edge.from),
      to: ref(edge.to),
      via: redaction.field("relation", edge.via),
      confidence: edge.confidence,
    })),
    unanalyzable: graph.unanalyzable.map((item) => ({
      artifact: ref(item.artifact),
      reason: redaction.field("reason", item.reason),
    })),
    demanded: graph.demanded.map((planned) => ({
      ...planned,
      spec: {
        ...planned.spec,
        id: redaction.field("plan", planned.spec.id),
      },
      target: ref(planned.target),
    })),
  };

  if (withheld.length > 0) {
    const count = (rule: WithheldArtifact["rule"]): number =>
      withheld.filter((item) => item.rule === rule).length;
    throw new EgressRefusedError(
      `the egress policy withholds ${withheld.length} of ${seen.size} artifacts in the impact graph (${count("denied")} on a denied table, ${count("unmatched")} on a table no allow rule names, ${count("malformed-identity")} without a table/sys_id identity); nothing was sent to the provider — allow the tables by name or use the template provider (DESIGN §10.2)`,
      withheld,
    );
  }

  const prompt = Object.freeze(
    renderPrompt(buildGenerationPrompt(kind, cleared, instruction)),
  );
  clearedPrompts.add(prompt);
  return {
    prompt,
    report: {
      artifacts: seen.size,
      redactions: Object.freeze({ ...redaction.counts }),
    },
  };
}

/** Every prompt `clearForEgress` produced, and nothing else. Module-private. */
const clearedPrompts = new WeakSet<object>();

/** True exactly for a prompt object `clearForEgress` produced in this process. */
export function isEgressCleared(prompt: unknown): boolean {
  return (
    typeof prompt === "object" && prompt !== null && clearedPrompts.has(prompt)
  );
}

/**
 * The transport-side check every adapter that sends a prompt off the machine
 * runs before it sends anything.
 *
 * @throws EgressRefusedError if `prompt` did not come out of `clearForEgress`.
 */
export function assertEgressCleared(prompt: unknown, provider: string): void {
  if (!isEgressCleared(prompt)) {
    throw new EgressRefusedError(
      `the ${provider} provider sends prompts off the machine, and this prompt did not pass egress classification; configure an egress policy with consent (DESIGN §10.2) or use the template provider`,
    );
  }
}
