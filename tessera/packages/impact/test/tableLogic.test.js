// Business Rule (`sys_script`) tracing — the `table_logic` producer.
//
// Three layers, each against its own seam:
//
//   * `createBusinessRuleLookup` against a canned `RecordReader` — which rows
//     become rules, which become siblings, and every way the lookup refuses
//     (fail closed: unanalyzable, never a rule with fewer edges);
//   * `createImpactAnalyzer` with `subjectTables` against an injected lookup
//     and search — the opt-in default, edge attribution, demanded specs and
//     the fail-closed paths of the graph builder;
//   * one end-to-end run over a canned reader through the LIVE lookup and the
//     LIVE where-used search, showing a Business Rule reaching a clean graph
//     (no unanalyzable entry, no warning note) with a demanded spec — the
//     precondition for a GO verdict.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ResolutionInputError } from "@tessera/resolvers";
import { tableApi } from "@tessera/sn-client";

import {
  BUSINESS_RULE_TABLE,
  SUBJECT_TABLES,
  createBusinessRuleLookup,
  createImpactAnalyzer,
  isIncomplete,
} from "../build/index.js";

const SCOPE_SYS_ID = "5c0be000000000000000000000000000";
const SCOPE_NAME = "x_acme_inventory";
const SCOPE_ROW = { sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME, name: "Acme" };

function sysId(prefix) {
  return prefix.padEnd(32, "0");
}

const RULE_A = {
  table: "sys_script",
  sysId: sysId("a1fa"),
  name: "Alpha rule",
};
const RULE_B = { table: "sys_script", sysId: sysId("beba"), name: "Beta rule" };
const INCLUDE = {
  table: "sys_script_include",
  sysId: sysId("ca1c"),
  name: "AmountCalculator",
};
const POLICY = {
  table: "sys_ui_policy",
  sysId: sysId("d01c"),
  name: "Some policy",
};

function ctx() {
  return {
    runId: "run-table-logic",
    lifecycle: "ephemeral",
    coverageSource: "atf",
    topology: { source: "dev", runner: "test", target: "test" },
    signal: new AbortController().signal,
  };
}

function answered(records, extra = {}) {
  return {
    outcome: "answered",
    records,
    truncated: false,
    detail: `${records.length} row(s)`,
    ...extra,
  };
}

function undecidable(detail) {
  return { outcome: "undecidable", records: [], truncated: false, detail };
}

/** Canned reads by table; an unlisted table answers with zero rows. */
function readerFrom(canned) {
  const requests = [];
  return {
    profile: "source",
    requests,
    queryRecords(request) {
      requests.push({
        table: request.table,
        query: request.query,
        fields: [...request.fields],
        fetchAll: request.fetchAll,
        crossCheckCount: request.crossCheckCount,
      });
      return Promise.resolve(canned[request.table] ?? answered([]));
    },
  };
}

function row(ref, collection, extra = {}) {
  return { sys_id: ref.sysId, sys_name: ref.name, collection, ...extra };
}

function lookup(read, subjects = [RULE_A]) {
  const reader = readerFrom({ sys_script: read });
  return {
    reader,
    result: createBusinessRuleLookup(reader)({
      ctx: ctx(),
      scopeSysId: SCOPE_SYS_ID,
      scopeLabel: SCOPE_NAME,
      subjects,
    }),
  };
}

function levels(notes, level) {
  return notes.filter((n) => n.level === level).map((n) => n.message);
}

describe("createBusinessRuleLookup", () => {
  it("reads sys_script once, in scope, for identity and trigger table only", async () => {
    const { reader, result } = lookup(answered([row(RULE_A, "incident")]));
    await result;
    assert.deepEqual(reader.requests, [
      {
        table: "sys_script",
        query: `sys_scope=${SCOPE_SYS_ID}`,
        fields: ["sys_id", "sys_name", "collection"],
        fetchAll: true,
        crossCheckCount: true,
      },
    ]);
  });

  it("binds a subject to its collection and finds sibling rules on the same table", async () => {
    const SIBLING = { table: "sys_script", sysId: sysId("5ib"), name: "Sib" };
    const ELSEWHERE = { table: "sys_script", sysId: sysId("e15e"), name: "X" };
    const { result } = lookup(
      answered([
        row(RULE_A, "incident"),
        row(SIBLING, "incident"),
        row(ELSEWHERE, "problem"),
      ]),
    );
    const out = await result;
    assert.deepEqual(out.rules, [{ rule: RULE_A, collection: "incident" }]);
    assert.deepEqual(out.siblings, [{ rule: SIBLING, collection: "incident" }]);
    assert.deepEqual(out.unanalyzable, []);
    assert.deepEqual(levels(out.notes, "warning"), []);
  });

  it("keeps the subject's own ref (label) rather than the row's", async () => {
    const { result } = lookup(
      answered([
        { sys_id: RULE_A.sysId, sys_name: "Renamed", collection: "incident" },
      ]),
    );
    const out = await result;
    assert.equal(out.rules[0].rule, RULE_A);
  });

  it("a global rule in scope is a sibling of every subject's table", async () => {
    const GLOBAL = { table: "sys_script", sysId: sysId("610b"), name: "G" };
    const { result } = lookup(
      answered([
        row(RULE_A, "incident"),
        row(RULE_B, "problem"),
        row(GLOBAL, "global"),
      ]),
      [RULE_A, RULE_B],
    );
    const out = await result;
    assert.deepEqual(
      out.siblings.map((s) => [s.rule.sysId, s.collection]),
      [
        [GLOBAL.sysId, "incident"],
        [GLOBAL.sysId, "problem"],
      ],
    );
  });

  for (const [label, collection, pattern] of [
    ["blank", "  ", /could not be read/],
    ["missing", undefined, /could not be read/],
    ["not a table name", "Incident; DROP", /not a table name/],
    ["global", "global", /every table/],
  ]) {
    it(`a subject whose collection is ${label} is unanalyzable, never bound`, async () => {
      const record = { sys_id: RULE_A.sysId, sys_name: RULE_A.name };
      if (collection !== undefined) record.collection = collection;
      const { result } = lookup(answered([record]));
      const out = await result;
      assert.deepEqual(out.rules, []);
      assert.equal(out.unanalyzable.length, 1);
      assert.equal(out.unanalyzable[0].artifact, RULE_A);
      assert.match(out.unanalyzable[0].reason, pattern);
    });
  }

  it("a subject missing from the scope read is unanalyzable (out of scope)", async () => {
    const { result } = lookup(answered([row(RULE_B, "incident")]));
    const out = await result;
    assert.deepEqual(out.rules, []);
    assert.equal(out.unanalyzable.length, 1);
    assert.match(
      out.unanalyzable[0].reason,
      /was not among the sys_script rows/,
    );
  });

  it("an undecidable read refuses every subject, with a warning", async () => {
    const { result } = lookup(undecidable("HTTP 403"), [RULE_A, RULE_B]);
    const out = await result;
    assert.deepEqual(out.rules, []);
    assert.deepEqual(
      out.unanalyzable.map((u) => u.artifact.sysId),
      [RULE_A.sysId, RULE_B.sysId],
    );
    assert.match(out.unanalyzable[0].reason, /HTTP 403/);
    assert.equal(levels(out.notes, "warning").length, 1);
  });

  it("a truncated read refuses every subject, worded by describeReadTruncation", async () => {
    const read = answered([row(RULE_A, "incident")], {
      truncated: true,
      total: 40,
      truncationReason: "cap",
    });
    const { result } = lookup(read);
    const out = await result;
    assert.deepEqual(out.rules, []);
    assert.equal(out.unanalyzable.length, 1);
    const clause = tableApi.describeTruncation({
      records: [...read.records],
      total: 40,
      truncationReason: "cap",
    });
    assert.ok(out.unanalyzable[0].reason.includes(clause));
    assert.ok(levels(out.notes, "warning")[0].includes(clause));
  });

  it("a row with no sys_id refuses every subject (it may be a sibling)", async () => {
    const { result } = lookup(
      answered([row(RULE_A, "incident"), { collection: "incident" }]),
    );
    const out = await result;
    assert.deepEqual(out.rules, []);
    assert.equal(out.unanalyzable.length, 1);
    assert.match(out.unanalyzable[0].reason, /may be a sibling rule/);
  });

  it("a non-subject row with an unreadable collection refuses every subject", async () => {
    const OTHER = { table: "sys_script", sysId: sysId("0the"), name: "O" };
    const { result } = lookup(
      answered([row(RULE_A, "incident"), { sys_id: OTHER.sysId }]),
    );
    const out = await result;
    assert.deepEqual(out.rules, []);
    assert.equal(out.unanalyzable.length, 1);
    assert.equal(levels(out.notes, "warning").length, 1);
  });

  it("reads nothing when handed no subject", async () => {
    const { reader, result } = lookup(answered([]), []);
    const out = await result;
    assert.deepEqual(reader.requests, []);
    assert.deepEqual(out, {
      rules: [],
      siblings: [],
      unanalyzable: [],
      notes: [],
    });
  });
});

// ── the analyzer ──────────────────────────────────────────────────────────

function scopeReader() {
  const requests = [];
  return {
    profile: "source",
    requests,
    queryRecords(request) {
      requests.push(request.table);
      if (request.table !== "sys_scope") {
        return Promise.reject(new Error(`unexpected read of ${request.table}`));
      }
      return Promise.resolve(answered([SCOPE_ROW]));
    },
  };
}

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

function lookupStub(result = {}) {
  const calls = [];
  const fn = (request) => {
    calls.push(request);
    return Promise.resolve({
      rules: [],
      siblings: [],
      unanalyzable: [],
      notes: [],
      ...result,
    });
  };
  fn.calls = calls;
  return fn;
}

function analyzerWith({ subjectTables, search, businessRules } = {}) {
  const reader = scopeReader();
  const analyzer = createImpactAnalyzer(reader, {
    scope: SCOPE_NAME,
    search: search ?? searchStub(),
    ...(businessRules === undefined ? {} : { businessRules }),
    ...(subjectTables === undefined ? {} : { subjectTables }),
  });
  return {
    reader,
    analyze(refs) {
      return analyzer.analyzeWithReport(
        ctx(),
        refs.map((ref) => ({ ref, resolvedBy: "scope" })),
      );
    },
  };
}

function reference(consumer, name, kind) {
  return { consumer, field: "script", match: { name, kind, line: 1 } };
}

const BOTH = ["sys_script_include", "sys_script"];

describe("subjectTables — what the analyzer accepts", () => {
  it("exports the supported subject tables", () => {
    assert.deepEqual(
      [...SUBJECT_TABLES],
      [
        "sys_script_include",
        "sys_script",
        "sys_ui_action",
        "sysauto_script",
        "sys_ws_operation",
        "sys_transform_script",
      ],
    );
    assert.equal(BUSINESS_RULE_TABLE, "sys_script");
    assert.ok(Object.isFrozen(SUBJECT_TABLES));
  });

  it("refuses an unsupported table at construction", () => {
    assert.throws(
      () => analyzerWith({ subjectTables: ["sys_ui_policy"] }),
      (error) =>
        error instanceof ResolutionInputError &&
        /cannot trace `sys_ui_policy`/.test(error.message),
    );
    assert.throws(
      () => analyzerWith({ subjectTables: [42] }),
      ResolutionInputError,
    );
    assert.throws(
      () => analyzerWith({ subjectTables: "sys_script" }),
      ResolutionInputError,
    );
  });

  it("by default a Business Rule stays unanalyzable and no lookup runs (opt-in)", async () => {
    const businessRules = lookupStub();
    const h = analyzerWith({ businessRules });
    const report = await h.analyze([RULE_A]);
    assert.equal(businessRules.calls.length, 0);
    assert.equal(report.graph.unanalyzable.length, 1);
    assert.match(
      report.graph.unanalyzable[0].reason,
      /MVP impact analysis traces sys_script_include usage only/,
    );
    assert.deepEqual(report.graph.demanded, []);
    assert.ok(isIncomplete(report));
  });

  it("an empty list traces nothing: every input is unanalyzable", async () => {
    const search = searchStub();
    const h = analyzerWith({ subjectTables: [], search });
    const report = await h.analyze([INCLUDE, RULE_A]);
    assert.equal(search.calls.length, 0);
    assert.equal(report.graph.unanalyzable.length, 2);
    assert.match(report.graph.unanalyzable[0].reason, /traces no table only/);
    assert.ok(isIncomplete(report));
  });

  it("a table still unsupported stays unanalyzable when Business Rules are on", async () => {
    const businessRules = lookupStub({
      rules: [{ rule: RULE_A, collection: "incident" }],
    });
    const h = analyzerWith({ subjectTables: BOTH, businessRules });
    const report = await h.analyze([RULE_A, POLICY]);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [POLICY.sysId],
    );
    assert.match(
      report.graph.unanalyzable[0].reason,
      /traces sys_script_include and sys_script only, so nothing was traced for this sys_ui_policy row/,
    );
    assert.ok(isIncomplete(report));
  });
});

describe("Business Rule tracing in the analyzer", () => {
  it("a bound rule with no warnings is a clean graph with a demanded spec", async () => {
    const businessRules = lookupStub({
      rules: [{ rule: RULE_A, collection: "incident" }],
    });
    const search = searchStub();
    const h = analyzerWith({ subjectTables: BOTH, businessRules, search });
    const report = await h.analyze([RULE_A]);

    assert.equal(businessRules.calls.length, 1);
    assert.deepEqual(businessRules.calls[0].subjects, [RULE_A]);
    assert.equal(businessRules.calls[0].scopeSysId, SCOPE_SYS_ID);
    // The rule is searched for by its trigger table, keyed on its own sys_id.
    assert.equal(search.calls.length, 1);
    assert.deepEqual(search.calls[0].subjects, [
      { table: "sys_script", sysId: RULE_A.sysId, name: "incident" },
    ]);

    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false);
    assert.deepEqual(report.graph.demanded, [
      {
        spec: {
          id: `sys_script/${RULE_A.sysId}`,
          path: `tests/${SCOPE_NAME}/sys_script/Alpha_rule/Alpha_rule.unit.ts`,
        },
        kind: "unit",
        target: RULE_A,
      },
    ]);
  });

  it("a script naming the rule's table becomes a table_logic edge at scanner confidence", async () => {
    const CONSUMER = {
      table: "sys_script_include",
      sysId: sysId("c0de"),
      name: "Writer",
    };
    const businessRules = lookupStub({
      rules: [
        { rule: RULE_A, collection: "incident" },
        { rule: RULE_B, collection: "incident" },
      ],
    });
    const search = searchStub({
      references: [
        reference(CONSUMER, "incident", "text"),
        // The rule's own row mentioning the table never makes a self-edge.
        reference(RULE_A, "incident", "text"),
      ],
    });
    const h = analyzerWith({ subjectTables: BOTH, businessRules, search });
    const report = await h.analyze([RULE_A, RULE_B]);

    const edges = report.graph.edges.map((e) => [
      e.from.sysId,
      e.to.sysId,
      e.via,
      e.confidence,
    ]);
    assert.deepEqual(edges, [
      // Siblings: the two rules share a table (medium, both directions).
      [RULE_A.sysId, RULE_B.sysId, "table_logic", "medium"],
      [RULE_A.sysId, CONSUMER.sysId, "table_logic", "low"],
      [RULE_B.sysId, RULE_A.sysId, "table_logic", "medium"],
      [RULE_B.sysId, CONSUMER.sysId, "table_logic", "low"],
    ]);
    // No duplicate-name warning for two rules on one table; no unknown name.
    assert.deepEqual(
      report.notes.filter((n) => n.level === "warning").map((n) => n.message),
      [],
    );
    // The consumer Script Include is a node on an enabled table, so it demands
    // a spec too — the same rule consumers of a Script Include follow.
    assert.deepEqual(
      report.graph.demanded.map((d) => d.spec.id).sort(),
      [
        `sys_script/${RULE_A.sysId}`,
        `sys_script/${RULE_B.sysId}`,
        `sys_script_include/${CONSUMER.sysId}`,
      ].sort(),
    );
  });

  it("a non-subject sibling becomes a node, an edge and a demanded spec", async () => {
    const SIB = { table: "sys_script", sysId: sysId("5ib"), name: "Sib" };
    const businessRules = lookupStub({
      rules: [{ rule: RULE_A, collection: "incident" }],
      siblings: [{ rule: SIB, collection: "incident" }],
    });
    const h = analyzerWith({ subjectTables: BOTH, businessRules });
    const report = await h.analyze([RULE_A]);
    assert.deepEqual(
      report.graph.edges.map((e) => [e.from.sysId, e.to.sysId, e.confidence]),
      [[RULE_A.sysId, SIB.sysId, "medium"]],
    );
    assert.deepEqual(
      report.graph.nodes.map((n) => n.sysId),
      [RULE_A.sysId, SIB.sysId],
    );
    assert.equal(report.graph.demanded.length, 2);
  });

  it("a name matching both a Script Include and a rule's table is attributed to both", async () => {
    const SI_NAMED = {
      table: "sys_script_include",
      sysId: sysId("5a3e"),
      name: "incident",
    };
    const CONSUMER = {
      table: "sys_ui_action",
      sysId: sysId("c0de"),
      name: "Btn",
    };
    const businessRules = lookupStub({
      rules: [{ rule: RULE_A, collection: "incident" }],
    });
    const search = searchStub({
      references: [reference(CONSUMER, "incident", "call")],
    });
    const h = analyzerWith({ subjectTables: BOTH, businessRules, search });
    const report = await h.analyze([RULE_A, SI_NAMED]);
    assert.deepEqual(
      report.graph.edges.map((e) => [e.from.sysId, e.via]),
      [
        [RULE_A.sysId, "table_logic"],
        [SI_NAMED.sysId, "where_used"],
      ],
    );
  });

  it("a rule the lookup refused is unanalyzable and is not searched for", async () => {
    const businessRules = lookupStub({
      unanalyzable: [{ artifact: RULE_A, reason: "refused by the lookup" }],
    });
    const search = searchStub();
    const h = analyzerWith({ subjectTables: BOTH, businessRules, search });
    const report = await h.analyze([RULE_A]);
    assert.equal(search.calls.length, 0);
    assert.deepEqual(report.graph.unanalyzable, [
      { artifact: RULE_A, reason: "refused by the lookup" },
    ]);
    assert.ok(isIncomplete(report));
  });

  it("fails closed on a lookup that forgets a subject", async () => {
    const h = analyzerWith({
      subjectTables: BOTH,
      businessRules: lookupStub(),
    });
    const report = await h.analyze([RULE_A]);
    assert.equal(report.graph.unanalyzable.length, 1);
    assert.match(
      report.graph.unanalyzable[0].reason,
      /returned nothing for this sys_script row/,
    );
    assert.ok(isIncomplete(report));
  });

  it("ignores lookup output about artifacts it was never asked about", async () => {
    const businessRules = lookupStub({
      rules: [
        { rule: RULE_A, collection: "incident" },
        { rule: RULE_B, collection: "incident" },
      ],
      unanalyzable: [{ artifact: RULE_B, reason: "noise" }],
    });
    const h = analyzerWith({ subjectTables: BOTH, businessRules });
    const report = await h.analyze([RULE_A]);
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.deepEqual(report.graph.edges, []);
  });

  it("an incomplete search marks every bound rule unanalyzable", async () => {
    const businessRules = lookupStub({
      rules: [{ rule: RULE_A, collection: "incident" }],
    });
    const search = searchStub({
      incomplete: true,
      notes: [
        { level: "warning", message: "sys_ui_action could not be searched" },
      ],
    });
    const h = analyzerWith({ subjectTables: BOTH, businessRules, search });
    const report = await h.analyze([RULE_A]);
    assert.equal(report.graph.unanalyzable.length, 1);
    assert.match(
      report.graph.unanalyzable[0].reason,
      /business rule `Alpha rule` through table `incident` could not be fully traced.*sys_ui_action could not be searched/,
    );
  });

  it("a nameless rule is traced, but its spec cannot be demanded (warning)", async () => {
    const NAMELESS_RULE = {
      table: "sys_script",
      sysId: sysId("d0d0"),
      name: `sys_script/${sysId("d0d0")}`,
    };
    const businessRules = lookupStub({
      rules: [{ rule: NAMELESS_RULE, collection: "incident" }],
    });
    const h = analyzerWith({ subjectTables: BOTH, businessRules });
    const report = await h.analyze([NAMELESS_RULE]);
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.deepEqual(report.graph.demanded, []);
    assert.ok(
      report.notes.some(
        (n) =>
          n.level === "warning" &&
          n.message.startsWith(
            `no unit spec is demanded for sys_script/${NAMELESS_RULE.sysId}`,
          ),
      ),
    );
    assert.ok(isIncomplete(report));
  });

  it("Business Rules alone may be enabled; a Script Include is then unanalyzable", async () => {
    const businessRules = lookupStub({
      rules: [{ rule: RULE_A, collection: "incident" }],
    });
    const h = analyzerWith({ subjectTables: ["sys_script"], businessRules });
    const report = await h.analyze([RULE_A, INCLUDE]);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [INCLUDE.sysId],
    );
    assert.deepEqual(
      report.graph.demanded.map((d) => d.spec.id),
      [`sys_script/${RULE_A.sysId}`],
    );
  });

  it("a duplicated rule input is looked up once", async () => {
    const businessRules = lookupStub({
      rules: [{ rule: RULE_A, collection: "incident" }],
    });
    const h = analyzerWith({ subjectTables: BOTH, businessRules });
    await h.analyze([RULE_A, RULE_A]);
    assert.deepEqual(businessRules.calls[0].subjects, [RULE_A]);
  });
});

describe("end to end over the live lookup and the live where-used search", () => {
  const WRITER = {
    table: "sys_script_include",
    sysId: sysId("c0de"),
    name: "IncidentWriter",
  };

  function liveReader(extra = {}) {
    return readerFrom({
      sys_scope: answered([SCOPE_ROW]),
      sys_script: answered([
        {
          sys_id: RULE_A.sysId,
          sys_name: RULE_A.name,
          collection: "incident",
          script:
            "(function executeRule(current, previous) {\n  current.state = 2;\n})(current, previous);",
          condition: "",
        },
      ]),
      sys_script_include: answered([
        {
          sys_id: WRITER.sysId,
          sys_name: WRITER.name,
          script: "var gr = new GlideRecord('incident');\ngr.insert();",
        },
      ]),
      ...extra,
    });
  }

  it("a plain Business Rule reaches a clean graph with a demanded spec", async () => {
    const reader = liveReader();
    const analyzer = createImpactAnalyzer(reader, {
      scope: SCOPE_NAME,
      subjectTables: BOTH,
    });
    const report = await analyzer.analyzeWithReport(ctx(), [
      { ref: RULE_A, resolvedBy: "scope" },
    ]);
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(
      report.graph.edges.map((e) => [e.from.sysId, e.to.sysId, e.via]),
      [[RULE_A.sysId, WRITER.sysId, "table_logic"]],
    );
    assert.deepEqual(
      report.graph.demanded.map((d) => d.spec.id).sort(),
      [
        `sys_script/${RULE_A.sysId}`,
        `sys_script_include/${WRITER.sysId}`,
      ].sort(),
    );
    // `analyze` (the port) agrees with the report's graph.
    const graph = await analyzer.analyze(ctx(), [
      { ref: RULE_A, resolvedBy: "scope" },
    ]);
    assert.deepEqual(graph.unanalyzable, []);
  });

  it("the same rule is INCONCLUSIVE-shaped under the default options", async () => {
    const analyzer = createImpactAnalyzer(liveReader(), { scope: SCOPE_NAME });
    const report = await analyzer.analyzeWithReport(ctx(), [
      { ref: RULE_A, resolvedBy: "scope" },
    ]);
    assert.equal(report.graph.unanalyzable.length, 1);
    assert.ok(isIncomplete(report));
  });

  it("a truncated sys_script read fails closed end to end", async () => {
    const reader = liveReader({
      sys_script: answered([row(RULE_A, "incident", { script: "" })], {
        truncated: true,
        total: 9,
        truncationReason: "cap",
      }),
    });
    const analyzer = createImpactAnalyzer(reader, {
      scope: SCOPE_NAME,
      subjectTables: BOTH,
    });
    const report = await analyzer.analyzeWithReport(ctx(), [
      { ref: RULE_A, resolvedBy: "scope" },
    ]);
    assert.ok(
      report.graph.unanalyzable.some((u) => u.artifact.sysId === RULE_A.sysId),
    );
    assert.ok(isIncomplete(report));
  });
});
