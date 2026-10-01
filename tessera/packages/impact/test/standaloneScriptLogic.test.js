// Standalone server-side script tracing — the wave-16 extension of the subject
// surface to `sysauto_script` (scheduled jobs), `sys_ws_operation` (Scripted
// REST operations) and `sys_transform_script` (transform map scripts).
//
// Three layers, each against its own seam, mirroring `uiActionLogic.test.js`:
//
//   * `createStandaloneScriptLookup` against a canned `RecordReader` — which
//     scripts bind (row read, body scanned against the scope's Script Include
//     names) and every way a read refusal, a truncation, an unreadable column
//     or dynamic dispatch fails the lookup closed;
//   * `createImpactAnalyzer` with `subjectTables` against an injected lookup
//     and search — the opt-in default, SI → script edges, sys_id callers,
//     defensive binding and the fail-closed paths of the graph builder;
//   * end to end over a canned reader through the LIVE lookup and the LIVE
//     where-used search.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  CONSUMER_TABLES,
  REST_OPERATION_TABLE,
  SCHEDULED_SCRIPT_TABLE,
  STANDALONE_SCRIPT_LOOKUP_TABLES,
  STANDALONE_SCRIPT_TABLES,
  TRANSFORM_MAP_TABLE,
  SUBJECT_TABLES,
  TRANSFORM_SCRIPT_TABLE,
  createImpactAnalyzer,
  createStandaloneScriptLookup,
  isIncomplete,
} from "../build/index.js";

const SCOPE_SYS_ID = "5c0be000000000000000000000000000";
const SCOPE_NAME = "x_acme_inventory";
const SCOPE_ROW = { sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME, name: "Acme" };

function sysId(prefix) {
  return prefix.padEnd(32, "0");
}

const JOB = {
  table: "sysauto_script",
  sysId: sysId("10b1"),
  name: "Nightly recalc",
};
const OPERATION = {
  table: "sys_ws_operation",
  sysId: sysId("0e1a"),
  name: "GET amounts",
};
const TRANSFORM = {
  table: "sys_transform_script",
  sysId: sysId("7a75"),
  name: "onBefore amounts",
};
const INCLUDE = {
  table: "sys_script_include",
  sysId: sysId("ca1c"),
  name: "AmountCalculator",
};
const OTHER_INCLUDE = {
  table: "sys_script_include",
  sysId: sysId("0c0c"),
  name: "TaxHelper",
};
const RULE = {
  table: "sys_script",
  sysId: sysId("e1e1"),
  name: "Incident rule",
};

const WITH_JOBS = ["sys_script_include", "sysauto_script"];

function ctx() {
  return {
    runId: "run-standalone-script-logic",
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

function truncated(records) {
  return answered(records, {
    truncated: true,
    total: records.length + 5,
    truncationReason: "cap",
  });
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

function includeRow(ref, extra = {}) {
  return { sys_id: ref.sysId, sys_name: ref.name, name: ref.name, ...extra };
}

function jobRow(ref, script, extra = {}) {
  return { sys_id: ref.sysId, sys_name: ref.name, script, ...extra };
}

/** The transform map the canned transform script belongs to. */
const MAP_ID = sysId("3a9");
const TARGET_TABLE = "x_acme_inventory_amount";

function transformRow(ref, script, extra = {}) {
  return jobRow(ref, script, { map: MAP_ID, ...extra });
}

function mapRow(extra = {}) {
  return { sys_id: MAP_ID, target_table: TARGET_TABLE, ...extra };
}

const MAPS = answered([mapRow()]);

const CALLS_INCLUDE =
  "var calc = new AmountCalculator();\ncalc.recalculate();\n// TaxHelper later";

function lookup(canned, subjects = [JOB]) {
  const reader = readerFrom(canned);
  return {
    reader,
    result: createStandaloneScriptLookup(reader)({
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

function refusedIds(result) {
  return result.unanalyzable.map((u) => u.artifact.sysId);
}

const INCLUDES = answered([includeRow(INCLUDE), includeRow(OTHER_INCLUDE)]);

describe("standalone script tables", () => {
  it("exports the three tables in a fixed order", () => {
    assert.equal(SCHEDULED_SCRIPT_TABLE, "sysauto_script");
    assert.equal(REST_OPERATION_TABLE, "sys_ws_operation");
    assert.equal(TRANSFORM_SCRIPT_TABLE, "sys_transform_script");
    assert.deepEqual(
      [...STANDALONE_SCRIPT_TABLES],
      ["sysauto_script", "sys_ws_operation", "sys_transform_script"],
    );
    assert.ok(Object.isFrozen(STANDALONE_SCRIPT_TABLES));
    for (const table of STANDALONE_SCRIPT_TABLES) {
      assert.ok(SUBJECT_TABLES.includes(table), table);
    }
  });

  it("client scripts, UI policies and ACLs are not subject tables", () => {
    for (const table of [
      "sys_script_client",
      "sys_ui_policy",
      "sys_security_acl",
    ]) {
      assert.equal(SUBJECT_TABLES.includes(table), false, table);
      assert.throws(
        () =>
          createImpactAnalyzer(readerFrom({}), {
            scope: SCOPE_NAME,
            subjectTables: [table],
          }),
        /cannot trace/,
      );
    }
  });

  it("each table's script column is the one the where-used search reads", async () => {
    // The lookup's `fields` are pinned against `CONSUMER_TABLES` so the two
    // cannot drift apart.
    for (const table of STANDALONE_SCRIPT_TABLES) {
      const consumer = CONSUMER_TABLES.find((entry) => entry.table === table);
      assert.ok(consumer, table);
      const subject = { table, sysId: sysId("5ab"), name: "s" };
      const { reader, result } = lookup(
        {
          [table]: answered([
            Object.fromEntries([
              ["sys_id", subject.sysId],
              ["sys_name", "s"],
              ...consumer.scriptFields.map((field) => [field, ""]),
              ["map", MAP_ID],
            ]),
          ]),
          sys_transform_map: MAPS,
          sys_script_include: INCLUDES,
        },
        [subject],
      );
      const out = await result;
      assert.deepEqual(reader.requests[0].fields, [
        "sys_id",
        "sys_name",
        ...consumer.scriptFields,
        // A transform script also reads its map reference (wave 17).
        ...(table === "sys_transform_script" ? ["map"] : []),
      ]);
      assert.deepEqual(refusedIds(out), [], table);
    }
  });
});

describe("createStandaloneScriptLookup", () => {
  it("reads the subject table then sys_script_include once each, in scope", async () => {
    const { reader, result } = lookup({
      sysauto_script: answered([jobRow(JOB, CALLS_INCLUDE)]),
      sys_script_include: INCLUDES,
    });
    const out = await result;
    assert.deepEqual(reader.requests, [
      {
        table: "sysauto_script",
        query: `sys_scope=${SCOPE_SYS_ID}`,
        fields: ["sys_id", "sys_name", "script"],
        fetchAll: true,
        crossCheckCount: true,
      },
      {
        table: "sys_script_include",
        query: `sys_scope=${SCOPE_SYS_ID}`,
        fields: ["sys_id", "sys_name", "name"],
        fetchAll: true,
        crossCheckCount: true,
      },
    ]);
    assert.deepEqual(refusedIds(out), []);
    assert.equal(out.scripts.length, 1);
    assert.deepEqual(out.scripts[0].script, JOB);
    assert.deepEqual(
      out.scripts[0].calls.map((c) => [
        c.include.sysId,
        c.field,
        c.match.kind,
        c.match.line,
      ]),
      [
        [INCLUDE.sysId, "script", "call", 1],
        [OTHER_INCLUDE.sysId, "script", "text", 3],
      ],
    );
    assert.deepEqual(levels(out.notes, "warning"), []);
  });

  it("an empty subject list reads nothing", async () => {
    const { reader, result } = lookup({}, []);
    const out = await result;
    assert.deepEqual(reader.requests, []);
    assert.deepEqual(out, {
      scripts: [],
      rules: [],
      unanalyzable: [],
      notes: [],
    });
  });

  it("a subject on another table is refused without a read of it", async () => {
    const { reader, result } = lookup({}, [RULE]);
    const out = await result;
    assert.deepEqual(refusedIds(out), [RULE.sysId]);
    assert.deepEqual(
      reader.requests.map((r) => r.table),
      [],
    );
  });

  it("reads each subject table once, in a fixed order, and binds all", async () => {
    const { reader, result } = lookup(
      {
        sysauto_script: answered([jobRow(JOB, "")]),
        sys_ws_operation: answered([
          {
            sys_id: OPERATION.sysId,
            sys_name: OPERATION.name,
            operation_script: "new AmountCalculator().get();",
          },
        ]),
        sys_transform_script: answered([transformRow(TRANSFORM, "")]),
        sys_transform_map: MAPS,
        sys_script_include: INCLUDES,
      },
      [TRANSFORM, OPERATION, JOB, JOB],
    );
    const out = await result;
    assert.deepEqual(
      reader.requests.map((r) => r.table),
      [
        "sysauto_script",
        "sys_ws_operation",
        "sys_transform_script",
        "sys_transform_map",
        "sys_script",
        "sys_script_include",
      ],
    );
    assert.deepEqual(refusedIds(out), []);
    // Sorted by table name (code-unit order), then name.
    assert.deepEqual(
      out.scripts.map((s) => [s.script.sysId, s.calls.length]),
      [
        [TRANSFORM.sysId, 0],
        [OPERATION.sysId, 1],
        [JOB.sysId, 0],
      ],
    );
    assert.equal(out.scripts[1].calls[0].field, "operation_script");
  });

  it("a subject missing from the scope rows is refused", async () => {
    const { result } = lookup({
      sysauto_script: answered([jobRow({ ...JOB, sysId: sysId("ff") }, "")]),
      sys_script_include: INCLUDES,
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.match(
      out.unanalyzable[0].reason,
      /was not among the sysauto_script rows/,
    );
    assert.deepEqual(out.scripts, []);
  });

  it("an unreadable script column is refused, never an empty script", async () => {
    const { result } = lookup({
      sysauto_script: answered([{ sys_id: JOB.sysId, sys_name: JOB.name }]),
      sys_script_include: INCLUDES,
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.match(out.unanalyzable[0].reason, /script column/);
    assert.deepEqual(out.scripts, []);
  });

  it("a body with dynamic dispatch is refused", async () => {
    const { result } = lookup({
      sysauto_script: answered([
        jobRow(JOB, "new AmountCalculator();\nvar x = eval(name);"),
      ]),
      sys_script_include: INCLUDES,
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.match(out.unanalyzable[0].reason, /`eval` on line 2/);
    assert.deepEqual(out.scripts, []);
  });

  it("an undecidable subject-table read refuses its subjects and warns", async () => {
    const { reader, result } = lookup({
      sysauto_script: undecidable("read refused (403)"),
      sys_script_include: INCLUDES,
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.match(out.unanalyzable[0].reason, /read refused \(403\)/);
    assert.equal(levels(out.notes, "warning").length, 1);
    // Nothing bound: the include table is not read.
    assert.deepEqual(
      reader.requests.map((r) => r.table),
      ["sysauto_script"],
    );
  });

  it("a truncated subject-table read refuses its subjects, even one it returned", async () => {
    const { result } = lookup({
      sysauto_script: truncated([jobRow(JOB, CALLS_INCLUDE)]),
      sys_script_include: INCLUDES,
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.deepEqual(out.scripts, []);
    assert.equal(levels(out.notes, "warning").length, 1);
  });

  it("one refused table does not refuse another table's subjects", async () => {
    const { result } = lookup(
      {
        sysauto_script: undecidable("read refused (403)"),
        sys_transform_script: answered([transformRow(TRANSFORM, "")]),
        sys_transform_map: MAPS,
        sys_script_include: INCLUDES,
      },
      [JOB, TRANSFORM],
    );
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.deepEqual(
      out.scripts.map((s) => s.script.sysId),
      [TRANSFORM.sysId],
    );
  });

  it("an undecidable sys_script_include read refuses every bound script", async () => {
    const { result } = lookup({
      sysauto_script: answered([jobRow(JOB, CALLS_INCLUDE)]),
      sys_script_include: undecidable("read refused (403)"),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.match(
      out.unanalyzable[0].reason,
      /sys_script_include could not be read/,
    );
    assert.deepEqual(out.scripts, []);
    assert.equal(levels(out.notes, "warning").length, 1);
  });

  it("a truncated sys_script_include read refuses every bound script", async () => {
    const { result } = lookup({
      sysauto_script: answered([jobRow(JOB, CALLS_INCLUDE)]),
      sys_script_include: truncated([includeRow(INCLUDE)]),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.deepEqual(out.scripts, []);
    assert.equal(levels(out.notes, "warning").length, 1);
  });

  it("an include row with no readable name refuses every bound script", async () => {
    const { result } = lookup({
      sysauto_script: answered([jobRow(JOB, CALLS_INCLUDE)]),
      sys_script_include: answered([
        includeRow(INCLUDE),
        includeRow(OTHER_INCLUDE, { name: "" }),
      ]),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
    assert.match(
      out.unanalyzable[0].reason,
      /without a readable sys_id or name/,
    );
    assert.deepEqual(out.scripts, []);
  });

  it("an include row with no sys_id refuses every bound script", async () => {
    const { result } = lookup({
      sysauto_script: answered([jobRow(JOB, "")]),
      sys_script_include: answered([includeRow(INCLUDE, { sys_id: "" })]),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [JOB.sysId]);
  });

  it("two includes sharing a name both get the call, with a warning", async () => {
    const twin = { ...INCLUDE, sysId: sysId("7a1") };
    const { result } = lookup({
      sysauto_script: answered([jobRow(JOB, "new AmountCalculator();")]),
      sys_script_include: answered([includeRow(INCLUDE), includeRow(twin)]),
    });
    const out = await result;
    assert.deepEqual(
      out.scripts[0].calls.map((c) => c.include.sysId).sort(),
      [INCLUDE.sysId, twin.sysId].sort(),
    );
    assert.equal(levels(out.notes, "warning").length, 1);
  });

  it("binds the subject's own ref, not the row's label", async () => {
    const { result } = lookup({
      sysauto_script: answered([jobRow(JOB, "", { sys_name: "Renamed" })]),
      sys_script_include: INCLUDES,
    });
    const out = await result;
    assert.equal(out.scripts[0].script, JOB);
  });
});

// ── the analyzer ─────────────────────────────────────────────────────────

function scopeReader() {
  return {
    profile: "source",
    queryRecords(request) {
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

function scriptLookupStub(result = {}) {
  const calls = [];
  const fn = (request) => {
    calls.push(request);
    return Promise.resolve({
      scripts: [],
      rules: [],
      unanalyzable: [],
      notes: [],
      ...result,
    });
  };
  fn.calls = calls;
  return fn;
}

function analyzerWith({ subjectTables, search, standaloneScripts } = {}) {
  const analyzer = createImpactAnalyzer(scopeReader(), {
    scope: SCOPE_NAME,
    search: search ?? searchStub(),
    ...(standaloneScripts === undefined ? {} : { standaloneScripts }),
    ...(subjectTables === undefined ? {} : { subjectTables }),
  });
  return {
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

function call(include, kind, line = 1) {
  return {
    include,
    field: "script",
    match: { name: include.name, kind, line },
  };
}

const BOUND_JOB = {
  script: JOB,
  calls: [call(INCLUDE, "call"), call(OTHER_INCLUDE, "text", 3)],
};

function edgeRows(report) {
  return report.graph.edges.map((e) => [
    e.from.sysId,
    e.to.sysId,
    e.via,
    e.confidence,
  ]);
}

describe("standalone script tracing in the analyzer", () => {
  it("by default a scheduled job stays unanalyzable and no lookup runs (opt-in)", async () => {
    const standaloneScripts = scriptLookupStub({ scripts: [BOUND_JOB] });
    const report = await analyzerWith({ standaloneScripts }).analyze([JOB]);
    assert.equal(standaloneScripts.calls.length, 0);
    assert.equal(report.graph.unanalyzable.length, 1);
    assert.match(
      report.graph.unanalyzable[0].reason,
      /MVP impact analysis traces sys_script_include usage only/,
    );
    assert.deepEqual(report.graph.edges, []);
    assert.deepEqual(report.graph.demanded, []);
    assert.ok(isIncomplete(report));
  });

  it("a table left out of subjectTables stays unanalyzable even with another one on", async () => {
    const standaloneScripts = scriptLookupStub();
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
    }).analyze([OPERATION]);
    assert.equal(standaloneScripts.calls.length, 0);
    assert.match(
      report.graph.unanalyzable[0].reason,
      /traces sys_script_include and sysauto_script only/,
    );
    assert.ok(isIncomplete(report));
  });

  it("a bound job edges every include it calls to itself and searches its sys_id", async () => {
    const standaloneScripts = scriptLookupStub({ scripts: [BOUND_JOB] });
    const caller = {
      table: "sys_script_include",
      sysId: sysId("ca11e5"),
      name: "JobStarter",
    };
    const search = searchStub({
      references: [
        reference(caller, JOB.sysId, "text"),
        // Its own mention is never a self-loop.
        reference(JOB, JOB.sysId, "text"),
      ],
    });
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
      search,
    }).analyze([JOB, JOB]);

    assert.equal(standaloneScripts.calls.length, 1);
    assert.deepEqual(standaloneScripts.calls[0].subjects, [JOB]);
    assert.equal(standaloneScripts.calls[0].scopeSysId, SCOPE_SYS_ID);
    assert.deepEqual(search.calls[0].subjects, [
      { table: "sysauto_script", sysId: JOB.sysId, name: JOB.sysId },
    ]);
    assert.deepEqual(edgeRows(report), [
      [INCLUDE.sysId, JOB.sysId, "where_used", "high"],
      [JOB.sysId, caller.sysId, "where_used", "low"],
      [OTHER_INCLUDE.sysId, JOB.sysId, "where_used", "low"],
    ]);
    assert.deepEqual(
      report.graph.nodes.map((n) => n.sysId).sort(),
      [INCLUDE.sysId, OTHER_INCLUDE.sysId, caller.sysId, JOB.sysId].sort(),
    );
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(
      report.graph.demanded.map((d) => [d.spec.id, d.spec.path]),
      [
        [
          `sys_script_include/${INCLUDE.sysId}`,
          `tests/${SCOPE_NAME}/sys_script_include/AmountCalculator/AmountCalculator.unit.ts`,
        ],
        [
          `sys_script_include/${caller.sysId}`,
          `tests/${SCOPE_NAME}/sys_script_include/JobStarter/JobStarter.unit.ts`,
        ],
        [
          `sys_script_include/${OTHER_INCLUDE.sysId}`,
          `tests/${SCOPE_NAME}/sys_script_include/TaxHelper/TaxHelper.unit.ts`,
        ],
        [
          `sysauto_script/${JOB.sysId}`,
          `tests/${SCOPE_NAME}/sysauto_script/Nightly_recalc/Nightly_recalc.unit.ts`,
        ],
      ],
    );
  });

  it("the strongest mention of an include wins the edge", async () => {
    const standaloneScripts = scriptLookupStub({
      scripts: [
        {
          script: JOB,
          calls: [call(INCLUDE, "text"), call(INCLUDE, "identifier", 2)],
        },
      ],
    });
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
    }).analyze([JOB]);
    assert.deepEqual(edgeRows(report), [
      [INCLUDE.sysId, JOB.sysId, "where_used", "medium"],
    ]);
  });

  it("with only the job table enabled, called includes are nodes but demand no spec", async () => {
    const standaloneScripts = scriptLookupStub({ scripts: [BOUND_JOB] });
    const report = await analyzerWith({
      subjectTables: ["sysauto_script"],
      standaloneScripts,
    }).analyze([JOB]);
    assert.equal(report.graph.nodes.length, 3);
    assert.deepEqual(
      report.graph.demanded.map((d) => d.spec.id),
      [`sysauto_script/${JOB.sysId}`],
    );
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
  });

  it("a script the lookup neither bound nor refused is refused by the analyzer", async () => {
    const standaloneScripts = scriptLookupStub();
    const search = searchStub();
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
      search,
    }).analyze([JOB]);
    assert.equal(search.calls.length, 0);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [JOB.sysId],
    );
    assert.match(
      report.graph.unanalyzable[0].reason,
      /standalone script lookup returned nothing/,
    );
    assert.ok(isIncomplete(report));
  });

  it("a row the lookup bound for a different subject is not taken for this one", async () => {
    const standaloneScripts = scriptLookupStub({
      scripts: [{ script: TRANSFORM, calls: [call(INCLUDE, "call")] }],
    });
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
    }).analyze([JOB]);
    assert.deepEqual(report.graph.edges, []);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [JOB.sysId],
    );
  });

  it("a refused script is carried through and not traced", async () => {
    const standaloneScripts = scriptLookupStub({
      scripts: [BOUND_JOB],
      unanalyzable: [{ artifact: JOB, reason: "sysauto_script read refused" }],
    });
    const search = searchStub();
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
      search,
    }).analyze([JOB]);
    assert.equal(search.calls.length, 0);
    assert.deepEqual(report.graph.edges, []);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.reason),
      ["sysauto_script read refused"],
    );
    assert.ok(isIncomplete(report));
  });

  it("an incomplete search makes every bound script unanalyzable", async () => {
    const standaloneScripts = scriptLookupStub({ scripts: [BOUND_JOB] });
    const search = searchStub({
      incomplete: true,
      notes: [
        { level: "warning", message: "sys_script_client could not be read" },
      ],
    });
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
      search,
    }).analyze([JOB]);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [JOB.sysId],
    );
    assert.match(
      report.graph.unanalyzable[0].reason,
      /sysauto_script script `Nightly recalc`.*sys_script_client could not be read/,
    );
    assert.ok(isIncomplete(report));
  });

  it("the lookup's notes reach the report", async () => {
    const standaloneScripts = scriptLookupStub({
      scripts: [BOUND_JOB],
      notes: [{ level: "warning", message: "two includes named X" }],
    });
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
    }).analyze([JOB]);
    assert.ok(report.notes.some((n) => n.message === "two includes named X"));
    assert.ok(isIncomplete(report));
  });
});

// ── end to end ────────────────────────────────────────────────────────────

describe("end to end over the live standalone script lookup and the live where-used search", () => {
  function liveReader(extra = {}) {
    return readerFrom({
      sys_scope: answered([SCOPE_ROW]),
      sysauto_script: answered([jobRow(JOB, CALLS_INCLUDE)]),
      sys_script_include: answered([
        includeRow(INCLUDE, {
          script: "var AmountCalculator = Class.create();",
        }),
        includeRow(OTHER_INCLUDE, {
          script: "var TaxHelper = Class.create();",
        }),
      ]),
      ...extra,
    });
  }

  function analyze(reader, subjectTables = WITH_JOBS) {
    return createImpactAnalyzer(reader, {
      scope: SCOPE_NAME,
      // `null` asks for the analyzer's own default (no `subjectTables`).
      ...(subjectTables === null ? {} : { subjectTables }),
    }).analyzeWithReport(ctx(), [{ ref: JOB, resolvedBy: "scope" }]);
  }

  it("a scheduled job reaches a clean graph with SI edges and demanded specs", async () => {
    const report = await analyze(liveReader());
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(edgeRows(report), [
      [INCLUDE.sysId, JOB.sysId, "where_used", "high"],
      [OTHER_INCLUDE.sysId, JOB.sysId, "where_used", "low"],
    ]);
    assert.deepEqual(
      report.graph.demanded.map((d) => d.spec.id),
      [
        `sys_script_include/${INCLUDE.sysId}`,
        `sys_script_include/${OTHER_INCLUDE.sysId}`,
        `sysauto_script/${JOB.sysId}`,
      ],
    );
  });

  it("the same job is INCONCLUSIVE-shaped under the default options", async () => {
    const report = await analyze(liveReader(), null);
    assert.equal(report.graph.unanalyzable.length, 1);
    assert.deepEqual(report.graph.edges, []);
    assert.ok(isIncomplete(report));
  });

  it("an ACL-refused sysauto_script read stays INCONCLUSIVE-shaped", async () => {
    const report = await analyze(
      liveReader({ sysauto_script: undecidable("read refused (403)") }),
    );
    assert.ok(
      report.graph.unanalyzable.some((u) => u.artifact.sysId === JOB.sysId),
    );
    assert.ok(isIncomplete(report));
  });

  it("a truncated sys_script_include read stays INCONCLUSIVE-shaped", async () => {
    const report = await analyze(
      liveReader({
        sys_script_include: truncated([includeRow(INCLUDE)]),
      }),
    );
    assert.ok(
      report.graph.unanalyzable.some((u) => u.artifact.sysId === JOB.sysId),
    );
    assert.ok(isIncomplete(report));
  });

  it("a job whose body names its call target at runtime stays INCONCLUSIVE-shaped", async () => {
    const report = await analyze(
      liveReader({
        sysauto_script: answered([
          jobRow(JOB, "var o = new GlideScopedEvaluator();"),
        ]),
      }),
    );
    assert.ok(
      report.graph.unanalyzable.some((u) => u.artifact.sysId === JOB.sysId),
    );
    assert.ok(isIncomplete(report));
  });
});

// ── the transform script's target table (wave 17) ─────────────────────────

describe("a transform script's target table", () => {
  const TARGET_RULE = {
    table: "sys_script",
    sysId: sysId("7a6e7"),
    name: "Amount before insert",
  };
  const OTHER_RULE = {
    table: "sys_script",
    sysId: sysId("07e7"),
    name: "Incident rule",
  };
  const GLOBAL_RULE = {
    table: "sys_script",
    sysId: sysId("610b"),
    name: "Everywhere rule",
  };

  // `script` too: the analyzer's where-used search reads the same table and
  // refuses a rule whose body it cannot read.
  function ruleRow(ref, collection, extra = {}) {
    return {
      sys_id: ref.sysId,
      sys_name: ref.name,
      collection,
      script: "",
      ...extra,
    };
  }

  const RULES = answered([
    ruleRow(TARGET_RULE, TARGET_TABLE),
    ruleRow(OTHER_RULE, "incident"),
    ruleRow(GLOBAL_RULE, "global"),
  ]);

  function transformLookup(extra = {}, subjects = [TRANSFORM]) {
    return lookup(
      {
        sys_transform_script: answered([transformRow(TRANSFORM, "")]),
        sys_transform_map: MAPS,
        sys_script: RULES,
        sys_script_include: INCLUDES,
        ...extra,
      },
      subjects,
    );
  }

  it("exports the lookup's table list as the one source for the CLI's reader", () => {
    assert.equal(TRANSFORM_MAP_TABLE, "sys_transform_map");
    assert.deepEqual(
      [...STANDALONE_SCRIPT_LOOKUP_TABLES],
      [
        "sysauto_script",
        "sys_ws_operation",
        "sys_transform_script",
        "sys_transform_map",
        "sys_script",
        "sys_script_include",
      ],
    );
    assert.ok(Object.isFrozen(STANDALONE_SCRIPT_LOOKUP_TABLES));
  });

  it("every table the lookup reads is in STANDALONE_SCRIPT_LOOKUP_TABLES", async () => {
    const { reader, result } = transformLookup({}, [TRANSFORM, JOB, OPERATION]);
    await result;
    for (const request of reader.requests) {
      assert.ok(
        STANDALONE_SCRIPT_LOOKUP_TABLES.includes(request.table),
        request.table,
      );
    }
  });

  it("binds the target table and returns the rules on it, a global rule included", async () => {
    const { reader, result } = transformLookup();
    const out = await result;
    assert.deepEqual(reader.requests.slice(0, 3), [
      {
        table: "sys_transform_script",
        query: `sys_scope=${SCOPE_SYS_ID}`,
        fields: ["sys_id", "sys_name", "script", "map"],
        fetchAll: true,
        crossCheckCount: true,
      },
      {
        table: "sys_transform_map",
        query: `sys_scope=${SCOPE_SYS_ID}`,
        fields: ["sys_id", "target_table"],
        fetchAll: true,
        crossCheckCount: true,
      },
      {
        table: "sys_script",
        query: `sys_scope=${SCOPE_SYS_ID}`,
        fields: ["sys_id", "sys_name", "collection"],
        fetchAll: true,
        crossCheckCount: true,
      },
    ]);
    assert.deepEqual(refusedIds(out), []);
    assert.equal(out.scripts.length, 1);
    assert.equal(out.scripts[0].script, TRANSFORM);
    assert.equal(out.scripts[0].targetTable, TARGET_TABLE);
    assert.deepEqual(
      out.rules.map((r) => [r.rule.sysId, r.collection]),
      [
        [TARGET_RULE.sysId, TARGET_TABLE],
        [GLOBAL_RULE.sysId, TARGET_TABLE],
      ],
    );
    assert.deepEqual(levels(out.notes, "warning"), []);
  });

  it("no transform script bound: neither the map nor the rule table is read", async () => {
    const { reader, result } = lookup({
      sysauto_script: answered([jobRow(JOB, "")]),
      sys_script_include: INCLUDES,
    });
    const out = await result;
    assert.deepEqual(
      reader.requests.map((r) => r.table),
      ["sysauto_script", "sys_script_include"],
    );
    assert.deepEqual(out.rules, []);
    assert.equal(out.scripts[0].targetTable, undefined);
  });

  for (const [label, map] of [
    ["absent", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not a string", 42],
  ]) {
    it(`a ${label} map reference is refused, never a script with no target`, async () => {
      const row = transformRow(TRANSFORM, "");
      if (map === undefined) delete row.map;
      else row.map = map;
      const { reader, result } = transformLookup({
        sys_transform_script: answered([row]),
      });
      const out = await result;
      assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
      assert.match(out.unanalyzable[0].reason, /`map`/);
      assert.deepEqual(out.scripts, []);
      // Nothing left to resolve a map for.
      assert.ok(!reader.requests.some((r) => r.table === "sys_transform_map"));
    });
  }

  it("a map the scope read did not return is refused", async () => {
    const { result } = transformLookup({
      sys_transform_map: answered([mapRow({ sys_id: sysId("0dd") })]),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
    assert.match(
      out.unanalyzable[0].reason,
      /was not among the sys_transform_map rows/,
    );
    assert.deepEqual(out.scripts, []);
  });

  it("an undecidable sys_transform_map read refuses the transform script only", async () => {
    const { reader, result } = transformLookup(
      {
        sysauto_script: answered([jobRow(JOB, "")]),
        sys_transform_map: undecidable("read refused (403)"),
      },
      [TRANSFORM, JOB],
    );
    const out = await result;
    assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
    assert.match(
      out.unanalyzable[0].reason,
      /sys_transform_map could not be read: read refused \(403\)/,
    );
    assert.deepEqual(
      out.scripts.map((s) => s.script.sysId),
      [JOB.sysId],
    );
    assert.equal(levels(out.notes, "warning").length, 1);
    // No bound target table: the rule table is not read.
    assert.ok(!reader.requests.some((r) => r.table === "sys_script"));
  });

  it("a truncated sys_transform_map read refuses, even the map it returned", async () => {
    const { result } = transformLookup({
      sys_transform_map: truncated([mapRow()]),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
    assert.deepEqual(out.scripts, []);
    assert.equal(levels(out.notes, "warning").length, 1);
  });

  for (const [label, target, pattern] of [
    ["absent", undefined, /`target_table`.*could not be read/],
    ["empty", "", /`target_table`.*could not be read/],
    ["not a string", 7, /`target_table`.*could not be read/],
    ["not a table name", "Amount; DROP", /not a table name/],
    ["global", "global", /every table/],
  ]) {
    it(`a ${label} target_table is refused`, async () => {
      const row = mapRow();
      if (target === undefined) delete row.target_table;
      else row.target_table = target;
      const { result } = transformLookup({
        sys_transform_map: answered([row]),
      });
      const out = await result;
      assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
      assert.match(out.unanalyzable[0].reason, pattern);
      assert.deepEqual(out.scripts, []);
    });
  }

  it("an undecidable sys_script read refuses the transform script only", async () => {
    const { result } = transformLookup(
      {
        sysauto_script: answered([jobRow(JOB, "")]),
        sys_script: undecidable("read refused (403)"),
      },
      [TRANSFORM, JOB],
    );
    const out = await result;
    assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
    assert.match(out.unanalyzable[0].reason, /sys_script could not be read/);
    assert.deepEqual(
      out.scripts.map((s) => s.script.sysId),
      [JOB.sysId],
    );
    assert.deepEqual(out.rules, []);
  });

  it("a truncated sys_script read refuses the transform script", async () => {
    const { result } = transformLookup({
      sys_script: truncated([ruleRow(TARGET_RULE, TARGET_TABLE)]),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
    assert.deepEqual(out.rules, []);
    assert.equal(levels(out.notes, "warning").length, 1);
  });

  it("a rule row with no readable trigger table refuses the transform script", async () => {
    const { result } = transformLookup({
      sys_script: answered([
        ruleRow(TARGET_RULE, TARGET_TABLE),
        ruleRow(OTHER_RULE, ""),
      ]),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
    assert.match(out.unanalyzable[0].reason, /may run on/);
    assert.deepEqual(out.rules, []);
  });

  it("a rule row with no sys_id refuses the transform script", async () => {
    const { result } = transformLookup({
      sys_script: answered([
        ruleRow(TARGET_RULE, TARGET_TABLE, { sys_id: "" }),
      ]),
    });
    const out = await result;
    assert.deepEqual(refusedIds(out), [TRANSFORM.sysId]);
  });

  // ── the analyzer ───────────────────────────────────────────────────────

  const WITH_TRANSFORMS = ["sys_script_include", "sys_transform_script"];

  it("a bound transform script edges the rules on its target table (table_logic, medium)", async () => {
    const standaloneScripts = scriptLookupStub({
      scripts: [
        {
          script: TRANSFORM,
          calls: [call(INCLUDE, "call")],
          targetTable: TARGET_TABLE,
        },
      ],
      rules: [
        { rule: TARGET_RULE, collection: TARGET_TABLE },
        { rule: OTHER_RULE, collection: "incident" },
      ],
    });
    const report = await analyzerWith({
      subjectTables: WITH_TRANSFORMS,
      standaloneScripts,
    }).analyze([TRANSFORM]);
    assert.deepEqual(edgeRows(report), [
      [INCLUDE.sysId, TRANSFORM.sysId, "where_used", "high"],
      [TRANSFORM.sysId, TARGET_RULE.sysId, "table_logic", "medium"],
    ]);
    assert.ok(report.graph.nodes.some((n) => n.sysId === TARGET_RULE.sysId));
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
  });

  it("a bound transform script without a target table is refused by the analyzer", async () => {
    const standaloneScripts = scriptLookupStub({
      scripts: [{ script: TRANSFORM, calls: [call(INCLUDE, "call")] }],
    });
    const report = await analyzerWith({
      subjectTables: WITH_TRANSFORMS,
      standaloneScripts,
    }).analyze([TRANSFORM]);
    assert.deepEqual(report.graph.edges, []);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [TRANSFORM.sysId],
    );
    assert.match(report.graph.unanalyzable[0].reason, /target table/);
    assert.ok(isIncomplete(report));
  });

  it("a lookup that bound a target table but returned no rule list is refused", async () => {
    const standaloneScripts = scriptLookupStub({
      scripts: [{ script: TRANSFORM, calls: [], targetTable: TARGET_TABLE }],
      rules: undefined,
    });
    const report = await analyzerWith({
      subjectTables: WITH_TRANSFORMS,
      standaloneScripts,
    }).analyze([TRANSFORM]);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [TRANSFORM.sysId],
    );
    assert.ok(isIncomplete(report));
  });

  it("a job needs no target table", async () => {
    const standaloneScripts = scriptLookupStub({ scripts: [BOUND_JOB] });
    const report = await analyzerWith({
      subjectTables: WITH_JOBS,
      standaloneScripts,
    }).analyze([JOB]);
    assert.deepEqual(report.graph.unanalyzable, []);
  });

  it("end to end: the live lookup edges the transform script to its target table's rule", async () => {
    const reader = readerFrom({
      sys_scope: answered([SCOPE_ROW]),
      sys_transform_script: answered([
        transformRow(TRANSFORM, "new AmountCalculator().run(source);"),
      ]),
      sys_transform_map: MAPS,
      sys_script: RULES,
      sys_script_include: answered([
        includeRow(INCLUDE, {
          script: "var AmountCalculator = Class.create();",
        }),
      ]),
    });
    const report = await createImpactAnalyzer(reader, {
      scope: SCOPE_NAME,
      subjectTables: WITH_TRANSFORMS,
    }).analyzeWithReport(ctx(), [{ ref: TRANSFORM, resolvedBy: "scope" }]);
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(edgeRows(report), [
      [INCLUDE.sysId, TRANSFORM.sysId, "where_used", "high"],
      [TRANSFORM.sysId, TARGET_RULE.sysId, "table_logic", "medium"],
      [TRANSFORM.sysId, GLOBAL_RULE.sysId, "table_logic", "medium"],
    ]);
  });

  it("end to end: a refused sys_transform_map read stays INCONCLUSIVE-shaped", async () => {
    const reader = readerFrom({
      sys_scope: answered([SCOPE_ROW]),
      sys_transform_script: answered([transformRow(TRANSFORM, "")]),
      sys_transform_map: undecidable("read refused (403)"),
      sys_script_include: INCLUDES,
    });
    const report = await createImpactAnalyzer(reader, {
      scope: SCOPE_NAME,
      subjectTables: WITH_TRANSFORMS,
    }).analyzeWithReport(ctx(), [{ ref: TRANSFORM, resolvedBy: "scope" }]);
    assert.ok(
      report.graph.unanalyzable.some(
        (u) => u.artifact.sysId === TRANSFORM.sysId,
      ),
    );
    assert.deepEqual(report.graph.edges, []);
    assert.ok(isIncomplete(report));
  });
});
