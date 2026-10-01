// The one script lexer the workspace owns: every index of a script body
// classified as code, string, comment or regex literal, in one left-to-right
// pass.
//
// Two consumers read it, and they want opposite things from a mis-lex:
//
//   * `./scan.ts` (this package) DESCRIBES a script somebody else owns, so it
//     asks for recovery — a quoted string still open at a newline is closed
//     there — and then treats every marker past the first doubtful position as
//     evidence regardless of classification.
//   * `@tessera/generate`'s `gate.ts` ADMITS a script it is about to write to
//     disk, so it asks for no recovery and rejects the source outright on any
//     doubt the lexer reports.
//
// It lives here, and is exported from `@tessera/impact`, because generate
// already depends on impact and impact depends on nothing of generate's: one
// lexer, no new edge, no cycle. Both suites run the same adversarial corpus
// against it (`test/lex.test.js` here, the gate's lexer cases in generate).
//
// What the lexer models, and why each piece exists:
//
//   * Template substitutions. `${…}` inside a template literal is CODE, and it
//     is tracked on the same bracket stack as `(`/`[`/`{`, so a template inside
//     a substitution inside a template — and strings, comments and regexes
//     inside the substitution — all return to the right state. Treating the
//     substitution as string content made `` `${eval(x)}` `` invisible.
//   * Regex literals. `/…/flags` is its own kind, with `\` escapes and `[…]`
//     classes honoured (a `/` inside `[/]` does not end it). Without this a
//     quote inside a regex opened a string that did not exist, and a second
//     regex closed it — `var a = /"/; eval(x); var b = /"/;` read as one long
//     string with no code in it.
//
// Regex versus division is decided by the previous significant token, the way
// the ECMAScript grammar decides it. Getting it wrong in EITHER direction hides
// code: a regex read as division lets its quote open a phantom string, and a
// division read as a regex swallows the code between two slashes. So where the
// previous token does not settle the question, the lexer does not guess: it
// records the position in `ambiguousSlashAt` and the consumer fails closed.
//
// Delegated decision 2026-09-25: the ambiguous cases are (a) a `/` after a
// code-position `}` (block end → regex, object-literal end → division; telling
// them apart needs a parser), (b) a `/` after `yield`, `await` or `of` (keywords
// in some dialects and plain identifiers in ES5/Rhino), and (c) a `/` after any
// character the lexer does not model as a token (`.`, `#`, `@`, `\`, non-ASCII
// punctuation). A `/` after the `)` of `if (…)`, `while (…)`, `for (…)` or
// `with (…)` is a regex; after any other `)` it is division. A `/` after `++`
// or `--` is division (a prefix increment of a regex literal is an early
// error, so the postfix reading is the only legal one).
//
// The owner delegated these calls with the instruction to fail closed: a
// generated spec that trips one is rejected for a human to rewrite, and a
// scanned instance script that trips one has its dynamic-dispatch markers
// counted from that point on regardless of classification.
//
// Three more pieces of the script grammar are modelled, because leaving them
// out let a comment the engine sees be read as code (or the reverse) and hid a
// denied call from both consumers (review W4a, 2026-09-26):
//
//   * HTML-like comments (ECMAScript Annex B, and Rhino). `<!--` anywhere in
//     code opens a line comment; `-->` opens one when nothing but whitespace
//     or comments precedes it on its line. Mid-line, `a-->b` is still `a-- >
//     b`. Both are recorded in `htmlCommentAt`.
//   * A hashbang. `#!` at offset 0 is a line comment, recorded in `hashbangAt`.
//   * A backslash in code. The only legal one is an identifier escape
//     (`\u0065val` is `eval` to the engine), which no spelling-based consumer
//     can see through. The lexer does not decode it; it records the first one
//     in `codeBackslashAt`.
//
// Delegated decision 2026-09-26: each of the four new fields (the three above
// and `stringLineBreakAt`) is a lex doubt reported by `firstLexDoubt`, so the
// scan counts markers past it regardless of classification, and the gate
// refuses the source outright. Engines disagree at the edges of Annex B
// (`-->` at offset 0, `-->` after a same-line block comment), and a doubt is
// the fail-closed answer to a question the lexer cannot settle for Rhino.

/** Per-index classification. The numbers are part of the contract. */
export const LEX_STRING = 0;
export const LEX_CODE = 1;
export const LEX_COMMENT = 2;
export const LEX_REGEX = 3;

export type ScriptLexState =
  | "code"
  | "line-comment"
  | "block-comment"
  | "single-quote"
  | "double-quote"
  | "template"
  | "regex";

export interface ScriptLexOptions {
  /**
   * Close a single- or double-quoted string at a raw newline instead of letting
   * it run on. Only a template may span lines, so an open quote at a newline
   * means the lexer lost track (or the script is broken); recovering confines
   * the damage to one line. The gate passes `false`: it would rather reject.
   */
  readonly recoverAtNewline: boolean;
}

export interface ScriptLexResult {
  /** One `LEX_*` value per index of the source. */
  readonly kinds: Uint8Array;
  /** The state at the end of the source. Anything but `code` is unterminated. */
  readonly endState: ScriptLexState;
  /** Offset where the brackets first went wrong, or -1 if they balanced. */
  readonly unbalancedAt: number;
  /** First `/` whose regex-or-division reading was not decidable, or -1. */
  readonly ambiguousSlashAt: number;
  /** First regex literal broken by a line terminator, or -1. */
  readonly unterminatedRegexAt: number;
  /** First index where `recoverAtNewline` closed a string, or -1. */
  readonly recoveredAt: number;
  /** Where the state still open at the end began, or -1 when it ended in code. */
  readonly unterminatedAt: number;
  /**
   * First raw (unescaped) line terminator inside a single- or double-quoted
   * string, or -1. Reported in BOTH modes: with recovery it equals
   * `recoveredAt`; without it the string runs on and this is the only trace.
   */
  readonly stringLineBreakAt: number;
  /** First `\` in a code position (an identifier escape), or -1. */
  readonly codeBackslashAt: number;
  /** First HTML-like comment opener (`<!--`, or a line-start `-->`), or -1. */
  readonly htmlCommentAt: number;
  /** 0 when the source starts with a `#!` hashbang comment, else -1. */
  readonly hashbangAt: number;
}

/** What a `/` in code position would be if it appeared next. */
type SlashReading = "regex" | "division" | "ambiguous";

interface Opener {
  readonly ch: "(" | "[" | "{" | "${";
  readonly index: number;
  /** A `(` that belongs to `if`/`while`/`for`/`with`: a `/` after its `)` is a regex. */
  readonly keywordParen: boolean;
}

/**
 * Keywords after which an expression — and therefore a regex literal — starts.
 * Taken from the ECMAScript grammar: each of these is followed by an
 * expression, never by an operator.
 */
const REGEX_AFTER_WORDS: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "delete",
  "void",
  "throw",
]);

/**
 * Contextual keywords: an operator-expecting identifier in ES5/Rhino, an
 * expression-expecting keyword in later dialects. See the delegated decision
 * in the file header.
 */
const AMBIGUOUS_AFTER_WORDS: ReadonlySet<string> = new Set([
  "yield",
  "await",
  "of",
]);

/** Keywords whose parenthesised head is followed by a statement, not an operator. */
const STATEMENT_HEAD_WORDS: ReadonlySet<string> = new Set([
  "if",
  "while",
  "for",
  "with",
]);

/** Punctuators after which an expression starts, so `/` opens a regex. */
const REGEX_AFTER_PUNCTUATORS = ",=:!&|?;+-*%<>~^";

const ASCII_WORD = /[A-Za-z0-9_$]/;
const UNICODE_WORD = /[\p{ID_Continue}$\u200c\u200d]/u;
const WHITESPACE = /\s/;

function isWordChar(ch: string): boolean {
  if (ch === "") return false;
  if (ASCII_WORD.test(ch)) return true;
  return ch.charCodeAt(0) > 0x7f && UNICODE_WORD.test(ch);
}

function isLineTerminator(ch: string): boolean {
  return ch === "\n" || ch === "\r" || ch === "\u2028" || ch === "\u2029";
}

/**
 * Lex a script body. Pure and total: any input produces a result, and every
 * doubt is reported through a field rather than resolved silently.
 */
export function lexScript(
  source: string,
  options: ScriptLexOptions,
): ScriptLexResult {
  const kinds = new Uint8Array(source.length);
  const stack: Opener[] = [];
  let unbalancedAt = -1;
  let ambiguousSlashAt = -1;
  let unterminatedRegexAt = -1;
  let recoveredAt = -1;
  let stringLineBreakAt = -1;
  let codeBackslashAt = -1;
  let htmlCommentAt = -1;
  let hashbangAt = -1;
  /**
   * Nothing but whitespace and comments precede this position on its line —
   * the one context in which `-->` opens an HTML-like close comment.
   */
  let atLineStart = true;
  /** Where the current non-code state began. */
  let openedAt = -1;
  let state: ScriptLexState = "code";
  let slash: SlashReading = "regex";
  /** The previous significant token was a `.`, so a word is a property name. */
  let afterDot = false;
  /** The previous significant token, when it was a non-property word. */
  let lastWord: string | null = null;
  let regexInClass = false;
  let i = 0;

  const markUnbalanced = (at: number): void => {
    if (unbalancedAt === -1) unbalancedAt = at;
  };

  while (i < source.length) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);

    if (state === "code") {
      // Delegated decision 2026-09-26: a leading `#!` is a hashbang comment (ES2023
      // grammar; Rhino rejects it). Modelling it as a comment keeps the rest of
      // the lex right, and recording it lets both consumers fail closed.
      if (i === 0 && ch === "#" && next === "!") {
        hashbangAt = 0;
        kinds[0] = LEX_COMMENT;
        kinds[1] = LEX_COMMENT;
        state = "line-comment";
        openedAt = 0;
        i = 2;
        continue;
      }
      // Delegated decision 2026-09-26: `<!--` opens a line comment wherever it
      // appears in code, and `-->` does when only whitespace or comments precede
      // it on its line (Annex B; Rhino supports both). Reading either as
      // operators hid everything on the line — a quote or `/*` after them opened
      // a string or comment the engine never sees.
      const htmlOpen = ch === "<" && source.startsWith("!--", i + 1);
      const htmlClose =
        atLineStart &&
        ch === "-" &&
        next === "-" &&
        source.charAt(i + 2) === ">";
      if (htmlOpen || htmlClose) {
        if (htmlCommentAt === -1) htmlCommentAt = i;
        const width = htmlOpen ? 4 : 3;
        kinds.fill(LEX_COMMENT, i, i + width);
        state = "line-comment";
        openedAt = i;
        i += width;
        continue;
      }
      if (ch === "/" && next === "/") {
        kinds[i] = LEX_COMMENT;
        kinds[i + 1] = LEX_COMMENT;
        state = "line-comment";
        openedAt = i;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        kinds[i] = LEX_COMMENT;
        kinds[i + 1] = LEX_COMMENT;
        state = "block-comment";
        openedAt = i;
        i += 2;
        continue;
      }
      if (WHITESPACE.test(ch)) {
        // Whitespace is code (it is where a match's neighbours live) but not a
        // token: it changes neither the slash reading nor the last word.
        kinds[i] = LEX_CODE;
        if (isLineTerminator(ch)) atLineStart = true;
        i += 1;
        continue;
      }
      // Every branch below consumes a token, so a `-->` after it is mid-line.
      atLineStart = false;
      if (ch === "/") {
        if (slash === "ambiguous" && ambiguousSlashAt === -1) {
          ambiguousSlashAt = i;
        }
        if (slash === "regex") {
          kinds[i] = LEX_REGEX;
          state = "regex";
          openedAt = i;
          regexInClass = false;
          i += 1;
          continue;
        }
        // Division — including the ambiguous case, which the consumer has
        // already been told about and will not trust.
        kinds[i] = LEX_CODE;
        slash = "regex";
        afterDot = false;
        lastWord = null;
        i += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`") {
        kinds[i] = LEX_STRING;
        state =
          ch === "'"
            ? "single-quote"
            : ch === '"'
              ? "double-quote"
              : "template";
        openedAt = i;
        i += 1;
        continue;
      }
      if (isWordChar(ch)) {
        let end = i + 1;
        while (end < source.length && isWordChar(source.charAt(end))) end += 1;
        const word = source.slice(i, end);
        kinds.fill(LEX_CODE, i, end);
        if (afterDot) {
          slash = "division";
          lastWord = null;
        } else {
          slash = REGEX_AFTER_WORDS.has(word)
            ? "regex"
            : AMBIGUOUS_AFTER_WORDS.has(word)
              ? "ambiguous"
              : "division";
          lastWord = word;
        }
        afterDot = false;
        i = end;
        continue;
      }

      kinds[i] = LEX_CODE;
      // Delegated decision 2026-09-26: a `\` in code is an identifier escape
      // (or a syntax error). It is lexed as an unmodelled punctuator, as before,
      // and recorded so the consumers fail closed rather than trust a spelling
      // the engine will decode.
      if (ch === "\\" && codeBackslashAt === -1) codeBackslashAt = i;
      const wasWord = lastWord;
      afterDot = false;
      lastWord = null;

      if (ch === "(" || ch === "[" || ch === "{") {
        stack.push({
          ch,
          index: i,
          keywordParen:
            ch === "(" && wasWord !== null && STATEMENT_HEAD_WORDS.has(wasWord),
        });
        slash = "regex";
        i += 1;
        continue;
      }
      if (ch === ")" || ch === "]") {
        const expected = ch === ")" ? "(" : "[";
        const top = stack[stack.length - 1];
        if (top?.ch === "${") {
          // Never pop a substitution frame for the wrong closer: that would
          // drop the lexer out of the template it is still inside.
          markUnbalanced(i);
          slash = "division";
        } else {
          stack.pop();
          if (top?.ch !== expected) markUnbalanced(i);
          slash =
            ch === ")" && top?.keywordParen === true ? "regex" : "division";
        }
        i += 1;
        continue;
      }
      if (ch === "}") {
        const top = stack.pop();
        if (top?.ch === "${") {
          // The end of a substitution: back into the enclosing template.
          state = "template";
          openedAt = top.index;
          i += 1;
          continue;
        }
        if (top?.ch !== "{") markUnbalanced(i);
        slash = "ambiguous";
        i += 1;
        continue;
      }
      if ((ch === "+" || ch === "-") && next === ch) {
        kinds[i + 1] = LEX_CODE;
        slash = "division";
        i += 2;
        continue;
      }
      if (ch === ".") {
        afterDot = true;
        slash = "ambiguous";
        i += 1;
        continue;
      }
      slash = REGEX_AFTER_PUNCTUATORS.includes(ch) ? "regex" : "ambiguous";
      i += 1;
      continue;
    }

    if (state === "line-comment") {
      if (isLineTerminator(ch)) {
        // The newline ends the comment and belongs to the code around it.
        kinds[i] = LEX_CODE;
        state = "code";
        atLineStart = true;
      } else {
        kinds[i] = LEX_COMMENT;
      }
      i += 1;
      continue;
    }

    if (state === "block-comment") {
      if (ch === "*" && next === "/") {
        kinds[i] = LEX_COMMENT;
        kinds[i + 1] = LEX_COMMENT;
        state = "code";
        i += 2;
        continue;
      }
      // A block comment spanning a line end leaves the lexer at a line start
      // (Annex B: `/*\n*/ -->` is a comment).
      if (isLineTerminator(ch)) atLineStart = true;
      kinds[i] = LEX_COMMENT;
      i += 1;
      continue;
    }

    if (state === "regex") {
      if (isLineTerminator(ch)) {
        // A regex literal cannot span lines. Record it and resume as code; the
        // consumer decides whether that is fatal (the gate) or a doubt (scan).
        if (unterminatedRegexAt === -1) unterminatedRegexAt = i;
        kinds[i] = LEX_CODE;
        state = "code";
        atLineStart = true;
        slash = "regex";
        i += 1;
        continue;
      }
      if (ch === "\\") {
        kinds[i] = LEX_REGEX;
        if (next !== "" && !isLineTerminator(next)) {
          kinds[i + 1] = LEX_REGEX;
          i += 2;
        } else {
          i += 1;
        }
        continue;
      }
      kinds[i] = LEX_REGEX;
      if (regexInClass) {
        if (ch === "]") regexInClass = false;
        i += 1;
        continue;
      }
      if (ch === "[") {
        regexInClass = true;
        i += 1;
        continue;
      }
      if (ch === "/") {
        let end = i + 1;
        while (end < source.length && isWordChar(source.charAt(end))) end += 1;
        kinds.fill(LEX_REGEX, i + 1, end);
        state = "code";
        slash = "division";
        afterDot = false;
        lastWord = null;
        i = end;
        continue;
      }
      i += 1;
      continue;
    }

    // single-quote, double-quote or template
    const quote =
      state === "single-quote" ? "'" : state === "double-quote" ? '"' : "`";

    if (ch === "\\") {
      // The escaped character is consumed with the backslash, so `\"` can never
      // be read as the end of the string and `\${` never opens a substitution.
      kinds[i] = LEX_STRING;
      if (i + 1 < source.length) kinds[i + 1] = LEX_STRING;
      // `\` CR LF is ONE line continuation; consuming only the CR would leave
      // the LF looking like a raw line break in the string.
      if (next === "\r" && source.charAt(i + 2) === "\n") {
        kinds[i + 2] = LEX_STRING;
        i += 3;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === quote) {
      kinds[i] = LEX_STRING;
      state = "code";
      slash = "division";
      afterDot = false;
      lastWord = null;
      i += 1;
      continue;
    }
    if (state === "template" && ch === "$" && next === "{") {
      kinds[i] = LEX_CODE;
      kinds[i + 1] = LEX_CODE;
      stack.push({ ch: "${", index: i, keywordParen: false });
      state = "code";
      slash = "regex";
      afterDot = false;
      lastWord = null;
      i += 2;
      continue;
    }
    // Delegated decision 2026-09-26: a raw line terminator in a quoted string
    // is recorded in both modes, U+2028/U+2029 included (legal since ES2019,
    // illegal in ES5/Rhino). Without recovery the string used to run on silently
    // and swallow the next line, and the gate cleared whatever was on it.
    if (state !== "template" && isLineTerminator(ch)) {
      if (stringLineBreakAt === -1) stringLineBreakAt = i;
    }
    if (
      options.recoverAtNewline &&
      state !== "template" &&
      isLineTerminator(ch)
    ) {
      // Recovery, not grammar: see `ScriptLexOptions.recoverAtNewline`.
      if (recoveredAt === -1) recoveredAt = i;
      kinds[i] = LEX_CODE;
      state = "code";
      atLineStart = true;
      slash = "regex";
      afterDot = false;
      lastWord = null;
      i += 1;
      continue;
    }
    kinds[i] = LEX_STRING;
    i += 1;
  }

  if (state === "regex" && unterminatedRegexAt === -1) {
    unterminatedRegexAt = source.length;
  }

  // An opener with no closer is reported at the opener, which is the line a
  // person has to edit — the end of the file is where the symptom is, not where
  // the mistake is.
  if (stack.length > 0 && unbalancedAt === -1) {
    unbalancedAt = stack[stack.length - 1]?.index ?? 0;
  }

  return {
    kinds,
    endState: state,
    unbalancedAt,
    ambiguousSlashAt,
    unterminatedRegexAt,
    recoveredAt,
    unterminatedAt: state === "code" ? -1 : Math.max(openedAt, 0),
    stringLineBreakAt,
    codeBackslashAt,
    htmlCommentAt,
    hashbangAt,
  };
}

/**
 * The first offset from which the classification cannot be trusted, or -1 when
 * the whole lex is sound. A consumer that must not miss code-position evidence
 * treats everything from here on as possibly code.
 */
export function firstLexDoubt(result: ScriptLexResult): number {
  const doubts = [
    result.unbalancedAt,
    result.ambiguousSlashAt,
    result.unterminatedRegexAt,
    result.recoveredAt,
    result.unterminatedAt,
    result.stringLineBreakAt,
    result.codeBackslashAt,
    result.htmlCommentAt,
    result.hashbangAt,
  ].filter((at) => at >= 0);
  return doubts.length === 0 ? -1 : Math.min(...doubts);
}
