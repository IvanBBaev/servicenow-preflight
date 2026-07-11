import { test } from "node:test";
import assert from "node:assert/strict";

import { formatJUnit, formatJUnitSuites } from "../../build/report/junit.js";

/** A report with a mix of pass / warn / fail results plus XML-hostile chars. */
function mixedReport() {
  return {
    ok: false,
    results: [
      { name: "instanceUrlConfigured", status: "pass", message: "ok" },
      {
        name: "scopeExists",
        status: "warn",
        message: "scope <default> not pinned & maybe wrong",
      },
      {
        name: "updateSetOpen",
        status: "fail",
        message: 'update set "prod" is closed',
      },
    ],
    summary: { pass: 1, warn: 1, fail: 1 },
  };
}

test("formatJUnit emits a well-formed XML prolog and testsuite roots", () => {
  const xml = formatJUnit(mixedReport());
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(xml, /<testsuites\b[^>]*>/);
  assert.match(xml, /<\/testsuites>\s*$/);
  assert.match(xml, /<testsuite\b[^>]*>/);
  assert.match(xml, /<\/testsuite>/);
});

test("formatJUnit sets tests and failures counts on the testsuite", () => {
  const xml = formatJUnit(mixedReport());
  // 3 results total, exactly 1 fail.
  assert.match(xml, /<testsuite[^>]*\btests="3"/);
  assert.match(xml, /<testsuite[^>]*\bfailures="1"/);
});

test("formatJUnit renders one testcase per result", () => {
  const xml = formatJUnit(mixedReport());
  const opens = xml.match(/<testcase\b/g) ?? [];
  assert.equal(opens.length, 3);
});

test("formatJUnit maps fail -> <failure> with the message", () => {
  const xml = formatJUnit(mixedReport());
  assert.match(xml, /<testcase name="updateSetOpen"[^>]*>/);
  assert.match(xml, /<failure message="[^"]*update set/);
  // Exactly one <failure> for the single failing check.
  const failures = xml.match(/<failure\b/g) ?? [];
  assert.equal(failures.length, 1);
});

test("formatJUnit maps warn -> passing testcase with a system-out note", () => {
  const xml = formatJUnit(mixedReport());
  assert.match(xml, /<testcase name="scopeExists"[^>]*>[\s\S]*?<system-out>/);
  // A warn must NOT be counted as a failure.
  const failures = xml.match(/<failure\b/g) ?? [];
  assert.equal(failures.length, 1);
});

test("formatJUnit maps pass -> plain testcase (no failure, no system-out)", () => {
  const xml = formatJUnit(mixedReport());
  const passCase = xml.match(/<testcase name="instanceUrlConfigured"[^>]*\/>/);
  assert.ok(passCase, "pass result should be a self-closed testcase");
});

test("formatJUnit escapes XML special characters in messages", () => {
  const xml = formatJUnit(mixedReport());
  // The raw hostile chars from the warn/fail messages must be escaped.
  assert.ok(!/scope <default>/.test(xml), "unescaped '<' leaked into output");
  assert.match(xml, /scope &lt;default&gt; not pinned &amp; maybe wrong/);
  assert.match(xml, /update set &quot;prod&quot; is closed/);
});

test("formatJUnit escapes special characters in the check name too", () => {
  const xml = formatJUnit({
    ok: false,
    results: [{ name: 'check <a> & "b"', status: "fail", message: "boom" }],
    summary: { pass: 0, warn: 0, fail: 1 },
  });
  assert.match(xml, /name="check &lt;a&gt; &amp; &quot;b&quot;"/);
});

test("formatJUnit strips XML-1.0-illegal control characters from messages", () => {
  // NUL, SOH and a vertical tab are forbidden by XML 1.0 even when escaped;
  // tab (\t) and newline (\n) are legal and must survive.
  const xml = formatJUnit({
    ok: false,
    results: [
      {
        name: "atfRun",
        status: "fail",
        message: "line1\u0000\u0001\u000Bline2\tkept\nkept",
      },
    ],
    summary: { pass: 0, warn: 0, fail: 1 },
  });
  for (const ch of ["\u0000", "\u0001", "\u000B"]) {
    assert.ok(
      !xml.includes(ch),
      "an illegal control character leaked into the XML",
    );
  }
  // The surrounding text and the legal whitespace are preserved.
  assert.match(xml, /line1line2\tkept\nkept/);
});

test("formatJUnit handles an empty report", () => {
  const xml = formatJUnit({
    ok: true,
    results: [],
    summary: { pass: 0, warn: 0, fail: 0 },
  });
  assert.match(xml, /<testsuite[^>]*\btests="0"/);
  assert.match(xml, /<testsuite[^>]*\bfailures="0"/);
  const opens = xml.match(/<testcase\b/g) ?? [];
  assert.equal(opens.length, 0);
});

test("formatJUnit derives failures from results, not summary.fail (CC-47)", () => {
  // A caller hands in a report whose summary is stale (fail: 0) but whose
  // results actually contain a failure. The failures= attribute and the
  // <failure> elements must follow the results, never the summary.
  const xml = formatJUnit({
    ok: true,
    results: [
      { name: "a", status: "pass", message: "ok" },
      { name: "b", status: "fail", message: "boom" },
    ],
    summary: { pass: 2, warn: 0, fail: 0 },
  });
  assert.match(xml, /<testsuites[^>]*\bfailures="1"/);
  assert.match(xml, /<testsuite[^>]*\bfailures="1"/);
  const failures = xml.match(/<failure\b/g) ?? [];
  assert.equal(
    failures.length,
    1,
    "exactly one <failure> for the failing result",
  );
});

test("formatJUnitSuites emits one document with a testsuite per instance (CC-20)", () => {
  const devReport = {
    ok: true,
    results: [{ name: "a", status: "pass", message: "ok" }],
    summary: { pass: 1, warn: 0, fail: 0 },
  };
  const prodReport = {
    ok: false,
    results: [
      { name: "a", status: "pass", message: "ok" },
      { name: "b", status: "fail", message: "boom" },
    ],
    summary: { pass: 1, warn: 0, fail: 1 },
  };
  const xml = formatJUnitSuites([
    { name: "dev", report: devReport },
    { name: "prod", report: prodReport },
  ]);
  // Exactly one XML prolog and one <testsuites> root — a single valid document.
  assert.equal((xml.match(/<\?xml/g) ?? []).length, 1);
  assert.equal((xml.match(/<testsuites\b/g) ?? []).length, 1);
  // One <testsuite> per instance, named after it, with its own counts.
  assert.match(xml, /<testsuite name="dev"[^>]*\btests="1"[^>]*\bfailures="0"/);
  assert.match(
    xml,
    /<testsuite name="prod"[^>]*\btests="2"[^>]*\bfailures="1"/,
  );
  // Document-level tests/failures are the sums across every suite.
  assert.match(xml, /<testsuites[^>]*\btests="3"[^>]*\bfailures="1"/);
});
