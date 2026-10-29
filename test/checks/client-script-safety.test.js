import { test } from "node:test";
import assert from "node:assert/strict";

import { clientScriptSafety } from "../../build/checks/client-script-safety.js";
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
  return clientScriptSafety.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

test("client-script-safety is registered with blocker rule 2.8 metadata", () => {
  assert.ok(defaultChecks.some((c) => c.name === "client-script-safety"));
  const { meta } = clientScriptSafety;
  assert.equal(meta.rule, "2.8");
  assert.equal(meta.severity, "blocker");
  assert.ok(meta.tables.includes("sys_script_client"));
  assert.ok(meta.tables.includes("sys_script_include"));
  assert.equal(new Set(meta.tables).size, meta.tables.length);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.remediation, /GlideAjax/);
});

test("warns when no scope is set", async () => {
  const result = await clientScriptSafety.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
  });
  assert.equal(result.name, "client-script-safety");
  assert.equal(result.status, "warn");
  assert.match(result.message, /scope/i);
});

test("passes when the scope ships no scripts", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to scan/);
});

test("passes on safe scripts; server GlideRecord and commented eval are fine", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          {
            sys_id: "c1",
            name: "onLoad",
            script:
              "function onLoad() {\n  // eval(x);\n  /* new GlideRecord('x')\n  */\n  var ga = new GlideAjax('x_acme_app.Util');\n}",
          },
        ],
        sys_script: [
          {
            sys_id: "b1",
            name: "BR",
            script:
              "var gr = new GlideRecord('incident');\nvar e = new GlideScopedEvaluator();",
          },
        ],
        sys_ui_action: [
          {
            sys_id: "a1",
            name: "Act",
            script: "current.update();",
            client_script: "",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "pass", result.message);
  // sys_ui_action is read once per side, so it counts in both scans.
  assert.match(result.message, /4 script artifact\(s\)/);
});

test("fails on client eval, Function constructor and GlideRecord, and on server evaluateScript", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          {
            sys_id: "c1",
            name: "Dyn",
            script:
              "var a = 1;\nvar r = eval(expr);\nvar f = new Function('return 1');",
          },
        ],
        sys_ui_policy: [
          {
            sys_id: "p1",
            short_description: "Policy GR",
            script_true: "",
            script_false: "x();\nvar gr = new GlideRecord('sys_user');",
          },
        ],
        sys_ui_action: [
          {
            sys_id: "a1",
            name: "Btn",
            script:
              "new GlideScopedEvaluator().evaluateScript(current, 'script');",
            client_script: "eval ( s );",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(
    result.message,
    /^5 unsafe dynamic-code or client GlideRecord use\(s\) in 3 artifact\(s\): /,
  );
  assert.match(result.message, /Dyn \(script:2, eval\)/);
  assert.match(result.message, /Dyn \(script:3, function-ctor\)/);
  assert.match(
    result.message,
    /Policy GR \(script_false:2, client-gliderecord\)/,
  );
  assert.match(result.message, /Btn \(client_script:1, eval\)/);
  assert.match(result.message, /Btn \(script:1, scoped-evaluator\)/);
  assert.doesNotMatch(result.message, /expr|sys_user|return 1/);
});

test("caps merged client and server hits at 500 with an '… and N more' suffix", async () => {
  const lines = (n, text) => Array.from({ length: n }, () => text).join("\n");
  const result = await run(
    makeHttp({
      tables: {
        sys_ui_script: [
          { sys_id: "u1", name: "Lib", script: lines(400, "eval(a);") },
        ],
        sys_script_include: [
          {
            sys_id: "i1",
            name: "Inc",
            script: lines(
              150,
              "new GlideScopedEvaluator().evaluateScript(gr, 'x');",
            ),
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "fail");
  assert.match(result.message, /^550 unsafe .* in 2 artifact\(s\)/);
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

  const withHit = await run(
    makeHttp({
      tables: {
        sys_script_client: [{ sys_id: "c1", name: "Dyn", script: "eval(x)" }],
      },
      totalCounts: { sys_script: 9 },
    }),
  );
  assert.equal(withHit.status, "fail");
  assert.match(
    withHit.message,
    /Dyn \(script:1, eval\).*sys_script\.script was security-trimmed/,
  );
});

test("warns when a zero-row read is ambiguous", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sys_transform_script: null } }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /could not be confirmed .*sys_transform_script\.script/,
  );
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

test("emits one finding per hit with distinct ids and lines (F-R-2)", async () => {
  const http = makeHttp({
    tables: {
      sys_script_client: [
        {
          sys_id: "r1",
          name: "Two Hits",
          script: "eval(a);\nvar g = new GlideRecord('incident');",
        },
      ],
    },
  });
  const result = await run(http);
  assert.equal(result.status, "fail", result.message);
  assert.equal(result.findings.length, 2);
  assert.deepEqual(
    result.findings.map((f) => f.kind),
    ["pattern:eval", "pattern:client-gliderecord"],
  );
  assert.deepEqual(
    result.findings.map((f) => f.location.line),
    [1, 2],
  );
  for (const f of result.findings) {
    assert.equal(f.location.table, "sys_script_client");
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

test("eval( inside a string or regex literal is not a finding (F-C-1)", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          {
            sys_id: "c1",
            name: "Lint",
            script:
              "var msg = 'never call eval(x)';\nvar re = /eval\\(/;\nvar t = `new Function(a)`;",
          },
        ],
      },
    }),
  );
  assert.equal(result.status, "pass", result.message);
});
