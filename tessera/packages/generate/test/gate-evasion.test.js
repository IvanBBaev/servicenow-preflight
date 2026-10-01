// TM-3 — regression suite for the W4a review (2026-09-26): constructs the
// engine executes as a denied call and the gate used to CLEAR.
//
// Every hostile case below was reproduced against the build of 2026-09-25 and
// confirmed to run under `node:vm` (the review's `engine-confirm.cjs`): the
// gate said `ok: true` and the engine called `eval` or `deleteMultiple`. Each
// one is now a refusal, and the rule it must be refused under is pinned so a
// later change that "still refuses, but for some unrelated reason" shows up.
//
// The second half is the other side of the ledger: ordinary code that sits
// next to each new rule — division, regex literals, templates, `"<!--"` in a
// string, `a-->b`, `\n` escapes — must still clear, or the gate has bought its
// safety by refusing everything.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { untrusted } from "@tessera/types";

import { inspectGeneratedSource } from "../build/index.js";

function gated(source) {
  return inspectGeneratedSource(untrusted(source));
}

function rulesOf(verdict) {
  assert.equal(verdict.ok, false, "expected a rejection, got a clearance");
  return verdict.violations.map((violation) => violation.rule);
}

/** Assert a refusal that includes `rule`, and that the source never cleared. */
function refusedAs(source, rule) {
  const verdict = gated(source);
  assert.equal(verdict.ok, false, `cleared: ${JSON.stringify(source)}`);
  assert.ok(
    rulesOf(verdict).includes(rule),
    `${JSON.stringify(source)} was refused as ${rulesOf(verdict).join()}, not ${rule}`,
  );
}

describe("W4a-A — identifier escapes in code position", () => {
  it("refuses the three repros as identifier-escape", () => {
    for (const source of [
      "\\u0065val(x);",
      'var gr = new GlideRecord("incident"); gr.\\u0064eleteMultiple();',
      'new \\u0046unction("gs.log(1)")();',
    ]) {
      refusedAs(source, "identifier-escape");
    }
  });

  it("refuses the braced form and an escape in the middle of a name", () => {
    refusedAs("\\u{65}val(x);", "identifier-escape");
    refusedAs("gr.delete\\u004dultiple();", "identifier-escape");
  });

  it("files the new rule under unparseable", () => {
    const verdict = gated("\\u0065val(x);");
    const row = verdict.violations.find((v) => v.rule === "identifier-escape");
    assert.equal(row.category, "unparseable");
    assert.equal(row.line, 1);
  });
});

describe("W4a-B — HTML-like comments, hashbang, raw line breaks in strings", () => {
  it("refuses the gate-probe repros", () => {
    refusedAs(
      'var a = 1; <!-- "\neval(x); gr.deleteMultiple(); //"\n',
      "html-comment",
    );
    refusedAs('var a = 1;\n--> "\ngr.deleteMultiple(); //"\n', "html-comment");
    refusedAs('#! "\neval(x) //"\n', "hashbang");
  });

  it("refuses the scan-probe repros", () => {
    for (const source of [
      "var a = 1; <!-- /*\neval(x); new MyInclude().run(); gr.deleteMultiple(); //*/\n",
      "var a = 1; <!-- `\neval(x); new MyInclude().run(); //`\n",
      "var a = 1;\n--> /*\neval(x); new MyInclude().run(); //*/\n",
    ]) {
      refusedAs(source, "html-comment");
    }
  });

  it("refuses `-->` after whitespace or a comment at the start of a line", () => {
    refusedAs("var a = 1;\n   --> x\nvar b = 2;", "html-comment");
    refusedAs("var a = 1;\n/* c */ --> x\nvar b = 2;", "html-comment");
  });

  it("refuses a quoted string broken by a raw line terminator", () => {
    // The engine rejects these outright; the strict lexer used to read the
    // whole rest of the file as one string and clear whatever was in it.
    for (const nl of ["\n", "\r", " ", " "]) {
      refusedAs(`var a = "x${nl}gr.deleteMultiple(); ";`, "string-line-break");
      refusedAs(`var a = 'x${nl}eval(y); ';`, "string-line-break");
    }
  });
});

describe("W4a-C — call shapes the deny-list used to miss", () => {
  const cases = [
    ["eval?.(x);", "eval"],
    ["gr.deleteMultiple?.();", "delete-multiple"],
    ["gr?.deleteMultiple();", "delete-multiple"],
    ["gr.deleteMultiple``;", "delete-multiple"],
    ["Function`gs.log(1)```;", "function-constructor"],
    ["gr.deleteMultiple.call(gr);", "delete-multiple"],
    ["gr.deleteMultiple.apply(gr, []);", "delete-multiple"],
    ["var f = gr.deleteMultiple.bind(gr);", "delete-multiple"],
    ["gr.insert.call(gr);", "insert"],
    ["Function.apply(null, ['x'])();", "function-constructor"],
    ["eval.apply(null, [x]);", "eval"],
    ["(0, eval)(x);", "eval"],
    ["var e = eval;", "eval"],
    ["globalThis.eval(x);", "eval"],
    ["with (gr) { deleteMultiple(); }", "with-statement"],
    ["Reflect.apply(gr.deleteMultiple, gr, []);", "reflect"],
    ["gs?.include('X');", "gs-include"],
    ["gs?.eventQueue('e', gr);", "gs-event-queue"],
    ["gr.deleteMultiple /* why */ ();", "delete-multiple"],
    ["gr./* why */deleteMultiple();", "delete-multiple"],
    ["eval /* why */ (x);", "eval"],
  ];
  for (const [source, rule] of cases) {
    it(`refuses ${source} as ${rule}`, () => {
      refusedAs(source, rule);
    });
  }
});

describe("W4a — legitimate code still clears", () => {
  const clean = [
    "var r = a / b / c;",
    "var r = (a + 1) / 2 / count;",
    "var re = /[\"']/g;\nvar ok = re.test(name);",
    "var re = /a\\/b/;",
    "var t = `id ${gr.getValue('sys_id')} of ${total / 2}`;",
    'var s = "<!--";',
    "var s = '-->';",
    "var t = `<!-- ${name} -->`;",
    "var n = a-->b;",
    "while (i-->0) { total += i; }",
    'var s = "line one\\nline two\\tend";',
    'var s = "a\\\nb";',
    'var s = "a\\\r\nb";',
    "var t = `multi\nline`;",
    "var copy = arr.with(0, 1);",
    "var score = evaluate(x) + evalCount;",
    "var fnName = describe.name;",
    "gr.query();\nwhile (gr.next()) { count += 1; }",
  ];
  for (const source of clean) {
    it(`clears ${JSON.stringify(source)}`, () => {
      const verdict = gated(source);
      assert.equal(
        verdict.ok,
        true,
        verdict.ok ? "" : `refused as ${rulesOf(verdict).join()}`,
      );
    });
  }
});

describe("W7b — formerly clean, now refused (delegated decision 2026-09-26)", () => {
  // Both cleared under W4a. `.call` is how an aliased denied method is run,
  // and a comment is where a YAML `# /*` hides a whole script, so both are
  // refused now; the cost is one rewrite of a legitimate callback or comment.
  it("refuses callback.call(this, x) as indirect-invoke", () => {
    refusedAs("var fn = callback.call(this, x);", "indirect-invoke");
  });
  it("refuses a comment that names a denied construct", () => {
    refusedAs(
      "// eval(x) and gr.deleteMultiple() are forbidden here\nvar a = 1;",
      "delete-multiple",
    );
  });
});

describe("W4a — the new refusals carry no source text (TM-1)", () => {
  it("never echoes the body", () => {
    for (const source of [
      "\\u0073ecretvalue(x);",
      "var a = 1; <!-- secretvalue",
      "#! secretvalue\nvar a = 1;",
      'var a = "secret\nvalue";',
      "with (secretvalue) { x(); }",
      "Reflect.secretvalue;",
    ]) {
      const text = JSON.stringify(gated(source));
      assert.ok(!text.includes("secretvalue"), source);
      assert.ok(!text.includes("secret"), source);
    }
  });
});
