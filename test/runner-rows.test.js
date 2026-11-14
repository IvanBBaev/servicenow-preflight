// RR-49 (CLI-1, CLI-2, CLI-3, CLI-17): a row the runner produced is never a
// check's finding — no baseline records or accepts it and no severity policy
// demotes it — and a missing table the check did not declare optional is an
// `error`, not a "plugin not installed" skip.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runPreflight } from "../build/index.js";
import { applyBaseline, baselineFromReport } from "../build/api/report.js";
import { applyPolicy } from "../build/api/checks.js";
import { corsRules } from "../build/checks/cors-rules.js";
import { portalRoles } from "../build/checks/portal-roles.js";
import { createFakeSnClient } from "../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const NOW = new Date("2026-11-14T12:00:00Z");

const hanging = (name) => ({
  name,
  description: name,
  run: (ctx) =>
    new Promise((resolve) => {
      ctx.signal?.addEventListener("abort", () =>
        resolve({ name, status: "pass", message: "late" }),
      );
    }),
});

const throwing = (name) => ({
  name,
  description: name,
  run() {
    throw new Error("boom");
  },
});

const finding = (name) => ({
  name,
  description: name,
  run: () => ({ name, status: "fail", message: "a real finding" }),
});

/** A report with a timed-out, a throwing and a genuinely failing check. */
async function mixedReport() {
  return runPreflight(
    { instanceUrl: INSTANCE },
    [hanging("slow"), throwing("crashy"), finding("real")],
    { timeoutMs: 20 },
  );
}

// --- CLI-1: a missing core table is an error --------------------------------

test("a 404 on a core table the check reads is an error row; ok is false", async () => {
  const http = createFakeSnClient({ tables: {}, fail: { http: 404 } });
  const out = await runPreflight(
    { instanceUrl: INSTANCE, http, scope: SCOPE },
    [corsRules],
  );
  const [row] = out.results;
  assert.equal(row.status, "error", row.message);
  assert.match(row.message, /^Required table not found/);
  assert.match(row.message, /not a missing plugin/);
  assert.equal(out.ok, false);
});

test("a 404 on a table the check declares optional stays a skip warn", async () => {
  const http = createFakeSnClient({
    tables: { sys_scope: [{ sys_id: "a".repeat(32), scope: SCOPE }] },
    fail: { table: { sp_widget: { http: 404 }, sp_page: { http: 404 } } },
  });
  const out = await runPreflight(
    { instanceUrl: INSTANCE, http, scope: SCOPE },
    [portalRoles],
  );
  const [row] = out.results;
  assert.equal(row.status, "warn", row.message);
  assert.match(row.message, /^Skipped .*likely not installed/);
  assert.equal(out.ok, true);
});

test("a thrown 404 from an optional table's read stays a skip warn", async () => {
  const http = createFakeSnClient({
    tables: {},
    fail: { table: { x_plugin_table: { http: 404 } } },
  });
  const out = await runPreflight({ instanceUrl: INSTANCE, http }, [
    {
      name: "plugin-reader",
      description: "d",
      meta: { optionalTables: ["x_plugin_table"] },
      async run(ctx) {
        await ctx.http.table("x_plugin_table").query({});
        return { name: "plugin-reader", status: "pass", message: "ok" };
      },
    },
  ]);
  assert.equal(out.results[0].status, "warn", out.results[0].message);
  assert.match(out.results[0].message, /^Skipped this check: /);
});

test("a check that swallows a missing core table cannot pass", async () => {
  const http = createFakeSnClient({
    tables: {},
    fail: { table: { sys_security_acl: { http: 404 } } },
  });
  const out = await runPreflight({ instanceUrl: INSTANCE, http }, [
    {
      name: "swallower",
      description: "d",
      async run(ctx) {
        try {
          await ctx.http.table("sys_security_acl").query({});
        } catch {
          // Pretends the read found nothing.
        }
        return { name: "swallower", status: "pass", message: "all clear" };
      },
    },
  ]);
  const [row] = out.results;
  assert.equal(row.status, "error", row.message);
  assert.match(row.message, /sys_security_acl/);
  assert.match(row.message, /The check reported: all clear$/);
});

// --- CLI-3: runner rows carry kind "runner" and resist the policy -----------

test("timeout, throw and malformed rows are runner rows", async () => {
  const out = await runPreflight(
    { instanceUrl: INSTANCE },
    [
      hanging("slow"),
      throwing("crashy"),
      { name: "nullish", description: "d", run: () => null },
    ],
    { timeoutMs: 20 },
  );
  for (const row of out.results) {
    assert.equal(row.status, "fail", row.name);
    assert.equal(row.kind, "runner", row.name);
  }
});

test("an external abort marks the cut checks as runner rows", async () => {
  const controller = new AbortController();
  const pending = runPreflight(
    { instanceUrl: INSTANCE },
    [hanging("running"), finding("pending")],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 10);
  const out = await pending;
  for (const row of out.results) {
    assert.equal(row.kind, "runner", row.name);
    assert.equal(row.status, "fail", row.name);
  }
});

test("a severity policy never demotes a runner row", async () => {
  const report = await mixedReport();
  const out = applyPolicy(report, {
    slow: "warn",
    crashy: "warn",
    real: "warn",
  });
  const byName = Object.fromEntries(out.results.map((r) => [r.name, r]));
  assert.equal(byName.slow.status, "fail");
  assert.equal(byName.crashy.status, "fail");
  assert.equal(byName.real.status, "warn");
  assert.equal(out.ok, false);
});

// --- CLI-2: runner rows are never baselined ---------------------------------

test("a baseline never records a runner row or a reserved name", async () => {
  const report = await mixedReport();
  report.results.push(
    {
      name: "preflight",
      status: "fail",
      message: "No checks matched.",
      kind: "runner",
    },
    { name: "preflight:incremental", status: "warn", message: "x" },
  );
  const b = baselineFromReport(report, INSTANCE, NOW);
  assert.deepEqual(
    b.entries.map((e) => e.check),
    ["real"],
  );
});

test("a baseline entry never accepts a runner row", async () => {
  const report = await mixedReport();
  report.results.push({
    name: "preflight",
    status: "fail",
    message: "No checks matched.",
    kind: "runner",
  });
  // Entries copied from every row, word for word: only the check's own
  // finding may be accepted.
  const b = {
    version: 1,
    entries: report.results.map((r) => ({
      check: r.name,
      status: r.status,
      message: r.message,
    })),
  };
  const out = applyBaseline(report, b, NOW);
  const byName = Object.fromEntries(out.results.map((r) => [r.name, r]));
  assert.equal(byName.slow.status, "fail");
  assert.equal(byName.crashy.status, "fail");
  assert.equal(byName.preflight.status, "fail");
  assert.equal(byName.real.status, "warn");
  assert.equal(byName.real.kind, "baseline");
  assert.equal(out.ok, false);
});

// --- CLI-17: a returned result is held to the check's name and a message ----

test("a check cannot report under another check's name", async () => {
  const out = await runPreflight({ instanceUrl: INSTANCE }, [
    {
      name: "liar",
      description: "d",
      run: () => ({ name: "someone-else", status: "pass", message: "ok" }),
    },
  ]);
  assert.equal(out.results[0].name, "liar");
});

test("a result without a message string fails as a runner row", async () => {
  for (const message of [undefined, 42, null]) {
    const out = await runPreflight({ instanceUrl: INSTANCE }, [
      {
        name: "mute",
        description: "d",
        run: () => ({ name: "mute", status: "pass", message }),
      },
    ]);
    const [row] = out.results;
    assert.equal(row.status, "fail", String(message));
    assert.equal(row.kind, "runner");
    assert.match(row.message, /without a message string/);
    assert.equal(out.ok, false);
  }
});
