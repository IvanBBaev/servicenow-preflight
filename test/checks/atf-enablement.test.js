import { test } from "node:test";
import assert from "node:assert/strict";

import { atfEnablement } from "../../build/checks/atf-enablement.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const INSTANCE = "https://dev12345.service-now.com";
const AUTH = { kind: "basic", user: "admin", pass: "secret" };

/** The property row that enables ATF execution, with the given value. */
function enabledProperty(value) {
  return { sys_id: "prop1", name: "sn_atf.runner.enabled", value };
}

/** An ATF client test runner session row (sys_atf_agent). */
function agent(sysId, type, status) {
  return { sys_id: sysId, type, status };
}

/** Build a context around a fake client with the given fixtures/options. */
function ctx(fixtures = {}, options = undefined) {
  return {
    instanceUrl: INSTANCE,
    auth: AUTH,
    http: createFakeSnClient(fixtures),
    options,
  };
}

test("atfEnablement has the frozen name", () => {
  assert.equal(atfEnablement.name, "atf-enablement");
});

test("passes when sn_atf.runner.enabled is true", async () => {
  const result = await atfEnablement.run(
    ctx({ tables: { sys_properties: [enabledProperty("true")] } }),
  );
  assert.equal(result.name, "atf-enablement");
  assert.equal(result.status, "pass");
  assert.match(result.message, /enabled/);
});

test("normalises the property value (case / whitespace) before comparing", async () => {
  // Boolean.parseBoolean semantics: "TRUE" (any case, padded) still enables.
  const result = await atfEnablement.run(
    ctx({ tables: { sys_properties: [enabledProperty("  TRUE ")] } }),
  );
  assert.equal(result.status, "pass");
});

test("queries sys_properties by name through the validated builder", async () => {
  // The fake ignores sysparm_query unless a queryFilter enforces it; this
  // mirrors the real filter, so an unrelated property row is excluded by the
  // query itself and only the sn_atf.runner.enabled row decides the verdict.
  const result = await atfEnablement.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http: createFakeSnClient({
      tables: {
        sys_properties: [
          { sys_id: "other", name: "some.other.property", value: "false" },
          enabledProperty("true"),
        ],
      },
      queryFilter(table, rows, params) {
        if (table === "sys_properties") {
          assert.equal(params?.sysparm_query, "name=sn_atf.runner.enabled");
          return rows.filter((r) => r.name === "sn_atf.runner.enabled");
        }
        return rows;
      },
    }),
  });
  assert.equal(result.status, "pass");
});

test("fails when the property is explicitly false and a suite is configured", async () => {
  // A configured ATF suite means atf-run will actually try to execute, so a
  // disabled runner is a hard gate (OPP-2).
  const result = await atfEnablement.run(
    ctx(
      { tables: { sys_properties: [enabledProperty("false")] } },
      {
        atfSuiteId: "suite1",
      },
    ),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /explicitly "false"/);
  assert.match(result.message, /Enable the property/);
  assert.match(result.message, /atf-run cannot execute tests/);
});

test("fails closed when the property value is empty and a suite is configured", async () => {
  const result = await atfEnablement.run(
    ctx(
      { tables: { sys_properties: [enabledProperty("")] } },
      {
        atfSuites: ["suite1"],
      },
    ),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /empty/);
  assert.match(result.message, /evaluates as false/);
});

test("fails closed when the property value is unrecognised and a suite is configured", async () => {
  // The platform evaluates anything but "true" as false — "yes" disables ATF.
  const result = await atfEnablement.run(
    ctx(
      { tables: { sys_properties: [enabledProperty("yes")] } },
      {
        atfSuiteId: "suite1",
      },
    ),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /"yes"/);
  assert.match(result.message, /evaluates as false/);
});

test("warns (not fail) when ATF is disabled but no suite is configured for the run", async () => {
  // A disabled runner with no configured suite gates nothing — atf-run
  // warn-skips and burns no poll budget, so a default preflight must not go red
  // on instances that simply do not use ATF (OPP-2 false-fail fix).
  const result = await atfEnablement.run(
    ctx({ tables: { sys_properties: [enabledProperty("false")] } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /disabled/);
  assert.match(result.message, /No ATF suite is configured/);
});

test("re-arms the hard fail when a disabled instance carries a manifest suite", async () => {
  // The manifest path of resolveSuiteIds also counts as "ATF intended".
  const result = await atfEnablement.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http: createFakeSnClient({
      tables: { sys_properties: [enabledProperty("false")] },
    }),
    manifest: { suites: [{ id: "smoke", name: "Smoke", sysId: "sys-smoke" }] },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /explicitly "false"/);
});

test("warns (unverified) when the property row is not visible", async () => {
  const result = await atfEnablement.run(
    ctx({ tables: { sys_properties: [] } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /unverified/);
  assert.match(result.message, /not visible/);
});

test("warns (unverified) when sys_properties is security-trimmed (OPP-2)", async () => {
  // X-Total-Count says a row matches, but 0 are visible: the account is
  // ACL-trimmed. The check must say so explicitly, never pass or hard-fail.
  const result = await atfEnablement.run(
    ctx({
      tables: { sys_properties: [] },
      totalCounts: { sys_properties: 1 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /security-trimmed/);
  assert.match(result.message, /unverified/);
});

test("does not query sys_atf_agent when the client-runner gate is not configured", async () => {
  const queried = [];
  const http = createFakeSnClient({
    tables: { sys_properties: [enabledProperty("true")], sys_atf_agent: [] },
    queryFilter(table, rows) {
      queried.push(table);
      return rows;
    },
  });
  const result = await atfEnablement.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.status, "pass");
  assert.ok(!queried.includes("sys_atf_agent"));
});

test("skips the client-runner gate when requireClientTestRunner is false", async () => {
  // Explicitly-off gate is valid config: zero agents must not fail or warn.
  const result = await atfEnablement.run(
    ctx(
      {
        tables: {
          sys_properties: [enabledProperty("true")],
          sys_atf_agent: [],
        },
      },
      { atfEnablement: { requireClientTestRunner: false } },
    ),
  );
  assert.equal(result.status, "pass");
});

test("treats an empty atfEnablement object as gate-not-required (no warn noise)", async () => {
  const result = await atfEnablement.run(
    ctx(
      {
        tables: {
          sys_properties: [enabledProperty("true")],
          sys_atf_agent: [],
        },
      },
      { atfEnablement: {} },
    ),
  );
  assert.equal(result.status, "pass");
  assert.doesNotMatch(result.message, /malformed/);
});

test("passes and mentions the runner count when the gate finds online scheduled runners", async () => {
  const result = await atfEnablement.run(
    ctx(
      {
        tables: {
          sys_properties: [enabledProperty("true")],
          sys_atf_agent: [
            agent("a1", "scheduled", "online"),
            agent("a2", "scheduled", "online"),
          ],
        },
      },
      { atfEnablement: { requireClientTestRunner: true } },
    ),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /2 scheduled client test runner\(s\) online/);
});

test("fails when the gate is required and no scheduled runner is online", async () => {
  const result = await atfEnablement.run(
    ctx(
      {
        tables: {
          sys_properties: [enabledProperty("true")],
          sys_atf_agent: [],
        },
      },
      { atfEnablement: { requireClientTestRunner: true } },
    ),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /no scheduled client test runner is online/);
  assert.match(result.message, /Start a scheduled client test runner/);
});

test("filters agents to type=scheduled AND status=online via the query", async () => {
  // An offline scheduled runner and an online manual one must not satisfy the
  // gate; the queryFilter enforces the exact encoded query the check sends.
  const result = await atfEnablement.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http: createFakeSnClient({
      tables: {
        sys_properties: [enabledProperty("true")],
        sys_atf_agent: [
          agent("a1", "scheduled", "offline"),
          agent("a2", "manual", "online"),
        ],
      },
      queryFilter(table, rows, params) {
        if (table === "sys_atf_agent") {
          assert.equal(params?.sysparm_query, "type=scheduled^status=online");
          return rows.filter(
            (r) => r.type === "scheduled" && r.status === "online",
          );
        }
        return rows;
      },
    }),
    options: { atfEnablement: { requireClientTestRunner: true } },
  });
  assert.equal(result.status, "fail");
  assert.match(result.message, /no scheduled client test runner is online/);
});

test("warns (unverified) when sys_atf_agent is security-trimmed", async () => {
  const result = await atfEnablement.run(
    ctx(
      {
        tables: {
          sys_properties: [enabledProperty("true")],
          sys_atf_agent: [],
        },
        totalCounts: { sys_atf_agent: 3 },
      },
      { atfEnablement: { requireClientTestRunner: true } },
    ),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /security-trimmed/);
  assert.match(result.message, /unverified/);
});

test("warns when options.atfEnablement is not an object", async () => {
  const result = await atfEnablement.run(
    ctx(
      { tables: { sys_properties: [enabledProperty("true")] } },
      { atfEnablement: "yes" },
    ),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /malformed/);
});

test("warns and skips the gate when requireClientTestRunner is not a boolean", async () => {
  // Malformed gate config must never silently *enable* the gate: zero agents
  // here still yields a warn (about the option), not a runner fail.
  const result = await atfEnablement.run(
    ctx(
      {
        tables: {
          sys_properties: [enabledProperty("true")],
          sys_atf_agent: [],
        },
      },
      { atfEnablement: { requireClientTestRunner: "yes" } },
    ),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /malformed/);
});

test("a disabled property outranks a malformed option (fail wins)", async () => {
  const result = await atfEnablement.run(
    ctx(
      { tables: { sys_properties: [enabledProperty("false")] } },
      { atfEnablement: 42, atfSuiteId: "suite1" },
    ),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /disabled/);
});

test("maps SnAuthError to fail (never throws)", async () => {
  const result = await atfEnablement.run(
    ctx({ tables: { sys_properties: [] }, fail: { auth: true } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /uthentication/);
});

test("maps SnNetworkError to fail (never throws)", async () => {
  const result = await atfEnablement.run(
    ctx({ tables: { sys_properties: [] }, fail: { network: true } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Could not reach/);
});

test("maps an agent-read auth failure to fail (gate path)", async () => {
  const result = await atfEnablement.run(
    ctx(
      {
        tables: { sys_properties: [enabledProperty("true")] },
        fail: { table: { sys_atf_agent: { auth: true } } },
      },
      { atfEnablement: { requireClientTestRunner: true } },
    ),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /uthentication/);
});

test("maps an unexpected SnHttpError to warn (enablement unverified)", async () => {
  const result = await atfEnablement.run(
    ctx({ tables: { sys_properties: [] }, fail: { http: 500 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /unverified/);
});

test("maps an unknown error to warn with its message (never throws)", async () => {
  // A hand-rolled stub, because the fake only throws Sn* transport errors.
  const http = {
    table() {
      return {
        get() {
          return Promise.resolve(null);
        },
        query() {
          return Promise.resolve([]);
        },
        queryWithMeta() {
          return Promise.reject(new Error("boom"));
        },
      };
    },
    cicd: {
      runTestSuite() {
        return Promise.resolve({ status: "success" });
      },
    },
    request() {
      return Promise.resolve({ status: 404, body: null });
    },
  };
  const result = await atfEnablement.run({
    instanceUrl: INSTANCE,
    auth: AUTH,
    http,
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /Unexpected error/);
  assert.match(result.message, /boom/);
});

test("warns and skips when no credentials are configured", async () => {
  // An unconfigured run must warn-skip (connectivity-auth already names the
  // fix), never turn the default check set into a hard fail.
  const result = await atfEnablement.run({
    instanceUrl: INSTANCE,
    http: createFakeSnClient({ fail: { network: true } }),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No credentials configured/);
});

test("runs with a client certificate alone (mTLS identifies the caller)", async () => {
  // tls without auth is a legitimate identity — the guard must not skip it.
  const result = await atfEnablement.run({
    instanceUrl: INSTANCE,
    tls: { cert: "CERT", key: "KEY" },
    http: createFakeSnClient({
      tables: { sys_properties: [enabledProperty("true")] },
    }),
  });
  assert.equal(result.status, "pass");
});
