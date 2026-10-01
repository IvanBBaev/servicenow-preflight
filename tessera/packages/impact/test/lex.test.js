// The shared script lexer — the one reading of JavaScript both the generation
// gate (@tessera/generate) and the impact scan use to tell code from text.
import assert from "node:assert/strict";
import test from "node:test";

import {
  LEX_CODE,
  LEX_COMMENT,
  LEX_REGEX,
  LEX_STRING,
  firstLexDoubt,
  lexScript,
} from "../build/index.js";

const STRICT = { recoverAtNewline: false };

/** The lex kind at the first occurrence of `needle` in `source`. */
function kindAt(source, needle, options = STRICT) {
  const index = source.indexOf(needle);
  assert.ok(index >= 0, `${needle} not in ${source}`);
  return lexScript(source, options).kinds[index];
}

test("a clean source ends in code with no doubt", () => {
  const result = lexScript("var a = 1; // c\n/* d */ var b = 'x';", STRICT);
  assert.equal(result.endState, "code");
  assert.equal(firstLexDoubt(result), -1);
  assert.equal(result.unbalancedAt, -1);
});

test("strings, comments and code are told apart", () => {
  const source = "var s = 'str'; // line\n/* block */ call();";
  assert.equal(kindAt(source, "str"), LEX_STRING);
  assert.equal(kindAt(source, "line"), LEX_COMMENT);
  assert.equal(kindAt(source, "block"), LEX_COMMENT);
  assert.equal(kindAt(source, "call"), LEX_CODE);
});

test("a template substitution is code; the template around it is string", () => {
  const source = "var t = `lit ${sub()} lat`;";
  assert.equal(kindAt(source, "lit"), LEX_STRING);
  assert.equal(kindAt(source, "sub"), LEX_CODE);
  assert.equal(kindAt(source, "lat"), LEX_STRING);
  assert.equal(lexScript(source, STRICT).endState, "code");
});

test("a template in a substitution in a template nests correctly", () => {
  const source = "`a ${`b ${deep()} c`} d`; after();";
  assert.equal(kindAt(source, "b "), LEX_STRING);
  assert.equal(kindAt(source, "deep"), LEX_CODE);
  assert.equal(kindAt(source, " c"), LEX_STRING);
  assert.equal(kindAt(source, " d"), LEX_STRING);
  assert.equal(kindAt(source, "after"), LEX_CODE);
  assert.equal(firstLexDoubt(lexScript(source, STRICT)), -1);
});

test("object braces and a quoted brace inside a substitution do not close it", () => {
  const source = "`${ {k: '}'}.k } tail ${x}` + code();";
  assert.equal(kindAt(source, " tail"), LEX_STRING);
  assert.equal(kindAt(source, "code"), LEX_CODE);
  assert.equal(lexScript(source, STRICT).endState, "code");
});

test("a regex literal is one token: quotes and backticks inside it open nothing", () => {
  for (const source of ['var re = /"/; after();', "var re = /`/; after();"]) {
    assert.equal(kindAt(source, "after"), LEX_CODE, source);
    assert.equal(lexScript(source, STRICT).endState, "code");
  }
  assert.equal(kindAt('var re = /"/;', '"'), LEX_REGEX);
});

test("a slash in a class and an escaped slash do not end the regex", () => {
  const cls = 'var re = /[/"]+/gi; after();';
  assert.equal(kindAt(cls, "after"), LEX_CODE);
  assert.equal(kindAt(cls, '"'), LEX_REGEX);
  const esc = 'var re = /a\\/"b/; after();';
  assert.equal(kindAt(esc, '"'), LEX_REGEX);
  assert.equal(kindAt(esc, "after"), LEX_CODE);
});

test("division is not a regex", () => {
  for (const source of [
    'x = a / b / c; s = "q";',
    'x = (a) / 2 / c; s = "q";',
    'x = r[0] / 2 / c; s = "q";',
    'x = i++ / 2 / c; s = "q";',
    'x = "a" / 2 / c; s = "q";',
  ]) {
    const result = lexScript(source, STRICT);
    assert.equal(kindAt(source, "q"), LEX_STRING, source);
    assert.equal(firstLexDoubt(result), -1, source);
    assert.ok(!result.kinds.includes(LEX_REGEX), source);
  }
});

test("keywords and control heads make the next slash a regex", () => {
  for (const source of [
    'return /"/.test(s); after();',
    'if (a) /"/.test(s); after();',
    'while (a) /"/.test(s); after();',
    'x = typeof /"/; after();',
    '/"/.test(s); after();',
  ]) {
    assert.equal(kindAt(source, '"'), LEX_REGEX, source);
    assert.equal(kindAt(source, "after"), LEX_CODE, source);
  }
  // A property that happens to be spelled like a keyword is still a value.
  assert.equal(
    firstLexDoubt(lexScript('x = a.return / 2; s = "q";', STRICT)),
    -1,
  );
});

test("an uncertain slash is recorded as a doubt", () => {
  const block = lexScript("if (a) { b(); }\n/x/.test(c);", STRICT);
  assert.ok(block.ambiguousSlashAt > 0);
  assert.equal(firstLexDoubt(block), block.ambiguousSlashAt);
  const yieldSlash = lexScript("function* g() { yield /x/; }", STRICT);
  assert.ok(yieldSlash.ambiguousSlashAt > 0);
});

test("a regex broken by a newline or EOF is recorded", () => {
  const broken = lexScript("var re = /abc;\nvar b = 1;", STRICT);
  assert.ok(broken.unterminatedRegexAt >= 0);
  const eof = lexScript("var re = /abc", STRICT);
  assert.equal(eof.unterminatedRegexAt, "var re = /abc".length);
});

test("a `)` or `]` inside a substitution is unbalanced, not a template exit", () => {
  assert.ok(lexScript("`${ ) }`", STRICT).unbalancedAt >= 0);
});

test("recoverAtNewline closes a quoted string at the line end and says so", () => {
  const source = 'var s = "open\ncall();';
  const recovered = lexScript(source, { recoverAtNewline: true });
  assert.equal(kindAt(source, "call", { recoverAtNewline: true }), LEX_CODE);
  assert.ok(recovered.recoveredAt >= 0);
  const strict = lexScript(source, STRICT);
  assert.equal(strict.endState, "double-quote");
});

// ── review W4a (2026-09-26): code-position escapes, HTML-like comments ──────

test("a backslash in code is recorded as a doubt (identifier escape)", () => {
  // `eval(x)` is `eval(x)` to the engine. The lexer does not decode it;
  // it records the position so both consumers fail closed.
  for (const source of [
    "\\u0065val(x);",
    "gr.\\u0064eleteMultiple();",
    'new \\u0046unction("x")();',
    "\\u{65}val(x);",
  ]) {
    const result = lexScript(source, STRICT);
    assert.equal(result.codeBackslashAt, source.indexOf("\\"), source);
    assert.equal(firstLexDoubt(result), result.codeBackslashAt, source);
  }
});

test("a backslash inside a string or a regex is not a code backslash", () => {
  for (const source of [
    'var s = "a\\nb";',
    "var s = 'it\\'s';",
    "var t = `a\\`b`;",
    "var re = /a\\/b/;",
  ]) {
    const result = lexScript(source, STRICT);
    assert.equal(result.codeBackslashAt, -1, source);
    assert.equal(firstLexDoubt(result), -1, source);
  }
});

test("`<!--` anywhere in code opens a line comment (Annex B)", () => {
  const source = 'var a = 1; <!-- "\neval(x); //"\n';
  const result = lexScript(source, STRICT);
  assert.equal(result.htmlCommentAt, source.indexOf("<!--"));
  assert.equal(kindAt(source, '"'), LEX_COMMENT);
  assert.equal(kindAt(source, "eval"), LEX_CODE);
  assert.equal(result.endState, "code");
  assert.equal(firstLexDoubt(result), result.htmlCommentAt);
  // Mid-expression too: the engine reads `a <!-- b` as `a` and a comment.
  assert.equal(kindAt("x = a<!--b\ny();", "b"), LEX_COMMENT);
});

test("`-->` at the start of a line is a line comment (Annex B)", () => {
  for (const source of [
    'var a = 1;\n--> "\ngr.deleteMultiple(); //"\n',
    'var a = 1;\n   --> "\ngr.deleteMultiple(); //"\n',
    'var a = 1;\n/* c */ --> "\ngr.deleteMultiple(); //"\n',
    'var a = 1; /* multi\nline */ --> "\ngr.deleteMultiple(); //"\n',
    'var a = 1; // c\n--> "\ngr.deleteMultiple(); //"\n',
    '--> "\ngr.deleteMultiple(); //"\n',
  ]) {
    const result = lexScript(source, STRICT);
    assert.equal(result.htmlCommentAt, source.indexOf("-->"), source);
    assert.equal(kindAt(source, "deleteMultiple"), LEX_CODE, source);
    assert.equal(result.endState, "code", source);
  }
});

test("`-->` mid-line is postfix `--` then `>`, not a comment", () => {
  for (const source of ["a-->b;", "x = a --> b; y();", "if (i-->0) f();"]) {
    const result = lexScript(source, STRICT);
    assert.equal(result.htmlCommentAt, -1, source);
    assert.equal(firstLexDoubt(result), -1, source);
    assert.ok(!result.kinds.includes(LEX_COMMENT), source);
  }
});

test("`<!--` and `-->` inside a string are string content", () => {
  for (const source of [
    'var s = "<!--";',
    "var s = '-->';",
    "var t = `<!-- ${x} -->`;",
  ]) {
    const result = lexScript(source, STRICT);
    assert.equal(result.htmlCommentAt, -1, source);
    assert.equal(firstLexDoubt(result), -1, source);
  }
});

test("a leading `#!` is a hashbang line comment; elsewhere it is not", () => {
  const source = '#! "\neval(x) //"\n';
  const result = lexScript(source, STRICT);
  assert.equal(result.hashbangAt, 0);
  assert.equal(kindAt(source, '"'), LEX_COMMENT);
  assert.equal(kindAt(source, "eval"), LEX_CODE);
  assert.equal(result.endState, "code");
  assert.equal(firstLexDoubt(result), 0);
  assert.equal(lexScript(" #!x", STRICT).hashbangAt, -1);
});

test("a raw line terminator in a quoted string is recorded in both modes", () => {
  for (const nl of ["\n", "\r", " ", " "]) {
    const source = `var s = "open${nl}eval(x); ";`;
    const strict = lexScript(source, STRICT);
    assert.equal(
      strict.stringLineBreakAt,
      source.indexOf(nl),
      JSON.stringify(nl),
    );
    assert.equal(firstLexDoubt(strict), strict.stringLineBreakAt);
    const recovered = lexScript(source, { recoverAtNewline: true });
    assert.equal(recovered.stringLineBreakAt, source.indexOf(nl));
  }
});

test("a line continuation (LF or CRLF) inside a string is not a raw break", () => {
  for (const source of [
    'var s = "a\\\nb";',
    'var s = "a\\\r\nb";',
    "var t = `a\nb`;",
  ]) {
    const result = lexScript(source, STRICT);
    assert.equal(result.stringLineBreakAt, -1, JSON.stringify(source));
    assert.equal(firstLexDoubt(result), -1, JSON.stringify(source));
  }
});
