import { test } from "node:test";
import assert from "node:assert/strict";

import { moduleRoles } from "../../build/checks/module-roles.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const MENU_OPEN = "1".repeat(32);
const MENU_GATED = "2".repeat(32);
const MENU_GONE = "3".repeat(32);

/** The menu lookup arrives as `sys_idIN<id>,<id>,…`. */
function queryFilter(table, rows, params) {
  if (table === "sys_app_application") {
    const m = /sys_idIN([^^]+)/.exec(params?.sysparm_query ?? "");
    if (!m) return rows;
    const ids = new Set(m[1].split(","));
    return rows.filter((r) => ids.has(r.sys_id));
  }
  return rows;
}

const MENUS = [
  { sys_id: MENU_OPEN, title: "Acme", roles: "" },
  { sys_id: MENU_GATED, title: "Acme Admin", roles: "x_acme_app.admin" },
];

function makeHttp({ modules = [], menus = MENUS, fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: { sys_app_module: modules, sys_app_application: menus },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return moduleRoles.run({
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

let seq = 0;
function mod(
  title,
  { roles = "", menu = MENU_OPEN, linkType = "LIST", override = false } = {},
) {
  seq += 1;
  return {
    sys_id: `m${seq}`,
    title,
    roles,
    application: menu,
    link_type: linkType,
    override_menu_roles: override ? "true" : "false",
  };
}

test("is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(moduleRoles));
  assert.equal(moduleRoles.name, "module-roles");
});

test("warns and skips when no scope is set", async () => {
  const result = await run(makeHttp(), { scope: "" });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when modules carry roles or sit under a role-gated menu", async () => {
  const result = await run(
    makeHttp({
      modules: [
        mod("Assets", { roles: "x_acme_app.user" }),
        mod("Settings", { menu: MENU_GATED }),
      ],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /All 2 active navigator module\(s\)/);
});

test("warns (never fails) on role-less modules under a role-less menu, grouped by menu", async () => {
  const result = await run(
    makeHttp({
      modules: [mod("Assets"), mod("Orders"), mod("Gated", { roles: "itil" })],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /2 module\(s\) under menu "Acme", which has no roles either — shown to every user: Assets, Orders/,
  );
  assert.doesNotMatch(result.message, /Gated/);
});

test("override_menu_roles without own roles is flagged even under a gated menu", async () => {
  const result = await run(
    makeHttp({
      modules: [mod("Bypass", { menu: MENU_GATED, override: true })],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /override the menu's roles but have none of their own: Bypass/,
  );
});

test("override_menu_roles WITH own roles is fine", async () => {
  const result = await run(
    makeHttp({
      modules: [
        mod("Own", { menu: MENU_GATED, override: true, roles: "itil" }),
      ],
    }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("a role-less module with no application menu is flagged", async () => {
  const result = await run(
    makeHttp({ modules: [mod("Orphan", { menu: "" })] }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /no roles and no application menu: Orphan/);
});

test("a menu that cannot be read leaves the module unverified", async () => {
  const result = await run(
    makeHttp({
      modules: [
        mod("Lost", { menu: MENU_GONE }),
        mod("Weird", { menu: "not-a-sys-id" }),
      ],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /2 role-less module\(s\) could not be verified/);
  assert.match(result.message, /\bLost\b/);
  assert.match(result.message, /\bWeird\b/);
});

test("separators are skipped", async () => {
  const result = await run(
    makeHttp({
      modules: [
        mod("----", { linkType: "SEPARATOR" }),
        mod("Real", { roles: "itil" }),
      ],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /All 1 active/);
});

test("a roles list of only commas counts as no roles, for modules and menus", async () => {
  const result = await run(
    makeHttp({
      modules: [mod("Blank", { roles: " , " })],
      menus: [{ sys_id: MENU_OPEN, title: "Acme", roles: "," }],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Blank/);
});

test("reads active scoped modules, then only the menus of role-less ones", async () => {
  const { http, calls } = tracked(
    makeHttp({
      modules: [mod("A"), mod("B", { roles: "itil", menu: MENU_GATED })],
    }),
  );
  await run(http);
  const modRead = calls.find((c) => c.table === "sys_app_module");
  assert.match(modRead.params.sysparm_query, /x_acme_app.*\^active=true$/);
  assert.equal(modRead.params.sysparm_limit, undefined);
  const menuRead = calls.find((c) => c.table === "sys_app_application");
  assert.equal(menuRead.params.sysparm_query, `sys_idIN${MENU_OPEN}`);
});

test("skips the menu lookup when every module has roles", async () => {
  const { http, calls } = tracked(
    makeHttp({ modules: [mod("A", { roles: "itil" })] }),
  );
  await run(http);
  assert.equal(
    calls.filter((c) => c.table === "sys_app_application").length,
    0,
  );
});

test("passes when the instance reports the scope ships no active modules", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_app_module: 0 } }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /No active navigator modules/);
});

test("warns (never fails) on a security-trimmed zero-row module read", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_app_module: 5 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /5 match but 0 are visible/);
});

test("warns on an ambiguous zero-row module read", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "warn");
  assert.match(result.message, /no pre-trim count arrived/);
});

test("warns on a trimmed menu read even when nothing else is flagged", async () => {
  const result = await run(
    makeHttp({
      modules: [mod("Settings", { menu: MENU_GATED })],
      totalCounts: { sys_app_application: 9 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /sys_app_application read was security-trimmed/);
});

test("findings under a trimmed module read carry the note", async () => {
  const result = await run(
    makeHttp({ modules: [mod("Assets")], totalCounts: { sys_app_module: 4 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Assets/);
  assert.match(
    result.message,
    /sys_app_module read was security-trimmed, so this may be incomplete/,
  );
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

test("warns (degraded) on an HTTP error reading the menus", async () => {
  const result = await run(
    makeHttp({
      modules: [mod("Assets")],
      fail: { table: { sys_app_application: { http: 403 } } },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
