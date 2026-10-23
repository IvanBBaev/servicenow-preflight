import { test } from "node:test";
import assert from "node:assert/strict";

import { logLeftovers } from "../../build/checks/log-leftovers.js";
import { defaultChecks } from "../../build/checks/index.js";
import { RULE_TITLES } from "../../build/catalogue.js";
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
  return logLeftovers.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

test("log-leftovers is registered with advisory rule 4.3 metadata", () => {
  assert.ok(defaultChecks.some((c) => c.name === "log-leftovers"));
  const { meta } = logLeftovers;
  assert.equal(meta.requires, "scope");
  assert.equal(meta.rule, "4.3");
  assert.equal(meta.severity, "advisory");
  assert.equal(typeof RULE_TITLES["4.3"], "string");
  assert.ok(meta.tables.includes("sys_script_client"));
  assert.ok(meta.tables.includes("sys_script"));
  assert.equal(new Set(meta.tables).size, meta.tables.length);
  for (const v of ["pass", "warn", "fail"]) assert.ok(meta.verdicts[v]);
  assert.match(meta.remediation, /jslog\(\)/);
  assert.match(meta.remediation, /gs\.info/);
});

test("warns when no scope is set", async () => {
  const result = await logLeftovers.run({
    instanceUrl: INSTANCE,
    http: makeHttp(),
    scope: "  ",
  });
  assert.equal(result.name, "log-leftovers");
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes when the scope ships no scripts", async () => {
  const result = await run(makeHttp());
  assert.equal(result.status, "pass");
  assert.match(result.message, /nothing to scan/);
});

test("passes on clean scripts; commented logs, gs.info and console on the server are fine", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          {
            sys_id: "c1",
            name: "onLoad",
            script:
              "function onLoad() {\n  // console.log(x);\n  /* alert('a')\n  */\n  jslog('ok');\n  showAlert(1);\n  console.error(e);\n}",
          },
        ],
        sys_script: [
          {
            sys_id: "b1",
            name: "BR",
            script: "gs.info('a');\ngs.warn('b');\n// gs.print(y);",
          },
        ],
        sys_ui_action: [
          {
            sys_id: "a1",
            name: "Act",
            // gs.log in the client script is not a server pattern, console.log
            // in the server script is not a client pattern.
            script: "console.log(current);",
            client_script: "gs.logError(x);",
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

test("warns on client console/alert and server gs.print/gs.log, never echoing the text", async () => {
  const result = await run(
    makeHttp({
      tables: {
        sys_script_client: [
          {
            sys_id: "c1",
            name: "Debug",
            script:
              "var a = 1;\nconsole.log('secretToken', a);\nconsole.debug (a);\nconsole.dir(a);",
          },
        ],
        sys_ui_policy: [
          {
            sys_id: "p1",
            short_description: "Policy Alert",
            script_true: "alert ('hello world');",
            script_false: "",
          },
        ],
        sys_ui_action: [
          {
            sys_id: "a1",
            name: "Btn",
            script: "x();\ngs.log('payload here');",
            client_script: "window.alert('x');",
          },
        ],
        sysauto_script: [
          { sys_id: "j1", name: "Nightly", script: "gs.print ( 'done' );" },
        ],
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /^7 log leftover\(s\) in 4 artifact\(s\): /);
  assert.match(result.message, /Debug \(script:2, console\)/);
  assert.match(result.message, /Debug \(script:3, console\)/);
  assert.match(result.message, /Debug \(script:4, console\)/);
  assert.match(result.message, /Policy Alert \(script_true:1, alert\)/);
  assert.match(result.message, /Btn \(client_script:1, alert\)/);
  assert.match(result.message, /Btn \(script:2, gs-log\)/);
  assert.match(result.message, /Nightly \(script:1, gs-log\)/);
  assert.match(result.message, /Use jslog\(\) on the client/);
  assert.doesNotMatch(result.message, /secretToken|hello world|payload|done/);
});

test("caps merged client and server hits at 500 with an '… and N more' suffix", async () => {
  const lines = (n, text) => Array.from({ length: n }, () => text).join("\n");
  const result = await run(
    makeHttp({
      tables: {
        sys_ui_script: [
          { sys_id: "u1", name: "Lib", script: lines(400, "console.log(a);") },
        ],
        sys_script_include: [
          { sys_id: "i1", name: "Inc", script: lines(150, "gs.log(a);") },
        ],
      },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /^550 log leftover\(s\) in 2 artifact\(s\)/);
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
          { sys_id: "c1", name: "Dbg", script: "console.log(x)" },
        ],
      },
      totalCounts: { sys_script: 9 },
    }),
  );
  assert.equal(withHit.status, "fail");
  assert.match(
    withHit.message,
    /sys_script\.script was security-trimmed.*Found so far: 1 log leftover\(s\) in 1 artifact\(s\): Dbg \(script:1, console\)/,
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
        sys_script: [{ sys_id: "b1", name: "BR", script: "gs.print(1);" }],
      },
      totalCounts: { sys_ui_script: null },
    }),
  );
  assert.equal(withHit.status, "warn");
  assert.match(withHit.message, /BR \(script:1, gs-log\)/);
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
