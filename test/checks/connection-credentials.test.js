import { test } from "node:test";
import assert from "node:assert/strict";

import { connectionCredentials } from "../../build/checks/connection-credentials.js";
import { defaultChecks } from "../../build/checks/index.js";
import { RULE_TITLES } from "../../build/catalogue.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const SENTINEL = "SENTINEL_9f3a";

const TABLES = [
  "discovery_credentials",
  "sys_rest_message",
  "sys_rest_message_fn",
  "sys_alias",
];

/** Every table proven empty unless a test overrides it. */
const EMPTY_COUNTS = Object.fromEntries(TABLES.map((t) => [t, 0]));

/** Assemble a fake client; `totalCounts` merges over the all-empty default. */
function makeHttp({
  creds = [],
  messages = [],
  fns = [],
  aliases = [],
  fail,
  totalCounts = {},
} = {}) {
  return createFakeSnClient({
    tables: {
      discovery_credentials: creds,
      sys_rest_message: messages,
      sys_rest_message_fn: fns,
      sys_alias: aliases,
    },
    totalCounts: { ...EMPTY_COUNTS, ...totalCounts },
    fail,
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

function run(http, extra = {}) {
  return connectionCredentials.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

function cred(name, cls = "basic_auth_credentials") {
  return {
    sys_id: `cred-${name}`,
    name,
    sys_class_name: cls,
    password: SENTINEL,
    user_name: SENTINEL,
  };
}

function message(name, endpoint) {
  return {
    sys_id: `msg-${name}`,
    name,
    rest_endpoint: endpoint,
    authentication_type: "basic",
  };
}

function fn(name, parent, endpoint) {
  return {
    sys_id: `fn-${name}`,
    rest_message: parent,
    function_name: name,
    rest_endpoint: endpoint,
  };
}

test("connection-credentials is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(connectionCredentials));
  assert.equal(connectionCredentials.name, "connection-credentials");
});

test("meta declares rule 1.7, blocker severity, tables and verdicts", () => {
  const meta = connectionCredentials.meta;
  assert.equal(meta.rule, "1.7");
  assert.equal(meta.severity, "blocker");
  assert.deepEqual(meta.tables, TABLES);
  for (const v of ["pass", "warn", "fail"]) {
    assert.ok(meta.verdicts[v].length > 0);
  }
  assert.equal(RULE_TITLES["1.7"], "No hard-coded secrets in artifacts");
});

test("warns when no scope is set", async () => {
  const result = await connectionCredentials.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("reads the four tables in scope with the card's fields and no limit", async () => {
  const { http, calls } = tracked(makeHttp());
  await run(http);
  const reads = calls.filter((c) => TABLES.includes(c.table));
  assert.deepEqual(
    reads.map((c) => c.table),
    TABLES,
  );
  const fields = Object.fromEntries(
    reads.map((c) => [c.table, c.params.sysparm_fields]),
  );
  assert.deepEqual(fields, {
    discovery_credentials: "sys_id,name,sys_class_name",
    sys_rest_message:
      "sys_id,name,rest_endpoint,authentication_type,basic_auth_profile,use_mid_server",
    sys_rest_message_fn:
      "sys_id,rest_message,function_name,rest_endpoint,authentication_type",
    sys_alias: "sys_id,name,type",
  });
  for (const c of reads) {
    assert.match(c.params.sysparm_query, /x_acme_app/);
    assert.equal(c.params.sysparm_limit, undefined);
    for (const secret of ["password", "api_key", "user_name"]) {
      assert.ok(
        !c.params.sysparm_fields.split(",").includes(secret),
        `${c.table} must not request ${secret}`,
      );
    }
  }
});

test("passes on a clean scope", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.equal(
    result.message,
    "No credential records and no hard-coded REST endpoints in scope.",
  );
  assert.equal(result.findings, undefined);
});

test("passes on alias-style endpoints and reports the alias count", async () => {
  const result = await run(
    makeHttp({
      messages: [
        message("Billing", "${x_acme_app.billing}"),
        message("Blank", ""),
      ],
      fns: [
        fn("get", "msg-Billing", "${rest_endpoint}/items"),
        fn("post", "msg-Billing", "https://${host}/api"),
      ],
      aliases: [{ sys_id: "a1", name: "billing", type: "connection" }],
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, / 1 connection alias\(es\) in scope\.$/);
});

test("fails when a credential record ships in the app", async () => {
  const result = await run(
    makeHttp({
      creds: [
        cred("Billing creds"),
        cred("Key", "api_key_credentials"),
        { sys_id: "cred-x" },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^3 credential record\(s\) ship in the app: Billing creds \(basic_auth_credentials\), Key \(api_key_credentials\), cred-x\.$/,
  );
  assert.equal(result.findings.length, 3);
  assert.equal(result.findings[0].kind, "credential-record");
  assert.equal(result.findings[0].location.table, "discovery_credentials");
  assert.ok(!result.message.includes(SENTINEL));
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});

test("warns on hard-coded REST message and function endpoints without echoing them", async () => {
  const url = `https://api.example.com/${SENTINEL}`;
  const result = await run(
    makeHttp({
      messages: [
        message("Billing", url),
        message("Aliased", "${x_acme_app.alias}"),
      ],
      fns: [
        fn("get", "msg-Billing", ` HTTP://${SENTINEL}.example.com`),
        fn("orphan", "msg-elsewhere", url),
        fn("ok", "msg-Aliased", ""),
      ],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /^3 REST message\/function\(s\) use a hard-coded endpoint instead of a Connection & Credential alias: Billing, Billing \(get\), msg-elsewhere \(orphan\)\.$/,
  );
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
  assert.ok(!result.message.includes("example.com"));
  assert.equal(result.findings.length, 3);
  for (const f of result.findings) {
    assert.equal(f.kind, "hard-coded-endpoint");
    assert.equal(f.status, "warn");
  }
  assert.deepEqual(
    result.findings.map((f) => f.location.table),
    ["sys_rest_message", "sys_rest_message_fn", "sys_rest_message_fn"],
  );
});

test("a credential record and a hard-coded endpoint together fail with both listed", async () => {
  const result = await run(
    makeHttp({
      creds: [cred("Billing creds")],
      messages: [message("Billing", "https://api.example.com")],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /1 credential record\(s\)/);
  assert.match(result.message, /1 REST message\/function\(s\)/);
  assert.equal(result.findings.length, 2);
});

test("a trimmed credential read fails", async () => {
  const result = await run(
    makeHttp({ totalCounts: { discovery_credentials: 2 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /discovery_credentials: 2 match in scope "x_acme_app" but 0 are visible \(security-trimmed\)/,
  );
});

test("a partially trimmed credential read with rows fails and notes the gap", async () => {
  const result = await run(
    makeHttp({
      creds: [cred("Visible")],
      totalCounts: { discovery_credentials: 3 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Visible \(basic_auth_credentials\)/);
  assert.match(result.message, /Not fully inspected: discovery_credentials/);
});

test("a trimmed REST message read warns", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_rest_message: 4 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /^Cannot fully confirm/);
  assert.match(result.message, /sys_rest_message: 4 match/);
});

test("a partially trimmed REST function read warns", async () => {
  const result = await run(
    makeHttp({
      fns: [fn("get", "m", "${alias}")],
      totalCounts: { sys_rest_message_fn: 5 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /sys_rest_message_fn: the read was security-trimmed/,
  );
});

test("a trimmed alias read warns", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_alias: 1 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /sys_alias: 1 match/);
});

test("an ambiguous zero-row read warns", async () => {
  const http = createFakeSnClient({
    tables: {},
    totalCounts: { sys_rest_message: 0, sys_rest_message_fn: 0, sys_alias: 0 },
  });
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /discovery_credentials: none visible in scope "x_acme_app" and no pre-trim count arrived/,
  );
});

test("an auth error fails", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Authentication failed/);
});

test("a network error warns", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /Could not reach the instance/);
});

test("an HTTP error warns", async () => {
  const result = await run(makeHttp({ fail: { http: 503 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 503/);
});

for (const [table, kind, status] of [
  ["discovery_credentials", { auth: true }, "fail"],
  ["discovery_credentials", { http: 403 }, "warn"],
  ["sys_rest_message", { network: true }, "warn"],
  ["sys_rest_message_fn", { http: 500 }, "warn"],
  ["sys_alias", { http: 403 }, "warn"],
  ["sys_alias", { response: true }, "fail"],
]) {
  test(`a forced ${Object.keys(kind)[0]} failure on ${table} → ${status}, other reads still run`, async () => {
    const { http, calls } = tracked(
      makeHttp({
        messages: [message("Billing", "${alias}")],
        fail: { table: { [table]: kind } },
      }),
    );
    const result = await run(http);
    assert.equal(result.status, status);
    assert.match(result.message, new RegExp(table));
    assert.deepEqual(
      calls.filter((c) => TABLES.includes(c.table)).map((c) => c.table),
      TABLES,
    );
  });
}

test("a per-table failure does not hide a credential finding", async () => {
  const result = await run(
    makeHttp({
      creds: [cred("Billing creds")],
      fail: { table: { sys_rest_message: { network: true } } },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /^1 credential record\(s\) ship in the app/);
  assert.match(result.message, /Not fully inspected: .*sys_rest_message/);
});

test("the sentinel never reaches any message", async () => {
  const url = `https://${SENTINEL}.example.com`;
  const result = await run(
    makeHttp({
      creds: [cred("C")],
      messages: [message("M", url)],
      fns: [fn("f", "msg-M", url)],
      aliases: [{ sys_id: "a", name: "x", type: SENTINEL }],
    }),
  );
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});
