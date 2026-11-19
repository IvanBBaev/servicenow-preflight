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
import { aclRoleSanity } from "../build/checks/acl-role-sanity.js";
import { atfEnablement } from "../build/checks/atf-enablement.js";
import { defaultSetLeakage } from "../build/checks/default-set-leakage.js";
import { i18nCompleteness } from "../build/checks/i18n-completeness.js";
import { scopedAppDeps } from "../build/checks/scoped-app-deps.js";
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

/** The ServiceNow REST error envelope, as the instance itself answers. */
function snBody(message, detail = null) {
  return { error: { message, detail }, status: "failure" };
}

// RR-3 follow-up: a missing table (plugin not installed) is a skip warn —
// HTTP 404, or the Table API's 400 "Invalid table" — never an error row.
// RR-39: only when ServiceNow itself says so (its JSON error envelope).
const MISSING_TABLE = [
  [
    "HTTP 404",
    new SnHttpError(
      404,
      "ServiceNow API error (404): No Record found",
      snBody(
        "No Record found",
        "Record doesn't exist or ACL restricts the record retrieval",
      ),
    ),
  ],
  [
    'HTTP 400 "Invalid table"',
    new SnHttpError(
      400,
      "ServiceNow API error (400): Invalid table x_missing",
      snBody("Invalid table x_missing"),
    ),
  ],
];

for (const [label, err] of MISSING_TABLE) {
  test(`errorResult maps a ${label} read to a skip warn`, () => {
    const r = errorResult("demo", "demo things", err);
    assert.equal(r.status, "warn");
    assert.match(r.message, /^Skipped demo things: .*not found/);
    assert.match(r.message, /plugin .* likely not installed/);
  });
}

// RR-39: a 404 (or "Invalid table" 400) that did not come from ServiceNow —
// a proxy or load-balancer page, a wrong base path, an empty body — proves
// nothing about the table: an error row, never the skip warn.
const NOT_FROM_SERVICENOW = [
  [
    "an HTML 404 (proxy page)",
    new SnHttpError(404, "ServiceNow API error (404): HTTP 404", {
      raw: "<html><body><h1>404 Not Found</h1>nginx</body></html>",
    }),
  ],
  [
    "an empty-body 404",
    new SnHttpError(404, "ServiceNow API error (404): HTTP 404", undefined),
  ],
  [
    "a 404 with a JSON body that is not the ServiceNow envelope",
    new SnHttpError(404, "ServiceNow API error (404): HTTP 404", {
      message: "Not Found",
    }),
  ],
  [
    "a 404 whose envelope has an empty message",
    new SnHttpError(404, "ServiceNow API error (404): HTTP 404", snBody("")),
  ],
  [
    'a non-ServiceNow 400 "Invalid table"',
    new SnHttpError(400, "ServiceNow API error (400): Invalid table x", {
      raw: "Invalid table x",
    }),
  ],
];

for (const [label, err] of NOT_FROM_SERVICENOW) {
  test(`errorResult maps ${label} to error, not a skip warn`, () => {
    const r = errorResult("demo", "demo things", err);
    assert.equal(r.status, "error", r.message);
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

for (const check of [corsRules, logLeftovers]) {
  test(`${check.meta.severity} ${check.name}: a 404 (missing table) is a skip warn`, async () => {
    const http = createFakeSnClient({ tables: {}, fail: { http: 404 } });
    const r = await check.run({ instanceUrl: INSTANCE, http, scope: SCOPE });
    assert.equal(r.status, "warn", r.message);
    assert.match(r.message, /^Skipped /);
  });
}

// RR-39: the five checks that call isMissingTable themselves, and the two
// that go through errorResult, all follow the envelope rule.
// Each entry: the check plus the context it needs to reach its first read.
const MISSING_TABLE_CHECKS = [
  [aclRoleSanity, {}],
  [atfEnablement, { auth: { kind: "basic", user: "admin", pass: "secret" } }],
  [defaultSetLeakage, {}],
  [i18nCompleteness, { options: { languages: ["fr", "de"] } }],
  [scopedAppDeps, { options: { requiredApps: [{ id: "x_acme_dep" }] } }],
  [corsRules, {}],
  [logLeftovers, {}],
];
const PROXY_404 = {
  http: 404,
  body: { raw: "<html><body>404 Not Found</body></html>" },
};
for (const [check, extra] of MISSING_TABLE_CHECKS) {
  test(`${check.name}: a ServiceNow 404 is a skip warn, a proxy or empty 404 an error row`, async () => {
    const run = (fail) =>
      check.run({
        instanceUrl: INSTANCE,
        http: createFakeSnClient({ tables: {}, fail }),
        scope: SCOPE,
        updateSetId: "0123456789abcdef0123456789abcdef",
        ...extra,
      });
    const sn = await run({ http: 404 });
    assert.equal(sn.status, "warn", sn.message);
    assert.match(sn.message, /^Skipped /);
    for (const fail of [PROXY_404, { http: 404, body: null }]) {
      const r = await run(fail);
      assert.equal(r.status, "error", r.message);
    }
  });
}

// RR-49 (CLI-1): a 404 the check did not get from a table it declares
// optional (meta.optionalTables) is not a missing plugin — it is an error.
test("the runner turns a thrown 404 from no optional table into an error", async () => {
  const out = await runPreflight({ instanceUrl: INSTANCE }, [
    {
      name: "throws-404",
      description: "d",
      run() {
        throw new SnHttpError(404, "Not Found", snBody("Not Found"));
      },
    },
  ]);
  assert.equal(out.results[0].status, "error");
  assert.match(out.results[0].message, /^Required table not found/);
  assert.equal(out.ok, false);
});

test("the runner keeps a thrown non-ServiceNow 404 an error row; ok is false", async () => {
  const out = await runPreflight(
    { instanceUrl: INSTANCE },
    NOT_FROM_SERVICENOW.map(([label, err], i) => ({
      name: `throws-${i}`,
      description: label,
      run() {
        throw err;
      },
    })),
  );
  assert.deepEqual(
    out.results.map((r) => r.status),
    NOT_FROM_SERVICENOW.map(() => "error"),
  );
  assert.equal(out.ok, false);
});

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

// RR-3 follow-up: the checks with their own catch blocks skip on a missing
// table too, and still error on any other read failure.
for (const [mod, exp] of [
  ["atf-enablement", "atfEnablement"],
  ["scoped-app-deps", "scopedAppDeps"],
  ["i18n-completeness", "i18nCompleteness"],
  ["default-set-leakage", "defaultSetLeakage"],
  ["acl-role-sanity", "aclRoleSanity"],
]) {
  test(`${mod}: a 404 is a skip warn, a 500 an error row`, async () => {
    const check = (await import(`../build/checks/${mod}.js`))[exp];
    const run = (fail) =>
      check.run({
        instanceUrl: INSTANCE,
        http: createFakeSnClient({ tables: {}, fail }),
        scope: SCOPE,
        updateSet: "x",
        auth: { kind: "basic", user: "u", pass: "p" },
        options: { requiredApps: [{ id: "com.x" }], languages: ["en", "de"] },
      });
    const skipped = await run({ http: 404 });
    assert.equal(skipped.status, "warn", skipped.message);
    assert.match(skipped.message, /^Skipped .*likely not installed/);
    assert.equal((await run({ http: 500 })).status, "error");
  });
}
