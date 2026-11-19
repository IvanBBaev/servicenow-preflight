// RR-53 (AUDIT-2026-11-12 ST-6, ST-15, ST-16, ST-17): the doctor fails closed.
// A trimmed or refused required table fails the access row; a probe that
// proves nothing warns; the basic-auth row needs to see both switches and
// treats a passed enforcement date as enforced; the CI/CD row passes only on
// an expected status with a ServiceNow JSON body.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runPreflight } from "../build/index.js";
import { defaultChecks } from "../build/checks/index.js";
import { BASIC_AUTH_PROPERTIES, doctorChecks } from "../build/doctor.js";
import { createFakeSnClient } from "../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const BASIC = { kind: "basic", user: "ci.user", pass: "secret" };
const NOW = new Date("2026-06-01T12:00:00Z");
const PROBE = "GET /api/sn_cicd/progress/00000000000000000000000000000000";

/** A selected check that reads `tables`, `optional` among them. */
function reader(name, tables, optional = []) {
  return {
    name,
    description: name,
    meta: { tables, optionalTables: optional },
    run: () => ({ name, status: "pass", message: "" }),
  };
}

async function doctor(http, { selected = [], auth = BASIC, now = NOW } = {}) {
  const checks = doctorChecks({
    selected,
    version: "9.9.9",
    instanceSource: "flag",
    lookup: async () => ({ address: "127.0.0.1", family: 4 }),
    env: {},
    now: () => now,
  });
  const report = await runPreflight(
    { instanceUrl: INSTANCE, auth, http },
    checks,
  );
  return {
    report,
    row: (name) => report.results.find((r) => r.name === name),
  };
}

function props(values) {
  return Object.entries(values).map(([key, value], i) => ({
    sys_id: `p${i}`,
    name: BASIC_AUTH_PROPERTIES[key],
    value,
  }));
}

// --- ST-6 / ST-15: table access ---------------------------------------------

test("a table that answers no rows but counts matches fails as trimmed (ST-6)", async () => {
  const http = createFakeSnClient({ totalCounts: { u_audit: 500 } });
  const { row, report } = await doctor(http, {
    selected: [reader("u-check", ["u_audit"])],
  });
  const access = row("doctor-table-access");
  assert.equal(access.status, "fail", access.message);
  assert.match(
    access.message,
    /Read ACLs trim u_audit \(u-check; 500 matching rows\)/,
  );
  assert.equal(report.ok, false);
});

test("no rows and no X-Total-Count warns: access cannot be confirmed (ST-6)", async () => {
  const http = createFakeSnClient({
    requests: {
      "GET /api/now/table/u_audit": { status: 200, body: { result: [] } },
    },
  });
  const { row } = await doctor(http, {
    selected: [reader("u-check", ["u_audit"])],
  });
  const access = row("doctor-table-access");
  assert.equal(access.status, "warn", access.message);
  assert.match(access.message, /no rows and no X-Total-Count/);
  assert.match(access.message, /ask an admin to confirm/);
});

test("a genuinely empty table (count 0) and a readable row both pass", async () => {
  const http = createFakeSnClient({
    tables: { u_full: [{ sys_id: "a" }, { sys_id: "b" }] },
  });
  const { row } = await doctor(http, {
    selected: [reader("u-check", ["u_empty", "u_full"])],
  });
  const access = row("doctor-table-access");
  assert.equal(access.status, "pass", access.message);
  assert.match(access.message, /reads all 2 tables/);
});

test("a 2xx probe without a result array warns, never passes", async () => {
  const http = createFakeSnClient({
    requests: {
      "GET /api/now/table/u_audit": { status: 200, body: { oops: true } },
      "GET /api/now/table/u_gone": { status: 404, body: null },
    },
  });
  const { row } = await doctor(http, {
    selected: [reader("u-check", ["u_audit", "u_gone"])],
  });
  const access = row("doctor-table-access");
  assert.equal(access.status, "warn", access.message);
  assert.match(
    access.message,
    /u_audit \(u-check\): HTTP 200 without a result array/,
  );
  assert.match(access.message, /u_gone \(u-check\): HTTP 404/);
});

test("every default table refused fails the run (ST-15)", async () => {
  const fail = { forbidden: true };
  const http = createFakeSnClient({ fail });
  const { row, report } = await doctor(http, { selected: defaultChecks });
  const access = row("doctor-table-access");
  assert.equal(access.status, "fail", access.message);
  assert.match(access.message, /Read access refused \(HTTP 403\)/);
  assert.equal(report.ok, false);
});

test("a refused optional-only table warns; a refused required one fails (ST-15)", async () => {
  const optional = await doctor(
    createFakeSnClient({ fail: { table: { u_plugin: { forbidden: true } } } }),
    { selected: [reader("u-check", ["u_core", "u_plugin"], ["u_plugin"])] },
  );
  const soft = optional.row("doctor-table-access");
  assert.equal(soft.status, "warn", soft.message);
  assert.match(soft.message, /optional tables u_plugin \(u-check\)/);

  // A second reader that needs the same table makes it required.
  const required = await doctor(
    createFakeSnClient({ fail: { table: { u_plugin: { forbidden: true } } } }),
    {
      selected: [
        reader("u-check", ["u_core", "u_plugin"], ["u_plugin"]),
        reader("u-other", ["u_plugin"]),
      ],
    },
  );
  const hard = required.row("doctor-table-access");
  assert.equal(hard.status, "fail", hard.message);
  assert.match(hard.message, /u_plugin \(u-check, u-other\)/);
});

test("the access probe is one row of sys_id, by GET", async () => {
  const seen = [];
  const fake = createFakeSnClient({ tables: { u_audit: [{ sys_id: "a" }] } });
  const http = {
    ...fake,
    request(method, path, opts) {
      seen.push({ method, path, query: opts?.query });
      return fake.request(method, path, opts);
    },
  };
  await doctor(http, { selected: [reader("u-check", ["u_audit"])] });
  assert.deepEqual(seen, [
    {
      method: "GET",
      path: "/api/now/table/u_audit",
      query: { sysparm_limit: "1", sysparm_fields: "sys_id" },
    },
  ]);
});

// --- ST-16: basic-auth restriction -----------------------------------------

test("no visible restriction property warns instead of 'not active' (ST-16)", async () => {
  const { row } = await doctor(createFakeSnClient());
  const basic = row("doctor-basic-auth");
  assert.equal(basic.status, "warn", basic.message);
  assert.match(
    basic.message,
    /Cannot confirm whether the basic-auth API restriction is active/,
  );
  assert.match(basic.message, /ask an admin to confirm/);
});

test("only the enforcement date visible, still ahead: warns (ST-16)", async () => {
  const http = createFakeSnClient({
    tables: { sys_properties: props({ enforcementDate: "2027-01-01" }) },
  });
  const { row } = await doctor(http);
  const basic = row("doctor-basic-auth");
  assert.equal(basic.status, "warn", basic.message);
  assert.match(
    basic.message,
    /sees no .*restriction\.active or .*restriction\.enforce property/,
  );
});

test("a passed enforcement date means enforced, even with both switches off (ST-16)", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_properties: props({
        active: "false",
        enforce: "false",
        enforcementDate: "2026-01-01",
      }),
    },
  });
  const { row } = await doctor(http);
  const basic = row("doctor-basic-auth");
  assert.equal(basic.status, "warn", basic.message);
  assert.match(
    basic.message,
    /is enforced \(the enforcement date 2026-01-01 has passed\)/,
  );
});

test("an enforcement date of today counts as passed; a garbled one does not", async () => {
  const today = createFakeSnClient({
    tables: {
      sys_properties: props({
        active: "false",
        enforce: "false",
        enforcementDate: "2026-06-01 00:00:00",
      }),
    },
  });
  assert.match(
    (await doctor(today)).row("doctor-basic-auth").message,
    /has passed/,
  );
  const garbled = createFakeSnClient({
    tables: {
      sys_properties: props({
        active: "false",
        enforce: "false",
        enforcementDate: "2026-13-45",
      }),
    },
  });
  assert.equal((await doctor(garbled)).row("doctor-basic-auth").status, "pass");
});

test("both switches visible and off, date ahead: passes as not active", async () => {
  const http = createFakeSnClient({
    tables: {
      sys_properties: props({
        active: "false",
        enforce: "false",
        enforcementDate: "2027-01-01",
      }),
    },
  });
  const basic = (await doctor(http)).row("doctor-basic-auth");
  assert.equal(basic.status, "pass", basic.message);
  assert.match(
    basic.message,
    /not active on this instance \(enforcement date 2027-01-01\)/,
  );
});

test("a security-trimmed sys_properties read cannot prove 'not active'", async () => {
  const http = createFakeSnClient({
    tables: { sys_properties: props({ active: "false", enforce: "false" }) },
    totalCounts: { sys_properties: 3 },
  });
  const basic = (await doctor(http)).row("doctor-basic-auth");
  assert.equal(basic.status, "warn", basic.message);
  assert.match(basic.message, /read ACLs hide some sys_properties rows/);
});

// --- ST-17: CI/CD probe ----------------------------------------------------

const atf = defaultChecks.filter((c) => c.name === "atf-run");

async function cicd(response) {
  const http = createFakeSnClient({ requests: { [PROBE]: response } });
  return (await doctor(http, { selected: atf })).row("doctor-cicd");
}

test("the CI/CD probe warns on anything but an expected JSON answer (ST-17)", async () => {
  for (const response of [
    { status: 200, body: "<html>login</html>" },
    { status: 200, body: null },
    { status: 200, body: [] },
    { status: 400, body: { error: "bad" } },
    { status: 302, body: null },
    { status: 429, body: { error: { message: "Too many requests" } } },
    { status: 418, body: { result: {} } },
    {
      status: 404,
      body: { error: { message: "does not represent any resource" } },
    },
  ]) {
    const r = await cicd(response);
    assert.equal(r.status, "warn", `${JSON.stringify(response)}: ${r.message}`);
    assert.match(r.message, /did not answer \(HTTP \d+/);
    assert.match(r.message, /com\.glide\.continuousdelivery/);
  }
});

test("the CI/CD probe passes on a ServiceNow envelope at 200 / 400 / 404", async () => {
  for (const response of [
    { status: 200, body: { result: { status: "0" } } },
    { status: 400, body: { error: { message: "Invalid progress id" } } },
    { status: 404, body: { error: { message: "No record found" } } },
  ]) {
    const r = await cicd(response);
    assert.equal(r.status, "pass", `${JSON.stringify(response)}: ${r.message}`);
  }
});

// --- fake fidelity ---------------------------------------------------------

test("the fake serves a raw Table API GET from its tables with x-total-count", async () => {
  const http = createFakeSnClient({
    tables: { u_t: [{ sys_id: "a" }, { sys_id: "b" }, { sys_id: "c" }] },
    fail: { table: { u_denied: { forbidden: true } } },
  });
  const res = await http.request("GET", "/api/now/table/u_t", {
    query: { sysparm_limit: "1", sysparm_fields: "sys_id" },
  });
  assert.deepEqual(res, {
    status: 200,
    body: { result: [{ sys_id: "a" }] },
    headers: { "x-total-count": "3" },
  });
  await assert.rejects(
    http.request("GET", "/api/now/table/u_denied"),
    (err) => err.status === 403,
  );
  const other = await http.request("GET", "/api/now/table/u_t/a");
  assert.deepEqual(other, { status: 404, body: null });
});
