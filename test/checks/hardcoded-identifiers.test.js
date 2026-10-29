import { test } from "node:test";
import assert from "node:assert/strict";

import { hardcodedIdentifiers } from "../../build/checks/hardcoded-identifiers.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const SYS_ID = "0123456789abcdef0123456789abcdef";

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

/**
 * A fake client seeded with `tables`; every scanned table reports a pre-trim
 * count equal to its seeded rows unless `totalCounts` overrides it (pass
 * `null` for a table to leave its count out — the "ambiguous" triage).
 */
function makeHttp({ tables = {}, totalCounts = {}, fail } = {}) {
  const counts = {};
  for (const t of TABLES) {
    const override = totalCounts[t];
    if (override === null) continue;
    counts[t] = override ?? tables[t]?.length ?? 0;
  }
  return createFakeSnClient({ tables, totalCounts: counts, fail });
}

function run(http, extra = {}) {
  return hardcodedIdentifiers.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

test("hardcoded-identifiers is registered with advisory rule 4.5 metadata", () => {
  assert.ok(defaultChecks.some((c) => c.name === "hardcoded-identifiers"));
  const { meta } = hardcodedIdentifiers;
  assert.equal(meta.rule, "4.5");
  assert.equal(meta.severity, "advisory");
  assert.ok(meta.tables.includes("sys_script_client"));
  assert.ok(meta.tables.includes("sys_ws_operation"));
  assert.equal(new Set(meta.tables).size, meta.tables.length);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.remediation, /sys_properties/);
});

test("warns when no scope is set", async () => {
  const result = await hardcodedIdentifiers.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.name, "hardcoded-identifiers");
  assert.equal(result.status, "warn");
  assert.match(result.message, /scope/i);
});

test("passes when the scope ships no scripts", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to scan/);
});

test("passes on clean scripts, ignoring instance and localhost URLs and comments", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script: [
          {
            sys_id: "b1",
            name: "Clean BR",
            script: [
              "var a = 'https://acme.service-now.com/api/now/table';",
              "var b = 'http://localhost:8080/x';",
              `// var legacy = '${SYS_ID}';`,
              "/* https://example.com/old",
              `   ${SYS_ID} */`,
              "var c = gs.getProperty('x_acme_app.endpoint');",
            ].join("\n"),
          },
        ],
        sys_ui_policy: [
          {
            sys_id: "p1",
            short_description: "Policy",
            script_true: "",
            script_false: "g_form.setVisible('a', true);",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(result.message, /2 script artifact\(s\)/);
});

test("warns on hard-coded sys_ids and URLs, naming field and line but not the text", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_include: [
          {
            sys_id: "i1",
            name: "AcmeUtil",
            script: `var x = 1;\nvar id = '${SYS_ID}';\nvar u = "https://api.example.com/v1";`,
          },
        ],
        sys_ui_action: [
          {
            sys_id: "a1",
            name: "Open Vendor",
            script: "",
            client_script: "window.open('http://vendor.example.org');",
          },
        ],
        sys_script_client: [
          {
            sys_id: "c1",
            name: "Fake Instance",
            script: "var u = 'https://evil.service-now.com.example.net/';",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /^4 hard-coded identifier\(s\) in 3 artifact\(s\): /,
  );
  assert.match(result.message, /AcmeUtil \(script:2, sys-id\)/);
  assert.match(result.message, /AcmeUtil \(script:3, url\)/);
  assert.match(result.message, /Open Vendor \(client_script:1, url\)/);
  assert.match(result.message, /Fake Instance \(script:1, url\)/);
  assert.doesNotMatch(result.message, new RegExp(SYS_ID));
  assert.doesNotMatch(result.message, /example\.(com|org|net)/);
});

test("caps the listed hits with an '… and N more' suffix", async () => {
  const body = Array.from({ length: 503 }, () => `x('${SYS_ID}');`).join("\n");
  const result = await run(
    makeHttp({
      tables: { sys_script: [{ sys_id: "b1", name: "Big", script: body }] },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /^503 hard-coded identifier\(s\) in 1 artifact\(s\)/,
  );
  assert.match(result.message, /… and 3 more/);
});

test("fails closed when a script table read is security-trimmed", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_script: 4 } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /sys_script\.script was security-trimmed/);
  assert.doesNotMatch(result.message, /Found so far/);
});

test("a trimmed read fails even with findings, and reports them", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_ui_script: [
          { sys_id: "u1", name: "Lib", script: `var a='${SYS_ID}';` },
        ],
      },
      totalCounts: { sys_ui_script: 3 },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /Found so far: 1 hard-coded identifier\(s\) in 1 artifact\(s\): Lib \(script:1, sys-id\)/,
  );
});

test("warns when a zero-row read is ambiguous", async () => {
  const onlyAmbiguous = await run(
    makeHttp({ totalCounts: { sysauto_script: null } }),
  );
  assert.equal(onlyAmbiguous.status, "warn");
  assert.match(onlyAmbiguous.message, /could not be confirmed/);
  assert.match(onlyAmbiguous.message, /sysauto_script\.script/);

  const withHits = await run(
    makeHttp({
      tables: {
        sys_script: [{ sys_id: "b1", name: "BR", script: `'${SYS_ID}'` }],
      },
      totalCounts: { sys_ws_operation: null },
    }),
  );
  assert.equal(withHits.status, "warn");
  assert.match(
    withHits.message,
    /BR \(script:1, sys-id\).*Not confirmed: .*sys_ws_operation\.operation_script/,
  );
});

test("maps auth, network and HTTP errors", async () => {
  const auth = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(auth.status, "fail");
  assert.match(auth.message, /Authentication failed/);

  const network = await run(
    makeHttp({ fail: { table: { sys_script: { network: true } } } }),
  );
  assert.equal(network.status, "warn");
  assert.match(network.message, /Could not reach/);

  const http = await run(
    makeHttp({ fail: { table: { sys_ui_policy: { http: 403 } } } }),
  );
  assert.equal(http.status, "warn");
  assert.match(http.message, /HTTP 403/);
});

test("emits one finding per hit with distinct ids and lines (F-R-2)", async () => {
  const http = makeHttp({
    tables: {
      sys_script: [
        {
          sys_id: "r1",
          name: "Two Hits",
          script:
            "var a = '0123456789abcdef0123456789abcdef';\nvar u = 'https://api.example.com/x';",
        },
      ],
    },
  });
  const result = await run(http);
  assert.equal(result.status, "warn", result.message);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["pattern:sys-id", "pattern:url"],
  );
  assert.deepEqual(
    result.findings.map((f) => f.location.line),
    [1, 2],
  );
  for (const f of result.findings) {
    assert.equal(f.location.table, "sys_script");
    assert.equal(f.location.sysId, "r1");
    assert.equal(f.location.recordName, "Two Hits");
    assert.match(f.id, /^f1:[0-9a-f]{16}$/);
  }
  assert.notEqual(result.findings[0].id, result.findings[1].id);
  assert.equal(result.findingsTruncated, undefined);
  // The row message is unchanged: findings ride alongside it.
  assert.doesNotMatch(result.message, /pattern:/);
});

test("a clean scan carries no findings (F-R-2)", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.equal(result.findings, undefined);
});
