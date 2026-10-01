// Wave 17 — the Stats API count cross-check on the inventory reads.
//
// The three `fetchAll` reads that decide WHAT this stage hands on — a scope's
// artifact tables, a story's update sets and those sets' members — send
// `crossCheckCount: true`. When the instance sends no X-Total-Count and the
// paging otherwise looks complete, `@tessera/sn-client` asks the Stats API how
// many rows match. The case it exists for: read ACLs trimmed the LAST window,
// the empty probe past it reads as the end, and without the count the partial
// list came back as the whole application / the whole story.
//
// Everything here runs the real transport against the QA-18 fake, because
// the claim is about HTTP: which requests are sent, and which are not.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { createFakeInstance } from "@tessera/fake-instance";
import { reloadCredentialsFromEnv } from "@tessera/sn-client";

import {
  ResolutionFaultError,
  createScopeResolver,
  createSnRecordReader,
  createStoryResolver,
  isIncomplete,
} from "../build/index.js";

const HOST = "dev-resolvers-crosscheck.service-now.com";
const hex = (prefix) => prefix.padEnd(32, "0");

const SCOPE_SYS_ID = hex("aaaa01");
const SCOPE_NAME = "x_snc_demo";
const STORY_ID = hex("57019");
const SET_A = hex("5e7a");
const SET_B = hex("5e7b");
const RULE_ID = hex("bad1");
const INCLUDE_ID = hex("ccc2");

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

const SEED = {
  sys_scope: [{ sys_id: SCOPE_SYS_ID, scope: SCOPE_NAME, name: "Demo" }],
  // `ORDERBYname` puts ZoneLookup last — the row a trimmed LAST window hides.
  sys_script_include: [
    { name: "ZoneLookup", sys_scope: SCOPE_SYS_ID, script: "var Z = {};" },
    { name: "AmountCalculator", sys_scope: SCOPE_SYS_ID, script: "var A;" },
  ],
  rm_story: [{ sys_id: STORY_ID, number: "STRY0042" }],
  sys_update_set: [
    { sys_id: SET_A, name: "part 1", story: STORY_ID },
    { sys_id: SET_B, name: "part 2", story: STORY_ID },
  ],
  sys_update_xml: [
    {
      sys_id: hex("e1"),
      name: `sys_script_${RULE_ID}`,
      type: "Business Rule",
      target_name: "Demo rule",
      action: "INSERT_OR_UPDATE",
      update_set: SET_A,
    },
    {
      sys_id: hex("e2"),
      name: `sys_script_include_${INCLUDE_ID}`,
      type: "Script Include",
      target_name: "DemoUtil",
      action: "INSERT_OR_UPDATE",
      update_set: SET_A,
    },
  ],
};

const CTX = {
  runId: "run-crosscheck",
  lifecycle: "ephemeral",
  coverageSource: "atf",
  topology: { source: "dev", runner: "test", target: "test" },
  signal: new AbortController().signal,
};

/** A row-level read ACL hiding exactly the rows `when` picks on `table`. */
const hide = (table, when) => ({ rules: [{ table, when }] });

function withFake(options = {}) {
  const fake = createFakeInstance({ host: HOST, state: SEED, ...options });
  const restoreFetch = fake.install();
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.SN_AUTH = "basic";
  process.env.SN_DOCS_DIR = path.join(os.tmpdir(), "tessera-crosscheck-docs");
  // One shot per request, so a single-fire fault is never retried away.
  process.env.SN_MAX_RETRIES = "0";
  process.env.SN_PROFILE_SOURCE_INSTANCE = HOST;
  process.env.SN_PROFILE_SOURCE_USER = "tessera";
  process.env.SN_PROFILE_SOURCE_PASSWORD = "tessera";
  reloadCredentialsFromEnv();
  const reader = createSnRecordReader("source");
  return {
    fake,
    scope: createScopeResolver(reader),
    story: createStoryResolver(reader),
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

const resolveScope = (h) =>
  h.scope.resolveWithReport(CTX, { scope: SCOPE_NAME });
const resolveStory = (h) =>
  h.story.resolveWithReport(CTX, { story: "STRY0042" });

describe("a trimmed last window is detected by the count", () => {
  it("scope: a hidden last artifact makes the enumeration partial", async () => {
    const h = withFake({
      omitTotalCount: true,
      readAcl: hide("sys_script_include", (row) => row.name === "ZoneLookup"),
    });
    try {
      const report = await resolveScope(h);
      assert.deepEqual(
        report.artifacts.map((a) => a.ref.name),
        ["AmountCalculator"],
      );
      assert.match(
        warnings(report),
        /sys_script_include enumeration came back inconsistent: no X-Total-Count, and the Stats API counts 2 matching rows but only 1 were returned/,
      );
      assert.match(warnings(report), /partial list of scope `x_snc_demo`/);
      assert.equal(isIncomplete(report), true);
      // One count for the table that was enumerated, with the caller's filter.
      const stats = h
        .statsCalls()
        .filter((r) => r.path.endsWith("/sys_script_include"));
      assert.equal(stats.length, 1);
      assert.equal(
        stats[0].params.sysparm_query,
        `sys_scope=${SCOPE_SYS_ID}^ORDERBYname`,
      );
      // ARCH-8 holds: the count is a GET like everything else.
      assert.deepEqual(
        [...new Set(h.fake.requests().map((r) => r.method))],
        ["GET"],
      );
    } finally {
      h.restore();
    }
  });

  it("story: a hidden last update set makes the set list partial", async () => {
    const h = withFake({
      omitTotalCount: true,
      readAcl: hide("sys_update_set", (row) => row.sys_id === SET_B),
    });
    try {
      const report = await resolveStory(h);
      assert.match(
        warnings(report),
        /the list of update sets linked to STRY0042 came back inconsistent: no X-Total-Count, and the Stats API counts 2 matching rows but only 1 were returned/,
      );
      assert.equal(isIncomplete(report), true);
      assert.equal(
        h.statsCalls().filter((r) => r.path.endsWith("/sys_update_set")).length,
        1,
      );
    } finally {
      h.restore();
    }
  });

  it("story: a hidden last member makes the member list partial", async () => {
    const h = withFake({
      omitTotalCount: true,
      readAcl: hide("sys_update_xml", (row) => row.sys_id === hex("e2")),
    });
    try {
      const report = await resolveStory(h);
      assert.deepEqual(
        report.artifacts.map((a) => a.ref.sysId),
        [RULE_ID],
      );
      assert.match(
        warnings(report),
        /the member list of STRY0042's update sets came back inconsistent: no X-Total-Count, and the Stats API counts 2 matching rows but only 1 were returned/,
      );
      assert.equal(isIncomplete(report), true);
      // The port without a notes channel refuses rather than hand on the
      // partial list (H1).
      await assert.rejects(
        () => h.story.resolve(CTX, { story: "STRY0042" }),
        ResolutionFaultError,
      );
    } finally {
      h.restore();
    }
  });

  it("a header-less read the count agrees with stays complete", async () => {
    const h = withFake({ omitTotalCount: true });
    try {
      const scope = await resolveScope(h);
      assert.equal(isIncomplete(scope), false);
      assert.equal(scope.artifacts.length, 2);
      const story = await resolveStory(h);
      assert.doesNotMatch(warnings(story), /Stats API/);
      // One count per inventory read: the include table, sets, members. The
      // single-row identity lookups (sys_scope, rm_story) never ask for one.
      assert.deepEqual(
        h
          .statsCalls()
          .map((r) => r.path)
          .sort(),
        [
          "/api/now/stats/sys_script_include",
          "/api/now/stats/sys_update_set",
          "/api/now/stats/sys_update_xml",
        ],
      );
    } finally {
      h.restore();
    }
  });
});

describe("X-Total-Count present → no Stats request", () => {
  it("sends no count for a scope or a story when the header decides", async () => {
    const h = withFake({
      readAcl: hide("sys_script_include", (row) => row.name === "ZoneLookup"),
    });
    try {
      const scope = await resolveScope(h);
      // The header already caught the trimming, as before wave 17.
      assert.match(warnings(scope), /came back short: X-Total-Count reports 2/);
      await resolveStory(h);
      assert.deepEqual(h.statsCalls(), []);
    } finally {
      h.restore();
    }
  });
});

describe("a count that cannot be obtained is incomplete, never complete", () => {
  // An instance without the Stats API answers its path with a 404. Before
  // wave 17 this header-less read came back complete; now nothing proves
  // the end of results, so the report is incomplete and `tess run` /
  // `tess impact` land on INCONCLUSIVE / incomplete rather than GO.
  it("a 404 from the Stats API (no Stats API) → count-unavailable warning", async () => {
    const h = withFake({ omitTotalCount: true });
    try {
      h.fake.faults.add({
        match: { path: "/api/now/stats/" },
        mode: { kind: "http-error", status: 404, message: "No such API" },
      });
      const report = await resolveScope(h);
      assert.equal(report.artifacts.length, 2);
      assert.match(
        warnings(report),
        /sys_script_include enumeration returned 2 rows with no X-Total-Count, and the Stats API count that would confirm the end of results could not be obtained, so more rows may exist/,
      );
      assert.equal(isIncomplete(report), true);
      await assert.rejects(
        () => h.scope.resolve(CTX, { scope: SCOPE_NAME }),
        ResolutionFaultError,
      );
    } finally {
      h.restore();
    }
  });

  it("an unreadable count (non-numeric) on a story → incomplete", async () => {
    const h = withFake({
      omitTotalCount: true,
      statsCount: { fault: "non-numeric-count" },
    });
    try {
      const report = await resolveStory(h);
      const text = warnings(report);
      assert.match(
        text,
        /the list of update sets linked to STRY0042 returned 2 rows with no X-Total-Count, and the Stats API count .* could not be obtained/,
      );
      assert.match(
        text,
        /the member list of STRY0042's update sets returned 2 rows with no X-Total-Count, and the Stats API count .* could not be obtained/,
      );
      assert.equal(isIncomplete(report), true);
    } finally {
      h.restore();
    }
  });
});

describe("known residual — an ACL-filtered Stats count", () => {
  // PINNED RESIDUAL (unverified live). If the real Stats API count honours
  // row-level read ACLs, it counts exactly the rows the Table API returned,
  // and a trimmed last window stays invisible: the scope below is missing
  // ZoneLookup and the report says it is complete. This test pins today's
  // behaviour so the day it changes (live evidence, a new signal) is noticed.
  // It must not be "fixed" by weakening the default-mode tests above.
  it("a count that honours read ACLs cannot see the trimmed window", async () => {
    const h = withFake({
      omitTotalCount: true,
      readAcl: hide("sys_script_include", (row) => row.name === "ZoneLookup"),
      statsCount: { aclFiltered: true },
    });
    try {
      const report = await resolveScope(h);
      assert.deepEqual(
        report.artifacts.map((a) => a.ref.name),
        ["AmountCalculator"],
      );
      assert.equal(isIncomplete(report), false);
      assert.equal(h.statsCalls().length, 1);
    } finally {
      h.restore();
    }
  });
});
