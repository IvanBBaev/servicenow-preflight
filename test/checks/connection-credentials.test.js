import { test } from "node:test";
import assert from "node:assert/strict";

import { connectionCredentials } from "../../build/checks/connection-credentials.js";
import { defaultChecks } from "../../build/checks/index.js";
import { RULE_TITLES } from "../../build/catalogue.js";
import { createFakeSnClient } from "../../build/http/fake.js";
import { inScope } from "../helpers/seed.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const SENTINEL = "SENTINEL_9f3a";

const TABLES = [
  "sys_db_object",
  "sys_metadata",
  "sys_metadata_link",
  "sys_rest_message",
  "sys_rest_message_fn",
  "sys_alias",
];

/** The scoped reads, proven empty unless a test overrides it. */
const EMPTY_COUNTS = Object.fromEntries(
  TABLES.filter((t) => t !== "sys_db_object").map((t) => [t, 0]),
);

/**
 * The credential class trees as `sys_db_object` rows: the four roots plus the
 * platform children, linked by `super_class` sys_id.
 */
const CLASS_ROWS = [
  { sys_id: "c_dc", name: "discovery_credentials" },
  { sys_id: "c_basic", name: "basic_auth_credentials", super_class: "c_dc" },
  { sys_id: "c_api", name: "api_key_credentials", super_class: "c_dc" },
  { sys_id: "c_oauth", name: "oauth_entity" },
  { sys_id: "c_pbasic", name: "sys_auth_profile_basic" },
  { sys_id: "c_poauth", name: "sys_auth_profile_oauth2" },
  { sys_id: "c_task", name: "task" },
  { sys_id: "c_inc", name: "incident", super_class: "c_task" },
];

/** Assemble a fake client; `totalCounts` merges over the all-empty default. */
function makeHttp({
  creds = [],
  links = [],
  classes = CLASS_ROWS,
  instanceCreds = [],
  messages = [],
  fns = [],
  aliases = [],
  fail,
  totalCounts = {},
} = {}) {
  return createFakeSnClient({
    tables: {
      sys_db_object: classes,
      sys_metadata: inScope(creds, SCOPE),
      sys_metadata_link: inScope(links, SCOPE),
      // The credential table itself: never read (ACL-5).
      discovery_credentials: instanceCreds,
      sys_rest_message: inScope(messages, SCOPE),
      sys_rest_message_fn: inScope(fns, SCOPE),
      sys_alias: inScope(aliases, SCOPE),
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

/** A shipped application file (`sys_metadata` row) of class `cls`. */
function cred(name, cls = "basic_auth_credentials") {
  return {
    sys_id: `cred-${name}`,
    sys_name: name,
    sys_class_name: cls,
    password: SENTINEL,
    user_name: SENTINEL,
    payload: SENTINEL,
  };
}

/** A data record added to the app (`sys_metadata_link` row) on `table`. */
function link(name, table, documentkey = `doc-${name}`) {
  return {
    sys_id: `link-${name}`,
    sys_name: name,
    tablename: table,
    documentkey,
    payload: SENTINEL,
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

test("walks the credential classes, then reads the scoped tables with the card's fields and no limit", async () => {
  const { http, calls } = tracked(makeHttp());
  await run(http);
  const classReads = calls.filter((c) => c.table === "sys_db_object");
  assert.deepEqual(
    classReads.map((c) => c.params.sysparm_query),
    [
      "nameINdiscovery_credentials,oauth_entity,sys_auth_profile_basic,sys_auth_profile_oauth2",
      "super_classINc_dc,c_oauth,c_pbasic,c_poauth",
      "super_classINc_basic,c_api",
    ],
  );
  const reads = calls.filter(
    (c) => TABLES.includes(c.table) && c.table !== "sys_db_object",
  );
  assert.deepEqual(
    reads.map((c) => c.table),
    TABLES.slice(1),
  );
  assert.equal(
    reads[0].params.sysparm_query,
    "sys_scope.scope=x_acme_app^sys_class_nameINdiscovery_credentials,oauth_entity,sys_auth_profile_basic,sys_auth_profile_oauth2,basic_auth_credentials,api_key_credentials",
  );
  assert.match(
    reads[1].params.sysparm_query,
    /\^tablenameINdiscovery_credentials,oauth_entity,.*api_key_credentials$/,
  );
  assert.equal(
    calls.filter((c) => c.table === "discovery_credentials").length,
    0,
  );
  const fields = Object.fromEntries(
    reads.map((c) => [c.table, c.params.sysparm_fields]),
  );
  assert.deepEqual(fields, {
    sys_metadata: "sys_id,sys_name,sys_class_name",
    sys_metadata_link: "sys_id,sys_name,tablename,documentkey",
    sys_rest_message:
      "sys_id,name,rest_endpoint,authentication_type,basic_auth_profile,use_mid_server",
    sys_rest_message_fn:
      "sys_id,rest_message,function_name,rest_endpoint,authentication_type",
    sys_alias: "sys_id,name,type",
  });
  for (const c of reads) {
    assert.match(c.params.sysparm_query, /x_acme_app/);
    assert.equal(c.params.sysparm_limit, undefined);
    for (const secret of [
      "password",
      "api_key",
      "user_name",
      "client_secret",
      "payload",
    ]) {
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
        { sys_id: "cred-x", sys_class_name: "discovery_credentials" },
      ],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^3 credential record\(s\) ship in the app: Billing creds \(basic_auth_credentials\), Key \(api_key_credentials\), cred-x \(discovery_credentials\)\.$/,
  );
  assert.equal(result.findings.length, 3);
  assert.equal(result.findings[0].kind, "credential-record");
  assert.equal(result.findings[0].location.table, "basic_auth_credentials");
  assert.equal(result.findings[0].location.sysId, "cred-Billing creds");
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
    /^3 REST message\/function\(s\) hard-code their endpoint host instead of taking it from a Connection & Credential alias: Billing, Billing \(get\), msg-elsewhere \(orphan\)\.$/,
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
  const result = await run(makeHttp({ totalCounts: { sys_metadata: 2 } }));
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /sys_metadata: 2 match in scope "x_acme_app" but 0 are visible \(security-trimmed\)/,
  );
});

test("a trimmed metadata-link read fails", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_metadata_link: 1 } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_metadata_link: 1 match/);
});

test("a partially trimmed credential read with rows fails and notes the gap", async () => {
  const result = await run(
    makeHttp({
      creds: [cred("Visible")],
      totalCounts: { sys_metadata: 3 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Visible \(basic_auth_credentials\)/);
  assert.match(result.message, /Not fully inspected: sys_metadata/);
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
    totalCounts: {
      sys_metadata_link: 0,
      sys_rest_message: 0,
      sys_rest_message_fn: 0,
      sys_alias: 0,
    },
  });
  const result = await run(http);
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /sys_metadata: none visible in scope "x_acme_app" and no pre-trim count arrived/,
  );
});

test("an auth error is an error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "error");
  assert.match(result.message, /Authentication failed/);
});

test("a network error is an error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "error");
  assert.match(result.message, /Could not reach the instance/);
});

test("an HTTP error is an error", async () => {
  const result = await run(makeHttp({ fail: { http: 503 } }));
  assert.equal(result.status, "error");
  assert.match(result.message, /HTTP 503/);
});

for (const [table, kind, status] of [
  ["sys_db_object", { auth: true }, "error"],
  ["sys_metadata", { auth: true }, "error"],
  // A 403 is an auth failure in production (SnAuthError): an error row (QA-1).
  ["sys_metadata_link", { http: 403 }, "error"],
  ["sys_rest_message", { network: true }, "error"],
  ["sys_rest_message_fn", { http: 500 }, "error"],
  ["sys_alias", { forbidden: true }, "error"],
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
      [
        ...new Set(
          calls.filter((c) => TABLES.includes(c.table)).map((c) => c.table),
        ),
      ],
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
  assert.equal(result.status, "error");
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

test("a credential on the instance that the app does not ship passes (ACL-5)", async () => {
  // The scope clause on the credential table proved nothing: every credential
  // matching it was reported as shipped, whatever app owns it.
  const instanceCreds = inScope([cred("Someone else's")], SCOPE);
  const result = await run(
    makeHttp({
      instanceCreds,
      totalCounts: { discovery_credentials: instanceCreds.length },
    }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("a credential added to the app as a data record fails (ACL-5)", async () => {
  const result = await run(
    makeHttp({
      // The credential table has no sys_scope column: only the link shows it ships.
      instanceCreds: [cred("Vendor login")],
      links: [
        link("Vendor login", "basic_auth_credentials", "cred-Vendor login"),
      ],
    }),
  );
  assert.equal(result.status, "fail", result.message);
  assert.match(
    result.message,
    /^1 credential record\(s\) ship in the app: Vendor login \(basic_auth_credentials\)\.$/,
  );
  assert.equal(result.findings[0].location.table, "sys_metadata_link");
  assert.ok(!JSON.stringify(result).includes(SENTINEL));
});

test("a record both shipped and linked counts once", async () => {
  const result = await run(
    makeHttp({
      creds: [cred("Key", "api_key_credentials")],
      links: [link("Key", "api_key_credentials", "cred-Key")],
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /^1 credential record\(s\)/);
  assert.equal(result.findings.length, 1);
});

test("an OAuth provider or basic-auth profile fails; an OAuth 2.0 profile warns (ACL-13)", async () => {
  const fails = await run(
    makeHttp({
      creds: [
        cred("Vendor OAuth", "oauth_entity"),
        cred("Vendor basic", "sys_auth_profile_basic"),
      ],
    }),
  );
  assert.equal(fails.status, "fail", fails.message);
  assert.match(
    fails.message,
    /2 credential record\(s\) ship in the app: Vendor OAuth \(oauth_entity\), Vendor basic \(sys_auth_profile_basic\)\./,
  );
  const warns = await run(
    makeHttp({ creds: [cred("Vendor profile", "sys_auth_profile_oauth2")] }),
  );
  assert.equal(warns.status, "warn", warns.message);
  assert.match(
    warns.message,
    /^1 OAuth 2\.0 profile\(s\) ship in the app .*: Vendor profile \(sys_auth_profile_oauth2\)\.$/,
  );
  assert.deepEqual(
    warns.findings.map((f) => [f.kind, f.status]),
    [["oauth2-profile", "warn"]],
  );
});

test("a record of a custom class deep in a credential tree fails", async () => {
  const result = await run(
    makeHttp({
      classes: [
        ...CLASS_ROWS,
        { sys_id: "c_x1", name: "x_acme_app_cred", super_class: "c_basic" },
        { sys_id: "c_x2", name: "x_acme_app_cred2", super_class: "c_x1" },
      ],
      creds: [cred("Deep", "x_acme_app_cred2"), cred("Task", "incident")],
    }),
  );
  assert.equal(result.status, "fail", result.message);
  assert.match(
    result.message,
    /^1 credential record\(s\) ship in the app: Deep \(x_acme_app_cred2\)\.$/,
  );
});

test("a trimmed class read fails closed", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sys_db_object: CLASS_ROWS.length + 5 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /sys_db_object: the credential class read was security-trimmed/,
  );
});

test("a class tree deeper than the walk follows fails closed", async () => {
  const chain = Array.from({ length: 11 }, (_, i) => ({
    sys_id: `c_d${i}`,
    name: `x_acme_app_d${i}`,
    super_class: i === 0 ? "c_basic" : `c_d${i - 1}`,
  }));
  const result = await run(makeHttp({ classes: [...CLASS_ROWS, ...chain] }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /deeper than 10 levels/);
});

test("a placeholder after a literal host is still a hard-coded endpoint (ACL-12)", async () => {
  const result = await run(
    makeHttp({
      messages: [
        message("Vendor", "https://api.vendor.example/v1/${path}"),
        message("Query", "http://api.vendor.example?x=${q}"),
        message("Aliased", "https://${host}/v1"),
      ],
    }),
  );
  assert.equal(result.status, "warn", result.message);
  assert.match(
    result.message,
    /hard-code their endpoint host .*: Vendor, Query\.$/,
  );
});
