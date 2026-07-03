import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeSnClient } from "../../build/http/fake.js";
import {
  SnAuthError,
  SnNetworkError,
  SnHttpError,
} from "../../build/http/client.js";
import { pullManifest, syncManifest } from "../../build/state/sync.js";

/**
 * A fake instance seeded with a small ATF footprint in scope `x_acme_app`:
 * two in-scope tests (one active, one inactive), one out-of-scope test, an
 * in-scope suite linking all three (the out-of-scope link must drop), a
 * global suite, and result rows so `withLastRun` has something to attach.
 *
 * `queryFilter` emulates the real instance: it honours `sys_scope.scope=` in
 * `sysparm_query`, and for `sys_atf_test_result` it filters by `test=` and
 * sorts newest-first (emulating `ORDERBYDESCsys_created_on`).
 */
function seedRows() {
  return {
    sys_atf_test: [
      {
        sys_id: "t1",
        name: "Login Works",
        active: "true",
        "sys_scope.scope": "x_acme_app",
      },
      {
        sys_id: "t2",
        name: "Logout Works",
        active: "false",
        "sys_scope.scope": "x_acme_app",
      },
      {
        sys_id: "t3",
        name: "Other Scope",
        active: "true",
        "sys_scope.scope": "global",
      },
    ],
    sys_atf_test_suite: [
      { sys_id: "s1", name: "Smoke", "sys_scope.scope": "x_acme_app" },
      { sys_id: "s2", name: "Global Suite", "sys_scope.scope": "global" },
    ],
    sys_atf_test_suite_test: [
      { test_suite: "s1", test: "t1" },
      { test_suite: "s1", test: "t2" },
      // References a test outside the pulled scope — must be skipped in membership.
      { test_suite: "s1", test: "t3" },
    ],
    sys_atf_test_result: [
      {
        sys_id: "r1old",
        test: "t1",
        status: "failure",
        sys_created_on: "2026-06-01 00:00:00",
      },
      {
        sys_id: "r1new",
        test: "t1",
        status: "success",
        sys_created_on: "2026-06-30 00:00:00",
      },
      {
        sys_id: "r2",
        test: "t2",
        status: "success",
        sys_created_on: "2026-06-15 00:00:00",
      },
    ],
  };
}

/** A scope-and-result-aware `queryFilter` shared by the seeded fixtures. */
function scopeAwareFilter(table, rows, params) {
  const q = params?.sysparm_query ?? "";
  if (table === "sys_atf_test_result") {
    const m = /(?:^|\^)test=([^^]+)/.exec(q);
    const testId = m?.[1];
    const matched = testId ? rows.filter((r) => r.test === testId) : rows;
    // Emulate ORDERBYDESCsys_created_on: newest first.
    return [...matched].sort((a, b) =>
      String(b.sys_created_on).localeCompare(String(a.sys_created_on)),
    );
  }
  const sm = /(?:^|\^)sys_scope\.scope=([^^]+)/.exec(q);
  if (sm) {
    const scope = sm[1];
    return rows.filter((r) => (r["sys_scope.scope"] ?? r.scope) === scope);
  }
  return rows;
}

function seededClient() {
  return createFakeSnClient({
    tables: seedRows(),
    queryFilter: scopeAwareFilter,
  });
}

/**
 * Wrap an {@link SnClient} so every `table(name).query(params)` is recorded.
 * Lets a test assert *which* tables were read (e.g. that `sys_atf_test_result`
 * is only touched when `withLastRun` is on).
 */
function tracked(client) {
  const calls = [];
  const wrapped = {
    ...client,
    table(name) {
      const t = client.table(name);
      return {
        get: (sysId) => t.get(sysId),
        query: (params) => {
          calls.push({ table: name, params });
          return t.query(params);
        },
      };
    },
  };
  return { client: wrapped, calls };
}

// ---------------------------------------------------------------------------
// pullManifest — the raw instance snapshot (no merge).
// ---------------------------------------------------------------------------

test("pullManifest snapshots scoped tests with logical ids, sysIds and active flags", async () => {
  const client = seededClient();
  const m = await pullManifest(client, "dev", "https://dev.service-now.com", {
    scope: "x_acme_app",
  });

  assert.equal(m.instance, "dev");
  assert.equal(m.url, "https://dev.service-now.com");
  assert.equal(m.scope, "x_acme_app");

  // Only the two in-scope tests; the global one is filtered out by the scope query.
  assert.deepEqual(m.tests.map((t) => t.id).sort(), [
    "x_acme_app/login-works",
    "x_acme_app/logout-works",
  ]);

  const login = m.tests.find((t) => t.id === "x_acme_app/login-works");
  assert.equal(login.sysId, "t1");
  assert.equal(login.name, "Login Works");
  assert.equal(login.active, true);

  const logout = m.tests.find((t) => t.id === "x_acme_app/logout-works");
  assert.equal(logout.sysId, "t2");
  assert.equal(logout.active, false);

  // No last-run pull requested → no lastRun on any test.
  assert.equal(login.lastRun, undefined);
  assert.equal(logout.lastRun, undefined);
});

test("pullManifest maps suite membership to logical ids, skipping out-of-scope links", async () => {
  const client = seededClient();
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });

  // url is undefined → not stamped.
  assert.equal(m.url, undefined);

  // Only the in-scope suite is pulled.
  assert.deepEqual(
    m.suites.map((s) => s.id),
    ["x_acme_app/smoke"],
  );
  const smoke = m.suites[0];
  assert.equal(smoke.sysId, "s1");
  // t3 (out of scope) is not in the pulled test index, so it drops from membership.
  assert.deepEqual(smoke.testIds.sort(), [
    "x_acme_app/login-works",
    "x_acme_app/logout-works",
  ]);
});

test("pullManifest without withLastRun never reads the result table", async () => {
  const { client, calls } = tracked(seededClient());
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });

  const readTables = calls.map((c) => c.table);
  assert.deepEqual([...new Set(readTables)].sort(), [
    "sys_atf_test",
    "sys_atf_test_suite",
    "sys_atf_test_suite_test",
  ]);
  assert.ok(!readTables.includes("sys_atf_test_result"));
  for (const t of m.tests) assert.equal(t.lastRun, undefined);
});

test("pullManifest with withLastRun reads the result table once per test with a sysId", async () => {
  const { client, calls } = tracked(seededClient());
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
    withLastRun: true,
  });

  const resultReads = calls.filter((c) => c.table === "sys_atf_test_result");
  // One query per in-scope test (t1, t2).
  assert.equal(resultReads.length, 2);
  // Each result query bounds a single, newest row and targets one test sys_id.
  for (const c of resultReads) {
    assert.equal(c.params.sysparm_limit, "1");
    assert.match(
      c.params.sysparm_query,
      /^test=t\d\^ORDERBYDESCsys_created_on$/,
    );
  }

  const login = m.tests.find((t) => t.id === "x_acme_app/login-works");
  // Newest result (r1new, success) wins over the older failure; status normalised.
  assert.deepEqual(login.lastRun, {
    at: "2026-06-30 00:00:00",
    status: "pass",
    resultId: "r1new",
  });
  const logout = m.tests.find((t) => t.id === "x_acme_app/logout-works");
  assert.deepEqual(logout.lastRun, {
    at: "2026-06-15 00:00:00",
    status: "pass",
    resultId: "r2",
  });
});

test("pullManifest withLastRun leaves lastRun unset for a test with no result rows", async () => {
  const client = createFakeSnClient({
    tables: {
      sys_atf_test: [
        {
          sys_id: "t1",
          name: "Untried",
          active: "true",
          "sys_scope.scope": "x_acme_app",
        },
      ],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
      sys_atf_test_result: [], // no runs for anyone
    },
    queryFilter: scopeAwareFilter,
  });
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
    withLastRun: true,
  });
  assert.equal(m.tests[0].lastRun, undefined);
});

test("pullManifest on an empty instance yields an empty-but-well-formed manifest", async () => {
  const client = createFakeSnClient({
    tables: {
      sys_atf_test: [],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
    },
  });
  const m = await pullManifest(
    client,
    "empty",
    "https://empty.service-now.com",
    {
      scope: "x_acme_app",
      withLastRun: true, // still fine with zero tests — attachLastRuns is a no-op
    },
  );

  assert.equal(m.instance, "empty");
  assert.equal(m.url, "https://empty.service-now.com");
  assert.equal(m.scope, "x_acme_app");
  assert.deepEqual(m.tests, []);
  assert.deepEqual(m.suites, []);
});

test("pullManifest stamps syncedAt from the injected `now`, and omits it otherwise", async () => {
  const withNow = await pullManifest(seededClient(), "dev", undefined, {
    scope: "x_acme_app",
    now: "2026-07-04T00:00:00.000Z",
  });
  assert.equal(withNow.syncedAt, "2026-07-04T00:00:00.000Z");

  const withoutNow = await pullManifest(seededClient(), "dev", undefined, {
    scope: "x_acme_app",
  });
  assert.equal(withoutNow.syncedAt, undefined);
});

test("pullManifest passes a caller-supplied limit through as sysparm_limit", async () => {
  const { client, calls } = tracked(seededClient());
  await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
    limit: 25,
  });
  for (const c of calls) {
    // The result table pins limit=1; every other read uses the caller's limit.
    if (c.table !== "sys_atf_test_result") {
      assert.equal(c.params.sysparm_limit, "25");
    }
  }
});

test("pullManifest defaults sysparm_limit to 1000 when no limit is given", async () => {
  const { client, calls } = tracked(seededClient());
  await pullManifest(client, "dev", undefined, { scope: "x_acme_app" });
  const testRead = calls.find((c) => c.table === "sys_atf_test");
  assert.equal(testRead.params.sysparm_limit, "1000");
});

test("pullManifest with no scope filter pulls everything; ids derive from each row's own scope", async () => {
  const client = seededClient();
  const m = await pullManifest(client, "dev", undefined, {});

  // No scope filter (opts.scope undefined) → all three tests. Each id's scope
  // prefix comes from the *row's* own `sys_scope.scope`, not from any filter.
  assert.deepEqual(m.tests.map((t) => t.id).sort(), [
    "global/other-scope",
    "x_acme_app/login-works",
    "x_acme_app/logout-works",
  ]);
  // Both suites come through, likewise prefixed by their own scope.
  assert.deepEqual(m.suites.map((s) => s.id).sort(), [
    "global/global-suite",
    "x_acme_app/smoke",
  ]);
  // With every test now in the index, the smoke suite keeps all three links.
  const smoke = m.suites.find((s) => s.id === "x_acme_app/smoke");
  assert.deepEqual(smoke.testIds.sort(), [
    "global/other-scope",
    "x_acme_app/login-works",
    "x_acme_app/logout-works",
  ]);
});

test("pullManifest carries a coverage hint through onto the test state", async () => {
  const client = createFakeSnClient({
    tables: {
      sys_atf_test: [
        {
          sys_id: "t1",
          name: "Covers SI",
          active: "true",
          "sys_scope.scope": "x_acme_app",
          covers_type: "script_include",
          covers_name: "AcmeUtils",
        },
        // A test with only a partial coverage hint → no `covers` attached.
        {
          sys_id: "t2",
          name: "No Cover",
          active: "true",
          "sys_scope.scope": "x_acme_app",
          coverage_type: "business_rule",
        },
      ],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
    },
    queryFilter: scopeAwareFilter,
  });
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });

  const covered = m.tests.find((t) => t.id === "x_acme_app/covers-si");
  assert.deepEqual(covered.covers, {
    type: "script_include",
    name: "AcmeUtils",
  });
  const uncovered = m.tests.find((t) => t.id === "x_acme_app/no-cover");
  assert.equal(uncovered.covers, undefined);
});

test("pullManifest reads reference fields in {value, display_value} form", async () => {
  const client = createFakeSnClient({
    tables: {
      sys_atf_test: [
        {
          sys_id: "t1",
          name: "Login",
          active: "true",
          sys_scope: { value: "sc", display_value: "x_acme_app" },
        },
      ],
      sys_atf_test_suite: [{ sys_id: "s1", name: "Smoke" }],
      sys_atf_test_suite_test: [
        { test_suite: { value: "s1" }, test: { value: "t1" } },
      ],
    },
  });
  // No scope filter here — exercise the plain (unscoped) pull + object refs.
  const m = await pullManifest(client, "dev", undefined, {});
  assert.equal(m.suites[0].testIds.length, 1);
  assert.equal(m.suites[0].testIds[0], m.tests[0].id);
});

test("pullManifest drops rows without a sys_id", async () => {
  const client = createFakeSnClient({
    tables: {
      sys_atf_test: [
        { sys_id: "t1", name: "Real", active: "true" },
        { name: "Ghost — no sys_id", active: "true" },
      ],
      sys_atf_test_suite: [
        { name: "Ghost suite" },
        { sys_id: "s1", name: "Real suite" },
      ],
      sys_atf_test_suite_test: [],
    },
  });
  const m = await pullManifest(client, "dev", undefined, {});
  assert.deepEqual(
    m.tests.map((t) => t.sysId),
    ["t1"],
  );
  assert.deepEqual(
    m.suites.map((s) => s.sysId),
    ["s1"],
  );
});

test("pullManifest normalises assorted raw run statuses", async () => {
  const client = createFakeSnClient({
    tables: {
      sys_atf_test: [
        { sys_id: "p", name: "Passed One", active: "true" },
        { sys_id: "f", name: "Failed One", active: "true" },
        { sys_id: "w", name: "Weird One", active: "true" },
      ],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
      sys_atf_test_result: [
        {
          sys_id: "rp",
          test: "p",
          status: "passed",
          sys_created_on: "2026-01-01 00:00:00",
        },
        {
          sys_id: "rf",
          test: "f",
          status: "errored",
          sys_created_on: "2026-01-01 00:00:00",
        },
        {
          sys_id: "rw",
          test: "w",
          status: "skipped",
          sys_created_on: "2026-01-01 00:00:00",
        },
      ],
    },
    queryFilter: scopeAwareFilter,
  });
  const m = await pullManifest(client, "dev", undefined, { withLastRun: true });
  const byId = Object.fromEntries(m.tests.map((t) => [t.id, t.lastRun.status]));
  assert.equal(byId["passed-one"], "pass");
  assert.equal(byId["failed-one"], "fail");
  // Unknown status passes through verbatim (lowercased).
  assert.equal(byId["weird-one"], "skipped");
});

// ---------------------------------------------------------------------------
// syncManifest — pull + merge against the committed manifest.
// ---------------------------------------------------------------------------

test("syncManifest against an empty/undefined committed manifest equals a raw pull", async () => {
  const merged = await syncManifest(
    seededClient(),
    "dev",
    undefined,
    undefined,
    {
      scope: "x_acme_app",
    },
  );
  assert.deepEqual(merged.tests.map((t) => t.id).sort(), [
    "x_acme_app/login-works",
    "x_acme_app/logout-works",
  ]);
  assert.deepEqual(
    merged.suites.map((s) => s.id),
    ["x_acme_app/smoke"],
  );
});

test("syncManifest merges a fresh snapshot into a committed manifest, preserving curated ids", async () => {
  const client = seededClient();
  // Committed manifest gave t1 a curated logical id (matched here by name).
  const existing = {
    instance: "dev",
    tests: [{ id: "x_acme_app/curated-login", name: "Login Works" }],
    suites: [
      {
        id: "x_acme_app/curated-smoke",
        sysId: "s1",
        name: "Smoke",
        testIds: [],
      },
    ],
  };
  const merged = await syncManifest(client, "dev", undefined, existing, {
    scope: "x_acme_app",
  });

  // The login test keeps its curated id (matched by name); its sysId is refreshed.
  const login = merged.tests.find((t) => t.name === "Login Works");
  assert.equal(login.id, "x_acme_app/curated-login");
  assert.equal(login.sysId, "t1");
  // The suite keeps its curated id (matched by sysId)...
  assert.equal(merged.suites[0].id, "x_acme_app/curated-smoke");
  // ...and its membership is remapped through the same reconciliation, so it
  // points at the curated test id, keeping the merged manifest consistent.
  assert.deepEqual(merged.suites[0].testIds.sort(), [
    "x_acme_app/curated-login",
    "x_acme_app/logout-works",
  ]);
});

test("syncManifest keeps the logical id stable when the instance reports a NEW sys_id", async () => {
  // First sync: instance reports t1 for the login test. Simulate a committed
  // manifest captured from that first sync.
  const first = await syncManifest(
    seededClient(),
    "dev",
    undefined,
    undefined,
    {
      scope: "x_acme_app",
    },
  );
  const committed = first;
  const loginBefore = committed.tests.find(
    (t) => t.id === "x_acme_app/login-works",
  );
  assert.equal(loginBefore.sysId, "t1");

  // Second sync against a DIFFERENT instance where the SAME logical test was
  // locally re-created and therefore has a different sys_id ("t1-prod"). Matching
  // falls back to `name`, so the logical id must not churn.
  const reCreated = seedRows();
  reCreated.sys_atf_test[0] = {
    sys_id: "t1-prod",
    name: "Login Works",
    active: "true",
    "sys_scope.scope": "x_acme_app",
  };
  // Suite membership link now points at the new test sys_id too.
  reCreated.sys_atf_test_suite_test[0] = { test_suite: "s1", test: "t1-prod" };
  const prodClient = createFakeSnClient({
    tables: reCreated,
    queryFilter: scopeAwareFilter,
  });

  const second = await syncManifest(prodClient, "prod", undefined, committed, {
    scope: "x_acme_app",
  });

  const loginAfter = second.tests.find((t) => t.name === "Login Works");
  // Same logical id survives the sys_id change...
  assert.equal(loginAfter.id, "x_acme_app/login-works");
  // ...while the volatile per-instance sys_id is refreshed to the new one.
  assert.equal(loginAfter.sysId, "t1-prod");
  // Suite membership still resolves to the stable logical id.
  const smoke = second.suites.find((s) => s.id === "x_acme_app/smoke");
  assert.ok(smoke.testIds.includes("x_acme_app/login-works"));
});

test("syncManifest carries lastRun and coverage from the fresh snapshot through the merge", async () => {
  const committed = {
    instance: "dev",
    tests: [{ id: "x_acme_app/login-works", sysId: "t1", name: "Login Works" }],
    suites: [],
  };
  const merged = await syncManifest(
    seededClient(),
    "dev",
    undefined,
    committed,
    {
      scope: "x_acme_app",
      withLastRun: true,
      now: "2026-07-04T00:00:00.000Z",
    },
  );
  assert.equal(merged.syncedAt, "2026-07-04T00:00:00.000Z");
  const login = merged.tests.find((t) => t.id === "x_acme_app/login-works");
  assert.equal(login.lastRun.status, "pass");
  assert.equal(login.lastRun.resultId, "r1new");
});

test("syncManifest on an empty instance drops committed tests (set follows the instance)", async () => {
  const committed = {
    instance: "dev",
    tests: [{ id: "x_acme_app/gone", sysId: "t9", name: "Gone" }],
    suites: [
      { id: "x_acme_app/gone-suite", sysId: "s9", name: "Gone", testIds: [] },
    ],
  };
  const emptyClient = createFakeSnClient({
    tables: {
      sys_atf_test: [],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
    },
  });
  const merged = await syncManifest(emptyClient, "dev", undefined, committed, {
    scope: "x_acme_app",
  });
  // The merged set reflects the instance, which is now empty.
  assert.deepEqual(merged.tests, []);
  assert.deepEqual(merged.suites, []);
});

// ---------------------------------------------------------------------------
// Error propagation — a failing client surfaces sanely out of sync.
// ---------------------------------------------------------------------------

test("pullManifest propagates an auth failure from the very first read", async () => {
  const client = createFakeSnClient({
    tables: { sys_atf_test: [] },
    fail: { auth: true },
  });
  await assert.rejects(
    () => pullManifest(client, "dev", undefined, { scope: "x_acme_app" }),
    (err) => {
      assert.ok(err instanceof SnAuthError);
      assert.equal(err.status, 401);
      return true;
    },
  );
});

test("pullManifest propagates a network failure scoped to the suite table", async () => {
  const client = createFakeSnClient({
    tables: seedRows(),
    queryFilter: scopeAwareFilter,
    // Tests read fine; the suite read blows up mid-pull.
    fail: { table: { sys_atf_test_suite: { network: true } } },
  });
  await assert.rejects(
    () => pullManifest(client, "dev", undefined, { scope: "x_acme_app" }),
    (err) => {
      assert.ok(err instanceof SnNetworkError);
      return true;
    },
  );
});

test("pullManifest withLastRun propagates a failure from the result table", async () => {
  const client = createFakeSnClient({
    tables: seedRows(),
    queryFilter: scopeAwareFilter,
    fail: {
      table: {
        sys_atf_test_result: { http: 503, message: "result table down" },
      },
    },
  });
  await assert.rejects(
    () =>
      pullManifest(client, "dev", undefined, {
        scope: "x_acme_app",
        withLastRun: true,
      }),
    (err) => {
      assert.ok(err instanceof SnHttpError);
      assert.equal(err.status, 503);
      assert.match(err.message, /result table down/);
      return true;
    },
  );
});

test("syncManifest propagates the underlying pull failure (never swallows it)", async () => {
  const client = createFakeSnClient({
    tables: { sys_atf_test: [] },
    fail: { http: 500, message: "boom" },
  });
  await assert.rejects(
    () =>
      syncManifest(client, "dev", undefined, undefined, {
        scope: "x_acme_app",
      }),
    (err) => {
      assert.ok(err instanceof SnHttpError);
      assert.equal(err.status, 500);
      return true;
    },
  );
});
