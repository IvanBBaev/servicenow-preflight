import { test } from "node:test";
import assert from "node:assert/strict";

import { defaultSetLeakage } from "../../build/checks/default-set-leakage.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const SCOPE = "x_acme_app";
const SCOPE_SYS_ID = "a".repeat(32);
const OTHER_SCOPE_ID = "e".repeat(32);
const GLOBAL_DEFAULT_ID = "b".repeat(32);
const SCOPED_DEFAULT_ID = "c".repeat(32);
const NAMED_SET_ID = "d".repeat(32);

/** The target scope's `sys_scope` row, so the shared resolver finds a sys_id. */
function scopeRow() {
  return { sys_id: SCOPE_SYS_ID, scope: SCOPE };
}

const globalDefault = {
  sys_id: GLOBAL_DEFAULT_ID,
  name: "Default",
  is_default: "true",
};
const scopedDefault = {
  sys_id: SCOPED_DEFAULT_ID,
  name: `Default [${SCOPE}]`,
  is_default: "true",
};
const namedSet = {
  sys_id: NAMED_SET_ID,
  name: "Release 1.2",
  is_default: "false",
};

/** A raw `sys_update_xml` fixture row captured in `setId` for the target scope. */
function update(setId, targetName, extra = {}) {
  return {
    sys_id: `u_${targetName}`,
    name: `sys_script_include_${targetName}`,
    target_name: targetName,
    update_set: setId,
    application: SCOPE_SYS_ID,
    ...extra,
  };
}

/**
 * Route the fake's single global query filter by table name, emulating the
 * encoded queries the check issues: the resolver's `sys_id=…^ORscope=…` lookup
 * on `sys_scope`, the `is_default=true` filter on `sys_update_set`, and the
 * `update_setIN…^application…` membership query on `sys_update_xml` (both the
 * resolved `application=<sysId>` form and the dot-walked
 * `application.scope=<name>` fallback).
 */
function queryFilter(table, rows, params) {
  const q = params?.sysparm_query ?? "";
  if (table === "sys_scope") {
    const wanted = [...q.matchAll(/(?:sys_id|scope)=([^^]+)/g)].map(
      (m) => m[1],
    );
    return rows.filter(
      (r) => wanted.includes(r.sys_id) || wanted.includes(r.scope),
    );
  }
  if (table === "sys_update_set") {
    if (/(?:^|\^)is_default=true(?:$|\^)/.test(q)) {
      return rows.filter((r) => String(r.is_default) === "true");
    }
    return rows;
  }
  if (table === "sys_update_xml") {
    const inMatch = /update_setIN([^^]+)/.exec(q);
    const setIds = inMatch ? new Set(inMatch[1].split(",")) : null;
    const appEq = /(?:^|\^)application=([^^]+)/.exec(q);
    const appScope = /(?:^|\^)application\.scope=([^^]+)/.exec(q);
    return rows.filter((r) => {
      if (setIds && !setIds.has(r.update_set)) return false;
      if (appEq && r.application !== appEq[1]) return false;
      if (appScope && r["application.scope"] !== appScope[1]) return false;
      return true;
    });
  }
  return rows;
}

/** Assemble a fake client from scope / update-set / update fixtures. */
function makeHttp({
  scopes = [scopeRow()],
  sets = [globalDefault, scopedDefault, namedSet],
  updates = [],
  fail,
  totalCounts,
} = {}) {
  return createFakeSnClient({
    tables: {
      sys_scope: scopes,
      sys_update_set: sets,
      sys_update_xml: updates,
    },
    queryFilter,
    totalCounts,
    fail,
  });
}

/** Run the check against a fresh ctx (fresh per-run scope-resolution cache). */
function run(http, extra = {}) {
  return defaultSetLeakage.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** Wrap a fake client so every `query`/`queryWithMeta` call is recorded. */
function tracked(http) {
  const calls = [];
  return {
    http: {
      ...http,
      table(name) {
        const t = http.table(name);
        return {
          get: (id, params) => t.get(id, params),
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
    },
    calls,
  };
}

test("default-set-leakage keeps its registered name", async () => {
  const result = await run(makeHttp());
  assert.equal(result.name, "default-set-leakage");
});

test("warns when no scope is set (nothing to verify)", async () => {
  const result = await defaultSetLeakage.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /no target scope/i);
  assert.match(result.message, /skipping/i);
});

test("passes on a clean zero — scope changes live only in real update sets", async () => {
  const updates = [
    update(NAMED_SET_ID, "widget-a"),
    // Another scope's change in the global Default is NOT this scope's leak.
    update(GLOBAL_DEFAULT_ID, "foreign", { application: OTHER_SCOPE_ID }),
  ];
  const result = await run(makeHttp({ updates }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /No changes in scope "x_acme_app"/);
  assert.match(result.message, /2 Default set\(s\) checked/);
});

test("fails when scope changes sit in the scope's Default set", async () => {
  const updates = [
    update(SCOPED_DEFAULT_ID, "widget-a"),
    // No target_name and no name: the label falls back to the sys_id.
    {
      sys_id: "u2",
      name: "",
      target_name: "",
      update_set: SCOPED_DEFAULT_ID,
      application: SCOPE_SYS_ID,
    },
    update(NAMED_SET_ID, "shipped-fine"),
  ];
  const result = await run(makeHttp({ updates }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /^2 change\(s\) in scope "x_acme_app"/);
  assert.match(result.message, /NOT ship/);
  assert.match(result.message, /"Default \[x_acme_app\]"/);
  assert.match(result.message, /"widget-a"/);
  assert.match(result.message, /"u2"/);
  assert.doesNotMatch(result.message, /shipped-fine/);
});

test("catches leakage into the GLOBAL Default set, not just the scope's own", async () => {
  const updates = [update(GLOBAL_DEFAULT_ID, "strayed-global")];
  const result = await run(makeHttp({ updates }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /"strayed-global"/);
  assert.match(result.message, /"Default"/);
});

test("bounds the fail sample to 5 names, deterministically sorted", async () => {
  // Seeded deliberately out of order: the message must sort, cap at 5, and
  // report the remainder — never echo instance row order.
  const names = ["upd-g", "upd-c", "upd-a", "upd-f", "upd-b", "upd-e", "upd-d"];
  const updates = names.map((n) => update(SCOPED_DEFAULT_ID, n));
  const result = await run(makeHttp({ updates }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /^7 change\(s\)/);
  assert.match(
    result.message,
    /"upd-a", "upd-b", "upd-c", "upd-d", "upd-e" \(\+2 more\)/,
  );
  assert.doesNotMatch(result.message, /upd-f|upd-g/);
});

test("still fails — with 'at least' — when the leak read is also trimmed", async () => {
  const updates = [update(SCOPED_DEFAULT_ID, "widget-a")];
  const result = await run(
    makeHttp({ updates, totalCounts: { sys_update_xml: 5 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /at least 1 change\(s\)/);
});

test("warns (never passes) on zero visible leaks with a trimmed sys_update_xml read (SN-1)", async () => {
  const result = await run(
    makeHttp({ updates: [], totalCounts: { sys_update_xml: 4 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /unverified/i);
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /not proof/i);
});

test("warns (never passes) when some Default sets are trimmed away (SN-1)", async () => {
  // 2 Default sets visible, but X-Total-Count says 5 match: hidden Default
  // sets may hold leaked work this account cannot inspect.
  const result = await run(
    makeHttp({ updates: [], totalCounts: { sys_update_set: 5 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /unverified/i);
  assert.match(result.message, /2 of 5 Default update set\(s\)/);
});

test("warns when no Default update set is visible at all", async () => {
  // Every instance carries at least the global "Default" set, so an empty
  // read means missing table access — never a pass.
  const result = await run(makeHttp({ sets: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /cannot verify/i);
  assert.match(result.message, /read access/i);
});

test("warns on a security-trimmed zero-row Default-set read (SN-1)", async () => {
  const result = await run(
    makeHttp({ sets: [], totalCounts: { sys_update_set: 3 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /security-trimmed/i);
  assert.match(result.message, /\b3\b/);
});

test("warns when a Default set row carries an unusable sys_id (not silently dropped)", async () => {
  const sets = [
    scopedDefault,
    // A sys_id the query builder would reject cannot be packed into the IN
    // clause — it must surface as unverified, never vanish.
    { sys_id: "bad id!", name: "Broken Default", is_default: "true" },
  ];
  const result = await run(makeHttp({ sets, updates: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /1 Default update set row\(s\)/);
  assert.match(result.message, /unusable sys_id/i);
});

test("filters sys_update_xml by the RESOLVED scope sys_id, unpaginated (SN-4)", async () => {
  const { http, calls } = tracked(
    makeHttp({ updates: [update(NAMED_SET_ID, "widget-a")] }),
  );
  const result = await run(http);
  assert.equal(result.status, "pass");

  const setReads = calls.filter((c) => c.table === "sys_update_set");
  assert.equal(setReads.length, 1);
  assert.equal(setReads[0].params.sysparm_query, "is_default=true");

  const xmlReads = calls.filter((c) => c.table === "sys_update_xml");
  assert.equal(xmlReads.length, 1);
  assert.match(xmlReads[0].params.sysparm_query, /update_setIN/);
  assert.match(
    xmlReads[0].params.sysparm_query,
    new RegExp(`\\^application=${SCOPE_SYS_ID}$`),
  );
  // No read pins a page size: the client auto-paginates, so leakage beyond a
  // single page is never silently truncated into a pass.
  const capped = calls.filter((c) => c.params?.sysparm_limit !== undefined);
  assert.deepEqual(capped, []);
});

test("falls back to the dot-walked application.scope filter when the scope does not resolve", async () => {
  const updates = [
    {
      sys_id: "u1",
      name: "sys_script_include_orphan",
      target_name: "orphan",
      update_set: GLOBAL_DEFAULT_ID,
      "application.scope": SCOPE,
    },
  ];
  const { http, calls } = tracked(makeHttp({ scopes: [], updates }));
  const result = await run(http);
  assert.equal(result.status, "fail");
  assert.match(result.message, /"orphan"/);

  const xmlReads = calls.filter((c) => c.table === "sys_update_xml");
  assert.match(
    xmlReads[0].params.sysparm_query,
    new RegExp(`\\^application\\.scope=${SCOPE}$`),
  );
});

test("filters by application=<sys_id> when an unresolved scope is itself a sys_id", async () => {
  const updates = [update(SCOPED_DEFAULT_ID, "widget-a")];
  const { http, calls } = tracked(makeHttp({ scopes: [], updates }));
  const result = await run(http, { scope: SCOPE_SYS_ID });
  assert.equal(result.status, "fail");

  const xmlReads = calls.filter((c) => c.table === "sys_update_xml");
  assert.match(
    xmlReads[0].params.sysparm_query,
    new RegExp(`\\^application=${SCOPE_SYS_ID}$`),
  );
});

test("batches the leak lookup into ⌈N/100⌉ membership queries (SN-6)", async () => {
  // 250 Default sets (one per scope on a busy instance) must cost 3 batched
  // `update_setIN…` reads, never 250 per-set queries.
  const sets = Array.from({ length: 250 }, (_, i) => ({
    sys_id: i.toString(16).padStart(32, "0"),
    name: `Default ${i}`,
    is_default: "true",
  }));
  const { http, calls } = tracked(makeHttp({ sets, updates: [] }));
  const result = await run(http);
  assert.equal(result.status, "pass");

  const xmlReads = calls.filter((c) => c.table === "sys_update_xml");
  assert.equal(xmlReads.length, 3);
  for (const r of xmlReads) {
    assert.match(r.params.sysparm_query, /update_setIN/);
    assert.doesNotMatch(r.params.sysparm_query, /update_set=/);
  }
});

test("rejects an operator-bearing scope before ANY query is issued (SR-1)", async () => {
  const { http, calls } = tracked(makeHttp());
  const result = await run(http, { scope: "x_acme^ORsys_id=1" });
  assert.equal(result.status, "warn");
  assert.match(result.message, /identifier|injection/i);
  assert.match(result.message, /unverified/i);
  // The builder failed closed: the malicious value never reached a query.
  assert.deepEqual(calls, []);
});

test("fails hard on an authentication error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication/i);
});

test("fails hard on a network error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /reach/i);
});

test("warns (unverified) on an HTTP error reading the tables", async () => {
  const result = await run(makeHttp({ fail: { http: 503 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 503/);
  assert.match(result.message, /unverified/i);
});

test("warns (unverified) on an unexpected non-JSON response error", async () => {
  // A hibernating PDI / SSO interstitial: 2xx with a non-JSON body.
  const result = await run(makeHttp({ fail: { response: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /unexpected error/i);
  assert.match(result.message, /unverified/i);
});

test("never throws — always returns a well-formed CheckResult", async () => {
  const result = await run(makeHttp({ fail: { http: 500 } }));
  assert.equal(result.name, "default-set-leakage");
  assert.ok(["pass", "warn", "fail"].includes(result.status));
  assert.equal(typeof result.message, "string");
  assert.ok(result.message.length > 0);
});
