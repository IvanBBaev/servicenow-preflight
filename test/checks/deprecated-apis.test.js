import { test } from "node:test";
import assert from "node:assert/strict";

import { deprecatedApis } from "../../build/checks/deprecated-apis.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

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
  return createFakeSnClient({ tables, totalCounts: counts, fail });
}

function run(http, extra = {}) {
  return deprecatedApis.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

test("deprecated-apis is registered with blocker metadata and no rule id", () => {
  assert.ok(defaultChecks.some((c) => c.name === "deprecated-apis"));
  const { meta } = deprecatedApis;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, undefined);
  assert.equal(meta.severity, "blocker");
  assert.ok(meta.tables.includes("sys_script_include"));
  assert.ok(meta.tables.includes("sys_ui_script"));
  assert.equal(new Set(meta.tables).size, meta.tables.length);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.remediation, /g_user\.hasRole/);
});

test("warns when no scope is set", async () => {
  const result = await deprecatedApis.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.name, "deprecated-apis");
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when the scope ships no scripts", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to scan/);
});

test("passes on modern code; async forms, comments and server gs.hasRole are fine", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          {
            sys_id: "c1",
            name: "onChange",
            script:
              "function onChange() {\n  // ga.getXMLWait();\n  /* g_form.getReference('caller')\n  */\n  ga.getXMLAnswer(cb);\n  g_form.getReference('caller_id', function (u) {});\n  g_user.hasRole('admin');\n}",
          },
        ],
        sys_script_include: [
          {
            sys_id: "i1",
            name: "Util",
            script:
              "if (gs.hasRole('admin')) {}\nvar myPackages = 1;\n// Packages.java.lang.System;",
          },
        ],
        sys_ui_action: [
          {
            sys_id: "a1",
            name: "Act",
            // Packages. on the client is not a server pattern; getXMLWait on
            // the server is not a client pattern.
            script: "ga.getXMLWait();",
            client_script: "Packages.foo;",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "pass", result.message);
  // sys_ui_action is read once per side, so it counts in both scans.
  assert.match(
    result.message,
    /across 4 script artifact\(s\) in scope "x_acme_app"/,
  );
});

test("warns on client-only synchronous and server-only calls", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          {
            sys_id: "c1",
            name: "Sync",
            script:
              "var ga = new GlideAjax('x');\nga.getXMLWait ();\nvar u = g_form.getReference('caller_id');\nif (gs.hasRole('itil_secret')) {}",
          },
        ],
        sys_ui_policy: [
          {
            sys_id: "p1",
            short_description: "Policy Ref",
            script_true: "",
            script_false: "x();\ng_form.getReference ( 'assigned_to' ) ;",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /^4 deprecated API call\(s\) in 2 artifact\(s\): /,
  );
  assert.doesNotMatch(result.message, /Packages\.\* \(not available/);
  assert.match(result.message, /Sync \(script:2, xml-wait\)/);
  assert.match(result.message, /Sync \(script:3, get-reference-sync\)/);
  assert.match(result.message, /Sync \(script:4, g-user-roles-sync\)/);
  assert.match(
    result.message,
    /Policy Ref \(script_false:2, get-reference-sync\)/,
  );
  assert.doesNotMatch(result.message, /caller_id|itil_secret|assigned_to/);
});

test("fails on a server Packages call, listing it before the client warnings", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          { sys_id: "c1", name: "Sync", script: "ga.getXMLWait();" },
        ],
        sys_script: [
          {
            sys_id: "b1",
            name: "Java BR",
            script: "var a = 1;\nvar f = new Packages.java.io.File('/etc/x');",
          },
        ],
        sys_ws_operation: [
          {
            sys_id: "w1",
            name: "GET items",
            operation_script: "Packages.com.glide.util.Log.info('m');",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^3 deprecated API call\(s\) in 3 artifact\(s\), 2 of them Packages\.\* \(not available in scoped apps\): Java BR \(script:2, packages\), GET items \(operation_script:1, packages\), Sync \(script:1, xml-wait\)\. /,
  );
  assert.doesNotMatch(result.message, /java\.io|\/etc\/x|Log\.info/);
});

test("caps merged hits at 500 with an '… and N more' suffix and keeps the fail", async () => {
  const lines = (n, text) => Array.from({ length: n }, () => text).join("\n");
  const result = await run(
    makeHttp({
      tables: {
        sys_script_include: [
          { sys_id: "i1", name: "Inc", script: lines(450, "Packages.x();") },
        ],
        sys_ui_script: [
          { sys_id: "u1", name: "Lib", script: lines(100, "ga.getXMLWait();") },
        ],
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^550 deprecated API call\(s\) in 2 artifact\(s\), 450 of them Packages/,
  );
  assert.match(result.message, /… and 50 more/);
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
          { sys_id: "c1", name: "Sync", script: "ga.getXMLWait();" },
        ],
      },
      totalCounts: { sys_script: 9 },
    }),
  );
  assert.equal(withHit.status, "fail");
  assert.match(
    withHit.message,
    /sys_script\.script was security-trimmed.*Found so far: 1 deprecated API call\(s\) in 1 artifact\(s\): Sync \(script:1, xml-wait\)/,
  );
});

test("warns when a zero-row read is ambiguous, with or without findings", async () => {
  const bare = await run(
    makeHttp({ totalCounts: { sys_transform_script: null } }),
  );
  assert.equal(bare.status, "warn");
  assert.match(
    bare.message,
    /could not be confirmed.*sys_transform_script\.script/,
  );

  const withHit = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          { sys_id: "c1", name: "Sync", script: "ga.getXMLWait();" },
        ],
      },
      totalCounts: { sys_ui_script: null },
    }),
  );
  assert.equal(withHit.status, "warn");
  assert.match(withHit.message, /Sync \(script:1, xml-wait\)/);
  assert.match(withHit.message, /Not confirmed: .*sys_ui_script\.script/);
});

test("maps auth, network and HTTP errors", async () => {
  const auth = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(auth.status, "fail");
  assert.match(auth.message, /Authentication failed/);

  const network = await run(
    makeHttp({ fail: { table: { sys_ui_script: { network: true } } } }),
  );
  assert.equal(network.status, "warn");
  assert.match(network.message, /Could not reach/);

  const http = await run(
    makeHttp({ fail: { table: { sys_ws_operation: { http: 500 } } } }),
  );
  assert.equal(http.status, "warn");
  assert.match(http.message, /HTTP 500/);
});
