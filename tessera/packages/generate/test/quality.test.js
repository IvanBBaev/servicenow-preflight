// QA-12(a) — the hermetic, PR-blocking half of the generation quality suite.
//
// The unit under test decides whether a generated batch is worth having. It is
// the check that runs on every pull request, so this suite is written against
// three properties, and a failure of any of them would quietly disarm the bar.
//
// EVERY RULE FIRES. Fourteen rule names are exported; a rule no input can
// trigger is not a bar, it is a comment. So there is one test per rule, each on
// a subject that is otherwise clean — if the subject broke two rules, the test
// would pass for the wrong reason and keep passing after its rule stopped
// working.
//
// NOTHING SHORT-CIRCUITS. The bar runs in a job whose author reads the answer
// once and then fixes what it says, so a batch with two bad specs must report
// both and a spec breaking three rules must report three. A first-finding-wins
// regression would cost that author a round trip per defect and would look
// green in every single-rule test above.
//
// NO MODEL BYTE ESCAPES. Everything this file inspects came out of a model, and
// a finding travels to a log, a CI annotation and a chat notification (TM-1).
// That is the whole reason `QUALITY_RULE_DETAILS` is a constant table, so the
// canary tests below assert the negative directly: a marker planted in a body
// appears in no `detail` and in no summary.
//
// And it is hermetic by construction — no socket, no clock, no disk — which is
// the only reason it is eligible to block a PR at all. The determinism test is
// what would catch a future rule that reached for one.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TEST_KINDS } from "@tessera/types";

import {
  MIN_ASSERTIONS,
  QUALITY_RULES,
  QUALITY_RULE_DETAILS,
  analyzeAssertions,
  checkGenerationQuality,
  createGenerationQualityBar,
  graphTargetKeys,
  summarizeQualityFindings,
  targetKey,
} from "../build/index.js";

import {
  ASSERTING_SOURCE,
  CANARY,
  demand,
  edge,
  graphWith,
  source,
  subject,
  sysId,
  target,
  unanalyzed,
} from "./support.js";

/** The one artifact every "otherwise clean" subject points at. */
const GROUNDED = target("grounded");
const GRAPH = graphWith([GROUNDED]);

/** A subject that breaks nothing, with `fields` overriding exactly one thing. */
function clean(fields = {}) {
  return subject({ targets: [GROUNDED], ...fields });
}

const rulesOf = (verdict) => verdict.findings.map((entry) => entry.rule);

/** A rejecting verdict, with the rule names in the failure message when it is not. */
function failing(subjects, graph = GRAPH) {
  const verdict = checkGenerationQuality(subjects, graph);
  assert.equal(verdict.ok, false, "expected the batch to be rejected");
  return verdict;
}

/**
 * The single finding a one-rule test expects. The count assertion is the one
 * that keeps these tests honest: a fixture that accidentally broke a second
 * rule would otherwise pass while proving nothing about the rule it names.
 */
function onlyFinding(subjects, graph = GRAPH) {
  const verdict = failing(subjects, graph);
  assert.equal(
    verdict.findings.length,
    1,
    `expected exactly one finding, got: ${rulesOf(verdict).join(", ")}`,
  );
  return verdict.findings[0];
}

/** A body with no assertion vocabulary anywhere in it. */
const SILENT_SOURCE = [
  "export function run(step) {",
  "  const record = step.getRecord();",
  "  record.setValue('state', 'closed');",
  "}",
].join("\n");

describe("the rule table", () => {
  it("names fifteen rules and gives every one of them constant detail text", () => {
    // The union and the detail table are two halves of one declaration; a rule
    // present in one and missing from the other would produce a finding whose
    // `detail` is `undefined` — a message with no explanation in it.
    assert.equal(QUALITY_RULES.length, 15);
    assert.equal(new Set(QUALITY_RULES).size, 15, "a rule name is repeated");
    for (const rule of QUALITY_RULES) {
      const detail = QUALITY_RULE_DETAILS[rule];
      assert.equal(typeof detail, "string", `${rule} has no detail`);
      assert.ok(detail.trim() !== "", `${rule} has blank detail`);
    }
    assert.deepEqual(
      Object.keys(QUALITY_RULE_DETAILS).sort(),
      [...QUALITY_RULES].sort(),
    );
  });

  it("sets the assertion floor at one, not at a ratio", () => {
    // A density target is a number somebody picked, and the first terse spec it
    // rejected would teach the next author to pad. Zero is different in kind.
    assert.equal(MIN_ASSERTIONS, 1);
  });
});

describe("a clean batch", () => {
  it("passes and reports the assertions it counted", () => {
    const verdict = checkGenerationQuality(
      [
        clean({ id: "a", path: "generated/a.unit.ts" }),
        clean({ id: "b", path: "generated/b.unit.ts" }),
      ],
      GRAPH,
    );
    assert.equal(verdict.ok, true, "a clean batch was rejected");
    assert.equal(verdict.checked, 2);
    // Non-zero on purpose: `ok: true` with `assertions: 0` would mean the
    // counter stopped working and `no-assertion` stopped being reachable.
    assert.equal(verdict.assertions, 2);
    assert.equal("findings" in verdict, false);
  });

  it("accepts every kind the workspace declares", () => {
    for (const kind of TEST_KINDS) {
      const verdict = checkGenerationQuality(
        [clean({ kind, path: `generated/${kind}.unit.ts` })],
        GRAPH,
      );
      assert.equal(verdict.ok, true, `kind ${kind} was rejected`);
    }
  });
});

describe("every rule fires", () => {
  it("empty-batch — on a batch with no specs at all", () => {
    // Not "nothing to check": an empty batch is a claim that nothing in the
    // impact graph is worth testing, and downstream that reads as a clean bill
    // of health (OPP-1b).
    const verdict = failing([]);
    assert.equal(verdict.checked, 0);
    assert.deepEqual(rulesOf(verdict), ["empty-batch"]);
    // Position 0 and a blank id: the finding is about the batch, and there is
    // no subject to point at.
    assert.equal(verdict.findings[0].position, 0);
    assert.equal(verdict.findings[0].specId, "");
  });

  it("blank-id — on a spec the manifest reader would drop", () => {
    const found = onlyFinding([clean({ id: "   " })]);
    assert.equal(found.rule, "blank-id");
    assert.equal(found.position, 1);
    assert.equal(found.specId, "", "a blank id must not be echoed as itself");
  });

  it("duplicate-id — on the second spec claiming an id, never the first", () => {
    const found = onlyFinding([
      clean({ id: "dup", path: "generated/a.unit.ts" }),
      clean({ id: "dup", path: "generated/b.unit.ts" }),
    ]);
    assert.equal(found.rule, "duplicate-id");
    // The reader keeps the first and warns about the rest, so the second is the
    // one that would disappear on promotion.
    assert.equal(found.position, 2);
    assert.equal(found.specId, "dup");
  });

  it("blank-path — on a spec with nothing to point at", () => {
    const found = onlyFinding([clean({ path: "" })]);
    assert.equal(found.rule, "blank-path");
    assert.equal(found.specId, "spec-1");
  });

  it("absolute-path — on a path named from the filesystem root", () => {
    const found = onlyFinding([clean({ path: "/generated/a.unit.ts" })]);
    assert.equal(found.rule, "absolute-path");
  });

  it("escaping-path — on a path that climbs out of the tests root", () => {
    const found = onlyFinding([clean({ path: "../outside/a.unit.ts" })]);
    assert.equal(found.rule, "escaping-path");
  });

  it("duplicate-path — on two ids over one file", () => {
    const found = onlyFinding([
      clean({ id: "a", path: "generated/same.unit.ts" }),
      clean({ id: "b", path: "generated/same.unit.ts" }),
    ]);
    assert.equal(found.rule, "duplicate-path");
    assert.equal(found.position, 2);
  });

  it("unknown-kind — on a kind no runner claims", () => {
    const found = onlyFinding([clean({ kind: "smoke" })]);
    assert.equal(found.rule, "unknown-kind");
  });

  it("untargeted-spec — on a spec with an empty target list", () => {
    // QA-16 joins coverage on the declared link and never on the file path, so
    // a spec with no targets confirms nothing however well it runs.
    const found = onlyFinding([clean({ targets: [] })]);
    assert.equal(found.rule, "untargeted-spec");
    assert.equal(found.detail, QUALITY_RULE_DETAILS["untargeted-spec"]);
  });

  it("malformed-target — on a target missing one of table/sysId/name", () => {
    const found = onlyFinding([
      clean({
        targets: [{ table: "sys_script", sysId: sysId("x"), name: "  " }],
      }),
    ]);
    assert.equal(found.rule, "malformed-target");
    // The offset is given so a reviewer can find the target in a spec that
    // declares four of them; the target itself is never quoted.
    assert.ok(found.detail.endsWith("(target #1)"), found.detail);
  });

  it("ungrounded-target — on an artifact the graph never mentions", () => {
    const found = onlyFinding([clean({ targets: [target("invented")] })]);
    assert.equal(found.rule, "ungrounded-target");
    assert.ok(found.detail.endsWith("(target #1)"), found.detail);
  });

  it("blank-source — on a spec whose body is whitespace", () => {
    const found = onlyFinding([clean({ source: "  \n\t " })]);
    assert.equal(found.rule, "blank-source");
  });

  it("no-assertion — on a body that runs and cannot fail", () => {
    const found = onlyFinding([clean({ source: SILENT_SOURCE })]);
    assert.equal(found.rule, "no-assertion");
    // A character count, not a slice: it separates "blank" from "wrote a lot
    // and asserted nothing", which are two different review comments.
    assert.ok(
      found.detail.endsWith(`(${SILENT_SOURCE.trim().length} characters)`),
      found.detail,
    );
  });

  it("tautological-assertion — on an assertion that cannot fail", () => {
    const found = onlyFinding([clean({ source: "assert(true);" })]);
    assert.equal(found.rule, "tautological-assertion");
    assert.ok(found.detail.endsWith("(1 of 1)"), found.detail);
  });

  it("unsafe-field — on a bidi override in a target name (W7b M1)", () => {
    const found = onlyFinding([
      clean({ targets: [{ ...GROUNDED, name: "Discount\u202Eevil" }] }),
    ]);
    assert.equal(found.rule, "unsafe-field");
  });

  it("unsafe-field — on a control character in the id, which is then not echoed", () => {
    const found = onlyFinding([clean({ id: "spec\u001b[2Jx" })]);
    assert.equal(found.rule, "unsafe-field");
    assert.equal(found.specId, "", "the unsafe id was echoed into specId");
  });

  it("unsafe-field — on a zero-width character in the path, and an overlong sysId", () => {
    const verdict = failing([
      clean({ path: "generated/spec\u200B-1.unit.ts" }),
      clean({
        id: "spec-2",
        path: "generated/spec-2.unit.ts",
        targets: [{ ...GROUNDED, sysId: "a".repeat(65) }],
      }),
    ]);
    const rules = rulesOf(verdict);
    assert.equal(rules[0], "unsafe-field");
    assert.ok(rules.includes("unsafe-field"));
    assert.equal(
      verdict.findings.filter((f) => f.rule === "unsafe-field").length,
      2,
    );
  });

  it("unsafe-field — two unsafe ids are not reported as duplicates of each other", () => {
    const verdict = failing([
      clean({ id: "a\u202E", path: "generated/a.unit.ts" }),
      clean({ id: "b\u202E", path: "generated/b.unit.ts" }),
    ]);
    assert.deepEqual(rulesOf(verdict), ["unsafe-field", "unsafe-field"]);
  });

  it("leaves no rule in the table unproven by this suite", () => {
    // The list above is checked against the exported union, so a sixteenth rule
    // added without a test here fails this assertion rather than shipping
    // untested.
    const proven = new Set([
      "empty-batch",
      "blank-id",
      "duplicate-id",
      "blank-path",
      "absolute-path",
      "escaping-path",
      "duplicate-path",
      "unknown-kind",
      "untargeted-spec",
      "malformed-target",
      "ungrounded-target",
      "blank-source",
      "no-assertion",
      "tautological-assertion",
      "unsafe-field",
    ]);
    assert.deepEqual([...QUALITY_RULES].sort(), [...proven].sort());
  });
});

describe("reporting — nothing short-circuits", () => {
  it("reports both bad specs in a batch, in batch order", () => {
    const verdict = failing([
      clean({ id: "a", path: "generated/a.unit.ts", source: SILENT_SOURCE }),
      clean({ id: "b", path: "" }),
    ]);
    assert.equal(verdict.checked, 2);
    assert.deepEqual(rulesOf(verdict), ["no-assertion", "blank-path"]);
    assert.deepEqual(
      verdict.findings.map((entry) => entry.position),
      [1, 2],
    );
  });

  it("reports three findings for one spec that breaks three rules", () => {
    const verdict = failing([clean({ id: "", kind: "smoke", targets: [] })]);
    assert.deepEqual(rulesOf(verdict), [
      "blank-id",
      "unknown-kind",
      "untargeted-spec",
    ]);
    for (const found of verdict.findings) assert.equal(found.position, 1);
  });

  it("points `position` at the offending subject and not at the finding index", () => {
    const verdict = failing([
      clean({ id: "a", path: "generated/a.unit.ts" }),
      clean({ id: "b", path: "generated/b.unit.ts", source: SILENT_SOURCE }),
      clean({ id: "c", path: "generated/c.unit.ts" }),
    ]);
    assert.equal(verdict.findings.length, 1);
    assert.equal(verdict.findings[0].position, 2);
    assert.equal(verdict.findings[0].specId, "b");
  });

  it("reads a subject as wire data rather than as its declared type", () => {
    // A hand-written fixture and a model answer are both allowed to be missing
    // a field. A `TypeError` out of the validator would be a worse answer than
    // a finding, and would take the rest of the batch down with it.
    const verdict = failing([
      { spec: undefined, source: source(ASSERTING_SOURCE) },
      {
        spec: { ref: { id: "b", path: "generated/b.unit.ts" }, kind: "unit" },
        source: source(ASSERTING_SOURCE),
      },
    ]);
    assert.deepEqual(rulesOf(verdict), [
      "blank-id",
      "blank-path",
      "unknown-kind",
      "untargeted-spec",
      "untargeted-spec",
    ]);
    // The second subject's `targets` is absent rather than empty, and the
    // finding says which of the two it was.
    assert.ok(
      verdict.findings[4].detail.endsWith("(`targets` is not an array)"),
      verdict.findings[4].detail,
    );
  });

  it("checks every target of a spec, not just the first", () => {
    const verdict = failing([
      clean({
        targets: [GROUNDED, target("invented"), { table: "x", sysId: "" }],
      }),
    ]);
    assert.deepEqual(rulesOf(verdict), [
      "ungrounded-target",
      "malformed-target",
    ]);
    assert.ok(verdict.findings[0].detail.endsWith("(target #2)"));
    assert.ok(verdict.findings[1].detail.endsWith("(target #3)"));
  });
});

describe("no-assertion — the rule that matters most", () => {
  // A missing test shows up in a gap count. A vacuous one shows up as success,
  // gets counted as confirmed coverage of every artifact it names, and gets
  // greener with age. This is the rule this whole file exists for.

  it("fires on a body with no assertion vocabulary at all", () => {
    assert.equal(
      onlyFinding([clean({ source: SILENT_SOURCE })]).rule,
      "no-assertion",
    );
  });

  it("fires on a body that is nothing but prose comments", () => {
    const found = onlyFinding([
      clean({
        source: [
          "// PROPOSED spec for the impacted business rule.",
          "// TODO: decide what this should check.",
        ].join("\n"),
      }),
    ]);
    assert.equal(found.rule, "no-assertion");
  });

  it("fires when an assert-looking word sits inside a string literal", () => {
    // The word alone is not a call. The bar counts calls, so a label mentioning
    // assertions does not buy a spec its way past the floor.
    const found = onlyFinding([
      clean({
        source: [
          "export function run(step) {",
          '  const label = "assert the record was loaded";',
          "  step.log(label);",
          "}",
        ].join("\n"),
      }),
    ]);
    assert.equal(found.rule, "no-assertion");
  });

  it("does not fire once a single real assertion is present", () => {
    // The floor is one. This is the assertion that keeps the rule from becoming
    // a density target nobody can satisfy honestly.
    const verdict = checkGenerationQuality([clean()], GRAPH);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.assertions, 1);
  });
});

describe("tautological-assertion", () => {
  const flags = (body) => {
    const found = onlyFinding([clean({ source: body })]);
    assert.equal(found.rule, "tautological-assertion", body);
  };

  it("flags a constant as the only operand", () => {
    flags("assert(true);");
    flags('assertOk("ready");');
  });

  it("flags the same expression on both sides", () => {
    flags("assert.equal(x, x);");
    flags("assertEquals(record.getValue('state'), record.getValue('state'));");
  });

  it("flags a self-comparison inside one operand", () => {
    flags("assert(record === record);");
  });

  it("flags a matcher chain that compares a constant with itself", () => {
    // `expect(a)` says nothing until its matcher arrives, so both calls' operands
    // have to be judged as one argument list.
    flags("expect(1).toBe(1);");
  });

  it("does NOT flag a real comparison against a literal expectation", () => {
    // `assertEquals(true, isOk())` is an ordinary useful assertion. Flagging a
    // constant that stands beside a real operand would teach authors to hide
    // their expected values behind variables, which helps nobody.
    const verdict = checkGenerationQuality(
      [
        clean({
          id: "a",
          path: "generated/a.unit.ts",
          source: 'expect(record.getValue("state")).toBe("closed");',
        }),
        clean({
          id: "b",
          path: "generated/b.unit.ts",
          source: 'assertEqual("state is closed", true, record.isClosed());',
        }),
      ],
      GRAPH,
    );
    assert.equal(verdict.ok, true, "a real comparison was called tautological");
  });

  it("fires on one tautology among several good assertions", () => {
    // Any tautology, not a ratio: one `assertEquals(x, x)` among nine honest
    // assertions still passes forever, and the rule is about the construct.
    const found = onlyFinding([
      clean({
        source: [
          'assertEqual("state", "closed", record.getValue("state"));',
          "assert(true);",
        ].join("\n"),
      }),
    ]);
    assert.equal(found.rule, "tautological-assertion");
    assert.ok(found.detail.endsWith("(1 of 2)"), found.detail);
  });
});

describe("blank-source suppresses the assertion rules", () => {
  it("reports one finding for a blank body, not three", () => {
    // A blank body has no assertions either, and a second line saying so sends
    // the reader looking for a second problem. One cause, one finding.
    for (const body of ["", "   ", "\n\t\n"]) {
      const verdict = failing([clean({ source: body })]);
      assert.deepEqual(
        rulesOf(verdict),
        ["blank-source"],
        `body ${JSON.stringify(body)}`,
      );
    }
  });
});

describe("grounding", () => {
  it("targetKey normalises case and whitespace and ignores the name", () => {
    // Casing and stray whitespace must not manufacture a phantom mismatch, and
    // `name` is model-authored prose — requiring it to match would fail a spec
    // for describing the right record with different words.
    assert.equal(
      targetKey({ table: " SYS_Script ", sysId: " AB01 ", name: "one" }),
      targetKey({ table: "sys_script", sysId: "ab01", name: "quite another" }),
    );
    // NUL joins the halves because it can occur in neither, so `a.b`/`c` and
    // `a`/`b.c` cannot collide into a silent grounding pass.
    assert.ok(
      targetKey({ table: "a", sysId: "b", name: "n" }).includes("\u0000"),
    );
  });

  it("graphTargetKeys unions all four lists of the graph", () => {
    const node = target("node");
    const from = target("from");
    const to = target("to");
    const opaque = target("opaque");
    const wanted = target("wanted");
    const keys = graphTargetKeys(
      graphWith([node], {
        edges: [edge(from, to)],
        unanalyzable: [unanalyzed(opaque)],
        demanded: [demand(wanted)],
      }),
    );
    assert.equal(keys.size, 5);
    for (const entry of [node, from, to, opaque, wanted]) {
      assert.ok(keys.has(targetKey(entry)), `${entry.name} is not grounded`);
    }
  });

  it("grounds a spec aimed at an artifact the analysis could not trace", () => {
    // QA-9: an untraceable artifact is still impacted and still in the QA-15
    // floor's denominator, so a spec aimed at one is aimed at the hardest part
    // of the change. Refusing it would be exactly backwards.
    const opaque = target("opaque");
    const verdict = checkGenerationQuality(
      [clean({ targets: [opaque] })],
      graphWith([], { unanalyzable: [unanalyzed(opaque)] }),
    );
    assert.equal(verdict.ok, true);
  });

  it("tolerates a graph that leaves lists out", () => {
    // A hand-written fixture graph is allowed to omit a list it has nothing
    // for. A `TypeError` out of the bar is a worse answer than a finding.
    assert.equal(graphTargetKeys({}).size, 0);
    assert.equal(graphTargetKeys({ nodes: [GROUNDED] }).size, 1);
    assert.equal(
      graphTargetKeys({ edges: [edge(GROUNDED, GROUNDED)] }).size,
      1,
    );
    const verdict = failing([clean()], { nodes: [] });
    assert.deepEqual(rulesOf(verdict), ["ungrounded-target"]);
  });

  it("ignores graph entries that are not usable artifact references", () => {
    const keys = graphTargetKeys(
      graphWith(["not-a-record", null, { table: "sys_script", sysId: "  " }]),
    );
    assert.equal(keys.size, 0);
  });

  it("does not fail a spec for the casing the model happened to use", () => {
    const verdict = checkGenerationQuality(
      [
        clean({
          targets: [
            {
              table: GROUNDED.table.toUpperCase(),
              sysId: ` ${GROUNDED.sysId.toUpperCase()} `,
              name: "the same record, described differently",
            },
          ],
        }),
      ],
      GRAPH,
    );
    assert.equal(verdict.ok, true, "casing manufactured a phantom mismatch");
  });
});

describe("path containment is pure string arithmetic (INJ-1)", () => {
  // Whether the file EXISTS is `@tessera/specs`' question. This is about the
  // binding, and it is decidable from the string alone — which is what keeps
  // the whole suite hermetic.

  const ruleFor = (candidatePath) => {
    const verdict = checkGenerationQuality(
      [clean({ path: candidatePath })],
      GRAPH,
    );
    return verdict.ok ? undefined : verdict.findings[0].rule;
  };

  it("rejects absolute paths in both flavours", () => {
    // A manifest travels between a macOS developer, a Windows one and a Linux
    // runner, and `C:\tests\x.unit.ts` is absolute on the machine that wrote it
    // whatever `path.isAbsolute` says on the machine that reads it.
    assert.equal(ruleFor("/generated/a.unit.ts"), "absolute-path");
    assert.equal(ruleFor("C:\\generated\\a.unit.ts"), "absolute-path");
    assert.equal(ruleFor("\\\\share\\generated\\a.unit.ts"), "absolute-path");
  });

  it("rejects a path that normalises to a leading `..`", () => {
    assert.equal(ruleFor("../a.unit.ts"), "escaping-path");
    assert.equal(ruleFor("generated/../../a.unit.ts"), "escaping-path");
  });

  it("treats a backslash as a separator when counting `..` segments", () => {
    // Without the backslash split, `generated\..\..\a.unit.ts` is one long
    // filename with no `..` segment in it, and it walks straight through.
    assert.equal(ruleFor("generated\\..\\..\\a.unit.ts"), "escaping-path");
  });

  it("accepts a `..` that stays inside the root after normalisation", () => {
    // The rule is containment, not a ban on the two-dot token.
    assert.equal(ruleFor("generated/../other/a.unit.ts"), undefined);
  });

  it("normalises before comparing paths, so separators cannot hide a duplicate", () => {
    const verdict = failing([
      clean({ id: "a", path: "generated/same.unit.ts" }),
      clean({ id: "b", path: "generated\\same.unit.ts" }),
    ]);
    assert.deepEqual(rulesOf(verdict), ["duplicate-path"]);
  });

  it("reports the absolute path and stops, rather than both path rules", () => {
    // One cause, one finding: `/a/../../b` is absolute first, and a second
    // finding about its `..` would send the author looking for two fixes.
    assert.equal(ruleFor("/generated/../../a.unit.ts"), "absolute-path");
  });
});

describe("hermetic — no network, no clock, no disk, no model bytes", () => {
  it("returns the same verdict for the same input, twice", () => {
    // The bar reads its two arguments and nothing else. A rule that reached for
    // a clock, a socket or the filesystem would show up here first.
    const build = () => [
      clean({ id: "a", path: "generated/a.unit.ts", source: SILENT_SOURCE }),
      clean({ id: "b", path: "/absolute.unit.ts" }),
      clean({ id: "a", path: "generated/c.unit.ts" }),
    ];
    const first = checkGenerationQuality(build(), GRAPH);
    const second = checkGenerationQuality(build(), GRAPH);
    assert.deepEqual(first, second);
  });

  it("lets no model-authored byte reach a finding or a summary", () => {
    // The canary is planted where a naive implementation would quote from: the
    // body, the declared path and the target's prose name. None of the three
    // may travel, because a finding ends up in a log, a CI annotation and a
    // chat notification (TM-1).
    const verdict = failing([
      clean({
        id: `spec-${CANARY}`,
        path: `generated/${CANARY}.unit.ts`,
        targets: [target("invented", { name: `Business Rule: ${CANARY}` })],
        source: `// ${CANARY}\nexport function run() {}\n`,
      }),
    ]);
    assert.deepEqual(rulesOf(verdict), ["ungrounded-target", "no-assertion"]);
    for (const found of verdict.findings) {
      assert.equal(
        found.detail.includes(CANARY),
        false,
        `${found.rule} leaked the body into its detail`,
      );
    }
    assert.equal(
      summarizeQualityFindings(verdict.findings).includes(CANARY),
      false,
    );
  });

  it("builds every detail from the constant table and nothing else", () => {
    // The stronger form of the canary test: not "the marker is absent" but
    // "every detail begins with developer-written text from the rule table".
    const verdict = failing([
      clean({ id: "", kind: "smoke", path: "../x.unit.ts", source: "" }),
      clean({
        id: "b",
        path: "generated/b.unit.ts",
        targets: [target("gone")],
      }),
    ]);
    for (const found of verdict.findings) {
      assert.ok(
        found.detail.startsWith(QUALITY_RULE_DETAILS[found.rule]),
        `${found.rule}: ${found.detail}`,
      );
    }
  });
});

describe("summarizeQualityFindings", () => {
  it("counts by rule and sorts by name, so two runs diff cleanly", () => {
    const verdict = failing([
      clean({ id: "a", path: "generated/a.unit.ts", source: SILENT_SOURCE }),
      clean({ id: "", path: "generated/b.unit.ts", source: SILENT_SOURCE }),
    ]);
    assert.equal(
      summarizeQualityFindings(verdict.findings),
      "blank-id (1), no-assertion (2)",
    );
  });

  it("is stable under the order the findings arrive in", () => {
    const findings = [
      { rule: "no-assertion", position: 1, specId: "a", detail: "x" },
      { rule: "blank-id", position: 2, specId: "", detail: "y" },
      { rule: "no-assertion", position: 3, specId: "c", detail: "z" },
    ];
    const forward = summarizeQualityFindings(findings);
    const backward = summarizeQualityFindings([...findings].reverse());
    assert.equal(forward, backward);
    assert.equal(forward, "blank-id (1), no-assertion (2)");
  });

  it("answers with an empty string when there is nothing to summarise", () => {
    assert.equal(summarizeQualityFindings([]), "");
  });
});

describe("analyzeAssertions", () => {
  it("separates a blank body from one that asserts nothing", () => {
    // `characters` is what lets `blank-source` and `no-assertion` be two
    // different review comments rather than one vague one.
    assert.deepEqual(analyzeAssertions(source("   \n ")), {
      characters: 0,
      total: 0,
      trivial: 0,
    });
    const silent = analyzeAssertions(source(SILENT_SOURCE));
    assert.equal(silent.total, 0);
    assert.equal(silent.characters, SILENT_SOURCE.trim().length);
  });

  it("counts the assertion vocabulary of all three spec languages", () => {
    // One table across kinds, deliberately: a YAML key matched inside a
    // TypeScript file costs nothing, and one table means a kind added later
    // cannot arrive with no vocabulary at all.
    assert.equal(analyzeAssertions(source(ASSERTING_SOURCE)).total, 1);
    const yaml = [
      "- step: Record Validation",
      "  assertions:",
      "    - field: state",
      "      expected_value: closed",
    ].join("\n");
    // Two YAML keys plus the exact ATF step name.
    assert.equal(analyzeAssertions(source(yaml)).total, 3);
  });

  it("counts a matcher chain once, with both operands", () => {
    const analysis = analyzeAssertions(source("expect(1).toBe(1);"));
    assert.equal(analysis.total, 1);
    assert.equal(analysis.trivial, 1);
  });

  it("says nothing about triviality when a call never closes", () => {
    // That source is already rejected by the gate's `unbalanced-brackets` rule,
    // so reaching it here means the bar was pointed at ungated text — and
    // guessing from a truncated argument list would be worse than abstaining.
    const analysis = analyzeAssertions(source("assert(true"));
    assert.equal(analysis.total, 1);
    assert.equal(analysis.trivial, 0);
  });

  it("over-counts assertions in comments and string literals, by documented design", () => {
    // DOCUMENTED BEHAVIOUR, not an accident: the counter is lexical and does
    // not mask comments or strings, so `total` is a CEILING. Excluding them
    // would mean re-implementing the gate's lexer, and the two failure modes
    // are not comparable — a gate that miscounts lets a hostile script run, a
    // bar that miscounts lets a weak test reach the human reviewer every
    // proposed spec is going to anyway (DEV-4). This test exists so the day
    // somebody tightens it, they do it on purpose.
    assert.equal(analyzeAssertions(source("// assert(record);")).total, 1);
    assert.equal(
      analyzeAssertions(source('const help = "assert(ok)";')).total,
      1,
    );
    // And the consequence at the bar: a body whose only assertion is commented
    // out is currently NOT reported as `no-assertion`.
    const verdict = checkGenerationQuality(
      [clean({ source: "export function run() {\n  // assert(record);\n}" })],
      GRAPH,
    );
    assert.equal(verdict.ok, true);
  });
});

describe("createGenerationQualityBar", () => {
  it("is the port the composition root hands the generator (ARCH-1)", () => {
    // Nothing inside `@tessera/generate` calls the bar itself; a test can
    // therefore tighten or loosen it without touching the generator.
    const bar = createGenerationQualityBar();
    assert.equal(typeof bar.check, "function");
    assert.deepEqual(
      bar.check([clean()], GRAPH),
      checkGenerationQuality([clean()], GRAPH),
    );
    assert.equal(bar.check([], GRAPH).ok, false);
  });
});
