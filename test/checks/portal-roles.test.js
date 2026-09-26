import { test } from "node:test";
import assert from "node:assert/strict";

import { portalRoles } from "../../build/checks/portal-roles.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/** Assemble a fake client from widget / page fixtures plus options. */
function makeHttp({ widgets = [], pages = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: { sp_widget: widgets, sp_page: pages },
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return portalRoles.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** Wrap a fake client so every `queryWithMeta` call is recorded. */
function tracked(http) {
  const calls = [];
  return {
    http: {
      ...http,
      table(name) {
        const t = http.table(name);
        return {
          get: (id, params) => t.get(id, params),
          query: (params) => t.query(params),
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

function widget(name, { roles = "", isPublic = false } = {}) {
  return {
    sys_id: `w_${name}`,
    name,
    id: name.toLowerCase().replace(/\s+/g, "-"),
    roles,
    public: isPublic ? "true" : "false",
  };
}

function page(id, { roles = "", isPublic = false } = {}) {
  return {
    sys_id: `p_${id}`,
    id,
    title: `Title ${id}`,
    roles,
    public: isPublic ? "true" : "false",
  };
}

test("is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(portalRoles));
  assert.equal(portalRoles.name, "portal-roles");
});

test("warns and skips when no scope is set", async () => {
  const result = await run(makeHttp(), { scope: "" });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when every widget and page carries a role", async () => {
  const result = await run(
    makeHttp({
      widgets: [widget("Asset List", { roles: "x_acme_app.user" })],
      pages: [page("acme_home", { roles: "x_acme_app.user,x_acme_app.admin" })],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /All 1 widget\(s\) and 1 page\(s\)/);
});

test("warns on a role-less widget and page, never failing", async () => {
  const result = await run(
    makeHttp({
      widgets: [widget("Asset List"), widget("Gated", { roles: "itil" })],
      pages: [page("acme_home")],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /1 widget\(s\) with no roles — open to every logged-in user: Asset List/,
  );
  assert.match(result.message, /1 page\(s\) with no roles.*acme_home/);
  assert.doesNotMatch(result.message, /Gated/);
  assert.match(result.message, /record why each is deliberately open/);
});

test("calls out role-less PUBLIC widgets and pages separately", async () => {
  const result = await run(
    makeHttp({
      widgets: [widget("Landing Banner", { isPublic: true })],
      pages: [page("acme_public", { isPublic: true }), page("acme_private")],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /1 public widget\(s\) with no roles — reachable without logging in: Landing Banner/,
  );
  assert.match(result.message, /1 public page\(s\) with no roles.*acme_public/);
  assert.match(
    result.message,
    /1 page\(s\) with no roles — open to every logged-in user: acme_private/,
  );
});

test("a public widget WITH roles is not flagged", async () => {
  const result = await run(
    makeHttp({
      widgets: [widget("Banner", { roles: "snc_external", isPublic: true })],
      totalCounts: { sp_page: 0 },
    }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("a roles list of only commas and blanks counts as no roles", async () => {
  const result = await run(
    makeHttp({ widgets: [widget("Blank Roles", { roles: " , ," })] }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Blank Roles/);
});

test("labels fall back to id, then title/sys_id", async () => {
  const result = await run(
    makeHttp({
      widgets: [
        {
          sys_id: "w9",
          name: "",
          id: "fallback-id",
          roles: "",
          public: "false",
        },
      ],
      pages: [
        {
          sys_id: "p9",
          id: "",
          title: "Only Title",
          roles: "",
          public: "false",
        },
      ],
    }),
  );
  assert.match(result.message, /fallback-id/);
  assert.match(result.message, /Only Title/);
});

test("passes when the instance reports the scope ships no widgets or pages", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sp_widget: 0, sp_page: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /No Service Portal widgets or pages/);
});

test("warns (never fails) on a security-trimmed zero-row read", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sp_widget: 4, sp_page: 0 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /sp_widget: 4 match .* but 0 are visible/);
});

test("warns on an ambiguous zero-row read", async () => {
  const result = await run(makeHttp({ totalCounts: { sp_widget: 0 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /sp_page: none visible/);
});

test("warns on a partially trimmed read even when every visible row has roles", async () => {
  const result = await run(
    makeHttp({
      widgets: [widget("W", { roles: "itil" })],
      pages: [page("p", { roles: "itil" })],
      totalCounts: { sp_page: 3 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /sp_page: the read was security-trimmed/);
});

test("findings under a trimmed read note what was not inspected", async () => {
  const result = await run(
    makeHttp({
      widgets: [widget("Open")],
      totalCounts: { sp_widget: 5, sp_page: 0 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Open/);
  assert.match(result.message, /Not fully inspected: sp_widget/);
});

test("reads both tables with the scope filter, unpaged", async () => {
  const { http, calls } = tracked(
    makeHttp({ totalCounts: { sp_widget: 0, sp_page: 0 } }),
  );
  await run(http);
  assert.deepEqual(
    calls.map((c) => c.table),
    ["sp_widget", "sp_page"],
  );
  for (const c of calls) {
    assert.match(c.params.sysparm_query, /x_acme_app/);
    assert.equal(c.params.sysparm_limit, undefined);
  }
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

test("warns (degraded) on an HTTP error reading sp_page", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sp_page: { http: 403 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
