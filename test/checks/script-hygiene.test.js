import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scriptHygiene,
  isEmptyScript,
} from "../../build/checks/script-hygiene.js";
import { defaultChecks } from "../../build/checks/index.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";

/**
 * The scope read carries a scope term; the cross-scope clash read is a bare
 * `nameIN…`. `others` are Script Includes in other scopes — visible only to
 * the clash read, as on a real instance.
 */
function makeHttp({
  fixes = [],
  includes = [],
  others = [],
  fail,
  totalCounts,
} = {}) {
  return createFakeSnClient({
    tables: {
      sys_script_fix: fixes,
      sys_script_include: [...includes, ...others],
    },
    queryFilter(table, rows, params) {
      if (table !== "sys_script_include") return rows;
      const q = params?.sysparm_query ?? "";
      const inMatch = /(?:^|\^)nameIN([^^]+)/.exec(q);
      if (inMatch) {
        const names = new Set(
          inMatch[1].split(",").map((n) => n.toLowerCase()),
        );
        return rows.filter((r) => names.has(String(r.name).toLowerCase()));
      }
      return rows.filter((r) => !others.includes(r));
    },
    totalCounts,
    fail,
  });
}

function run(http, extra = {}) {
  return scriptHygiene.run({
    instanceUrl: INSTANCE,
    http,
    scope: SCOPE,
    ...extra,
  });
}

let seq = 0;
function fix(name, script) {
  seq += 1;
  return { sys_id: `f${seq}`, name, script };
}
function si(name, apiName = `${SCOPE}.${name}`) {
  seq += 1;
  return { sys_id: `s${seq}`, name, api_name: apiName };
}

// --- isEmptyScript ----------------------------------------------------------

test("isEmptyScript: empty, whitespace and comment-only scripts do nothing", () => {
  for (const s of [
    "",
    "   \n\t ",
    "// TODO: remove",
    "/* one-off fix, already applied */",
    "/**\n * multi\n * line\n */\n// and a line comment\n",
    "/* unterminated block comment",
    "(function() {\n  // nothing here\n})();",
    "(function () { /* noop */ })()",
  ]) {
    assert.equal(isEmptyScript(s), true, JSON.stringify(s));
  }
});

test("isEmptyScript: any real statement counts as work", () => {
  for (const s of [
    "gs.info('done');",
    "// fix\nvar gr = new GlideRecord('x_acme_app_asset');",
    "(function() { gs.info('x'); })();",
    'var url = "http://example.com"; // comment-like text in a string',
    'var a = "/*"; var b = "*/";',
    "(function(){})",
  ]) {
    assert.equal(isEmptyScript(s), false, JSON.stringify(s));
  }
});

// --- the check ---------------------------------------------------------------

test("is registered in the default suite", () => {
  assert.ok(defaultChecks.includes(scriptHygiene));
  assert.equal(scriptHygiene.name, "script-hygiene");
});

test("warns and skips when no scope is set", async () => {
  const result = await run(makeHttp(), { scope: "" });
  assert.equal(result.status, "warn");
  assert.match(result.message, /No scope set/);
});

test("passes with working Fix Scripts and uniquely named Script Includes", async () => {
  const result = await run(
    makeHttp({
      fixes: [fix("Backfill", "gs.info('x');")],
      includes: [si("AcmeUtil"), si("AcmeApi")],
    }),
  );
  assert.equal(result.status, "pass", result.message);
  assert.match(
    result.message,
    /All 1 Fix Script\(s\).*2 Script Include\(s\) have unique names/,
  );
});

test("warns (never fails) on a Fix Script that only has comments", async () => {
  const result = await run(
    makeHttp({
      fixes: [
        fix("Old cleanup", "// already run in 2024"),
        fix("Real", "gs.info(1);"),
      ],
      includes: [si("AcmeUtil")],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /1 Fix Script\(s\) do nothing.*Old cleanup/);
  assert.doesNotMatch(result.message, /Real/);
});

test("warns on Script Include names duplicated within the scope, case-insensitively", async () => {
  const result = await run(
    makeHttp({
      includes: [
        si("AcmeUtil"),
        si("acmeutil", "x_acme_app.acmeutil"),
        si("Other"),
      ],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /1 Script Include name\(s\) are used more than once in the scope: x_acme_app\.AcmeUtil \/ x_acme_app\.acmeutil/,
  );
});

test("warns on a Script Include name also used in another scope", async () => {
  const result = await run(
    makeHttp({
      includes: [si("ArrayUtil"), si("AcmeUtil")],
      others: [si("ArrayUtil", "global.ArrayUtil")],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(
    result.message,
    /1 Script Include name\(s\) are also used in another scope.*x_acme_app\.ArrayUtil ↔ global\.ArrayUtil/,
  );
  assert.doesNotMatch(result.message, /AcmeUtil ↔/);
});

test("a name outside the safe query charset is not cross-checked (and does not crash)", async () => {
  const result = await run(
    makeHttp({
      includes: [si("Acme$Util")],
      others: [si("Acme$Util", "global.Acme$Util")],
      totalCounts: { sys_script_fix: 0 },
    }),
  );
  assert.equal(result.status, "pass", result.message);
});

test("reports every finding kind together", async () => {
  const result = await run(
    makeHttp({
      fixes: [fix("Empty", "")],
      includes: [si("Dup"), si("Dup", "x_acme_app.Dup2"), si("ArrayUtil")],
      others: [si("ArrayUtil", "global.ArrayUtil")],
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Fix Script\(s\) do nothing/);
  assert.match(result.message, /used more than once/);
  assert.match(result.message, /also used in another scope/);
});

test("passes when the instance reports the scope ships neither", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sys_script_fix: 0, sys_script_include: 0 } }),
  );
  assert.equal(result.status, "pass");
  assert.match(result.message, /No Fix Scripts or Script Includes/);
});

test("warns (never fails) on a security-trimmed zero-row Fix Script read", async () => {
  const result = await run(
    makeHttp({ totalCounts: { sys_script_fix: 3, sys_script_include: 0 } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /sys_script_fix: 3 match .* but 0 are visible/);
});

test("warns on an ambiguous zero-row read", async () => {
  const result = await run(makeHttp({ totalCounts: { sys_script_fix: 0 } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /sys_script_include: none visible/);
});

test("warns on a trimmed cross-scope clash read even when nothing else is flagged", async () => {
  const result = await run(
    makeHttp({
      includes: [si("AcmeUtil")],
      totalCounts: { sys_script_fix: 0 },
    }),
  );
  // With no trimming this is a clean pass …
  assert.equal(result.status, "pass", result.message);
  // … but a trimmed read of sys_script_include cannot clear the name check.
  const trimmed = await run(
    makeHttp({
      includes: [si("AcmeUtil")],
      totalCounts: { sys_script_fix: 0, sys_script_include: 5 },
    }),
  );
  assert.equal(trimmed.status, "warn");
  assert.match(trimmed.message, /name-clash read was security-trimmed/);
});

test("findings under a trimmed read note what was not inspected", async () => {
  const result = await run(
    makeHttp({
      fixes: [fix("Empty", "")],
      totalCounts: { sys_script_fix: 4, sys_script_include: 0 },
    }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /Empty/);
  assert.match(result.message, /Not fully inspected: sys_script_fix/);
});

test("fails hard on an authentication error", async () => {
  const result = await run(makeHttp({ fail: { auth: true } }));
  assert.equal(result.status, "fail");
  assert.match(result.message, /Authentication failed/);
});

test("warns (degraded) on a network error", async () => {
  const result = await run(makeHttp({ fail: { network: true } }));
  assert.equal(result.status, "warn");
  assert.match(result.message, /Could not reach the instance/);
});

test("warns (degraded) on an HTTP error reading Fix Scripts", async () => {
  const result = await run(
    makeHttp({ fail: { table: { sys_script_fix: { http: 403 } } } }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.message, /HTTP 403/);
});
