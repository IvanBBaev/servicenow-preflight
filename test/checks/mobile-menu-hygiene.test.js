import { test } from "node:test";
import assert from "node:assert/strict";

import { mobileMenuHygiene } from "../../build/checks/mobile-menu-hygiene.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * The check queries `device_type=mobile` on both tables, so the filter honours
 * it — proving a browser-device menu seeded alongside never becomes a finding.
 */
function queryFilter(table, rows, params) {
  const q = params?.sysparm_query ?? "";
  if (/device_type=mobile/.test(q)) {
    return rows.filter((r) => r.device_type === "mobile");
  }
  return rows;
}

/** Assemble a fake client from menu / module fixtures plus options. */
function makeHttp({ menus = [], modules = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: {
      sys_app_application: menus,
      sys_app_module: modules,
    },
    queryFilter,
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return mobileMenuHygiene.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** Both zero-row reads proven genuinely empty by the instance. */
const PROVEN_EMPTY = { sys_app_application: 0, sys_app_module: 0 };

test("mobile-menu-hygiene keeps its registered name", async () => {
  const result = await run(makeHttp({ totalCounts: PROVEN_EMPTY }));
  assert.equal(result.name, "mobile-menu-hygiene");
});

test("warns when no scope is set", async () => {
  const result = await mobileMenuHygiene.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /scope/i);
});

test("passes when the instance proves the scope ships no mobile records", async () => {
  // A browser-device menu is seeded and must NOT count as a finding.
  const menus = [
    { sys_id: "m1", title: "Acme Desktop", device_type: "browser" },
  ];
  const result = await run(makeHttp({ menus, totalCounts: PROVEN_EMPTY }));
  assert.equal(result.status, "pass");
  assert.match(result.message, /No mobile Application Menus/);
});

test("warns (never passes) on an ambiguous zero-row read (SN-1)", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "warn");
  assert.match(result.message, /could not prove/i);
});

test("a proven-empty menu read still cannot vouch for an unproven module read", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sys_app_application: 0 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /sys_app_module/);
});

test("warns (advisory rule) on a security-trimmed zero-row read", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sys_app_application: 2, sys_app_module: 0 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /could not prove/i);
  assert.match(result.message, /sys_app_application/);
});

test("warns on a mobile Application Menu left in the app", async () => {
  const menus = [{ sys_id: "m1", title: "Acme Mobile", device_type: "mobile" }];
  const result = await run(
    makeHttp({ menus, totalCounts: { sys_app_module: 0 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /menu "Acme Mobile"/);
  assert.match(result.message, /remove or deactivate/i);
});

test("warns on a mobile Module left in the app", async () => {
  const modules = [
    { sys_id: "mod1", title: "Acme Mobile List", device_type: "mobile" },
  ];
  const result = await run(
    makeHttp({ modules, totalCounts: { sys_app_application: 0 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /module "Acme Mobile List"/);
});

test("counts menus and modules together and labels each kind", async () => {
  const menus = [{ sys_id: "m1", title: "Acme Mobile", device_type: "mobile" }];
  const modules = [
    { sys_id: "mod1", title: "Acme Mobile List", device_type: "mobile" },
  ];
  const result = await run(makeHttp({ menus, modules }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /2 mobile Application Menu\/Module record/);
  assert.match(result.message, /menu "Acme Mobile"/);
  assert.match(result.message, /module "Acme Mobile List"/);
});

test("findings on a trimmed read carry the incomplete-view note", async () => {
  const menus = [{ sys_id: "m1", title: "Acme Mobile", device_type: "mobile" }];
  const result = await run(
    makeHttp({
      menus,
      totalCounts: { sys_app_application: 6, sys_app_module: 0 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /menu "Acme Mobile"/);
  assert.match(result.message, /may be incomplete/i);
});

test("falls back to the name when a record has no title", async () => {
  const menus = [{ sys_id: "m1", name: "acme_mobile", device_type: "mobile" }];
  const result = await run(makeHttp({ menus }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /menu "acme_mobile"/);
});

test("fails (not passes) when authentication is rejected", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /authentication failed/i);
});

test("warns when the instance is unreachable", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /could not reach/i);
});

test("warns on an HTTP error from the table read", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sys_app_module: { http: 500 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /500/);
});
