// RR-12 (ARC-1): the library verdict. `evaluate()` is the one pipeline
// (policy → baseline → failOn) the CLI and `runGate()` share; it is pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluate, runGate } from "../build/index.js";
import { BASELINE_ROW } from "../build/api/report.js";
import { UsageError } from "../build/config.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function report(results) {
  const summary = { pass: 0, warn: 0, fail: 0, error: 0 };
  for (const r of results) summary[r.status] += 1;
  return {
    ok: summary.fail === 0 && summary.error === 0,
    results,
    summary,
  };
}

function baseline(entries) {
  return { version: 1, generatedAt: "2026-01-01T00:00:00.000Z", entries };
}

function fixed(name, status, message = `${name} ${status}`) {
  return { name, description: name, run: () => ({ name, status, message }) };
}

const CTX = { instanceUrl: "https://acme.service-now.com", instance: "prod" };

test("src/core imports no fs, process, CLI or HTTP runtime module", () => {
  const dir = join(ROOT, "src", "core");
  const files = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const runtime = [
      ...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"([^"]+)"/gms),
    ].map((m) => m[1]);
    for (const spec of runtime) {
      assert.doesNotMatch(
        spec,
        /^(node:)?(fs|process)(\/|$)|\/cli[^/]*$|\/http\//,
        `${file} imports ${spec}`,
      );
    }
    assert.doesNotMatch(text, /\bprocess\./, `${file} touches process`);
  }
});

test("evaluate: the policy applies before the baseline, the threshold last", () => {
  const raw = report([
    { name: "a", status: "fail", message: "a found 2" },
    { name: "b", status: "warn", message: "b found 1" },
  ]);
  // The baseline accepted `a` as a warn: it only matches once the policy
  // demoted the fail.
  const b = baseline([
    {
      check: "a",
      status: "warn",
      message: "a found 2 [severity: warn by policy]",
      reason: "",
    },
  ]);
  const v = evaluate(raw, {
    policy: { a: "warn" },
    baseline: b,
    failOn: "warn",
  });
  assert.equal(v.report.results[0].kind, "baseline");
  assert.equal(v.report.results[0].status, "warn");
  // `b` is an unbaselined warn: the gate fails under failOn warn.
  assert.equal(v.ok, false);
  assert.equal(v.report.ok, false);
  assert.equal(v.failOn, "warn");
  assert.equal(v.baselined, 1);
  assert.equal(v.expired, 0);
  // Without the policy the baseline does not match and `a` still fails.
  const strict = evaluate(raw, { baseline: b });
  assert.equal(strict.ok, false);
  assert.equal(strict.report.summary.fail, 1);
  assert.equal(strict.baselined, 0);
});

test("evaluate: defaults to failOn fail and counts expired entries", () => {
  const raw = report([{ name: "a", status: "warn", message: "m" }]);
  const v = evaluate(raw, {
    baseline: baseline([
      {
        check: "a",
        status: "warn",
        message: "m",
        reason: "",
        expires: "2000-01-01",
      },
    ]),
    now: new Date("2026-06-01T00:00:00Z"),
  });
  assert.equal(v.ok, true);
  assert.equal(v.failOn, "fail");
  assert.equal(v.baselined, 0);
  assert.equal(v.expired, 1);
  assert.equal(v.report.results.at(-1).name, BASELINE_ROW);
});

test("evaluate: recomputes the summary fail-closed", () => {
  const raw = {
    ok: true,
    results: [{ name: "a", status: "bogus", message: "?" }],
    summary: { pass: 1, warn: 0, fail: 0, error: 0 },
  };
  assert.equal(evaluate(raw).ok, false);
});

test("evaluate: an invalid failOn is a RangeError", () => {
  const raw = report([{ name: "a", status: "warn", message: "m" }]);
  for (const failOn of ["Warn", "pass", "", 1]) {
    assert.throws(() => evaluate(raw, { failOn }), RangeError);
  }
});

test("evaluate: a baseline for another instance is refused", () => {
  const raw = report([{ name: "a", status: "warn", message: "m" }]);
  const b = { ...baseline([]), instance: "dev" };
  assert.throws(
    () => evaluate(raw, { baseline: b, baselineTarget: { instance: "prod" } }),
    (err) => err instanceof UsageError,
  );
});

test("runGate: validates inputs before any check runs", async () => {
  let ran = 0;
  const probe = {
    name: "probe",
    description: "probe",
    run: () => {
      ran += 1;
      return { name: "probe", status: "pass", message: "ok" };
    },
  };
  await assert.rejects(
    runGate(CTX, [probe], { policy: { nope: "warn" } }),
    (err) => err instanceof UsageError && /nope/.test(err.message),
  );
  await assert.rejects(runGate(CTX, [probe], { failOn: "Warn" }), RangeError);
  await assert.rejects(
    runGate(CTX, [probe], { baseline: { ...baseline([]), instance: "dev" } }),
    (err) => err instanceof UsageError && /"dev"/.test(err.message),
  );
  await assert.rejects(
    runGate(CTX, [probe], {
      baseline: { ...baseline([]), url: "https://other.service-now.com" },
    }),
    (err) => err instanceof UsageError,
  );
  assert.equal(ran, 0);
});

test("runGate: policy off skips the check, the verdict follows failOn", async () => {
  const checks = [fixed("a", "fail"), fixed("b", "warn")];
  const off = await runGate(CTX, checks, { policy: { a: "off" } });
  assert.deepEqual(
    off.report.results.map((r) => r.name),
    ["b"],
  );
  assert.equal(off.ok, true);
  const strict = await runGate(CTX, checks, {
    policy: { a: "off" },
    failOn: "warn",
  });
  assert.equal(strict.ok, false);
  // An existing skip is kept, and a name is not skipped twice.
  const both = await runGate(
    { ...CTX, select: { skip: ["a"] } },
    [...checks, fixed("c", "pass")],
    { policy: { a: "off", b: "off" } },
  );
  assert.deepEqual(
    both.report.results.map((r) => r.name),
    ["c"],
  );
});

test("runGate: a baseline for the same instance accepts the finding", async () => {
  const checks = [fixed("a", "fail", "a found 1")];
  const v = await runGate(CTX, checks, {
    baseline: {
      ...baseline([
        { check: "a", status: "fail", message: "a found 1", reason: "known" },
      ]),
      instance: "prod",
      url: "https://ACME.service-now.com/",
    },
  });
  assert.equal(v.ok, true);
  assert.equal(v.baselined, 1);
  assert.match(v.report.results[0].message, /^Baselined \(known/);
});
