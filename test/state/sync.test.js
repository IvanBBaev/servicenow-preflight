import { test } from "node:test";
import assert from "node:assert/strict";

import { createFakeSnClient } from "../../build/http/fake.js";
import {
  createSnClient,
  SnAuthError,
  SnNetworkError,
  SnHttpError,
} from "../../build/http/client.js";
import {
  pullManifest,
  syncManifest,
  EmptySnapshotError,
} from "../../build/state/sync.js";

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
      { test_suite: "s1", test: "t1", "sys_scope.scope": "x_acme_app" },
      { test_suite: "s1", test: "t2", "sys_scope.scope": "x_acme_app" },
      // References a test outside the pulled scope — must be skipped in
      // membership. The link itself is in-scope (the app owns the membership
      // record), so it survives the scoped link query; t3 drops only because it
      // is not in the pulled test index.
      { test_suite: "s1", test: "t3", "sys_scope.scope": "x_acme_app" },
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
 * Wrap an {@link SnClient} so every `table(name).query(params)` and
 * `table(name).queryWithMeta(params)` is recorded. Lets a test assert *which*
 * tables were read (e.g. that `sys_atf_test_result` is only touched when
 * `withLastRun` is on) and *with what params* (e.g. the sysparm_fields pinned
 * for CC-15). The test/suite reads now go through `queryWithMeta`, so it must be
 * wrapped too or those reads would bypass tracking (and throw).
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
        queryWithMeta: (params) => {
          calls.push({ table: name, params });
          return t.queryWithMeta(params);
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
  // The ATF tables plus the version-capture reads (OPP-1 / OPP-5) — but never
  // sys_atf_test_result without withLastRun.
  assert.deepEqual([...new Set(readTables)].sort(), [
    "sys_app",
    "sys_atf_test",
    "sys_atf_test_suite",
    "sys_atf_test_suite_test",
    "sys_plugins",
    "sys_properties",
    "sys_store_app",
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

test("pullManifest sends no explicit sysparm_limit on the ATF table reads (DM-7)", async () => {
  const { client, calls } = tracked(seededClient());
  await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
    withLastRun: true,
  });
  for (const c of calls) {
    if (c.table === "sys_atf_test_result") {
      // The newest-run lookup is a legitimate single-row bound — it stays.
      assert.equal(c.params.sysparm_limit, "1");
    } else {
      // Every other read omits sysparm_limit so SnClient auto-paginates; an
      // explicit cap silently truncated instances with > 1000 rows (DM-7).
      assert.equal(c.params.sysparm_limit, undefined);
    }
  }
});

test("pullManifest scopes the suite-membership link read like its siblings (DM-7)", async () => {
  const { client, calls } = tracked(seededClient());
  await pullManifest(client, "dev", undefined, { scope: "x_acme_app" });
  const linkRead = calls.find((c) => c.table === "sys_atf_test_suite_test");
  // Previously the link table was read unscoped (and capped); it is now scoped
  // to the same app scope as the test/suite reads.
  assert.equal(linkRead.params.sysparm_query, "sys_scope.scope=x_acme_app");
  assert.equal(linkRead.params.sysparm_limit, undefined);
});

test("pullManifest pulls every test across pagination pages — no 1000-row cap (DM-7)", async () => {
  const TOTAL = 2500;
  const realFetch = globalThis.fetch;
  // A real SnClient over a fetch stub that serves `sys_atf_test` in windows and
  // returns an empty set for the suite/link tables. Proves sync no longer caps
  // the pull at a single 1000-row page.
  globalThis.fetch = (url) => {
    const u = new URL(String(url));
    const table = decodeURIComponent(u.pathname.split("/").pop());
    const offset = Number(u.searchParams.get("sysparm_offset") ?? "0");
    const limit = Number(u.searchParams.get("sysparm_limit") ?? "0");
    const result = [];
    if (table === "sys_atf_test") {
      const end = Math.min(offset + limit, TOTAL);
      for (let i = offset; i < end; i++) {
        result.push({ sys_id: `t${i}`, name: `Test ${i}`, active: "true" });
      }
    }
    return Promise.resolve({
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify({ result })),
    });
  };
  try {
    const client = createSnClient({
      instanceUrl: "https://dev12345.service-now.com",
      auth: { kind: "basic", user: "u", pass: "p" },
    });
    const m = await pullManifest(client, "dev", undefined, {
      scope: "x_acme_app",
    });
    assert.equal(m.tests.length, TOTAL);
    // A row well beyond the first page is present (the old cap dropped these).
    assert.ok(m.tests.some((t) => t.sysId === "t2499"));
  } finally {
    globalThis.fetch = realFetch;
  }
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
// CC-15 — the scope prefix of a logical id must be the scope NAME, pinned by
// requesting `sys_scope.scope` on the reads (a real instance returns a 32-hex
// sys_id for `sys_scope` otherwise → per-instance prefix → 100% false drift).
// ---------------------------------------------------------------------------

test("pullManifest pins the scope name by requesting sys_scope.scope on the test AND suite reads (CC-15)", async () => {
  const { client, calls } = tracked(seededClient());
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });

  // The test read must ask for the dot-walked scope-name field. Without it the
  // Table API returns `sys_scope` as a per-instance 32-hex sys_id.
  const testRead = calls.find((c) => c.table === "sys_atf_test");
  assert.ok(
    testRead.params.sysparm_fields.split(",").includes("sys_scope.scope"),
    "test read must request sys_scope.scope",
  );
  // The suite read must pin the same field so its id prefix matches the tests'.
  const suiteRead = calls.find((c) => c.table === "sys_atf_test_suite");
  assert.ok(
    suiteRead.params.sysparm_fields.split(",").includes("sys_scope.scope"),
    "suite read must request sys_scope.scope",
  );

  // The resulting logical id is prefixed by the scope NAME, not a sys_id: every
  // id begins with "x_acme_app/" (a 32-hex prefix would be per-instance).
  const login = m.tests.find((t) => t.name === "Login Works");
  assert.ok(
    login.id.startsWith("x_acme_app/"),
    `expected scope-name prefix, got "${login.id}"`,
  );
  assert.equal(login.id, "x_acme_app/login-works");
  assert.ok(m.suites[0].id.startsWith("x_acme_app/"));
});

// ---------------------------------------------------------------------------
// CC-4 — two same-scope artifacts whose names slug to the same logical id must
// be rejected at sync time (they would corrupt idRemap / suite membership).
// ---------------------------------------------------------------------------

test("pullManifest rejects two same-scope tests that slug to the same logical id (CC-4)", async () => {
  // "Login!" and "Login?" both slugify to "login" → id "x_acme_app/login". The
  // second would silently shadow the first in the manifest (one row where the
  // instance has two). Sync must fail loudly, naming both tests and the id.
  const client = createFakeSnClient({
    tables: {
      sys_atf_test: [
        {
          sys_id: "t1",
          name: "Login!",
          active: "true",
          "sys_scope.scope": "x_acme_app",
        },
        {
          sys_id: "t2",
          name: "Login?",
          active: "true",
          "sys_scope.scope": "x_acme_app",
        },
      ],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
    },
    queryFilter: scopeAwareFilter,
  });
  await assert.rejects(
    () => pullManifest(client, "dev", undefined, { scope: "x_acme_app" }),
    (err) => {
      assert.match(err.message, /Logical id collision/);
      assert.match(err.message, /Login!/);
      assert.match(err.message, /Login\?/);
      assert.match(err.message, /x_acme_app\/login/);
      return true;
    },
  );
});

test("syncManifest rejects two same-scope suites that slug to the same logical id (CC-4)", async () => {
  // The same collision on the suite side must also fail loudly.
  const client = createFakeSnClient({
    tables: {
      sys_atf_test: [],
      sys_atf_test_suite: [
        { sys_id: "s1", name: "Smoke Suite", "sys_scope.scope": "x_acme_app" },
        { sys_id: "s2", name: "smoke suite", "sys_scope.scope": "x_acme_app" },
      ],
      sys_atf_test_suite_test: [],
    },
    queryFilter: scopeAwareFilter,
  });
  await assert.rejects(
    () =>
      syncManifest(client, "dev", undefined, undefined, {
        scope: "x_acme_app",
      }),
    (err) => {
      assert.match(err.message, /Logical id collision/);
      assert.match(err.message, /suites/);
      assert.match(err.message, /x_acme_app\/smoke-suite/);
      return true;
    },
  );
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
  reCreated.sys_atf_test_suite_test[0] = {
    test_suite: "s1",
    test: "t1-prod",
    "sys_scope.scope": "x_acme_app",
  };
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
  // An all-empty snapshot over a non-empty committed manifest is refused by the
  // SN-1 guard unless the caller opts in — here the emptiness is intentional, so
  // pass allowEmpty (and there is no security-trimming to force a hard refusal).
  const merged = await syncManifest(emptyClient, "dev", undefined, committed, {
    scope: "x_acme_app",
    allowEmpty: true,
  });
  // The merged set reflects the instance, which is now empty.
  assert.deepEqual(merged.tests, []);
  assert.deepEqual(merged.suites, []);
});

// ---------------------------------------------------------------------------
// SN-1 — an all-empty snapshot must not silently overwrite a non-empty
// committed manifest. Soft refusal (overridable) by default; a HARD refusal
// (not overridable) once the instance PROVES it is security-trimming rows.
// ---------------------------------------------------------------------------

/** A committed manifest with real coverage, used as the SN-1 overwrite target. */
function committedWithCoverage() {
  return {
    instance: "prod",
    tests: [
      { id: "x_acme_app/login-works", sysId: "t1", name: "Login Works" },
      { id: "x_acme_app/logout-works", sysId: "t2", name: "Logout Works" },
    ],
    suites: [
      { id: "x_acme_app/smoke", sysId: "s1", name: "Smoke", testIds: [] },
    ],
  };
}

test("syncManifest refuses an all-empty snapshot over a non-empty committed manifest without --allow-empty (SN-1)", async () => {
  // The account sees zero rows and the instance does NOT report a higher total
  // count (no proof of trimming). Committing would erase two committed tests, so
  // the default is a soft refusal the caller can override once they have checked.
  const emptyClient = createFakeSnClient({
    tables: {
      sys_atf_test: [],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
    },
  });
  await assert.rejects(
    () =>
      syncManifest(emptyClient, "prod", undefined, committedWithCoverage(), {
        scope: "x_acme_app",
      }),
    (err) => {
      assert.ok(err instanceof EmptySnapshotError);
      // A soft refusal: the emptiness is unproven, so --allow-empty overrides it.
      assert.equal(err.securityTrimmed, false);
      assert.match(err.message, /ACL security-trimming/);
      assert.match(err.message, /--allow-empty/);
      return true;
    },
  );
});

test("syncManifest commits an intentional empty snapshot when --allow-empty is set (SN-1)", async () => {
  // Same empty pull, but the caller has confirmed the emptiness is real and opts
  // in. With no proof of trimming the soft refusal is overridable → the merged
  // manifest reflects the (now empty) instance.
  const emptyClient = createFakeSnClient({
    tables: {
      sys_atf_test: [],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
    },
  });
  const merged = await syncManifest(
    emptyClient,
    "prod",
    undefined,
    committedWithCoverage(),
    { scope: "x_acme_app", allowEmpty: true },
  );
  assert.deepEqual(merged.tests, []);
  assert.deepEqual(merged.suites, []);
});

test("syncManifest hard-refuses a security-trimmed empty snapshot even WITH --allow-empty (SN-1/P5)", async () => {
  // The instance reports X-Total-Count = 5 on sys_atf_test but returns 0 visible
  // rows — proof that ACL security-trimming is hiding tests from this account.
  // They are not gone, so committing the empty snapshot would erase real
  // coverage. This refusal is HARD: --allow-empty must not override it.
  const trimmedClient = createFakeSnClient({
    tables: {
      sys_atf_test: [],
      sys_atf_test_suite: [],
      sys_atf_test_suite_test: [],
    },
    totalCounts: { sys_atf_test: 5 },
  });
  await assert.rejects(
    () =>
      syncManifest(trimmedClient, "prod", undefined, committedWithCoverage(), {
        scope: "x_acme_app",
        allowEmpty: true, // deliberately set — must NOT override a proven trim
      }),
    (err) => {
      assert.ok(err instanceof EmptySnapshotError);
      assert.equal(err.securityTrimmed, true);
      assert.match(err.message, /X-Total-Count exceeds the visible rows/);
      assert.match(err.message, /NOT overridable with --allow-empty/);
      return true;
    },
  );
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

// ---------------------------------------------------------------------------
// Version capture — instance identity (OPP-1) and installed apps (OPP-5).
// ---------------------------------------------------------------------------

/**
 * Seed rows for the version-capture tables on top of the ATF footprint, with
 * the interesting edge rows built in: an SN-5 `latest_version` trap, a
 * scopeless app, a versionless app, a plugin keyed by `source`, and a
 * versionless plugin.
 */
function versionSeedRows() {
  return {
    ...seedRows(),
    sys_properties: [
      { sys_id: "p1", name: "glide.buildname", value: "Xanadu" },
      { sys_id: "p2", name: "glide.war", value: "glide-xanadu-07-02-2026" },
      // Unrelated property — must never leak into the identity.
      { sys_id: "p3", name: "glide.installation.name", value: "Dev" },
    ],
    sys_store_app: [
      {
        sys_id: "sa1",
        scope: "x_store_app",
        name: "Store App",
        version: "2.0.0",
        // SN-5 trap: the store's newest AVAILABLE version — must never be read.
        latest_version: "9.9.9",
      },
    ],
    sys_app: [
      {
        sys_id: "a1",
        scope: "x_custom_app",
        name: "Custom App",
        version: "1.5.0",
      },
      // No scope — cannot be keyed by id, dropped.
      { sys_id: "a2", scope: "", name: "Scopeless" },
      // No version — still recorded: presence drives missing-on-target (OPP-5).
      { sys_id: "a3", scope: "x_versionless", name: "Versionless App" },
    ],
    sys_plugins: [
      {
        sys_id: "pl1",
        id: "com.snc.incident",
        name: "Incident",
        version: "10.0.1",
      },
      // No `id` value; the capture must fall back to `source`.
      {
        sys_id: "pl2",
        source: "com.snc.source_only",
        name: "Source Only",
        version: "1.1",
      },
      // No version — a plugin carries no comparable signal without one, dropped.
      { sys_id: "pl3", id: "com.snc.no_version", name: "No Version" },
    ],
  };
}

function versionSeededClient() {
  return createFakeSnClient({
    tables: versionSeedRows(),
    queryFilter: scopeAwareFilter,
  });
}

test("pullManifest captures the platform identity from sys_properties (OPP-1)", async () => {
  const m = await pullManifest(versionSeededClient(), "dev", undefined, {
    scope: "x_acme_app",
  });
  assert.deepEqual(m.identity, {
    buildName: "Xanadu",
    war: "glide-xanadu-07-02-2026",
  });
});

test("identity read goes through the validated IN builder and pins its fields (SR-1)", async () => {
  const { client, calls } = tracked(versionSeededClient());
  await pullManifest(client, "dev", undefined, { scope: "x_acme_app" });
  const propCalls = calls.filter((c) => c.table === "sys_properties");
  assert.equal(propCalls.length, 1);
  assert.equal(
    propCalls[0].params.sysparm_query,
    "nameINglide.buildname,glide.war",
  );
  assert.equal(propCalls[0].params.sysparm_fields, "name,value");
});

test("pullManifest captures the installed app/plugin inventory (OPP-5)", async () => {
  const m = await pullManifest(versionSeededClient(), "dev", undefined, {
    scope: "x_acme_app",
  });
  const byId = new Map(m.apps.map((a) => [a.id, a]));
  assert.deepEqual(byId.get("x_store_app"), {
    id: "x_store_app",
    name: "Store App",
    version: "2.0.0",
  });
  assert.deepEqual(byId.get("x_custom_app"), {
    id: "x_custom_app",
    name: "Custom App",
    version: "1.5.0",
  });
  // Recorded WITHOUT a version: presence alone drives missing-on-target.
  assert.deepEqual(byId.get("x_versionless"), {
    id: "x_versionless",
    name: "Versionless App",
  });
  assert.deepEqual(byId.get("com.snc.incident"), {
    id: "com.snc.incident",
    name: "Incident",
    version: "10.0.1",
  });
  // Plugin with a blank `id` is keyed by `source`.
  assert.deepEqual(byId.get("com.snc.source_only"), {
    id: "com.snc.source_only",
    name: "Source Only",
    version: "1.1",
  });
  // Scopeless app and versionless plugin are dropped.
  assert.equal(byId.has("com.snc.no_version"), false);
  assert.equal(byId.size, 5);
});

test("app capture reads the INSTALLED version column, never latest_version (SN-5)", async () => {
  const rows = versionSeedRows();
  rows.sys_store_app.push({
    sys_id: "sa2",
    scope: "x_not_yet_upgraded",
    name: "Not Yet Upgraded",
    // Only the store's newest available version exists; the installed
    // `version` column is blank → the entry must carry NO version at all.
    latest_version: "4.0.0",
  });
  const client = createFakeSnClient({
    tables: rows,
    queryFilter: scopeAwareFilter,
  });
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });
  assert.deepEqual(
    m.apps.find((a) => a.id === "x_not_yet_upgraded"),
    { id: "x_not_yet_upgraded", name: "Not Yet Upgraded" },
  );
  // And the seeded installed version is captured as-is, not the 9.9.9 trap.
  assert.equal(m.apps.find((a) => a.id === "x_store_app").version, "2.0.0");
});

test("app capture dedupes by id with store > scoped app > plugin precedence (OPP-5)", async () => {
  const rows = versionSeedRows();
  rows.sys_store_app.push({
    sys_id: "d1",
    scope: "x_dup",
    name: "Store Wins",
    version: "2.0.0",
  });
  rows.sys_app.push({
    sys_id: "d2",
    scope: "x_dup",
    name: "App Loses",
    version: "1.0.0",
  });
  rows.sys_plugins.push({
    sys_id: "d3",
    id: "x_dup",
    name: "Plugin Loses",
    version: "0.5",
  });
  rows.sys_plugins.push({
    sys_id: "d4",
    id: "x_custom_app",
    name: "Plugin Loses Too",
    version: "0.1",
  });
  const client = createFakeSnClient({
    tables: rows,
    queryFilter: scopeAwareFilter,
  });
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });
  const dup = m.apps.filter((a) => a.id === "x_dup");
  assert.equal(dup.length, 1);
  assert.deepEqual(dup[0], {
    id: "x_dup",
    name: "Store Wins",
    version: "2.0.0",
  });
  // The sys_app row wins over the plugin carrying the same id.
  assert.equal(m.apps.find((a) => a.id === "x_custom_app").version, "1.5.0");
});

test("a security-trimmed app read drops the whole inventory — partial would mis-gate (SN-1/OPP-5)", async () => {
  const client = createFakeSnClient({
    tables: versionSeedRows(),
    queryFilter: scopeAwareFilter,
    // More matching rows than visible ones on ONE of the three app tables.
    totalCounts: { sys_store_app: 10 },
  });
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });
  assert.equal(m.apps, undefined);
  // The identity is captured independently of the app inventory.
  assert.deepEqual(m.identity, {
    buildName: "Xanadu",
    war: "glide-xanadu-07-02-2026",
  });
});

test("a failing capture read records absence but the sync still succeeds (OPP-1/OPP-5)", async () => {
  const client = createFakeSnClient({
    tables: versionSeedRows(),
    queryFilter: scopeAwareFilter,
    fail: {
      table: {
        sys_properties: { http: 403, message: "ACL denies sys_properties" },
        sys_plugins: { http: 403, message: "ACL denies sys_plugins" },
      },
    },
  });
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });
  assert.equal(m.identity, undefined);
  // ONE of the three app reads failing drops the whole inventory.
  assert.equal(m.apps, undefined);
  // The ATF snapshot itself is unaffected — the sync did not abort.
  assert.equal(m.tests.length, 2);
});

test("blank property values are recorded as absent, never fabricated (OPP-1)", async () => {
  const rows = versionSeedRows();
  rows.sys_properties = [
    { sys_id: "p1", name: "glide.buildname", value: "" },
    { sys_id: "p2", name: "glide.war", value: "glide-only.war" },
  ];
  const client = createFakeSnClient({
    tables: rows,
    queryFilter: scopeAwareFilter,
  });
  const m = await pullManifest(client, "dev", undefined, {
    scope: "x_acme_app",
  });
  assert.deepEqual(m.identity, { war: "glide-only.war" });
});

test("an all-empty, untrimmed inventory reads as never captured (OPP-1/OPP-5)", async () => {
  // The base seeded client has no version tables at all: every capture read
  // returns zero rows with no trim signal. A real instance always has plugins,
  // so all-empty is treated as unproven ACL trimming → absent, not [].
  const m = await pullManifest(seededClient(), "dev", undefined, {
    scope: "x_acme_app",
  });
  assert.equal(m.identity, undefined);
  assert.equal(m.apps, undefined);
});

test("syncManifest carries identity and apps from the fresh snapshot through the merge (OPP-1/OPP-5)", async () => {
  const committed = {
    instance: "dev",
    tests: [{ id: "x_acme_app/login-works", name: "Login Works" }],
    suites: [],
  };
  const m = await syncManifest(
    versionSeededClient(),
    "dev",
    undefined,
    committed,
    { scope: "x_acme_app" },
  );
  assert.deepEqual(m.identity, {
    buildName: "Xanadu",
    war: "glide-xanadu-07-02-2026",
  });
  assert.ok(m.apps.some((a) => a.id === "x_store_app"));
});
