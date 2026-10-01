// The scanner — one script body, one pass, and a deliberately small answer
// (PLAN Phase 3, DESIGN §12.3 row 3).
//
// Everything the ImpactAnalyzer ever learns about a consumer script it learns
// here: where the searched names appear in it, what kind of evidence each
// occurrence is, and whether the script does anything that makes the ABSENCE of
// a name meaningless (QA-9). The function is pure and does no I/O at all, which
// is what lets the interesting half of Phase 3 be tested exhaustively without an
// instance anywhere in the picture.
//
// TM-1 — the workspace has exactly one door out of `Untrusted<T>`: the
// `unwrapUntrusted` function itself, in `@tessera/types`. Every call through
// it must name the boundary it crosses. This file holds one of those calls,
// so it owes the reader the argument for why that door opens here. Do not
// restate how many call sites exist — a count is a measurement and needs a
// date; an invariant is a contract and needs a test.
//
// Which half of TM-1 you may lean on:
//
// MECHANICAL, and tested. `unwrapUntrusted` throws on a blank boundary and
// on a value never minted by `untrusted()` — the brand is a module-private
// runtime marker (a WeakSet in `@tessera/types`), not a type-only fiction, so
// a lying cast or a hand-rolled `{ value }` is caught at the door it walks
// through instead of surfacing as `undefined` much later. No `isUntrusted`
// guard is provided, deliberately: it would be a second door. Which files may
// unwrap at all, and that each call passes a named UPPER_SNAKE boundary
// constant rather than a literal, is pinned by
// `types/test/unwrapAllowList.test.js` (delegated decision 2026-09-23) —
// this file's call is one line of that list.
//
// EDITORIAL, and upheld by review alone. Nothing checks that the unwrapped
// text does not flow onward into a prompt, a log, or an error message, and
// `JSON.stringify` on a branded value still emits the raw text (a written
// concession in `untrusted.ts`). And the boundary sentence being TRUE is a
// claim about a function's outputs — not machine-checkable at any price.
// Each function's own structure upholds that; nothing cross-function does.
// This half was last read end to end on 2026-08-30 and held. That is an
// audit, not enforcement, and audits have dates.
//
// DESIGN §9.1 classifies a script body read off an instance as untrusted input:
// anyone holding write access on `source` authored it, and its comments and
// string literals are attacker-controllable. §9.2 walks the chain that follows
// if such a string reaches a generation prompt unmarked — the model reads an
// embedded imperative as an instruction, emits a "Run Server Side Script" ATF
// step carrying the hostile body, and the runner executes it with real
// privileges. DEV-4's rollback envelope is no answer to that: DR-5 lists tables
// (Email, ECC Queue, History) that are never rolled back, so an injected step
// signals or exfiltrates long before the transaction unwinds.
//
// The unwrap is honest here because of what LEAVES this function: line numbers,
// `MatchKind` values, and marker labels taken from a constant in this package —
// plus `ScanMatch.name`, which is the CALLER'S own searched string echoed back
// rather than a slice of the body. No excerpt, no context line, no "found near
// …". That is also why `ScanMatch` carries no excerpt field at all: the safe
// report had to be the only representable one, not merely the recommended one.
// Nothing in here logs the body, interpolates it into a message, or throws with
// it either — an error quoting the offending line would re-open precisely the
// hole the brand closes.
//
// The analysis is a single left-to-right lex of the body into `code` and `text`
// positions (`./lex.ts`, shared with the generated-code gate), followed by one
// regex sweep per searched name consulted against that map. Template
// substitutions are code and regex literals are lexed as regex literals; where
// the lexer cannot decide (a `/` after `}`, a broken regex, a string recovered
// at a newline) it says so, and the dynamic-dispatch sweep stops trusting the
// classification from that point on. The residual imprecision is in the name
// matches only, and it errs toward the weaker claim.
//
// Since 2026-09-26 (review W4a) the sweeps run over a decoded view of the body:
// code-position identifier escapes (`eval`) are replaced by the characters
// the engine reads, with an offset map back to the original for flags and line
// numbers. HTML-like comments (`<!--`, line-start `-->`) and a leading `#!` are
// lexed as the line comments they are, and every one of these constructs is
// also a lex doubt.

import type { Untrusted } from "@tessera/types";
import { unwrapUntrusted } from "@tessera/types";

import { LEX_CODE, firstLexDoubt, lexScript } from "./lex.js";
import { DYNAMIC_DISPATCH_MARKERS } from "./types.js";
import type {
  DynamicDispatchMarker,
  DynamicDispatchMarkerName,
  MatchKind,
  ScanMatch,
  ScanResult,
} from "./types.js";

/**
 * The boundary argument for the one unwrap, written so that a reviewer who
 * greps for `unwrapUntrusted` across the workspace can decide this call on the
 * strength of the sentence alone. It is a claim about the function's outputs,
 * and the rest of this file exists to keep it true.
 */
const SCAN_BOUNDARY =
  "impact scanner — the body is matched by regex and only line numbers and enum values leave this function; no instance text is returned, logged, or interpolated (TM-1)";

/**
 * What may not flank a match. JavaScript identifiers admit `$` and `_`, and
 * leaving either out would let `Foo` match inside `$Foo` and report an edge to
 * an artifact that is not being used at all.
 */
const WORD_CHAR = "[A-Za-z0-9_$]";

const IDENTIFIER_START = /[A-Za-z_$]/;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/;
const WHITESPACE = /\s/;

/**
 * The per-index verdict of the lexer. A byte array rather than a `Set` of
 * indices because a script body is tens of thousands of characters and the
 * lookup happens once per match: one allocation of n bytes buys O(1) answers
 * and keeps the whole scan linear in the length of the body.
 */
const TEXT = 0;
const CODE = 1;

/**
 * The dynamic-dispatch patterns, kept as regex SOURCE strings rather than as
 * `RegExp` objects.
 *
 * A `/g` regex carries `lastIndex` between calls, so a module-level instance
 * shared across two script bodies would make the second scan's result depend on
 * where the first one stopped — a bug that only shows up under load, in the
 * shape of a marker that is silently missed. Compiling per scan costs five
 * regex compilations per script and removes the hazard entirely.
 *
 * The keys are the labels from `DYNAMIC_DISPATCH_MARKERS`, which stays the
 * public vocabulary: `types.ts` says WHAT is looked for, this table says how.
 * The `Record` is keyed by that union rather than by `string`, so extending the
 * vocabulary without extending this table is a compile error — the one failure
 * mode worth designing against here is a marker that is advertised as searched
 * for and is not, because its whole job is to stop a negative result being
 * believed (QA-9).
 *
 * The two evaluator classes match on a bare word boundary because there is no
 * harmless way to mention them in code — naming the class is already the
 * intent. The other three require call position, and that requirement is the
 * whole point: `eval` alone would fire on any variable called `evalCount` or
 * `evaluate`, and a marker that cries wolf is a marker a reader learns to skip
 * past on exactly the run where it mattered. Whitespace is allowed between the
 * tokens of the multi-token markers because `new  Function(` and `gs . include(`
 * are the same construct as their tidy forms and formatting is not evidence.
 *
 * "Call position" is wider than a `(` (review W4a, 2026-09-26). The engine
 * invokes a function through every one of: `f(`, `f?.(`, a tagged template
 * `` f`…` ``, and `f.call` / `f.apply` / `f.bind` (plain or optional). For
 * `eval` alone a closing `)` counts too — `(0, eval)(x)` is the textbook
 * indirect eval, and handing `eval` to anything as an argument is dispatch the
 * scanner cannot follow. The `new Function` label means "the Function
 * constructor": `Function(src)` without `new` builds a function just the same,
 * so the `new` is optional in the pattern even though it stays in the label
 * (`types.ts` owns the vocabulary and is not changed here).
 *
 * Delegated decision 2026-09-26: the widened suffix is applied to `eval`, the
 * Function constructor and `gs.include` alike, and a bare `eval` that is none
 * of these (`var e = eval;`) is still NOT a marker in the scan — the scan's
 * contract is "call position", and the aliasing it would miss is the same
 * aliasing it has always missed for every marker. The generated-code gate,
 * which fails closed on anything it cannot read, refuses the bare word.
 */
const INVOKE_SUFFIX = `\\s*(?:[(\`]|\\?\\.\\s*[(\`]|\\??\\.\\s*(?:call|apply|bind)(?!${WORD_CHAR}))`;

const DYNAMIC_DISPATCH_PATTERNS: Readonly<
  Record<DynamicDispatchMarkerName, string>
> = {
  GlideEvaluator: `(?<!${WORD_CHAR})GlideEvaluator(?!${WORD_CHAR})`,
  GlideScopedEvaluator: `(?<!${WORD_CHAR})GlideScopedEvaluator(?!${WORD_CHAR})`,
  "gs.include": `(?<!${WORD_CHAR})gs\\s*\\??\\.\\s*include${INVOKE_SUFFIX}`,
  eval: `(?<!${WORD_CHAR})eval(?:${INVOKE_SUFFIX}|\\s*\\))`,
  "new Function": `(?<!${WORD_CHAR})(?:new\\s+)?Function${INVOKE_SUFFIX}`,
};

/**
 * Script Include names are identifiers by convention, but nothing on the
 * platform enforces that and the caller hands us whatever `name` the row
 * carried. An unescaped `.` would quietly turn `x.y` into "any character", and
 * an unescaped `(` would turn the query into a syntax error at run time — both
 * of them failures that look like an analysis result rather than like a bug.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-word, global matcher for one literal name. */
function wordPattern(literal: string): RegExp {
  return new RegExp(
    `(?<!${WORD_CHAR})${escapeRegExp(literal)}(?!${WORD_CHAR})`,
    "g",
  );
}

/**
 * Blank and duplicated names are dropped once, before any searching. A repeated
 * name would otherwise double every one of its matches, and the caller — which
 * de-duplicates edges by artifact, not by occurrence — would read that as two
 * independent pieces of evidence. Entries are trimmed because a name that
 * arrived with padding is the same artifact as the one without it, and the
 * trimmed form is what gets echoed back in `ScanMatch.name`, so the reported
 * name is always exactly the text that matched.
 */
function normalizeNames(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Classify every index of the body as code or text.
 *
 * The lexing itself is `./lex.ts`, shared with `@tessera/generate`'s gate so
 * the two cannot drift: template substitutions are code, regex literals are
 * their own kind, and single- or double-quoted strings still open at a newline
 * are closed there (recovery — this stage describes a script it does not
 * control). Everything that is not code collapses to `TEXT` here.
 *
 * `doubtFrom` is the first offset from which the classification is not to be
 * trusted (see `firstLexDoubt`), or -1 for a sound lex.
 */
function classifyPositions(source: string): {
  readonly flags: Uint8Array;
  readonly doubtFrom: number;
  readonly codeBackslashAt: number;
} {
  const lexed = lexScript(source, { recoverAtNewline: true });
  const flags = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    flags[i] = lexed.kinds[i] === LEX_CODE ? CODE : TEXT;
  }
  return {
    flags,
    doubtFrom: firstLexDoubt(lexed),
    codeBackslashAt: lexed.codeBackslashAt,
  };
}

/**
 * The body as the engine reads its identifiers, plus the way back.
 *
 * `text` is the source with every code-position identifier escape
 * (`\uXXXX`, `\u{X…}`) replaced by the character it denotes; `origin[j]` is
 * the offset in the ORIGINAL source that produced `text[j]` (every character of
 * an escape maps to the backslash). Flags and line numbers are always read
 * through `origin`, so they stay facts about the body the instance holds.
 */
interface ScanView {
  readonly text: string;
  readonly origin: Int32Array;
  readonly flags: Uint8Array;
}

const CODE_ESCAPE = /\\u(?:([0-9A-Fa-f]{4})|\{([0-9A-Fa-f]{1,6})\})/y;

/**
 * Build the decoded view. A body with no code-position backslash — nearly all
 * of them — is its own view and costs one identity map.
 *
 * Delegated decision 2026-09-26: identifier escapes are DECODED, not merely
 * flagged. Before this, `\u0065val(x)` was invisible to every sweep: the
 * dynamic-dispatch pattern and the name search read spellings, and the engine
 * reads code points. The lexer's `codeBackslashAt` doubt is kept on top of the
 * decoding (via `firstLexDoubt`), so an escape shape this decoder does not know
 * still makes every later marker count regardless of classification.
 */
function decodeView(
  source: string,
  flags: Uint8Array,
  codeBackslashAt: number,
): ScanView {
  const origin = new Int32Array(source.length);
  if (codeBackslashAt < 0) {
    for (let i = 0; i < source.length; i += 1) origin[i] = i;
    return { text: source, origin, flags };
  }
  let text = "";
  let written = 0;
  let i = 0;
  while (i < source.length) {
    if (source.charAt(i) === "\\" && flags[i] === CODE) {
      CODE_ESCAPE.lastIndex = i;
      const escape = CODE_ESCAPE.exec(source);
      const hex = escape?.[1] ?? escape?.[2];
      const point = hex === undefined ? NaN : Number.parseInt(hex, 16);
      if (escape !== null && point <= 0x10ffff) {
        const decoded = String.fromCodePoint(point);
        text += decoded;
        for (let k = 0; k < decoded.length; k += 1) origin[written++] = i;
        i += escape[0].length;
        continue;
      }
    }
    text += source.charAt(i);
    origin[written++] = i;
    i += 1;
  }
  const viewOrigin = origin.slice(0, written);
  const viewFlags = new Uint8Array(written);
  for (let j = 0; j < written; j += 1) {
    viewFlags[j] = flags[viewOrigin[j] ?? 0] ?? TEXT;
  }
  return { text, origin: viewOrigin, flags: viewFlags };
}

/**
 * Offsets at which each line begins. Only `\n` is counted, which is exactly
 * what makes `\r\n` bodies come out right: the carriage return belongs to the
 * line it terminates, and treating it as a second break would report every line
 * of a Windows-authored script at twice its number.
 */
function lineStarts(source: string): readonly number[] {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charAt(i) === "\n") starts.push(i + 1);
  }
  return starts;
}

/**
 * The 1-based line holding `index`, by binary search over the line starts. A
 * linear count per match would make a body with many matches quadratic in its
 * own length, which is the one performance shape this file must not have.
 */
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

function isCode(flags: Uint8Array, index: number): boolean {
  return flags[index] === CODE;
}

function skipWhitespace(source: string, from: number): number {
  let i = from;
  while (i < source.length && WHITESPACE.test(source.charAt(i))) i += 1;
  return i;
}

/** The index just past an identifier starting at `from`, or `from` if none. */
function skipIdentifier(source: string, from: number): number {
  if (from >= source.length) return from;
  if (!IDENTIFIER_START.test(source.charAt(from))) return from;
  let i = from + 1;
  while (i < source.length && IDENTIFIER_PART.test(source.charAt(i))) i += 1;
  return i;
}

/**
 * Whether what follows a code-position occurrence makes it a CALL.
 *
 * Three shapes count, and they are the three ways a script uses a Script
 * Include: `Name(`, `new Name(` — which arrives here identically, since the
 * `new` sits before the name and changes nothing after it — and `Name.method(`.
 * Anything else is a mention of the identifier: `var x = Name;` may well be a
 * reference, but the call it eventually makes is not visible from here, and
 * `identifier`/`medium` is the honest way to say so.
 *
 * Whitespace is skipped between the tokens, including across newlines, because
 * a call broken over two lines is still a call. Comments are NOT skipped: a
 * `Name /* why *\/ ()` would be read as an identifier. That is the weaker claim
 * again, and the construct is rare enough not to be worth a second lexer pass.
 */
function isCallPosition(source: string, after: number): boolean {
  const afterName = skipWhitespace(source, after);
  if (source.charAt(afterName) === "(") return true;
  if (source.charAt(afterName) !== ".") return false;

  const memberStart = skipWhitespace(source, afterName + 1);
  const memberEnd = skipIdentifier(source, memberStart);
  if (memberEnd === memberStart) return false;
  return source.charAt(skipWhitespace(source, memberEnd)) === "(";
}

/** One occurrence, kept with the offset it was found at so it can be ordered. */
interface LocatedMatch {
  readonly index: number;
  readonly match: ScanMatch;
}

function classifyMatch(
  source: string,
  flags: Uint8Array,
  index: number,
  name: string,
): MatchKind {
  if (!isCode(flags, index)) return "text";
  return isCallPosition(source, index + name.length) ? "call" : "identifier";
}

/**
 * At most one entry per distinct marker, and it is the first occurrence that is
 * kept. A loop containing fifty `eval(` calls is ONE fact about the script —
 * "nothing you fail to find here proves anything" — and fifty identical rows
 * would bury the other four markers under it in the verdict. The list comes
 * back in `DYNAMIC_DISPATCH_MARKERS` order rather than in body order so that
 * adding an `eval` above an existing `GlideEvaluator` does not reshuffle the
 * report and show up in CI as a diff in something that did not change.
 *
 * Only code positions count. A marker named in a comment is prose about
 * dispatch, not dispatch, and treating a `// never use eval here` line as
 * evidence of dynamic dispatch would make the honest scripts the loud ones.
 */
function findDynamicMarkers(
  view: ScanView,
  doubtFrom: number,
  starts: readonly number[],
): readonly DynamicDispatchMarker[] {
  const { text: source, flags, origin } = view;
  const found: DynamicDispatchMarker[] = [];

  for (const marker of DYNAMIC_DISPATCH_MARKERS) {
    // Total by construction: the pattern table is keyed by the marker union, so
    // a marker with no pattern cannot reach here — it fails to compile. There is
    // deliberately no runtime fallback, because both fallbacks available are
    // wrong: skipping the marker leaves it listed as searched for and never
    // searched for (the failure QA-9 forbids), and a coarser whole-word search
    // silently downgrades the precision the table was written to state.
    const pattern = new RegExp(DYNAMIC_DISPATCH_PATTERNS[marker], "g");

    for (
      let hit = pattern.exec(source);
      hit !== null;
      hit = pattern.exec(source)
    ) {
      // Delegated decision 2026-09-25 (fail closed): past the first position the
      // lexer could not account for — an ambiguous `/`, a broken regex, a
      // string recovered at a newline, unbalanced brackets, an unterminated
      // state — a marker counts whatever its classification says. Over-reporting
      // dynamic dispatch weakens a negative result; under-reporting it makes a
      // negative result a lie (QA-9).
      const at = origin[hit.index] ?? hit.index;
      const doubtful = doubtFrom >= 0 && at >= doubtFrom;
      if (!doubtful && !isCode(flags, hit.index)) continue;
      found.push({ marker, line: lineAt(starts, at) });
      break;
    }
  }

  return found;
}

/**
 * Find every occurrence of `names` in one script body, with the evidence class
 * that produced each, plus the dynamic-dispatch markers that decide whether a
 * negative result may be believed.
 *
 * Matches come back in body order and are NOT de-duplicated: the caller builds
 * edges from them and is the only layer that knows whether two occurrences in
 * one field are one edge or two. An empty `names` list still reports markers —
 * dynamic dispatch is a property of the script, not of the search — and an
 * empty body falls out of the general path as an empty result rather than
 * through a special case.
 *
 * @param body The script column exactly as the instance returned it, branded at
 * ingestion. This is the only place in the workspace that opens the brand; see
 * the file header for the argument.
 * @param names The artifact names to look for. Blank entries are dropped and
 * repeats collapse, so a name cannot be counted twice.
 */
export function scanScript(
  body: Untrusted<string>,
  names: readonly string[],
): ScanResult {
  const source = unwrapUntrusted(body, SCAN_BOUNDARY);
  const { flags, doubtFrom, codeBackslashAt } = classifyPositions(source);
  const starts = lineStarts(source);
  const view = decodeView(source, flags, codeBackslashAt);

  const located: LocatedMatch[] = [];
  for (const name of normalizeNames(names)) {
    const pattern = wordPattern(name);
    for (
      let hit = pattern.exec(view.text);
      hit !== null;
      hit = pattern.exec(view.text)
    ) {
      const at = view.origin[hit.index] ?? hit.index;
      located.push({
        index: at,
        match: {
          // The caller's own string, never `source.slice(...)`. Echoing the
          // searched name is what keeps the TM-1 boundary claim above true even
          // though the two strings are equal here by construction.
          name,
          kind: classifyMatch(view.text, view.flags, hit.index, name),
          line: lineAt(starts, at),
        },
      });
    }
  }

  // Body order, and stable: `Array.prototype.sort` has been required to be
  // stable since ES2019, so two names matching at the same offset (`Foo` and
  // `Foo.Bar` both start at one) stay in the order the names were given rather
  // than in whatever order the engine felt like.
  located.sort((left, right) => left.index - right.index);

  return {
    matches: located.map((entry) => entry.match),
    dynamic: findDynamicMarkers(view, doubtFrom, starts),
  };
}
