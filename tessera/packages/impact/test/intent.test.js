// The pre-run intent join — DESIGN §4a, PLAN Phase 4 read side.
//
// `computeIntent` is pure, so every test here is a table: a hand-built
// `ImpactReport` plus a hand-built spec inventory in, an `IntentReport` out. No
// stub, no seam, no clock — if one of these ever needs a fixture with an
// instance in it, the function has grown a dependency it must not have.
//
// The assertions that matter most are the ones about what must NOT happen: an
// artifact only ever seen as `unanalyzable` must not vanish from `entries` (it
// is QA-15's denominator, and losing it makes every future coverage figure rise
// as the analysis gets worse), a spec must not match on `name` or on its path
// (QA-16 — the link is declared), and the gap summary must not read as a
// coverage measurement (QA-8: a spec that exists is not a spec that passed).

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeIntent, intentGaps, isIncomplete } from "../build/index.js";

/** A 32-hex sys_id from a short prefix — the fixtures read by name, not by id. */
function sysId(prefix) {
  return prefix.padEnd(32, "0");
}

const CALCULATOR = {
  table: "sys_script_include",
  sysId: sysId("ca1c"),
  name: "AmountCalculator",
};
const ZONE = {
  table: "sys_script_include",
  sysId: sysId("20ne"),
  name: "ZoneLookup",
};
const HELPER = {
  table: "sys_script_include",
  sysId: sysId("he1b"),
  name: "HelperInclude",
};
const ALPHA_RULE = {
  table: "sys_script",
  sysId: sysId("a1fa"),
  name: "Alpha rule",
};

/** Same display name as CALCULATOR, different row — the QA-16 trap. */
const CALCULATOR_TWIN = { ...CALCULATOR, sysId: sysId("7w1n") };

function graph({ nodes = [], edges = [], unanalyzable = [], demanded = [] }) {
  return { nodes, edges, unanalyzable, demanded };
}

function report({ notes = [], ...rest } = {}) {
  return { graph: graph(rest), notes };
}

function untraced(artifact, reason = "the MVP traces sys_script_include only") {
  return { artifact, reason };
}

/** A `TestSpec`: identity is `ref.id`, and the join is `targets` alone. */
function spec(id, targets, { kind = "unit", path } = {}) {
  return { ref: { id, path: path ?? `tests/${id}.unit.ts` }, kind, targets };
}

function messages(intent, level) {
  return intent.notes
    .filter((note) => level === undefined || note.level === level)
    .map((note) => note.message);
}

function specIds(entry) {
  return entry.specs.map((ref) => ref.id);
}

describe("the impacted universe entries are built from", () => {
  it("covers every node, with and without a spec", () => {
    const intent = computeIntent(report({ nodes: [CALCULATOR, ZONE] }), [
      spec("calc", [CALCULATOR]),
    ]);

    assert.deepEqual(
      intent.entries.map((entry) => [entry.artifact.name, specIds(entry)]),
      [
        // (table, sysId): ZoneLookup's `20ne…` sorts before `ca1c…`.
        ["ZoneLookup", []],
        ["AmountCalculator", ["calc"]],
      ],
    );
    // A gap is `specs.length === 0` on the one list, never a second list that
    // can drift out of step with it.
    assert.deepEqual(intentGaps(intent), [ZONE]);
  });

  it("keeps an artifact that appears ONLY in unanalyzable", () => {
    // The QA-15 denominator case. Nothing put this row in `nodes` — building
    // `entries` from `nodes` alone would drop exactly the artifact the
    // coverage floor exists to catch, and the ratio would climb every time the
    // analysis got WORSE.
    const intent = computeIntent(
      report({ nodes: [CALCULATOR], unanalyzable: [untraced(ALPHA_RULE)] }),
      [],
    );

    assert.equal(intent.entries.length, 2);
    const rule = intent.entries.find(
      (entry) => entry.artifact.sysId === ALPHA_RULE.sysId,
    );
    assert.deepEqual(rule.artifact, ALPHA_RULE);
    assert.equal(rule.analyzable, false);
    assert.deepEqual(rule.specs, []);
  });

  it("counts an artifact in BOTH lists exactly once, as unanalyzable", () => {
    const intent = computeIntent(
      report({
        nodes: [CALCULATOR, ALPHA_RULE],
        // The same artifact, untraceable for two different reasons — one
        // impacted artifact all the same.
        unanalyzable: [
          untraced(ALPHA_RULE, "dynamic dispatch: eval, line 4"),
          untraced(ALPHA_RULE, "the MVP traces sys_script_include only"),
        ],
      }),
      [spec("rule", [ALPHA_RULE])],
    );

    assert.equal(intent.entries.length, 2);
    const rule = intent.entries.filter(
      (entry) => entry.artifact.sysId === ALPHA_RULE.sysId,
    );
    assert.equal(rule.length, 1);
    assert.equal(rule[0].analyzable, false);
    // What the analyzer failed to see is which OTHER artifacts the change
    // touches — not whether this one has a spec, so the intent still counts.
    assert.deepEqual(specIds(rule[0]), ["rule"]);
    assert.deepEqual(intentGaps(intent), [CALCULATOR]);
  });

  it("marks a traced artifact analyzable", () => {
    const intent = computeIntent(report({ nodes: [CALCULATOR] }), []);

    assert.deepEqual(
      intent.entries.map((entry) => entry.analyzable),
      [true],
    );
  });

  it("answers an empty graph with no entries and a zero-of-zero summary", () => {
    const intent = computeIntent(report(), []);

    assert.deepEqual(intent.entries, []);
    assert.deepEqual(intentGaps(intent), []);
    assert.equal(intent.incomplete, false);
    assert.match(messages(intent, "info").join("\n"), /^0 of 0 impacted/m);
  });

  it("orders entries by table, then sys_id", () => {
    // Handed over in none of the orders it may come back in: the output order
    // has to come from the sort. `name` is deliberately not part of it —
    // CALCULATOR and its twin share one, and identity is what orders a report.
    const intent = computeIntent(
      report({
        nodes: [CALCULATOR_TWIN, ALPHA_RULE, ZONE],
        unanalyzable: [untraced(HELPER)],
        // `nodes` is where CALCULATOR arrives last, on purpose.
        edges: [],
      }),
      [],
    );

    assert.deepEqual(
      intent.entries.map(
        (entry) => `${entry.artifact.table}/${entry.artifact.sysId}`,
      ),
      [
        `sys_script/${ALPHA_RULE.sysId}`,
        `sys_script_include/${ZONE.sysId}`,
        `sys_script_include/${CALCULATOR_TWIN.sysId}`,
        `sys_script_include/${HELPER.sysId}`,
      ],
    );
  });
});

describe("the spec join is declared, never inferred (QA-16)", () => {
  it("ignores a spec whose target has the right name but another sys_id", () => {
    // The whole reason the join is table + sys_id: two records can share one
    // display name, and matching on it would credit this change with a spec
    // aimed at a different row.
    const intent = computeIntent(report({ nodes: [CALCULATOR] }), [
      spec("twin", [CALCULATOR_TWIN]),
    ]);

    assert.deepEqual(specIds(intent.entries[0]), []);
    assert.deepEqual(intentGaps(intent), [CALCULATOR]);
  });

  it("ignores a spec whose target has the right sys_id under another table", () => {
    const elsewhere = { ...CALCULATOR, table: "sys_script" };
    const intent = computeIntent(report({ nodes: [CALCULATOR] }), [
      spec("elsewhere", [elsewhere]),
    ]);

    assert.deepEqual(specIds(intent.entries[0]), []);
  });

  it("matches on sys_id even when the spec's target carries another name", () => {
    // A rename between the run that generated the spec and this one. The
    // declaration still points at the same row, so the intent still counts —
    // which is exactly what joining on a path would have lost.
    const renamed = { ...CALCULATOR, name: "AmountCalculatorV2" };
    const intent = computeIntent(report({ nodes: [CALCULATOR] }), [
      spec("calc", [renamed]),
    ]);

    assert.deepEqual(specIds(intent.entries[0]), ["calc"]);
  });

  it("ignores the spec's path entirely", () => {
    // A path encodes at most one table and one name and breaks outright for a
    // multi-artifact spec — so a path that looks wrong changes nothing.
    const intent = computeIntent(report({ nodes: [ZONE] }), [
      spec("zone", [ZONE], { path: "tests/somewhere/else/Unrelated.unit.ts" }),
    ]);

    assert.deepEqual(specIds(intent.entries[0]), ["zone"]);
  });

  it("counts one spec for every artifact it targets", () => {
    const wide = spec("wide", [CALCULATOR, ZONE, ALPHA_RULE], { kind: "e2e" });
    const intent = computeIntent(
      report({ nodes: [CALCULATOR, ZONE, ALPHA_RULE] }),
      [wide],
    );

    assert.deepEqual(
      intent.entries.map((entry) => specIds(entry)),
      [["wide"], ["wide"], ["wide"]],
    );
    assert.deepEqual(intentGaps(intent), []);
  });

  it("de-duplicates by spec id and orders the refs by it", () => {
    const intent = computeIntent(report({ nodes: [CALCULATOR] }), [
      spec("zeta", [CALCULATOR]),
      // The same artifact named twice in one spec is one declaration.
      spec("alpha", [CALCULATOR, { ...CALCULATOR }]),
    ]);

    assert.deepEqual(specIds(intent.entries[0]), ["alpha", "zeta"]);
    assert.deepEqual(intent.entries[0].specs[0], {
      id: "alpha",
      path: "tests/alpha.unit.ts",
    });
  });

  it("treats an empty spec inventory as every artifact being a gap", () => {
    const intent = computeIntent(
      report({
        nodes: [CALCULATOR, ZONE],
        unanalyzable: [untraced(ALPHA_RULE)],
      }),
      [],
    );

    assert.equal(intent.entries.length, 3);
    assert.equal(intentGaps(intent).length, 3);
    assert.match(messages(intent, "info").at(-1), /^3 of 3 impacted/);
  });
});

describe("the notes", () => {
  it("carries the graph's own reasoning through, first and unchanged", () => {
    const graphNotes = [
      { level: "info", message: "scope `x_acme` is sys_scope/abc" },
      { level: "warning", message: "sys_script on source: refused (403)" },
    ];
    const intent = computeIntent(
      report({ nodes: [CALCULATOR], notes: graphNotes }),
      [],
    );

    assert.deepEqual(intent.notes.slice(0, 2), graphNotes);
    // Carried, not aliased: the caller's array must not grow a note it never
    // wrote when a second report is computed from the same graph.
    assert.notEqual(intent.notes, graphNotes);
    assert.equal(graphNotes.length, 2);
  });

  it("states the gap count as intent and denies the coverage reading", () => {
    const intent = computeIntent(report({ nodes: [CALCULATOR, ZONE] }), [
      spec("calc", [CALCULATOR]),
    ]);

    const summary = messages(intent, "info").at(-1);
    assert.match(summary, /1 of 2 impacted artifact\(s\) have no spec/);
    // QA-8 / DESIGN §4a: this figure must never be readable as coverage, so
    // the sentence says what it counted and rules the other reading out in
    // words rather than trusting the reader to remember the distinction.
    assert.match(summary, /INTENT/);
    assert.match(summary, /not a spec that passed/);
    assert.doesNotMatch(summary, /covered|coverage floor/);
  });

  it("warns about a declared target that is not in the impacted set", () => {
    // Not evidence about this change. Nothing is dropped — the spec still
    // counts for the target that IS impacted — but silence here would hide a
    // stale or misaimed spec indefinitely.
    const intent = computeIntent(report({ nodes: [CALCULATOR] }), [
      spec("wide", [CALCULATOR, ALPHA_RULE]),
      spec("stale", [ZONE]),
    ]);

    assert.deepEqual(specIds(intent.entries[0]), ["wide"]);
    const warnings = messages(intent, "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /2 declared spec target\(s\) are not in this/);
    // Both ends are named: which spec, and which of its targets missed.
    assert.match(
      warnings[0],
      new RegExp(`stale → sys_script_include/${ZONE.sysId}`),
    );
    assert.match(
      warnings[0],
      new RegExp(`wide → sys_script/${ALPHA_RULE.sysId}`),
    );
    // Sorted, so two runs over the same inputs diff clean.
    assert.ok(warnings[0].indexOf("stale →") < warnings[0].indexOf("wide →"));
    // A stray target says nothing about the gap set in either direction, so it
    // does not by itself make the report inconclusive.
    assert.equal(intent.incomplete, false);
  });

  it("says nothing about stray targets when there are none", () => {
    const intent = computeIntent(report({ nodes: [CALCULATOR] }), [
      spec("calc", [CALCULATOR]),
    ]);

    assert.deepEqual(messages(intent, "warning"), []);
    assert.equal(intent.notes.length, 1);
  });

  it("warns that an unread inventory may overstate the gap set", () => {
    const intent = computeIntent(report({ nodes: [CALCULATOR] }), [], {
      inventoryIncomplete: true,
    });

    const warnings = messages(intent, "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /spec inventory was not fully read/);
    assert.match(warnings[0], /overstate/);
  });

  it("orders and words its notes deterministically", () => {
    const inputs = () => [
      report({
        nodes: [CALCULATOR],
        notes: [{ level: "info", message: "scope `x_acme` is sys_scope/abc" }],
      }),
      [spec("calc", [CALCULATOR]), spec("stale", [ZONE])],
      { inventoryIncomplete: true },
    ];
    const [first, second] = [
      computeIntent(...inputs()),
      computeIntent(...inputs()),
    ];

    assert.deepEqual(first.notes, second.notes);
    assert.deepEqual(
      first.notes.map((note) => note.level),
      // Carried graph note, gap summary, stray targets, unread inventory.
      ["info", "info", "warning", "warning"],
    );
  });
});

describe("incomplete", () => {
  it("is true when the graph could not be traced", () => {
    const input = report({
      nodes: [CALCULATOR],
      unanalyzable: [untraced(CALCULATOR)],
    });
    assert.equal(isIncomplete(input), true);

    assert.equal(computeIntent(input, []).incomplete, true);
  });

  it("is true when the graph carries a warning note", () => {
    // `isIncomplete`'s other half: a warning means the graph is not a clean
    // answer even with nothing in `unanalyzable` — two Script Includes sharing
    // a name leave edges WRONG rather than missing.
    const input = report({
      nodes: [CALCULATOR],
      notes: [{ level: "warning", message: "2 rows are named `X`" }],
    });

    assert.equal(computeIntent(input, []).incomplete, true);
  });

  it("is true when only the spec inventory was incomplete", () => {
    const input = report({ nodes: [CALCULATOR] });
    assert.equal(isIncomplete(input), false);

    assert.equal(
      computeIntent(input, [spec("calc", [CALCULATOR])], {
        inventoryIncomplete: true,
      }).incomplete,
      true,
    );
  });

  it("is false when neither side is, including with the option off", () => {
    const input = report({ nodes: [CALCULATOR] });

    assert.equal(computeIntent(input, []).incomplete, false);
    assert.equal(computeIntent(input, [], {}).incomplete, false);
    assert.equal(
      computeIntent(input, [], { inventoryIncomplete: false }).incomplete,
      false,
    );
  });
});
