import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codeLines,
  lexLines,
  scanScripts,
  MAX_SCAN_HITS,
} from "../../build/checks/script-scan.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE_SYS_ID = "0123456789abcdef0123456789abcdef";

/** Every view of `src` has one line per source line, each as long as the source line. */
function assertShape(src, lexed) {
  const lines = src.split(/\r?\n/);
  for (const view of ["code", "strings", "raw"]) {
    assert.equal(lexed[view].length, lines.length, `${view} line count`);
    lexed[view].forEach((l, i) =>
      assert.equal(l.length, lines[i].length, `${view} line ${i + 1} length`),
    );
  }
}

// [name, source, expected code view, expected string view] — one line each.
const CASES = [
  [
    "// inside a string is text, a trailing // comment is blanked",
    `var u = "http://x"; // c`,
    `var u = "        ";     `,
    `         http://x       `,
  ],
  [
    "/* */ inside a template is text",
    "var t = `a /* b */`;",
    "var t = `         `;",
    "         a /* b */  ",
  ],
  [
    "a regex literal containing //, ' and \"",
    `var r = /a\\/\\/'"/g; f();`,
    `var r = /       /g; f();`,
    `                        `,
  ],
  [
    "division is not a regex",
    "x = a / b / c;",
    "x = a / b / c;",
    "              ",
  ],
  ["a regex after =", "x = /re/g;", "x = /  /g;", "          "],
  [
    "a regex after return",
    "return /re/.test(s);",
    "return /  /.test(s);",
    "                    ",
  ],
  [
    "division after ) and ]",
    "y = (a) / 2 + b[0] / 3;",
    "y = (a) / 2 + b[0] / 3;",
    "                       ",
  ],
  [
    "a / inside a regex class does not close it",
    `r = /[/"]x/; eval(s);`,
    `r = /     /; eval(s);`,
    `                     `,
  ],
  [
    "template ${} nesting with braces in strings",
    "t = `a${ \"a\" + '}' }b`; z();",
    "t = ` ${ \" \" + ' ' } `; z();",
    "     a    a     }   b       ",
  ],
  [
    "template expression with an object literal and a nested template",
    "t = `${ {k: `in${1}`}.k }!`;",
    "t = `${ {k: `  ${1}`}.k } `;",
    "             in          !  ",
  ],
];

for (const [name, src, code, strings] of CASES) {
  test(`lexLines: ${name}`, () => {
    const lexed = lexLines(src);
    assertShape(src, lexed);
    assert.equal(lexed.code[0], code, "code view");
    assert.equal(lexed.strings[0], strings, "string view");
  });
}

test("lexLines: an unterminated quote ends at the newline", () => {
  const src = "var a = 'open\nb(); // c\n'x'";
  const lexed = lexLines(src);
  assertShape(src, lexed);
  assert.deepEqual(lexed.code, ["var a = '    ", "b();     ", "' '"]);
  assert.deepEqual(lexed.strings, ["         open", "         ", " x "]);
});

test("lexLines: a backslash-newline continues a quote string", () => {
  const lexed = lexLines("var a = 'one\\\ntwo'; eval(x);");
  assert.equal(lexed.code[1], "   '; eval(x);");
  assert.equal(lexed.strings[1], "two           ");
});

test("lexLines: block comments and templates span lines", () => {
  const src = "a(); /* x\n eval(1) */ b();\nt = `l1\nl2 ${c}`;";
  const lexed = lexLines(src);
  assertShape(src, lexed);
  assert.deepEqual(lexed.code, [
    "a();     ",
    "            b();",
    "t = `  ",
    "   ${c}`;",
  ]);
  assert.deepEqual(lexed.strings, [
    "         ",
    "                ",
    "     l1",
    "l2       ",
  ]);
});

test("lexLines: CRLF input keeps line count and columns", () => {
  const src = "a = 'x';\r\n// c\r\nb = /r/;\r\n";
  const lexed = lexLines(src);
  assertShape(src, lexed);
  assert.deepEqual(lexed.code, ["a = ' ';", "    ", "b = / /;", ""]);
  assert.deepEqual(lexed.raw, ["a = 'x';", "    ", "b = /r/;", ""]);
});

test("lexLines: a regex is allowed after a keyword but not after an identifier", () => {
  assert.equal(lexLines("typeof /x/").code[0], "typeof / /");
  assert.equal(lexLines("total /x/ 2").code[0], "total /x/ 2");
  assert.equal(lexLines("/^a/.test(s)").code[0], "/  /.test(s)");
  // A regex ends at the newline when unterminated.
  assert.deepEqual(lexLines("x = /open\ny();").code, ["x = /    ", "y();"]);
});

test("lexLines: a regex is allowed after a control head or a block (RR-67)", () => {
  assert.equal(
    lexLines("if (ok) /`/.test(s);").code[0],
    "if (ok) / /.test(s);",
  );
  assert.equal(lexLines("while (a(b)) /x/;").code[0], "while (a(b)) / /;");
  assert.equal(lexLines("}\n/[`]/.test(s);").code[1], "/   /.test(s);");
  // A call or a grouping paren is still an operand: `/` there divides.
  assert.equal(lexLines("f(a) / 2 / b").code[0], "f(a) / 2 / b");
  assert.equal(lexLines("(a + b) / 2 / c").code[0], "(a + b) / 2 / c");
});

test("lexLines: a postfix ++/-- keeps the next / a division (RR-67)", () => {
  assert.equal(
    lexLines("n = a++ / 2; s = '/'").code[0],
    "n = a++ / 2; s = ' '",
  );
  assert.equal(
    lexLines("n = a-- / 2; s = '/'").code[0],
    "n = a-- / 2; s = ' '",
  );
  // A prefix ++ before a regex position is still an operator.
  assert.equal(lexLines("x = ++/a/.lastIndex").code[0], "x = ++/ /.lastIndex");
});

test("lexLines: CR, U+2028 and U+2029 end a line comment (RR-67)", () => {
  for (const sep of ["\r", " ", " "]) {
    const lexed = lexLines(`// c${sep}eval(x);`);
    assert.deepEqual(lexed.code, ["    ", "eval(x);"], JSON.stringify(sep));
    assert.equal(lexed.unterminatedLine, 0);
  }
});

test("lexLines: unterminatedLine reports the first unterminated literal (RR-67)", () => {
  for (const [src, line] of [
    ["a();\nb();", 0],
    ["a = 'ok';\nb = /ok/;\nc = `t ${d} e`;", 0],
    ["a();\nvar s = 'open\nb();", 2],
    ["x = /open\ny = 'also open", 1],
    ["a();\n/* never closed\nb();", 2],
    ["t = `l1\nl2", 1],
    ["t = `a ${\nb", 1],
    ["t = `a ${ `inner` \n b", 1],
  ]) {
    assert.equal(lexLines(src).unterminatedLine, line, JSON.stringify(src));
  }
});

test("codeLines is the raw view: comments blanked, literals kept", () => {
  const src = "var u = '//x'; /* c */ var r = /a/; // d";
  assert.deepEqual(codeLines(src), lexLines(src).raw);
  assert.equal(codeLines(src)[0], "var u = '//x';         var r = /a/;     ");
});

test("scanScripts tests each pattern against its own view", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_script: [
        {
          sys_id: "s1",
          name: "R",
          sys_scope: SCOPE_SYS_ID,
          active: "true",
          script: "var s = 'eval(x)';\neval(y); // eval(z)",
        },
      ],
    },
  });
  const re = /\beval\(/;
  const res = await scanScripts(
    { http },
    `sys_scope=${SCOPE_SYS_ID}`,
    [{ table: "sys_script", nameField: "name", scriptFields: ["script"] }],
    [
      { id: "code", regex: re },
      { id: "string", regex: re, view: "string" },
      { id: "raw", regex: re, view: "raw" },
    ],
  );
  assert.deepEqual(
    res.hits.map((h) => `${h.patternId}:${h.line}`),
    ["string:1", "raw:1", "code:2", "raw:2"],
  );
  assert.equal(res.truncated, false);
});

test("scanScripts sets truncated when hits are dropped", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_script: [
        {
          sys_id: "s1",
          name: "R",
          sys_scope: SCOPE_SYS_ID,
          active: "true",
          script: Array.from(
            { length: MAX_SCAN_HITS + 2 },
            () => "eval(1);",
          ).join("\n"),
        },
      ],
    },
  });
  const res = await scanScripts(
    { http },
    `sys_scope=${SCOPE_SYS_ID}`,
    [{ table: "sys_script", nameField: "name", scriptFields: ["script"] }],
    [{ id: "eval", regex: /\beval\(/ }],
  );
  assert.equal(res.dropped, 2);
  assert.equal(res.truncated, true);
});
