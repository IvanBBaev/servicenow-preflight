// RR-3 (OD-12): an HTTP 4xx/5xx, network or auth failure inside a check is an
// `error` row — it fails the run, has its own summary bucket, is distinct in
// every report format and is never demoted by a baseline or a severity policy.
import { test } from "node:test";
import assert from "node:assert/strict";

import { runPreflight } from "../build/index.js";
import { applyBaseline, baselineFromReport } from "../build/api/report.js";
import { applyPolicy } from "../build/api/checks.js";
import { errorResult } from "../build/checks/cert-common.js";
import { corsRules } from "../build/checks/cors-rules.js";
import { logLeftovers } from "../build/checks/log-leftovers.js";
import { createFakeSnClient } from "../build/http/fake.js";
import {
  SnAuthError,
  SnHttpError,
  SnNetworkError,
  SnResponseError,
} from "../build/http/client.js";
import { formatJUnit } from "../build/report/junit.js";
import { formatSarif } from "../build/report/sarif.js";
import { formatMarkdown } from "../build/report/markdown.js";
import { formatGitHubAnnotations } from "../build/report/github.js";
import { createTracer } from "../build/trace.js";

const SCOPE = "x_acme_app";
const INSTANCE = "https://dev12345.service-now.com";
const NOW = new Date("2026-10-22T12:00:00Z");

function report(results) {
  const summary = { pass: 0, warn: 0, fail: 0, error: 0 };
  for (const r of results) summary[r.status] += 1;
  return {
    ok: summary.fail === 0 && summary.error === 0,
    results,
    summary,
  };
}

const READ_ERRORS = [
  ["HTTP 400", new SnHttpError(400, "Bad Request")],
  ["HTTP 404", new SnHttpError(404, "Not Found")],
  ["HTTP 500", new SnHttpError(500, "Internal Server Error")],
  ["network", new SnNetworkError("ECONNREFUSED")],
  ["401", new SnAuthError("Unauthorized", 401)],
  ["403", new SnAuthError("Forbidden", 403)],
];

for (const [label, err] of READ_ERRORS) {
  test(`errorResult maps a ${label} read failure to error`, () => {
    const r = errorResult("demo", "demo things", err);
    assert.equal(r.status, "error");
    assert.equal(r.name, "demo");
  });
}

test("errorResult keeps an unexpected error a fail", () => {
  assert.equal(
    errorResult("demo", "x", new SnResponseError("not JSON", 200, "<html>"))
      .status,
    "fail",
  );
  assert.equal(errorResult("demo", "x", new Error("boom")).status, "fail");
});

// Severity plays no part (OD-12: no advisory exception): a blocker and an
// advisory check both turn every read failure into an error row.
const FAKE_FAILS = [
  ["HTTP 400", { http: 400 }],
  ["HTTP 404", { http: 404 }],
  ["HTTP 500", { http: 500 }],
  ["network", { network: true }],
  ["401", { auth: true }],
  ["403", { forbidden: true }],
];
for (const check of [corsRules, logLeftovers]) {
  for (const [label, fail] of FAKE_FAILS) {
    test(`${check.meta.severity} ${check.name}: a ${label} read is an error row`, async () => {
      const http = createFakeSnClient({ tables: {}, fail });
      const r = await check.run({ instanceUrl: INSTANCE, http, scope: SCOPE });
      assert.equal(r.status, "error", r.message);
    });
  }
}

test("the runner turns a thrown read failure into an error row; ok is false", async () => {
  const checks = READ_ERRORS.map(([label, err], i) => ({
    name: `throws-${i}`,
    description: label,
    run() {
      throw err;
    },
  }));
  checks.push({
    name: "throws-plain",
    description: "plain",
    run() {
      throw new Error("kaboom");
    },
  });
  const out = await runPreflight({ instanceUrl: INSTANCE }, checks);
  assert.deepEqual(
    out.results.map((r) => r.status),
    [...READ_ERRORS.map(() => "error"), "fail"],
  );
  assert.deepEqual(out.summary, {
    pass: 0,
    warn: 0,
    fail: 1,
    error: READ_ERRORS.length,
  });
  assert.equal(out.ok, false);
});

test("a lone error row makes the report not ok", async () => {
  const out = await runPreflight({ instanceUrl: INSTANCE }, [
    {
      name: "unreadable",
      description: "d",
      run: () => ({ name: "unreadable", status: "error", message: "HTTP 500" }),
    },
  ]);
  assert.equal(out.ok, false);
  assert.deepEqual(out.summary, { pass: 0, warn: 0, fail: 0, error: 1 });
});

// The demotion matrix: {finding, error} × {baseline match, none} ×
// {policy fail, warn, none}. A finding may be demoted; an error row never is.
for (const row of ["finding", "error"]) {
  for (const baselined of [true, false]) {
    for (const level of ["fail", "warn", undefined]) {
      test(`demotion matrix: ${row}, baseline ${baselined ? "match" : "none"}, policy ${level ?? "none"}`, () => {
        const status = row === "error" ? "error" : "fail";
        const live = report([
          { name: "c", status, message: "same message" },
          { name: "ok", status: "pass", message: "fine" },
        ]);
        // A baseline that would match the row if it were demotable: recorded
        // from the same check while it was a plain fail.
        const b = baselined
          ? baselineFromReport(
              report([{ name: "c", status: "fail", message: "same message" }]),
              undefined,
              NOW,
            )
          : { version: 1, generatedAt: NOW.toISOString(), entries: [] };
        if (baselined && row === "error") {
          // Force a same-status entry too: even a hand-written `error` entry
          // must not match.
          b.entries.push({
            check: "c",
            status: "error",
            message: "same message",
            reason: "",
          });
        }
        let out = applyBaseline(live, b, NOW);
        if (level) out = applyPolicy(out, { c: level });
        const r = out.results.find((x) => x.name === "c");
        if (row === "error") {
          assert.equal(r.status, "error");
          assert.equal(r.message, "same message");
          assert.equal(out.summary.error, 1);
          assert.equal(out.ok, false);
        } else {
          const expected = level ?? (baselined ? "warn" : "fail");
          assert.equal(r.status, expected);
          assert.equal(out.ok, expected !== "fail");
        }
      });
    }
  }
}

test("baselineFromReport never records an error row", () => {
  const b = baselineFromReport(
    report([
      { name: "a", status: "error", message: "HTTP 500" },
      { name: "b", status: "fail", message: "gap" },
    ]),
    undefined,
    NOW,
  );
  assert.deepEqual(
    b.entries.map((e) => e.check),
    ["b"],
  );
});

const MIXED = report([
  { name: "readable", status: "fail", message: "a gap" },
  { name: "unreadable", status: "error", message: "HTTP 500 <x>" },
  { name: "fine", status: "pass", message: "ok" },
]);

test("JUnit renders an error row as <error> and counts errors apart", () => {
  const xml = formatJUnit(MIXED);
  assert.match(xml, /<testsuites tests="3" failures="1" errors="1">/);
  assert.match(xml, /<testsuite [^>]*failures="1" errors="1">/);
  assert.match(
    xml,
    /<testcase name="unreadable"[^>]*>\n\s+<error message="HTTP 500 &lt;x&gt;">/,
  );
  assert.equal((xml.match(/<failure /g) ?? []).length, 1);
});

test("SARIF reports an error row at level error", () => {
  const sarif = JSON.parse(formatSarif(MIXED));
  const res = sarif.runs[0].results.find((r) => r.ruleId === "unreadable");
  assert.equal(res.level, "error");
});

test("markdown and GitHub summaries show the error bucket only when non-zero", () => {
  const md = formatMarkdown(MIXED);
  assert.match(md, /1 failed, 1 error\*\*/);
  assert.match(md, /🛑/);
  // Error rows sort ahead of fails.
  assert.ok(md.indexOf("`unreadable`") < md.indexOf("`readable`"));
  const clean = formatMarkdown(
    report([{ name: "fine", status: "pass", message: "ok" }]),
  );
  assert.doesNotMatch(clean, /error/);
  const gh = formatGitHubAnnotations(MIXED);
  assert.match(gh, /1 failed, 1 error/);
  assert.match(gh, /::error[^\n]*unreadable/);
});

test("trace carries the error status and summary bucket", async () => {
  const lines = [];
  const tracer = createTracer((line) => lines.push(line));
  try {
    await runPreflight({ instanceUrl: INSTANCE }, [
      {
        name: "unreadable",
        description: "d",
        run() {
          throw new SnHttpError(503, "Service Unavailable");
        },
      },
    ]);
  } finally {
    tracer.close();
  }
  const events = lines.map((l) => JSON.parse(l));
  const end = events.find((e) => e.type === "check.end");
  assert.equal(end.status, "error");
  const runEnd = events.find((e) => e.type === "run.end");
  assert.deepEqual(runEnd.summary, { pass: 0, warn: 0, fail: 0, error: 1 });
});
