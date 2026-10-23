import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_FINDINGS,
  capFindings,
  findingId,
  makeFinding,
  runPreflight,
} from "../build/index.js";
import { createFakeSnClient } from "../build/http/fake.js";

const loc = {
  table: "sys_script_include",
  sysId: "a".repeat(32),
  field: "script",
};

test("findingId is deterministic and has the f1 format", () => {
  const id = findingId("log-leftovers", "pattern:gs.log", loc);
  assert.match(id, /^f1:[0-9a-f]{16}$/);
  assert.equal(id, findingId("log-leftovers", "pattern:gs.log", { ...loc }));
});

test("findingId ignores line, recordName and message", () => {
  const base = findingId("c", "k", loc);
  assert.equal(
    findingId("c", "k", { ...loc, line: 42, recordName: "Renamed" }),
    base,
  );
  assert.equal(
    makeFinding("c", "k", "one wording", loc).id,
    makeFinding("c", "k", "another wording", loc).id,
  );
});

test("findingId changes with check, kind, sysId, field and logicalId", () => {
  const base = findingId("c", "k", loc);
  for (const other of [
    findingId("c2", "k", loc),
    findingId("c", "k2", loc),
    findingId("c", "k", { ...loc, sysId: "b".repeat(32) }),
    findingId("c", "k", { ...loc, field: "condition" }),
    findingId("c", "k", { ...loc, logicalId: "instance" }),
  ]) {
    assert.notEqual(other, base);
  }
});

test("findingId does not collide when fields shift between slots", () => {
  assert.notEqual(
    findingId("c", "k", { table: "ab", field: "c" }),
    findingId("c", "k", { table: "a", field: "bc" }),
  );
});

test("capFindings keeps the first max entries and counts the rest", () => {
  const list = Array.from({ length: 7 }, (_, i) =>
    makeFinding("c", `k${i}`, "m"),
  );
  const capped = capFindings(list, 5);
  assert.equal(capped.findings.length, 5);
  assert.equal(capped.truncated, 2);
  assert.equal(MAX_FINDINGS, 500);
});

function run(produced) {
  return runPreflight({ http: createFakeSnClient() }, [
    { name: "custom", description: "d", run: () => produced },
  ]);
}

test("a result without findings is passed through unchanged", async () => {
  const report = await run({ name: "custom", status: "pass", message: "ok" });
  assert.deepEqual(report.results, [
    { name: "custom", status: "pass", message: "ok" },
  ]);
});

test("the runner sanitises findings a check returns", async () => {
  const good = makeFinding("custom", "k", "m", loc, "warn");
  const report = await run({
    name: "custom",
    status: "warn",
    message: "found",
    findings: [
      good,
      null,
      "junk",
      { kind: 1, message: "m" },
      {
        id: "not-an-id",
        kind: "k2",
        message: "m2",
        status: "bogus",
        location: { table: "t", line: 0, extra: "x", sysId: 5 },
      },
    ],
  });
  const [row] = report.results;
  assert.equal(row.status, "warn");
  assert.equal(row.findings.length, 2);
  assert.deepEqual(row.findings[0], good);
  assert.deepEqual(row.findings[1], {
    id: findingId("custom", "k2", { table: "t" }),
    kind: "k2",
    message: "m2",
    location: { table: "t" },
  });
});

test("a non-array findings value is dropped without changing the status", async () => {
  const report = await run({
    name: "custom",
    status: "pass",
    message: "ok",
    findings: "nope",
  });
  assert.deepEqual(report.results, [
    { name: "custom", status: "pass", message: "ok" },
  ]);
  assert.equal(report.ok, true);
});

test("the runner clamps findings at 500 and records the overflow", async () => {
  const findings = Array.from({ length: 503 }, (_, i) => ({
    kind: `k${i}`,
    message: "m",
  }));
  const report = await run({
    name: "custom",
    status: "fail",
    message: "many",
    findings,
    findingsTruncated: 10,
  });
  const [row] = report.results;
  assert.equal(row.findings.length, 500);
  assert.equal(row.findingsTruncated, 13);
});
