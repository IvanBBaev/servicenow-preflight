// Wave 17 — the Stats API count cross-check on impact's own reads.
//
// Every `fetchAll` read impact makes decides what gets traced: the nine
// where-used sweeps, and the Business Rule / UI Action / standalone script
// lookups. Each sends `crossCheckCount: true`, so when the instance sends no
// X-Total-Count and the paging otherwise looks complete, `@tessera/sn-client`
// asks the Stats API how many rows match. The case it exists for: a read ACL
// trimmed the LAST window, and without the count the partial sweep came back
// as the whole scope — a consumer silently missing from the graph, and a
// report that said it was complete.
//
// Everything here runs the real transport against the QA-18 fake, because the
// claim is about HTTP: which requests are sent, and which are not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { createSnRecordReader } from "@tessera/resolvers";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import { createImpactAnalyzer, isIncomplete } from "../build/index.js";

const HOST = "dev-impact-crosscheck.service-now.com";
const hex = (prefix) => prefix.padEnd(32, "0");

const SCOPE_SYS_ID = hex("aaaa01");
const SCOPE_NAME = "x_acme_inv";
const TARGET_TABLE = "x_acme_inv_amount";

const INCLUDE = {
  table: "sys_script_include",
  sysId: hex("ca1c"),
  name: "AmountCalculator",
};
const TRANSFORM = {
  table: "sys_transform_script",
  sysId: hex("7a75"),
  name: "Amount import script",
};
const MAP_ID = hex("3a9");
// `ORDERBYsys_id` (the transport's stable paging order) puts RULE_Z last —
// the row a trimmed LAST window hides.
const RULE_A = hex("b1");
const RULE_Z = hex("f9");

const ENV_KEYS = [
  "SN_INSTANCE",
  "SN_USER",
  "SN_PASSWORD",
  "SN_AUTH",
  "SN_DOCS_DIR",
  "SN_READONLY",
  "SN_ACTIVE_PROFILE",
  "SN_ALLOWED_HOSTS",
  "SN_MAX_RETRIES",
  "SN_MAX_RECORDS",
  "SN_TABLES_ALLOW",
  "SN_TABLES_DENY",
  "SN_PROFILE_SOURCE_INSTANCE",
  "SN_PROFILE_SOURCE_USER",
  "SN_PROFILE_SOURCE_PASSWORD",
];

const rule = (sysId, name) => ({
  sys_id: sysId,
  sys_name: name,
  name,
  sys_scope: SCOPE_SYS_ID,
  collection: TARGET_TABLE,
  script: "new AmountCalculator().run(current);",
});

const SEED = {
  sys_scope: [{ sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME, name: "Inventory" }],
  sys_script_include: [
    {
      sys_id: INCLUDE.sysId,
      sys_name: INCLUDE.name,
      name: INCLUDE.name,
      sys_scope: SCOPE_SYS_ID,
      script: "var AmountCalculator = Class.create();",
    },
  ],
  sys_script: [rule(RULE_A, "Rule A"), rule(RULE_Z, "Rule Z")],
  sys_transform_script: [
    {
      sys_id: TRANSFORM.sysId,
      sys_name: TRANSFORM.name,
      sys_scope: SCOPE_SYS_ID,
      map: MAP_ID,
      script: "",
    },
  ],
  sys_transform_map: [
    { sys_id: MAP_ID, sys_scope: SCOPE_SYS_ID, target_table: TARGET_TABLE },
  ],
};

const CTX = {
  runId: "run-impact-crosscheck",
  lifecycle: "ephemeral",
  coverageSource: "atf",
  topology: { source: "dev", runner: "test", target: "test" },
  signal: new AbortController().signal,
};

/** A row-level read ACL hiding exactly the rows `when` picks on `table`. */
const hide = (table, when) => ({ rules: [{ table, when }] });
const HIDE_RULE_Z = hide("sys_script", (row) => row.sys_id === RULE_Z);

function withFake(options = {}) {
  const fake = createFakeInstance({ host: HOST, state: SEED, ...options });
  const restoreFetch = fake.install();
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "tessera-impact-crosscheck");
  // One shot per request, so a single-fire fault is never retried away.
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_SOURCE_INSTANCE = HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  reloadCredentialsFromEnv();
  const reader = createSnRecordReader("source");
  return {
    fake,
    reader,
    statsCalls: () =>
      fake.requests().filter((r) => r.path.startsWith("/api/now/stats/")),
    restore() {
      restoreFetch();
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      reloadCredentialsFromEnv();
    },
  };
}

const warnings = (report) =>
  report.notes
    .filter((note) => note.level === "warning")
    .map((note) => note.message)
    .join("\n");

/** The include alone — the where-used sweeps are the only reads. */
const analyzeInclude = (h) =>
  createImpactAnalyzer(h.reader, { scope: SCOPE_NAME }).analyzeWithReport(CTX, [
    { ref: INCLUDE, resolvedBy: "scope" },
  ]);

/** The transform script — its lookup reads maps and rules as well. */
const analyzeTransform = (h) =>
  createImpactAnalyzer(h.reader, {
    scope: SCOPE_NAME,
    subjectTables: ["sys_script_include", "sys_transform_script"],
  }).analyzeWithReport(CTX, [{ ref: TRANSFORM, resolvedBy: "scope" }]);

const edgeTargets = (report) =>
  report.graph.edges.map((edge) => edge.to.sysId).sort();

describe("a trimmed last window is caught by the count, never GO", () => {
  it("where-used: a hidden last consumer makes the sweep partial", async () => {
    const h = withFake({ omitTotalCount: true, readAcl: HIDE_RULE_Z });
    try {
      const report = await analyzeInclude(h);
      // Rule Z calls the include too; the ACL hid it from the sweep.
      assert.deepEqual(edgeTargets(report), [RULE_A]);
      assert.match(
        warnings(report),
        /sys_script search came back inconsistent: no X-Total-Count, and the Stats API counts 2 matching rows but only 1 were returned/,
      );
      assert.equal(isIncomplete(report), true);
      const stats = h
        .statsCalls()
        .filter((r) => r.path.endsWith("/sys_script"));
      assert.equal(stats.length, 1);
      // ARCH-8 holds: the count is a GET like everything else.
      assert.deepEqual(
        [...new Set(h.fake.requests().map((r) => r.method))],
        ["GET"],
      );
    } finally {
      h.restore();
    }
  });

  it("lookup: a hidden last rule on the target table refuses the transform script", async () => {
    const h = withFake({ omitTotalCount: true, readAcl: HIDE_RULE_Z });
    try {
      const report = await analyzeTransform(h);
      const refused = report.graph.unanalyzable.find(
        (entry) => entry.artifact.sysId === TRANSFORM.sysId,
      );
      assert.ok(refused, JSON.stringify(report.graph.unanalyzable));
      // The count reaches the rendered reason, not just the verdict.
      assert.match(
        refused.reason,
        /sys_script read came back inconsistent: no X-Total-Count, and the Stats API counts 2 matching rows but only 1 were returned/,
      );
      // No `table_logic` edge from a script whose rule list is partial.
      assert.ok(!report.graph.edges.some((edge) => edge.via === "table_logic"));
      assert.equal(isIncomplete(report), true);
    } finally {
      h.restore();
    }
  });
});

describe("X-Total-Count present → no Stats request", () => {
  it("sends no count when the header decides, and still reports the trim", async () => {
    const h = withFake({ readAcl: HIDE_RULE_Z });
    try {
      const include = await analyzeInclude(h);
      // The header already caught the trimming, as before wave 17.
      assert.match(
        warnings(include),
        /sys_script search came back short: X-Total-Count reports 2/,
      );
      assert.equal(isIncomplete(include), true);
      await analyzeTransform(h);
      assert.deepEqual(h.statsCalls(), []);
    } finally {
      h.restore();
    }
  });
});

describe("a header-less read the count agrees with stays complete", () => {
  it("traces everything, with the counts sent as GETs", async () => {
    const h = withFake({ omitTotalCount: true });
    try {
      const report = await analyzeTransform(h);
      assert.deepEqual(report.graph.unanalyzable, []);
      assert.equal(isIncomplete(report), false, warnings(report));
      assert.deepEqual(
        report.graph.edges.map((edge) => [edge.to.sysId, edge.via]).sort(),
        [
          [RULE_A, "table_logic"],
          [RULE_Z, "table_logic"],
        ],
      );
      // The lookup's map and rule reads each asked for a count.
      const paths = new Set(h.statsCalls().map((r) => r.path));
      assert.ok(paths.has("/api/now/stats/sys_transform_map"), [...paths]);
      assert.ok(paths.has("/api/now/stats/sys_script"), [...paths]);
      assert.ok(paths.has("/api/now/stats/sys_transform_script"), [...paths]);
      // The single-row scope identity lookup never asks for one.
      assert.ok(!paths.has("/api/now/stats/sys_scope"), [...paths]);
    } finally {
      h.restore();
    }
  });
});

describe("a count that cannot be obtained is incomplete, never complete", () => {
  it("a 404 from the Stats API (no Stats API) → incomplete", async () => {
    const h = withFake({ omitTotalCount: true });
    try {
      h.fake.faults.add({
        match: { path: "/api/now/stats/" },
        mode: { kind: "http-error", status: 404, message: "No such API" },
      });
      const report = await analyzeInclude(h);
      // Every row still came back; nothing proves the end of results.
      assert.deepEqual(edgeTargets(report), [RULE_A, RULE_Z]);
      assert.match(
        warnings(report),
        /sys_script search returned 2 rows with no X-Total-Count, and the Stats API count that would confirm the end of results could not be obtained, so more rows may exist/,
      );
      assert.equal(isIncomplete(report), true);
    } finally {
      h.restore();
    }
  });
});
