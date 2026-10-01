// `createCliImpactAnalyzer` — the one place every CLI entry point composes the
// impact analyzer (wave 14). The wire-level behaviour (GO, NO_GO/missing,
// INCONCLUSIVE, exit 3) is pinned in `liveImpactIncomplete.test.js` and
// `impact.test.js`; this suite pins the composition's own guards.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  STANDALONE_SCRIPT_LOOKUP_TABLES,
  STANDALONE_SCRIPT_TABLES,
  SUBJECT_TABLES,
  isIncomplete,
} from "@tessera/impact";
import { ResolutionFaultError } from "@tessera/resolvers";

import {
  DEFAULT_CLI_SUBJECT_TABLES,
  createCliImpactAnalyzer,
} from "../build/impactComposition.js";
import {
  LIVE_ARTIFACT_TABLES,
  LIVE_LOOKUP_TABLES,
  createClassifyingReader,
} from "../build/liveArtifactTables.js";

/** A reader that must never be read: construction alone is under test. */
function reader(profile) {
  const refuse = () => {
    throw new Error("read during construction");
  };
  return { profile, queryRecords: refuse, getRecord: refuse };
}

describe("createCliImpactAnalyzer", () => {
  it("traces Business Rules by default", () => {
    // Listed explicitly (wave 15): a table impact learns to trace next is a
    // CLI decision, not an inherited one. Wave 16 adds the three standalone
    // script tables (scheduled jobs, Scripted REST operations, transform
    // scripts) — deliberately, see `impactComposition.ts`.
    assert.deepEqual(
      [...DEFAULT_CLI_SUBJECT_TABLES],
      [
        "sys_script_include",
        "sys_script",
        "sys_ui_action",
        "sysauto_script",
        "sys_ws_operation",
        "sys_transform_script",
      ],
    );
    for (const table of DEFAULT_CLI_SUBJECT_TABLES) {
      assert.ok(SUBJECT_TABLES.includes(table), table);
    }
  });

  it("refuses a rule reader bound to another profile (ARCH-19)", () => {
    assert.throws(
      () =>
        createCliImpactAnalyzer(reader("source"), {
          scope: "x_demo",
          ruleReader: reader("target"),
        }),
      /profile "target", not the source profile "source" \(ARCH-19\)/,
    );
  });

  it("needs no rule reader at all when Business Rules are not traced", () => {
    const analyzer = createCliImpactAnalyzer(reader("source"), {
      scope: "x_demo",
      subjectTables: ["sys_script_include"],
      ruleReader: reader("target"),
    });
    assert.equal(typeof analyzer.analyze, "function");
  });
});

// ── UI Actions (wave 15) ────────────────────────────────────────────────────
//
// The CLI traces server-side `sys_ui_action` subjects by default, through a
// classifying reader, exactly as it traces Business Rules. These cases drive
// the composed analyzer over a canned reader: the edges it draws, what a
// refused or faulted lookup read does, and which reader the lookup reads.

const hex = (prefix) => prefix.padEnd(32, "0");
const SCOPE_NAME = "x_demo";
const SCOPE_ID = hex("5c0be");
const ACTION = {
  table: "sys_ui_action",
  sysId: hex("a1a1"),
  name: "Recalculate",
};
const RULE = { table: "sys_script", sysId: hex("e1e1"), name: "Incident rule" };
const CLIENT = {
  table: "sys_script_client",
  sysId: hex("c11e"),
  name: "Submit recalc",
};

function ctx() {
  return {
    runId: "run-cli-ui-action",
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

/** The UI Action lookup's own read: it alone asks for the `client` flag. */
const isActionLookup = (request) =>
  request.table === "sys_ui_action" && request.fields.includes("client");

/**
 * A canned scope: one server-side action on `incident`, one rule on
 * `incident`, one client script invoking the action by name. `actionRead`
 * replaces the answer to the action LOOKUP's read only — the where-used
 * search's own `sys_ui_action` read still answers.
 */
function cannedReader({ profile = "source", actionRead } = {}) {
  const requests = [];
  const canned = {
    sys_scope: answered([
      { sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Demo" },
    ]),
    sys_ui_action: answered([
      {
        sys_id: ACTION.sysId,
        sys_name: ACTION.name,
        table: "incident",
        client: "false",
        action_name: "x_demo_recalc",
        script: "current.state = 2;\ncurrent.update();",
      },
    ]),
    sys_script: answered([
      {
        sys_id: RULE.sysId,
        sys_name: RULE.name,
        collection: "incident",
        script:
          "(function executeRule(current, previous) {})(current, previous);",
      },
    ]),
    sys_script_client: answered([
      {
        sys_id: CLIENT.sysId,
        sys_name: CLIENT.name,
        script: "gsftSubmit(null, g_form.getFormElement(), 'x_demo_recalc');",
      },
    ]),
  };
  return {
    profile,
    requests,
    queryRecords(request) {
      requests.push({ table: request.table, fields: [...request.fields] });
      if (actionRead !== undefined && isActionLookup(request)) {
        return Promise.resolve(actionRead);
      }
      return Promise.resolve(canned[request.table] ?? answered([]));
    },
  };
}

function analyzeAction(analyzer) {
  return analyzer.analyzeWithReport(ctx(), [
    { ref: ACTION, resolvedBy: "scope" },
  ]);
}

describe("createCliImpactAnalyzer — UI Actions", () => {
  it("traces UI Actions by default", () => {
    assert.ok(DEFAULT_CLI_SUBJECT_TABLES.includes("sys_ui_action"));
  });

  it("draws the action's table_logic and where_used edges through the default composition", async () => {
    const source = cannedReader();
    const report = await analyzeAction(
      createCliImpactAnalyzer(source, { scope: SCOPE_NAME }),
    );
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(
      report.graph.edges.map((edge) => [edge.to.sysId, edge.via]),
      [
        [RULE.sysId, "table_logic"],
        [CLIENT.sysId, "where_used"],
      ],
    );
    assert.deepEqual(
      report.graph.demanded.map((entry) => entry.spec.id),
      // The rule the action reaches is a traced subject table in the CLI too
      // (wave 14), so its own spec is demanded beside the action's.
      [`sys_script/${RULE.sysId}`, `sys_ui_action/${ACTION.sysId}`],
    );
    assert.ok(source.requests.some(isActionLookup));
  });

  it("a refused sys_ui_action lookup read is unanalyzable and recorded as a lookup refusal — never a clean graph", async () => {
    const source = cannedReader({
      actionRead: {
        outcome: "undecidable",
        records: [],
        truncated: false,
        detail: "sys_ui_action: read refused (403) — Insufficient rights",
      },
    });
    const classifying = createClassifyingReader(source);
    const report = await analyzeAction(
      createCliImpactAnalyzer(source, {
        scope: SCOPE_NAME,
        actionReader: classifying.forLookup(),
      }),
    );
    assert.deepEqual(
      report.graph.unanalyzable.map((entry) => entry.artifact.sysId),
      [ACTION.sysId],
    );
    assert.ok(isIncomplete(report));
    assert.deepEqual(
      classifying.refused().map((entry) => [entry.table, entry.read]),
      [["sys_ui_action", "lookup"]],
    );
  });

  it("a transport fault on the default action lookup read is thrown as a fault", async () => {
    const source = cannedReader({
      actionRead: {
        outcome: "undecidable",
        records: [],
        truncated: false,
        detail: "sys_ui_action: HTTP 500",
      },
    });
    await assert.rejects(
      analyzeAction(createCliImpactAnalyzer(source, { scope: SCOPE_NAME })),
      (error) =>
        error instanceof ResolutionFaultError &&
        /sys_ui_action could not be read by the impact lookup/.test(
          error.message,
        ),
    );
  });

  it("a truncated action lookup read through the default composition is not a clean graph", async () => {
    const source = cannedReader({
      actionRead: {
        ...answered([]),
        truncated: true,
        total: 5,
        truncationReason: "cap",
      },
    });
    const report = await analyzeAction(
      createCliImpactAnalyzer(source, { scope: SCOPE_NAME }),
    );
    assert.ok(isIncomplete(report));
  });

  it("honours an actionReader override for the lookup reads", async () => {
    const source = cannedReader();
    const override = cannedReader();
    const report = await analyzeAction(
      createCliImpactAnalyzer(source, {
        scope: SCOPE_NAME,
        actionReader: override,
      }),
    );
    assert.equal(isIncomplete(report), false);
    assert.ok(override.requests.some(isActionLookup));
    assert.ok(!source.requests.some(isActionLookup));
  });

  it("refuses an action reader bound to another profile (ARCH-19)", () => {
    assert.throws(
      () =>
        createCliImpactAnalyzer(reader("source"), {
          scope: SCOPE_NAME,
          actionReader: reader("target"),
        }),
      /UI action reader is bound to profile "target", not the source profile "source" \(ARCH-19\)/,
    );
  });

  it("creates no action reader when UI Actions are not traced", async () => {
    const unused = cannedReader({ profile: "target" });
    // Another profile would throw if it were bound at all.
    const analyzer = createCliImpactAnalyzer(cannedReader(), {
      scope: SCOPE_NAME,
      subjectTables: ["sys_script_include", "sys_script"],
      actionReader: unused,
    });
    const report = await analyzeAction(analyzer);
    assert.deepEqual(unused.requests, []);
    // Not traced: the action subject stays unanalyzable, never GO-shaped.
    assert.ok(isIncomplete(report));
  });

  it("still traces UI Actions when Business Rules are not traced", async () => {
    const source = cannedReader();
    const override = cannedReader();
    const report = await analyzeAction(
      createCliImpactAnalyzer(source, {
        scope: SCOPE_NAME,
        subjectTables: ["sys_script_include", "sys_ui_action"],
        ruleReader: reader("target"),
        actionReader: override,
      }),
    );
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    // The CLI's own action lookup is composed — not impact's default over
    // the plain source reader.
    assert.ok(override.requests.some(isActionLookup));
    assert.ok(!source.requests.some(isActionLookup));
  });
});

// ── Standalone scripts (wave 16) ────────────────────────────────────────────
//
// The CLI traces scheduled jobs, Scripted REST operations and transform
// scripts by default: the standalone-script lookup reads the subject's own row
// and the scope's Script Includes, and draws a `where_used` edge from each
// include the body calls TO the script. The lookup reads through a classifying
// reader watching `STANDALONE_SCRIPT_LOOKUP_TABLES`: the three script tables,
// `sys_script_include` and (wave 17) a transform script's `sys_transform_map`
// and target-table `sys_script` rules.

const JOB = {
  table: "sysauto_script",
  sysId: hex("70b1"),
  name: "Nightly recalc",
};
const INCLUDE = {
  table: "sys_script_include",
  sysId: hex("51a1"),
  name: "RecalcUtil",
};

/**
 * The script lookup's own `sys_script_include` read: it alone asks for the
 * include's `name` (the where-used search reads `script`).
 */
const isIncludeLookup = (request) =>
  request.table === "sys_script_include" &&
  request.fields.includes("name") &&
  !request.fields.includes("script");

/**
 * A canned scope: one scheduled job whose body calls one Script Include.
 * `includeRead` replaces the answer to the script LOOKUP's include read only;
 * `jobRead` replaces every `sysauto_script` read.
 */
function scriptReader({ profile = "source", includeRead, jobRead } = {}) {
  const requests = [];
  const canned = {
    sys_scope: answered([
      { sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Demo" },
    ]),
    sysauto_script: answered([
      {
        sys_id: JOB.sysId,
        sys_name: JOB.name,
        script: "new RecalcUtil().run();",
      },
    ]),
    sys_script_include: answered([
      {
        sys_id: INCLUDE.sysId,
        sys_name: INCLUDE.name,
        name: INCLUDE.name,
        script: "var RecalcUtil = Class.create();",
      },
    ]),
  };
  return {
    profile,
    requests,
    queryRecords(request) {
      requests.push({ table: request.table, fields: [...request.fields] });
      if (includeRead !== undefined && isIncludeLookup(request)) {
        return Promise.resolve(includeRead);
      }
      if (jobRead !== undefined && request.table === "sysauto_script") {
        return Promise.resolve(jobRead);
      }
      return Promise.resolve(canned[request.table] ?? answered([]));
    },
  };
}

function analyzeJob(analyzer) {
  return analyzer.analyzeWithReport(ctx(), [{ ref: JOB, resolvedBy: "scope" }]);
}

const REFUSED_403 = (table) => ({
  outcome: "undecidable",
  records: [],
  truncated: false,
  detail: `${table}: read refused (403) — Insufficient rights`,
});

describe("createCliImpactAnalyzer — standalone scripts", () => {
  it("traces every standalone script table by default", () => {
    for (const table of STANDALONE_SCRIPT_TABLES) {
      assert.ok(DEFAULT_CLI_SUBJECT_TABLES.includes(table), table);
    }
  });

  it("binds a scheduled script through the default composition and draws the include→script edge", async () => {
    const source = scriptReader();
    const report = await analyzeJob(
      createCliImpactAnalyzer(source, { scope: SCOPE_NAME }),
    );
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(
      report.graph.edges.map((edge) => [
        edge.from.sysId,
        edge.to.sysId,
        edge.via,
      ]),
      [[INCLUDE.sysId, JOB.sysId, "where_used"]],
    );
    assert.ok(
      report.graph.demanded.some(
        (entry) => entry.spec.id === `sysauto_script/${JOB.sysId}`,
      ),
      JSON.stringify(report.graph.demanded),
    );
    assert.ok(source.requests.some(isIncludeLookup));
  });

  it("a refused include lookup read through the default composition is unanalyzable — never a clean graph", async () => {
    const source = scriptReader({
      includeRead: REFUSED_403("sys_script_include"),
    });
    const report = await analyzeJob(
      createCliImpactAnalyzer(source, { scope: SCOPE_NAME }),
    );
    assert.deepEqual(
      report.graph.unanalyzable.map((entry) => entry.artifact.sysId),
      [JOB.sysId],
    );
    assert.match(
      report.graph.unanalyzable[0].reason,
      /the Script Includes this sysauto_script script calls could not be established/,
    );
    assert.ok(isIncomplete(report));
    assert.deepEqual(report.graph.edges, []);
  });

  it("a refused sysauto_script lookup read is unanalyzable and recorded as a lookup refusal", async () => {
    const source = scriptReader();
    const classifying = createClassifyingReader(
      scriptReader({ jobRead: REFUSED_403("sysauto_script") }),
    );
    const report = await analyzeJob(
      createCliImpactAnalyzer(source, {
        scope: SCOPE_NAME,
        scriptReader: classifying.forLookup(),
      }),
    );
    assert.deepEqual(
      report.graph.unanalyzable.map((entry) => entry.artifact.sysId),
      [JOB.sysId],
    );
    assert.ok(isIncomplete(report));
    assert.deepEqual(
      classifying.refused().map((entry) => [entry.table, entry.read]),
      [["sysauto_script", "lookup"]],
    );
  });

  it("a refused include lookup read through a classifying scriptReader is recorded as a lookup refusal of sys_script_include", async () => {
    const lookupSource = scriptReader({
      includeRead: REFUSED_403("sys_script_include"),
    });
    const classifying = createClassifyingReader(lookupSource);
    const report = await analyzeJob(
      createCliImpactAnalyzer(scriptReader(), {
        scope: SCOPE_NAME,
        scriptReader: classifying.forLookup(),
      }),
    );
    assert.ok(isIncomplete(report));
    assert.deepEqual(
      classifying.refused().map((entry) => [entry.table, entry.read]),
      [["sys_script_include", "lookup"]],
    );
  });

  it("a transport fault on the default include lookup read is thrown as a fault", async () => {
    // The default classifying reader watches `sys_script_include` as well as
    // the three script tables; were it not watched, this 500 would be
    // softened into an unanalyzable script instead of exit 3.
    const source = scriptReader({
      includeRead: {
        outcome: "undecidable",
        records: [],
        truncated: false,
        detail: "sys_script_include: HTTP 500",
      },
    });
    await assert.rejects(
      analyzeJob(createCliImpactAnalyzer(source, { scope: SCOPE_NAME })),
      (error) =>
        error instanceof ResolutionFaultError &&
        /sys_script_include could not be read by the impact lookup/.test(
          error.message,
        ),
    );
  });

  it("a transport fault on the default sysauto_script lookup read is thrown as a fault", async () => {
    const source = scriptReader({
      jobRead: {
        outcome: "undecidable",
        records: [],
        truncated: false,
        detail: "sysauto_script: HTTP 503",
      },
    });
    await assert.rejects(
      analyzeJob(createCliImpactAnalyzer(source, { scope: SCOPE_NAME })),
      (error) =>
        error instanceof ResolutionFaultError &&
        /sysauto_script could not be read by the impact lookup/.test(
          error.message,
        ),
    );
  });

  it("honours a scriptReader override for the lookup reads", async () => {
    const source = scriptReader();
    const override = scriptReader();
    const report = await analyzeJob(
      createCliImpactAnalyzer(source, {
        scope: SCOPE_NAME,
        scriptReader: override,
      }),
    );
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.ok(override.requests.some(isIncludeLookup));
    assert.ok(!source.requests.some(isIncludeLookup));
  });

  it("refuses a script reader bound to another profile (ARCH-19)", () => {
    assert.throws(
      () =>
        createCliImpactAnalyzer(reader("source"), {
          scope: SCOPE_NAME,
          scriptReader: reader("target"),
        }),
      /standalone script reader is bound to profile "target", not the source profile "source" \(ARCH-19\)/,
    );
  });

  it("creates no script reader when no standalone script table is traced", async () => {
    const unused = scriptReader({ profile: "target" });
    // Another profile would throw if it were bound at all.
    const analyzer = createCliImpactAnalyzer(scriptReader(), {
      scope: SCOPE_NAME,
      subjectTables: ["sys_script_include", "sys_script", "sys_ui_action"],
      scriptReader: unused,
    });
    const report = await analyzeJob(analyzer);
    assert.deepEqual(unused.requests, []);
    // Not traced: the script subject stays unanalyzable, never GO-shaped.
    assert.ok(isIncomplete(report));
  });

  it("traces standalone scripts alone, through the CLI's own lookup", async () => {
    const source = scriptReader();
    const override = scriptReader();
    const report = await analyzeJob(
      createCliImpactAnalyzer(source, {
        scope: SCOPE_NAME,
        subjectTables: ["sys_script_include", "sysauto_script"],
        ruleReader: reader("target"),
        actionReader: reader("target"),
        scriptReader: override,
      }),
    );
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.ok(override.requests.some(isIncludeLookup));
    assert.ok(!source.requests.some(isIncludeLookup));
  });
});

// ── Transform scripts' target tables (wave 17) ──────────────────────────────
//
// A transform script runs as a map writes its target table, so the lookup
// also reads the script's `sys_transform_map` (for `target_table`) and the
// `sys_script` rules on that table. The CLI's default classifying reader
// watches every table the lookup reads — `STANDALONE_SCRIPT_LOOKUP_TABLES` —
// so a fault on the map or rule hop is a fault (exit 3), not a softened
// unanalyzable script, and a refusal is recorded as a lookup refusal.

const TRANSFORM = {
  table: "sys_transform_script",
  sysId: hex("7a75"),
  name: "onBefore amounts",
};
const MAP_ID = hex("3a9");
const TARGET_TABLE = "x_demo_amount";
const TARGET_RULE = {
  table: "sys_script",
  sysId: hex("7a6e7"),
  name: "Amount before insert",
};
const OTHER_TABLE_RULE = {
  table: "sys_script",
  sysId: hex("07e7"),
  name: "Incident rule",
};

/**
 * A canned scope: one transform script (calling one Script Include) on a map
 * whose target table carries one Business Rule. `reads[table]` replaces every
 * read of that table.
 */
function transformReader({ profile = "source", reads = {} } = {}) {
  const requests = [];
  const canned = {
    sys_scope: answered([
      { sys_id: SCOPE_ID, scope: SCOPE_NAME, name: "Demo" },
    ]),
    sys_transform_script: answered([
      {
        sys_id: TRANSFORM.sysId,
        sys_name: TRANSFORM.name,
        script: "new RecalcUtil().run(source);",
        map: MAP_ID,
      },
    ]),
    sys_transform_map: answered([
      { sys_id: MAP_ID, target_table: TARGET_TABLE },
    ]),
    sys_script: answered([
      {
        sys_id: TARGET_RULE.sysId,
        sys_name: TARGET_RULE.name,
        collection: TARGET_TABLE,
        script: "",
      },
      {
        sys_id: OTHER_TABLE_RULE.sysId,
        sys_name: OTHER_TABLE_RULE.name,
        collection: "incident",
        script: "",
      },
    ]),
    sys_script_include: answered([
      {
        sys_id: INCLUDE.sysId,
        sys_name: INCLUDE.name,
        name: INCLUDE.name,
        script: "var RecalcUtil = Class.create();",
      },
    ]),
  };
  return {
    profile,
    requests,
    queryRecords(request) {
      requests.push({ table: request.table, fields: [...request.fields] });
      return Promise.resolve(
        reads[request.table] ?? canned[request.table] ?? answered([]),
      );
    },
  };
}

function analyzeTransform(analyzer) {
  return analyzer.analyzeWithReport(ctx(), [
    { ref: TRANSFORM, resolvedBy: "scope" },
  ]);
}

const TRANSPORT_FAULT = (table) => ({
  outcome: "undecidable",
  records: [],
  truncated: false,
  detail: `${table}: HTTP 500`,
});

describe("createCliImpactAnalyzer — transform scripts' target tables (wave 17)", () => {
  it("traces a transform script through the default composition to its target table's rules", async () => {
    const source = transformReader();
    const report = await analyzeTransform(
      createCliImpactAnalyzer(source, { scope: SCOPE_NAME }),
    );
    assert.deepEqual(report.graph.unanalyzable, []);
    assert.equal(isIncomplete(report), false, JSON.stringify(report.notes));
    assert.deepEqual(
      report.graph.edges.map((edge) => [
        edge.from.sysId,
        edge.to.sysId,
        edge.via,
      ]),
      [
        [INCLUDE.sysId, TRANSFORM.sysId, "where_used"],
        [TRANSFORM.sysId, TARGET_RULE.sysId, "table_logic"],
      ],
    );
    assert.ok(
      report.graph.demanded.some(
        (entry) => entry.spec.id === `sys_transform_script/${TRANSFORM.sysId}`,
      ),
      JSON.stringify(report.graph.demanded),
    );
    assert.ok(source.requests.some((r) => r.table === "sys_transform_map"));
  });

  for (const table of ["sys_transform_map", "sys_script"]) {
    it(`a transport fault on the default ${table} lookup read is thrown as a fault`, async () => {
      // Were the transform hop not watched, this 500 would be softened into
      // an unanalyzable transform script (exit 5) instead of exit 3.
      const source = transformReader({
        reads: { [table]: TRANSPORT_FAULT(table) },
      });
      await assert.rejects(
        analyzeTransform(
          createCliImpactAnalyzer(source, { scope: SCOPE_NAME }),
        ),
        (error) =>
          error instanceof ResolutionFaultError &&
          new RegExp(`${table} could not be read by the impact lookup`).test(
            error.message,
          ),
      );
    });
  }

  it("a refused sys_transform_map lookup read through the default composition is unanalyzable — never a clean graph", async () => {
    const source = transformReader({
      reads: { sys_transform_map: REFUSED_403("sys_transform_map") },
    });
    const report = await analyzeTransform(
      createCliImpactAnalyzer(source, { scope: SCOPE_NAME }),
    );
    assert.deepEqual(
      report.graph.unanalyzable.map((entry) => entry.artifact.sysId),
      [TRANSFORM.sysId],
    );
    assert.match(
      report.graph.unanalyzable[0].reason,
      /sys_transform_map could not be read/,
    );
    assert.ok(isIncomplete(report));
    assert.ok(
      !report.graph.edges.some((edge) => edge.via === "table_logic"),
      JSON.stringify(report.graph.edges),
    );
  });

  it("a refused sys_transform_map lookup read through the live lookup view is recorded as a lookup refusal", async () => {
    const classifying = createClassifyingReader(
      transformReader({
        reads: { sys_transform_map: REFUSED_403("sys_transform_map") },
      }),
      LIVE_LOOKUP_TABLES,
    );
    const report = await analyzeTransform(
      createCliImpactAnalyzer(transformReader(), {
        scope: SCOPE_NAME,
        scriptReader: classifying.forLookup(),
      }),
    );
    assert.ok(isIncomplete(report));
    assert.deepEqual(
      classifying.refused().map((entry) => [entry.table, entry.read]),
      [["sys_transform_map", "lookup"]],
    );
  });

  it("the live lookup view watches every table the standalone-script lookup reads", () => {
    for (const table of STANDALONE_SCRIPT_LOOKUP_TABLES) {
      assert.ok(LIVE_LOOKUP_TABLES.includes(table), table);
    }
    for (const table of LIVE_ARTIFACT_TABLES) {
      assert.ok(LIVE_LOOKUP_TABLES.includes(table), table);
    }
    assert.ok(Object.isFrozen(LIVE_LOOKUP_TABLES));
  });
});
