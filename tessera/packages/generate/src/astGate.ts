// TM-3 layer 1 — the AST allowlist in front of the lexical deny-list (PA-10).
//
// ─────────────────────────────────────────────────────────────────────────────
// What this layer is, and what changed by adding it.
//
// `./gate.ts` is a LEXICAL deny-list: it says what a body may not spell. That is
// defeatable in principle — a member name built by concatenation, a method that
// is not on the list, a homoglyph, an alias — and its header says so. This file
// inverts the question for the one kind of body that is written into an ATF
// "Run Server Side Script" step: it parses the body as ES5 with acorn and admits
// only the shapes and call targets the tables below name. Anything the walker
// does not recognise is a rejection, not a pass.
//
//   * A call is admitted only when its callee is on an allowlist entry: a named
//     ATF/JS helper, a method of a `gs`/`Math`/`JSON`/`stepResult` entry, a read
//     method of a `GlideRecord`/`GlideAggregate` the body constructed itself
//     from a LITERAL table name, or a method of an instance of a Script Include
//     the caller declared as the spec's target (see `targetClassNames`).
//   * Every member name must be spelled (`a.b`); `a[b]`, `a["x" + "y"]` and even
//     `a["x"]` are refused, so there is no way to reach a member the tables
//     cannot read.
//   * Function values cannot travel: a method read that is not immediately
//     called, a constructed record or target used as a plain value, an allowed
//     helper passed as an argument, a function expression anywhere but the two
//     ATF wrapper shapes — each is refused, so `var f = gr.deleteRecord; f()` and
//     `var g = gs; g.eventQueue(…)` have no first step.
//   * Identifiers are ASCII only. A Cyrillic `е` inside `dеleteRecord` is a
//     different identifier to every table here; it is refused before any of
//     them is consulted.
//
// What it still is NOT. It is an allowlist over a SYNTAX TREE, not a sandbox
// and not a proof of behaviour:
//
//   * The target Script Include's own methods are admitted by name (any name
//     not on the denied list). What those methods DO is outside this layer —
//     the target is the code under test, and its behaviour is bounded by the
//     ATF rollback and the runner's roles, not by this file (AIS-2).
//   * The target class names come from the spec manifest. A manifest that names
//     a Script Include as a target makes that class constructible here; the
//     manifest is reviewed repo content (TM-5), so this layer trusts it exactly
//     as far as the review does — and no further: every declared name must be
//     a plain ASCII identifier that is not a reserved word, and a body may
//     declare at most `MAX_TARGET_CLASS_NAMES` of them, or the whole body is
//     refused (`ast-target-name-invalid`, `ast-too-many-targets`).
//   * acorn parses ES5 as the standard defines it. Rhino accepts extensions
//     (E4X, `for each`, Java member access through `Packages`) that acorn
//     refuses — refusal is the safe direction, but a Rhino quirk that PARSES
//     in both and MEANS something different in Rhino is not modelled.
//   * Loops are admitted, so a body can spin until the ATF step timeout.
//
// The lexical gate runs AFTER this one on every body, unconditionally: the
// layers are independent, and a body is admitted only when both pass. Neither
// layer is a substitute for the human review gate (DEV-4).
// ─────────────────────────────────────────────────────────────────────────────
//
// TM-1. Findings carry a rule name, a category, a line and constant text — the
// same shape as `GateViolation`. No slice of the body, no identifier and no
// table name leaves this file.

import { parse } from "acorn";
import type * as A from "acorn";

import type { GateCategory } from "./gate.js";

/** The lexical categories, plus the one only an allowlist can report. */
export type AstGateCategory = GateCategory | "outside-allowlist";

/** Every rule this layer can report. Prefixed `ast-` so a mixed list reads. */
export type AstGateRuleName =
  | "ast-unparseable"
  | "ast-non-ascii-identifier"
  | "ast-eval"
  | "ast-function-constructor"
  | "ast-with-statement"
  | "ast-this"
  | "ast-arguments"
  | "ast-computed-member"
  | "ast-function-alias"
  | "ast-receiver-alias"
  | "ast-function-value"
  | "ast-denied-dynamic-code"
  | "ast-denied-dml"
  | "ast-denied-integrity-bypass"
  | "ast-denied-outbound"
  | "ast-denied-privilege-escalation"
  | "ast-denied-side-effect"
  | "ast-call-outside-allowlist"
  | "ast-new-outside-allowlist"
  | "ast-table-not-literal"
  | "ast-unknown-identifier"
  | "ast-syntax-outside-allowlist"
  | "ast-assignment-outside-allowlist"
  | "ast-redeclaration"
  | "ast-target-name-invalid"
  | "ast-too-many-targets";

export interface AstGateViolation {
  readonly rule: AstGateRuleName;
  readonly category: AstGateCategory;
  /** 1-based, or 0 for a finding about the body as a whole. */
  readonly line: number;
  /** Constant text from `AST_RULE_DETAILS`. Never a slice of the body. */
  readonly detail: string;
}

export interface AstGateOptions {
  /**
   * Script Include class names the body may construct with `new <Name>(…)` —
   * the spec's declared targets, read from the reviewed manifest.
   *
   * Each name must be a plain ASCII JavaScript identifier of at most
   * `MAX_TARGET_CLASS_NAME_CHARS` characters that is not an ES5 reserved
   * word, and there may be at most `MAX_TARGET_CLASS_NAMES` distinct names.
   * Anything else rejects the WHOLE body (`ast-target-name-invalid`,
   * `ast-too-many-targets`): a manifest that declares a target the gate
   * cannot read is not a manifest the gate can vouch for. A well-formed name
   * that collides with a platform class, a global or a denied name is still
   * ignored (fail closed: it simply stays unconstructible).
   */
  readonly targetClassNames?: readonly string[];
}

/**
 * The most distinct Script Include classes one body may declare as targets.
 * A unit spec exercises the Script Include under test and, rarely, a helper
 * it is built from; each declared class is one more name whose methods the
 * allowlist admits wholesale (AIS-2), so the bound keeps that surface small
 * enough for a reviewer to hold in mind. Sixteen is generous for any real
 * spec and far below the generator's per-spec target cap.
 */
export const MAX_TARGET_CLASS_NAMES = 16;

/**
 * The longest declared target class name admitted, in characters — the
 * length of `sys_script_include.name` on the platform (100).
 */
export const MAX_TARGET_CLASS_NAME_CHARS = 100;

const RULES: Readonly<
  Record<AstGateRuleName, { category: AstGateCategory; detail: string }>
> = {
  "ast-unparseable": {
    category: "unparseable",
    detail:
      "the body does not parse as an ES5 script; nothing the allowlist could say about it would be about the code the engine runs",
  },
  "ast-non-ascii-identifier": {
    category: "outside-allowlist",
    detail:
      "an identifier contains a character outside ASCII [A-Za-z0-9_$]; a homoglyph is a different name to every allowlist and deny-list entry",
  },
  "ast-eval": {
    category: "dynamic-code",
    detail: "`eval` is referenced; evaluated text is code no gate has read",
  },
  "ast-function-constructor": {
    category: "dynamic-code",
    detail:
      "`Function` is referenced; the Function constructor is `eval` under another name",
  },
  "ast-with-statement": {
    category: "dynamic-code",
    detail:
      "a `with` statement makes every name inside it resolve against an object the gate cannot see",
  },
  "ast-this": {
    category: "dynamic-code",
    detail:
      "`this` is referenced; in a step body it is the global object, and `this[…]` or `this.x` reaches any global by a name the allowlist does not spell",
  },
  "ast-arguments": {
    category: "dynamic-code",
    detail:
      "`arguments` is referenced; it exposes the wrapper's parameters (and `callee`) as data rather than as named values",
  },
  "ast-computed-member": {
    category: "dynamic-code",
    detail:
      "a member is reached by a computed key (`a[b]`); every member name must be spelled so the allowlist can read it",
  },
  "ast-function-alias": {
    category: "dynamic-code",
    detail:
      "a function is used as a value (read without being called, assigned or passed on); an aliased function is a call the allowlist cannot attribute",
  },
  "ast-receiver-alias": {
    category: "dynamic-code",
    detail:
      "a record, a target instance or a platform object is used as a plain value; its methods are allowlisted only on the name it was declared under",
  },
  "ast-function-value": {
    category: "dynamic-code",
    detail:
      "a function expression appears outside the two admitted shapes (the ATF step wrapper IIFE and a `describe`/`it` callback)",
  },
  "ast-denied-dynamic-code": {
    category: "dynamic-code",
    detail:
      "a reflective or evaluating member or class is named (`prototype`, `constructor`, `__proto__`, `GlideEvaluator`, `Packages`, `gs.include`, …)",
  },
  "ast-denied-dml": {
    category: "unbounded-dml",
    detail:
      "a record-writing method or class is named (`insert`, `update`, `deleteRecord`, `deleteMultiple`, `updateMultiple`, `setValue`, `GlideSysAttachment`, …)",
  },
  "ast-denied-integrity-bypass": {
    category: "integrity-bypass",
    detail:
      "a method that switches off business rules, workflows or system fields is named (`setWorkflow`, `autoSysFields`, `setUseEngines`, `setProperty`)",
  },
  "ast-denied-outbound": {
    category: "outbound",
    detail:
      "an outbound-integration class is named (`RESTMessageV2`, `SOAPMessageV2`, `GlideHTTPRequest`, `sn_ws`, …)",
  },
  "ast-denied-privilege-escalation": {
    category: "privilege-escalation",
    detail:
      "a session or impersonation method or class is named (`getSession`, `impersonate`, `GlideImpersonate`, `setRoles`)",
  },
  "ast-denied-side-effect": {
    category: "unrollbackable-side-effect",
    detail:
      "a method with a side effect the ATF rollback cannot undo is named (`gs.eventQueue`, `gs.eventQueueScheduled`, `gs.email`, `GlideEmailOutbound`)",
  },
  "ast-call-outside-allowlist": {
    category: "outside-allowlist",
    detail:
      "a call's target is not on the allowlist (named helpers, `gs.info`/`gs.debug`, read methods of a record the body constructed, methods of a declared target)",
  },
  "ast-new-outside-allowlist": {
    category: "outside-allowlist",
    detail:
      "a `new` expression constructs a class that is neither a read-only Glide class nor a declared target, or appears outside a `var` initialiser",
  },
  "ast-table-not-literal": {
    category: "outside-allowlist",
    detail:
      "a GlideRecord/GlideAggregate table is not one string literal of the form `[a-z][a-z0-9_]*`; a built table name is a table no reviewer read",
  },
  "ast-unknown-identifier": {
    category: "outside-allowlist",
    detail:
      "a free identifier is neither declared in the body, an ATF wrapper parameter, an allowlisted global nor an UPPER_SNAKE fixture placeholder",
  },
  "ast-syntax-outside-allowlist": {
    category: "outside-allowlist",
    detail:
      "a construct outside the admitted ES5 subset is used (function declarations, `for…in`, `try`, `throw`, `switch`, labels, `debugger`, `delete`, comma expressions, regex literals, accessors)",
  },
  "ast-assignment-outside-allowlist": {
    category: "outside-allowlist",
    detail:
      "an assignment targets something other than a plain local variable (a member, a record, a target instance, a global or a wrapper parameter)",
  },
  "ast-redeclaration": {
    category: "outside-allowlist",
    detail:
      "a name is declared twice, or a declaration shadows an allowlisted global or wrapper parameter; each name must mean one thing for the whole body",
  },
  "ast-target-name-invalid": {
    category: "outside-allowlist",
    detail: `a declared Script Include target name is not a plain ASCII JavaScript identifier of at most ${MAX_TARGET_CLASS_NAME_CHARS} characters that is not an ES5 reserved word; fix the spec's \`targets[].name\` in the manifest`,
  },
  "ast-too-many-targets": {
    category: "outside-allowlist",
    detail: `the spec declares more than ${MAX_TARGET_CLASS_NAMES} distinct Script Include targets; each one widens the call surface the allowlist admits, so split the spec`,
  },
};

// ── The allowlist, as data ──────────────────────────────────────────────────
//
// Every entry carries the reason it is safe. Adding an entry is a security
// decision: it widens what a repo spec can execute with the runner's authority.

/**
 * The ATF "Run Server Side Script" wrapper parameters, in order. A body is
 * either bare statements or one IIFE over a prefix-free subset of these, called
 * with the same names (phase05 `S5_GENERATED_TEST_SCRIPT`, cli `GOOD_BODY`).
 */
const ATF_WRAPPER_PARAMS: Readonly<Record<string, string>> = {
  outputs:
    "the step's output map; admitted only as a wrapper parameter and argument",
  steps:
    "earlier steps' outputs; admitted only as a wrapper parameter and argument",
  params: "the test's parameters; admitted only as a wrapper parameter",
  stepResult:
    "the step's result handle; only the methods in GLOBAL_OBJECTS.stepResult",
  assertEqual: "the ATF assertion helper; callable, never passed on",
};

/** Plain functions a body may call by name. Arguments must be plain values. */
const ALLOWED_FUNCTIONS: Readonly<Record<string, string>> = {
  assertEqual:
    "ATF assertion helper ({ name, shouldbe, value }); reports, writes nothing",
  assertNotEqual: "assertion helper; reports, writes nothing",
  assertTrue: "assertion helper; reports, writes nothing",
  assertFalse: "assertion helper; reports, writes nothing",
  assertEquals: "assertion helper (Jasmine-style specs); reports only",
  String: "pure conversion",
  Number: "pure conversion",
  parseInt: "pure conversion",
  parseFloat: "pure conversion",
  isNaN: "pure predicate",
};

/**
 * Callback-taking helpers: `describe('<literal>', function () { … })` and the
 * same for `it`. The callback's body is walked under the same rules.
 */
const CALLBACK_FUNCTIONS: Readonly<Record<string, string>> = {
  describe: "Jasmine suite grouping; runs its callback once, writes nothing",
  it: "Jasmine spec grouping; runs its callback once, writes nothing",
};

/** Platform objects whose methods are admitted by name, method by method. */
const GLOBAL_OBJECTS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  gs: {
    info: "writes one syslog line; no record a test asserts on",
    debug: "writes one debug syslog line, usually suppressed",
  },
  Math: {
    abs: "pure arithmetic",
    ceil: "pure arithmetic",
    floor: "pure arithmetic",
    max: "pure arithmetic",
    min: "pure arithmetic",
    round: "pure arithmetic",
  },
  JSON: {
    stringify: "pure serialisation of a value already in hand",
  },
  stepResult: {
    setOutputMessage: "sets this step's message; ATF-owned state only",
    setFailed: "marks this step failed; ATF-owned state only",
    setSuccess: "marks this step passed; ATF-owned state only",
  },
};

/** Read-only Glide classes and the methods admitted on an instance of each. */
const GLIDE_READ_CLASSES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  GlideRecord: {
    addQuery: "narrows the query; client-side state until `query()`",
    addEncodedQuery: "narrows the query; client-side state until `query()`",
    query: "runs the SELECT; reads only",
    next: "advances the cursor; reads only",
    get: "reads one record by sys_id or field/value",
    getValue: "reads one field as a string",
    getDisplayValue: "reads one field's display value",
    getUniqueValue: "reads the sys_id",
    isValidRecord: "reports whether the cursor is on a record",
    hasNext: "reports whether another row exists",
    getRowCount: "reports the result size",
  },
  GlideAggregate: {
    addQuery: "narrows the aggregate; client-side state until `query()`",
    addEncodedQuery: "narrows the aggregate; client-side state until `query()`",
    addAggregate: "declares an aggregate (COUNT, SUM, …); reads only",
    groupBy: "declares a grouping; reads only",
    query: "runs the aggregate SELECT; reads only",
    next: "advances the cursor; reads only",
    getAggregate: "reads one aggregate value",
    getValue: "reads one grouped field",
  },
};

/** Free identifiers that are values, not functions or objects. */
const ALLOWED_VALUES: Readonly<Record<string, string>> = {
  undefined: "the undefined value",
  NaN: "a number",
  Infinity: "a number",
};

/**
 * Fixture placeholders: an UPPER_SNAKE free identifier with at least one `_`
 * (`FIXTURE_SYS_ID` in a reviewed spec), admitted as a plain value only —
 * never called, constructed or used as a receiver. The underscore keeps
 * `JSON`, `Math` and every platform class out of the shape.
 */
const PLACEHOLDER = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;

/** An admitted table literal. */
const TABLE_LITERAL = /^[a-z][a-z0-9_]{0,79}$/;

/** What a plain ASCII identifier looks like. */
const ASCII_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * ES5 reserved words (§7.6.1: keywords, future reserved words in both modes,
 * and the `null` / `true` / `false` literals). None can be a class name.
 */
const ES5_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "break",
  "case",
  "catch",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "new",
  "return",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "class",
  "const",
  "enum",
  "export",
  "extends",
  "import",
  "super",
  "implements",
  "interface",
  "let",
  "package",
  "private",
  "protected",
  "public",
  "static",
  "yield",
  "null",
  "true",
  "false",
]);

/** Whether a declared target class name is well-formed (see `AstGateOptions`). */
function isWellFormedTargetName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.length <= MAX_TARGET_CLASS_NAME_CHARS &&
    ASCII_IDENTIFIER.test(name) &&
    !ES5_RESERVED_WORDS.has(name)
  );
}

/**
 * Whole-body findings about the declared targets themselves: a name the gate
 * cannot read, or more names than it admits. Never echoes a name (TM-1).
 */
function targetListViolations(
  names: readonly string[] | undefined,
): AstGateViolation[] {
  const found: AstGateViolation[] = [];
  const list = names ?? [];
  const finding = (rule: AstGateRuleName): AstGateViolation => ({
    rule,
    category: RULES[rule].category,
    line: 0,
    detail: RULES[rule].detail,
  });
  if (!list.every(isWellFormedTargetName)) {
    found.push(finding("ast-target-name-invalid"));
  }
  if (new Set(list).size > MAX_TARGET_CLASS_NAMES) {
    found.push(finding("ast-too-many-targets"));
  }
  return found;
}

type DeniedRule =
  | "ast-denied-dynamic-code"
  | "ast-denied-dml"
  | "ast-denied-integrity-bypass"
  | "ast-denied-outbound"
  | "ast-denied-privilege-escalation"
  | "ast-denied-side-effect";

/**
 * Member names denied wherever they are spelled — called, read, assigned or
 * used as an object key — whatever the receiver. Matching the NAME and not the
 * call shape is what refuses `var f = gr.deleteRecord`, and a target method
 * that happens to share one of these names is refused too: a test can wrap it.
 */
const DENIED_MEMBERS: ReadonlyMap<string, DeniedRule> = new Map<
  string,
  DeniedRule
>([
  // Record writes: the TM-3 unbounded-DML class, and the per-field write.
  ["insert", "ast-denied-dml"],
  ["update", "ast-denied-dml"],
  ["deleteRecord", "ast-denied-dml"],
  ["deleteMultiple", "ast-denied-dml"],
  ["updateMultiple", "ast-denied-dml"],
  ["updateWithReferences", "ast-denied-dml"],
  ["insertWithReferences", "ast-denied-dml"],
  ["setValue", "ast-denied-dml"],
  ["setDisplayValue", "ast-denied-dml"],
  ["applyTemplate", "ast-denied-dml"],
  ["initialize", "ast-denied-dml"],
  ["newRecord", "ast-denied-dml"],
  // Integrity bypass: business rules, workflows, system fields, properties.
  ["setWorkflow", "ast-denied-integrity-bypass"],
  ["autoSysFields", "ast-denied-integrity-bypass"],
  ["setUseEngines", "ast-denied-integrity-bypass"],
  ["setProperty", "ast-denied-integrity-bypass"],
  // Unrollbackable: events and mail leave the transaction.
  ["eventQueue", "ast-denied-side-effect"],
  ["eventQueueScheduled", "ast-denied-side-effect"],
  ["email", "ast-denied-side-effect"],
  // Privilege: the session and impersonation.
  ["getSession", "ast-denied-privilege-escalation"],
  ["impersonate", "ast-denied-privilege-escalation"],
  ["setRoles", "ast-denied-privilege-escalation"],
  // Dynamic code: script inclusion and reflective invocation.
  ["include", "ast-denied-dynamic-code"],
  // `call`, `apply` and `bind` are deliberately NOT here: a target may have a
  // method of that name (the live fixtures' `LiveDiscount.apply`), and the
  // reflective use is already impossible — a method call is admitted only on
  // a named record, target or platform object, so no function value can ever
  // be the receiver of `.call(…)`.
  ["prototype", "ast-denied-dynamic-code"],
  ["constructor", "ast-denied-dynamic-code"],
  ["__proto__", "ast-denied-dynamic-code"],
  ["__defineGetter__", "ast-denied-dynamic-code"],
  ["__defineSetter__", "ast-denied-dynamic-code"],
  ["__lookupGetter__", "ast-denied-dynamic-code"],
  ["__lookupSetter__", "ast-denied-dynamic-code"],
]);

/** Global names denied wherever they appear as an identifier. */
const DENIED_GLOBALS: Readonly<Record<string, DeniedRule>> = {
  GlideSysAttachment: "ast-denied-dml",
  GlideMultipleDelete: "ast-denied-dml",
  GlideMultipleUpdate: "ast-denied-dml",
  GlideRecordSecure: "ast-denied-dml",
  RESTMessage: "ast-denied-outbound",
  RESTMessageV2: "ast-denied-outbound",
  SOAPMessage: "ast-denied-outbound",
  SOAPMessageV2: "ast-denied-outbound",
  GlideHTTPRequest: "ast-denied-outbound",
  sn_ws: "ast-denied-outbound",
  sn_ws_int: "ast-denied-outbound",
  GlideEmailOutbound: "ast-denied-side-effect",
  GlideImpersonate: "ast-denied-privilege-escalation",
  GlideEvaluator: "ast-denied-dynamic-code",
  GlideScopedEvaluator: "ast-denied-dynamic-code",
  Packages: "ast-denied-dynamic-code",
  java: "ast-denied-dynamic-code",
  Class: "ast-denied-dynamic-code",
  Object: "ast-denied-dynamic-code",
  Reflect: "ast-denied-dynamic-code",
  global: "ast-denied-dynamic-code",
  require: "ast-denied-outbound",
  process: "ast-denied-outbound",
};

/**
 * Prefixes no declared target name may carry: a platform class or scoped API
 * namespace is not a Script Include under test.
 */
const PLATFORM_PREFIXES = ["Glide", "RESTMessage", "SOAPMessage", "sn_"];

function has(table: Readonly<Record<string, unknown>>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, name);
}

/** Every name a declaration may not shadow and a target may not take. */
function isReservedName(name: string): boolean {
  return (
    name === "eval" ||
    name === "Function" ||
    name === "arguments" ||
    has(ATF_WRAPPER_PARAMS, name) ||
    has(ALLOWED_FUNCTIONS, name) ||
    has(CALLBACK_FUNCTIONS, name) ||
    has(GLOBAL_OBJECTS, name) ||
    has(GLIDE_READ_CLASSES, name) ||
    has(ALLOWED_VALUES, name) ||
    has(DENIED_GLOBALS, name) ||
    DENIED_MEMBERS.has(name)
  );
}

function admittedTargets(names: readonly string[] | undefined): Set<string> {
  const admitted = new Set<string>();
  for (const name of names ?? []) {
    // A malformed name is also a whole-body finding (`targetListViolations`);
    // skipping it here keeps the walker's tables free of it either way.
    if (!isWellFormedTargetName(name)) continue;
    if (isReservedName(name)) continue;
    if (PLATFORM_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    admitted.add(name);
  }
  return admitted;
}

/** The allowlist exactly as this layer consults it, for docs and tests. */
export const AST_ALLOWLIST = Object.freeze({
  wrapperParams: Object.freeze(Object.keys(ATF_WRAPPER_PARAMS)),
  functions: Object.freeze(Object.keys(ALLOWED_FUNCTIONS)),
  callbackFunctions: Object.freeze(Object.keys(CALLBACK_FUNCTIONS)),
  globalObjects: Object.freeze(
    Object.fromEntries(
      Object.entries(GLOBAL_OBJECTS).map(([name, methods]) => [
        name,
        Object.freeze(Object.keys(methods)),
      ]),
    ),
  ),
  glideReadClasses: Object.freeze(
    Object.fromEntries(
      Object.entries(GLIDE_READ_CLASSES).map(([name, methods]) => [
        name,
        Object.freeze(Object.keys(methods)),
      ]),
    ),
  ),
  values: Object.freeze(Object.keys(ALLOWED_VALUES)),
  deniedMembers: Object.freeze(Object.fromEntries(DENIED_MEMBERS)),
  deniedGlobals: Object.freeze({ ...DENIED_GLOBALS }),
});

/** Every rule this layer can report, sorted. */
export function astGateRuleNames(): readonly AstGateRuleName[] {
  return (Object.keys(RULES) as AstGateRuleName[]).sort();
}

/** The constant detail sentence for each rule. */
export const AST_RULE_DETAILS: Readonly<Record<AstGateRuleName, string>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(RULES).map(([rule, entry]) => [rule, entry.detail]),
    ) as Record<AstGateRuleName, string>,
  );

// ── The walker ──────────────────────────────────────────────────────────────

type LocalKind = "plain" | "glide-record" | "glide-aggregate" | "target";

interface WalkState {
  readonly targets: ReadonlySet<string>;
  readonly locals: Map<string, LocalKind>;
  readonly found: AstGateViolation[];
}

function lineOf(node: A.Node): number {
  return node.loc?.start.line ?? 0;
}

function report(state: WalkState, rule: AstGateRuleName, node: A.Node): void {
  const { category, detail } = RULES[rule];
  state.found.push({ rule, category, line: lineOf(node), detail });
}

/** The name of a non-computed member, or undefined for a computed one. */
function memberName(node: A.MemberExpression): string | undefined {
  if (node.computed || node.property.type !== "Identifier") return undefined;
  return node.property.name;
}

/** Glide class name for a tracked local's kind. */
function glideClassOf(kind: LocalKind): string | undefined {
  if (kind === "glide-record") return "GlideRecord";
  if (kind === "glide-aggregate") return "GlideAggregate";
  return undefined;
}

/**
 * Pass 1 — names. Every Identifier is ASCII; every spelled member name and
 * object key is checked against the denied table. This runs over the WHOLE
 * tree, independent of position, so no shape of the structural walk below can
 * hide a denied name or a homoglyph.
 */
function scanNames(root: A.Node, state: WalkState): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const node = value as A.AnyNode;
    if (typeof node.type !== "string") continue;
    if (node.type === "Identifier") {
      if (!ASCII_IDENTIFIER.test(node.name)) {
        report(state, "ast-non-ascii-identifier", node);
      }
    } else if (node.type === "MemberExpression") {
      const name = memberName(node);
      if (name !== undefined && DENIED_MEMBERS.has(name)) {
        report(state, DENIED_MEMBERS.get(name) as DeniedRule, node.property);
      }
    } else if (node.type === "Property") {
      const key = propertyKeyName(node);
      if (key !== undefined && DENIED_MEMBERS.has(key)) {
        report(state, DENIED_MEMBERS.get(key) as DeniedRule, node.key);
      }
    }
    for (const [field, child] of Object.entries(node)) {
      if (field === "loc") continue;
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
}

function propertyKeyName(
  node: A.Property | A.AssignmentProperty,
): string | undefined {
  if (node.computed) return undefined;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && typeof node.key.value === "string") {
    return node.key.value;
  }
  return undefined;
}

/**
 * Pass 2 — declarations. Every `var` name is recorded with what it was
 * initialised to. A name declared twice, or shadowing anything the allowlist
 * gives a meaning to, is refused: each name means one thing for the body.
 */
function declare(state: WalkState, id: A.Identifier, kind: LocalKind): void {
  if (
    state.locals.has(id.name) ||
    isReservedName(id.name) ||
    state.targets.has(id.name)
  ) {
    report(state, "ast-redeclaration", id);
    return;
  }
  state.locals.set(id.name, kind);
}

/** The kind a `var` initialiser produces, without walking it. */
function initKind(
  init: A.Expression | null | undefined,
  state: WalkState,
): LocalKind {
  if (init?.type !== "NewExpression" || init.callee.type !== "Identifier") {
    return "plain";
  }
  const name = init.callee.name;
  if (name === "GlideRecord") return "glide-record";
  if (name === "GlideAggregate") return "glide-aggregate";
  if (state.targets.has(name)) return "target";
  return "plain";
}

function collectDeclarations(root: A.Node, state: WalkState): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    const node = value as A.AnyNode;
    if (typeof node.type !== "string") continue;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      declare(state, node.id, initKind(node.init, state));
    }
    for (const [field, child] of Object.entries(node)) {
      if (field === "loc") continue;
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
}

// Pass 3 — structure. Statements and expressions are admitted by shape.

function walkStatements(
  body: ReadonlyArray<A.Statement | A.ModuleDeclaration>,
  state: WalkState,
): void {
  for (const statement of body) walkStatement(statement, state);
}

function walkStatement(
  node: A.Statement | A.ModuleDeclaration,
  state: WalkState,
): void {
  switch (node.type) {
    case "ExpressionStatement":
      walkExpressionStatement(node, state);
      return;
    case "VariableDeclaration":
      for (const declarator of node.declarations) {
        walkDeclarator(declarator, state);
      }
      return;
    case "BlockStatement":
      walkStatements(node.body, state);
      return;
    case "EmptyStatement":
      return;
    case "IfStatement":
      walkValue(node.test, state);
      walkStatement(node.consequent, state);
      if (node.alternate) walkStatement(node.alternate, state);
      return;
    case "WhileStatement":
    case "DoWhileStatement":
      walkValue(node.test, state);
      walkStatement(node.body, state);
      return;
    case "ForStatement":
      if (node.init) {
        if (node.init.type === "VariableDeclaration") {
          walkStatement(node.init, state);
        } else {
          walkValue(node.init, state);
        }
      }
      if (node.test) walkValue(node.test, state);
      if (node.update) walkValue(node.update, state);
      walkStatement(node.body, state);
      return;
    case "BreakStatement":
    case "ContinueStatement":
      if (node.label) report(state, "ast-syntax-outside-allowlist", node);
      return;
    case "ReturnStatement":
      if (node.argument) walkValue(node.argument, state);
      return;
    case "WithStatement":
      report(state, "ast-with-statement", node);
      return;
    default:
      // FunctionDeclaration, ForIn, Try, Throw, Switch, Labeled, Debugger.
      report(state, "ast-syntax-outside-allowlist", node);
  }
}

function walkExpressionStatement(
  node: A.ExpressionStatement,
  state: WalkState,
): void {
  const expression = node.expression;
  if (isWrapperCall(expression)) {
    walkWrapper(expression, state);
    return;
  }
  walkValue(expression, state);
}

/** `(function (outputs, …) { … })(outputs, …)` — callee is a function expression. */
function isWrapperCall(
  node: A.Expression,
): node is A.CallExpression & { callee: A.FunctionExpression } {
  return (
    node.type === "CallExpression" && node.callee.type === "FunctionExpression"
  );
}

/**
 * The ATF wrapper IIFE. Its parameters must be ATF wrapper names, and it must
 * be called with exactly those names in the same order — so the wrapper can
 * neither smuggle a value in nor rename `assertEqual` to something else.
 */
function walkWrapper(
  node: A.CallExpression & { callee: A.FunctionExpression },
  state: WalkState,
): void {
  const fn = node.callee;
  const names: string[] = [];
  let shapeOk = fn.id == null;
  for (const param of fn.params) {
    if (
      param.type !== "Identifier" ||
      !has(ATF_WRAPPER_PARAMS, param.name) ||
      names.includes(param.name)
    ) {
      shapeOk = false;
      continue;
    }
    names.push(param.name);
  }
  if (node.arguments.length !== fn.params.length) shapeOk = false;
  node.arguments.forEach((arg, index) => {
    if (arg.type !== "Identifier" || arg.name !== names[index]) shapeOk = false;
  });
  if (!shapeOk) {
    report(state, "ast-function-value", node);
    return;
  }
  walkStatements(fn.body.body, state);
}

function walkDeclarator(node: A.VariableDeclarator, state: WalkState): void {
  // `var` with a non-identifier binding cannot parse as ES5; the check stays.
  /* c8 ignore next 4 */
  if (node.id.type !== "Identifier") {
    report(state, "ast-syntax-outside-allowlist", node);
    return;
  }
  const init = node.init;
  if (!init) return;
  if (init.type === "NewExpression") {
    walkConstruction(init, state);
    return;
  }
  walkValue(init, state);
}

/** `new X(…)` — admitted only as a `var` initialiser. */
function walkConstruction(node: A.NewExpression, state: WalkState): void {
  const callee = node.callee;
  if (callee.type !== "Identifier") {
    // `new global.SomeInclude()`, `new (f())()`: a class the allowlist cannot name.
    if (callee.type === "MemberExpression") walkReceiverChain(callee, state);
    report(state, "ast-new-outside-allowlist", node);
    return;
  }
  const name = callee.name;
  if (has(GLIDE_READ_CLASSES, name)) {
    const [table, ...rest] = node.arguments;
    if (
      rest.length > 0 ||
      table?.type !== "Literal" ||
      typeof table.value !== "string" ||
      !TABLE_LITERAL.test(table.value)
    ) {
      report(state, "ast-table-not-literal", node);
    }
    return;
  }
  if (state.targets.has(name)) {
    walkArguments(node.arguments, state);
    return;
  }
  if (!identifierIsSpecial(callee, state)) {
    report(state, "ast-new-outside-allowlist", node);
  }
}

/**
 * Report the identifiers that are denied or dynamic in themselves, wherever
 * they appear. Returns true when it reported something.
 */
function identifierIsSpecial(node: A.Identifier, state: WalkState): boolean {
  const name = node.name;
  if (name === "eval") {
    report(state, "ast-eval", node);
    return true;
  }
  if (name === "Function") {
    report(state, "ast-function-constructor", node);
    return true;
  }
  if (name === "arguments") {
    report(state, "ast-arguments", node);
    return true;
  }
  if (has(DENIED_GLOBALS, name)) {
    report(state, DENIED_GLOBALS[name] as DeniedRule, node);
    return true;
  }
  return false;
}

/** The object of a member chain we refuse anyway: still report what it names. */
function walkReceiverChain(
  node: A.Expression | A.Super,
  state: WalkState,
): void {
  if (node.type === "Identifier") {
    identifierIsSpecial(node, state);
  } else if (node.type === "ThisExpression") {
    report(state, "ast-this", node);
  } else if (node.type === "MemberExpression") {
    if (node.computed) report(state, "ast-computed-member", node);
    walkReceiverChain(node.object, state);
  }
}

function walkArguments(
  args: ReadonlyArray<A.Expression | A.SpreadElement>,
  state: WalkState,
): void {
  for (const arg of args) walkValue(arg, state);
}

/**
 * A value position: something whose RESULT is used — an argument, an operand,
 * an initialiser, a condition, a property value. Functions cannot appear here.
 */
function walkValue(
  node: A.Expression | A.SpreadElement | A.Super | A.PrivateIdentifier,
  state: WalkState,
): void {
  switch (node.type) {
    case "Literal":
      if (node.regex) report(state, "ast-syntax-outside-allowlist", node);
      return;
    case "Identifier":
      walkIdentifierValue(node, state);
      return;
    case "ThisExpression":
      report(state, "ast-this", node);
      return;
    case "ArrayExpression":
      for (const element of node.elements) {
        if (element) walkValue(element, state);
      }
      return;
    case "ObjectExpression":
      for (const property of node.properties) {
        walkProperty(property, state);
      }
      return;
    case "UnaryExpression":
      if (node.operator === "delete") {
        report(state, "ast-syntax-outside-allowlist", node);
        return;
      }
      walkValue(node.argument, state);
      return;
    case "BinaryExpression":
    case "LogicalExpression":
      walkValue(node.left, state);
      walkValue(node.right, state);
      return;
    case "ConditionalExpression":
      walkValue(node.test, state);
      walkValue(node.consequent, state);
      walkValue(node.alternate, state);
      return;
    case "UpdateExpression":
      walkAssignmentTarget(node.argument, state);
      return;
    case "AssignmentExpression":
      walkAssignmentTarget(node.left, state);
      walkValue(node.right, state);
      return;
    case "MemberExpression":
      walkMemberRead(node, state);
      return;
    case "CallExpression":
      walkCall(node, state);
      return;
    case "NewExpression":
      // Construction is admitted only where its result gets a name.
      walkConstruction(node, state);
      report(state, "ast-new-outside-allowlist", node);
      return;
    case "FunctionExpression":
      report(state, "ast-function-value", node);
      return;
    default:
      // SequenceExpression and anything ES5 parses that is not listed above.
      report(state, "ast-syntax-outside-allowlist", node);
  }
}

function walkProperty(
  node: A.Property | A.SpreadElement,
  state: WalkState,
): void {
  // ES5 object literals have no spread, computed keys or shorthand.
  /* c8 ignore next 4 */
  if (node.type !== "Property" || node.computed) {
    report(state, "ast-syntax-outside-allowlist", node);
    return;
  }
  if (node.kind !== "init") {
    report(state, "ast-syntax-outside-allowlist", node);
    return;
  }
  walkValue(node.value, state);
}

function walkIdentifierValue(node: A.Identifier, state: WalkState): void {
  const name = node.name;
  if (identifierIsSpecial(node, state)) return;
  const local = state.locals.get(name);
  if (local === "plain") return;
  if (local !== undefined) {
    report(state, "ast-receiver-alias", node);
    return;
  }
  if (has(ALLOWED_VALUES, name) || PLACEHOLDER.test(name)) return;
  if (has(GLOBAL_OBJECTS, name)) {
    report(state, "ast-receiver-alias", node);
    return;
  }
  if (
    has(ALLOWED_FUNCTIONS, name) ||
    has(CALLBACK_FUNCTIONS, name) ||
    has(GLIDE_READ_CLASSES, name) ||
    has(ATF_WRAPPER_PARAMS, name) ||
    state.targets.has(name)
  ) {
    report(state, "ast-function-alias", node);
    return;
  }
  report(state, "ast-unknown-identifier", node);
}

function walkAssignmentTarget(
  node: A.Pattern | A.Expression,
  state: WalkState,
): void {
  if (node.type === "Identifier" && state.locals.get(node.name) === "plain") {
    return;
  }
  if (node.type === "MemberExpression") walkReceiverChain(node, state);
  else if (node.type === "Identifier") identifierIsSpecial(node, state);
  report(state, "ast-assignment-outside-allowlist", node);
}

/**
 * A member read whose result is used as a value (not called). On a record it
 * is a field read (`gr.priority`, `gr.caller_id.name`) unless the name is one
 * of the record's methods — a method read is an alias. On anything else that
 * carries methods it is an alias too.
 */
function walkMemberRead(node: A.MemberExpression, state: WalkState): void {
  if (node.computed) {
    report(state, "ast-computed-member", node);
    walkReceiverChain(node.object, state);
    return;
  }
  const name = memberName(node) as string;
  const object = node.object;
  if (object.type === "Identifier") {
    const kind = state.locals.get(object.name);
    if (kind !== undefined) {
      const glide = glideClassOf(kind);
      if (glide !== undefined) {
        if (has(GLIDE_READ_CLASSES[glide] as Record<string, string>, name)) {
          report(state, "ast-function-alias", node);
        }
        return;
      }
      if (kind === "target") {
        // A target property may be a method; no read can tell.
        report(state, "ast-function-alias", node);
      }
      return;
    }
    if (identifierIsSpecial(object, state)) return;
    if (has(GLOBAL_OBJECTS, object.name)) {
      report(state, "ast-function-alias", node);
      return;
    }
    if (PLACEHOLDER.test(object.name)) return;
    walkIdentifierValue(object, state);
    return;
  }
  if (object.type === "MemberExpression") {
    walkMemberRead(object, state);
    return;
  }
  walkValue(object, state);
}

/** A call: the callee must resolve to an allowlist entry by its spelled name. */
function walkCall(node: A.CallExpression, state: WalkState): void {
  const callee = node.callee;
  if (callee.type === "Identifier") {
    walkNamedCall(node, callee, state);
    return;
  }
  if (callee.type === "MemberExpression") {
    walkMethodCall(node, callee, state);
    walkArguments(node.arguments, state);
    return;
  }
  if (callee.type === "FunctionExpression") {
    report(state, "ast-function-value", callee);
  } else {
    // `f()()`, `(a || b)()`: walk the callee too, so what it names is reported.
    walkValue(callee, state);
    report(state, "ast-call-outside-allowlist", node);
  }
  walkArguments(node.arguments, state);
}

function walkNamedCall(
  node: A.CallExpression,
  callee: A.Identifier,
  state: WalkState,
): void {
  const name = callee.name;
  if (has(CALLBACK_FUNCTIONS, name)) {
    walkCallbackCall(node, state);
    return;
  }
  if (!has(ALLOWED_FUNCTIONS, name) || state.locals.has(name)) {
    if (!identifierIsSpecial(callee, state)) {
      report(state, "ast-call-outside-allowlist", node);
    }
  }
  walkArguments(node.arguments, state);
}

/** `describe('<literal>', function () { … })` and `it(…)` — nothing else. */
function walkCallbackCall(node: A.CallExpression, state: WalkState): void {
  const [label, callback, ...rest] = node.arguments;
  const shapeOk =
    rest.length === 0 &&
    label?.type === "Literal" &&
    typeof label.value === "string" &&
    callback?.type === "FunctionExpression" &&
    callback.params.length === 0 &&
    callback.id == null;
  if (!shapeOk) {
    report(state, "ast-function-value", node);
    return;
  }
  walkStatements(callback.body.body, state);
}

function walkMethodCall(
  node: A.CallExpression,
  callee: A.MemberExpression,
  state: WalkState,
): void {
  if (callee.computed) {
    report(state, "ast-computed-member", callee);
    walkReceiverChain(callee.object, state);
    return;
  }
  const name = memberName(callee) as string;
  if (DENIED_MEMBERS.has(name)) {
    // Already reported by name in pass 1; the receiver may name more.
    walkReceiverChain(callee.object, state);
    return;
  }
  const object = callee.object;
  if (object.type !== "Identifier") {
    // `a.b.c()`, `f().g()`, `'x'.y()`: no allowlist entry has that shape.
    walkReceiverChain(object, state);
    report(state, "ast-call-outside-allowlist", node);
    return;
  }
  if (identifierIsSpecial(object, state)) return;
  const kind = state.locals.get(object.name);
  if (kind !== undefined) {
    const glide = glideClassOf(kind);
    if (kind === "target") return;
    if (
      glide !== undefined &&
      has(GLIDE_READ_CLASSES[glide] as Record<string, string>, name)
    ) {
      return;
    }
    report(state, "ast-call-outside-allowlist", node);
    return;
  }
  const methods = GLOBAL_OBJECTS[object.name];
  if (
    methods !== undefined &&
    has(GLOBAL_OBJECTS, object.name) &&
    has(methods, name)
  ) {
    return;
  }
  report(state, "ast-call-outside-allowlist", node);
}

const CATEGORY_ORDER: Readonly<Record<AstGateCategory, number>> = {
  unparseable: 0,
  "dynamic-code": 1,
  "unbounded-dml": 2,
  "integrity-bypass": 3,
  outbound: 4,
  "privilege-escalation": 5,
  "unrollbackable-side-effect": 6,
  "outside-allowlist": 7,
};

function orderAndDedupe(
  violations: readonly AstGateViolation[],
): AstGateViolation[] {
  const seen = new Set<string>();
  const unique = violations.filter((violation) => {
    const key = `${violation.rule}:${violation.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort(
    (left, right) =>
      CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category] ||
      left.line - right.line ||
      (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0),
  );
}

/** acorn's SyntaxError carries `loc.line`; anything else is line 0. */
function parseErrorLine(error: unknown): number {
  const loc = (error as { loc?: { line?: unknown } } | null)?.loc;
  return typeof loc?.line === "number" ? loc.line : 0;
}

/**
 * Inspect one ATF server-side body against the AST allowlist. Takes the text
 * already unwrapped by `./gate.ts`, which owns the unwrap boundary and the
 * clearance; this function returns findings only and is not exported from the
 * package, so it cannot be mistaken for a gate on its own.
 *
 * Pure, hermetic and deterministic, like the lexical layer.
 */
export function inspectAstAllowlist(
  text: string,
  options: AstGateOptions = {},
): readonly AstGateViolation[] {
  const targetFindings = targetListViolations(options.targetClassNames);
  let program: A.Program;
  try {
    program = parse(text, {
      ecmaVersion: 5,
      sourceType: "script",
      locations: true,
      allowReturnOutsideFunction: false,
      allowHashBang: false,
      allowReserved: false,
    });
  } catch (error) {
    const { category, detail } = RULES["ast-unparseable"];
    return orderAndDedupe([
      ...targetFindings,
      {
        rule: "ast-unparseable",
        category,
        line: parseErrorLine(error),
        detail,
      },
    ]);
  }
  const state: WalkState = {
    targets: admittedTargets(options.targetClassNames),
    locals: new Map(),
    found: [...targetFindings],
  };
  scanNames(program, state);
  collectDeclarations(program, state);
  walkStatements(program.body, state);
  return orderAndDedupe(state.found);
}
