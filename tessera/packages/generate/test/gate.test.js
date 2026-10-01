// TM-3 — the generated-code gate, held to exactly the claim it makes.
//
// `src/gate.ts` opens with a warning that this suite is written to honour: the
// gate is LEXICAL. It has no parser, no scope analysis and no evaluation, so
// `{ ok: true }` means "no rule fired", never "this source is safe". A suite
// that only fed it hostile snippets and watched them bounce would read as proof
// of a strength the implementation does not have, and the next person to skip a
// human review because "the gate checks it" would be reading that suite.
//
// So the file is organised around four propositions, in descending order of how
// much they are worth:
//
//   1. EVERY rule fires. The exhaustiveness test is driven off `gateRuleNames()`
//      rather than off a list written here, so a rule added to `src` without a
//      fixture turns this suite red. A rule that can never fire is not a gate,
//      it is a comment.
//   2. Every doubt is a rejection. Oversize, blank, unbranded, unparseable —
//      each one produces a refusal and never a clearance, and a source whose lex
//      desynchronised never reaches the deny-list at all.
//   3. A clean, realistic spec CLEARS. Without this the gate is "reject
//      everything", which passes every safety assertion above and ships nothing.
//   4. What it CANNOT catch, pinned by name in `the lexical limitation` below.
//      That block is the honest record of the gate's real strength, and each
//      case says whether the current behaviour is a false positive or a false
//      negative and why both are the documented cost of not having an AST.
//
// TM-1 runs through all of it: a `GateViolation` must not carry model-authored
// bytes, because a violation travels to a log, a CI annotation and a chat
// notification — three places the untrusted string was never cleared to reach.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { untrusted } from "@tessera/types";

import {
  GATE_CATEGORIES,
  MAX_GATED_SOURCE_CHARS,
  createGeneratedCodeGate,
  gateRuleNames,
  inspectGeneratedSource,
} from "../build/index.js";

/**
 * A string no rule table, no detail sentence and no category name could ever
 * contain by coincidence. The assertion it serves is not "the message is tidy"
 * but "these exact bytes never left the gate", which only an implausible marker
 * can state.
 */
const CANARY = "canary-6b3f-model-authored-never-echo-this";

/** The one call shape every test uses: brand, inspect, hand back the verdict. */
function gated(source) {
  return inspectGeneratedSource(untrusted(source));
}

/** Rule names of a rejection, in the order the gate reported them. */
function rulesOf(verdict) {
  assert.equal(verdict.ok, false, "expected a rejection, got a clearance");
  return verdict.violations.map((violation) => violation.rule);
}

/** The whole rejection as one string — what a canary assertion greps. */
function textOf(verdict) {
  assert.equal(verdict.ok, false, "expected a rejection, got a clearance");
  return JSON.stringify(verdict.violations);
}

/**
 * A realistic generated unit spec: one behaviour, one assertion pair, no writes.
 *
 * It is deliberately ordinary. The gate has to let this through or the pipeline
 * proposes nothing, and "nothing was ever proposed" is the failure mode a
 * reject-everything gate hides behind.
 */
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

/**
 * One source per rule, keyed by the rule it must provoke.
 *
 * Keyed rather than listed so the exhaustiveness test can compare this table
 * against `gateRuleNames()` in BOTH directions: a new rule with no fixture is a
 * failure, and a fixture for a rule that no longer exists is a failure too.
 *
 * The control, zero-width and bidi characters are written as `\u` escapes on
 * purpose — a literal one in this file would be invisible in a diff, which is
 * the same property that makes the gate refuse them.
 */
const RULE_FIXTURES = {
  // dynamic-code
  eval: "var out = eval(payload);",
  "new-function": 'var f = new Function("return 1;");',
  "function-constructor": 'var f = Function("return 1;");',
  "glide-evaluator": "var e = new GlideEvaluator();",
  "glide-scoped-evaluator": "var e = new GlideScopedEvaluator();",
  "gs-include": 'gs.include("PrototypeServer");',
  "encoded-decoder": "var s = String.fromCharCode(101, 118, 97, 108);",
  "with-statement": "with (gr) { query(); }",
  reflect: "var r = Reflect;",
  "java-bridge": "var rt = Packages.java.lang.Runtime;",
  "gs-alias": "var g = gs;",
  "glide-record-alias": "var G = GlideRecord;",
  "indirect-invoke": "var f = gr.getValue.bind(gr);",
  "prototype-access": "var F = x.constructor.constructor;",
  // unbounded-dml
  insert: "gr.insert();",
  update: "gr.update();",
  "update-multiple": "gr.updateMultiple();",
  "delete-record": "gr.deleteRecord();",
  "delete-multiple": "gr.deleteMultiple();",
  "dml-family-member": "gr.insertWithReferences();",
  "glide-multiple-dml": 'var md = new GlideMultipleDelete("incident");',
  "sys-attachment": "var a = new GlideSysAttachment();",
  // integrity-bypass
  "set-workflow": "gr.setWorkflow(false);",
  "auto-sys-fields": "gr.autoSysFields(false);",
  "set-use-engines": "gr.setUseEngines(false);",
  "set-property": 'gs.setProperty("glide.x", "false");',
  // outbound
  "rest-message": "var m = new RESTMessage();",
  "rest-message-v2": "var m = new RESTMessageV2();",
  "soap-message": "var m = new SOAPMessage();",
  "soap-message-v2": "var m = new SOAPMessageV2();",
  "glide-http-request": "var r = new GlideHTTPRequest();",
  "sn-ws": "var api = sn_ws;",
  "sn-ws-int": "var api = sn_ws_int;",
  "node-runtime": 'var cp = require("child_process");',
  // privilege-escalation
  "set-roles": "session.setRoles(adminRole);",
  impersonate: "impersonator.impersonate(userSysId);",
  "glide-impersonate": "var imp = new GlideImpersonate();",
  "role-table": "var grants = sys_user_has_role;",
  // unrollbackable-side-effect (DR-5)
  "gs-email": "gs.email(to, cc, subject, body);",
  "gs-event-queue": 'gs.eventQueue("x.done", gr, "a", "b");',
  "glide-email-outbound": "var mail = new GlideEmailOutbound();",
  "sysevent-table": "var queue = sysevent;",
  "ecc-queue-table": "var queue = ecc_queue;",
  // unparseable / fail-closed
  "blank-source": "   \n\t  ",
  "oversize-source": "x".repeat(MAX_GATED_SOURCE_CHARS + 1),
  "unterminated-string": 'var a = "still open;',
  "unterminated-template": "var a = `still open;",
  "unterminated-comment": "var a = 1; /* still open",
  "unbalanced-brackets": "function f() { return 1;",
  "unterminated-regex": "var re = /abc;\nvar b = 1;",
  "ambiguous-slash": "if (a) { b(); }\n/x/.test(c);",
  "control-character": "var a = 1;\u0007",
  "zero-width-character": "var a = 1;\u200b",
  "bidi-control-character": "var a = 1;\u202e",
  "escape-obfuscation": 'var a = "\\x41";',
  "computed-call": "gr[methodName]();",
  "computed-member": "var v = gr[k];",
  destructuring: "var { a: b } = gr;",
  "computed-name-concat": 'var f = gr["ins" + "ert"];',
  "identifier-escape": "var \\u0061 = 1;",
  "html-comment": "var a = 1; <!-- note",
  hashbang: "#!/usr/bin/env rhino\nvar a = 1;",
  "string-line-break": 'var a = "one\ntwo";',
};

describe("inspectGeneratedSource — every advertised rule fires (TM-3)", () => {
  it("has exactly one fixture per name in gateRuleNames(), in both directions", () => {
    // The load-bearing assertion of this file. A rule added to `src/gate.ts`
    // and never exercised is indistinguishable from a rule that cannot fire,
    // and the only way to tell them apart is to make the suite fail when the
    // table below stops matching the exported list.
    assert.deepEqual(
      Object.keys(RULE_FIXTURES).sort(),
      [...gateRuleNames()].sort(),
      "the fixture table and gateRuleNames() have drifted apart",
    );
  });

  it("reports the rule its fixture was written for, for all 63 of them", () => {
    const unfired = [];
    for (const rule of gateRuleNames()) {
      const verdict = gated(RULE_FIXTURES[rule]);
      if (verdict.ok || !rulesOf(verdict).includes(rule)) unfired.push(rule);
    }
    // Named, not counted: a failure here has to say WHICH rule went silent, or
    // the next reader has to bisect a forty-three-row table by hand.
    assert.deepEqual(unfired, [], `rules that never fired: ${unfired.join()}`);
  });

  it("reaches every category GATE_CATEGORIES advertises", () => {
    // The category is what a reviewer triages on. A category no rule can reach
    // is a triage bucket that is always empty and a promise nothing keeps.
    const reached = new Set();
    for (const rule of gateRuleNames()) {
      const verdict = gated(RULE_FIXTURES[rule]);
      for (const violation of verdict.violations ?? []) {
        reached.add(violation.category);
      }
    }
    assert.deepEqual([...reached].sort(), [...GATE_CATEGORIES].sort());
  });

  it("classifies `new Function(` under both dynamic-code rules, not one", () => {
    // Not an accident worth hiding: `new Function("…")` satisfies both the
    // `new-function` pattern and the bare `function-constructor` one, and the
    // gate reports both. Two rows for one construct is the right cost — the
    // alternative is a deny-list that stops at the first match and lets the
    // second construct on the same line go unreported.
    assert.deepEqual(rulesOf(gated('var f = new Function("return 1;");')), [
      "function-constructor",
      "new-function",
    ]);
  });
});

describe("inspectGeneratedSource — fail-closed under every doubt (TM-3)", () => {
  it("refuses a blank source and one that is only whitespace", () => {
    // A blank spec is not a harmless no-op: it would clear the gate, land in
    // `proposed/`, and read downstream as a test that exists.
    for (const blank of ["", "   ", "\n\n", "\t \r\n "]) {
      const verdict = gated(blank);
      assert.deepEqual(rulesOf(verdict), ["blank-source"]);
      assert.equal(
        verdict.violations[0].line,
        0,
        "a rule about the whole source has no line to point at",
      );
    }
  });

  it("refuses one character over the cap and clears one character under it", () => {
    // Both sides of the boundary, because an off-by-one here is invisible: the
    // gate would either reject every large-but-legitimate spec or accept the
    // first one nobody reads to the end.
    const exact = "// filler\n".repeat(1_999) + "var a = 1;";
    assert.equal(exact.length, MAX_GATED_SOURCE_CHARS);
    assert.equal(gated(exact).ok, true, "the cap itself must still clear");
    assert.deepEqual(rulesOf(gated(`${exact}x`)), ["oversize-source"]);
    assert.equal(MAX_GATED_SOURCE_CHARS, 20_000);
  });

  it("refuses the oversize source unread, without lexing it", () => {
    // The point of the cap is that nothing downstream of it runs. A source made
    // of nothing but denied constructs comes back with the size rule alone —
    // proof that the gate stopped rather than scanned.
    const huge = "gr.deleteRecord();\n".repeat(2_000);
    assert.ok(huge.length > MAX_GATED_SOURCE_CHARS);
    assert.deepEqual(rulesOf(gated(huge)), ["oversize-source"]);
  });

  it("throws on an unbranded value rather than inspecting it", () => {
    // TM-1's door is `unwrapUntrusted`, and it refuses anything `untrusted()`
    // did not brand. A plain string reaching this function means a caller cast
    // its way past the type system; the gate must not quietly accept the cast,
    // because the brand is the only evidence the value was ever classified.
    assert.throws(
      () => inspectGeneratedSource("gr.deleteRecord();"),
      (error) => {
        assert.equal(error.name, "TypeError");
        assert.match(error.message, /never branded by untrusted\(\)/);
        return true;
      },
    );
    for (const raw of [42, null, undefined, [], () => "src"]) {
      assert.throws(() => inspectGeneratedSource(raw), TypeError);
    }
  });

  it("refuses a hand-rolled or round-tripped `{ value }` object", () => {
    // TM-1 at runtime, after the delegated decision of 2026-09-23. This test
    // used to pin the opposite — a forged `{ value }` walked through the door
    // because the brand was a shape check — so that a real runtime marker
    // would show up here as a deliberate change. This is that change: the
    // door now checks a module-private WeakSet in @tessera/types, so only a
    // box `untrusted()` minted can reach the gate's lexer. A forged box, and a
    // JSON round trip of a real one (the queue/cache/HTTP-hop case), are
    // refused with the door's TypeError before a single rule runs.
    const payload = "gr.deleteRecord();";
    const forgeries = [
      ["a hand-rolled box", { value: payload }],
      ["a JSON round trip", JSON.parse(JSON.stringify(untrusted(payload)))],
      ["a spread copy", { ...untrusted(payload) }],
    ];
    for (const [label, forged] of forgeries) {
      assert.throws(
        () => inspectGeneratedSource(forged),
        (error) => {
          assert.equal(error.name, "TypeError");
          assert.match(error.message, /never branded by untrusted\(\)/);
          return true;
        },
        label,
      );
    }
    // The genuine brand still reaches the deny-list: the refusal above is
    // provenance, not a gate that stopped inspecting.
    assert.deepEqual(rulesOf(inspectGeneratedSource(untrusted(payload))), [
      "delete-record",
    ]);
  });

  it("throws on a branded payload that is not a string", () => {
    // Fail-closed in direction, if not in shape: a number, `null` or
    // `undefined` inside the brand raises rather than clears. The throw is a
    // raw TypeError from `String.prototype.trim` rather than a `GateViolation`,
    // so a caller cannot report it as a gate finding — worth knowing, and
    // pinned here so a future structured rejection is a visible change.
    for (const payload of [42, null, undefined, { nested: true }]) {
      assert.throws(
        () => inspectGeneratedSource(untrusted(payload)),
        TypeError,
        `a branded ${String(payload)} must never clear`,
      );
    }
  });

  it("never consults the deny-list once the lex has desynchronised", () => {
    // The one answer this gate must never give by accident is a clean report.
    // Every source below hides a denied call behind a lexical fault, and the
    // verdict has to be the fault — reporting "no rule fired" from a file the
    // lexer lost track of would be a clean bill of health nobody earned.
    const hidden = [
      ['var a = "open;\ngr.deleteRecord();', "unterminated-string"],
      ["/* open\ngr.deleteRecord();", "unterminated-comment"],
      ["var a = `open;\ngr.deleteRecord();", "unterminated-template"],
      ["function f() {\ngr.deleteRecord();", "unbalanced-brackets"],
      ["var a = 1;\u200b\ngr.deleteRecord();", "zero-width-character"],
    ];
    for (const [source, expected] of hidden) {
      const verdict = gated(source);
      assert.equal(verdict.ok, false);
      assert.ok(
        rulesOf(verdict).includes(expected),
        `${expected} did not fire for ${JSON.stringify(source)}`,
      );
      assert.ok(
        !rulesOf(verdict).includes("delete-record"),
        "the deny-list ran against a classification the lexer could not vouch for",
      );
    }
  });

  it("treats every doubt as a rejection and none of them as a clearance", () => {
    // Restated as one sweep, because the property is "no path from doubt to
    // `ok: true`" rather than "each doubt has its own rule".
    const doubtful = Object.entries(RULE_FIXTURES).filter(([rule]) =>
      rule.endsWith("-source") ? true : rule.startsWith("un"),
    );
    for (const [, source] of doubtful) {
      assert.equal(gated(source).ok, false);
    }
  });
});

describe("inspectGeneratedSource — a clean spec clears (TM-3)", () => {
  it("clears a realistic generated unit spec and returns a ClearedSource", () => {
    const verdict = gated(CLEAN_SPEC);
    assert.equal(
      verdict.ok,
      true,
      `an ordinary spec was refused: ${verdict.ok ? "" : textOf(verdict)}`,
    );
    assert.equal(verdict.cleared.lines, 10);
    assert.equal(verdict.cleared.characters, CLEAN_SPEC.length);
    assert.equal(
      "violations" in verdict,
      false,
      "a clearance must not also carry a violation list",
    );
  });

  it("hands the source back still branded — passing is not laundering", () => {
    // A gate that returned a bare `string` would be a second door out of TM-1:
    // the text is no more trustworthy for having been scanned, and the next
    // consumer would have no type-level reason to keep treating it as hostile.
    const branded = untrusted(CLEAN_SPEC);
    const verdict = inspectGeneratedSource(branded);
    assert.equal(verdict.ok, true);
    assert.equal(
      verdict.cleared.source,
      branded,
      "the cleared source is not the value that went in",
    );
    assert.notEqual(typeof verdict.cleared.source, "string");
  });

  it("mints a clearance that a caller cannot forge or mutate", () => {
    // `./writer.ts` demands a `GateClearance`, which is what makes writing an
    // ungated source a compile error rather than a review comment. The token is
    // frozen so a caller cannot decorate it into meaning something else.
    const clearance = gated(CLEAN_SPEC).cleared.clearance;
    assert.equal(typeof clearance, "object");
    assert.equal(Object.isFrozen(clearance), true);
    assert.equal(
      gated("var a = 1;").cleared.clearance,
      clearance,
      "the clearance is a single minted token, not a fresh object per call",
    );
  });

  it("counts lines and characters off the source, not off the violations", () => {
    const single = gated("var a = 1;");
    assert.equal(single.cleared.lines, 1);
    assert.equal(single.cleared.characters, 10);
    const trailing = gated("var a = 1;\n");
    assert.equal(
      trailing.cleared.lines,
      2,
      "a trailing newline opens a line, and the count says so",
    );
  });
});

describe("inspectGeneratedSource — violations point at the right line", () => {
  it("reports the line the construct is actually on", () => {
    // Off-by-one here sends a reviewer to the wrong line, and a reviewer who
    // reads the wrong line approves the diff.
    const source = [
      "// line 1: prologue",
      "var gr = new GlideRecord('incident');",
      "gr.query();",
      "gr.deleteRecord();",
      "gr.next();",
    ].join("\n");
    const verdict = gated(source);
    assert.deepEqual(rulesOf(verdict), ["delete-record"]);
    assert.equal(verdict.violations[0].line, 4);
  });

  it("counts CRLF line endings as one line each", () => {
    // The lexer counts `\n` only, which is what makes a `\r\n` file come out
    // right instead of double-counting every line.
    const source = "var a = 1;\r\nvar b = 2;\r\ngr.insert();\r\n";
    assert.equal(gated(source).violations[0].line, 3);
  });

  it("uses line 0 for the rules that are about the whole source", () => {
    assert.equal(gated("").violations[0].line, 0);
    assert.equal(gated("x".repeat(30_000)).violations[0].line, 0);
  });

  it("reports every violation in a source, not just the first", () => {
    // A gate that stopped at the first finding would send a spec round the
    // review loop once per denied construct, and a reviewer who fixed one
    // finding would believe the rest of the file was clean.
    const source = [
      "var a = 1;",
      "gr.insert();",
      "gr.deleteRecord();",
      "var m = new RESTMessageV2();",
      "gs.email(to, cc, subject, body);",
    ].join("\n");
    const verdict = gated(source);
    assert.deepEqual(rulesOf(verdict), [
      "insert",
      "delete-record",
      "rest-message-v2",
      "gs-email",
    ]);
    assert.deepEqual(
      verdict.violations.map((violation) => violation.line),
      [2, 3, 4, 5],
    );
  });

  it("orders violations by category, then line, then rule name", () => {
    // A CI annotation that reorders between runs is a diff nobody can read, so
    // the order is a contract and not an implementation detail. Categories lead
    // because a structural fault makes everything under it provisional.
    const source = [
      "gs.email(to, cc, subject, body);",
      "gr.insert();",
      "var m = new RESTMessage();",
      "gr.setWorkflow(false);",
      "var out = eval(payload);",
    ].join("\n");
    const first = gated(source);
    assert.deepEqual(rulesOf(first), [
      "eval",
      "insert",
      "set-workflow",
      "rest-message",
      "gs-email",
    ]);
    assert.deepEqual(rulesOf(gated(source)), rulesOf(first));
  });

  it("reports one row per rule even when a construct repeats", () => {
    // A loop with forty inserts is one fact about the spec. Forty rows would
    // bury the other rules under a single mistake.
    const source = "gr.insert();\n".repeat(40) + "gr.deleteRecord();";
    assert.deepEqual(rulesOf(gated(source)), ["insert", "delete-record"]);
  });
});

describe("GateViolation — no model-authored bytes escape (TM-1)", () => {
  it("never carries a slice of the inspected source", () => {
    // The canary sits ON the offending line, which is exactly where a
    // well-meaning "here is the code that failed" message would pick it up. A
    // violation travels to a log, a CI annotation and a chat notification, and
    // the gate exists to keep instance-derived text from making that trip.
    const source = [
      "// a generated spec that reaches for the instance",
      `gr.deleteRecord("${CANARY}");`,
      `var note = "${CANARY}";`,
    ].join("\n");
    const verdict = gated(source);
    assert.equal(verdict.violations[0].line, 2, "the canary line is the one");
    assert.equal(
      textOf(verdict).includes(CANARY),
      false,
      "the violation quoted the source it was reporting on",
    );
    for (const violation of verdict.violations) {
      for (const value of Object.values(violation)) {
        assert.equal(String(value).includes(CANARY), false);
      }
    }
  });

  it("carries exactly four fields, so a future snippet field cannot slip in", () => {
    // The gate quotes NOTHING, so the bound on what escapes is stated as a
    // closed key set rather than as a length limit. Adding a `snippet` or
    // `excerpt` field would fail here before it could fail in production, which
    // is the only place that particular regression is cheap to catch.
    const verdict = gated(`gr.insert("${CANARY}");`);
    assert.deepEqual(Object.keys(verdict.violations[0]).sort(), [
      "category",
      "detail",
      "line",
      "rule",
    ]);
  });

  it("uses constant detail text, identical across two different sources", () => {
    // The proof that `detail` is a sentence from the rule table and not a
    // rendering of the input: two sources that share nothing but the rule
    // produce byte-identical details.
    const one = gated("gr.insert();").violations[0];
    const two = gated(`payload.insert(${CANARY.replace(/-/g, "_")});`)
      .violations[0];
    assert.equal(one.rule, two.rule);
    assert.equal(one.detail, two.detail);
    assert.match(one.detail, /record insertion/);
  });

  it("keeps the canary out of every rule's report, not just the deny-list's", () => {
    // Structural rules build their own sentences, so they get the same
    // treatment: a source rejected for a lexical fault must not echo the fault.
    for (const source of [
      `var a = "${CANARY};`,
      `function f() { var a = "${CANARY}";`,
      `var a = "${CANARY}\\x41";`,
      `gr[${CANARY.replace(/-/g, "_")}]();`,
    ]) {
      assert.equal(textOf(gated(source)).includes(CANARY), false);
    }
  });
});

describe("the lexical limitation — what this gate cannot catch (DESIGN §9.3)", () => {
  // Every case below is a KNOWN evasion or a KNOWN over-refusal of a scanner
  // with no AST. They are pinned rather than fixed because the package's
  // zero-runtime-dependency rule is what rules out a parser, and a limitation
  // nobody wrote down is a limitation somebody will mistake for a guarantee.
  //
  // Raising any of these to a real answer means an AST for the ES5/Rhino
  // dialect plus an allowlist of call targets — a different piece of work.

  it("an aliased method with no call parenthesis is refused (formerly a false negative)", () => {
    // Until W7b the deny-list matched `.insert(` and binding the method to a
    // name walked straight through. Denied methods are now matched by name.
    assert.deepEqual(rulesOf(gated("var write = gr.insert;\nwrite();")), [
      "insert",
    ]);
  });

  it("a subscript read now and called later is refused (formerly a false negative)", () => {
    // `computed-call` only sees `](`. The read itself is now refused as
    // `computed-member` unless its key is a digit run or a plain quoted name
    // the deny-list admits, and the later `.call` is `indirect-invoke`.
    assert.deepEqual(
      rulesOf(gated('var write = gr["insert"];\nwrite.call(gr);')),
      ["computed-member", "indirect-invoke"],
    );
  });

  it("MISCATEGORISED: bracket notation is refused, but as unparseable", () => {
    // Caught, but reported as `computed-call`/`computed-member` (unparseable)
    // rather than as `insert`/unbounded-dml: `.insert` is never spelled. A
    // reviewer triaging by category sees "the gate could not read this", not
    // "this writes the instance".
    const verdict = gated('gr["insert"]();');
    assert.deepEqual(rulesOf(verdict), ["computed-call", "computed-member"]);
    assert.equal(verdict.violations[0].category, "unparseable");
  });

  it("MISCATEGORISED: a name built by concatenation is caught at the use site", () => {
    // The concatenation itself is invisible when it happens outside the
    // subscript: only the later `gr[m]` fires, on the line that USES the name,
    // not on the line that spelled it.
    const verdict = gated('var m = "ins" + "ert";\ngr[m]();');
    assert.deepEqual(rulesOf(verdict), ["computed-call", "computed-member"]);
    assert.equal(verdict.violations[0].line, 2);
    assert.equal(
      rulesOf(gated('var f = gr["ins" + "ert"];')).includes(
        "computed-name-concat",
      ),
      true,
      "concatenation INSIDE the subscript is the shape the rule can see",
    );
  });

  it("a denied table reached as a string literal is refused (formerly a false negative)", () => {
    // Table, class and method names are ANYWHERE rules since W7b: the
    // realistic way to touch these tables is a string argument.
    for (const [table, rule] of [
      ["sys_user_has_role", "role-table"],
      ["sysevent", "sysevent-table"],
      ["ecc_queue", "ecc-queue-table"],
    ]) {
      assert.deepEqual(
        rulesOf(gated(`var gr = new GlideRecord("${table}");\ngr.query();`)),
        [rule],
      );
    }
  });

  it("FALSE POSITIVE: a denied name inside a comment now fires", () => {
    // The W7b trade, stated. A YAML spec is lexed as JS, so a YAML `# /*`
    // opens a JS block comment and a whole script can sit inside it; a
    // comment-blind deny-list let that through. The cost: the sentence "we
    // must never call deleteRecord here" is refused too.
    assert.deepEqual(
      rulesOf(gated("// never call gr.deleteRecord() in a spec")),
      ["delete-record"],
    );
    assert.deepEqual(
      rulesOf(gated("/* gr.insert() is forbidden */\nvar a = 1;")),
      ["insert"],
    );
  });

  it("a denied name inside a string literal is refused (formerly a false negative)", () => {
    // A double-quoted YAML scalar is one JS string, so a string-blind rule
    // was blind to a whole YAML-embedded script.
    assert.deepEqual(rulesOf(gated('var doc = "gr.insert() is forbidden";')), [
      "insert",
    ]);
  });

  it("FALSE POSITIVE: a legitimate unicode escape is refused", () => {
    // `assertEquals("caf\\u00e9", …)` is an ordinary assertion about accented
    // text, and `escape-obfuscation` refuses it. The rule cannot tell a legible
    // escape from one spelling a denied name character by character, so it
    // refuses both — one reviewer rewrite versus the deny-list losing all of
    // its value at once.
    assert.deepEqual(rulesOf(gated('assertEquals("caf\\u00e9", name);')), [
      "escape-obfuscation",
    ]);
  });

  it("FALSE POSITIVE: a subscript by variable is refused, read or called", () => {
    // `handlers[index]()` and `rows[index]` are perfectly normal and both are
    // refused since W7b: `var m = gr[k]; m.call(gr)` reached deleteMultiple
    // with the call two statements from the subscript. Only a digit run or a
    // plain quoted name the deny-list admits is let through.
    assert.deepEqual(rulesOf(gated("handlers[index]();")), [
      "computed-call",
      "computed-member",
    ]);
    assert.deepEqual(rulesOf(gated("var row = rows[index];")), [
      "computed-member",
    ]);
    assert.equal(gated('var v = map["key"];').ok, true);
    assert.equal(gated("var first = rows[0];").ok, true);
  });

  it("a regex literal containing a quote clears (formerly a false positive)", () => {
    // The lexer now models regex literals, so `/["']/` is one token and the
    // quote inside it opens nothing. Until 2026-09-25 this was rejected as
    // `unterminated-string`.
    assert.equal(gated("var re = /[\"']/;\nvar ok = re.test(name);").ok, true);
  });

  it("a denied call inside a template substitution is rejected", () => {
    // `${…}` is code, not string content. Until 2026-09-25 both of these
    // cleared, which let any denied call hide in an interpolation.
    assert.equal(gated("var s = `id ${gr.getValue('sys_id')}`;").ok, true);
    assert.deepEqual(rulesOf(gated("var s = `x ${gr.insert()}`;")), ["insert"]);
  });
});

describe("inspectGeneratedSource — the lexer (regex literals, template substitutions)", () => {
  it("rejects the review repros: a quote or backtick inside a regex hid what followed", () => {
    // Before regex literals were modelled, the `"` or `` ` `` inside the regex
    // opened a string that swallowed the next line and hid the denied call.
    assert.ok(
      rulesOf(gated('var re = /"/; eval(x); var s = "";')).includes("eval"),
    );
    assert.ok(
      rulesOf(
        gated(
          'var re = /`/;\nnew GlideRecord("incident").deleteMultiple();\nvar t = `x`;',
        ),
      ).includes("delete-multiple"),
    );
  });

  it("rejects each denied call written inside a substitution", () => {
    for (const [source, rule] of [
      ["var t = `${eval(x)}`;", "eval"],
      [
        'var t = `${new GlideRecord("incident").deleteMultiple()}`;',
        "delete-multiple",
      ],
      ['var t = `${gs.eventQueue("e", null)}`;', "gs-event-queue"],
    ]) {
      assert.ok(rulesOf(gated(source)).includes(rule), source);
    }
  });

  it("sees code in a template nested in a substitution in a template", () => {
    assert.deepEqual(rulesOf(gated("var t = `a ${`b ${gr.insert()} c`} d`;")), [
      "insert",
    ]);
    assert.equal(gated("var t = `a ${`b ${name} c`} d`;").ok, true);
  });

  it("handles braces, strings and objects inside a substitution", () => {
    assert.equal(gated("var t = `${ { a: 1 }.a } and ${'}'}`;").ok, true);
    assert.deepEqual(rulesOf(gated("var t = `${'}'}${gr.insert()}`;")), [
      "insert",
    ]);
  });

  it("a slash inside a regex character class does not end the regex", () => {
    assert.equal(gated('var re = /[/"]+/g;\nvar ok = re.test(name);').ok, true);
    assert.ok(
      rulesOf(gated("var re = /[/`]/;\neval(x);\nvar t = `y`;")).includes(
        "eval",
      ),
    );
  });

  it("an escaped slash does not end the regex", () => {
    assert.equal(gated('var re = /a\\/"b/i;\nvar ok = 1;').ok, true);
  });

  it("division is division: `a / b / c` clears and is not read as a regex", () => {
    assert.equal(gated("var r = a / b / c;").ok, true);
    assert.equal(gated("var r = (a + 1) / 2 / count;").ok, true);
    assert.equal(gated("var r = rows[0] / total;").ok, true);
    assert.equal(gated("var r = row.length / 2;").ok, true);
    assert.equal(gated("i++ / 2;").ok, true);
    // A quote after a division is a real string, not regex content.
    assert.equal(gated('var r = a / b; var s = "/";').ok, true);
  });

  it("a regex after a keyword or an if(...) head is a regex", () => {
    assert.equal(gated('function f(s) { return /"/.test(s); }').ok, true);
    assert.equal(gated('if (a) /"/.test(b);').ok, true);
    assert.equal(gated("var ok = typeof /x/;").ok, true);
  });

  it("fails closed on a slash whose reading is uncertain", () => {
    // After a block-closing `}` a `/` may open a regex or divide an object
    // literal's value; the lexer cannot tell, so the gate refuses.
    const verdict = gated("if (a) { b(); }\n/x/.test(c);");
    assert.equal(verdict.ok, false);
    assert.deepEqual(rulesOf(verdict), ["ambiguous-slash"]);
    assert.equal(verdict.violations[0].category, "unparseable");
  });

  it("fails closed on a regex that never closes on its line", () => {
    const verdict = gated("var re = /abc;\ngr.insert();");
    assert.equal(verdict.ok, false);
    assert.ok(rulesOf(verdict).includes("unterminated-regex"));
  });

  it("carries no source text in the new violations (TM-1)", () => {
    for (const source of [
      "var re = /secretvalue;\nvar b = 1;",
      "if (a) { b(); }\n/secretvalue/.test(c);",
    ]) {
      const text = JSON.stringify(gated(source));
      assert.ok(!text.includes("secretvalue"), source);
    }
  });
});

describe("inspectGeneratedSource — determinism and purity", () => {
  it("returns the same verdict for the same input, twice", () => {
    // The gate has to be reproducible in CI with no instance and no network, or
    // a rejection is an argument rather than a fact.
    for (const source of [CLEAN_SPEC, ...Object.values(RULE_FIXTURES)]) {
      assert.deepEqual(gated(source), gated(source));
    }
  });

  it("reads no clock and no randomness", () => {
    // Asserted by removing them: if the gate touched `Date.now` or
    // `Math.random` the call below would throw instead of returning a verdict.
    // Both are restored in `finally`, because leaving a poisoned global behind
    // would break every test that runs after this one.
    const realNow = Date.now;
    const realRandom = Math.random;
    const boom = () => {
      throw new Error("the gate must not read a clock or a random source");
    };
    try {
      Date.now = boom;
      Math.random = boom;
      assert.equal(gated(CLEAN_SPEC).ok, true);
      assert.deepEqual(rulesOf(gated("gr.insert();")), ["insert"]);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
    }
  });

  it("is unaffected by the order sources are inspected in", () => {
    // The deny-list is compiled per scan precisely because a `/g` regex carries
    // `lastIndex` between uses. A stale `lastIndex` would make a verdict depend
    // on what was scanned before it — the exact failure this asserts against.
    const forward = Object.values(RULE_FIXTURES).map((source) =>
      JSON.stringify(gated(source)),
    );
    const reverse = [...Object.values(RULE_FIXTURES)]
      .reverse()
      .map((source) => JSON.stringify(gated(source)))
      .reverse();
    assert.deepEqual(forward, reverse);
  });

  it("createGeneratedCodeGate().inspect agrees with the free function", () => {
    // ARCH-1: `./generator.ts` is handed a gate rather than importing one, so
    // the port and the function it wraps have to be the same decision.
    const gate = createGeneratedCodeGate();
    assert.equal(typeof gate.inspect, "function");
    for (const source of [CLEAN_SPEC, ...Object.values(RULE_FIXTURES)]) {
      const branded = untrusted(source);
      assert.deepEqual(gate.inspect(branded), inspectGeneratedSource(branded));
    }
  });

  it("returns a fresh gate object per call, sharing no scan state", () => {
    const first = createGeneratedCodeGate();
    const second = createGeneratedCodeGate();
    assert.notEqual(first, second);
    assert.equal(gated("gr.insert();").ok, false);
    assert.deepEqual(
      first.inspect(untrusted(CLEAN_SPEC)),
      second.inspect(untrusted(CLEAN_SPEC)),
    );
  });
});
