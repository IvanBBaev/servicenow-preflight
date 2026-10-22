import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatGitHubAnnotations,
  formatGitHubAnnotationsAll,
} from "../../build/report/github.js";
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

test("formatGitHubAnnotations emits ::error / ::warning, omits passes, summary last", () => {
  const out = formatGitHubAnnotations(
    summarize([pass("a"), fail("b", "broken"), warn("c", "careful")]),
  );
  assert.equal(
    out,
    [
      "::error title=b::broken",
      "::warning title=c::careful",
      "1 passed, 1 warnings, 1 failed",
      "",
    ].join("\n"),
  );
});

test("formatGitHubAnnotations with only passes prints just the summary", () => {
  assert.equal(
    formatGitHubAnnotations(summarize([pass("a"), pass("b")])),
    "2 passed, 0 warnings, 0 failed\n",
  );
});

test("formatGitHubAnnotations adds the instance to the title", () => {
  const out = formatGitHubAnnotations(summarize([fail("chk", "x")]), "dev");
  assert.match(out, /^::error title=chk \(dev\)::x$/m);
});

test("formatGitHubAnnotations annotates an unknown status as an error", () => {
  const out = formatGitHubAnnotations(
    summarize([{ name: "odd", status: "weird", message: "?" }]),
  );
  assert.match(out, /^::error title=odd::\?$/m);
});

const DATA_ESCAPES = [
  ["percent", "100%", "100%25"],
  ["CR", "a\rb", "a%0Db"],
  ["LF", "a\nb", "a%0Ab"],
  ["already-encoded text", "%0A", "%250A"],
  ["colon and comma kept in the message", "a: b, c", "a: b, c"],
];

for (const [label, input, expected] of DATA_ESCAPES) {
  test(`formatGitHubAnnotations escapes the message: ${label}`, () => {
    const [line] = formatGitHubAnnotations(summarize([fail("t", input)])).split(
      "\n",
    );
    assert.equal(line, `::error title=t::${expected}`);
  });
}

const PROPERTY_ESCAPES = [
  ["percent", "a%b", "a%25b"],
  ["CR", "a\rb", "a%0Db"],
  ["LF", "a\nb", "a%0Ab"],
  ["colon", "a:b", "a%3Ab"],
  ["comma", "a,b", "a%2Cb"],
];

for (const [label, input, expected] of PROPERTY_ESCAPES) {
  test(`formatGitHubAnnotations escapes the title: ${label}`, () => {
    const [line] = formatGitHubAnnotations(summarize([warn(input, "m")])).split(
      "\n",
    );
    assert.equal(line, `::warning title=${expected}::m`);
  });
}

test("formatGitHubAnnotations escapes the instance inside the title", () => {
  const out = formatGitHubAnnotations(summarize([fail("c", "m")]), "a:b,c");
  assert.match(out, /^::error title=c \(a%3Ab%2Cc\)::m$/m);
});

test("formatGitHubAnnotationsAll annotates every instance, then per-instance summaries", () => {
  const out = formatGitHubAnnotationsAll([
    { name: "dev", report: summarize([pass("a"), warn("b", "w")]) },
    { name: "prod", report: summarize([fail("a", "f")]) },
  ]);
  assert.equal(
    out,
    [
      "::warning title=b (dev)::w",
      "::error title=a (prod)::f",
      "dev: 1 passed, 1 warnings, 0 failed",
      "prod: 0 passed, 0 warnings, 1 failed",
      "",
    ].join("\n"),
  );
});

test("the GitHub formatters are part of the public API", () => {
  assert.equal(api.formatGitHubAnnotations, formatGitHubAnnotations);
  assert.equal(api.formatGitHubAnnotationsAll, formatGitHubAnnotationsAll);
});
