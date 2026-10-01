// The ImpactAnalyzer's graph — PLAN Phase 3, DESIGN §12.3 row 3.
//
// Every test here runs against the two injected seams: a `RecordReader` that
// answers the one `sys_scope` identity lookup, and a `WhereUsedSearch` stub
// that returns a canned `WhereUsedResult` and records the `WhereUsedRequest` it
// was handed. Nothing in this file reaches an instance, and that is the point.
// What is under test is a decision table — which input becomes a subject, which
// becomes an `UnanalyzableArtifact`, which reference becomes an edge and at
// what confidence — plus two orderings the rest of the pipeline relies on. A
// live search in the picture would add several ways for those assertions to
// pass for the wrong reason, and the search's own reads are covered where they
// belong, in `whereUsed.test.js`.
//
// Half of the assertions below are about what the analyzer must NOT do: not
// read a consumer table itself, not run a search it has nothing to search for,
// not draw a self-edge, and above all not drop an artifact it could not trace.
// That last one is QA-15 arithmetic rather than tidiness — the coverage floor
// divides by ALL impacted artifacts including the unanalyzable ones, so a node
// list that quietly lost them would inflate the figure by exactly the artifacts
// the floor exists to catch.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CONFIDENCE_BY_MATCH_KIND,
  createImpactAnalyzer,
  isIncomplete,
} from "../build/index.js";

/** A 32-hex sys_id from a short prefix — the fixtures read by name, not by id. */
function sysId(prefix) {
  return prefix.padEnd(32, "0");
}

const SCOPE_SYS_ID = sysId("5c0be");
const SCOPE_NAME = "x_acme_inventory";
const SCOPE_ROW = {
  sys_id: SCOPE_SYS_ID,
  scope: SCOPE_NAME,
  name: "Acme Inventory",
};

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
const BETA_RULE = {
  table: "sys_script",
  sysId: sysId("beba"),
  name: "Beta rule",
};

/**
 * The label `@tessera/resolvers` substitutes when a row's `name` column could
 * not be read. It is addressable and it is useless as a search term, which is
 * the whole reason the analyzer has to recognise it.
 */
const NAMELESS = {
  table: "sys_script_include",
  sysId: sysId("d0d0"),
  name: `sys_script_include/${sysId("d0d0")}`,
};

function ctx() {
  return {
    runId: "run-impact",
    lifecycle: "ephemeral",
    coverageSource: "atf",
    topology: { source: "dev", runner: "test", target: "test" },
    signal: new AbortController().signal,
  };
}

function answered(records) {
  return {
    outcome: "answered",
    records,
    truncated: false,
    detail: `${records.length} row(s)`,
  };
}

function undecidable(detail) {
  return { outcome: "undecidable", records: [], truncated: false, detail };
}

/**
 * A reader that answers exactly one question. Any other table is a defect —
 * the search owns every read that is not the scope identity — so the stub
 * refuses instead of answering, which is the only way a test can state "this
 * read must never happen" as an assertion rather than as a comment.
 */
function readerFor(read = answered([SCOPE_ROW])) {
  const requests = [];
  return {
    profile: "source",
    requests,
    queryRecords(request) {
      requests.push({ table: request.table, query: request.query });
      if (request.table !== "sys_scope") {
        return Promise.reject(
          new Error(`the analyzer read ${request.table} itself`),
        );
      }
      return Promise.resolve(read);
    },
  };
}

/** A `WhereUsedSearch` over a canned result that remembers what it was asked. */
function searchStub(result = {}) {
  const calls = [];
  const search = (request) => {
    calls.push(request);
    return Promise.resolve({
      references: [],
      unanalyzable: [],
      notes: [],
      incomplete: false,
      ...result,
    });
  };
  search.calls = calls;
  return search;
}

function harness({ result, read, scope = SCOPE_NAME } = {}) {
  const reader = readerFor(read);
  const search = searchStub(result);
  const analyzer = createImpactAnalyzer(reader, { scope, search });
  return {
    reader,
    search,
    analyzer,
    /** The resolver hands the analyzer `AffectedArtifact`s, not bare refs. */
    analyze(refs) {
      return analyzer.analyzeWithReport(
        ctx(),
        refs.map((ref) => ({ ref, resolvedBy: "scope" })),
      );
    },
  };
}

function reference(consumer, name, kind, { field = "script", line = 1 } = {}) {
  return { consumer, field, match: { name, kind, line } };
}

function messages(report, level) {
  return report.notes
    .filter((note) => level === undefined || note.level === level)
    .map((note) => note.message);
}

describe("what the search is asked to look for", () => {
  it("hands over the named Script Includes, inside the resolved scope", async () => {
    const h = harness();
    await h.analyze([CALCULATOR, BETA_RULE, NAMELESS, ZONE]);

    assert.equal(h.search.calls.length, 1);
    const request = h.search.calls[0];
    // The scope identity comes from the shared `findScopeIdentity` lookup, so
    // `--scope` means the same row here as it does to the ScopeResolver.
    assert.equal(request.scopeSysId, SCOPE_SYS_ID);
    assert.equal(request.scopeLabel, SCOPE_NAME);
    assert.equal(request.ctx.runId, "run-impact");
    // Only the Script Includes with a usable name: a Business Rule is not a
    // subject this MVP can trace, and a row whose name is the `table/sys_id`
    // placeholder cannot be searched for at all.
    assert.deepEqual([...request.subjects], [CALCULATOR, ZONE]);
    // One read, and it is the scope lookup — consumer tables are the search's
    // business, not the analyzer's.
    assert.deepEqual(
      h.reader.requests.map((r) => r.table),
      ["sys_scope"],
    );
  });

  it("runs no search when there is nothing traceable to search for", async () => {
    const h = harness();
    const report = await h.analyze([BETA_RULE, NAMELESS]);

    assert.equal(h.search.calls.length, 0);
    assert.match(
      messages(report, "info").join("\n"),
      /no where-used search was run/,
    );
  });

  it("answers an empty artifact list with an empty graph", async () => {
    const h = harness();
    const report = await h.analyze([]);

    assert.deepEqual(report.graph, {
      nodes: [],
      edges: [],
      unanalyzable: [],
      demanded: [],
    });
    assert.equal(h.search.calls.length, 0);
    // Nothing was asked about, so nothing is missing — an empty graph over an
    // empty input is complete, and saying otherwise would teach the reader to
    // skim the warnings that matter.
    assert.equal(isIncomplete(report), false);
    // The scope was still resolved: a bad `--scope` must fail even on an empty
    // artifact list, rather than being validated only when it is convenient.
    assert.equal(h.reader.requests.length, 1);
  });
});

describe("what the MVP cannot trace, it says out loud", () => {
  it("keeps a non-Script-Include input as a node and marks it unanalyzable", async () => {
    const h = harness();
    const report = await h.analyze([BETA_RULE]);

    assert.equal(report.graph.unanalyzable.length, 1);
    const entry = report.graph.unanalyzable[0];
    assert.deepEqual(entry.artifact, BETA_RULE);
    assert.match(entry.reason, /sys_script_include usage only/);
    assert.match(entry.reason, /§12\.3 row 3/);
    // It names the table that was skipped, so the reader knows what was left
    // untraced rather than merely that something was.
    assert.match(entry.reason, /this sys_script row/);
    // QA-15: the artifact stays in the graph. Dropping it would shrink the
    // coverage denominator by exactly the artifact the floor exists for.
    assert.deepEqual([...report.graph.nodes], [BETA_RULE]);
    assert.deepEqual([...report.graph.demanded], []);
    assert.equal(isIncomplete(report), true);
  });

  it("cannot search for a Script Include whose name was unreadable", async () => {
    const h = harness();
    const report = await h.analyze([NAMELESS]);

    assert.equal(report.graph.unanalyzable.length, 1);
    assert.deepEqual(report.graph.unanalyzable[0].artifact, NAMELESS);
    assert.match(report.graph.unanalyzable[0].reason, /no readable name/);
    assert.deepEqual([...report.graph.nodes], [NAMELESS]);
    // No name, no path under DESIGN §4's layout — so no spec is demanded, and
    // the gap is stated rather than left to be noticed.
    assert.deepEqual([...report.graph.demanded], []);
    assert.match(
      messages(report, "warning").join("\n"),
      /no unit spec is demanded/,
    );
  });

  it("turns an incomplete search into one entry per subject", async () => {
    const h = harness({
      result: {
        incomplete: true,
        notes: [
          { level: "warning", message: "sys_script on source: refused (403)" },
        ],
      },
    });
    const report = await h.analyze([CALCULATOR, ZONE]);

    // "I looked and could not see all of it" is a different claim from
    // "nothing uses this", and only the analyzer knows which artifacts the
    // hole applies to — so the search's single boolean becomes one honest
    // entry per subject.
    assert.equal(report.graph.unanalyzable.length, 2);
    assert.deepEqual(
      report.graph.unanalyzable.map((entry) => entry.artifact.name),
      ["AmountCalculator", "ZoneLookup"],
    );
    for (const entry of report.graph.unanalyzable) {
      assert.match(entry.reason, /could not be fully traced/);
      // The evidence travels with the claim; "could not be traced" with no
      // cause is indistinguishable from a shrug.
      assert.match(entry.reason, /refused \(403\)/);
    }
    // The search's own note survives, and the analyzer adds the summary.
    const warnings = messages(report, "warning");
    assert.ok(warnings.includes("sys_script on source: refused (403)"));
    assert.match(warnings.at(-1), /impact graph is incomplete/);
    assert.equal(isIncomplete(report), true);
    // Specs are still demanded for both: an untraceable artifact is exactly
    // the one somebody should be made to test.
    assert.equal(report.graph.demanded.length, 2);
  });

  it("names no cause for an incomplete search that named none itself", async () => {
    // `WhereUsedSearch` is an injected port, so `incomplete: true` can arrive
    // with no warning beside it. The property under test is that the analyzer
    // then reports the SHAPE of what it was told — a hole with no stated
    // location — instead of filling the gap with the causes the bundled search
    // happens to produce. A named cause here would be a diagnosis nothing in
    // the run observed (DEV-1), and it is unfalsifiable from the report: the
    // reader cannot tell an inferred cause from a measured one.
    const h = harness({ result: { incomplete: true, notes: [] } });
    const report = await h.analyze([CALCULATOR]);

    assert.equal(report.graph.unanalyzable.length, 1);
    const reason = report.graph.unanalyzable[0].reason;
    // Still says the trace is short, and still says an absent edge proves
    // nothing — striking a cause must not strike the claim.
    assert.match(reason, /could not be fully traced/);
    assert.equal(isIncomplete(report), true);
    // But nothing that would pass for an observation.
    assert.doesNotMatch(reason, /table|truncated|cap|403|refused/i);
    assert.match(reason, /without saying which part/);
  });

  it("carries the search's own unanalyzable consumers, de-duplicated", async () => {
    const dynamic = {
      artifact: ALPHA_RULE,
      reason: "builds its call target at runtime (GlideEvaluator, line 12)",
    };
    const h = harness({
      // The same conclusion reached twice — once per searched name — is one
      // line in the report, not two.
      result: { unanalyzable: [dynamic, { ...dynamic }] },
    });
    const report = await h.analyze([CALCULATOR, BETA_RULE]);

    assert.deepEqual(
      report.graph.unanalyzable.map((entry) => entry.artifact.name),
      // Sorted by (table, name, sys_id, reason): both are `sys_script`.
      ["Alpha rule", "Beta rule"],
    );
    assert.match(report.graph.unanalyzable[0].reason, /GlideEvaluator/);
  });
});

describe("edges", () => {
  it("collapses two references to one consumer into the strongest edge", async () => {
    // One consumer that both calls `AmountCalculator(` and names it in a
    // comment is one relationship, and it is a high-confidence one.
    const weakFirst = harness({
      result: {
        references: [
          reference(ALPHA_RULE, "AmountCalculator", "text", { line: 3 }),
          reference(ALPHA_RULE, "AmountCalculator", "call", { line: 9 }),
        ],
      },
    });
    const report = await weakFirst.analyze([CALCULATOR]);

    assert.equal(report.graph.edges.length, 1);
    assert.deepEqual(report.graph.edges[0], {
      from: CALCULATOR,
      to: ALPHA_RULE,
      via: "where_used",
      confidence: "high",
    });

    // Order of arrival must not decide it: a trailing comment cannot demote a
    // proven call.
    const strongFirst = harness({
      result: {
        references: [
          reference(ALPHA_RULE, "AmountCalculator", "call", { line: 9 }),
          reference(ALPHA_RULE, "AmountCalculator", "text", { line: 3 }),
        ],
      },
    });
    const second = await strongFirst.analyze([CALCULATOR]);
    assert.equal(second.graph.edges.length, 1);
    assert.equal(second.graph.edges[0].confidence, "high");
  });

  it("takes confidence from the evidence class, never from anywhere else", async () => {
    for (const kind of ["call", "identifier", "text"]) {
      const h = harness({
        result: {
          references: [reference(ALPHA_RULE, "AmountCalculator", kind)],
        },
      });
      const report = await h.analyze([CALCULATOR]);

      assert.equal(
        report.graph.edges[0].confidence,
        CONFIDENCE_BY_MATCH_KIND[kind],
      );
      assert.equal(report.graph.edges[0].via, "where_used");
    }
  });

  it("never draws a self-edge", async () => {
    // The search already excludes a subject's own row — every `Foo` Script
    // Include contains the word `Foo` — but a self-loop reaching a report
    // would read as "this artifact uses itself", so the guard is duplicated.
    const h = harness({
      result: {
        references: [reference(CALCULATOR, "AmountCalculator", "call")],
      },
    });
    const report = await h.analyze([CALCULATOR]);

    assert.deepEqual([...report.graph.edges], []);
    assert.deepEqual([...report.graph.nodes], [CALCULATOR]);
  });

  it("attributes a shared name to every subject that carries it, and warns", async () => {
    const twin = { ...CALCULATOR, sysId: sysId("7w1n") };
    const h = harness({
      result: {
        references: [reference(ALPHA_RULE, "AmountCalculator", "call")],
      },
    });
    const report = await h.analyze([CALCULATOR, twin]);

    // Two rows with one name cannot coexist in a scope, so the note is the
    // interesting part — but picking one of them would drop an edge silently,
    // which is the one outcome that cannot be recovered from the report.
    assert.equal(report.graph.edges.length, 2);
    // Handed over as [CALCULATOR, twin] and returned the other way round: the
    // only thing separating these two edges is `from.sysId`, so this is the
    // one case that proves the edge order comes from the comparator rather
    // than from the order the artifacts happened to arrive in.
    assert.deepEqual(
      report.graph.edges.map((edge) => edge.from.sysId),
      [twin.sysId, CALCULATOR.sysId],
    );
    assert.match(messages(report, "warning").join("\n"), /are named/);
  });

  it("reports a reference to a name nobody searched for instead of dropping it", async () => {
    const h = harness({
      result: { references: [reference(ALPHA_RULE, "SomethingElse", "call")] },
    });
    const report = await h.analyze([CALCULATOR]);

    assert.deepEqual([...report.graph.edges], []);
    assert.match(
      messages(report, "warning").join("\n"),
      /never searched for.*SomethingElse/s,
    );
  });
});

describe("a graph two runs can be diffed against each other", () => {
  const REFERENCES = [
    reference(BETA_RULE, "ZoneLookup", "call"),
    reference(ALPHA_RULE, "AmountCalculator", "identifier"),
    reference(HELPER, "AmountCalculator", "call"),
    reference(ALPHA_RULE, "ZoneLookup", "text"),
  ];

  it("orders edges, nodes and demanded specs deterministically", async () => {
    // Subjects handed over in reverse order, references in none at all: the
    // output order has to come from the sort, not from the input.
    const h = harness({ result: { references: REFERENCES } });
    const report = await h.analyze([ZONE, CALCULATOR]);

    // Edges: (from.name, to.table, to.name, to.sysId).
    assert.deepEqual(
      report.graph.edges.map((edge) => [
        edge.from.name,
        edge.to.name,
        edge.confidence,
      ]),
      [
        ["AmountCalculator", "Alpha rule", "medium"],
        ["AmountCalculator", "HelperInclude", "high"],
        ["ZoneLookup", "Alpha rule", "low"],
        ["ZoneLookup", "Beta rule", "high"],
      ],
    );

    // Nodes: every input plus every consumer that earned an edge, by
    // (table, name, sys_id).
    assert.deepEqual(
      report.graph.nodes.map((ref) => `${ref.table}/${ref.name}`),
      [
        "sys_script/Alpha rule",
        "sys_script/Beta rule",
        "sys_script_include/AmountCalculator",
        "sys_script_include/HelperInclude",
        "sys_script_include/ZoneLookup",
      ],
    );

    // Demanded: every Script Include node, by path. `HelperInclude` only ever
    // appeared as a CONSUMER, and it is demanded all the same — a change to
    // the thing it calls is a reason to test it.
    assert.deepEqual(
      report.graph.demanded.map((entry) => entry.spec.path),
      [
        "tests/x_acme_inventory/sys_script_include/AmountCalculator/AmountCalculator.unit.ts",
        "tests/x_acme_inventory/sys_script_include/HelperInclude/HelperInclude.unit.ts",
        "tests/x_acme_inventory/sys_script_include/ZoneLookup/ZoneLookup.unit.ts",
      ],
    );
    assert.ok(report.graph.demanded.every((entry) => entry.kind === "unit"));
    assert.deepEqual(report.graph.demanded[1].target, HELPER);
    // Nothing went untraced, so nothing is warned about.
    assert.deepEqual([...report.graph.unanalyzable], []);
    assert.equal(isIncomplete(report), false);
  });

  it("orders unanalyzable entries by artifact, then by reason", async () => {
    const h = harness({
      result: {
        unanalyzable: [
          { artifact: HELPER, reason: "dynamic dispatch: eval, line 4" },
          {
            artifact: ALPHA_RULE,
            reason: "dynamic dispatch: gs.include, line 2",
          },
        ],
      },
    });
    const report = await h.analyze([BETA_RULE, CALCULATOR]);

    assert.deepEqual(
      report.graph.unanalyzable.map((entry) => entry.artifact.name),
      ["Alpha rule", "Beta rule", "HelperInclude"],
    );
  });
});

describe("the demanded checklist", () => {
  it("builds DESIGN §4's path from sanitised segments and a sys_id identity", async () => {
    const awkward = {
      table: "sys_script_include",
      sysId: sysId("aw"),
      name: "Amount/Calculator Pro",
    };
    // A scope row with no `scope` column falls back to its display name, which
    // is where the space in the path segment comes from. The scope is named by
    // that display name: the resolver only accepts a row that IS the scope it
    // was asked for (scope or name column equal to the argument).
    const h = harness({
      scope: "Acme Inventory",
      read: answered([{ sys_id: SCOPE_SYS_ID, name: "Acme Inventory" }]),
    });
    const report = await h.analyze([awkward]);

    assert.deepEqual(
      [...report.graph.demanded],
      [
        {
          spec: {
            // Never the name: a rename would orphan the spec from the artifact
            // it tests, and every join downstream is on this string.
            id: `sys_script_include/${sysId("aw")}`,
            path: "tests/Acme_Inventory/sys_script_include/Amount_Calculator_Pro/Amount_Calculator_Pro.unit.ts",
          },
          kind: "unit",
          target: awkward,
        },
      ],
    );
    // The sanitisation is for the path only — the search still looks for the
    // name the instance actually holds.
    assert.deepEqual([...h.search.calls[0].subjects], [awkward]);
  });
});

describe("the port and the report agree", () => {
  it("analyze() is analyzeWithReport() with the notes dropped", async () => {
    const reader = readerFor();
    const search = searchStub({
      references: [reference(ALPHA_RULE, "AmountCalculator", "call")],
    });
    const analyzer = createImpactAnalyzer(reader, {
      scope: SCOPE_NAME,
      search,
    });
    const artifacts = [{ ref: CALCULATOR, resolvedBy: "scope" }];

    const graph = await analyzer.analyze(ctx(), artifacts);
    const report = await analyzer.analyzeWithReport(ctx(), artifacts);

    assert.deepEqual(graph, report.graph);
    assert.ok(report.notes.length > 0);
    // A copy: a caller pushing onto the graph it received cannot reach into
    // the report the CLI is about to print.
    graph.edges.push("not an edge");
    graph.nodes.push("not a node");
    assert.equal(report.graph.edges.length, 1);
    assert.equal(report.graph.nodes.length, 2);
  });

  it("names the scope it resolved, so the graph can be read against a run", async () => {
    const h = harness();
    const report = await h.analyze([CALCULATOR]);

    assert.match(
      messages(report, "info")[0],
      new RegExp(`sys_scope/${SCOPE_SYS_ID}`),
    );
  });
});

describe("a scope that cannot be turned into one identity", () => {
  it("propagates a wrong argument as ResolutionInputError", async () => {
    // DEV-1: the instance answered and named nothing, so the fix is a
    // different argument. Re-wrapping it here would cost the CLI its exit-2
    // path, and nothing this stage knows would be added by doing so.
    const h = harness({ read: answered([]) });

    await assert.rejects(() => h.analyze([CALCULATOR]), {
      name: "ResolutionInputError",
      message: /x_acme_inventory/,
    });
    assert.equal(h.search.calls.length, 0);
  });

  it("carries a hole the search found onto the graph, which has no notes", async () => {
    // The one test in this file that does NOT stub the search, and it is here
    // rather than in `whereUsed.test.js` because what it asserts is a property
    // of the JOIN between them: `ImpactAnalyzer.analyze` (the port the pipeline
    // calls) returns a bare `ImpactGraph`, so every note either turns into
    // something on the graph or is gone. A row the search had to drop is a
    // missing edge; on the graph, `unanalyzable` is the only place that can
    // say so, and reaching it depends on the search raising `incomplete`.
    // Asserted through `analyze`, not `analyzeWithReport`, for exactly that
    // reason — the report channel would hide the regression.
    const reader = {
      profile: "source",
      queryRecords(request) {
        if (request.table === "sys_scope") {
          return Promise.resolve(answered([SCOPE_ROW]));
        }
        if (request.table === "sys_script") {
          // Field-level ACL trimming: a row nothing can address.
          return Promise.resolve(
            answered([{ sys_name: "trimmed", script: "new Foo();" }]),
          );
        }
        return Promise.resolve(answered([]));
      },
    };
    const analyzer = createImpactAnalyzer(reader, { scope: SCOPE_NAME });
    const graph = await analyzer.analyze(ctx(), [
      { ref: CALCULATOR, resolvedBy: "scope" },
    ]);

    assert.equal(graph.edges.length, 0);
    // Not an empty `unanalyzable`: an edge list shortened by a row nobody could
    // read is not a trace that found nothing (QA-9, DEV-1).
    assert.equal(graph.unanalyzable.length, 1);
    assert.equal(graph.unanalyzable[0].artifact.sysId, CALCULATOR.sysId);
    assert.match(graph.unanalyzable[0].reason, /could not be fully traced/);
    assert.match(graph.unanalyzable[0].reason, /no readable sys_id/);
  });

  it("propagates an unread scope as ResolutionFaultError", async () => {
    // The opposite half of DEV-1: nothing was learned, so this is an absence
    // of evidence (exit 3) and never an empty graph.
    const h = harness({
      read: undecidable("sys_scope on source: read refused (403)"),
    });

    await assert.rejects(() => h.analyze([CALCULATOR]), {
      name: "ResolutionFaultError",
      message: /refused \(403\)/,
    });
    assert.equal(h.search.calls.length, 0);
  });
});
