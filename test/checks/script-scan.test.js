import { test } from "node:test";
import assert from "node:assert/strict";

import {
  codeLines,
  describeHits,
  scanScripts,
  MAX_SCAN_HITS,
} from "../../build/checks/script-scan.js";
import { createFakeSnClient } from "../../build/http/fake.js";

const CLAUSE = "sys_scope=0123456789abcdef0123456789abcdef";
const EVAL = { id: "eval", regex: /\beval\s*\(/ };
const SOURCE = {
  table: "sys_script",
  nameField: "name",
  scriptFields: ["script"],
};

function ctxFor(fixtures) {
  return { http: createFakeSnClient(fixtures) };
}

test("codeLines keeps line count and drops // comment lines", () => {
  const lines = codeLines("a();\n  // eval(x)\nb();");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "a();");
  assert.equal(lines[1].trim(), "");
  assert.equal(lines[2], "b();");
});

test("codeLines skips a block comment spanning lines, keeps code after it", () => {
  const lines = codeLines("x(); /* start\n eval(a)\n end */ eval(b);\nz();");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^x\(\);/);
  assert.doesNotMatch(lines[1], /eval/);
  assert.match(lines[2], /eval\(b\)/);
  assert.doesNotMatch(lines[2], /end/);
  assert.equal(lines[3], "z();");
});

test("codeLines treats comment markers inside strings as text", () => {
  const [line] = codeLines(
    "var u = 'https://x.example.com/*'; var v = \"//\";",
  );
  assert.match(line, /https:\/\/x\.example\.com\/\*/);
  assert.match(line, /var v = "\/\/";/);
  // Escaped quote stays inside the string; a trailing // comment is dropped.
  const [esc] = codeLines("var s = 'it\\'s // here'; // gone");
  assert.match(esc, /here'/);
  assert.doesNotMatch(esc, /gone/);
});

test("codeLines: backslash in code escapes, strings end at newline, templates span", () => {
  assert.doesNotMatch(codeLines("var r = /\\/\\//; eval(1);")[0], /^$/);
  assert.match(codeLines("var r = /\\/\\//; eval(1);")[0], /eval/);
  const unterminated = codeLines("var a = 'open\n// comment\neval(2)");
  assert.equal(unterminated[1].trim(), "");
  assert.match(unterminated[2], /eval/);
  const tpl = codeLines("var t = `a\n// not a comment\n`; c();");
  assert.match(tpl[1], /not a comment/);
  assert.match(tpl[2], /c\(\)/);
  assert.deepEqual(codeLines("a\r\nb"), ["a", "b"]);
});

test("scanScripts reports artifact, field and line — never the matched text", async () => {
  const ctx = ctxFor({
    tables: {
      sys_script: [
        {
          sys_id: "s1",
          name: "BR One",
          script: "a();\n/* eval(x)\n*/\n  eval(y);",
        },
        { sys_id: "s2", name: "", script: "ok();" },
        { sys_id: "s3", name: "Empty", script: "   " },
      ],
    },
    totalCounts: { sys_script: 3 },
  });
  const res = await scanScripts(ctx, CLAUSE, [SOURCE], [EVAL]);
  assert.equal(res.scanned, 3);
  assert.deepEqual(res.trimmed, []);
  assert.deepEqual(res.ambiguous, []);
  assert.equal(res.dropped, 0);
  assert.deepEqual(res.hits, [
    {
      table: "sys_script",
      sysId: "s1",
      name: "BR One",
      field: "script",
      line: 4,
      patternId: "eval",
    },
  ]);
  assert.deepEqual(res.artifacts, ["sys_script:s1"]);
  assert.equal(describeHits(res.hits), "BR One (script:4, eval)");
});

test("scanScripts builds a scoped, active-only query with the source fields", async () => {
  const seen = [];
  const ctx = ctxFor({
    tables: { sys_ui_policy: [] },
    totalCounts: { sys_ui_policy: 0 },
    queryFilter(table, rows, params) {
      seen.push({ table, params });
      return rows;
    },
  });
  const res = await scanScripts(
    ctx,
    CLAUSE,
    [
      {
        table: "sys_ui_policy",
        nameField: "short_description",
        scriptFields: ["script_true", "script_false"],
        extraQuery: "run_scripts=true",
      },
    ],
    [EVAL],
  );
  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].params.sysparm_query,
    `${CLAUSE}^active=true^run_scripts=true`,
  );
  assert.equal(
    seen[0].params.sysparm_fields,
    "sys_id,short_description,script_true,script_false",
  );
  assert.equal(res.scanned, 0);
  assert.deepEqual(res.ambiguous, []);
});

test("scanScripts collects trimmed and ambiguous sources", async () => {
  const ctx = ctxFor({
    tables: {
      sys_script: [],
      sys_script_include: [],
      sys_ui_script: [{ sys_id: "u1", name: "U", script: "x" }],
    },
    totalCounts: { sys_script: 4, sys_ui_script: 2 },
  });
  const res = await scanScripts(
    ctx,
    CLAUSE,
    [
      SOURCE,
      {
        table: "sys_script_include",
        nameField: "name",
        scriptFields: ["script"],
      },
      { table: "sys_ui_script", nameField: "name", scriptFields: ["script"] },
    ],
    [EVAL],
  );
  assert.deepEqual(res.trimmed, ["sys_script.script", "sys_ui_script.script"]);
  assert.deepEqual(res.ambiguous, ["sys_script_include.script"]);
  assert.equal(res.scanned, 1);
});

test("scanScripts caps hits at MAX_SCAN_HITS and counts the rest", async () => {
  const body = Array.from({ length: MAX_SCAN_HITS + 7 }, () => "eval(1);").join(
    "\n",
  );
  const ctx = ctxFor({
    tables: { sys_script: [{ sys_id: "s1", name: "Big", script: body }] },
    totalCounts: { sys_script: 1 },
  });
  const res = await scanScripts(
    ctx,
    CLAUSE,
    [SOURCE],
    [{ id: "eval", regex: /eval/g }],
  );
  assert.equal(res.hits.length, MAX_SCAN_HITS);
  assert.equal(res.dropped, 7);
  assert.deepEqual(res.artifacts, ["sys_script:s1"]);
  assert.match(
    describeHits(res.hits.slice(0, 1), res.dropped),
    /^Big \(script:1, eval\), … and 7 more$/,
  );
});

test("scanScripts unwraps non-string field values and labels by sys_id", async () => {
  const ctx = ctxFor({
    tables: {
      sys_script: [
        { sys_id: "s9", script: { value: "eval(z)" } },
        { script: "eval(q)" },
      ],
    },
    totalCounts: { sys_script: 2 },
  });
  const res = await scanScripts(ctx, CLAUSE, [SOURCE], [EVAL]);
  assert.deepEqual(
    res.hits.map((h) => h.name),
    ["s9", "(unnamed)"],
  );
  assert.deepEqual(res.artifacts, ["sys_script:s9", "sys_script:(unnamed)"]);
});
