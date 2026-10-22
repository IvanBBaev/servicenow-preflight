// TM-3 layer 1 — the AST allowlist (PA-10), and the layered gate it fronts.
//
// The lexical suite (`gate.test.js`) pins what a deny-list cannot see. This
// suite pins the allowlist that closes those classes for ATF step bodies:
//
//   1. EVERY layer-1 rule fires, driven off `astGateRuleNames()` in both
//      directions, like the lexical exhaustiveness test.
//   2. Realistic bodies CLEAR both layers — the live fixtures' wrapper IIFE
//      (the S5 generated script is pinned in cli `liveSpecsAstGate.test.js`), the Jasmine-shaped clean spec, GlideRecord and
//      GlideAggregate reads, `gs.info`/`gs.debug`.
//   3. Every named bypass class is REFUSED by layer 1, including the ones the
//      lexical layer alone lets through (homoglyphs, undenied methods, aliases).
//   4. Both layers always run, and no finding carries a slice of the body.
//
// Strings only: nothing here runs against an instance.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { untrusted } from "@tessera/types";

import {
  AST_ALLOWLIST,
  AST_RULE_DETAILS,
  GATE_CATEGORIES,
  MAX_GATED_SOURCE_CHARS,
  astGateRuleNames,
  createAtfServerScriptGate,
  inspectAtfServerScript,
  inspectGeneratedSource,
} from "../build/index.js";

const CANARY = "canary-91ac-repo-authored-never-echo-this";

function gated(source, targetClassNames = []) {
  return inspectAtfServerScript(untrusted(source), { targetClassNames });
}

/** Layer-1 rule names of a verdict (those prefixed `ast-`). */
function astRules(verdict) {
  assert.equal(verdict.ok, false, "expected a rejection, got a clearance");
  return verdict.violations
    .map((violation) => violation.rule)
    .filter((rule) => rule.startsWith("ast-"));
}

function lexicalRules(verdict) {
  assert.equal(verdict.ok, false, "expected a rejection, got a clearance");
  return verdict.violations
    .map((violation) => violation.rule)
    .filter((rule) => !rule.startsWith("ast-"));
}

/** The live fixtures' wrapper body (cli `liveRun.test.js` GOOD_BODY). */
const WRAPPED_BODY = `(function (outputs, steps, params, stepResult, assertEqual) {
  var d = new LiveDiscount();
  assertEqual({ name: "below threshold pays full price", shouldbe: 990, value: d.apply(99, 10) });
  assertEqual({ name: "the threshold itself discounts", shouldbe: 900, value: d.apply(100, 10) });
})(outputs, steps, params, stepResult, assertEqual);
`;

/** `gate.test.js` CLEAN_SPEC, verbatim. */
const CLEAN_SPEC = [
  "// Regression guard: a critical incident keeps priority 1.",
  "describe('incident priority', function () {",
  "  it('stays at 1 when impact and urgency are both 1', function () {",
  "    var gr = new GlideRecord('incident');",
  "    gr.addQuery('sys_id', FIXTURE_SYS_ID);",
  "    gr.query();",
  "    assertTrue(gr.next(), 'the fixture incident is readable');",
  "    assertEquals('1', String(gr.getValue('priority')));",
  "  });",
  "});",
].join("\n");

const GLIDE_READS = [
  "var gr = new GlideRecord('incident');",
  "gr.addEncodedQuery('active=true');",
  "gr.addQuery('priority', '<=', 2);",
  "gr.query();",
  "var count = 0;",
  "while (gr.hasNext() && gr.next()) {",
  "  if (!gr.isValidRecord()) { break; }",
  "  count++;",
  "  var label = gr.getDisplayValue('caller_id') + ':' + gr.getUniqueValue();",
  "  var caller = gr.caller_id.name;",
  "  gs.debug('row ' + label + caller);",
  "}",
  "var one = new GlideRecord('sys_user');",
  "var found = one.get(FIXTURE_SYS_ID);",
  "var agg = new GlideAggregate('incident');",
  "agg.addQuery('active', true);",
  "agg.addEncodedQuery('priority=1');",
  "agg.addAggregate('COUNT');",
  "agg.groupBy('category');",
  "agg.query();",
  "for (var i = 0; agg.next() && i < 10; i += 1) {",
  "  var total = parseInt(agg.getAggregate('COUNT'), 10);",
  "  gs.info(agg.getValue('category') + '=' + total);",
  "  continue;",
  "}",
  "do { count--; } while (count > 0);",
  "var rows = gr.getRowCount();",
  "var biggest = Math.max(rows, 0, Math.abs(-1), Math.round(1.5));",
  "var text = JSON.stringify({ rows: rows, big: biggest, list: [1, , 'x'] });",
  "var flag = isNaN(Number('x')) ? undefined : NaN;",
  "assertEqual({ name: 'read-only', shouldbe: 1, value: found ? 1 : parseFloat('1') });",
  "assertNotEqual(text, '');",
  "assertFalse(typeof flag === 'string');",
  "stepResult.setOutputMessage('done');",
  "stepResult.setSuccess();",
  ";",
].join("\n");

describe("TM-3 layer 1 — realistic bodies clear both layers", () => {
  it("the live wrapper body clears, `d.apply(…)` on the target included", () => {
    assert.equal(gated(WRAPPED_BODY, ["LiveDiscount"]).ok, true);
  });

  it("the Jasmine-shaped clean spec clears with no targets", () => {
    const verdict = gated(CLEAN_SPEC);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  });

  it("GlideRecord / GlideAggregate reads and the allowlisted helpers clear", () => {
    const verdict = gated(GLIDE_READS);
    assert.equal(verdict.ok, true, JSON.stringify(verdict.violations));
  });

  it("`gs.info` and `gs.debug` clear on their own", () => {
    assert.equal(gated("gs.info('x');\n").ok, true);
    assert.equal(gated("gs.debug('x');\n", ["X"]).ok, true);
  });

  it("loops and parenthesised callees are admitted shapes", () => {
    // Parentheses are not in the tree: this is `gs.info('x')`.
    assert.equal(gated("(gs.info)('x'); for (;;) { break; }").ok, true);
  });

  it("a wrapper may take a prefix of the ATF parameters", () => {
    const body =
      "(function (outputs, steps) { gs.info('x'); })(outputs, steps);";
    assert.equal(gated(body).ok, true);
  });

  it("the cleared source is the branded input, not a bare string", () => {
    const source = untrusted(CLEAN_SPEC);
    const verdict = createAtfServerScriptGate().inspect(source);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.cleared.source, source);
    assert.ok(verdict.cleared.clearance);
  });
});

/**
 * One body per layer-1 rule. Keyed so the exhaustiveness test can compare it
 * with `astGateRuleNames()` both ways.
 */
const RULE_FIXTURES = {
  "ast-unparseable": "var x = ;",
  "ast-non-ascii-identifier":
    "var gr = new GlideRecord('incident'); gr.dеleteRecord();",
  "ast-eval": "eval('gs.info(1)');",
  "ast-function-constructor": "var f = new Function('return 1');",
  "ast-with-statement": "with (gs) { info('x'); }",
  "ast-this": "this.gs.info('x');",
  "ast-arguments": "var a = arguments;",
  "ast-computed-member": "var x = Math['max'];",
  "ast-function-alias": "var f = assertEqual;",
  "ast-receiver-alias": "var g = gs;",
  "ast-function-value": "var f = function () { return 1; };",
  "ast-denied-dynamic-code": "gs.include('SomeInclude');",
  "ast-denied-dml":
    "var gr = new GlideRecord('incident'); gr.query(); gr.deleteMultiple();",
  "ast-denied-integrity-bypass":
    "var gr = new GlideRecord('incident'); gr.setWorkflow(false);",
  "ast-denied-outbound": "var r = new RESTMessageV2('x', 'post');",
  "ast-denied-privilege-escalation": "var s = gs.getSession();",
  "ast-denied-side-effect": "gs.eventQueue('evt', null, '', '');",
  "ast-call-outside-allowlist": "gs.log('x');",
  "ast-new-outside-allowlist": "var s = new SomeInclude();",
  "ast-table-not-literal": "var gr = new GlideRecord('inc' + 'ident');",
  "ast-unknown-identifier": "var x = someGlobal;",
  "ast-syntax-outside-allowlist": "try { gs.info('x'); } catch (e) {}",
  "ast-assignment-outside-allowlist": "gs.level = 1;",
  "ast-redeclaration": "var a = 1; var a = 2;",
};

describe("TM-3 layer 1 — every rule fires", () => {
  it("there is exactly one fixture per rule, in both directions", () => {
    assert.deepEqual(Object.keys(RULE_FIXTURES).sort(), [
      ...astGateRuleNames(),
    ]);
  });

  for (const [rule, source] of Object.entries(RULE_FIXTURES)) {
    it(`${rule} fires`, () => {
      const verdict = gated(source);
      assert.ok(
        astRules(verdict).includes(rule),
        `${rule} not in ${JSON.stringify(astRules(verdict))}`,
      );
    });
  }

  it("every finding has a lexical-style shape and a constant detail", () => {
    const categories = new Set([...GATE_CATEGORIES, "outside-allowlist"]);
    for (const source of Object.values(RULE_FIXTURES)) {
      const verdict = gated(source);
      for (const violation of verdict.violations) {
        assert.deepEqual(Object.keys(violation).sort(), [
          "category",
          "detail",
          "line",
          "rule",
        ]);
        assert.ok(categories.has(violation.category));
        assert.ok(Number.isInteger(violation.line) && violation.line >= 0);
        if (violation.rule.startsWith("ast-")) {
          assert.equal(violation.detail, AST_RULE_DETAILS[violation.rule]);
        }
      }
    }
  });
});

describe("TM-3 layer 1 — the PA-10 bypass classes are refused", () => {
  it("a concatenated member name is refused (computed member)", () => {
    const verdict = gated(
      "var gr = new GlideRecord('incident'); gr['delete' + 'Record']();",
    );
    assert.ok(astRules(verdict).includes("ast-computed-member"));
  });

  it("a built name through a variable is refused (computed member)", () => {
    const verdict = gated(
      "var gr = new GlideRecord('incident'); var m = 'dele' + 'teRecord'; gr[m]();",
    );
    assert.ok(astRules(verdict).includes("ast-computed-member"));
  });

  it("an undenied side-effecting method is refused by the allowlist", () => {
    // Neither name is on any deny-list; the lexical layer clears them.
    for (const call of ["gr.applyEncodedQuery('x')", "gr.setLimit(1)"]) {
      const body = `var gr = new GlideRecord('incident'); ${call};`;
      assert.equal(inspectGeneratedSource(untrusted(body)).ok, true);
      assert.deepEqual(astRules(gated(body)), ["ast-call-outside-allowlist"]);
    }
  });

  it("a homoglyph identifier is refused before any table is consulted", () => {
    const body = "var gr = new GlideRecord('incident'); gr.dеleteRecord();";
    // The lexical layer alone does not see it — that is the bypass.
    assert.equal(inspectGeneratedSource(untrusted(body)).ok, true);
    assert.ok(astRules(gated(body)).includes("ast-non-ascii-identifier"));
  });

  it("a homoglyph in a declared name is refused too", () => {
    assert.ok(
      astRules(gated("var а = 1;")).includes("ast-non-ascii-identifier"),
    );
  });

  it("aliasing a method is refused, denied or not", () => {
    const denied = gated(
      "var gr = new GlideRecord('incident'); var f = gr.deleteRecord; f();",
    );
    assert.ok(astRules(denied).includes("ast-denied-dml"));
    assert.ok(astRules(denied).includes("ast-call-outside-allowlist"));
    const allowed = gated(
      "var gr = new GlideRecord('incident'); var q = gr.query; q();",
    );
    assert.ok(astRules(allowed).includes("ast-function-alias"));
    const global = gated("var log = gs.info; log('x');");
    assert.ok(astRules(global).includes("ast-function-alias"));
    const target = gated("var d = new LiveDiscount(); var a = d.apply;", [
      "LiveDiscount",
    ]);
    assert.ok(astRules(target).includes("ast-function-alias"));
  });

  it("aliasing a receiver is refused", () => {
    for (const body of [
      "var g = gs; g.eventQueue('x');",
      "var gr = new GlideRecord('incident'); var r = gr;",
      "var d = new LiveDiscount(); assertEqual({ value: d });",
      "assertEqual(stepResult);",
    ]) {
      assert.ok(
        astRules(gated(body, ["LiveDiscount"])).includes("ast-receiver-alias"),
        body,
      );
    }
  });

  it("`this['x']` and `this.x` are refused", () => {
    assert.ok(astRules(gated("this['x']();")).includes("ast-this"));
    assert.ok(astRules(gated("var g = this.gs;")).includes("ast-this"));
    assert.ok(astRules(gated("var t = this;")).includes("ast-this"));
  });

  it("a string-built or non-literal table name is refused", () => {
    for (const body of [
      "var gr = new GlideRecord('sys_' + 'user');",
      "var t = 'incident'; var gr = new GlideRecord(t);",
      "var gr = new GlideRecord();",
      "var gr = new GlideRecord('incident', 'x');",
      "var gr = new GlideRecord('Incident');",
      "var ga = new GlideAggregate(String('incident'));",
    ]) {
      assert.ok(astRules(gated(body)).includes("ast-table-not-literal"), body);
    }
  });

  it("a Script Include reached by name is refused unless it is the target", () => {
    assert.ok(
      astRules(gated("var s = new SomeInclude(); s.run();")).includes(
        "ast-new-outside-allowlist",
      ),
    );
    assert.ok(
      astRules(gated("SomeInclude.run();")).includes(
        "ast-call-outside-allowlist",
      ),
    );
    assert.ok(
      astRules(gated("var s = new global.SomeInclude();")).includes(
        "ast-denied-dynamic-code",
      ),
    );
    assert.ok(
      astRules(gated("var s = new x_scope.SomeInclude();")).includes(
        "ast-new-outside-allowlist",
      ),
    );
    assert.ok(
      astRules(gated("gs.include('SomeInclude');")).includes(
        "ast-denied-dynamic-code",
      ),
    );
    // The declared target is constructible; another class still is not.
    assert.ok(
      astRules(gated("var s = new Other();", ["LiveDiscount"])).includes(
        "ast-new-outside-allowlist",
      ),
    );
  });

  it("every PA-10 denied method is refused by name, on any receiver", () => {
    const expected = {
      insert: "ast-denied-dml",
      update: "ast-denied-dml",
      deleteRecord: "ast-denied-dml",
      deleteMultiple: "ast-denied-dml",
      updateMultiple: "ast-denied-dml",
      setValue: "ast-denied-dml",
      setWorkflow: "ast-denied-integrity-bypass",
      autoSysFields: "ast-denied-integrity-bypass",
      eventQueue: "ast-denied-side-effect",
    };
    for (const [name, rule] of Object.entries(expected)) {
      const onRecord = gated(
        `var gr = new GlideRecord('incident'); gr.${name}();`,
      );
      assert.ok(astRules(onRecord).includes(rule), name);
      // Denied on the declared target too: a spec can wrap it, not call it.
      const onTarget = gated(`var d = new LiveDiscount(); d.${name}();`, [
        "LiveDiscount",
      ]);
      assert.ok(astRules(onTarget).includes(rule), name);
      // And as an object key, where it could be handed to something.
      const asKey = gated(`var o = { ${name}: 1 };`);
      assert.ok(astRules(asKey).includes(rule), name);
    }
  });

  it("every PA-10 denied class is refused", () => {
    const expected = {
      GlideSysAttachment: "ast-denied-dml",
      RESTMessageV2: "ast-denied-outbound",
      GlideHTTPRequest: "ast-denied-outbound",
      SOAPMessageV2: "ast-denied-outbound",
      GlideEmailOutbound: "ast-denied-side-effect",
      GlideImpersonate: "ast-denied-privilege-escalation",
      GlideEvaluator: "ast-denied-dynamic-code",
      Packages: "ast-denied-dynamic-code",
    };
    for (const [name, rule] of Object.entries(expected)) {
      assert.ok(astRules(gated(`var x = new ${name}();`)).includes(rule), name);
      assert.ok(astRules(gated(`var x = ${name};`)).includes(rule), name);
    }
    assert.ok(
      astRules(gated("var r = new sn_ws.RESTMessageV2();")).includes(
        "ast-denied-outbound",
      ),
    );
  });

  it("reflection and prototype reach are refused", () => {
    for (const body of [
      "var c = gs.constructor;",
      "var p = Math.__proto__;",
      "var o = { prototype: 1 };",
      "var o = { '__proto__': 1 };",
    ]) {
      assert.ok(
        astRules(gated(body)).includes("ast-denied-dynamic-code"),
        body,
      );
    }
    // `.call` / `.apply` on a value is structurally unreachable.
    const verdict = gated(
      "var gr = new GlideRecord('incident'); var x = gr.getValue('a'); x.call(1);",
    );
    assert.ok(astRules(verdict).includes("ast-call-outside-allowlist"));
  });

  it("`eval`, `Function` and `with` are refused in every position", () => {
    assert.ok(astRules(gated("var e = eval;")).includes("ast-eval"));
    assert.ok(
      astRules(gated("var f = Function;")).includes("ast-function-constructor"),
    );
    assert.ok(
      astRules(gated("Function('x')();")).includes("ast-function-constructor"),
    );
    assert.ok(
      astRules(gated("if (1) { with (Math) { gs.info(max(1)); } }")).includes(
        "ast-with-statement",
      ),
    );
    // Sloppy-mode ES5 lets `eval` be declared; the gate does not.
    assert.ok(astRules(gated("var eval = 1;")).includes("ast-redeclaration"));
  });
});

describe("TM-3 layer 1 — shapes outside the allowlist fail closed", () => {
  const syntax = [
    "function f() {}",
    "for (var k in gs) { gs.info(k); }",
    "throw 1;",
    "switch (1) { case 1: break; }",
    "outer: for (;;) { break outer; }",
    "debugger;",
    "var a = 1; delete a;",
    "var a = (1, 2);",
    "var r = /x/;",
    "var o = { get x() { return 1; } };",
  ];
  for (const body of syntax) {
    it(`refuses: ${body}`, () => {
      assert.ok(astRules(gated(body)).length > 0, body);
    });
  }

  it("refuses ES2015+ syntax as unparseable", () => {
    for (const body of [
      "let x = 1;",
      "const x = 1;",
      "var f = () => 1;",
      "var s = `x`;",
      "class A {}",
    ]) {
      assert.ok(astRules(gated(body)).includes("ast-unparseable"), body);
    }
  });

  it("refuses a malformed wrapper", () => {
    for (const body of [
      "(function (outputs) { gs.info('x'); })(steps);",
      "(function (outputs) { gs.info('x'); })();",
      "(function (gr) { gs.info('x'); })(gr);",
      "(function (outputs, outputs) { gs.info('x'); })(outputs, outputs);",
      "(function named(outputs) { gs.info('x'); })(outputs);",
      "(function (outputs) {})(1);",
    ]) {
      assert.ok(astRules(gated(body)).includes("ast-function-value"), body);
    }
  });

  it("refuses a malformed describe/it callback", () => {
    for (const body of [
      "describe('x', function (done) { gs.info('x'); });",
      "describe(name, function () {});",
      "it('x', gs);",
      "it('x', function () {}, 1);",
      "var d = describe;",
    ]) {
      assert.ok(astRules(gated(body)).length > 0, body);
    }
  });

  it("refuses a call whose callee is not a spelled name", () => {
    for (const body of [
      "(gs.info || gs.debug)('x');",
      "String('x').trim();",
      "gs.info.length;",
      "Math.max.call(1);",
      "var a = [1]; a.push(2);",
      "var x = FIXTURE_SYS_ID.length; FIXTURE_SYS_ID();",
      "assertEqual(new LiveDiscount());",
      "var f = (function () {})();",
    ]) {
      assert.ok(astRules(gated(body, ["LiveDiscount"])).length > 0, body);
    }
  });

  it("refuses assignment to anything but a plain local", () => {
    for (const body of [
      "outputs.x = 1;",
      "var gr = new GlideRecord('incident'); gr.short_description = 'x';",
      "var gr = new GlideRecord('incident'); gr = 1;",
      "undefined = 1;",
      "assertEqual = 1;",
      "Function = 1;",
      "var d = new LiveDiscount(); d.rate++;",
      "this.x = 1;",
    ]) {
      assert.ok(
        astRules(gated(body, ["LiveDiscount"])).includes(
          "ast-assignment-outside-allowlist",
        ),
        body,
      );
    }
    assert.equal(gated("var n = 1; n = n + 1; n++; n += 2;").ok, true);
  });

  it("refuses shadowing an allowlisted or denied name", () => {
    for (const body of [
      "var gs = 1;",
      "var assertEqual = 1;",
      "var GlideRecord = 1;",
      "var LiveDiscount = 1;",
      "var deleteRecord = 1;",
    ]) {
      assert.ok(
        astRules(gated(body, ["LiveDiscount"])).includes("ast-redeclaration"),
        body,
      );
    }
  });

  it("a placeholder is a value, never a callee or a class", () => {
    assert.equal(gated("var id = FIXTURE_SYS_ID;").ok, true);
    assert.ok(astRules(gated("FIXTURE_SYS_ID();")).length > 0);
    assert.ok(
      astRules(gated("var x = new FIXTURE_SYS_ID();")).includes(
        "ast-new-outside-allowlist",
      ),
    );
    // No underscore: not the placeholder shape.
    assert.ok(
      astRules(gated("var x = FIXTURE;")).includes("ast-unknown-identifier"),
    );
  });

  it("construction is admitted only as a `var` initialiser", () => {
    assert.ok(
      astRules(gated("gs.info(new GlideRecord('incident'));")).includes(
        "ast-new-outside-allowlist",
      ),
    );
    assert.ok(
      astRules(gated("var g; g = new GlideRecord('incident');")).includes(
        "ast-new-outside-allowlist",
      ),
    );
  });

  it("a method not on a record's allowlist is refused on that record", () => {
    const gr = gated(
      "var gr = new GlideRecord('incident'); gr.addAggregate('COUNT');",
    );
    assert.deepEqual(astRules(gr), ["ast-call-outside-allowlist"]);
    const local = gated("var n = 1; n.toString();");
    assert.deepEqual(astRules(local), ["ast-call-outside-allowlist"]);
  });
});

describe("TM-3 layered gate — both layers, fail closed", () => {
  it("a declared target name that collides with the platform is ignored", () => {
    for (const name of [
      "GlideRecordSecure",
      "GlideFoo",
      "RESTMessageV3",
      "sn_x",
      "gs",
      "eval",
      "deleteRecord",
      "bad-name",
      "Nаme",
    ]) {
      const verdict = gated(`var x = new ${name}();`, [name]);
      assert.equal(verdict.ok, false, name);
    }
  });

  it("layer 2 runs even when layer 1 rejects, and its findings follow", () => {
    const verdict = gated(
      "var gr = new GlideRecord('incident'); gr.query(); gr.deleteRecord();",
    );
    const rules = verdict.violations.map((violation) => violation.rule);
    assert.ok(rules.includes("ast-denied-dml"));
    assert.ok(lexicalRules(verdict).length > 0);
    const firstLexical = rules.findIndex((rule) => !rule.startsWith("ast-"));
    assert.ok(rules.slice(firstLexical).every((r) => !r.startsWith("ast-")));
  });

  it("a body layer 1 admits is still refused by layer 2", () => {
    // A bidi override inside a string: the parser is content, the lexer is not.
    const verdict = gated("gs.info('a‮b');");
    assert.deepEqual(astRules(verdict), []);
    assert.ok(lexicalRules(verdict).length > 0);
  });

  it("blank and oversize are reported by layer 2 only", () => {
    assert.deepEqual(lexicalRules(gated("   \n")), ["blank-source"]);
    assert.deepEqual(astRules(gated("   \n")), []);
    const oversize = "gs.info('x');\n".repeat(
      Math.ceil(MAX_GATED_SOURCE_CHARS / 14) + 1,
    );
    assert.deepEqual(lexicalRules(gated(oversize)), ["oversize-source"]);
  });

  it("options default to no targets", () => {
    const verdict = inspectAtfServerScript(
      untrusted("var d = new LiveDiscount();"),
    );
    assert.ok(astRules(verdict).includes("ast-new-outside-allowlist"));
    assert.equal(
      createAtfServerScriptGate().inspect(untrusted("gs.info('x');")).ok,
      true,
    );
  });

  it("findings are deduplicated and ordered by category, line, rule", () => {
    const verdict = gated(
      [
        "var x = someGlobal;",
        "gs.eventQueue('a'); gs.eventQueue('b');",
        "var gr = new GlideRecord('incident'); gr.deleteRecord();",
      ].join("\n"),
    );
    const ast = verdict.violations.filter((v) => v.rule.startsWith("ast-"));
    const keys = ast.map((v) => `${v.rule}:${v.line}`);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(
      ast.map((v) => v.rule),
      ["ast-denied-dml", "ast-denied-side-effect", "ast-unknown-identifier"],
    );
  });

  it("no finding carries a slice of the body (TM-1)", () => {
    for (const source of [
      `var ${CANARY.replace(/-/g, "_")} = gs;`,
      `gs.info('${CANARY}'); ${CANARY.replace(/-/g, "_")}();`,
      `var gr = new GlideRecord('${CANARY}');`,
      `var x = ;// ${CANARY}`,
      `var d = new LiveDiscount(); d.${CANARY.replace(/-/g, "_")}.x = 1;`,
    ]) {
      const verdict = gated(source, ["LiveDiscount"]);
      assert.equal(verdict.ok, false, source);
      assert.ok(!JSON.stringify(verdict.violations).includes("canary"));
    }
  });

  it("the allowlist is exposed as frozen data", () => {
    assert.ok(Object.isFrozen(AST_ALLOWLIST));
    assert.deepEqual(AST_ALLOWLIST.globalObjects.gs, ["info", "debug"]);
    assert.deepEqual(AST_ALLOWLIST.glideReadClasses.GlideRecord, [
      "addQuery",
      "addEncodedQuery",
      "query",
      "next",
      "get",
      "getValue",
      "getDisplayValue",
      "getUniqueValue",
      "isValidRecord",
      "hasNext",
      "getRowCount",
    ]);
    for (const denied of [
      "insert",
      "update",
      "deleteRecord",
      "deleteMultiple",
      "updateMultiple",
      "setValue",
      "setWorkflow",
      "autoSysFields",
      "eventQueue",
      "__proto__",
    ]) {
      assert.ok(Object.hasOwn(AST_ALLOWLIST.deniedMembers, denied), denied);
    }
    for (const denied of [
      "GlideSysAttachment",
      "RESTMessageV2",
      "GlideHTTPRequest",
    ]) {
      assert.ok(Object.hasOwn(AST_ALLOWLIST.deniedGlobals, denied), denied);
    }
  });
});
