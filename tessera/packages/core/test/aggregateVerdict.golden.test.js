// Golden fixture suite (§6a Tier-1 requirement): every fixture is a
// (VerdictInput -> expected PreflightVerdict) pair; the comparison is
// byte-stable via canonical JSON. Hermetic — no instance, no clock.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { aggregateVerdict, canonicalJson } from "../build/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixtureFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const EXPECTED_FIXTURES = [
  "allow-skipped-go",
  "coverage-floor",
  "empty-plan",
  "flaky-disagreement",
  "full-green",
  "full-red",
  "missing-row",
  "parity-breach",
  "resolution-table",
  "unknown-outcome",
  "unplanned-result",
];

describe("aggregateVerdict golden fixtures", () => {
  it("the fixture set itself is complete", () => {
    assert.deepEqual(
      fixtureFiles.map((f) => f.replace(/\.json$/, "")),
      EXPECTED_FIXTURES,
    );
  });

  for (const file of fixtureFiles) {
    const { name, input, expected } = JSON.parse(
      readFileSync(join(fixturesDir, file), "utf8"),
    );

    it(`${name}: reproduces the golden verdict byte-for-byte`, () => {
      const actual = aggregateVerdict(input);
      assert.equal(canonicalJson(actual), canonicalJson(expected));
      assert.deepEqual(actual, expected);
    });

    it(`${name}: is deterministic (double run, byte-identical)`, () => {
      assert.equal(
        canonicalJson(aggregateVerdict(input)),
        canonicalJson(aggregateVerdict(input)),
      );
    });
  }
});

describe("aggregateVerdict invariants across all fixtures", () => {
  for (const file of fixtureFiles) {
    const { name, expected } = JSON.parse(
      readFileSync(join(fixturesDir, file), "utf8"),
    );

    it(`${name}: token present iff status is GO, sig unminted`, () => {
      assert.equal(
        expected.confirmToken !== undefined,
        expected.status === "GO",
      );
      if (expected.confirmToken) {
        assert.equal(expected.confirmToken.sig, "");
      }
    });

    it(`${name}: counts are consistent with rows`, () => {
      const rows = expected.rows;
      assert.equal(
        expected.counts.pass,
        rows.filter((r) => r.status === "pass").length,
      );
      assert.equal(
        expected.counts.fail,
        rows.filter((r) => r.status === "fail").length,
      );
      assert.equal(
        expected.counts.inconclusive,
        rows.filter((r) => r.status === "inconclusive").length,
      );
      assert.equal(
        expected.counts.blocking,
        rows.filter((r) => r.blocking).length,
      );
      assert.equal(
        expected.counts.missing,
        rows.filter((r) => r.raw === "missing").length,
      );
    });

    it(`${name}: rows follow the sort contract`, () => {
      const keys = expected.rows.map((r) =>
        JSON.stringify([
          r.target.table,
          r.target.sysId,
          r.spec.id,
          r.spec.path,
        ]),
      );
      assert.deepEqual(keys, [...keys].sort());
    });

    it(`${name}: missing rows never carry evidence`, () => {
      for (const row of expected.rows) {
        if (row.raw === "missing") assert.equal(row.evidence, undefined);
      }
    });
  }
});

describe("aggregateVerdict input validation", () => {
  it("rejects a non-ISO injected clock", () => {
    const { input } = JSON.parse(
      readFileSync(join(fixturesDir, "empty-plan.json"), "utf8"),
    );
    assert.throws(
      () => aggregateVerdict({ ...input, now: "not-a-date" }),
      /ISO-8601/,
    );
  });
});
