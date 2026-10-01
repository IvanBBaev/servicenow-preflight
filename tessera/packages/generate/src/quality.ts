// QA-12(a) — the quality bar: the hermetic half of the split QA-19 forced.
//
// QA-19's argument is that a single "golden set" for generation cannot be kept
// honest: a live model in a PR job is flaky and costly, and a recorded one
// rubber-stamps whatever the recording froze. So the suite is split, and this
// file is the half that BLOCKS a pull request. Everything it needs is handed to
// it — the specs, their bodies, and the graph they were generated from. It
// opens no socket, reads no file and asks nothing of the clock, which is the
// only reason it is eligible to run on every PR.
//
// What it checks is not whether a test is GOOD; no hermetic function can know
// that. It checks the three ways a generated batch is provably worthless.
//
//   1. It will not bind. The manifest rules in `@tessera/specs`'s inventory
//      reader are the contract: an entry with a blank id, an absolute or
//      escaping path, a kind outside TEST_KINDS, or a target missing
//      table/sysId/name is DROPPED there — as a warning, in a report nobody
//      reads on a green run. Checking the same rules here turns a spec that
//      quietly never joined into a failed pull request.
//   2. It is about nothing this run looked at. A target that appears in no
//      node, edge, demand or unanalyzable entry of the `ImpactGraph` is a
//      target the model invented, and coverage joined on it (QA-16) would
//      count an artifact the analysis never saw.
//   3. It asserts nothing. This is the one that matters most, and it is the
//      only item on the list that gets GREENER with age: a spec with no
//      assertion — or with `assertEquals(x, x)` — runs, passes, and is counted
//      as confirmed coverage of the artifact it names, forever. A missing test
//      shows up in a gap count; a vacuous one shows up as success.
//
// Findings carry rule names, positions and counts, and nothing else. The
// inventory reader quotes the offending value because a manifest is repo data
// a human wrote and will grep for; every value inspected HERE came out of a
// model, and `./errors.ts` says why none of it may reach a log, a CI annotation
// or a chat notification (TM-1).
//
// This file is intentionally NOT the safety check. `./gate.ts` answers whether
// a body is safe to have on disk; this one answers whether it is worth having.
// Keeping them apart is what lets either be read on its own — and it means a
// batch can fail here while every byte of it is perfectly safe, which is the
// normal case.

import path from "node:path";

import { TEST_KINDS, unwrapUntrusted } from "@tessera/types";

import {
  MAX_FILENAME_CHARS,
  MAX_ID_CHARS,
  MAX_SYS_ID_CHARS,
  MAX_TABLE_CHARS,
  MAX_TARGET_NAME_CHARS,
  isSafeField,
} from "./fieldSafety.js";
import type {
  ImpactGraph,
  TargetArtifactRef,
  TestKind,
  TestSpec,
  TestSpecRef,
  Untrusted,
} from "@tessera/types";

/**
 * The one unwrap in this file, written so a reviewer who greps the workspace
 * for `unwrapUntrusted` can decide the call on the strength of the sentence.
 */
const QUALITY_BOUNDARY =
  "generation quality bar — the body is matched by regex to count assertions; only counts leave this function, and no model-authored byte is returned, logged, interpolated or re-thrown (TM-1)";

/**
 * The floor, not a target. One assertion per spec is the only density this
 * file can defend: a ratio (assertions per line, per target, per step) is a
 * number somebody picked, and the first spec it rejects for being terse would
 * teach the next author to pad. Zero is different in kind — it is not a weak
 * test, it is a test that cannot fail.
 */
export const MIN_ASSERTIONS = 1;

/**
 * Every rule the bar can report. A union rather than `string`, so the detail
 * table below is exhaustive by compilation and a rule cannot be named in one
 * place and missing from the other.
 */
export const QUALITY_RULES = [
  "empty-batch",
  "blank-id",
  "duplicate-id",
  "blank-path",
  "absolute-path",
  "escaping-path",
  "duplicate-path",
  "unknown-kind",
  "untargeted-spec",
  "malformed-target",
  "ungrounded-target",
  "blank-source",
  "no-assertion",
  "tautological-assertion",
  "unsafe-field",
] as const;

export type QualityRuleName = (typeof QUALITY_RULES)[number];

/**
 * Constant text, one sentence per rule, saying what is wrong and why it is not
 * survivable. Nothing here is ever built from a spec's own fields.
 */
export const QUALITY_RULE_DETAILS: Readonly<Record<QualityRuleName, string>> = {
  "empty-batch":
    "the batch holds no specs; an empty batch is a claim that nothing in the impact graph is worth testing, and downstream it reads as a clean bill of health (OPP-1b)",
  "blank-id":
    "the spec has no `id`; the manifest reader drops an entry without one, so this spec would be registered nowhere and join to nothing",
  "duplicate-id":
    "another spec in this batch already uses this `id`; the manifest reader keeps the first and warns about the rest, so half the batch would disappear on promotion",
  "blank-path":
    "the spec has no `path`; there is nothing for the manifest to point at",
  "absolute-path":
    "the spec's `path` is absolute; a spec of this repo is named relative to the tests root, and the reader rejects the entry",
  "escaping-path":
    "the spec's `path` climbs out of the tests root; an entry that reaches outside the tests tree describes something other than this repo's specs",
  "duplicate-path":
    "another spec in this batch already claims this `path`; two ids over one file means one of them is bookkeeping, and coverage would count the file twice",
  "unknown-kind": `the spec's \`kind\` is outside ${TEST_KINDS.join(", ")}; no runner claims it and the manifest reader drops the entry`,
  "untargeted-spec":
    "the spec declares no targets; QA-16 joins coverage on the declared link and never on the file path, so a spec with no targets confirms nothing no matter how well it runs",
  "malformed-target":
    "a target is missing a non-blank table/sysId/name; the manifest reader drops the WHOLE entry over one rotten target, because a spec that keeps three of its four targets claims less than it was written to claim",
  "ungrounded-target":
    "a target names an artifact that appears nowhere in the impact graph this batch was generated from; it was not analysed, so a spec pointed at it would report coverage of something this run never looked at",
  "blank-source": "the spec body is empty; there is no test here",
  "no-assertion":
    "the spec body contains no assertion; it will run, pass, and be counted as confirmed coverage of every artifact it names — forever, and regardless of what those artifacts do",
  "tautological-assertion":
    "an assertion compares a value with itself or with a constant; it is green before the code under test exists and stays green after that code breaks, which is worse than having no test at all",
  "unsafe-field":
    "the spec's id, path or a target's table/sysId/name carries a control, bidi or zero-width character, or is longer than its cap; such a field prints differently from what is on disk and can drive the reviewer's terminal (review W7b M1)",
};

/**
 * The cap on a spec's `path` for the `unsafe-field` rule. The path is the
 * writer's directory plus a filename, so it is allowed the filename cap twice
 * over.
 *
 * Delegated decision 2026-09-26: a generous multiple rather than the exact
 * `proposed/` prefix length. This file does not know the writer's layout, and
 * the tight filename cap is enforced where the filename is parsed and written.
 */
const MAX_PATH_CHARS = MAX_FILENAME_CHARS * 2;

/**
 * One generated spec as the bar sees it: the binding a manifest would record,
 * plus the body that binding points at.
 *
 * The body arrives still branded. Passing the gate does not launder it (see
 * `ClearedSource` in `./gate.ts`) and neither does passing this — the quality
 * bar reads the text, counts constructs in it, and hands nothing back.
 */
export interface QualitySubject {
  readonly spec: TestSpec;
  readonly source: Untrusted<string>;
}

export interface QualityFinding {
  readonly rule: QualityRuleName;
  /** 1-based position in the batch. Usable even when the id is not; 0 for a rule about the batch as a whole. */
  readonly position: number;
  /** The spec's id, or "" when it does not have a usable one. */
  readonly specId: string;
  /** Constant text from the table above, plus counts. Never a slice of a spec. */
  readonly detail: string;
}

export type QualityVerdict =
  | {
      readonly ok: true;
      readonly checked: number;
      /** Assertion-shaped constructs found across the batch — evidence for a log. */
      readonly assertions: number;
    }
  | {
      readonly ok: false;
      readonly checked: number;
      readonly findings: readonly QualityFinding[];
    };

/**
 * The port. An argument everywhere it is used (ARCH-1) — `./generator.ts` is
 * handed one and never reaches for `createGenerationQualityBar` itself, so a
 * test can tighten or loosen the bar without touching the generator.
 */
export interface GenerationQualityBar {
  check(
    subjects: readonly QualitySubject[],
    graph: ImpactGraph,
  ): QualityVerdict;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `Array.isArray` widens an `unknown` to `any[]`, which would hand every
 * element out untyped — the one thing a validator must not do with the values
 * it is validating.
 */
function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * A missing list is treated as an empty one.
 *
 * A hand-written fixture graph — which is exactly what QA-12(a) is exercised
 * with — is allowed to leave out a list it has nothing for. A validator that
 * crashed on `{ nodes: [...] }` would be harder to exercise than the thing it
 * validates, and a `TypeError` out of the bar is a worse answer than a finding.
 */
function listOf(value: unknown): readonly unknown[] {
  return isArray(value) ? value : [];
}

function isTestKind(value: unknown): value is TestKind {
  return typeof value === "string" && TEST_KINDS.some((kind) => kind === value);
}

/**
 * Identity of an artifact, normalised. Table and sys_id only: `name` is
 * model-authored prose, and requiring it to match would fail a spec for
 * describing the right record with different words.
 *
 * NUL joins the halves because it cannot occur in either — a `.` separator
 * would let `a.b`/`c` and `a`/`b.c` collide, which is a silent grounding pass.
 */
function identity(table: string, sysId: string): string {
  return `${table.trim().toLowerCase()}\u0000${sysId.trim().toLowerCase()}`;
}

/** The key a target is grounded by. Call it on a validated target. */
export function targetKey(target: TargetArtifactRef): string {
  return identity(target.table, target.sysId);
}

/**
 * Every artifact identity the graph mentions, from all four of its lists.
 *
 * `unanalyzable` counts. QA-9's whole point is that an artifact static analysis
 * could not trace is still an impacted artifact — it is in the QA-15 floor's
 * denominator — so a spec aimed at one is a spec aimed at the hardest part of
 * the change, and refusing it would be exactly backwards.
 */
export function graphTargetKeys(graph: ImpactGraph): ReadonlySet<string> {
  const keys = new Set<string>();

  const add = (value: unknown): void => {
    if (!isRecord(value)) return;
    const { table, sysId } = value;
    if (!isNonBlank(table) || !isNonBlank(sysId)) return;
    keys.add(identity(table, sysId));
  };

  for (const node of listOf(graph.nodes)) add(node);
  for (const edge of listOf(graph.edges)) {
    if (!isRecord(edge)) continue;
    add(edge.from);
    add(edge.to);
  }
  for (const item of listOf(graph.unanalyzable)) {
    if (isRecord(item)) add(item.artifact);
  }
  for (const planned of listOf(graph.demanded)) {
    if (isRecord(planned)) add(planned.target);
  }

  return keys;
}

/**
 * Absolute in either flavour.
 *
 * A manifest travels between a macOS developer, a Windows one and a Linux
 * runner, and `C:\tests\x.unit.ts` is absolute on the machine that wrote it
 * whatever `path.isAbsolute` says on the machine that reads it.
 */
function isAbsoluteAnywhere(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

/**
 * Containment decided by path arithmetic, never by touching the filesystem.
 *
 * Whether the file EXISTS is `@tessera/specs`'s question — `readSpecInventory`
 * stats every registered entry and reports rot. This one is about the binding:
 * a relative path that normalises to a leading `..` names a file outside the
 * tests tree no reviewer of this repo ever saw, and that is decidable from the
 * string alone, which is what keeps this suite hermetic.
 */
function escapesRoot(value: string): boolean {
  const normalized = path.normalize(value.split("\\").join("/"));
  return normalized.split("/").some((segment) => segment === "..");
}

/**
 * What one body is worth, lexically.
 *
 * `characters` is the trimmed length, so "blank" and "asserts nothing" stay
 * distinguishable: they are two different review comments.
 */
export interface AssertionAnalysis {
  readonly characters: number;
  readonly total: number;
  /** Of `total`, the ones that cannot fail. */
  readonly trivial: number;
}

/**
 * Assertion vocabulary, unioned across the three spec languages rather than
 * split by kind. A YAML key matched inside a TypeScript file costs nothing —
 * this is a floor on "does it assert at all", not a parse — and one table means
 * a kind added later cannot silently arrive with no vocabulary at all.
 */
const ASSERTION_CALL =
  /\b(?:assert|expect)[A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z0-9_]+)*\s*\(/g;

/** `expect(a).toBe(b)` — the matcher that carries the second operand. */
const MATCHER_CHAIN =
  /^\s*\.\s*(?:toBe|toEqual|toStrictEqual|toContain|toMatch|toBeCloseTo|equals?|is)\s*\(/;

/** ATF/YAML step and field vocabulary, at the start of a line or list item. */
const YAML_ASSERTION_KEY =
  /^[ \t-]*(?:assert(?:ion)?s?|expected|expected_value|expectedValue)\s*:/gm;

/** ATF steps whose whole purpose is the comparison. Exact product strings. */
const ATF_ASSERTION_STEPS: readonly string[] = [
  "Field Values Validation",
  "Record Validation",
  "Assert Text on Page",
];

/** A single operand that is already the answer: `assert(true)`, `assert("x")`. */
const CONSTANT_ARGUMENT = /^(?:true|1|!0|!!1|"[^"]*"|'[^']*'|`[^`]*`)$/;

/** `x === x` inside one operand. */
const SELF_COMPARISON = /^(.+?)\s*(?:===|==)\s*(.+)$/;

/** How far past a call's `)` a matcher chain may start before it is not one. */
const MATCHER_LOOKAHEAD = 48;

interface CallText {
  readonly args: readonly string[];
  /** Index of the closing `)`. */
  readonly end: number;
}

/**
 * The argument list of the call whose `(` is at `open`, split at top-level
 * commas, with quotes and nesting respected.
 *
 * `undefined` when the call never closes. That source is already rejected by
 * the gate's `unbalanced-brackets` rule, so reaching it here means the bar was
 * pointed at ungated text — in which case saying nothing about triviality is
 * the honest answer, not guessing from a truncated argument.
 */
function readCall(text: string, open: number): CallText | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  let quote: string | undefined;
  let escaped = false;

  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) break;

    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push(text.slice(start, index));
        return { args, end: index };
      }
      continue;
    }
    if (char === "," && depth === 1) {
      args.push(text.slice(start, index));
      start = index + 1;
    }
  }

  return undefined;
}

function normalizeArgument(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Whether an assertion's operands make it unfalsifiable.
 *
 * Three shapes, and only three, because each is a claim about the operands
 * rather than about the code under test:
 *
 *   * nothing at all — `assert()`;
 *   * the same text twice — `assertEquals(x, x)`, `expect(x).toBe(x)`;
 *   * one operand that is already a constant — `assert(true)`, `assert(1 === 1)`.
 *
 * A constant is only damning when it stands alone: `assertEquals(true, isOk())`
 * is an ordinary, useful assertion, and flagging it would teach authors to hide
 * their expected values behind variables.
 */
function isTrivial(args: readonly string[]): boolean {
  const normalized = args.map(normalizeArgument);
  const first = normalized[0];
  if (first === undefined || first === "") return true;

  const second = normalized[1];
  if (second !== undefined && second === first) return true;

  const halves = SELF_COMPARISON.exec(first);
  if (halves !== null) {
    const left = halves[1];
    const right = halves[2];
    if (
      left !== undefined &&
      right !== undefined &&
      left.trim() === right.trim()
    ) {
      return true;
    }
  }

  return normalized.length === 1 && CONSTANT_ARGUMENT.test(first);
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = text.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Count the assertions in one body, and how many of them cannot fail.
 *
 * Lexical and deliberately shallow. Comments and string literals are NOT
 * excluded, which makes the count a ceiling rather than a measurement: a body
 * whose only `assert(` sits in a comment is counted as asserting. That is a
 * conscious limit — excluding them means re-implementing the lexer in
 * `./gate.ts`, and the two failure modes are not comparable. A gate that
 * miscounts lets a hostile script execute; a bar that miscounts lets a weak
 * test reach a human reviewer, which is where every generated spec is going
 * anyway (DEV-4).
 *
 * Exported on its own for the DR-2 reason: a check only reachable through the
 * port it feeds is a check whose behaviour never gets pinned down.
 */
export function analyzeAssertions(
  source: Untrusted<string>,
): AssertionAnalysis {
  const text = unwrapUntrusted(source, QUALITY_BOUNDARY);
  const trimmed = text.trim();
  if (trimmed === "") return { characters: 0, total: 0, trivial: 0 };

  let total = 0;
  let trivial = 0;

  for (const match of text.matchAll(ASSERTION_CALL)) {
    const at = match.index;
    const matched = match[0];
    if (at === undefined || matched === undefined) continue;
    total += 1;

    const call = readCall(text, at + matched.length - 1);
    if (call === undefined) continue;

    // `expect(a)` alone says nothing until its matcher arrives, so the operands
    // of both calls are judged as one argument list.
    let operands = call.args;
    const chain = MATCHER_CHAIN.exec(
      text.slice(call.end + 1, call.end + 1 + MATCHER_LOOKAHEAD),
    );
    if (chain !== null && chain[0] !== undefined) {
      const chained = readCall(text, call.end + chain[0].length);
      if (chained !== undefined) operands = [...call.args, ...chained.args];
    }

    if (isTrivial(operands)) trivial += 1;
  }

  const yamlKeys = text.match(YAML_ASSERTION_KEY);
  if (yamlKeys !== null) total += yamlKeys.length;
  for (const step of ATF_ASSERTION_STEPS) {
    total += countOccurrences(text, step);
  }

  return { characters: trimmed.length, total, trivial };
}

function finding(
  rule: QualityRuleName,
  position: number,
  specId: string,
  extra?: string,
): QualityFinding {
  const base = QUALITY_RULE_DETAILS[rule];
  return {
    rule,
    position,
    specId,
    detail: extra === undefined ? base : `${base} (${extra})`,
  };
}

/**
 * Rule names and counts, for an error message or a CI annotation.
 *
 * Sorted by rule and not by occurrence: a summary that changes order between
 * two runs of the same batch is a summary nobody can diff.
 */
export function summarizeQualityFindings(
  findings: readonly QualityFinding[],
): string {
  const counts = new Map<QualityRuleName, number>();
  for (const item of findings) {
    counts.set(item.rule, (counts.get(item.rule) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([rule, count]) => `${rule} (${count})`)
    .join(", ");
}

/**
 * Check a whole batch against the graph it was generated from.
 *
 * Every subject is checked, and every rule is checked on every subject: this
 * runs in a PR job whose author is going to read the answer once and then fix
 * what it says, so stopping at the first finding would buy nothing and cost
 * them a second round trip. The findings come back in batch order, so the list
 * reads down the manifest.
 */
export function checkGenerationQuality(
  subjects: readonly QualitySubject[],
  graph: ImpactGraph,
): QualityVerdict {
  if (subjects.length === 0) {
    // Not "nothing to check". `./errors.ts` and OPP-1b: an empty batch is a
    // claim, and the bar refuses to certify it the same way the generator
    // refuses to produce it.
    return {
      ok: false,
      checked: 0,
      findings: [finding("empty-batch", 0, "")],
    };
  }

  const grounded = graphTargetKeys(graph);
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const findings: QualityFinding[] = [];
  let assertions = 0;

  subjects.forEach((subject, index) => {
    const position = index + 1;
    // Read as wire-ish rather than as the declared type. A fixture spec is
    // written by hand for this suite, and a missing field must produce the
    // finding that names it — not a TypeError from inside the validator.
    const spec: Partial<TestSpec> | undefined = subject.spec;
    const ref: Partial<TestSpecRef> | undefined = spec?.ref;
    const rawId = isNonBlank(ref?.id) ? ref.id : "";
    // Delegated decision 2026-09-26 (W7b M1): an unsafe id is not repeated in
    // any finding, not even as `specId` — a finding is printed, and printing
    // the id is exactly what the rule exists to prevent.
    const idIsSafe = isSafeField(rawId, MAX_ID_CHARS);
    const id = idIsSafe ? rawId : "";
    const record = (rule: QualityRuleName, extra?: string): void => {
      findings.push(finding(rule, position, id, extra));
    };
    let unsafe = !idIsSafe;
    if (typeof ref?.path === "string" && !isSafeField(ref.path, MAX_PATH_CHARS))
      unsafe = true;

    if (rawId === "") record("blank-id");
    else if (seenIds.has(rawId)) record("duplicate-id");
    else seenIds.add(rawId);

    const declaredPath = ref?.path;
    if (!isNonBlank(declaredPath)) {
      record("blank-path");
    } else if (isAbsoluteAnywhere(declaredPath)) {
      record("absolute-path");
    } else if (escapesRoot(declaredPath)) {
      record("escaping-path");
    } else {
      const normalized = path.normalize(declaredPath.split("\\").join("/"));
      if (seenPaths.has(normalized)) record("duplicate-path");
      else seenPaths.add(normalized);
    }

    if (!isTestKind(spec?.kind)) record("unknown-kind");

    const targets = spec === undefined ? [] : listOf(spec.targets);
    if (targets.length === 0) {
      record(
        "untargeted-spec",
        isArray(spec?.targets) ? undefined : "`targets` is not an array",
      );
    }
    targets.forEach((target, offset) => {
      const at = `target #${offset + 1}`;
      if (!isRecord(target)) {
        record("malformed-target", at);
        return;
      }
      const { table, sysId, name } = target;
      if (!isNonBlank(table) || !isNonBlank(sysId) || !isNonBlank(name)) {
        record("malformed-target", at);
        return;
      }
      if (
        !isSafeField(table, MAX_TABLE_CHARS) ||
        !isSafeField(sysId, MAX_SYS_ID_CHARS) ||
        !isSafeField(name, MAX_TARGET_NAME_CHARS)
      ) {
        unsafe = true;
      }
      if (!grounded.has(identity(table, sysId)))
        record("ungrounded-target", at);
    });

    // One finding per spec, however many of its fields are unsafe — the rule
    // names the construct, and the detail says which fields it covers.
    if (unsafe) record("unsafe-field");

    const analysis = analyzeAssertions(subject.source);
    assertions += analysis.total;
    if (analysis.characters === 0) {
      // One finding, not two. A blank body has no assertions either, and a
      // second line saying so sends the reader looking for a second problem.
      record("blank-source");
    } else {
      if (analysis.total < MIN_ASSERTIONS) {
        record("no-assertion", `${analysis.characters} characters`);
      }
      if (analysis.trivial > 0) {
        // Any tautology, not a ratio: one `assertEquals(x, x)` among nine good
        // assertions still passes forever, and the rule is about the construct.
        record(
          "tautological-assertion",
          `${analysis.trivial} of ${analysis.total}`,
        );
      }
    }
  });

  if (findings.length > 0) {
    return { ok: false, checked: subjects.length, findings };
  }
  return { ok: true, checked: subjects.length, assertions };
}

/**
 * The bar as a port implementation. The composition root hands one to the
 * generator; nothing inside `@tessera/generate` calls this itself (ARCH-1).
 */
export function createGenerationQualityBar(): GenerationQualityBar {
  return { check: checkGenerationQuality };
}
