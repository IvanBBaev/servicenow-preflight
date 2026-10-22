import { test } from "node:test";
import assert from "node:assert/strict";

import {
  inactiveArtifacts,
  INACTIVE_ARTIFACT_TABLES,
} from "../../build/checks/inactive-artifacts.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

const TABLES = INACTIVE_ARTIFACT_TABLES.map((t) => t.table);

/** A deterministic 32-hex sys_id from a small integer. */
function sid(n) {
  return n.toString(16).padStart(32, "0");
}

/**
 * Fake client. Every swept table gets a pre-trim count equal to its seeded
 * rows unless overridden (`null` omits the count to simulate an ambiguous read).
 */
function makeHttp({ tables = {}, totalCounts = {}, fail, queryFilter } = {}) {
  const counts = {};
  for (const t of TABLES) {
    const override = totalCounts[t];
    if (override === null) continue;
    counts[t] = override ?? tables[t]?.length ?? 0;
  }
  return createFakeSnClient({ tables, totalCounts: counts, fail, queryFilter });
}

function run(http, extra = {}) {
  return inactiveArtifacts.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

test("inactive-artifacts is registered as an advisory sweep over seven tables", () => {
  assert.equal(inactiveArtifacts.name, "inactive-artifacts");
  assert.ok(defaultChecks.includes(inactiveArtifacts));
  const { meta } = inactiveArtifacts;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, undefined);
  assert.equal(meta.severity, "advisory");
  assert.equal(meta.tables.length, 7);
  assert.equal(new Set(meta.tables).size, 7);
  for (const t of [
    "sys_script",
    "sys_script_client",
    "sys_script_include",
    "sys_ui_action",
    "sys_ui_policy",
    "sysauto_script",
    "sysevent_email_action",
  ]) {
    assert.ok(meta.tables.includes(t), t);
  }
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.verdicts.fail, /never/i);
});

test("warns when no scope is set", async () => {
  const result = await inactiveArtifacts.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /no scope set/i);
});

test("passes when every table reports zero inactive artifacts", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.match(result.message, /No inactive artifacts/);
  assert.match(result.message, /7 artifact tables/);
});

test("warns and cannot confirm when a table has no rows and no pre-trim count", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sys_script_include: null } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /cannot confirm/i);
  assert.match(result.message, /sys_script_include/);
});

test("warns with per-table counts and names when inactive artifacts ship", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script: [
          { sys_id: sid(1), name: "Old BR" },
          { sys_id: sid(2), name: "Older BR" },
        ],
        sys_ui_policy: [{ sys_id: sid(3), short_description: "Hide field" }],
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /3 inactive artifact\(s\)/);
  assert.match(
    result.message,
    /2 Business Rules \(sys_script\): Old BR, Older BR/,
  );
  assert.match(result.message, /1 UI Policies \(sys_ui_policy\): Hide field/);
  assert.doesNotMatch(result.message, /sys_script_client/);
});

test("elides names past the first five per table", async () => {
  const jobs = Array.from({ length: 8 }, (_, i) => ({
    sys_id: sid(10 + i),
    name: `Job ${i}`,
  }));
  const result = await run(makeHttp({ tables: { sysauto_script: jobs } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /8 Scheduled Jobs \(sysauto_script\)/);
  assert.match(result.message, /Job 4, … 3 more/);
  assert.doesNotMatch(result.message, /Job 5/);
});

test("falls back to the sys_id when a row has no name", async () => {
  const result = await run(
    makeHttp({
      tables: { sysevent_email_action: [{ sys_id: sid(7), name: "" }] },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, new RegExp(sid(7)));
});

test("notes incomplete counts when a table read was security-trimmed", async () => {
  const result = await run(
    makeHttp({
      tables: { sys_ui_action: [{ sys_id: sid(1), name: "Stale button" }] },
      totalCounts: { sys_ui_action: 3 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Stale button/);
  assert.match(result.message, /security-trimmed/);
  assert.match(result.message, /may be incomplete/);
});

test("a clean but security-trimmed sweep warns rather than passes", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_script_client: 2 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /Cannot fully sweep/);
  assert.match(result.message, /sys_script_client/);
});

test("reads only active=false rows in scope and never a script body", async () => {
  const seen = new Map();
  const http = makeHttp({
    queryFilter: (table, rows, params) => {
      seen.set(table, params);
      return rows;
    },
  });
  await run(http);
  for (const { table, nameField } of INACTIVE_ARTIFACT_TABLES) {
    const params = seen.get(table);
    assert.ok(params, table);
    assert.match(params.sysparm_query, /sys_scope(\.scope)?=/);
    assert.match(params.sysparm_query, /(^|\^)active=false($|\^)/);
    assert.equal(params.sysparm_fields, `sys_id,${nameField}`);
  }
  assert.equal(
    seen.get("sys_ui_policy").sysparm_fields,
    "sys_id,short_description",
  );
});

test("fails on an authentication error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication failed/i);
});

test("warns on a network error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /could not reach/i);
});

test("warns on an HTTP error reading one of the tables", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sys_ui_action: { http: 403 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /403/);
});
