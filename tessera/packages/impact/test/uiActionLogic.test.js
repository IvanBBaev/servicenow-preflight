// UI Action (`sys_ui_action`) tracing — the wave-15 extension of the
// `table_logic` pattern Business Rules introduced in wave 14.
//
// Three layers, each against its own seam, mirroring `tableLogic.test.js`:
//
//   * `createUiActionLookup` against a canned `RecordReader` — which actions
//     bind (server-side, table-bound, readable), which are refused (client-
//     side, `global`, unreadable columns, outside the scope) and every way a
//     read refusal fails the lookup closed;
//   * `createImpactAnalyzer` with `subjectTables` against an injected lookup
//     and search — the opt-in default, edge attribution, demanded specs and
//     the fail-closed paths of the graph builder;
//   * end to end over a canned reader through the LIVE lookup and the LIVE
//     where-used search: a server-side UI Action reaches a clean graph with a
//     demanded spec, and a client-side one stays INCONCLUSIVE-shaped.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SUBJECT_TABLES,
  UI_ACTION_TABLE,
  createImpactAnalyzer,
  createUiActionLookup,
  isIncomplete,
} from "../build/index.js";

const SCOPE_SYS_ID = "5c0be000000000000000000000000000";
const SCOPE_NAME = "x_acme_inventory";
const SCOPE_ROW = { sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME, name: "Acme" };

function sysId(prefix) {
  return prefix.padEnd(32, "0");
}

const ACTION_A = {
  table: "sys_ui_action",
  sysId: sysId("a1a1"),
  name: "Recalculate",
};
const ACTION_B = {
  table: "sys_ui_action",
  sysId: sysId("b2b2"),
  name: "Close out",
};
const RULE_ON_INCIDENT = {
  table: "sys_script",
  sysId: sysId("e1e1"),
  name: "Incident rule",
};
const RULE_ON_PROBLEM = {
  table: "sys_script",
  sysId: sysId("e2e2"),
  name: "Problem rule",
};
const GLOBAL_RULE = {
  table: "sys_script",
  sysId: sysId("e3e3"),
  name: "Global rule",
};
const INCLUDE = {
  table: "sys_script_include",
  sysId: sysId("ca1c"),
  name: "AmountCalculator",
};
const CLIENT = {
  table: "sys_script_client",
  sysId: sysId("c11e"),
  name: "Submit recalc",
};

const WITH_ACTIONS = ["sys_script_include", "sys_ui_action"];

function ctx() {
  return {
    runId: "run-ui-action-logic",
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

function actionRow(ref, extra = {}) {
  return {
    sys_id: ref.sysId,
    sys_name: ref.name,
    table: "incident",
    client: "false",
    action_name: "x_acme_recalc",
    ...extra,
  };
}

function ruleRow(ref, collection) {
  return { sys_id: ref.sysId, sys_name: ref.name, collection };
}

function lookup(canned, subjects = [ACTION_A]) {
  const reader = readerFrom(canned);
  return {
    reader,
    result: createUiActionLookup(reader)({
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

describe("createUiActionLookup", () => {
  it("reads sys_ui_action then sys_script once each, in scope, identity and binding columns only", async () => {
    const { reader, result } = lookup({
      sys_ui_action: answered([actionRow(ACTION_A)]),
      sys_script: answered([
        ruleRow(RULE_ON_INCIDENT, "incident"),
        ruleRow(RULE_ON_PROBLEM, "problem"),
      ]),
    });
    const out = await result;
    assert.deepEqual(reader.requests, [
      {
        table: "sys_ui_action",
        query: `sys_scope=${SCOPE_SYS_ID}`,
        fields: ["sys_id", "sys_name", "table", "client", "action_name"],
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
    assert.deepEqual(out.actions, [
      { action: ACTION_A, table: "incident", actionName: "x_acme_recalc" },
    ]);
    assert.deepEqual(out.rules, [
      { rule: RULE_ON_INCIDENT, collection: "incident" },
    ]);
    assert.deepEqual(out.unanalyzable, []);
    assert.deepEqual(levels(out.notes, "warning"), []);
  });

  it("an empty subject list reads nothing", async () => {
    const { reader, result } = lookup({}, []);
    const out = await result;
    assert.deepEqual(reader.requests, []);
    assert.deepEqual(out, {
      actions: [],
      rules: [],
      unanalyzable: [],
      notes: [],
    });
  });

  it("the subject's own ref is bound, not the row's label", async () => {
    const renamed = { ...ACTION_A, name: "Label from the resolver" };
    const { result } = lookup(
      {
        sys_ui_action: answered([actionRow(ACTION_A)]),
        sys_script: answered([]),
      },
      [renamed, renamed],
    );
    const out = await result;
    assert.deepEqual(out.actions, [
      { action: renamed, table: "incident", actionName: "x_acme_recalc" },
    ]);
  });

  it("a blank action_name binds with no name to search for", async () => {
    const { result } = lookup({
      sys_ui_action: answered([actionRow(ACTION_A, { action_name: "  " })]),
      sys_script: answered([]),
    });
    const out = await result;
    assert.deepEqual(out.actions, [{ action: ACTION_A, table: "incident" }]);
    assert.deepEqual(out.unanalyzable, []);
  });

  it("a `global` rule in the scope is bound to every action table", async () => {
    const { result } = lookup(
      {
        sys_ui_action: answered([
          actionRow(ACTION_A),
          actionRow(ACTION_B, { table: "problem", action_name: "" }),
        ]),
        sys_script: answered([ruleRow(GLOBAL_RULE, "global")]),
      },
      [ACTION_A, ACTION_B],
    );
    const out = await result;
    assert.deepEqual(out.rules, [
      { rule: GLOBAL_RULE, collection: "incident" },
      { rule: GLOBAL_RULE, collection: "problem" },
    ]);
  });

  describe("per-action refusals (fail closed)", () => {
    const cases = [
      ["a client-side action", { client: "true" }, /client-side/],
      ["an unreadable client flag", { client: undefined }, /`client` flag/],
      ["an unexpected client flag", { client: "maybe" }, /`client` flag/],
      ["a `global` table", { table: "global" }, /every table/],
      ["an unreadable table", { table: "" }, /`table`.*could not be read/],
      [
        "a table that is not a table name",
        { table: "inc^NQ" },
        /not a table name/,
      ],
      [
        "an unreadable action_name",
        { action_name: undefined },
        /`action_name`.*could not be read/,
      ],
    ];
    for (const [label, extra, reason] of cases) {
      it(`${label} is unanalyzable`, async () => {
        const row = actionRow(ACTION_A, extra);
        for (const [key, value] of Object.entries(extra)) {
          if (value === undefined) delete row[key];
        }
        const { reader, result } = lookup({
          sys_ui_action: answered([row]),
          sys_script: answered([]),
        });
        const out = await result;
        assert.deepEqual(out.actions, []);
        assert.deepEqual(refusedIds(out), [ACTION_A.sysId]);
        assert.match(out.unanalyzable[0].reason, reason);
        // Nothing bound, so the Business Rule read is not even sent.
        assert.deepEqual(
          reader.requests.map((r) => r.table),
          ["sys_ui_action"],
        );
      });
    }

    it("an action the scope read did not return is unanalyzable", async () => {
      const { result } = lookup(
        {
          sys_ui_action: answered([actionRow(ACTION_A)]),
          sys_script: answered([]),
        },
        [ACTION_A, ACTION_B],
      );
      const out = await result;
      assert.deepEqual(
        out.actions.map((a) => a.action.sysId),
        [ACTION_A.sysId],
      );
      assert.deepEqual(refusedIds(out), [ACTION_B.sysId]);
      assert.match(
        out.unanalyzable[0].reason,
        /was not among the sys_ui_action rows/,
      );
    });
  });

  describe("read refusals (ACL / truncation) refuse every subject", () => {
    it("a refused sys_ui_action read (403, ACL) refuses all, with a warning", async () => {
      const { reader, result } = lookup(
        {
          sys_ui_action: undecidable("read refused (403)"),
          sys_script: answered([]),
        },
        [ACTION_A, ACTION_B],
      );
      const out = await result;
      assert.deepEqual(out.actions, []);
      assert.deepEqual(
        refusedIds(out).sort(),
        [ACTION_A.sysId, ACTION_B.sysId].sort(),
      );
      assert.match(
        out.unanalyzable[0].reason,
        /sys_ui_action could not be read: read refused \(403\)/,
      );
      assert.equal(levels(out.notes, "warning").length, 1);
      assert.deepEqual(
        reader.requests.map((r) => r.table),
        ["sys_ui_action"],
      );
    });

    it("a truncated sys_ui_action read refuses all", async () => {
      const { result } = lookup({
        sys_ui_action: truncated([actionRow(ACTION_A)]),
        sys_script: answered([]),
      });
      const out = await result;
      assert.deepEqual(out.actions, []);
      assert.deepEqual(refusedIds(out), [ACTION_A.sysId]);
      assert.equal(levels(out.notes, "warning").length, 1);
    });

    it("a refused sys_script read refuses every bound action", async () => {
      const { result } = lookup({
        sys_ui_action: answered([actionRow(ACTION_A)]),
        sys_script: undecidable("read refused (403)"),
      });
      const out = await result;
      assert.deepEqual(out.actions, []);
      assert.deepEqual(out.rules, []);
      assert.deepEqual(refusedIds(out), [ACTION_A.sysId]);
      assert.match(out.unanalyzable[0].reason, /sys_script could not be read/);
      assert.equal(levels(out.notes, "warning").length, 1);
    });

    it("a truncated sys_script read refuses every bound action", async () => {
      const { result } = lookup({
        sys_ui_action: answered([actionRow(ACTION_A)]),
        sys_script: truncated([ruleRow(RULE_ON_INCIDENT, "incident")]),
      });
      const out = await result;
      assert.deepEqual(out.actions, []);
      assert.deepEqual(out.rules, []);
      assert.deepEqual(refusedIds(out), [ACTION_A.sysId]);
    });

    for (const [label, bad] of [
      [
        "a rule row with no sys_id",
        { sys_name: "anon", collection: "incident" },
      ],
      [
        "a rule row with an unreadable collection",
        { sys_id: sysId("f0f0"), sys_name: "x" },
      ],
    ]) {
      it(`${label} (it may be on the action's table) refuses every bound action`, async () => {
        const { result } = lookup({
          sys_ui_action: answered([actionRow(ACTION_A)]),
          sys_script: answered([ruleRow(RULE_ON_INCIDENT, "incident"), bad]),
        });
        const out = await result;
        assert.deepEqual(out.actions, []);
        assert.deepEqual(out.rules, []);
        assert.deepEqual(refusedIds(out), [ACTION_A.sysId]);
        assert.equal(levels(out.notes, "warning").length, 1);
      });
    }

    it("per-action refusals are kept alongside a later whole-read refusal", async () => {
      const { result } = lookup(
        {
          sys_ui_action: answered([
            actionRow(ACTION_A),
            actionRow(ACTION_B, { client: "true" }),
          ]),
          sys_script: undecidable("read refused (403)"),
        },
        [ACTION_A, ACTION_B],
      );
      const out = await result;
      assert.deepEqual(
        refusedIds(out).sort(),
        [ACTION_A.sysId, ACTION_B.sysId].sort(),
      );
    });
  });
});

// ── the analyzer ──────────────────────────────────────────────────────────

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

function actionLookupStub(result = {}) {
  const calls = [];
  const fn = (request) => {
    calls.push(request);
    return Promise.resolve({
      actions: [],
      rules: [],
      unanalyzable: [],
      notes: [],
      ...result,
    });
  };
  fn.calls = calls;
  return fn;
}

function analyzerWith({ subjectTables, search, uiActions } = {}) {
  const analyzer = createImpactAnalyzer(scopeReader(), {
    scope: SCOPE_NAME,
    search: search ?? searchStub(),
    ...(uiActions === undefined ? {} : { uiActions }),
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

const BOUND_A = {
  action: ACTION_A,
  table: "incident",
  actionName: "x_acme_recalc",
};

describe("UI Action tracing in the analyzer", () => {
  it("exports sys_ui_action as a supported subject table", () => {
    assert.equal(UI_ACTION_TABLE, "sys_ui_action");
    assert.ok(SUBJECT_TABLES.includes("sys_ui_action"));
  });

  it("by default a UI Action stays unanalyzable and no lookup runs (opt-in)", async () => {
    const uiActions = actionLookupStub({ actions: [BOUND_A] });
    const report = await analyzerWith({ uiActions }).analyze([ACTION_A]);
    assert.equal(uiActions.calls.length, 0);
    assert.equal(report.graph.unanalyzable.length, 1);
    assert.match(
      report.graph.unanalyzable[0].reason,
      /MVP impact analysis traces sys_script_include usage only/,
    );
    assert.deepEqual(report.graph.demanded, []);
    assert.ok(isIncomplete(report));
  });

  it("a bound action searches its action_name and sys_id and edges callers and table rules", async () => {
    const uiActions = actionLookupStub({
      actions: [BOUND_A],
      rules: [{ rule: RULE_ON_INCIDENT, collection: "incident" }],
    });
    const search = searchStub({
      references: [
        reference(CLIENT, "x_acme_recalc", "text"),
        reference(INCLUDE, ACTION_A.sysId, "text"),
        // Its own mention is never a self-loop.
        reference(ACTION_A, "x_acme_recalc", "text"),
      ],
    });
    const report = await analyzerWith({
      subjectTables: WITH_ACTIONS,
      uiActions,
      search,
    }).analyze([ACTION_A]);

    assert.deepEqual(uiActions.calls[0].subjects, [ACTION_A]);
    assert.equal(uiActions.calls[0].scopeSysId, SCOPE_SYS_ID);
    assert.deepEqual(search.calls[0].subjects, [
      { table: "sys_ui_action", sysId: ACTION_A.sysId, name: "x_acme_recalc" },
      { table: "sys_ui_action", sysId: ACTION_A.sysId, name: ACTION_A.sysId },
    ]);
    assert.deepEqual(
      report.graph.edges.map((e) => [
        e.from.sysId,
        e.to.sysId,
        e.via,
        e.confidence,
      ]),
      [
        [ACTION_A.sysId, RULE_ON_INCIDENT.sysId, "table_logic", "medium"],
        [ACTION_A.sysId, CLIENT.sysId, "where_used", "low"],
        [ACTION_A.sysId, INCLUDE.sysId, "where_used", "low"],
      ],
    );
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(
      report.graph.demanded.map((d) => [d.spec.id, d.spec.path, d.kind]),
      [
        [
          `sys_script_include/${INCLUDE.sysId}`,
          `tests/${SCOPE_NAME}/sys_script_include/AmountCalculator/AmountCalculator.unit.ts`,
          "unit",
        ],
        [
          `sys_ui_action/${ACTION_A.sysId}`,
          `tests/${SCOPE_NAME}/sys_ui_action/Recalculate/Recalculate.unit.ts`,
          "unit",
        ],
      ],
    );
  });

  it("an action with no action_name is still searched by sys_id", async () => {
    const uiActions = actionLookupStub({
      actions: [{ action: ACTION_A, table: "incident" }],
    });
    const search = searchStub();
    await analyzerWith({
      subjectTables: WITH_ACTIONS,
      uiActions,
      search,
    }).analyze([ACTION_A]);
    assert.deepEqual(search.calls[0].subjects, [
      { table: "sys_ui_action", sysId: ACTION_A.sysId, name: ACTION_A.sysId },
    ]);
  });

  it("an action the lookup neither bound nor refused is refused by the analyzer", async () => {
    const uiActions = actionLookupStub();
    const search = searchStub();
    const report = await analyzerWith({
      subjectTables: WITH_ACTIONS,
      uiActions,
      search,
    }).analyze([ACTION_A]);
    assert.equal(search.calls.length, 0);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [ACTION_A.sysId],
    );
    assert.match(
      report.graph.unanalyzable[0].reason,
      /UI action lookup returned nothing/,
    );
    assert.ok(isIncomplete(report));
  });

  it("a refused action is carried through and not traced", async () => {
    const uiActions = actionLookupStub({
      actions: [BOUND_A],
      unanalyzable: [{ artifact: ACTION_A, reason: "client-side" }],
    });
    const report = await analyzerWith({
      subjectTables: WITH_ACTIONS,
      uiActions,
    }).analyze([ACTION_A]);
    assert.deepEqual(report.graph.edges, []);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.reason),
      ["client-side"],
    );
    assert.ok(isIncomplete(report));
  });

  it("an incomplete search makes every bound action unanalyzable", async () => {
    const uiActions = actionLookupStub({ actions: [BOUND_A] });
    const search = searchStub({
      incomplete: true,
      notes: [
        { level: "warning", message: "sys_script_client could not be read" },
      ],
    });
    const report = await analyzerWith({
      subjectTables: WITH_ACTIONS,
      uiActions,
      search,
    }).analyze([ACTION_A]);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [ACTION_A.sysId],
    );
    assert.match(
      report.graph.unanalyzable[0].reason,
      /scripts invoking UI action `Recalculate`.*sys_script_client could not be read/,
    );
    assert.ok(isIncomplete(report));
  });

  it("a Business Rule stays unanalyzable when only UI Actions are enabled", async () => {
    const uiActions = actionLookupStub({ actions: [BOUND_A] });
    const report = await analyzerWith({
      subjectTables: WITH_ACTIONS,
      uiActions,
    }).analyze([ACTION_A, RULE_ON_INCIDENT]);
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [RULE_ON_INCIDENT.sysId],
    );
    assert.match(
      report.graph.unanalyzable[0].reason,
      /traces sys_script_include and sys_ui_action only/,
    );
  });
});

// ── end to end ────────────────────────────────────────────────────────────

describe("end to end over the live UI action lookup and the live where-used search", () => {
  function liveReader(extra = {}) {
    return readerFrom({
      sys_scope: answered([SCOPE_ROW]),
      sys_ui_action: answered([
        actionRow(ACTION_A, {
          script: "current.state = 2;\ncurrent.update();",
        }),
      ]),
      sys_script: answered([
        {
          ...ruleRow(RULE_ON_INCIDENT, "incident"),
          script:
            "(function executeRule(current, previous) {})(current, previous);",
        },
      ]),
      sys_script_client: answered([
        {
          sys_id: CLIENT.sysId,
          sys_name: CLIENT.name,
          script: "gsftSubmit(null, g_form.getFormElement(), 'x_acme_recalc');",
        },
      ]),
      ...extra,
    });
  }

  function analyze(reader, subjectTables = WITH_ACTIONS) {
    return createImpactAnalyzer(reader, {
      scope: SCOPE_NAME,
      // `null` asks for the analyzer's own default (no `subjectTables`).
      ...(subjectTables === null ? {} : { subjectTables }),
    }).analyzeWithReport(ctx(), [{ ref: ACTION_A, resolvedBy: "scope" }]);
  }

  it("a server-side UI Action reaches a clean graph with a demanded spec", async () => {
    const report = await analyze(liveReader());
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(
      report.graph.edges.map((e) => [e.from.sysId, e.to.sysId, e.via]),
      [
        [ACTION_A.sysId, RULE_ON_INCIDENT.sysId, "table_logic"],
        [ACTION_A.sysId, CLIENT.sysId, "where_used"],
      ],
    );
    assert.deepEqual(
      report.graph.demanded.map((d) => d.spec.id),
      [`sys_ui_action/${ACTION_A.sysId}`],
    );
  });

  it("the same action is INCONCLUSIVE-shaped under the default options", async () => {
    const report = await analyze(liveReader(), null);
    assert.equal(report.graph.unanalyzable.length, 1);
    assert.ok(isIncomplete(report));
  });

  it("a client-side UI Action stays INCONCLUSIVE-shaped", async () => {
    const report = await analyze(
      liveReader({
        sys_ui_action: answered([actionRow(ACTION_A, { client: "true" })]),
      }),
    );
    assert.deepEqual(
      report.graph.unanalyzable.map((u) => u.artifact.sysId),
      [ACTION_A.sysId],
    );
    assert.ok(isIncomplete(report));
  });

  it("an ACL-refused sys_ui_action read stays INCONCLUSIVE-shaped", async () => {
    const report = await analyze(
      liveReader({ sys_ui_action: undecidable("read refused (403)") }),
    );
    assert.ok(
      report.graph.unanalyzable.some(
        (u) => u.artifact.sysId === ACTION_A.sysId,
      ),
    );
    assert.ok(isIncomplete(report));
  });

  it("an ACL-refused sys_script read stays INCONCLUSIVE-shaped", async () => {
    const report = await analyze(
      liveReader({ sys_script: undecidable("read refused (403)") }),
    );
    assert.ok(
      report.graph.unanalyzable.some(
        (u) => u.artifact.sysId === ACTION_A.sysId,
      ),
    );
    assert.ok(isIncomplete(report));
  });
});
