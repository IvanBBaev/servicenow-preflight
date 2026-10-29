import { test } from "node:test";
import assert from "node:assert/strict";

import { corsRules } from "../../build/checks/cors-rules.js";
import { defaultChecks } from "../../build/checks/index.js";
import { RULE_TITLES } from "../../build/catalogue.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const SENTINEL = "SENTINEL_9f3a";

/** Assemble a fake client from CORS rule fixtures plus options. */
function makeHttp({ rules = [], fail, totalCounts } = {}) {
  return createFakeSnClient({
    tables: { sys_cors_rule: rules },
    totalCounts,
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
  return corsRules.run({ instanceUrl: INSTANCE, http, scope: SCOPE, ...extra });
}

function rule(name, domain) {
  return { sys_id: `id-${name}`, name, domain, active: "true" };
}

test("cors-rules is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(corsRules));
  assert.equal(corsRules.name, "cors-rules");
});

test("meta declares rule 2.7, blocker severity, table and verdicts", () => {
  const meta = corsRules.meta;
  assert.equal(meta.rule, "2.7");
  assert.equal(meta.severity, "blocker");
  assert.deepEqual(meta.tables, ["sys_cors_rule"]);
  for (const v of ["pass", "warn", "fail"]) {
    assert.ok(meta.verdicts[v].length > 0);
  }
  assert.equal(
    RULE_TITLES["2.7"],
    "CORS rules name an exact origin (no wildcard)",
  );
});

test("warns when no scope is set", async () => {
  const result = await corsRules.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("reads active in-scope rules with the card's fields and no limit", async () => {
  const { http, calls } = tracked(
    makeHttp({ rules: [rule("Partner", "https://a.example.com")] }),
  );
  await run(http);
  const reads = calls.filter((c) => c.table === "sys_cors_rule");
  assert.equal(reads.length, 1);
  const params = reads[0].params;
  assert.match(params.sysparm_query, /\^active=true$/);
  assert.match(params.sysparm_query, /x_acme_app/);
  assert.equal(
    params.sysparm_fields,
    "sys_id,name,domain,rest_api,http_method,max_age,active",
  );
  assert.equal(params.sysparm_limit, undefined);
});

test("passes when every rule names an exact origin", async () => {
  const result = await run(
    makeHttp({
      rules: [
        rule("Partner", "https://app.customer.example.com"),
        rule("Portal", "portal.example.com"),
      ],
    }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /exact origin \(2 rule\(s\)\)/);
});

test("passes when the instance proves the scope ships no CORS rules", async () => {
  const result = await run(
    makeHttp({ rules: [], totalCounts: { sys_cors_rule: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /ships no CORS rules/);
});

for (const [label, domain] of [
  ["a bare *", "*"],
  ["a padded *", "  *  "],
  ["an empty domain", ""],
  ["a missing domain", undefined],
  ["*.com", "*.com"],
  ["*com", "*com"],
  ["https://*", "https://*"],
  ["https://*.com/", "https://*.com/"],
]) {
  test(`fails on ${label}`, async () => {
    const rules = [rule("Open Door", domain), rule("Partner", "a.example.com")];
    const result = await run(makeHttp({ rules }));
    assert.equal(result.status, "fail");
    assert.match(
      result.message,
      /^1 CORS rule\(s\) allow a wildcard origin: Open Door\./,
    );
    assert.doesNotMatch(result.message, /Partner/);
  });
}

test("warns on a wildcard sub-domain", async () => {
  const rules = [
    rule("Tenants", "*.example.com"),
    rule("Partner", "https://a.example.com"),
  ];
  const result = await run(makeHttp({ rules }));
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /^1 CORS rule\(s\) use a wildcard sub-domain: Tenants\./,
  );
});

test("a wildcard origin outranks a wildcard sub-domain", async () => {
  const rules = [rule("Tenants", "*.example.com"), rule("Open", "*")];
  const result = await run(makeHttp({ rules }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Open/);
});

test("falls back to sys_id when a rule has no name", async () => {
  const result = await run(
    makeHttp({ rules: [{ sys_id: "abc123", domain: "*" }] }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /abc123/);
});

test("never echoes the domain value", async () => {
  for (const domain of [
    `*.${SENTINEL}`,
    `https://*.${SENTINEL}.example.com`,
    `https://${SENTINEL}.example.com`,
  ]) {
    const result = await run(makeHttp({ rules: [rule("Rule", domain)] }));
    assert.doesNotMatch(result.message, new RegExp(SENTINEL), domain);
  }
});

test("fails on a security-trimmed zero-row read", async () => {
  const result = await run(
    makeHttp({ rules: [], totalCounts: { sys_cors_rule: 3 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
  assert.match(result.message, /\b3\b/);
});

test("a clean-looking but trimmed read fails", async () => {
  const result = await run(
    makeHttp({
      rules: [rule("Partner", "a.example.com")],
      totalCounts: { sys_cors_rule: 4 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /security-trimmed/);
});

test("a wildcard on a trimmed read fails with the incomplete note", async () => {
  const result = await run(
    makeHttp({ rules: [rule("Open", "*")], totalCounts: { sys_cors_rule: 4 } }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /Open/);
  assert.match(result.message, /may be incomplete/);
});

test("warns on an ambiguous zero-row read", async () => {
  const result = await run(makeHttp({ rules: [] }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /Cannot confirm/);
});

test("fails when authentication is rejected", async () => {
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
    makeHttp({ fail: { table: { sys_cors_rule: { http: 403 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /403/);
});

test("one finding per offending rule; a pass carries none", async () => {
  const rules = [
    rule("Open", "*"),
    rule("Tenants", `*.${SENTINEL}.example.com`),
    rule("Partner", "a.example.com"),
  ];
  const result = await run(makeHttp({ rules }));
  assert.equal(result.status, "fail");
  assert.deepEqual(
    result.findings.map((f) => [f.kind, f.location.sysId, f.status]),
    [
      ["wildcard-origin", "id-Open", undefined],
      ["wildcard-subdomain", "id-Tenants", "warn"],
    ],
  );
  for (const f of result.findings) {
    assert.equal(f.location.table, "sys_cors_rule");
    assert.doesNotMatch(JSON.stringify(f), new RegExp(SENTINEL));
  }

  const clean = await run(
    makeHttp({ rules: [rule("Partner", "a.example.com")] }),
  );
  assert.equal(clean.status, "pass");
  assert.equal(clean.findings, undefined);
});
