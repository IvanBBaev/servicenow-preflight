// The where-used reader — PLAN Phase 3, DESIGN §12.3 row 3.
//
// Everything here runs against a stubbed `RecordReader`, because everything
// this file decides is a decision about read OUTCOMES rather than about HTTP:
// which outcome becomes a reference, which becomes a warning, which becomes an
// unanalyzable artifact, and which one is allowed to throw. The live adapter
// (`createSnRecordReader`) turns a 403 into `undecidable` and is covered by the
// resolvers' own suite against a QA-18 fake, so putting an instance in the
// picture here would only add ways for these assertions to pass for the wrong
// reason — and several of them ("this table was never read", "the reads did not
// overlap") are about calls that must NOT happen, which a live fake states far
// less clearly than a stub that counts them.
//
// The scanner is deliberately NOT stubbed: `scanScript` is pure, and a search
// that reports the right consumer with the wrong evidence class is exactly the
// kind of quiet wrongness this package exists to avoid. So the script bodies
// below are real ones, and the assertions name real line numbers.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ResolutionFaultError, ResolutionInputError } from "@tessera/resolvers";
import { scriptsApi, tableApi } from "@tessera/sn-client";

import {
  CONSUMER_TABLES,
  createImpactAnalyzer,
  createWhereUsedSearch,
  isIncomplete,
} from "../build/index.js";

const SCOPE_SYS_ID = "aaaa0000000000000000000000000001";
const SCOPE_LABEL = "x_snc_demo";

/** The artifact whose usage is traced in every test below. */
const SUBJECT = {
  table: "sys_script_include",
  sysId: "bbbb0000000000000000000000000002",
  name: "AmountCalculator",
};

const RULE_SYS_ID = "cccc0000000000000000000000000003";
const POLICY_SYS_ID = "dddd0000000000000000000000000004";
const OTHER_RULE_SYS_ID = "eeee0000000000000000000000000005";

/** One unambiguous call, on line 2, so a line number can be asserted. */
const CALLS_SUBJECT =
  "var g = new GlideRecord('incident');\nnew AmountCalculator().total(g);";

function ctx() {
  return {
    runId: "run-where-used",
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

/**
 * A reader over canned reads keyed by table. Every request is recorded, because
 * half of what this stage promises is about the queries it sends. A table with
 * no canned entry answers with zero rows — "the instance looked and found
 * nothing", never "the read failed"; `fallback` flips that for the tests that
 * need a scope where nothing at all could be read.
 *
 * The in-flight counter is the sequencing assertion: each read yields to the
 * microtask queue before it resolves, so an implementation that fired the whole
 * table list off with `Promise.all` would show a peak of nine here instead of
 * one.
 */
function readerFrom(canned, fallback = answered([])) {
  const requests = [];
  let inFlight = 0;
  let peakInFlight = 0;
  return {
    profile: "source",
    requests,
    get peakInFlight() {
      return peakInFlight;
    },
    async queryRecords(request) {
      requests.push({
        table: request.table,
        query: request.query,
        fields: [...request.fields],
        limit: request.limit,
        fetchAll: request.fetchAll,
        crossCheckCount: request.crossCheckCount,
        signal: request.signal,
      });
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return canned[request.table] ?? fallback;
    },
  };
}

function whereUsed(reader, request = {}, options) {
  return createWhereUsedSearch(
    reader,
    options,
  )({
    ctx: ctx(),
    scopeSysId: SCOPE_SYS_ID,
    scopeLabel: SCOPE_LABEL,
    subjects: [SUBJECT],
    ...request,
  });
}

function messages(result, level) {
  return result.notes
    .filter((note) => level === undefined || note.level === level)
    .map((note) => note.message);
}

describe("the tables that get searched", () => {
  it("derives the consumer tables from the sn-client script registry", () => {
    // Not re-typed: a script type added to `@tessera/sn-client` has to become
    // searchable without a second edit, or the two modules drift into
    // disagreeing about where ServiceNow keeps code — which shows up not as an
    // error but as an edge that quietly stopped being found.
    assert.ok(CONSUMER_TABLES.length > 0);
    for (const descriptor of Object.values(scriptsApi.SCRIPT_TYPES)) {
      const entry = CONSUMER_TABLES.find((t) => t.table === descriptor.table);
      assert.ok(entry, `${descriptor.table} is missing from CONSUMER_TABLES`);
      for (const field of descriptor.scriptFields) {
        assert.ok(entry.scriptFields.includes(field));
      }
    }
  });

  it("unions the columns of a table that has two of them", () => {
    const policy = CONSUMER_TABLES.find((t) => t.table === "sys_ui_policy");
    assert.deepEqual([...policy.scriptFields], ["script_true", "script_false"]);
  });

  it("is sorted by table name, so a CI log can be diffed", () => {
    const names = CONSUMER_TABLES.map((t) => t.table);
    assert.deepEqual(names, [...names].sort());
    // Every entry must carry something to search, or its rows would all report
    // as unreadable.
    assert.ok(CONSUMER_TABLES.every((t) => t.scriptFields.length > 0));
  });
});

describe("the read it asks for", () => {
  it("confines the query to the scope and adds no ORDERBY", async () => {
    const reader = readerFrom({});
    const context = ctx();
    await createWhereUsedSearch(reader)({
      ctx: context,
      scopeSysId: SCOPE_SYS_ID,
      scopeLabel: SCOPE_LABEL,
      subjects: [SUBJECT],
    });

    for (const request of reader.requests) {
      assert.equal(request.query, `sys_scope=${SCOPE_SYS_ID}`);
      // An ORDERBY naming a column one of these tables does not have is an
      // unknown-field rejection — a 400 the reader correctly reports as
      // undecidable, turning a readable table into a hole in the graph. The
      // output is sorted in memory instead.
      assert.ok(!request.query.includes("ORDERBY"));
      assert.equal(request.fetchAll, true);
      assert.equal(request.limit, undefined);
      // Wave 17: every sweep confirms its end with a Stats API count when the
      // instance sends no X-Total-Count.
      assert.equal(request.crossCheckCount, true);
      // ARCH-28: cancellation has to reach the transport, not just the loop.
      assert.equal(request.signal, context.signal);
    }
  });

  it("asks for the identity columns plus that table's script columns", async () => {
    const reader = readerFrom({});
    await whereUsed(reader);

    const policy = reader.requests.find((r) => r.table === "sys_ui_policy");
    // `sys_name` is the derived display column every sys_metadata descendant
    // carries; a per-table `name` would be a guess (sys_transform_script has
    // none) and a wrong guess is a rejected query, not a missing label.
    assert.deepEqual(policy.fields, [
      "sys_id",
      "sys_name",
      "script_true",
      "script_false",
    ]);
    const rule = reader.requests.find((r) => r.table === "sys_script");
    assert.deepEqual(rule.fields, ["sys_id", "sys_name", "script"]);
  });

  it("reads the tables one at a time, in CONSUMER_TABLES order", async () => {
    const reader = readerFrom({});
    await whereUsed(reader);

    assert.deepEqual(
      reader.requests.map((r) => r.table),
      CONSUMER_TABLES.map((t) => t.table),
    );
    // Reproducible note order for a diffable log, and a courtesy to an
    // instance that is very likely production.
    assert.equal(reader.peakInFlight, 1);
  });

  it("refuses a request that names no scope, before reading anything", async () => {
    // `sys_scope=` is not "every scope" — it is a query for rows belonging to
    // no application, which would answer cleanly and mean nothing.
    const reader = readerFrom({});
    await assert.rejects(
      () => whereUsed(reader, { scopeSysId: "  " }),
      ResolutionInputError,
    );
    assert.equal(reader.requests.length, 0);
  });
});

describe("finding a consumer", () => {
  it("reports the row, the column and the line that mention it", async () => {
    const reader = readerFrom({
      sys_script: answered([
        {
          sys_id: RULE_SYS_ID,
          sys_name: "Total on insert",
          script: CALLS_SUBJECT,
        },
      ]),
    });
    const result = await whereUsed(reader);

    assert.equal(result.references.length, 1);
    assert.deepEqual(result.references[0], {
      consumer: {
        table: "sys_script",
        sysId: RULE_SYS_ID,
        name: "Total on insert",
      },
      field: "script",
      match: { name: "AmountCalculator", kind: "call", line: 2 },
    });
    assert.deepEqual(result.unanalyzable, []);
    assert.equal(result.incomplete, false);
    assert.deepEqual(messages(result, "warning"), []);
    // One info note per table that answered, counting what it read and what it
    // contributed.
    assert.equal(messages(result, "info").length, CONSUMER_TABLES.length);
    assert.ok(
      messages(result, "info").some((m) =>
        /sys_script: 1 row\(s\) read, 1 reference\(s\)/.test(m),
      ),
    );
  });

  it("reports both script columns of a UI policy separately", async () => {
    const reader = readerFrom({
      sys_ui_policy: answered([
        {
          sys_id: POLICY_SYS_ID,
          sys_name: "Show total",
          script_true: "new AmountCalculator();",
          script_false: "new AmountCalculator();",
        },
      ]),
    });
    const result = await whereUsed(reader);

    // Two references, not one: the columns run in different circumstances, and
    // a reviewer has to know which of them is affected.
    assert.deepEqual(
      result.references.map((r) => r.field),
      ["script_false", "script_true"],
    );
    assert.ok(
      result.references.every((r) => r.consumer.sysId === POLICY_SYS_ID),
    );
    assert.equal(result.incomplete, false);
  });

  it("never labels a consumer with an empty name", async () => {
    const reader = readerFrom({
      sys_script: answered([
        { sys_id: RULE_SYS_ID, sys_name: "   ", script: CALLS_SUBJECT },
      ]),
    });
    const result = await whereUsed(reader);

    assert.equal(
      result.references[0].consumer.name,
      `sys_script/${RULE_SYS_ID}`,
    );
  });

  it("keeps a Script Include out of its own result set", async () => {
    // Every `Foo` script include contains the word `Foo` in its own definition,
    // so without this the graph would be a list of self-loops with the real
    // consumers buried underneath. This is why the request carries refs rather
    // than bare names.
    const reader = readerFrom({
      sys_script_include: answered([
        {
          sys_id: SUBJECT.sysId,
          sys_name: "AmountCalculator",
          script: "var AmountCalculator = Class.create();",
        },
        {
          sys_id: OTHER_RULE_SYS_ID,
          sys_name: "TaxHelper",
          script: "new AmountCalculator();",
        },
      ]),
    });
    const result = await whereUsed(reader);

    assert.deepEqual(
      result.references.map((r) => r.consumer.sysId),
      [OTHER_RULE_SYS_ID],
    );
  });

  it("reports one subject using another, and only drops the self-mention", async () => {
    // The exclusion is per (row, name), not per row. `tess impact --scope X`
    // makes every Script Include in the scope a subject, so a row-level skip
    // would make include→include edges — the very edges DESIGN §12.3 row 3
    // exists to report — impossible to see, and it would go unnoticed because
    // the result is a clean empty answer rather than an error.
    const helper = {
      table: "sys_script_include",
      sysId: OTHER_RULE_SYS_ID,
      name: "TaxHelper",
    };
    const reader = readerFrom({
      sys_script_include: answered([
        {
          sys_id: SUBJECT.sysId,
          sys_name: "AmountCalculator",
          // Mentions itself AND the other subject: one is dropped, one is not.
          script: "var AmountCalculator = Class.create();\nnew TaxHelper();",
        },
        {
          sys_id: OTHER_RULE_SYS_ID,
          sys_name: "TaxHelper",
          script: "new AmountCalculator();",
        },
      ]),
    });
    const result = await whereUsed(reader, { subjects: [SUBJECT, helper] });

    assert.deepEqual(
      result.references.map((r) => [r.consumer.sysId, r.match.name]),
      [
        [SUBJECT.sysId, "TaxHelper"],
        [OTHER_RULE_SYS_ID, "AmountCalculator"],
      ],
    );
  });

  it("sorts the references the same way on every run", async () => {
    const reader = readerFrom({
      sys_ui_policy: answered([
        {
          sys_id: POLICY_SYS_ID,
          sys_name: "Show total",
          script_true: "new AmountCalculator();",
          script_false: "new AmountCalculator();",
        },
      ]),
      // Seeded out of order, and with two hits in one body, so the sort has
      // something to do on every key.
      sys_script: answered([
        {
          sys_id: OTHER_RULE_SYS_ID,
          sys_name: "Zeta rule",
          script: "new AmountCalculator();",
        },
        {
          sys_id: RULE_SYS_ID,
          sys_name: "Alpha rule",
          script: "new AmountCalculator();\nvar x;\nAmountCalculator.help();",
        },
      ]),
    });
    const result = await whereUsed(reader);

    assert.deepEqual(
      result.references.map((r) => [
        r.consumer.table,
        r.consumer.name,
        r.field,
        r.match.line,
      ]),
      [
        ["sys_script", "Alpha rule", "script", 1],
        ["sys_script", "Alpha rule", "script", 3],
        ["sys_script", "Zeta rule", "script", 1],
        ["sys_ui_policy", "Show total", "script_false", 1],
        ["sys_ui_policy", "Show total", "script_true", 1],
      ],
    );
  });
});

describe("the rows it cannot speak for", () => {
  it("drops a row nobody can address, out loud", async () => {
    const reader = readerFrom({
      sys_script: answered([
        { sys_name: "no identity here", script: CALLS_SUBJECT },
        { sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT },
      ]),
    });
    const result = await whereUsed(reader);

    // An edge has to point AT something, so the row is skipped — but a consumer
    // that was never examined is not a consumer that was cleared.
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].consumer.sysId, RULE_SYS_ID);
    assert.equal(messages(result, "warning").length, 1);
    assert.match(messages(result, "warning")[0], /no readable sys_id/);
    // "Out loud" has to mean out loud on the channel the consumer has.
    // `unanalyzable` cannot hold this row — an entry there needs the sys_id
    // that is missing — and `ImpactAnalyzer.analyze` returns an `ImpactGraph`
    // carrying no notes, so without the flag the shortened edge list is all
    // that reaches it, and a shortened edge list reads as a complete one.
    assert.equal(result.incomplete, true);
  });

  it("raises `incomplete` for anything that shortens the result, on every path that cannot name an artifact", async () => {
    // The property, stated once over every branch that can drop something: if
    // the search saw less of the scope than it was asked to search, and the
    // gap has no `unanalyzable` entry to live in, `incomplete` is the only
    // thing left that a notes-free consumer can read. Asserted as a table so a
    // new branch of this kind is a new row here, not a silent hole.
    const scenarios = [
      [
        "a table that refused",
        readerFrom({ sys_script: undecidable("read refused (403)") }),
        {},
      ],
      [
        "a read stopped at the record cap",
        readerFrom({
          sys_script: answered(
            [{ sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT }],
            { truncated: true, truncationReason: "cap", total: 250 },
          ),
        }),
        {},
      ],
      [
        "a short page under a larger X-Total-Count",
        readerFrom({
          sys_script: answered(
            [{ sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT }],
            { truncated: true, truncationReason: "short-page", total: 40 },
          ),
        }),
        {},
      ],
      [
        "a capped read with no X-Total-Count",
        readerFrom({
          sys_script: answered(
            [{ sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT }],
            { truncated: true, truncationReason: "no-total" },
          ),
        }),
        {},
      ],
      [
        "a truncated read with no reason",
        readerFrom({
          sys_script: answered(
            [{ sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT }],
            { truncated: true },
          ),
        }),
        {},
      ],
      [
        "a row nothing can address",
        readerFrom({
          sys_script: answered([
            { sys_name: "no identity here", script: CALLS_SUBJECT },
          ]),
        }),
        {},
      ],
      ["no consumer tables at all", readerFrom({}), { consumerTables: [] }],
    ];

    for (const [label, reader, options] of scenarios) {
      const result = await whereUsed(reader, {}, options);
      assert.equal(result.incomplete, true, label);
      // And the reason travels: a flag with no sentence beside it sends the
      // reader hunting for what was missed.
      assert.ok(messages(result, "warning").length > 0, label);
    }
  });

  it("leaves `incomplete` false when everything asked for was read", async () => {
    // The mirror. A dynamic-dispatch row and a row with no readable script are
    // both fully accounted for in `unanalyzable`, so raising the flag for them
    // would understate a search that did exactly what it promised.
    const reader = readerFrom({
      sys_script: answered([
        { sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT },
        { sys_id: OTHER_RULE_SYS_ID, sys_name: "Opaque" },
        { sys_id: POLICY_SYS_ID, sys_name: "Eval", script: "gs.include(x);" },
      ]),
    });
    const result = await whereUsed(reader);

    assert.equal(result.unanalyzable.length, 2);
    assert.deepEqual(messages(result, "warning"), []);
    assert.equal(result.incomplete, false);
  });

  it("calls a row whose script column was trimmed away unanalyzable", async () => {
    const reader = readerFrom({
      sys_script: answered([{ sys_id: RULE_SYS_ID, sys_name: "Opaque rule" }]),
    });
    const result = await whereUsed(reader);

    assert.equal(result.unanalyzable.length, 1);
    assert.equal(result.unanalyzable[0].artifact.sysId, RULE_SYS_ID);
    assert.match(result.unanalyzable[0].reason, /script column/);
    assert.deepEqual(result.references, []);
  });

  it("treats an empty script as an answer, not as a hole", async () => {
    // A readable empty column says "this script mentions nothing". Collapsing
    // it into the unreadable case would inflate the QA-15 denominator with
    // artifacts that were, in fact, fully examined.
    const reader = readerFrom({
      sys_script: answered([
        { sys_id: RULE_SYS_ID, sys_name: "Empty rule", script: "" },
      ]),
    });
    const result = await whereUsed(reader);

    assert.deepEqual(result.unanalyzable, []);
    assert.deepEqual(result.references, []);
    assert.equal(result.incomplete, false);
  });

  it("reports dynamic dispatch once per row, even across two columns", async () => {
    const reader = readerFrom({
      sys_ui_policy: answered([
        {
          sys_id: POLICY_SYS_ID,
          sys_name: "Evaluated policy",
          script_true: "var e = new GlideEvaluator();",
          script_false: "new GlideEvaluator();\nnew AmountCalculator();",
        },
      ]),
    });
    const result = await whereUsed(reader);

    // One entry per consumer row: repeating it per column or per marker would
    // fill the verdict with copies of a single fact.
    assert.equal(result.unanalyzable.length, 1);
    assert.equal(result.unanalyzable[0].artifact.sysId, POLICY_SYS_ID);
    assert.match(result.unanalyzable[0].reason, /GlideEvaluator/);
    assert.match(result.unanalyzable[0].reason, /line 1/);
    // It matched AND it is unanalyzable: the matches that were found do not
    // make the rest of its dispatch visible.
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].field, "script_false");
    // Dynamic dispatch has its own channel and never sets `incomplete` — that
    // flag is about reads, not about scripts.
    assert.equal(result.incomplete, false);
  });
});

describe("the tables that did not answer", () => {
  it("keeps the tables that answered when one of them did not", async () => {
    const reader = readerFrom({
      sys_script: undecidable("sys_script on source: read refused (403)"),
      sys_ui_policy: answered([
        {
          sys_id: POLICY_SYS_ID,
          sys_name: "Show total",
          script_true: "new AmountCalculator();",
        },
      ]),
    });
    const result = await whereUsed(reader);

    // The rows another table returned are still true; the hole in them is a
    // warning, not a reason to throw the answer away.
    assert.equal(result.references.length, 1);
    assert.equal(result.references[0].consumer.sysId, POLICY_SYS_ID);
    assert.equal(result.incomplete, true);
    const warnings = messages(result, "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /sys_script could not be searched/);
    // The evidence line travels with the note — DEV-1 wants the cause.
    assert.match(warnings[0], /read refused \(403\)/);
    // Every other table still got read.
    assert.equal(reader.requests.length, CONSUMER_TABLES.length);
  });

  it("does not present a truncated read as the whole scope", async () => {
    const reader = readerFrom({
      sys_script: answered(
        [{ sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT }],
        { truncated: true, truncationReason: "cap", total: 250 },
      ),
    });
    const result = await whereUsed(reader);

    // The rows that did arrive are still processed: a partial answer is worth
    // more than none, as long as it is labelled partial (QA-9).
    assert.equal(result.references.length, 1);
    assert.equal(result.incomplete, true);
    const warnings = messages(result, "warning");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^sys_script search /);
    assert.match(warnings[0], /only part of scope `x_snc_demo` was searched/);
    assert.match(warnings[0], /consumers are missing from this result/);
  });

  // One row per `truncationReason`, plus the reason-less read a stub or an
  // older adapter can hand over. The clause is sn-client's own
  // `describeTruncation`, asserted verbatim so the search cannot drift into a
  // wording of its own; `mustNot` pins the advice that would be wrong for the
  // case (raising SN_MAX_RECORDS does not help a short page).
  const TRUNCATION_CASES = [
    {
      label: "the record cap",
      extra: { truncationReason: "cap", total: 250 },
      must: [/SN_MAX_RECORDS cap \(1 of 250 matching rows read/],
      mustNot: [/came back short/, /no X-Total-Count/],
    },
    {
      label: "a short page (read ACLs)",
      extra: { truncationReason: "short-page", total: 40 },
      must: [
        /came back short: X-Total-Count reports 40 matching rows but only 1 were returned/,
        /read ACLs/,
        /raising SN_MAX_RECORDS will not help/,
      ],
      mustNot: [/hit the SN_MAX_RECORDS cap/, /raise SN_MAX_RECORDS for/],
    },
    {
      label: "the cap with no X-Total-Count",
      extra: { truncationReason: "no-total" },
      must: [/sent no X-Total-Count, so more rows may exist/],
      mustNot: [/came back short/, /hit the SN_MAX_RECORDS cap/],
    },
    {
      label: "no reason at all",
      extra: {},
      must: [/stopped before the full result set \(1 rows read\)/],
      mustNot: [/SN_MAX_RECORDS/, /read ACLs/, /X-Total-Count/],
    },
  ];

  for (const { label, extra, must, mustNot } of TRUNCATION_CASES) {
    it(`names why the read was partial: ${label}`, async () => {
      const read = answered(
        [{ sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT }],
        { truncated: true, ...extra },
      );
      const result = await whereUsed(readerFrom({ sys_script: read }));

      // Fail-closed first: the wording changed, the verdict did not.
      assert.equal(result.incomplete, true);
      assert.equal(result.references.length, 1);
      const warnings = messages(result, "warning");
      assert.equal(warnings.length, 1);
      assert.equal(
        warnings[0],
        `sys_script search ${tableApi.describeTruncation(read)}, so only part of scope \`${SCOPE_LABEL}\` was searched — consumers are missing from this result`,
      );
      for (const pattern of must) assert.match(warnings[0], pattern);
      for (const pattern of mustNot) assert.doesNotMatch(warnings[0], pattern);
    });
  }

  it("carries the reason onto the analyzer's unanalyzable entry and keeps the report incomplete", async () => {
    // The join, end to end: the reason has to survive into what the pipeline
    // actually reads — the graph's `unanalyzable` (no notes there) and the
    // report `isIncomplete` judges, which is what turns GO into INCONCLUSIVE.
    const reader = {
      profile: "source",
      queryRecords(request) {
        if (request.table === "sys_scope") {
          return Promise.resolve(
            answered([
              { sys_id: SCOPE_SYS_ID, scope: SCOPE_LABEL, name: "Demo" },
            ]),
          );
        }
        if (request.table === "sys_script") {
          return Promise.resolve(
            answered([], {
              truncated: true,
              truncationReason: "short-page",
              total: 12,
            }),
          );
        }
        return Promise.resolve(answered([]));
      },
    };
    const analyzer = createImpactAnalyzer(reader, { scope: SCOPE_LABEL });
    const report = await analyzer.analyzeWithReport(ctx(), [
      { ref: SUBJECT, resolvedBy: "scope" },
    ]);

    assert.equal(isIncomplete(report), true);
    const entry = report.graph.unanalyzable.find(
      (u) => u.artifact.sysId === SUBJECT.sysId,
    );
    assert.ok(entry, "the subject is unanalyzable");
    assert.match(entry.reason, /could not be fully traced/);
    assert.match(
      entry.reason,
      /sys_script search came back short: X-Total-Count reports 12 matching rows but only 0 were returned/,
    );
  });

  it("faults when not one table answered", async () => {
    // An empty reference list here is indistinguishable from "nothing uses
    // this", which is exactly the silent green QA-9 forbids. DEV-1: exit 3, an
    // infrastructure fault, never a verdict.
    const reader = readerFrom({}, undecidable("source: 500 from the instance"));

    await assert.rejects(() => whereUsed(reader), {
      name: "ResolutionFaultError",
      message: /500 from the instance/,
    });
    await assert.rejects(() => whereUsed(reader), ResolutionFaultError);
  });

  it("will not answer an empty table list with a clean empty result", async () => {
    const reader = readerFrom({});
    const result = await whereUsed(reader, {}, { consumerTables: [] });

    assert.deepEqual(result.references, []);
    assert.equal(result.incomplete, true);
    assert.match(messages(result, "warning")[0], /no consumer tables/);
    assert.equal(reader.requests.length, 0);
  });

  it("drops a configured table that carries no script column", async () => {
    // Reading it would report every one of its rows as unanalyzable, so a
    // configuration slip would print as a scope full of opaque scripts.
    const reader = readerFrom({});
    const result = await whereUsed(
      reader,
      {},
      { consumerTables: [{ table: "sys_script", scriptFields: ["  "] }] },
    );

    assert.equal(reader.requests.length, 0);
    assert.equal(result.incomplete, true);
    assert.match(messages(result, "warning")[0], /no consumer tables/);
  });

  it("reads a repeated table exactly once", async () => {
    const reader = readerFrom({
      sys_script: answered([
        { sys_id: RULE_SYS_ID, sys_name: "Total", script: CALLS_SUBJECT },
      ]),
    });
    const result = await whereUsed(
      reader,
      {},
      {
        consumerTables: [
          { table: "sys_script", scriptFields: ["script"] },
          { table: "sys_script", scriptFields: ["script"] },
        ],
      },
    );

    // Twice would report the same reference twice, which reads exactly like
    // two genuine consumers.
    assert.equal(reader.requests.length, 1);
    assert.equal(result.references.length, 1);
  });
});
