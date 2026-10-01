// TM-3 — the static gate that every generated spec passes before anything is
// written, and the honest statement of what it is worth (DESIGN §9.3).
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE TRUSTING ANYTHING BELOW.
//
// This is a LEXICAL gate. It has no parser, no scope analysis, no evaluation of
// any kind. It lexes the source into code, string and comment positions and
// then matches a deny-list of literal constructs — some against code positions
// only, names and tables against every position. That is all it does.
//
// A lexical gate is DEFEATABLE BY OBFUSCATION. It is defeatable in principle,
// not merely in some unlucky corner: any construct that computes a method name
// at run time, decodes it from data, reaches it through an alias, or hides it
// behind a language feature this file does not model can carry a denied call
// past every rule here. The structural rules below (`computed-call`,
// `computed-member`, `destructuring`, `encoded-decoder`, `escape-obfuscation`,
// `zero-width`, `bidi-control`, and the balance and termination checks) exist precisely because that is true:
// they refuse the shapes obfuscation needs, so that defeating the gate requires
// a shape the gate has not thought of rather than one it has. That narrows the
// hole. It does not close it, and nothing in this file closes it.
//
// So the claim this gate makes is bounded and worth stating exactly:
//
//   * It PROVES nothing about a passing spec. `{ ok: true }` means "no rule
//     fired", which is a statement about the deny-list, not about the code.
//   * It is a DEFENCE-IN-DEPTH LAYER UNDER THE HUMAN REVIEW GATE, NOT A
//     SUBSTITUTE FOR ONE. DEV-4 puts generated specs in `proposed/` and leaves
//     the live manifest untouched exactly so a person reads the diff. If that
//     review is ever skipped because "the gate checks it", the gate has made
//     the system less safe than having no gate at all, by supplying a
//     confidence it cannot underwrite.
//   * What it does deliver is cheap, deterministic and total: the obvious
//     hostile constructs never get as far as a reviewer's attention budget, and
//     every rejection is reproducible in CI with no instance and no network.
//
// What the deny-list now covers, and what it still does not (reviews W4a and
// W7b, 2026-09-26 — every COVERED item below was an executed bypass before
// that date):
//
//   COVERED. Identifier escapes in code (`eval`) are refused outright
//   (`identifier-escape`); HTML-like comments (`<!--`, line-start `-->`) and a
//   `#!` hashbang are refused outright (`html-comment`, `hashbang`), and the
//   lexer models them as the line comments the engine sees; a quoted string
//   broken by a raw line terminator is refused (`string-line-break`).
//
//   Denied methods are matched by NAME, not by call shape: `.deleteMultiple`,
//   `.insert`, `.update`, `setWorkflow`, … fire whether or not a call token
//   follows, so a parenthesised member (`(gr.deleteMultiple)()`), a comma
//   expression, an alias (`var f = gr.deleteMultiple`) and an array element
//   are refused at the name. The `*WithReferences`-style DML family
//   (`dml-family-member`), `GlideMultipleDelete`/`GlideMultipleUpdate`,
//   `setProperty`, `GlideSysAttachment`, the Rhino Java bridge (`Packages`,
//   `java.*`) and Node runtime reach (`require`, `process`, `fetch`, dynamic
//   `import`, `from 'fs'`, `node:` specifiers) are denied. Indirect invocation
//   (`.call`, `.bind`, and `.apply` except `.apply(<digit or quote>…)`),
//   prototype and constructor access, an aliased `gs` or `GlideRecord`, every
//   computed member whose key is not a digit run or a plain quoted literal
//   (`computed-member`; object computed keys and `?.[` included) and every
//   destructuring pattern (`destructuring`) are refused, because each is a way
//   to reach a member without spelling its name where a rule can read it.
//
//   Names, tables and classes are matched ANYWHERE — code, strings, comments
//   and regex literals — not only in code positions. A YAML spec is lexed as
//   JavaScript, so a double-quoted YAML scalar reads as one string and
//   `# /* … # */` reads as a block comment; before W7b both hid a whole script
//   from a code-only deny-list. The cost is stated rather than hidden: a
//   comment that merely mentions `deleteMultiple` or `eval` is refused too.
//
//   NOT COVERED, and not coverable lexically. A member name assembled by
//   concatenation OUTSIDE a subscript and reached by a construct this file
//   does not model; a YAML scalar gets only the ANYWHERE patterns and the
//   string-position subscript and destructuring checks — none of the
//   structural lexing a code body gets; a method that is not on the deny-list
//   doing the denied thing; confusable homoglyphs (a Cyrillic letter inside a
//   denied name is a different identifier to every rule here); and any
//   construct Rhino accepts that this lexer does not model. These are the
//   "shape the gate has not thought of" above.
//
// Raising this to a real guarantee means an AST for the ES5/Rhino dialect plus
// an allowlist of permitted call targets — a different piece of work, owned and
// versioned. Until that exists, do not describe this file as one.
// ─────────────────────────────────────────────────────────────────────────────
//
// FAIL-CLOSED. Anything the lexer cannot confidently account for is a rejection
// and not a warning: an unterminated string, an unterminated comment, a broken
// regex literal, a slash that could be division or a regex, brackets that do
// not balance, control or bidirectional characters, a backslash in code, an
// HTML-like comment, a hashbang, a raw line break inside a quoted string, a
// source over the size cap. The reasoning is one sentence — if the lexer is desynchronised then
// every CODE/STRING verdict after that point is a guess, and a deny-list
// consulted against guesses is a deny-list that reports clean because it looked
// in the wrong place. `@tessera/impact`'s scanner makes the opposite trade for
// the opposite reason: it recovers from a mis-lex because it is describing a
// script it does not control, while this file is admitting one it is about to
// write to disk.
//
// TM-1. Violations carry a rule name, a category, a line number and a sentence
// from the constant table below. They never carry a slice of the source. An
// error message quoting the offending line is the same string escaping through
// a different door — into a log, a CI annotation, a chat notification — and the
// gate exists to keep it from travelling.

import { LEX_CODE, LEX_COMMENT, LEX_STRING, lexScript } from "@tessera/impact";
import type { ScriptLexResult } from "@tessera/impact";
import { unwrapUntrusted } from "@tessera/types";
import type { Untrusted } from "@tessera/types";

/**
 * The unwrap boundary, phrased as the claim the rest of the file keeps true.
 */
const GATE_BOUNDARY =
  "generated-code gate — the source is lexed and regex-matched in place; only rule names, category names, line numbers and constant text leave this function, and the body itself is returned still branded (TM-1/TM-3)";

/**
 * A source longer than this is rejected unread.
 *
 * The cap is not about performance. A generated unit spec is tens of lines; a
 * twenty-thousand-character one is not a spec this pipeline asked for, and the
 * failure mode of scanning it anyway is a reviewer who approves a diff nobody
 * read to the end.
 */
export const MAX_GATED_SOURCE_CHARS = 20_000;

export const GATE_CATEGORIES = [
  "dynamic-code",
  "unbounded-dml",
  "integrity-bypass",
  "outbound",
  "privilege-escalation",
  "unrollbackable-side-effect",
  "unparseable",
] as const;

export type GateCategory = (typeof GATE_CATEGORIES)[number];

/**
 * Every rule this gate can report. A union rather than `string`, so the tables
 * below are exhaustive by compilation and a rule cannot be advertised in one
 * place and missing from another.
 */
export type GateRuleName =
  // dynamic-code
  | "eval"
  | "new-function"
  | "function-constructor"
  | "glide-evaluator"
  | "glide-scoped-evaluator"
  | "gs-include"
  | "with-statement"
  | "reflect"
  // unbounded-dml
  | "insert"
  | "update"
  | "update-multiple"
  | "delete-record"
  | "delete-multiple"
  | "dml-family-member"
  | "glide-multiple-dml"
  | "sys-attachment"
  // dynamic-code, W7b
  | "java-bridge"
  | "gs-alias"
  | "glide-record-alias"
  | "indirect-invoke"
  | "prototype-access"
  // integrity-bypass
  | "set-workflow"
  | "auto-sys-fields"
  | "set-use-engines"
  | "set-property"
  // outbound, W7b
  | "node-runtime"
  // outbound
  | "rest-message"
  | "rest-message-v2"
  | "soap-message"
  | "soap-message-v2"
  | "glide-http-request"
  | "sn-ws"
  | "sn-ws-int"
  // privilege-escalation
  | "set-roles"
  | "impersonate"
  | "glide-impersonate"
  | "role-table"
  // unrollbackable-side-effect
  | "gs-email"
  | "gs-event-queue"
  | "glide-email-outbound"
  | "sysevent-table"
  | "ecc-queue-table"
  // unparseable / fail-closed
  | "blank-source"
  | "oversize-source"
  | "unterminated-string"
  | "unterminated-template"
  | "unterminated-comment"
  | "unterminated-regex"
  | "ambiguous-slash"
  | "unbalanced-brackets"
  | "control-character"
  | "zero-width-character"
  | "bidi-control-character"
  | "escape-obfuscation"
  | "encoded-decoder"
  | "computed-call"
  | "computed-name-concat"
  | "computed-member"
  | "destructuring"
  | "identifier-escape"
  | "html-comment"
  | "hashbang"
  | "string-line-break";

export interface GateViolation {
  readonly rule: GateRuleName;
  readonly category: GateCategory;
  /** 1-based, or 0 for a rule about the source as a whole. */
  readonly line: number;
  /** Constant text from the rule table. Never a slice of the inspected source. */
  readonly detail: string;
}

declare const gateClearanceBrand: unique symbol;

/**
 * Proof that a specific source was inspected and no rule fired.
 *
 * It is opaque and can only be minted here, which is what makes `./writer.ts`
 * able to demand one: writing an ungated source is then a compile error rather
 * than a review comment. The token says the gate ran — see the header for what
 * that is and is not worth.
 */
export interface GateClearance {
  readonly [gateClearanceBrand]: true;
}

export interface ClearedSource {
  /**
   * The same value that went in, still branded. Passing the gate is not
   * laundering: the text is no more trustworthy for having been scanned, and a
   * gate that handed back a bare `string` would be a second door out of TM-1.
   */
  readonly source: Untrusted<string>;
  readonly clearance: GateClearance;
  readonly lines: number;
  readonly characters: number;
}

export type GateVerdict =
  | { readonly ok: true; readonly cleared: ClearedSource }
  | { readonly ok: false; readonly violations: readonly GateViolation[] };

export interface GeneratedCodeGate {
  inspect(source: Untrusted<string>): GateVerdict;
}

/** What may not flank a bare-word match; `$` and `_` are identifier characters. */
const WORD_CHAR = "[A-Za-z0-9_$]";

/** A bare word: `name` not flanked by an identifier character. */
function word(name: string): string {
  return `(?<!${WORD_CHAR})(?:${name})(?!${WORD_CHAR})`;
}

/**
 * What makes a name a CALL, as the engine sees it: `f(`, `f?.(`, a tagged
 * template `` f`…` ``, or `f.call` / `f.apply` / `f.bind` (plain or `?.`).
 *
 * Delegated decision 2026-09-26: the few rules that still need a call shape
 * (`new Function(…)`, `Function(…)` in non-code text, the decoders) end in this
 * suffix rather than in `\s*\(`, so `?.(`, a tagged template and
 * `.call`/`.apply`/`.bind` all count as the call.
 */
const INVOKE = `\\s*(?:[(\`]|\\?\\.\\s*[(\`]|\\??\\.\\s*(?:call|apply|bind)(?!${WORD_CHAR}))`;

/** `gs.` or `gs?.` — optional chaining reaches the same member. */
const GS_DOT = `(?<!${WORD_CHAR})gs\\s*\\??\\.\\s*`;

/** `.name` or `?.name`, the name ending at a word boundary. */
function member(name: string): string {
  return `\\.\\s*(?:${name})(?!${WORD_CHAR})`;
}

interface DenyRule {
  readonly category: GateCategory;
  /**
   * Regex SOURCE matched against the comment-blanked projection, a hit
   * counting only at a CODE position. For constructs that are ordinary words
   * in prose or in a string (`Function`, `process`, `prototype`) and are only
   * dangerous as code.
   */
  readonly code?: string;
  /**
   * Regex SOURCE matched at ANY position of the raw source — code, string,
   * comment, regex — and also against the comment-blanked projection at CODE
   * positions (so a comment between two tokens is whitespace, as it is to the
   * engine). For names, tables and classes: a YAML scalar is one JS string and
   * a YAML `# /*` is one JS comment, so a code-only match of these is a match
   * a YAML spec walks straight past.
   */
  readonly anywhere?: string;
  readonly detail: string;
}

/**
 * The DESIGN §9.3 deny-list, one row per construct, plus the W7b rows.
 *
 * Widenings of the design table, each stricter than what it says and each for
 * the same reason — a lexer cannot read an argument, follow an alias, or tell
 * a YAML scalar from a JS string:
 *
 *   * Denied METHODS are matched by name (`.deleteMultiple`, bare
 *     `setWorkflow`), not by call shape. Delegated decision 2026-09-26: before
 *     W7b every call-shaped row was defeated by `(gr.deleteMultiple)()`, by
 *     `(0, gr.deleteMultiple)()`, by `var f = gr.deleteMultiple; f.call(gr)`
 *     and by `[gr.deleteMultiple][0].call(gr)`. Naming the method is refused.
 *   * `setWorkflow`/`autoSysFields`/`setUseEngines` are denied outright, not
 *     only with a `false` argument: deciding `setWorkflow(x)` needs `x`.
 *   * `RESTMessage` and `SOAPMessage` are denied by name, because naming the
 *     class in a test is already the intent.
 *   * `sys_user_has_role`, `sysevent` and `ecc_queue` are denied as bare words
 *     anywhere. A test that mentions these tables at all is a test doing
 *     something a rollback cannot undo (DR-5).
 *
 * Delegated decision 2026-09-26: names, tables and classes are ANYWHERE rules
 * (see `DenyRule.anywhere`). A comment that merely mentions a denied name is
 * refused; that costs an author one rephrase, and the alternative let a whole
 * script through inside a YAML scalar.
 */
const DENY_TABLE: ReadonlyArray<readonly [GateRuleName, DenyRule]> = [
  [
    "eval",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: `eval` is denied as a bare word, called
      // or not, anywhere. `(0, eval)(x)`, `var e = eval;` and `eval.apply(…)`
      // all reach it without an `eval(` token, and no generated test names it.
      anywhere: word("eval"),
      detail: "eval executes text as code; nothing generated here needs it",
    },
  ],
  [
    "new-function",
    {
      category: "dynamic-code",
      anywhere: `(?<!${WORD_CHAR})new\\s+Function${INVOKE}`,
      detail:
        "the Function constructor builds a callable out of a string, which is eval with a different name",
    },
  ],
  [
    "function-constructor",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: in code, `Function` is denied as a bare
      // word — `Function.prototype.call.call(gr.deleteMultiple, gr)` and
      // `var F = Function; F(src)` reach it without a call token after the
      // name. Outside code (prose, a YAML scalar) only the call shape counts,
      // because "Function" is an ordinary English word.
      code: word("Function"),
      anywhere: `(?<!${WORD_CHAR})Function${INVOKE}`,
      detail:
        "calling Function as a function compiles a string into code without the `new`",
    },
  ],
  [
    "glide-evaluator",
    {
      category: "dynamic-code",
      anywhere: word("GlideEvaluator"),
      detail: "GlideEvaluator runs arbitrary server-side script text",
    },
  ],
  [
    "glide-scoped-evaluator",
    {
      category: "dynamic-code",
      anywhere: word("GlideScopedEvaluator"),
      detail: "GlideScopedEvaluator runs arbitrary script text in a scope",
    },
  ],
  [
    "gs-include",
    {
      category: "dynamic-code",
      anywhere: `${GS_DOT}include(?!${WORD_CHAR})`,
      detail:
        "gs.include pulls a named script into the current scope at run time, which is dispatch this gate cannot follow",
    },
  ],
  [
    "with-statement",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: the `with` statement is denied. Inside
      // `with (gr) { deleteMultiple(); }` a bare name resolves to a member of
      // `gr`, so a denied method is called with no `.name` token to match. A
      // member named `with` (`arr.with(0, 1)`) is not the statement and passes.
      anywhere: `(?<!${WORD_CHAR})(?<!\\.\\s*)with\\s*\\(`,
      detail:
        "a with statement turns bare names into member calls, which hides a denied method from every call-shaped rule",
    },
  ],
  [
    "reflect",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: `Reflect` is denied as a bare word
      // anywhere, and `Proxy` in code. Both call, construct and read members
      // by reference, and a generated test never needs either.
      anywhere: word("Reflect"),
      code: word("Proxy"),
      detail:
        "Reflect and Proxy call, construct and read members by reference, which is dispatch this gate cannot follow",
    },
  ],
  [
    "java-bridge",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: the Rhino Java bridge is denied.
      // `Packages.java.lang.Runtime.getRuntime().exec(…)` is a shell on the
      // instance node, and nothing about it looks like a ServiceNow API.
      // `java`/`javax` alone are only code-position words (they are ordinary
      // words in prose); the qualified forms and the bridge globals are
      // denied anywhere.
      code: word("java|javax"),
      anywhere: `${word("Packages|JavaImporter|importPackage|importClass|JavaAdapter")}|(?<!${WORD_CHAR})(?:java|javax|org|com)\\s*\\.\\s*(?:lang|io|nio|net|util|security|mozilla|glide|snc|sun|oracle|apache|google)(?!${WORD_CHAR})`,
      detail:
        "the Rhino Java bridge reaches the JVM under the instance directly — processes, files, sockets — past every Glide API this gate knows",
    },
  ],
  [
    "gs-alias",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: `gs` is only admitted as `gs.member`
      // (or `gs?.member`). `var g = gs; g.eventQueue(…)` and `this.gs` hand the
      // whole GlideSystem API to a name every `gs.`-shaped rule is blind to.
      anywhere: `(?<!${WORD_CHAR})gs(?!${WORD_CHAR})(?!\\s*\\??\\.)|${word("GlideSystem")}`,
      detail:
        "gs used as a value rather than as `gs.member` is an alias the gs-shaped rules cannot follow",
    },
  ],
  [
    "glide-record-alias",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: `GlideRecord`/`GlideRecordSecure` are
      // only admitted right after `new`. `var G = GlideRecord` renames the
      // class, and nothing downstream of that name is visible to a rule.
      code: `(?<!${WORD_CHAR})(?<!(?<!${WORD_CHAR})new\\s+)GlideRecord(?:Secure)?(?!${WORD_CHAR})`,
      detail:
        "GlideRecord used other than as `new GlideRecord(…)` is an alias the gate cannot follow",
    },
  ],
  [
    "indirect-invoke",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: `.call` and `.bind` are denied as
      // members, and `.apply` unless its first argument starts with a digit or
      // a quote. Each is how an alias is invoked with a chosen receiver
      // (`f.call(gr)` after `var f = gr.deleteMultiple`). The `.apply` carve-out
      // exists because a domain object's own `apply(99, 10)` is ordinary; a
      // receiver passed to Function.prototype.apply is never a literal number
      // or string in anything this pipeline generates.
      anywhere: `\\??\\.\\s*(?:call|bind)(?!${WORD_CHAR})|\\??\\.\\s*apply(?!${WORD_CHAR})(?!\\s*\\(\\s*[0-9"'])`,
      detail:
        "call, apply and bind invoke a function held by reference, which is how an aliased denied method is run",
    },
  ],
  [
    "prototype-access",
    {
      category: "dynamic-code",
      // Delegated decision 2026-09-26: prototype and constructor access is
      // denied. `x.constructor.constructor(src)` is the Function constructor
      // with no `Function` token, and the reflective Object helpers enumerate
      // the member names a computed-member rule would otherwise refuse.
      code: word(
        "prototype|constructor|__proto__|getOwnPropertyNames|getOwnPropertyDescriptors?|getPrototypeOf|setPrototypeOf|definePropert(?:y|ies)|__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__",
      ),
      anywhere: `\\.\\s*(?:prototype|constructor|__proto__)(?!${WORD_CHAR})|${word("getOwnPropertyNames|getOwnPropertyDescriptors?|getPrototypeOf|setPrototypeOf|definePropert(?:y|ies)|__defineGetter__|__defineSetter__|__lookupGetter__|__lookupSetter__")}|${word("Object")}\\s*\\.\\s*(?:values|entries)(?!${WORD_CHAR})`,
      detail:
        "prototype and constructor access reach the Function constructor and every member of an object without naming one",
    },
  ],
  [
    "insert",
    {
      category: "unbounded-dml",
      anywhere: member("insert"),
      detail:
        "record insertion writes the instance outside the asserted fixture set",
    },
  ],
  [
    "update",
    {
      category: "unbounded-dml",
      anywhere: member("update"),
      detail:
        "record update writes the instance outside the asserted fixture set",
    },
  ],
  [
    "update-multiple",
    {
      category: "unbounded-dml",
      anywhere: word("updateMultiple"),
      detail:
        "updateMultiple writes every row a query matched, and the query is not bounded by anything the gate can see",
    },
  ],
  [
    "delete-record",
    {
      category: "unbounded-dml",
      anywhere: word("deleteRecord"),
      detail: "record deletion is not a test step",
    },
  ],
  [
    "delete-multiple",
    {
      category: "unbounded-dml",
      anywhere: word("deleteMultiple"),
      detail:
        "deleteMultiple removes every row a query matched; a mistaken query here empties a table",
    },
  ],
  [
    "dml-family-member",
    {
      category: "unbounded-dml",
      // Delegated decision 2026-09-26: every `insert…`/`update…`/`delete…`
      // camel-case member is denied — `insertWithReferences`,
      // `updateWithReferences`, `deleteAttachment`, and whatever the platform
      // adds next. The three named rows above keep their own rule names.
      anywhere: `(?<!${WORD_CHAR})(?!(?:updateMultiple|deleteRecord|deleteMultiple)(?!${WORD_CHAR}))(?:insert|update|delete)[A-Z][A-Za-z0-9_$]*`,
      detail:
        "an insert, update or delete variant writes or removes rows outside the asserted fixture set",
    },
  ],
  [
    "glide-multiple-dml",
    {
      category: "unbounded-dml",
      anywhere: `(?<!${WORD_CHAR})GlideMultiple(?:Delete|Update)(?!${WORD_CHAR})`,
      detail:
        "GlideMultipleDelete and GlideMultipleUpdate change every row a query matched in one statement",
    },
  ],
  [
    "sys-attachment",
    {
      category: "unbounded-dml",
      anywhere: `(?<!${WORD_CHAR})GlideSysAttachment[A-Za-z0-9_$]*`,
      detail:
        "GlideSysAttachment reads, writes and deletes attachment content outside the asserted fixture set",
    },
  ],
  [
    "set-workflow",
    {
      category: "integrity-bypass",
      anywhere: word("setWorkflow"),
      detail:
        "setWorkflow suppresses business rules while writing, so the write happens with the logic under test switched off",
    },
  ],
  [
    "auto-sys-fields",
    {
      category: "integrity-bypass",
      anywhere: word("autoSysFields"),
      detail:
        "autoSysFields suppresses the audit fields that record who changed what",
    },
  ],
  [
    "set-use-engines",
    {
      category: "integrity-bypass",
      anywhere: word("setUseEngines"),
      detail:
        "setUseEngines disables approval and workflow engines during a write",
    },
  ],
  [
    "set-property",
    {
      category: "integrity-bypass",
      anywhere: word("setProperty"),
      detail:
        "setProperty changes a system property for the whole instance, and a rollback does not restore it",
    },
  ],
  [
    "rest-message",
    {
      category: "outbound",
      anywhere: word("RESTMessage"),
      detail:
        "outbound HTTP leaves the instance and is not transactional; it has already been sent when the rollback runs",
    },
  ],
  [
    "rest-message-v2",
    {
      category: "outbound",
      anywhere: word("RESTMessageV2"),
      detail:
        "outbound HTTP leaves the instance and is not transactional; it has already been sent when the rollback runs",
    },
  ],
  [
    "soap-message",
    {
      category: "outbound",
      anywhere: word("SOAPMessage"),
      detail: "outbound SOAP leaves the instance and cannot be rolled back",
    },
  ],
  [
    "soap-message-v2",
    {
      category: "outbound",
      anywhere: word("SOAPMessageV2"),
      detail: "outbound SOAP leaves the instance and cannot be rolled back",
    },
  ],
  [
    "glide-http-request",
    {
      category: "outbound",
      anywhere: word("GlideHTTPRequest"),
      detail: "a raw outbound HTTP request is exfiltration or SSRF, not a test",
    },
  ],
  [
    "sn-ws",
    {
      category: "outbound",
      anywhere: word("sn_ws"),
      detail: "the sn_ws scope is the outbound web-service API",
    },
  ],
  [
    "sn-ws-int",
    {
      category: "outbound",
      anywhere: word("sn_ws_int"),
      detail: "the sn_ws_int scope is the outbound web-service API",
    },
  ],
  [
    "node-runtime",
    {
      category: "outbound",
      // Delegated decision 2026-09-26: a Playwright or unit spec runs under
      // Node on the operator's machine, where `require`, `process`, `fetch`
      // and a dynamic `import()` are a shell and the operator's credentials.
      // The globals are code-position words (they are ordinary in prose); the
      // module specifiers are denied anywhere. A static import of anything but
      // the listed built-ins (`@playwright/test`) is left alone.
      code: `(?<![A-Za-z0-9_$.])(?:require|process|fetch|XMLHttpRequest|WebSocket|Deno|Bun|globalThis|global|window|self|Buffer|__dirname|__filename)(?!${WORD_CHAR})|(?<!${WORD_CHAR})import\\s*[(.]`,
      anywhere: `child_process|["'\`]node:|(?<!${WORD_CHAR})from\\s*["'\`](?:node:)?(?:fs|child_process|net|http2?|https|os|vm|worker_threads|cluster|dgram|dns|tls|module|process|v8|inspector|repl)(?:/[A-Za-z0-9_/]*)?["'\`]`,
      detail:
        "a generated spec reaching the Node runtime can run processes, read files and send the operator's credentials anywhere",
    },
  ],
  [
    "set-roles",
    {
      category: "privilege-escalation",
      anywhere: word("setRoles"),
      detail:
        "granting roles moves the run outside the identity it was authorised with",
    },
  ],
  [
    "impersonate",
    {
      category: "privilege-escalation",
      anywhere: `\\.\\s*impersonate[A-Za-z0-9_$]*`,
      detail: "impersonation runs the rest of the test as somebody else",
    },
  ],
  [
    "glide-impersonate",
    {
      category: "privilege-escalation",
      anywhere: word("GlideImpersonate"),
      detail: "impersonation runs the rest of the test as somebody else",
    },
  ],
  [
    "role-table",
    {
      category: "privilege-escalation",
      anywhere: word("sys_user_has_role"),
      detail:
        "sys_user_has_role is the role-grant table; a test that touches it is a test that changes who can do what",
    },
  ],
  [
    "gs-email",
    {
      category: "unrollbackable-side-effect",
      anywhere: `${GS_DOT}email`,
      detail:
        "mail is a DR-5 exception table: the rollback does not unsend it, so the side effect outlives the test",
    },
  ],
  [
    "gs-event-queue",
    {
      category: "unrollbackable-side-effect",
      // Delegated decision 2026-09-26: the bare word, not `gs.eventQueue`, so
      // an aliased `gs` (`g.eventQueue(…)`) and `eventQueueScheduled` fire.
      anywhere: `(?<!${WORD_CHAR})eventQueue[A-Za-z0-9_$]*`,
      detail:
        "queued events survive the rollback and fire against whatever ran the test",
    },
  ],
  [
    "glide-email-outbound",
    {
      category: "unrollbackable-side-effect",
      anywhere: word("GlideEmailOutbound"),
      detail: "mail is a DR-5 exception table and is never rolled back",
    },
  ],
  [
    "sysevent-table",
    {
      category: "unrollbackable-side-effect",
      anywhere: word("sysevent"),
      detail:
        "the event queue is a DR-5 exception table and is not rolled back",
    },
  ],
  [
    "ecc-queue-table",
    {
      category: "unrollbackable-side-effect",
      anywhere: word("ecc_queue"),
      detail:
        "the ECC queue is a DR-5 exception table; a row written there reaches a MID server the rollback cannot recall",
    },
  ],
  [
    "encoded-decoder",
    {
      category: "dynamic-code",
      anywhere: `(?<!${WORD_CHAR})(?:String\\s*\\.\\s*fromCharCode|atob|unescape|decodeURIComponent|decodeURI)${INVOKE}`,
      detail:
        "decoding a string at run time is how a denied name is smuggled past a lexical deny-list; a generated test has no reason to build identifiers",
    },
  ],
];

/**
 * Every deny pattern, compiled once without `/g`, for the one caller that asks
 * "would this literal member name be denied if it were spelled `.name`?" — see
 * `literalKeyIsSafe`.
 */
const DENY_PROBES: readonly RegExp[] = DENY_TABLE.flatMap(([, rule]) =>
  [rule.code, rule.anywhere]
    .filter((source): source is string => source !== undefined)
    .map((source) => new RegExp(source)),
);

/** Constant sentences for the structural rules, kept beside the deny-list ones. */
const STRUCTURAL_DETAILS: Readonly<Record<string, string>> = {
  "blank-source":
    "the source is blank; there is nothing to gate and nothing to run",
  "oversize-source": `the source is over ${MAX_GATED_SOURCE_CHARS} characters, past the point where a reviewer reads it to the end`,
  "unterminated-string":
    "a quoted string is still open at the end of the source, so every code/text verdict after it is a guess",
  "unterminated-template":
    "a template literal is still open at the end of the source, so every code/text verdict after it is a guess",
  "unterminated-comment":
    "a block comment is still open at the end of the source, so the rest of the file was never scanned as code",
  "unterminated-regex":
    "a regex literal is broken by a line end or the end of the source, so every code/text verdict after it is a guess",
  "ambiguous-slash":
    "a slash appears where it could be division or the start of a regex literal and the lexer cannot tell which; either wrong guess hides code from the deny-list",
  "unbalanced-brackets":
    "brackets do not balance, which means the lexer's idea of where code begins and ends does not match the file's",
  "control-character":
    "a C0 control character outside tab/newline/carriage-return is present; it renders as nothing and hides whatever follows it on the line",
  "zero-width-character":
    "a zero-width character is present, which can split a denied name into two halves that no rule matches",
  "bidi-control-character":
    "a bidirectional control character is present, which makes the rendered order of the line differ from the order it executes in",
  "escape-obfuscation":
    "a numeric character escape is present inside a string literal; it is how a denied name is written so that no rule matches it",
  "computed-call":
    "a call through a computed member name cannot be resolved lexically, so the deny-list cannot be consulted about it at all",
  "computed-name-concat":
    "a member name is built by concatenation, which is the direct way to spell a denied call the deny-list will not see",
  "computed-member":
    "a member is read through a computed key that is not a digit run or a plain quoted name the deny-list admits, so which member it reaches cannot be known lexically",
  destructuring:
    "a destructuring pattern reads members by name without a `.name` token, which is an alias the deny-list cannot follow",
  "identifier-escape":
    "a backslash appears in code, which is an identifier escape: the engine decodes it into a name no rule can see spelled out",
  "html-comment":
    "an HTML-like comment (`<!--`, or `-->` at a line start) is present; engines disagree on where it ends, and a wrong guess hides code from the deny-list",
  hashbang:
    "the source starts with a hashbang line, which Rhino does not accept and this pipeline never generates",
  "string-line-break":
    "a quoted string contains a raw line break, which the engine rejects and which makes the rest of the file a guess",
};

function structural(rule: GateRuleName, line: number): GateViolation {
  return {
    rule,
    category: "unparseable",
    line,
    detail: STRUCTURAL_DETAILS[rule] ?? rule,
  };
}

/**
 * Per-index classification, as `@tessera/impact`'s `lexScript` reports it.
 * Four values: comments and strings differ, and a regex literal is neither.
 */
const STRING = LEX_STRING;
const CODE = LEX_CODE;
const COMMENT = LEX_COMMENT;

/**
 * Offsets at which each line begins, in a pass of its own.
 *
 * Counting newlines inside the lexer would mean incrementing a line number in
 * six branches, one of which consumes two characters at a time — and a line
 * counter that is wrong by one in the escape branch produces violations
 * pointing at the wrong line, which is worse than no line at all. Only `\n` is
 * counted, so a `\r\n` file comes out right.
 */
function lineStartsOf(source: string): readonly number[] {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charAt(i) === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * One left-to-right pass: classify every index and track bracket depth over
 * code positions — delegated to `lexScript` in `@tessera/impact`, the one
 * lexer the workspace owns, so the gate and the impact scanner cannot drift
 * apart on what counts as code.
 *
 * Unlike the impact scanner this caller asks for NO recovery. A quoted string
 * still open at a newline stays open, and the caller rejects the source for it.
 * Recovery is right when the job is to describe a script somebody else owns and
 * wrong when the job is to admit one into a repository: a recovered lex
 * silently converts "I lost track" into "I found nothing".
 *
 * Template substitutions (`${…}`) are lexed as code, nested templates and all,
 * and regex literals are lexed as regex literals. Before 2026-09-25 neither
 * was, and both were deny-list bypasses: `` `${eval(x)}` `` read as string
 * content, and `var a = /"/; eval(x); var b = /"/;` read as one long string.
 * Where regex-versus-division cannot be decided from the previous token the
 * lexer reports it and `inspectGeneratedSource` rejects (`ambiguous-slash`).
 */
function lex(source: string): ScriptLexResult {
  return lexScript(source, { recoverAtNewline: false });
}

/** The 1-based line holding `index`, by binary search over the line starts. */
function lineAt(starts: readonly number[], index: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    const start = starts[middle];
    if (start !== undefined && start <= index) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

const WHITESPACE = /\s/;

function skipWhitespace(source: string, from: number): number {
  let i = from;
  while (i < source.length && WHITESPACE.test(source.charAt(i))) i += 1;
  return i;
}

/**
 * Characters a lexical gate cannot reason about, and therefore refuses.
 *
 * Each one is a documented way to make rendered text differ from executed text:
 * zero-width characters split a denied identifier in two, bidi controls reorder
 * a line for the human without reordering it for the engine, and C0 controls
 * simply do not render. A gate whose whole method is "read the characters"
 * cannot be right about a file whose characters lie about themselves.
 */
function scanCharacters(
  source: string,
  starts: readonly number[],
): readonly GateViolation[] {
  const found: GateViolation[] = [];
  const seen = new Set<GateRuleName>();
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    let rule: GateRuleName | undefined;
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0x7f
    ) {
      rule = "control-character";
    } else if (
      code === 0x200b ||
      code === 0x200c ||
      code === 0x200d ||
      code === 0xfeff
    ) {
      rule = "zero-width-character";
    } else if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x200e ||
      code === 0x200f
    ) {
      rule = "bidi-control-character";
    }
    // One report per class. Fifty zero-width characters are one fact about the
    // file, and fifty rows would bury the other rules under them.
    if (rule !== undefined && !seen.has(rule)) {
      seen.add(rule);
      found.push(structural(rule, lineAt(starts, i)));
    }
  }
  return found;
}

/**
 * `\xNN`, `\uNNNN` and `\u{…}` inside string positions. The same escapes in
 * CODE positions are identifier escapes and are refused earlier, as
 * `identifier-escape`, from the lexer's `codeBackslashAt`.
 */
const ESCAPE_PATTERN = /\\(?:x[0-9A-Fa-f]{2}|u\{?[0-9A-Fa-f])/g;

function scanEscapes(
  source: string,
  flags: Uint8Array,
  starts: readonly number[],
): readonly GateViolation[] {
  const pattern = new RegExp(ESCAPE_PATTERN.source, "g");
  for (
    let hit = pattern.exec(source);
    hit !== null;
    hit = pattern.exec(source)
  ) {
    if (flags[hit.index] !== STRING) continue;
    return [structural("escape-obfuscation", lineAt(starts, hit.index))];
  }
  return [];
}

/**
 * Words after which `[` opens an array literal, not a subscript: `return [a]`
 * is a value, `rows[a]` is a member read.
 */
const LITERAL_AFTER_KEYWORD = new Set([
  "return",
  "typeof",
  "in",
  "of",
  "case",
  "yield",
  "await",
  "void",
  "delete",
  "new",
  "else",
  "do",
  "instanceof",
  "throw",
]);

/** A digit run, or a plain quoted name in the charset a member name uses. */
const LITERAL_KEY = /^(?:[0-9]+|(['"])([A-Za-z0-9_ .:/-]*)\1)$/;

/**
 * Delegated decision 2026-09-26: a subscript key is admitted only if it is a
 * digit run (`rows[0]`) or a plain single- or double-quoted literal
 * (`map["key"]`) whose name, spelled as `.name`, fires no deny rule. So
 * `gr["deleteMultiple"]` is refused here as well as by the name rule, and
 * `gr[k]` is refused whatever `k` is — the gate cannot know.
 */
function literalKeyIsSafe(key: string): boolean {
  const match = LITERAL_KEY.exec(key);
  if (match === null) return false;
  const name = match[2];
  if (name === undefined) return true;
  const spelled = `.${name}`;
  return !DENY_PROBES.some((probe) => probe.test(spelled));
}

/**
 * In a string or a comment: `x[name]` or `x[… + …]`. A YAML spec is lexed as
 * JS, so a double-quoted YAML scalar holding a whole script is ONE string to
 * this file, and this is the only structural look it gets. A CSS attribute
 * selector (`input[name="x"]`) does not match: its key is not a bare name.
 */
const TEXT_SUBSCRIPT =
  /[A-Za-z0-9_$)\]]\s*(?:\?\.)?\[\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\s*\]|[^\]\n]*\+)/g;

/**
 * Computed member access, judged by what follows it and by what is in it.
 *
 * `rows[0]` and `map["key"]` are ordinary and pass. `obj[name]()` and
 * `gr["ins" + "ert"]()` do not — a computed CALL is a call whose target the
 * deny-list can never be consulted about (`computed-call`), and concatenation
 * inside a subscript is the direct way to spell a denied name one character at
 * a time (`computed-name-concat`). Since W7b, a computed READ whose key is not
 * a safe literal is refused too (`computed-member`): `var m = gr[k];
 * m.call(gr)` reached `deleteMultiple` with the call two statements away from
 * the subscript. Object and class computed keys (`{ [name]: 1 }`) and optional
 * subscripts (`gr?.[k]`) are the same construct.
 *
 * A false positive here costs a reviewer one rewrite. A false negative costs
 * the deny-list all of its value at once, which is why the asymmetry is
 * resolved this way.
 */
function scanComputedAccess(
  source: string,
  flags: Uint8Array,
  starts: readonly number[],
): readonly GateViolation[] {
  const found: GateViolation[] = [];
  const seen = new Set<GateRuleName>();

  const report = (rule: GateRuleName, index: number): void => {
    if (seen.has(rule)) return;
    seen.add(rule);
    found.push(structural(rule, lineAt(starts, index)));
  };

  for (let i = 0; i < source.length; i += 1) {
    if (source.charAt(i) !== "[" || flags[i] !== CODE) continue;

    let before = i - 1;
    while (before >= 0 && WHITESPACE.test(source.charAt(before))) before -= 1;
    const prev = before >= 0 ? source.charAt(before) : "";

    // What precedes the `[` decides what it is. An identifier, a closing
    // bracket or paren, the end of a string or template, or `?.` means a
    // subscript — unless the identifier is a keyword after which `[` starts an
    // array literal. `{` or `,` (or `}`/`;` in a class body) followed by a
    // `]` then `:` or `(` is a computed key.
    let isSubscript = false;
    let isKeyCandidate = false;
    if (/[A-Za-z0-9_$]/.test(prev)) {
      let wordStart = before;
      while (
        wordStart > 0 &&
        /[A-Za-z0-9_$]/.test(source.charAt(wordStart - 1))
      ) {
        wordStart -= 1;
      }
      const preceding = source.slice(wordStart, before + 1);
      const dotted =
        wordStart > 0 && source.charAt(skipBack(source, wordStart - 1)) === ".";
      isSubscript = dotted || !LITERAL_AFTER_KEYWORD.has(preceding);
    } else if (
      prev === ")" ||
      prev === "]" ||
      prev === "'" ||
      prev === '"' ||
      prev === "`"
    ) {
      isSubscript = true;
    } else if (
      prev === "." &&
      before > 0 &&
      source.charAt(before - 1) === "?"
    ) {
      isSubscript = true;
    } else if (prev === "{" || prev === "," || prev === "}" || prev === ";") {
      isKeyCandidate = true;
    }
    if (!isSubscript && !isKeyCandidate) continue;

    let depth = 0;
    let end = -1;
    let concatenates = false;
    for (let j = i; j < source.length; j += 1) {
      if (flags[j] !== CODE) continue;
      const ch = source.charAt(j);
      if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      } else if (ch === "+" && depth === 1) {
        concatenates = true;
      }
    }
    if (end === -1) {
      // An unclosed subscript in code position: the balance check has already
      // caught it, but reporting it here too would be a second row for one
      // fault. Leave it to `unbalanced-brackets`.
      continue;
    }
    const after = source.charAt(skipWhitespace(source, end + 1));
    if (isKeyCandidate) {
      // `{ [k]: v }`, `{ [k]() {} }`: a computed key. Anything else after a
      // `{` or `,` is an array literal (`f(a, [b])`, `{ a: [1] }` is `:`-led).
      if (after !== ":" && after !== "(") continue;
    }
    const key = source.slice(i + 1, end).trim();
    if (concatenates) report("computed-name-concat", i);
    if (isSubscript && after === "(") report("computed-call", i);
    if (isKeyCandidate || !literalKeyIsSafe(key)) {
      report("computed-member", i);
    }
  }

  // Text positions: a YAML scalar or a comment carrying `x[name]`.
  const text = new RegExp(TEXT_SUBSCRIPT.source, "g");
  for (let hit = text.exec(source); hit !== null; hit = text.exec(source)) {
    const at = hit.index;
    if (flags[at] === STRING || flags[at] === COMMENT) {
      report("computed-member", at);
      break;
    }
  }

  return found;
}

/** The index of the last non-whitespace character at or before `from`. */
function skipBack(source: string, from: number): number {
  let i = from;
  while (i > 0 && WHITESPACE.test(source.charAt(i))) i -= 1;
  return i;
}

/** `var {`, `let [`, `const {` — a declaration that destructures. */
const DESTRUCTURING_DECLARATION = new RegExp(
  `(?<!${WORD_CHAR})(?:var|let|const)\\s*[\\[{]`,
  "g",
);

/** `} =` — an assignment pattern (`({ a: d } = gr)`), not `}==` or `} =>`. */
const DESTRUCTURING_ASSIGNMENT = /\}\s*=(?![=>])/g;

/**
 * Delegated decision 2026-09-26: every destructuring pattern is refused.
 * `var { deleteMultiple: d } = gr; d.call(gr)` reads a denied member with no
 * `.deleteMultiple` token, and a key-renaming pattern can carry any name. A
 * declaration pattern is refused wherever it appears (a YAML scalar is a
 * string to this file); an assignment pattern is refused when both its `}`
 * and its `=` are code. Parameter patterns (`async ({ page }) =>`) are not
 * matched: they destructure the caller's argument, not a Glide object.
 */
function scanDestructuring(
  source: string,
  flags: Uint8Array,
  starts: readonly number[],
): readonly GateViolation[] {
  const declaration = new RegExp(DESTRUCTURING_DECLARATION.source, "g");
  const first = declaration.exec(source);
  if (first !== null) {
    return [structural("destructuring", lineAt(starts, first.index))];
  }
  const assignment = new RegExp(DESTRUCTURING_ASSIGNMENT.source, "g");
  for (
    let hit = assignment.exec(source);
    hit !== null;
    hit = assignment.exec(source)
  ) {
    const equals = hit.index + hit[0].length - 1;
    if (flags[hit.index] === CODE && flags[equals] === CODE) {
      return [structural("destructuring", lineAt(starts, hit.index))];
    }
  }
  return [];
}

/**
 * The source with every comment position replaced by a space. Same length, so
 * every index still means the same thing.
 *
 * Delegated decision 2026-09-26: the code-scoped patterns read this
 * projection, so a comment between the tokens of a call
 * (`gr./* x *\/deleteMultiple()`, `eval /* x *\/ (y)`) is whitespace to the
 * patterns, as it is to the engine.
 */
function blankComments(source: string, flags: Uint8Array): string {
  let out = "";
  let runStart = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (flags[i] === COMMENT) {
      out += source.slice(runStart, i) + " ";
      runStart = i + 1;
    }
  }
  return out + source.slice(runStart);
}

/** The earliest index at which `pattern` matches `text` where `admit` agrees. */
function firstHit(
  pattern: string,
  text: string,
  admit: (index: number) => boolean,
): number {
  const regex = new RegExp(pattern, "g");
  for (let hit = regex.exec(text); hit !== null; hit = regex.exec(text)) {
    if (admit(hit.index)) return hit.index;
    // A zero-length match would never advance; none of the patterns has one,
    // but a loop that relies on that is one edit away from hanging.
    if (hit[0].length === 0) regex.lastIndex += 1;
  }
  return -1;
}

function scanDenyList(
  original: string,
  flags: Uint8Array,
  starts: readonly number[],
): readonly GateViolation[] {
  const projection = blankComments(original, flags);
  const isCode = (index: number): boolean => flags[index] === CODE;
  const always = (): boolean => true;
  const found: GateViolation[] = [];
  for (const [name, rule] of DENY_TABLE) {
    const hits: number[] = [];
    if (rule.code !== undefined) {
      hits.push(firstHit(rule.code, projection, isCode));
    }
    if (rule.anywhere !== undefined) {
      hits.push(firstHit(rule.anywhere, original, always));
      hits.push(firstHit(rule.anywhere, projection, isCode));
    }
    const earliest = hits
      .filter((index) => index >= 0)
      .reduce((left, right) => Math.min(left, right), Number.POSITIVE_INFINITY);
    if (earliest === Number.POSITIVE_INFINITY) continue;
    // One row per rule: a loop with forty inserts is one finding.
    found.push({
      rule: name,
      category: rule.category,
      line: lineAt(starts, earliest),
      detail: rule.detail,
    });
  }
  return found;
}

const CATEGORY_ORDER: Readonly<Record<GateCategory, number>> = {
  unparseable: 0,
  "dynamic-code": 1,
  "unbounded-dml": 2,
  "integrity-bypass": 3,
  outbound: 4,
  "privilege-escalation": 5,
  "unrollbackable-side-effect": 6,
};

/**
 * Deterministic order: category first (structural faults lead, because a
 * rejected lex makes everything under it provisional), then line, then rule
 * name. A CI annotation that reorders between runs is a diff nobody can read.
 */
function order(violations: readonly GateViolation[]): GateViolation[] {
  return [...violations].sort(
    (left, right) =>
      CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category] ||
      left.line - right.line ||
      (left.rule < right.rule ? -1 : left.rule > right.rule ? 1 : 0),
  );
}

const CLEARANCE = Object.freeze({}) as unknown as GateClearance;

/**
 * Inspect one generated source against the TM-3 deny-list and the fail-closed
 * structural rules.
 *
 * Pure, hermetic and deterministic: no clock, no filesystem, no network, and
 * the same input always produces the same verdict in the same order — which is
 * what lets the whole gate be exercised in CI without an instance.
 *
 * Read the file header before treating `{ ok: true }` as an assurance. It means
 * no rule fired.
 */
export function inspectGeneratedSource(source: Untrusted<string>): GateVerdict {
  const text = unwrapUntrusted(source, GATE_BOUNDARY);

  if (text.trim() === "") {
    return { ok: false, violations: [structural("blank-source", 0)] };
  }
  if (text.length > MAX_GATED_SOURCE_CHARS) {
    return { ok: false, violations: [structural("oversize-source", 0)] };
  }

  const lineStarts = lineStartsOf(text);
  const {
    kinds: flags,
    endState,
    unbalancedAt,
    ambiguousSlashAt,
    unterminatedRegexAt,
    codeBackslashAt,
    htmlCommentAt,
    hashbangAt,
    stringLineBreakAt,
  } = lex(text);

  const violations: GateViolation[] = [];
  if (endState === "single-quote" || endState === "double-quote") {
    violations.push(structural("unterminated-string", lineStarts.length));
  } else if (endState === "template") {
    violations.push(structural("unterminated-template", lineStarts.length));
  } else if (endState === "block-comment") {
    violations.push(structural("unterminated-comment", lineStarts.length));
  }
  // Delegated decision 2026-09-25 (fail closed): a regex literal the lexer
  // could not close, and a `/` it could not classify, are both rejections. The
  // lexer's guess after either point decides what is code, and the deny-list
  // must never be consulted against a guess.
  if (unterminatedRegexAt >= 0) {
    violations.push(
      structural(
        "unterminated-regex",
        lineAt(lineStarts, Math.min(unterminatedRegexAt, text.length - 1)),
      ),
    );
  }
  if (ambiguousSlashAt >= 0) {
    violations.push(
      structural("ambiguous-slash", lineAt(lineStarts, ambiguousSlashAt)),
    );
  }
  if (unbalancedAt >= 0) {
    violations.push(
      structural("unbalanced-brackets", lineAt(lineStarts, unbalancedAt)),
    );
  }
  // Delegated decision 2026-09-26 (fail closed): a backslash in code is an
  // identifier escape the engine decodes and the deny-list cannot read, so it
  // is refused outright rather than decoded — a generated spec never needs one.
  if (codeBackslashAt >= 0) {
    violations.push(
      structural("identifier-escape", lineAt(lineStarts, codeBackslashAt)),
    );
  }
  // Delegated decision 2026-09-26 (fail closed): HTML-like comments and a
  // hashbang are refused outright even though the lexer now models them.
  // Engines differ at the edges of Annex B, Rhino rejects `#!`, and no
  // generated spec has a reason to contain either.
  if (htmlCommentAt >= 0) {
    violations.push(
      structural("html-comment", lineAt(lineStarts, htmlCommentAt)),
    );
  }
  if (hashbangAt >= 0) {
    violations.push(structural("hashbang", 1));
  }
  // Delegated decision 2026-09-26 (fail closed): a raw line terminator in a
  // quoted string is refused, U+2028/U+2029 included. ES2019 allows those two,
  // ES5/Rhino does not; without recovery the lexer reads the string on into
  // the next line, and that is the reading the deny-list must not trust.
  if (stringLineBreakAt >= 0) {
    violations.push(
      structural("string-line-break", lineAt(lineStarts, stringLineBreakAt)),
    );
  }
  violations.push(...scanCharacters(text, lineStarts));

  // The deny-list is consulted ONLY when the lex is trustworthy. Running it over
  // a desynchronised classification would produce a clean report from a file
  // nobody read correctly, and a clean report is the one answer this gate must
  // never give by accident.
  if (violations.length === 0) {
    violations.push(...scanEscapes(text, flags, lineStarts));
    violations.push(...scanComputedAccess(text, flags, lineStarts));
    violations.push(...scanDestructuring(text, flags, lineStarts));
    violations.push(...scanDenyList(text, flags, lineStarts));
  }

  if (violations.length > 0) {
    return { ok: false, violations: order(violations) };
  }

  return {
    ok: true,
    cleared: {
      source,
      clearance: CLEARANCE,
      lines: lineStarts.length,
      characters: text.length,
    },
  };
}

/**
 * The port shape DESIGN §9.3 names. It exists so `./generator.ts` can be handed
 * a stricter gate in a test without knowing which one it got (ARCH-1).
 */
export function createGeneratedCodeGate(): GeneratedCodeGate {
  return { inspect: inspectGeneratedSource };
}

/** Every rule this gate can report, for a caller that wants to enumerate them. */
export function gateRuleNames(): readonly GateRuleName[] {
  const structuralRules = Object.keys(STRUCTURAL_DETAILS) as GateRuleName[];
  const denyRules = DENY_TABLE.map(([name]) => name);
  return [...denyRules, ...structuralRules].sort();
}
