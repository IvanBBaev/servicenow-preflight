import { test } from "node:test";
import assert from "node:assert/strict";

import { uiPageAcl } from "../../build/checks/ui-page-acl.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * Route the fake's single global query filter by table name. The ACL lookup
 * arrives as `type=ui_page^nameIN<a>,<b>,…` in chunked batches, so
 * `sys_security_acl` is filtered by type and by the batch's name membership —
 * case-insensitively, the way the real encoded-query `IN` matches.
 */
function queryFilter(table, rows, params) {
  if (table === "sys_security_acl") {
    const q = params?.sysparm_query ?? "";
    const inMatch = /nameIN([^^]+)/.exec(q);
    const type = /(?:^|\^)type=([^^]+)/.exec(q)?.[1];
    const names = inMatch
      ? new Set(inMatch[1].split(",").map((n) => n.toLowerCase()))
      : undefined;
    return rows.filter(
      (r) =>
        (type === undefined || r.type === type) &&
        (!names || names.has(String(r.name).toLowerCase())),
    );
  }
  return rows;
}

/** Assemble a fake client from UI Page / ACL fixtures plus options. */
function makeHttp({ pages = [], acls = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: { sys_ui_page: pages, sys_security_acl: acls },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return uiPageAcl.run({
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

/** A scoped UI Page: endpoint `<scope>_<name>.do`. */
function page(name, endpoint = `${SCOPE}_${name}.do`) {
  return { sys_id: `p_${name}`, name, endpoint };
}

/** A `ui_page` ACL. */
function acl(
  name,
  { operation = "read", active = true, type = "ui_page" } = {},
) {
  return {
    sys_id: `acl_${name}_${operation}_${type}`,
    name,
    type,
    operation,
    active: active ? "true" : "false",
  };
}

test("is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(uiPageAcl));
  assert.equal(uiPageAcl.name, "ui-page-acl");
});

test("warns and skips when no scope is set", async () => {
  const result = await run(makeHttp(), { scope: "" });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when every page has an active read ACL named for its endpoint", async () => {
  const result = await run(
    makeHttp({
      pages: [page("dashboard"), page("report")],
      acls: [acl("x_acme_app_dashboard"), acl("X_ACME_APP_REPORT")],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /All 2 UI Page\(s\)/);
});

test("fails a page with no read ACL, naming the page and the expected ACL", async () => {
  const result = await run(
    makeHttp({
      pages: [page("dashboard"), page("report")],
      acls: [acl("x_acme_app_dashboard")],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 UI Page\(s\) have no read ACL/);
  assert.match(result.message, /report \(x_acme_app_report\)/);
  assert.doesNotMatch(result.message, /dashboard/);
});

test("an ACL named for the bare page name does not cover a scoped endpoint", async () => {
  // A global page's ACL called "dashboard" must not clear x_acme_app_dashboard.
  const result = await run(
    makeHttp({ pages: [page("dashboard")], acls: [acl("dashboard")] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /dashboard \(x_acme_app_dashboard\)/);
});

test("falls back to the page name when no endpoint was read", async () => {
  const pass = await run(
    makeHttp({ pages: [page("legacy_page", "")], acls: [acl("legacy_page")] }),
  );
  assert.equal(pass.status, "pass", pass.message);
  const fail = await run(makeHttp({ pages: [page("legacy_page", "")] }));
  assert.equal(fail.status, "fail");
  // Label and ACL name coincide, so the name is not repeated in parentheses.
  assert.match(fail.message, /can open them: legacy_page\./);
});

test("strips the .do suffix case-insensitively", async () => {
  const result = await run(
    makeHttp({
      pages: [page("dashboard", "x_acme_app_dashboard.DO")],
      acls: [acl("x_acme_app_dashboard")],
    }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("an inactive read ACL does not cover the page and is called out", async () => {
  const result = await run(
    makeHttp({
      pages: [page("dashboard")],
      acls: [acl("x_acme_app_dashboard", { active: false })],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /only by an INACTIVE read ACL/);
});

test("an ACL of another operation or type does not count", async () => {
  const result = await run(
    makeHttp({
      pages: [page("dashboard")],
      acls: [
        acl("x_acme_app_dashboard", { operation: "write" }),
        acl("x_acme_app_dashboard", { type: "record" }),
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /have no read ACL/);
});

test("passes when the instance reports the scope ships no pages", async () => {
  const result = await run(
    makeHttp({ pages: [], totalCounts: { sys_ui_page: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /No UI Pages in scope/);
});

test("fails on a security-trimmed zero-row page read (SN-1)", async () => {
  const result = await run(
    makeHttp({ pages: [], totalCounts: { sys_ui_page: 2 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /2 match but 0 are visible/);
});

test("warns on an ambiguous zero-row page read (no pre-trim count)", async () => {
  const result = await run(makeHttp({ pages: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("fails on a partially trimmed page read even when every visible page is covered", async () => {
  const result = await run(
    makeHttp({
      pages: [page("dashboard")],
      acls: [acl("x_acme_app_dashboard")],
      totalCounts: { sys_ui_page: 4 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_ui_page read was security-trimmed/);
});

test("fails on a trimmed ACL read rather than trusting the visible ACLs", async () => {
  const result = await run(
    makeHttp({
      pages: [page("dashboard")],
      acls: [acl("x_acme_app_dashboard")],
      totalCounts: { sys_security_acl: 3 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_security_acl read was security-trimmed/);
});

test("a concrete gap outranks a trimmed read and notes the incomplete view", async () => {
  const result = await run(
    makeHttp({ pages: [page("dashboard")], totalCounts: { sys_ui_page: 5 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /have no read ACL/);
  assert.match(result.message, /may be incomplete/);
});

test("a page whose endpoint is not safely queryable fails as unverifiable", async () => {
  const result = await run(
    makeHttp({
      pages: [page("evil", "x_acme^ORname=x.do"), page("dashboard")],
      acls: [acl("x_acme_app_dashboard")],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 could not be verified/);
  assert.match(result.message, /evil/);
});

test("queries scope-filtered pages and type=ui_page ACLs by name, unpaged", async () => {
  const { http, calls } = tracked(
    makeHttp({
      pages: [page("dashboard")],
      acls: [acl("x_acme_app_dashboard")],
    }),
  );
  await run(http);
  const pageRead = calls.find((c) => c.table === "sys_ui_page");
  assert.match(pageRead.params.sysparm_query, /x_acme_app/);
  assert.equal(pageRead.params.sysparm_limit, undefined);
  const aclRead = calls.find((c) => c.table === "sys_security_acl");
  assert.equal(
    aclRead.params.sysparm_query,
    "type=ui_page^nameINx_acme_app_dashboard",
  );
  assert.equal(aclRead.params.sysparm_limit, undefined);
});

test("fails hard on an authentication error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Authentication failed/);
});

test("warns (degraded) on a network error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /Could not reach the instance/);
});

test("warns (degraded) on an HTTP error reading the ACL table", async () => {
  const result = await run(
    makeHttp({
      pages: [page("dashboard")],
      fail: { table: { sys_security_acl: { http: 403 } } },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
