import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeResults } from "../build/summary.js";

test("summarizeResults counts pass/warn/fail and is ok without failures", () => {
  const report = summarizeResults([
    { name: "a", status: "pass", message: "ok" },
    { name: "b", status: "warn", message: "hmm" },
  ]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { pass: 1, warn: 1, fail: 0 });
  assert.equal(report.results.length, 2);
});

test("summarizeResults treats an unrecognised status as fail (P1-1, fail-closed)", () => {
  // The CLI's drift merge used to count any non-warn/non-fail status as pass,
  // so a bogus status produced `ok: true` on a promote gate.
  const report = summarizeResults([
    { name: "a", status: "pass", message: "ok" },
    { name: "bogus", status: "skipped", message: "did not run" },
    { name: "missing", status: undefined, message: "no status" },
  ]);
  assert.equal(report.ok, false);
  assert.deepEqual(report.summary, { pass: 1, warn: 0, fail: 2 });
  assert.equal(report.results[1].status, "fail");
  assert.match(
    report.results[1].message,
    /unrecognised status "skipped".*did not run/,
  );
  assert.equal(report.results[2].status, "fail");
  assert.match(report.results[2].message, /unrecognised status "undefined"/);
});

test("summarizeResults on no results is ok with an empty summary", () => {
  const report = summarizeResults([]);
  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, { pass: 0, warn: 0, fail: 0 });
});
