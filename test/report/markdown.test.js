import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatMarkdown,
  formatMarkdownAll,
} from "../../build/report/markdown.js";
import * as api from "../../build/index.js";

function summarize(results) {
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const r of results) {
    if (r.status === "pass") summary.pass += 1;
    else if (r.status === "warn") summary.warn += 1;
    else summary.fail += 1;
  }
  return { ok: summary.fail === 0, results, summary };
}

const pass = (name, message = "ok") => ({ name, status: "pass", message });
const warn = (name, message = "hm") => ({ name, status: "warn", message });
const fail = (name, message = "bad") => ({ name, status: "fail", message });

/** The table rows (lines starting with `| ` after the header separator). */
function rows(md) {
  return md
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| | Check"));
}

test("formatMarkdown renders heading, bold summary and a table", () => {
  const md = formatMarkdown(
    summarize([pass("a"), warn("b"), fail("c", "broken")]),
    "dev",
  );
  const lines = md.split("\n");
  assert.equal(lines[0], "### servicenow-preflight — dev — ❌ failed");
  assert.equal(lines[2], "**1 passed, 1 warning, 1 failed**");
  assert.ok(md.includes("| | Check | Result |\n|---|---|---|\n"));
  assert.ok(md.includes("| ❌ | `c` | broken |"));
  assert.ok(md.endsWith("|\n"));
});

test("formatMarkdown defaults the target to 'preflight' and shows a pass verdict", () => {
  const md = formatMarkdown(summarize([pass("a"), warn("b"), warn("c")]));
  assert.match(md, /^### servicenow-preflight — preflight — ✅ passed\n/);
  assert.match(md, /\*\*1 passed, 2 warnings, 0 failed\*\*/);
});

test("formatMarkdown honours a custom title", () => {
  const md = formatMarkdown(summarize([pass("a")]), "test", {
    title: "Gate | prod",
  });
  assert.match(md, /^### Gate \\\| prod — test — ✅ passed/);
});

const ESCAPES = [
  ["pipe", "a|b", "a\\|b"],
  ["LF", "a\nb", "a b"],
  ["CRLF", "a\r\nb", "a b"],
  ["CR", "a\rb", "a b"],
  ["angle brackets", "<script>", "&lt;script&gt;"],
  ["backtick", "use `x`", "use 'x'"],
  ["acceptance case", "a|b\nc", "a\\|b c"],
];

for (const [label, input, expected] of ESCAPES) {
  test(`formatMarkdown escapes ${label} in a message`, () => {
    const md = formatMarkdown(summarize([fail("chk", input)]));
    const body = rows(md);
    assert.equal(body.length, 1, md);
    assert.equal(body[0], `| ❌ | \`chk\` | ${expected} |`);
  });
}

test("formatMarkdown escapes the check name inside its code span", () => {
  const md = formatMarkdown(summarize([fail("we`ird|name", "x")]));
  assert.equal(rows(md)[0], "| ❌ | `we'ird\\|name` | x |");
});

test("formatMarkdown orders fail → warn → pass, stable within a group", () => {
  const md = formatMarkdown(
    summarize([
      pass("p1"),
      warn("w1"),
      fail("f1"),
      pass("p2"),
      fail("f2"),
      warn("w2"),
    ]),
  );
  const names = rows(md).map((l) => l.split("`")[1]);
  assert.deepEqual(names, ["f1", "f2", "w1", "w2", "p1", "p2"]);
});

test("formatMarkdown renders an unknown status as a failure row, first", () => {
  const md = formatMarkdown(
    summarize([pass("p"), { name: "odd", status: "weird", message: "?" }]),
  );
  assert.deepEqual(rows(md), ["| ❌ | `odd` | ? |", "| ✅ | `p` | ok |"]);
});

test("formatMarkdown keeps up to five pass rows in the main table", () => {
  const results = [fail("f"), ...[1, 2, 3, 4, 5].map((n) => pass(`p${n}`))];
  const md = formatMarkdown(summarize(results));
  assert.ok(!md.includes("<details>"));
  assert.equal(rows(md).length, 6);
});

test("formatMarkdown folds more than five pass rows into <details>", () => {
  const results = [warn("w"), ...[1, 2, 3, 4, 5, 6].map((n) => pass(`p${n}`))];
  const md = formatMarkdown(summarize(results));
  const [main, folded] = md.split("<details>");
  assert.equal(rows(main).length, 1);
  assert.match(main, /`w`/);
  assert.match(folded, /^<summary>6 passed<\/summary>\n\n\| \| Check/);
  assert.equal(rows(folded).length, 6);
  assert.match(md, /<\/details>\n$/);
});

test("formatMarkdown with only passes over the threshold emits just <details>", () => {
  const results = [1, 2, 3, 4, 5, 6, 7].map((n) => pass(`p${n}`));
  const md = formatMarkdown(summarize(results));
  const [head] = md.split("<details>");
  assert.equal(rows(head).length, 0);
  assert.ok(!head.includes("| | Check"));
  assert.match(md, /<summary>7 passed<\/summary>/);
});

test("formatMarkdown handles an empty result list", () => {
  const md = formatMarkdown(summarize([]), "dev");
  assert.match(md, /\*\*0 passed, 0 warnings, 0 failed\*\*/);
  assert.match(md, /_No checks ran\._\n$/);
  assert.ok(!md.includes("| | Check"));
});

test("formatMarkdownAll leads with a roll-up and adds one block per instance", () => {
  const md = formatMarkdownAll([
    { name: "dev", report: summarize([pass("a")]) },
    { name: "test", report: summarize([fail("a")]) },
  ]);
  const lines = md.split("\n");
  assert.equal(lines[0], "**dev** ✅ · **test** ❌");
  const headings = lines.filter((l) => l.startsWith("### "));
  assert.deepEqual(headings, [
    "### servicenow-preflight — dev — ✅ passed",
    "### servicenow-preflight — test — ❌ failed",
  ]);
});

test("formatMarkdownAll passes the title option through", () => {
  const md = formatMarkdownAll(
    [{ name: "dev", report: summarize([pass("a")]) }],
    { title: "Gate" },
  );
  assert.match(md, /^### Gate — dev — ✅ passed$/m);
});

test("the Markdown formatters are part of the public API", () => {
  assert.equal(api.formatMarkdown, formatMarkdown);
  assert.equal(api.formatMarkdownAll, formatMarkdownAll);
});
