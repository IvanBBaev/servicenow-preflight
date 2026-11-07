import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SECRET_PATTERNS,
  secretInScripts,
} from "../../build/checks/secret-in-scripts.js";
import { defaultChecks } from "../../build/checks/index.js";
import { RULE_TITLES } from "../../build/catalogue.js";
import { createFakeSnClient } from "../../build/http/fake.js";
import { tablesInScope } from "../helpers/seed.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const SENTINEL = "SENTINEL_9f3a";

const TABLES = [
  "sys_script",
  "sys_script_include",
  "sys_ui_action",
  "sysauto_script",
  "sys_ws_operation",
  "sys_transform_map",
  "sys_transform_script",
  "sys_script_client",
  "sys_ui_script",
  "sys_ui_policy",
];

/** Fake client; each table's pre-trim count defaults to its seeded rows (`null` omits it). */
function makeHttp({ tables = {}, totalCounts = {}, fail } = {}) {
  const counts = {};
  for (const t of TABLES) {
    const override = totalCounts[t];
    if (override === null) continue;
    counts[t] = override ?? tables[t]?.length ?? 0;
  }
  return createFakeSnClient({
    tables: tablesInScope(tables, SCOPE, { active: "true" }),
    totalCounts: counts,
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
  return secretInScripts.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

/** Run the check over one Script Include holding `script`. */
function runScript(script) {
  return run(
    makeHttp({
      tables: { sys_script_include: [{ sys_id: "i1", name: "Util", script }] },
    }),
  );
}

// Token-shaped fixtures are assembled at run time so the source file itself
// never carries a literal that a secret scanner would flag.
const AWS_KEY = "AKIA" + "ABCDEFGHIJKLMNOP";
const GITHUB_TOKEN = "ghp_" + "a".repeat(36);
const SLACK_TOKEN = "xoxb-" + "1234567890-abc";
const PEM = "-----BEGIN RSA " + "PRIVATE KEY-----";
const JWT = "eyJ" + "hbGciOiJIUzI1" + "." + "eyJzdWIiOiIx" + ".sig";

test("secret-in-scripts is registered with blocker metadata and rule 1.7", () => {
  assert.ok(defaultChecks.some((c) => c.name === "secret-in-scripts"));
  const { meta } = secretInScripts;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, "1.7");
  assert.ok(RULE_TITLES["1.7"]);
  assert.equal(meta.severity, "blocker");
  for (const t of TABLES) assert.ok(meta.tables.includes(t), t);
  assert.equal(new Set(meta.tables).size, meta.tables.length);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.remediation, /Connection & Credential/);
  assert.deepEqual(
    SECRET_PATTERNS.map((p) => p.id),
    ["key-assign", "known-token-shape", "basic-auth-header"],
  );
});

test("warns when no scope is set", async () => {
  const result = await secretInScripts.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.name, "secret-in-scripts");
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when the scope ships no scripts", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to scan/);
  assert.equal(result.findings, undefined);
});

test("reads every source with the scope + active filter and no limit", async () => {
  const { http, calls } = tracked(makeHttp());
  await run(http);
  const tables = calls.map((r) => r.table);
  for (const t of TABLES) assert.ok(tables.includes(t), t);
  for (const r of calls.filter((x) => TABLES.includes(x.table))) {
    assert.match(r.params.sysparm_query, /active=true/);
    assert.equal(r.params.sysparm_limit, undefined);
    assert.match(r.params.sysparm_fields, /^sys_id,/);
  }
  const ui = calls.find((r) => r.table === "sys_ui_action");
  assert.equal(ui.params.sysparm_fields, "sys_id,name,script,client_script");
});

for (const [label, script] of [
  ['password = ""', 'var password = "";'],
  ["password = gs.getProperty(...)", "var password = gs.getProperty('x.pw');"],
  ["var tokenCount = 1", "var tokenCount = 1;"],
  ['"token=" + x in a URL builder', 'var url = base + "?token=" + x;'],
  ["a template built only from expressions", "var token = `${a}${b}`;"],
  ["a comparison", 'if (password == "abc") {}'],
  ["a commented-out assignment", `// var password = "${SENTINEL}";`],
  ["setBasicAuth with variables", "r.setBasicAuth(user, pass);"],
  ["a token shape outside a literal", "var AKIAX = 1; // " + AWS_KEY],
]) {
  test(`passes on ${label}`, async () => {
    const result = await runScript(script);
    assert.equal(result.status, "pass", result.message);
    assert.match(
      result.message,
      /No hard-coded secret pattern in any in-scope script/,
    );
    assert.equal(result.findings, undefined);
  });
}

for (const [id, script] of [
  ["key-assign", `var password = "${SENTINEL}";`],
  ["key-assign", `var cfg = { api_key: '${SENTINEL}' };`],
  ["key-assign", `client_secret = \`${SENTINEL}\`;`],
  ["key-assign", `var Token = " ${SENTINEL}";`],
  ["known-token-shape", `var k = "${AWS_KEY}";`],
  ["known-token-shape", `var k = '${GITHUB_TOKEN}';`],
  ["known-token-shape", `var k = "${SLACK_TOKEN}";`],
  ["known-token-shape", `var k = "${PEM}\\nMIIE${SENTINEL}";`],
  ["known-token-shape", `var k = \`${JWT}\`;`],
  ["basic-auth-header", `r.setBasicAuth("admin", pw);`],
  ["basic-auth-header", `r.setBasicAuth( '${SENTINEL}', pw);`],
]) {
  test(`fails on ${id}: ${script.slice(0, 24)}…`, async () => {
    const result = await runScript(script);
    assert.equal(result.status, "fail", result.message);
    assert.match(
      result.message,
      new RegExp(
        `^\\d+ possible hard-coded secret\\(s\\) in in-scope scripts: .*Util \\(script:1, ${id}\\)`,
      ),
    );
    assert.ok(result.findings.some((f) => f.kind === `pattern:${id}`));
    for (const text of [
      result.message,
      ...result.findings.map((f) => f.message),
    ]) {
      assert.ok(!text.includes(SENTINEL), text);
      for (const secret of [AWS_KEY, GITHUB_TOKEN, SLACK_TOKEN, PEM, JWT]) {
        assert.ok(!text.includes(secret), text);
      }
    }
  });
}

test("a private-key literal fails with the line, across client and server sources", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script: [
          {
            sys_id: "b1",
            name: "Signer",
            script: `function x() {\n  var key = "${PEM}";\n}`,
          },
        ],
        sys_ui_action: [
          {
            sys_id: "a1",
            name: "Act",
            script: "",
            client_script: `ga.addParam('k');\nvar secret = "${SENTINEL}";`,
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^2 possible hard-coded secret\(s\) in in-scope scripts: Signer \(script:2, known-token-shape\), Act \(client_script:2, key-assign\)\. Move secrets/,
  );
  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((f) => [f.location.table, f.location.line]),
    [
      ["sys_script", 2],
      ["sys_ui_action", 2],
    ],
  );
  assert.ok(!result.message.includes(SENTINEL));
});

test("fails closed on a security-trimmed read, with or without findings", async () => {
  const bare = await run(makeHttp({ totalCounts: { sys_ui_policy: 2 } }));
  assert.equal(bare.status, "fail");
  assert.match(bare.message, /^Cannot fully scan/);
  assert.match(
    bare.message,
    /sys_ui_policy\.script_true\/script_false was security-trimmed/,
  );
  assert.doesNotMatch(bare.message, /Found so far/);

  const withHit = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          { sys_id: "c1", name: "Leak", script: `var pwd = "${SENTINEL}";` },
        ],
      },
      totalCounts: { sys_script: 9 },
    }),
  );
  assert.equal(withHit.status, "fail");
  assert.match(
    withHit.message,
    /sys_script\.script was security-trimmed.*Found so far: 1 possible hard-coded secret\(s\) in in-scope scripts: Leak \(script:1, key-assign\)/,
  );
  assert.ok(!withHit.message.includes(SENTINEL));
});

test("warns when a zero-row read is ambiguous; a hit still fails", async () => {
  const bare = await run(
    makeHttp({ totalCounts: { sys_transform_script: null } }),
  );
  assert.equal(bare.status, "warn");
  assert.match(bare.message, /could not be confirmed/);
  assert.match(bare.message, /Not confirmed: .*sys_transform_script\.script/);

  const withHit = await run(
    makeHttp({
      tables: {
        sys_ui_script: [
          { sys_id: "u1", name: "Lib", script: `var k = "${AWS_KEY}";` },
        ],
      },
      totalCounts: { sys_ui_script: 1, sys_script: null },
    }),
  );
  assert.equal(withHit.status, "fail");
  assert.match(withHit.message, /Lib \(script:1, known-token-shape\)/);
  assert.match(withHit.message, /Not confirmed: .*sys_script\.script/);
});

test("maps auth, network and HTTP errors", async () => {
  const auth = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(auth.status, "error");

  const network = await run(
    makeHttp({ fail: { table: { sys_ui_script: { network: true } } } }),
  );
  assert.equal(network.status, "error");

  const http = await run(
    makeHttp({ fail: { table: { sys_ws_operation: { http: 500 } } } }),
  );
  assert.equal(http.status, "error");
  for (const r of [auth, network, http]) {
    assert.equal(r.name, "secret-in-scripts");
    assert.match(r.message, /hard-coded secrets in scripts/);
  }
});
